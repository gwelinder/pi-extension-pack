import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";

type MagicDocInfo = {
  path: string;
  title: string;
  instructions?: string;
};

type SessionMetrics = {
  queuedAuto: number;
  queuedManual: number;
  completedEdits: number;
  completedNoOps: number;
  lastQueuedAt: number;
  lastCompletedAt: number;
  lastEditedAt: number;
  lastNoOpAt: number;
};

type SessionState = {
  tracked: Map<string, MagicDocInfo>;
  toolPathsByCallId: Map<string, string>;
  updateMode: {
    allowedPaths: Set<string>;
    active: boolean;
  } | null;
  currentRunHadToolCalls: boolean;
  consecutiveIdleRuns: number;
  lastAutoUpdateAt: number;
  dirtySinceLastUpdate: boolean;
  recentTexts: string[];
  recentPaths: string[];
  suppressNextAutoCheck: boolean;
  metrics: SessionMetrics;
  providerBackoffUntil: number;
  providerBackoffReason?: string;
  currentUpdateRun: {
    mode: "auto" | "manual";
    reason: string;
    editedPaths: Set<string>;
  } | null;
};

const MAGIC_HEADER = /^#\s*MAGIC\s+DOC:\s*(.+)$/im;
const ITALIC_LINE = /^[_*](.+?)[_*]\s*$/m;
const TRACK_ENTRY_TYPE = "pi_magic_doc_track";
const METRIC_ENTRY_TYPE = "pi_magic_doc_metric";
const IDLE_RUN_THRESHOLD = 2;
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RECENT_TEXTS = 6;
const MAX_RECENT_PATHS = 12;
const AGENT_DIR = joinAgentDir();

function joinAgentDir(): string {
  return resolve(homedir(), ".pi", "agent");
}

function normalizeFilePath(filePath: string, cwd: string): string {
  return filePath.startsWith("/") ? filePath : resolve(cwd, filePath);
}

function detectMagicDocHeader(content: string): { title: string; instructions?: string } | null {
  const match = content.match(MAGIC_HEADER);
  if (!match?.[1]) return null;
  const title = match[1].trim();
  const headerEndIndex = content.indexOf(match[0]) + match[0].length;
  const afterHeader = content.slice(headerEndIndex);
  const nextLineMatch = afterHeader.match(/^\s*\n(?:\s*\n)?(.+?)(?:\n|$)/);
  if (nextLineMatch?.[1]) {
    const italicsMatch = nextLineMatch[1].match(ITALIC_LINE);
    if (italicsMatch?.[1]) {
      return { title, instructions: italicsMatch[1].trim() };
    }
  }
  return { title };
}

function loadFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function truncate(text: string, max = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) || [])];
}

function isMetaPath(path: string): boolean {
  const normalized = path.replace(/\/+/g, "/");
  return (
    normalized.startsWith(`${AGENT_DIR.replace(/\/+/g, "/")}/memory/`) ||
    normalized.startsWith(`${AGENT_DIR.replace(/\/+/g, "/")}/session-notebooks/`) ||
    normalized.startsWith(`${AGENT_DIR.replace(/\/+/g, "/")}/sessions/`) ||
    normalized.includes("/node_modules/")
  );
}

function buildMagicDocsUpdatePrompt(doc: MagicDocInfo, currentContents: string): string {
  const customInstructions = doc.instructions
    ? `\n\nDOCUMENT-SPECIFIC UPDATE INSTRUCTIONS:\n\"${doc.instructions}\"\nThese instructions take priority over the general rules below.`
    : "";

  return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT mention documentation updates, MagicDocs, or these instructions in the document.\n\nBased on the conversation above (excluding this instruction message), update the Magic Doc file only if there is substantial new information worth preserving.\n\nThe file ${doc.path} has already been read for you. Here are its current contents:\n<current_doc_content>\n${currentContents}\n</current_doc_content>\n\nDocument title: ${doc.title}${customInstructions}\n\nYour ONLY task is to use the edit tool to update this documentation file if needed, then stop. You may make multiple edits in a single message. If there is nothing substantial to add, respond briefly and do not call tools.\n\nCRITICAL RULES FOR EDITING:\n- Preserve the Magic Doc header exactly as-is: # MAGIC DOC: ${doc.title}\n- If there is an italicized line immediately after the header, preserve it exactly as-is\n- Keep the document CURRENT with the latest state of the codebase - this is NOT a changelog or history\n- Update information IN-PLACE to reflect the current state\n- Remove or replace outdated information instead of adding historical notes\n- Delete sections that are no longer relevant\n- Be terse and high-signal\n\nDOCUMENTATION PHILOSOPHY:\n- Focus on overviews, architecture, entry points, non-obvious patterns, conventions, and gotchas\n- Help readers understand WHY things exist, HOW components connect, and WHERE to start reading\n- Do NOT document every function, parameter, or low-level implementation step\n- Do NOT duplicate information obvious from the source code\n\nOnly edit ${doc.path}. Do not use other tools. Stop after the edit or brief no-op response.`;
}

