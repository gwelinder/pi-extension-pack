#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const home = os.homedir();
const skillObserverDir = path.join(home, ".pi", "agent", "skill-observer");
const harnessDir = path.join(home, ".pi", "agent", "telemetry", "harness");
const bundleTelemetryDir = path.join(home, ".pi", "agent", "telemetry", "skill-bundles");
const agentsSkillsDir = path.join(home, ".agents", "skills");
const piSkillsDir = path.join(home, ".pi", "agent", "skills");
const lockPath = path.join(home, ".agents", ".skill-lock.json");

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function listFiles(dir, re = /.*/) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && re.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function skillNames(root) {
  return listDirs(root)
    .filter((dir) => exists(path.join(dir, "SKILL.md")))
    .map((dir) => path.basename(dir));
}

function nonSkillDirs(root) {
  return listDirs(root)
    .filter((dir) => !exists(path.join(dir, "SKILL.md")))
    .map((dir) => path.basename(dir));
}

function parseJsonl(files, visitor) {
  for (const file of files) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { visitor(JSON.parse(line), file); } catch {}
    }
  }
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function maxIso(map, key, value) {
  if (!value) return;
  const current = map.get(key) ?? "";
  if (value > current) map.set(key, value);
}

function mdTable(headers, rows) {
  if (rows.length === 0) return "_none_";
  const esc = (value) => String(value ?? "").replaceAll("|", "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(esc).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(esc).join(" | ")} |`),
  ].join("\n");
}

function sourceOf(lock, name) {
  return lock[name]?.source ?? "(unlocked/local)";
}

function sourceUrlOf(lock, name) {
  return lock[name]?.sourceUrl ?? "";
}

const lock = readJson(lockPath)?.skills ?? {};
const lockedNames = new Set(Object.keys(lock));
const activePiSkills = new Set(skillNames(piSkillsDir));
const agentSkills = new Set(skillNames(agentsSkillsDir));
const allSkillNames = new Set([...activePiSkills, ...agentSkills, ...lockedNames]);

const observerFiles = listFiles(skillObserverDir, /^observations\.ndjson(?:\.\d+)?$/);
const harnessFiles = listFiles(harnessDir, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
const bundleFiles = listFiles(bundleTelemetryDir, /^\d{4}-\d{2}-\d{2}\.jsonl$/);

const loads = new Map();
const lastLoad = new Map();
const projects = new Map();
const observerSessions = new Set();
let observerRuns = 0;
let loadedSkillEvents = 0;

parseJsonl(observerFiles, (record) => {
  if (record.event !== "run_end") return;
  observerRuns += 1;
  if (record.sessionId) observerSessions.add(record.sessionId);
  const cwd = record.cwd || "";
  const ts = record.endedAt || record.ts || "";
  for (const skill of record.loadedSkills ?? []) {
    const name = skill?.name;
    if (!name) continue;
    allSkillNames.add(name);
    inc(loads, name);
    loadedSkillEvents += 1;
    maxIso(lastLoad, name, ts);
    if (!projects.has(name)) projects.set(name, new Set());
    if (cwd) projects.get(name).add(cwd);
  }
});

const promptPresence = new Map();
const lastPromptPresence = new Map();
const toolCalls = new Map();
let toolOutputCompactions = 0;
let skillLookupCalls = 0;

parseJsonl(harnessFiles, (record) => {
  if (record.event === "before_agent_start") {
    for (const name of record.skillNames ?? []) {
      allSkillNames.add(name);
      inc(promptPresence, name);
      maxIso(lastPromptPresence, name, record.iso || "");
    }
    return;
  }
  if (record.event === "tool_start" && record.toolName) {
    inc(toolCalls, record.toolName);
    if (record.toolName === "skill_lookup") skillLookupCalls += 1;
    return;
  }
  if (record.event === "tool_end") {
    const budget = record.result?.toolOutputBudget;
    if (budget?.compacted) toolOutputCompactions += 1;
  }
});

const bundleMatches = new Map();
const bundleLast = new Map();
parseJsonl(bundleFiles, (record) => {
  for (const match of record.matches ?? []) {
    if (!match?.name) continue;
    inc(bundleMatches, match.name);
    maxIso(bundleLast, match.name, record.iso || "");
  }
});

const bySource = new Map();
for (const name of Object.keys(lock)) {
  const source = sourceOf(lock, name);
  if (!bySource.has(source)) bySource.set(source, []);
  bySource.get(source).push(name);
}

const rows = [...allSkillNames].sort().map((name) => ({
  name,
  loads: loads.get(name) ?? 0,
  lastLoad: lastLoad.get(name) ?? "",
  promptPresence: promptPresence.get(name) ?? 0,
  lastPromptPresence: lastPromptPresence.get(name) ?? "",
  projects: projects.get(name)?.size ?? 0,
  source: sourceOf(lock, name),
  sourceUrl: sourceUrlOf(lock, name),
  activePi: activePiSkills.has(name),
  installedAgent: agentSkills.has(name),
  locked: lockedNames.has(name),
}));

const obviousRemoval = rows
  .filter((row) => row.locked && row.loads === 0 && !row.activePi && !row.installedAgent)
  .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));

const reviewHideOrRemove = rows
  .filter((row) => row.locked && row.loads <= 3 && !obviousRemoval.some((candidate) => candidate.name === row.name))
  .sort((a, b) => a.loads - b.loads || (a.lastLoad || "").localeCompare(b.lastLoad || "") || a.name.localeCompare(b.name));

