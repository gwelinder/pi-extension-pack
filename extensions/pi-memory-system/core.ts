import { createHash } from "node:crypto";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "user" | "private" | "project";
export type MemorySource = "native" | "canonical";

export type MemoryCandidate = {
  id: string;
  source: MemorySource;
  path?: string;
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
  updatedAt?: string;
  mtimeMs?: number;
  active?: boolean;
  agentSafe?: boolean;
  visibility?: string;
  sensitivity?: string;
  projectId?: string;
  sourceUris: string[];
  supersedes: string[];
};

export type BobbyManifest = {
  canonicalMemoryRoot?: string;
  records: MemoryCandidate[];
};

export type MemoryProposal = {
  proposalType: "create" | "deprecate";
  record?: {
    name: string;
    description: string;
    type: MemoryType;
    scope: MemoryScope;
    body: string;
  };
  targetRecordId?: string;
  provenance: {
    source: "pi-explicit" | "pi-inferred";
    contentHash?: string;
    projectId?: string;
    evidenceUri?: string;
  };
};

export type ExtractionCandidate = {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
};

export type RankedMemory = MemoryCandidate & { score: number };

const MEMORY_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const MEMORY_SCOPES = new Set<MemoryScope>(["user", "private", "project"]);
const MAX_RELEVANT_RECORDS = 2;
const MAX_RELEVANT_CHARS = 1200;
const MAX_EXTRACTION_CANDIDATES = 3;
const MAX_EXTRACTION_BODY_CHARS = 1200;

const QUERY_STOP_WORDS = new Set([
  "about", "after", "again", "also", "any", "are", "can", "could", "exactly", "for", "from", "have",
  "hello", "help", "hey", "how", "just", "know", "okay", "please", "question", "reply", "should",
  "that", "thanks", "their", "there", "these", "they", "this", "what", "when", "where", "which", "with",
  "would", "your", "you", "the", "and", "but", "not", "our", "pi", "task", "thing", "things",
]);

const SECRET_PATTERNS = [
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:ghp|github_pat|glpat|xox[baprs])_[A-Za-z0-9_-]{20,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*['"]?[^\s'"`]{12,}/gi,
];

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown, max = 10_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function firstString(object: Record<string, unknown>, keys: string[], max?: number): string | undefined {
  for (const key of keys) {
    const value = asString(object[key], max);
    if (value) return value;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(values.map((item) => asString(item, 500)).filter((item): item is string => Boolean(item)))];
}

function parseType(value: unknown, fallback: MemoryType = "reference"): MemoryType {
  if (typeof value !== "string") return fallback;
  if (MEMORY_TYPES.has(value as MemoryType)) return value as MemoryType;
  if (value === "preference" || value === "constraint" || value === "decision") return "feedback";
  if (value === "fact") return "user";
  return fallback;
}

function parseScope(value: unknown, fallback: MemoryScope = "project"): MemoryScope {
  if (typeof value !== "string") return fallback;
  if (MEMORY_SCOPES.has(value as MemoryScope)) return value as MemoryScope;
  if (value.startsWith("project:")) return "project";
  return fallback;
}

function projectIdFromScope(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("project:")
    ? value.slice("project:".length).trim() || undefined
    : undefined;
}

export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function tokenizeExact(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [])
    .filter((token) => !QUERY_STOP_WORDS.has(token)))];
}

export function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { fields: {}, body: content.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().replace(/-/g, "_");
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) fields[key] = value;
  }
  return { fields, body: content.slice(match[0].length).trim() };
}

export function parseNativeMemory(path: string, content: string, mtimeMs = 0): MemoryCandidate {
  const { fields, body } = parseFrontmatter(content);
  return {
    id: path,
    source: "native",
    path,
    name: fields.name || path.split(/[\\/]/).pop()?.replace(/\.md$/, "") || "native-memory",
    description: fields.description || "Native Pi memory",
    type: parseType(fields.type),
    scope: parseScope(fields.scope),
    body,
    updatedAt: fields.updated_at,
    mtimeMs,
    sourceUris: [`file://${path}`],
    supersedes: [],
  };
}

