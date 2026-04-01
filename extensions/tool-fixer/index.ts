import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createEditToolDefinition,
  createReadToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, basename, extname, join, relative, resolve, sep } from "node:path";

type ReadSnapshot = {
  hash: string;
  readTs: number;
};

const PI_MEMORY_ROOT = join(homedir(), ".pi", "agent", "memory") + sep;

function canonicalizePath(cwd: string, toolPath: string): string {
  const resolved = resolve(cwd, toolPath);
  if (existsSync(resolved)) {
    try {
      return realpathSync.native(resolved);
    } catch {
      return realpathSync(resolved);
    }
  }
  return resolved;
}

function hashFile(absolutePath: string): string | null {
  try {
    const content = readFileSync(absolutePath, "utf8");
    return createHash("md5").update(content).digest("hex");
  } catch {
    return null;
  }
}

function getMemoryReadNote(absolutePath: string): string | null {
  if (!absolutePath.startsWith(PI_MEMORY_ROOT)) return null;

  const fileName = basename(absolutePath);
  if (fileName === "MEMORY.md") {
    return `\n\n💡 This is a memory index file. Read linked memory files for the full details behind an entry.`;
  }

  try {
    const ageDays = Math.max(0, Math.floor((Date.now() - statSync(absolutePath).mtimeMs) / 86_400_000));
    if (ageDays <= 1) {
      return `\n\n💡 This is a persistent memory file. Treat it as historical context, not proof of the current code state.`;
    }
    return `\n\n💡 This memory is ${ageDays} days old. Treat memory as point-in-time context and verify code/file/function claims against the current project state before acting on them.`;
  } catch {
    return `\n\n💡 This is a persistent memory file. Treat it as historical context, not proof of the current code state.`;
  }
}

function isSimilarFilename(a: string, b: string): boolean {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const aStem = aLower.replace(/\.[^.]+$/, "");
  const bStem = bLower.replace(/\.[^.]+$/, "");
  if (aLower === bLower) return false;
  const aPrefix = aStem.slice(0, Math.min(4, aStem.length));
  const bPrefix = bStem.slice(0, Math.min(4, bStem.length));
  return aStem.includes(bPrefix) || bStem.includes(aPrefix);
}

function findSameBasenameAlternative(filePath: string): string | undefined {
  try {
    const dir = dirname(filePath);
    const targetStem = basename(filePath, extname(filePath));
    const targetExt = extname(filePath);
    const match = readdirSync(dir).find((name) => {
      return basename(name, extname(name)) === targetStem && extname(name) !== targetExt;
    });
    return match ? join(dir, match) : undefined;
  } catch {
    return undefined;
  }
}

function suggestPathUnderCwd(cwd: string, requestedPath: string): string | undefined {
  const cwdParent = dirname(cwd);
  const normalizedRequested = requestedPath;
  const cwdParentPrefix = cwdParent === sep ? sep : cwdParent + sep;

  if (
    !normalizedRequested.startsWith(cwdParentPrefix) ||
    normalizedRequested.startsWith(cwd + sep) ||
    normalizedRequested === cwd
  ) {
    return undefined;
  }

  const relFromParent = relative(cwdParent, normalizedRequested);
  const corrected = join(cwd, relFromParent);
  return existsSync(corrected) ? corrected : undefined;
}

async function suggestSimilarFiles(
  pi: ExtensionAPI,
  cwd: string,
  toolPath: string,
  signal?: AbortSignal
): Promise<string | null> {
  const absolutePath = canonicalizePath(cwd, toolPath);
  const targetDir = dirname(absolutePath);
  const targetName = basename(absolutePath);

  let existingAncestor = targetDir;
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor) && existingAncestor !== "/") {
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = dirname(existingAncestor);
  }
  if (!existsSync(existingAncestor)) return null;

  if (missingSegments.length === 0 && existsSync(targetDir)) {
    const altExt = findSameBasenameAlternative(absolutePath);
    if (altExt) {
      return `\n\n💡 File not found. A file with the same basename exists at:\n  • ${altExt}`;
    }

    try {
      const siblings = readdirSync(targetDir)
        .filter((name) => isSimilarFilename(name, targetName))
        .slice(0, 8);
      if (siblings.length > 0) {
        return `\n\n💡 File not found. Similar files in ${targetDir}/:\n${siblings.map((s) => `  • ${s}`).join("\n")}`;
      }
    } catch {
      // fall through
    }
  }

  const cwdSuggestion = suggestPathUnderCwd(cwd, absolutePath);
  if (cwdSuggestion) {
    return `\n\n💡 Path not found. Your current working directory is ${cwd}. Did you mean:\n  • ${cwdSuggestion}`;
  }

  const stem = targetName.replace(/\.[^.]+$/, "");
  const ext = targetName.includes(".") ? targetName.split(".").pop() : undefined;
  const args = ["--max-results", "8"];
  if (missingSegments.length > 0) {
    args.push("--type", "d", "--max-depth", "3", missingSegments[0], existingAncestor);
  } else {
    if (ext) args.push("--extension", ext);
    args.push(stem, existingAncestor);
  }

  try {
    const result = await pi.exec("fd", args, { timeout: 3000, signal });
    const stdout = result.stdout.trim();
    if (!stdout) return null;
    const matches = stdout.split("\n").filter(Boolean).slice(0, 6);
    if (matches.length === 0) return null;
    if (missingSegments.length > 0) {
      return `\n\n💡 Directory "${missingSegments.join("/")}" was not found under ${existingAncestor}. Similar directories:\n${matches.map((m) => `  • ${m}`).join("\n")}`;
    }
    return `\n\n💡 File not found. Did you mean one of these?\n${matches.map((m) => `  • ${m}`).join("\n")}`;
  } catch {
    return null;
  }
}

