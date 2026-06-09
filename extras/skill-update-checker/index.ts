import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const AGENT_DIR = resolve(homedir(), ".pi", "agent");
const ROOT_DIR = resolve(AGENT_DIR, "safe-skill-updates");
const RUNS_DIR = resolve(ROOT_DIR, "runs");
const BASELINES_DIR = resolve(ROOT_DIR, "baselines");
const STATE_PATH = resolve(ROOT_DIR, "state.json");
const GLOBAL_SKILLS_LOCK = resolve(homedir(), ".agents", ".skill-lock.json");
const GLOBAL_SKILLS_ROOT = resolve(homedir(), ".agents", "skills");
const GLOBAL_CONFIG_PATH = resolve(AGENT_DIR, "safe-skill-updates.json");
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const IGNORED_FILES = new Set([".DS_Store", "metadata.json"]);
const IGNORED_DIRS = new Set([".git", "__pycache__", "__pypackages__", "node_modules"]);

type Scope = "global" | "project";

type RawLockEntry = {
  source?: string;
  sourceType?: string;
  sourceUrl?: string;
  ref?: string;
  skillPath?: string;
  skillFolderHash?: string;
  computedHash?: string;
  installedAt?: string;
  updatedAt?: string;
  pluginName?: string;
};

type SkillEntry = {
  scope: Scope;
  name: string;
  lockPath: string;
  liveDir: string;
  source: string;
  sourceType: string;
  sourceUrl: string;
  ref?: string;
  skillPath?: string;
  skillFolderPath?: string;
  baseTreeSha?: string;
  raw: RawLockEntry;
};

type SnapshotFile = {
  path: string;
  gitSha: string;
  sha256?: string;
  size?: number;
  mode?: string;
  kind?: "text" | "binary";
  contentBase64?: string;
};

type RemoteSource = {
  owner: string;
  repo: string;
  defaultBranch: string;
  tree: GitHubTreeItem[];
};

type GitHubTreeItem = {
  path: string;
  mode: string;
  type: "blob" | "tree" | string;
  sha: string;
  size?: number;
};

type FileAction =
  | "none"
  | "use_upstream"
  | "add_upstream"
  | "preserve_local"
  | "clean_merge"
  | "conflict"
  | "needs_delete_approval";

type FilePlan = {
  path: string;
  case: string;
  action: FileAction;
  safe: boolean;
  mergeable?: boolean;
  reason: string;
  baseSha?: string;
  localSha?: string;
  upstreamSha?: string;
  upstreamContentBase64?: string;
  mergedContentBase64?: string;
  conflictPath?: string;
};

type SkillPlan = {
  name: string;
  scope: Scope;
  source: string;
  sourceUrl: string;
  ref?: string;
  liveDir: string;
  lockPath: string;
  skillPath?: string;
  skillFolderPath?: string;
  baseTreeSha?: string;
  latestTreeSha?: string;
  status:
    | "up_to_date"
    | "clean_updates"
    | "mergeable"
    | "conflicts"
    | "needs_adoption"
    | "fetch_error"
    | "local_missing";
  summary: {
    totalFiles: number;
    changedFiles: number;
    cleanActions: number;
    mergeableActions: number;
    conflicts: number;
    localOnly: number;
    localEdits: number;
    upstreamDeletes: number;
  };
  files: FilePlan[];
  localManifest: Record<string, string>;
  error?: string;
};

type Plan = {
  version: 1;
  id: string;
  createdAt: string;
  cwd: string;
  args: string;
  runDir: string;
  summary: {
    checked: number;
    upToDate: number;
    cleanUpdates: number;
    mergeable: number;
    conflicts: number;
    needsAdoption: number;
    errors: number;
    localMissing: number;
  };
  skills: SkillPlan[];
};

type State = {
  version: 1;
  lastRunId?: string;
  lastScanAt?: string;
  lastSummary?: Plan["summary"];
  lastApplyAt?: string;
  lastApplyRunId?: string;
  reminders?: Array<{ at: string; runId: string; message: string }>;
};

type Config = {
  scanOnStartup?: boolean;
  include?: string[];
  exclude?: string[];
};

type ParsedArgs = {
  filters: string[];
  scope: "global" | "project" | "both";
  limit?: number;
  includeUpToDate: boolean;
  includeMergeable: boolean;
  cleanOnly: boolean;
};

const repoTreeCache = new Map<string, Promise<RemoteSource>>();
const treeCache = new Map<string, Promise<GitHubTreeItem[]>>();
const blobCache = new Map<string, Promise<Buffer>>();
let cachedGitHubToken: string | undefined | null;

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function isoNow(): string {
  return new Date().toISOString();
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadState(): State {
  return { version: 1, ...(readJson<State>(STATE_PATH) || {}) };
}

function saveState(state: State): void {
  writeJson(STATE_PATH, state);
}

function loadConfig(cwd: string): Config {
  const global = readJson<Config>(GLOBAL_CONFIG_PATH) || {};
  const project = readJson<Config>(resolve(cwd, ".pi", "safe-skill-updates.json")) || {};
  return {
    ...global,
    ...project,
    include: [...(global.include || []), ...(project.include || [])],
    exclude: [...(global.exclude || []), ...(project.exclude || [])],
  };
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function gitBlobSha(buf: Buffer): string {
  return createHash("sha1").update(Buffer.from(`blob ${buf.length}\0`)).update(buf).digest("hex");
}

function looksText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  if (buf.length > MAX_TEXT_BYTES) return false;
  return !buf.toString("utf8").includes("�");
}

function isIgnoredRelPath(relPath: string): boolean {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => IGNORED_DIRS.has(part))) return true;
  return parts.some((part) => IGNORED_FILES.has(part));
}

function sanitizeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "item";
}

function runId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z")}-${randomBytes(3).toString("hex")}`;
}

