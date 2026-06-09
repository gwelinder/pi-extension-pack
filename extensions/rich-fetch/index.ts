import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  resolve as resolvePath,
  sep as pathSep,
} from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const RESULT_DIR = join(homedir(), ".pi", "agent", "rich-fetch-results");
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
const DEFAULT_MAX_CHARS = 24000;
const MAX_INLINE_FILE_CHARS = 100000;
const MAX_TREE_ENTRIES = 220;
const MIN_USEFUL_TEXT = 600;

type Mode = "auto" | "github" | "url" | "pdf" | "youtube" | "video";

type RichFetchParams = {
  url?: string;
  urls?: string[];
  mode?: Mode;
  prompt?: string;
  forceClone?: boolean;
  maxChars?: number;
  model?: string;
  timestamp?: string;
  frames?: number;
};

type RichResult = {
  url: string;
  title: string;
  content: string;
  error?: string | null;
  artifactPaths?: string[];
  images?: Array<{ data: string; mimeType: string; label: string; path?: string }>;
};

type GitHubUrlInfo = {
  owner: string;
  repo: string;
  ref?: string;
  refIsFullSha: boolean;
  path?: string;
  type: "root" | "blob" | "tree";
};

type VideoInfo = { absolutePath: string; mimeType: string; sizeBytes: number };
type TimestampSpec = { type: "single"; seconds: number } | { type: "range"; start: number; end: number };

type Config = {
  geminiApiKey?: unknown;
  githubClone?: {
    enabled?: unknown;
    maxRepoSizeMB?: unknown;
    cloneTimeoutSeconds?: unknown;
    clonePath?: unknown;
  };
  youtube?: { enabled?: unknown; preferredModel?: unknown };
  video?: { enabled?: unknown; preferredModel?: unknown; maxSizeMB?: unknown };
};

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".tif",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".wav", ".ogg", ".webm", ".flac", ".aac",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".lib",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".sqlite", ".db", ".sqlite3", ".pyc", ".pyo", ".class", ".jar", ".war",
  ".iso", ".img", ".dmg",
]);

const NOISE_DIRS = new Set([
  "node_modules", "vendor", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", "target",
  ".gradle", ".idea", ".vscode",
]);

const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".3gp": "video/3gpp",
  ".3gpp": "video/3gpp",
};

const YOUTUBE_RE = /(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const NON_CODE_GITHUB_SEGMENTS = new Set([
  "issues", "pull", "pulls", "discussions", "releases", "wiki", "actions",
  "settings", "security", "projects", "graphs", "compare", "commits", "tags",
  "branches", "stargazers", "watchers", "network", "forks", "milestone",
  "labels", "packages", "codespaces", "contribute", "community", "sponsors",
  "invitations", "notifications", "insights",
]);

function enumValues<const T extends string[]>(values: T, description?: string) {
  return Type.Union(values.map((value) => Type.Literal(value)), { description });
}

function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
}

function shellSecret(command: string): string | null {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      shell: "/bin/zsh",
    }).trim() || null;
  } catch {
    return null;
  }
}

function resolveSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("!")) return shellSecret(trimmed.slice(1));
  return trimmed;
}

function geminiApiKey(): string | null {
  return resolveSecret(process.env.GEMINI_API_KEY) ?? resolveSecret(readConfig().geminiApiKey);
}

