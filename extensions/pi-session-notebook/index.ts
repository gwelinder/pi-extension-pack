import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

type ToolState = {
  paths: Set<string>;
  commands: string[];
  errors: string[];
  lastToolNames: string[];
  sessionLineage?: string;
};

const NOTEBOOK_DIR = join(homedir(), ".pi", "agent", "session-notebooks");
const MAX_INJECT_CHARS = 7000;
const MAX_LIST_ITEMS = 8;
const MAX_WORKLOG_LINES = 20;
const MAX_ERROR_LINES = 12;

const TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler._

# Session Lineage
_How this session started, whether it resumed or forked from another session, and any continuity notes worth preserving._

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task Specification
_What did the user ask to build? Any design decisions or other explanatory context._

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections._

# Key Results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here._

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step._
`;

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function ensureNotebook(path: string): void {
  ensureDir(NOTEBOOK_DIR);
  if (!existsSync(path)) {
    writeFileSync(path, TEMPLATE, "utf8");
  }
}

function notebookPath(sessionId: string): string {
  return join(NOTEBOOK_DIR, `${sessionId}.md`);
}

function notebookPathFromSessionFile(sessionFile: string): string {
  const fileName = basename(sessionFile).replace(/\.(jsonl|json)$/i, "");
  return notebookPath(fileName);
}

function truncate(text: string, max = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content as any[]) {
    if (part?.type === "text" && typeof part.text === "string") chunks.push(part.text);
  }
  return chunks.join("\n").trim();
}

function extractToolCalls(content: unknown): Array<{ name: string; arguments: any }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ name: string; arguments: any }> = [];
  for (const part of content as any[]) {
    if (part?.type === "toolCall" && typeof part.name === "string") {
      calls.push({ name: part.name, arguments: part.arguments ?? {} });
    }
  }
  return calls;
}

function readNotebook(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return TEMPLATE;
  }
}

function parseNotebookSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split("\n");
  let currentHeader = "";
  let buffer: string[] = [];
  let skippingItalic = false;

  const flush = () => {
    if (currentHeader) {
      sections[currentHeader] = buffer.join("\n").trim();
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("# ")) {
      flush();
      currentHeader = line.slice(2).trim();
      buffer = [];
      skippingItalic = true;
      continue;
    }
    if (skippingItalic) {
      if (line.startsWith("_") && line.endsWith("_")) {
        skippingItalic = false;
        continue;
      }
      if (!line.trim()) continue;
      skippingItalic = false;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function formatBulletList(items: string[], limit = MAX_LIST_ITEMS): string {
  const unique = [...new Set(items.map((s) => truncate(s)).filter(Boolean))].slice(0, limit);
  return unique.map((item) => `- ${item}`).join("\n");
}

function mergeBulletSections(existing: string, additions: string[], limit: number): string {
  const existingItems = existing
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  const merged = [...existingItems, ...additions].filter(Boolean);
  return formatBulletList(merged, limit);
}

function titleFromText(input: string): string {
  const raw = truncate(input, 72).replace(/[.?!]+$/, "");
  if (!raw) return "Session notebook";
  const words = raw.split(/\s+/).slice(0, 10);
  const title = words.join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function buildNotebook(sections: Record<string, string>): string {
  const ordered: Array<[string, string]> = [
    ["Session Title", "_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler._"],
    ["Session Lineage", "_How this session started, whether it resumed or forked from another session, and any continuity notes worth preserving._"],
    ["Current State", "_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._"],
    ["Task Specification", "_What did the user ask to build? Any design decisions or other explanatory context._"],
    ["Files and Functions", "_What are the important files? In short, what do they contain and why are they relevant?_"],
    ["Workflow", "_What bash commands are usually run and in what order? How to interpret their output if not obvious?_"],
    ["Errors & Corrections", "_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_"],
    ["Learnings", "_What has worked well? What has not? What to avoid? Do not duplicate items from other sections._"],
    ["Key Results", "_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here._"],
    ["Worklog", "_Step by step, what was attempted, done? Very terse summary for each step._"],
  ];

  return ordered
    .map(([header, italic]) => `# ${header}\n${italic}\n\n${(sections[header] || "").trim()}\n`)
    .join("\n")
    .replace(/\n{4,}/g, "\n\n");
}

