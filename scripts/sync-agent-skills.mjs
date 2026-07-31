#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const home = os.homedir();
const repo = path.resolve(import.meta.dirname, "..");
const configPath = path.join(repo, "config", "skill-distribution.json");
const apply = process.argv.includes("--apply");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

function expand(p) {
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : path.resolve(repo, p);
}

function hashDir(root) {
  if (!fs.existsSync(root)) return null;
  const hash = crypto.createHash("sha256");
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  files.sort();
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function copyDir(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, dereference: false });
}

const canonicalRoot = expand(config.canonicalRoot);
const actions = [];
for (const [name, skill] of Object.entries(config.skills)) {
  const source = path.join(canonicalRoot, name);
  if (!fs.existsSync(path.join(source, "SKILL.md"))) {
    actions.push({ name, target: "canonical", status: "missing-source", source });
    continue;
  }
  const sourceHash = hashDir(source);
  for (const targetName of skill.targets || []) {
    const targetRoot = config.targets[targetName];
    if (!targetRoot) {
      actions.push({ name, target: targetName, status: "unknown-target" });
      continue;
    }
    const target = path.join(expand(targetRoot), name);
    const targetHash = hashDir(target);
    const status = targetHash === null ? "missing" : targetHash === sourceHash ? "clean" : "diverged";
    actions.push({ name, target: targetName, status, source, destination: target });
    if (apply && status !== "clean") copyDir(source, target);
  }
}

for (const action of actions) {
  const suffix = apply && (action.status === "missing" || action.status === "diverged") ? " -> synced" : "";
  console.log(`${action.status.padEnd(14)} ${action.name} -> ${action.target}${suffix}`);
}

if (!apply && actions.some((action) => action.status !== "clean")) {
  console.log("\nPlan only. Re-run with --apply to sync named managed targets. No unlisted skill is modified or removed.");
}
if (actions.some((action) => action.status === "missing-source" || action.status === "unknown-target")) process.exitCode = 1;