function parseCanonicalRecord(value: unknown): MemoryCandidate | null {
  const object = asObject(value);
  if (!object) return null;
  const id = firstString(object, ["id", "recordId", "record_id", "canonicalId", "canonical_id"], 300);
  if (!id) return null;
  const visibility = firstString(object, ["visibility", "audience"], 80);
  const sensitivity = firstString(object, ["sensitivity"], 80)?.toLowerCase();
  const sourcePath = firstString(object, ["path", "record_path", "file", "filePath", "file_path"], 2_000);
  const status = firstString(object, ["status", "lifecycle", "state"], 80)?.toLowerCase();
  const active = status ? status === "active" : asBoolean(object.active);
  const explicitAgentSafe = asBoolean(object.agentSafe) ?? asBoolean(object.agent_safe);
  const audience = Array.isArray(object.audience) ? object.audience.map(String) : [];
  const inferredAgentSafe = sensitivity === "agent_safe"
    || visibility === "agent"
    || visibility === "agent-safe"
    || audience.includes("agent");
  const agentSafe = explicitAgentSafe ?? (inferredAgentSafe ? true : undefined);
  return {
    id,
    source: "canonical",
    path: sourcePath,
    name: firstString(object, ["name", "title"], 160) || id,
    description: firstString(object, ["description", "summary"], 320) || "Canonical memory",
    type: parseType(object.type ?? object.kind),
    scope: parseScope(object.scope),
    body: firstString(object, ["body", "content", "text", "markdown"], 20_000) || "",
    updatedAt: firstString(object, ["updatedAt", "updated_at", "updated"], 80),
    active,
    agentSafe,
    visibility,
    sensitivity,
    projectId: projectIdFromScope(object.scope),
    sourceUris: [...stringArray(object.sourceUris), ...stringArray(object.source_uris)],
    supersedes: [
      ...stringArray(object.supersedes),
      ...stringArray(object.supersedesIds),
      ...stringArray(object.supersedes_ids),
      ...stringArray(object.sourceIds),
      ...stringArray(object.source_ids),
      ...stringArray(object.supersededNativePaths),
      ...stringArray(object.superseded_native_paths),
    ],
  };
}

export function parseBobbyManifest(value: unknown): BobbyManifest | null {
  const object = asObject(value);
  if (!object) return null;
  const rawRecords = object.records ?? object.canonicalRecords ?? object.canonical_records ?? object.memories;
  if (rawRecords !== undefined && !Array.isArray(rawRecords)) return null;
  const records = (rawRecords || []).map(parseCanonicalRecord).filter((record): record is MemoryCandidate => Boolean(record));
  return {
    canonicalMemoryRoot: firstString(object, ["canonicalMemoryRoot", "canonical_memory_root", "canonical_root", "root"], 2_000),
    records,
  };
}

function quotedListValues(content: string, field: string): string[] {
  const block = new RegExp(`^${field}:\\s*\\n((?:  - .+\\n?)*)`, "m").exec(content)?.[1] || "";
  return [...block.matchAll(/^  -\s+["']?([^"'\n]+)["']?\s*$/gm)].map((match) => match[1]!.trim());
}

function canonicalEvidenceUris(content: string): string[] {
  return [...content.matchAll(/^\s+uri:\s+["']?([^"'\n]+)["']?\s*$/gm)].map((match) => match[1]!.trim());
}

