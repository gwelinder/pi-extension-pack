# Safe external skill updates

Design for replacing `extras/skill-update-checker` with a Pi-native updater that can accept upstream skill changes without overwriting Gustav's local customizations.

## Problem

Many external skills were installed with the `skills` CLI into `~/.agents/skills`, with metadata in `~/.agents/.skill-lock.json`. Some of those skills are useful as upstream-maintained assets, but we also customize them locally.

The current upstream update path is unsafe for this workflow:

- `npx skills update` detects upstream changes from lock metadata, then reinstalls by invoking `skills add -y`.
- The installer removes and recreates the target skill directory before copying upstream files.
- There is no local-modification check, three-way merge, conflict surface, or backup-first apply plan.
- `skills check` in current releases routes into the same update implementation, so it must not be treated as a safe dry run.

The old `extras/skill-update-checker` only checked watched git checkouts and emitted reminders. It did not understand `~/.agents/.skill-lock.json`, local edits, or safe apply semantics.

## Goals

1. Detect upstream updates for skills installed through the `skills` CLI and recorded in lock files.
2. Detect local edits in live skill directories.
3. Produce a report-first update plan before mutating anything.
4. Apply only safe changes automatically:
   - upstream-only edits where local still equals the recorded upstream base;
   - upstream new files;
   - clean text three-way merges when explicitly allowed.
5. Preserve local-only files by default.
6. Never overwrite local changes silently.
7. Keep enough artifacts to review, rerun, or roll back.
8. Update lock metadata only after the live directory has been safely merged.

## Non-goals

- Do not become a general package manager for all Pi packages. Pi packages should still use `pi update`.
- Do not blindly call `npx skills update` or `npx skills add -y` as part of apply.
- Do not auto-resolve real conflicts with LLM edits in the first version.
- Do not require every third-party skill to be vendored into `pi-extension-pack`.

## Product shape

Replace `skill-update-checker` with a new extension implementation, probably still in `extras/skill-update-checker` initially but conceptually named **safe skill updater**.

Keep the existing command names as aliases so old muscle memory works:

- `/skill-updates-status`
- `/skill-updates-check`

Add explicit report/apply commands:

- `/skill-updates-scan [filters]`
- `/skill-updates-plan [filters]` — alias for scan, creates a run artifact
- `/skill-updates-diff [run] [skill] [file]`
- `/skill-updates-apply <run|latest> [skill...] [--clean-only|--include-mergeable]`
- `/skill-updates-restore <run> [skill...]`
- `/skill-updates-adopt <skill>` for missing/legacy baselines

Default behavior on `session_start` should be status-only and cheap:

- if no recent scan exists, do nothing unless enabled by config;
- if a previous scan found conflicts/pending updates, remind with a compact message;
- never fetch or mutate large remote state on every Pi startup unless opted in.

## Discovery

The updater should discover skill installs from these sources.

### Global `skills` CLI installs

- lock file: `~/.agents/.skill-lock.json`
- live root: `~/.agents/skills/<skill-name>`
- typical Pi symlink: `~/.pi/agent/skills/<skill-name> -> ~/.agents/skills/<skill-name>`

Useful lock fields:

```json
{
  "source": "vercel-labs/agent-skills",
  "sourceType": "github",
  "sourceUrl": "https://github.com/vercel-labs/agent-skills.git",
  "ref": "optional-branch-or-tag",
  "skillPath": "skills/web-design-guidelines/SKILL.md",
  "skillFolderHash": "github-tree-sha-for-the-skill-folder"
}
```

`skillPath` points to `SKILL.md`; the skill folder is `dirname(skillPath)`.

### Project `skills` CLI installs

- lock file: `<cwd>/skills-lock.json`
- live root: `<cwd>/.agents/skills/<skill-name>`

Some project lock entries only have `computedHash` and no remote tree metadata. Those are not safely updatable until adoption.

### Explicit config

Optional config can add or override entries:

- global: `~/.pi/agent/safe-skill-updates.json`
- project: `<cwd>/.pi/safe-skill-updates.json`

Example:

```json
{
  "scanOnStartup": false,
  "include": ["vercel-*", "next-*", "frontend-design"],
  "exclude": ["experimental-*"],
  "sources": [
    {
      "name": "taste-skill",
      "sourceUrl": "https://github.com/Leonxlnx/taste-skill.git",
      "forkUrl": "git@github.com:gwelinder/taste-skill.git",
      "localClone": "~/code/skills/taste-skill",
      "preferForkWorkflow": true
    }
  ]
}
```

## State and artifacts

Use a dedicated root:

`~/.pi/agent/safe-skill-updates/`

Suggested layout:

