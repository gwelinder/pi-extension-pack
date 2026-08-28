import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-bash-fixer-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_HARNESS_TELEMETRY = "0";

let bashFixer: (pi: unknown) => void;

beforeAll(async () => {
  mock.module("@earendil-works/pi-coding-agent", () => ({
    ...codingAgent,
    isBashToolResult: (event: { toolName: string }) => event.toolName === "bash",
    isToolCallEventType: (toolName: string, event: { toolName: string }) => event.toolName === toolName,
  }));
  ({ default: bashFixer } = await import("./index"));
});

function runToolCall(command: string, activeTools: string[] = ["bash"]) {
  return runToolCallWithEvent(command, activeTools).result;
}

function runToolCallWithEvent(command: string, activeTools: string[] = ["bash"]) {
  let toolCallHandler: ((event: any, ctx: any) => unknown) | undefined;
  bashFixer({
    getActiveTools() {
      return activeTools;
    },
    on(eventName: string, handler: (event: any, ctx: any) => unknown) {
      if (eventName === "tool_call") toolCallHandler = handler;
    },
  } as never);

  const event = { toolName: "bash", input: { command } };
  return { result: toolCallHandler!(event, { cwd: process.cwd() }), event };
}

afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

test("allows one static delayed handoff read only when no process tool is active", () => {
  const repro = "sleep 30; test -f /tmp/handoff && stat /tmp/handoff";

  expect(runToolCall(repro, ["bash", "read"])).toBeUndefined();

  const blocked = runToolCall(repro, ["bash", "process"]);
  expect(blocked).toMatchObject({ block: true });
  expect((blocked as { reason: string }).reason).toContain("process.start");
});

test("recognizes true process tool namespace variants only", () => {
  const repro = "sleep 30; test -f /tmp/handoff && stat /tmp/handoff";

  for (const processTool of [
    "process",
    "process.start",
    "functions.process",
    "mcp__process__start",
    "process_start",
  ]) {
    expect(runToolCall(repro, ["bash", processTool])).toMatchObject({ block: true });
  }

  for (const unrelatedTool of [
    "postprocess",
    "process-fixer",
    "process_helper",
    "process.output",
    "mcp__process__logs",
  ]) {
    expect(runToolCall(repro, ["bash", unrelatedTool])).toBeUndefined();
  }
});

test("allows chained visible delayed reads without imposing a sleep duration cap", () => {
  for (const command of [
    "sleep 45; test -f /tmp/handoff && stat /tmp/handoff && wc -c /tmp/handoff",
    "sleep 2d\n[ -r '/tmp/agent handoff' ] && cat '/tmp/agent handoff'",
  ]) {
    expect(runToolCall(command)).toBeUndefined();
  }
});

test("blocks delayed checks with dynamic sleeps, loops, retries, or backgrounding", () => {
  for (const command of [
    "sleep $DELAY; test -f /tmp/handoff && stat /tmp/handoff",
    "sleep \"$DELAY\"; test -f /tmp/handoff && stat /tmp/handoff",
    "sleep $(cat /tmp/delay); test -f /tmp/handoff && stat /tmp/handoff",
    "while test ! -f /tmp/handoff; do sleep 30; done; stat /tmp/handoff",
    "for delay in 30; do sleep $delay; stat /tmp/handoff; done",
    "sleep 30; test -f /tmp/handoff || sleep 30; stat /tmp/handoff",
    "sleep 30 & stat /tmp/handoff",
  ]) {
    expect(runToolCall(command)).toMatchObject({ block: true });
  }
});

test("blocks mutations around a delayed read", () => {
  for (const command of [
    "touch /tmp/handoff; sleep 30; stat /tmp/handoff",
    "sleep 30; touch /tmp/handoff; stat /tmp/handoff",
    "sleep 30; stat /tmp/handoff; rm /tmp/handoff",
  ]) {
    expect(runToolCall(command)).toMatchObject({ block: true });
  }
});

test("requires visible delayed-read output and rejects redirection or pipelines", () => {
  for (const command of [
    "sleep 30; test -f /tmp/handoff",
    "sleep 30; test -f /tmp/handoff && stat /tmp/handoff >/dev/null",
    "sleep 30; test -f /tmp/handoff && stat /tmp/handoff 2>&1",
    "sleep 30; test -f /tmp/handoff && stat /tmp/handoff | head -1",
  ]) {
    expect(runToolCall(command)).toMatchObject({ block: true });
  }
});

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