const topLoaded = rows
  .filter((row) => row.loads > 0)
  .sort((a, b) => b.loads - a.loads || a.name.localeCompare(b.name))
  .slice(0, 35);

const sourceRows = [...bySource.entries()]
  .map(([source, names]) => {
    const loadSum = names.reduce((sum, name) => sum + (loads.get(name) ?? 0), 0);
    const promptSum = names.reduce((sum, name) => sum + (promptPresence.get(name) ?? 0), 0);
    const zero = names.filter((name) => (loads.get(name) ?? 0) === 0 && (promptPresence.get(name) ?? 0) === 0).length;
    const low = names.filter((name) => (loads.get(name) ?? 0) <= 3).length;
    return [source, names.length, loadSum, promptSum, zero, low];
  })
  .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])));

const bundleRows = [...bundleMatches.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([name, count]) => [name, count, (bundleLast.get(name) ?? "").slice(0, 10)]);

const toolRows = [...toolCalls.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 20);

const activeNotAgent = [...activePiSkills].filter((name) => !agentSkills.has(name)).sort();
const agentNotActive = [...agentSkills].filter((name) => !activePiSkills.has(name)).sort();
const nonSkillPi = nonSkillDirs(piSkillsDir);
const nonSkillAgent = nonSkillDirs(agentsSkillsDir);

const lines = [];
lines.push("# Skill usage audit");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Inputs");
lines.push("");
lines.push(mdTable(["Signal", "Count"], [
  ["active `~/.pi/agent/skills` with `SKILL.md`", activePiSkills.size],
  ["installed `~/.agents/skills` with `SKILL.md`", agentSkills.size],
  ["locked external skills", lockedNames.size],
  ["skill-observer files", observerFiles.length],
  ["skill-observer runs", observerRuns],
  ["skill-observer sessions", observerSessions.size],
  ["loaded skill events", loadedSkillEvents],
  ["harness telemetry days", harnessFiles.length],
  ["skill_lookup tool calls", skillLookupCalls],
  ["tool-output-budget compactions", toolOutputCompactions],
  ["skill-bundle telemetry days", bundleFiles.length],
]));
lines.push("");
lines.push("> `loads` means a skill was explicitly loaded/read during a run. `prompt presence` means it was present in the sampled system skill catalog; that is prompt tax, not proof of use, and the harness intentionally caps long skill lists.");
lines.push("");
lines.push("## Strong removal candidates");
lines.push("");
lines.push("Locked external skills with no observer loads that are not active Pi skills and are not valid `~/.agents/skills` installs.");
lines.push("");
lines.push(mdTable(["Skill", "Source", "Active in Pi", "Installed in ~/.agents"], obviousRemoval.map((row) => [row.name, row.source, row.activePi ? "yes" : "no", row.installedAgent ? "yes" : "no"])));
lines.push("");
lines.push("## Low-load review candidates");
lines.push("");
lines.push("These are not automatic removals. Many visible/router skills intentionally shape behavior without explicit loads.");
lines.push("");
lines.push(mdTable(["Skill", "Loads", "Last load", "Prompt presence", "Projects", "Source"], reviewHideOrRemove.slice(0, 60).map((row) => [row.name, row.loads, row.lastLoad.slice(0, 10) || "never", row.promptPresence, row.projects, row.source])));
lines.push("");
lines.push("## Top explicitly loaded skills");
lines.push("");
lines.push(mdTable(["Skill", "Loads", "Last load", "Projects", "Source"], topLoaded.map((row) => [row.name, row.loads, row.lastLoad.slice(0, 10), row.projects, row.source])));
lines.push("");
lines.push("## External source summary");
lines.push("");
lines.push(mdTable(["Source", "Skills", "Load sum", "Prompt presence sum", "Zero signal", "Loads <= 3"], sourceRows));
lines.push("");
lines.push("## Skill-bundle-router matches");
lines.push("");
lines.push(mdTable(["Bundle", "Matches", "Last match"], bundleRows));
lines.push("");
lines.push("## Tool telemetry highlights");
lines.push("");
lines.push(mdTable(["Tool", "Calls"], toolRows));
lines.push("");
lines.push("## Directory hygiene notes");
lines.push("");
lines.push(mdTable(["Check", "Names"], [
  ["Active Pi skills not installed in `~/.agents`", activeNotAgent.join(", ") || "none"],
  ["Installed `~/.agents` skills not active in Pi", agentNotActive.join(", ") || "none"],
  ["Non-skill dirs under `~/.pi/agent/skills`", nonSkillPi.join(", ") || "none"],
  ["Non-skill dirs under `~/.agents/skills`", nonSkillAgent.join(", ") || "none"],
]));
lines.push("");
lines.push("## Suggested policy");
lines.push("");
lines.push("1. Remove locked external skills only from the strong-candidate list, or hide them first if they are part of a bundle you may revive.");
lines.push("2. For large source bundles with high prompt presence but low explicit loads, prefer router/hide cleanup before deletion.");
lines.push("3. Keep `skill-update-checker` report-first; do not use `npx skills update/check` for customized local skills.");
lines.push("4. Keep `zz-harness-telemetry` and `zz-tool-output-budget` enabled while doing cleanup; they are the audit trail and context-spill guardrail.");

console.log(lines.join("\n"));
