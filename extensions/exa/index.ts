import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SEARCH_URL = "https://api.exa.ai/search";
const CONTENTS_URL = "https://api.exa.ai/contents";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const USAGE_PATH = join(homedir(), ".pi", "exa-usage.json");
const RESULT_DIR = join(homedir(), ".pi", "agent", "exa-results");
const DEFAULT_NUM_RESULTS = 6;
const DEFAULT_TEXT_CHARS = 6000;
const MAX_INLINE_CHARS = 24000;
const DEFAULT_MONTHLY_LIMIT = 1000;

type ExaType = "instant" | "fast" | "auto" | "deep-lite" | "deep" | "deep-reasoning";
type ContentMode = "highlights" | "summary" | "text" | "none";
type ExaKind = "web" | "code";

type ExaParams = {
  query?: string;
  urls?: string[];
  kind?: ExaKind;
  type?: ExaType;
  numResults?: number;
  content?: ContentMode;
  maxChars?: number;
  domains?: string[];
  since?: string;
  maxAgeHours?: number;
  systemPrompt?: string;
  outputSchema?: unknown;
};

type Usage = { month: string; count: number };
type SearchResult = {
  title?: string;
  url?: string;
  id?: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  highlights?: string[];
  summary?: unknown;
};

type ExaResponse = {
  requestId?: string;
  searchType?: string;
  results?: SearchResult[];
  output?: { content?: unknown; grounding?: unknown };
  costDollars?: { total?: number };
};

function enumValues<const T extends string[]>(values: T, description?: string) {
  return Type.Union(values.map((value) => Type.Literal(value)), { description });
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function shellSecret(command: string): string | null {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      shell: "/bin/zsh",
    }).trim() || null;
  } catch {
    return null;
  }
}

function resolveSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("!")) return shellSecret(trimmed.slice(1));
  return trimmed;
}

function getApiKey(): string | null {
  return resolveSecret(process.env.EXA_API_KEY) ?? resolveSecret(readJson(CONFIG_PATH).exaApiKey);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function monthlyLimit(): number {
  const raw = Number(process.env.PI_EXA_MONTHLY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MONTHLY_LIMIT;
}

function readUsage(): Usage {
  if (!existsSync(USAGE_PATH)) return { month: currentMonth(), count: 0 };
  try {
    const raw = JSON.parse(readFileSync(USAGE_PATH, "utf8")) as Partial<Usage>;
    if (raw.month !== currentMonth()) return { month: currentMonth(), count: 0 };
    return { month: raw.month, count: Math.max(0, Math.floor(Number(raw.count) || 0)) };
  } catch {
    return { month: currentMonth(), count: 0 };
  }
}

function writeUsage(usage: Usage): void {
  mkdirSync(join(homedir(), ".pi"), { recursive: true });
  writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2) + "\n");
}

