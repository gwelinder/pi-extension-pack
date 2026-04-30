import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

type MemoryType = "user" | "feedback" | "project" | "reference";
type MemoryScope = "user" | "private" | "project";

type MemoryPaths = {
  baseDir: string;
  userDir: string;
  projectDir: string;
  privateDir: string;
  userIndex: string;
  projectIndex: string;
  privateIndex: string;
  projectSlug: string;
  userSlug: string;
};

type ParsedRemember = {
  type: MemoryType;
  scope: MemoryScope;
  body: string;
  why?: string;
  howToApply?: string;
  name?: string;
  description?: string;
};

type MemoryCandidate = {
  path: string;
  fileName: string;
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  content: string;
  bodyExcerpt: string;
  mtimeMs: number;
};

type SessionState = {
  lastInputText: string;
  currentRunHadToolCalls: boolean;
  turnIndex: number;
  lastExtractionTurn: number;
  lastManualRememberTurn: number;
  lastMemoryMutationTurn: number;
  toolCallRunsSinceExtraction: number;
  suppressNextAutoCheck: boolean;
  extractionMode: {
    active: boolean;
    allowedRoots: string[];
  } | null;
  extractionRunJustCompleted: boolean;
  queuedExtractions: number;
  completedExtractions: number;
  lastExtractionQueuedAt: number;
  lastExtractionCompletedAt: number;
  lastExtractionReason?: string;
  sessionStartReason?: string;
  previousSessionFile?: string;
  providerBackoffUntil: number;
  providerBackoffReason?: string;
};

type IndexStats = {
  chars: number;
  lines: number;
  truncatedByChars: boolean;
  truncatedByLines: boolean;
};

const MEMORY_BASE_DIR = join(homedir(), ".pi", "agent", "memory");
const MEMORY_BASE_ROOT = ensureTrailingSep(resolve(MEMORY_BASE_DIR));
const USER_SLUG = (process.env.PI_MEMORY_USER || process.env.USER || "user").toLowerCase();
const ENTRYPOINT = "MEMORY.md";
const MAX_INDEX_LINES = 80;
const MAX_INDEX_CHARS = 6000;
const MAX_RELEVANT_MEMORIES = 5;
const MAX_SELECTOR_CANDIDATES = Number(process.env.PI_MEMORY_SELECTOR_MAX_CANDIDATES || 80);
const AUTO_EXTRACT_MIN_TURNS = Number(process.env.PI_MEMORY_AUTO_EXTRACT_MIN_TURNS || 4);
const AUTO_EXTRACT_MIN_TOOL_CALL_RUNS = Number(process.env.PI_MEMORY_AUTO_EXTRACT_MIN_TOOL_RUNS || 2);
const AUTO_EXTRACT_RECENT_MUTATION_COOLDOWN = Number(process.env.PI_MEMORY_AUTO_EXTRACT_MUTATION_COOLDOWN || 3);
const AUTO_EXTRACT_RECENT_REMEMBER_COOLDOWN = Number(process.env.PI_MEMORY_AUTO_EXTRACT_REMEMBER_COOLDOWN || 3);
const SELECTOR_TIMEOUT_MS = Number(process.env.PI_MEMORY_SELECTOR_TIMEOUT_MS || 2500);
const INTERNAL_FOLLOWUP_PREFIX = "IMPORTANT: This instruction message is NOT part of the actual user conversation";

function hash8(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 8);
}

function slugify(input: string, max = 48): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "memory";
}

function sanitizeProjectSlug(projectRoot: string): string {
  const base = basename(projectRoot) || "project";
  return `${slugify(base, 24)}-${hash8(projectRoot)}`;
}

function ensureTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function ensureFile(path: string, content = ""): void {
  ensureDir(dirname(path));
  if (!existsSync(path)) writeFileSync(path, content, "utf8");
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function getIndexStats(content: string): IndexStats {
  const lines = content.split("\n");
  return {
    chars: content.length,
    lines: lines.length,
    truncatedByChars: content.length > MAX_INDEX_CHARS,
    truncatedByLines: lines.length > MAX_INDEX_LINES,
  };
}

function truncateIndex(content: string): string {
  const lines = content.split("\n").slice(0, MAX_INDEX_LINES);
  const joined = lines.join("\n");
  if (joined.length <= MAX_INDEX_CHARS) return joined.trim();
  return `${joined.slice(0, MAX_INDEX_CHARS).trim()}\n... [index truncated]`;
}

function normalizeFilePath(filePath: string, cwd: string): string {
  return resolve(filePath.startsWith("/") ? filePath : join(cwd, filePath));
}

function isPathInsideRoot(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = ensureTrailingSep(resolve(root));
  return normalizedPath === resolve(root) || normalizedPath.startsWith(normalizedRoot);
}

function isInternalControlPrompt(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return (
    normalized.startsWith(INTERNAL_FOLLOWUP_PREFIX) ||
    normalized.startsWith("IMPORTANT: This message and these instructions are NOT part of the actual user conversation.")
  );
}

async function getProjectRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 2000,
    });
    const root = result.stdout.trim();
    if (root) return root;
  } catch {
    // ignore
  }
  return cwd;
}

