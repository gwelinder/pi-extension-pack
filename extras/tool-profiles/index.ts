import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CORE_TOOLS = [
  "read",
  "bash",
  "edit",
  "apply_patch",
  "write",
  "skill_lookup",
  "tool_lookup",
  "finder",
  "ask_user_question",
];

const SEARCH_TOOLS = [
  ...CORE_TOOLS,
  "exa",
  "librarian",
  "rich_fetch",
];

const ORCH_TOOLS = [
  ...CORE_TOOLS,
  "process",
];

const DESIGN_TOOLS = [
  ...CORE_TOOLS,
  "open_design_gallery",
  "design_deck",
  "deck_generate",
  "duel_deck",
];

const CLOUDFLARE_TOOLS = [
  ...CORE_TOOLS,
  "cf_codemode_schema",
  "cf_execute",
];

const FULL_TOOLS = [
  ...SEARCH_TOOLS,
  ...ORCH_TOOLS,
  ...DESIGN_TOOLS,
  ...CLOUDFLARE_TOOLS,
];

const BROWSER_EVAL_TOOLS = [
  ...SEARCH_TOOLS,
  "rich_fetch",
  "interactive_shell",
];

const PROFILES = {
  lean: CORE_TOOLS,
  search: SEARCH_TOOLS,
  orch: ORCH_TOOLS,
  design: DESIGN_TOOLS,
  cloudflare: CLOUDFLARE_TOOLS,
  full: FULL_TOOLS,
  browser: BROWSER_EVAL_TOOLS,
} as const;

// Project-local first-class tools should ride along with every profile when
// available, without causing "missing tool" noise outside those projects.
const AUTO_INCLUDED_TOOLS = ["codegraph", "memory"];

const LOADABLE_PROFILES = ["search", "orch", "design", "cloudflare", "browser"] as const;

const PROFILE_SEARCH_TERMS: Record<(typeof LOADABLE_PROFILES)[number], string> = {
  search: "search research web sources citations recent url pdf transcript github librarian exa fetch",
  orch: "worker subagent dispatch process background long-running tmux session codex claude orchestration",
  design: "design frontend ui ux visual mockup prototype gallery deck image",
  cloudflare: "cloudflare workers wrangler durable objects d1 r2 dns zone kv",
  browser: "browser chrome website login screenshot scrape click form playwright automation",
};

type ProfileName = keyof typeof PROFILES;

const ALIASES: Record<string, ProfileName> = {
  default: "lean",
  core: "lean",
  lean: "lean",
  l: "lean",
  search: "search",
  research: "search",
  web: "search",
  s: "search",
  orch: "orch",
  orchestrator: "orch",
  delegate: "orch",
  agents: "orch",
  o: "orch",
  design: "design",
  deck: "design",
  ui: "design",
  d: "design",
  cloudflare: "cloudflare",
  cf: "cloudflare",
  full: "full",
  all: "full",
  f: "full",
  browser: "browser",
  browsers: "browser",
  "browser-eval": "browser",
  be: "browser",
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeProfile(raw: string | undefined): ProfileName | undefined {
  if (!raw) return undefined;
  return ALIASES[raw.trim().toLowerCase()];
}

function requestedToolsForProfile(profile: ProfileName, available: Set<string>): string[] {
  return unique([
    ...PROFILES[profile],
    ...AUTO_INCLUDED_TOOLS.filter((name) => available.has(name)),
  ]);
}

function setTools(pi: ExtensionAPI, profile: ProfileName): { active: string[]; missing: string[] } {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const requested = requestedToolsForProfile(profile, available);
  const active = requested.filter((name) => available.has(name));
  const missing = requested.filter((name) => !available.has(name));
  pi.setActiveTools(active);
  return { active, missing };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

function detectProfile(active: string[]): ProfileName | "custom" {
  const activeSet = new Set(active);
  for (const name of Object.keys(PROFILES) as ProfileName[]) {
    if (sameSet(active, requestedToolsForProfile(name, activeSet))) return name;
  }
  return "custom";
}

function statusLine(pi: ExtensionAPI): string {
  const active = pi.getActiveTools();
  return `tools:${detectProfile(active)}(${active.length})`;
}

function updateStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("tool-profiles", statusLine(pi));
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1))];
}

