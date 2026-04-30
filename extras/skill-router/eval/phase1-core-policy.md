# Phase 1 core-policy classification

Phase 1 keeps only a very small always-visible core and hides the rest with `disable-model-invocation: true`.

## Visible core

These remain visible by default:

- `beads`
- `expect`
- `explore`
- `simplify`
- `verify`

## Why this core

The current real-session evidence showed that the biggest practical problem was **repeated false-positive loading of broad or stale skills** rather than lack of available specialists.

The kept core is intentionally narrow:

- **`explore`** — broad reconnaissance before planning/implementation
- **`verify`** — adversarial validation after non-trivial work
- **`simplify`** — post-implementation cleanup/review pass
- **`expect`** — browser verification specialist with a clear, high-value trigger
- **`beads`** — user-specific persistent task tracking workflow that appears often enough to justify default visibility

## Hidden long tail

Everything else is treated as specialist long tail, including:

- domain stacks like `cloudflare`, `wrangler`, `seo-audit`, `qmd`, `durable-objects`
- media/video skills like `ffmpeg`, `runwayml`, `kling-v2v`, `video-understanding`
- marketing specialists like `copywriting`, `ad-creative`, `programmatic-seo`, `pricing-strategy`
- presentation / visual specialists like `visual-explainer`, `pptx`, `model-duel-deck`
- planning / orchestration specialists like `plan`, `agent-chains`, `worker-reviewer-dispatch`

## Notes

- Hidden skills are still available via explicit `/skill:name` loading.
- This phase is intentionally aggressive because the baseline showed only one hidden skill out of 108 and heavy over-visibility.
- Later phases can re-surface the right specialists on demand instead of advertising them all upfront.