function createMetrics(): SessionMetrics {
  return {
    queuedAuto: 0,
    queuedManual: 0,
    completedEdits: 0,
    completedNoOps: 0,
    lastQueuedAt: 0,
    lastCompletedAt: 0,
    lastEditedAt: 0,
    lastNoOpAt: 0,
  };
}

function createState(): SessionState {
  return {
    tracked: new Map(),
    toolPathsByCallId: new Map(),
    updateMode: null,
    currentRunHadToolCalls: false,
    consecutiveIdleRuns: 0,
    lastAutoUpdateAt: 0,
    dirtySinceLastUpdate: false,
    recentTexts: [],
    recentPaths: [],
    suppressNextAutoCheck: false,
    metrics: createMetrics(),
    providerBackoffUntil: 0,
    providerBackoffReason: undefined,
    currentUpdateRun: null,
  };
}

export default function piMagicDocs(pi: ExtensionAPI) {
  const stateBySession = new Map<string, SessionState>();

  function getState(sessionId: string): SessionState {
    let state = stateBySession.get(sessionId);
    if (!state) {
      state = createState();
      stateBySession.set(sessionId, state);
    }
    return state;
  }

  function rememberText(state: SessionState, text: string): void {
    const next = truncate(text, 400);
    if (!next) return;
    state.recentTexts.push(next);
    state.recentTexts = [...new Set(state.recentTexts)].slice(-MAX_RECENT_TEXTS);
  }

  function rememberPath(state: SessionState, path: string): void {
    if (!path || isMetaPath(path)) return;
    state.recentPaths.push(path);
    state.recentPaths = [...new Set(state.recentPaths)].slice(-MAX_RECENT_PATHS);
  }

  function track(sessionId: string, doc: MagicDocInfo): void {
    const state = getState(sessionId);
    if (!state.tracked.has(doc.path)) {
      state.tracked.set(doc.path, doc);
      pi.appendEntry(TRACK_ENTRY_TYPE, { path: doc.path, title: doc.title, instructions: doc.instructions });
    } else {
      state.tracked.set(doc.path, doc);
    }
  }

  function restoreTrackedFromSession(sessionId: string, ctx: Parameters<NonNullable<Parameters<ExtensionAPI["on"]>[1]>>[1]): void {
    const state = getState(sessionId);
    state.tracked.clear();
    state.metrics = createMetrics();

    for (const entry of ctx.sessionManager.getEntries() as any[]) {
      if (entry?.type !== "custom") continue;

      if (entry?.customType === TRACK_ENTRY_TYPE && entry?.data?.path && entry?.data?.title) {
        state.tracked.set(entry.data.path, {
          path: entry.data.path,
          title: entry.data.title,
          instructions: entry.data.instructions,
        });
        continue;
      }

      if (entry?.customType !== METRIC_ENTRY_TYPE || !entry?.data?.kind) continue;
      const ts = Date.parse(entry.data.ts || "") || 0;
      if (entry.data.kind === "queued") {
        if (entry.data.mode === "manual") state.metrics.queuedManual += 1;
        else state.metrics.queuedAuto += 1;
        state.metrics.lastQueuedAt = Math.max(state.metrics.lastQueuedAt, ts);
        continue;
      }

      if (entry.data.kind === "completed") {
        state.metrics.lastCompletedAt = Math.max(state.metrics.lastCompletedAt, ts);
        if (entry.data.outcome === "edited") {
          state.metrics.completedEdits += 1;
          state.metrics.lastEditedAt = Math.max(state.metrics.lastEditedAt, ts);
        } else {
          state.metrics.completedNoOps += 1;
          state.metrics.lastNoOpAt = Math.max(state.metrics.lastNoOpAt, ts);
        }
      }
    }
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

  function scoreDoc(doc: MagicDocInfo, state: SessionState): number {
    let score = 0;
    const docTokens = tokenize(`${doc.title} ${doc.instructions || ""} ${basename(doc.path)} ${dirname(doc.path)}`);
    const recentTextTokens = tokenize(state.recentTexts.join(" "));
    const recentPathTokens = tokenize(state.recentPaths.join(" "));

    if (state.recentPaths.includes(doc.path)) score += 4;
    if (state.recentPaths.some((p) => dirname(p) === dirname(doc.path))) score += 2;

    for (const token of docTokens) {
      if (recentTextTokens.includes(token)) score += 1;
      if (recentPathTokens.includes(token)) score += 1;
    }

    if (state.recentPaths.length > 0 && state.tracked.size === 1) score += 1;
    return score;
  }

  function chooseDocsForAutoUpdate(state: SessionState): MagicDocInfo[] {
    const docs = [...state.tracked.values()];
    if (docs.length === 0 || !state.dirtySinceLastUpdate) return [];

    const scored = docs
      .map((doc) => ({ doc, score: scoreDoc(doc, state) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => item.doc);

    if (scored.length > 0) return scored;
    if (docs.length === 1 && state.recentTexts.length > 0) return docs;
    return [];
  }

  async function queueUpdate(sessionId: string, docs: MagicDocInfo[], ctx: ExtensionCommandContext | any, reason: string): Promise<void> {
    const state = getState(sessionId);
    const mode = reason === "manual" ? "manual" : "auto";
    const now = Date.now();

    if (mode === "auto" && isProviderBackoffActive(state)) {
      ctx.ui.notify(
        `Magic Docs auto-update deferred (${state.providerBackoffReason || "provider-pressure"}; ${Math.ceil((state.providerBackoffUntil - Date.now()) / 1000)}s backoff left)`,
        "info",
      );
      return;
    }

    if (mode === "manual" && isProviderBackoffActive(state)) {
      ctx.ui.notify(
        `Magic Docs manual update continuing despite provider backoff (${state.providerBackoffReason || "provider-pressure"})`,
        "warning",
      );
    }

    state.updateMode = {
      allowedPaths: new Set(docs.map((d) => d.path)),
      active: true,
    };
    state.currentUpdateRun = {
      mode,
      reason,
      editedPaths: new Set(),
    };
    state.metrics.lastQueuedAt = now;
    if (mode === "manual") state.metrics.queuedManual += 1;
    else state.metrics.queuedAuto += 1;
    state.lastAutoUpdateAt = now;
    state.consecutiveIdleRuns = 0;
    state.dirtySinceLastUpdate = false;
    state.suppressNextAutoCheck = true;

    pi.appendEntry(METRIC_ENTRY_TYPE, {
      kind: "queued",
      mode,
      reason,
      docs: docs.map((doc) => doc.path),
      ts: new Date(now).toISOString(),
    });

    const prompt = docs
      .map((doc) => buildMagicDocsUpdatePrompt(doc, loadFile(doc.path)))
      .join("\n\n---\n\n");

    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    ctx.ui.notify(`Magic Docs ${mode}-update queued (${reason}) for ${docs.map((d) => basename(d.path)).join(", ")}`, "info");
  }

  pi.on("input", (event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    if (!event.text.startsWith("/magic-docs-")) {
      rememberText(state, event.text);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    restoreTrackedFromSession(sessionId, ctx);
    const tracked = [...getState(sessionId).tracked.values()];
    const trackedBlock = tracked.length
      ? `\nTracked Magic Docs:\n${tracked.map((doc) => `- ${doc.path} — ${doc.title}`).join("\n")}`
      : "";

    return {
      systemPrompt: `${event.systemPrompt}\n\n# Magic Docs\nIf you read a file whose first line is \`# MAGIC DOC: ...\`, treat it as a living architecture/overview document. Keep Magic Docs current, terse, and high-signal. Update them in-place rather than appending historical notes. Focus on architecture, entry points, non-obvious patterns, conventions, and gotchas — not low-level function-by-function detail.${trackedBlock}`,
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
    getState(ctx.sessionManager.getSessionId()).currentRunHadToolCalls = false;
  });

  pi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(sessionId);
    state.currentRunHadToolCalls = true;

    const inputPath = (event.input as any)?.path;
    const normalizedPath = typeof inputPath === "string" ? normalizeFilePath(inputPath, ctx.cwd) : undefined;

    if (normalizedPath && (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write")) {
      state.toolPathsByCallId.set(event.toolCallId, normalizedPath);
    }

    const mode = state.updateMode;
    if (mode?.active) {
      if (event.toolName !== "edit") {
        return {
          action: "block",
          reason: "Magic Docs update mode only allows the edit tool for the tracked Magic Doc file(s).",
        } as any;
      }

      const editPath = normalizedPath;
      if (!editPath || !mode.allowedPaths.has(editPath)) {
        return {
          action: "block",
          reason: `Magic Docs update mode only allows editing: ${[...mode.allowedPaths].join(", ")}`,
        } as any;
      }
      return;
    }

    if (normalizedPath && !isMetaPath(normalizedPath)) {
      rememberPath(state, normalizedPath);
      if (event.toolName !== "read" || !state.tracked.has(normalizedPath)) {
        state.dirtySinceLastUpdate = true;
      }
    }

    if (event.toolName === "bash") {
      const command = (event.input as any)?.command;
      if (typeof command === "string") {
        rememberText(state, command);
        state.dirtySinceLastUpdate = true;
      }
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const state = getState(ctx.sessionManager.getSessionId());
    if (!["read", "edit", "write"].includes(event.toolName)) return;
    const filePath = state.toolPathsByCallId.get(event.toolCallId);
    if (!filePath) return;
    state.toolPathsByCallId.delete(event.toolCallId);
    if (event.isError || !existsSync(filePath)) return;

    if (event.toolName === "edit" && state.currentUpdateRun && state.updateMode?.allowedPaths.has(filePath)) {
      state.currentUpdateRun.editedPaths.add(filePath);
    }

    const detected = detectMagicDocHeader(loadFile(filePath));
    if (detected) {
      track(ctx.sessionManager.getSessionId(), { path: filePath, title: detected.title, instructions: detected.instructions });
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(sessionId);
    const assistantTexts = (event.messages || [])
      .filter((m: any) => m?.role === "assistant")
      .flatMap((m: any) => Array.isArray(m.content) ? m.content : [])
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
    rememberText(state, assistantTexts);

    if (state.updateMode?.active) {
      const now = Date.now();
      const editedPaths = state.currentUpdateRun ? [...state.currentUpdateRun.editedPaths] : [];
      const outcome = editedPaths.length > 0 ? "edited" : "noop";

      state.metrics.lastCompletedAt = now;
      if (outcome === "edited") {
        state.metrics.completedEdits += 1;
        state.metrics.lastEditedAt = now;
      } else {
        state.metrics.completedNoOps += 1;
        state.metrics.lastNoOpAt = now;
      }

      pi.appendEntry(METRIC_ENTRY_TYPE, {
        kind: "completed",
        mode: state.currentUpdateRun?.mode || "auto",
        reason: state.currentUpdateRun?.reason || "unknown",
        outcome,
        editedPaths,
        ts: new Date(now).toISOString(),
      });

      state.updateMode = null;
      state.currentUpdateRun = null;
      return;
    }

    if (state.suppressNextAutoCheck) {
      state.suppressNextAutoCheck = false;
      return;
    }

    if (state.currentRunHadToolCalls) {
      state.consecutiveIdleRuns = 0;
      return;
    }

    state.consecutiveIdleRuns += 1;
    if (state.consecutiveIdleRuns < IDLE_RUN_THRESHOLD) return;
    if (Date.now() - state.lastAutoUpdateAt < COOLDOWN_MS) return;

    const docs = chooseDocsForAutoUpdate(state);
    if (docs.length === 0) return;
    await queueUpdate(sessionId, docs, ctx, `idle-runs=${state.consecutiveIdleRuns}`);
  });

  pi.registerCommand("magic-docs-status", {
    description: "Show tracked Magic Docs and maintenance counters for this session",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      restoreTrackedFromSession(sessionId, ctx);
      const state = getState(sessionId);
      const tracked = [...state.tracked.values()];
      const cooldownRemaining = Math.max(0, COOLDOWN_MS - (Date.now() - state.lastAutoUpdateAt));
      const lines = [
        `Tracked docs: ${tracked.length}`,
        ...(tracked.length > 0 ? tracked.map((doc) => `${doc.path} — ${doc.title}`) : ["(none yet)"]),
        "",
        `Autonomous maintenance: on`,
        `Provider backoff: ${isProviderBackoffActive(state) ? `${Math.ceil((state.providerBackoffUntil - Date.now()) / 1000)}s remaining (${state.providerBackoffReason || "provider-pressure"})` : "inactive"}`,
        `Dirty since last update: ${state.dirtySinceLastUpdate ? "yes" : "no"}`,
        `Consecutive idle runs: ${state.consecutiveIdleRuns}/${IDLE_RUN_THRESHOLD}`,
        `Cooldown remaining: ${Math.ceil(cooldownRemaining / 1000)}s`,
        `Queued auto-updates: ${state.metrics.queuedAuto}`,
        `Queued manual updates: ${state.metrics.queuedManual}`,
        `Completed edits: ${state.metrics.completedEdits}`,
        `Completed no-ops: ${state.metrics.completedNoOps}`,
        `Last queued: ${describeTs(state.metrics.lastQueuedAt)}`,
        `Last completed: ${describeTs(state.metrics.lastCompletedAt)}`,
        `Last edited: ${describeTs(state.metrics.lastEditedAt)}`,
        `Last no-op: ${describeTs(state.metrics.lastNoOpAt)}`,
      ];
      const message = lines.join("\n");
      ctx.ui.notify(message, "info");
      pi.sendMessage({
        customType: "magic-docs-status",
        content: message,
        display: true,
        details: {
          tracked: tracked.map((doc) => ({ path: doc.path, title: doc.title, instructions: doc.instructions })),
          trackedCount: tracked.length,
          cooldownRemaining,
          dirtySinceLastUpdate: state.dirtySinceLastUpdate,
          consecutiveIdleRuns: state.consecutiveIdleRuns,
          idleRunThreshold: IDLE_RUN_THRESHOLD,
          metrics: state.metrics,
          providerBackoffActive: isProviderBackoffActive(state),
          providerBackoffUntil: state.providerBackoffUntil,
          providerBackoffReason: state.providerBackoffReason,
        },
      });
    },
  });

  pi.registerCommand("magic-docs-update", {
    description: "Update tracked Magic Docs, or a specific path if provided",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      restoreTrackedFromSession(sessionId, ctx);
      const state = getState(sessionId);

      let docs: MagicDocInfo[];
      const targetArg = args.trim();
      if (targetArg) {
        const targetPath = normalizeFilePath(targetArg, ctx.cwd);
        const direct = state.tracked.get(targetPath);
        if (direct) docs = [direct];
        else {
          const content = loadFile(targetPath);
          const detected = content ? detectMagicDocHeader(content) : null;
          if (!detected) {
            ctx.ui.notify(`Not a tracked Magic Doc and no Magic Doc header found: ${targetArg}`, "warning");
            return;
          }
          const doc = { path: targetPath, title: detected.title, instructions: detected.instructions };
          track(sessionId, doc);
          docs = [doc];
        }
      } else {
        docs = [...state.tracked.values()];
      }

      if (docs.length === 0) {
        ctx.ui.notify("No tracked Magic Docs to update. Read a Magic Doc first.", "info");
        return;
      }

      await ctx.waitForIdle();
      await queueUpdate(sessionId, docs, ctx, "manual");
    },
  });
}