function getBranchMessages(ctx: Parameters<NonNullable<Parameters<ExtensionAPI["on"]>[1]>>[1]): any[] {
  return ctx.sessionManager
    .getBranch()
    .filter((entry: any) => entry?.type === "message" && entry?.message)
    .map((entry: any) => entry.message);
}

function extractPathsFromToolCall(toolName: string, input: any): string[] {
  if (!input || typeof input !== "object") return [];
  const out: string[] = [];
  if (typeof input.path === "string") out.push(input.path);
  if (typeof input.file_path === "string") out.push(input.file_path);
  if (Array.isArray(input.edits) && typeof input.path === "string") out.push(input.path);
  if (toolName === "write" && typeof input.path === "string") out.push(input.path);
  return out;
}

export default function piSessionNotebook(pi: ExtensionAPI) {
  const sessionState = new Map<string, ToolState>();

  function stateFor(sessionId: string): ToolState {
    const existing = sessionState.get(sessionId);
    if (existing) return existing;
    const next: ToolState = { paths: new Set(), commands: [], errors: [], lastToolNames: [], sessionLineage: undefined };
    sessionState.set(sessionId, next);
    return next;
  }

  pi.on("session_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const path = notebookPath(sessionId);
    const state = stateFor(sessionId);
    state.paths = new Set();
    state.commands = [];
    state.errors = [];
    state.lastToolNames = [];

    let forkSeeded = false;
    if (!existsSync(path) && event.reason === "fork" && event.previousSessionFile) {
      const previousNotebookPath = notebookPathFromSessionFile(event.previousSessionFile);
      if (existsSync(previousNotebookPath)) {
        writeFileSync(path, readNotebook(previousNotebookPath), "utf8");
        forkSeeded = true;
      }
    }

    ensureNotebook(path);
    const sections = parseNotebookSections(readNotebook(path));
    const lineageLines = [
      `- Start reason: ${event.reason}`,
      `- Session file: ${ctx.sessionManager.getSessionFile() || "ephemeral"}`,
    ];
    if (event.previousSessionFile) lineageLines.push(`- Previous session: ${event.previousSessionFile}`);
    if (forkSeeded) lineageLines.push(`- Fork continuity: seeded from previous notebook`);
    state.sessionLineage = lineageLines.join("\n");
    sections["Session Lineage"] = state.sessionLineage;
    writeFileSync(path, buildNotebook(sections), "utf8");
  });

  pi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = stateFor(sessionId);
    state.lastToolNames.push(event.toolName);
    state.lastToolNames = state.lastToolNames.slice(-12);

    const paths = extractPathsFromToolCall(event.toolName, (event as any).input);
    for (const path of paths) state.paths.add(path);

    if (event.toolName === "bash") {
      const command = (event as any).input?.command;
      if (typeof command === "string" && command.trim()) {
        state.commands.push(truncate(command, 200));
        state.commands = state.commands.slice(-MAX_LIST_ITEMS);
      }
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!event.isError) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const state = stateFor(sessionId);
    const result = event.result as any;
    const text = Array.isArray(result?.content)
      ? result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
      : "";
    const message = truncate(text || `Tool error in ${event.toolName}`, 240);
    if (message) {
      state.errors.push(message);
      state.errors = [...new Set(state.errors)].slice(-MAX_ERROR_LINES);
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const path = notebookPath(sessionId);
    ensureNotebook(path);
    const content = readNotebook(path);
    const injected = content.length > MAX_INJECT_CHARS ? `${content.slice(0, MAX_INJECT_CHARS).trim()}\n\n[Session notebook truncated]` : content;
    return {
      systemPrompt: `${_event.systemPrompt}\n\n# Session Notebook\nUse this as continuity context for the current session. Verify code/file claims against the current workspace if needed.\n\n<session_notebook path="${path}">\n${injected}\n</session_notebook>`,
    };
  });

  pi.on("turn_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const path = notebookPath(sessionId);
    ensureNotebook(path);

    const existing = parseNotebookSections(readNotebook(path));
    const state = stateFor(sessionId);
    const branchMessages = getBranchMessages(ctx);

    const firstUser = branchMessages.find((m) => m?.role === "user");
    const lastUser = [...branchMessages].reverse().find((m) => m?.role === "user");
    const lastAssistant = [...branchMessages].reverse().find((m) => m?.role === "assistant");

    const titleSeed = extractText(firstUser?.content) || extractText(lastUser?.content) || "Session notebook";
    const taskSpec = truncate(extractText(firstUser?.content) || extractText(lastUser?.content), 1200);
    const currentState = truncate(extractText(lastUser?.content) || extractText(event.message?.content) || extractText(lastAssistant?.content), 1200);
    const keyResults = truncate(extractText(lastAssistant?.content), 1500);

    const messageToolCalls = branchMessages.flatMap((m) => extractToolCalls(m?.content));
    for (const call of messageToolCalls) {
      for (const p of extractPathsFromToolCall(call.name, call.arguments)) state.paths.add(p);
      if (call.name === "bash" && typeof call.arguments?.command === "string") {
        state.commands.push(truncate(call.arguments.command, 200));
      }
    }
    state.commands = [...new Set(state.commands)].slice(-MAX_LIST_ITEMS);

    const fileItems = [...state.paths].slice(-MAX_LIST_ITEMS).map((p) => `${p}`);
    const workflowItems = state.commands.slice(-MAX_LIST_ITEMS);

    const worklogLine = truncate(
      [
        lastUser ? `User: ${extractText(lastUser.content)}` : "",
        state.lastToolNames.length ? `Tools: ${[...new Set(state.lastToolNames)].join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
      220
    );

    const worklog = mergeBulletSections(existing["Worklog"] || "", worklogLine ? [worklogLine] : [], MAX_WORKLOG_LINES);
    const errors = mergeBulletSections(existing["Errors & Corrections"] || "", state.errors, MAX_ERROR_LINES);
    const files = formatBulletList(fileItems, MAX_LIST_ITEMS);
    const workflow = formatBulletList(workflowItems, MAX_LIST_ITEMS);

    const learningsExisting = existing["Learnings"] || "";
    const learnings = learningsExisting || "- Prefer concise, durable notes. Verify code facts against the workspace when needed.";

    const nextSections: Record<string, string> = {
      "Session Title": titleFromText(titleSeed),
      "Session Lineage": state.sessionLineage || existing["Session Lineage"] || "",
      "Current State": currentState,
      "Task Specification": taskSpec,
      "Files and Functions": files,
      "Workflow": workflow,
      "Errors & Corrections": errors,
      "Learnings": learnings,
      "Key Results": keyResults,
      "Worklog": worklog,
    };

    writeFileSync(path, buildNotebook(nextSections), "utf8");
  });

  pi.registerCommand("notebook-status", {
    description: "Show the current session notebook path",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const state = stateFor(sessionId);
      const path = notebookPath(sessionId);
      ensureNotebook(path);
      const message = [`Session notebook: ${path}`, state.sessionLineage ? `Lineage: ${state.sessionLineage.replace(/\n/g, " | ")}` : null]
        .filter(Boolean)
        .join("\n");
      ctx.ui.notify(message, "info");
      pi.sendMessage({
        customType: "notebook-status",
        content: message,
        display: true,
        details: {
          path,
          sessionLineage: state.sessionLineage,
        },
      });
    },
  });
}