function commandExists(command: string): boolean {
  try {
    execFileSync("/usr/bin/env", ["bash", "-lc", `command -v ${command}`], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function maxChars(params: RichFetchParams): number {
  return positiveInt(params.maxChars, DEFAULT_MAX_CHARS, 200000);
}

function preferredModel(params: RichFetchParams, section: "youtube" | "video" = "youtube"): string {
  if (params.model?.trim()) return params.model.trim();
  const cfg = readConfig()[section];
  const model = cfg && typeof cfg === "object" && typeof cfg.preferredModel === "string" ? cfg.preferredModel.trim() : "";
  return model || DEFAULT_GEMINI_MODEL;
}

function isEnabled(section: "youtube" | "video"): boolean {
  const cfg = readConfig()[section];
  if (cfg && typeof cfg === "object" && typeof cfg.enabled === "boolean") return cfg.enabled;
  return true;
}

function videoMaxSizeMB(): number {
  const cfg = readConfig().video;
  const raw = cfg && typeof cfg === "object" ? Number(cfg.maxSizeMB) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
}

function saveArtifact(prefix: string, ext: string, content: string | Buffer): string {
  mkdirSync(RESULT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const hash = createHash("sha1").update(typeof content === "string" ? content : content.subarray(0, 4096)).digest("hex").slice(0, 8);
  const path = join(RESULT_DIR, `${stamp}-${prefix}-${hash}${ext}`);
  writeFileSync(path, content);
  return path;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n\n[Truncated at ${limit} chars]`;
}

function titleFromMarkdown(text: string, fallback: string): string {
  const match = text.match(/^#{1,2}\s+(.+)$/m);
  return match?.[1]?.replace(/\*+/g, "").trim() || fallback;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function localPath(input: string): string | null {
  if (input.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(input).pathname);
    } catch {
      return null;
    }
  }
  if (input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || input.startsWith("~/")) {
    return resolvePath(expandHome(input));
  }
  return null;
}

function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (NON_CODE_GITHUB_SEGMENTS.has(segments[2]?.toLowerCase())) return null;

  if (segments.length === 2) return { owner, repo, refIsFullSha: false, type: "root" };
  const action = segments[2];
  if (action !== "blob" && action !== "tree") return null;
  if (segments.length < 4) return null;

  const ref = segments[3];
  const refIsFullSha = /^[0-9a-f]{40}$/i.test(ref);
  const rest = segments.slice(4).join("/");
  return { owner, repo, ref, refIsFullSha, path: rest, type: action as "blob" | "tree" };
}

function githubApiJson(endpoint: string): unknown | null {
  if (commandExists("gh")) {
    try {
      const out = execFileSync("gh", ["api", endpoint], { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(out);
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("/usr/bin/env", ["bash", "-lc", `curl -fsSL ${JSON.stringify(`https://api.github.com/${endpoint}`)}`], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function githubDefaultBranch(owner: string, repo: string): string | null {
  const data = githubApiJson(`repos/${owner}/${repo}`) as { default_branch?: unknown } | null;
  return typeof data?.default_branch === "string" ? data.default_branch : null;
}

function githubRepoSizeKB(owner: string, repo: string): number | null {
  const data = githubApiJson(`repos/${owner}/${repo}`) as { size?: unknown } | null;
  const size = Number(data?.size);
  return Number.isFinite(size) ? size : null;
}

function decodeGithubContent(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const content = (data as { content?: unknown }).content;
  const encoding = (data as { encoding?: unknown }).encoding;
  if (typeof content !== "string" || encoding !== "base64") return null;
  return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
}

function githubReadme(owner: string, repo: string, ref: string): string | null {
  const data = githubApiJson(`repos/${owner}/${repo}/readme?ref=${encodeURIComponent(ref)}`);
  const text = decodeGithubContent(data);
  return text ? truncate(text, 8192) : null;
}

function githubFile(owner: string, repo: string, path: string, ref: string): string | null {
  const endpoint = `repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
  const data = githubApiJson(endpoint);
  if (Array.isArray(data)) {
    return data.map((item) => {
      const row = item as { type?: string; name?: string; size?: number };
      return `${row.type === "dir" ? "dir " : "file"} ${row.name ?? ""}${typeof row.size === "number" ? ` (${row.size} bytes)` : ""}`;
    }).join("\n");
  }
  return decodeGithubContent(data);
}

function githubTree(owner: string, repo: string, ref: string): string | null {
  const data = githubApiJson(`repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`) as { tree?: Array<{ path?: unknown }> } | null;
  const paths = Array.isArray(data?.tree) ? data.tree.map((item) => item.path).filter((p): p is string => typeof p === "string") : [];
  if (paths.length === 0) return null;
  const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
  return paths.length > MAX_TREE_ENTRIES ? `${display}\n... (${paths.length} total entries)` : display;
}

function cloneConfig() {
  const defaults = { enabled: true, maxRepoSizeMB: 350, cloneTimeoutSeconds: 30, clonePath: "/tmp/pi-github-repos" };
  const raw = readConfig().githubClone ?? {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
    maxRepoSizeMB: Number.isFinite(Number(raw.maxRepoSizeMB)) && Number(raw.maxRepoSizeMB) > 0 ? Number(raw.maxRepoSizeMB) : defaults.maxRepoSizeMB,
    cloneTimeoutSeconds: Number.isFinite(Number(raw.cloneTimeoutSeconds)) && Number(raw.cloneTimeoutSeconds) > 0 ? Number(raw.cloneTimeoutSeconds) : defaults.cloneTimeoutSeconds,
    clonePath: typeof raw.clonePath === "string" && raw.clonePath.trim() ? raw.clonePath.trim() : defaults.clonePath,
  };
}

function clonePathFor(owner: string, repo: string, ref?: string): string {
  const cfg = cloneConfig();
  const suffix = ref ? `${repo}@${ref.replace(/[^a-zA-Z0-9_.-]/g, "_")}` : repo;
  return join(cfg.clonePath, owner, suffix);
}

function cloneRepo(owner: string, repo: string, ref?: string): string | null {
  const cfg = cloneConfig();
  if (!cfg.enabled) return null;
  const target = clonePathFor(owner, repo, ref);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });

  const timeout = cfg.cloneTimeoutSeconds * 1000;
  try {
    if (commandExists("gh")) {
      const args = ["repo", "clone", `${owner}/${repo}`, target, "--", "--depth", "1", "--single-branch"];
      if (ref) args.push("--branch", ref);
      execFileSync("gh", args, { stdio: "ignore", timeout });
      return target;
    }
    const args = ["clone", "--depth", "1", "--single-branch"];
    if (ref) args.push("--branch", ref);
    args.push(`https://github.com/${owner}/${repo}.git`, target);
    execFileSync("git", args, { stdio: "ignore", timeout });
    return target;
  } catch {
    rmSync(target, { recursive: true, force: true });
    return null;
  }
}

function resolveWithin(root: string, relativePath: string): string | null {
  const normalizedRoot = resolvePath(root);
  const candidate = resolvePath(normalizedRoot, relativePath || ".");
  if (candidate !== normalizedRoot) {
    const prefix = normalizedRoot.endsWith(pathSep) ? normalizedRoot : normalizedRoot + pathSep;
    if (!candidate.startsWith(prefix)) return null;
  }
  if (!existsSync(candidate)) return candidate;
  try {
    const realRoot = realpathSync(normalizedRoot);
    const realCandidate = realpathSync(candidate);
    if (realCandidate === realRoot) return candidate;
    const prefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
    return realCandidate.startsWith(prefix) ? candidate : null;
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isBinaryFile(path: string): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  try {
    const buf = readFileSync(path).subarray(0, 512);
    return buf.includes(0);
  } catch {
    return false;
  }
}

function buildTree(root: string): string {
  const entries: string[] = [];
  function walk(dir: string, rel: string) {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    let items: string[];
    try { items = readdirSync(dir).sort(); } catch { return; }
    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) return;
      if (item === ".git") continue;
      const childRel = rel ? `${rel}/${item}` : item;
      const full = resolveWithin(root, childRel);
      if (!full) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (NOISE_DIRS.has(item)) {
          entries.push(`${childRel}/ [skipped]`);
          continue;
        }
        entries.push(`${childRel}/`);
        walk(full, childRel);
      } else {
        entries.push(childRel);
      }
    }
  }
  walk(root, "");
  if (entries.length >= MAX_TREE_ENTRIES) entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
  return entries.join("\n");
}