export function hydrateCanonicalMemory(record: MemoryCandidate, content: string): MemoryCandidate {
  const { fields, body } = parseFrontmatter(content);
  const fieldStatus = fields.status?.toLowerCase();
  const sensitivity = (record.sensitivity || fields.sensitivity || "").toLowerCase();
  const fieldAgentSafe = sensitivity === "agent_safe"
    || fields.agent_safe?.toLowerCase() === "true"
    || fields.agentSafe?.toLowerCase() === "true";
  const scopeValue = fields.scope || (record.projectId ? `project:${record.projectId}` : record.scope);
  return {
    ...record,
    name: record.name === record.id ? (fields.title || fields.name || record.name) : record.name,
    description: record.description === "Canonical memory" ? (fields.summary || fields.description || record.description) : record.description,
    type: record.type === "reference" ? parseType(fields.kind || fields.type, record.type) : record.type,
    scope: parseScope(scopeValue, record.scope),
    projectId: record.projectId || projectIdFromScope(fields.scope),
    body: record.body || body.replace(/^#\s+.*\n+/, "").trim(),
    updatedAt: record.updatedAt || fields.updated_at,
    active: record.active ?? (fieldStatus ? fieldStatus === "active" : undefined),
    agentSafe: record.agentSafe ?? fieldAgentSafe,
    visibility: record.visibility || fields.visibility,
    sensitivity: sensitivity || undefined,
    sourceUris: [...new Set([...record.sourceUris, ...canonicalEvidenceUris(content)])],
    supersedes: [...new Set([...record.supersedes, ...stringArray(fields.supersedes), ...quotedListValues(content, "supersedes")])],
  };
}

export function isAgentSafeCanonical(record: MemoryCandidate): boolean {
  return record.source === "canonical"
    && record.active === true
    && record.agentSafe === true
    && record.scope !== "private"
    && record.visibility !== "private";
}

function normalizedFingerprint(candidate: MemoryCandidate): string {
  return `${candidate.name}\n${candidate.description}\n${candidate.body}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalWinsOverNative(canonical: MemoryCandidate, native: MemoryCandidate): boolean {
  const nativeReferences = new Set([
    native.id,
    native.path || "",
    native.path ? `file://${native.path}` : "",
    native.path?.split(/[\\/]/).pop() || "",
  ]);
  if ([canonical.id, ...canonical.supersedes, ...canonical.sourceUris].some((reference) => nativeReferences.has(reference))) return true;
  const canonicalFingerprint = normalizedFingerprint(canonical);
  const nativeFingerprint = normalizedFingerprint(native);
  return canonicalFingerprint.length >= 24 && canonicalFingerprint === nativeFingerprint;
}

function scoreCandidate(candidate: MemoryCandidate, queryTokens: string[], query: string): number {
  const nameTokens = new Set(tokenizeExact(candidate.name));
  const descriptionTokens = new Set(tokenizeExact(candidate.description));
  const bodyTokens = new Set(tokenizeExact(candidate.body.slice(0, 8_000)));
  let score = 0;
  let strongMatches = 0;
  let bodyMatches = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) { score += 7; strongMatches += 1; }
    if (descriptionTokens.has(token)) { score += 5; strongMatches += 1; }
    if (bodyTokens.has(token)) { score += 2; bodyMatches += 1; }
  }
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length >= 8) {
    if (candidate.name.toLowerCase().includes(normalizedQuery)) { score += 10; strongMatches += 1; }
    else if (candidate.description.toLowerCase().includes(normalizedQuery)) { score += 7; strongMatches += 1; }
  }
  if ((queryTokens.length === 1 && strongMatches === 0) || (queryTokens.length >= 2 && strongMatches === 0 && bodyMatches < 2)) return 0;
  return score;
}

export function rankRelevantMemories(native: MemoryCandidate[], canonical: MemoryCandidate[], query: string, currentProjectId?: string): RankedMemory[] {
  const queryTokens = tokenizeExact(query);
  if (queryTokens.length === 0) return [];
  const canonicalActive = canonical.filter((record) => isAgentSafeCanonical(record)
    && (record.scope === "user" || (record.scope === "project" && record.projectId === currentProjectId)));
  const nativeWithoutSuperseded = native.filter((record) => record.scope !== "private"
    && !canonical.some((canonicalRecord) => canonicalWinsOverNative(canonicalRecord, record)));
  return [...canonicalActive, ...nativeWithoutSuperseded]
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, queryTokens, query) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || (a.source === b.source ? 0 : a.source === "canonical" ? -1 : 1) || (b.mtimeMs || 0) - (a.mtimeMs || 0));
}

function renderRelevantMemory(candidate: RankedMemory, maxChars: number): string {
  const label = candidate.source === "canonical" ? `Canonical memory ${candidate.id}` : `Native edge-cache memory ${candidate.path || candidate.id}`;
  const authority = candidate.source === "canonical" ? "Canonical active record; it takes precedence over duplicate native cache entries." : "Native edge-cache evidence; verify against current evidence and canonical records.";
  const full = `### ${label}\n${authority}\n\n${candidate.body.trim()}`.trim();
  if (full.length <= maxChars) return full;
  return `${full.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n… [memory truncated]`;
}

export function selectRelevantMemoryNotes(native: MemoryCandidate[], canonical: MemoryCandidate[], query: string, currentProjectId?: string, maxChars = MAX_RELEVANT_CHARS): string[] {
  return selectRelevantMemoryNotesWithBudget(native, canonical, query, currentProjectId, maxChars);
}