function reserveBudget(): Usage {
  const usage = readUsage();
  const limit = monthlyLimit();
  if (usage.count >= limit) {
    throw new Error(`Exa monthly budget exhausted (${usage.count}/${limit}). Set PI_EXA_MONTHLY_LIMIT to override.`);
  }
  const next = { month: usage.month, count: usage.count + 1 };
  writeUsage(next);
  return next;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function splitDomains(domains: string[] | undefined): { includeDomains?: string[]; excludeDomains?: string[] } {
  const includeDomains: string[] = [];
  const excludeDomains: string[] = [];
  for (const domain of domains ?? []) {
    const trimmed = domain.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("-")) excludeDomains.push(trimmed.slice(1));
    else includeDomains.push(trimmed);
  }
  return {
    ...(includeDomains.length ? { includeDomains } : {}),
    ...(excludeDomains.length ? { excludeDomains } : {}),
  };
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function queryForKind(query: string, kind: ExaKind | undefined): string {
  if (kind !== "code") return query;
  if (/\b(api|code|docs?|documentation|example|github|implementation|library|source|stackoverflow|stack overflow)\b/i.test(query)) {
    return query;
  }
  return `${query} code examples API docs GitHub Stack Overflow official documentation`;
}

function contentForSearch(params: ExaParams): Record<string, unknown> | undefined {
  const mode = params.content ?? "highlights";
  if (mode === "none") return undefined;

  const contents: Record<string, unknown> = {};
  const maxChars = positiveInt(params.maxChars, DEFAULT_TEXT_CHARS, 50000);
  if (mode === "text") contents.text = { maxCharacters: maxChars };
  if (mode === "summary") contents.summary = params.query ? { query: params.query } : true;
  if (mode === "highlights") contents.highlights = params.maxChars ? { maxCharacters: maxChars } : true;
  if (Number.isFinite(params.maxAgeHours)) contents.maxAgeHours = Math.floor(Number(params.maxAgeHours));
  return contents;
}

function bodyForSearch(params: ExaParams): Record<string, unknown> {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) throw new Error("Provide query for search, or urls for content fetch.");

  const body: Record<string, unknown> = {
    query: queryForKind(query, params.kind),
    type: params.type ?? "auto",
    numResults: positiveInt(params.numResults, DEFAULT_NUM_RESULTS, 100),
    ...splitDomains(params.domains),
  };
  const contents = contentForSearch(params);
  if (contents) body.contents = contents;
  if (params.since) body.startPublishedDate = params.since;
  if (params.systemPrompt) body.systemPrompt = params.systemPrompt;
  if (params.outputSchema) body.outputSchema = params.outputSchema;
  return body;
}

function bodyForContents(params: ExaParams): Record<string, unknown> {
  const urls = asStringArray(params.urls);
  if (urls.length === 0) throw new Error("Provide one or more urls.");

  const body: Record<string, unknown> = { urls };
  const mode = params.content ?? "text";
  const maxChars = positiveInt(params.maxChars, DEFAULT_TEXT_CHARS, 50000);
  if (mode === "text") body.text = { maxCharacters: maxChars };
  if (mode === "highlights") body.highlights = params.maxChars ? { maxCharacters: maxChars } : true;
  if (mode === "summary") body.summary = params.query ? { query: params.query } : true;
  if (Number.isFinite(params.maxAgeHours)) body.maxAgeHours = Math.floor(Number(params.maxAgeHours));
  return body;
}

async function postExa(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ExaResponse> {
  const key = getApiKey();
  if (!key) throw new Error("Missing EXA_API_KEY or exaApiKey in ~/.pi/web-search.json.");
  reserveBudget();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = typeof data === "object" && data && "error" in data
      ? String((data as { error?: unknown }).error)
      : text.slice(0, 500);
    throw new Error(`Exa API ${response.status}: ${message}`);
  }
  return data as ExaResponse;
}

function saveResult(kind: "search" | "contents", body: Record<string, unknown>, response: ExaResponse): string {
  mkdirSync(RESULT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const hash = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 8);
  const file = join(RESULT_DIR, `${stamp}-${kind}-${hash}.json`);
  writeFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), kind, request: body, response }, null, 2) + "\n");
  return file;
}

function oneLine(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : JSON.stringify(value);
}

function excerpt(result: SearchResult): string {
  if (Array.isArray(result.highlights) && result.highlights.length > 0) {
    return result.highlights.map((item) => `   > ${item.replace(/\s+/g, " ").trim()}`).join("\n");
  }
  if (result.summary) return `   ${oneLine(result.summary)}`;
  if (result.text) return `   ${result.text.trim().slice(0, 1800)}`;
  return "";
}