test("blocks mixed session-log commands without executing or dropping statements", () => {
  for (const operator of [";", "&&", "||", "\n"]) {
    const command = `wc -l file ${operator} rg PATTERN ~/.pi/agent/sessions --glob '*.jsonl'`;
    const { result, event } = runToolCallWithEvent(command);
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("wc -l file");
    expect((result as { reason: string }).reason).toContain("No part of this compound command was executed");
    expect(event.input.command).toBe(command);
  }

  const unsafeFirst = "rg PATTERN ~/.pi/agent/sessions --glob '*.jsonl'; wc -l file";
  const { result, event } = runToolCallWithEvent(unsafeFirst);
  expect(result).toMatchObject({ block: true });
  expect((result as { reason: string }).reason).toContain("No part of this compound command was executed");
  expect((result as { reason: string }).reason).not.toContain("Run the safe inspection separately");
  expect(event.input.command).toBe(unsafeFirst);
});

test("uses shell syntax and argv semantics for metacharacters and tmux capture-pane", () => {
  for (const command of [
    "printf '%s\\n' 'rg PATTERN ~/.pi/agent/sessions'",
    "printf '%s\\n' \"tmux capture-pane -t session -p | head -80\"",
    "echo 'rg PATTERN /tmp/audit.jsonl'",
    "tmux capture-pane -t session -p",
    "tmux capture-pane -t session -p | head -80",
  ]) {
    expect(runToolCall(command)).toBeUndefined();
  }

  for (const command of [
    "tmux capture-pane -t session -p | rg PATTERN ~/.pi/agent/sessions",
    "printf ok; rg PATTERN ~/.pi/agent/sessions",
  ]) {
    expect(runToolCall(command)).toMatchObject({ block: true });
  }
});

test("does not execute a mutation before a blocked inspection", () => {
  const command = "frog log --title should-not-run --body details; rg PATTERN ~/.pi/agent/sessions";
  const { result, event } = runToolCallWithEvent(command);
  expect(result).toMatchObject({ block: true });
  expect((result as { reason: string }).reason).not.toContain("Run the safe inspection separately");
  expect(event.input.command).toBe(command);
});

test("reports only statically proven read-only git and tmux prefixes", () => {
  for (const command of [
    "git status --short; rg PATTERN ~/.pi/agent/sessions",
    "git diff --stat; rg PATTERN ~/.pi/agent/sessions",
    "git log -1 --oneline; rg PATTERN ~/.pi/agent/sessions",
    "tmux capture-pane -t session -p; rg PATTERN ~/.pi/agent/sessions",
    "tmux capture-pane -pJ -t session; rg PATTERN ~/.pi/agent/sessions",
    "tmux list-sessions; rg PATTERN ~/.pi/agent/sessions",
  ]) {
    const { result } = runToolCallWithEvent(command);
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("Run the safe inspection separately");
    expect((result as { reason: string }).reason).toContain(command.split(";")[0]!);
  }

  for (const command of [
    "git reset --hard; rg PATTERN ~/.pi/agent/sessions",
    "git branch new-name; rg PATTERN ~/.pi/agent/sessions",
    "tmux kill-session -t work; rg PATTERN ~/.pi/agent/sessions",
    "tmux capture-pane -t session; rg PATTERN ~/.pi/agent/sessions",
    "tmux capture-pane -p -b named; rg PATTERN ~/.pi/agent/sessions",
    "tmux capture-pane -bp named; rg PATTERN ~/.pi/agent/sessions",
    "tmux capture-pane -bt session; rg PATTERN ~/.pi/agent/sessions",
    "git status `printf dynamic`; rg PATTERN ~/.pi/agent/sessions",
    "tmux capture-pane -t session -p `printf dynamic`; rg PATTERN ~/.pi/agent/sessions",
    "git status $DYNAMIC; rg PATTERN ~/.pi/agent/sessions",
  ]) {
    const { result } = runToolCallWithEvent(command);
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).not.toContain("Run the safe inspection separately");
    expect((result as { reason: string }).reason).toContain("No part of this compound command was executed");
  }
});
