import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from",
  "help", "how", "i", "in", "into", "is", "it", "let", "lets", "me", "my", "of", "on",
  "or", "our", "out", "should", "that", "the", "their", "them", "this", "to", "up", "use",
  "using", "we", "what", "when", "with", "you", "your",
]);

export function tokenize(input) {
  const normalized = String(input || "").toLowerCase().replace(/twitter\/x/g, "twitter x").replace(/[\/]/g, " ");
  const rough = normalized.match(/[a-z0-9][a-z0-9+.-]*/g) || [];
  const result = [];
  const seen = new Set();
  const add = (token) => {
    const clean = token.replace(/^\.+|\.+$/g, "");
    if (clean.length <= 1 || STOPWORDS.has(clean) || seen.has(clean)) return;
    seen.add(clean);
    result.push(clean);
  };
  for (const part of rough) {
    add(part);
    for (const sub of part.split(/[-+.]/g)) add(sub);
  }
  return result;
}

export function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return {};
  const lines = text.slice(4, end).split("\n");
  const out = {};
  let index = 0;
  while (index < lines.length) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
    if (!match) { index += 1; continue; }
    const [, key, raw] = match;
    if (raw === ">" || raw === "|") {
      const parts = [];
      index += 1;
      while (index < lines.length && (/^\s/.test(lines[index]) || lines[index] === "")) {
        parts.push(lines[index].trim());
        index += 1;
      }
      out[key] = parts.filter(Boolean).join(" ");
      continue;
    }
    const parts = [raw.trim()];
    index += 1;
    while (index < lines.length && /^\s+\S/.test(lines[index])) {
      parts.push(lines[index].trim());
      index += 1;
    }
    out[key] = parts.join(" ").trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

export function parseTags(raw) {
  if (!raw) return [];
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((tag) => tag.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  return [trimmed.replace(/^['"]|['"]$/g, "")].filter(Boolean);
}

export function entryFromSkill(skill) {
  let tags = [];
  let mtimeMs = 0;
  try {
    const text = fs.readFileSync(skill.filePath, "utf8");
    const metadata = parseFrontmatter(text);
    tags = parseTags(metadata.tags);
    mtimeMs = fs.statSync(skill.filePath).mtimeMs;
  } catch {}
  return {
    name: skill.name,
    description: skill.description || "",
    filePath: skill.filePath,
    baseDir: skill.baseDir || path.dirname(skill.filePath),
    tags,
    mtimeMs,
    sourceScope: skill.sourceInfo?.scope || "unknown",
    sourceOrigin: skill.sourceInfo?.origin || "unknown",
  };
}

function discoverSkillFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    if (dir !== root && entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      files.push(path.join(dir, "SKILL.md"));
      continue;
    }
    if (dir === root) {
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !["readme.md", "license.md", "changelog.md"].includes(entry.name.toLowerCase())) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try { isDirectory = fs.statSync(full).isDirectory(); } catch { continue; }
      }
      if (isDirectory) queue.push(full);
    }
  }
  return files;
}

export function skillRootsForCwd(cwd) {
  const projectRoots = [];
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    for (const rel of [path.join(".pi", "skills"), path.join(".agents", "skills")]) {
      const candidate = path.join(current, rel);
      if (fs.existsSync(candidate)) projectRoots.push(candidate);
    }
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [
    ...projectRoots,
    path.join(os.homedir(), ".pi", "agent", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
}

export function fallbackCatalog(roots = skillRootsForCwd(process.cwd())) {
  const entries = [];
  const seen = new Set();
  for (const root of roots) {
    for (const filePath of discoverSkillFiles(root)) {
      let text = "";
      try { text = fs.readFileSync(filePath, "utf8"); } catch { continue; }
      const metadata = parseFrontmatter(text);
      const name = metadata.name || path.basename(path.dirname(filePath));
      if (!name || !metadata.description || seen.has(name)) continue;
      seen.add(name);
      entries.push({
        name,
        description: metadata.description,
        filePath,
        baseDir: path.dirname(filePath),
        tags: parseTags(metadata.tags),
        mtimeMs: fs.statSync(filePath).mtimeMs,
        sourceScope: "user",
        sourceOrigin: "fallback",
      });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function searchCatalog(query, entries, limit = 5, policy = {}) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const documentFrequency = new Map();
  for (const entry of entries) {
    const aliases = policy.skillAliases?.[entry.name] || [];
    const tokens = new Set([...tokenize(entry.name), ...tokenize(entry.description), ...entry.tags.flatMap(tokenize), ...aliases.flatMap(tokenize)]);
    for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const corpusSize = Math.max(entries.length, 1);
  const bundle = matchBundle(query, policy.bundles || []);
  return entries.map((entry) => {
    const aliases = policy.skillAliases?.[entry.name] || [];
    const nameTokens = tokenize(entry.name);
    const descriptionTokens = tokenize(entry.description);
    const tagTokens = [...entry.tags, ...aliases].flatMap(tokenize);
    const nameRaw = entry.name.toLowerCase();
    const descriptionRaw = entry.description.toLowerCase();
    const tagRaw = [...entry.tags, ...aliases].join(" ").toLowerCase();
    const allRaw = `${nameRaw} ${descriptionRaw} ${tagRaw}`;
    const queryRaw = String(query).toLowerCase().trim();
    let score = 0;
    const matchedTokens = [];
    if (allRaw.includes(queryRaw)) score += 8;
    if (nameRaw.includes(queryRaw)) score += 12;
    for (const token of queryTokens) {
      const idf = Math.log((corpusSize + 1) / ((documentFrequency.get(token) || 0) + 1)) + 1;
      let matched = false;
      if (nameTokens.includes(token)) { score += 6 * idf; matched = true; }
      else if (token.length >= 4 && nameRaw.includes(token)) { score += 3 * idf; matched = true; }
      if (tagTokens.includes(token)) { score += 4 * idf; matched = true; }
      else if (token.length >= 4 && tagRaw.includes(token)) { score += 2 * idf; matched = true; }
      if (descriptionTokens.includes(token)) { score += 2 * idf; matched = true; }
      else if (token.length >= 4 && descriptionRaw.includes(token)) { score += 0.75 * idf; matched = true; }
      if (matched) matchedTokens.push(token);
    }
    if (bundle?.skills?.includes(entry.name)) score += bundle.score * 2.5;
    return { ...entry, score, matchedTokens: [...new Set(matchedTokens)], bundle: bundle?.name };
  }).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.matchedTokens.length - a.matchedTokens.length || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(12, limit)));
}

export function matchBundle(prompt, bundles) {
  const text = String(prompt || "").toLowerCase();
  const matches = [];
  for (const bundle of bundles) {
    const matchedTriggers = (bundle.triggers || []).filter((trigger) => {
      const normalized = trigger.toLowerCase();
      if (normalized.includes(" ")) return text.includes(normalized);
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`).test(text);
    });
    if (matchedTriggers.length === 0) continue;
    const score = matchedTriggers.reduce((sum, trigger) => sum + (trigger.includes(" ") ? 2 : 1), 0);
    matches.push({ ...bundle, score, matchedTriggers });
  }
  return matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))[0] || null;
}

export function loadSkill(name, entries) {
  const normalized = String(name || "").trim().toLowerCase().replace(/^skill:/, "");
  const entry = entries.find((candidate) => candidate.name.toLowerCase() === normalized);
  if (!entry) return null;
  const text = fs.readFileSync(entry.filePath, "utf8");
  return { ...entry, text };
}

export function truncate(text, maxChars) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars - 1).trim()}…`;
}
