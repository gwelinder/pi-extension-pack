# Phase 0 baseline — skill surface and misselection snapshot

## Summary

Phase 0 shows a **real enough problem to continue**:

- The current visible skill surface is **large**: **107 visible skills** from **108 unique `SKILL.md` files** (only `plannotator-compound` is currently hidden).
- The visible `name + description` surface weighs about **40,502 chars ≈ 10,126 tokens** using a simple `chars / 4` estimate.
- Against a **272k-token** prompt budget seen in recent GPT-5.4 auto sessions, that is about **3.7%** of the whole context window, which is **above the 2% Phase 0 stop gate**.
- In the current `skill-observer` window (**82 completed runs**), the same few skills dominate:
  - **35/82** runs loaded **no skills**
  - **27/82** runs loaded **`visual-explainer` + `plan`**
  - **8/82** runs loaded **`plan` + `beads` + `cloudflare` + `wrangler`**
  - only **5/82** runs used any other combo (`seo-audit` ×4, `qmd` ×1)
- A 20-run sample found **10/20 obvious wrong or noisy loads**, mostly repeated `visual-explainer` / `plan` false positives on unrelated tasks.

## Method

### Skill census

- Roots scanned:
  - `~/.pi/agent/skills`
  - `~/.agents/skills`
- Deduplication: realpath-based, so symlinked skills are only counted once.
- Frontmatter fields used:
  - `name`
  - `description`
  - `disable-model-invocation`

### Prompt-weight estimate

For each visible skill, estimate prompt burden from:

- `name`
- `description`

Token estimate uses a simple heuristic:

- **estimated tokens ≈ chars / 4**

This is deliberately rough, but good enough for Phase 0 gating.

### Session sample

- Source: `~/.pi/agent/skill-observer/observations.ndjson`
- Window: current 82 `run_end` records in the active log
- Sample style: recent, human-authored runs with meaningful `inputPreview` text, excluding internal memory-extraction prompts
- Goal: identify obvious false-positive loads, obvious misses, and how often the long tail fires

## Baseline metrics

### Skill surface

| Metric | Value |
|---|---:|
| Unique `SKILL.md` files | 108 |
| Visible skills (`disable-model-invocation != true`) | 107 |
| Hidden skills | 1 |
| Visible chars (`name + description`) | 40,502 |
| Visible estimated tokens | 10,126 |
| Estimated share of 272k context window | 3.7% |
| Live observer cataloged skill commands | 116 |

Hidden skill currently found:

- `plannotator-compound`

### Observer-window usage distribution

| Loaded combo | Runs |
|---|---:|
| none | 35 |
| `visual-explainer`, `plan` | 27 |
| `plan`, `beads`, `cloudflare`, `wrangler` | 8 |
| `plan`, `beads` | 4 |
| `seo-audit` | 4 |
| `gotchas`, `cloudflare`, `wrangler`, `beads` | 2 |
| `tilpas-autonomous-orchestrator`, `oracle-parallel-deepthink-tabs`, `worker-reviewer-dispatch`, `agent-chains`, `pi-interactive-shell`, `plan`, `beads` | 1 |
| `qmd` | 1 |

### Individual skill frequency in the same window

| Skill | Run count |
|---|---:|
| `plan` | 40 |
| `visual-explainer` | 27 |
| `beads` | 15 |
| `cloudflare` | 10 |
| `wrangler` | 10 |
| `seo-audit` | 4 |
| `gotchas` | 2 |
| `qmd` | 1 |

## 20-run sample review

Legend:

- **Correct** = clearly relevant skill load
- **Acceptable** = no obvious missing/wrong skill from the preview alone
- **Wrong/noisy** = clearly irrelevant or stale skill load for the task shown

