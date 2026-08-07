import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * model-instructions
 *
 * Appends model-specific instruction blocks to the system prompt on
 * before_agent_start, so instructions follow the model across mid-session
 * switches. The MSW block's source of truth is ~/.codex/AGENTS.md between
 * <!-- BEGIN MSW --> / <!-- END MSW --> markers: Codex CLI reads the file
 * directly (comments are inert there) and Pi extracts the same block here.
 */

interface InstructionRule {
  /** Tested against "provider/model-id". */
  match: RegExp;
  file: string;
  begin: string;
  end: string;
  /** Skip injection when the prompt already carries the block. */
  sentinel: string;
}

const RULES: InstructionRule[] = [
  {
    match: /gpt-5\.6/i,
    file: join(homedir(), ".codex", "AGENTS.md"),
    begin: "<!-- BEGIN MSW -->",
    end: "<!-- END MSW -->",
    sentinel: "MSW — the kernel",
  },
];

export function extractBlock(source: string, begin: string, end: string): string | undefined {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  if (start === -1 || stop <= start) return undefined;
  return source.slice(start + begin.length, stop).trim();
}

export default function modelInstructions(pi: ExtensionAPI) {
  const warned = new Set<string>();

  pi.on("before_agent_start", (event, ctx) => {
    const id = `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
    let prompt = event.systemPrompt;

    for (const rule of RULES) {
      if (!rule.match.test(id) || prompt.includes(rule.sentinel)) continue;

      let block: string | undefined;
      try {
        block = extractBlock(readFileSync(rule.file, "utf8"), rule.begin, rule.end);
      } catch {
        block = undefined;
      }

      if (!block) {
        if (ctx.hasUI && !warned.has(rule.file)) {
          warned.add(rule.file);
          ctx.ui.notify(`model-instructions: no ${rule.begin} block found in ${rule.file}`, "warning");
        }
        continue;
      }

      prompt += `\n\n${block}\n`;
    }

    return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
  });
}
