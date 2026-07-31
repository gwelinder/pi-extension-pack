import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

type Bundle = {
  name: string;
  description: string;
  skills: string[];
  triggers: string[];
  instruction: string;
  filePath: string;
};

type BundleMatch = {
  name: string;
  score: number;
  matchedTriggers: string[];
  skills: string[];
};

const DEFAULT_BUNDLE_DIR = path.join(os.homedir(), ".pi", "agent", "skill-bundles");
const BUNDLE_DIR = process.env.PI_SKILL_BUNDLE_DIR || DEFAULT_BUNDLE_DIR;
const TELEMETRY_DIR = path.join(os.homedir(), ".pi", "agent", "telemetry", "skill-bundles");
const NOTIFY = process.env.PI_SKILL_BUNDLE_ROUTER_NOTIFY === "1";
const MIN_SCORE = Number(process.env.PI_SKILL_BUNDLE_ROUTER_MIN_SCORE || "2");
const MAX_MATCHES = Number(process.env.PI_SKILL_BUNDLE_ROUTER_MAX_MATCHES || "3");

function dayStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function readList(lines: string[], startIndex: number): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!item) break;
    values.push(item[1].replace(/^['"]|['"]$/g, ""));
    index += 1;
  }
  return { values, nextIndex: index };
}

function readBlock(lines: string[], startIndex: number): { value: string; nextIndex: number } {
  const parts: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (/^[a-zA-Z0-9_-]+:\s*/.test(line)) break;
    parts.push(line.replace(/^\s{2}/, ""));
    index += 1;
  }
  return { value: parts.join("\n").trim(), nextIndex: index };
}

function parseBundleYaml(filePath: string): Bundle | null {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const bundle: Bundle = {
    name: path.basename(filePath, path.extname(filePath)),
    description: "",
    skills: [],
    triggers: [],
    instruction: "",
    filePath,
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      index += 1;
      continue;
    }

    const key = match[1];
    const raw = match[2].trim();
    if (key === "skills" || key === "triggers") {
      const result = readList(lines, index + 1);
      bundle[key] = result.values;
      index = result.nextIndex;
      continue;
    }
    if (key === "instruction" && (raw === "|" || raw === ">")) {
      const result = readBlock(lines, index + 1);
      bundle.instruction = result.value;
      index = result.nextIndex;
      continue;
    }
    if (key === "name" || key === "description" || key === "instruction") {
      bundle[key] = raw.replace(/^['"]|['"]$/g, "");
    }
    index += 1;
  }

  if (!bundle.name || !bundle.description || bundle.triggers.length === 0) return null;
  return bundle;
}

function loadBundles(): Bundle[] {
  try {
    if (!fs.existsSync(BUNDLE_DIR)) return [];
    return fs.readdirSync(BUNDLE_DIR)
      .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
      .map((name) => path.join(BUNDLE_DIR, name))
      .map((filePath) => {
        try {
          return parseBundleYaml(filePath);
        } catch {
          return null;
        }
      })
      .filter((bundle): bundle is Bundle => bundle !== null);
  } catch {
    return [];
  }
}

function scoreBundle(prompt: string, bundle: Bundle): BundleMatch | null {
  const text = prompt.toLowerCase();
  const matchedTriggers = bundle.triggers.filter((trigger) => {
    const normalized = trigger.toLowerCase();
    if (normalized.includes(" ")) return text.includes(normalized);
    return new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
  });
  if (matchedTriggers.length === 0) return null;
  const score = matchedTriggers.reduce((sum, trigger) => sum + (trigger.includes(" ") ? 2 : 1), 0);
  if (score < MIN_SCORE) return null;
  return {
    name: bundle.name,
    score,
    matchedTriggers,
    skills: bundle.skills,
  };
}

function matchBundles(prompt: string): BundleMatch[] {
  return loadBundles()
    .map((bundle) => scoreBundle(prompt, bundle))
    .filter((match): match is BundleMatch => match !== null)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_MATCHES);
}

function sessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

function writeTelemetry(ctx: ExtensionContext, prompt: string, matches: BundleMatch[]): void {
  try {
    const now = new Date();
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    const record = {
      ts: now.getTime(),
      iso: now.toISOString(),
      source: "skill-bundle-router",
      mode: "dry-run",
      sessionId: sessionId(ctx),
      cwd: ctx.cwd,
      promptHash: hashText(prompt),
      promptChars: prompt.length,
      matches,
    };
    fs.appendFileSync(path.join(TELEMETRY_DIR, `${dayStamp(now)}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Dry-run telemetry must never affect the agent loop.
  }
}

export default function skillBundleRouter(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const prompt = String(event.prompt || "").trim();
    if (!prompt) return;
    const matches = matchBundles(prompt);
    if (matches.length === 0) return;
    writeTelemetry(ctx, prompt, matches);
    if (NOTIFY) {
      ctx.ui.notify(`skill-bundle dry-run: ${matches.map((match) => match.name).join(", ")}`, "info");
    }
  });
}
