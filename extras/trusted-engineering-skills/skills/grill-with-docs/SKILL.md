---
name: grill-with-docs
description: Interrogate an unclear plan, design, specification, ADR, or architecture document until the user and agent share a precise understanding. Use when the user says grill this, grill me with these docs, stress-test this plan, expose missing decisions, or wants a one-question-at-a-time design interview grounded in repository evidence. Route genuinely multi-session fog to Beads Wayfinder instead of manufacturing planning Markdown.
---

# Grill with docs

Use the supplied documents and repository as evidence, then resolve the remaining decisions with the user one at a time.

## orient

1. Read the applicable `AGENTS.md` and identify the canonical instruction and artifact owners.
2. Read every document the user supplied, including relevant linked sections and comments.
3. Inspect code, schemas, issue state, or source systems for facts that materially affect the discussion.
4. Separate factual unknowns from decisions. Investigate facts; reserve questions for choices only the user can make.
5. Use the `domain-modeling` skill when vocabulary, identity, ownership, invariants, or bounded contexts are involved. Use `codebase-design` when the decision concerns interfaces, seams, adapters, depth, or testability.

## interview

- State the current understanding and the highest-leverage unresolved decision.
- Ask exactly one question at a time and wait for the answer.
- Include a recommended answer with concrete reasoning and tradeoffs.
- Follow dependencies between decisions rather than jumping between unrelated branches.
- Challenge contradictions between the documents, code, and the user's current statement.
- Do not implement or rewrite the artifact until the user confirms shared understanding, unless the request explicitly authorizes an immediate edit after the interview.

If the way to the destination is already clear and fits in one session, stop using the interview once the decisive ambiguity is resolved.

If the effort spans sessions and the route itself remains unclear, use `beads-wayfinder`. The interview should resolve the destination and first visible frontier, not attempt to hold the whole map in chat.

## artifact discipline

Do not create a specification, scratch plan, glossary, ADR, or handoff file merely because the interview occurred.

- Beads owns evolving work and decision state when present.
- Existing documents are edited only when the user asked for a change and the document remains the right source of truth.
- `CONTEXT.md` and ADRs use the gates in `domain-modeling`.
- The final chat answer may be the complete output for a small decision.

## stopping condition

Stop when both sides can state:

- the destination and scope boundary;
- the accepted decisions and their reasons;
- remaining unknowns and who can resolve them;
- the next safe action, if any.

Ask the user to confirm shared understanding before acting on the result.

## provenance

Adapted from Matt Pocock's `grilling` and `grill-with-docs` skills at commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c` under the MIT license. This version is self-contained across harnesses and removes mandatory document creation.