async function findMatchLocations(
  pi: ExtensionAPI,
  cwd: string,
  toolPath: string,
  oldText: string,
  signal?: AbortSignal
): Promise<string | null> {
  const absolutePath = canonicalizePath(cwd, toolPath);
  if (!existsSync(absolutePath)) return null;

  const nonEmptyLines = oldText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonEmptyLines.length === 0) return null;

  const needle = (nonEmptyLines[1] ?? nonEmptyLines[0]).slice(0, 200);
  if (needle.length < 3) return null;

  try {
    const result = await pi.exec(
      "rg",
      ["-n", "--no-heading", "-F", "-m", "20", needle, absolutePath],
      { timeout: 3000, signal }
    );
    const stdout = result.stdout.trim();
    if (!stdout) return null;
    const lines = stdout.split("\n").filter(Boolean);
    if (lines.length < 2) return null;
    return (
      `\n\n💡 This oldText is not unique. Add more surrounding context or merge nearby edits. Match locations:\n` +
      lines.map((line) => `  ${line.slice(0, 160)}`).join("\n")
    );
  } catch {
    return null;
  }
}

export default function toolFixer(pi: ExtensionAPI) {
  const lastReadByFile = new Map<string, ReadSnapshot>();

  let stats = {
    enoentHints: 0,
    eisdirHints: 0,
    nonUniqueHints: 0,
    staleHints: 0,
  };

  const readBase = createReadToolDefinition(process.cwd());
  const editBase = createEditToolDefinition(process.cwd());

  pi.registerTool({
    ...readBase,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const runtimeRead = createReadToolDefinition(ctx.cwd);
      try {
        const result = await runtimeRead.execute(toolCallId, params, signal, onUpdate, ctx);

        const absolutePath = canonicalizePath(ctx.cwd, params.path);
        const hash = hashFile(absolutePath);
        if (hash) {
          lastReadByFile.set(absolutePath, { hash, readTs: Date.now() });
        }

        const memoryNote = getMemoryReadNote(absolutePath);
        if (memoryNote && Array.isArray(result.content)) {
          const firstText = result.content.find(
            (item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string"
          );
          if (firstText) {
            firstText.text += memoryNote;
          }
        }

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("ENOENT")) {
          const hint = await suggestSimilarFiles(pi, ctx.cwd, params.path, ctx.signal);
          if (hint) {
            stats.enoentHints++;
            throw new Error(message + hint);
          }
        }

        if (message.includes("EISDIR")) {
          stats.eisdirHints++;
          throw new Error(
            message +
              `\n\n💡 "${params.path}" is a directory, not a file. Use the ls tool to inspect it, then read a specific file inside it.`
          );
        }

        throw error;
      }
    },
  });

  pi.registerTool({
    ...editBase,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const runtimeEdit = createEditToolDefinition(ctx.cwd);
      try {
        return await runtimeEdit.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const absolutePath = canonicalizePath(ctx.cwd, params.path);

        if (message.includes("The text must be unique")) {
          const oldText = params.edits.find((edit) => typeof edit.oldText === "string")?.oldText;
          if (oldText) {
            const hint = await findMatchLocations(pi, ctx.cwd, params.path, oldText, ctx.signal);
            if (hint) {
              stats.nonUniqueHints++;
              throw new Error(message + hint);
            }
          }
        }

        const staleCandidate =
          message.includes("Could not find the exact text") || message.includes("No changes made");
        if (staleCandidate) {
          const snapshot = lastReadByFile.get(absolutePath);
          const currentHash = snapshot ? hashFile(absolutePath) : null;
          if (snapshot && currentHash && currentHash !== snapshot.hash) {
            const ageSeconds = Math.max(1, Math.round((Date.now() - snapshot.readTs) / 1000));
            stats.staleHints++;
            throw new Error(
              message +
                `\n\n⚠️ Stale file: ${params.path} changed on disk since you last read it (${ageSeconds}s ago). Re-read the file before retrying this edit.`
            );
          }
        }

        throw error;
      }
    },
  });

  pi.on("session_shutdown", () => {
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.error(
        `[tool-fixer] Session hints: enoent=${stats.enoentHints} eisdir=${stats.eisdirHints} non-unique=${stats.nonUniqueHints} stale=${stats.staleHints} (${total} total)`
      );
    }
  });
}
