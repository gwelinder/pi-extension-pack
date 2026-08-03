# Trusted engineering skill sources

Repo-owned source directories for the cross-harness trusted engineering set.

They live outside the package's normal `skills/` root deliberately. Pi must load the same immutable canonical snapshots as Codex, Claude, Hermes, and OpenClaw rather than bypassing the pin through a package working tree.

Do not link these working-tree directories directly. Source ownership and activation are handled by:

- `config/trusted-skill-sources.json`
- `scripts/manage-trusted-skills.mjs`
- `config/skill-distribution.json`
- `scripts/sync-agent-skills.mjs`

See `docs/TRUSTED_ENGINEERING_SKILLS.md` for the reviewed set, update gate, validation, and textbook pilot.
