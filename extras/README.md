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
Generic watched-source update checker:
- useful for upstream skill sources
- requires real local git checkouts for watched sources
- not enabled by default because the fork/filter strategy in `docs/UPSTREAM_STRATEGY.md` is the main recovery path

### `claude-inspired-coach`
Small prompt-layer nudge extension. Kept for reference, but the concrete tool/runtime extensions are the stronger default package.
