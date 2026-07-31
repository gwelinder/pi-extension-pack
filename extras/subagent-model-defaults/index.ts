import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODEL_DEFAULTS = {
  PI_FINDER_MODELS: "openai-codex/gpt-5.6-luna:medium,openai-codex/gpt-5.6-terra:medium",
  PI_LIBRARIAN_MODELS: "openai-codex/gpt-5.6-terra:medium,openai-codex/gpt-5.6-luna:medium",
} as const;

export default function subagentModelDefaults(_pi: ExtensionAPI) {
  process.env.PI_FINDER_MODELS = MODEL_DEFAULTS.PI_FINDER_MODELS;
  process.env.PI_LIBRARIAN_MODELS = MODEL_DEFAULTS.PI_LIBRARIAN_MODELS;
}
