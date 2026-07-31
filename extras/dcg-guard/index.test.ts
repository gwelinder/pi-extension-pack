import assert from "node:assert/strict";
import test from "node:test";
import dcgGuard from "./index.ts";

function harness() {
  let handler: ((event: { toolName: string; input: Record<string, unknown> }) => unknown) | undefined;
  const commands = new Map<string, unknown>();
  dcgGuard({
    on(event: string, callback: typeof handler) {
      if (event === "tool_call") handler = callback;
    },
    registerCommand(name: string, definition: unknown) {
      commands.set(name, definition);
    },
  } as never);
  assert.ok(handler);
  return { handler, commands };
}

test("allows a safe direct command and registers status", () => {
  const { handler, commands } = harness();
  assert.equal(handler({ toolName: "bash", input: { command: "git status" } }), undefined);
  assert.ok(commands.has("dcg-status"));
});

test("blocks a destructive direct command", () => {
  const { handler } = harness();
  const result = handler({ toolName: "exec_command", input: { cmd: "rm -rf /" } }) as {
    block: boolean;
    reason: string;
  };
  assert.equal(result.block, true);
  assert.match(result.reason, /core\.filesystem:rm-rf-root-home/);
});

test("guards nested Code Mode commands and fails closed on dynamic input", () => {
  const { handler } = harness();
  assert.equal(
    handler({ toolName: "exec", input: { code: "await tools.exec_command({cmd: 'git diff'})" } }),
    undefined,
  );
  const result = handler({
    toolName: "exec",
    input: { code: "await tools.exec_command({cmd: buildCommand()})" },
  });
  assert.deepEqual(result, {
    block: true,
    reason: "[dcg-guard] blocked a dynamic exec_command call in Code Mode: cmd is not a static string. Use a static string literal so DCG can inspect it.",
  });
});
