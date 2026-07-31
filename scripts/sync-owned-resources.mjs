#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const home = os.homedir();
const repo = path.resolve(import.meta.dirname, "..");

const ownedExtensions = [
  {
    name: "codex-ui-gallery",
    from: path.join(home, ".pi", "agent", "extensions", "codex-ui-gallery"),
    to: path.join(repo, "extensions", "codex-ui-gallery"),
  },
  {
    name: "duel-deck",
    from: path.join(home, ".pi", "agent", "extensions", "duel-deck"),
    to: path.join(repo, "extensions", "duel-deck"),
  },
];

const optInExtensions = [
  "process-fixer",
  "skill-gateway",
  "skill-observer",
  "skill-update-checker",
  "subagent-model-defaults",
  "tool-profiles",
  "worker-prompt-compiler",
  "zz-harness-telemetry",
  "zz-tool-output-budget",
].map((name) => ({
  name,
  from: path.join(home, ".pi", "agent", "extensions", name),
  to: path.join(repo, "extras", name),
}));

const ownedSkills = [
  {
    name: "frontend-stack",
    from: path.join(home, ".agents", "skills", "frontend-stack"),
    to: path.join(repo, "skills", "frontend-stack"),
  },
  {
    name: "codex-ui-design",
    from: path.join(home, ".agents", "skills", "codex-ui-design"),
    to: path.join(repo, "skills", "codex-ui-design"),
  },
];

const localSkillSnapshots = [
  "distribute-skill-to-all-agents",
  "effective-agent-skills",
  "fal-generate",
  "folder-specific-claude-and-agents-md",
  "plannotator-compound",
  "video-prompting",
].map((name) => ({
  name,
  from: path.join(home, ".agents", "skills", name),
  to: path.join(repo, "extras", "local-skill-snapshots", name),
}));

const excludeNames = new Set(["node_modules", ".git", ".DS_Store", "logs", ".codex-ui-design", ".codex-imagegen", "Icon\r"]);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) throw new Error(`missing source: ${src}`);
  rmrf(dst);
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (excludeNames.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

for (const item of [...ownedExtensions, ...optInExtensions, ...ownedSkills, ...localSkillSnapshots]) {
  if (!fs.existsSync(item.from) && localSkillSnapshots.includes(item)) continue;
  copyDir(item.from, item.to);
  console.log(`synced ${item.name}: ${item.from} -> ${path.relative(repo, item.to)}`);
}

for (const dir of ["prompts", "themes"]){
  const p = path.join(repo, dir);
  fs.mkdirSync(p, { recursive: true });
  const keep = path.join(p, ".gitkeep");
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
}