function parseCommandArgs(args: string | undefined): ParsedArgs {
  const tokens = (args || "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const parsed: ParsedArgs = {
    filters: [],
    scope: "global",
    includeUpToDate: false,
    includeMergeable: false,
    cleanOnly: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--scope") {
      const scope = tokens[++i] as ParsedArgs["scope"] | undefined;
      if (scope === "global" || scope === "project" || scope === "both") parsed.scope = scope;
      continue;
    }
    if (token.startsWith("--scope=")) {
      const scope = token.slice("--scope=".length) as ParsedArgs["scope"];
      if (scope === "global" || scope === "project" || scope === "both") parsed.scope = scope;
      continue;
    }
    if (token === "--limit") {
      const n = Number(tokens[++i]);
      if (Number.isFinite(n) && n > 0) parsed.limit = Math.floor(n);
      continue;
    }
    if (token.startsWith("--limit=")) {
      const n = Number(token.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) parsed.limit = Math.floor(n);
      continue;
    }
    if (token === "--include-up-to-date") {
      parsed.includeUpToDate = true;
      continue;
    }
    if (token === "--include-mergeable") {
      parsed.includeMergeable = true;
      continue;
    }
    if (token === "--clean-only") {
      parsed.cleanOnly = true;
      continue;
    }
    if (!token.startsWith("--")) parsed.filters.push(token);
  }

  return parsed;
}

function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function matchesFilters(entry: SkillEntry, filters: string[], config: Config): boolean {
  const include = config.include || [];
  const exclude = config.exclude || [];
  const hay = [entry.name, entry.source, entry.sourceUrl].join(" ");
  if (exclude.some((p) => globMatch(entry.name, p) || hay.toLowerCase().includes(p.toLowerCase()))) return false;
  if (filters.length > 0 && !filters.some((p) => globMatch(entry.name, p) || entry.name.toLowerCase() === p.toLowerCase())) return false;
  if (include.length === 0) return true;
  return include.some((p) => globMatch(entry.name, p) || hay.toLowerCase().includes(p.toLowerCase()));
}

function dirnamePosix(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return "";
  return path.slice(0, idx);
}

function normalizeSourceUrl(entry: RawLockEntry): string {
  if (entry.sourceUrl) return entry.sourceUrl;
  if (entry.source?.includes("/")) return `https://github.com/${entry.source}.git`;
  return entry.source || "";
}

function loadGlobalEntries(): SkillEntry[] {
  const lock = readJson<{ skills?: Record<string, RawLockEntry> }>(GLOBAL_SKILLS_LOCK);
  const skills = lock?.skills || {};
  return Object.entries(skills).map(([name, raw]) => ({
    scope: "global" as const,
    name,
    lockPath: GLOBAL_SKILLS_LOCK,
    liveDir: resolve(GLOBAL_SKILLS_ROOT, name),
    source: raw.source || "",
    sourceType: raw.sourceType || "",
    sourceUrl: normalizeSourceUrl(raw),
    ref: raw.ref,
    skillPath: raw.skillPath,
    skillFolderPath: raw.skillPath ? dirnamePosix(raw.skillPath) : undefined,
    baseTreeSha: raw.skillFolderHash,
    raw,
  }));
}

function loadProjectEntries(cwd: string): SkillEntry[] {
  const lockPath = resolve(cwd, "skills-lock.json");
  const lock = readJson<{ skills?: Record<string, RawLockEntry> }>(lockPath);
  const skills = lock?.skills || {};
  return Object.entries(skills).map(([name, raw]) => ({
    scope: "project" as const,
    name,
    lockPath,
    liveDir: resolve(cwd, ".agents", "skills", name),
    source: raw.source || "",
    sourceType: raw.sourceType || "",
    sourceUrl: normalizeSourceUrl(raw),
    ref: raw.ref,
    skillPath: raw.skillPath,
    skillFolderPath: raw.skillPath ? dirnamePosix(raw.skillPath) : undefined,
    baseTreeSha: raw.skillFolderHash,
    raw,
  }));
}

function discoverEntries(cwd: string, parsed: ParsedArgs): SkillEntry[] {
  const entries: SkillEntry[] = [];
  if (parsed.scope === "global" || parsed.scope === "both") entries.push(...loadGlobalEntries());
  if (parsed.scope === "project" || parsed.scope === "both") entries.push(...loadProjectEntries(cwd));
  return entries;
}

