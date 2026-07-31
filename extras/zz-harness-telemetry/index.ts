import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const TZ = "Europe/Copenhagen";
const DEFAULT_DIR = join(homedir(), ".pi", "agent", "telemetry", "harness");
const TELEMETRY_DIR = process.env.PI_HARNESS_TELEMETRY_DIR || DEFAULT_DIR;
const ENABLED = process.env.PI_HARNESS_TELEMETRY !== "0";
const MAX_TEXT_SAMPLE = 240;

type JsonRecord = Record<string, unknown>;

type TextPart = { type?: string; text?: string };

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function copenhagenDay(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function sessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

function sessionFile(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile();
  } catch {
    return undefined;
  }
}

function modelInfo(ctx: ExtensionContext): JsonRecord | undefined {
  const model = ctx.model;
  if (!model) return undefined;
  return {
    provider: model.provider,
    api: model.api,
    id: model.id,
    reasoningLevel: ctx.thinkingLevel,
  };
}

function bashSessionEnvironment(ctx: ExtensionContext): JsonRecord {
  return {
    PI_SESSION_ID: sessionId(ctx),
    PI_SESSION_FILE: sessionFile(ctx),
    PI_PROVIDER: ctx.model?.provider,
    PI_MODEL: ctx.model?.id,
    PI_REASONING_LEVEL: ctx.thinkingLevel,
  };
}

function writeTelemetry(ctx: ExtensionContext, event: string, data: JsonRecord = {}): void {
  if (!ENABLED) return;
  try {
    const ts = Date.now();
    mkdirSync(TELEMETRY_DIR, { recursive: true });
    const path = join(TELEMETRY_DIR, `${copenhagenDay(ts)}.jsonl`);
    const record = {
      ts,
      iso: new Date(ts).toISOString(),
      event,
      source: "pi-harness-telemetry",
      sessionId: sessionId(ctx),
      sessionFile: sessionFile(ctx),
      cwd: ctx.cwd,
      model: modelInfo(ctx),
      ...data,
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Telemetry must never affect the agent loop.
  }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextPart => part && typeof part === "object" && (part as TextPart).type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function classifyText(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (text.trim() === "(no output)" || /placeholder\/no-output final answer|silent model failure/i.test(text)) return "silent_no_output";
  if (/websocket error|websocket closed|provider_transport_failure/i.test(text)) return "websocket";
  if (/unexpected eof|syntax error|was never closed|unterminated/i.test(text)) return "shell_or_syntax";
  if (/command not found|not found\b/i.test(text)) return "command_not_found";
  if (/timed? out|timeout|terminated/i.test(text)) return "timeout_or_terminated";
  if (/permission denied|eacces/i.test(text)) return "permission";
  if (/no such file|enoent/i.test(text)) return "missing_file";
  if (/preflight failed|oldtext must match|could not find the exact text/i.test(text)) return "edit_preflight";
  if (lower.includes("traceback")) return "python_traceback";
  return undefined;
}

function firstShellWord(command: string): string | undefined {
  const match = command.trimStart().match(/^([A-Za-z0-9_./-]+)/);
  return match?.[1];
}

function extractCodemodeMethods(code: string): string[] {
  const methods = new Set<string>();
  for (const match of code.matchAll(/codemode\.([A-Za-z0-9_]+)/g)) {
    methods.add(match[1]);
  }
  return [...methods].sort();
}

function extractPatchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    files.add(match[1]);
  }
  return [...files].slice(0, 80);
}