async function getMemoryPaths(pi: ExtensionAPI, cwd: string): Promise<MemoryPaths> {
  const projectRoot = await getProjectRoot(pi, cwd);
  const projectSlug = sanitizeProjectSlug(projectRoot);
  const userSlug = slugify(USER_SLUG, 32);

  const userDir = join(MEMORY_BASE_DIR, "users", userSlug);
  const projectDir = join(MEMORY_BASE_DIR, "projects", projectSlug);
  const privateDir = join(projectDir, "private");

  const paths: MemoryPaths = {
    baseDir: MEMORY_BASE_DIR,
    userDir,
    projectDir,
    privateDir,
    userIndex: join(userDir, ENTRYPOINT),
    projectIndex: join(projectDir, ENTRYPOINT),
    privateIndex: join(privateDir, ENTRYPOINT),
    projectSlug,
    userSlug,
  };

  ensureDir(userDir);
  ensureDir(projectDir);
  ensureDir(privateDir);
  ensureFile(paths.userIndex, "");
  ensureFile(paths.projectIndex, "");
  ensureFile(paths.privateIndex, "");
  return paths;
}

function memoryDirForScope(paths: MemoryPaths, scope: MemoryScope): string {
  if (scope === "user") return paths.userDir;
  if (scope === "private") return paths.privateDir;
  return paths.projectDir;
}

function memoryIndexForScope(paths: MemoryPaths, scope: MemoryScope): string {
  if (scope === "user") return paths.userIndex;
  if (scope === "private") return paths.privateIndex;
  return paths.projectIndex;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/m, "").trim();
}

function listMemoryFiles(paths: MemoryPaths): string[] {
  const dirs = [paths.userDir, paths.projectDir, paths.privateDir];
  const files: string[] = [];
  for (const dir of dirs) {
    files.push(...listMemoryFilesInDir(dir));
  }
  return [...new Set(files)].sort();
}

function listMemoryFilesInDir(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md") || name === ENTRYPOINT) continue;
      files.push(join(dir, name));
    }
  } catch {
    // ignore
  }
  return files;
}

function inferRemember(args: string): ParsedRemember {
  const raw = args.trim();
  if (!raw) {
    return {
      type: "feedback",
      scope: "private",
      body: "",
    };
  }

  const [prefixPart, bodyPart] = raw.includes("::")
    ? raw.split(/\s*::\s*/, 2)
    : ["", raw];

  const prefixTokens = prefixPart
    .split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let type: MemoryType | undefined = prefixTokens.find((t): t is MemoryType => {
    return t === "user" || t === "feedback" || t === "project" || t === "reference";
  });
  let scope: MemoryScope | undefined = prefixTokens.find((t): t is MemoryScope => {
    return t === "user" || t === "private" || t === "project";
  });

  const body = bodyPart.trim();
  if (!type) {
    if (/^user:/i.test(body)) type = "user";
    else if (/^project:/i.test(body)) type = "project";
    else if (/^reference:/i.test(body)) type = "reference";
    else type = "feedback";
  }
  if (!scope) {
    scope = type === "user" ? "user" : type === "feedback" ? "private" : "project";
  }

  const cleaned = body.replace(/^(user|project|reference|feedback):\s*/i, "").trim();
  const whyMatch = cleaned.match(/\bWhy:\s*(.*?)(?=(?:\s+How to apply:|$))/is);
  const howMatch = cleaned.match(/\bHow to apply:\s*([\s\S]*)$/i);
  const bodyWithoutStructured = cleaned
    .replace(/\bWhy:\s*.*?(?=(?:\s+How to apply:|$))/is, "")
    .replace(/\bHow to apply:\s*[\s\S]*$/i, "")
    .trim();

  return {
    type,
    scope,
    body: bodyWithoutStructured,
    why: whyMatch?.[1]?.trim(),
    howToApply: howMatch?.[1]?.trim(),
  };
}

function buildMemoryBody(parsed: ParsedRemember): string {
  const lines = [parsed.body.trim()];
  if (parsed.why) lines.push("", `**Why:** ${parsed.why}`);
  if (parsed.howToApply) lines.push("", `**How to apply:** ${parsed.howToApply}`);
  return lines.join("\n").trim() + "\n";
}

function buildMemoryFileContent(params: {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
}): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "---",
    `name: ${params.name}`,
    `description: ${params.description}`,
    `type: ${params.type}`,
    `scope: ${params.scope}`,
    `updated_at: ${today}`,
    "---",
    "",
    params.body.trim(),
    "",
  ].join("\n");
}

