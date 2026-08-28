import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { expect, test } from "bun:test";

type RpcEvent = Record<string, unknown>;

async function runMemoryCommand(
  extension: string,
  env: NodeJS.ProcessEnv,
  beforePrompt?: () => void,
): Promise<{ commands: Array<{ name: string }>; notice: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", join(extension, "index.ts")], {
      cwd: resolve(import.meta.dir, "../.."),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let requestId = 0;
    let commands: Array<{ name: string }> = [];
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(error);
    };
    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ id: `probe-${++requestId}`, ...message })}\n`);
    };

    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", fail);
    child.on("exit", (code) => {
      if (!settled) fail(new Error(`Pi exited ${code}: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: RpcEvent;
        try { event = JSON.parse(line) as RpcEvent; } catch { continue; }
        if (event.type === "response" && event.command === "get_commands" && event.success === true) {
          const data = event.data as { commands?: Array<{ name: string }> };
          commands = data.commands || [];
          if (!commands.some((command) => command.name === "remember")) {
            fail(new Error("Fresh Pi did not register /remember."));
            return;
          }
          beforePrompt?.();
          send({ type: "prompt", message: "/remember feedback user :: Owner requires one Bobby canonical-memory command stream without legacy aliases or compatibility fallbacks." });
        }
        if (event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string") {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          resolvePromise({ commands, notice: event.message });
          return;
        }
      }
    });
    send({ type: "get_commands" });
  });
}

test("a running Pi holds its old memory client until a fresh registration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-runtime-"));
  const extension = join(dir, "pi-memory-system");
  const clientPath = join(extension, "bobby-client.ts");
  const requestPath = join(dir, "request.json");
  const bobbyPath = join(dir, "bobby");
  try {
    cpSync(import.meta.dir, extension, { recursive: true, filter: (path) => !path.endsWith(".test.ts") });
    const freshClient = readFileSync(clientPath, "utf8");
    const staleClient = freshClient.replaceAll(
      'command: "ops", args: ["canonical-memory-client"]',
      'command: "canonical-memory-client"',
    );
    expect(staleClient).not.toBe(freshClient);
    writeFileSync(clientPath, staleClient);
    writeFileSync(bobbyPath, `#!/bin/sh
cat > "${requestPath}"
if [ "$1" = "ops" ] && [ "$2" = "canonical-memory-client" ]; then
  printf '%s\\n' '{"ok":true,"data":{"proposalId":"fresh-pending-123"}}'
else
  printf '%s\\n' '{"ok":false,"error":"expected bobby ops canonical-memory-client"}'
fi
`);
    chmodSync(bobbyPath, 0o755);
    const env = {
      ...process.env,
      BOBBY_BIN: bobbyPath,
      BOBBY_CANONICAL_MEMORY_ROOT: join(dir, "canonical"),
    };

    const stale = await runMemoryCommand(extension, env, () => writeFileSync(clientPath, freshClient));
    expect(stale.commands.map((command) => command.name)).toContain("remember");
    expect(stale.notice).toContain("Bobby unavailable; no canonical mutation was made (expected bobby ops canonical-memory-client).");

    const fresh = await runMemoryCommand(extension, env);
    expect(fresh.notice).toBe("Canonical proposal fresh-pending-123 is pending Bobby review.");
    expect(JSON.parse(readFileSync(requestPath, "utf8"))).toMatchObject({
      operation: "propose",
      payload: {
        consumer: "pi",
        proposal: {
          proposalType: "create",
          provenance: { source: "pi-explicit" },
        },
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