function listDir(root: string, subPath: string): string {
  const target = resolveWithin(root, subPath);
  if (!target || !existsSync(target)) return "(path not found)";
  return readdirSync(target).sort().filter((item) => item !== ".git").map((item) => {
    const rel = subPath ? `${subPath}/${item}` : item;
    const full = resolveWithin(root, rel);
    if (!full || !existsSync(full)) return `  ${item} (unreadable)`;
    const stat = statSync(full);
    return stat.isDirectory() ? `  ${item}/` : `  ${item} (${formatSize(stat.size)})`;
  }).join("\n");
}

function readReadme(root: string): string | null {
  for (const name of ["README.md", "readme.md", "README", "README.txt", "README.rst"]) {
    const path = join(root, name);
    if (existsSync(path)) return truncate(readFileSync(path, "utf8"), 8192);
  }
  return null;
}

function githubFromClone(url: string, info: GitHubUrlInfo, root: string): RichResult {
  const lines = [`Repository cloned to: ${root}`, ""];
  if (info.type === "root") {
    lines.push("## Structure", buildTree(root), "");
    const readme = readReadme(root);
    if (readme) lines.push("## README", readme, "");
    lines.push("Use `read`/`bash` at the clone path for deeper exploration.");
  } else if (info.type === "tree") {
    const sub = info.path || "";
    lines.push(`## ${sub || "/"}`, listDir(root, sub), "", "Use `read`/`bash` at the clone path for deeper exploration.");
  } else {
    const sub = info.path || "";
    const file = resolveWithin(root, sub);
    if (!file || !existsSync(file)) {
      lines.push(`Path not found: ${sub}`, "", "## Structure", buildTree(root));
    } else if (statSync(file).isDirectory()) {
      lines.push(`## ${sub}`, listDir(root, sub));
    } else if (isBinaryFile(file)) {
      lines.push(`## ${sub}`, `Binary file (${formatSize(statSync(file).size)}): ${file}`);
    } else {
      const content = readFileSync(file, "utf8");
      lines.push(`## ${sub}`, truncate(content, MAX_INLINE_FILE_CHARS));
      if (content.length > MAX_INLINE_FILE_CHARS) lines.push(`\nFull file: ${file}`);
    }
  }
  return { url, title: info.path ? `${info.owner}/${info.repo} - ${info.path}` : `${info.owner}/${info.repo}`, content: lines.join("\n"), artifactPaths: [root] };
}

