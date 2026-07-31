import type { ImageContent, TextContent, ThinkingLevel as AiThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";

type ProcessInput = {
  action?: string;
  command?: string;
  name?: string;
  [key: string]: unknown;
};

type ContentPart = TextContent | ImageContent;

type WorkerAdapter = "claude-opus" | "claude" | "gpt55-codex" | "codex";

type CompilerSelection = {
  model: NonNullable<ExtensionContext["model"]>;
  reasoning: AiThinkingLevel | false;
  source: "configured" | "active-scoped";
};

type PromptReference = {
  originalToken: string;
  promptPath: string;
  replaceStart: number;
  replaceEnd: number;
  replacementKind: "stdin" | "pi-prompt-arg";
};

type CompileRecord = {
  status: "compiled" | "fallback" | "reused" | "skipped" | "failed" | "audit";
  adapter?: WorkerAdapter;
  processName?: string;
  originalPath?: string;
  compiledPath?: string;
  manifestPath?: string;
  skillPath?: string;
  reason?: string;
  fallbackReason?: string;
  summary?: string;
  mode: string;
};

const DEFAULT_SKILL_PATH = join(
  homedir(),
  ".pi/agent/reference/directional-prompting/plugins/directional-prompting/skills/directional-prompting/SKILL.md",
);
const SKILL_PATH = process.env.PI_WORKER_PROMPT_COMPILER_SKILL ?? DEFAULT_SKILL_PATH;
const MODE = (process.env.PI_WORKER_PROMPT_COMPILER_MODE ?? "auto").toLowerCase(); // auto | audit | off
const FAKE_REWRITER = process.env.PI_WORKER_PROMPT_COMPILER_FAKE === "1";
const CONTEXT_BUDGET = Number(process.env.PI_WORKER_PROMPT_COMPILER_CONTEXT_CHARS ?? 12000);
const ORIGINAL_PROMPT_BUDGET = Number(process.env.PI_WORKER_PROMPT_COMPILER_MAX_PROMPT_CHARS ?? 120000);
const MODEL_PROVIDER = process.env.PI_WORKER_PROMPT_COMPILER_PROVIDER ?? "openai-codex";
const MODEL_ID = process.env.PI_WORKER_PROMPT_COMPILER_MODEL ?? "gpt-5.5";
const REWRITE_DIRECTIONAL = process.env.PI_WORKER_PROMPT_COMPILER_REWRITE_DIRECTIONAL !== "0";
const COMPILER_VERSION = "pi-worker-prompt-compiler-v1";
const HARNESS_TELEMETRY_DIR = process.env.PI_HARNESS_TELEMETRY_DIR || join(homedir(), ".pi", "agent", "telemetry", "harness");
const HARNESS_TELEMETRY_ENABLED = process.env.PI_HARNESS_TELEMETRY !== "0";

const WORKER_COMMAND_RE = /\bclaude\b.*(?:--print|\s-p\b)|\bpi\b.*--provider\s+openai-codex|\bpi\b.*--model\s+gpt-5/i;
const ABSOLUTE_OR_HOME_PATH_RE = /(?:~|\/)[^\s`'"<>|;&)]+/g;
const JSON_KEY_RE = /"([A-Za-z_][A-Za-z0-9_\-]*)"\s*:/g;
const VALIDATION_COMMAND_RE = /(?:python3\s+[^\n`]*|pnpm\s+[^\n`]*|npm\s+[^\n`]*|bun\s+[^\n`]*|git\s+diff\s+--check[^\n`]*)/g;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function telemetryDay(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function sessionIdFromContext(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

function sessionFileFromContext(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile();
  } catch {
    return undefined;
  }
}

function resolveCompilerSelection(ctx: ExtensionContext): CompilerSelection {
  const configured = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
  if (ctx.scopedModels.length === 0) {
    if (!configured) throw new Error(`compiler model not available: ${MODEL_PROVIDER}/${MODEL_ID}`);
    return { model: configured, reasoning: "low", source: "configured" };
  }

  const scopedConfigured = ctx.scopedModels.find(
    (entry) => entry.model.provider === MODEL_PROVIDER && entry.model.id === MODEL_ID,
  );
  if (scopedConfigured && configured) {
    return {
      model: configured,
      reasoning: scopedConfigured.thinkingLevel === "off" ? false : scopedConfigured.thinkingLevel ?? "low",
      source: "configured",
    };
  }

  const activeScoped = ctx.model
    ? ctx.scopedModels.find(
        (entry) => entry.model.provider === ctx.model?.provider && entry.model.id === ctx.model?.id,
      )
    : undefined;
  if (ctx.model && activeScoped) {
    return {
      model: ctx.model,
      reasoning: activeScoped.thinkingLevel === "off" ? false : activeScoped.thinkingLevel ?? "low",
      source: "active-scoped",
    };
  }

  throw new Error(`no compiler model is available inside the session model scope`);
}

function writeCompilerTelemetry(ctx: ExtensionContext, record: CompileRecord, toolCallId?: string): void {
  if (!HARNESS_TELEMETRY_ENABLED) return;
  try {
    const ts = Date.now();
    mkdirSync(HARNESS_TELEMETRY_DIR, { recursive: true });
    appendFileSync(
      join(HARNESS_TELEMETRY_DIR, `${telemetryDay(ts)}.jsonl`),
      JSON.stringify({
        ts,
        iso: new Date(ts).toISOString(),
        source: "worker-prompt-compiler",
        event: "worker_prompt_compiler",
        sessionId: sessionIdFromContext(ctx),
        sessionFile: sessionFileFromContext(ctx),
        cwd: ctx.cwd,
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        reasoningLevel: ctx.thinkingLevel,
        toolCallId,
        status: record.status,
        adapter: record.adapter,
        processName: record.processName,
        mode: record.mode,
        originalPath: record.originalPath,
        compiledPath: record.compiledPath,
        manifestPath: record.manifestPath,
        reason: record.reason?.slice(0, 300),
        fallbackReason: record.fallbackReason?.slice(0, 300),
      }) + "\n",
      "utf8",
    );
  } catch {
    // Telemetry must never affect worker launch.
  }
}

function stripQuotes(token: string): string {
  const trimmed = token.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function expandShellVars(value: string, vars: Map<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    const key = braced || bare;
    return vars.get(key) ?? _match;
  });
}

