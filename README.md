# pi-extension-pack

A curated pack of Pi extensions for:

- safer tool execution
- persistent markdown memory
- per-session notebook continuity
- autonomous Magic Docs maintenance

It is set up as a **Pi package** that can be installed from a local path or GitHub.

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
- commands:
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
Tracks markdown files whose first line is `# MAGIC DOC: ...` and treats them as living architecture/overview docs:
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
Kept in `extras/skill-observer/` because it is currently tied to a more local / legacy setup:
- analytics-first now, but still contains legacy Cognee integration
- shell/python helper scripts are better treated as a separate package or cleaned up before publishing widely

### `claude-inspired-coach`
A lightweight prompt coach, kept as reference only. It is not enabled by default because the more concrete runtime/tooling extensions are the real value here.

## Install

### From a local path

```bash
pi install /absolute/path/to/pi-extension-pack
```

### From GitHub

```bash
pi install git:github.com/<your-org-or-user>/pi-extension-pack
```

Or directly via URL:

```bash
pi install https://github.com/<your-org-or-user>/pi-extension-pack
```

## Project-local install

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
```

## Notes

- The package is currently marked `UNLICENSED`. Choose a license before publishing publicly if you want reuse rights to be explicit.
- The default package manifest only loads `./extensions`. `extras/` is included for reference and future extraction, but is not auto-loaded by Pi.
- The extensions are designed for Pi's TypeScript extension loader, so no build step is required.

## Suggested next step before pushing

- review package name / repo name
- choose a license
- optionally split `skill-observer` into its own repo after removing local-path assumptions and legacy Cognee coupling