function githubViaApi(url: string, info: GitHubUrlInfo, note?: string): RichResult | null {
  const ref = info.ref || githubDefaultBranch(info.owner, info.repo);
  if (!ref) return null;
  const lines: string[] = [];
  if (note) lines.push(note, "");

  if (info.type === "blob" && info.path) {
    const content = githubFile(info.owner, info.repo, info.path, ref);
    if (!content) return null;
    lines.push(`## ${info.path}`, truncate(content, MAX_INLINE_FILE_CHARS));
    return { url, title: `${info.owner}/${info.repo} - ${info.path}`, content: lines.join("\n") };
  }

  const tree = githubTree(info.owner, info.repo, ref);
  const readme = githubReadme(info.owner, info.repo, ref);
  if (!tree && !readme) return null;
  if (tree) lines.push("## Structure", tree, "");
  if (readme) lines.push("## README", readme, "");
  lines.push("API-only GitHub view. Use a local clone for deeper exploration.");
  return { url, title: info.path ? `${info.owner}/${info.repo} - ${info.path}` : `${info.owner}/${info.repo}`, content: lines.join("\n") };
}

async function fetchGitHub(url: string, params: RichFetchParams): Promise<RichResult> {
  const info = parseGitHubUrl(url);
  if (!info) return { url, title: url, content: "", error: "Not a GitHub code URL" };

  if (info.type === "blob" || info.refIsFullSha) {
    const api = githubViaApi(url, info, info.refIsFullSha ? "Commit SHA URL: using GitHub API instead of clone." : undefined);
    if (api) return api;
  }

  const cfg = cloneConfig();
  const sizeKB = githubRepoSizeKB(info.owner, info.repo);
  if (!params.forceClone && sizeKB !== null && sizeKB / 1024 > cfg.maxRepoSizeMB) {
    const note = `Repository is ${Math.round(sizeKB / 1024)}MB; using GitHub API instead of cloning. Pass forceClone for full clone.`;
    const api = githubViaApi(url, info, note);
    if (api) return api;
  }

  const clone = cloneRepo(info.owner, info.repo, info.ref);
  if (clone) return githubFromClone(url, info, clone);

  const api = githubViaApi(url, info, "Clone failed; using GitHub API fallback.");
  if (api) return api;
  return { url, title: `${info.owner}/${info.repo}`, content: "", error: "GitHub clone/API extraction failed" };
}

function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return url.toLowerCase().endsWith(".pdf");
  }
}