function summarizeArgs(toolName: string, args: any): JsonRecord {
  if (!args || typeof args !== "object") return {};

  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return {
      commandHash: command ? hashText(command) : undefined,
      commandChars: command.length,
      firstWord: firstShellWord(command),
      timeout: args.timeout,
    };
  }

  if (toolName === "process") {
    const command = typeof args.command === "string" ? args.command : "";
    return {
      action: args.action,
      name: args.name,
      commandHash: command ? hashText(command) : undefined,
      commandChars: command.length || undefined,
      logWatches: Array.isArray(args.logWatches) ? args.logWatches.length : undefined,
    };
  }

  if (toolName === "cf_execute") {
    const code = typeof args.code === "string" ? args.code : "";
    return {
      mode: args.mode,
      codeHash: code ? hashText(code) : undefined,
      codeChars: code.length,
      codemodeMethods: extractCodemodeMethods(code),
    };
  }

  if (toolName === "cf_codemode_schema") {
    return {
      query: typeof args.query === "string" ? args.query.slice(0, MAX_TEXT_SAMPLE) : undefined,
      methods: Array.isArray(args.methods) ? args.methods.slice(0, 50) : undefined,
      maxItems: args.maxItems,
    };
  }

  if (toolName === "read") {
    return { path: args.path, offset: args.offset, limit: args.limit };
  }

  if (toolName === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    return { path: args.path, contentChars: content.length, contentHash: content ? hashText(content) : undefined };
  }

  if (toolName === "edit") {
    return {
      path: args.path,
      multiCount: Array.isArray(args.multi) ? args.multi.length : undefined,
      oldTextChars: typeof args.oldText === "string" ? args.oldText.length : undefined,
      newTextChars: typeof args.newText === "string" ? args.newText.length : undefined,
    };
  }

  if (toolName === "apply_patch") {
    const input = typeof args.input === "string" ? args.input : "";
    return { patchHash: input ? hashText(input) : undefined, patchChars: input.length, patchFiles: extractPatchFiles(input) };
  }

  if (toolName === "finder" || toolName === "librarian") {
    const query = typeof args.query === "string" ? args.query : "";
    return { queryHash: query ? hashText(query) : undefined, queryChars: query.length, limit: args.limit };
  }

  if (toolName === "skill_lookup") {
    const query = typeof args.query === "string" ? args.query : "";
    return {
      queryHash: query ? hashText(query) : undefined,
      queryChars: query.length,
      name: typeof args.name === "string" ? args.name : undefined,
      includeVisible: args.includeVisible,
      limit: args.limit,
    };
  }

  if (toolName === "ask_user_question") {
    return { questionCount: Array.isArray(args.questions) ? args.questions.length : undefined };
  }

  return {
    keys: Object.keys(args).slice(0, 40),
  };
}

function summarizeResult(toolName: string, result: any, isError: boolean): JsonRecord {
  const text = textContent(result?.content);
  const summary: JsonRecord = {
    isError,
    textChars: text.length,
    errorClass: isError || text ? classifyText(text) : undefined,
  };

  if (text && (isError || toolName === "bash" || toolName === "process")) {
    summary.textSample = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_SAMPLE);
  }

  const details = result?.details;
  if (details && typeof details === "object") {
    const workerPromptCompiler = (details as any).workerPromptCompiler;
    if (workerPromptCompiler && typeof workerPromptCompiler === "object") {
      summary.workerPromptCompiler = {
        status: workerPromptCompiler.status,
        adapter: workerPromptCompiler.adapter,
        mode: workerPromptCompiler.mode,
        reason: typeof workerPromptCompiler.reason === "string" ? workerPromptCompiler.reason.slice(0, MAX_TEXT_SAMPLE) : undefined,
      };
    }

    const toolOutputBudget = (details as any).toolOutputBudget;
    if (toolOutputBudget && typeof toolOutputBudget === "object") {
      summary.toolOutputBudget = {
        compacted: Boolean(toolOutputBudget.compacted),
        originalTokens: toolOutputBudget.originalTokens,
        compactedTokens: toolOutputBudget.compactedTokens,
        originalChars: toolOutputBudget.originalChars,
        thresholdTokens: toolOutputBudget.thresholdTokens,
        targetTokens: toolOutputBudget.targetTokens,
        strategy: toolOutputBudget.strategy,
      };
    }
  }

  return summary;
}

function summarizeDiagnostics(message: any): JsonRecord[] {
  const diagnostics = Array.isArray(message?.diagnostics) ? message.diagnostics : [];
  return diagnostics.slice(0, 20).map((diag: any) => ({
    type: diag?.type,
    errorName: diag?.error?.name,
    errorMessage: typeof diag?.error?.message === "string" ? diag.error.message.slice(0, MAX_TEXT_SAMPLE) : undefined,
    dataReason: typeof diag?.data?.reason === "string" ? diag.data.reason : undefined,
  }));
}

