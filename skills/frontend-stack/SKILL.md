---
name: frontend-stack
description: Frontend/UI skill router for Gustav's local stack. Use whenever a task involves building, designing from scratch, redesigning, reviewing, polishing, or art-directing a web UI, landing page, app surface, dashboard, shadcn component, image-to-code workflow, brand kit, motion/demo section, or frontend visual quality. This skill decides which frontend/design skills to combine and which conflicts to avoid, and it prefers image-first Codex UI mockups for visually important new designs/redesigns instead of loading every UI skill at once.
disable-model-invocation: true
---

# Frontend Stack Router

Use this skill as the routing layer for frontend/design work. The goal is not to add another aesthetic opinion; the goal is to pick the right small set of existing skills for the job.

## Core principle

Do **not** load every frontend skill. Pick a recipe based on the task shape, then follow the selected skills deeply.

Default behavior:
1. Identify the task type.
2. Pick one recipe below.
3. If the task is visually important and not a tiny fix, prefer an image-first direction with `codex-ui-design` before coding: generate references/mockups, pick or infer the strongest direction, then implement.
4. Read the listed skill files before implementing/reviewing.
5. Apply conflict rules when skills disagree.
6. Verify visually/browser-facing changes with the appropriate browser verification skill when code changes are made.

## Task routing

### A. Normal frontend build / new interface from scratch

Use when building a new component/page/app surface where visual quality matters. For anything more substantial than a small component fix, do **not** start by freehanding CSS; start with a visual direction.

Preferred workflow:
1. Use `codex-ui-design generate` to create 1–4 UI mockup/reference directions from the brief.
2. Run/inspect the chosen direction's `spec.md`.
3. Implement the real UI with the normal code skills.

Load:
- `codex-ui-design` — preferred image-first start for new UI/page/app design, using Codex app-server and `gpt-5.5` via the logged-in subscription.
- `frontend-skill` — art direction, restrained composition, image-led hierarchy, anti-card-spam.
- `design-taste-frontend` — strict implementation guardrails: dependency checks, Tailwind/RSC safety, performance-safe motion, anti-AI defaults.
- `make-interfaces-feel-better` — detail pass for radii, shadows, hit areas, text wrapping, transitions.

Optional:
- `shadcn` if the project has `components.json` or shadcn/ui components.
- `next-best-practices` if the project is Next.js.

### B. Existing UI redesign / cleanup

Use when improving an existing site/app/UI, especially if the user says redesign, make this better, clean up the UI, make it premium, or fix AI slop.

Default workflow:
1. Scan the current implementation and identify what must be preserved.
2. For visually important redesigns, use `codex-ui-design upgrade` or `imagegen-frontend-web` as a first-pass art-direction generator before coding: generate several redesign reference images, pick/analyze the strongest direction, then feed that direction into the code skills.
3. Apply targeted code changes with the existing stack; do not rewrite from scratch unless the user explicitly asks.

Load:
- `redesign-existing-projects` — scan → diagnose → targeted fixes without rewriting from scratch.
- `codex-ui-design` — preferred local-subscription redesign/mockup pipeline through Codex app-server.
- `imagegen-frontend-web` — prompt/style discipline for web comps and reference images.
- `frontend-skill` — preserve strong composition and avoid default dashboard/card clutter.
- `emil-design-eng` — motion/component craft and invisible polish.
- `polish` — final alignment, spacing, state, and quality pass.

Optional:
- `critique` before editing if the user wants diagnosis first.
- `harden` if production robustness, edge cases, long text, errors, or i18n matter.

### C. Ambitious landing page / image-first website

Use when the user wants a visually ambitious landing page, marketing page, hero, portfolio, editorial site, or says to make it wild/beautiful/award-level.

Load:
- `codex-ui-design` — preferred Codex app-server mockup/variant generation for website/interface directions.
- `image-to-code` — generate/analyze visual references first, then implement faithfully.
- `imagegen-frontend-web` — website comps/reference images and prompt discipline.
- `frontend-skill` — page structure, hero restraint, image-led composition.
- `emil-design-eng` — motion and interaction discipline.

