#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "help",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "let",
  "lets",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "out",
  "should",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "up",
  "use",
  "using",
  "we",
  "what",
  "when",
  "with",
  "you",
  "your",
]);

const DEFAULT_ROOTS = [
  path.join(homedir(), ".pi", "agent", "skills"),
  path.join(homedir(), ".agents", "skills"),
  path.join(homedir(), ".pi", "agent", "skills-managed", "active"),
];

function discoverSkillFilesFromRoot(root) {
  if (!root || !fs.existsSync(root)) return [];
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  const out = [];
  const ignoreDirs = new Set([".git", "node_modules", ".turbo", "dist", "build"]);
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = fs.statSync(fullPath).isDirectory();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        if (!ignoreDirs.has(entry.name)) stack.push(fullPath);
        continue;
      }

      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase() === "skill.md") {
        try {
          out.push(path.normalize(fs.realpathSync(fullPath)));
        } catch {
          out.push(path.normalize(fullPath));
        }
      }
    }
  }

  return [...new Set(out)].sort();
}

function extractFrontmatter(text) {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return undefined;
  return text.slice(4, end);
}

function parseFrontmatter(text) {
  const frontmatter = extractFrontmatter(text);
  if (!frontmatter) return {};

  const out = {};
  const lines = frontmatter.split("\n");
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }

    const key = match[1];
    const value = match[2];
    if (value === ">" || value === "|") {
      const parts = [];
      i += 1;
      while (i < lines.length) {
        const current = lines[i];
        if (current.startsWith(" ") || current.startsWith("\t") || current === "") {
          parts.push(current.trim());
          i += 1;
          continue;
        }
        break;
      }
      out[key] = parts.filter(Boolean).join(" ").trim();
      continue;
    }

    out[key] = value.trim();
    i += 1;
  }

  return out;
}