function parseShellAssignments(command: string): Map<string, string> {
  const vars = new Map<string, string>();
  const assignmentRe = /(?:^|[\n;]\s*)([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;\n]+)/g;
  for (const match of command.matchAll(assignmentRe)) {
    const name = match[1];
    let value = stripQuotes(match[2] ?? "");
    value = expandShellVars(value, vars);
    // Skip dynamic shell expressions. They are not useful for path rewriting.
    if (/\$\(|`/.test(value)) continue;
    vars.set(name, value);
  }
  return vars;
}

function findLastCdDir(command: string, cwd: string, vars: Map<string, string>): string {
  let cdDir: string | undefined;
  const cdRe = /(?:^|[;&\n]\s*)cd\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;&|'\"]+)/g;
  for (const match of command.matchAll(cdRe)) {
    const raw = stripQuotes(match[1] ?? "");
    const expanded = expandShellVars(raw, vars);
    if (!expanded || /\$\(|`/.test(expanded)) continue;
    cdDir = expanded.startsWith("/") ? expanded : resolve(cwd, expanded);
  }
  return cdDir ?? cwd;
}

function resolvePromptPath(rawToken: string, cwd: string, cdDir: string, vars: Map<string, string>): string | null {
  let token = stripQuotes(rawToken.trim());
  if (token.startsWith("@")) token = token.slice(1);
  token = expandShellVars(token, vars);
  token = token.replace(/^@/, "");
  if (!token || /\$\(|`/.test(token)) return null;
  if (!/\.(?:md|txt|prompt)$/i.test(token) && !existsSync(token)) return null;
  if (token.startsWith("~")) return resolve(homedir(), token.slice(2));
  return token.startsWith("/") ? token : resolve(cdDir || cwd, token);
}

function detectAdapter(command: string): WorkerAdapter | null {
  if (/\bclaude\b/i.test(command) && /(?:--print|\s-p\b)/i.test(command)) {
    return /(?:--model\s+(?:claude-)?opus\b|\b--model\s+[^\n]*opus\b|\bopus\b)/i.test(command) ? "claude-opus" : "claude";
  }
  if (/\bpi\b/i.test(command) && /--provider\s+openai-codex/i.test(command)) {
    return /--model\s+gpt-5\.5\b/i.test(command) ? "gpt55-codex" : "codex";
  }
  return null;
}

function findPromptReference(command: string, cwd: string): PromptReference | null {
  if (!WORKER_COMMAND_RE.test(command)) return null;

  const vars = parseShellAssignments(command);
  const cdDir = findLastCdDir(command, cwd, vars);

  if (/\bclaude\b/i.test(command)) {
    const redirRe = /(<\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;&|'\"]+)/g;
    for (const match of command.matchAll(redirRe)) {
      const token = match[2] ?? "";
      const promptPath = resolvePromptPath(token, cwd, cdDir, vars);
      if (!promptPath) continue;
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      return {
        originalToken: token,
        promptPath,
        replaceStart: start,
        replaceEnd: start + token.length,
        replacementKind: "stdin",
      };
    }
  }

  if (/\bpi\b/i.test(command) && /--provider\s+openai-codex/i.test(command)) {
    const promptArgRe = /((?:^|\s)(?:-p|--prompt)\s+)("@[^"\n]+"|'@[^'\n]+'|@?[^\s;&|'\"]+)/g;
    for (const match of command.matchAll(promptArgRe)) {
      const token = match[2] ?? "";
      const promptPath = resolvePromptPath(token, cwd, cdDir, vars);
      if (!promptPath) continue;
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      return {
        originalToken: token,
        promptPath,
        replaceStart: start,
        replaceEnd: start + token.length,
        replacementKind: "pi-prompt-arg",
      };
    }
  }

  return null;
}

function replacePromptReference(command: string, ref: PromptReference, compiledPath: string): string {
  const replacement = ref.replacementKind === "pi-prompt-arg" ? `@${compiledPath}` : `"${compiledPath}"`;
  return command.slice(0, ref.replaceStart) + replacement + command.slice(ref.replaceEnd);
}

function isDirectionalPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("Goal:") && /\nSuccess means:\s*\n/i.test(text) && /\nStop when:\s*/i.test(text);
}

function buildCompiledPath(originalPath: string, adapter: WorkerAdapter, cacheHash: string): { compiledPath: string; manifestPath: string } {
  const dir = dirname(originalPath);
  const ext = extname(originalPath) || ".md";
  const stem = basename(originalPath, ext);
  const suffix = adapter.replace(/[^a-z0-9]+/gi, "-");
  const short = cacheHash.slice(0, 10);
  const compiledPath = join(dir, `${stem}.compiled-${suffix}-${short}${ext}`);
  const manifestPath = join(dir, `${stem}.compiled-${suffix}-${short}.manifest.json`);
  return { compiledPath, manifestPath };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextContent => part && typeof part === "object" && (part as ContentPart).type === "text")
    .map((part) => part.text)
    .join("\n");
}

function collectRecentContext(ctx: ExtensionContext, charBudget = CONTEXT_BUDGET): string {
  const branch = ctx.sessionManager.getBranch() as any[];
  const chunks: string[] = [];
  let used = 0;

  for (let i = branch.length - 1; i >= 0 && used < charBudget; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = contentText(message.content).trim();
    if (!text) continue;
    const clipped = text.length > 2500 ? text.slice(0, 1200) + "\n...[middle clipped]...\n" + text.slice(-1200) : text;
    const chunk = `### ${message.role.toUpperCase()}\n${clipped}`;
    chunks.push(chunk);
    used += chunk.length;
  }

  return chunks.reverse().join("\n\n").slice(-charBudget);
}

function extractSet(re: RegExp, text: string, normalize: (value: string) => string = (v) => v): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(re)) {
    const raw = match[1] ?? match[0];
    const normalized = normalize(raw.trim());
    if (normalized.length >= 2) values.add(normalized);
  }
  return [...values];
}

