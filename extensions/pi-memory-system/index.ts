import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { basename, dirname, join, resolve } from "node:path";
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

const MEMORY_BASE_DIR = join(homedir(), ".pi", "agent", "memory");
const USER_SLUG = (process.env.PI_MEMORY_USER || process.env.USER || "user").toLowerCase();
const ENTRYPOINT = "MEMORY.md";
const MAX_INDEX_LINES = 80;
const MAX_INDEX_CHARS = 6000;

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

function truncateIndex(content: string): string {
  const lines = content.split("\n").slice(0, MAX_INDEX_LINES);
  const joined = lines.join("\n");
  if (joined.length <= MAX_INDEX_CHARS) return joined.trim();
  return `${joined.slice(0, MAX_INDEX_CHARS).trim()}\n... [index truncated]`;
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

function listMemoryFiles(paths: MemoryPaths): string[] {
  const dirs = [paths.userDir, paths.projectDir, paths.privateDir];
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md") || name === ENTRYPOINT) continue;
        files.push(join(dir, name));
      }
    } catch {
      // ignore
    }
  }
  return files.sort();
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
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) || [])];
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
      if (content.trim()) return content.trim();
    }
  }
  return "";
}

function selectRelevantMemories(paths: MemoryPaths, query: string): Array<{ path: string; note: string }> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scored = listMemoryFiles(paths)
    .map((file) => {
      const content = readText(file);
      const fm = parseFrontmatter(content);
      const haystack = `${fm.description || ""}\n${content}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { file, content, description: fm.description || basename(file), score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return scored.map((item) => {
    let freshness = "";
    try {
      const ageDays = Math.max(0, Math.floor((Date.now() - statSync(item.file).mtimeMs) / 86_400_000));
      freshness = ageDays > 1 ? `This memory is ${ageDays} days old. Verify current code/resource claims before relying on them.` : "Recent memory; still verify code/resource claims if the user is about to act on them.";
    } catch {
      freshness = "Verify current code/resource claims before relying on this memory.";
    }
    const excerpt = item.content.length > 1400 ? `${item.content.slice(0, 1400).trim()}\n... [memory truncated]` : item.content.trim();
    return {
      path: item.file,
      note: `### ${item.file}\n${freshness}\n\n${excerpt}`,
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

async function handleRemember(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
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
    ctx.ui.notify('Usage: /remember [type] [scope] :: memory text', 'warning');
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
  ctx.ui.notify(`Saved ${parsed.type} memory to ${filePath}`, "info");
}

async function handleForget(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
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
    ctx.ui.notify(`Multiple matches for '${query}': ${matches.map(summarizeMemoryFile).join('; ')}`, "warning");
    return;
  }

  const dir = dirname(target);
  const fileName = basename(target);
  unlinkSync(target);
  if (dir === paths.userDir) removeIndexEntry(paths.userIndex, fileName);
  else if (dir === paths.privateDir) removeIndexEntry(paths.privateIndex, fileName);
  else removeIndexEntry(paths.projectIndex, fileName);

  ctx.ui.notify(`Forgot memory ${fileName}`, "info");
}

async function handleMemoryStatus(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const paths = await getMemoryPaths(pi, ctx.cwd);
  const counts = {
    user: listMemoryFiles({ ...paths, projectDir: "/__none__", privateDir: "/__none__" } as MemoryPaths).filter((f) => dirname(f) === paths.userDir).length,
    project: listMemoryFiles(paths).filter((f) => dirname(f) === paths.projectDir).length,
    private: listMemoryFiles(paths).filter((f) => dirname(f) === paths.privateDir).length,
  };

  ctx.ui.notify(
    [
      `Memory root: ${paths.baseDir}`,
      `User dir: ${paths.userDir} (${counts.user})`,
      `Project dir: ${paths.projectDir} (${counts.project})`,
      `Private dir: ${paths.privateDir} (${counts.private})`,
    ].join("\n"),
    "info"
  );
}

export default function piMemorySystem(pi: ExtensionAPI) {
  const lastInputBySession = new Map<string, string>();

  pi.on("input", (event, ctx) => {
    lastInputBySession.set(ctx.sessionManager.getSessionId(), event.text || "");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const paths = await getMemoryPaths(pi, ctx.cwd);
    const recentUserQuery = lastInputBySession.get(ctx.sessionManager.getSessionId()) || getRecentUserQuery(ctx);
    const relevant = recentUserQuery ? selectRelevantMemories(paths, recentUserQuery) : [];
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildMemoryPrompt(paths, relevant)}`,
    };
  });

  pi.registerCommand("remember", {
    description: "Save a durable memory. Usage: /remember [type] [scope] :: memory text",
    handler: async (args, ctx) => {
      await handleRemember(args, ctx, pi);
    },
  });

  pi.registerCommand("forget", {
    description: "Remove a matching memory. Usage: /forget <query>",
    handler: async (args, ctx) => {
      await handleForget(args, ctx, pi);
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show active memory directories and file counts",
    handler: async (_args, ctx) => {
      await handleMemoryStatus(ctx, pi);
    },
  });
}
