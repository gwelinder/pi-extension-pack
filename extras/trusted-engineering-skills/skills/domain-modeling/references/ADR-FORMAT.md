# ADR format

Create an ADR only after the skill's three-part gate passes.

```md
# <short decision title>

<One to three sentences covering the context, decision, and why it won over the real alternatives.>
```

Optional sections are justified only when they add information:

- `Status` when a decision can be proposed, accepted, deprecated, or superseded.
- `Considered options` when rejected alternatives are likely to return.
- `Consequences` for non-obvious downstream effects.

Use the repository's established ADR location and numbering. If none exists, prefer `docs/adr/NNNN-slug.md` and create it lazily.

Do not copy work status, implementation checklists, or a Bead's full discussion into the ADR. Link to the Bead when the detailed investigation remains useful.
