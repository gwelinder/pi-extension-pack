#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");

export function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function expandPath(value, { home, repoRoot }) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

export function safeJoin(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Expected a relative path, received: ${relativePath}`);
  }
  const joined = path.resolve(root, relativePath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!joined.startsWith(prefix)) {
    throw new Error(`Path escapes its source root: ${relativePath}`);
  }
  return joined;
}

export function hashDirectory(root) {
  if (!pathExists(root)) return null;
  const hash = crypto.createHash("sha256");
  const entries = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else entries.push(absolute);
    }
  }

  entries.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
  for (const entry of entries) {
    const relative = path.relative(root, entry);
    const stat = fs.lstatSync(entry);
    hash.update(relative);
    hash.update("\0");
    hash.update(String(stat.mode & 0o777));
    hash.update("\0");
    if (stat.isSymbolicLink()) hash.update(`link:${fs.readlinkSync(entry)}`);
    else hash.update(fs.readFileSync(entry));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function validateContainedSymlinks(root) {
  const resolvedRoot = path.resolve(root);
  const prefix = `${resolvedRoot}${path.sep}`;
  const queue = [resolvedRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const linkTarget = fs.readlinkSync(absolute);
      const resolvedTarget = path.resolve(path.dirname(absolute), linkTarget);
      if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) {
        throw new Error(`Skill symlink escapes its reviewed directory: ${absolute} -> ${linkTarget}`);
      }
    }
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function validateManifest(manifest) {
  if (manifest.version !== 1) throw new Error(`Unsupported trusted-skill manifest version: ${manifest.version}`);
  if (!manifest.canonicalRoot || !manifest.vendorRoot || !manifest.backupRoot) {
    throw new Error("Manifest must define canonicalRoot, vendorRoot, and backupRoot");
  }

  const names = new Set();
  for (const [sourceId, source] of Object.entries(manifest.sources || {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sourceId)) throw new Error(`Invalid source id: ${sourceId}`);
    if (!Array.isArray(source.skills) || source.skills.length === 0) throw new Error(`Source ${sourceId} has no skills`);
    if (source.kind === "git") {
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(source.url || "")) {
        throw new Error(`Git source ${sourceId} must use an explicit GitHub HTTPS URL`);
      }
      if (!/^[0-9a-f]{40}$/.test(source.revision || "")) throw new Error(`Git source ${sourceId} must pin a full commit SHA`);
    } else if (source.kind !== "local") {
      throw new Error(`Unsupported source kind for ${sourceId}: ${source.kind}`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(source.revision || "")) throw new Error(`Invalid immutable revision for ${sourceId}`);

    for (const skill of source.skills) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.name || "")) throw new Error(`Invalid skill name: ${skill.name}`);
      if (names.has(skill.name)) throw new Error(`Duplicate managed skill name: ${skill.name}`);
      names.add(skill.name);
      if (!/^[0-9a-f]{64}$/.test(skill.sha256 || "")) throw new Error(`Skill ${skill.name} needs a reviewed SHA-256`);
      safeJoin("/manifest-root", skill.path);
    }
  }

  for (const source of Object.values(manifest.sources || {})) {
    for (const skill of source.skills) {
      for (const dependency of skill.dependencies || []) {
        if (!names.has(dependency)) throw new Error(`Skill ${skill.name} depends on unmanaged skill ${dependency}`);
      }
    }
  }
  return names;
}

export function flattenSkills(manifest, { home, repoRoot }) {
  const vendorRoot = expandPath(manifest.vendorRoot, { home, repoRoot });
  return Object.entries(manifest.sources).flatMap(([sourceId, source]) => {
    const snapshotRoot = path.join(vendorRoot, sourceId, source.revision);
    return source.skills.map((skill) => ({
      sourceId,
      source,
      skill,
      snapshotRoot,
      materializedPath: safeJoin(snapshotRoot, skill.path),
    }));
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout || ""}${result.stderr || ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}${detail}`);
  }
  return result.stdout || "";
}