```text
safe-skill-updates/
  state.json
  baselines/
    global/<skill>.json
    project/<project-hash>/<skill>.json
  runs/
    2026-05-31T140000Z-abc123/
      plan.json
      report.md
      backups/
        agents-lock.before.json
        <skill>/...
      snapshots/
        <skill>/base/...
        <skill>/local/...
        <skill>/upstream/...
        <skill>/merged/...
      patches/
        <skill>/base-to-local.patch
        <skill>/base-to-upstream.patch
        <skill>/local-to-proposed.patch
      conflicts/
        <skill>/<path>.diff3.md
```

`state.json` tracks last scan/apply summaries only. Runs contain durable evidence.

Baseline sidecar example:

```json
{
  "version": 1,
  "scope": "global",
  "skillName": "web-design-guidelines",
  "liveDir": "~/.agents/skills/web-design-guidelines",
  "lockPath": "~/.agents/.skill-lock.json",
  "sourceUrl": "https://github.com/vercel-labs/agent-skills.git",
  "ref": "main",
  "skillFolderPath": "skills/web-design-guidelines",
  "upstreamBaseTreeSha": "3116f3e62dbd02b44a598b1aa690d2a8938e8f89",
  "localPostApplyHash": "sha256-of-live-dir-after-last-safe-apply",
  "updatedAt": "2026-05-31T14:00:00Z"
}
```

The lock's `skillFolderHash` remains the current accepted upstream base. Local customizations are represented by the live directory plus our sidecar hashes, not by lying in the upstream lock field.

## Snapshot model

Every scan builds three snapshots per skill:

1. **base** — upstream skill folder at the recorded lock `skillFolderHash`.
2. **local** — current live directory on disk.
3. **upstream** — latest upstream skill folder at the configured ref/default branch.

Snapshots are path-keyed maps:

```ts
type SnapshotFile = {
  path: string;
  kind: "text" | "binary";
  sha256: string;
  size: number;
  mode?: string;
  content?: string; // text only, capped in plan.json; full content in artifacts
};
```

Ignore ephemeral files for comparison:

- `.DS_Store`
- `metadata.json` from the `skills` CLI
- `.git/`
- `__pycache__/`
- `__pypackages__/`

Do not ignore arbitrary local files. Local-only helper files are part of the safety contract.

## Fetchers

### GitHub fetcher

For `sourceType: "github"` and GitHub URLs:

- parse owner/repo from `source` or `sourceUrl`;
- use `GITHUB_TOKEN` or `GH_TOKEN` when present;
- fetch base tree by `skillFolderHash`:
  - `GET /repos/{owner}/{repo}/git/trees/{treeSha}?recursive=1`
- fetch latest tree:
  - resolve ref/default branch to a commit;
  - fetch repo tree recursively;
  - find `dirname(skillPath)`;
  - fetch that folder's tree recursively.
- fetch blob contents by blob SHA for changed or report-needed files.

This avoids cloning large repos for common public GitHub skill packs.

### Git clone fetcher

For non-GitHub sources or when GitHub metadata is incomplete:

- shallow clone latest ref to temp;
- read the skill folder from disk;
- base snapshot is available only if we have a prior sidecar baseline snapshot.

If no base snapshot exists, mark the skill as `needs_adoption` instead of pretending it is safe.

## File classification

For every path in `base ∪ local ∪ upstream`, classify by content hash.

| Case | Condition | Default action |
| --- | --- | --- |
| unchanged | `base == local == upstream` | no-op |
| upstream-only edit | `local == base`, `upstream != base` | apply upstream |
| upstream new file | absent in base/local, present upstream | add |
| local-only file | absent in base/upstream, present local | preserve |
| local-only edit | `local != base`, `upstream == base` | preserve |
| both changed same | `local == upstream`, both differ from base | accept, update lock |
| clean text merge | local and upstream both changed, git diff3 merges cleanly | apply only with `--include-mergeable` or interactive approval |
| conflict | local and upstream both changed, no clean merge | stop; write conflict artifact |
| upstream delete, local unchanged | present base/local, absent upstream | report; apply only when delete is approved |
| upstream delete, local edited | present base/local, absent upstream, `local != base` | conflict; preserve local |
| local delete, upstream unchanged | present base/upstream, absent local | preserve local deletion unless user chooses restore |
| local delete, upstream edited | present base/upstream, absent local, `upstream != base` | conflict |
| binary both changed | binary changed locally and upstream | conflict |

## Merge engine

For text files, use `git merge-file` semantics rather than an LLM:

```bash
git merge-file -p local base upstream
```

- exit `0`: clean merge candidate;
- nonzero with conflict markers: conflict artifact;
- binary files: no auto-merge.

Generated artifacts per changed skill:

- `base-to-local.patch` — Gustav/custom delta;
- `base-to-upstream.patch` — incoming upstream delta;
- `local-to-proposed.patch` — what apply would change;
- conflict files with base/local/upstream sections.

LLM assistance can be a later optional command that explains conflicts, but not part of unattended apply.

## Apply protocol

Apply must be two-phase and abortable.

