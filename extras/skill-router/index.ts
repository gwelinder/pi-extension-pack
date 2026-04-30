import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

type SkillEntry = {
  name: string;
  commandName: string;
  path?: string;
  description: string;
  tags: string[];
  hidden: boolean;
  mtimeMs: number;
  sourceScope: string;
  sourceOrigin: string;
};

type RankedSkill = SkillEntry & {
  score: number;
  overlapCount: number;
  matchedTokens: string[];
};

type SessionState = {
  lastInputText: string;
  firstExternalTurnHandled: boolean;
};

type IndexCache = {
  signature: string;
  entries: SkillEntry[];
  tokenDocumentFrequency: Map<string, number>;
};

const AUTO_INJECTION_BUDGET_MS = 150;
const AUTO_INJECTION_TOP_K = 3;
const AUTO_INJECTION_SCORE_FLOOR = 30;
const EXPLICIT_LOOKUP_TOP_K = 8;
const TOOL_LOOKUP_TOP_K = 5;
const INTERNAL_PREFIXES = [
  "IMPORTANT: This instruction message is NOT part of the actual user conversation",
  "IMPORTANT: This message and these instructions are NOT part of the actual user conversation",
];

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "help",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "let",
  "lets",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "out",
  "should",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "up",
  "use",
  "using",
  "we",
  "what",
  "when",
  "with",
  "you",
  "your",
]);

function normalizeName(raw: string): string {
  return raw.trim().replace(/^skill:/i, "").toLowerCase();
}

function normalizePathMaybe(rawPath: string | undefined, cwd: string): string | undefined {
  if (!rawPath || rawPath.trim() === "") return undefined;
  let resolvedPath = rawPath.trim();
  if (resolvedPath.startsWith("@")) resolvedPath = resolvedPath.slice(1);
  if (resolvedPath.startsWith("~/")) resolvedPath = path.join(homedir(), resolvedPath.slice(2));
  return path.normalize(path.isAbsolute(resolvedPath) ? resolvedPath : path.resolve(cwd, resolvedPath));
}

function isInternalInput(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  return INTERNAL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function extractFrontmatter(text: string): string | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return undefined;
  return text.slice(4, end);
}

