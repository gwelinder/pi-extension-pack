import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BobbyManifest,
  type MemoryCandidate,
  type MemoryProposal,
  parseBobbyManifest,
  proposalIsSafe,
} from "./core.ts";

export type BobbyOperation = "search" | "propose" | "proposal-update" | "proposal-apply" | "status";

type CommandOverride = { command?: string; args?: string[] };

export type BobbyConfig = {
  bin: string;
  canonicalMemoryRoot?: string;
  manifestPath: string;
  timeoutMs: number;
  maxOutputChars: number;
  commands: Record<BobbyOperation, CommandOverride>;
  review?: { actor: string; note: string };
  applyExplicit: boolean;
};

export type BobbyInvocation = { file: string; args: string[] };
export type BobbyResult = { ok: boolean; data?: unknown; error?: string };

const DEFAULT_COMMANDS: Record<BobbyOperation, CommandOverride> = {
  search: { command: "canonical-memory-client" },
  propose: { command: "canonical-memory-client" },
  "proposal-update": { command: "canonical-memory-client" },
  "proposal-apply": { command: "canonical-memory-client" },
  status: { command: "canonical-memory-client" },
};

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function parseOverrides(value: string | undefined): Partial<Record<BobbyOperation, CommandOverride>> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const output: Partial<Record<BobbyOperation, CommandOverride>> = {};
    for (const operation of Object.keys(DEFAULT_COMMANDS) as BobbyOperation[]) {
      const raw = parsed[operation];
      if (typeof raw === "string" && raw.trim()) output[operation] = { command: raw.trim() };
      else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const object = raw as Record<string, unknown>;
        output[operation] = {
          command: typeof object.command === "string" && object.command.trim() ? object.command.trim() : undefined,
          args: Array.isArray(object.args) && object.args.every((arg) => typeof arg === "string") ? object.args : undefined,
        };
      }
    }
    return output;
  } catch {
    return {};
  }
}

/**
 * The only Bobby CLI boundary. Command names/flags can be changed through
 * BOBBY_CANONICAL_MEMORY_COMMANDS_JSON without changing memory lifecycle code.
 */
export function getBobbyConfig(env: NodeJS.ProcessEnv = process.env): BobbyConfig {
  const overrides = parseOverrides(env.BOBBY_CANONICAL_MEMORY_COMMANDS_JSON);
  const commands = {} as Record<BobbyOperation, CommandOverride>;
  for (const operation of Object.keys(DEFAULT_COMMANDS) as BobbyOperation[]) {
    commands[operation] = { ...DEFAULT_COMMANDS[operation], ...overrides[operation] };
  }
  const actor = env.BOBBY_CANONICAL_MEMORY_REVIEW_ACTOR?.trim();
  const note = env.BOBBY_CANONICAL_MEMORY_REVIEW_NOTE?.trim();
  const canonicalMemoryRoot = env.BOBBY_CANONICAL_MEMORY_ROOT?.trim()
    || join(homedir(), "Documents", "ceo-personal-os", "knowledge", "living", "memory");
  return {
    bin: env.BOBBY_BIN?.trim() || join(homedir(), "code", "bobby", "bin", "bobby"),
    canonicalMemoryRoot,
    manifestPath: env.BOBBY_PI_MEMORY_MANIFEST?.trim() || join(canonicalMemoryRoot, "manifest.json"),
    timeoutMs: boundedNumber(env.BOBBY_CANONICAL_MEMORY_TIMEOUT_MS, 2_500, 250, 30_000),
    maxOutputChars: boundedNumber(env.BOBBY_CANONICAL_MEMORY_MAX_OUTPUT_CHARS, 64_000, 1_024, 1_000_000),
    commands,
    review: actor && note ? { actor, note } : undefined,
    applyExplicit: env.BOBBY_CANONICAL_MEMORY_EXPLICIT_APPLY === "1",
  };
}

export function buildBobbyInvocation(config: BobbyConfig, operation: BobbyOperation): BobbyInvocation {
  const command = config.commands[operation];
  return {
    file: config.bin,
    args: [
      command.command || DEFAULT_COMMANDS[operation].command!,
      ...(command.args || DEFAULT_COMMANDS[operation].args || []),
      ...(config.canonicalMemoryRoot ? ["--root", config.canonicalMemoryRoot] : []),
    ],
  };
}

export function readBobbyManifest(config: BobbyConfig): BobbyManifest | null {
  try {
    if (!existsSync(config.manifestPath)) {
      return config.canonicalMemoryRoot ? { canonicalMemoryRoot: config.canonicalMemoryRoot, records: [] } : null;
    }
    const manifest = parseBobbyManifest(JSON.parse(readFileSync(config.manifestPath, "utf8")));
    if (!manifest) return config.canonicalMemoryRoot ? { canonicalMemoryRoot: config.canonicalMemoryRoot, records: [] } : null;
    return {
      ...manifest,
      canonicalMemoryRoot: config.canonicalMemoryRoot || manifest.canonicalMemoryRoot,
    };
  } catch {
    return config.canonicalMemoryRoot ? { canonicalMemoryRoot: config.canonicalMemoryRoot, records: [] } : null;
  }
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

function shortError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240) || "Bobby command failed";
}