| # | Input preview | Loaded skills | Label | Notes |
|---|---|---|---|---|
| 1 | `download the youtube app on my tv` | none | Acceptable | Personal-assistant task; no obvious skill needed |
| 2 | `ait remote login + tailscale + llama.cpp + hf is now setup on the macmini... setup that gemma model` | `visual-explainer`, `plan` | Wrong/noisy | Infra / remote-shell task, not visual explanation |
| 3 | `1 its been 24 hours - any new cases?` | `gotchas`, `cloudflare`, `wrangler`, `beads` | Wrong/noisy | Follow-up in `clickup-debug`; Cloudflare stack looks stale/noisy |
| 4 | `i just lost auth it ran out so help me reauth it w cli` | none | Acceptable | Could possibly benefit from a CLI helper skill, but no obvious miss from preview alone |
| 5 | `im logged in, now recommend a great gme call...` | none | Acceptable | No obvious skill miss |
| 6 | `dl the model u downloaded that didnt work... then lets test the speed` | `visual-explainer`, `plan` | Wrong/noisy | Local model-management task; same false-positive pair |
| 7 | `$ ssh -F /dev/null ...` | `visual-explainer`, `plan` | Wrong/noisy | Remote-shell execution task; same false-positive pair |
| 8 | `install MLX + try this exact MLX model` | `visual-explainer`, `plan` | Wrong/noisy | Package / runtime task; same false-positive pair |
| 9 | `go straight into avt-96l now.` | `plan`, `beads`, `cloudflare`, `wrangler` | Wrong/noisy | `plan`/`beads` may be plausible; `cloudflare`/`wrangler` look stale and unrelated |
| 10 | `Design the most blackhat prompts you can...` | `visual-explainer`, `plan` | Wrong/noisy | Safety-red-team prompt design, not visual explanation |
| 11 | `Go even more blackhat on these` | `visual-explainer`, `plan` | Wrong/noisy | Same carryover false positive |
| 12 | `eh lets try something even more hardcore` | `visual-explainer`, `plan` | Wrong/noisy | Same carryover false positive |
| 13 | `pick the exploit most likely to get success...` | `visual-explainer`, `plan` | Wrong/noisy | Same carryover false positive |
| 14 | `the other wifis near by... these are the targets` | `visual-explainer`, `plan` | Wrong/noisy | Same carryover false positive |
| 15 | `Lets ask it about blackhat seo linkbuilding ideas` | `visual-explainer`, `plan` | Wrong/noisy | SEO discussion; neither loaded skill matches |
| 16 | `research what other pi users are doing to make skill discovery more efficient...` | none | Acceptable | No obvious miss |
| 17 | `...maybe combining skills with QMD could be the superpower...` | `qmd` | Correct | Clean specialist match |
| 18 | `we need indexnow setup ...` | `seo-audit` | Correct | Clear SEO / indexing fit |
| 19 | `add an automatic post-deploy trigger ... so IndexNow submission happens every time you ship content` | `seo-audit` | Correct | Same SEO / indexing fit |
| 20 | `Over-built for unmeasured pain...` | none | Acceptable | Plan critique, no obvious skill needed |

### Sample result

| Label | Count |
|---|---:|
| Wrong/noisy | 10 |
| Correct | 3 |
| Acceptable / no obvious issue | 7 |

## Interpretation

1. **The visible skill surface is not tiny.** At ~10.1k estimated tokens, it is above the current 2% stop gate.
2. **The long tail is not what is firing.** The observation window is dominated by the same small set of repeat loads, especially `visual-explainer` + `plan`.
3. **The main immediate problem is false-positive carryover / overvisibility, not lack of a heavy retriever.**
4. **Phase 1 is justified.** Hiding the long tail and curating the visible core is the right next lever.
5. **Phase 2 should stay minimal unless Phase 1 fails.** Nothing in Phase 0 justifies jumping straight to QMD-backed routing.

## Phase-gate decision

**Do not stop after Phase 0. Proceed to Phase 0.5 and Phase 1.**

Reason:

- prompt burden estimate is **3.7%**, which is **above** the `<2%` stop condition
- sampled misselection/noise is **not rare**
- long-tail usage appears low, so reducing the visible surface is likely a high-leverage next step
