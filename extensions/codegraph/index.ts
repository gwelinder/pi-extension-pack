import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 24_000;
const MAX_OUTPUT_CHARS_LIMIT = 120_000;
const ARTIFACT_ROOT = path.join(os.homedir(), ".pi", "agent", "artifacts", "codegraph");
const requireFromExtension = createRequire(import.meta.url);

type CodeGraphAction =
  | "context"
  | "search"
  | "files"
  | "callers"
  | "callees"
  | "impact"
  | "affected"
  | "node"
  | "explore"
  | "trace"
  | "status"
  | "sync"
  | "init"
  | "index";

type CodeGraphParams = {
  action: CodeGraphAction;
  query?: string;
  symbol?: string;
  from?: string;
  to?: string;
  files?: string[];
  projectPath?: string;
  limit?: number;
  kind?: string;
  depth?: number;
  maxNodes?: number;
  maxCode?: number;
  maxFiles?: number;
  maxDepth?: number;
  filter?: string;
  pattern?: string;
  format?: "markdown" | "json" | "tree" | "flat" | "grouped";
  includeCode?: boolean;
  sync?: boolean;
  maxOutputChars?: number;
  force?: boolean;
  index?: boolean;
  quiet?: boolean;
};

type CodeGraphDetails = {
  action: CodeGraphAction;
  projectPath: string;
  command: string[];
  synced: boolean;
  syncOutput?: string;
  elapsedMs: number;
  truncated: boolean;
  originalChars: number;
  artifactPath?: string;
  sha256?: string;
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function expandUserPath(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function findCodeGraphProject(startPath: string): string | undefined {
  let current = path.resolve(expandUserPath(startPath));
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);
  } catch {
    // Ignore and walk from the resolved path.
  }
  while (true) {
    if (fs.existsSync(path.join(current, ".codegraph", "codegraph.db"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveProjectPath(input: string | undefined, cwd: string): string {
  if (input?.trim()) return path.resolve(cwd, expandUserPath(input.trim()));
  return findCodeGraphProject(cwd) ?? path.resolve(cwd);
}

function packageCodeGraphBin(): string | undefined {
  try {
    const packageJsonPath = requireFromExtension.resolve("@colbymchenry/codegraph/package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.codegraph;
    if (!bin) return undefined;
    const candidate = path.join(path.dirname(packageJsonPath), bin);
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function ancestorBin(name: string): string | undefined {
  let current = typeof __dirname === "string" ? __dirname : process.cwd();
  while (true) {
    const candidate = path.join(current, "node_modules", ".bin", name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveCodeGraphBin(): string {
  if (process.env.PI_CODEGRAPH_BIN?.trim()) return process.env.PI_CODEGRAPH_BIN.trim();
  return packageCodeGraphBin() ?? ancestorBin("codegraph") ?? "codegraph";
}

function requireString(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`codegraph ${name} is required for this action.`);
  return trimmed;
}

function buildArgs(params: CodeGraphParams, projectPath: string): string[] {
  const json = params.format === "json";
  const args: string[] = [];

  switch (params.action) {
    case "context":
      args.push("context", requireString(params.query, "query"), "--path", projectPath);
      args.push("--max-nodes", String(clampInt(params.maxNodes, 20, 1, 100)));
      args.push("--max-code", String(clampInt(params.maxCode, 8, 0, 50)));
      args.push("--format", json ? "json" : "markdown");
      if (params.includeCode === false) args.push("--no-code");
      return args;
    case "search":
      args.push("query", requireString(params.query, "query"), "--path", projectPath);
      args.push("--limit", String(clampInt(params.limit, 12, 1, 100)));
      if (params.kind?.trim()) args.push("--kind", params.kind.trim());
      if (json) args.push("--json");
      return args;
    case "files":
      args.push("files", "--path", projectPath);
      if (params.filter?.trim()) args.push("--filter", params.filter.trim());
      if (params.pattern?.trim()) args.push("--pattern", params.pattern.trim());
      if (params.maxDepth !== undefined) args.push("--max-depth", String(clampInt(params.maxDepth, 4, 1, 20)));
      if (params.format === "flat" || params.format === "grouped" || params.format === "tree") args.push("--format", params.format);
      if (json) args.push("--json");
      return args;
    case "callers":
    case "callees":
      args.push(params.action, requireString(params.symbol, "symbol"), "--path", projectPath);
      args.push("--limit", String(clampInt(params.limit, 20, 1, 100)));
      if (json) args.push("--json");
      return args;
    case "impact":
      args.push("impact", requireString(params.symbol, "symbol"), "--path", projectPath);
      args.push("--depth", String(clampInt(params.depth, 2, 1, 10)));
      if (json) args.push("--json");
      return args;
    case "affected": {
      const files = Array.isArray(params.files) ? params.files.filter((file) => file.trim()) : [];
      args.push("affected", ...files, "--path", projectPath);
      args.push("--depth", String(clampInt(params.depth, 5, 1, 20)));
      if (params.filter?.trim()) args.push("--filter", params.filter.trim());
      if (params.quiet) args.push("--quiet");
      if (json) args.push("--json");
      return args;
    }
    case "node":
    case "explore":
    case "trace":
      throw new Error(`codegraph ${params.action} is only available through the MCP bridge.`);
    case "status":
      args.push("status");
      if (json) args.push("--json");
      return args;
    case "sync":
      args.push("sync");
      if (params.quiet) args.push("--quiet");
      return args;
    case "init":
      args.push("init");
      if (params.index !== false) args.push("--index");
      args.push(projectPath);
      return args;
    case "index":
      args.push("index");
      if (params.force) args.push("--force");
      if (params.quiet !== false) args.push("--quiet");
      args.push(projectPath);
      return args;
  }
}

function mcpToolName(action: CodeGraphAction): string | undefined {
  if (action === "node") return "codegraph_node";
  if (action === "explore") return "codegraph_explore";
  if (action === "trace") return "codegraph_trace";
  return undefined;
}

function buildMcpInput(params: CodeGraphParams): Record<string, unknown> {
  switch (params.action) {
    case "node":
      return {
        symbol: requireString(params.symbol, "symbol"),
        includeCode: params.includeCode === true,
      };
    case "explore":
      return {
        query: requireString(params.query, "query"),
        maxFiles: clampInt(params.maxFiles, 12, 1, 30),
      };
    case "trace":
      return {
        from: requireString(params.from, "from"),
        to: requireString(params.to, "to"),
      };
    default:
      return {};
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function commandErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  const parts = [error.message, extra.stdout?.toString(), extra.stderr?.toString()]
    .filter(Boolean)
    .map((part) => stripAnsi(String(part)).trim())
    .filter(Boolean);
  return parts.join("\n");
}

async function runCodeGraph(args: string[], projectPath: string, signal?: AbortSignal): Promise<string> {
  const result = await execFileAsync(resolveCodeGraphBin(), args, {
    cwd: projectPath,
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    signal,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
  });
  return stripAnsi([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
}

type JsonRpcMessage = {
  id?: number;
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

function mcpResultToText(result: unknown): string {
  const structured = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  if (Array.isArray(structured.content)) {
    const text = structured.content
      .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item)))
      .filter(Boolean)
      .join("\n");
    return text || JSON.stringify(result, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

async function runCodeGraphMcpTool(toolName: string, input: Record<string, unknown>, projectPath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCodeGraphBin(), ["serve", "--mcp", "--path", projectPath, "--no-watch"], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
    });

    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout>;

    const finish = (error: Error | undefined, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        child.kill();
      } catch {
        // Ignore shutdown races.
      }
      if (error) reject(error);
      else resolve(output ?? "");
    };

    const abort = () => finish(new Error(`CodeGraph MCP ${toolName} aborted.`));
    timer = setTimeout(() => {
      finish(new Error(`CodeGraph MCP ${toolName} timed out after ${DEFAULT_TIMEOUT_MS}ms.${stderr ? `\n${stripAnsi(stderr).trim()}` : ""}`));
    }, DEFAULT_TIMEOUT_MS);

    signal?.addEventListener("abort", abort, { once: true });

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8000);
    });

    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`CodeGraph MCP ${toolName} exited before returning a result (code ${code}).${stderr ? `\n${stripAnsi(stderr).trim()}` : ""}`));
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf("\n");
        if (!line) continue;

        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }

        if (message.id === 1) {
          if (message.error) {
            finish(new Error(`CodeGraph MCP initialize failed: ${message.error.message || JSON.stringify(message.error)}`));
            return;
          }
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: input } });
          return;
        }

        if (message.id === 2) {
          if (message.error) {
            finish(new Error(`CodeGraph MCP ${toolName} failed: ${message.error.message || JSON.stringify(message.error)}`));
            return;
          }
          const text = mcpResultToText(message.result);
          const isError = Boolean((message.result as { isError?: boolean } | undefined)?.isError);
          finish(isError ? new Error(text) : undefined, text);
          return;
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-codegraph-extension", version: "1" },
      },
    });
  });
}

