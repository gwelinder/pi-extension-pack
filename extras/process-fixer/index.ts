import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type ContentPart = TextContent | ImageContent;

type ProcessInput = {
  action?: string;
  command?: string;
  id?: string;
  logWatches?: Array<{ pattern?: string; stream?: string; repeat?: boolean }>;
  [key: string]: unknown;
};

const UNSUPPORTED_OUTPUT_KEYS = ["outputLines", "outputMaxChars", "lines", "maxChars", "tail", "limit"];
const CHILD_EXIT_RE = /\[exit\((-?\d+)\)\]/;

function textContent(content: ContentPart[]): string {
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function appendTextContent(content: ContentPart[], text: string): ContentPart[] {
  return [...content, { type: "text", text }];
}

function validateLogWatchPattern(pattern: unknown): string | undefined {
  if (typeof pattern !== "string") return undefined;
  if (pattern.includes("(?i)")) {
    return [
      "Invalid process logWatch regex: JavaScript RegExp does not support inline `(?i)` case-insensitive flags.",
      "Use explicit character classes like `[Ee]rror|[Ff]ailed`, or bake the cases into the pattern.",
      "Keep `logWatches[].pattern` as a plain JavaScript regex string; flags are not a separate field in the process tool schema.",
    ].join(" ");
  }
  try {
    new RegExp(pattern);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Invalid process logWatch regex \`${pattern}\`: ${message}. Use JavaScript RegExp syntax.`;
  }
}

function hasUnsupportedOutputShape(input: ProcessInput): string[] {
  if (input.action !== "output" && input.action !== "logs") return [];
  return UNSUPPORTED_OUTPUT_KEYS.filter((key) => key in input);
}

function hasManualBackgrounding(command: string | undefined): boolean {
  if (!command) return false;
  return /(?:^|\s)(?:nohup\s+|setsid\s+)|\s&\s*(?:[A-Z_]+_PID=\$!|PID=\$!|$)/.test(command);
}

function findPackageRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function packageManagerHint(cwd: string): string {
  const root = findPackageRoot(cwd);
  if (!root) return "no package.json found above cwd";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
    if (packageManager) return `packageManager=${packageManager}`;
  } catch {
    // Fall through to lockfiles.
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) return `lockfile=${join(root, "pnpm-lock.yaml")}`;
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun lockfile present";
  if (existsSync(join(root, "package-lock.json"))) return `npm lockfile=${join(root, "package-lock.json")}; ask before npm mutations`;
  return `package root=${root}`;
}

function hasMutatingNpmCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const npmMutatingRe = /(?:^|[\n;&|()]\s*)(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(npm)\s+(?:i|install|ci|update|up|dedupe|audit\s+fix|exec|x|create|init|link|unlink|publish|version)\b/;
  const npxRe = /(?:^|[\n;&|()]\s*)(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(npx)\b/;
  if (npmMutatingRe.test(command)) return "npm";
  if (npxRe.test(command)) return "npx";
  return undefined;
}

function unsafeLogQueryNudge(command: string | undefined): string | undefined {
  if (!command || !/(?:^|[\n;&|()]\s*)rg\b/.test(command)) return undefined;
  const safeListingOrCounts = /\brg\s+--files\b|\b--files\b|(?:^|\s)-(?:l|c)\b|\b--(?:files-with-matches|count|count-matches)\b/.test(command);
  const hasMaxColumns = /\b--max-columns(?:=|\s+)\d+\b/.test(command);
  if (safeListingOrCounts || hasMaxColumns) return undefined;
  if (/(?:~|\$HOME|\/Users\/gfw)\/\.pi\/agent\/sessions|\.pi\/agent\/sessions|\.jsonl\b/.test(command)) {
    return [
      "Blocked process.start with unbounded `rg` over JSONL/session logs.",
      "Use a foreground one-shot Python/JQ extractor, `rg -l`/`--count`, or add `--max-columns 300 -m <small-number>` to avoid giant output and pi-bash spill logs.",
    ].join(" ");
  }
  return undefined;
}

function packagePolicyFailureNote(output: string): string | undefined {
  if (/minimum[- ]?release[- ]?age|minimumReleaseAge|too new|published.*(?:minute|hour|day)|release cooldown/i.test(output)) {
    return [
      "[process-fixer] Package install was blocked by the configured release cooldown.",
      "Use an older safe version, wait for the 7-day window, or ask for a scoped one-shot bypass for a trusted package. Do not lower the global cooldown.",
    ].join(" ");
  }
  if (/block-exotic-subdeps|exotic subdep|exotic dependency|ERR_PNPM[^\n]*(?:git\+|github:|https?:\/\/.*\.tgz|tarball)|blocked[^\n]*(?:git\+|github:|https?:\/\/.*\.tgz|tarball)/i.test(output)) {
    return [
      "[process-fixer] Package install appears blocked by exotic-dependency policy.",
      "Inspect/pin the dependency or choose a registry-published version; do not disable block-exotic-subdeps globally.",
    ].join(" ");
  }
  return undefined;
}

export default function processFixer(pi: ExtensionAPI) {
  let stats = {
    invalidLogWatchBlocks: 0,
    unsupportedOutputArgBlocks: 0,
    manualBackgroundBlocks: 0,
    packageManagerBlocks: 0,
    unsafeLogQueryBlocks: 0,
    childFailureMarks: 0,
  };

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "process") return;
    const input = event.input as ProcessInput;

    const unsupported = hasUnsupportedOutputShape(input);
    if (unsupported.length > 0) {
      stats.unsupportedOutputArgBlocks++;
      return {
        block: true,
        reason: [
          `[process-fixer] Unsupported process.${input.action} field(s): ${unsupported.join(", ")}.`,
          "Use `process.output` for recent output, or `process.logs` to get log file paths and then `read` the logs with offset/limit for exact slices.",
          "The process tool intentionally keeps output retrieval simple; do not assume bash-style tail options in its schema.",
        ].join(" "),
      };
    }

    if (input.action === "start" && hasManualBackgrounding(input.command)) {
      stats.manualBackgroundBlocks++;
      return {
        block: true,
        reason: [
          "[process-fixer] Do not manually background a command inside `process.start`.",
          "Pass the foreground command to `process.start`; Pi will run and manage it in the background, with `process.output`, `process.logs`, and `process.kill` for follow-up.",
        ].join(" "),
      };
    }

    if (input.action === "start") {
      const blockedPm = hasMutatingNpmCommand(input.command);
      if (blockedPm) {
        stats.packageManagerBlocks++;
        return {
          block: true,
          reason: [
            `[process-fixer] Blocked mutating ${blockedPm} command inside process.start.`,
            "Use pnpm or Bun by default; keep frozen lockfiles in CI; do not bypass the 7-day release cooldown or pnpm block-exotic-subdeps globally.",
            `Repo hint: ${packageManagerHint(ctx.cwd)}.`,
            "If a package is blocked by cooldown/exotic-dependency policy, pick an older safe version, inspect/pin it, or ask for explicit scoped approval.",
          ].join(" "),
        };
      }

      const logNudge = unsafeLogQueryNudge(input.command);
      if (logNudge) {
        stats.unsafeLogQueryBlocks++;
        return { block: true, reason: `[process-fixer] ${logNudge}` };
      }
    }

    if (input.action === "start" && Array.isArray(input.logWatches)) {
      for (let index = 0; index < input.logWatches.length; index++) {
        const issue = validateLogWatchPattern(input.logWatches[index]?.pattern);
        if (!issue) continue;
        stats.invalidLogWatchBlocks++;
        return {
          block: true,
          reason: `[process-fixer] logWatches[${index}].pattern: ${issue}`,
        };
      }
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "process") return;
    const input = event.input as ProcessInput;
    if (input.action !== "output" && input.action !== "logs") return;
    if (event.isError) return;

    const output = textContent(event.content);
    const packageNote = packagePolicyFailureNote(output);
    if (packageNote && !output.includes("Package install")) {
      return {
        isError: true,
        content: appendTextContent(event.content, `\n${packageNote}`),
      };
    }
    if (output.includes("[process-fixer]")) return;
    const match = output.match(CHILD_EXIT_RE);
    if (!match) return;
    const code = Number(match[1]);
    if (!Number.isFinite(code) || code === 0) return;

    stats.childFailureMarks++;
    return {
      isError: true,
      content: appendTextContent(
        event.content,
        `\n[process-fixer] The process tool succeeded, but the managed child process exited with code ${code}. Treat the child command as failed; inspect the shown output/logs, fix the underlying command, and restart it if needed.`
      ),
    };
  });

  pi.on("session_shutdown", () => {
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.error(
        `[process-fixer] Session nudges: invalid-logwatch=${stats.invalidLogWatchBlocks} unsupported-output-args=${stats.unsupportedOutputArgBlocks} manual-background=${stats.manualBackgroundBlocks} package-manager=${stats.packageManagerBlocks} unsafe-log-query=${stats.unsafeLogQueryBlocks} child-failure-marks=${stats.childFailureMarks} (${total} total)`
      );
    }
  });
}