function criticalPaths(text: string): string[] {
  return extractSet(ABSOLUTE_OR_HOME_PATH_RE, text)
    .filter((value) => value.length > 6)
    .filter((value) => !value.includes("$("))
    .slice(0, 120);
}

function jsonKeys(text: string): string[] {
  return extractSet(JSON_KEY_RE, text).slice(0, 160);
}

function validationCommands(text: string): string[] {
  return extractSet(VALIDATION_COMMAND_RE, text, (v) => v.replace(/\s+/g, " ").trim()).slice(0, 40);
}

function validateCompiledPrompt(original: string, compiled: string): { ok: true } | { ok: false; reason: string } {
  if (!isDirectionalPrompt(compiled)) {
    return { ok: false, reason: "compiled prompt does not start with Goal / Success means / Stop when" };
  }
  if (compiled.length < Math.min(1200, Math.floor(original.length * 0.25))) {
    return { ok: false, reason: "compiled prompt is suspiciously short" };
  }

  const paths = criticalPaths(original);
  const missingPaths = paths.filter((path) => !compiled.includes(path));
  if (missingPaths.length > Math.max(3, Math.ceil(paths.length * 0.2))) {
    return { ok: false, reason: `compiled prompt dropped too many path references: ${missingPaths.slice(0, 8).join(", ")}` };
  }

  const keys = jsonKeys(original);
  if (keys.length > 0 && keys.length <= 120) {
    const missingKeys = keys.filter((key) => !compiled.includes(`"${key}"`));
    if (missingKeys.length > Math.max(5, Math.ceil(keys.length * 0.25))) {
      return { ok: false, reason: `compiled prompt dropped too many JSON/schema keys: ${missingKeys.slice(0, 12).join(", ")}` };
    }
  }

  const commands = validationCommands(original);
  const missingCommands = commands.filter((command) => !compiled.replace(/\s+/g, " ").includes(command));
  if (missingCommands.length > Math.max(2, Math.ceil(commands.length * 0.3))) {
    return { ok: false, reason: `compiled prompt dropped validation commands: ${missingCommands.slice(0, 4).join(" | ")}` };
  }

  return { ok: true };
}

