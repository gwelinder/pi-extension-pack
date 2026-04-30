# skill-router

Experimental skill discovery helper for Pi.

This extension is intentionally minimal:

- runs only on the **first external user turn per session**
- indexes Pi's live skill command catalog first, then enriches entries from the backing `SKILL.md` frontmatter
- matches against `name`, `description`, and optional `tags`
- injects at most **3 hidden specialist skills** when confidence clears an empirical floor
- exposes exactly one explicit user lookup command: **`/skill-find <query>`**
- also provides a model-callable `skill_lookup` tool with compact custom rendering for on-demand skill discovery later in a run

## Design constraints

This extension exists to support the gated skill-discovery plan:

- **Phase 1 first:** hide the long tail before building retrieval
- **No parallel generated catalog:** use Pi's live discovered commands plus existing `SKILL.md` files directly
- **No QMD dependency in Phase 2:** keyword/tag routing only
- **Latency budget:** auto-injection skips the turn if indexing/search takes more than **150 ms**
- **Freshness:** the skill index is rebuilt lazily when `SKILL.md` mtimes change

## Auto-injection behavior

On the first real user turn of a session, the extension:

1. builds or refreshes the in-memory skill index from `pi.getCommands()` and live skill metadata
2. searches only **hidden** skills
3. injects a short `Hidden skill candidates` block into the system prompt if the top score clears the floor
4. otherwise stays silent

The current confidence floor was chosen from the offline eval set in `eval/skill-router-eval.json`.

## Explicit lookup

```text
/skill-find <query>
```

Returns ranked skill matches with:

- hidden vs visible status
- live command provenance (`sourceInfo`-derived scope/origin)
- score
- matched query tokens
- tags
- short description

## Files in this directory

- `index.ts` — runtime extension
- `eval/README.md` — eval schema and metrics
- `eval/phase0-baseline.md` — pre-change measurement snapshot
- `eval/phase1-core-policy.md` — curated visible-core policy
- `eval/phase1-remeasure.md` — post-hide remeasurement
- `eval/skill-router-eval.json` — labeled offline eval set
- `eval/score-skill-router.mjs` — offline scorer for Phase 2
- `eval/phase2-eval.md` — eval results and chosen thresholds

## Status

- kept in `extras/` because this is still a policy/routing experiment
- suitable for local runtime activation via `~/.pi/agent/extensions/skill-router/`
- not promoted to default package loading unless longer-term usage proves it stable and valuable
