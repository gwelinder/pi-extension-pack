import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { execFile, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

type SkillLocation = "user" | "project" | "temporary" | "unknown";

type ToolErrorRecord = {
  toolName: string;
  toolCallId: string;
  message?: string;
  inputPreview?: string;
  timestamp: string;
};

type SkillRecord = {
  name: string;
  path?: string;
  source: "explicit_command" | "read_path";
  location: SkillLocation;
  commandName?: string;
  sha256?: string;
};

type ActiveRun = {
  runId: string;
  startedAtMs: number;
  startedAtIso: string;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  inputSource: string;
  inputPreview: string;
  inputHash: string;
  inputLength: number;
  explicitSkillName?: string;
  explicitSkillArgsPreview?: string;
  explicitSkillArgsHash?: string;
  explicitSkillArgsLength?: number;
  loadedSkills: Map<string, SkillRecord>;
  toolErrors: ToolErrorRecord[];
  turns: number;
};

type SkillCatalogEntry = {
  name: string;
  commandName?: string;
  path?: string;
  location: SkillLocation;
  description?: string;
};

const SCHEMA = "cognee-skill-observer/v1";
const DEFAULT_OBSERVER_ROOT = path.join(homedir(), ".pi", "agent", "skill-observer");
const DEFAULT_LOG_PATH = path.join(DEFAULT_OBSERVER_ROOT, "observations.ndjson");
const DEFAULT_MANAGED_GLOBAL_DIR = path.join(homedir(), ".pi", "agent", "skills-managed", "active");
const DEFAULT_MANAGED_PROJECT_SUBPATH = path.join(".pi", "skills-managed", "active");
const LOG_ROTATE_MAX_BYTES = Number(process.env.COGNEE_SKILL_OBSERVER_MAX_LOG_BYTES || 10 * 1024 * 1024);
const LOG_ROTATE_MAX_ARCHIVES = Math.max(1, Number(process.env.COGNEE_SKILL_OBSERVER_MAX_ARCHIVES || 3));
const LOG_ROTATE_CHECK_INTERVAL_MS = Number(process.env.COGNEE_SKILL_OBSERVER_ROTATE_CHECK_INTERVAL_MS || 30_000);

function toIso(ts = Date.now()): string {
  return new Date(ts).toISOString();
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fileSizeMaybe(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function envTruthy(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizePathMaybe(rawPath: string | undefined, cwd: string): string | undefined {
  if (!rawPath || rawPath.trim() === "") return undefined;
  let p = rawPath.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (p.startsWith("~/")) p = path.join(homedir(), p.slice(2));
  const resolved = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  return path.normalize(resolved);
}

function hashSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function previewText(input: string, maxChars = 240): string {
  if (!input) return "";
  const singleLine = input.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars)}…`;
}

function tryReadFileHash(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    const data = fs.readFileSync(filePath, "utf8");
    return hashSha256(data);
  } catch {
    return undefined;
  }
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Error) {
      return {
        name: v.name,
        message: v.message,
        stack: v.stack,
      };
    }
    return v;
  });
}

function discoverSkillFilesFromRoot(root: string): string[] {
  if (!root || !fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) return [];

  const ignoreDirs = new Set([".git", "node_modules", ".turbo", "dist", "build"]);
  const ignoreRootMd = new Set(["readme.md", "license.md", "changelog.md"]);

  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      // Follow symlinks for both dirs and files
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try { isDir = fs.statSync(full).isDirectory(); } catch { continue; /* dangling symlink */ }
      }
      if (isDir) {
        if (ignoreDirs.has(entry.name)) continue;
        stack.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      const isFile = entry.isFile() || entry.isSymbolicLink();
      if (!isFile) continue;

      const lower = entry.name.toLowerCase();
      if (lower === "skill.md") {
        out.push(path.normalize(full));
        continue;
      }

      if (current.depth === 0 && lower.endsWith(".md") && !ignoreRootMd.has(lower)) {
        out.push(path.normalize(full));
      }
    }
  }

  return [...new Set(out)].sort();
}

function parseSkillCommand(rawInput: string): { skillName: string; args?: string } | undefined {
  const match = rawInput.match(/^\/skill:([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  return {
    skillName: match[1].toLowerCase(),
    args: match[2],
  };
}

function extractTextFromMessageContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const part of content) {
    const maybePart = part as any;
    if (maybePart?.type === "text" && typeof maybePart.text === "string") {
      chunks.push(maybePart.text);
    }
  }
  return chunks.join("\n").trim();
}

function extractLastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg?.role === "assistant") {
      return extractTextFromMessageContent(msg.content);
    }
  }
  return "";
}

function extractErrorMessage(result: unknown): string | undefined {
  const maybeResult = result as any;
  if (!maybeResult) return undefined;

  const fromContent = extractTextFromMessageContent(maybeResult.content);
  if (fromContent) return previewText(fromContent, 600);

  if (typeof maybeResult.error === "string") return previewText(maybeResult.error, 600);
  if (typeof maybeResult.message === "string") return previewText(maybeResult.message, 600);

  return undefined;
}

const DAEMON_PID_FILE = path.join(DEFAULT_OBSERVER_ROOT, "cognee-state.daemon.pid");
const DAEMON_LOG_FILE = path.join(DEFAULT_OBSERVER_ROOT, "daemon.log");

function resolvePackageDir(): string | undefined {
  const envDir = process.env.PI_PACKAGE_DIR?.trim();
  if (envDir) return path.resolve(envDir);
  try {
    if (typeof __dirname === "string" && __dirname) return path.resolve(__dirname);
  } catch {}
  return undefined;
}

function resolveIngesterScript(): string {
  const envPath = process.env.COGNEE_SKILL_OBSERVER_INGESTER_PATH?.trim();
  const packageDir = resolvePackageDir();
  const candidates = [
    envPath,
    packageDir ? path.join(packageDir, "cognee_ingester.py") : undefined,
    packageDir ? path.join(packageDir, "extras", "skill-observer", "cognee_ingester.py") : undefined,
    path.join(homedir(), ".pi", "agent", "extensions", "skill-observer", "cognee_ingester.py"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0] || path.join(DEFAULT_OBSERVER_ROOT, "cognee_ingester.py");
}

function getDaemonStatus(): { running: boolean; pid?: number; stalePidCleaned: boolean } {
  let stalePidCleaned = false;
  try {
    if (!fs.existsSync(DAEMON_PID_FILE)) return { running: false, stalePidCleaned };
    const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf8").trim(), 10);
    if (isNaN(pid)) {
      try { fs.unlinkSync(DAEMON_PID_FILE); stalePidCleaned = true; } catch {}
      return { running: false, stalePidCleaned };
    }
    process.kill(pid, 0);
    return { running: true, pid, stalePidCleaned };
  } catch {
    try { fs.unlinkSync(DAEMON_PID_FILE); stalePidCleaned = true; } catch {}
    return { running: false, stalePidCleaned };
  }
}

function isDaemonRunning(): boolean {
  return getDaemonStatus().running;
}

function ensureDaemonRunning(): void {
  if (isDaemonRunning()) return;
  const ingesterScript = resolveIngesterScript();
  if (!fs.existsSync(ingesterScript)) return;

  try {
    const logFd = fs.openSync(DAEMON_LOG_FILE, "a");
    const child = execFile("python3", [ingesterScript, "daemon"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    } as any);

    // Detach so it survives Pi shutdown
    if (child.unref) child.unref();
    fs.closeSync(logFd);
  } catch {
    // Non-fatal — daemon is optional
  }
}

export default function skillObserverExtension(pi: ExtensionAPI) {
  const logPath = process.env.COGNEE_SKILL_OBSERVER_LOG_PATH?.trim() || DEFAULT_LOG_PATH;
  const includeSensitiveText = envTruthy("COGNEE_SKILL_OBSERVER_INCLUDE_TEXT", false);
  const disabled = envTruthy("COGNEE_SKILL_OBSERVER_DISABLED", false);
  const analyticsOnly = !envTruthy("COGNEE_SKILL_OBSERVER_ENABLE_DAEMON", false);

  ensureParentDir(logPath);

  let lastRotateCheckAt = 0;

  function rotateLogsIfNeeded(force = false): { rotated: boolean; archives: string[]; currentSize: number } {
    const now = Date.now();
    if (!force && now - lastRotateCheckAt < LOG_ROTATE_CHECK_INTERVAL_MS) {
      return { rotated: false, archives: [], currentSize: fileSizeMaybe(logPath) };
    }
    lastRotateCheckAt = now;

    const currentSize = fileSizeMaybe(logPath);
    if (currentSize <= 0 || currentSize < LOG_ROTATE_MAX_BYTES) {
      return { rotated: false, archives: [], currentSize };
    }

    const archives: string[] = [];
    try {
      for (let i = LOG_ROTATE_MAX_ARCHIVES; i >= 1; i--) {
        const src = `${logPath}.${i}`;
        const dest = `${logPath}.${i + 1}`;
        if (!fs.existsSync(src)) continue;
        if (i === LOG_ROTATE_MAX_ARCHIVES) fs.rmSync(src, { force: true });
        else fs.renameSync(src, dest);
      }
      fs.renameSync(logPath, `${logPath}.1`);
      fs.writeFileSync(logPath, "", "utf8");
      for (let i = 1; i <= LOG_ROTATE_MAX_ARCHIVES; i++) {
        const candidate = `${logPath}.${i}`;
        if (fs.existsSync(candidate)) archives.push(candidate);
      }
      return { rotated: true, archives, currentSize };
    } catch {
      return { rotated: false, archives, currentSize };
    }
  }

  let currentRun: ActiveRun | null = null;
  const toolCallIndex = new Map<string, { toolName: string; input: unknown; ts: number }>();

  // Session-level skill memory: skills loaded in earlier runs carry over
  // to subsequent runs in the same session (they're still in the LLM context).
  const sessionSkillMemory = new Map<string, SkillRecord>();

  const skillCatalogByName = new Map<string, SkillCatalogEntry>();
  const skillCatalogByPath = new Map<string, SkillCatalogEntry>();
  let lastSessionStartMeta: { reason?: string; previousSessionFile?: string } = {};

  function emit(event: string, payload: Record<string, unknown>) {
    if (disabled) return;

    const rotation = rotateLogsIfNeeded();
    if (rotation.rotated) {
      const rotateEvent = safeJsonStringify({
        schema: SCHEMA,
        event: "log_rotated",
        ts: toIso(),
        previousSizeBytes: rotation.currentSize,
        logPath,
        archives: rotation.archives,
      });
      try {
        fs.appendFileSync(logPath, `${rotateEvent}\n`, "utf8");
      } catch {
        // Never break the agent flow because of observer logging.
      }
    }

    const line = safeJsonStringify({
      schema: SCHEMA,
      event,
      ts: toIso(),
      ...payload,
    });

    try {
      fs.appendFileSync(logPath, `${line}\n`, "utf8");
    } catch {
      // Never break the agent flow because of observer logging.
    }
  }

  function getManagedSkillRoots(cwd: string): string[] {
    const envRoots = (process.env.COGNEE_SKILL_PATHS || "")
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => normalizePathMaybe(s, cwd))
      .filter((s): s is string => Boolean(s));

    if (envRoots.length > 0) {
      return [...new Set(envRoots)];
    }

    const defaults = [
      DEFAULT_MANAGED_GLOBAL_DIR,
      path.join(cwd, DEFAULT_MANAGED_PROJECT_SUBPATH),
    ].map((s) => path.normalize(s));

    return [...new Set(defaults)];
  }

  function refreshSkillCatalog(cwd: string) {
    skillCatalogByName.clear();
    skillCatalogByPath.clear();

    const commands = pi.getCommands().filter((command) => command.source === "skill") as Array<any>;

    for (const command of commands) {
      const normalizedName = command.name.startsWith("skill:")
        ? command.name.slice("skill:".length)
        : command.name;
      const skillName = normalizedName.toLowerCase();
      const sourceInfo = command.sourceInfo || {};

      const entry: SkillCatalogEntry = {
        name: skillName,
        commandName: command.name,
        path: normalizePathMaybe(sourceInfo.path, cwd),
        location: (["user", "project", "temporary"].includes(sourceInfo.scope) ? sourceInfo.scope : "unknown") as SkillLocation,
        description: command.description,
      };

      skillCatalogByName.set(skillName, entry);
      if (entry.path) {
        skillCatalogByPath.set(entry.path, entry);
      }
    }
  }

  function resolveSkillByPath(filePath: string): SkillCatalogEntry | undefined {
    const normalized = path.normalize(filePath);
    const exact = skillCatalogByPath.get(normalized);
    if (exact) return exact;

    const base = path.basename(normalized).toLowerCase();
    if (base === "skill.md") {
      const inferredName = path.basename(path.dirname(normalized)).toLowerCase();
      return {
        name: inferredName,
        path: normalized,
        location: "unknown",
      };
    }

    if (base.endsWith(".md") && normalized.includes(`${path.sep}skills${path.sep}`)) {
      // Skip reference/sub-files — only treat SKILL.md as a skill load.
      // Files like references/services.md, pptxgenjs.md, editing.md etc.
      // are supporting docs read during skill execution, not skills themselves.
      const parentDir = path.basename(path.dirname(normalized)).toLowerCase();
      if (parentDir === "references" || parentDir === "scripts" || parentDir === "examples") {
        return undefined;
      }
      // Also skip if the file is a sibling .md in the same dir as a SKILL.md
      // (e.g. pptx/pptxgenjs.md, pptx/editing.md) — these are sub-docs
      const siblingSkillMd = path.join(path.dirname(normalized), "SKILL.md");
      try {
        if (fs.existsSync(siblingSkillMd) && base !== "skill.md") {
          return undefined;
        }
      } catch {}
      const inferredName = path.basename(base, ".md").toLowerCase();
      return {
        name: inferredName,
        path: normalized,
        location: "unknown",
      };
    }

    return undefined;
  }

  function ensureRunForCurrentTurn(cwd: string, source: string): ActiveRun {
    if (currentRun) return currentRun;

    const syntheticRun: ActiveRun = {
      runId: randomUUID(),
      startedAtMs: Date.now(),
      startedAtIso: toIso(),
      cwd,
      sessionId: "(unknown)",
      inputSource: source,
      inputPreview: "(synthetic run; no input event observed)",
      inputHash: hashSha256(""),
      inputLength: 0,
      loadedSkills: new Map(),
      toolErrors: [],
      turns: 0,
    };

    currentRun = syntheticRun;
    emit("run_start", {
      runId: syntheticRun.runId,
      synthetic: true,
      cwd: syntheticRun.cwd,
      sessionId: syntheticRun.sessionId,
      inputSource: syntheticRun.inputSource,
      inputLength: syntheticRun.inputLength,
      inputHash: syntheticRun.inputHash,
      inputPreview: includeSensitiveText ? syntheticRun.inputPreview : undefined,
    });

    return syntheticRun;
  }

  function recordLoadedSkill(run: ActiveRun, skill: SkillCatalogEntry, source: SkillRecord["source"], meta: Record<string, unknown> = {}) {
    const dedupeKey = skill.path ? `${skill.name}::${skill.path}` : skill.name;
    if (run.loadedSkills.has(dedupeKey)) return;

    const record: SkillRecord = {
      name: skill.name,
      path: skill.path,
      source,
      location: skill.location,
      commandName: skill.commandName,
      sha256: tryReadFileHash(skill.path),
    };

    run.loadedSkills.set(dedupeKey, record);

    // Remember this skill for the rest of the session —
    // subsequent runs inherit it since it's still in LLM context.
    sessionSkillMemory.set(dedupeKey, record);

    emit("skill_loaded", {
      runId: run.runId,
      skill: record,
      ...meta,
    });
  }

  pi.on("resources_discover", (event) => {
    const roots = getManagedSkillRoots(event.cwd);
    const skillPaths = roots.flatMap((root) => discoverSkillFilesFromRoot(root));
    const deduped = [...new Set(skillPaths)];

    emit("resources_discover", {
      reason: event.reason,
      cwd: event.cwd,
      managedRoots: roots,
      discoveredSkillPaths: deduped,
      discoveredSkillCount: deduped.length,
    });

    return {
      skillPaths: deduped,
    };
  });

  pi.on("session_start", (event, ctx) => {
    refreshSkillCatalog(ctx.cwd);
    sessionSkillMemory.clear();
    lastSessionStartMeta = {
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
    };

    const rotation = rotateLogsIfNeeded(true);
    if (rotation.rotated) {
      emit("log_rotated", {
        previousSizeBytes: rotation.currentSize,
        logPath,
        archives: rotation.archives,
        source: "session_start",
      });
    }

    emit("observer_session_start", {
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      catalogSkillCount: skillCatalogByName.size,
      logPath,
      includeSensitiveText,
      analyticsOnly,
      ingesterScript: resolveIngesterScript(),
    });

    // The observer now serves as analytics/telemetry only by default.
    // Legacy Cognee ingestion stays opt-in behind COGNEE_SKILL_OBSERVER_ENABLE_DAEMON.
    if (!disabled && !analyticsOnly && !envTruthy("COGNEE_SKILL_OBSERVER_NO_DAEMON", false)) {
      ensureDaemonRunning();
    }
  });

  pi.on("input", (event, ctx) => {
    refreshSkillCatalog(ctx.cwd);

    if (currentRun) {
      emit("run_abandoned", {
        runId: currentRun.runId,
        reason: "new_input_before_previous_run_end",
        elapsedMs: Date.now() - currentRun.startedAtMs,
      });
    }

    const parsedSkillCommand = parseSkillCommand(event.text);

    // Carry forward skills from earlier runs in this session —
    // the LLM still has them in context even though the user sent a new message.
    const carriedSkills = new Map<string, SkillRecord>();
    for (const [key, record] of sessionSkillMemory) {
      carriedSkills.set(key, { ...record, source: "read_path" });
    }

    const run: ActiveRun = {
      runId: randomUUID(),
      startedAtMs: Date.now(),
      startedAtIso: toIso(),
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      inputSource: event.source,
      inputPreview: previewText(event.text),
      inputHash: hashSha256(event.text),
      inputLength: event.text.length,
      explicitSkillName: parsedSkillCommand?.skillName,
      explicitSkillArgsPreview: parsedSkillCommand?.args ? previewText(parsedSkillCommand.args) : undefined,
      explicitSkillArgsHash: parsedSkillCommand?.args ? hashSha256(parsedSkillCommand.args) : undefined,
      explicitSkillArgsLength: parsedSkillCommand?.args?.length,
      loadedSkills: carriedSkills,
      toolErrors: [],
      turns: 0,
    };

    currentRun = run;

    emit("run_start", {
      runId: run.runId,
      startedAt: run.startedAtIso,
      cwd: run.cwd,
      sessionId: run.sessionId,
      sessionFile: run.sessionFile,
      inputSource: run.inputSource,
      inputLength: run.inputLength,
      inputHash: run.inputHash,
      inputPreview: run.inputPreview,
      explicitSkillName: run.explicitSkillName,
      explicitSkillArgsHash: run.explicitSkillArgsHash,
      explicitSkillArgsLength: run.explicitSkillArgsLength,
      explicitSkillArgsPreview: includeSensitiveText ? run.explicitSkillArgsPreview : undefined,
      model: {
        provider: (ctx.model as any)?.provider,
        id: (ctx.model as any)?.id,
      },
    });

    if (parsedSkillCommand) {
      const fromCatalog = skillCatalogByName.get(parsedSkillCommand.skillName);
      const entry = fromCatalog || {
        name: parsedSkillCommand.skillName,
        location: "unknown" as SkillLocation,
      };

      recordLoadedSkill(run, entry, "explicit_command", {
        via: "input_command",
      });
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    const run = ensureRunForCurrentTurn(ctx.cwd, "agent_start");
    if (run.sessionId === "(unknown)") {
      run.sessionId = ctx.sessionManager.getSessionId();
      run.sessionFile = ctx.sessionManager.getSessionFile();
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const run = ensureRunForCurrentTurn(ctx.cwd, "tool_call");

    toolCallIndex.set(event.toolCallId, {
      toolName: event.toolName,
      input: (event as any).input,
      ts: Date.now(),
    });

    if (event.toolName !== "read") return;

    const rawPath = (event as any).input?.path;
    const normalized = normalizePathMaybe(rawPath, ctx.cwd);
    if (!normalized) return;

    const skill = resolveSkillByPath(normalized);
    if (!skill) return;

    recordLoadedSkill(run, skill, "read_path", {
      toolCallId: event.toolCallId,
      readPath: normalized,
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const run = ensureRunForCurrentTurn(ctx.cwd, "tool_execution_end");

    const callMeta = toolCallIndex.get(event.toolCallId);
    toolCallIndex.delete(event.toolCallId);

    if (!event.isError) return;

    const message = extractErrorMessage(event.result);
    const inputPreview = callMeta?.input ? previewText(safeJsonStringify(callMeta.input), 240) : undefined;

    const errorRecord: ToolErrorRecord = {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      message,
      inputPreview,
      timestamp: toIso(),
    };

    run.toolErrors.push(errorRecord);

    emit("tool_error", {
      runId: run.runId,
      toolName: errorRecord.toolName,
      toolCallId: errorRecord.toolCallId,
      toolInputPreview: errorRecord.inputPreview,
      errorMessage: errorRecord.message,
    });
  });

  pi.on("turn_end", (event) => {
    if (!currentRun) return;
    currentRun.turns = Math.max(currentRun.turns, event.turnIndex + 1);
  });

  pi.on("agent_end", (event, ctx) => {
    const run = ensureRunForCurrentTurn(ctx.cwd, "agent_end");
    const assistantText = extractLastAssistantText(event.messages);

    const loadedSkills = [...run.loadedSkills.values()].map((s) => ({
      name: s.name,
      path: s.path,
      source: s.source,
      location: s.location,
      commandName: s.commandName,
      sha256: s.sha256,
    }));

    emit("run_end", {
      runId: run.runId,
      startedAt: run.startedAtIso,
      endedAt: toIso(),
      durationMs: Date.now() - run.startedAtMs,
      cwd: run.cwd,
      sessionId: run.sessionId,
      sessionFile: run.sessionFile,
      turns: run.turns,
      loadedSkillCount: loadedSkills.length,
      loadedSkills,
      toolErrorCount: run.toolErrors.length,
      toolErrors: run.toolErrors,
      executionOutcome: run.toolErrors.length > 0 ? "tool_error" : "ok",
      assistantLength: assistantText.length,
      assistantHash: hashSha256(assistantText),
      assistantPreview: includeSensitiveText ? previewText(assistantText, 320) : undefined,
      model: {
        provider: (ctx.model as any)?.provider,
        id: (ctx.model as any)?.id,
      },
    });

    currentRun = null;
  });

  pi.on("model_select", (event, ctx) => {
    emit("model_select", {
      cwd: ctx.cwd,
      source: event.source,
      previousModel: event.previousModel
        ? {
            provider: (event.previousModel as any).provider,
            id: (event.previousModel as any).id,
          }
        : undefined,
      model: {
        provider: (event.model as any).provider,
        id: (event.model as any).id,
      },
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (currentRun) {
      emit("run_abandoned", {
        runId: currentRun.runId,
        reason: "session_shutdown",
        elapsedMs: Date.now() - currentRun.startedAtMs,
      });
      currentRun = null;
    }

    emit("observer_session_shutdown", {
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
    });
  });

  function buildSkillAnalyticsReport(cwd: string, args: string): { message: string; details: Record<string, unknown> } {
    const files = [
      ...Array.from({ length: LOG_ROTATE_MAX_ARCHIVES }, (_v, i) => `${logPath}.${LOG_ROTATE_MAX_ARCHIVES - i}`),
      logPath,
    ].filter((candidate) => fs.existsSync(candidate));

    const runCwds = new Map<string, string>();
    const endedRunIds = new Set<string>();
    const runSkills = new Map<string, Set<string>>();
    const skillPaths = new Map<string, Map<string, number>>();
    const eventCounts = new Map<string, number>();
    let eventCount = 0;
    let runStartCount = 0;
    let runEndCount = 0;
    let minTs = "";
    let maxTs = "";

    function projectLabel(rawCwd: string | undefined): string {
      if (!rawCwd) return "(unknown)";
      const normalized = path.normalize(rawCwd);
      const codeRoot = path.join(homedir(), "code");
      const rel = path.relative(codeRoot, normalized);
      if (!rel || rel === "") return "(code-root)";
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep)[0] || "(code-root)";
      return normalized;
    }

    function classifySkillPath(skillPath: string | undefined): string {
      if (!skillPath || skillPath === "?") return "unknown";
      const normalized = path.normalize(skillPath);
      const codeRoot = path.join(homedir(), "code");
      const rel = path.relative(codeRoot, normalized);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        if (normalized.includes(`${path.sep}.pi${path.sep}skills${path.sep}`) || normalized.includes(`${path.sep}.pi${path.sep}skills-managed${path.sep}active${path.sep}`)) {
          return `project-local:${rel.split(path.sep)[0] || "code-root"}`;
        }
      }
      if (normalized.includes(`${path.sep}.pi${path.sep}agent${path.sep}skills-managed${path.sep}active${path.sep}`)) return "global-managed";
      if (normalized.includes(`${path.sep}.pi${path.sep}agent${path.sep}skills${path.sep}`)) return "global-user";
      if (normalized.includes(`${path.sep}node_modules${path.sep}`) || normalized.includes(`${path.sep}lib${path.sep}node_modules${path.sep}`)) return "package";
      return "other";
    }

    function incrementCounter(map: Map<string, number>, key: string, by = 1) {
      map.set(key, (map.get(key) || 0) + by);
    }

    function rememberSkill(runId: string | undefined, name: string | undefined, skillPath?: string) {
      if (!runId || !name) return;
      const normalizedName = name.toLowerCase();
      let skills = runSkills.get(runId);
      if (!skills) {
        skills = new Set<string>();
        runSkills.set(runId, skills);
      }
      skills.add(normalizedName);
      if (skillPath) {
        let pathsForSkill = skillPaths.get(normalizedName);
        if (!pathsForSkill) {
          pathsForSkill = new Map<string, number>();
          skillPaths.set(normalizedName, pathsForSkill);
        }
        incrementCounter(pathsForSkill, skillPath);
      }
    }

    for (const file of files) {
      let raw = "";
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }

        eventCount += 1;
        if (typeof o.event === "string") incrementCounter(eventCounts, o.event);
        if (typeof o.ts === "string") {
          if (!minTs || o.ts < minTs) minTs = o.ts;
          if (!maxTs || o.ts > maxTs) maxTs = o.ts;
        }

        if (o.event === "run_start") {
          runStartCount += 1;
          if (o.runId && o.cwd) runCwds.set(o.runId, o.cwd);
          if (o.runId && typeof o.explicitSkillName === "string") rememberSkill(o.runId, o.explicitSkillName);
          continue;
        }

        if (o.event === "skill_loaded") {
          const skill = o.skill || {};
          if (o.runId && o.cwd) runCwds.set(o.runId, o.cwd);
          rememberSkill(o.runId, skill.name, skill.path || o.readPath);
          continue;
        }

        if (o.event === "run_end") {
          runEndCount += 1;
          if (o.runId) endedRunIds.add(o.runId);
          if (o.runId && o.cwd) runCwds.set(o.runId, o.cwd);
          for (const loaded of Array.isArray(o.loadedSkills) ? o.loadedSkills : []) {
            if (typeof loaded === "string") rememberSkill(o.runId, loaded);
            else rememberSkill(o.runId, loaded?.name, loaded?.path);
          }
        }
      }
    }

    const skillStats = new Map<string, { runs: Set<string>; projects: Map<string, number>; pathClasses: Map<string, number> }>();
    for (const [runId, skills] of runSkills.entries()) {
      const project = projectLabel(runCwds.get(runId));
      for (const skill of skills) {
        let stat = skillStats.get(skill);
        if (!stat) {
          stat = { runs: new Set<string>(), projects: new Map<string, number>(), pathClasses: new Map<string, number>() };
          skillStats.set(skill, stat);
        }
        stat.runs.add(runId);
        incrementCounter(stat.projects, project);
      }
    }

    for (const [skill, pathsForSkill] of skillPaths.entries()) {
      const stat = skillStats.get(skill);
      if (!stat) continue;
      for (const [skillPath, count] of pathsForSkill.entries()) {
        incrementCounter(stat.pathClasses, classifySkillPath(skillPath), count);
      }
    }

    const rows = [...skillStats.entries()].map(([name, stat]) => {
      const projectEntries = [...stat.projects.entries()].sort((a, b) => b[1] - a[1]);
      const classEntries = [...stat.pathClasses.entries()].sort((a, b) => b[1] - a[1]);
      const runs = stat.runs.size;
      const topProject = projectEntries[0]?.[0] || "-";
      const topProjectCount = projectEntries[0]?.[1] || 0;
      return {
        name,
        runs,
        projects: stat.projects.size,
        topProject,
        topProjectCount,
        concentration: runs > 0 ? topProjectCount / runs : 0,
        dominantClass: classEntries[0]?.[0] || "unknown",
      };
    }).sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));

    const currentCatalog = new Set<string>();
    for (const root of getManagedSkillRoots(cwd)) {
      for (const skillFile of discoverSkillFilesFromRoot(root)) {
        const lower = path.basename(skillFile).toLowerCase();
        const name = lower === "skill.md"
          ? path.basename(path.dirname(skillFile)).toLowerCase()
          : path.basename(skillFile, path.extname(skillFile)).toLowerCase();
        if (name) currentCatalog.add(name);
      }
    }

    const usedSkillNames = new Set(rows.map((row) => row.name));
    const unusedManaged = [...currentCatalog].filter((name) => !usedSkillNames.has(name)).sort();
    const endedWithSkills = [...endedRunIds].filter((runId) => (runSkills.get(runId)?.size || 0) > 0).length;
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    const fmtDate = (ts: string) => ts ? ts.slice(0, 10) : "unknown";
    const limitMatch = args.match(/\b(?:top|limit)\s*=?\s*(\d{1,3})\b/i);
    const topLimit = Math.max(5, Math.min(50, limitMatch ? Number(limitMatch[1]) : 15));

    function formatRows(selected: typeof rows, limit = topLimit): string[] {
      return selected.slice(0, limit).map((row) => {
        const name = row.name.padEnd(34).slice(0, 34);
        return `  ${name} ${String(row.runs).padStart(4)}  ${String(row.projects).padStart(2)} projects  top=${row.topProject}:${percent(row.concentration)}  ${row.dominantClass}`;
      });
    }

    const broad = rows.filter((row) => row.runs >= 5 && row.projects >= 4 && row.concentration <= 0.5);
    const projectSpecific = rows
      .filter((row) => row.runs >= 3 && row.concentration >= 0.8)
      .sort((a, b) => b.concentration - a.concentration || b.runs - a.runs || a.name.localeCompare(b.name));
    const projectLocal = rows.filter((row) => row.dominantClass.startsWith("project-local:"));

    const lines = [
      `Skill analytics (${fmtDate(minTs)} → ${fmtDate(maxTs)})`,
      `Events: ${eventCount.toLocaleString()}  Runs: ${runStartCount.toLocaleString()} started / ${runEndCount.toLocaleString()} ended`,
      `Runs with skills: ${endedWithSkills.toLocaleString()} / ${runEndCount.toLocaleString()} = ${runEndCount ? percent(endedWithSkills / runEndCount) : "n/a"}`,
      `Current managed catalog: ${currentCatalog.size} skills; unused observed: ${unusedManaged.length}`,
      "",
      `Top skills by distinct runs:`,
      ...formatRows(rows),
      "",
      `Broad reusable skills:`,
      ...formatRows(broad, 12),
      "",
      `Project-specific candidates:`,
      ...formatRows(projectSpecific, 18),
      "",
      `Project-local skills by path:`,
      ...formatRows(projectLocal, 14),
      "",
      `Unused current managed skills:`,
      unusedManaged.length ? `  ${unusedManaged.slice(0, 40).join(", ")}${unusedManaged.length > 40 ? " …" : ""}` : "  (none)",
      "",
      `Tip: /skill-analytics top=30 for a longer top-skills section.`,
    ];

    return {
      message: lines.join("\n"),
      details: {
        files,
        eventCount,
        eventCounts: Object.fromEntries(eventCounts.entries()),
        runStartCount,
        runEndCount,
        endedWithSkills,
        dateRange: { minTs, maxTs },
        topSkills: rows.slice(0, 50),
        broadReusable: broad.slice(0, 50),
        projectSpecific: projectSpecific.slice(0, 50),
        projectLocal: projectLocal.slice(0, 50),
        unusedManaged,
      },
    };
  }

  pi.registerCommand("skill-analytics", {
    description: "Show skill usage analytics, reusable skills, project-specific candidates, and unused managed skills",
    handler: async (args, ctx) => {
      refreshSkillCatalog(ctx.cwd);
      const report = buildSkillAnalyticsReport(ctx.cwd, args || "");
      ctx.ui.notify(report.message, "info");
      pi.sendMessage({
        customType: "skill-analytics",
        content: report.message,
        display: true,
        details: report.details,
      });
    },
  });

  pi.registerCommand("skill-daemon", {
    description: "Check/start/stop the legacy cognee skill-observer daemon",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();
      if (cmd === "stop") {
        try {
          if (fs.existsSync(DAEMON_PID_FILE)) {
            const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf8").trim(), 10);
            if (!isNaN(pid)) {
              process.kill(pid, "SIGTERM");
              ctx.ui.notify(`Daemon stopped (pid ${pid})`, "info");
              return;
            }
          }
          ctx.ui.notify("No daemon running", "info");
        } catch {
          ctx.ui.notify("Failed to stop daemon", "warning");
        }
        return;
      }

      if (cmd === "start") {
        ensureDaemonRunning();
        ctx.ui.notify("Legacy Cognee daemon start requested", "info");
        return;
      }

      if (cmd === "log" || cmd === "logs") {
        try {
          const log = fs.readFileSync(DAEMON_LOG_FILE, "utf8");
          const tail = log.split("\n").slice(-30).join("\n");
          pi.sendMessage({
            customType: "skill-daemon-log",
            content: tail || "(empty)",
            display: true,
          });
        } catch {
          ctx.ui.notify("No daemon log found", "info");
        }
        return;
      }

      // Default: status
      const daemon = getDaemonStatus();
      const pid = daemon.pid != null ? String(daemon.pid) : "(none)";
      const msg = [
        `Legacy Cognee daemon: ${daemon.running ? "RUNNING" : "STOPPED"} (pid=${pid})`,
        `Mode: ${analyticsOnly ? "analytics-only by default; daemon opt-in" : "legacy daemon enabled"}`,
        `Daemon log: ${DAEMON_LOG_FILE}`,
        daemon.stalePidCleaned ? `Stale PID file: cleaned` : `Stale PID file: not detected`,
        "",
        "Commands: /skill-daemon start | stop | log",
      ].join("\n");
      ctx.ui.notify(msg, "info");
      pi.sendMessage({ customType: "skill-daemon", content: msg, display: true });
    },
  });

  pi.registerCommand("skill-observer-status", {
    description: "Show skill-observer analytics status, log health, and legacy Cognee details",
    handler: async (_args, ctx) => {
      refreshSkillCatalog(ctx.cwd);

      const daemon = getDaemonStatus();
      const roots = getManagedSkillRoots(ctx.cwd);
      const logSize = fileSizeMaybe(logPath);
      const archiveCount = Array.from({ length: LOG_ROTATE_MAX_ARCHIVES }, (_v, i) => `${logPath}.${i + 1}`)
        .filter((candidate) => fs.existsSync(candidate)).length;
      const ingesterScript = resolveIngesterScript();
      const lines = [
        `Skill observer: ${disabled ? "disabled" : "active"}`,
        `Role: analytics / telemetry`,
        `Legacy Cognee daemon mode: ${analyticsOnly ? "opt-in only" : "enabled"}`,
        `Daemon running: ${daemon.running ? "yes" : "no"}`,
        `Stale PID cleaned on check: ${daemon.stalePidCleaned ? "yes" : "no"}`,
        `Last session start reason: ${lastSessionStartMeta.reason || "unknown"}`,
        `Previous session file: ${lastSessionStartMeta.previousSessionFile || "(none)"}`,
        `Ingester script: ${ingesterScript}`,
        `Log file: ${logPath}`,
        `Log size: ${Math.round(logSize / 1024)} KB`,
        `Log rotation: ${Math.round(LOG_ROTATE_MAX_BYTES / 1024 / 1024)} MB max, ${LOG_ROTATE_MAX_ARCHIVES} archives kept (${archiveCount} present)`,
        `Include text previews: ${includeSensitiveText ? "yes" : "no"}`,
        `Cataloged skill commands: ${skillCatalogByName.size}`,
        "Managed skill roots:",
        ...roots.map((r) => `  - ${r}`),
      ];

      const message = lines.join("\n");
      ctx.ui.notify(message, "info");
      pi.sendMessage({
        customType: "skill-observer",
        content: message,
        display: true,
        details: {
          disabled,
          logPath,
          logSize,
          includeSensitiveText,
          catalogSkillCount: skillCatalogByName.size,
          roots,
          analyticsOnly,
          daemon,
          ingesterScript,
          lastSessionStartMeta,
          logRotateMaxBytes: LOG_ROTATE_MAX_BYTES,
          logRotateMaxArchives: LOG_ROTATE_MAX_ARCHIVES,
          archiveCount,
        },
      });
    },
  });
}
