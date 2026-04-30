import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type WatchConfig = {
  id: string;
  label?: string;
  localPath: string;
  remoteUrl: string;
  branch?: string;
  applyHint?: string;
};

type PendingUpdate = {
  localHead: string;
  remoteHead: string;
  commits: string;
  message: string;
  detectedAt: string;
};

type WatchState = {
  lastCheckedDay?: string;
  pending?: PendingUpdate;
  lastError?: string;
};

type UpdateEventType = "update_available" | "still_pending" | "no_updates" | "updated" | "check_failed" | "local_missing";

type UpdateEvent = {
  at: string;
  watchId: string;
  type: UpdateEventType;
  details?: string;
};

type CheckerState = {
  version: 1;
  watches: Record<string, WatchState>;
  events: UpdateEvent[];
};

type CheckerConfig = {
  watch: WatchConfig[];
};

const AGENT_DIR = resolve(homedir(), ".pi", "agent");
const STATE_PATH = resolve(AGENT_DIR, "extensions", "skill-update-checker", "state.json");
const GLOBAL_CONFIG_PATH = resolve(AGENT_DIR, "skill-update-checker.json");
const MAX_EVENTS = 200;

function todayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizePath(input: string, cwd?: string): string {
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  if (input.startsWith("/")) return resolve(input);
  return resolve(cwd || process.cwd(), input);
}

function loadJsonFile<T>(filePath: string): T | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function loadState(): CheckerState {
  const raw = loadJsonFile<CheckerState>(STATE_PATH);
  return {
    version: 1,
    watches: raw?.watches || {},
    events: Array.isArray(raw?.events) ? raw!.events.slice(-MAX_EVENTS) : [],
  };
}

function saveState(state: CheckerState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // non-fatal
  }
}

function addEvent(state: CheckerState, watchId: string, type: UpdateEventType, details?: string): void {
  state.events = [...state.events, { at: new Date().toISOString(), watchId, type, details }].slice(-MAX_EVENTS);
}

function getProjectConfigPath(cwd: string): string {
  return resolve(cwd, ".pi", "skill-update-checker.json");
}

function dedupeWatches(watches: WatchConfig[]): WatchConfig[] {
  const byId = new Map<string, WatchConfig>();
  for (const watch of watches) {
    byId.set(watch.id, watch);
  }
  return [...byId.values()];
}

function loadConfig(cwd: string): CheckerConfig {
  const globalConfig = loadJsonFile<CheckerConfig>(GLOBAL_CONFIG_PATH);
  const projectConfig = loadJsonFile<CheckerConfig>(getProjectConfigPath(cwd));
  const merged = dedupeWatches([
    ...(globalConfig?.watch || []),
    ...(projectConfig?.watch || []).map((watch) => ({ ...watch, localPath: normalizePath(watch.localPath, cwd) })),
  ]).map((watch) => ({
    ...watch,
    localPath: normalizePath(watch.localPath, cwd),
  }));
  return { watch: merged };
}

function buildMessage(watch: WatchConfig, count: number | string, commits: string): string {
  const name = watch.label || watch.id;
  const hint = watch.applyHint || "Update the local source, then reload Pi if needed.";
  return [
    `🔔 **${name} has ${count} new update${count === 1 ? "" : "s"}:**`,
    "",
    "```",
    commits || "(no commit details available)",
    "```",
    "",
    hint,
  ].join("\n");
}

function sendPendingMessage(pi: ExtensionAPI, watch: WatchConfig, pending?: PendingUpdate): void {
  if (!pending?.message) return;
  pi.sendMessage({
    customType: "skill-update-checker",
    content: pending.message,
    display: true,
    details: {
      watchId: watch.id,
      label: watch.label || watch.id,
      localPath: watch.localPath,
      remoteUrl: watch.remoteUrl,
      branch: watch.branch || "HEAD",
      pending,
    },
  });
}

