import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { entryFromSkill, fallbackCatalog, loadSkill, matchBundle, searchCatalog, skillRootsForCwd, truncate } from "./core.mjs";

type GatewayMode = "off" | "observe" | "routed";
type CatalogEntry = ReturnType<typeof entryFromSkill>;
type GatewayPolicy = {
  version: number;
  mode: GatewayMode;
  autoRecommend: { enabled: boolean; minimumScore: number; maxCandidates: number; maxPromptChars: number };
  bundles: Array<{ name: string; triggers: string[]; skills: string[] }>;
};

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = path.join(EXTENSION_DIR, "policy.json");
const USER_POLICY_PATH = path.join(os.homedir(), ".pi", "agent", "skill-gateway.json");
const TELEMETRY_DIR = process.env.PI_SKILL_GATEWAY_TELEMETRY_DIR || path.join(os.homedir(), ".pi", "agent", "telemetry", "skill-gateway");
const INTERNAL_PREFIXES = [
  "IMPORTANT: This instruction message is NOT part of the actual user conversation",
  "IMPORTANT: This message and these instructions are NOT part of the actual user conversation",
];

function readJson<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")) as T; } catch { return null; }
}

function policy(): GatewayPolicy {
  const base = readJson<GatewayPolicy>(DEFAULT_POLICY_PATH);
  if (!base) throw new Error(`skill-gateway policy missing: ${DEFAULT_POLICY_PATH}`);
  const local = readJson<Partial<GatewayPolicy>>(USER_POLICY_PATH) || {};
  const envMode = process.env.PI_SKILL_GATEWAY_MODE as GatewayMode | undefined;
  return {
    ...base,
    ...local,
    mode: envMode || local.mode || base.mode,
    autoRecommend: { ...base.autoRecommend, ...(local.autoRecommend || {}) },
    bundles: local.bundles || base.bundles,
  };
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function dayStamp(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function sessionId(ctx: ExtensionContext): string | undefined {
  try { return ctx.sessionManager.getSessionId(); } catch { return undefined; }
}

function telemetry(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
  try {
    const now = new Date();
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    fs.appendFileSync(path.join(TELEMETRY_DIR, `${dayStamp(now)}.jsonl`), `${JSON.stringify({
      ts: now.getTime(), iso: now.toISOString(), source: "skill-gateway", event,
      sessionId: sessionId(ctx), cwd: ctx.cwd, ...data,
    })}\n`, "utf8");
  } catch {
    // Routing telemetry must never affect the agent loop.
  }
}

function isInternalPrompt(prompt: string): boolean {
  const text = prompt.trim();
  return !text || INTERNAL_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function estimateTokens(chars: number, charsPerToken = 4): number {
  return Math.ceil(Math.max(0, chars) / charsPerToken);
}

function formatTokens(value: unknown): string {
  return typeof value === "number" ? `~${value.toLocaleString()} tok` : "n/a";
}

function systemSectionTokenEstimates(prompt: string, recommendation: string): Record<string, number> {
  const workingStart = prompt.indexOf("# Working style");
  const memoryStart = prompt.indexOf("# Pi Memory");
  const recommendationStart = recommendation ? prompt.lastIndexOf(recommendation) : prompt.length;
  const coreEnd = workingStart >= 0 ? workingStart : memoryStart >= 0 ? memoryStart : recommendationStart;
  const workingEnd = memoryStart >= 0 ? memoryStart : recommendationStart;
  return {
    core: estimateTokens(prompt.slice(0, coreEnd).length),
    workingPrinciples: workingStart >= 0 ? estimateTokens(prompt.slice(workingStart, workingEnd).length) : 0,
    memory: memoryStart >= 0 ? estimateTokens(prompt.slice(memoryStart, recommendationStart).length) : 0,
    recommendation: estimateTokens(recommendation.length),
  };
}

function providerSurface(payload: any): Record<string, unknown> {
  const systemValue = payload?.instructions ?? payload?.system ?? payload?.systemInstruction ?? payload?.config?.systemInstruction;
  const toolsValue = payload?.tools ?? payload?.functions ?? payload?.config?.tools;
  const systemChars = typeof systemValue === "string"
    ? systemValue.length
    : systemValue == null ? 0 : JSON.stringify(systemValue).length;
  const toolSchemaChars = toolsValue == null ? 0 : JSON.stringify(toolsValue).length;
  const toolCount = Array.isArray(toolsValue)
    ? toolsValue.length
    : Array.isArray(toolsValue?.functionDeclarations) ? toolsValue.functionDeclarations.length : 0;
  return {
    payloadChars: JSON.stringify(payload ?? {}).length,
    payloadTokensEstimate: estimateTokens(JSON.stringify(payload ?? {}).length),
    systemChars,
    systemTokensEstimate: estimateTokens(systemChars),
    toolSchemaChars,
    toolSchemaTokensEstimate: estimateTokens(toolSchemaChars, 4.7),
    toolCount,
  };
}

function buildRecommendation(results: any[], bundle: any, maxChars: number): string {
  const lines = ["## Skill routing"];
  if (bundle) lines.push(`Likely task family: ${bundle.name}.`);
  for (const result of results) {
    lines.push(`- ${result.name}: ${truncate(result.description, 150)}`);
  }
  lines.push("Load a skill only if useful: call skill_lookup with its exact name.");
  return truncate(lines.join("\n"), maxChars);
}

function formatSearchResults(query: string, results: any[], elapsedMs: number): string {
  if (results.length === 0) return `No skills matched: ${query}`;
  return [
    `Skill matches for: ${query} (${elapsedMs} ms)`,
    ...results.map((entry) => `- ${entry.name} score=${entry.score.toFixed(1)}${entry.bundle ? ` bundle=${entry.bundle}` : ""}\n  ${truncate(entry.description, 180)}`),
    "Call skill_lookup again with name=<exact-name> to load one skill.",
  ].join("\n");
}

function catalogFromNative(skills: Skill[] | undefined): CatalogEntry[] {
  return (skills || []).map(entryFromSkill).sort((a, b) => a.name.localeCompare(b.name));
}

export default function skillGateway(pi: ExtensionAPI) {
  let currentPolicy = policy();
  let catalog: CatalogEntry[] = [];
  let latestPromptStats: Record<string, unknown> = {};
  let latestProviderStats: Record<string, unknown> = {};

  const ensureCatalog = (cwd?: string): CatalogEntry[] => {
    if (catalog.length === 0) catalog = fallbackCatalog(skillRootsForCwd(cwd || process.cwd()));
    return catalog;
  };

  pi.registerTool({
    name: "skill_lookup",
    label: "Skill Gateway",
    description: "Search the approved skill catalog by task, or load one skill by exact name.",
    promptSnippet: "Search or load specialized agent skills on demand",
    promptGuidelines: ["Use skill_lookup when specialist instructions may improve the task; search by query, then load only the best exact-name match."],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Task description to search for" })),
      name: Type.Optional(Type.String({ description: "Exact skill name to load" })),
      limit: Type.Optional(Type.Number({ description: "Maximum search results", default: 5 })),
      offset: Type.Optional(Type.Number({ description: "Character offset when continuing an oversized skill load", default: 0 })),
      maxChars: Type.Optional(Type.Number({ description: "Maximum skill characters to return per load", default: 16000 })),
      includeVisible: Type.Optional(Type.Boolean({ description: "Compatibility field; all gateway skills are searchable", default: true })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entries = ensureCatalog(ctx.cwd);
      if (params.name?.trim()) {
        const started = Date.now();
        const loaded = loadSkill(params.name, entries);
        if (!loaded) {
          telemetry(ctx, "load_miss", { name: params.name, catalogSize: entries.length });
          return { content: [{ type: "text", text: `Unknown skill: ${params.name}. Search with query first.` }], isError: true };
        }
        const offset = Math.max(0, Math.floor(params.offset || 0));
        const maxChars = Math.max(2000, Math.min(24000, Math.floor(params.maxChars || 16000)));
        const chunk = loaded.text.slice(offset, offset + maxChars);
        const nextOffset = offset + chunk.length < loaded.text.length ? offset + chunk.length : undefined;
        telemetry(ctx, "load", {
          name: loaded.name, filePath: loaded.filePath, bytes: Buffer.byteLength(loaded.text),
          offset, returnedChars: chunk.length, nextOffset, durationMs: Date.now() - started,
        });
        return {
          content: [{ type: "text", text: [
            `[skill-gateway] Loaded ${loaded.name} characters ${offset}-${offset + chunk.length} of ${loaded.text.length}.`,
            `Skill directory: ${loaded.baseDir}`,
            "Resolve every relative reference against that directory.",
            nextOffset === undefined ? "Complete skill body." : `Oversized skill: continue with name=${loaded.name}, offset=${nextOffset}.`,
            "",
            chunk,
          ].join("\n") }],
          details: {
            name: loaded.name, filePath: loaded.filePath, baseDir: loaded.baseDir,
            bytes: Buffer.byteLength(loaded.text), totalChars: loaded.text.length,
            offset, returnedChars: chunk.length, nextOffset,
          },
        };
      }

      const query = params.query?.trim();
      if (!query) {
        return { content: [{ type: "text", text: "Provide query=<task description> to search or name=<exact skill name> to load." }], isError: true };
      }
      const started = Date.now();
      const results = searchCatalog(query, entries, params.limit || 5, currentPolicy);
      const elapsedMs = Date.now() - started;
      telemetry(ctx, "search", {
        queryHash: hashText(query), queryChars: query.length, elapsedMs,
        results: results.map((entry) => ({ name: entry.name, score: entry.score, bundle: entry.bundle })),
      });
      return {
        content: [{ type: "text", text: formatSearchResults(query, results, elapsedMs) }],
        details: { query, elapsedMs, results: results.map(({ name, score, filePath, baseDir, bundle, matchedTokens }) => ({ name, score, filePath, baseDir, bundle, matchedTokens })) },
      };
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    currentPolicy = policy();
    const nativeSkills = event.systemPromptOptions.skills || [];
    if (nativeSkills.length > 0) catalog = catalogFromNative(nativeSkills);
    else ensureCatalog(ctx.cwd);

    const skillSection = formatSkillsForPrompt(nativeSkills);
    const beforeChars = event.systemPrompt.length;
    let nextPrompt = event.systemPrompt;
    let strippedChars = 0;
    if (currentPolicy.mode === "routed" && skillSection && nextPrompt.includes(skillSection)) {
      nextPrompt = nextPrompt.replace(skillSection, "");
      strippedChars = skillSection.length;
    }

    let recommendation = "";
    let results: any[] = [];
    const bundle = matchBundle(event.prompt, currentPolicy.bundles);
    if (currentPolicy.mode === "routed" && currentPolicy.autoRecommend.enabled && !isInternalPrompt(event.prompt)) {
      results = searchCatalog(event.prompt, catalog, currentPolicy.autoRecommend.maxCandidates, currentPolicy);
      if ((results[0]?.score || 0) >= currentPolicy.autoRecommend.minimumScore) {
        recommendation = buildRecommendation(results, bundle, currentPolicy.autoRecommend.maxPromptChars);
        nextPrompt = `${nextPrompt}\n\n${recommendation}`;
      }
    }

    latestPromptStats = {
      mode: currentPolicy.mode,
      catalogSize: catalog.length,
      nativeVisibleSkills: nativeSkills.filter((skill) => !skill.disableModelInvocation).length,
      activeToolCount: event.systemPromptOptions.selectedTools?.length || 0,
      beforeChars,
      beforeTokensEstimate: estimateTokens(beforeChars),
      afterChars: nextPrompt.length,
      afterTokensEstimate: estimateTokens(nextPrompt.length),
      strippedChars,
      strippedTokensEstimate: estimateTokens(strippedChars),
      recommendationChars: recommendation.length,
      recommendationTokensEstimate: estimateTokens(recommendation.length),
      netTokensSavedEstimate: estimateTokens(Math.max(0, strippedChars - recommendation.length)),
      sectionTokensEstimate: systemSectionTokenEstimates(nextPrompt, recommendation),
    };
    telemetry(ctx, "route", {
      ...latestPromptStats,
      promptHash: hashText(event.prompt), promptChars: event.prompt.length,
      bundle: bundle ? { name: bundle.name, score: bundle.score, matchedTriggers: bundle.matchedTriggers } : undefined,
      recommended: results.map((entry) => ({ name: entry.name, score: entry.score })),
    });

    if (currentPolicy.mode === "routed" && nextPrompt !== event.systemPrompt) return { systemPrompt: nextPrompt };
  });

  pi.on("before_provider_request", (event, ctx) => {
    latestProviderStats = providerSurface(event.payload);
    telemetry(ctx, "provider_surface", { mode: currentPolicy.mode, ...latestProviderStats });
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("skill-gateway", `skills:${currentPolicy.mode}`);
  });

  const showPromptSurface = (ctx: ExtensionContext) => {
      currentPolicy = policy();
      const route = latestPromptStats as Record<string, any>;
      const provider = latestProviderStats as Record<string, any>;
      const content = [
        `mode: ${currentPolicy.mode}`,
        `policy: ${fs.existsSync(USER_POLICY_PATH) ? USER_POLICY_PATH : DEFAULT_POLICY_PATH}`,
        Object.keys(route).length > 0
          ? `route: ${formatTokens(route.beforeTokensEstimate)} → ${formatTokens(route.afterTokensEstimate)} system prompt`
          : "route: no agent request observed yet",
        ...(Object.keys(route).length > 0 ? [
          `skills: ${route.nativeVisibleSkills} catalog-visible; ${formatTokens(route.strippedTokensEstimate)} removed; ${formatTokens(route.recommendationTokensEstimate)} recommendation; ${formatTokens(route.netTokensSavedEstimate)} net saved`,
          ...(route.sectionTokensEstimate ? [
            `system breakdown: core ${formatTokens(route.sectionTokensEstimate.core)}; working principles ${formatTokens(route.sectionTokensEstimate.workingPrinciples)}; memory ${formatTokens(route.sectionTokensEstimate.memory)}; routed recommendation ${formatTokens(route.sectionTokensEstimate.recommendation)}`,
          ] : []),
          `tools selected before provider adaptation: ${route.activeToolCount}`,
          `catalog: ${route.catalogSize}`,
        ] : []),
        Object.keys(provider).length > 0
          ? `provider: ${formatTokens(provider.payloadTokensEstimate)} request payload`
          : "provider: no provider request observed yet",
        ...(Object.keys(provider).length > 0 ? [
          `system: ${formatTokens(provider.systemTokensEstimate)}`,
          `tools: ${formatTokens(provider.toolSchemaTokensEstimate)} across ${provider.toolCount} schemas`,
          `stable system + tools: ${formatTokens((provider.systemTokensEstimate || 0) + (provider.toolSchemaTokensEstimate || 0))}`,
        ] : []),
      ].join("\n");
      pi.sendMessage({
        customType: "skill-gateway-status",
        content,
        display: true,
        details: { route: latestPromptStats, provider: latestProviderStats },
      });
      if (ctx.hasUI) ctx.ui.notify(`skill-gateway: ${currentPolicy.mode}`, "info");
  };

  pi.registerCommand("skill-gateway", {
    description: "Show routed skill and actual provider prompt surfaces",
    handler: async (_args, ctx) => showPromptSurface(ctx),
  });

  pi.registerCommand("prompt-surface", {
    description: "Show actual routed prompt and tool-schema measurements",
    handler: async (_args, ctx) => showPromptSurface(ctx),
  });

  pi.registerCommand("skill-maintenance", {
    description: "Summarize skill catalog pressure and maintenance signals",
    handler: async (_args, ctx) => {
      const entries = ensureCatalog(ctx.cwd);
      const descriptionChars = entries.reduce((sum, entry) => sum + entry.name.length + entry.description.length, 0);
      const longest = [...entries].sort((a, b) => b.description.length - a.description.length).slice(0, 10);
      const content = [
        `Catalog: ${entries.length} skills`,
        `Discovery text: ${descriptionChars.toLocaleString()} chars (~${Math.ceil(descriptionChars / 3.5).toLocaleString()} rough tokens before XML)`,
        `Mode: ${currentPolicy.mode}`,
        "Longest descriptions:",
        ...longest.map((entry) => `- ${entry.name}: ${entry.description.length} chars`),
        "",
        "Run repository audits for removal and cross-harness drift:",
        "- npm run audit:skills",
        "- npm run audit:agent-skills",
        "- npm run audit:harness-skills",
      ].join("\n");
      telemetry(ctx, "maintenance", { catalogSize: entries.length, descriptionChars });
      pi.sendMessage({ customType: "skill-maintenance", content, display: true });
    },
  });
}
