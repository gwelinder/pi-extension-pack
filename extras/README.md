# Extras

These extensions are included in the repository for reference, but are **not** part of the default Pi package manifest.

## Why they are excluded

### `skill-observer`
Useful, but still coupled to a more local / transitional setup:
- analytics-only by default now
- legacy Cognee scripts still live beside it
- better shipped as a separate package after cleanup

### `skill-router`
Experimental gated skill discovery:
- indexes Pi's live command/resource catalog
- enriches hidden candidates from `SKILL.md` frontmatter
- provides `/skill-find` and `skill_lookup`
- useful, but should remain opt-in until the policy is proven stable

### `skill-update-checker`
Safe external skill updater:
- report-first scans for `skills` CLI installs under `~/.agents/skills`
- compares recorded upstream base, local live files, and latest upstream
- preserves local edits and writes conflict artifacts instead of overwriting
- not enabled by default because it is still an operator tool for sensitive skill updates

### `local-skill-snapshots`
Disaster-recovery copies of local skills not recorded in `~/.agents/.skill-lock.json` at inventory time. They are intentionally not auto-loaded by the package manifest.

### `operating-principles`
Small prompt-layer nudge extension for always-on Pi working style and Gustav's core operating principles. Kept as an opt-in extra because it intentionally changes the system prompt.

### `retired/pi-magic-docs`
Sunset Magic Docs extension. Archived for reference only; no longer default because telemetry showed tracked reads but essentially no successful maintenance edits.

### `retired/pi-session-notebook`
Old automatic per-session notebook. Archived for reference only; no longer default because it overlaps with Pi's native session persistence and `pi-memory-system` while adding prompt weight every turn.
