import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-bash-fixer-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_HARNESS_TELEMETRY = "0";

let bashFixer: (pi: unknown) => void;

beforeAll(async () => {
  mock.module("@earendil-works/pi-coding-agent", () => ({
    isBashToolResult: (event: { toolName: string }) => event.toolName === "bash",
    isToolCallEventType: (toolName: string, event: { toolName: string }) => event.toolName === toolName,
  }));
  ({ default: bashFixer } = await import("./index"));
});

function runToolCall(command: string) {
  let toolCallHandler: ((event: any, ctx: any) => unknown) | undefined;
  bashFixer({
    on(eventName: string, handler: (event: any, ctx: any) => unknown) {
      if (eventName === "tool_call") toolCallHandler = handler;
    },
  } as never);

  const event = { toolName: "bash", input: { command } };
  return toolCallHandler!(event, { cwd: process.cwd() });
}

afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

test("allows stdin-only rg filters while blocking broad rg path operands", () => {
  for (const command of [
    "ps -axo pid,lstart,command | rg -F '/Users/gfw/.herdr/worktrees'",
    "lsof -nP | rg --fixed-strings /Users/gfw | awk '{print $1}'",
    "rg -F /Users/gfw",
  ]) {
    expect(runToolCall(command)).toBeUndefined();
  }

  for (const command of [
    "rg -F PATTERN ~",
    "rg --fixed-strings PATTERN /Users/gfw",
    "rg --glob '*.ts' -F PATTERN /Users/gfw",
    "rg -e PATTERN /Users/gfw",
    "ps -axo pid,lstart,command | rg -F PATTERN /Users/gfw",
    "rg -F PATTERN /",
  ]) {
    expect(runToolCall(command)).toMatchObject({ block: true });
  }
});