async function pdfBuffer(input: string): Promise<{ buffer: Buffer; sourcePath?: string }> {
  const lp = localPath(input);
  if (lp) return { buffer: readFileSync(lp), sourcePath: lp };
  const res = await fetch(input, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return { buffer: Buffer.from(await res.arrayBuffer()) };
}

async function fetchPdf(url: string, params: RichFetchParams): Promise<RichResult> {
  try {
    const { buffer, sourcePath } = await pdfBuffer(url);
    const pdfPath = sourcePath ?? saveArtifact("pdf", ".pdf", buffer);
    if (!commandExists("pdftotext")) {
      if (!sourcePath) {
        const gemini = await fetchGeminiUrl(url, params);
        if (!gemini.error) return { ...gemini, artifactPaths: [pdfPath, ...(gemini.artifactPaths ?? [])] };
      }
      return { url, title: basename(pdfPath), content: `PDF saved to ${pdfPath}`, error: "pdftotext is not installed" };
    }
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
    const txtPath = saveArtifact("pdf-text", ".txt", text);
    return {
      url,
      title: basename(pdfPath),
      content: `PDF: ${pdfPath}\nExtracted text: ${txtPath}\n\n${truncate(text, maxChars(params))}`,
      artifactPaths: [pdfPath, txtPath],
    };
  } catch (err) {
    return { url, title: url, content: "", error: err instanceof Error ? err.message : String(err) };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchBasicUrl(url: string, params: RichFetchParams): Promise<RichResult> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/122 Safari/537.36" },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("pdf") || isPdfUrl(url)) return fetchPdf(url, params);
  const raw = await res.text();
  const text = contentType.includes("html") ? stripHtml(raw) : raw;
  const path = saveArtifact("url", ".txt", text);
  return { url, title: titleFromMarkdown(text, new URL(url).hostname), content: truncate(text, maxChars(params)), artifactPaths: [path] };
}

async function fetchGeminiUrl(url: string, params: RichFetchParams): Promise<RichResult> {
  const key = geminiApiKey();
  if (!key) return { url, title: url, content: "", error: "Missing GEMINI_API_KEY or geminiApiKey in ~/.pi/web-search.json" };
  const prompt = params.prompt?.trim()
    ? `${params.prompt.trim()}\n\nUse this URL as the grounded source. Return markdown with citations/URLs when useful.\n\nURL: ${url}`
    : `Extract the complete readable content from this URL as clean markdown. Include title, main text, code blocks, and tables. Do not summarize.\n\nURL: ${url}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], tools: [{ url_context: {} }] };
  const model = preferredModel(params);
  const res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) return { url, title: url, content: "", error: `Gemini URL context ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; url_context_metadata?: { url_metadata?: Array<{ url_retrieval_status?: string }> } }>;
  };
  const status = data.candidates?.[0]?.url_context_metadata?.url_metadata?.[0]?.url_retrieval_status;
  if (status === "URL_RETRIEVAL_STATUS_UNSAFE" || status === "URL_RETRIEVAL_STATUS_ERROR") {
    return { url, title: url, content: "", error: `Gemini URL retrieval failed: ${status}` };
  }
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join("\n") ?? "";
  if (!text.trim()) return { url, title: url, content: "", error: "Gemini URL context returned empty content" };
  const path = saveArtifact("gemini-url", ".md", text);
  return { url, title: titleFromMarkdown(text, new URL(url).hostname), content: truncate(text, maxChars(params)), artifactPaths: [path] };
}

async function fetchUrl(url: string, params: RichFetchParams): Promise<RichResult> {
  if (params.prompt?.trim()) {
    const gemini = await fetchGeminiUrl(url, params);
    if (!gemini.error) return gemini;
  }
  try {
    const basic = await fetchBasicUrl(url, params);
    if (basic.content.length >= MIN_USEFUL_TEXT) return basic;
  } catch {
  }
  const gemini = await fetchGeminiUrl(url, params);
  if (!gemini.error) return gemini;
  try {
    return await fetchBasicUrl(url, params);
  } catch (err) {
    return { url, title: url, content: "", error: gemini.error || (err instanceof Error ? err.message : String(err)) };
  }
}

function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/playlist") return null;
  } catch {
  }
  return url.match(YOUTUBE_RE)?.[1] ?? null;
}

function parseTimestamp(ts: string): number | null {
  const numeric = Number(ts);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  const parts = ts.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return parts.length === 3 ? Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]) : Math.floor(parts[0] * 60 + parts[1]);
}

function parseTimestampSpec(raw: string): TimestampSpec | null {
  const dash = raw.indexOf("-", 1);
  if (dash > 0) {
    const start = parseTimestamp(raw.slice(0, dash));
    const end = parseTimestamp(raw.slice(dash + 1));
    if (start !== null && end !== null && end > start) return { type: "range", start, end };
    return null;
  }
  const seconds = parseTimestamp(raw);
  return seconds !== null ? { type: "single", seconds } : null;
}

function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function sampleTimestamps(duration: number | null, count: number): number[] {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return [1];
  const end = Math.max(0, Math.floor(duration - 1));
  if (count <= 1) return [Math.min(end, Math.max(0, Math.floor(duration / 2)))];
  const step = end / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

function frameTimestamps(params: RichFetchParams): number[] {
  const count = positiveInt(params.frames, params.timestamp?.includes("-") ? 6 : 1, 12);
  if (!params.timestamp) return [];
  const spec = parseTimestampSpec(params.timestamp);
  if (!spec) throw new Error(`Invalid timestamp: ${params.timestamp}`);
  if (spec.type === "single") return Array.from({ length: count }, (_, i) => spec.seconds + i * 5);
  if (count <= 1) return [spec.start];
  const step = (spec.end - spec.start) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(spec.start + i * step));
}

