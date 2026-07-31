import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { extractCodeModeCommands, runDcg, type CommandCandidate } from "./core.ts";

function block(reason: string): ToolCallEventResult {
  return { block: true, reason: `[dcg-guard] ${reason}` };
}

function directCandidate(toolName: string, input: Record<string, unknown>): CommandCandidate[] {
  if (toolName === "bash" && typeof input.command === "string") {
    return [{ toolName: "bash", command: input.command, dynamic: false }];
  }
  if (toolName === "exec_command" && typeof input.cmd === "string") {
    return [{ toolName: "exec_command", command: input.cmd, dynamic: false }];
  }
  if (toolName === "process" && input.action === "start" && typeof input.command === "string") {
    return [{ toolName: "process", command: input.command, dynamic: false }];
  }
  if (toolName === "exec" && typeof input.code === "string") {
    return extractCodeModeCommands(input.code);
  }
  return [];
}

export default function dcgGuard(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    const candidates = directCandidate(event.toolName, event.input as Record<string, unknown>);
    for (const candidate of candidates) {
      if (candidate.dynamic || candidate.command === undefined) {
        return block(`blocked a dynamic ${candidate.toolName} call in Code Mode: ${candidate.reason || "command could not be inspected"}. Use a static string literal so DCG can inspect it.`);
      }
      const decision = runDcg(candidate.command);
      if (!decision.allow) {
        const rule = decision.ruleId ? ` (${decision.ruleId})` : "";
        return block(`${decision.reason || "command denied"}${rule}`);
      }
    }
    return undefined;
  });

  pi.registerCommand("dcg-status", {
    description: "Show the DCG version used by Pi command guards",
    handler: async (_args, ctx) => {
      const executable = process.env.DCG_BIN?.trim() || "dcg";
      const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 1500 });
      const message = result.status === 0
        ? `DCG guard active: ${(result.stdout || "").trim()}`
        : "DCG guard is loaded, but the dcg executable is unavailable. Command execution will fail closed.";
      if (ctx.hasUI) ctx.ui.notify(message, result.status === 0 ? "info" : "warning");
    },
  });
}
