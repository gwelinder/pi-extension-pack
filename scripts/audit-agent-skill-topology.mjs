#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const home = os.homedir();
const repo = path.resolve(import.meta.dirname, "..");
const distributionPolicy = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(repo, "config", "skill-distribution.json"), "utf8")); } catch { return {}; }
})();
const HARNESS_ROOTS = [
  ["codex-agents", path.join(home, ".agents", "skills")],
  ["claude-user", path.join(home, ".claude", "skills")],
  ["claude-plugin-cache", path.join(home, ".claude", "plugins", "cache")],
  ["pi-user", path.join(home, ".pi", "agent", "skills")],
  ["hermes-user", path.join(home, ".hermes", "skills")],
  ["hermes-builtin", path.join(home, ".hermes", "hermes-agent", "skills")],
  ["openclaw-user", path.join(home, ".openclaw", "skills")],
  ["openclaw-workspace", path.join(home, ".openclaw", "workspace", "skills")],
];

const PROJECT_SEARCH_ROOTS = [path.join(home, "code")];
const PROJECT_SKILL_SUFFIXES = [
  path.join(".agents", "skills"),
  path.join(".claude", "skills"),
  path.join(".pi", "skills"),
  path.join(".pi", "agent", "skills"),
];
const PRUNE_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "vendor", ".venv", "venv", "target"]);

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function listChildren(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};
  const raw = text.slice(4, end).split("\n");
  const out = {};
  let index = 0;
  while (index < raw.length) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw[index]);
    if (!match) { index += 1; continue; }
    const parts = [match[2].trim()];
    index += 1;
    while (index < raw.length && /^\s+\S/.test(raw[index])) {
      parts.push(raw[index].trim());
      index += 1;
    }
    out[match[1]] = parts.join(" ").replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function scanRoot(harness, root) {
  const skills = [];
  const containerDirs = [];
  if (!exists(root)) return { harness, root, exists: false, isSymlink: false, skills, containerDirs };

  const queue = [root];
  const visited = new Set();
  while (queue.length > 0) {
    const dir = queue.shift();
    let real;
    try { real = fs.realpathSync(dir); } catch { continue; }
    if (visited.has(real)) continue;
    visited.add(real);

    const skillPath = path.join(dir, "SKILL.md");
    if (dir !== root && exists(skillPath)) {
      let text = "";
      try { text = fs.readFileSync(skillPath, "utf8"); } catch { continue; }
      const fm = parseFrontmatter(text);
      const name = fm.name || path.basename(dir);
      skills.push({
        harness,
        root,
        dirName: path.relative(root, dir),
        name,
        description: fm.description || "",
        skillPath,
        hash: sha256(text),
        bytes: Buffer.byteLength(text),
        descriptionChars: (fm.description || "").length,
        disabled: String(fm["disable-model-invocation"] || "").toLowerCase() === "true",
      });
      continue;
    }

    const children = listChildren(dir).filter((entry) => {
      if (entry.name.startsWith(".") || PRUNE_DIRS.has(entry.name)) return false;
      try { return fs.statSync(path.join(dir, entry.name)).isDirectory(); } catch { return false; }
    });
    if (dir === root) containerDirs.push(...children.map((entry) => entry.name));
    for (const child of children) queue.push(path.join(dir, child.name));
  }
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.skillPath.localeCompare(b.skillPath));
  return { harness, root, exists: true, isSymlink: isSymlink(root), skills, containerDirs: containerDirs.sort() };
}

function discoverProjectSkillRoots() {
  const found = [];
  const seen = new Set();
  for (const searchRoot of PROJECT_SEARCH_ROOTS) {
    if (!exists(searchRoot)) continue;
    const queue = [{ dir: searchRoot, depth: 0 }];
    while (queue.length > 0) {
      const { dir, depth } = queue.shift();
      if (depth > 7) continue;
      for (const suffix of PROJECT_SKILL_SUFFIXES) {
        const candidate = path.join(dir, suffix);
        if (exists(candidate) && !seen.has(candidate)) {
          seen.add(candidate);
          found.push([`project:${path.relative(searchRoot, dir) || "."}:${suffix.replaceAll(path.sep, "/")}`, candidate]);
        }
      }
      for (const entry of listChildren(dir)) {
        if (entry.name.startsWith(".") || PRUNE_DIRS.has(entry.name)) continue;
        const child = path.join(dir, entry.name);
        try { if (fs.statSync(child).isDirectory()) queue.push({ dir: child, depth: depth + 1 }); } catch {}
      }
    }
  }
  return found;
}

function mdTable(headers, rows) {
  if (rows.length === 0) return "_none_";
  const esc = (v) => String(v ?? "").replaceAll("|", "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(esc).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(esc).join(" | ")} |`),
  ].join("\n");
}

const scans = [...HARNESS_ROOTS, ...discoverProjectSkillRoots()].map(([harness, root]) => scanRoot(harness, root));
const allSkills = scans.flatMap((scan) => scan.skills);
const byName = new Map();
for (const skill of allSkills) {
  if (!byName.has(skill.name)) byName.set(skill.name, []);
  byName.get(skill.name).push(skill);
}

const duplicateRecords = [...byName.entries()]
  .filter(([, entries]) => entries.length > 1)
  .map(([name, entries]) => ({
    name,
    entries,
    harnesses: new Set(entries.map((entry) => entry.harness)),
    hashes: new Set(entries.map((entry) => entry.hash)),
  }));
