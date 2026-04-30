# Phase 3 decision — QMD-backed routing

## Decision

**Skipped for now.**

## Reason

Phase 3 only happens if the minimal keyword/tag router underperforms on the labeled eval set.

That did not happen.

Phase 2 results:

- top-1 precision: **87.5%**
- top-3 precision: **100%**
- target: **top-3 precision ≥ 80%**

Because the minimal router already beats the target comfortably, there is no justification yet for making QMD a load-bearing routing dependency.

## What remains true

- QMD itself was still modernized independently.
- QMD remains available as a future escalation path if the keyword/tag router regresses or fails on a broader eval.
- If Phase 3 is revisited later, it should index existing `SKILL.md` frontmatter/description directly rather than a parallel generated catalog.

## Trigger to revisit

Re-open Phase 3 only if one of these happens:

- a larger eval set drops below the target
- real-session router misses show clear recall problems that tags cannot fix cheaply
- multi-repo skill growth materially changes the search problem size
