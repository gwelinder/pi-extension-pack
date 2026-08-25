import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  LatestSingleFlightQueue,
  ambientBudgetChars,
  buildExplicitProposal,
  buildDeprecateProposal,
  buildInferredProposal,
  hasDurableSignal,
  hydrateCanonicalMemory,
  isAgentSafeCanonical,
  parseBobbyManifest,
  parseNativeMemory,
  rankRelevantMemories,
  selectRelevantMemoryNotes,
  validateExtractionJson,
} from "./core.ts";
import { BobbyClient, buildBobbyInvocation, getBobbyConfig } from "./bobby-client.ts";

const canonical = (overrides: Record<string, unknown> = {}) => ({
  id: "canon-preferences",
  status: "active",
  agentSafe: true,
  name: "Preferred validation",
  description: "Run focused validation after non-trivial changes",
  type: "feedback",
  scope: "project",
  body: "Run focused validation after non-trivial changes.",
  ...overrides,
});

describe("Bobby sidecar parsing and recall", () => {
  test("parses an inline manifest and tolerates its absent records array", () => {
    const parsed = parseBobbyManifest({ canonicalMemoryRoot: "/tmp/bobby", records: [canonical()] });
    expect(parsed?.canonicalMemoryRoot).toBe("/tmp/bobby");
    expect(parsed?.records[0]?.id).toBe("canon-preferences");
    expect(parseBobbyManifest({ canonicalMemoryRoot: "/tmp/bobby" })?.records).toEqual([]);
    expect(parseBobbyManifest({ records: "bad" })).toBeNull();
  });

  test("parses and hydrates Bobby's real manifest/frontmatter schema", () => {
    const manifest = parseBobbyManifest({
      schema_version: "bobby.canonical-memory-manifest.v1",
      records: [{
        id: "mem_validation_12345678",
        title: "Preferred validation",
        kind: "preference",
        scope: "project:repo-abc12345",
        status: "active",
        sensitivity: "agent_safe",
        path: "/tmp/memory/records/mem_validation_12345678.md",
      }],
    })!;
    const hydrated = hydrateCanonicalMemory(manifest.records[0]!, `---\nid: "mem_validation_12345678"\ntitle: "Preferred validation"\nkind: "preference"\nscope: "project:repo-abc12345"\nstatus: "active"\nsummary: "Run focused validation"\nsensitivity: "agent_safe"\nevidence:\n  - sourceType: "pi_explicit"\n    uri: "file:///memory/native.md"\n---\n\n# Preferred validation\n\nRun focused validation.`);
    expect(hydrated).toMatchObject({ type: "feedback", scope: "project", projectId: "repo-abc12345", active: true, agentSafe: true });
    expect(hydrated.sourceUris).toEqual(["file:///memory/native.md"]);
  });

  test("manifest-less fallback derives superseded and private safety fields from frontmatter", () => {
    const fallback = parseBobbyManifest({ records: [{ id: "mem_old_12345678", path: "records/mem_old_12345678.md" }] })!;
    const hydrated = hydrateCanonicalMemory(fallback.records[0]!, `---\ntitle: "Old rule"\nkind: "preference"\nscope: "private"\nstatus: "superseded"\nsummary: "Do not recall"\nsensitivity: "bobby_only"\n---\n\n# Old rule\n\nDo not recall.`);
    expect(hydrated).toMatchObject({ active: false, agentSafe: false, scope: "private", sensitivity: "bobby_only" });
    expect(isAgentSafeCanonical(hydrated)).toBe(false);
  });

  test("canonical active record suppresses a duplicate native edge-cache record", () => {
    const native = parseNativeMemory("/memory/native.md", "---\nname: Preferred validation\ndescription: Run focused validation after non-trivial changes\ntype: feedback\nscope: private\n---\nRun focused validation after non-trivial changes.");
    const manifest = parseBobbyManifest({ records: [canonical()] })!;
    const ranked = rankRelevantMemories([native], manifest.records, "Please run focused validation");
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.source).toBe("canonical");
  });

  test("generic prompts recall nothing and total injected text is bounded", () => {
    const manifest = parseBobbyManifest({ records: [canonical({ body: "validation ".repeat(400) })] })!;
    expect(selectRelevantMemoryNotes([], manifest.records, "hello can you help")).toEqual([]);
    const incidental = parseBobbyManifest({ records: [canonical({ name: "Unrelated preference", description: "A different rule", body: "This body happens to mention hello once." })] })!;
    expect(selectRelevantMemoryNotes([], incidental.records, "say hello")).toEqual([]);
    const notes = selectRelevantMemoryNotes([], manifest.records, "focused validation");
    expect(notes).toHaveLength(1);
    expect(notes.join("\n").length).toBeLessThanOrEqual(1200);
  });

  test("private native and non-agent canonical records never enter recall", () => {
    const manifest = parseBobbyManifest({
      records: [
        canonical({ id: "private", scope: "private" }),
        canonical({ id: "unsafe", agentSafe: false }),
        canonical({ id: "inactive", status: "deprecated" }),
      ],
    })!;
    const nativePrivate = parseNativeMemory("/memory/private.md", "---\nname: Private detail\ndescription: focused validation detail\ntype: feedback\nscope: private\n---\nfocused validation detail");
    expect(rankRelevantMemories([nativePrivate], manifest.records, "focused validation")).toEqual([]);
  });

  test("project records stay isolated and inactive canonical source tombstones suppress native cache copies", () => {
    const native = parseNativeMemory("/memory/old.md", "---\nname: Old rule\ndescription: Run old validation\ntype: feedback\nscope: project\n---\nRun old validation.");
    const manifest = parseBobbyManifest({ records: [
      canonical({ id: "alpha", scope: "project:alpha", sensitivity: "agent_safe", agentSafe: undefined }),
      canonical({ id: "old", status: "superseded", scope: "project:alpha", sourceUris: ["file:///memory/old.md"] }),
    ] })!;
    expect(rankRelevantMemories([native], manifest.records, "focused validation", "beta")).toEqual([]);
    expect(rankRelevantMemories([native], manifest.records, "old validation", "alpha").some((record) => record.source === "native")).toBe(false);
  });
});

