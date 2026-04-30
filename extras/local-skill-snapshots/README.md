# Local skill snapshots

These skills were present in `~/.agents/skills` but were not listed in `~/.agents/.skill-lock.json` when the package inventory was generated.

They are preserved here as disaster-recovery snapshots, but they are **not loaded by the default Pi package manifest**. Move a skill into top-level `skills/` only after deciding this repo should own and auto-enable it.

Current snapshots:

- `fal-generate` — fal.ai generation helper skill; requires external credentials such as `FAL_KEY` at runtime.
- `plannotator-compound` — Plannotator/Claude planning-analysis workflow.
- `video-prompting` — AI video prompt writing/debugging helper.
