# Skill-router eval assets

This directory holds the offline evaluation artifacts for the gated skill-discovery plan.

## Files

- `phase0-baseline.md` — measurement snapshot of the current skill surface and observed misselection patterns
- `skill-router-eval.json` — labeled offline eval set for retrieval/router scoring

## Eval schema

Each eval row has:

- `id` — stable case ID
- `task` — natural-language user request or first-turn-style query
- `correctSkills` — one or more acceptable gold skills
- `notes` — optional rationale / disambiguation

## Scoring rule

A prediction is counted as correct when **any** gold skill appears in the router's top-k list.

Recommended metrics:

- top-1 precision
- top-3 precision

Current Phase 2 / Phase 3 success bar:

- **top-3 precision ≥ 80%**
