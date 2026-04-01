# pi-extension-pack

A curated Pi package that bundles the most generally useful extensions built during this Pi upgrade pass:

- **`bash-fixer`** — conservative bash mistake repair before execution
- **`tool-fixer`** — better `read` / `edit` recovery and diagnostics
- **`pi-memory-system`** — Claude-style persistent markdown memory
- **`pi-session-notebook`** — structured per-session continuity notebook
- **`pi-magic-docs`** — living architecture docs with autonomous maintenance

The default manifest enables the production-ready extensions under `extensions/`.
More experimental or more locally-coupled pieces live in `extras/`.

## Why this package exists

These extensions were built to make Pi more reliable and more stateful without depending on opaque graph memory or prompt-only nudges.

The package focuses on four things:

1. **fix common model/tooling mistakes at the runtime layer**
2. **store durable context in readable markdown files**
3. **preserve session continuity across long runs and compaction**
4. **keep architecture docs alive with low-friction maintenance**

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

### `pi-memory-system`
Adds Claude-style durable markdown memory under `~/.pi/agent/memory/`:
- typed memories: `user`, `feedback`, `project`, `reference`
- scoped storage: user, project, private
- `MEMORY.md` indexes
- selective memory recall into the system prompt

Commands:
- `/remember`
- `/forget`
- `/memory-status`

### `pi-session-notebook`
Creates a per-session notebook under `~/.pi/agent/session-notebooks/` and injects it into the prompt:
- session title
- current state
- task specification
- files and functions
- workflow
- errors and corrections
- learnings
- key results
- worklog

Command:
- `/notebook-status`

### `pi-magic-docs`
Tracks markdown files whose first line is `# MAGIC DOC: ...` and treats them as living architecture / overview docs:
- tracks docs on read, edit, and write
- persists tracked docs in session state
- manual update command
- autonomous maintenance after idle assistant runs
- cooldown-gated auto-queueing
- tight scoped edit guard during update mode

Commands:
- `/magic-docs-status`
- `/magic-docs-update [path]`

## Included in `extras/`, but not enabled by default

### `skill-observer`
Kept in `extras/skill-observer/` because it is still somewhat transitional:
- analytics-first now, but still contains legacy Cognee integration
- bundles shell/python helper scripts
- likely deserves its own package after further cleanup

### `claude-inspired-coach`
A lightweight prompt coach kept as reference only. It is not enabled by default because the concrete runtime/tooling extensions are the main value here.

## Install

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
    pi-memory-system/
    pi-session-notebook/
    pi-magic-docs/
  extras/
    skill-observer/
    claude-inspired-coach/
  package.json
  README.md
  LICENSE
```

## Notes

- The default package manifest only loads `./extensions`.
- `extras/` is included for reference and future extraction, but is not auto-loaded by Pi.
- The extensions are designed for Pi's TypeScript extension loader, so no build step is required.
- Licensed under MIT.

## Repository

- GitHub: https://github.com/gwelinder/pi-extension-pack
