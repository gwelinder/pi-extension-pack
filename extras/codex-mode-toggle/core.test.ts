import { describe, expect, test } from "bun:test";
import { configForCodexMode, currentCodexMode, parseCodexModeArgs } from "./core.ts";

describe("codex mode profiles", () => {
  test("native profile preserves unrelated settings", () => {
    const source = {
      mode: "path",
      tools: { applyPatchOnly: false, webRun: false },
      beta: { codeMode: true, futureFlag: true },
      openai: { fast: true, forceCachedWebSockets: true },
      custom: { keep: true },
    };
    const result = configForCodexMode(source, "native") as any;
    expect(result.mode).toBe("normal");
    expect(result.tools).toEqual({ applyPatchOnly: true, webRun: false });
    expect(result.beta).toEqual({ codeMode: false, futureFlag: true, responsesLite: false });
    expect(result.openai).toEqual({ fast: false, forceCachedWebSockets: true });
    expect(result.custom).toEqual({ keep: true });
    expect(currentCodexMode(result)).toBe("native");
  });

  test("code profile enables full adapter without changing other tool flags", () => {
    const result = configForCodexMode({ tools: { applyPatchOnly: true, imageGeneration: false } }, "code") as any;
    expect(result.tools).toEqual({ applyPatchOnly: false, imageGeneration: false });
    expect(result.beta).toEqual({ codeMode: true, responsesLite: false });
    expect(currentCodexMode(result)).toBe("code");
  });

  test("argument parser supports clean-session and in-place switches", () => {
    expect(parseCodexModeArgs("", "native")).toEqual({ action: "select" });
    expect(parseCodexModeArgs("status", "native")).toEqual({ action: "status" });
    expect(parseCodexModeArgs("toggle", "native")).toEqual({ action: "switch", mode: "code", inPlace: false });
    expect(parseCodexModeArgs("native here", "code")).toEqual({ action: "switch", mode: "native", inPlace: true });
    expect(parseCodexModeArgs("wat", "native")).toEqual({ action: "invalid" });
  });
});
