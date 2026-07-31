# Safe skill update audit

Updated: 2026-07-14

No update plan was applied.

## Full report-first scan

Run: `2026-07-14T111351854Z-199027`

- checked: 97
- up to date: 31
- clean updates: 7
- mergeable: 2
- conflicts/deletion approvals: 7
- needs adoption: 1
- fetch errors: 48
- local missing: 1

Report:

```text
~/.pi/agent/safe-skill-updates/runs/2026-07-14T111351854Z-199027/report.md
```

The high fetch-error count was not a network outage. Most errors came from upstream repositories reorganizing or removing skill folders while the lock retained old paths.

Examples:

- `pbakaus/impeccable` consolidated many individual skills into one `impeccable` skill;
- `vercel-labs/next-skills` currently has no `SKILL.md` files on its default branch;
- `runwayml/skills` replaced the old `api` skill with multiple `rw-*` and `use-runway-api` skills;
- Supabase moved `postgres-best-practices`, which the updater can now resolve by unique folder basename.

## Updater improvement

`skill-update-checker` now:

1. tries the lock's exact upstream folder;
2. if missing, searches for a unique `SKILL.md` parent whose basename matches the old folder or skill name;
3. uses the resolved folder for comparison;
4. updates `skillPath` alongside `skillFolderHash` after a later approved safe apply.

A targeted scan confirmed that `supabase-postgres-best-practices` is now found. It also exposed a major upstream directory migration with clean additions and deletion approvals, so it remains review-only.

## Decision

Do not bulk-apply this scan.

Handle upstream reorganizations as migrations, not ordinary updates:

- decide whether the replacement capability is actually wanted;
- install/evaluate the replacement skill separately;
- preserve local lessons intentionally;
- retire old lock entries only after replacement validation;
- rerun the report-first scan.