describe("proposals and extraction validation", () => {
  test("builds explicit proposal payload and central Bobby invocation", () => {
    const proposal = buildExplicitProposal({
      name: "feedback-validation",
      description: "Run focused validation",
      type: "feedback",
      scope: "project",
      body: "Run focused validation after non-trivial changes.",
    });
    expect(proposal).toMatchObject({ proposalType: "create", provenance: { source: "pi-explicit" }, record: { scope: "project" } });
    const config = getBobbyConfig({ BOBBY_CANONICAL_MEMORY_ROOT: "/tmp/canonical" } as NodeJS.ProcessEnv);
    expect(buildBobbyInvocation(config, "propose")).toEqual({
      file: join(homedir(), ".local", "bin", "bobby"),
      args: ["ops", "canonical-memory-client", "--root", "/tmp/canonical"],
    });
    expect(buildInferredProposal({
      name: "inferred-validation",
      description: "Candidate from a durable session signal",
      type: "feedback",
      scope: "project",
      body: "Prefer focused validation.",
    }).provenance.source).toBe("pi-inferred");
    expect(buildDeprecateProposal("mem-123")?.proposalType).toBe("deprecate");
  });

  test("maps structured proposal success and error responses through the authoritative argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-memory-bobby-"));
    const makeBobby = (name: string, response: string) => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1" != "ops" ] || [ "$2" != "canonical-memory-client" ] || [ "$3" != "--root" ] || [ "$4" != "/tmp/canonical" ]; then
  printf '%s\\n' '{"ok":false,"error":"unexpected argv"}'
  exit 0
fi
request=$(cat)
case "$request" in
  *'"operation":"propose"'*) printf '%s\\n' '${response}' ;;
  *) printf '%s\\n' '{"ok":false,"error":"unexpected operation"}' ;;
