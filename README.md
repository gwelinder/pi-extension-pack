# pi-extension-pack

A curated Pi bootstrap package for Gustav's owned Pi extensions, owned skills, and recovery docs.

Included by default:

- **`bash-fixer`** — conservative bash mistake repair before execution
- **`tool-fixer`** — better `read` / `edit` recovery and diagnostics
- **`exa`** — compact Exa search / URL-content tool with highlights-first defaults
- **`rich-fetch`** — compact rich URL/media extractor for GitHub, PDFs, YouTube/video, and Gemini URL-context fallback
- **`codegraph`** — Pi-native wrapper for local semantic code indexes, callers/callees, impact, and affected tests
- **`pi-memory-system`** — Claude-style persistent markdown memory
- **`codex-ui-gallery`** — high-quality native Pi gallery for Codex UI image outputs
- **`duel-deck`** — parallel UI generation/model×skill comparison viewer
- **`finder-model-default`** — default model routing for the Finder tool when env is unset
- **`frontend-stack`** — local frontend/design skill router
- **`codex-ui-design`** — image-first UI design workflow via Codex app-server

The default manifest enables production-ready resources under `extensions/` and `skills/`.
More experimental or locally-coupled pieces live in `extras/`.

## Why this package exists

These extensions were built to make Pi more reliable and more stateful without depending on opaque graph memory or prompt-only nudges.

The package focuses on four things:

1. **fix common model/tooling mistakes at the runtime layer**
2. **store durable context in readable markdown files**
3. **preserve durable context across long runs and compaction**
4. **recover owned Pi UI/design workflows from GitHub without depending on this MacBook**

## Included by default

### `bash-fixer`
Conservative pre-execution rewrites for common shell mistakes:
- quote bare paths with parentheses
- rewrite `rg --include` to `rg -g`
- rewrite recursive `grep -r` searches to `rg`
- prefer `ggrep -P` when GNU grep is available
- fix a few known `cd` project-name typos

### `tool-fixer`
Wraps Pi's built-in `read` and `edit` tools to improve failure recovery:
- ENOENT hints with nearby file suggestions
- directory-vs-file read guidance
- stale-file edit hints
- non-unique edit match locations
- memory-file freshness notes

### `exa`
Compact Exa integration for Pi:
- one model-callable `exa` tool for web search, code/docs search, and URL content fetches
- defaults to Exa `/search` with `type: "auto"` and `contents.highlights: true`
- uses `/contents` when `urls` are provided
- supports `kind: "code"`, domain filters, freshness, text caps, and Exa `outputSchema`
- stores full raw JSON under `~/.pi/agent/exa-results/` so no separate `get_search_content` tool is needed

### `rich-fetch`
Compact content extractor for cases where search is not enough:
- GitHub repo/file extraction via clone/API fallback
- PDF text extraction via `pdftotext`
- YouTube and local-video analysis via Gemini, with optional frame extraction via `yt-dlp`/`ffmpeg`
- Gemini URL-context fallback for JS-rendered/blocked pages
- stores full artifacts under `~/.pi/agent/rich-fetch-results/`

### `codegraph`
Pi-native CodeGraph wrapper for local semantic code intelligence:
- registers one `codegraph` tool with `context`, `search`, `files`, `callers`, `callees`, `impact`, `affected`, `node`, `explore`, `trace`, `status`, `sync`, `init`, and `index` actions
- auto-syncs the local `.codegraph/` index before query actions
- resolves the CLI from `PI_CODEGRAPH_BIN`, the bundled `@colbymchenry/codegraph` dependency, local `node_modules/.bin`, or `PATH`
- archives very large outputs under `~/.pi/agent/artifacts/codegraph/`
- use `codegraph init -i` or the tool's `init` action to enable a new repo

### `pi-memory-system`
Adds Claude-style durable markdown memory under `~/.pi/agent/memory/`:
- typed memories: `user`, `feedback`, `project`, `reference`
- scoped storage: user, project, private
- `MEMORY.md` indexes
- selective memory recall into the system prompt
- background extraction guarded to memory directories only
- `/memory-status` now reports counts, index truncation state, selector mode, and extraction diagnostics

Commands:
- `/remember`
- `/forget`
- `/memory-status`

### `codex-ui-gallery`
High-quality native Pi TUI image gallery for `codex-ui-design` outputs:
- opens generated `summary.json`, output directories, or image paths
- renders with Pi's native terminal image component outside overlays
- supports multi-image navigation and screen-height fitting

Commands/tool:
- `/codex-gallery [output-dir|summary.json|image-path]`
- `/codex-image <image-path>`
- `/codex-gallery-clear`
- tool: `show_codex_ui_gallery`

### `duel-deck`
Runs the same UI task through multiple model×skill combinations and presents generated HTML options in a comparison deck.

### `finder-model-default`
Sets a preferred `PI_FINDER_MODELS` fallback when the shell environment has not specified one.

### `frontend-stack`
A small routing skill for choosing the right local frontend/design skill mix without loading every overlapping UI skill at once.

