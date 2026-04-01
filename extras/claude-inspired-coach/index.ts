import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * claude-inspired-coach
 *
 * A lightweight prompt/context coach inspired by strong patterns in Claude Code:
 * - dedicated tools over bash for file work/search
 * - read before edit, avoid scope creep
 * - absolute paths over cd when possible
 * - offset/limit for large reads
 * - parallelize independent tools
 * - report verification honestly
 * - surface context pressure early
 *
 * Kept intentionally short so it nudges behavior without bloating the prompt.
 */

export default function claudeInspiredCoach(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const addition = `
# Working style
- Prefer dedicated tools over bash for file reads, edits, writes, and search.
- Read files before proposing or making edits. Understand existing code before changing it.
- Do not broaden scope beyond what the user asked. Avoid speculative abstractions and unnecessary cleanup.
- Prefer absolute paths and avoid cd when possible.
- For large files, use read offset/limit and avoid re-reading entire files when only one section matters.
- Make independent tool calls in parallel; only sequence calls when one depends on another.
- If a tool failure suggests stale context or a path mismatch, trust the hint and adjust instead of retrying blindly.
- Report verification faithfully: if you did not run a check, say so; if it failed, say so plainly.
`;

    return {
      systemPrompt: event.systemPrompt + addition,
    };
  });
}
