import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * bash-fixer: safely rewrites a few high-confidence bash mistakes before execution.
 *
 * Kept intentionally conservative after reviewing Pi's extension docs:
 * - Mutate event.input.command only for rewrites with stable semantics
 * - Mutate event.input.timeout only when a leading GNU timeout wrapper is clearly equivalent
 * - Avoid clever rewrites that change query meaning (for example broad find -> mdfind)
 * - Prefer "do nothing" over silently changing results
 */

const TIMEOUT_SHIM_MARKER = "pi-bash-fixer-timeout-shim-v1";
const HARNESS_TELEMETRY_DIR = process.env.PI_HARNESS_TELEMETRY_DIR || join(homedir(), ".pi", "agent", "telemetry", "harness");
const HARNESS_TELEMETRY_ENABLED = process.env.PI_HARNESS_TELEMETRY !== "0";
const BASH_SPILL_CLEANUP_ENABLED = process.env.PI_BASH_SPILL_CLEANUP !== "0";
const BASH_SPILL_CLEANUP_DRY_RUN = process.env.PI_BASH_SPILL_CLEANUP_DRY_RUN === "1";
const BASH_SPILL_TTL_HOURS = Number(process.env.PI_BASH_SPILL_TTL_HOURS ?? 24);
const TIMEOUT_COMMAND_NOT_FOUND_RE =
  /(?:^|\n)(?:[^\n]*\b(?:g?timeout): command not found\b|[^\n]*\bcommand not found: g?timeout\b|[^\n]*\bg?timeout: not found\b)/i;
const SHELL_DIAGNOSTIC_RE =
  /(?:^|\n)(?:\/(?:bin|usr\/bin)\/(?:ba|z)?sh|bash|zsh): (?:line \d+: )?.*(?:command not found|syntax error|unexpected EOF while looking for matching|No such file or directory)/i;

