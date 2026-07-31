#!/usr/bin/env node

import { accessSync, constants, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

const MAX_FILES = 200;

function fail(message, exitCode = 2) {
  process.stderr.write(`nextjs-ubs-review: ${message}\n`);
  process.exit(exitCode);
}

function findExecutable(name) {
  if (name.includes("/")) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return undefined;
    }
  }
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}

function findModernBash() {
  const candidates = [process.env.UBS_BASH, "/opt/homebrew/bin/bash", "/usr/local/bin/bash", findExecutable("bash")];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const version = spawnSync(candidate, ["-c", "(( BASH_VERSINFO[0] >= 4 ))"], { stdio: "ignore" });
    if (version.status === 0) return candidate;
  }
  return undefined;
}

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "buffer" });
  if (result.status !== 0) {
    const detail = result.stderr?.toString("utf8").trim();
    fail(detail || `git ${args[0]} failed`);
  }
  return result.stdout;
}

function zeroSeparated(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function parseArgs(argv) {
  const options = { base: undefined, staged: false, list: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--staged") options.staged = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--base") {
      options.base = argv[++index];
      if (!options.base) fail("--base requires a git ref");
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: scan.mjs [--staged | --base REF] [--list]\n");
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (options.staged && options.base) fail("choose either --staged or --base, not both");
  return options;
}

function changedFiles(options) {
  if (options.staged) {
    return zeroSeparated(runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]));
  }
  if (options.base) {
    return zeroSeparated(runGit(["diff", "--name-only", "--diff-filter=ACMR", "-z", `${options.base}...HEAD`]));
  }
  const tracked = zeroSeparated(runGit(["diff", "HEAD", "--name-only", "--diff-filter=ACMR", "-z"]));
  const untracked = zeroSeparated(runGit(["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...tracked, ...untracked];
}

function hasServerDirective(path) {
  try {
    const prefix = readFileSync(path, "utf8").slice(0, 4096);
    return /^\s*(["'])use server\1\s*;?/m.test(prefix);
  } catch {
    return false;
  }
}

function isNextServerBoundary(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!/\.[cm]?[jt]sx?$/.test(normalized)) return false;
  return (
    /(^|\/)app\/(?:.*\/)?route\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)pages\/api\//.test(normalized) ||
    /(^|\/)(?:api|server|actions)\//.test(normalized) ||
    /(^|\/)src\/lib\/server\//.test(normalized) ||
    /(^|\/)(?:middleware|server)\.[cm]?[jt]s$/.test(normalized) ||
    hasServerDirective(normalized)
  );
}

const options = parseArgs(process.argv.slice(2));
const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (root.status !== 0) fail("run this command inside a git repository");
process.chdir(root.stdout.trim());

const selected = [...new Set(changedFiles(options))].filter(isNextServerBoundary).sort();
if (selected.length > MAX_FILES) {
  fail(`selected ${selected.length} files; split the review into scopes of at most ${MAX_FILES}`);
}
if (options.list) {
  process.stdout.write(selected.length ? `${selected.join("\n")}\n` : "");
  process.exit(0);
}
if (selected.length === 0) {
  process.stdout.write(`${JSON.stringify({
    scope: "nextjs-server-changes",
    mode: options.staged ? "staged" : options.base ? `base:${options.base}` : "working-tree",
    files: [],
    status: "no_applicable_files",
  }, null, 2)}\n`);
  process.exit(0);
}

process.stderr.write(`nextjs-ubs-review: scanning ${selected.length} changed server file(s)\n`);
for (const file of selected) process.stderr.write(`  ${file}\n`);

const ubs = findExecutable(process.env.UBS_BIN?.trim() || "ubs");
if (!ubs) fail("ubs is not installed or executable", 3);
const bash = findModernBash();
if (!bash) fail("UBS requires Bash 4 or newer; install Homebrew bash or set UBS_BASH", 3);
const scan = spawnSync(
  bash,
  [ubs, "--only=js", "--format=json", "--ci", "--no-auto-update", ...selected],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
);
if (scan.stdout) process.stdout.write(scan.stdout);
if (scan.stderr) process.stderr.write(scan.stderr);
if (scan.error) fail(`could not start UBS (${scan.error.message})`, 3);
process.exit(scan.status ?? 3);
