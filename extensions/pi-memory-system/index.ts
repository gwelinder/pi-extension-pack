import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  type BobbyManifest,
  type ExtractionCandidate,
  type MemoryCandidate,
  LatestSingleFlightQueue,
  buildDeprecateProposal,
  buildExplicitProposal,
  buildInferredProposal,
  contentHash,
  hasDurableSignal,
  hydrateCanonicalMemory,
  parseBobbyManifest,
  parseNativeMemory,
  parseRememberInput,
  rankRelevantMemories,
  selectRelevantMemoryNotes,
} from "./core.ts";
import { BobbyClient, getBobbyConfig, readBobbyManifest } from "./bobby-client.ts";
import { getExtractionConfig, runIsolatedExtraction } from "./extraction-runner.ts";

type MemoryPaths = {
  baseDir: string;
  userDir: string;
  projectDir: string;
  privateDir: string;
  projectSlug: string;
};

type BackgroundJob = {
  sessionId: string;
  projectId: string;
  evidenceUri: string;
  userText: string;
  assistantText: string;
  report: (status: string) => void;
};

type SessionState = {
  lastExternalInput: string;
  currentRunUserText: string;
  currentAssistantTexts: string[];
  currentProjectId: string;
  seenDeltaHashes: Set<string>;
  submittedProposalHashes: Set<string>;
  queue?: LatestSingleFlightQueue<BackgroundJob>;
  queuedExtractions: number;
  completedExtractions: number;
  pendingProposals: number;
  lastStatus: string;
};

const MEMORY_BASE_DIR = join(homedir(), ".pi", "agent", "memory");
const USER_SLUG = (process.env.PI_MEMORY_USER || process.env.USER || "user").toLowerCase();
const ENTRYPOINT = "MEMORY.md";
const MAX_NATIVE_FILES = 1_000;
const MAX_CANONICAL_FILES = 1_000;

function hash8(value: string): string {
  return createHash("md5").update(value).digest("hex").slice(0, 8);
}

function slugify(value: string, max = 48): string {
  const slug = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return slug || "memory";
}

function sanitizeProjectSlug(projectRoot: string): string {
  return `${slugify(basename(projectRoot) || "project", 24)}-${hash8(projectRoot)}`;
}

async function getProjectRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  try {
    const common = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: 2_000 });
    const gitDir = resolve(common.stdout.trim());
    const worktreesMarker = `${sep}.git${sep}worktrees${sep}`;
    const markerIndex = gitDir.indexOf(worktreesMarker);
    if (markerIndex >= 0) return gitDir.slice(0, markerIndex);
    if (basename(gitDir) === ".git") return dirname(gitDir);
  } catch {
    // Fall through to the current directory when no Git identity is available.
  }
  return resolve(cwd);
}

async function getMemoryPaths(pi: ExtensionAPI, cwd: string): Promise<MemoryPaths> {
  const projectRoot = await getProjectRoot(pi, cwd);
  const projectSlug = sanitizeProjectSlug(projectRoot);
  const userSlug = slugify(USER_SLUG, 32);
  const projectDir = join(MEMORY_BASE_DIR, "projects", projectSlug);
  return {
    baseDir: MEMORY_BASE_DIR,
    userDir: join(MEMORY_BASE_DIR, "users", userSlug),
    projectDir,
    privateDir: join(projectDir, "private"),
    projectSlug,
  };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function listMarkdownFiles(dir: string, maxFiles: number, depth = 0): string[] {
  if (depth > 3 || !existsSync(dir)) return [];
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) break;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...listMarkdownFiles(path, maxFiles - files.length, depth + 1));
      else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== ENTRYPOINT) files.push(path);
    }
  } catch {
    // Native and canonical stores are optional read-only inputs.
  }
  return files;
}

function listNativeCandidates(paths: MemoryPaths): MemoryCandidate[] {
  const files = [...new Set([
    ...listMarkdownFiles(paths.userDir, MAX_NATIVE_FILES, 0),
    ...listMarkdownFiles(paths.projectDir, MAX_NATIVE_FILES, 0).filter((path) => !path.startsWith(`${paths.privateDir}${sep}`)),
    ...listMarkdownFiles(paths.privateDir, MAX_NATIVE_FILES, 0),
  ])].slice(0, MAX_NATIVE_FILES);
  return files.map((path) => {
    let mtimeMs = 0;
    try { mtimeMs = statSync(path).mtimeMs; } catch { /* ignore */ }
    return parseNativeMemory(path, readText(path), mtimeMs);
  });
}