### `codex-ui-design`
Image-first UI design skill and scripts using local `codex app-server` + logged-in ChatGPT/Codex auth. It is the transport/harness; for best visual output, pair it with optional Taste skills such as [`imagegen-frontend-web`](https://github.com/Leonxlnx/taste-skill/tree/main/skills/imagegen-frontend-web) for Codex prompt art direction and [`image-to-code`](https://github.com/Leonxlnx/taste-skill/tree/main/skills/image-to-code-skill) when implementing a chosen mockup.

Scripts:
- `scripts/probe.sh`
- `scripts/imagegen.sh`
- `scripts/generate.sh`
- `scripts/upgrade.sh`
- `scripts/describe.sh`
- `scripts/iterate.sh`
- `scripts/screenshot.sh`

## Included in `extras/`, but not enabled by default

### `skill-observer`
Kept in `extras/skill-observer/` because it is still somewhat transitional:
- analytics-first now, but still contains legacy Cognee integration
- legacy daemon behavior is opt-in; the default role is telemetry / analytics
- status output reports daemon health, stale-PID cleanup, and log rotation state
- bundles shell/python helper scripts with package-relative / `PI_PACKAGE_DIR`-aware resolution
- likely deserves its own package after further cleanup

### `skill-router`
Experimental gated skill discovery in `extras/skill-router/`:
- pairs with a curated visible-core / hidden-specialist skill policy
- indexes Pi's live discovered skill command catalog, then enriches entries from `SKILL.md` frontmatter (no parallel catalog)
- injects only top hidden candidates on the first user turn when confidence clears a measured floor
- exposes exactly one explicit user lookup command: `/skill-find <query>`
- also provides a model-callable `skill_lookup` tool with compact self-rendered output for later-turn discovery
- ships with offline eval assets and scorer scripts under `extras/skill-router/eval/`
- intentionally not enabled by default until longer-term usage proves the policy stable

### `skill-update-checker`
Safe external skill updater in `extras/skill-update-checker/`:
- report-first replacement for unsafe `npx skills update` flows
- reads `~/.agents/.skill-lock.json` and compares recorded upstream base vs local skill dir vs latest upstream
- preserves local-only files and local-only edits
- stops on local/upstream conflicts with review artifacts
- applies only explicit `--clean-only` or `--include-mergeable` plans, with backups and restore
- exposes `/skill-updates-status`, `/skill-updates-scan`, `/skill-updates-diff`, `/skill-updates-apply`, and `/skill-updates-restore`

### `operating-principles`
A lightweight prompt coach for always-on Pi working style and Gustav's core operating principles. Kept as an opt-in extra because it intentionally changes the system prompt.

### Retired extensions
- `retired/pi-magic-docs` — sunset Magic Docs extension. Session evidence showed many tracked reads but essentially no successful maintenance edits, so the always-on prompt burden was not justified.
- `retired/pi-session-notebook` — old automatic per-session notebook. Removed from defaults because it adds prompt weight and overlaps with Pi's native sessions plus `pi-memory-system` durable recall.

## Install

### Selected resources only

Users do **not** have to load everything in this public repo. Pi supports package filters in `settings.json`, for example:

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "extensions": ["extensions/codex-ui-gallery/**"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

See `docs/SELECTIVE_INSTALL.md` for copy-paste profiles.

### From a local path

```bash
pi install /absolute/path/to/pi-extension-pack
```

### From GitHub

```bash
pi install git:github.com/gwelinder/pi-extension-pack
```

Or directly via URL:

```bash
pi install https://github.com/gwelinder/pi-extension-pack
```

### Project-local install

```bash
pi install -l /absolute/path/to/pi-extension-pack
```

That writes the package to `.pi/settings.json` for the current project.

## Package structure

```text
pi-extension-pack/
  extensions/
    bash-fixer/
    tool-fixer/
    exa/
    rich-fetch/
    codegraph/
    pi-memory-system/
    codex-ui-gallery/
    duel-deck/
    finder-model-default.ts
  skills/
    frontend-stack/
    codex-ui-design/
  prompts/
  themes/
  extras/
    skill-observer/
    skill-router/
    skill-update-checker/
    local-skill-snapshots/
    operating-principles/
    retired/pi-magic-docs/
    retired/pi-session-notebook/
  docs/
    BOOTSTRAP.md
    INVENTORY.md
    SECRETS.md
    SELECTIVE_INSTALL.md
    UPSTREAM_STRATEGY.md
  scripts/
    audit-local.mjs
    check-no-secrets.mjs
    sync-owned-resources.mjs
  package.json
  README.md
  LICENSE
```

## Notes

- The default package manifest loads `./extensions`, `./skills`, `./prompts`, and `./themes`.
- `extras/` is included for reference and future extraction, but is not auto-loaded by Pi.
- Third-party skills should usually remain external/forked package sources with filters; see `docs/UPSTREAM_STRATEGY.md`.
- Secret-bearing config is represented by examples only; see `docs/SECRETS.md`.
- When a local owned resource is ahead of the repo, run `npm run sync:owned`, review, then commit so the repository stays canonical.
- The extensions are designed for Pi's TypeScript extension loader, so no build step is required.
- Licensed under MIT.

## Repository

- GitHub: https://github.com/gwelinder/pi-extension-pack
