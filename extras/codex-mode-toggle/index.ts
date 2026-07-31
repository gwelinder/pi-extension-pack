import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configForCodexMode, currentCodexMode, parseCodexModeArgs, type CodexMode, type JsonObject } from "./core.ts";

const CONFIG_NAME = "pi-codex-conversion.json";
const STATUS_KEY = "codex-mode-toggle";

function configPath(): string {
  return join(getAgentDir(), CONFIG_NAME);
}

function readConfig(): JsonObject {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeConfig(config: JsonObject): void {
  const path = configPath();
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    try { rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  }
}

function mode(): CodexMode {
  return currentCodexMode(readConfig());
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const active = mode();
  ctx.ui.setStatus(STATUS_KEY, active === "code" ? "codex:code" : "codex:native");
}

function recordSwitch(from: CodexMode, to: CodexMode, inPlace: boolean, ctx: ExtensionContext): void {
  const directory = join(getAgentDir(), "telemetry", "codex-mode-toggle");
  mkdirSync(directory, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(join(directory, `${day}.jsonl`), `${JSON.stringify({
    timestamp: new Date().toISOString(),
    from,
    to,
    inPlace,
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    cwd: ctx.cwd,
  })}\n`);
}

function describe(active: CodexMode): string {
  return active === "code"
    ? "Codex Code Mode: schema-free V8 exec/wait for GPT-5.6; Pi extension tools are unavailable to Codex."
    : "Native routed tools: Pi extensions, tool_lookup, memory, Finder, and Codex apply_patch remain available.";
}

export default function codexModeToggle(pi: ExtensionAPI): void {
  const switchMode = async (target: CodexMode, inPlace: boolean, ctx: ExtensionCommandContext) => {
    const previous = mode();
    if (target === previous) {
      updateStatus(ctx);
      ctx.ui.notify(`${describe(target)} Already selected.`, "info");
      return;
    }

    writeConfig(configForCodexMode(readConfig(), target));
    recordSwitch(previous, target, inPlace, ctx);
    ctx.ui.notify(`${describe(target)} ${inPlace ? "Reloading this session." : "Starting a clean session."}`, "info");

    await ctx.waitForIdle();
    if (inPlace) {
      await ctx.reload();
      return;
    }

    const result = await ctx.newSession();
    if (result.cancelled) {
      ctx.ui.notify("Mode saved; new-session switch was cancelled. Reloading in place.", "warning");
      await ctx.reload();
    }
  };

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("session_switch", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));

  pi.registerCommand("codex-mode", {
    description: "Switch between native routed tools and Codex Code Mode",
    getArgumentCompletions: (prefix: string) => ["code", "native", "toggle", "code here", "native here", "toggle here", "status"]
      .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      let parsed = parseCodexModeArgs(args, mode());
      if (parsed.action === "select") {
        const choice = await ctx.ui.select("Codex execution profile", [
          "Native routed tools — new session",
          "Codex Code Mode — new session",
          "Toggle in this session",
          "Show status",
        ]);
        if (!choice) return;
        if (choice === "Show status") parsed = { action: "status" };
        else if (choice === "Toggle in this session") parsed = parseCodexModeArgs("toggle here", mode());
        else parsed = parseCodexModeArgs(choice.startsWith("Codex") ? "code" : "native", mode());
      }

      if (parsed.action === "status") {
        const active = mode();
        pi.sendMessage({
          customType: "codex-mode-status",
          content: `${describe(active)}\nConfig: ${configPath()}\nUse /codex-mode code|native|toggle; add 'here' to keep the current session.`,
          display: true,
        });
        updateStatus(ctx);
        return;
      }
      if (parsed.action === "invalid" || !parsed.mode) {
        ctx.ui.notify("Usage: /codex-mode [code|native|toggle|status] [here]", "error");
        return;
      }
      await switchMode(parsed.mode, parsed.inPlace === true, ctx);
    },
  });
}
