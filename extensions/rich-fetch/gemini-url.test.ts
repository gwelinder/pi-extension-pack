import { describe, expect, test } from "bun:test";
import { NOT_RETRIEVED, geminiUrlPrompt, readGeminiUrlResponse, type GeminiUrlResponse } from "./gemini-url.ts";

const URL = "https://example.test/app/terms";

function response(statuses: string[] | null, text: string): GeminiUrlResponse {
  return {
    candidates: [{
      content: { parts: [{ text }] },
      ...(statuses ? { urlContextMetadata: { urlMetadata: statuses.map((urlRetrievalStatus) => ({ retrievedUrl: URL, urlRetrievalStatus })) } } : {}),
    }],
  };
}

const reconstructed = "I was unable to access the URL directly. I have reconstructed the complete content.\n\n# Terms of Service\n...";

describe("readGeminiUrlResponse", () => {
  test("discards text when Gemini reports a retrieval error (the shape the live API returned for an inaccessible page)", () => {
    const outcome = readGeminiUrlResponse(response(["URL_RETRIEVAL_STATUS_ERROR", "URL_RETRIEVAL_STATUS_ERROR"], reconstructed));
    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toContain("URL_RETRIEVAL_STATUS_ERROR");
  });

  test("discards text when Gemini never used URL context", () => {
    const outcome = readGeminiUrlResponse(response(null, reconstructed));
    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toContain("no URL was retrieved");
  });

  test("discards text for paywall and other non-success statuses", () => {
    expect(readGeminiUrlResponse(response(["URL_RETRIEVAL_STATUS_PAYWALL"], reconstructed)).error).toContain("PAYWALL");
  });

  test("discards the sentinel answer for a retrieved page without readable content", () => {
    const outcome = readGeminiUrlResponse(response(["URL_RETRIEVAL_STATUS_SUCCESS"], `${NOT_RETRIEVED}\n`));
    expect(outcome.text).toBeUndefined();
    expect(outcome.error).toContain("no readable content");
  });

  test("returns the text when Gemini retrieved the page", () => {
    const outcome = readGeminiUrlResponse(response(["URL_RETRIEVAL_STATUS_SUCCESS", "URL_RETRIEVAL_STATUS_SUCCESS"], "# Frog\n\nA frog is an amphibian."));
    expect(outcome).toEqual({ text: "# Frog\n\nA frog is an amphibian." });
  });
});

describe("geminiUrlPrompt", () => {
  test("asks for the sentinel instead of text from memory, with and without a user prompt", () => {
    for (const prompt of [geminiUrlPrompt(URL), geminiUrlPrompt(URL, "What does section 4 say?")]) {
      expect(prompt).toContain(`reply with exactly ${NOT_RETRIEVED}`);
      expect(prompt).toContain("Never write the page from memory");
      expect(prompt.endsWith(`URL: ${URL}`)).toBe(true);
    }
    expect(geminiUrlPrompt(URL, "What does section 4 say?")).toStartWith("What does section 4 say?");
  });
});
