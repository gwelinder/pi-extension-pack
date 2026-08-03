#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const home = process.env.TRUSTED_SKILLS_HOME ? path.resolve(process.env.TRUSTED_SKILLS_HOME) : os.homedir();
const repo = path.resolve(import.meta.dirname, "..");
const configPath = path.join(repo, "config", "skill-distribution.json");
const apply = process.argv.includes("--apply");
const onlyArg = process.argv.find((argument) => argument.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean)) : null;
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const backupStamp = new Date().toISOString().replace(/[-:.]/g, "");
const backupRunRoot = path.join(home, ".agents", "skill-backups", "distribution", backupStamp);
let backupUsed = false;

function expand(p) {
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : path.resolve(repo, p);
}

function hashDir(root) {
  if (!pathExists(root)) return null;
  const hash = crypto.createHash("sha256");
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(full);
    }
  }
  files.sort();
  for (const file of files) {
    const stat = fs.lstatSync(file);
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(stat.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function backupTarget(target, targetName, skillName) {
  if (!pathExists(target)) return null;
  const backup = path.join(backupRunRoot, targetName, skillName);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (pathExists(backup)) throw new Error(`Backup collision: ${backup}`);
  fs.renameSync(target, backup);
  backupUsed = true;
  return backup;
}

function copyDir(source, target, targetName, skillName) {
  backupTarget(target, targetName, skillName);
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, dereference: false });
}

function symlinkMatches(target, source) {
  if (!pathExists(target) || !fs.lstatSync(target).isSymbolicLink()) return false;
  try {
    return fs.realpathSync.native(target) === fs.realpathSync.native(source);
  } catch {
    return false;
  }
}

function linkDir(source, target, targetName, skillName) {
  backupTarget(target, targetName, skillName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, "dir");
}

const canonicalRoot = expand(config.canonicalRoot);
const actions = [];
if (only) {
  const unknown = [...only].filter((name) => !Object.hasOwn(config.skills, name));
  if (unknown.length > 0) throw new Error(`Unknown --only skill(s): ${unknown.join(", ")}`);
}
for (const [name, skill] of Object.entries(config.skills)) {
  if (only && !only.has(name)) continue;
  const source = path.join(canonicalRoot, name);
  if (!pathExists(path.join(source, "SKILL.md"))) {
    actions.push({ name, target: "canonical", status: "missing-source", source });
    continue;
  }
  const sourceHash = hashDir(source);
  const strategy = skill.strategy || "copy";
  if (strategy !== "copy" && strategy !== "symlink") {
    actions.push({ name, target: "canonical", status: "unknown-strategy", strategy });
    continue;
  }
  for (const targetName of skill.targets || []) {
    const targetRoot = config.targets[targetName];
    if (!targetRoot) {
      actions.push({ name, target: targetName, status: "unknown-target" });
      continue;
    }
    const target = path.join(expand(targetRoot), name);
    const targetHash = hashDir(target);
    const status = strategy === "symlink"
      ? targetHash === null
        ? "missing"
        : symlinkMatches(target, source)
          ? "clean"
          : "needs-link"
      : targetHash === null
        ? "missing"
        : targetHash === sourceHash
          ? "clean"
          : "diverged";
    actions.push({ name, target: targetName, status, strategy, source, destination: target });
    if (apply && status !== "clean") {
      if (strategy === "symlink") linkDir(source, target, targetName, name);
      else copyDir(source, target, targetName, name);
    }
  }
}

for (const action of actions) {
  const suffix = apply && (action.status === "missing" || action.status === "diverged") ? " -> synced" : "";
  console.log(`${action.status.padEnd(14)} ${action.name} -> ${action.target}${suffix}`);
}

if (!apply && actions.some((action) => action.status !== "clean")) {
  console.log("\nPlan only. Re-run with --apply to sync named managed targets. No unlisted skill is modified or removed.");
}
if (backupUsed) console.log(`\nBackups: ${backupRunRoot}`);
if (actions.some((action) => action.status === "missing-source" || action.status === "unknown-target" || action.status === "unknown-strategy")) process.exitCode = 1;
