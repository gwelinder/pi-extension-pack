#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const skipDirs = new Set([".git", "node_modules", ".cx", ".pi", "sessions", "session-notebooks", "logs", "cache", "generated-images", ".codex-ui-design", ".codex-imagegen"]);
const blockedBasenames = new Set(["auth.json", "settings.json", "cloudflare-codemode.json", ".env"]);
const allowedExample = /(^|[./-])example\.(json|env|md)$/i;

const secretPatterns = [
  { name: "OpenAI-style API key", re: /sk-[A-Za-z0-9_-]{32,}/g },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{32,}/g },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9_]{30,}/g },
  { name: "Cloudflare token assignment", re: /(?:CF_[A-Z0-9_]*TOKEN|CLOUDFLARE_API_TOKEN|token)\s*[:=]\s*["']?[A-Za-z0-9_-]{35,}["']?/gi },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") && ent.name !== ".gitignore") {
      if (ent.isDirectory() && skipDirs.has(ent.name)) continue;
    }
    const p = path.join(dir, ent.name);
    const rel = path.relative(repo, p);
    if (ent.isDirectory()) {
      if (skipDirs.has(ent.name)) continue;
      walk(p, out);
    } else if (ent.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function isBinary(buf) {
  return buf.subarray(0, Math.min(buf.length, 8000)).includes(0);
}

const findings = [];
for (const rel of walk(repo)) {
  const base = path.basename(rel);
  if (blockedBasenames.has(base) && !allowedExample.test(rel)) {
    findings.push(`${rel}: blocked secret/config filename`);
    continue;
  }
  const abs = path.join(repo, rel);
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) continue;
  const text = buf.toString("utf8");
  for (const { name, re } of secretPatterns) {
    re.lastIndex = 0;
    if (re.test(text)) findings.push(`${rel}: ${name}`);
  }
}

if (findings.length) {
  console.error("Potential secrets/config snapshots found:\n" + findings.map((f) => `- ${f}`).join("\n"));
  process.exit(1);
}
console.log("No obvious secrets found.");
