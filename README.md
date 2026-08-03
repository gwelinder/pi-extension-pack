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
- **`frontend-stack`** — local frontend/design skill router
- **`codex-ui-design`** — image-first UI design workflow via Codex app-server
- **`agent-mail-coordination`**: collision-safe ownership and handoffs for agents sharing a checkout
- **`nextjs-ubs-review`**: source-validated UBS review of changed Next.js server boundaries

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
Adds an additive Bobby canonical-memory bridge while preserving native Pi Markdown memory under `~/.pi/agent/memory/` as a resilient, read-only edge-cache and evidence source:
- Bobby is the canonical reconciliation authority; native Markdown memories are never disabled, deleted, or directly rewritten by this extension
- `before_agent_start` combines native records with Bobby's generated canonical manifest by exact-token relevance and project identity; active agent-safe canonical records win duplicate/supersession conflicts, with at most two records / 1200 chars injected by default
- explicit memory operations create Bobby proposals only; deprecation targets an exact canonical record and never removes native files
- inferred extraction runs in an isolated, tool-less Pi print child after `agent_end`; it submits pending Bobby proposals off-thread and never adds a turn or message to the main session
- absent/malformed Bobby manifests or unavailable CLI fail open for conversation and fail closed for canonical mutation

Configuration: `BOBBY_BIN`, `BOBBY_CANONICAL_MEMORY_ROOT`, and `BOBBY_PI_MEMORY_MANIFEST` select the typed `canonical-memory-client` boundary and manifest. `BOBBY_CANONICAL_MEMORY_COMMANDS_JSON` can override that one boundary for testing. `PI_MEMORY_AMBIENT_MAX_CHARS` directly bounds ambient injection (200–8000 characters; default 1200). Pi has no accept/apply path: explicit and inferred writes remain pending Bobby proposals.

Commands/tool:
- `/remember [type] [scope] :: text`
- `/forget <record-id or query>`
- `/memory-status`
- `memory_query` — bounded Bobby canonical search
- `memory_context` — Bobby's bounded native context projection
- `memory_propose` — pending create/deprecate proposal only

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

### `agent-mail-coordination`
A CLI-first MCP Agent Mail workflow for two or more agents sharing a checkout. It checks conflicts, reserves narrow ownership paths, threads blocker and handoff messages, requires acknowledgements where they matter, and releases reservations at the end. It does not start a background service by default.

### `nextjs-ubs-review`
A narrow Ultimate Bug Scanner workflow for changed Next.js API routes, middleware, server actions, and other server boundaries. Its wrapper selects at most 200 relevant files, invokes UBS with a compatible modern Bash on macOS, and requires source validation before a scanner candidate becomes a finding.

## Included in `extras/`, but not enabled by default

### `dcg-guard`
Opt-in Destructive Command Guard enforcement for Pi's built-in shell tool, direct Codex-style command tools, and static nested command calls inside Code Mode. Dynamic nested commands fail closed because Pi extension hooks cannot inspect them after Code Mode dispatch.

### `skill-observer`
Kept in `extras/skill-observer/` because it is still somewhat transitional:
- analytics-first now, but still contains legacy Cognee integration
- legacy daemon behavior is opt-in; the default role is telemetry / analytics
- status output reports daemon health, stale-PID cleanup, and log rotation state
- bundles shell/python helper scripts with package-relative / `PI_PACKAGE_DIR`-aware resolution
- likely deserves its own package after further cleanup

### `skill-gateway`
Unified routed discovery in `extras/skill-gateway/`:
- preserves Pi's native catalog, package/project precedence, and `/skill:*` commands
- removes the full generated skill XML block from routed model turns
- exposes one compact `skill_lookup` tool for both search and exact-name loading
- injects at most one bounded relevant recommendation per external task
- records prompt/provider-surface counts without retaining prompt text
- replaces the retired `skill-router` and `skill-bundle-router`
- ships with hermetic tests and a 40-prompt routing eval

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
  skills/
    frontend-stack/
    codex-ui-design/
    agent-mail-coordination/
    nextjs-ubs-review/
  prompts/
  themes/
  extras/
    dcg-guard/
    skill-gateway/
    skill-observer/
    skill-update-checker/
    tool-profiles/
    codex-mode-toggle/
    local-skill-snapshots/
    operating-principles/
    retired/skill-router/
    retired/skill-bundle-router/
    retired/pi-magic-docs/
    retired/pi-session-notebook/
  docs/
    BOOTSTRAP.md
    dcg-config.example.toml
    INVENTORY.md
    PI_RELEASE_REVIEW.md
    SECRETS.md
    SELECTIVE_INSTALL.md
    UPSTREAM_STRATEGY.md
  scripts/
    audit-local.mjs
    audit-agent-skill-topology.mjs
    audit-harness-prompt-surfaces.mjs
    audit-skill-usage.mjs
    propose-skill-maintenance.mjs
    sync-agent-skills.mjs
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
- When a local owned resource is ahead of the repo, run `pnpm run sync:owned`, review, then commit so the repository stays canonical.
- The extensions are designed for Pi's TypeScript extension loader, so no build step is required.
- Licensed under MIT.

## Repository

- GitHub: https://github.com/gwelinder/pi-extension-pack
