#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const home = os.homedir();
const gatewayDir = path.join(home, ".pi", "agent", "telemetry", "skill-gateway");
const harnessDir = path.join(home, ".pi", "agent", "telemetry", "harness");
const minimumLoads = Number(process.env.SKILL_MAINTENANCE_MIN_LOADS || 3);
const failureRateFloor = Number(process.env.SKILL_MAINTENANCE_FAILURE_RATE || 0.3);

function listJsonl(dir) {
  try { return fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(dir, name)); } catch { return []; }
}

function records(dir) {
  const result = [];
  for (const file of listJsonl(dir)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { result.push(JSON.parse(line)); } catch {}
    }
  }
  return result;
}

function inc(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function discoverSkillBodies() {
  const roots = [path.join(home, ".pi", "agent", "skills"), path.join(home, ".agents", "skills")];
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    const queue = [root];
    while (queue.length > 0) {
      const dir = queue.shift();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const skillFile = path.join(dir, "SKILL.md");
      if (dir !== root && fs.existsSync(skillFile)) {
        const text = fs.readFileSync(skillFile, "utf8");
        const name = /^name:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(text)?.[1]?.trim() || path.basename(dir);
        if (!seen.has(name)) {
          seen.add(name);
          result.push({ name, chars: text.length, path: skillFile });
        }
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git") continue;
        const child = path.join(dir, entry.name);
        try { if (fs.statSync(child).isDirectory()) queue.push(child); } catch {}
      }
    }
  }
  return result;
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

const gateway = records(gatewayDir);
const harness = records(harnessDir);
const sessions = new Map();
const state = (sessionId) => {
  if (!sessions.has(sessionId)) sessions.set(sessionId, { loaded: new Set(), recommended: new Set(), searched: 0, failures: 0, toolCalls: 0 });
  return sessions.get(sessionId);
};

const loads = new Map();
const recommendations = new Map();
const loadMisses = new Map();
for (const record of gateway) {
  if (!record.sessionId) continue;
  const session = state(record.sessionId);
  if (record.event === "load" && record.name) {
    session.loaded.add(record.name);
    inc(loads, record.name);
  }
  if (record.event === "load_miss" && record.name) inc(loadMisses, record.name);
  if (record.event === "search") session.searched += 1;
  if (record.event === "route") {
    for (const candidate of record.recommended || []) {
      if (!candidate?.name) continue;
      session.recommended.add(candidate.name);
      inc(recommendations, candidate.name);
    }
  }
}

for (const record of harness) {
  if (!record.sessionId || record.event !== "tool_end") continue;
  const session = state(record.sessionId);
  session.toolCalls += 1;
  if (record.result?.isError) session.failures += 1;
}

const skillOutcomes = new Map();
for (const session of sessions.values()) {
  for (const name of session.loaded) {
    if (!skillOutcomes.has(name)) skillOutcomes.set(name, { sessions: 0, failedSessions: 0, failures: 0, toolCalls: 0 });
    const outcome = skillOutcomes.get(name);
    outcome.sessions += 1;
    outcome.failures += session.failures;
    outcome.toolCalls += session.toolCalls;
    if (session.failures > 0) outcome.failedSessions += 1;
  }
}

const reviewRows = [...skillOutcomes.entries()]
  .map(([name, outcome]) => ({ name, ...outcome, rate: outcome.sessions ? outcome.failedSessions / outcome.sessions : 0 }))
  .filter((row) => row.sessions >= minimumLoads && row.rate >= failureRateFloor)
  .sort((a, b) => b.rate - a.rate || b.sessions - a.sessions)
  .map((row) => [row.name, row.sessions, row.failedSessions, `${Math.round(row.rate * 100)}%`, row.failures, row.toolCalls]);

const routingRows = [...recommendations.entries()]
  .map(([name, count]) => [name, count, loads.get(name) || 0, count ? `${Math.round(((loads.get(name) || 0) / count) * 100)}%` : "0%"])
  .sort((a, b) => Number(b[1]) - Number(a[1]))
  .slice(0, 40);

const loadRows = [...loads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
const oversizedRows = discoverSkillBodies()
  .filter((skill) => skill.chars > 20000)
  .sort((a, b) => b.chars - a.chars)
  .map((skill) => [skill.name, skill.chars, skill.path.replace(home, "~")]);
const missRows = [...loadMisses.entries()].sort((a, b) => b[1] - a[1]);

const lines = [];
lines.push("# Skill maintenance proposals");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("> Evidence report only. It never edits a skill. A failed tool in the same session is correlation, not proof that the loaded skill caused it.");
lines.push("");
lines.push("## Skills meeting the review threshold");
lines.push("");
lines.push(`Threshold: at least ${minimumLoads} loaded sessions and ${Math.round(failureRateFloor * 100)}% of those sessions containing a tool failure.`);
lines.push("");
lines.push(mdTable(["Skill", "Loaded sessions", "Sessions with failures", "Correlated rate", "Failures", "Tool calls"], reviewRows));
lines.push("");
lines.push("## Routing recommendation-to-load signal");
lines.push("");
lines.push(mdTable(["Skill", "Recommended", "Loaded", "Crude conversion"], routingRows));
lines.push("");
lines.push("## Explicit gateway loads");
lines.push("");
lines.push(mdTable(["Skill", "Loads"], loadRows));
lines.push("");
lines.push("## Oversized skill bodies");
lines.push("");
lines.push("Bodies over 20k characters should be reviewed for direct references/scripts. The gateway chunks them safely, but chunking is not a substitute for good progressive disclosure.");
lines.push("");
lines.push(mdTable(["Skill", "Body chars", "Path"], oversizedRows));
lines.push("");
lines.push("## Load misses");
lines.push("");
lines.push(mdTable(["Requested name", "Misses"], missRows));
lines.push("");
lines.push("## Proposal gate");
lines.push("");
lines.push("For every candidate: inspect the actual sessions, identify routing vs instruction vs environment failure, propose replacement/removal text, add or update an eval, and require a review. Do not append an anecdote or auto-apply a generated amendment.");

console.log(lines.join("\n"));