function parseGitHubRepo(entry: SkillEntry): { owner: string; repo: string } | undefined {
  const candidates = [entry.sourceUrl, entry.source];
  for (const raw of candidates) {
    if (!raw) continue;
    let match = raw.match(/github\.com[:/]([^/]+)\/([^/#.]+)(?:\.git)?/i);
    if (match) return { owner: match[1]!, repo: match[2]!.replace(/\.git$/i, "") };
    match = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (match) return { owner: match[1]!, repo: match[2]! };
  }
  return undefined;
}

async function githubJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pi-safe-skill-updater",
  };
  const token = getGitHubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function getGitHubToken(): string | undefined {
  if (cachedGitHubToken !== undefined) return cachedGitHubToken || undefined;
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken?.trim()) {
    cachedGitHubToken = envToken.trim();
    return cachedGitHubToken;
  }
  try {
    cachedGitHubToken = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    cachedGitHubToken = null;
  }
  return cachedGitHubToken || undefined;
}

async function fetchRepoSource(owner: string, repo: string, ref?: string): Promise<RemoteSource> {
  const key = `${owner}/${repo}@${ref || "default"}`;
  if (!repoTreeCache.has(key)) {
    repoTreeCache.set(key, (async () => {
      const repoMeta = await githubJson<{ default_branch?: string }>(`https://api.github.com/repos/${owner}/${repo}`);
      const defaultBranch = ref || repoMeta.default_branch || "main";
      const tree = await githubJson<{ tree?: GitHubTreeItem[]; truncated?: boolean }>(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      );
      if (!Array.isArray(tree.tree)) throw new Error(`No GitHub tree for ${owner}/${repo}`);
      if (tree.truncated) throw new Error(`GitHub tree truncated for ${owner}/${repo}`);
      return { owner, repo, defaultBranch, tree: tree.tree };
    })());
  }
  return repoTreeCache.get(key)!;
}

async function fetchTreeBySha(owner: string, repo: string, treeSha: string): Promise<GitHubTreeItem[]> {
  const key = `${owner}/${repo}:${treeSha}`;
  if (!treeCache.has(key)) {
    treeCache.set(key, (async () => {
      const tree = await githubJson<{ tree?: GitHubTreeItem[]; truncated?: boolean }>(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
      );
      if (!Array.isArray(tree.tree)) throw new Error(`No GitHub tree for ${owner}/${repo}@${treeSha}`);
      if (tree.truncated) throw new Error(`GitHub tree truncated for ${owner}/${repo}@${treeSha}`);
      return tree.tree;
    })());
  }
  return treeCache.get(key)!;
}

async function fetchBlob(owner: string, repo: string, sha: string): Promise<Buffer> {
  const key = `${owner}/${repo}:${sha}`;
  if (!blobCache.has(key)) {
    blobCache.set(key, (async () => {
      const blob = await githubJson<{ content?: string; encoding?: string }>(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`);
      if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`Unsupported blob encoding for ${sha}`);
      return Buffer.from(blob.content.replace(/\s+/g, ""), "base64");
    })());
  }
  return blobCache.get(key)!;
}

function remoteSnapshotFromTree(tree: GitHubTreeItem[], prefix = ""): { treeSha?: string; files: Map<string, SnapshotFile> } {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  let treeSha: string | undefined;
  const files = new Map<string, SnapshotFile>();

  for (const item of tree) {
    const p = item.path.replace(/\\/g, "/");
    if (normalizedPrefix) {
      if (p === normalizedPrefix && item.type === "tree") {
        treeSha = item.sha;
        continue;
      }
      if (!p.startsWith(`${normalizedPrefix}/`)) continue;
    }
    const rel = normalizedPrefix ? p.slice(normalizedPrefix.length + 1) : p;
    if (!rel || isIgnoredRelPath(rel)) continue;
    if (item.type !== "blob") continue;
    files.set(rel, {
      path: rel,
      gitSha: item.sha,
      size: item.size,
      mode: item.mode,
    });
  }

  return { treeSha, files };
}

function localSnapshot(dir: string): Map<string, SnapshotFile> {
  const out = new Map<string, SnapshotFile>();
  if (!existsSync(dir)) return out;

  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const rel = relative(dir, absolute).split(sep).join("/");
      if (isIgnoredRelPath(rel)) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const buf = readFileSync(absolute);
      const text = looksText(buf);
      out.set(rel, {
        path: rel,
        gitSha: gitBlobSha(buf),
        sha256: sha256(buf),
        size: buf.length,
        kind: text ? "text" : "binary",
        contentBase64: text ? buf.toString("base64") : undefined,
      });
    }
  };

  visit(dir);
  return out;
}

function manifest(snapshot: Map<string, SnapshotFile>): Record<string, string> {
  return Object.fromEntries([...snapshot.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, f]) => [p, f.gitSha]));
}

function sameManifest(current: Map<string, SnapshotFile>, expected: Record<string, string>): string[] {
  const currentManifest = manifest(current);
  const paths = new Set([...Object.keys(currentManifest), ...Object.keys(expected)]);
  const changed: string[] = [];
  for (const p of paths) {
    if (currentManifest[p] !== expected[p]) changed.push(p);
  }
  return changed;
}

function decodeText(base64: string | undefined): string | undefined {
  if (!base64) return undefined;
  return Buffer.from(base64, "base64").toString("utf8");
}

async function remoteContent(owner: string, repo: string, file?: SnapshotFile): Promise<{ contentBase64?: string; kind?: "text" | "binary" }> {
  if (!file) return {};
  const buf = await fetchBlob(owner, repo, file.gitSha);
  const kind = looksText(buf) ? "text" : "binary";
  return { contentBase64: kind === "text" ? buf.toString("base64") : buf.toString("base64"), kind };
}

async function tryCleanMerge(pi: ExtensionAPI, baseText: string, localText: string, upstreamText: string): Promise<string | undefined> {
  const tmp = join(tmpdir(), `pi-skill-merge-${randomBytes(4).toString("hex")}`);
  ensureDir(tmp);
  const base = join(tmp, "base");
  const local = join(tmp, "local");
  const upstream = join(tmp, "upstream");
  try {
    writeFileSync(base, baseText, "utf8");
    writeFileSync(local, localText, "utf8");
    writeFileSync(upstream, upstreamText, "utf8");
    const result = await pi.exec("git", ["merge-file", "-p", local, base, upstream], { timeout: 5000 });
    if (result.code === 0 && !result.stdout.includes("<<<<<<<")) return result.stdout;
    return undefined;
  } catch {
    return undefined;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function conflictArtifact(runDir: string, skill: string, relPath: string, sections: Record<string, string | undefined>): Promise<string> {
  const conflictPath = join(runDir, "conflicts", sanitizeSegment(skill), `${relPath.split("/").map(sanitizeSegment).join("__")}.diff3.md`);
  ensureDir(dirname(conflictPath));
  const body = [
    `# Conflict: ${skill} / ${relPath}`,
    "",
    "## Base",
    "```",
    sections.base || "(missing/binary)",
    "```",
    "",
    "## Local",
    "```",
    sections.local || "(missing/binary)",
    "```",
    "",
    "## Upstream",
    "```",
    sections.upstream || "(missing/binary)",
    "```",
    "",
  ].join("\n");
  writeFileSync(conflictPath, body, "utf8");
  return conflictPath;
}

async function classifyFile(
  pi: ExtensionAPI,
  runDir: string,
  entry: SkillEntry,
  owner: string,
  repo: string,
  relPath: string,
  base: SnapshotFile | undefined,
  local: SnapshotFile | undefined,
  upstream: SnapshotFile | undefined,
): Promise<FilePlan> {
  const baseSha = base?.gitSha;
  const localSha = local?.gitSha;
  const upstreamSha = upstream?.gitSha;

  const common = { path: relPath, baseSha, localSha, upstreamSha };

  if (baseSha === localSha && localSha === upstreamSha) {
    return { ...common, case: "unchanged", action: "none", safe: true, reason: "No changes" };
  }

  if (!base && !local && upstream) {
    const content = await remoteContent(owner, repo, upstream);
    return { ...common, case: "upstream_new", action: "add_upstream", safe: true, reason: "New upstream file", upstreamContentBase64: content.contentBase64 };
  }

  if (!base && local && !upstream) {
    return { ...common, case: "local_only", action: "preserve_local", safe: true, reason: "Local-only file is preserved" };
  }

  if (!base && local && upstream) {
    if (localSha === upstreamSha) return { ...common, case: "same_new_file", action: "none", safe: true, reason: "Local and upstream independently have the same new file" };
    const up = await remoteContent(owner, repo, upstream);
    const conflictPath = await conflictArtifact(runDir, entry.name, relPath, {
      local: decodeText(local.contentBase64),
      upstream: up.kind === "text" ? decodeText(up.contentBase64) : undefined,
    });
    return { ...common, case: "local_and_upstream_new_differ", action: "conflict", safe: false, reason: "Local and upstream both added different files", conflictPath };
  }

  if (base && local && !upstream) {
    if (localSha === baseSha) {
      return { ...common, case: "upstream_delete_local_unchanged", action: "needs_delete_approval", safe: false, reason: "Upstream deleted a file; deletion requires explicit approval" };
    }
    const baseContent = await remoteContent(owner, repo, base);
    const conflictPath = await conflictArtifact(runDir, entry.name, relPath, {
      base: baseContent.kind === "text" ? decodeText(baseContent.contentBase64) : undefined,
      local: decodeText(local.contentBase64),
    });
    return { ...common, case: "upstream_delete_local_edited", action: "conflict", safe: false, reason: "Upstream deleted a locally edited file", conflictPath };
  }

  if (base && !local && upstream) {
    if (upstreamSha === baseSha) return { ...common, case: "local_delete_upstream_unchanged", action: "preserve_local", safe: true, reason: "Local deletion is preserved" };
    const baseContent = await remoteContent(owner, repo, base);
    const up = await remoteContent(owner, repo, upstream);
    const conflictPath = await conflictArtifact(runDir, entry.name, relPath, {
      base: baseContent.kind === "text" ? decodeText(baseContent.contentBase64) : undefined,
      upstream: up.kind === "text" ? decodeText(up.contentBase64) : undefined,
    });
    return { ...common, case: "local_delete_upstream_edited", action: "conflict", safe: false, reason: "Local deleted a file that upstream edited", conflictPath };
  }

  if (base && local && upstream) {
    if (localSha === baseSha && upstreamSha !== baseSha) {
      const up = await remoteContent(owner, repo, upstream);
      return { ...common, case: "upstream_only_edit", action: "use_upstream", safe: true, reason: "Local matches base; upstream edit is safe", upstreamContentBase64: up.contentBase64 };
    }
    if (upstreamSha === baseSha && localSha !== baseSha) {
      return { ...common, case: "local_only_edit", action: "preserve_local", safe: true, reason: "Upstream unchanged; local edit is preserved" };
    }
    if (localSha === upstreamSha) {
      return { ...common, case: "both_changed_same", action: "none", safe: true, reason: "Local and upstream already match" };
    }

    const [baseContent, up] = await Promise.all([remoteContent(owner, repo, base), remoteContent(owner, repo, upstream)]);
    const localText = decodeText(local.contentBase64);
    const baseText = baseContent.kind === "text" ? decodeText(baseContent.contentBase64) : undefined;
    const upstreamText = up.kind === "text" ? decodeText(up.contentBase64) : undefined;
    if (baseText !== undefined && localText !== undefined && upstreamText !== undefined) {
      const merged = await tryCleanMerge(pi, baseText, localText, upstreamText);
      if (merged !== undefined) {
        return {
          ...common,
          case: "clean_text_merge",
          action: "clean_merge",
          safe: true,
          mergeable: true,
          reason: "Local and upstream both changed; git merge-file produced a clean merge",
          mergedContentBase64: Buffer.from(merged, "utf8").toString("base64"),
        };
      }
    }
    const conflictPath = await conflictArtifact(runDir, entry.name, relPath, {
      base: baseText,
      local: localText,
      upstream: upstreamText,
    });
    return { ...common, case: "both_changed_conflict", action: "conflict", safe: false, reason: "Local and upstream both changed", conflictPath };
  }

  return { ...common, case: "unknown", action: "conflict", safe: false, reason: "Unhandled file state" };
}

function summarizeSkill(entry: SkillEntry, files: FilePlan[], latestTreeSha?: string): SkillPlan["summary"] {
  return {
    totalFiles: files.length,
    changedFiles: files.filter((f) => f.action !== "none").length,
    cleanActions: files.filter((f) => f.action === "use_upstream" || f.action === "add_upstream").length,
    mergeableActions: files.filter((f) => f.action === "clean_merge").length,
    conflicts: files.filter((f) => f.action === "conflict").length,
    localOnly: files.filter((f) => f.case === "local_only").length,
    localEdits: files.filter((f) => f.case === "local_only_edit" || f.case === "clean_text_merge" || f.case === "both_changed_conflict").length,
    upstreamDeletes: files.filter((f) => f.action === "needs_delete_approval" || f.case.startsWith("upstream_delete")).length,
  };
}

function statusFromSummary(summary: SkillPlan["summary"], baseTreeSha?: string, latestTreeSha?: string): SkillPlan["status"] {
  if (summary.conflicts > 0 || summary.upstreamDeletes > 0) return "conflicts";
  if (summary.mergeableActions > 0) return "mergeable";
  if (summary.cleanActions > 0) return "clean_updates";
  if (baseTreeSha && latestTreeSha && baseTreeSha !== latestTreeSha) return "clean_updates";
  return "up_to_date";
}

async function planSkill(pi: ExtensionAPI, runDir: string, entry: SkillEntry): Promise<SkillPlan> {
  if (!existsSync(entry.liveDir)) {
    return {
      name: entry.name,
      scope: entry.scope,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      ref: entry.ref,
      liveDir: entry.liveDir,
      lockPath: entry.lockPath,
      skillPath: entry.skillPath,
      skillFolderPath: entry.skillFolderPath,
      baseTreeSha: entry.baseTreeSha,
      status: "local_missing",
      summary: { totalFiles: 0, changedFiles: 0, cleanActions: 0, mergeableActions: 0, conflicts: 0, localOnly: 0, localEdits: 0, upstreamDeletes: 0 },
      files: [],
      localManifest: {},
      error: `Missing live directory: ${entry.liveDir}`,
    };
  }

  if (!entry.skillPath || !entry.skillFolderPath || !entry.baseTreeSha || !entry.sourceUrl) {
    const local = localSnapshot(entry.liveDir);
    return {
      name: entry.name,
      scope: entry.scope,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      ref: entry.ref,
      liveDir: entry.liveDir,
      lockPath: entry.lockPath,
      skillPath: entry.skillPath,
      skillFolderPath: entry.skillFolderPath,
      baseTreeSha: entry.baseTreeSha,
      status: "needs_adoption",
      summary: { totalFiles: local.size, changedFiles: 0, cleanActions: 0, mergeableActions: 0, conflicts: 0, localOnly: 0, localEdits: 0, upstreamDeletes: 0 },
      files: [],
      localManifest: manifest(local),
      error: "Missing sourceUrl, skillPath, or skillFolderHash metadata",
    };
  }

  const gh = parseGitHubRepo(entry);
  if (!gh || entry.sourceType !== "github") {
    const local = localSnapshot(entry.liveDir);
    return {
      name: entry.name,
      scope: entry.scope,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      ref: entry.ref,
      liveDir: entry.liveDir,
      lockPath: entry.lockPath,
      skillPath: entry.skillPath,
      skillFolderPath: entry.skillFolderPath,
      baseTreeSha: entry.baseTreeSha,
      status: "needs_adoption",
      summary: { totalFiles: local.size, changedFiles: 0, cleanActions: 0, mergeableActions: 0, conflicts: 0, localOnly: 0, localEdits: 0, upstreamDeletes: 0 },
      files: [],
      localManifest: manifest(local),
      error: `Only GitHub lock entries are supported in this version (sourceType=${entry.sourceType || "unknown"})`,
    };
  }

  try {
    const source = await fetchRepoSource(gh.owner, gh.repo, entry.ref);
    const latest = remoteSnapshotFromTree(source.tree, entry.skillFolderPath);
    if (!latest.treeSha) throw new Error(`Could not find upstream skill folder ${entry.skillFolderPath}`);

    const local = localSnapshot(entry.liveDir);
    const baseFiles = latest.treeSha === entry.baseTreeSha
      ? latest.files
      : remoteSnapshotFromTree(await fetchTreeBySha(gh.owner, gh.repo, entry.baseTreeSha)).files;

    const paths = [...new Set([...baseFiles.keys(), ...local.keys(), ...latest.files.keys()])].sort();
    const files: FilePlan[] = [];
    for (const relPath of paths) {
      files.push(await classifyFile(pi, runDir, entry, gh.owner, gh.repo, relPath, baseFiles.get(relPath), local.get(relPath), latest.files.get(relPath)));
    }

    const summary = summarizeSkill(entry, files, latest.treeSha);
    return {
      name: entry.name,
      scope: entry.scope,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      ref: entry.ref,
      liveDir: entry.liveDir,
      lockPath: entry.lockPath,
      skillPath: entry.skillPath,
      skillFolderPath: entry.skillFolderPath,
      baseTreeSha: entry.baseTreeSha,
      latestTreeSha: latest.treeSha,
      status: statusFromSummary(summary, entry.baseTreeSha, latest.treeSha),
      summary,
      files,
      localManifest: manifest(local),
    };
  } catch (error) {
    const local = localSnapshot(entry.liveDir);
    return {
      name: entry.name,
      scope: entry.scope,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      ref: entry.ref,
      liveDir: entry.liveDir,
      lockPath: entry.lockPath,
      skillPath: entry.skillPath,
      skillFolderPath: entry.skillFolderPath,
      baseTreeSha: entry.baseTreeSha,
      status: "fetch_error",
      summary: { totalFiles: local.size, changedFiles: 0, cleanActions: 0, mergeableActions: 0, conflicts: 0, localOnly: 0, localEdits: 0, upstreamDeletes: 0 },
      files: [],
      localManifest: manifest(local),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSummary(skills: SkillPlan[]): Plan["summary"] {
  return {
    checked: skills.length,
    upToDate: skills.filter((s) => s.status === "up_to_date").length,
    cleanUpdates: skills.filter((s) => s.status === "clean_updates").length,
    mergeable: skills.filter((s) => s.status === "mergeable").length,
    conflicts: skills.filter((s) => s.status === "conflicts").length,
    needsAdoption: skills.filter((s) => s.status === "needs_adoption").length,
    errors: skills.filter((s) => s.status === "fetch_error").length,
    localMissing: skills.filter((s) => s.status === "local_missing").length,
  };
}

function shortStatus(status: SkillPlan["status"]): string {
  return status.replace(/_/g, " ");
}

function reportForPlan(plan: Plan): string {
  const lines = [
    `# Safe skill update report`,
    "",
    `Run: ${plan.id}`,
    `Created: ${plan.createdAt}`,
    `CWD: ${plan.cwd}`,
    "",
    `## Summary`,
    "",
    `- checked: ${plan.summary.checked}`,
    `- clean updates: ${plan.summary.cleanUpdates}`,
    `- clean merge candidates: ${plan.summary.mergeable}`,
    `- conflicts / deletion approvals: ${plan.summary.conflicts}`,
    `- needs adoption: ${plan.summary.needsAdoption}`,
    `- fetch errors: ${plan.summary.errors}`,
    `- up to date: ${plan.summary.upToDate}`,
    "",
    `## Commands`,
    "",
    `- Apply clean-only safe updates: \`/skill-updates-apply ${plan.id} --clean-only\``,
    `- Apply clean text merges too: \`/skill-updates-apply ${plan.id} --include-mergeable\``,
    `- Restore an apply: \`/skill-updates-restore ${plan.id}\``,
    "",
    `## Skills`,
    "",
  ];

  for (const skill of plan.skills) {
    if (skill.status === "up_to_date" && skill.summary.localOnly === 0 && skill.summary.localEdits === 0) continue;
    lines.push(`### ${skill.name}`);
    lines.push("");
    lines.push(`- status: ${shortStatus(skill.status)}`);
    lines.push(`- source: ${skill.source || skill.sourceUrl}`);
    lines.push(`- live: ${skill.liveDir}`);
    if (skill.error) lines.push(`- error: ${skill.error}`);
    if (skill.baseTreeSha || skill.latestTreeSha) lines.push(`- tree: ${skill.baseTreeSha || "?"} -> ${skill.latestTreeSha || "?"}`);
    lines.push(`- counts: clean=${skill.summary.cleanActions}, mergeable=${skill.summary.mergeableActions}, conflicts=${skill.summary.conflicts}, local-only=${skill.summary.localOnly}, local-edits=${skill.summary.localEdits}`);
    const interesting = skill.files.filter((file) => file.action !== "none" || file.case.includes("local"));
    if (interesting.length > 0) {
      lines.push("");
      for (const file of interesting.slice(0, 80)) {
        lines.push(`  - ${file.path}: ${file.action} (${file.case}) — ${file.reason}${file.conflictPath ? ` — ${file.conflictPath}` : ""}`);
      }
      if (interesting.length > 80) lines.push(`  - ... ${interesting.length - 80} more`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function compactPlanMessage(plan: Plan): string {
  const parts = [
    `Safe skill update scan: ${plan.summary.checked} skill(s) checked`,
    `Clean updates: ${plan.summary.cleanUpdates}`,
    `Clean merges: ${plan.summary.mergeable}`,
    `Conflicts / delete approvals: ${plan.summary.conflicts}`,
    `Needs adoption: ${plan.summary.needsAdoption}`,
    `Errors: ${plan.summary.errors}`,
    `Report: ${join(plan.runDir, "report.md")}`,
  ];
  if (plan.summary.cleanUpdates > 0) parts.push(`Apply clean: /skill-updates-apply ${plan.id} --clean-only`);
  if (plan.summary.mergeable > 0) parts.push(`Apply merges: /skill-updates-apply ${plan.id} --include-mergeable`);
  return parts.join("\n");
}

async function createPlan(pi: ExtensionAPI, cwd: string, args: string | undefined): Promise<Plan> {
  const parsed = parseCommandArgs(args);
  const config = loadConfig(cwd);
  const id = runId();
  const runDir = resolve(RUNS_DIR, id);
  ensureDir(runDir);
  ensureDir(join(runDir, "conflicts"));

  let entries = discoverEntries(cwd, parsed).filter((entry) => matchesFilters(entry, parsed.filters, config));
  if (parsed.limit) entries = entries.slice(0, parsed.limit);

  const skills: SkillPlan[] = [];
  for (const entry of entries) {
    skills.push(await planSkill(pi, runDir, entry));
  }

  const filteredSkills = parsed.includeUpToDate ? skills : skills.filter((skill) => skill.status !== "up_to_date" || skill.summary.localOnly > 0 || skill.summary.localEdits > 0);
  const plan: Plan = {
    version: 1,
    id,
    createdAt: isoNow(),
    cwd,
    args: args || "",
    runDir,
    summary: buildSummary(skills),
    skills: filteredSkills,
  };
  writeJson(join(runDir, "plan.json"), plan);
  writeFileSync(join(runDir, "report.md"), reportForPlan(plan), "utf8");

  const state = loadState();
  state.lastRunId = id;
  state.lastScanAt = plan.createdAt;
  state.lastSummary = plan.summary;
  saveState(state);
  return plan;
}

function loadPlan(idOrLatest: string | undefined): Plan | undefined {
  const id = !idOrLatest || idOrLatest === "latest" ? loadState().lastRunId : idOrLatest;
  if (!id) return undefined;
  return readJson<Plan>(resolve(RUNS_DIR, id, "plan.json"));
}

function allowedForMode(skill: SkillPlan, includeMergeable: boolean): { ok: boolean; reason?: string } {
  if (skill.status === "conflicts") return { ok: false, reason: "conflicts/delete approvals present" };
  if (skill.status === "fetch_error" || skill.status === "needs_adoption" || skill.status === "local_missing") return { ok: false, reason: skill.status };
  const disallowed = skill.files.filter((f) => {
    if (f.action === "none" || f.action === "preserve_local") return false;
    if (f.action === "use_upstream" || f.action === "add_upstream") return false;
    if (includeMergeable && f.action === "clean_merge") return false;
    return true;
  });
  if (disallowed.length > 0) return { ok: false, reason: `contains ${disallowed[0]?.action}` };
  const actions = skill.files.filter((f) => f.action === "use_upstream" || f.action === "add_upstream" || (includeMergeable && f.action === "clean_merge"));
  if (actions.length === 0 && skill.baseTreeSha === skill.latestTreeSha) return { ok: false, reason: "no applicable actions" };
  return { ok: true };
}

function backupSkill(runDir: string, skill: SkillPlan): string {
  const backupDir = resolve(runDir, "backups", sanitizeSegment(skill.name), "live");
  rmSync(backupDir, { recursive: true, force: true });
  ensureDir(dirname(backupDir));
  cpSync(skill.liveDir, backupDir, { recursive: true, preserveTimestamps: true });
  return backupDir;
}

function backupLock(runDir: string, lockPath: string): string | undefined {
  if (!existsSync(lockPath)) return undefined;
  const dest = resolve(runDir, "backups", "locks", sanitizeSegment(lockPath.replace(/^\/+/, "")) + ".json");
  ensureDir(dirname(dest));
  cpSync(lockPath, dest, { preserveTimestamps: true });
  return dest;
}

function writeFileFromBase64(path: string, base64: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, Buffer.from(base64, "base64"));
}

function updateLockEntry(skill: SkillPlan): void {
  if (!skill.latestTreeSha || !existsSync(skill.lockPath)) return;
  const lock = readJson<any>(skill.lockPath);
  if (!lock?.skills?.[skill.name]) return;
  lock.skills[skill.name].skillFolderHash = skill.latestTreeSha;
  lock.skills[skill.name].updatedAt = isoNow();
  writeJson(skill.lockPath, lock);
}

function writeBaseline(skill: SkillPlan): void {
  if (!skill.latestTreeSha) return;
  const baselinePath = resolve(BASELINES_DIR, skill.scope, `${sanitizeSegment(skill.name)}.json`);
  writeJson(baselinePath, {
    version: 1,
    scope: skill.scope,
    skillName: skill.name,
    liveDir: skill.liveDir,
    lockPath: skill.lockPath,
    sourceUrl: skill.sourceUrl,
    ref: skill.ref,
    skillFolderPath: skill.skillFolderPath,
    upstreamBaseTreeSha: skill.latestTreeSha,
    updatedAt: isoNow(),
  });
}

function applySkill(skill: SkillPlan, includeMergeable: boolean): number {
  let changed = 0;
  for (const file of skill.files) {
    const target = resolve(skill.liveDir, file.path);
    if (file.action === "use_upstream" || file.action === "add_upstream") {
      if (!file.upstreamContentBase64) continue;
      writeFileFromBase64(target, file.upstreamContentBase64);
      changed++;
    } else if (includeMergeable && file.action === "clean_merge") {
      if (!file.mergedContentBase64) continue;
      writeFileFromBase64(target, file.mergedContentBase64);
      changed++;
    }
  }
  if (!existsSync(resolve(skill.liveDir, "SKILL.md"))) throw new Error(`${skill.name}: SKILL.md missing after apply`);
  return changed;
}

function applyPlan(plan: Plan, args: string | undefined): string {
  const parsed = parseCommandArgs(args);
  const includeMergeable = parsed.includeMergeable && !parsed.cleanOnly;
  const selected = parsed.filters.length > 0
    ? plan.skills.filter((skill) => parsed.filters.some((filter) => filter === skill.name || globMatch(skill.name, filter)))
    : plan.skills;

  const applyLog: any = {
    runId: plan.id,
    appliedAt: isoNow(),
    includeMergeable,
    skills: [] as any[],
    lockBackups: {} as Record<string, string | undefined>,
  };

  for (const skill of selected) {
    const allowed = allowedForMode(skill, includeMergeable);
    if (!allowed.ok) {
      applyLog.skills.push({ name: skill.name, status: "skipped", reason: allowed.reason });
      continue;
    }

    const current = localSnapshot(skill.liveDir);
    const changedSinceScan = sameManifest(current, skill.localManifest);
    if (changedSinceScan.length > 0) {
      applyLog.skills.push({ name: skill.name, status: "aborted", reason: `local files changed since scan: ${changedSinceScan.slice(0, 5).join(", ")}` });
      continue;
    }

    try {
      const backupDir = backupSkill(plan.runDir, skill);
      if (!applyLog.lockBackups[skill.lockPath]) applyLog.lockBackups[skill.lockPath] = backupLock(plan.runDir, skill.lockPath);
      const changedFiles = applySkill(skill, includeMergeable);
      updateLockEntry(skill);
      writeBaseline(skill);
      applyLog.skills.push({ name: skill.name, status: "applied", changedFiles, backupDir });
    } catch (error) {
      applyLog.skills.push({ name: skill.name, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  writeJson(resolve(plan.runDir, "apply.json"), applyLog);
  const state = loadState();
  state.lastApplyAt = applyLog.appliedAt;
  state.lastApplyRunId = plan.id;
  saveState(state);

  const applied = applyLog.skills.filter((s: any) => s.status === "applied");
  const skipped = applyLog.skills.filter((s: any) => s.status !== "applied");
  return [
    `Safe skill update apply: ${applied.length} applied, ${skipped.length} skipped/failed`,
    ...applied.map((s: any) => `- ${s.name}: applied ${s.changedFiles} file(s)`),
    ...skipped.slice(0, 12).map((s: any) => `- ${s.name}: ${s.status} (${s.reason})`),
    `Apply log: ${resolve(plan.runDir, "apply.json")}`,
    `Restore: /skill-updates-restore ${plan.id}`,
  ].join("\n");
}

function restorePlan(plan: Plan, args: string | undefined): string {
  const parsed = parseCommandArgs(args);
  const applyLog = readJson<any>(resolve(plan.runDir, "apply.json"));
  if (!applyLog) return `No apply log found for ${plan.id}`;
  const selected = new Set(parsed.filters.filter((f) => f !== plan.id && f !== "latest"));
  const restored: string[] = [];

  for (const item of applyLog.skills || []) {
    if (item.status !== "applied") continue;
    if (selected.size > 0 && !selected.has(item.name)) continue;
    const skill = plan.skills.find((s) => s.name === item.name);
    if (!skill || !item.backupDir || !existsSync(item.backupDir)) continue;
    rmSync(skill.liveDir, { recursive: true, force: true });
    ensureDir(dirname(skill.liveDir));
    cpSync(item.backupDir, skill.liveDir, { recursive: true, preserveTimestamps: true });
    restored.push(item.name);
  }

  for (const [lockPath, backup] of Object.entries(applyLog.lockBackups || {})) {
    if (typeof backup === "string" && existsSync(backup)) cpSync(backup, lockPath, { preserveTimestamps: true });
  }

  return `Restored ${restored.length} skill(s) from ${plan.id}${restored.length ? `:\n- ${restored.join("\n- ")}` : ""}`;
}

function statusMessage(): string {
  const state = loadState();
  if (!state.lastRunId) {
    return [
      "Safe skill updater: no scans yet.",
      `Artifact root: ${ROOT_DIR}`,
      "Run /skill-updates-scan [skill...] to create a report-first update plan.",
    ].join("\n");
  }
  const s = state.lastSummary;
  return [
    `Safe skill updater: last scan ${state.lastRunId}`,
    `Scanned at: ${state.lastScanAt || "unknown"}`,
    s ? `Summary: clean=${s.cleanUpdates}, mergeable=${s.mergeable}, conflicts=${s.conflicts}, adoption=${s.needsAdoption}, errors=${s.errors}, up-to-date=${s.upToDate}` : "Summary: unknown",
    `Report: ${resolve(RUNS_DIR, state.lastRunId, "report.md")}`,
    state.lastApplyAt ? `Last apply: ${state.lastApplyAt} (${state.lastApplyRunId})` : "Last apply: never",
  ].join("\n");
}

function diffMessage(plan: Plan, args: string | undefined): string {
  const parsed = parseCommandArgs(args);
  const [skillName, filePath] = parsed.filters.filter((f) => f !== plan.id && f !== "latest");
  if (!skillName) return `Usage: /skill-updates-diff ${plan.id} <skill> [file]`;
  const skill = plan.skills.find((s) => s.name === skillName);
  if (!skill) return `No skill named ${skillName} in run ${plan.id}`;
  const files = filePath ? skill.files.filter((f) => f.path === filePath) : skill.files.filter((f) => f.action !== "none" || f.case.includes("local"));
  if (files.length === 0) return `No changed files for ${skillName}${filePath ? ` / ${filePath}` : ""}`;
  return [
    `${skillName}: ${shortStatus(skill.status)}`,
    ...files.slice(0, 40).map((f) => `- ${f.path}: ${f.action} (${f.case}) — ${f.reason}${f.conflictPath ? `\n  conflict: ${f.conflictPath}` : ""}`),
  ].join("\n");
}

export default function safeSkillUpdater(pi: ExtensionAPI) {
  ensureDir(ROOT_DIR);
  ensureDir(RUNS_DIR);

  pi.on("session_start", (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    const state = loadState();
    if (state.lastSummary && (state.lastSummary.cleanUpdates || state.lastSummary.mergeable || state.lastSummary.conflicts || state.lastSummary.needsAdoption)) {
      pi.sendMessage({
        customType: "safe-skill-updates-reminder",
        content: statusMessage(),
        display: true,
        details: { state },
      });
    }
    if (config.scanOnStartup) {
      pi.sendMessage({
        customType: "safe-skill-updates",
        content: "Safe skill updater: scanOnStartup is configured, but automatic remote scans are intentionally disabled in v1. Run /skill-updates-scan explicitly.",
        display: true,
      });
    }
  });

  pi.registerCommand("skill-updates-status", {
    description: "Show safe external skill update status",
    handler: async (_args, ctx) => {
      const message = statusMessage();
      ctx.ui.notify(message, "info");
      pi.sendMessage({ customType: "safe-skill-updates-status", content: message, display: true, details: loadState() });
    },
  });

  const scanHandler = async (args: string, ctx: any) => {
    ctx.ui.notify("Safe skill updater scan started (report-only)", "info");
    const plan = await createPlan(pi, ctx.cwd, args);
    const message = compactPlanMessage(plan);
    ctx.ui.notify(message, "info");
    pi.sendMessage({
      customType: "safe-skill-updates-scan",
      content: message,
      display: true,
      details: {
        id: plan.id,
        summary: plan.summary,
        runDir: plan.runDir,
        reportPath: join(plan.runDir, "report.md"),
      },
    });
  };

  pi.registerCommand("skill-updates-scan", {
    description: "Scan skills for safe upstream updates without mutating files",
    handler: scanHandler,
  });

  pi.registerCommand("skill-updates-plan", {
    description: "Alias for /skill-updates-scan",
    handler: scanHandler,
  });

  pi.registerCommand("skill-updates-check", {
    description: "Alias for /skill-updates-scan (safe report-only; never calls npx skills update)",
    handler: scanHandler,
  });

  pi.registerCommand("skill-updates-diff", {
    description: "Show planned file actions for a run/skill. Usage: /skill-updates-diff latest <skill> [file]",
    handler: async (args, ctx) => {
      const [runArg] = (args || "").split(/\s+/).filter(Boolean);
      const plan = loadPlan(runArg);
      const message = plan ? diffMessage(plan, args) : `No plan found for ${runArg || "latest"}`;
      ctx.ui.notify(message, "info");
      pi.sendMessage({ customType: "safe-skill-updates-diff", content: message, display: true });
    },
  });

  pi.registerCommand("skill-updates-apply", {
    description: "Apply a safe skill update plan. Usage: /skill-updates-apply latest [skill...] --clean-only|--include-mergeable",
    handler: async (args, ctx) => {
      const tokens = (args || "").split(/\s+/).filter(Boolean);
      const runArg = tokens[0] && !tokens[0].startsWith("--") ? tokens[0] : "latest";
      const plan = loadPlan(runArg);
      if (!plan) {
        ctx.ui.notify(`No plan found for ${runArg}`, "warning");
        return;
      }
      if (!args.includes("--clean-only") && !args.includes("--include-mergeable")) {
        const message = "Refusing to apply without explicit mode. Use --clean-only or --include-mergeable.";
        ctx.ui.notify(message, "warning");
        pi.sendMessage({ customType: "safe-skill-updates-apply", content: message, display: true });
        return;
      }
      const applyArgs = runArg === "latest" && (tokens[0]?.startsWith("--") || !tokens[0]) ? args : tokens.slice(1).join(" ");
      const message = applyPlan(plan, applyArgs);
      ctx.ui.notify(message, "info");
      pi.sendMessage({ customType: "safe-skill-updates-apply", content: message, display: true });
    },
  });

  pi.registerCommand("skill-updates-restore", {
    description: "Restore skill directories and lock files from an apply backup. Usage: /skill-updates-restore <run> [skill...]",
    handler: async (args, ctx) => {
      const [runArg] = (args || "").split(/\s+/).filter(Boolean);
      const plan = loadPlan(runArg);
      const message = plan ? restorePlan(plan, args) : `No plan found for ${runArg || "latest"}`;
      ctx.ui.notify(message, "info");
      pi.sendMessage({ customType: "safe-skill-updates-restore", content: message, display: true });
    },
  });

  pi.registerCommand("skill-updates-adopt", {
    description: "Explain adoption for skills missing safe baseline metadata",
    handler: async (args, ctx) => {
      const message = [
        "Adoption is not mutating in v1.",
        "Run /skill-updates-scan <skill> to see why the skill needs adoption.",
        "For now, prefer a real git fork/clone for customized skills, then load the fork with Pi package filters.",
        args?.trim() ? `Requested: ${args.trim()}` : undefined,
      ].filter(Boolean).join("\n");
      ctx.ui.notify(message, "info");
      pi.sendMessage({ customType: "safe-skill-updates-adopt", content: message, display: true });
    },
  });
}