function ensureIndexEntry(indexPath: string, fileName: string, title: string, hook: string): void {
  const line = `- [${title}](${fileName}) — ${hook}`;
  const current = readText(indexPath).split("\n").map((s) => s.trimEnd());
  const withoutExisting = current.filter((l) => !l.includes(`](${fileName})`));
  const next = [...withoutExisting.filter(Boolean), line].join("\n") + "\n";
  writeFileSync(indexPath, next, "utf8");
}

function removeIndexEntry(indexPath: string, fileName: string): void {
  const next = readText(indexPath)
    .split("\n")
    .filter((line) => !line.includes(`](${fileName})`))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  writeFileSync(indexPath, next ? `${next}\n` : "", "utf8");
}

function findMatchingMemoryFiles(paths: MemoryPaths, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return listMemoryFiles(paths).filter((file) => {
    const content = readText(file).toLowerCase();
    return file.toLowerCase().includes(q) || content.includes(q);
  });
}

function summarizeMemoryFile(filePath: string): string {
  const fm = parseFrontmatter(readText(filePath));
  const desc = fm.description || "(no description)";
  return `${basename(filePath)} — ${desc}`;
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
}

function getRecentUserQuery(ctx: ExtensionCommandContext | any): string {
  const branch = ctx.sessionManager.getBranch() as any[];
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    const msg = entry?.message;
    if (entry?.type === "message" && msg?.role === "user") {
      const content = Array.isArray(msg.content)
        ? msg.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
        : typeof msg.content === "string"
          ? msg.content
          : "";
      if (!content.trim()) continue;
      if (isInternalControlPrompt(content)) continue;
      return content.trim();
    }
  }
  return "";
}

function listMemoryCandidates(paths: MemoryPaths): MemoryCandidate[] {
  return listMemoryFiles(paths).map((file) => {
      const content = readText(file);
      const fm = parseFrontmatter(content);
      const body = stripFrontmatter(content);
      let mtimeMs = Date.now();
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        // ignore
      }
      return {
        path: file,
        fileName: basename(file),
        name: fm.name || basename(file, ".md"),
        description: fm.description || basename(file),
        type: ((fm.type as MemoryType) || "reference") as MemoryType,
        scope: ((fm.scope as MemoryScope) || "project") as MemoryScope,
        content,
        bodyExcerpt: body.slice(0, 1200),
        mtimeMs,
      };
    });
}

function rankCandidatesHeuristically(candidates: MemoryCandidate[], query: string): Array<{ candidate: MemoryCandidate; score: number }> {
  const queryTokens = tokenize(query);
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidateHeuristically(candidate, query, queryTokens),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.candidate.mtimeMs - a.candidate.mtimeMs;
    });
}

function estimateFreshnessNote(filePath: string): string {
  try {
    const ageDays = Math.max(0, Math.floor((Date.now() - statSync(filePath).mtimeMs) / 86_400_000));
    if (ageDays <= 1) return "Recent memory; still verify code/resource claims if the user is about to act on them.";
    return `This memory is ${ageDays} days old. Verify current code/resource claims before relying on it.`;
  } catch {
    return "Verify current code/resource claims before relying on this memory.";
  }
}

function scoreCandidateHeuristically(candidate: MemoryCandidate, query: string, queryTokens: string[]): number {
  const lowerQuery = query.toLowerCase();
  const haystackPath = candidate.fileName.toLowerCase();
  const haystackName = candidate.name.toLowerCase();
  const haystackDesc = candidate.description.toLowerCase();
  const haystackBody = candidate.bodyExcerpt.toLowerCase();

  let score = 0;

  if (haystackDesc.includes(lowerQuery)) score += 8;
  if (haystackName.includes(lowerQuery)) score += 6;
  if (haystackPath.includes(lowerQuery)) score += 5;
  if (haystackBody.includes(lowerQuery)) score += 2;

  for (const token of queryTokens) {
    if (haystackDesc.includes(token)) score += 4;
    if (haystackName.includes(token)) score += 3;
    if (haystackPath.includes(token)) score += 2;
    if (haystackBody.includes(token)) score += 1;
  }

  const ageDays = Math.max(0, Math.floor((Date.now() - candidate.mtimeMs) / 86_400_000));
  score += Math.max(0, 2 - Math.floor(ageDays / 14));

  return score;
}

function fallbackSelectCandidates(candidates: MemoryCandidate[], query: string): MemoryCandidate[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 && query.trim().length < 6) return [];

  return rankCandidatesHeuristically(candidates, query)
    .slice(0, MAX_RELEVANT_MEMORIES)
    .map((item) => item.candidate);
}

