---
name: codex-ui-design
description: Image-first UI/website design pipeline using the local Codex app-server and the user's logged-in ChatGPT/Codex subscription. Use this as a preferred starting direction whenever designing a new UI/page/app surface from scratch, generating interface art direction, creating landing-page mockups, or redesigning an existing site before coding. Also use when the user wants many UI design variants without fal.ai/FAL_KEY, or mentions Codex app-server/imagegen/gpt-image-2. It generates visual mockups/reference images first, then turns the chosen image into a build spec/tokens for Pi to implement.
disable-model-invocation: true
---

# Codex UI Design

Use this skill to start UI work with **visual design first** instead of asking a coding model to invent CSS directly.

It is the Pi-native port of the `fal-redesign` workflow, but it uses the local authenticated `codex app-server` bridge and the user's `codex login` ChatGPT subscription instead of paid fal.ai inference.

The runtime is based on the stronger Codex-authored app-server harness: worker-per-app-server concurrency, free-port allocation, `initialize` + `initialized`, `getAuthStatus` without token access, approval-denying server request handlers, explicit `imagegen` skill input, `savedPath` image copying, base64 fallback, logs, and `summary.json` metadata.

## Core workflow

For visually important UI work, prefer this order:

1. Generate 1–8 visual mockup/reference images from the brief or current site.
2. Review/select the strongest direction.
3. Run `describe` on the chosen image to produce `spec.md` + implementation constraints.
4. Implement the actual code with the normal frontend stack.
5. Inspect generated references inside Pi with `/codex-gallery <out-dir-or-summary.json>` when the `codex-ui-gallery` extension is loaded.
6. Screenshot the result and run `iterate` for a residual delta spec if needed.

The image model does the art direction; Pi does the engineering.

## When to use

Use for:
- Greenfield UI/page/app surface design from a brief.
- Ambitious landing pages, portfolio pages, marketing sites, editorial pages.
- Product dashboards or app surfaces where visual direction matters before coding.
- Existing UI redesigns where a screenshot should become a stronger reference mockup.
- Bulk UI variant generation through Codex app-server.

Do not use for:
- Backend work.
- Tiny copy-only or CSS-only fixes.
- Cases where the user explicitly wants direct implementation without a visual exploration pass.

## Requirements

- Codex CLI must be installed and logged in:
  ```bash
  codex login status
  ```
- No `OPENAI_API_KEY` is required. The runtime talks to `codex app-server`, which uses the local ChatGPT/Codex login.
- Default model is `gpt-5.5`. Override with `CODEX_UI_MODEL=gpt-5.3-codex` if needed.
- For screenshotting file/URL targets, the runtime installs `puppeteer` on first run.
- Raw app-server logs are written under `<out>/logs/`.
- Every image run writes `<id>.json` metadata plus `summary.json` with thread/turn IDs, source path, revised prompt, warnings, and final image path.

## Pi TUI gallery

If the `codex-ui-gallery` extension is loaded, generated images can be inspected without leaving Pi:

```text
/codex-gallery .codex-ui-design
/codex-gallery .codex-ui-design/summary.json
/codex-gallery .codex-ui-design/mockup-01-artistic-universal.png
```

The extension also registers `show_codex_ui_gallery` for the agent and auto-opens a popup after successful `codex-ui-design` bash runs unless `PI_CODEX_GALLERY_AUTO=0` is set.

## Commands

All paths below are relative to this skill directory.

### Probe Codex app-server auth/protocol

```bash
bash scripts/probe.sh --out .codex-ui-design-probe
```

Use this first if image generation is failing. It should return JSON with `ok: true`, `authMethod: "chatgpt"`, and a completed `OK` text turn. It never requests or prints auth tokens.

### Raw imagegen harness: prompt(s) → image file(s)

```bash
bash scripts/imagegen.sh --prompt "Create a clean 1024x1024 abstract placeholder. No text." --out .codex-imagegen
bash scripts/imagegen.sh --prompt "Use this reference image but redesign it as a premium app hero." --image ./reference.png --out .codex-imagegen
bash scripts/imagegen.sh --prompts prompts.jsonl --concurrency 4 --out .codex-imagegen
```

