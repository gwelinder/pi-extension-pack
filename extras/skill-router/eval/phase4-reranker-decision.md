# Phase 4 decision — observer-derived reranker

## Decision

**Do not build a reranker yet.**

## Reason

The gated plan requires at least **500+ logged skill selections** before evaluating whether observer-derived reranking can beat the retrieval-only baseline.

Current observed volume is still below that bar.

## Current counts

From the active `skill-observer` log window:

- `run_end` rows: **83**
- summed loaded-skill selections: **114**

That is not enough signal to justify a reranker.

## What we do now

- keep `skill-observer` in logging / analytics mode
- keep Phase 2 retrieval-only routing as the baseline
- defer any reranking logic until there is enough real selection volume to compare fairly

## Revisit trigger

Re-open Phase 4 only when:

- logged skill selections exceed **500**
- there is enough router usage to compare reranked results against the same offline / real-session baseline
- the added complexity has a realistic chance of beating the current keyword/tag baseline