Important:
- If image generation is not available, still use `image-to-code` as an analysis/implementation discipline, but explicitly state that the image generation step was not run.
- Prefer separate, readable section references over one compressed board.
- For many variants, prefer `codex-ui-design`/Codex app-server over subagents. Codex's built-in image generation is serial inside one agent; `codex-ui-design` uses a worker-per-app-server harness against the logged-in ChatGPT/Codex session without setting `OPENAI_API_KEY`. Default model is now `gpt-5.5`; override with `CODEX_UI_MODEL` only if needed. Use conservative concurrency with backoff: start at 4–8, try 16–32 if stable, avoid 64 unless explicitly stress-testing quota/throughput. Inspect `summary.json` and per-image metadata when runs fail.

### D. Brand / identity / visual system

Use when the user wants logo directions, brand world, identity board, moodboard, product visual direction, or brand kit.

Load:
- `brandkit` — premium identity boards and logo-system art direction.
- `imagegen-frontend-web` if the brand needs website applications.

Do not start coding unless the user explicitly asks to implement.

### E. Product dashboard / operational app UI

Use when building admin tools, dashboards, internal tools, analytics, tables, or operator consoles.

Load:
- `codex-ui-design` — use first when the dashboard/app surface needs a new visual system or several interface directions before coding.
- `frontend-skill` — app UI restraint and utility-copy rules.
- `design-taste-frontend` — technical UI typography, density, no generic cards, dependency/RSC checks.
- `userinterface-wiki` — UX and animation review rules.
- `make-interfaces-feel-better` — detail polish.

Optional:
- `vercel-react-best-practices` for React/Next performance.
- `harden` for overflow, empty/error/loading states, i18n, and resilience.

### F. Motion / product demo section

Use when building a scroll-triggered product walkthrough, workflow demo, integration demo, or animated landing-page feature showcase.

Load:
- `web-animation-demo` — pure React + requestAnimationFrame + IntersectionObserver product demos.
- `motion-craft` — timing, sequencing, data-viz animation, narrative motion.

Do not load `gpt-taste` or any GSAP-heavy skill for this recipe unless the user explicitly asks for GSAP. `web-animation-demo` explicitly avoids external animation libraries.

### G. shadcn/ui work

Use when the project has shadcn/ui, a `components.json`, or the user asks for shadcn components/blocks/presets.

Load:
- `shadcn` — CLI/docs/component composition rules.
- `frontend-skill` or `design-taste-frontend` depending on whether the task is visual or implementation-heavy.
- `make-interfaces-feel-better` for final details.

Follow `shadcn` rules over generic Tailwind habits: semantic tokens, existing components first, docs before guessing, no raw custom markup where shadcn components exist.

### H. Review / audit only

Use when the user asks to review, critique, audit, verify UI quality, check accessibility, or identify problems without changing code.

Load:
- `critique` for design-director feedback.
- `web-design-guidelines` for Vercel guideline compliance.
- `userinterface-wiki` for detailed UI/UX rule checks.
- `make-interfaces-feel-better` for polish-level findings.

Return path/line findings when reviewing code. Be direct; do not soften serious design problems.

### I. Completion / no placeholders

Use when the user asks for full files, exhaustive implementation, or the model has been truncating/handwaving.

Load:
- `full-output-enforcement`.

This is a utility skill. Combine it with the relevant frontend recipe only when output completeness is the risk.

## Conflict rules

- `frontend-skill` controls **composition and restraint**: hero structure, no card spam, image-led hierarchy, short copy.
- `design-taste-frontend` controls **implementation safety**: dependency checks, Tailwind version checks, RSC/client boundaries, `min-h-[100dvh]`, transform/opacity animation, no emojis.
- `emil-design-eng`, `motion-craft`, and `make-interfaces-feel-better` control **motion/detail discipline**: short timings, interruptibility, active states, transform origins, no `transition: all`.
- `shadcn` controls **shadcn component API and CLI behavior** when present.
- `web-animation-demo` wins over GSAP/Framer advice for product demo sections unless the user explicitly chooses another animation stack.
- `redesign-existing-projects` wins over greenfield rewrite instincts when the task is an existing codebase.
- Never mix style presets (`minimalist-ui`, `industrial-brutalist-ui`, `high-end-visual-design`, `gpt-taste`) unless the user explicitly picks that style.

## Default final pass

For any browser-facing code change, after implementation:
1. Run project checks (`lint`, `typecheck`, tests) where available.
2. Use browser/adversarial verification if the change affects visible UI.
3. Report what was verified and what was not.
