#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const home = os.homedir();
const repo = path.resolve(import.meta.dirname, "..");
const activeExtensionsDir = path.join(home, ".pi", "agent", "extensions");
const disabledExtensionsDir = path.join(home, ".pi", "agent", "extensions-disabled");
const agentsSkillsDir = path.join(home, ".agents", "skills");
const piSkillsDir = path.join(home, ".pi", "agent", "skills");
const skillLockPath = path.join(home, ".agents", ".skill-lock.json");

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function skillNames(root) {
  return listDirs(root).filter((name) => exists(path.join(root, name, "SKILL.md")));
}

function packageResourceNames(kind) {
  const dir = path.join(repo, kind);
  const dirs = listDirs(dir);
  if (kind !== "extensions") return dirs;
  const files = listFiles(dir).filter((name) => /\.(ts|js)$/.test(name));
  return [...dirs, ...files].sort();
}

function relSkillTarget(name) {
  const p = path.join(piSkillsDir, name);
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return fs.readlinkSync(p);
  } catch {}
  return null;
}

function mdList(items, empty = "none") {
  return items.length ? items.map((x) => `- ${x}`).join("\n") : `- ${empty}`;
}

const repoExtensions = packageResourceNames("extensions");
const repoExtras = packageResourceNames("extras");
const repoSkills = packageResourceNames("skills");
const activeExtensions = listDirs(activeExtensionsDir);
const disabledExtensions = listDirs(disabledExtensionsDir);
const activeExtensionFiles = listFiles(activeExtensionsDir).filter((name) => /\.(ts|js|json)$/.test(name));
const agentsSkills = skillNames(agentsSkillsDir);
const piSkills = skillNames(piSkillsDir);

const lock = loadJson(skillLockPath)?.skills ?? {};
const lockedNames = new Set(Object.keys(lock));
const sourceGroups = new Map();
for (const [name, meta] of Object.entries(lock)) {
  const source = meta.source ?? "(unknown)";
  if (!sourceGroups.has(source)) sourceGroups.set(source, []);
  sourceGroups.get(source).push(name);
}
const groupedSources = [...sourceGroups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

const unmanagedAgentSkills = agentsSkills.filter((name) => !lockedNames.has(name));
const repoMissingActiveExtensions = activeExtensions.filter((name) => !repoExtensions.includes(name) && !repoExtras.includes(name));
const repoMissingSkills = agentsSkills.filter((name) => !repoSkills.includes(name));
const packageOnlySkills = repoSkills.filter((name) => !agentsSkills.includes(name));

const lines = [];
lines.push("# Local Pi package inventory");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("> This report intentionally lists paths and names only. It does not read or print auth/config contents.");
lines.push("");
lines.push("## Package repo resources");
lines.push("");
lines.push(`- repo: \`${repo}\``);
lines.push(`- default extensions: ${repoExtensions.length}`);
lines.push(`- extras: ${repoExtras.length}`);
lines.push(`- packaged skills: ${repoSkills.length}`);
lines.push("");
lines.push("### Packaged default extensions");
lines.push(mdList(repoExtensions));
lines.push("");
lines.push("### Packaged skills");
lines.push(mdList(repoSkills));
lines.push("");
lines.push("## Active local extensions not yet packaged");
lines.push("");
lines.push(mdList(repoMissingActiveExtensions));
lines.push("");
if (activeExtensionFiles.length) {
  lines.push("### Active root-level extension/config files");
  lines.push(mdList(activeExtensionFiles.map((name) => {
    if (name.endsWith(".json")) return `${name} (config; do not commit raw if secret-bearing)`;
    return repoExtensions.includes(name) ? `${name} (packaged)` : `${name} (not packaged)`;
  })));
  lines.push("");
}
if (disabledExtensions.length) {
  lines.push("## Disabled local extensions");
  lines.push("");
  lines.push(mdList(disabledExtensions));
  lines.push("");
}
lines.push("## Skill sources from ~/.agents/.skill-lock.json");
lines.push("");
for (const [source, names] of groupedSources) {
  names.sort();
  const url = lock[names[0]]?.sourceUrl;
  lines.push(`### ${source} (${names.length})`);
  if (url) lines.push(`- upstream: ${url}`);
  lines.push(`- skills: ${names.join(", ")}`);
  lines.push("");
}
lines.push("## Local ~/.agents skills not in skill lock");
lines.push("");
lines.push(mdList(unmanagedAgentSkills));
lines.push("");
lines.push("## Packaged skills not present in ~/.agents");
lines.push("");
lines.push(mdList(packageOnlySkills));
lines.push("");
lines.push("## Pi skill symlink notes");
lines.push("");
const symlinkLines = piSkills
  .map((name) => [name, relSkillTarget(name)])
  .filter(([, target]) => target)
  .slice(0, 160)
  .map(([name, target]) => `${name} -> ${target}`);
lines.push(mdList(symlinkLines));
lines.push("");
lines.push("## Recommended ownership split");
lines.push("");
lines.push("- **Vendored in this repo:** owned extensions and owned skills that are not expected to receive upstream changes.");
lines.push("- **External package/fork:** third-party skill bundles, installed with Pi package filters so upstream updates can flow.");
lines.push("- **Examples only:** secret-bearing config files and machine-local settings.");

console.log(lines.join("\n"));