function sessionIdFrom(ctx: any): string {
  try {
    return String(ctx.sessionManager.getSessionId() || "no-session");
  } catch {
    return "no-session";
  }
}

function writeArtifact(ctx: any, action: string, output: string): { artifactPath: string; sha256: string } {
  const sessionId = sessionIdFrom(ctx).replace(/[^a-zA-Z0-9_.-]+/g, "_");
  const sha256 = crypto.createHash("sha256").update(output).digest("hex");
  const dir = path.join(ARTIFACT_ROOT, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactPath = path.join(dir, `${stamp}_${action}_${sha256.slice(0, 12)}.txt`);
  fs.writeFileSync(artifactPath, output, "utf8");
  return { artifactPath, sha256 };
}

function truncateOutput(output: string, maxChars: number): { text: string; truncated: boolean } {
  if (output.length <= maxChars) return { text: output, truncated: false };
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.max(1000, maxChars - headChars - 300);
  return {
    truncated: true,
    text: `${output.slice(0, headChars).trimEnd()}\n\n--- output truncated; tail follows ---\n\n${output.slice(-tailChars).trimStart()}`,
  };
}

function shouldAutoSync(params: CodeGraphParams): boolean {
  return params.sync !== false && !["status", "sync", "init", "index"].includes(params.action);
}

function requiresExistingIndex(action: CodeGraphAction): boolean {
  return !["status", "init", "index"].includes(action);
}

const codegraphTool = defineTool({
  name: "codegraph",
  label: "CodeGraph",
  description:
    "Query or maintain the local CodeGraph semantic index for a repository. Use for source-code topology, symbol search, callers/callees, impact radius, affected tests, and focused implementation context.",
  promptSnippet: "Use codegraph for indexed semantic code exploration before broad grep/read when a repo has a .codegraph index.",
  promptGuidelines: [
    "Use codegraph early for code-facing questions when the repo has a .codegraph index: action=context for broad architecture/feature/bug context, action=search for known symbols/components/files, and action=files for indexed file structure.",
    "If context is too broad or thin, refine with action=explore for several related symbols/files, action=node for one exact symbol with optional source, or action=trace for a from→to flow. Do not fall back to broad grep just because the first context query was imperfect.",
    "Before changing shared symbols, routes, workflows, tools, auth, database code, or agent pipeline code, use callers/callees/impact/affected to map blast radius and likely tests.",
    "The tool auto-runs incremental codegraph sync before query actions. If codegraph reports pending/stale files or you just edited a file, read those exact source files directly before relying on exact content.",
    "If no index exists and the user wants CodeGraph enabled, use action=init with index=true or run `codegraph init -i` in the project root.",
    "Use native read/rg/jq/Python/log tools instead for literal text, generated artifacts, production data shape, runtime logs, prose, PDFs, screenshots, and paths outside indexed source code.",
  ],
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("context"),
        Type.Literal("search"),
        Type.Literal("files"),
        Type.Literal("callers"),
        Type.Literal("callees"),
        Type.Literal("impact"),
        Type.Literal("affected"),
        Type.Literal("node"),
        Type.Literal("explore"),
        Type.Literal("trace"),
        Type.Literal("status"),
        Type.Literal("sync"),
        Type.Literal("init"),
        Type.Literal("index"),
      ],
      { description: "CodeGraph operation to run." },
    ),
    query: Type.Optional(Type.String({ description: "Task/search text for context or search actions." })),
    symbol: Type.Optional(Type.String({ description: "Symbol name for callers, callees, impact, or node." })),
    from: Type.Optional(Type.String({ description: "For trace: symbol where the flow starts." })),
    to: Type.Optional(Type.String({ description: "For trace: symbol the flow should reach." })),
    files: Type.Optional(Type.Array(Type.String(), { description: "Changed files for affected-test analysis." })),
    projectPath: Type.Optional(Type.String({ description: "Project path override. Defaults to nearest .codegraph project or the current working directory." })),
    limit: Type.Optional(Type.Number({ description: "Result limit for search/callers/callees." })),
    kind: Type.Optional(Type.String({ description: "Optional search kind filter, e.g. function, class, interface, file, route." })),
    depth: Type.Optional(Type.Number({ description: "Traversal depth for impact/affected." })),
    maxNodes: Type.Optional(Type.Number({ description: "Max nodes for context (default 20)." })),
    maxCode: Type.Optional(Type.Number({ description: "Max code blocks for context (default 8)." })),
    maxFiles: Type.Optional(Type.Number({ description: "For explore: maximum files to include source from (default 12)." })),
    maxDepth: Type.Optional(Type.Number({ description: "Max tree depth for files action." })),
    filter: Type.Optional(Type.String({ description: "Directory filter for files, or test glob for affected." })),
    pattern: Type.Optional(Type.String({ description: "Glob pattern for files action." })),
    format: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("json"), Type.Literal("tree"), Type.Literal("flat"), Type.Literal("grouped")], {
        description: "Output format when supported.",
      }),
    ),
    includeCode: Type.Optional(Type.Boolean({ description: "For context: include code snippets (default true)." })),
    sync: Type.Optional(Type.Boolean({ description: "Auto-sync before query actions (default true)." })),
    maxOutputChars: Type.Optional(Type.Number({ description: "Max returned chars before artifact-backed truncation (default 24000)." })),
    force: Type.Optional(Type.Boolean({ description: "For index: force a full re-index." })),
    index: Type.Optional(Type.Boolean({ description: "For init: run initial indexing after initialization (default true)." })),
    quiet: Type.Optional(Type.Boolean({ description: "For sync/index/affected: reduce CLI decoration where supported." })),
  }),
  async execute(_toolCallId, params: CodeGraphParams, signal, _onUpdate, ctx) {
    const started = Date.now();
    const action = params.action;
    const projectPath = resolveProjectPath(params.projectPath, ctx.cwd);

    if (!fs.existsSync(projectPath)) {
      return { isError: true, content: [{ type: "text", text: `CodeGraph project path does not exist: ${projectPath}` }], details: { action, projectPath } };
    }

    if (requiresExistingIndex(action) && !fs.existsSync(path.join(projectPath, ".codegraph", "codegraph.db"))) {
      return {
        isError: true,
        content: [{ type: "text", text: `No CodeGraph index found in ${projectPath}. Run codegraph action=init with index=true, or run: codegraph init -i` }],
        details: { action, projectPath },
      };
    }

    let synced = false;
    let syncOutput: string | undefined;

    try {
      if (shouldAutoSync(params)) {
        syncOutput = await runCodeGraph(["sync", "--quiet"], projectPath, signal);
        synced = true;
      }

      const toolName = mcpToolName(action);
      const args = toolName ? ["serve", "--mcp", "--path", projectPath, "--no-watch", `<mcp-tool:${toolName}>`] : buildArgs(params, projectPath);
      const output = toolName
        ? await runCodeGraphMcpTool(toolName, buildMcpInput(params), projectPath, signal)
        : await runCodeGraph(args, projectPath, signal);
      const fullOutput = [`# CodeGraph ${action}`, `Project: ${projectPath}`, synced ? "Index: synced before query" : "Index: not synced by this call", "", output || "(no output)"].join("\n");
      const maxChars = clampInt(params.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 2_000, MAX_OUTPUT_CHARS_LIMIT);
      const truncation = truncateOutput(fullOutput, maxChars);
      const artifact = truncation.truncated ? writeArtifact(ctx, action, fullOutput) : undefined;
      const details: CodeGraphDetails = {
        action,
        projectPath,
        command: [resolveCodeGraphBin(), ...args],
        synced,
        syncOutput,
        elapsedMs: Date.now() - started,
        truncated: truncation.truncated,
        originalChars: fullOutput.length,
        artifactPath: artifact?.artifactPath,
        sha256: artifact?.sha256,
      };
      const suffix = artifact ? `\n\n[Full CodeGraph output archived: ${artifact.artifactPath} sha256=${artifact.sha256}]` : "";
      return { content: [{ type: "text", text: `${truncation.text}${suffix}` }], details };
    } catch (error) {
      const message = commandErrorMessage(error);
      return {
        isError: true,
        content: [{ type: "text", text: `CodeGraph ${action} failed for ${projectPath}: ${message}` }],
        details: { action, projectPath, synced, syncOutput, elapsedMs: Date.now() - started, error: message },
      };
    }
  },
  renderCall(args: CodeGraphParams, theme) {
    const target = args.query || args.symbol || args.filter || args.pattern || (args.files ? args.files.join(",") : "");
    const short = target.length > 72 ? `${target.slice(0, 69)}…` : target;
    return new Text(`${theme.fg("toolTitle", theme.bold("codegraph"))} ${theme.fg("accent", args.action)} ${theme.fg("muted", short)}`, 0, 0);
  },
  renderResult(result, { expanded, isPartial }, theme) {
    if (isPartial) return new Text(theme.fg("muted", "Querying CodeGraph…"), 0, 0);
    const details = result.details as Partial<CodeGraphDetails> | undefined;
    const content = result.content?.[0]?.type === "text" ? result.content[0].text : "";
    const status = (result as any).isError ? theme.fg("error", "failed") : theme.fg("success", "ok");
    const summary = [`${theme.fg("toolTitle", theme.bold("CodeGraph"))} ${details?.action ?? ""} ${status} ${theme.fg("muted", `${details?.elapsedMs ?? 0}ms`)}`];
    if (details?.truncated && details.artifactPath) summary.push(theme.fg("warning", `full output: ${details.artifactPath}`));
    if (expanded && content) summary.push("", ...content.split("\n").slice(0, 24).map((line) => theme.fg("muted", line)));
    return new Text(summary.join("\n"), 0, 0);
  },
});

function ensureCodeGraphActive(pi: ExtensionAPI): void {
  const active = new Set(pi.getActiveTools());
  if (active.has("codegraph")) return;
  active.add("codegraph");
  pi.setActiveTools([...active]);
}

export default function codegraphExtension(pi: ExtensionAPI) {
  pi.registerTool(codegraphTool);
  pi.on("session_start", () => ensureCodeGraphActive(pi));
  pi.on("before_agent_start", () => ensureCodeGraphActive(pi));
}