/** Direct character bound for Pi's ambient edge capsule. Bobby's token-budget
 * eval is a separate authority projection and is not converted locally. */
export function ambientBudgetChars(value = process.env.PI_MEMORY_AMBIENT_MAX_CHARS): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MAX_RELEVANT_CHARS;
  return Math.min(8_000, Math.max(200, Math.floor(parsed)));
}

export function selectRelevantMemoryNotesWithBudget(native: MemoryCandidate[], canonical: MemoryCandidate[], query: string, currentProjectId: string | undefined, maxChars: number): string[] {
  const notes: string[] = [];
  let remaining = Math.max(200, Math.floor(maxChars));
  for (const candidate of rankRelevantMemories(native, canonical, query, currentProjectId)) {
    if (notes.length >= MAX_RELEVANT_RECORDS || remaining < 80) break;
    const note = renderRelevantMemory(candidate, remaining);
    if (!note.trim()) continue;
    notes.push(note);
    remaining -= note.length;
  }
  return notes;
}

export function parseRememberInput(args: string): ExtractionCandidate | null {
  const raw = args.trim();
  if (!raw) return null;
  const [prefix, rawBody] = raw.includes("::") ? raw.split(/\s*::\s*/, 2) : ["", raw];
  const prefixTokens = prefix.toLowerCase().split(/\s+/).filter(Boolean);
  const body = rawBody.trim().replace(/^(user|feedback|project|reference):\s*/i, "").trim();
  if (!body) return null;
  const type = parseType(prefixTokens.find((token) => MEMORY_TYPES.has(token as MemoryType)) || (
    /^user:/i.test(rawBody) ? "user" : /^project:/i.test(rawBody) ? "project" : /^reference:/i.test(rawBody) ? "reference" : "feedback"
  ), "feedback");
  const scope = parseScope(prefixTokens.find((token) => MEMORY_SCOPES.has(token as MemoryScope)), type === "user" ? "user" : type === "feedback" ? "private" : "project");
  const why = body.match(/\bWhy:\s*(.*?)(?=(?:\s+How to apply:|$))/is)?.[1]?.trim();
  const howToApply = body.match(/\bHow to apply:\s*([\s\S]*)$/i)?.[1]?.trim();
  const main = body
    .replace(/\bWhy:\s*.*?(?=(?:\s+How to apply:|$))/is, "")
    .replace(/\bHow to apply:\s*[\s\S]*$/i, "")
    .trim();
  const structuredBody = [main, why ? `**Why:** ${why}` : "", howToApply ? `**How to apply:** ${howToApply}` : ""]
    .filter(Boolean)
    .join("\n\n");
  if (!structuredBody) return null;
  return {
    name: `${type}-${slugify(main, 48)}`,
    description: main.split("\n")[0]!.slice(0, 180),
    type,
    scope,
    body: structuredBody,
  };
}

function slugify(value: string, max: number): string {
  const slug = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return slug || "memory";
}

export function redactSecretShapes(value: string): { value: string; redacted: boolean; rejected: boolean } {
  let redacted = false;
  let rejected = false;
  let next = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(next)) continue;
    pattern.lastIndex = 0;
    if (pattern.source.includes("PRIVATE KEY")) rejected = true;
    next = next.replace(pattern, "[REDACTED SECRET]");
    redacted = true;
  }
  return { value: next, redacted, rejected };
}

export function sanitizeExtractionCandidate(value: unknown): ExtractionCandidate | null {
  const object = asObject(value);
  if (!object) return null;
  const type = parseType(object.type, "feedback");
  const scope = parseScope(object.scope, type === "user" ? "user" : "project");
  const name = asString(object.name, 160);
  const description = asString(object.description, 320);
  const body = asString(object.body, MAX_EXTRACTION_BODY_CHARS);
  if (!name || !description || !body) return null;
  const secretCheck = redactSecretShapes(`${name}\n${description}\n${body}`);
  if (secretCheck.redacted || secretCheck.rejected) return null;
  return { name, description, type, scope, body };
}