export default function piHarnessTelemetry(pi: ExtensionAPI) {
  if (!ENABLED) return;

  const startedAtByToolCall = new Map<string, number>();

  pi.on("session_start", (_event, ctx) => {
    writeTelemetry(ctx, "session_start");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    writeTelemetry(ctx, "session_shutdown");
  });

  pi.on("input", (event, ctx) => {
    const text = typeof event.text === "string" ? event.text : "";
    writeTelemetry(ctx, "input", {
      inputSource: event.source,
      inputChars: text.length,
      inputHash: text ? hashText(text) : undefined,
    });
  });

  pi.on("before_agent_start", (event, ctx) => {
    const skills = Array.isArray(event.systemPromptOptions?.skills)
      ? event.systemPromptOptions.skills.map((skill: any) => skill?.name).filter(Boolean).slice(0, 120)
      : [];
    writeTelemetry(ctx, "before_agent_start", {
      promptChars: event.prompt.length,
      promptHash: hashText(event.prompt),
      selectedTools: event.systemPromptOptions?.selectedTools ?? [],
      skillNames: skills,
      skillCount: skills.length,
      contextFileCount: Array.isArray(event.systemPromptOptions?.contextFiles) ? event.systemPromptOptions.contextFiles.length : 0,
    });
  });

  pi.on("model_select", (event, ctx) => {
    writeTelemetry(ctx, "model_select", {
      selectedModel: { provider: event.model.provider, api: event.model.api, id: event.model.id },
      previousModel: event.previousModel ? { provider: event.previousModel.provider, api: event.previousModel.api, id: event.previousModel.id } : undefined,
      modelSelectSource: event.source,
    });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    writeTelemetry(ctx, "thinking_level_select", { level: event.level, previousLevel: event.previousLevel });
  });

  pi.on("user_bash", (event, ctx) => {
    const command = typeof event.command === "string" ? event.command : "";
    writeTelemetry(ctx, "user_bash", {
      mode: ctx.mode,
      excludeFromContext: event.excludeFromContext,
      commandHash: command ? hashText(command) : undefined,
      commandChars: command.length,
      firstWord: firstShellWord(command),
      sessionEnvironment: bashSessionEnvironment(ctx),
    });
  });

  pi.on("turn_start", (event, ctx) => {
    writeTelemetry(ctx, "turn_start", { turnIndex: event.turnIndex, turnTimestamp: event.timestamp });
  });

  pi.on("turn_end", (event, ctx) => {
    writeTelemetry(ctx, "turn_end", {
      turnIndex: event.turnIndex,
      messageRole: (event.message as any)?.role,
      toolResultCount: event.toolResults?.length ?? 0,
      failedToolResultCount: (event.toolResults ?? []).filter((result: any) => result?.isError).length,
    });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    startedAtByToolCall.set(event.toolCallId, Date.now());
    writeTelemetry(ctx, "tool_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: summarizeArgs(event.toolName, event.args),
      sessionEnvironment: event.toolName === "bash" ? bashSessionEnvironment(ctx) : undefined,
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const startedAt = startedAtByToolCall.get(event.toolCallId);
    startedAtByToolCall.delete(event.toolCallId);
    writeTelemetry(ctx, "tool_end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      durationMs: startedAt ? Date.now() - startedAt : undefined,
      result: summarizeResult(event.toolName, event.result, event.isError),
    });
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as any;
    if (message?.role !== "assistant") return;
    writeTelemetry(ctx, "assistant_message", {
      provider: message.provider,
      api: message.api,
      model: message.model,
      stopReason: message.stopReason,
      errorMessage: typeof message.errorMessage === "string" ? message.errorMessage.slice(0, MAX_TEXT_SAMPLE) : undefined,
      responseId: message.responseId,
      usage: message.usage
        ? {
            input: message.usage.input,
            output: message.usage.output,
            cacheRead: message.usage.cacheRead,
            cacheWrite: message.usage.cacheWrite,
            totalTokens: message.usage.totalTokens,
            costTotal: message.usage.cost?.total,
          }
        : undefined,
      diagnostics: summarizeDiagnostics(message),
    });
  });
}