async function runBobby(config: BobbyConfig, operation: BobbyOperation, payload?: unknown, signal?: AbortSignal): Promise<BobbyResult> {
  if (signal?.aborted) return { ok: false, error: "aborted" };
  const invocation = buildBobbyInvocation(config, operation);
  return await new Promise<BobbyResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let abort = () => {};
    const finish = (result: BobbyResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    try {
      child = spawn(invocation.file, invocation.args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : "Unable to start Bobby" });
      return;
    }
    const process = child;
    const stop = () => {
      try { process.kill("SIGTERM"); } catch { /* ignore */ }
      const force = setTimeout(() => {
        try { process.kill("SIGKILL"); } catch { /* ignore */ }
      }, 250);
      force.unref?.();
    };
    abort = () => {
      stop();
      finish({ ok: false, error: "aborted" });
    };
    timeout = setTimeout(() => {
      timedOut = true;
      stop();
      finish({ ok: false, error: "Bobby command timed out" });
    }, config.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    process.stdout!.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > config.maxOutputChars) {
        stop();
        finish({ ok: false, error: "Bobby command output exceeded limit" });
      }
    });
    process.stderr!.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > 8_000) stderr = stderr.slice(0, 8_000);
    });
    process.on("error", (error) => finish({ ok: false, error: error.message }));
    process.on("close", (code) => {
      if (timedOut) return finish({ ok: false, error: "Bobby command timed out" });
      if (stdout.length > config.maxOutputChars) return finish({ ok: false, error: "Bobby command output exceeded limit" });
      if (code !== 0) return finish({ ok: false, error: shortError(stderr) });
      const data = parseJsonOutput(stdout);
      if (data === undefined) return finish({ ok: false, error: "Bobby command did not return JSON" });
      if (data && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).ok === false) {
        return finish({ ok: false, error: shortError(String((data as Record<string, unknown>).error || "Bobby request failed")) });
      }
      const unwrapped = data && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).ok === true
        ? (data as Record<string, unknown>).data
        : data;
      return finish({ ok: true, data: unwrapped });
    });
    try {
      process.stdin!.end(JSON.stringify({ operation, payload: payload ?? {} }));
    } catch {
      abort();
    }
  });
}

function recordsFromPayload(value: unknown): MemoryCandidate[] {
  const envelope = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const records = Array.isArray(value) ? value : envelope?.records ?? envelope?.results ?? envelope?.memories;
  if (!Array.isArray(records)) return [];
  const manifest = parseBobbyManifest({ records });
  return manifest?.records || [];
}

function proposalId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ["proposalId", "proposal_id", "id"]) {
    if (typeof object[key] === "string" && object[key].trim()) return object[key].trim();
  }
  return proposalId(object.proposal) || proposalId(object.receipt);
}

export class BobbyClient {
  constructor(readonly config: BobbyConfig = getBobbyConfig()) {}

  async search(query: string, limit = 8, signal?: AbortSignal, projectId?: string): Promise<{ available: boolean; records: MemoryCandidate[] }> {
    const result = await runBobby(this.config, "search", { query, limit, projectId, consumer: "pi" }, signal);
    return result.ok ? { available: true, records: recordsFromPayload(result.data) } : { available: false, records: [] };
  }

  async status(signal?: AbortSignal): Promise<BobbyResult> {
    return await runBobby(this.config, "status", { consumer: "pi" }, signal);
  }

  async propose(proposal: MemoryProposal, signal?: AbortSignal): Promise<{ ok: boolean; proposalId?: string; error?: string }> {
    if (!proposalIsSafe(proposal)) return { ok: false, error: "Proposal rejected locally because it contains a secret-shaped value." };
    const result = await runBobby(this.config, "propose", { proposal, consumer: "pi" }, signal);
    return result.ok ? { ok: true, proposalId: proposalId(result.data) } : { ok: false, error: result.error };
  }

  async acceptAndApply(proposalIdValue: string, signal?: AbortSignal): Promise<{ applied: boolean; error?: string }> {
    const review = this.config.review;
    if (!this.config.applyExplicit || !review) return { applied: false, error: "Bobby review actor/note contract is not configured; proposal remains pending." };
    const accepted = await runBobby(this.config, "proposal-update", {
      proposalId: proposalIdValue,
      status: "accepted",
      review: { actor: review.actor, note: review.note },
      consumer: "pi",
    }, signal);
    if (!accepted.ok) return { applied: false, error: accepted.error };
    const applied = await runBobby(this.config, "proposal-apply", {
      proposalId: proposalIdValue,
      review: { actor: review.actor, note: review.note },
      consumer: "pi",
    }, signal);
    return applied.ok ? { applied: true } : { applied: false, error: applied.error };
  }
}