const TIMEOUT_SHIM = String.raw`#!/usr/bin/env python3
# pi-bash-fixer-timeout-shim-v1
import os
import re
import signal
import subprocess
import sys

MARKER = "pi-bash-fixer-timeout-shim-v1"


def eprint(message):
    sys.stderr.write("timeout: " + message + "\n")


def duration_to_seconds(raw):
    match = re.match(r"^([0-9]+(?:\.[0-9]+)?)([smhd]?)$", raw)
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2)
    factor = {"": 1.0, "s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}[unit]
    return value * factor


def candidate_is_managed_shim(path):
    try:
        with open(path, "rb") as fh:
            return MARKER.encode("utf-8") in fh.read(512)
    except OSError:
        return False


def find_real_timeout():
    seen = set()
    for name in ("gtimeout", "timeout"):
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            if not directory:
                continue
            candidate = os.path.join(directory, name)
            real = os.path.realpath(candidate)
            if real in seen:
                continue
            seen.add(real)
            if not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
                continue
            if candidate_is_managed_shim(candidate):
                continue
            return candidate
    return None


def shell_status(returncode):
    if returncode is None:
        return 124
    if returncode < 0:
        return 128 + abs(returncode)
    return returncode


def parse_signal(raw):
    if raw.isdigit():
        return int(raw)
    name = raw.upper()
    if not name.startswith("SIG"):
        name = "SIG" + name
    sig = getattr(signal, name, None)
    if sig is None:
        raise ValueError(raw)
    return sig


def signal_process_group(proc, sig):
    try:
        if hasattr(os, "killpg"):
            os.killpg(proc.pid, sig)
        else:
            proc.send_signal(sig)
    except ProcessLookupError:
        pass


def usage(exit_code=0):
    stream = sys.stdout if exit_code == 0 else sys.stderr
    stream.write(
        "Usage: timeout [OPTION] DURATION COMMAND [ARG]...\n"
        "Pi bash-fixer shim: supports common GNU timeout usage plus -s/--signal, -k/--kill-after, --foreground, and --preserve-status.\n"
    )
    return exit_code


def fallback_main(argv):
    args = argv[1:]
    if not args:
        return usage(125)

    sig = signal.SIGTERM
    kill_after = 2.0
    preserve_status = False
    index = 0

    while index < len(args):
        arg = args[index]
        if arg == "--":
            index += 1
            break
        if arg in ("--help", "-h"):
            return usage(0)
        if arg == "--version":
            print("timeout (pi bash-fixer shim)")
            return 0
        if arg == "--foreground":
            index += 1
            continue
        if arg == "--preserve-status":
            preserve_status = True
            index += 1
            continue
        if arg in ("-s", "--signal"):
            if index + 1 >= len(args):
                eprint("option requires an argument: " + arg)
                return 125
            try:
                sig = parse_signal(args[index + 1])
            except ValueError:
                eprint("invalid signal: " + args[index + 1])
                return 125
            index += 2
            continue
        if arg.startswith("--signal="):
            try:
                sig = parse_signal(arg.split("=", 1)[1])
            except ValueError:
                eprint("invalid signal: " + arg.split("=", 1)[1])
                return 125
            index += 1
            continue
        if arg.startswith("-s") and len(arg) > 2:
            try:
                sig = parse_signal(arg[2:])
            except ValueError:
                eprint("invalid signal: " + arg[2:])
                return 125
            index += 1
            continue
        if arg in ("-k", "--kill-after"):
            if index + 1 >= len(args):
                eprint("option requires an argument: " + arg)
                return 125
            kill_after = duration_to_seconds(args[index + 1])
            if kill_after is None:
                eprint("invalid kill-after duration: " + args[index + 1])
                return 125
            index += 2
            continue
        if arg.startswith("--kill-after="):
            kill_after = duration_to_seconds(arg.split("=", 1)[1])
            if kill_after is None:
                eprint("invalid kill-after duration: " + arg.split("=", 1)[1])
                return 125
            index += 1
            continue
        if arg.startswith("-") and duration_to_seconds(arg) is None:
            eprint("unsupported option: " + arg)
            return 125
        break

    if index >= len(args):
        eprint("missing duration")
        return 125
    duration = duration_to_seconds(args[index])
    if duration is None:
        eprint("invalid duration: " + args[index])
        return 125
    index += 1
    command = args[index:]
    if not command:
        eprint("missing command")
        return 125

    try:
        proc = subprocess.Popen(command, start_new_session=hasattr(os, "setsid"))
    except FileNotFoundError:
        eprint(command[0] + ": No such file or directory")
        return 127
    except PermissionError:
        eprint(command[0] + ": Permission denied")
        return 126

    if duration == 0:
        return shell_status(proc.wait())

    try:
        return shell_status(proc.wait(timeout=duration))
    except subprocess.TimeoutExpired:
        signal_process_group(proc, sig)
        try:
            code = proc.wait(timeout=kill_after)
        except subprocess.TimeoutExpired:
            signal_process_group(proc, signal.SIGKILL)
            code = proc.wait()
        if preserve_status:
            return shell_status(code)
        return 124


def main(argv):
    real = find_real_timeout()
    if real:
        os.execv(real, [real] + argv[1:])
    return fallback_main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;

function hasCommand(bin: string): boolean {
  try {
    const result = spawnSync("which", [bin], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function hashCommand(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
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

function sessionIdFromContext(ctx: any): string | undefined {
  try {
    return ctx?.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function writeBashFixerTelemetry(ctx: any, action: string, category: string, command: string, extra: Record<string, unknown> = {}) {
  if (!HARNESS_TELEMETRY_ENABLED) return;
  try {
    const ts = Date.now();
    mkdirSync(HARNESS_TELEMETRY_DIR, { recursive: true });
    appendFileSync(
      join(HARNESS_TELEMETRY_DIR, `${telemetryDay(ts)}.jsonl`),
      JSON.stringify({
        ts,
        iso: new Date(ts).toISOString(),
        source: "bash-fixer",
        event: "bash_fixer",
        action,
        category,
        sessionId: sessionIdFromContext(ctx),
        cwd: ctx?.cwd,
        commandHash: hashCommand(command),
        commandChars: command.length,
        ...extra,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Telemetry must never affect tool execution.
  }
}

function writeBashFixerSystemTelemetry(category: string, extra: Record<string, unknown> = {}) {
  if (!HARNESS_TELEMETRY_ENABLED) return;
  try {
    const ts = Date.now();
    mkdirSync(HARNESS_TELEMETRY_DIR, { recursive: true });
    appendFileSync(
      join(HARNESS_TELEMETRY_DIR, `${telemetryDay(ts)}.jsonl`),
      JSON.stringify({
        ts,
        iso: new Date(ts).toISOString(),
        source: "bash-fixer",
        event: "bash_fixer",
        action: "maintenance",
        category,
        ...extra,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Telemetry must never affect tool execution.
  }
}

function cleanupPiBashSpillLogs(): { deleted: number; bytes: number; skipped: number; error?: string } {
  if (!BASH_SPILL_CLEANUP_ENABLED) return { deleted: 0, bytes: 0, skipped: 0 };
  const ttlMs = Number.isFinite(BASH_SPILL_TTL_HOURS) && BASH_SPILL_TTL_HOURS >= 1 ? BASH_SPILL_TTL_HOURS * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const dir = tmpdir();
  let deleted = 0;
  let bytes = 0;
  let skipped = 0;
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!/^pi-bash-[a-f0-9]+\.log$/.test(name)) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        skipped++;
        continue;
      }
      if (!stat.isFile() || now - stat.mtimeMs < ttlMs) continue;
      bytes += stat.size;
      deleted++;
      if (!BASH_SPILL_CLEANUP_DRY_RUN) {
        try {
          unlinkSync(path);
        } catch {
          skipped++;
          deleted--;
          bytes -= stat.size;
        }
      }
    }
    return { deleted, bytes, skipped };
  } catch (error) {
    return { deleted, bytes, skipped, error: error instanceof Error ? error.message : String(error) };
  }
}

function getPiBinDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(resolve(agentDir), "bin");
}

function isManagedTimeoutShim(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(TIMEOUT_SHIM_MARKER);
  } catch {
    return false;
  }
}

function writeManagedTimeoutShim(path: string): "installed" | "updated" | "kept" | "skipped" {
  if (existsSync(path)) {
    if (!isManagedTimeoutShim(path)) {
      return "skipped";
    }
    const current = readFileSync(path, "utf8");
    if (current === TIMEOUT_SHIM) {
      try {
        chmodSync(path, 0o755);
      } catch {
        // Best effort; the command may already be executable.
      }
      return "kept";
    }
    writeFileSync(path, TIMEOUT_SHIM, { mode: 0o755 });
    chmodSync(path, 0o755);
    return "updated";
  }

  writeFileSync(path, TIMEOUT_SHIM, { mode: 0o755 });
  chmodSync(path, 0o755);
  return "installed";
}

function ensureTimeoutShims(): { changed: number; skipped: string[]; error?: string } {
  try {
    const binDir = getPiBinDir();
    mkdirSync(binDir, { recursive: true });

    let changed = 0;
    const skipped: string[] = [];
    for (const name of ["timeout", "gtimeout"]) {
      const path = join(binDir, name);
      const status = writeManagedTimeoutShim(path);
      if (status === "installed" || status === "updated") changed++;
      if (status === "skipped") skipped.push(path);
    }
    return { changed, skipped };
  } catch (err) {
    return { changed: 0, skipped: [], error: err instanceof Error ? err.message : String(err) };
  }
}

type ShellWord = {
  value: string;
  raw: string;
  start: number;
  end: number;
};

function readShellWord(input: string, startIndex: number): ShellWord | undefined {
  let i = startIndex;
  while (i < input.length && /\s/.test(input[i])) i++;
  if (i >= input.length) return undefined;

  const start = i;
  let value = "";
  let quote: "'" | '"' | undefined;

  while (i < input.length) {
    const char = input[i];

    if (quote) {
      if (char === quote) {
        quote = undefined;
        i++;
        continue;
      }
      if (quote === '"' && char === "\\" && i + 1 < input.length) {
        value += input[i + 1];
        i += 2;
        continue;
      }
      value += char;
      i++;
      continue;
    }

    if (/\s/.test(char)) break;
    if (";|&<>".includes(char)) break;
    if (char === "'" || char === '"') {
      quote = char;
      i++;
      continue;
    }
    if (char === "\\" && i + 1 < input.length) {
      value += input[i + 1];
      i += 2;
      continue;
    }

    value += char;
    i++;
  }

  if (i === start) return undefined;
  return { value, raw: input.slice(start, i), start, end: i };
}

function parseDurationSeconds(raw: string): number | undefined {
  const match = raw.match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!match) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;

  const unit = match[2];
  const factor = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return value * factor;
}

function hasTopLevelControlOperator(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote) {
      if (quote === '"' && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      return true;
    }
  }

  return false;
}

type TimeoutRewrite = {
  command: string;
  seconds: number;
  wrapper: string;
  duration: string;
};

const SHELL_ONLY_LEADING_WORDS = new Set([
  "cd",
  "source",
  ".",
  "alias",
  "export",
  "unset",
  "set",
  "shopt",
  "ulimit",
  "jobs",
  "fg",
  "bg",
  "wait",
  "read",
  "eval",
  "exec",
  "trap",
  "return",
  "break",
  "continue",
  "shift",
  "local",
  "declare",
  "typeset",
  "function",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "time",
]);

function startsWithShellOnlySyntax(command: string): boolean {
  if (/^[({!]/.test(command.trimStart())) return true;
  const first = readShellWord(command, 0);
  if (!first) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first.value)) return true;
  return SHELL_ONLY_LEADING_WORDS.has(first.value);
}

function parseLeadingTimeoutRewrite(command: string): TimeoutRewrite | undefined {
  const wrapper = readShellWord(command, 0);
  if (!wrapper || !/^(?:g?timeout)$/.test(wrapper.value)) return undefined;

  const duration = readShellWord(command, wrapper.end);
  if (!duration) return undefined;

  const seconds = parseDurationSeconds(duration.value);
  if (seconds === undefined) return undefined;

  const rest = command.slice(duration.end).trimStart();
  if (!rest) return undefined;

  // Pi's native bash timeout applies to the whole shell command. GNU timeout
  // applies to one executable before top-level control flow. Keep control-flow
  // or shell-only syntax on the compatibility shim instead of changing semantics.
  if (hasTopLevelControlOperator(rest)) return undefined;
  if (startsWithShellOnlySyntax(rest)) return undefined;

  return {
    command: rest,
    seconds,
    wrapper: wrapper.value,
    duration: duration.raw,
  };
}

function mergeTimeouts(existing: number | undefined, wrapperSeconds: number): number | undefined {
  const existingPositive = typeof existing === "number" && Number.isFinite(existing) && existing > 0 ? existing : undefined;
  if (wrapperSeconds <= 0) return existingPositive;
  return existingPositive === undefined ? wrapperSeconds : Math.min(existingPositive, wrapperSeconds);
}

function maxSleepSeconds(command: string): number | undefined {
  let max: number | undefined;
  for (const match of command.matchAll(/(?:^|[\s;&|])sleep\s+(\d+(?:\.\d+)?[smhd]?)(?=\s|[;&|]|$)/g)) {
    const seconds = parseDurationSeconds(match[1]);
    if (seconds === undefined) continue;
    max = max === undefined ? seconds : Math.max(max, seconds);
  }
  return max;
}

function hasFindPruneOrCommonExcludes(command: string): boolean {
  return /-prune|!\s+-path|-not\s+-path|node_modules|\.git|\.next|dist|build|coverage|\.turbo|\.cache/.test(command);
}

function hasBroadHomeOrRootFind(command: string): boolean {
  if (hasFindPruneOrCommonExcludes(command)) return false;
  return /(?:^|[\n;&|])\s*find\s+(['"]?)(?:~|\$HOME|\/Users\/gfw|\/)\1(?=\s)/.test(command);
}

function findMaxdepth(command: string): number | undefined {
  const match = command.match(/-maxdepth\s+(\d+)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function hasInefficientCodeFind(command: string): boolean {
  if (hasFindPruneOrCommonExcludes(command)) return false;
  const hasCodeRoot = /(?:^|[\n;&|])\s*find\s+(['"]?)(?:\.|\.\/|\/Users\/gfw\/code\/[^\s'";|&]+|~\/code\/[^\s'";|&]+|packages|src)\1(?=\s)/.test(
    command
  );
  if (!hasCodeRoot) return false;

  const maxdepth = findMaxdepth(command);
  // `find . -maxdepth 1/2` is usually harmless for a quick directory glance.
  // Anything deeper in a repo should use fd/rg/git unless it has explicit prunes.
  return maxdepth === undefined || maxdepth > 2;
}

function hasLongRunningWatcher(command: string): boolean {
  return /(?:^|[\n;&|])\s*(?:(?:npx\s+)?wrangler\s+(?:tail|dev)\b|(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?dev\b|next\s+dev\b|vite\b.*(?:--host|--port))/.test(
    command
  );
}

function hasFindGrepSearch(command: string): boolean {
  return /(?:^|[\n;&|])\s*find\s+[^\n;&|]*\s+-type\s+f[^\n;&|]*(?:-exec\s+g?grep\b|\|\s*xargs\s+g?grep\b|\|\s+g?grep\b)/.test(
    command
  );
}

function hasManualBackgroundProcess(command: string): boolean {
  return /\s&\s*(?:[A-Z_]+_PID=\$!|PID=\$!)/.test(command);
}

function hasHereDoc(command: string): boolean {
  // Do not run token-level shell rewrites over heredoc bodies. Bash does not
  // parse heredoc content as shell, but text rewrites like quoteParenPaths()
  // would. This has corrupted embedded Python/JS snippets such as
  // `Path('dir')/name` into `Path('dir'')/name'`.
  return /(?:^|[^<])<<-?\s*(?:['"]?[A-Za-z_][A-Za-z0-9_]*['"]?)/.test(command);
}

function hasShellExpansionSyntax(command: string): boolean {
  // Without a real shell parser, token-level rewrites around substitutions are
  // too risky: `$(...)`, `<(...)`, `>(...)`, arithmetic expansion, and backticks
  // all introduce parens/quotes that do not belong to ordinary path tokens.
  return /`|\$\(|<\(|>\(|\$\(\(/.test(command);
}

function hasDangerousDoubleQuotedSearchPattern(command: string): boolean {
  return /(^|\n|&&|\|\||[;|])\s*(?:rg|grep)(?:\s+(?:-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(?:=(?:[^\s'";|&]+))?))*\s+"([^"\n]*(?:`|\$\{|\$\()[^"\n]*)"/.test(
    command
  );
}

function hasCurlPollingLoop(command: string): boolean {
  if (!/\bcurl\b/.test(command) || !/\bsleep\s+\d/.test(command)) return false;
  return /\b(?:for|while)\b[\s\S]{0,2500}\bcurl\b[\s\S]{0,2500}\bsleep\s+\d|\bcurl\b[\s\S]{0,2500}\bsleep\s+\d[\s\S]{0,2500}\b(?:done|while|for)\b/.test(
    command
  );
}

function hasValidationOutputTruncation(command: string): boolean {
  if (!/\|\s*(?:tail|head)\b/.test(command)) return false;
  return /(?:pnpm|npm|yarn|bun|npx|tsc|vitest|playwright|next|wrangler)[^\n|]*(?:typecheck|test|lint|build|check|vitest|playwright|tsc|pages\s+deploy)[^\n|]*\|\s*(?:tail|head)\b/.test(
    command
  );
}

function hasExternalCurlWithoutRobustness(command: string): boolean {
  if (!/\bcurl\b/.test(command)) return false;
  if (!/https?:\/\/(?!localhost\b|127\.0\.0\.1\b|0\.0\.0\.0\b)/i.test(command)) return false;
  const hasFailMode = /--(?:fail|fail-with-body)\b|\s-[A-Za-z]*f[A-Za-z]*\b/.test(command);
  const hasTimeout = /--(?:max-time|connect-timeout)\b/.test(command);
  return !(hasFailMode && hasTimeout);
}

function looksLikeExtensionHarnessCommand(command: string): boolean {
  return /handlers\.get\(['"]tool_call['"]\)|mod\.default\(pi\)|bash-fixer\/index\.ts|test-bash-fixer/.test(command);
}

type PackageManagerHint = {
  manager: "pnpm" | "bun" | "npm" | "unknown";
  reason: string;
};

function findPackageRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function packageManagerHint(cwd: string): PackageManagerHint {
  const root = findPackageRoot(cwd);
  if (!root) return { manager: "unknown", reason: "no package.json found above cwd" };

  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
    if (packageManager.startsWith("pnpm@")) return { manager: "pnpm", reason: `packageManager=${packageManager}` };
    if (packageManager.startsWith("bun@")) return { manager: "bun", reason: `packageManager=${packageManager}` };
    if (packageManager.startsWith("npm@")) return { manager: "npm", reason: `packageManager=${packageManager}` };
  } catch {
    // Fall through to lockfiles.
  }

  if (existsSync(join(root, "pnpm-lock.yaml"))) return { manager: "pnpm", reason: `lockfile=${join(root, "pnpm-lock.yaml")}` };
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return { manager: "bun", reason: "bun lockfile present" };
  if (existsSync(join(root, "package-lock.json"))) return { manager: "npm", reason: `lockfile=${join(root, "package-lock.json")}` };
  return { manager: "unknown", reason: `package.json root=${root}` };
}

function firstCommandWord(command: string): string | undefined {
  const match = command.trimStart().match(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*([A-Za-z0-9_./-]+)/);
  return match?.[1]?.replace(/^.*\//, "");
}

function hasMutatingNpmCommand(command: string): string | undefined {
  const npmMutatingRe = /(?:^|[\n;&|()]\s*)(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(npm)\s+(?:i|install|ci|update|up|dedupe|audit\s+fix|exec|x|create|init|link|unlink|publish|version)\b/;
  const npxRe = /(?:^|[\n;&|()]\s*)(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(npx)\b/;
  if (npmMutatingRe.test(command)) return "npm";
  if (npxRe.test(command)) return "npx";
  return undefined;
}

function shellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let words: string[] = [];
  const flush = () => {
    if (words.length > 0) segments.push(words.join(" "));
    words = [];
  };

  for (let index = 0; index < command.length;) {
    const char = command[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (";|&<>".includes(char)) {
      flush();
      index++;
      continue;
    }
    const word = readShellWord(command, index);
    if (!word) {
      index++;
      continue;
    }
    words.push(word.value);
    index = word.end;
  }
  flush();
  return segments;
}

function hasUnsafeJsonlRg(command: string): boolean {
  if (hasHereDoc(command)) return false;
  return shellCommandSegments(command).some((segment) => {
    if (!/^rg\b/.test(segment)) return false;
    if (/\brg\s+--files\b|\b--files\b|(?:^|\s)-(?:l|c)\b|\b--(?:files-with-matches|count|count-matches)\b/.test(segment)) return false;
    if (/\b--max-columns(?:=|\s+)\d+\b/.test(segment)) return false;
    return /\.jsonl\b|\.pi\/agent\/sessions|\.codex\/sessions|\.claude\/projects|\.openclaw\/.+\.jsonl/.test(segment);
  });
}

function hasUnsafePiSessionRg(command: string): boolean {
  if (hasHereDoc(command)) return false;
  return shellCommandSegments(command).some((segment) => {
    if (!/^rg\b/.test(segment)) return false;
    if (!/(?:~|\$HOME|\/Users\/gfw)\/\.pi\/agent\/sessions|\.pi\/agent\/sessions/.test(segment)) return false;
    if (/\brg\s+--files\b|\b--files\b|(?:^|\s)-(?:l|c)\b|\b--(?:files-with-matches|count|count-matches)\b/.test(segment)) return false;
    return !/\b--max-columns(?:=|\s+)\d+\b/.test(segment);
  });
}

const RG_SHORT_OPTIONS_WITH_VALUE = new Set(["A", "B", "C", "d", "e", "E", "f", "g", "j", "m", "M", "r", "t", "T"]);
const RG_LONG_OPTIONS_WITH_VALUE = new Set([
  "after-context", "before-context", "color", "colors", "context", "context-separator",
  "dfa-size-limit", "encoding", "engine", "field-context-separator", "field-match-separator",
  "file", "glob", "hostname-bin", "hyperlink-format", "ignore-file", "max-columns",
  "max-count", "max-depth", "max-filesize", "path-separator", "pre", "pre-glob",
  "regexp", "regex-size-limit", "replace", "sort", "sortr", "threads", "type",
  "type-add", "type-clear", "type-not",
]);

function isBroadSearchRoot(value: string): boolean {
  const path = value.replace(/\/+$/, "");
  return path === "" || path === "~" || path === "$HOME" || path === "/Users" || path === "/Users/gfw";
}

function commandExecutableIndex(words: ShellWord[]): number {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "")) index++;
  if (words[index]?.value === "env") {
    index++;
    while (words[index]?.value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? "")) index++;
  }
  if (words[index]?.value === "command") index++;
  return index;
}

function rgHasBroadPathOperand(words: ShellWord[]): boolean {
  const executableIndex = commandExecutableIndex(words);
  const executable = words[executableIndex]?.value.replace(/^.*\//, "");
  if (executable !== "rg" && executable !== "ripgrep") return false;

  let hasPattern = false;
  let filesMode = false;
  let optionsEnded = false;
  for (let index = executableIndex + 1; index < words.length; index++) {
    const value = words[index]!.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && value.startsWith("--") && value.length > 2) {
      const [option] = value.slice(2).split("=", 1);
      if (option === "files") filesMode = true;
      if (option === "regexp" || option === "file") hasPattern = true;
      if (!value.includes("=") && RG_LONG_OPTIONS_WITH_VALUE.has(option)) index++;
      continue;
    }

    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      const flags = value.slice(1);
      const valueFlagIndex = [...flags].findIndex((flag) => RG_SHORT_OPTIONS_WITH_VALUE.has(flag));
      if (valueFlagIndex >= 0) {
        const valueFlag = flags[valueFlagIndex]!;
        if (valueFlag === "e" || valueFlag === "f") hasPattern = true;
        if (valueFlagIndex === flags.length - 1) index++;
      }
      continue;
    }

    // `rg --files` has no pattern; every non-option operand is a search root.
    if (!filesMode && !hasPattern) {
      hasPattern = true;
      continue;
    }
    if (isBroadSearchRoot(value)) return true;
  }
  return false;
}

function hasBroadUnboundedHomeRg(command: string): boolean {
  if (hasHereDoc(command)) return false;

  let words: ShellWord[] = [];
  const checkSegment = () => {
    const blocked = rgHasBroadPathOperand(words);
    words = [];
    return blocked;
  };

  for (let index = 0; index < command.length;) {
    const char = command[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (";|&<>".includes(char)) {
      if (checkSegment()) return true;
      index++;
      continue;
    }
    const word = readShellWord(command, index);
    if (!word) {
      index++;
      continue;
    }
    words.push(word);
    index = word.end;
  }

  return checkSegment();
}

function packageManagerNudge(command: string, cwd: string): string | undefined {
  const blocked = hasMutatingNpmCommand(command);
  if (!blocked) return undefined;
  const hint = packageManagerHint(cwd);
  const replacement = hint.manager === "bun" ? "bun" : hint.manager === "pnpm" ? "pnpm" : "pnpm or Bun";
  return [
    `Blocked mutating ${blocked} command. Gustav's local supply-chain policy is pnpm/Bun by default, with frozen lockfiles in CI, 7-day release cooldowns, and pnpm exotic-subdependency blocking.`,
    hint.manager === "npm"
      ? `This repo appears npm-based (${hint.reason}); ask before using npm for mutations, or migrate/choose pnpm/Bun intentionally.`
      : `Use ${replacement} here (${hint.reason}).`,
    "If a package is blocked by minimum-release-age, choose an older safe version or ask for a scoped one-shot bypass; do not disable cooldown globally.",
    "If exotic GitHub/git/tarball dependencies are blocked, inspect/pin or ask for approval; do not turn off block-exotic-subdeps globally.",
  ].join(" ");
}

function packageManagerFailureNote(command: string, output: string): string | undefined {
  if (!/(?:^|[\s;&|])(?:pnpm|bun)\b/.test(command)) return undefined;
  if (/minimum[- ]?release[- ]?age|minimumReleaseAge|too new|published.*(?:minute|hour|day)|release cooldown/i.test(output)) {
    return [
      "[bash-fixer] Package install was blocked by the configured release cooldown.",
      "Prefer an older safe version or wait for the package to age past the 7-day window.",
      "Only use a scoped one-shot bypass for trusted packages with explicit approval; never lower the global cooldown to make an agent install pass.",
    ].join(" ");
  }
  if (/block-exotic-subdeps|exotic subdep|exotic dependency|ERR_PNPM[^\n]*(?:git\+|github:|https?:\/\/.*\.tgz|tarball)|blocked[^\n]*(?:git\+|github:|https?:\/\/.*\.tgz|tarball)/i.test(output)) {
    return [
      "[bash-fixer] Package install appears blocked by exotic-dependency supply-chain policy.",
      "Inspect the direct/lockfile dependency that introduced the GitHub/git/tarball URL, choose a registry-published version if possible, or ask for explicit approval.",
      "Do not disable block-exotic-subdeps globally.",
    ].join(" ");
  }
  return undefined;
}

function getIneffectiveCommandNudge(command: string, cwd: string): string | undefined {
  if (looksLikeExtensionHarnessCommand(command)) return undefined;

  const packageNudge = packageManagerNudge(command, cwd);
  if (packageNudge) return packageNudge;

  if (hasDangerousDoubleQuotedSearchPattern(command)) {
    return [
      "Blocked double-quoted rg/grep search pattern containing shell expansion syntax (`...`, `${...}`, or `$(...)`).",
      "If you want to search for those characters literally, use single quotes around the pattern.",
      "If you intentionally need shell expansion, compute the pattern separately into a variable and quote that variable explicitly.",
    ].join(" ");
  }

  if (hasUnsafePiSessionRg(command)) {
    return [
      "Blocked raw `rg` over Pi session JSONL logs. Session JSONL lines often contain huge embedded tool results/images, so one match can dump hundreds of MB into context/temp spill logs.",
      "Use a JSONL-aware Python extractor that parses records and prints only selected fields/counts, or first run `rg -l '<pattern>' ~/.pi/agent/sessions --glob '*.jsonl'` to identify candidate files.",
      "If you truly need text grep, rerun with a narrow file list plus `--max-columns 300 -m <small-number>`.",
    ].join(" ");
  }

  if (hasUnsafeJsonlRg(command)) {
    return [
      "Blocked unbounded plain-text `rg` over JSONL. JSONL log lines can be extremely large and will create noisy/truncated tool output.",
      "Use a short Python/JQ extractor for specific keys, or add `--max-columns 300 -m <small-number>` / `-l` / `--count` depending on the task.",
    ].join(" ");
  }

  if (hasBroadUnboundedHomeRg(command)) {
    return [
      "Blocked broad unbounded `rg` under /Users/gfw/home. It will scan agent logs, caches, node_modules, cloud folders, and app data before producing useful signal.",
      "Use the `finder` tool for broad reconnaissance, or narrow to a project/root with globs and caps: `rg -n -m 80 --max-columns 300 '<pattern>' <specific-root> -g '<glob>'`.",
    ].join(" ");
  }

  if (hasFindGrepSearch(command)) {
    return [
      "Blocked slow `find ... -exec grep` / `find ... | grep` search pattern.",
      "For code/content search use `rg -n '<pattern>' <dir> -g '<glob>'` or tracked-only `git grep -n '<pattern>' -- '<pathspec>'`.",
      "For indexed Markdown/docs/notes use `qmd query/search '<query>'` instead of grepping every `.md` file.",
      "If you truly need POSIX find semantics, rerun with a narrow root plus `-maxdepth` and explicit prunes for node_modules/.git/.next/dist/build.",
    ].join(" ");
  }

  if (hasBroadHomeOrRootFind(command)) {
    return [
      "Blocked broad `find` rooted at home/root; it will traverse caches, node_modules, cloud folders, and app data before producing useful signal.",
      "Use the `finder` tool for broad reconnaissance across files/code.",
      "For indexed Markdown/docs/notes use QMD: `qmd query '<semantic query>'`, `qmd search '<keywords>'`, or `qmd get <file>:<line>`.",
      "For personal files on macOS use Spotlight: `mdfind -onlyin <dir> '<terms>'`.",
      "For code file names use `fd -HI -E node_modules -E .git -E .next -E dist -E build -g '<glob>' <specific-root>` or `rg --files -g '<glob>' <specific-root>`.",
    ].join(" ");
  }

  if (hasInefficientCodeFind(command)) {
    return [
      "Blocked inefficient `find` in a code tree without common prunes; it is likely to walk node_modules, build output, and caches (even with moderate `-maxdepth`).",
      "For tracked repo files use `git ls-files '<pathspec>'`.",
      "For file-name/glob search use `fd -HI -E node_modules -E .git -E .next -E dist -E build -g '<glob>' <root>` or `rg --files -g '<glob>' <root>`.",
      "For content search use `rg -n '<pattern>' <root> -g '<glob>'`.",
      "Plain `find` is allowed for shallow glances (`-maxdepth 1` or `2`) or when you explicitly prune generated folders.",
    ].join(" ");
  }

  if (hasLongRunningWatcher(command)) {
    return [
      "Blocked long-running watcher/dev-server command in bash.",
      "Use the `process` tool instead: `process.start` with a clear name, then `process.output`/`process.logs`/`process.kill` as needed.",
      "For logs, prefer `logWatches` over `wrangler tail` blocking the main turn.",
    ].join(" ");
  }

  if (hasCurlPollingLoop(command)) {
    return [
      "Blocked curl+sleep polling loop in the bash tool.",
      "Use `process.start` for polling/waiting workflows so the main agent turn stays free, or run a single immediate status check now.",
      "If this is an external async job, write progress to a log file and watch it with the `process` tool instead of blocking bash.",
      "For JS-heavy or logged-in browser/web work, prefer the Playwriter skill/CLI/browser extension from our browser-harness evaluation; it can use real browser state, inspect DOM/network, take screenshots, and make deeper network observations. For simple current-info lookup, prefer Pi web/search/fetch tools when active.",
    ].join(" ");
  }

  if (hasExternalCurlWithoutRobustness(command)) {
    return [
      "Blocked brittle external `curl` command without fail/timeout guardrails.",
      "If the task is web/browser investigation, prefer Playwriter (CLI + browser extension) for the best browser-harness ergonomics: logged-in browser state, DOM/network inspection, screenshots, and deeper information gathering. For simple research, use Pi web/search/fetch tools when active.",
      "If raw curl is truly the right tool, rerun with explicit robustness, e.g. `curl -fsSL --max-time 30 --connect-timeout 10 --retry 2 <url>` or `curl --fail-with-body --max-time 30 ...`. Localhost smoke checks are allowed.",
    ].join(" ");
  }

  if (hasValidationOutputTruncation(command)) {
    return [
      "Blocked validation/build command piped directly to `tail`/`head`; this hides full output and can mask the real failure.",
      "Use an inspectable pattern that preserves exit code: `log=$(mktemp); <command> >\"$log\" 2>&1; status=$?; tail -80 \"$log\"; echo \"Full output: $log\"; exit $status`.",
      "For long validations, consider `process.start` and inspect logs instead of blocking the main turn.",
    ].join(" ");
  }

  if (hasManualBackgroundProcess(command)) {
    return [
      "Blocked manual bash background/PID orchestration.",
      "Use the `process` tool for background commands instead of `cmd & PID=$!; sleep ...; kill $PID` in the bash tool.",
      "Start the long-lived command with `process.start`, then inspect output or logs from the main session.",
    ].join(" ");
  }

  const sleepSeconds = maxSleepSeconds(command);
  if (sleepSeconds !== undefined && sleepSeconds >= 30) {
    return [
      `Blocked long blocking sleep (${sleepSeconds}s) in the bash tool.`,
      "If this is a delayed check or polling loop, use `process.start` for the wait/check command so the main agent turn is not blocked.",
      "If you only need current state, run the check now without sleeping.",
    ].join(" ");
  }

  return undefined;
}

function textContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function commandMentionsTimeout(command: string): boolean {
  return /(?:^|[\s;&|])g?timeout(?:\s|$)/.test(command);
}

function canMaskShellDiagnostics(command: string): boolean {
  if (/[`]|\$\(|\$\{/.test(command)) return true;
  if (/\|/.test(command)) return true;
  if (/[;\n]/.test(command)) return true;
  if (/\|\||\btrue\b/.test(command)) return true;
  return false;
}

function looksLikePureLogPreview(command: string): boolean {
  return /^\s*(?:cat|sed|tail|head)\b/.test(command) && !/[`]|\$\(|\$\{/.test(command);
}

function appendTextContent<T extends Array<{ type: string; text?: string }>>(content: T, text: string) {
  return [...content, { type: "text", text }];
}

export default function bashFixer(pi: ExtensionAPI) {
  const hasGGrep = hasCommand("ggrep");
  const shimStatus = ensureTimeoutShims();
  if (shimStatus.error) {
    console.error(`[bash-fixer] Could not install timeout/gtimeout shims: ${shimStatus.error}`);
  } else if (shimStatus.skipped.length > 0) {
    console.error(
      `[bash-fixer] Left existing non-managed timeout shim(s) unchanged: ${shimStatus.skipped.join(", ")}`
    );
  }

  let fixCount = {
    parens: 0,
    rgInclude: 0,
    grepPcre: 0,
    grepToRg: 0,
    searchQuotes: 0,
    cdTypos: 0,
    timeoutNative: 0,
    heredocSafeSkips: 0,
    nudges: 0,
    timeoutGuard: 0,
    shellDiagnosticGuard: 0,
    timeoutShim: shimStatus.changed,
    shellExpansionSafeSkips: 0,
    spillLogsDeleted: 0,
  };
  let spillLogBytesDeleted = 0;

  pi.on("session_start", () => {
    const cleanup = cleanupPiBashSpillLogs();
    if (cleanup.error) {
      console.error(`[bash-fixer] pi-bash spill cleanup failed: ${cleanup.error}`);
      writeBashFixerSystemTelemetry("temp_spill_ttl_error", { error: cleanup.error.slice(0, 240) });
      return;
    }
    if (cleanup.deleted > 0 || cleanup.skipped > 0) {
      fixCount.spillLogsDeleted += cleanup.deleted;
      spillLogBytesDeleted += cleanup.bytes;
      writeBashFixerSystemTelemetry("temp_spill_ttl", {
        deleted: cleanup.deleted,
        bytes: cleanup.bytes,
        skipped: cleanup.skipped,
        ttlHours: BASH_SPILL_TTL_HOURS,
        dryRun: BASH_SPILL_CLEANUP_DRY_RUN,
      });
    }
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const original = event.input.command;
    let command = original;

    // ─── Fix 0: leading GNU timeout -> Pi-native bash timeout ──────────
    // High-confidence only: `timeout 60 cmd` / `gtimeout 2m cmd` with no
    // top-level pipes/logical operators after the wrapped command.
    const timeoutRewrite = parseLeadingTimeoutRewrite(command);
    if (timeoutRewrite) {
      command = timeoutRewrite.command;
      const mergedTimeout = mergeTimeouts(event.input.timeout, timeoutRewrite.seconds);
      if (mergedTimeout !== undefined) {
        event.input.timeout = mergedTimeout;
      }
      fixCount.timeoutNative++;
      writeBashFixerTelemetry(ctx, "rewrite", "timeout_native", original, {
        wrapper: timeoutRewrite.wrapper,
        duration: timeoutRewrite.duration,
        seconds: timeoutRewrite.seconds,
      });
    }

    // ─── Fix 1: block/nudge inefficient orchestration/search patterns ──
    // This is intentionally a nudge, not a timeout: make the agent choose the
    // Pi-native tool (`finder`/`process`) instead of burning a blocking bash turn.
    const nudge = getIneffectiveCommandNudge(command, ctx.cwd);
    if (nudge) {
      fixCount.nudges++;
      writeBashFixerTelemetry(ctx, "block", "nudge", command, { reason: nudge.slice(0, 240) });
      return { block: true, reason: `[bash-fixer] ${nudge}` };
    }

    if (hasHereDoc(command)) {
      // Token-level shell rewrites are intentionally skipped for heredoc
      // commands. They cannot distinguish shell syntax from embedded Python/JS.
      fixCount.heredocSafeSkips++;
      writeBashFixerTelemetry(ctx, "skip", "heredoc_token_rewrites", command);
    } else if (hasShellExpansionSyntax(command)) {
      // Likewise skip token-level rewrites around command/process/arithmetic
      // substitutions. Previous paren-path rewrites corrupted `$()` closes.
      fixCount.shellExpansionSafeSkips++;
      writeBashFixerTelemetry(ctx, "skip", "shell_expansion_token_rewrites", command);
    } else {
      // ─── Fix 2: quote bare paths with parentheses ────────────────────
      // High-confidence fix for paths like src/app/(app)/page.tsx.
      const beforeParens = command;
      command = quoteParenPaths(command);
      if (command !== beforeParens) {
        fixCount.parens++;
        writeBashFixerTelemetry(ctx, "rewrite", "paren_path", beforeParens);
      }

      // ─── Fix 3: rg --include -> rg -g ────────────────────────────────
      // Only rewrite if the command appears to be using ripgrep.
      const beforeRgInclude = command;
      command = rewriteRgInclude(command);
      if (command !== beforeRgInclude) {
        fixCount.rgInclude++;
        writeBashFixerTelemetry(ctx, "rewrite", "rg_include", beforeRgInclude);
      }

      // ─── Fix 4: grep -P -> ggrep -P if present, else rg -P ───────────
      // Do NOT silently map PCRE to grep -E; semantics differ. Ripgrep supports
      // PCRE2 via -P and is already part of the Pi local bin setup.
      const beforeGrepPcre = command;
      command = rewriteGrepPcre(command, hasGGrep);
      if (command !== beforeGrepPcre) {
        fixCount.grepPcre++;
        writeBashFixerTelemetry(ctx, "rewrite", "grep_pcre", beforeGrepPcre, { hasGGrep });
      }

      // Former automatic grep -r -> rg and dangerous-pattern requoting rewrites
      // are intentionally disabled. They were convenient but can silently alter
      // semantics. Prefer block/nudge for risky searches.

      // ─── Fix 7: obvious cd typos in known project names ─────────────
      const beforeCdTypos = command;
      command = rewriteCdTypos(command, ctx.cwd);
      if (command !== beforeCdTypos) {
        fixCount.cdTypos++;
        writeBashFixerTelemetry(ctx, "rewrite", "cd_typo", beforeCdTypos);
      }
    }

    if (command !== original) {
      event.input.command = command;
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (!isBashToolResult(event)) return;

    const inputCommand = typeof event.input.command === "string" ? event.input.command : "";
    const output = textContent(event.content);

    const packageFailure = packageManagerFailureNote(inputCommand, output);
    if (packageFailure && !output.includes("[bash-fixer] Package install")) {
      writeBashFixerTelemetry(ctx, "guard", "package_manager_supply_chain_failure", inputCommand, {
        note: packageFailure.slice(0, 240),
      });
      return {
        isError: true,
        content: appendTextContent(event.content, `\n${packageFailure}`),
      };
    }

    if (commandMentionsTimeout(inputCommand) && TIMEOUT_COMMAND_NOT_FOUND_RE.test(output)) {
      fixCount.timeoutGuard++;
      writeBashFixerTelemetry(ctx, "guard", "timeout_masked_failure", inputCommand);
      return {
        isError: true,
        content: appendTextContent(
          event.content,
          "\n[bash-fixer] Detected a masked timeout/gtimeout command-not-found failure. Pi has a native bash tool `timeout` field; simple leading timeout wrappers are auto-converted, and complex cases should be handled by ~/.pi/agent/bin/timeout after /reload or a fresh Pi start."
        ),
      };
    }

    if (!event.isError && SHELL_DIAGNOSTIC_RE.test(output) && canMaskShellDiagnostics(inputCommand) && !looksLikePureLogPreview(inputCommand)) {
      fixCount.shellDiagnosticGuard++;
      writeBashFixerTelemetry(ctx, "guard", "masked_shell_diagnostic", inputCommand, {
        diagnosticClass: output.match(SHELL_DIAGNOSTIC_RE)?.[0]?.slice(0, 160),
      });
      return {
        isError: true,
        content: appendTextContent(
          event.content,
          "\n[bash-fixer] Detected a shell diagnostic that was masked by a pipeline/control operator. Treat this command as failed; fix the quoting/command order rather than trusting the later pipeline output."
        ),
      };
    }
  });

  pi.on("session_shutdown", () => {
    const total = Object.values(fixCount).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.error(
        `[bash-fixer] Session fixes: parens=${fixCount.parens} rg-include=${fixCount.rgInclude} grep-P=${fixCount.grepPcre} grep→rg=${fixCount.grepToRg} search-quotes=${fixCount.searchQuotes} cd-typos=${fixCount.cdTypos} timeout→native=${fixCount.timeoutNative} heredoc-safe-skips=${fixCount.heredocSafeSkips} shell-expansion-safe-skips=${fixCount.shellExpansionSafeSkips} nudges=${fixCount.nudges} timeout-guard=${fixCount.timeoutGuard} shell-diagnostic-guard=${fixCount.shellDiagnosticGuard} timeout-shim=${fixCount.timeoutShim} spill-logs-deleted=${fixCount.spillLogsDeleted} spill-bytes=${spillLogBytesDeleted} (${total} total)`
      );
    }
  });
}

function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function isShellTokenBoundary(char: string): boolean {
  return /\s/.test(char) || ";|&><".includes(char);
}

function hasBalancedLiteralParens(token: string): boolean {
  let depth = 0;
  let sawOpen = false;
  let sawClose = false;

  for (const char of token) {
    if (char === "(") {
      depth++;
      sawOpen = true;
      continue;
    }
    if (char === ")") {
      if (depth === 0) return false;
      depth--;
      sawClose = true;
    }
  }

  return depth === 0 && sawOpen && sawClose;
}

function looksLikeBareParenPath(token: string): boolean {
  if (!token.includes("/") || !/[()]/.test(token)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  if (token.startsWith("$")) return false;
  if (/\\[()]/.test(token)) return false;
  // Avoid corrupting command substitutions like `RUN_ID=$(cat /tmp/file)`.
  // The token scanner sees `/tmp/file)` separately; quoting that token moves
  // the command-substitution close-paren inside quotes and leaves `$(` open.
  if (!hasBalancedLiteralParens(token)) return false;
  // Avoid disabling intentional glob expansion. The recurring failure pattern
  // is literal framework paths such as src/app/(frontend)/page.tsx.
  if (/[*?]/.test(token)) return false;
  return true;
}

function unescapeBareShellToken(token: string): string {
  return token.replace(/\\(.)/g, "$1");
}

function quoteParenPaths(command: string): string {
  let out = "";
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    if (char === "'" || char === '"') {
      const quote = char;
      let j = i + 1;
      while (j < command.length) {
        if (quote === '"' && command[j] === "\\" && j + 1 < command.length) {
          j += 2;
          continue;
        }
        if (command[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      out += command.slice(i, j);
      i = j;
      continue;
    }

    if (isShellTokenBoundary(char)) {
      out += char;
      i++;
      continue;
    }

    let j = i;
    let parenDepth = 0;
    while (j < command.length) {
      const tokenChar = command[j];
      if (tokenChar === "'" || tokenChar === '"') break;
      if (/\s/.test(tokenChar)) break;
      if (tokenChar === "(") {
        parenDepth++;
        j++;
        continue;
      }
      if (tokenChar === ")" && parenDepth > 0) {
        parenDepth--;
        j++;
        continue;
      }
      if (parenDepth === 0 && ";|&><".includes(tokenChar)) break;
      j++;
    }

    const token = command.slice(i, j);
    out += looksLikeBareParenPath(token) ? shellSingleQuote(unescapeBareShellToken(token)) : token;
    i = j;
  }

  return out;
}

function rewriteRgInclude(command: string): string {
  // Rewrite only obvious rg invocations, not arbitrary quoted text elsewhere in
  // a compound command. This intentionally handles simple option forms only.
  return command.replace(
    /(^|\n|&&|\|\||[;])(\s*)(rg|ripgrep)((?:\s+(?:-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(?:=(?:[^\s'";|&]+))?|['"][^'"\n]*['"]|[^\s'";|&]+))*?)\s+--include(?:=|\s+)(['"]?)([^'"\s;|&]+)\5/g,
    (_match, prefix, spacing, bin, before, _quote, glob) => `${prefix}${spacing}${bin}${before} -g ${shellSingleQuote(glob)}`
  );
}

function rewriteGrepPcre(command: string, hasGGrep: boolean): string {
  return command.replace(
    /(^|\n|&&|\|\||[;|])(\s*)grep\s+-([a-zA-Z]*P[a-zA-Z]*)\b/g,
    (match, prefix, spacing, flags) => {
      if (hasGGrep) {
        return `${prefix}${spacing}ggrep -${flags}`;
      }
      return match;
    }
  );
}

function rewriteCdTypos(command: string, cwd: string): string {
  const knownTypos = new Map([
    ["tilpan-monorepo", "tilpas-monorepo"],
    ["tilapas-monorepo", "tilpas-monorepo"],
    ["tilaps-monorepo", "tilpas-monorepo"],
  ]);

  return command.replace(
    /(?:^|(?<=&&\s)|(?<=;\s))cd\s+([^\s;&|]+)/g,
    (match, rawPath) => {
      let nextPath = rawPath;
      for (const [wrong, right] of knownTypos) {
        if (nextPath.includes(wrong)) {
          const candidate = nextPath.replace(wrong, right);
          const absolute = candidate.startsWith("/") ? candidate : resolve(cwd, candidate);
          if (existsSync(absolute)) {
            nextPath = candidate;
          }
        }
      }
      return nextPath === rawPath ? match : match.replace(rawPath, nextPath);
    }
  );
}
