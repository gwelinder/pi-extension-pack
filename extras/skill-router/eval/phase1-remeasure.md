# Phase 1 re-measure — hide the long tail

## Summary

Phase 1 produced a **large prompt-surface reduction**:

- visible skills went from **107** to **5**
- hidden skills went from **1** to **103**
- visible `name + description` weight fell from **40,502 chars / ~10,126 tokens** to **1,414 chars / ~354 tokens**
- prompt share vs a 272k window dropped from **3.7%** to **0.13%**

This comfortably beats the Phase 0 token target.

## Visible core after Phase 1

- `beads`
- `expect`
- `explore`
- `simplify`
- `verify`

## Metrics

| Metric | Phase 0 | Phase 1 | Delta |
|---|---:|---:|---:|
| Unique skills | 108 | 108 | 0 |
| Visible skills | 107 | 5 | -102 |
| Hidden skills | 1 | 103 | +102 |
| Visible chars (`name + description`) | 40,502 | 1,414 | -39,088 |
| Visible est. tokens | 10,126 | 354 | -9,772 |
| Share of 272k context window | 3.7% | 0.13% | -3.57 pts |

## Misselection proxy

We do not yet have a fresh post-change observation window, so this pass uses a **same-sample proxy** against the 20 reviewed runs from Phase 0.

What changed materially:

- repeated false-positive loads of `visual-explainer` disappeared from the default visible set
- repeated stale/default loads of `cloudflare` + `wrangler` disappeared from the default visible set
- `plan` was also moved into the hidden long tail because it appeared repeatedly on tasks that were clearly not asking for explicit planning

### Same-sample visible-skill replay

Under the new visible core, the 20 sampled runs would have shown visible loads only in these cases:

- `beads` on `1 its been 24 hours - any new cases?`
- `beads` on `start that now.`

Everything else that had been obviously noisy in the Phase 0 sample is now hidden by default.

## Interpretation

1. **Phase 1 clearly solved the token-bloat part of the problem.**
2. **Phase 1 likely solves most of the observed false-positive long-tail issue as well**, especially `visual-explainer`, `cloudflare`, `wrangler`, and `plan` over-visibility.
3. The remaining open question is not prompt burden anymore — it is **discoverability**: how easily the right hidden specialist can be surfaced without reintroducing prompt noise.

## Gate decision

Phase 1 is a clear win, but we should still continue to Phase 2 for two reasons:

- the user explicitly wants a skill search / router path
- once the long tail is hidden, explicit discovery becomes more important

So Phase 2 should proceed as the **minimal** router and one-command lookup path defined in the gated plan.