export function validateExtractionJson(text: string): ExtractionCandidate[] | null {
  if (!text.trim() || text.length > 24_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  const object = asObject(parsed);
  if (!object || !Array.isArray(object.candidates) || object.candidates.length > MAX_EXTRACTION_CANDIDATES) return null;
  const candidates = object.candidates.map(sanitizeExtractionCandidate).filter((candidate): candidate is ExtractionCandidate => Boolean(candidate));
  return candidates.length === object.candidates.length ? candidates : null;
}

export function hasDurableSignal(userText: string, _assistantText: string): boolean {
  const text = userText.toLowerCase().trim();
  if (!text || text.startsWith("/") || text.includes("important: this instruction")) return false;
  return /\b(?:remember|don't forget|my preference|i prefer|from now on|going forward|we decided|decision is|standing policy|source of truth)\b/.test(text)
    || /\bcorrection\s*:/.test(text)
    || /^(?:please\s+)?(?:always|never)\s+\S+/i.test(text);
}

export function buildExplicitProposal(candidate: ExtractionCandidate, context: { projectId?: string; evidenceUri?: string } = {}): MemoryProposal {
  const secretCheck = redactSecretShapes(`${candidate.name}\n${candidate.description}\n${candidate.body}`);
  if (secretCheck.redacted || secretCheck.rejected) throw new Error("Memory proposals cannot contain secret-shaped values.");
  return {
    proposalType: "create",
    record: candidate,
    provenance: { source: "pi-explicit", contentHash: contentHash(JSON.stringify(candidate)), ...context },
  };
}

export function buildInferredProposal(candidate: ExtractionCandidate, context: { projectId?: string; evidenceUri?: string } = {}): MemoryProposal {
  const secretCheck = redactSecretShapes(`${candidate.name}\n${candidate.description}\n${candidate.body}`);
  if (secretCheck.redacted || secretCheck.rejected) throw new Error("Memory proposals cannot contain secret-shaped values.");
  return {
    proposalType: "create",
    record: candidate,
    provenance: { source: "pi-inferred", contentHash: contentHash(JSON.stringify(candidate)), ...context },
  };
}

export function proposalIsSafe(proposal: MemoryProposal): boolean {
  if (!proposal.record) return true;
  const secretCheck = redactSecretShapes(`${proposal.record.name}\n${proposal.record.description}\n${proposal.record.body}`);
  return !secretCheck.redacted && !secretCheck.rejected;
}

export function buildDeprecateProposal(recordId: string): MemoryProposal | null {
  const targetRecordId = recordId.trim();
  if (!targetRecordId || targetRecordId.length > 300) return null;
  return {
    proposalType: "deprecate",
    targetRecordId,
    provenance: { source: "pi-explicit" },
  };
}

export type QueueSnapshot = { running: boolean; scheduled: boolean; pending: boolean; closed: boolean };

export class LatestSingleFlightQueue<T> {
  private current: T | undefined;
  private pending: T | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private closed = false;
  private controller: AbortController | undefined;

  constructor(
    private readonly worker: (job: T, signal: AbortSignal) => Promise<void>,
    private readonly debounceMs = 600,
    private readonly onError?: (error: unknown) => void,
  ) {}

  enqueue(job: T): "started" | "replaced" | "closed" {
    if (this.closed) return "closed";
    if (this.running) {
      const replaced = this.pending !== undefined;
      this.pending = job;
      return replaced ? "replaced" : "started";
    }
    const replaced = this.current !== undefined;
    this.current = job;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.startCurrent();
    }, Math.max(0, this.debounceMs));
    return replaced ? "replaced" : "started";
  }

  snapshot(): QueueSnapshot {
    return { running: this.running, scheduled: this.timer !== undefined, pending: this.pending !== undefined, closed: this.closed };
  }

  shutdown(): void {
    this.closed = true;
    this.current = undefined;
    this.pending = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  private async startCurrent(): Promise<void> {
    const job = this.current;
    this.current = undefined;
    if (this.closed || job === undefined) return;
    this.running = true;
    this.controller = new AbortController();
    try {
      await this.worker(job, this.controller.signal);
    } catch (error) {
      if (!this.closed) this.onError?.(error);
    } finally {
      this.running = false;
      this.controller = undefined;
      if (this.closed || this.pending === undefined) return;
      this.current = this.pending;
      this.pending = undefined;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.startCurrent();
      }, Math.max(0, this.debounceMs));
    }
  }
}
