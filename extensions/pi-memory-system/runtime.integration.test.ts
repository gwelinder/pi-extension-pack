import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

function findMemoryPropose(loader: DefaultResourceLoader) {
  const errors = loader.getExtensions().errors;
  expect(errors).toEqual([]);
  for (const extension of loader.getExtensions().extensions) {
    const tool = extension.tools.get("memory_propose");
    if (tool) return tool;
  }
  throw new Error("Reloaded Pi did not register the memory_propose tool.");
}

test("the model-callable memory_propose tool picks up a fresh client across one real reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-reload-"));
  const extension = join(dir, "pi-memory-system");
  const projectDir = join(dir, "project");
  const agentDir = join(dir, "agent");
  const clientPath = join(extension, "bobby-client.ts");
  const requestPath = join(dir, "request.json");
  const argvPath = join(dir, "argv.log");
  const bobbyPath = join(dir, "bobby");
  const oldBin = process.env.BOBBY_BIN;
  const oldRoot = process.env.BOBBY_CANONICAL_MEMORY_ROOT;
  try {
    cpSync(import.meta.dir, extension, { recursive: true, filter: (path) => !path.endsWith(".test.ts") });
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    const freshClient = readFileSync(clientPath, "utf8");
    expect(freshClient).toContain('command: "ops", args: ["canonical-memory-client"]');
    expect(freshClient).not.toMatch(/command:\s*"canonical-memory-client"/);
    const staleClient = freshClient.replaceAll(
      'command: "ops", args: ["canonical-memory-client"]',
      'command: "canonical-memory-client"',
    );
    expect(staleClient).not.toBe(freshClient);
    writeFileSync(clientPath, staleClient);
    writeFileSync(bobbyPath, `#!/bin/sh
printf '%s\\n' "$*" > "${argvPath}"
cat > "${requestPath}"
if [ "$1" = "ops" ] && [ "$2" = "canonical-memory-client" ]; then
  printf '%s\\n' '{"ok":true,"data":{"proposalId":"fresh-pending-123"}}'
else
  printf '%s\\n' '{"ok":false,"error":"expected bobby ops canonical-memory-client"}'
fi
`);
    chmodSync(bobbyPath, 0o755);
    process.env.BOBBY_BIN = bobbyPath;
    process.env.BOBBY_CANONICAL_MEMORY_ROOT = join(dir, "canonical");

    const settings = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
    const loader = new DefaultResourceLoader({
      cwd: projectDir,
      agentDir,
      settingsManager: settings,
      additionalExtensionPaths: [join(extension, "index.ts")],
    });
    await loader.reload();

    const ctx = {
      cwd: projectDir,
      sessionManager: { getSessionId: () => "reload-proof" },
      hasUI: false,
    } as never;
    const params = {
      content: "Owner requires one Bobby canonical-memory command stream without legacy aliases.",
      type: "feedback",
      scope: "project",
    } as never;

    const staleTool = findMemoryPropose(loader);
    const staleResult = await staleTool.definition.execute("stale-call", params, undefined, undefined, ctx);
    expect(staleResult.content[0]?.text).toContain(
      "Bobby unavailable; no canonical mutation was made (expected bobby ops canonical-memory-client).",
    );
    expect((staleResult.details as { pending?: boolean } | undefined)?.pending).toBe(false);

    // Simulate a deploy arriving mid-session, then take the same /reload path a
    // running Pi parent uses (session.reload -> resource loader reload).
    writeFileSync(clientPath, freshClient);
    await loader.reload();

    const freshTool = findMemoryPropose(loader);
    expect(freshTool.definition).not.toBe(staleTool.definition);
    const freshResult = await freshTool.definition.execute("fresh-call", params, undefined, undefined, ctx);
    expect(freshResult.content[0]?.text).toBe("Canonical proposal fresh-pending-123 is pending Bobby review.");
    expect((freshResult.details as { pending?: boolean } | undefined)?.pending).toBe(true);
    expect(readFileSync(argvPath, "utf8").trim().split(/\s+/).slice(0, 2)).toEqual([
      "ops",
      "canonical-memory-client",
    ]);
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
    if (oldBin === undefined) delete process.env.BOBBY_BIN;
    else process.env.BOBBY_BIN = oldBin;
    if (oldRoot === undefined) delete process.env.BOBBY_CANONICAL_MEMORY_ROOT;
    else process.env.BOBBY_CANONICAL_MEMORY_ROOT = oldRoot;
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
