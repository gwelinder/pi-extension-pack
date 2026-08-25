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
    "ps -axo pid,lstart,command | rg --fixed-strings -- '--user-data-dir=/Users/gfw/.dev-browser/browsers/'",
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

test("blocks broad roots in compound rg commands", () => {
  for (const command of [
    "if true; then :; else rg PATTERN /Users/gfw; fi",
    "{ rg PATTERN /Users/gfw; }",
    "if true; then rg PATTERN /Users/gfw; fi",
    "(rg PATTERN /Users/gfw)",
  ]) {
    expect(runToolCall(command)).toMatchObject({ block: true });
  }
});

test("allows only bounded, statically parsed frog list output inspection", () => {
  for (const command of [
    "frog list | head -80",
    "frog list --state pending --since main --cwd /tmp | tail -n 80",
    "FROG_COLOR=0 env FROG_CONFIG=/tmp/frog command frog list -S main --cwd . | head --lines=0",
    "env -u FROG_CONFIG frog list --cwd . | command head -80",
    "env -C /tmp frog list --state pending | env tail -n 80",
    "command env -u FROG_CONFIG frog list --cwd . | command env head -80",
    "command env -C /tmp frog list --state pending | command env tail -n 80",
  ]) {
    expect(runToolCall(command)).toBeUndefined();
  }
});

test("blocks unsafe output truncation despite a frog command name", () => {
  for (const command of [
    "pnpm test | tail -80",
    "pnpm test | env tail -80",
    "frog log --title repro --body details | head -80",
    "frog publish | command head -80",
    "frog resolve 20260826012708 | tail -80",
    "frog publish | head -80",
    "frog sync | tail -80",
    "frog list | head -80 | frog log --title repro --body details",
    "frog list | command head -80 | frog log --title repro --body details",
    "frog list | tail -n +1",
    "frog unknown-command | head -80",
    "frog $FROG_SUBCOMMAND | head -80",
    "frog $FROG_SUBCOMMAND | command head -80",
    "$FROG_BIN list | head -80",
    "env -u FROG_CONFIG frog publish | head -80",
    "env -C /tmp frog unknown-command | tail -80",
    "env --split-string='frog publish' | head -80",
    "command env -u FROG_CONFIG frog publish | head -80",
    "command env -C /tmp frog unknown-command | tail -80",
    "command env pnpm test | command tail -80",
    "frog publish | head -80; true",
    "frog $FROG_SUBCOMMAND | command head -80; echo done",
    "pnpm test | env tail -80 && echo done",
    "frog publish | command head -80 || true",
    "frog publish | command head -80 > /tmp/frog-output",
    "{ frog publish | command head -80; }",
    "frog publish | (command head -80)",
  ]) {
    expect(runToolCall(command)).toMatchObject({ block: true });
  }
});

test("scopes JSONL protections to the rg command segment", () => {
  expect(runToolCall(
    `python3 -c 'print("/tmp/audit.jsonl")'; ps -axo pid,lstart,command | rg "Google Chrome|playwriter|dev-browser|node.*daemon|chromium" | head -80`,
  )).toBeUndefined();

  expect(runToolCall(
    `python3 -c 'print("inventory")'; rg error /tmp/audit.jsonl | head -80`,
  )).toMatchObject({ block: true });

  expect(runToolCall(
    `printf session; rg error /Users/gfw/.pi/agent/sessions/run.jsonl`,
  )).toMatchObject({ block: true });

  for (const command of [
    "env rg error /tmp/audit.jsonl",
    "command rg error /tmp/audit.jsonl",
    "RG_CONFIG_PATH=/tmp/rg.conf rg error /tmp/audit.jsonl",
    "env rg error /Users/gfw/.pi/agent/sessions/run.jsonl",
  ]) {
    expect(runToolCall(command)).toMatchObject({ block: true });
  }
});
