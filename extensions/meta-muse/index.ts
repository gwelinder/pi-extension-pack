import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Registers the Meta Model API provider with Muse Spark models.
 *
 * Auth resolution order:
 * 1. Muse Code subscription credential in macOS Keychain
 *    (service: ai.meta.dev.credentials, provisioned by Muse Code onboarding;
 *    carries the flat-rate subscription instead of pay-as-you-go billing)
 * 2. $MODEL_API_KEY / $META_API_KEY environment variables
 * 3. Pi /login meta (stores an API key in auth.json)
 *
 * Muse Spark 1.3 requires the Responses API (`openai-responses`) and nested
 * `reasoning.effort`. It does not support effort "none" or "max".
 */
export default function (pi: ExtensionAPI) {
  const keychainKey =
    "!python3 -c \"import json,subprocess;print(json.loads(subprocess.check_output(['security','find-generic-password','-s','ai.meta.dev.credentials','-w']).decode().strip())['api_key'])\"";

  const thinkingLevelMap = {
    off: null,
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: null,
  } as const;

  pi.registerProvider("meta", {
    name: "Meta Model API",
    baseUrl: "https://api.meta.ai/v1",
    apiKey: keychainKey,
    api: "openai-responses",
    models: [
      {
        id: "muse-spark-1.3",
        name: "Muse Spark 1.3 Standard",
        reasoning: true,
        thinkingLevelMap: { ...thinkingLevelMap },
        input: ["text", "image"],
        cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 943718,
      },
      {
        id: "muse-spark-1.3-contributor",
        name: "Muse Spark 1.3 Contributor (training data)",
        reasoning: true,
        thinkingLevelMap: { ...thinkingLevelMap },
        input: ["text", "image"],
        cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 943718,
      },
    ],
  });
}