function compilerSystemPrompt(skillText: string): string {
  return `You are Pi's worker-prompt compiler. Rewrite worker prompts for delegated coding agents.\n\nUse the following directional-prompting skill as the governing method. Apply its reasoning while preserving the task semantics exactly.\n\n<directional_prompting_skill>\n${skillText}\n</directional_prompting_skill>\n\nCompiler rules:\n- Return only the rewritten worker prompt. Do not wrap it in markdown fences.\n- Start the rewritten prompt with exactly: Goal:\n- Include: Success means: and Stop when:\n- Preserve every operational requirement from the original prompt: file paths, allowed write roots, schemas, JSON keys, artifact names, validation commands, final response formats, hard safety boundaries, and model/tool restrictions.\n- Preserve legitimate negations for hard safety boundaries, explicit banned actions, and scope limits. Rewrite soft warnings and vague prohibitions into positive action language.\n- Use recent parent-thread context only to clarify intent and hidden rationale. Do not invent new requirements that are absent from the original prompt or parent context.\n- Keep the worker prompt implementation-ready. Do not explain directional prompting, prompt theory, or this compiler.\n- Keep raw source text/secrets/private artifacts out exactly as the original prompt requires.\n- Prefer concise section headings and positive verbs. Every body sentence should name a destination or a step toward it.`;
}

function compilerUserPrompt(args: {
  adapter: WorkerAdapter;
  processName?: string;
  command: string;
  cwd: string;
  promptPath: string;
  recentContext: string;
  originalPrompt: string;
}): string {
  const adapterGuidance =
    args.adapter === "claude-opus" || args.adapter === "claude"
      ? "Target worker: Claude CLI. Give it a rich judgment frame, explicit success criteria, preserved hard gates, and a clear execution path. Claude handles nuanced adjudication well when the decision rubric is explicit."
      : "Target worker: Pi/OpenAI Codex. Give it a crisp outcome, exact scope, concrete work steps, verification commands, and output format. Codex performs best when autonomy is bounded by success criteria and required artifacts.";

  return `Compile this worker prompt.\n\n${adapterGuidance}\n\nProcess name: ${args.processName ?? "(unknown)"}\nCurrent cwd: ${args.cwd}\nLaunch command:\n\`\`\`bash\n${args.command}\n\`\`\`\nOriginal prompt path: ${args.promptPath}\n\nRecent parent-thread context:\n<parent_context>\n${args.recentContext || "(no recent context captured)"}\n</parent_context>\n\nOriginal worker prompt:\n<original_worker_prompt>\n${args.originalPrompt}\n</original_worker_prompt>\n\nReturn the compiled worker prompt now.`;
}