JSONL lines may be either plain prompt strings or objects. Object lines can include `images` as local paths or `{ "path" | "url", "label" }` objects. Relative image paths resolve relative to the JSONL file:

```jsonl
{"id":"dashboard-a","prompt":"Use case: ui-mockup\nAsset type: first-pass dashboard reference\nPrimary request: ..."}
{"id":"edit-reference","prompt":"Redesign this screenshot into a premium dashboard while preserving the core IA.","images":["./refs/current.png"]}
{"id":"style-transfer","prompt":"Use Image 1 as layout target and Image 2 as visual style reference.","images":[{"path":"./refs/layout.png","label":"layout/edit target"},{"url":"https://example.com/style.png","label":"style reference"}]}
```

Outputs:
- `<id>.png` / `.jpg` / `.webp`
- `<id>.json`
- `summary.json`
- `logs/app-server-<port>.log`

### Greenfield: brief → UI mockup(s)

```bash
bash scripts/generate.sh --context "brief here" --variants 4 --out .codex-ui-design
```

Outputs:
- `mockup-01-<direction>.png`, etc.
- `<id>.json` metadata for each image.
- `summary.json`.
- `gallery.html` when multiple variants are generated.
- `spec.md` for single-variant runs.

Use this for new interfaces from scratch. It is not only a redesign tool.

### Existing site: screenshot → redesigned mockup

```bash
bash scripts/upgrade.sh --target ./index.html --context "brand/product notes" --variants 4 --out .codex-ui-design
bash scripts/upgrade.sh --target http://localhost:3000 --variants 4 --out .codex-ui-design
```

Outputs:
- `before.png`
- `after-01-<direction>.png`, etc. or `after.png`
- `<id>.json` metadata for each image.
- `summary.json`.
- `gallery.html` for variants
- `spec.md` for single-variant runs

### Describe chosen image → implementation spec

```bash
bash scripts/describe.sh --image .codex-ui-design/mockup-02-swiss-editorial.png --out .codex-ui-design/chosen
```

Outputs:
- `spec.md` — build spec with hard constraints.

### Iterate after implementation

```bash
bash scripts/iterate.sh --target http://localhost:3000 --reference .codex-ui-design/chosen/mockup.png --out .codex-ui-design/iterate
```

Outputs:
- `current.png`
- `delta.md` — only residual pixel/spacing/type/color fixes.

## Agent usage pattern

1. If the user asks to design a UI from scratch and visual quality matters, run `generate` before coding.
2. If the user asks to redesign/improve an existing UI, run `upgrade` before coding.
3. If multiple variants are generated, show/open the gallery or read the strongest images and ask/pick a direction.
4. Run `describe` on the chosen image if the generated run did not already produce `spec.md`.
5. Implement with `frontend-stack` / `frontend-skill` / `emil-design-eng` / `make-interfaces-feel-better` as appropriate.
6. After implementation, use the `expect` browser-facing verification skill and optionally run `iterate` for a delta spec.

## Concurrency guidance

Codex image generation inside one normal agent is serial. This runtime uses a worker-per-app-server model: each worker starts its own local `codex app-server` and processes jobs sequentially. This is more stable than many simultaneous turns inside one server.

- Default: `--concurrency 4` for variant generation.
- For bulk exploration: try 8–16.
- For very large batches: 32 can work if the app-server and subscription are stable.
- Avoid 64 unless explicitly stress-testing; failures/timeouts become more likely.
- If runs fail, inspect `<out>/summary.json`, per-image `<id>.json`, and `<out>/logs/app-server-*.log` before changing prompts.

## Design prompt stance

Push the image model to make a real visual commitment:
- Choose the visual carrier from the product: product image, photography, illustration, typography, diagram, or graphic system.
- Preserve real copy and IA for redesigns.
- Avoid default SaaS layouts, generic cards, blue CTAs, fake dashboards, emoji decoration, and Inter-only blandness.
- Generate interfaces that look plausible to implement, not abstract posters.