function safeCanonicalPath(root: string, suppliedPath: string): string | undefined {
  const resolvedRoot = resolve(root);
  const target = resolve(suppliedPath.startsWith("/") ? suppliedPath : join(resolvedRoot, suppliedPath));
  return target === resolvedRoot || target.startsWith(`${resolvedRoot}${sep}`) ? target : undefined;
}

function canonicalRecordFromFile(root: string, path: string): MemoryCandidate | null {
  const content = readText(path);
  if (!content) return null;
  const fallbackId = relative(root, path) || basename(path);
  const manifest = parseBobbyManifest({
    records: [{ id: fallbackId, path: relative(root, path) }],
  });
  const record = manifest?.records[0];
  return record ? hydrateCanonicalMemory(record, content) : null;
}

function listCanonicalCandidates(manifest: BobbyManifest | null): MemoryCandidate[] {
  if (!manifest?.canonicalMemoryRoot) return manifest?.records || [];
  const root = manifest.canonicalMemoryRoot;
  const records = manifest.records.map((record) => {
    if (record.scope === "private" || record.visibility === "private" || (record.sensitivity && record.sensitivity !== "agent_safe")) return record;
    if (record.body || !record.path) return record;
    const path = safeCanonicalPath(root, record.path);
    return path ? hydrateCanonicalMemory(record, readText(path)) : record;
  });
  if (records.length > 0) return records;
  return listMarkdownFiles(root, MAX_CANONICAL_FILES).map((path) => canonicalRecordFromFile(root, path)).filter((record): record is MemoryCandidate => Boolean(record));
}

function memoryPrompt(notes: string[]): string {
  return [
    "# Pi Memory",
    "",
    "Bobby canonical memory is the reconciliation authority. Native Pi Markdown memories remain a resilient read-only edge cache and evidence source; do not disable, delete, or write them directly.",
    "Use persistent memory only for durable facts, preferences, feedback, rationale/constraints, and external references not derivable from the repository. Current evidence wins over memory.",
    "Use the memory tool for explicit search, proposals, forget requests, and status. Canonical mutations are proposals through Bobby; never edit canonical or native memory Markdown directly.",
    ...(notes.length ? ["", "## Relevant memory", ...notes] : []),
  ].join("\n");
}

function messageText(message: unknown): string {
  const object = message && typeof message === "object" ? message as Record<string, unknown> : null;
  if (!object || object.role !== "assistant" || !Array.isArray(object.content)) return "";
  return object.content
    .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isInternalMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return !normalized || normalized.startsWith("/") || normalized.startsWith("important: this instruction") || normalized.includes("[pi-memory-control]");
}

function rememberHash(set: Set<string>, hash: string): boolean {
  if (set.has(hash)) return false;
  set.add(hash);
  if (set.size > 120) set.delete(set.values().next().value!);
  return true;
}