async function rewriteWithModel(args: {
  ctx: ExtensionContext;
  adapter: WorkerAdapter;
  processName?: string;
  command: string;
  cwd: string;
  promptPath: string;
  skillText: string;
  originalPrompt: string;
  recentContext: string;
  compiler: CompilerSelection;
}): Promise<string> {
  if (FAKE_REWRITER) {
    return [
      `Goal: Complete the delegated worker task from ${args.promptPath}.`,
      "",
      "Success means:",
      "  - All required artifacts, validations, and final reporting from the original prompt are completed.",
      "  - Scope, safety boundaries, file paths, schemas, and validation commands from the original prompt are preserved.",
      "",
      "Stop when: The original worker prompt's final response and validation requirements are satisfied.",
      "",
      "Use the following canonical task details. Execute them directly and preserve their hard constraints.",
      "",
      args.originalPrompt,
    ].join("\n");
  }

  const { model } = args.compiler;
  const auth = await args.ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}/${model.id}` : auth.error);
  const provider = args.ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error(`compiler provider not available: ${model.provider}`);

  const userMessage: UserMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: compilerUserPrompt({
          adapter: args.adapter,
          processName: args.processName,
          command: args.command,
          cwd: args.cwd,
          promptPath: args.promptPath,
          recentContext: args.recentContext,
          originalPrompt: args.originalPrompt,
        }),
      },
    ],
    timestamp: Date.now(),
  };

  const response = await provider
    .streamSimple(
      model,
      { systemPrompt: compilerSystemPrompt(args.skillText), messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: args.ctx.signal,
        reasoning: args.compiler.reasoning || undefined,
        maxTokens: 20000,
        timeoutMs: 180000,
        maxRetries: 1,
        sessionId: `pi-worker-prompt-compiler-${args.adapter}`,
      },
    )
    .result();

  const text = contentText(response.content).trim();
  if (!text) throw new Error(`compiler returned no text (stopReason=${response.stopReason})`);
  return text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function deterministicFallbackPrompt(args: { promptPath: string; adapter: WorkerAdapter; originalPrompt: string; reason: string }): string {
  return [
    `Goal: Complete the delegated worker task from ${args.promptPath}.`,
    "",
    "Success means:",
    "  - The original worker prompt below is executed faithfully, including all file paths, allowed write roots, artifact names, schemas, validation commands, and final response requirements.",
    "  - Hard safety boundaries and scope limits in the original prompt are preserved exactly.",
    "  - The final response explains what changed, what was validated, and any concrete blocker that remains.",
    "",
    "Stop when: The original worker prompt's success criteria, validation requirements, and final response format are satisfied, or a real blocker is documented with evidence.",
    "",
    `Compiler fallback: The model-based prompt rewrite failed (${args.reason}). This deterministic wrapper is intentionally conservative: use the original prompt as the source of truth and do not invent extra scope.`,
    `Target adapter: ${args.adapter}`,
    "",
    "Original worker prompt:",
    "",
    args.originalPrompt,
  ].join("\n");
}

async function compilePrompt(args: {
  ctx: ExtensionContext;
  adapter: WorkerAdapter;
  processName?: string;
  command: string;
  promptPath: string;
}): Promise<CompileRecord> {
  const mode = MODE;
  if (mode === "off") return { status: "skipped", reason: "compiler disabled", mode };
  if (args.promptPath.includes(".compiled-")) return { status: "skipped", reason: "prompt path already looks compiled", mode };
  if (!existsSync(args.promptPath)) {
    return { status: "failed", reason: `prompt file not found: ${args.promptPath}`, mode, adapter: args.adapter, originalPath: args.promptPath };
  }
  const stat = statSync(args.promptPath);
  if (!stat.isFile()) {
    return { status: "failed", reason: `prompt path is not a file: ${args.promptPath}`, mode, adapter: args.adapter, originalPath: args.promptPath };
  }
  if (stat.size > ORIGINAL_PROMPT_BUDGET) {
    return {
      status: "failed",
      reason: `prompt file too large for automatic rewrite (${stat.size} bytes > ${ORIGINAL_PROMPT_BUDGET})`,
      mode,
      adapter: args.adapter,
      originalPath: args.promptPath,
    };
  }

  const originalPrompt = readFileSync(args.promptPath, "utf8");
  if (!REWRITE_DIRECTIONAL && isDirectionalPrompt(originalPrompt)) {
    return { status: "skipped", reason: "prompt already has Goal / Success means / Stop when", mode, adapter: args.adapter, originalPath: args.promptPath };
  }
  if (!existsSync(SKILL_PATH)) {
    return { status: "failed", reason: `directional-prompting skill not found: ${SKILL_PATH}`, mode, adapter: args.adapter, originalPath: args.promptPath };
  }

  const skillText = readFileSync(SKILL_PATH, "utf8");
  const recentContext = collectRecentContext(args.ctx);
  let compiler: CompilerSelection | undefined;
  let compilerSelectionError: string | undefined;
  try {
    compiler = resolveCompilerSelection(args.ctx);
  } catch (error) {
    compilerSelectionError = error instanceof Error ? error.message : String(error);
  }
  const compilerModelKey = compiler ? `${compiler.model.provider}/${compiler.model.id}` : `${MODEL_PROVIDER}/${MODEL_ID}`;
  const compilerReasoningLevel = compiler?.reasoning === false ? "off" : compiler?.reasoning ?? "low";
  const cacheHash = sha256(
    JSON.stringify({
      version: COMPILER_VERSION,
      adapter: args.adapter,
      skillHash: sha256(skillText),
      originalHash: sha256(originalPrompt),
      contextHash: sha256(recentContext),
      compilerModel: compilerModelKey,
      compilerReasoning: compilerReasoningLevel,
      compilerScope: args.ctx.scopedModels.length > 0 ? "scoped" : "all",
    }),
  );
  const { compiledPath, manifestPath } = buildCompiledPath(args.promptPath, args.adapter, cacheHash);

  if (existsSync(compiledPath) && existsSync(manifestPath)) {
    let existingStatus: string | undefined;
    try {
      existingStatus = JSON.parse(readFileSync(manifestPath, "utf8"))?.status;
    } catch {
      existingStatus = undefined;
    }
    if (existingStatus !== "fallback") {
      return {
        status: mode === "audit" ? "audit" : "reused",
        mode,
        adapter: args.adapter,
        processName: args.processName,
        originalPath: args.promptPath,
        compiledPath,
        manifestPath,
        skillPath: SKILL_PATH,
        summary: "Reused existing compiled worker prompt for the same original/context hash.",
      };
    }
  }

  if (mode === "audit") {
    return {
      status: "audit",
      mode,
      adapter: args.adapter,
      processName: args.processName,
      originalPath: args.promptPath,
      compiledPath,
      manifestPath,
      skillPath: SKILL_PATH,
      summary: "Audit mode: would compile this worker prompt with directional-prompting + parent context.",
    };
  }

  let compiled: string;
  let fallbackReason: string | undefined;
  try {
    if (!compiler) throw new Error(compilerSelectionError ?? "compiler model selection failed");
    compiled = await rewriteWithModel({
      ctx: args.ctx,
      adapter: args.adapter,
      processName: args.processName,
      command: args.command,
      cwd: args.ctx.cwd,
      promptPath: args.promptPath,
      skillText,
      originalPrompt,
      recentContext,
      compiler,
    });

    const validation = validateCompiledPrompt(originalPrompt, compiled);
    if (!validation.ok) {
      fallbackReason = validation.reason;
      compiled = deterministicFallbackPrompt({
        promptPath: args.promptPath,
        adapter: args.adapter,
        originalPrompt,
        reason: validation.reason,
      });
    }
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error);
    compiled = deterministicFallbackPrompt({
      promptPath: args.promptPath,
      adapter: args.adapter,
      originalPrompt,
      reason: fallbackReason,
    });
  }

  writeFileSync(compiledPath, compiled.endsWith("\n") ? compiled : compiled + "\n", "utf8");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: COMPILER_VERSION,
        status: fallbackReason ? "fallback" : "compiled",
        mode,
        compilerModel: compilerModelKey,
        compilerModelSource: compiler?.source,
        compilerReasoning: compilerReasoningLevel,
        compilerScope: args.ctx.scopedModels.length > 0 ? "scoped" : "all",
        parentSession: {
          id: sessionIdFromContext(args.ctx),
          file: sessionFileFromContext(args.ctx),
          provider: args.ctx.model?.provider,
          model: args.ctx.model?.id,
          reasoningLevel: args.ctx.thinkingLevel,
        },
        adapter: args.adapter,
        processName: args.processName,
        originalPath: args.promptPath,
        compiledPath,
        skillPath: SKILL_PATH,
        originalHash: sha256(originalPrompt),
        compiledHash: sha256(compiled),
        skillHash: sha256(skillText),
        contextHash: sha256(recentContext),
        cacheHash,
        fallbackReason,
        generatedAt: new Date().toISOString(),
        preserved: {
          criticalPathCount: criticalPaths(originalPrompt).length,
          jsonKeyCount: jsonKeys(originalPrompt).length,
          validationCommandCount: validationCommands(originalPrompt).length,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return {
    status: fallbackReason ? "fallback" : "compiled",
    mode,
    adapter: args.adapter,
    processName: args.processName,
    originalPath: args.promptPath,
    compiledPath,
    manifestPath,
    skillPath: SKILL_PATH,
    fallbackReason,
    summary: fallbackReason
      ? `Created deterministic fallback compiled prompt after model rewrite failed or failed validation: ${fallbackReason}`
      : `Compiled worker prompt with ${compilerModelKey} ${compilerReasoningLevel} reasoning using full directional-prompting skill and recent parent context.`,
  };
}

function appendTextContent(content: ContentPart[], text: string): ContentPart[] {
  return [...content, { type: "text", text }];
}

function noteForRecord(record: CompileRecord): string {
  if (record.status === "compiled" || record.status === "fallback" || record.status === "reused") {
    const verb = record.status === "compiled" ? "Rewrote" : record.status === "fallback" ? "Created fallback compiled" : "Reused compiled";
    return [
      "",
      `[worker-prompt-compiler] ${verb} worker prompt using directional-prompting + recent parent context.`,
      `Target adapter: ${record.adapter}`,
      `Original: ${record.originalPath}`,
      `Compiled: ${record.compiledPath}`,
      `Manifest: ${record.manifestPath}`,
      `Skill reference: ${record.skillPath}`,
      `Configured compiler: ${MODEL_PROVIDER}/${MODEL_ID} reasoning=low (falls back to the active model when session scope excludes it)`,
      record.fallbackReason ? `Fallback reason: ${record.fallbackReason}` : undefined,
      "The launch command was updated to use the compiled prompt. Future worker prompts should start with Goal / Success means / Stop when and use positive directional execution language.",
    ].filter(Boolean).join("\n");
  }
  if (record.status === "audit") {
    return [
      "",
      "[worker-prompt-compiler] Audit mode: detected a worker prompt that would be rewritten before launch.",
      `Target adapter: ${record.adapter}`,
      `Original: ${record.originalPath}`,
      `Planned compiled path: ${record.compiledPath}`,
      `Skill reference: ${record.skillPath}`,
      "Set PI_WORKER_PROMPT_COMPILER_MODE=auto to rewrite and launch compiled prompts automatically.",
    ].join("\n");
  }
  if (record.status === "failed") {
    return [
      "",
      "[worker-prompt-compiler] Prompt rewrite failed; launched the original worker prompt unchanged.",
      record.adapter ? `Target adapter: ${record.adapter}` : undefined,
      record.originalPath ? `Original: ${record.originalPath}` : undefined,
      `Reason: ${record.reason ?? "unknown"}`,
      record.skillPath ? `Skill reference: ${record.skillPath}` : `Skill reference: ${SKILL_PATH}`,
      "For future launches, write worker prompts with Goal / Success means / Stop when and positive directional execution language.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export default function workerPromptCompiler(pi: ExtensionAPI) {
  const recordsByToolCall = new Map<string, CompileRecord>();
  let stats = { compiled: 0, fallback: 0, reused: 0, audit: 0, skipped: 0, failed: 0 };

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "process") return;
    const input = event.input as ProcessInput;
    if (input.action !== "start" || typeof input.command !== "string") return;
    if (MODE === "off") return;

    const adapter = detectAdapter(input.command);
    if (!adapter) return;
    const ref = findPromptReference(input.command, ctx.cwd);
    if (!ref) {
      const reason =
        "[worker-prompt-compiler] Worker launch detected, but no prompt file reference was found. Write the worker prompt to a file and launch Claude with `< prompt.md` or Pi/Codex with `-p @prompt.md` so the compiler can rewrite it with directional-prompting + parent context before start.";
      const record: CompileRecord = {
        status: "failed",
        mode: MODE,
        adapter,
        processName: input.name,
        reason,
      };
      stats.failed++;
      recordsByToolCall.set(event.toolCallId, record);
      writeCompilerTelemetry(ctx, record, event.toolCallId);
      if (MODE !== "audit") return { block: true, reason };
      return;
    }

    try {
      const record = await compilePrompt({
        ctx,
        adapter,
        processName: input.name,
        command: input.command,
        promptPath: ref.promptPath,
      });

      stats[record.status] = (stats[record.status] ?? 0) + 1;
      recordsByToolCall.set(event.toolCallId, record);
      writeCompilerTelemetry(ctx, record, event.toolCallId);

      if (record.status === "failed" && /prompt (?:file not found|path is not a file)/i.test(record.reason ?? "")) {
        return {
          block: true,
          reason: `[worker-prompt-compiler] ${record.reason}. The worker launch would fail or run without the intended prompt; recreate the prompt file and launch again.`,
        };
      }

      if ((record.status === "compiled" || record.status === "fallback" || record.status === "reused") && record.compiledPath) {
        input.command = replacePromptReference(input.command, ref, record.compiledPath);
      }
    } catch (error) {
      const record: CompileRecord = {
        status: "failed",
        mode: MODE,
        adapter,
        processName: input.name,
        originalPath: ref.promptPath,
        skillPath: SKILL_PATH,
        reason: error instanceof Error ? error.message : String(error),
      };
      stats.failed++;
      recordsByToolCall.set(event.toolCallId, record);
      writeCompilerTelemetry(ctx, record, event.toolCallId);
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "process") return;
    const record = recordsByToolCall.get(event.toolCallId);
    if (!record) return;
    recordsByToolCall.delete(event.toolCallId);
    const note = noteForRecord(record);
    if (!note) return;
    return {
      content: appendTextContent(event.content, note),
      details: {
        ...(event.details as Record<string, unknown>),
        workerPromptCompiler: record,
      },
    };
  });

  pi.on("before_agent_start", (event) => {
    if (MODE === "off") return;
    if (!/(worker|workers|delegate|delegation|orchestrat|fan[- ]?out|claude\s+-p|claude\s+--print|openai-codex|gpt-5\.5)/i.test(event.prompt)) {
      return;
    }
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\nWorker prompt compiler is active for process.start worker launches. When launching Claude workers, write prompts to files and run Claude with \`< prompt.md\`; when launching Pi/Codex workers, write prompts to files and run Pi with \`-p @prompt.md\`. The compiler will use the full directional-prompting skill plus recent parent context to rewrite uncompiled worker prompts before launch and will report the compiled path back to you.`,
    };
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI && MODE !== "off") {
      ctx.ui.setStatus("worker-prompts", MODE === "audit" ? "wp:audit" : "wp:auto");
    }
  });

  pi.on("session_shutdown", () => {
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.error(
        `[worker-prompt-compiler] Session: compiled=${stats.compiled} fallback=${stats.fallback} reused=${stats.reused} audit=${stats.audit} skipped=${stats.skipped} failed=${stats.failed} (${total} total)`,
      );
    }
  });
}
