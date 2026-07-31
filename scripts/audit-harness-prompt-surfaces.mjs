#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const home = os.homedir();
const repo = path.resolve(import.meta.dirname, "..");
const telemetryDir = path.join(home, ".pi", "agent", "telemetry", "skill-gateway");
const savedProbes = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(repo, "config", "harness-prompt-probes.json"), "utf8")).probes || []; } catch { return []; }
})();
const harnesses = [
  ["Pi", "pi", ["--no-extensions", "--version"]],
  ["Claude Code", "claude", ["--version"]],
  ["Codex", "codex", ["--version"]],
  ["Hermes", "hermes", ["--version"]],
  ["OpenClaw", "openclaw", ["--version"]],
];

function files(dir) {
  try { return fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(dir, name)); } catch { return []; }
}

function readRecords() {
  const records = [];
  for (const file of files(telemetryDir)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch {}
    }
  }
  return records;
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000, env: { ...process.env, PI_OFFLINE: "1" } });
  if (result.error?.code === "ENOENT") return "not installed";
  const text = `${result.stdout || ""} ${result.stderr || ""}`
    .trim()
    .replaceAll(home, "~")
    .replace(/\s+/g, " ");
  return text.slice(0, 160) || `exit ${result.status}`;
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

const records = readRecords();
const sessions = new Map();
for (const record of records) {
  if (!record.sessionId) continue;
  if (!sessions.has(record.sessionId)) sessions.set(record.sessionId, {});
  const session = sessions.get(record.sessionId);
  if (record.event === "route") session.route = record;
  if (record.event === "provider_surface") session.provider = record;
}

const measured = [...sessions.values()]
  .filter((session) => session.route && session.provider)
  .sort((a, b) => (b.route.ts || 0) - (a.route.ts || 0));
const promptRows = measured.slice(0, 10).map((session) => [
  session.route.mode,
  session.route.catalogSize,
  session.route.nativeVisibleSkills,
  session.route.activeToolCount,
  session.route.beforeChars,
  session.route.afterChars,
  session.route.strippedChars,
  session.route.recommendationChars,
  session.provider.systemChars,
  session.provider.toolCount,
  session.provider.toolSchemaChars,
]);

let matchedPair;
for (const observe of measured.filter((session) => session.route.mode === "observe")) {
  const routed = measured.find((session) => session.route.mode === "routed"
    && session.route.activeToolCount === observe.route.activeToolCount
    && session.route.beforeChars === observe.route.beforeChars);
  if (routed) { matchedPair = { observe, routed }; break; }
}
const systemSavings = matchedPair
  ? Number(matchedPair.observe.provider.systemChars || 0) - Number(matchedPair.routed.provider.systemChars || 0)
  : undefined;

const routedProfiles = measured.filter((session) => session.route.mode === "routed");
const lean = routedProfiles.find((session) => Number(session.route.activeToolCount) === 8)
  || [...routedProfiles].sort((a, b) => Number(a.provider.toolCount || 0) - Number(b.provider.toolCount || 0))[0];
const widest = [...routedProfiles].sort((a, b) => Number(b.provider.toolCount || 0) - Number(a.provider.toolCount || 0))[0];
const toolSavings = lean && widest
  ? Number(widest.provider.toolSchemaChars || 0) - Number(lean.provider.toolSchemaChars || 0)
  : undefined;

const lines = [];
lines.push("# Harness prompt-surface audit");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Installed harnesses");
lines.push("");
lines.push(mdTable(["Harness", "Version"], harnesses.map(([name, command, args]) => [name, commandVersion(command, args)])));
lines.push("");
lines.push("## Measured Pi provider payloads");
lines.push("");
lines.push("Measurements come from `before_provider_request`; no prompt or user text is retained, only counts. Compare probes using the same model/tool profile.");
lines.push("");
lines.push(mdTable([
  "Mode", "Catalog", "Native visible", "Active tools", "Prompt before", "Prompt after", "Skill chars removed", "Route chars", "Provider system chars", "Provider tools", "Tool schema chars",
], promptRows));
lines.push("");
if (systemSavings !== undefined) lines.push(`A matched observe/routed pair saved **${systemSavings.toLocaleString()} provider-system characters** in routed mode.`);
if (toolSavings !== undefined && lean && widest) lines.push(`The routed lean ${lean.provider.toolCount}-tool surface used **${toolSavings.toLocaleString()} fewer tool-schema characters** than the measured ${widest.provider.toolCount}-tool surface.`);
lines.push("");
lines.push("## Measured non-Pi probes");
lines.push("");
lines.push(mdTable(
  ["Harness", "Model", "System chars/bytes", "Skill chars/bytes", "Skills", "Tool chars/bytes", "Tools", "Input/prompt tokens", "Notes"],
  savedProbes.map((probe) => [
    probe.harness,
    probe.model || "default",
    probe.systemPromptChars || probe.systemPromptBytes || "not exposed",
    probe.skillPromptChars || probe.skillIndexBytes || "not exposed",
    probe.skillCount || "not exposed",
    probe.toolSummaryAndSchemaChars || probe.toolSchemaBytes || "not exposed",
    probe.toolCount || "not exposed",
    probe.promptTokens || probe.effectiveInitialInputTokens || probe.inputTokens || "not exposed",
    probe.notes,
  ]),
));
lines.push("");
lines.push("These probes use each harness's own reporting/usage output. They are not directly comparable across models because providers count cached input and tool schemas differently. Claude and Codex expose total initial usage but not a stable skill-only breakdown; do not infer skill cost from those totals alone.");

console.log(lines.join("\n"));
