# Phase 2 eval — minimal keyword/tag router

## Summary

Phase 2 meets the target **without QMD retrieval**.

Using the minimal router over existing `SKILL.md` frontmatter (`name`, `description`, optional `tags`):

- **eval set size:** 40 tasks
- **indexed skills:** 113 unique skill names across scanned roots
- **hidden skills searched for auto-routing:** 103
- **top-1 precision:** **87.5%**
- **top-3 precision:** **100%**
- **misses:** 0

This exceeds the Phase 2 gate of **top-3 precision ≥ 80%**.

## Scoring approach

The router uses:

- token overlap on skill `name`
- token overlap on skill `description`
- token overlap on optional `tags`
- substring boosts for exact / near-exact name or tag matches
- lightweight IDF weighting so rarer terms matter more than generic ones

No embeddings, no QMD, no parallel generated catalog.

## Chosen auto-injection floor

Current auto-injection floor:

- **top candidate score ≥ 30**

Why this floor:

- it preserves full recall on the offline eval set
- it suppresses obvious junk on unrelated first-turn inputs during spot checks
- it keeps the router quiet when query/skill overlap is weak

## Smoke tests

### Explicit lookup

Runtime smoke-tested via the new command:

```text
/skill-find qmd mcp markdown search
```

Observed:

- top match: `qmd`
- lookup time: **36 ms**

Also tested:

```text
/skill-find durable object websocket presence
```

Observed:

- top match: `durable-objects`
- lookup time: **54 ms**

These are within the Phase 2 latency target envelope.

## Example outcomes

### Strong direct match

Task:

- `Set up QMD so I can index a repo, search it from the CLI, and expose it over MCP for agent use.`

Top result:

- `qmd`

### Strong specialist match

Task:

- `I need a Durable Object websocket room with presence and ordered message delivery. How should I build it?`

Top-3 included:

- `durable-objects`
- `cloudflare`

### Ambiguous but still successful top-3

Some tasks do not get the gold skill at top-1, but still land in top-3. That is acceptable for this phase because the design target is **top-3 injection quality**, not perfect top-1 ranking.

## Files

- scorer: `extras/skill-router/eval/score-skill-router.mjs`
- eval set: `extras/skill-router/eval/skill-router-eval.json`
- runtime extension: `extras/skill-router/index.ts`

## Gate decision

**Phase 2 passes. Do not proceed to QMD-backed routing by default.**