function scoreText(tokens: string[], text: string): number {
  const normalized = text.toLowerCase();
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0);
}

function findToolsToLoad(pi: ExtensionAPI, query: string, limit: number): { group?: string; tools: string[] } {
  const tokens = tokenize(query);
  const active = new Set(pi.getActiveTools());
  const allTools = pi.getAllTools();
  const available = new Set(allTools.map((tool) => tool.name));

  const group = LOADABLE_PROFILES
    .map((name) => ({ name, score: scoreText(tokens, `${name} ${PROFILE_SEARCH_TERMS[name]}`) }))
    .sort((a, b) => b.score - a.score)[0];

  if (group && group.score > 0) {
    const tools = requestedToolsForProfile(group.name, available)
      .filter((name) => !CORE_TOOLS.includes(name) && !active.has(name))
      .slice(0, limit);
    if (tools.length > 0) return { group: group.name, tools };
  }

  const tools = allTools
    .filter((tool) => !active.has(tool.name) && tool.name !== "tool_lookup")
    .map((tool) => ({
      name: tool.name,
      score: scoreText(tokens, `${tool.name} ${tool.description ?? ""}`),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((candidate) => candidate.name);

  return { tools };
}

function insertPrefix(ctx: ExtensionContext, prefix: string): void {
  if (!ctx.hasUI) return;
  const current = ctx.ui.getEditorText();
  if (!current.trim()) {
    ctx.ui.setEditorText(`${prefix} `);
    return;
  }
  if (current.startsWith("+")) {
    ctx.ui.setEditorText(current.replace(/^\+\S+\s*/, `${prefix} `));
    return;
  }
  ctx.ui.setEditorText(`${prefix} ${current}`);
}

function profileTable(pi: ExtensionAPI): string {
  const active = pi.getActiveTools();
  const current = detectProfile(active);
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const rows = (Object.keys(PROFILES) as ProfileName[])
    .map((name) => {
      const marker = current === name ? "*" : " ";
      const tools = requestedToolsForProfile(name, available);
      return `${marker} ${name.padEnd(6)} ${String(tools.length).padStart(2)} tools  ${tools.join(",")}`;
    })
    .join("\n");
  return [
    `Current: ${current} (${active.length} active tools)`,
    "",
    rows,
    "",
    "Sessions start lean. The model can call tool_lookup to add capabilities at a cache-preserving tool-result boundary. Use `/tools <profile>` or a `+search`, `+orch`, `+design`, `+cloudflare`, `+lean`, `+full`, or `+browser` prefix for an explicit profile replacement.",
  ].join("\n");
}

function parseProfileAndRest(args: string): { profile?: ProfileName; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { rest: "" };
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const profile = normalizeProfile(match?.[1]);
  return { profile, rest: match?.[2] ?? "" };
}

export default function toolProfiles(pi: ExtensionAPI) {
  pi.registerFlag("tool-profile", {
    description: "Initial active tool profile: lean, search, orch, design, cloudflare, browser, or full",
    type: "string",
    default: "lean",
  });

  pi.on("session_start", async (_event, ctx) => {
    const configured = String(pi.getFlag("tool-profile") || process.env.PI_TOOL_PROFILE || "lean");
    const initial = normalizeProfile(configured) ?? "lean";
    setTools(pi, initial);
    updateStatus(pi, ctx);
  });

  pi.registerTool({
    name: "tool_lookup",
    label: "Tool Lookup",
    description: "Search for and activate additional Pi tools when the current active tools cannot perform a task. Added tools become available on the next model turn.",
    parameters: Type.Object({
      query: Type.String({ description: "Capability or task the additional tools must support" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, default: 6 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const match = findToolsToLoad(pi, params.query, params.limit ?? 6);
      if (match.tools.length === 0) {
        return {
          content: [{ type: "text", text: `No inactive tools matched: ${params.query}` }],
          details: { query: params.query, added: [] },
        };
      }

      const active = pi.getActiveTools();
      pi.setActiveTools(unique([...active, ...match.tools]));
      const activeAfter = new Set(pi.getActiveTools());
      const added = match.tools.filter((name) => !active.includes(name) && activeAfter.has(name));
      const skipped = match.tools.filter((name) => !activeAfter.has(name));
      updateStatus(pi, ctx);

      if (added.length === 0) {
        return {
          content: [{ type: "text", text: `Matched tools could not be activated: ${match.tools.join(", ")}` }],
          details: { query: params.query, group: match.group, requested: match.tools, added, skipped },
        };
      }

      return {
        content: [{
          type: "text",
          text: [
            `Loaded${match.group ? ` ${match.group}` : ""} tools: ${added.join(", ")}`,
            skipped.length > 0 ? `Unavailable: ${skipped.join(", ")}` : undefined,
          ].filter(Boolean).join("\n"),
        }],
        details: { query: params.query, group: match.group, requested: match.tools, added, skipped },
      };
    },
  });

  pi.on("input", async (event, ctx) => {
    const match = event.text.match(/^\+(lean|core|default|l|search|research|web|s|orch|orchestrator|delegate|agents|o|design|deck|ui|d|cloudflare|cf|full|all|f|browser|browsers|browser-eval|be)(?:\s+([\s\S]*))?$/i);
    if (!match) return;

    const profile = normalizeProfile(match[1]);
    if (!profile) return;

    const { active, missing } = setTools(pi, profile);
    updateStatus(pi, ctx);
    if (ctx.hasUI) {
      const suffix = missing.length ? `; missing: ${missing.join(", ")}` : "";
      ctx.ui.notify(`Pi tool profile: ${profile} (${active.length} tools${suffix})`, "info");
    }

    const rest = (match[2] ?? "").trim();
    if (!rest) return { action: "handled" as const };
    return { action: "transform" as const, text: rest, images: event.images };
  });

  const shortcutProfiles: Array<[ProfileName, string, string]> = [
    ["lean", "ctrl+shift+1", "+lean"],
    ["search", "ctrl+shift+2", "+search"],
    ["orch", "ctrl+shift+3", "+orch"],
    ["design", "ctrl+shift+4", "+design"],
    ["full", "ctrl+shift+5", "+full"],
    ["browser", "ctrl+shift+6", "+browser"],
  ];
  for (const [profile, shortcut, prefix] of shortcutProfiles) {
    pi.registerShortcut(shortcut, {
      description: `Insert Pi ${profile} tool-profile prefix`,
      handler: (ctx) => insertPrefix(ctx, prefix),
    });
  }

  pi.registerCommand("tools", {
    description: "Show or switch Pi active tool profiles: lean, search, orch, design, full",
    getArgumentCompletions: (prefix: string) => {
      const options = ["lean", "search", "orch", "design", "cloudflare", "full", "browser", "status"];
      return options
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "status" || trimmed === "list") {
        pi.sendMessage({
          customType: "tool-profiles-status",
          content: profileTable(pi),
          display: true,
          details: { active: pi.getActiveTools() },
        });
        updateStatus(pi, ctx);
        return;
      }

      const { profile, rest } = parseProfileAndRest(trimmed);
      if (!profile) {
        ctx.ui.notify(`Unknown tool profile: ${trimmed.split(/\s+/, 1)[0]}`, "error");
        return;
      }

      const { active, missing } = setTools(pi, profile);
      updateStatus(pi, ctx);
      const suffix = missing.length ? `; missing: ${missing.join(", ")}` : "";
      ctx.ui.notify(`Pi tool profile: ${profile} (${active.length} tools${suffix})`, "info");

      if (rest.trim()) {
        pi.sendUserMessage(rest.trim());
      }
    },
  });
}
