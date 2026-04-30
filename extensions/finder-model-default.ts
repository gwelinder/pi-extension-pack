import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_FINDER_MODELS =
  "openai-codex/gpt-5.3-codex-spark:high,openai-codex/gpt-5.4:xhigh";

function ensureFinderModelPreference() {
  const configured = process.env.PI_FINDER_MODELS?.trim();
  if (!configured) {
    process.env.PI_FINDER_MODELS = DEFAULT_FINDER_MODELS;
  }
}

export default function finderModelDefaultExtension(pi: ExtensionAPI) {
  // Apply immediately on load and keep it in place for future turns.
  // Respect explicit shell/env overrides by only setting this when blank.
  ensureFinderModelPreference();

  pi.on("session_start", async () => {
    ensureFinderModelPreference();
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "finder") {
      ensureFinderModelPreference();
    }
  });
}