async function runCheck(pi: ExtensionAPI, state: CheckerState, watch: WatchConfig, force = false): Promise<void> {
  const today = todayKey();
  const watchState = state.watches[watch.id] || {};
  state.watches[watch.id] = watchState;

  if (!existsSync(watch.localPath)) {
    watchState.lastCheckedDay = today;
    watchState.lastError = `Missing local path: ${watch.localPath}`;
    addEvent(state, watch.id, "local_missing", watchState.lastError);
    return;
  }

  try {
    const local = await pi.exec("git", ["-C", watch.localPath, "rev-parse", "HEAD"], { timeout: 5000 });
    if (local.code !== 0) {
      watchState.lastCheckedDay = today;
      watchState.lastError = "git rev-parse HEAD failed";
      addEvent(state, watch.id, "check_failed", watchState.lastError);
      return;
    }

    const localHead = local.stdout.trim();

    if (watchState.pending && watchState.pending.remoteHead === localHead) {
      addEvent(state, watch.id, "updated", `local head reached ${localHead.slice(0, 12)}`);
      delete watchState.pending;
      watchState.lastError = undefined;
    }

    if (!force && watchState.lastCheckedDay === today) {
      return;
    }

    const remoteTarget = watch.branch ? `refs/heads/${watch.branch}` : "HEAD";
    const remote = await pi.exec("git", ["ls-remote", watch.remoteUrl, remoteTarget], { timeout: 10000 });
    if (remote.code !== 0) {
      watchState.lastCheckedDay = today;
      watchState.lastError = "git ls-remote failed";
      addEvent(state, watch.id, "check_failed", watchState.lastError);
      return;
    }

    const remoteHead = remote.stdout.split(/\s/)[0]?.trim();
    if (!remoteHead) {
      watchState.lastCheckedDay = today;
      watchState.lastError = "remote HEAD not found";
      addEvent(state, watch.id, "check_failed", watchState.lastError);
      return;
    }

    watchState.lastCheckedDay = today;
    watchState.lastError = undefined;

    if (localHead === remoteHead) {
      if (watchState.pending) addEvent(state, watch.id, "updated", `${localHead.slice(0, 12)} == ${remoteHead.slice(0, 12)}`);
      else addEvent(state, watch.id, "no_updates", localHead.slice(0, 12));
      delete watchState.pending;
      return;
    }

    if (watchState.pending && watchState.pending.localHead === localHead && watchState.pending.remoteHead === remoteHead) {
      addEvent(state, watch.id, "still_pending", `${localHead.slice(0, 12)}..${remoteHead.slice(0, 12)}`);
      return;
    }

    const fetchTarget = watch.branch || "HEAD";
    await pi.exec("git", ["-C", watch.localPath, "fetch", "origin", fetchTarget], { timeout: 10000 });

    const compareRef = watch.branch ? `origin/${watch.branch}` : remoteHead;
    const log = await pi.exec(
      "git",
      ["-C", watch.localPath, "log", "--oneline", "--no-decorate", `${localHead}..${compareRef}`],
      { timeout: 5000 },
    );

    const commits = log.code === 0 ? log.stdout.trim() : "(failed to read commit list)";
    const count = commits && commits !== "(failed to read commit list)" ? commits.split("\n").filter(Boolean).length : "?";
    const message = buildMessage(watch, count, commits);

    watchState.pending = {
      localHead,
      remoteHead,
      commits,
      message,
      detectedAt: new Date().toISOString(),
    };
    addEvent(state, watch.id, "update_available", `${localHead.slice(0, 12)}..${remoteHead.slice(0, 12)}`);
  } catch {
    watchState.lastCheckedDay = today;
    watchState.lastError = "unexpected exception";
    addEvent(state, watch.id, "check_failed", watchState.lastError);
  }
}

function buildStatusMessage(config: CheckerConfig, state: CheckerState): string {
  if (config.watch.length === 0) {
    return [
      "Skill update checker: no watched sources configured.",
      `Global config: ${GLOBAL_CONFIG_PATH}`,
      "Add a watch entry with localPath + remoteUrl to enable daily checks.",
    ].join("\n");
  }

  const lines = [
    `Skill update checker: watching ${config.watch.length} source${config.watch.length === 1 ? "" : "s"}`,
    `Global config: ${GLOBAL_CONFIG_PATH}`,
  ];

  for (const watch of config.watch) {
    const watchState = state.watches[watch.id] || {};
    const status = watchState.pending
      ? `pending (${watchState.pending.localHead.slice(0, 7)}..${watchState.pending.remoteHead.slice(0, 7)})`
      : watchState.lastError
        ? `error (${watchState.lastError})`
        : `up-to-date`;
    lines.push("");
    lines.push(`- ${watch.label || watch.id}: ${status}`);
    lines.push(`  local: ${watch.localPath}`);
    lines.push(`  remote: ${watch.remoteUrl}${watch.branch ? `#${watch.branch}` : ""}`);
    lines.push(`  last checked day: ${watchState.lastCheckedDay || "never"}`);
  }

  return lines.join("\n");
}

export default function skillUpdateChecker(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.watch.length === 0) return;

    const state = loadState();
    for (const watch of config.watch) {
      await runCheck(pi, state, watch, false);
    }
    saveState(state);

    for (const watch of config.watch) {
      sendPendingMessage(pi, watch, state.watches[watch.id]?.pending);
    }
  });

  pi.registerCommand("skill-updates-status", {
    description: "Show watched skill-source update status",
    handler: async (_args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const state = loadState();
      const message = buildStatusMessage(config, state);
      ctx.ui.notify(message, "info");
      pi.sendMessage({
        customType: "skill-update-checker-status",
        content: message,
        display: true,
        details: {
          configPath: GLOBAL_CONFIG_PATH,
          watchCount: config.watch.length,
          watches: config.watch,
          state: state.watches,
        },
      });
    },
  });

  pi.registerCommand("skill-updates-check", {
    description: "Force an immediate check for watched skill-source updates",
    handler: async (_args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const state = loadState();
      for (const watch of config.watch) {
        await runCheck(pi, state, watch, true);
      }
      saveState(state);
      const message = buildStatusMessage(config, state);
      ctx.ui.notify(message, "info");
      pi.sendMessage({
        customType: "skill-update-checker-status",
        content: message,
        display: true,
        details: {
          forced: true,
          configPath: GLOBAL_CONFIG_PATH,
          watchCount: config.watch.length,
          watches: config.watch,
          state: state.watches,
        },
      });
      for (const watch of config.watch) {
        sendPendingMessage(pi, watch, state.watches[watch.id]?.pending);
      }
    },
  });
}