function parseTags(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((tag) => tag.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return trimmed ? [trimmed.replace(/^['"]|['"]$/g, "")] : [];
}

function tokenize(input) {
  const normalized = input
    .toLowerCase()
    .replace(/twitter\/x/g, "twitter x")
    .replace(/[\/]/g, " ");

  const roughParts = normalized.match(/[a-z0-9][a-z0-9+-]*/g) || [];
  const tokens = [];
  const seen = new Set();

  const push = (token) => {
    if (token.length <= 1) return;
    if (STOPWORDS.has(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  for (const part of roughParts) {
    push(part);
    for (const subPart of part.split(/[-+]/g)) push(subPart);
  }

  return tokens;
}

function buildEntries() {
  const files = DEFAULT_ROOTS.flatMap((root) => discoverSkillFilesFromRoot(root));
  const entries = [];
  const seenNames = new Set();

  for (const filePath of [...new Set(files)]) {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const frontmatter = parseFrontmatter(text);
    const name = String(frontmatter.name || path.basename(path.dirname(filePath))).replace(/^['"]|['"]$/g, "").toLowerCase();
    if (seenNames.has(name)) continue;
    seenNames.add(name);

    entries.push({
      name,
      description: String(frontmatter.description || "").replace(/^['"]|['"]$/g, "").trim(),
      tags: parseTags(frontmatter.tags),
      hidden: String(frontmatter["disable-model-invocation"] || "").toLowerCase() === "true",
      path: filePath,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function buildTokenDocumentFrequency(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const tokens = new Set([
      ...tokenize(entry.name),
      ...tokenize(entry.description),
      ...entry.tags.flatMap((tag) => tokenize(tag)),
    ]);
    for (const token of tokens) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return counts;
}

function scoreEntry(query, entry, tokenDocumentFrequency, corpusSize) {
  const queryTokens = tokenize(query);
  const nameTokens = tokenize(entry.name);
  const descriptionTokens = tokenize(entry.description);
  const tagTokens = entry.tags.flatMap((tag) => tokenize(tag));
  const nameRaw = entry.name.toLowerCase();
  const descriptionRaw = entry.description.toLowerCase();
  const tagsRaw = entry.tags.join(" ").toLowerCase();
  const fullRaw = `${nameRaw} ${descriptionRaw} ${tagsRaw}`;
  const queryRaw = query.toLowerCase().trim();

  let score = 0;
  const matchedTokens = [];
  const matchedSet = new Set();

  if (queryRaw && fullRaw.includes(queryRaw)) score += 8;
  if (queryRaw && nameRaw.includes(queryRaw)) score += 12;

  for (const token of queryTokens) {
    const documentFrequency = tokenDocumentFrequency.get(token) || 0;
    const idf = Math.log((corpusSize + 1) / (documentFrequency + 1)) + 1;
    let matched = false;

    if (nameTokens.includes(token)) {
      score += 6 * idf;
      matched = true;
    } else if (token.length >= 4 && nameRaw.includes(token)) {
      score += 3 * idf;
      matched = true;
    }

    if (tagTokens.includes(token)) {
      score += 4 * idf;
      matched = true;
    } else if (token.length >= 4 && tagsRaw.includes(token)) {
      score += 2 * idf;
      matched = true;
    }

    if (descriptionTokens.includes(token)) {
      score += 2 * idf;
      matched = true;
    } else if (token.length >= 4 && descriptionRaw.includes(token)) {
      score += 0.75 * idf;
      matched = true;
    }

    if (matched && !matchedSet.has(token)) {
      matchedSet.add(token);
      matchedTokens.push(token);
    }
  }

  const normalizedQuery = queryTokens.join(" ");
  const normalizedCorpus = [...nameTokens, ...tagTokens, ...descriptionTokens].join(" ");
  if (normalizedQuery && normalizedCorpus.includes(normalizedQuery)) score += 6;

  return {
    ...entry,
    score,
    overlapCount: matchedTokens.length,
    matchedTokens,
  };
}

function search(query, entries, tokenDocumentFrequency, includeVisible = false, limit = 3) {
  const candidates = includeVisible ? entries : entries.filter((entry) => entry.hidden);
  const corpusSize = Math.max(candidates.length, 1);
  return candidates
    .map((entry) => scoreEntry(query, entry, tokenDocumentFrequency, corpusSize))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.overlapCount !== a.overlapCount) return b.overlapCount - a.overlapCount;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

function main() {
  const evalPath = process.argv[2] || path.join(process.cwd(), "skill-router-eval.json");
  const rows = JSON.parse(fs.readFileSync(evalPath, "utf8"));
  const entries = buildEntries();
  const tokenDocumentFrequency = buildTokenDocumentFrequency(entries);

  let top1 = 0;
  let top3 = 0;
  const misses = [];
  const rankedRows = [];

  for (const row of rows) {
    const ranked = search(row.task, entries, tokenDocumentFrequency, false, 3);
    const names = ranked.map((entry) => entry.name);
    if (names.some((name, index) => index === 0 && row.correctSkills.includes(name))) top1 += 1;
    if (names.some((name) => row.correctSkills.includes(name))) top3 += 1;
    else misses.push({ id: row.id, task: row.task, predicted: names, correctSkills: row.correctSkills });

    rankedRows.push({
      id: row.id,
      task: row.task,
      correctSkills: row.correctSkills,
      predicted: ranked.map((entry) => ({
        name: entry.name,
        score: Number(entry.score.toFixed(3)),
        matchedTokens: entry.matchedTokens,
      })),
    });
  }

  const summary = {
    evalItems: rows.length,
    indexedSkills: entries.length,
    hiddenSkills: entries.filter((entry) => entry.hidden).length,
    visibleSkills: entries.filter((entry) => !entry.hidden).length,
    top1Precision: top1 / rows.length,
    top3Precision: top3 / rows.length,
    misses,
    rankedRows,
    suggestedAutoInjectionScoreFloor: 30,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
