export type CodexMode = "native" | "code";

export type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export function currentCodexMode(value: unknown): CodexMode {
  const root = object(value);
  const tools = object(root.tools);
  const beta = object(root.beta);
  return beta.codeMode === true && tools.applyPatchOnly === false ? "code" : "native";
}

export function configForCodexMode(value: unknown, mode: CodexMode): JsonObject {
  const root = object(value);
  const tools = object(root.tools);
  const beta = object(root.beta);
  const openai = object(root.openai);

  return {
    ...root,
    mode: "normal",
    tools: {
      ...tools,
      applyPatchOnly: mode === "native",
    },
    beta: {
      ...beta,
      codeMode: mode === "code",
      responsesLite: false,
    },
    openai: {
      ...openai,
      fast: false,
    },
  };
}

export function parseCodexModeArgs(args: string, current: CodexMode): {
  action: "switch" | "status" | "select" | "invalid";
  mode?: CodexMode;
  inPlace?: boolean;
} {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { action: "select" };
  if (words[0] === "status") return { action: "status" };

  const mode = words[0] === "toggle"
    ? current === "code" ? "native" : "code"
    : words[0] === "code"
      ? "code"
      : words[0] === "native"
        ? "native"
        : undefined;
  if (!mode || words.some((word, index) => index > 0 && word !== "here")) {
    return { action: "invalid" };
  }
  return { action: "switch", mode, inPlace: words.includes("here") };
}
