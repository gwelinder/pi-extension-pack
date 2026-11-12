#!/usr/bin/env node
// Concurrency-safe deploy for the pi-memory-system extension.
//
// Swap strategy: stage the new tree in a unique temp dir on the same
// filesystem, verify it, then move the live tree aside to a *unique* backup
// dir (never a fixed `.previous` path, so concurrent deploys cannot clobber
// each other's rollback) and rename the staged tree into place. The two
// renames run back-to-back and the backup is only removed after the new tree
// verifies, so a failed swap restores the previous tree instead of leaving a
// missing active path. A lock dir serializes concurrent deploys.
//
// Restart contract: a new Pi process loads the deployed extension at startup;
// every already-running Pi parent must take `/reload` to re-register it. Tool
// calls already running during `/reload` continue in the old extension frame,
// so invoke `memory_propose` only after that call returns.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "..", "extensions", "pi-memory-system");
const target = join(homedir(), ".pi", "agent", "extensions", "pi-memory-system");
const parent = dirname(target);
const lockDir = join(parent, ".pi-memory-system-deploy.lock");

const REQUIRED_FILES = ["index.ts", "bobby-client.ts", "core.ts", "extraction-runner.ts"];
const SINGLE_STREAM_MARKER = 'command: "ops", args: ["canonical-memory-client"]';
const LEGACY_ALIAS_PATTERN = /command:\s*"canonical-memory-client"/;

function uniqueSuffix() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function acquireLock() {
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // A previous deploy that was hard-killed can leave a stale lock behind.
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > 5 * 60_000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock vanished mid-check; retry immediately.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Another pi-memory-system deploy holds ${lockDir}; retry when it finishes.`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function releaseLock() {
  rmSync(lockDir, { recursive: true, force: true });
}

function findTestFiles(dir, depth = 0) {
  if (depth > 4) return [];
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) hits.push(...findTestFiles(path, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) hits.push(path);
  }
  return hits;
}

function verifyStagedTree(stagedExtension) {
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(stagedExtension, file))) {
      throw new Error(`Staged extension is missing required file ${file}; refusing to swap.`);
    }
  }
  const stagedTests = findTestFiles(stagedExtension);
  if (stagedTests.length > 0) {
    throw new Error(`Staged extension contains test files (${stagedTests[0]}); refusing to swap.`);
  }
  const client = readFileSync(join(stagedExtension, "bobby-client.ts"), "utf8");
  if (!client.includes(SINGLE_STREAM_MARKER)) {
    throw new Error("Staged bobby-client.ts does not use the single supported `bobby ops canonical-memory-client` stream; refusing to swap.");
  }
  if (LEGACY_ALIAS_PATTERN.test(client)) {
    throw new Error("Staged bobby-client.ts contains a legacy `canonical-memory-client` command alias; refusing to swap.");
  }
}

function verifyLiveTree() {
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(target, file))) {
      throw new Error(`Deployed extension is missing ${file} after the swap.`);
    }
  }
}

mkdirSync(parent, { recursive: true });
acquireLock();
const stage = mkdtempSync(join(parent, ".pi-memory-system-stage-"));
const stagedExtension = join(stage, "pi-memory-system");
const backup = join(parent, `.pi-memory-system-backup-${uniqueSuffix()}`);
let movedLiveAside = false;
try {
  cpSync(source, stagedExtension, {
    recursive: true,
    filter: (path) => !path.endsWith(".test.ts"),
  });
  verifyStagedTree(stagedExtension);
  if (existsSync(target)) {
    renameSync(target, backup);
    movedLiveAside = true;
  }
  try {
    renameSync(stagedExtension, target);
  } catch (error) {
    if (movedLiveAside && !existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
  verifyLiveTree();
  rmSync(backup, { recursive: true, force: true });
  // Best-effort sweep of backups orphaned by hard-killed deploys; only entries
  // old enough that no live deploy can own them.
  try {
    const cutoff = Date.now() - 24 * 3_600_000;
    for (const entry of readdirSync(parent)) {
      if (!entry.startsWith(".pi-memory-system-backup-")) continue;
      const path = join(parent, entry);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
      } catch {
        // Ignore entries racing with another deploy's cleanup.
      }
    }
  } catch {
    // Cleanup sweep is advisory; the deploy itself already verified.
  }
  console.log(`Deployed ${source} -> ${target}`);
  console.log("Verified single Bobby stream (ops canonical-memory-client) with no legacy alias and no test files.");
  console.log("Activate it in each already-running Pi parent with /reload; a new Pi process loads it on startup.");
} finally {
  rmSync(stage, { recursive: true, force: true });
  releaseLock();
}
