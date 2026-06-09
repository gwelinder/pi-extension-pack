# skill-update-checker / safe skill updater

Report-first safe updater for external skills installed by the `skills` CLI.

This replaces the old watched-git-source reminder flow. It is intentionally conservative: scans are read-only, applies require an explicit mode, and local edits are never overwritten silently.

## Why this exists

Many useful third-party skills live under `~/.agents/skills` and are tracked in `~/.agents/.skill-lock.json`. Gustav sometimes customizes those skills locally, but still wants upstream improvements.

The upstream `npx skills update` flow is unsafe for that because it reinstalls skill directories. This extension reads the lock metadata directly and performs a safer three-way analysis:

- **base** — recorded upstream tree from the lock file
- **local** — current live skill directory
- **upstream** — latest upstream tree

## What it does

- discovers global `skills` CLI installs from `~/.agents/.skill-lock.json`
- optionally discovers project installs from `<cwd>/skills-lock.json`
- fetches GitHub trees/blobs using `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`
- compares `base -> local -> upstream` file-by-file
- writes run artifacts under `~/.pi/agent/safe-skill-updates/runs/<run-id>/`
- preserves local-only files
- preserves local-only edits
- stops on real conflicts and writes conflict artifacts
- can apply clean upstream-only updates with backups
- can restore from apply backups

## Commands

### `/skill-updates-status`
Show the last scan/apply summary and report path.

### `/skill-updates-scan [skill...] [--scope=global|project|both] [--limit=N]`
Create a read-only update plan. Alias: `/skill-updates-plan`.

### `/skill-updates-check [skill...]`
Safe alias for scan. It does **not** call `npx skills check` or `npx skills update`.

### `/skill-updates-diff latest <skill> [file]`
Show planned file actions for a skill in a run.

### `/skill-updates-apply latest [skill...] --clean-only`
Apply only clean upstream-only edits/additions and lock-only updates. Creates backups first and aborts if local files changed since the scan.

### `/skill-updates-apply latest [skill...] --include-mergeable`
Also apply clean text merges produced by `git merge-file`. Conflicts are still never applied.

### `/skill-updates-restore <run> [skill...]`
Restore live skill directories and lock files from an apply backup.

### `/skill-updates-adopt <skill>`
Currently explanatory only. Future work: create a safe baseline for skills missing enough lock metadata.

## Artifact root

```text
~/.pi/agent/safe-skill-updates/
  state.json
  baselines/
  runs/<run-id>/
    plan.json
    report.md
    backups/
    conflicts/
    apply.json
```

## Safety invariants

1. Scan is read-only.
2. Apply refuses to run without `--clean-only` or `--include-mergeable`.
3. Apply aborts a skill if local files changed after scan.
4. Apply creates backups before writing.
5. Local-only files survive clean apply.
6. Local-edited files are not overwritten by upstream-edited files.
7. Conflict markers are never written into live skills.
8. Lock metadata updates only after a successful safe apply.

See `../../docs/SAFE_SKILL_UPDATES.md` for the full design.
