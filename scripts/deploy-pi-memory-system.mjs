#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "..", "extensions", "pi-memory-system");
const target = join(homedir(), ".pi", "agent", "extensions", "pi-memory-system");
mkdirSync(dirname(target), { recursive: true });
const stage = mkdtempSync(join(dirname(target), ".pi-memory-system-deploy-"));
const stagedExtension = join(stage, "pi-memory-system");
const backup = `${target}.previous`;

try {
  cpSync(source, stagedExtension, {
    recursive: true,
    filter: (path) => !path.endsWith(".test.ts"),
  });
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, backup);
  renameSync(stagedExtension, target);
  rmSync(backup, { recursive: true, force: true });
  console.log(`Deployed ${source} -> ${target}`);
  console.log("Activate it in each already-running Pi parent with /reload; a new Pi process loads it on startup.");
} catch (error) {
  if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
  throw error;
} finally {
  rmSync(stage, { recursive: true, force: true });
}