function setMemoryStatus(ctx: ExtensionContext, state: SessionState, status: string): void {
  state.lastStatus = status;
  if (ctx.hasUI) ctx.ui.setStatus("canonical-memory", status);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function createSessionState(): SessionState {
  return {
    lastExternalInput: "",
    currentRunUserText: "",
    currentAssistantTexts: [],
    currentProjectId: "",
    seenDeltaHashes: new Set(),
    submittedProposalHashes: new Set(),
    queuedExtractions: 0,
    completedExtractions: 0,
    pendingProposals: 0,
    lastStatus: "memory: idle",
  };
}

async function submitExplicitProposal(candidate: ExtractionCandidate, client: BobbyClient, context: { projectId?: string; evidenceUri?: string } = {}, signal?: AbortSignal, allowReviewedApply = false): Promise<string> {
  const proposed = await client.propose(buildExplicitProposal(candidate, context), signal);
  if (!proposed.ok) return `Bobby unavailable; no canonical mutation was made (${proposed.error || "proposal failed"}).`;
  if (!proposed.proposalId) return "Bobby accepted the proposal, but returned no proposal ID; it remains pending for review.";
  if (!allowReviewedApply) return `Canonical proposal ${proposed.proposalId} is pending Bobby review.`;
  const approval = await client.acceptAndApply(proposed.proposalId, signal);
  if (approval.applied) return `Canonical proposal ${proposed.proposalId} was accepted and applied through Bobby's review receipt.`;
  return `Canonical proposal ${proposed.proposalId} is pending. ${approval.error || "It was not applied."}`;
}

async function chooseForgetTarget(query: string, client: BobbyClient, ctx: ExtensionCommandContext, projectId: string): Promise<string | undefined> {
  const result = await client.search(query, 8, undefined, projectId);
  if (!result.available || result.records.length === 0) return undefined;
  const exact = result.records.find((record) => record.id === query.trim());
  if (exact) return exact.id;
  if (result.records.length === 1) return result.records[0]!.id;
  if (!ctx.hasUI) return undefined;
  const choices = result.records.map((record) => `${record.id} — ${record.description}`);
  const selected = await ctx.ui.select("Forget which canonical record?", choices);
  return result.records.find((record) => `${record.id} — ${record.description}` === selected)?.id;
}

function describeStatus(state: SessionState, manifest: BobbyManifest | null, bobbyAvailable: boolean): string {
  const queue = state.queue?.snapshot();
  return [
    `Canonical manifest: ${manifest ? "available" : "unavailable"}`,
    `Canonical root: ${manifest?.canonicalMemoryRoot || "not configured"}`,
    `Canonical records in sidecar: ${manifest?.records.length || 0}`,
    `Bobby CLI: ${bobbyAvailable ? "available" : "unavailable"}`,
    `Extraction queue: ${queue?.running ? "running" : queue?.scheduled ? "debouncing" : "idle"}${queue?.pending ? " + latest pending" : ""}`,
    `Queued extractions: ${state.queuedExtractions}`,
    `Completed extractions: ${state.completedExtractions}`,
    `Pending proposals this session: ${state.pendingProposals}`,
    `Status: ${state.lastStatus}`,
  ].join("\n");
}

export default function piMemorySystem(pi: ExtensionAPI) {
  const stateBySession = new Map<string, SessionState>();
  const getState = (sessionId: string): SessionState => {
    const state = stateBySession.get(sessionId);
    if (state) return state;
    const next = createSessionState();
    stateBySession.set(sessionId, next);
    return next;
  };

  const runBackgroundJob = async (job: BackgroundJob, signal: AbortSignal): Promise<void> => {
    const state = stateBySession.get(job.sessionId);
    if (!state || signal.aborted) return;
    job.report("memory: extracting");
    const candidates = await runIsolatedExtraction(job.userText, job.assistantText, getExtractionConfig(), signal);
    if (signal.aborted || !candidates) {
      if (!signal.aborted) job.report("memory: extraction unavailable");
      return;
    }
    let proposed = 0;
    const client = new BobbyClient(getBobbyConfig());
    for (const candidate of candidates) {
      if (signal.aborted) return;
      const proposal = buildInferredProposal(candidate, { projectId: job.projectId, evidenceUri: job.evidenceUri });
      const hash = proposal.provenance.contentHash!;
      if (!rememberHash(state.submittedProposalHashes, hash)) continue;
      const result = await client.propose(proposal, signal);
      if (result.ok) proposed += 1;
    }
    state.completedExtractions += 1;
    state.pendingProposals += proposed;
    job.report(proposed ? `memory: ${proposed} proposal${proposed === 1 ? "" : "s"} pending` : "memory: no durable proposal");
  };

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const prior = stateBySession.get(sessionId);
    prior?.queue?.shutdown();
    const state = createSessionState();
    stateBySession.set(sessionId, state);
    setMemoryStatus(ctx, state, "memory: idle");
  });

  pi.on("input", (event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    state.lastExternalInput = event.source === "extension" || isInternalMessage(event.text) ? "" : event.text;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    state.currentAssistantTexts = [];
    state.currentRunUserText = state.lastExternalInput && !isInternalMessage(event.prompt) ? event.prompt.trim() : "";
    const paths = await getMemoryPaths(pi, ctx.cwd);
    state.currentProjectId = paths.projectSlug;
    const config = getBobbyConfig();
    const manifest = readBobbyManifest(config);
    const notes = state.currentRunUserText
      ? selectRelevantMemoryNotes(listNativeCandidates(paths), listCanonicalCandidates(manifest), state.currentRunUserText, paths.projectSlug)
      : [];
    return { systemPrompt: `${event.systemPrompt}\n\n${memoryPrompt(notes)}` };
  });

  pi.on("turn_end", (event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    if (!state.currentRunUserText) return;
    const text = messageText(event.message);
    if (text) state.currentAssistantTexts.push(text.slice(0, 6_000));
  });

  pi.on("agent_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(sessionId);
    const userText = state.currentRunUserText;
    const assistantText = state.currentAssistantTexts.join("\n").slice(0, 8_000);
    state.currentRunUserText = "";
    state.currentAssistantTexts = [];
    if (!userText || !assistantText || !hasDurableSignal(userText, assistantText)) return;
    const deltaHash = contentHash(`${userText}\n---\n${assistantText}`);
    if (!rememberHash(state.seenDeltaHashes, deltaHash)) return;
    if (!state.queue) {
      state.queue = new LatestSingleFlightQueue(runBackgroundJob, Number(process.env.PI_MEMORY_EXTRACTION_DEBOUNCE_MS || 700));
    }
    const outcome = state.queue.enqueue({
      sessionId,
      projectId: state.currentProjectId,
      evidenceUri: `pi-session://${sessionId}/${deltaHash.slice(0, 16)}`,
      userText,
      assistantText,
      report: (status) => setMemoryStatus(ctx, state, status),
    });
    if (outcome !== "closed") {
      state.queuedExtractions += 1;
      setMemoryStatus(ctx, state, outcome === "replaced" ? "memory: latest extraction queued" : "memory: extraction queued");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = stateBySession.get(sessionId);
    state?.queue?.shutdown();
    stateBySession.delete(sessionId);
  });

  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: "Search native edge-cache and Bobby canonical memory, propose explicit durable memory, deprecate an exact canonical record, or show memory status.",
    promptSnippet: "Search or propose canonical durable memory",
    promptGuidelines: ["Use memory for explicit durable-memory requests. Use memory forget only with an exact canonical record ID returned by memory search; it creates a Bobby deprecate proposal rather than deleting files."],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("search"), Type.Literal("propose"), Type.Literal("forget"), Type.Literal("status")]),
      query: Type.Optional(Type.String({ maxLength: 2_000 })),
      content: Type.Optional(Type.String({ maxLength: 2_000 })),
      type: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("feedback"), Type.Literal("project"), Type.Literal("reference")])),
      scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("private"), Type.Literal("project")])),
      recordId: Type.Optional(Type.String({ maxLength: 300 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const state = getState(ctx.sessionManager.getSessionId());
      const client = new BobbyClient(getBobbyConfig());
      if (params.action === "search") {
        const query = params.query?.trim();
        if (!query) return { content: [{ type: "text", text: "Provide a search query." }], details: { records: [] } };
        const paths = await getMemoryPaths(pi, ctx.cwd);
        const manifest = readBobbyManifest(client.config);
        const bobby = await client.search(query, 8, signal, paths.projectSlug);
        const canonical = [...listCanonicalCandidates(manifest), ...bobby.records.filter((record) => !manifest?.records.some((local) => local.id === record.id))];
        const records = rankRelevantMemories(listNativeCandidates(paths), canonical, query, paths.projectSlug).slice(0, 8);
        const text = records.length
          ? records.map((record) => `${record.source === "canonical" ? "canonical" : "native"} ${record.id} — ${record.description}`).join("\n")
          : "No relevant memory records found.";
        return { content: [{ type: "text", text }], details: { bobbyAvailable: bobby.available, records: records.map((record) => ({ id: record.id, source: record.source, description: record.description })) } };
      }
      if (params.action === "propose") {
        const raw = params.content || params.query || "";
        const candidate = parseRememberInput(`${params.type || ""} ${params.scope || ""} :: ${raw}`);
        if (!candidate) return { content: [{ type: "text", text: "Provide durable memory content to propose." }], details: { pending: false } };
        try {
          const paths = await getMemoryPaths(pi, ctx.cwd);
          const text = await submitExplicitProposal(candidate, client, {
            projectId: paths.projectSlug,
            evidenceUri: `pi-session://${ctx.sessionManager.getSessionId()}/explicit`,
          }, signal);
          return { content: [{ type: "text", text }], details: { pending: text.includes("pending") } };
        } catch (error) {
          return { content: [{ type: "text", text: error instanceof Error ? error.message : "Memory proposal rejected locally." }], details: { pending: false } };
        }
      }
      if (params.action === "forget") {
        const proposal = buildDeprecateProposal(params.recordId || "");
        if (!proposal) return { content: [{ type: "text", text: "Use memory search first, then provide its exact canonical recordId." }], details: { pending: false } };
        const result = await client.propose(proposal, signal);
        return { content: [{ type: "text", text: result.ok ? `Deprecate proposal ${result.proposalId || "submitted"} is pending Bobby review.` : `Bobby unavailable; no canonical mutation was made (${result.error || "proposal failed"}).` }], details: { proposalId: result.proposalId, pending: result.ok } };
      }
      const manifest = readBobbyManifest(client.config);
      const bobby = await client.status(signal);
      return { content: [{ type: "text", text: describeStatus(state, manifest, bobby.ok) }], details: { bobbyAvailable: bobby.ok, manifestAvailable: Boolean(manifest) } };
    },
  });

  pi.registerCommand("remember", {
    description: "Propose durable canonical memory. Usage: /remember [type] [scope] :: memory text",
    handler: async (args, ctx) => {
      let candidate = parseRememberInput(args);
      if (!candidate && ctx.hasUI && !args.trim()) {
        const type = await ctx.ui.select("Memory type", ["user", "feedback", "project", "reference"]);
        if (!type) return;
        const scope = await ctx.ui.select("Memory scope", type === "user" ? ["user"] : ["private", "project"]);
        if (!scope) return;
        const body = await ctx.ui.editor("Memory content", "");
        candidate = body?.trim() ? parseRememberInput(`${type} ${scope} :: ${body}`) : null;
      }
      if (!candidate) return notify(ctx, "Usage: /remember [type] [scope] :: memory text", "warning");
      try {
        const paths = await getMemoryPaths(pi, ctx.cwd);
        notify(ctx, await submitExplicitProposal(candidate, new BobbyClient(getBobbyConfig()), {
          projectId: paths.projectSlug,
          evidenceUri: `pi-session://${ctx.sessionManager.getSessionId()}/explicit`,
        }, undefined, true));
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : "Memory proposal rejected locally.", "warning");
      }
    },
  });

  pi.registerCommand("forget", {
    description: "Propose deprecation of a canonical memory. Usage: /forget <record-id or query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return notify(ctx, "Usage: /forget <record-id or query>", "warning");
      const client = new BobbyClient(getBobbyConfig());
      const paths = await getMemoryPaths(pi, ctx.cwd);
      const recordId = await chooseForgetTarget(query, client, ctx, paths.projectSlug);
      const proposal = recordId ? buildDeprecateProposal(recordId) : null;
      if (!proposal) return notify(ctx, "No exact canonical record selected; nothing was changed.", "warning");
      const result = await client.propose(proposal);
      notify(ctx, result.ok ? `Deprecate proposal ${result.proposalId || "submitted"} is pending Bobby review.` : `Bobby unavailable; no canonical mutation was made (${result.error || "proposal failed"}).`, result.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show Bobby canonical-memory and off-thread extraction status",
    handler: async (_args, ctx) => {
      const state = getState(ctx.sessionManager.getSessionId());
      const client = new BobbyClient(getBobbyConfig());
      const status = await client.status();
      notify(ctx, describeStatus(state, readBobbyManifest(client.config), status.ok));
    },
  });
}
