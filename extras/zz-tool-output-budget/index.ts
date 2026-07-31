import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawnSync } from "node:child_process";

const ARTIFACT_ROOT = process.env.PI_TOOL_OUTPUT_BUDGET_DIR || join(homedir(), ".pi", "agent", "artifacts", "tool-output");
const ENABLED = process.env.PI_TOOL_OUTPUT_BUDGET !== "0";
const TOKENIZER_IMPORT =
  process.env.PI_TOOL_OUTPUT_TOKENIZER_IMPORT ||
  "gpt-tokenizer/encoding/o200k_base";

const IMPORTANT_LINE_RE = /\b(error|failed?|failure|exception|traceback|syntaxerror|typeerror|referenceerror|assert|expected|actual|timeout|timed out|not found|enoent|eacces|websocket|fatal|panic|segfault)\b/i;

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image"; data: string; mimeType: string };
type ContentPart = TextPart | ImagePart | Record<string, unknown>;

type EncodeFn = (text: string) => number[];

type ToolBudget = {
  thresholdTokens: number;
  targetTokens: number;
  headTokens: number;
  tailTokens: number;
  importantTokens: number;
  minChars: number;
  strategy: "tail-heavy" | "head-heavy" | "balanced";
};

let encodePromise: Promise<EncodeFn | undefined> | undefined;
const commandCache = new Map<string, boolean>();

const BUDGETS: Record<string, ToolBudget> = {
  bash: {
    thresholdTokens: envInt("PI_TOOL_OUTPUT_BASH_THRESHOLD_TOKENS", 4_500),
    targetTokens: envInt("PI_TOOL_OUTPUT_BASH_TARGET_TOKENS", 2_800),
    headTokens: envInt("PI_TOOL_OUTPUT_BASH_HEAD_TOKENS", 450),
    tailTokens: envInt("PI_TOOL_OUTPUT_BASH_TAIL_TOKENS", 1_650),
    importantTokens: envInt("PI_TOOL_OUTPUT_BASH_IMPORTANT_TOKENS", 550),
    minChars: envInt("PI_TOOL_OUTPUT_BASH_MIN_CHARS", 10_000),
    strategy: "tail-heavy",
  },
  process: {
    thresholdTokens: envInt("PI_TOOL_OUTPUT_PROCESS_THRESHOLD_TOKENS", 3_500),
    targetTokens: envInt("PI_TOOL_OUTPUT_PROCESS_TARGET_TOKENS", 2_200),
    headTokens: envInt("PI_TOOL_OUTPUT_PROCESS_HEAD_TOKENS", 350),
    tailTokens: envInt("PI_TOOL_OUTPUT_PROCESS_TAIL_TOKENS", 1_250),
    importantTokens: envInt("PI_TOOL_OUTPUT_PROCESS_IMPORTANT_TOKENS", 450),
    minChars: envInt("PI_TOOL_OUTPUT_PROCESS_MIN_CHARS", 8_000),
    strategy: "tail-heavy",
  },
  read: {
    thresholdTokens: envInt("PI_TOOL_OUTPUT_READ_THRESHOLD_TOKENS", 5_000),
    targetTokens: envInt("PI_TOOL_OUTPUT_READ_TARGET_TOKENS", 3_300),
    headTokens: envInt("PI_TOOL_OUTPUT_READ_HEAD_TOKENS", 2_150),
    tailTokens: envInt("PI_TOOL_OUTPUT_READ_TAIL_TOKENS", 650),
    importantTokens: envInt("PI_TOOL_OUTPUT_READ_IMPORTANT_TOKENS", 0),
    minChars: envInt("PI_TOOL_OUTPUT_READ_MIN_CHARS", 12_000),
    strategy: "head-heavy",
  },
  cf_codemode_schema: {
    thresholdTokens: envInt("PI_TOOL_OUTPUT_CF_SCHEMA_THRESHOLD_TOKENS", 3_500),
    targetTokens: envInt("PI_TOOL_OUTPUT_CF_SCHEMA_TARGET_TOKENS", 2_400),
    headTokens: envInt("PI_TOOL_OUTPUT_CF_SCHEMA_HEAD_TOKENS", 1_300),
    tailTokens: envInt("PI_TOOL_OUTPUT_CF_SCHEMA_TAIL_TOKENS", 650),
    importantTokens: envInt("PI_TOOL_OUTPUT_CF_SCHEMA_IMPORTANT_TOKENS", 0),
    minChars: envInt("PI_TOOL_OUTPUT_CF_SCHEMA_MIN_CHARS", 8_000),
    strategy: "head-heavy",
  },
  cf_execute: {
    thresholdTokens: envInt("PI_TOOL_OUTPUT_CF_EXECUTE_THRESHOLD_TOKENS", 4_000),
    targetTokens: envInt("PI_TOOL_OUTPUT_CF_EXECUTE_TARGET_TOKENS", 2_700),
    headTokens: envInt("PI_TOOL_OUTPUT_CF_EXECUTE_HEAD_TOKENS", 700),
    tailTokens: envInt("PI_TOOL_OUTPUT_CF_EXECUTE_TAIL_TOKENS", 1_400),
    importantTokens: envInt("PI_TOOL_OUTPUT_CF_EXECUTE_IMPORTANT_TOKENS", 350),
    minChars: envInt("PI_TOOL_OUTPUT_CF_EXECUTE_MIN_CHARS", 9_000),
    strategy: "tail-heavy",
  },
  default: {
    thresholdTokens: envInt("PI_TOOL_OUTPUT_DEFAULT_THRESHOLD_TOKENS", 6_000),
    targetTokens: envInt("PI_TOOL_OUTPUT_DEFAULT_TARGET_TOKENS", 3_500),
    headTokens: envInt("PI_TOOL_OUTPUT_DEFAULT_HEAD_TOKENS", 900),
    tailTokens: envInt("PI_TOOL_OUTPUT_DEFAULT_TAIL_TOKENS", 1_600),
    importantTokens: envInt("PI_TOOL_OUTPUT_DEFAULT_IMPORTANT_TOKENS", 500),
    minChars: envInt("PI_TOOL_OUTPUT_DEFAULT_MIN_CHARS", 14_000),
    strategy: "balanced",
  },
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function getEncoder(): Promise<EncodeFn | undefined> {
  encodePromise ??= import(TOKENIZER_IMPORT)
    .then((mod: any) => (typeof mod.encode === "function" ? (mod.encode as EncodeFn) : undefined))
    .catch(() => undefined);
  return encodePromise;
}

async function tokenCount(text: string): Promise<number> {
  const encode = await getEncoder();
  if (!encode) return roughTokenCount(text);
  return encode(text).length;
}

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 3.4);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "unknown";
}

function sessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() || "unknown-session";
  } catch {
    return "unknown-session";
  }
}

function artifactPath(ctx: ExtensionContext, toolName: string, toolCallId: string, suffix: string): string {
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(ARTIFACT_ROOT, safePart(sessionId(ctx)));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${date}_${safePart(toolName)}_${safePart(toolCallId)}.${suffix}`);
}

function writeArtifact(ctx: ExtensionContext, toolName: string, toolCallId: string, text: string, metadata: Record<string, unknown>): string {
  const path = artifactPath(ctx, toolName, toolCallId, "txt");
  const header = [
    "# Pi tool output archive",
    `tool: ${toolName}`,
    `toolCallId: ${toolCallId}`,
    `sessionId: ${sessionId(ctx)}`,
    `cwd: ${ctx.cwd}`,
    `createdAt: ${new Date().toISOString()}`,
    `sha256_16: ${hashText(text)}`,
    `metadata: ${JSON.stringify(metadata)}`,
    "",
    "--- original model-visible tool result ---",
    "",
  ].join("\n");
  writeFileSync(path, header + text, "utf8");
  return path;
}

function contentInfo(content: unknown): { text: string; textParts: TextPart[]; imageCount: number; otherParts: ContentPart[] } {
  const textParts: TextPart[] = [];
  const otherParts: ContentPart[] = [];
  let imageCount = 0;
  if (Array.isArray(content)) {
    for (const part of content as ContentPart[]) {
      if (part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string") {
        textParts.push(part as TextPart);
      } else {
        if (part && typeof part === "object" && (part as any).type === "image") imageCount++;
        otherParts.push(part);
      }
    }
  } else if (typeof content === "string") {
    textParts.push({ type: "text", text: content });
  }
  return { text: textParts.map((part) => part.text).join("\n"), textParts, imageCount, otherParts };
}

function hasCommand(command: string): boolean {
  const cached = commandCache.get(command);
  if (cached !== undefined) return cached;
  const result = spawnSync("bash", ["-lc", `command -v ${command} >/dev/null 2>&1`], { timeout: 700 });
  const ok = result.status === 0;
  commandCache.set(command, ok);
  return ok;
}

function readPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as any).path ?? (input as any).file_path;
  return typeof value === "string" ? value : undefined;
}

function readKind(filePath: string | undefined): string {
  if (!filePath) return "unknown";
  const lower = filePath.toLowerCase();
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return "image";
  if (lower.endsWith(".jsonl")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".mdx") || /\b(agents|claude|readme)\.md$/i.test(filePath)) return "markdown";
  if (lower.includes("/node_modules/")) return "node_modules";
  if (lower.includes("/tmp/")) return "tmp-artifact";
  if (/\.(ts|tsx|js|jsx|py|go|rs|swift|java|c|cc|cpp)$/.test(lower)) return "source";
  return extname(lower).replace(/^\./, "") || "text";
}

function toolTips(toolName: string, input: unknown): string[] {
  if (toolName === "read") {
    const path = readPath(input);
    const kind = readKind(path);
    const tips = [`Use read offset/limit for the exact range you need; avoid rereading the whole large file.`];
    if (kind === "markdown" && hasCommand("qmd")) {
      tips.push("For indexed Markdown/docs/notes on this Mac, prefer QMD: `qmd query '<semantic question>'`, `qmd search '<keywords>'`, or `qmd get <file>:<line>`.");
    }
    if ((kind === "json" || kind === "jsonl") && hasCommand("jq")) {
      tips.push("For JSON/JSONL, use `jq` or a short Python extractor to pull keys/counts/records instead of reading the full artifact.");
    }
    if (kind === "source" || kind === "node_modules") {
      tips.push("For source code, use `rg -n -C 2 '<symbol|error>' <path>` or Finder for reconnaissance, then read only the relevant line range.");
    }
    if (kind === "tmp-artifact") {
      tips.push("For generated/tmp artifacts, first inspect shape with `wc -l -c`, `jq`, `rg -n`, or a tiny Python summary, then read slices.");
    }
    return tips;
  }

  if (toolName === "bash") {
    return [
      "Prefer bounded output: `rg -n -m 80 -C 2 '<pattern>' <root>`, `git diff --stat && git diff -- <file>`, `jq` projections, or Python summaries instead of dumping whole logs/files.",
      "For Markdown/docs/notes, QMD is installed here; use `qmd query/search/get` when the task is semantic document retrieval rather than code grep.",
    ];
  }

  if (toolName === "process") {
    return [
      "Use `process.logs` for full log paths and `process.output` only for recent tails. Add `logWatches` for exact success/failure patterns instead of polling large output.",
    ];
  }

  if (toolName === "cf_codemode_schema") {
    return ["Use `query` for search and `methods:[...]` for exact definitions. Query mode is intentionally compact; request exact methods only when needed."];
  }

  return ["Rerun the tool with a narrower query/range/filter if you need details omitted from this compact view."];
}

async function takeHead(text: string, maxTokens: number): Promise<string> {
  if (maxTokens <= 0 || !text) return "";
  const total = await tokenCount(text);
  if (total <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  let best = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid);
    if ((await tokenCount(candidate)) <= maxTokens) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best.trimEnd();
}

async function takeTail(text: string, maxTokens: number): Promise<string> {
  if (maxTokens <= 0 || !text) return "";
  const total = await tokenCount(text);
  if (total <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  let best = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(text.length - mid);
    if ((await tokenCount(candidate)) <= maxTokens) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best.trimStart();
}

async function importantExcerpt(text: string, maxTokens: number): Promise<string> {
  if (maxTokens <= 0) return "";
  const lines = text.split("\n");
  const picked: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!IMPORTANT_LINE_RE.test(line)) continue;
    const start = Math.max(0, i - 1);
    const end = Math.min(lines.length, i + 2);
    const chunk = lines.slice(start, end).join("\n");
    const key = hashText(chunk);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(`-- around line ${i + 1} --\n${chunk}`);
    const current = picked.join("\n");
    if ((await tokenCount(current)) > maxTokens) {
      picked.pop();
      break;
    }
  }
  return picked.join("\n").trim();
}

function pointerLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /\[(?:Showing|Truncated|First line)|Full output:|Full logs:|Use offset=|more lines in file/i.test(line))
    .slice(-8);
}

async function compactText(params: {
  text: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  ctx: ExtensionContext;
  budget: ToolBudget;
  originalTokens: number;
}): Promise<{ text: string; archivePath: string; keptTokens: number }> {
  const { text, toolName, toolCallId, input, ctx, budget, originalTokens } = params;
  const archivePath = writeArtifact(ctx, toolName, toolCallId, text, {
    originalTokens,
    originalChars: text.length,
    budgetTokens: budget.targetTokens,
    strategy: budget.strategy,
  });

  const head = await takeHead(text, budget.headTokens);
  const tail = await takeTail(text, budget.tailTokens);
  const important = await importantExcerpt(text, budget.importantTokens);
  const pointers = pointerLines(text);
  const omittedChars = Math.max(0, text.length - head.length - tail.length);
  const omittedTokens = Math.max(0, originalTokens - (await tokenCount(head)) - (await tokenCount(tail)) - (important ? await tokenCount(important) : 0));
  const tips = toolTips(toolName, input);

  const pathHint = toolName === "read" && readPath(input) ? `\nRead path: ${readPath(input)}` : "";
  const header = [
    `[tool-output-budget] Compacted large ${toolName} result before it entered model context.`,
    `Original: ~${originalTokens.toLocaleString()} o200k tokens, ${text.length.toLocaleString()} chars, sha256=${hashText(text)}.`,
    `Archive of the original model-visible result: ${archivePath}`,
    pathHint.trim(),
    pointers.length ? `Tool-provided pointers preserved:\n${pointers.join("\n")}` : undefined,
    `Strategy: kept a ${budget.strategy} excerpt under ~${budget.targetTokens.toLocaleString()} tokens.`,
    ...tips.map((tip) => `Tip: ${tip}`),
  ]
    .filter(Boolean)
    .join("\n");

  const parts = [header, "\n--- kept head ---\n", head || "(empty)"];
  if (important) parts.push("\n--- diagnostic/error lines ---\n", important);
  parts.push(
    `\n--- omitted middle: ~${omittedTokens.toLocaleString()} tokens / ${omittedChars.toLocaleString()} chars ---\n`,
    tail || "(empty)",
    "\n--- end compacted tool result ---",
  );
  const compacted = parts.join("");
  return { text: compacted, archivePath, keptTokens: await tokenCount(compacted) };
}

function budgetFor(toolName: string): ToolBudget {
  return BUDGETS[toolName] ?? BUDGETS.default;
}

export default function toolOutputBudget(pi: ExtensionAPI) {
  if (!ENABLED) return;
  let compactedCount = 0;

  pi.on("tool_result", async (event, ctx) => {
    const info = contentInfo(event.content);
    if (info.imageCount > 0) return; // Deliberately do not touch image reads yet.
    if (!info.text.trim()) return;

    const budget = budgetFor(event.toolName);
    if (info.text.length < budget.minChars) return;

    const originalTokens = await tokenCount(info.text);
    if (originalTokens < budget.thresholdTokens) return;

    const compacted = await compactText({
      text: info.text,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      ctx,
      budget,
      originalTokens,
    });

    compactedCount++;
    return {
      content: [{ type: "text", text: compacted.text }],
      details: {
        ...(event.details && typeof event.details === "object" ? (event.details as Record<string, unknown>) : {}),
        toolOutputBudget: {
          compacted: true,
          originalTokens,
          originalChars: info.text.length,
          compactedTokens: compacted.keptTokens,
          archivePath: compacted.archivePath,
          thresholdTokens: budget.thresholdTokens,
          targetTokens: budget.targetTokens,
          strategy: budget.strategy,
        },
      },
    };
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("tool-output-budget", "ctx:guard");
  });

  pi.on("session_shutdown", () => {
    if (compactedCount > 0) {
      console.error(`[tool-output-budget] Compacted ${compactedCount} large tool result(s) this session.`);
    }
  });
}