const toDuplicateRow = (record) => [
  record.name,
  [...record.harnesses].join(", "),
  record.hashes.size,
  record.entries.map((entry) => `${entry.harness}:${entry.bytes}`).join(", "),
];
const crossHarnessDuplicates = duplicateRecords.filter((record) => record.harnesses.size > 1).map(toDuplicateRow)
  .sort((a, b) => Number(b[2]) - Number(a[2]) || String(a[0]).localeCompare(String(b[0])));
const sameHarnessDriftRows = duplicateRecords.filter((record) => record.harnesses.size === 1 && record.hashes.size > 1).map(toDuplicateRow)
  .sort((a, b) => Number(b[2]) - Number(a[2]) || String(a[0]).localeCompare(String(b[0])));

const intentionalOverrides = distributionPolicy.intentionalOverrides || {};
const intentionalRows = crossHarnessDuplicates.filter((row) => Number(row[2]) > 1 && intentionalOverrides[row[0]])
  .map((row) => [...row, intentionalOverrides[row[0]].reason || "declared override"]);
const divergentRows = crossHarnessDuplicates.filter((row) => Number(row[2]) > 1 && !intentionalOverrides[row[0]]);
const uniqueRows = scans.map((scan) => {
  const unique = scan.skills.filter((skill) => (byName.get(skill.name)?.length ?? 0) === 1);
  return [scan.harness, unique.length, unique.map((skill) => skill.name).slice(0, 50).join(", ") || "none"];
});

const burdenRows = scans.map((scan) => {
  const descriptions = scan.skills.filter((s) => !s.disabled).reduce((sum, s) => sum + s.name.length + s.description.length + 16, 0);
  const hidden = scan.skills.filter((s) => s.disabled).length;
  return [scan.harness, scan.skills.length, hidden, descriptions, Math.ceil(descriptions / 3.5)];
});

const longDescriptionRows = allSkills
  .filter((skill) => skill.descriptionChars > 650)
  .sort((a, b) => b.descriptionChars - a.descriptionChars)
  .slice(0, 80)
  .map((skill) => [skill.name, skill.harness, skill.descriptionChars, skill.skillPath.replace(home, "~")]);

const badNameRows = allSkills
  .filter((skill) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64)
  .map((skill) => [skill.name, skill.harness, skill.skillPath.replace(home, "~")]);

const rootRows = scans.map((scan) => [
  scan.harness,
  scan.root.replace(home, "~"),
  scan.exists ? "yes" : "no",
  scan.isSymlink ? "yes" : "no",
  scan.skills.length,
  scan.containerDirs?.length ?? 0,
]);

const lines = [];
lines.push("# Cross-agent skill topology audit");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Roots");
lines.push("");
lines.push(mdTable(["Harness", "Root", "Exists", "Symlink", "Skills", "Top-level containers"], rootRows));
lines.push("");
lines.push("## Catalog description inventory");
lines.push("");
lines.push("This is an upper-bound inventory, not measured prompt cost. Harnesses differ in discovery, deduplication, plugin loading, and `disable-model-invocation` support.");
lines.push("");
lines.push(mdTable(["Harness", "Skills", "Hidden", "Description chars", "Rough tokens"], burdenRows));
lines.push("");
lines.push("## Divergent duplicate skills");
lines.push("");
lines.push("Same skill name appears in multiple harnesses with different `SKILL.md` hashes. These are the highest-value cleanup targets.");
lines.push("");
lines.push(mdTable(["Skill", "Harnesses", "Hash variants", "Bytes by harness"], divergentRows.slice(0, 120)));
lines.push("");
lines.push("## Intentional harness overrides");
lines.push("");
lines.push(mdTable(["Skill", "Harnesses", "Hash variants", "Bytes by harness", "Reason"], intentionalRows));
lines.push("");
lines.push("## Same-harness cache/version drift");
lines.push("");
lines.push("Multiple plugin/cache versions inside one harness are reported separately; they are not cross-harness distribution conflicts.");
lines.push("");
lines.push(mdTable(["Skill", "Harness", "Hash variants", "Bytes by copy"], sameHarnessDriftRows.slice(0, 80)));
lines.push("");
lines.push("## Harness-unique skills");
lines.push("");
lines.push(mdTable(["Harness", "Unique count", "Examples"], uniqueRows));
lines.push("");
lines.push("## Long descriptions");
lines.push("");
lines.push(mdTable(["Skill", "Harness", "Description chars", "Path"], longDescriptionRows));
lines.push("");
lines.push("## Invalid or non-standard names");
lines.push("");
lines.push(mdTable(["Skill", "Harness", "Path"], badNameRows));
lines.push("");
lines.push("## Recommended cleanup order");
lines.push("");
lines.push("1. Resolve divergent duplicates before deleting anything; decide which harness owns each variant.");
lines.push("2. In Pi, move long-tail skills behind `skill_lookup` / hidden skills rather than keeping every description always visible.");
lines.push("3. Keep Hermes/OpenClaw app-control skills out of Codex/Pi unless they are rewritten as portable skills.");
lines.push("4. Keep a small visible core of router skills and primitives; hide or package-route the rest.");

console.log(lines.join("\n"));