function verifySkill(entry, root = entry.snapshotRoot) {
  const skillPath = safeJoin(root, entry.skill.path);
  validateContainedSymlinks(skillPath);
  const skillFile = path.join(skillPath, "SKILL.md");
  if (!pathExists(skillFile)) throw new Error(`${entry.skill.name} is missing SKILL.md at ${skillFile}`);
  const frontmatter = fs.readFileSync(skillFile, "utf8").match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter || !new RegExp(`^name:\\s*${entry.skill.name}\\s*$`, "m").test(frontmatter[1])) {
    throw new Error(`${entry.skill.name} frontmatter name does not match its manifest name`);
  }
  const actual = hashDirectory(skillPath);
  if (actual !== entry.skill.sha256) {
    throw new Error(`${entry.skill.name} hash mismatch: expected ${entry.skill.sha256}, received ${actual}`);
  }
  return actual;
}

function copySelectedLocalSource(sourceId, source, entries, destination, repoRoot) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(temporary, { recursive: true });
  try {
    for (const entry of entries) {
      const from = safeJoin(repoRoot, entry.skill.path);
      const to = safeJoin(temporary, entry.skill.path);
      if (!pathExists(path.join(from, "SKILL.md"))) throw new Error(`Local source missing for ${entry.skill.name}: ${from}`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true, dereference: false, preserveTimestamps: true });
      verifySkill(entry, temporary);
    }
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  console.log(`materialized   ${sourceId}@${source.revision}`);
}

function clonePinnedGitSource(sourceId, source, entries, destination) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    run("git", ["clone", "--filter=blob:none", "--no-checkout", source.url, temporary]);
    run("git", ["-C", temporary, "checkout", "--detach", source.revision]);
    const head = run("git", ["-C", temporary, "rev-parse", "HEAD"], { capture: true }).trim();
    if (head !== source.revision) throw new Error(`Pinned checkout mismatch for ${sourceId}: ${head}`);
    for (const entry of entries) verifySkill(entry, temporary);
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  console.log(`materialized   ${sourceId}@${source.revision}`);
}

export function materializeSources(manifest, context) {
  validateManifest(manifest);
  const entries = flattenSkills(manifest, context);
  for (const [sourceId, source] of Object.entries(manifest.sources)) {
    const sourceEntries = entries.filter((entry) => entry.sourceId === sourceId);
    const destination = sourceEntries[0].snapshotRoot;
    if (pathExists(destination)) {
      for (const entry of sourceEntries) verifySkill(entry);
      console.log(`verified       ${sourceId}@${source.revision}`);
      continue;
    }
    if (source.kind === "git") clonePinnedGitSource(sourceId, source, sourceEntries, destination);
    else copySelectedLocalSource(sourceId, source, sourceEntries, destination, context.repoRoot);
  }
}

function resolvedSymlinkMatches(target, expected) {
  if (!pathExists(target) || !fs.lstatSync(target).isSymbolicLink()) return false;
  try {
    return fs.realpathSync.native(target) === fs.realpathSync.native(expected);
  } catch {
    return false;
  }
}

export function buildActivationPlan(manifest, context) {
  const canonicalRoot = expandPath(manifest.canonicalRoot, context);
  const entries = flattenSkills(manifest, context);
  const actions = [];
  for (const entry of entries) {
    const target = path.join(canonicalRoot, entry.skill.name);
    actions.push({
      kind: resolvedSymlinkMatches(target, entry.materializedPath) ? "clean" : pathExists(target) ? "replace-link" : "create-link",
      label: "agents",
      name: entry.skill.name,
      target,
      expected: entry.materializedPath,
    });
    for (const [label, rawRoot] of Object.entries(manifest.shadowRoots || {})) {
      const shadow = path.join(expandPath(rawRoot, context), entry.skill.name);
      if (pathExists(shadow)) actions.push({ kind: "remove-shadow", label, name: entry.skill.name, target: shadow });
    }
  }
  return actions;
}

export function buildLockPlan(manifest, context) {
  if (!manifest.lockFile) return [];
  const lockPath = expandPath(manifest.lockFile, context);
  if (!pathExists(lockPath)) return [];
  const lock = readJson(lockPath);
  const managed = new Set(flattenSkills(manifest, context).map((entry) => entry.skill.name));
  return Object.keys(lock.skills || {})
    .filter((name) => managed.has(name))
    .sort()
    .map((name) => ({ kind: "remove-lock-entry", label: "skills-cli-lock", name, target: lockPath }));
}