function youtubeStreamInfo(id: string): { streamUrl: string; duration: number | null } {
  const output = execFileSync("yt-dlp", ["--print", "duration", "-g", `https://www.youtube.com/watch?v=${id}`], {
    encoding: "utf8",
    timeout: 20000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  const [durationRaw, streamUrl] = output.split(/\r?\n/);
  if (!streamUrl) throw new Error("yt-dlp did not return a stream URL");
  const duration = Number(durationRaw);
  return { streamUrl, duration: Number.isFinite(duration) ? duration : null };
}

function ffmpegFrame(input: string, seconds: number): { data: string; mimeType: string; path: string } {
  const buffer = execFileSync("ffmpeg", ["-ss", String(seconds), "-i", input, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], {
    maxBuffer: 6 * 1024 * 1024,
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (buffer.length === 0) throw new Error("ffmpeg returned empty frame");
  const path = saveArtifact("frame", ".jpg", buffer);
  return { data: buffer.toString("base64"), mimeType: "image/jpeg", path };
}

async function geminiVideo(prompt: string, fileUri: string, params: RichFetchParams, mimeType?: string): Promise<string> {
  const key = geminiApiKey();
  if (!key) throw new Error("Missing GEMINI_API_KEY or geminiApiKey in ~/.pi/web-search.json");
  const fileData: Record<string, string> = { fileUri };
  if (mimeType) fileData.mimeType = mimeType;
  const body = { contents: [{ parts: [{ fileData }, { text: prompt }] }] };
  const model = preferredModel(params, "youtube");
  const res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`Gemini video ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join("\n") ?? "";
  if (!text.trim()) throw new Error("Gemini returned empty video response");
  return text;
}

async function fetchYoutube(url: string, params: RichFetchParams): Promise<RichResult> {
  if (!isEnabled("youtube")) return { url, title: "YouTube", content: "", error: "YouTube extraction disabled in ~/.pi/web-search.json" };
  const id = youtubeId(url);
  if (!id) return { url, title: "YouTube", content: "", error: "Not a supported YouTube URL" };
  const canonical = `https://www.youtube.com/watch?v=${id}`;

  if (params.timestamp || params.frames) {
    const info = youtubeStreamInfo(id);
    const timestamps = params.timestamp
      ? frameTimestamps(params)
      : sampleTimestamps(info.duration, positiveInt(params.frames, 1, 12));
    const images = timestamps.map((seconds) => {
      const frame = ffmpegFrame(info.streamUrl, seconds);
      return { ...frame, label: `Frame ${formatSeconds(seconds)}` };
    });
    const lines = [`YouTube frames: ${canonical}`, "", ...images.map((img) => `- ${img.label}: ${img.path}`)];
    return { url, title: "YouTube frames", content: lines.join("\n"), images, artifactPaths: images.map((img) => img.path) };
  }

  const prompt = params.prompt?.trim() || [
    "Extract the complete content of this YouTube video as markdown.",
    "Include title/channel/duration if visible, a concise summary, transcript with timestamps when available, and descriptions of code/slides/UI shown on screen.",
  ].join(" ");
  const text = await geminiVideo(prompt, canonical, params);
  const path = saveArtifact("youtube", ".md", text);
  return { url, title: titleFromMarkdown(text, "YouTube video"), content: truncate(text, maxChars(params)), artifactPaths: [path] };
}

function videoInfo(input: string): VideoInfo | null {
  if (!isEnabled("video")) return null;
  const lp = localPath(input);
  if (!lp) return null;
  const ext = extname(lp).toLowerCase();
  const mimeType = VIDEO_MIME[ext];
  if (!mimeType || !existsSync(lp)) return null;
  const stat = statSync(lp);
  if (!stat.isFile()) return null;
  if (stat.size > videoMaxSizeMB() * 1024 * 1024) return null;
  return { absolutePath: lp, mimeType, sizeBytes: stat.size };
}

function localVideoDuration(path: string): number | null {
  try {
    const out = execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8", timeout: 10000 });
    const parsed = Number(out.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function uploadGeminiFile(info: VideoInfo, key: string, signal?: AbortSignal): Promise<{ name: string; uri: string }> {
  const init = await fetch(`${GEMINI_UPLOAD_BASE}/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(info.sizeBytes),
      "X-Goog-Upload-Header-Content-Type": info.mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: basename(info.absolutePath) } }),
    signal,
  });
  if (!init.ok) throw new Error(`Gemini upload init ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const uploadUrl = init.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini upload did not return upload URL");
  const data = await readFile(info.absolutePath);
  const upload = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(info.sizeBytes),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: data,
    signal,
  });
  if (!upload.ok) throw new Error(`Gemini upload ${upload.status}: ${(await upload.text()).slice(0, 200)}`);
  const json = await upload.json() as { file?: { name?: string; uri?: string } };
  if (!json.file?.name || !json.file?.uri) throw new Error("Gemini upload returned malformed file object");
  return { name: json.file.name, uri: json.file.uri };
}

async function pollGeminiFile(name: string, key: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const res = await fetch(`${GEMINI_API_BASE}/${name}?key=${key}`, { signal });
    if (!res.ok) throw new Error(`Gemini file state ${res.status}`);
    const data = await res.json() as { state?: string };
    if (data.state === "ACTIVE") return;
    if (data.state === "FAILED") throw new Error("Gemini file processing failed");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("Gemini file processing timed out");
}

function deleteGeminiFile(name: string, key: string): void {
  fetch(`${GEMINI_API_BASE}/${name}?key=${key}`, { method: "DELETE" }).catch(() => {});
}

async function fetchVideo(input: string, params: RichFetchParams, signal?: AbortSignal): Promise<RichResult> {
  const info = videoInfo(input);
  if (!info) return { url: input, title: input, content: "", error: "Not a supported local video path, file missing, disabled, or over size limit" };

  if (params.timestamp || params.frames) {
    const duration = localVideoDuration(info.absolutePath);
    const timestamps = params.timestamp
      ? frameTimestamps(params)
      : sampleTimestamps(duration, positiveInt(params.frames, 1, 12));
    const images = timestamps.map((seconds) => {
      const frame = ffmpegFrame(info.absolutePath, seconds);
      return { ...frame, label: `Frame ${formatSeconds(seconds)}` };
    });
    const lines = [`Video frames: ${info.absolutePath}`, duration ? `Duration: ${formatSeconds(Math.floor(duration))}` : "", "", ...images.map((img) => `- ${img.label}: ${img.path}`)].filter(Boolean);
    return { url: input, title: basename(info.absolutePath), content: lines.join("\n"), images, artifactPaths: images.map((img) => img.path) };
  }

  const key = geminiApiKey();
  if (!key) return { url: input, title: basename(info.absolutePath), content: "", error: "Missing GEMINI_API_KEY or geminiApiKey in ~/.pi/web-search.json" };

  let fileName: string | null = null;
  try {
    const uploaded = await uploadGeminiFile(info, key, signal);
    fileName = uploaded.name;
    await pollGeminiFile(fileName, key, signal);
    const prompt = params.prompt?.trim() || [
      "Extract the complete content of this video as markdown.",
      "Include inferred title/duration, summary, transcript with timestamps if available, and descriptions of code/slides/UI shown on screen.",
    ].join(" ");
    const text = await geminiVideo(prompt, uploaded.uri, { ...params, model: params.model ?? preferredModel(params, "video") }, info.mimeType);
    const path = saveArtifact("video", ".md", text);
    return { url: input, title: titleFromMarkdown(text, basename(info.absolutePath)), content: truncate(text, maxChars(params)), artifactPaths: [path] };
  } catch (err) {
    return { url: input, title: basename(info.absolutePath), content: "", error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (fileName) deleteGeminiFile(fileName, key);
  }
}

async function fetchOne(input: string, params: RichFetchParams, signal?: AbortSignal): Promise<RichResult> {
  const mode = params.mode ?? "auto";
  const gh = parseGitHubUrl(input);
  const ytid = youtubeId(input);
  const vinfo = videoInfo(input);
  const lp = localPath(input);

  if (mode === "github" || (mode === "auto" && gh)) return fetchGitHub(input, params);
  if (mode === "youtube" || (mode === "auto" && ytid)) return fetchYoutube(input, params);
  if (mode === "video" || (mode === "auto" && vinfo)) return fetchVideo(input, params, signal);
  if (mode === "pdf" || (mode === "auto" && (isPdfUrl(input) || !!(lp && extname(lp).toLowerCase() === ".pdf")))) return fetchPdf(input, params);
  return fetchUrl(input, params);
}

function renderCombined(results: RichResult[], limit: number): string {
  const parts: string[] = [];
  for (const result of results) {
    parts.push(`## ${result.title || result.url}`);
    parts.push(result.url);
    if (result.artifactPaths?.length) parts.push(`Artifacts: ${result.artifactPaths.join(", ")}`);
    if (result.error) parts.push(`Error: ${result.error}`);
    if (result.content) parts.push(truncate(result.content, limit));
    parts.push("");
  }
  return parts.join("\n").trim();
}

function normalizeInputs(params: RichFetchParams): string[] {
  const list = Array.isArray(params.urls) ? params.urls : (params.url ? [params.url] : []);
  return list.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

export default function richFetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rich_fetch",
    label: "Rich Fetch",
    description: "Extract rich URL/file content: GitHub repos/files, PDFs, YouTube/local video transcripts or frames, and Gemini URL-context fallback. Stores artifacts and returns a preview.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL or local file path" })),
      urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs/paths" })),
      mode: Type.Optional(enumValues(["auto", "github", "url", "pdf", "youtube", "video"], "Default auto")),
      prompt: Type.Optional(Type.String({ description: "Question/instructions for Gemini URL/video analysis" })),
      forceClone: Type.Optional(Type.Boolean({ description: "Force GitHub clone despite size" })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 200000, description: "Preview cap" })),
      model: Type.Optional(Type.String({ description: "Gemini model override" })),
      timestamp: Type.Optional(Type.String({ description: "Video timestamp or range, e.g. 1:23 or 1:00-2:00" })),
      frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "Frame count for video timestamps" })),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as RichFetchParams;
      const inputs = normalizeInputs(params);
      if (inputs.length === 0) {
        return { content: [{ type: "text", text: "Error: provide url or urls." }], details: { error: "No input" } };
      }

      const results: RichResult[] = [];
      for (const input of inputs) {
        if (signal?.aborted) break;
        try {
          results.push(await fetchOne(input, params, signal));
        } catch (err) {
          results.push({ url: input, title: input, content: "", error: err instanceof Error ? err.message : String(err) });
        }
      }

      const combined = renderCombined(results, maxChars(params));
      const combinedPath = saveArtifact("rich-fetch", ".md", combined + "\n");
      const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
        { type: "text", text: `${combined}\n\nFull combined output: ${combinedPath}` },
      ];
      for (const image of results.flatMap((result) => result.images ?? [])) {
        content.push({ type: "text", text: image.path ? `${image.label}: ${image.path}` : image.label });
        content.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
      pi.appendEntry("rich-fetch-result", {
        inputs,
        outputPath: combinedPath,
        artifactPaths: results.flatMap((result) => result.artifactPaths ?? []),
        ts: new Date().toISOString(),
      });
      return {
        content,
        details: {
          outputPath: combinedPath,
          count: results.length,
          errors: results.filter((result) => result.error).map((result) => ({ url: result.url, error: result.error })),
          artifactPaths: results.flatMap((result) => result.artifactPaths ?? []),
          imageCount: results.reduce((sum, result) => sum + (result.images?.length ?? 0), 0),
        },
      };
    },
    renderCall(args, theme) {
      const params = args as RichFetchParams;
      const inputs = normalizeInputs(params);
      const label = inputs.length === 0 ? "(no input)" : inputs.length === 1 ? inputs[0] : `${inputs.length} inputs`;
      const clipped = label.length > 80 ? label.slice(0, 77) + "..." : label;
      return new Text(theme.fg("toolTitle", theme.bold("rich_fetch ")) + theme.fg("accent", clipped), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as { count?: number; errors?: unknown[]; outputPath?: string; imageCount?: number } | undefined;
      const ok = (details?.errors?.length ?? 0) === 0;
      const status = theme.fg(ok ? "success" : "warning", `rich_fetch ${details?.count ?? 0} item(s)`) +
        (details?.imageCount ? theme.fg("accent", ` · ${details.imageCount} image(s)`) : "") +
        (details?.outputPath ? theme.fg("muted", ` · ${details.outputPath}`) : "");
      if (!expanded) return new Text(status, 0, 0);
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      return new Text(`${status}\n${theme.fg("dim", text.slice(0, 1200))}`, 0, 0);
    },
  });
}