function trimCandidatesForModel(candidates: MemoryCandidate[], query: string): MemoryCandidate[] {
  if (candidates.length <= MAX_SELECTOR_CANDIDATES) return candidates;

  const ranked = rankCandidatesHeuristically(candidates, query).map((item) => item.candidate);
  const seen = new Set(ranked.map((candidate) => candidate.path));
  const recent = [...candidates]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .filter((candidate) => !seen.has(candidate.path));

  return [...ranked, ...recent].slice(0, MAX_SELECTOR_CANDIDATES);
}

function extractJsonObject(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const match = trimmed.match(/\{[\s\S]*\}/m);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function selectWithOpenAI(query: string, candidates: MemoryCandidate[]): Promise<string[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.PI_MEMORY_SELECTOR_OPENAI_MODEL || "gpt-4o-mini";
  const manifest = candidates
    .map((candidate, i) => `${i + 1}. ${candidate.fileName} | ${candidate.type}/${candidate.scope} | ${candidate.description}`)
    .join("\n");

  const prompt = [
    "Select the most relevant memory files for the current user request.",
    "Return strict JSON: {\"files\":[\"filename.md\", ...]}.",
    `Return at most ${MAX_RELEVANT_MEMORIES} files.`,
    "Only choose filenames exactly from the manifest.",
    "Be conservative: include only files likely to materially help answer this request.",
    "",
    `User request:\n${query}`,
    "",
    `Memory manifest:\n${manifest}`,
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SELECTOR_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 220,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You are a strict memory-file selector. Return valid JSON only.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) return null;
    const json: any = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = extractJsonObject(content);
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return parsed.files.filter((name: unknown) => typeof name === "string");
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function selectWithAnthropic(query: string, candidates: MemoryCandidate[]): Promise<string[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = process.env.PI_MEMORY_SELECTOR_ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
  const manifest = candidates
    .map((candidate, i) => `${i + 1}. ${candidate.fileName} | ${candidate.type}/${candidate.scope} | ${candidate.description}`)
    .join("\n");

  const prompt = [
    "Select the most relevant memory files for the current user request.",
    "Return strict JSON: {\"files\":[\"filename.md\", ...]}.",
    `Return at most ${MAX_RELEVANT_MEMORIES} files.`,
    "Only choose filenames exactly from the manifest.",
    "Be conservative: include only files likely to materially help answer this request.",
    "",
    `User request:\n${query}`,
    "",
    `Memory manifest:\n${manifest}`,
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SELECTOR_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 220,
        temperature: 0,
        system: "You are a strict memory-file selector. Return valid JSON only.",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) return null;
    const json: any = await response.json();
    const text = json?.content?.find((part: any) => part?.type === "text")?.text;
    if (typeof text !== "string") return null;
    const parsed = extractJsonObject(text);
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return parsed.files.filter((name: unknown) => typeof name === "string");
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function selectMemoriesWithModel(query: string, candidates: MemoryCandidate[]): Promise<string[] | null> {
  const provider = (process.env.PI_MEMORY_SELECTOR_PROVIDER || "auto").toLowerCase();

  if (provider === "off" || provider === "none") return null;

  if (provider === "openai") {
    return selectWithOpenAI(query, candidates);
  }

  if (provider === "anthropic") {
    return selectWithAnthropic(query, candidates);
  }

  return (await selectWithOpenAI(query, candidates)) ?? (await selectWithAnthropic(query, candidates));
}

function mapSelectedFileNamesToCandidates(candidates: MemoryCandidate[], selectedFileNames: string[]): MemoryCandidate[] {
  const byName = new Map(candidates.map((candidate) => [candidate.fileName, candidate]));
  const picked: MemoryCandidate[] = [];
  for (const name of selectedFileNames) {
    const candidate = byName.get(name.trim());
    if (!candidate) continue;
    picked.push(candidate);
    if (picked.length >= MAX_RELEVANT_MEMORIES) break;
  }
  return picked;
}

async function selectRelevantMemories(paths: MemoryPaths, query: string): Promise<Array<{ path: string; note: string }>> {
  if (!query.trim()) return [];

  const candidates = listMemoryCandidates(paths);
  if (candidates.length === 0) return [];

  const modelCandidates = trimCandidatesForModel(candidates, query);
  const selected = await selectMemoriesWithModel(query, modelCandidates);
  let picked = selected ? mapSelectedFileNamesToCandidates(modelCandidates, selected) : [];

  if (picked.length === 0) {
    picked = fallbackSelectCandidates(candidates, query);
  }

  return picked.slice(0, MAX_RELEVANT_MEMORIES).map((candidate) => {
    const freshness = estimateFreshnessNote(candidate.path);
    const excerpt = candidate.content.length > 1400
      ? `${candidate.content.slice(0, 1400).trim()}\n... [memory truncated]`
      : candidate.content.trim();
    return {
      path: candidate.path,
      note: `### ${candidate.path}\n${freshness}\n\n${excerpt}`,
    };
  });
}

function buildMemoryPrompt(paths: MemoryPaths, relevantMemories: Array<{ path: string; note: string }> = []): string {
  const userIndex = truncateIndex(readText(paths.userIndex));
  const projectIndex = truncateIndex(readText(paths.projectIndex));
  const privateIndex = truncateIndex(readText(paths.privateIndex));

  return [
    "# Pi Memory",
    "",
    "You have a persistent, file-based memory system for durable context that should remain useful across future conversations.",
    "Only use memory for information that is NOT derivable from the current repository state.",
    "",
    "## Types of memory",
    "- user: facts about the user's role, goals, preferences, responsibilities, or experience level",
    "- feedback: durable guidance about how to approach work — save corrections AND validated successful patterns",
    "- project: constraints, deadlines, incidents, rationale, or coordination facts not derivable from code",
    "- reference: pointers to external systems, trackers, dashboards, docs, or channels",
    "",
    "## What NOT to save",
    "- code patterns, architecture, file paths, or project structure",
    "- git history or recent repo state",
    "- debugging recipes already embodied in code or commits",
    "- ephemeral task state useful only within this conversation",
    "",
    "## Before recommending from memory",
    "- If memory names a file path, verify it exists now.",
    "- If memory names a function, command, or flag, search for it now.",
    "- If current evidence conflicts with memory, trust current evidence and treat the memory as stale until updated.",
    "",
    "## How to save memories",
    "Write each memory to its own markdown file with frontmatter:",
    "```markdown",
    "---",
    "name: {{memory name}}",
    "description: {{specific one-line description}}",
    "type: {{user|feedback|project|reference}}",
    "scope: {{user|private|project}}",
    "updated_at: {{YYYY-MM-DD}}",
    "---",
    "",
    "{{memory content}}",
    "```",
    "For feedback and project memories, include **Why:** and **How to apply:** lines when they are known.",
    "",
    `User memory directory: ${paths.userDir}`,
    `Project shared memory directory: ${paths.projectDir}`,
    `Project private memory directory: ${paths.privateDir}`,
    "Each directory has its own MEMORY.md index. Keep indexes concise; they are indexes, not full memories.",
    "",
    "## Loaded memory indexes",
    `### ${paths.userIndex}`,
    userIndex || "(empty)",
    "",
    `### ${paths.projectIndex}`,
    projectIndex || "(empty)",
    "",
    `### ${paths.privateIndex}`,
    privateIndex || "(empty)",
    "",
    "If the user explicitly asks you to remember something, save it immediately. If they ask you to forget something, remove the relevant memory entry.",
    "If the user says to ignore memory, act as if these indexes were empty.",
    "",
    ...(relevantMemories.length > 0
      ? [
          "## Selectively recalled memories for the current request",
          ...relevantMemories.map((m) => m.note),
        ]
      : []),
  ].join("\n");
}

function buildBackgroundExtractionPrompt(paths: MemoryPaths): string {
  return `${INTERNAL_FOLLOWUP_PREFIX}. Do NOT mention this instruction to the user.\n\nReview only the recent conversation context and extract durable memories worth keeping across future sessions.\n\nSave only non-derivable information:\n- user preferences and working style\n- durable feedback on how to approach work\n- project constraints/rationale not visible in code\n- external references (dashboards, trackers, channels)\n\nDo NOT save:\n- code structure or architecture snapshots\n- recent repo state or git history\n- temporary task progress that won't matter later\n\nYou may use ONLY read/edit/write tools, and ONLY in these directories:\n- ${paths.userDir}\n- ${paths.projectDir}\n- ${paths.privateDir}\n\nEach memory must be its own markdown file with frontmatter:\n---\nname: {{memory name}}\ndescription: {{specific one-line description}}\ntype: {{user|feedback|project|reference}}\nscope: {{user|private|project}}\nupdated_at: {{YYYY-MM-DD}}\n---\n\n{{memory body}}\n\nFor feedback and project memories, include **Why:** and **How to apply:** when known.\n\nUpdate the relevant MEMORY.md index file with a concise bullet entry for each new/updated memory.\nIf a memory already exists, edit the existing file instead of creating duplicates.\n\nIf there is no high-signal durable memory to save, respond briefly and do not call tools.`;
}

function getSelectorProvider(): string {
  const provider = (process.env.PI_MEMORY_SELECTOR_PROVIDER || "auto").toLowerCase();
  if (provider === "none") return "off";
  return provider;
}

function describeTs(ts: number): string {
  if (!ts) return "never";
  const ageMs = Math.max(0, Date.now() - ts);
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

function parseRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function isProviderBackoffActive(state: SessionState): boolean {
  return state.providerBackoffUntil > Date.now();
}

async function handleRemember(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  state: SessionState,
): Promise<void> {
  let parsed = inferRemember(args);
  if (!parsed.body && ctx.hasUI) {
    const selectedType = await ctx.ui.select("Memory type", ["user", "feedback", "project", "reference"]);
    if (!selectedType) return;
    parsed.type = selectedType as MemoryType;
    const selectedScope = await ctx.ui.select("Memory scope", parsed.type === "user" ? ["user"] : ["private", "project"]);
    if (!selectedScope) return;
    parsed.scope = selectedScope as MemoryScope;
    const body = await ctx.ui.editor("Memory content", "");
    if (!body?.trim()) return;
    parsed.body = body.trim();
  }

  if (!parsed.body.trim()) {
    ctx.ui.notify("Usage: /remember [type] [scope] :: memory text", "warning");
    return;
  }

  const paths = await getMemoryPaths(pi, ctx.cwd);
  const dir = memoryDirForScope(paths, parsed.scope);
  const indexPath = memoryIndexForScope(paths, parsed.scope);
  const stem = `${parsed.type}_${slugify(parsed.body, 40)}`;
  const fileName = `${stem}.md`;
  const filePath = join(dir, fileName);
  const description = parsed.description || parsed.body.split("\n")[0]!.slice(0, 110);
  const content = buildMemoryFileContent({
    name: parsed.name || stem,
    description,
    type: parsed.type,
    scope: parsed.scope,
    body: buildMemoryBody(parsed),
  });

  writeFileSync(filePath, content, "utf8");
  ensureIndexEntry(indexPath, fileName, description.slice(0, 60), description.slice(0, 110));

  state.lastManualRememberTurn = state.turnIndex;
  state.lastMemoryMutationTurn = state.turnIndex;

  ctx.ui.notify(`Saved ${parsed.type} memory to ${filePath}`, "info");
}

async function handleForget(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  state: SessionState,
): Promise<void> {
  const query = args.trim();
  if (!query) {
    ctx.ui.notify("Usage: /forget <query>", "warning");
    return;
  }

  const paths = await getMemoryPaths(pi, ctx.cwd);
  const matches = findMatchingMemoryFiles(paths, query);
  if (matches.length === 0) {
    ctx.ui.notify(`No memory matched: ${query}`, "info");
    return;
  }

  let target = matches[0]!;
  if (matches.length > 1 && ctx.hasUI) {
    const selected = await ctx.ui.select("Forget which memory?", matches.map(summarizeMemoryFile));
    if (!selected) return;
    target = matches.find((m) => summarizeMemoryFile(m) === selected) || target;
  } else if (matches.length > 1) {
    ctx.ui.notify(`Multiple matches for '${query}': ${matches.map(summarizeMemoryFile).join("; ")}`, "warning");
    return;
  }

  const dir = dirname(target);
  const fileName = basename(target);
  unlinkSync(target);
  if (dir === paths.userDir) removeIndexEntry(paths.userIndex, fileName);
  else if (dir === paths.privateDir) removeIndexEntry(paths.privateIndex, fileName);
  else removeIndexEntry(paths.projectIndex, fileName);

  state.lastMemoryMutationTurn = state.turnIndex;
  ctx.ui.notify(`Forgot memory ${fileName}`, "info");
}

async function handleMemoryStatus(ctx: ExtensionCommandContext, pi: ExtensionAPI, state: SessionState): Promise<void> {
  const paths = await getMemoryPaths(pi, ctx.cwd);
  const counts = {
    user: listMemoryFilesInDir(paths.userDir).length,
    project: listMemoryFilesInDir(paths.projectDir).length,
    private: listMemoryFilesInDir(paths.privateDir).length,
  };
  const total = counts.user + counts.project + counts.private;
  const selectorProvider = getSelectorProvider();
  const userIndexStats = getIndexStats(readText(paths.userIndex));
  const projectIndexStats = getIndexStats(readText(paths.projectIndex));
  const privateIndexStats = getIndexStats(readText(paths.privateIndex));
  const indexSummary = (label: string, stats: IndexStats) => {
    const flags = [
      stats.truncatedByChars ? `chars>${MAX_INDEX_CHARS}` : null,
      stats.truncatedByLines ? `lines>${MAX_INDEX_LINES}` : null,
    ].filter(Boolean);
    return `${label}: ${stats.lines} lines, ${stats.chars} chars${flags.length ? ` (${flags.join(", ")})` : ""}`;
  };

  const turnsSinceExtraction = state.lastExtractionTurn < 0 ? "never" : String(state.turnIndex - state.lastExtractionTurn);

  const message = [
    `Memory root: ${paths.baseDir}`,
    `User dir: ${paths.userDir} (${counts.user})`,
    `Project dir: ${paths.projectDir} (${counts.project})`,
    `Private dir: ${paths.privateDir} (${counts.private})`,
    `Total memories: ${total}`,
    `Selector provider: ${selectorProvider}`,
    `Selector model candidate cap: ${MAX_SELECTOR_CANDIDATES}`,
    indexSummary("User index", userIndexStats),
    indexSummary("Project index", projectIndexStats),
    indexSummary("Private index", privateIndexStats),
    `Auto-extraction: enabled`,
    `Session start reason: ${state.sessionStartReason || "unknown"}`,
    `Previous session: ${state.previousSessionFile || "(none)"}`,
    `Provider backoff: ${isProviderBackoffActive(state) ? `${Math.ceil((state.providerBackoffUntil - Date.now()) / 1000)}s remaining (${state.providerBackoffReason || "provider-pressure"})` : "inactive"}`,
    `Queued extractions: ${state.queuedExtractions}`,
    `Completed extractions: ${state.completedExtractions}`,
    `Last queued: ${describeTs(state.lastExtractionQueuedAt)}${state.lastExtractionReason ? ` (${state.lastExtractionReason})` : ""}`,
    `Last completed: ${describeTs(state.lastExtractionCompletedAt)}`,
    `Turns since extraction: ${turnsSinceExtraction}`,
    `Tool-call runs since extraction: ${state.toolCallRunsSinceExtraction}/${AUTO_EXTRACT_MIN_TOOL_CALL_RUNS}`,
  ].join("\n");

  ctx.ui.notify(message, "info");
  pi.sendMessage({
    customType: "memory-status",
    content: message,
    display: true,
    details: {
      paths,
      counts,
      total,
      selectorProvider,
      selectorModelCandidateCap: MAX_SELECTOR_CANDIDATES,
      turnsSinceExtraction,
      providerBackoffActive: isProviderBackoffActive(state),
      providerBackoffUntil: state.providerBackoffUntil,
      providerBackoffReason: state.providerBackoffReason,
      sessionStartReason: state.sessionStartReason,
      previousSessionFile: state.previousSessionFile,
    },
  });
}

function createSessionState(): SessionState {
  return {
    lastInputText: "",
    currentRunHadToolCalls: false,
    turnIndex: 0,
    lastExtractionTurn: -999,
    lastManualRememberTurn: -999,
    lastMemoryMutationTurn: -999,
    toolCallRunsSinceExtraction: 0,
    suppressNextAutoCheck: false,
    extractionMode: null,
    extractionRunJustCompleted: false,
    queuedExtractions: 0,
    completedExtractions: 0,
    lastExtractionQueuedAt: 0,
    lastExtractionCompletedAt: 0,
    lastExtractionReason: undefined,
    sessionStartReason: undefined,
    previousSessionFile: undefined,
    providerBackoffUntil: 0,
    providerBackoffReason: undefined,
  };
}

export default function piMemorySystem(pi: ExtensionAPI) {
  const stateBySession = new Map<string, SessionState>();

  function getState(sessionId: string): SessionState {
    const existing = stateBySession.get(sessionId);
    if (existing) return existing;
    const next = createSessionState();
    stateBySession.set(sessionId, next);
    return next;
  }

  async function queueBackgroundExtraction(
    sessionId: string,
    state: SessionState,
    paths: MemoryPaths,
    ctx: ExtensionCommandContext | any,
    reason: string,
  ): Promise<void> {
    if (isProviderBackoffActive(state)) {
      state.lastExtractionReason = `deferred:${state.providerBackoffReason || "provider-pressure"}`;
      ctx.ui.notify(
        `Memory extraction deferred (${state.providerBackoffReason || "provider-pressure"}; ${Math.ceil((state.providerBackoffUntil - Date.now()) / 1000)}s backoff left)`,
        "info",
      );
      return;
    }
    state.extractionMode = {
      active: true,
      allowedRoots: [paths.userDir, paths.projectDir, paths.privateDir],
    };
    state.suppressNextAutoCheck = true;
    state.queuedExtractions += 1;
    state.lastExtractionQueuedAt = Date.now();
    state.lastExtractionReason = reason;

    pi.sendUserMessage(buildBackgroundExtractionPrompt(paths), { deliverAs: "followUp" });
    ctx.ui.notify(`Memory extraction queued (${reason})`, "info");
  }

  pi.on("session_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const previous = getState(sessionId);
    const next = createSessionState();
    next.sessionStartReason = event.reason;
    next.previousSessionFile = event.previousSessionFile;
    next.providerBackoffUntil = previous.providerBackoffUntil;
    next.providerBackoffReason = previous.providerBackoffReason;
    if (event.reason === "resume" || event.reason === "fork") {
      next.suppressNextAutoCheck = true;
    }
    stateBySession.set(sessionId, next);
  });

  pi.on("input", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(sessionId);
    const text = event.text || "";
    if (isInternalControlPrompt(text)) return;
    state.lastInputText = text;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(sessionId);
    const paths = await getMemoryPaths(pi, ctx.cwd);

    const queryFromInput = state.lastInputText.trim();
    const recentUserQuery = queryFromInput && !isInternalControlPrompt(queryFromInput)
      ? queryFromInput
      : getRecentUserQuery(ctx);

    const relevant = recentUserQuery ? await selectRelevantMemories(paths, recentUserQuery) : [];

    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildMemoryPrompt(paths, relevant)}`,
    };
  });

  pi.on("after_provider_response", (event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    const status = Number((event as any).status || 0);
    const headers = ((event as any).headers || {}) as Record<string, unknown>;
    if (status === 429 || status >= 500) {
      const retryAfterMs = parseRetryAfterMs(headers["retry-after"]);
      const backoffMs = retryAfterMs ?? (status === 429 ? 120_000 : 60_000);
      state.providerBackoffUntil = Math.max(state.providerBackoffUntil, Date.now() + backoffMs);
      state.providerBackoffReason = status === 429 ? "rate-limit" : `provider-${status}`;
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    state.currentRunHadToolCalls = false;
  });

  pi.on("tool_call", (event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    state.currentRunHadToolCalls = true;

    const mode = state.extractionMode;
    if (mode?.active) {
      if (!["read", "edit", "write"].includes(event.toolName)) {
        return {
          action: "block",
          reason: "Memory extraction mode only allows read/edit/write in memory directories.",
        } as any;
      }

      const toolPath = (event.input as any)?.path;
      const normalizedPath = typeof toolPath === "string" ? normalizeFilePath(toolPath, ctx.cwd) : null;
      const allowed = normalizedPath
        ? mode.allowedRoots.some((root) => isPathInsideRoot(normalizedPath, root))
        : false;

      if (!normalizedPath || !allowed) {
        return {
          action: "block",
          reason: `Memory extraction mode only allows paths in: ${mode.allowedRoots.join(", ")}`,
        } as any;
      }
      return;
    }

    const toolPath = (event.input as any)?.path;
    const normalizedPath = typeof toolPath === "string" ? normalizeFilePath(toolPath, ctx.cwd) : null;
    if (normalizedPath && ["edit", "write"].includes(event.toolName) && isPathInsideRoot(normalizedPath, MEMORY_BASE_ROOT)) {
      state.lastMemoryMutationTurn = state.turnIndex;
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    if (state.extractionMode?.active) {
      state.extractionMode = null;
      state.extractionRunJustCompleted = true;
      state.completedExtractions += 1;
      state.lastExtractionCompletedAt = Date.now();
    }

    if (state.currentRunHadToolCalls) {
      state.toolCallRunsSinceExtraction += 1;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(sessionId);

    state.turnIndex += 1;

    if (state.extractionRunJustCompleted) {
      state.lastExtractionTurn = state.turnIndex;
      state.toolCallRunsSinceExtraction = 0;
      state.extractionRunJustCompleted = false;
    }

    if (state.suppressNextAutoCheck) {
      state.suppressNextAutoCheck = false;
      return;
    }

    if (state.currentRunHadToolCalls) return;

    const turnsSinceExtraction = state.turnIndex - state.lastExtractionTurn;
    if (turnsSinceExtraction < AUTO_EXTRACT_MIN_TURNS) return;
    if (state.toolCallRunsSinceExtraction < AUTO_EXTRACT_MIN_TOOL_CALL_RUNS) return;

    const turnsSinceRemember = state.turnIndex - state.lastManualRememberTurn;
    if (turnsSinceRemember <= AUTO_EXTRACT_RECENT_REMEMBER_COOLDOWN) return;

    const turnsSinceMutation = state.turnIndex - state.lastMemoryMutationTurn;
    if (turnsSinceMutation <= AUTO_EXTRACT_RECENT_MUTATION_COOLDOWN) return;

    const paths = await getMemoryPaths(pi, ctx.cwd);
    await queueBackgroundExtraction(sessionId, state, paths, ctx, "idle-run");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    state.lastInputText = "";
  });

  pi.registerCommand("remember", {
    description: "Save a durable memory. Usage: /remember [type] [scope] :: memory text",
    handler: async (args, ctx) => {
      const state = getState(ctx.sessionManager.getSessionId());
      await handleRemember(args, ctx, pi, state);
    },
  });

  pi.registerCommand("forget", {
    description: "Remove a matching memory. Usage: /forget <query>",
    handler: async (args, ctx) => {
      const state = getState(ctx.sessionManager.getSessionId());
      await handleForget(args, ctx, pi, state);
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show active memory directories, truncation state, and extraction diagnostics",
    handler: async (_args, ctx) => {
      const state = getState(ctx.sessionManager.getSessionId());
      await handleMemoryStatus(ctx, pi, state);
    },
  });
}