esac
`);
      chmodSync(path, 0o755);
      return path;
    };
    const proposal = buildExplicitProposal({
      name: "feedback-validation",
      description: "Run focused validation",
      type: "feedback",
      scope: "project",
      body: "Run focused validation after non-trivial changes.",
    });
    try {
      const success = new BobbyClient(getBobbyConfig({
        BOBBY_BIN: makeBobby("success", '{"ok":true,"data":{"proposalId":"proposal-123"}}'),
        BOBBY_CANONICAL_MEMORY_ROOT: "/tmp/canonical",
      } as NodeJS.ProcessEnv));
      const failure = new BobbyClient(getBobbyConfig({
        BOBBY_BIN: makeBobby("failure", '{"ok":false,"error":"proposal rejected by Bobby"}'),
        BOBBY_CANONICAL_MEMORY_ROOT: "/tmp/canonical",
      } as NodeJS.ProcessEnv));

      expect(await success.propose(proposal)).toEqual({ ok: true, proposalId: "proposal-123" });
      expect(await failure.propose(proposal)).toEqual({ ok: false, error: "proposal rejected by Bobby" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prefilters durable signals and validates bounded extraction JSON", () => {
    expect(hasDurableSignal("Please remember that I prefer focused tests.", "I will use focused tests.")).toBe(true);
    expect(hasDurableSignal("Correction: focused tests are the standing preference.", "Understood.")).toBe(true);
    expect(hasDurableSignal("hello", "Hi there")).toBe(false);
    expect(hasDurableSignal("Can you always explain this?", "Sure.")).toBe(false);
    expect(validateExtractionJson(JSON.stringify({ candidates: [{
      name: "focused-tests",
      description: "User prefers focused tests",
      type: "feedback",
      scope: "project",
      body: "Prefer focused tests before broad validation.",
    }] }))).toHaveLength(1);
    expect(validateExtractionJson("not json")).toBeNull();
    expect(validateExtractionJson(JSON.stringify({ candidates: [{
      name: "secret",
      description: "secret",
      type: "reference",
      scope: "project",
      body: "api_key=abcdefghijklmnopqrstuvwxyz012345",
    }] }))).toBeNull();
  });

  test("ambient capsule keeps the proven character default and a direct bounded character seam", () => {
    expect(ambientBudgetChars(undefined)).toBe(1_200);
    expect(ambientBudgetChars("2400")).toBe(2_400);
    expect(ambientBudgetChars("100000")).toBe(8_000);
    expect(ambientBudgetChars("not-a-number")).toBe(1_200);
  });
});

test("latest single-flight queue keeps only one latest pending job", async () => {
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const queue = new LatestSingleFlightQueue<string>(async (job) => {
    calls.push(job);
    if (job === "first") await new Promise<void>((resolve) => { releaseFirst = resolve; });
  }, 0);
  queue.enqueue("first");
  await Bun.sleep(5);
  queue.enqueue("second");
  queue.enqueue("latest");
  releaseFirst?.();
  await Bun.sleep(15);
  expect(calls).toEqual(["first", "latest"]);
  queue.shutdown();
});

test("extension source has no synthetic user-message extraction path", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const clientSource = readFileSync(join(import.meta.dir, "bobby-client.ts"), "utf8");
  expect(source).not.toMatch(/sendUserMessage/);
  expect(source).not.toMatch(/followUp/);
  expect(source).toMatch(/name: "memory_query"/);
  expect(source).toMatch(/name: "memory_context"/);
  expect(source).toMatch(/name: "memory_propose"/);
  expect(source).not.toMatch(/name: "memory"/);
  expect(source).not.toMatch(/canonical-memory-mcp|runCanonicalMemoryMcpServer/i);
  expect(clientSource).not.toMatch(/acceptAndApply|proposal-update|proposal-apply|EXPLICIT_APPLY/);
  expect(clientSource).not.toMatch(/command:\s*"canonical-memory-client"/);
});