function backupTarget(target, backupRoot, label, name) {
  if (!pathExists(target)) return null;
  const destination = path.join(backupRoot, label, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (pathExists(destination)) throw new Error(`Backup collision: ${destination}`);
  fs.renameSync(target, destination);
  return destination;
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

export function applyActivationPlan(manifest, context, actions) {
  const backupBase = expandPath(manifest.backupRoot, context);
  const backupRoot = path.join(backupBase, timestampId());
  const performed = [];
  for (const action of actions) {
    if (action.kind === "clean") continue;
    const backup = backupTarget(action.target, backupRoot, action.label, action.name);
    if (action.kind === "create-link" || action.kind === "replace-link") {
      fs.mkdirSync(path.dirname(action.target), { recursive: true });
      fs.symlinkSync(action.expected, action.target, "dir");
    }
    performed.push({ ...action, backup });
    console.log(`${action.kind.padEnd(14)} ${action.name} -> ${action.label}`);
  }
  if (performed.length > 0) {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.writeFileSync(path.join(backupRoot, "actions.json"), `${JSON.stringify({ createdAt: new Date().toISOString(), actions: performed }, null, 2)}\n`);
    console.log(`backups       ${backupRoot}`);
  }
  return { backupRoot: performed.length > 0 ? backupRoot : null, performed };
}

export function reconcileSkillLock(manifest, context, actions, existingBackupRoot = null) {
  if (actions.length === 0) return { backupRoot: existingBackupRoot, performed: [] };
  const lockPath = actions[0].target;
  const lock = readJson(lockPath);
  const backupBase = expandPath(manifest.backupRoot, context);
  const backupRoot = existingBackupRoot || path.join(backupBase, timestampId());
  const backup = path.join(backupRoot, "locks", "skill-lock.json");
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (!pathExists(backup)) fs.copyFileSync(lockPath, backup);
  for (const action of actions) delete lock.skills[action.name];
  const temporary = `${lockPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`);
  fs.renameSync(temporary, lockPath);

  const actionLog = path.join(backupRoot, "actions.json");
  const existing = pathExists(actionLog) ? readJson(actionLog) : { createdAt: new Date().toISOString(), actions: [] };
  const performed = actions.map((action) => ({ ...action, backup }));
  existing.actions.push(...performed);
  fs.writeFileSync(actionLog, `${JSON.stringify(existing, null, 2)}\n`);
  for (const action of actions) console.log(`${action.kind.padEnd(18)} ${action.name} -> ${action.label}`);
  console.log(`lock backup    ${backup}`);
  return { backupRoot, performed };
}

function scanRiskyCommands(root) {
  const findings = [];
  const patterns = [
    ["recursive deletion", /\brm\s+-[^\n]*r[^\n]*f|\brm\s+-[^\n]*f[^\n]*r/],
    ["destructive git", /\bgit\s+(?:reset\s+--hard|clean\s+-|checkout\s+--|restore\s+--source)/],
    ["remote git mutation", /\bgit\s+push\b|\bgh\s+pr\s+create\b/],
    ["privilege escalation", /\bsudo\b/],
    ["credential-bearing curl", /\bcurl\b[^\n]*(?:Authorization|Bearer|token=)/i],
    ["package runner bypass", /\b(?:npx|npm|yarn)\b/],
  ];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.(?:md|sh|mjs|js|ts|yaml|yml|json)$/.test(entry.name)) continue;
      const lines = fs.readFileSync(absolute, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        for (const [risk, pattern] of patterns) {
          if (pattern.test(lines[index])) findings.push({ risk, file: absolute, line: index + 1, text: lines[index].trim() });
        }
      }
    }
  }
  return findings;
}

function readDistributionConfig(repoRoot) {
  return readJson(path.join(repoRoot, "config", "skill-distribution.json"));
}

