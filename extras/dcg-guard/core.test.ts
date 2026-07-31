import assert from "node:assert/strict";
import test from "node:test";
import { extractCodeModeCommands, runDcg } from "./core.ts";

test("extracts literal Code Mode commands", () => {
  assert.deepEqual(
    extractCodeModeCommands(`
      const first = await tools.exec_command({cmd: "git status", workdir: "/tmp"});
      const second = await tools.process({action: "start", command: "pnpm test"});
    `),
    [
      { toolName: "exec_command", command: "git status", dynamic: false },
      { toolName: "process", command: "pnpm test", dynamic: false },
    ],
  );
});

test("supports bracket notation and ignores non-start process actions", () => {
  assert.deepEqual(
    extractCodeModeCommands(`
      await tools["exec_command"]({cmd: "git diff"});
      await tools.process({action: "poll", session_id: 12});
    `),
    [{ toolName: "exec_command", command: "git diff", dynamic: false }],
  );
});

test("blocks dynamic command construction", () => {
  assert.deepEqual(
    extractCodeModeCommands(`await tools.exec_command({cmd: buildCommand()})`),
    [{ toolName: "exec_command", dynamic: true, reason: "cmd is not a static string" }],
  );
  assert.deepEqual(
    extractCodeModeCommands("await tools.process(options)"),
    [{ toolName: "process", dynamic: true, reason: "command tool arguments are not a literal object" }],
  );
  assert.deepEqual(
    extractCodeModeCommands("const run = tools.exec_command; await run({cmd: 'git status'})"),
    [{ toolName: "exec_command", dynamic: true, reason: "exec_command is referenced indirectly" }],
  );
  assert.deepEqual(
    extractCodeModeCommands("const { exec_command } = tools; await exec_command({cmd: 'git status'})"),
    [{ toolName: "exec_command", dynamic: true, reason: "the Code Mode tools object is used indirectly" }],
  );
});

test("does not treat strings, comments, templates, or regexes as tool calls", () => {
  assert.deepEqual(
    extractCodeModeCommands(`
      "tools.exec_command({cmd: 'rm -rf /'})";
      // tools.exec_command({cmd: "rm -rf /"})
      /* tools.process({action: "start", command: "rm -rf /"}) */
      const template = \`tools.exec_command({cmd: "rm -rf /"})\`;
      const pattern = /tools\\.exec_command/;
    `),
    [],
  );
});

test("decodes escaped literal commands before evaluation", () => {
  assert.deepEqual(
    extractCodeModeCommands(`await tools.exec_command({cmd: "printf 'a\\n'"})`),
    [{ toolName: "exec_command", command: "printf 'a\n'", dynamic: false }],
  );
});

test("DCG allows a safe command and denies a destructive one", () => {
  assert.equal(runDcg("git status").allow, true);
  const denied = runDcg("rm -rf /");
  assert.equal(denied.allow, false);
  assert.equal(denied.ruleId, "core.filesystem:rm-rf-root-home");
});
