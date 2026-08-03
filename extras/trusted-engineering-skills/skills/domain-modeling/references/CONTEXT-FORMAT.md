# `CONTEXT.md` format

Use this only for a durable ubiquitous-language glossary.

```md
# <context name>

<One or two sentences defining what this context owns.>

## language

**Maintenance target**
: The stable subject selected for a maintenance run.
  _Avoid_: chapter number, picker item

**Chapter identity**
: The stable identity of a chapter within a named book identity.
  _Avoid_: chapter label, ordinal
```

Rules:

- Define what a term is in one or two sentences.
- Pick one canonical term and list misleading synonyms under `_Avoid_`.
- Include only concepts specific to the project's domain.
- Keep implementation, migration steps, task status, and unresolved alternatives out.
- Group terms only when natural clusters have emerged.
- Link to the owning Bead or ADR only when the provenance would remain useful after the work closes.

For multiple contexts, create `CONTEXT-MAP.md` only after the context boundaries are evidenced by different language, ownership, invariants, or lifecycle. A directory boundary alone is not evidence.