function formatResponse(kind: "search" | "contents", response: ExaResponse, file: string, usage: Usage): string {
  const results = response.results ?? [];
  const lines: string[] = [];
  const cost = response.costDollars?.total;
  const meta = [
    response.searchType ? `type=${response.searchType}` : undefined,
    response.requestId ? `request=${response.requestId}` : undefined,
    typeof cost === "number" ? `cost=$${cost.toFixed(4)}` : undefined,
    `usage=${usage.count}/${monthlyLimit()}`,
  ].filter(Boolean).join(" · ");

  lines.push(`# Exa ${kind}`);
  if (meta) lines.push(meta);
  lines.push(`Full JSON: ${file}`);

  if (response.output?.content !== undefined) {
    lines.push("\n## Synthesized output");
    lines.push(oneLine(response.output.content));
  }

  if (results.length > 0) lines.push("\n## Results");
  results.forEach((result, index) => {
    const title = result.title || result.url || `Result ${index + 1}`;
    const url = result.url || result.id || "";
    const bits = [result.publishedDate?.slice(0, 10), result.author].filter(Boolean).join(" · ");
    lines.push(`${index + 1}. ${url ? `[${title}](${url})` : title}${bits ? ` — ${bits}` : ""}`);
    const body = excerpt(result);
    if (body) lines.push(body);
  });

  let output = lines.join("\n");
  if (output.length > MAX_INLINE_CHARS) {
    output = `${output.slice(0, MAX_INLINE_CHARS).trimEnd()}\n\n[Truncated. Read full JSON at ${file}]`;
  }
  return output;
}

export default function exaExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "exa",
    label: "Exa",
    description: "Search Exa or fetch URL content. Defaults to auto search with highlights. Use kind=code for docs/code/API searches.",
    promptSnippet: "Use exa for current web/code search or URL content; pass query or urls.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query; optional summary question for urls" })),
      urls: Type.Optional(Type.Array(Type.String(), { description: "Fetch these URLs instead of searching" })),
      kind: Type.Optional(enumValues(["web", "code"], "Default web; code biases query toward docs/examples")),
      type: Type.Optional(enumValues(["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"], "Search depth; default auto")),
      numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Default 6" })),
      content: Type.Optional(enumValues(["highlights", "summary", "text", "none"], "Default highlights for search, text for urls")),
      maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 50000, description: "Cap text/highlights chars" })),
      domains: Type.Optional(Type.Array(Type.String(), { description: "Include domains; prefix - to exclude" })),
      since: Type.Optional(Type.String({ description: "startPublishedDate ISO/date" })),
      maxAgeHours: Type.Optional(Type.Integer({ minimum: -1, description: "0 livecrawl; -1 cache only" })),
      systemPrompt: Type.Optional(Type.String({ description: "Exa synthesis/source instructions" })),
      outputSchema: Type.Optional(Type.Any({ description: "Exa outputSchema for synthesized output" })),
    }),
    async execute(_toolCallId, params, signal) {
      const input = params as ExaParams;
      const isContents = asStringArray(input.urls).length > 0;
      const body = isContents ? bodyForContents(input) : bodyForSearch(input);
      const response = await postExa(isContents ? CONTENTS_URL : SEARCH_URL, body, signal);
      const file = saveResult(isContents ? "contents" : "search", body, response);
      const usage = readUsage();
      pi.appendEntry("exa-result", { kind: isContents ? "contents" : "search", path: file, requestId: response.requestId, ts: new Date().toISOString() });
      return {
        content: [{ type: "text", text: formatResponse(isContents ? "contents" : "search", response, file, usage) }],
        details: { path: file, results: response.results?.length ?? 0, requestId: response.requestId, usage },
      };
    },
    renderCall(args, theme) {
      const params = args as ExaParams;
      const urls = asStringArray(params.urls);
      const title = urls.length > 0 ? `${urls.length} url${urls.length === 1 ? "" : "s"}` : (params.query || "(no query)");
      const clipped = title.length > 80 ? title.slice(0, 77) + "..." : title;
      return new Text(theme.fg("toolTitle", theme.bold("exa ")) + theme.fg("accent", clipped), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as { results?: number; path?: string; usage?: Usage } | undefined;
      const status = theme.fg("success", `Exa returned ${details?.results ?? 0} result(s)`) +
        (details?.usage ? theme.fg("muted", ` · ${details.usage.count}/${monthlyLimit()}`) : "");
      if (!expanded) return new Text(status, 0, 0);
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      return new Text(`${status}\n${theme.fg("dim", text.slice(0, 1000))}`, 0, 0);
    },
  });
}