function verifyActiveState(manifest, context) {
  const entries = flattenSkills(manifest, context);
  const canonicalRoot = expandPath(manifest.canonicalRoot, context);
  const distribution = readDistributionConfig(context.repoRoot);
  const errors = [];
  const lockActions = buildLockPlan(manifest, context);
  for (const action of lockActions) errors.push(`${action.name} is still owned by the skills CLI lock`);
  for (const entry of entries) {
    try {
      verifySkill(entry);
    } catch (error) {
      errors.push(error.message);
    }
    const canonical = path.join(canonicalRoot, entry.skill.name);
    if (!resolvedSymlinkMatches(canonical, entry.materializedPath)) errors.push(`${entry.skill.name} canonical link is missing or incorrect`);
    const distributionEntry = distribution.skills[entry.skill.name];
    if (!distributionEntry || distributionEntry.strategy !== "symlink") {
      errors.push(`${entry.skill.name} is not registered for symlink distribution`);
      continue;
    }
    for (const targetName of distributionEntry.targets || []) {
      const rawRoot = distribution.targets[targetName];
      if (!rawRoot) {
        errors.push(`${entry.skill.name} has unknown distribution target ${targetName}`);
        continue;
      }
      const target = path.join(expandPath(rawRoot, context), entry.skill.name);
      if (!resolvedSymlinkMatches(target, canonical)) errors.push(`${entry.skill.name} link for ${targetName} is missing or incorrect`);
    }
    for (const [label, rawRoot] of Object.entries(manifest.shadowRoots || {})) {
      const shadow = path.join(expandPath(rawRoot, context), entry.skill.name);
      if (pathExists(shadow)) errors.push(`${entry.skill.name} still has a shadow copy in ${label}`);
    }
  }
  return errors;
}

function printPlan(actions) {
  for (const action of actions) console.log(`${action.kind.padEnd(14)} ${action.name} -> ${action.label}`);
  if (actions.every((action) => action.kind === "clean")) console.log("No canonical or shadow changes required.");
}

function usage() {
  console.log(`Usage: node scripts/manage-trusted-skills.mjs <command>\n\nCommands:\n  materialize  Create immutable vendor snapshots at reviewed revisions\n  audit        Verify hashes, dependency closure, and risky command patterns\n  plan         Report canonical link and shadow-copy changes\n  apply        Back up conflicts, activate canonical links, and sync harness links\n  verify       Verify snapshots, canonical links, harness links, and absent shadows`);
}

function main() {
  const command = process.argv[2] || "plan";
  if (command === "--help" || command === "help") {
    usage();
    return;
  }
  const repoRoot = process.env.TRUSTED_SKILLS_REPO_ROOT ? path.resolve(process.env.TRUSTED_SKILLS_REPO_ROOT) : defaultRepoRoot;
  const home = process.env.TRUSTED_SKILLS_HOME ? path.resolve(process.env.TRUSTED_SKILLS_HOME) : os.homedir();
  const context = { home, repoRoot };
  const manifest = readJson(path.join(repoRoot, "config", "trusted-skill-sources.json"));
  validateManifest(manifest);

  if (command === "materialize") {
    materializeSources(manifest, context);
    return;
  }

  const entries = flattenSkills(manifest, context);
  for (const entry of entries) verifySkill(entry);

  if (command === "audit") {
    const findings = entries.flatMap((entry) => scanRiskyCommands(entry.materializedPath).map((finding) => ({ ...finding, name: entry.skill.name })));
    if (findings.length > 0) {
      for (const finding of findings) console.error(`${finding.name}: ${finding.risk} at ${finding.file}:${finding.line}: ${finding.text}`);
      throw new Error(`Trusted skill audit found ${findings.length} risky command pattern(s)`);
    }
    console.log(`audit clean    ${entries.length} managed skills, dependency closure complete, hashes verified`);
    return;
  }

  const actions = buildActivationPlan(manifest, context);
  const lockActions = buildLockPlan(manifest, context);
  if (command === "plan") {
    printPlan([...actions, ...lockActions]);
    return;
  }
  if (command === "apply") {
    const activation = applyActivationPlan(manifest, context, actions);
    reconcileSkillLock(manifest, context, lockActions, activation.backupRoot);
    const names = entries.map((entry) => entry.skill.name).join(",");
    run(process.execPath, [path.join(repoRoot, "scripts", "sync-agent-skills.mjs"), "--apply", `--only=${names}`], {
      env: { ...process.env, TRUSTED_SKILLS_HOME: home },
    });
    const errors = verifyActiveState(manifest, context);
    if (errors.length > 0) throw new Error(`Activation verification failed:\n- ${errors.join("\n- ")}`);
    console.log(`verified       ${entries.length} trusted skills active across configured harnesses`);
    return;
  }
  if (command === "verify") {
    const errors = verifyActiveState(manifest, context);
    if (errors.length > 0) throw new Error(`Trusted skill verification failed:\n- ${errors.join("\n- ")}`);
    console.log(`verified       ${entries.length} trusted skills active across configured harnesses`);
    return;
  }
  usage();
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
