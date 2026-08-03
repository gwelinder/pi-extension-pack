---
name: domain-modeling
description: Sharpen a codebase's domain language, bounded contexts, identities, and durable architectural decisions. Use when terms are overloaded, the code and documentation disagree about a business concept, a migration crosses domain boundaries, or the user explicitly asks for DDD, a glossary, a context map, or an ADR. In Beads repositories, keep evolving work and decision state in Beads instead of creating planning Markdown by default.
---

# Domain modeling

Build a precise, code-grounded domain model. This is the active discipline of resolving vocabulary, identities, ownership, invariants, and context boundaries. Merely reading an existing glossary is normal repository orientation and does not require this workflow.

This adaptation keeps the strongest parts of Matt Pocock's domain-modeling workflow while making artifact creation source-aware and Beads-native.

## establish the owners

1. Read the applicable `AGENTS.md` first. Treat `CLAUDE.md` as canonical only when the repository says it is.
2. Find existing domain artifacts such as `CONTEXT.md`, `CONTEXT-MAP.md`, ADRs, schemas, and issue-tracker decisions.
3. If `.beads/` exists, run `bd prime` and inspect the relevant Bead before proposing a second decision ledger.
4. Inspect the implementation for factual claims. Ask the user about choices, not facts the repository can answer.

## sharpen the model

- Call out overloaded language immediately. Propose one canonical term for each distinct concept.
- Distinguish stable identity from labels, ordinals, display names, storage keys, and external identifiers.
- Use concrete edge cases to test relationships and invariants.
- Infer bounded contexts from differences in language, ownership, invariants, and lifecycle. Do not infer them from package or monorepo layout alone.
- Check the proposed language against code, persisted data shapes, and public contracts. Surface contradictions instead of silently choosing one source.
- State who owns each concept and which other contexts may only reference it.

## choose the smallest durable record

Avoid duplicate truth:

- **Beads** owns evolving work, open decisions, dependencies, and resolution comments.
- **`CONTEXT.md`** is only a durable ubiquitous-language glossary. It contains no implementation plan or work status.
- **`CONTEXT-MAP.md`** exists only when multiple bounded contexts and their relationships are independently useful to future maintainers.
- **ADRs** record durable rationale only when the three-part gate below passes.
- **Git and code** own implementation reality.

For an answer, review, or planning request, report the proposed model without writing files. Create or change artifacts only when the request authorizes changes.

When a Bead already owns the decision, record the evolving answer in its design, notes, or resolution comment. Create a glossary or ADR as well only when it has independent value after the Bead closes.

## glossary gate

Create or update `CONTEXT.md` only when at least one project-specific term has actually been resolved and the repository benefits from a durable shared vocabulary. Follow [the glossary format](references/CONTEXT-FORMAT.md).

Do not add general programming concepts, speculative terminology, implementation details, task status, or unresolved alternatives.

## ADR gate

Offer an ADR only when all three conditions are true:

1. The decision is costly to reverse.
2. A future maintainer would find the result surprising without its rationale.
3. Genuine alternatives existed and the choice reflects a real tradeoff.

If any condition fails, keep the resolution in the relevant Bead or code review. When the gate passes, use [the concise ADR format](references/ADR-FORMAT.md).

## completion

Finish with:

- canonical terms and terms to avoid;
- context ownership and relationships;
- code or data contradictions found;
- resolved and unresolved decisions;
- artifacts changed, or an explicit statement that none were warranted.

Do not continue into implementation unless the user also asked for implementation.

## provenance

Adapted from Matt Pocock's `domain-modeling` skill at commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c` under the MIT license. This version changes artifact ownership, bounded-context inference, instruction precedence, and Beads integration.
