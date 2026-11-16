// Gemini URL context is a model answer, not a page download. It counts as page content only when
// Gemini reports that it retrieved the URL; otherwise the model writes plausible text from memory.

export const NOT_RETRIEVED = "URL_NOT_RETRIEVED";
const RETRIEVED = "URL_RETRIEVAL_STATUS_SUCCESS";

// The REST API answers in camelCase (checked 2026-11-16 against generativelanguage v1beta).
export type GeminiUrlResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    urlContextMetadata?: { urlMetadata?: Array<{ retrievedUrl?: string; urlRetrievalStatus?: string }> };
  }>;
};

export type GeminiUrlOutcome = { text: string; error?: undefined } | { text?: undefined; error: string };

export function geminiUrlPrompt(url: string, userPrompt?: string): string {
  const task = userPrompt?.trim()
    ? `${userPrompt.trim()}\n\nUse this URL as the grounded source. Return markdown with citations/URLs when useful.`
    : "Extract the complete readable content from this URL as clean markdown. Include title, main text, code blocks, and tables. Do not summarize.";
  const grounding = `Use only text you retrieved from this URL in this request. If you cannot retrieve it, or it has no readable content, reply with exactly ${NOT_RETRIEVED} and nothing else. Never write the page from memory or from other sources.`;
  return `${task}\n\n${grounding}\n\nURL: ${url}`;
}

export function readGeminiUrlResponse(data: GeminiUrlResponse): GeminiUrlOutcome {
  const candidate = data.candidates?.[0];
  const statuses = (candidate?.urlContextMetadata?.urlMetadata ?? []).map((entry) => entry.urlRetrievalStatus ?? "unspecified");
  if (!statuses.includes(RETRIEVED)) {
    const seen = statuses.length ? [...new Set(statuses)].join(", ") : "no URL was retrieved";
    return { error: `Gemini did not retrieve the URL (${seen}); its answer would be model-written, so it was discarded` };
  }
  const text = candidate?.content?.parts?.map((part) => part.text).filter(Boolean).join("\n") ?? "";
  if (!text.trim()) return { error: "Gemini URL context returned empty content" };
  if (text.trim() === NOT_RETRIEVED) return { error: "Gemini retrieved the URL but found no readable content" };
  return { text };
}
