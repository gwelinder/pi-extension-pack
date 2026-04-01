import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * bash-fixer: safely rewrites a few high-confidence bash mistakes before execution.
 *
 * Kept intentionally conservative after reviewing Pi's extension docs:
 * - Mutate event.input.command only for rewrites with stable semantics
 * - Avoid clever rewrites that change query meaning (for example broad find -> mdfind)
 * - Prefer "do nothing" over silently changing results
 */

function hasCommand(bin: string): boolean {
  try {
    const result = spawnSync("which", [bin], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

export default function bashFixer(pi: ExtensionAPI) {
  const hasGGrep = hasCommand("ggrep");

  let fixCount = {
    parens: 0,
    rgInclude: 0,
    grepPcre: 0,
    grepToRg: 0,
    cdTypos: 0,
  };

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const original = event.input.command;
    let command = original;

    // ─── Fix 1: quote bare paths with parentheses ──────────────────────
    // High-confidence fix for paths like src/app/(app)/page.tsx.
    const beforeParens = command;
    command = quoteParenPaths(command);
    if (command !== beforeParens) {
      fixCount.parens++;
    }

    // ─── Fix 2: rg --include -> rg -g ──────────────────────────────────
    // Only rewrite if the command appears to be using ripgrep.
    const beforeRgInclude = command;
    if (/\brg\b|\bripgrep\b/.test(command)) {
      command = command.replace(
        /--include(?:=|\s+)(['"]?)([^'"\s]+)\1/g,
        (_match, _quote, glob) => `-g '${glob}'`
      );
    }
    if (command !== beforeRgInclude) {
      fixCount.rgInclude++;
    }

    // ─── Fix 3: grep -P -> ggrep -P (preferred) ───────────────────────
    // Do NOT silently map PCRE to grep -E; semantics differ.
    const beforeGrepPcre = command;
    if (hasGGrep) {
      command = command.replace(/\bgrep\s+-([a-zA-Z]*P[a-zA-Z]*)\b/g, "ggrep -$1");
    }
    if (command !== beforeGrepPcre) {
      fixCount.grepPcre++;
    }

    // ─── Fix 4: grep -r -> rg ──────────────────────────────────────────
    // Conservative: rewrite only standalone recursive grep commands,
    // not piped grep filters.
    const beforeGrepR = command;
    command = rewriteRecursiveGrepToRg(command);
    if (command !== beforeGrepR) {
      fixCount.grepToRg++;
    }

    // ─── Fix 5: obvious cd typos in known project names ───────────────
    const beforeCdTypos = command;
    command = rewriteCdTypos(command, ctx.cwd);
    if (command !== beforeCdTypos) {
      fixCount.cdTypos++;
    }

    if (command !== original) {
      event.input.command = command;
    }
  });

  pi.on("session_shutdown", () => {
    const total = Object.values(fixCount).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.error(
        `[bash-fixer] Session fixes: parens=${fixCount.parens} rg-include=${fixCount.rgInclude} grep-P=${fixCount.grepPcre} grep→rg=${fixCount.grepToRg} cd-typos=${fixCount.cdTypos} (${total} total)`
      );
    }
  });
}

function quoteParenPaths(command: string): string {
  let rewritten = command;

  // Common commands where the next arg is a path.
  rewritten = rewritten.replace(
    /\b(cd|cat|ls|stat|mkdir|rm|cp|mv|touch|head|tail|wc|file|realpath|dirname|basename)\s+((?:\.{0,2}\/|~\/|\/Users\/)[^\s'"`;|&><$]*\([^)]*\)[^\s'"`;|&><$]*)/g,
    (_match, cmd, filePath) => `${cmd} '${filePath}'`
  );

  // Also catch later bare path arguments, but do not touch already quoted ones.
  rewritten = rewritten.replace(
    /(^|\s)((?:\.{0,2}\/|~\/|\/Users\/)[^\s'"`;|&><$]*\([^)]*\)[^\s'"`;|&><$]*)/gm,
    (match, prefix, filePath, offset, full) => {
      const prevChar = offset > 0 ? full[offset - 1] : "";
      if (prevChar === "'" || prevChar === '"') return match;
      return `${prefix}'${filePath}'`;
    }
  );

  return rewritten;
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

function rewriteRecursiveGrepToRg(command: string): string {
  return command.replace(
    /(?:^|(?<=&&\s)|(?<=;\s))\s*grep\s+-([a-zA-Z]*[rR][a-zA-Z]*)\s+(['"][^'"]+['"]|[^\s]+)\s+([^\s;|&]+)/gm,
    (_match, flags, pattern, searchPath) => {
      const flagStr = String(flags).replace(/[rR]/g, "");
      const rgFlags: string[] = [];

      if (flagStr.includes("l")) rgFlags.push("-l");
      if (flagStr.includes("i")) rgFlags.push("-i");
      if (flagStr.includes("c")) rgFlags.push("-c");
      if (flagStr.includes("w")) rgFlags.push("-w");
      if (flagStr.includes("v")) rgFlags.push("-v");
      if (flagStr.includes("x")) rgFlags.push("-x");

      return ["rg", ...rgFlags, pattern, searchPath].join(" ");
    }
  );
}