function parseFrontmatter(text: string): Record<string, string> {
  const frontmatter = extractFrontmatter(text);
  if (!frontmatter) return {};

  const out: Record<string, string> = {};
  const lines = frontmatter.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }

    const key = match[1];
    const value = match[2];

    if (value === ">" || value === "|") {
      const parts: string[] = [];
      i += 1;
      while (i < lines.length) {
        const current = lines[i];
        if (current.startsWith(" ") || current.startsWith("\t") || current === "") {
          parts.push(current.trim());
          i += 1;
          continue;
        }
        break;
      }
      out[key] = parts.filter(Boolean).join(" ").trim();
      continue;
    }

    out[key] = value.trim();
    i += 1;
  }

  return out;
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((tag) => tag.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return trimmed ? [trimmed.replace(/^['"]|['"]$/g, "")] : [];
}

function tokenize(input: string): string[] {
  const normalized = input
    .toLowerCase()
    .replace(/twitter\/x/g, "twitter x")
    .replace(/[\/]/g, " ");

  const roughParts = normalized.match(/[a-z0-9][a-z0-9+-]*/g) || [];
  const tokens: string[] = [];
  const seen = new Set<string>();

  const push = (token: string) => {
    if (token.length <= 1) return;
    if (STOPWORDS.has(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  for (const part of roughParts) {
    push(part);
    for (const subPart of part.split(/[-+]/g)) push(subPart);
  }

  return tokens;
}

function buildTokenDocumentFrequency(entries: SkillEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const tokens = new Set<string>([
      ...tokenize(entry.name),
      ...tokenize(entry.description),
      ...entry.tags.flatMap((tag) => tokenize(tag)),
    ]);
    for (const token of tokens) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return counts;
}

function truncate(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 1).trim()}…`;
}

function scoreEntry(query: string, entry: SkillEntry, tokenDocumentFrequency: Map<string, number>, corpusSize: number): RankedSkill {
  const queryTokens = tokenize(query);
  const nameTokens = tokenize(entry.name);
  const descriptionTokens = tokenize(entry.description);
  const tagTokens = entry.tags.flatMap((tag) => tokenize(tag));
  const nameRaw = entry.name.toLowerCase();
  const descriptionRaw = entry.description.toLowerCase();
  const tagsRaw = entry.tags.join(" ").toLowerCase();
  const fullRaw = `${nameRaw} ${descriptionRaw} ${tagsRaw}`;
  const queryRaw = query.toLowerCase().trim();

  let score = 0;
  const matchedTokens: string[] = [];
  const matchedSet = new Set<string>();

  if (queryRaw && fullRaw.includes(queryRaw)) score += 8;
  if (queryRaw && nameRaw.includes(queryRaw)) score += 12;

  for (const token of queryTokens) {
    const documentFrequency = tokenDocumentFrequency.get(token) || 0;
    const idf = Math.log((corpusSize + 1) / (documentFrequency + 1)) + 1;
    let matched = false;

    if (nameTokens.includes(token)) {
      score += 6 * idf;
      matched = true;
    } else if (token.length >= 4 && nameRaw.includes(token)) {
      score += 3 * idf;
      matched = true;
    }

    if (tagTokens.includes(token)) {
      score += 4 * idf;
      matched = true;
    } else if (token.length >= 4 && tagsRaw.includes(token)) {
      score += 2 * idf;
      matched = true;
    }

    if (descriptionTokens.includes(token)) {
      score += 2 * idf;
      matched = true;
    } else if (token.length >= 4 && descriptionRaw.includes(token)) {
      score += 0.75 * idf;
      matched = true;
    }

    if (matched && !matchedSet.has(token)) {
      matchedSet.add(token);
      matchedTokens.push(token);
    }
  }

  const normalizedQuery = queryTokens.join(" ");
  const normalizedCorpus = [...nameTokens, ...tagTokens, ...descriptionTokens].join(" ");
  if (normalizedQuery && normalizedCorpus.includes(normalizedQuery)) score += 6;

  return {
    ...entry,
    score,
    overlapCount: matchedTokens.length,
    matchedTokens,
  };
}

function buildPromptBlock(candidates: RankedSkill[]): string {
  const lines = [
    "# Hidden skill candidates",
    "These specialist skills are hidden by default but look relevant to the user's first request.",
    "Load one explicitly with /skill:name only if it is clearly useful.",
    "",
  ];

  for (const candidate of candidates) {
    const tags = candidate.tags.length ? ` [tags: ${candidate.tags.slice(0, 4).join(", ")}]` : "";
    lines.push(`- /skill:${candidate.name} — ${truncate(candidate.description, 180)}${tags}`);
  }

  lines.push("", "If none of these are clearly helpful, ignore this section.");
  return lines.join("\n");
}

function readSkillMetadata(filePath: string | undefined): { description?: string; tags: string[]; hidden: boolean; mtimeMs: number } {
  if (!filePath || !fs.existsSync(filePath)) {
    return { tags: [], hidden: false, mtimeMs: 0 };
  }

  try {
    const text = fs.readFileSync(filePath, "utf8");
    const frontmatter = parseFrontmatter(text);
    return {
      description: (frontmatter.description || "").replace(/^['"]|['"]$/g, "").trim() || undefined,
      tags: parseTags(frontmatter.tags),
      hidden: String(frontmatter["disable-model-invocation"] || "").toLowerCase() === "true",
      mtimeMs: fs.statSync(filePath).mtimeMs,
    };
  } catch {
    return { tags: [], hidden: false, mtimeMs: 0 };
  }
}

function formatResultLines(query: string, results: RankedSkill[], elapsedMs: number, rebuilt: boolean): string[] {
  if (results.length === 0) {
    return [`Skill matches for: ${query}`, `Index rebuilt: ${rebuilt ? "yes" : "no"}`, `Lookup time: ${elapsedMs} ms`, "", "(no matches)"];
  }

  const lines = [
    `Skill matches for: ${query}`,
    `Index rebuilt: ${rebuilt ? "yes" : "no"}`,
    `Lookup time: ${elapsedMs} ms`,
    "",
  ];

  for (const result of results) {
    const visibility = result.hidden ? "hidden" : "visible";
    const matched = result.matchedTokens.length ? ` matched=${result.matchedTokens.join(",")}` : "";
    const tags = result.tags.length ? ` tags=${result.tags.join(",")}` : "";
    lines.push(`- ${result.name} [${visibility}] score=${result.score.toFixed(1)}${matched}${tags}`);
    lines.push(`  ${truncate(result.description, 180)}`);
  }

  return lines;
}

export default function skillRouterExtension(pi: ExtensionAPI) {
  const sessionState = new Map<string, SessionState>();
  let cache: IndexCache | null = null;

  function getState(sessionId: string): SessionState {
    const existing = sessionState.get(sessionId);
    if (existing) return existing;
    const next: SessionState = {
      lastInputText: "",
      firstExternalTurnHandled: false,
    };
    sessionState.set(sessionId, next);
    return next;
  }

  function buildIndex(cwd: string): { cache: IndexCache; elapsedMs: number } {
    const startedAt = Date.now();
    const commands = pi.getCommands().filter((command: any) => command.source === "skill") as Array<any>;
    const entries: SkillEntry[] = [];
    const seenNames = new Set<string>();
    const signatureParts: string[] = [];

    for (const command of commands) {
      const commandName = typeof command.name === "string" ? command.name : "";
      const skillName = normalizeName(commandName);
      if (!skillName || seenNames.has(skillName)) continue;
      seenNames.add(skillName);

      const sourceInfo = command.sourceInfo || {};
      const sourcePath = normalizePathMaybe(sourceInfo.path, cwd);
      const metadata = readSkillMetadata(sourcePath);
      const description = metadata.description || (command.description || "").trim();

      const entry: SkillEntry = {
        name: skillName,
        commandName,
        path: sourcePath,
        description,
        tags: metadata.tags,
        hidden: metadata.hidden,
        mtimeMs: metadata.mtimeMs,
        sourceScope: String(sourceInfo.scope || "unknown"),
        sourceOrigin: String(sourceInfo.origin || "unknown"),
      };

      entries.push(entry);
      signatureParts.push([
        entry.commandName,
        entry.path || "",
        entry.description,
        entry.tags.join(","),
        entry.hidden ? "hidden" : "visible",
        entry.sourceScope,
        entry.sourceOrigin,
        String(Math.round(entry.mtimeMs)),
      ].join("|"));
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    const nextCache: IndexCache = {
      signature: `${entries.length}:${signatureParts.join("||")}`,
      entries,
      tokenDocumentFrequency: buildTokenDocumentFrequency(entries),
    };

    return { cache: nextCache, elapsedMs: Date.now() - startedAt };
  }

  function ensureFreshIndex(cwd: string): { cache: IndexCache; elapsedMs: number; rebuilt: boolean } {
    const next = buildIndex(cwd);
    if (!cache || cache.signature !== next.cache.signature) {
      cache = next.cache;
      return { cache, elapsedMs: next.elapsedMs, rebuilt: true };
    }
    return { cache, elapsedMs: next.elapsedMs, rebuilt: false };
  }

  function searchSkills(query: string, cwd: string, includeVisible: boolean, limit: number): { results: RankedSkill[]; elapsedMs: number; rebuilt: boolean } {
    const startedAt = Date.now();
    const ensured = ensureFreshIndex(cwd);
    const entries = includeVisible ? ensured.cache.entries : ensured.cache.entries.filter((entry) => entry.hidden);
    const corpusSize = Math.max(entries.length, 1);

    const ranked = entries
      .map((entry) => scoreEntry(query, entry, ensured.cache.tokenDocumentFrequency, corpusSize))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.overlapCount !== a.overlapCount) return b.overlapCount - a.overlapCount;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit);

    return {
      results: ranked,
      elapsedMs: Date.now() - startedAt,
      rebuilt: ensured.rebuilt,
    };
  }

  function shouldAutoInject(results: RankedSkill[]): boolean {
    if (results.length === 0) return false;
    return results[0].score >= AUTO_INJECTION_SCORE_FLOOR;
  }

  const skillLookupTool = defineTool({
    name: "skill_lookup",
    label: "Skill Lookup",
    description: "Search Pi's live skill catalog for relevant visible and hidden skills by task description. Use this when you are unsure which skill to load.",
    parameters: Type.Object({
      query: Type.String({ description: "Task description or skill query" }),
      includeVisible: Type.Optional(Type.Boolean({ description: "Whether to include already-visible skills", default: true })),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return", default: TOOL_LOOKUP_TOP_K })),
    }),
    promptGuidelines: [
      "Use skill_lookup when you need to discover the most relevant Pi skill for a task.",
      "Prefer it when a hidden specialist skill may exist but is not obvious from the current prompt.",
      "Load a returned skill explicitly with /skill:name only when it is clearly useful.",
    ],
    renderShell: "self",
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("skill_lookup"))} ${theme.fg("muted", truncate(String(args.query || ""), 96))}`,
        0,
        0,
      );
    },
    renderResult(result, state, theme) {
      if (state.isPartial) {
        return new Text(theme.fg("muted", "Searching skill catalog…"), 0, 0);
      }

      const details = (result as any)?.details || {};
      const query = String(details.query || "").trim();
      const results = Array.isArray(details.results) ? details.results : [];
      const header = `${theme.fg("success", `Skill lookup`)} ${theme.fg("muted", `(${details.elapsedMs ?? 0} ms${details.rebuilt ? ", rebuilt" : ""})`)}`;

      if (results.length === 0) {
        return new Text(`${header}\n${theme.fg("warning", `No skills matched${query ? `: ${query}` : "."}`)}`, 0, 0);
      }

      const body = results
        .map((item: any) => {
          const visibility = item.hidden ? theme.fg("warning", "hidden") : theme.fg("success", "visible");
          const matched = Array.isArray(item.matchedTokens) && item.matchedTokens.length > 0
            ? ` · ${theme.fg("muted", item.matchedTokens.join(", "))}`
            : "";
          return `• ${theme.fg("accent", item.name)} ${theme.fg("muted", `[${visibility}] score=${Number(item.score || 0).toFixed(1)}`)}${matched}`;
        })
        .join("\n");

      return new Text(`${header}\n${body}`, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const limit = Math.max(1, Math.min(12, Math.round(params.limit || TOOL_LOOKUP_TOP_K)));
      const search = searchSkills(params.query, ctx.cwd, params.includeVisible !== false, limit);
      const content = formatResultLines(params.query, search.results, search.elapsedMs, search.rebuilt).join("\n");
      return {
        content: [{ type: "text", text: content }],
        details: {
          query: params.query,
          rebuilt: search.rebuilt,
          elapsedMs: search.elapsedMs,
          results: search.results.map((result) => ({
            name: result.name,
            hidden: result.hidden,
            score: result.score,
            overlapCount: result.overlapCount,
            matchedTokens: result.matchedTokens,
            tags: result.tags,
            path: result.path,
            commandName: result.commandName,
            sourceScope: result.sourceScope,
            sourceOrigin: result.sourceOrigin,
          })),
        },
      };
    },
  });

  pi.registerTool(skillLookupTool);

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    sessionState.set(sessionId, { lastInputText: "", firstExternalTurnHandled: false });
  });

  pi.on("input", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(sessionId);
    const text = String((event as any).text || "");
    if (isInternalInput(text)) return;
    if (text.trim().startsWith("/skill-find")) return;
    state.lastInputText = text;
  });

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(sessionId);
    const query = state.lastInputText.trim();

    if (state.firstExternalTurnHandled) return;
    if (!query || isInternalInput(query)) return;

    state.firstExternalTurnHandled = true;

    const search = searchSkills(query, ctx.cwd, false, AUTO_INJECTION_TOP_K);
    if (search.elapsedMs > AUTO_INJECTION_BUDGET_MS) {
      ctx.ui.notify(`skill-router skipped auto-injection (index/search took ${search.elapsedMs} ms > ${AUTO_INJECTION_BUDGET_MS} ms budget)`, "info");
      return;
    }

    if (!shouldAutoInject(search.results)) return;

    const addition = buildPromptBlock(search.results);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${addition}`,
    };
  });

  pi.registerCommand("skill-find", {
    description: "Find the most relevant skills for a task or query",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        const message = "Usage: /skill-find <query>";
        ctx.ui.notify(message, "info");
        pi.sendMessage({ customType: "skill-find", content: message, display: true });
        return;
      }

      const search = searchSkills(query, ctx.cwd, true, EXPLICIT_LOOKUP_TOP_K);
      if (search.results.length === 0) {
        const message = `No skills matched: ${query}`;
        ctx.ui.notify(message, "info");
        pi.sendMessage({ customType: "skill-find", content: message, display: true, details: { query, results: [] } });
        return;
      }

      const content = formatResultLines(query, search.results, search.elapsedMs, search.rebuilt).join("\n");
      ctx.ui.notify(`skill-router found ${search.results.length} matches`, "info");
      pi.sendMessage({
        customType: "skill-find",
        content,
        display: true,
        details: {
          query,
          rebuilt: search.rebuilt,
          elapsedMs: search.elapsedMs,
          results: search.results.map((result) => ({
            name: result.name,
            hidden: result.hidden,
            score: result.score,
            overlapCount: result.overlapCount,
            matchedTokens: result.matchedTokens,
            tags: result.tags,
            path: result.path,
            commandName: result.commandName,
            sourceScope: result.sourceScope,
            sourceOrigin: result.sourceOrigin,
          })),
        },
      });
    },
  });
}