1. Load `plan.json`.
2. Re-snapshot local live directories.
3. Abort if any local hash differs from the plan's local snapshot.
4. Acquire a lock file under `~/.pi/agent/safe-skill-updates/update.lock`.
5. Copy full live skill directories and lock files into `runs/<id>/backups/`.
6. Apply selected operations to a temp merged directory.
7. Validate merged directory:
   - `SKILL.md` exists;
   - frontmatter parses enough to find `name`/`description` if present;
   - no conflict markers remain in text files;
   - live Pi symlink target still resolves.
8. Write changed files into the live skill directory.
9. Preserve local-only files unless explicitly removed by the user.
10. Update lock entry `skillFolderHash` to latest upstream tree SHA.
11. Write/update sidecar baseline.
12. Emit a Pi message with summary and rollback command.

Default apply mode:

- `--clean-only`: upstream-only edits and upstream new files only.

Optional apply mode:

- `--include-mergeable`: also apply clean text merges.

No mode should apply conflict files.

## Rollback

Every apply run writes backups first. Rollback restores:

- live skill directory;
- global/project lock file;
- sidecar baseline for the affected skill.

Command:

```text
/skill-updates-restore <run-id> [skill...]
```

Rollback should also re-check symlinks from `~/.pi/agent/skills` to `~/.agents/skills` and report broken links.

## User-facing reports

`/skill-updates-scan` should send a compact Pi message:

```text
Safe skill update scan: 17 skills checked

Clean updates: 8
Clean merges available: 3
Local-only edits preserved: 12 files across 5 skills
Conflicts: 2 skills / 4 files
Needs adoption: 6 legacy/local skills

Run: ~/.pi/agent/safe-skill-updates/runs/2026-05-31T140000Z-abc123/report.md

Next:
- /skill-updates-diff latest vercel-react-best-practices
- /skill-updates-apply latest --clean-only
- /skill-updates-apply latest vercel-react-best-practices --include-mergeable
```

`report.md` should group by source and skill:

- current installed version/base tree;
- latest upstream tree;
- local modifications count;
- planned actions;
- conflicts with file paths;
- exact commands to apply or restore.

## Fork-backed workflow

For skills we actively customize, the long-term best path is fork-backed rather than live-directory customization.

Recommended flow:

1. Fork the upstream repo under `gwelinder`.
2. Commit Gustav-specific skill changes to that fork.
3. Add `upstream` remote.
4. Merge upstream normally with git.
5. Install/load the fork via Pi package filters or sync reviewed skill folders into `~/.agents/skills`.

The safe updater should still support these skills, but the highest-safety merge engine is git itself in a real fork.

Future command:

```text
/skill-updates-fork-plan [source]
```

It can list heavily customized sources and suggest `gh repo fork` / settings filter changes.

## Edge cases

### Missing base tree

If `skillFolderHash` is absent or cannot be fetched:

- do not update;
- mark as `needs_adoption`;
- offer `/skill-updates-adopt <skill>`.

Adoption records the current upstream as base and current local delta as Gustav's custom layer.

### User already ran unsafe update

If live local hash changed while no plan was active:

- compare live directory against latest upstream;
- if equal, mark local custom layer as lost/empty and update sidecar;
- if not equal, require adoption or manual review.

### Upstream deleted a skill

Never delete automatically on scan or clean apply. Report as `upstream_deleted` and require explicit remove/archive action.

### Large repos / rate limits

- cache GitHub trees/blobs by SHA under `~/.pi/agent/safe-skill-updates/cache/`;
- use `GITHUB_TOKEN`/`GH_TOKEN` if available;
- group skills by source so one repo tree fetch can serve multiple skills.

## Implementation phases

### Phase 1 — report-only scanner

- Discover global `~/.agents/.skill-lock.json` entries.
- GitHub fetcher for base/latest snapshots.
- Local snapshotter.
- Classification table.
- Run artifacts and `/skill-updates-scan`/`/skill-updates-status`.
- No writes to live skill dirs.

### Phase 2 — safe clean apply

- Backup-first apply.
- `--clean-only` operations.
- Lock file update after successful apply.
- Restore command.

### Phase 3 — clean three-way merges

- `git merge-file` for text files.
- `--include-mergeable` mode.
- Conflict artifacts and `/skill-updates-diff`.

### Phase 4 — adoption and fork workflow

- Handle missing base metadata.
- Project lock support.
- Fork-plan recommendations.
- Optional local clone/fork sync helpers.

## Safety invariants

These should be tested and never violated:

1. Scan is read-only.
2. Apply aborts if live files changed after scan.
3. Apply creates a full backup before writing.
4. Local-only files survive clean apply.
5. Local-edited files are never overwritten by upstream-edited files without a clean merge and explicit merge mode.
6. Conflict markers are never written into live skills.
7. Lock metadata changes only after live files have been updated successfully.
8. Rollback restores both files and lock state.

