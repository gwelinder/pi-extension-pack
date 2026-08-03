# Trusted engineering skills

## decision

Expose a small reviewed engineering set from immutable source snapshots. Use one canonical skill path under `~/.agents/skills`, per-skill links for Claude and Hermes, and native `.agents` discovery for Pi, Codex, and OpenClaw.

Do not install Matt Pocock's full bundle, run its development linker, or let Repository Updater move active skill pins.

## active set

| Skill | Owner | Role |
| --- | --- | --- |
| `grilling` | Matt Pocock, pinned unchanged | One-question-at-a-time decision interview; facts are investigated. |
| `codebase-design` | Matt Pocock, pinned unchanged | Deep modules, interfaces, seams, adapters, leverage, and locality. |
| `domain-modeling` | This repository, adapted from Matt | Beads-native vocabulary, identity, context, glossary, and ADR discipline. |
| `grill-with-docs` | This repository, adapted from Matt | Evidence-grounded interview without mandatory Markdown output. |
| `beads-wayfinder` | This repository, adapted from Matt | Multi-session decision maps in Beads with native dependencies and atomic claims. |
| `distribute-skill-to-all-agents` | This repository | Per-skill distribution, pin review, backups, and cross-harness verification. |

The Matt source is pinned to commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c`. `config/trusted-skill-sources.json` records every exposed folder and expected SHA-256. A full upstream checkout may exist in the vendor root, but only allowlisted directories are linked into the active catalog.

## source and distribution owners

- `config/trusted-skill-sources.json`: source URLs, immutable revisions, dependency closure, expected hashes, and direct-discovery shadow roots.
- `scripts/manage-trusted-skills.mjs`: immutable materialization, policy audit, canonical activation, shadow cleanup, and active-state verification.
- `config/skill-distribution.json`: target harnesses and copy-versus-symlink strategy.
- `scripts/sync-agent-skills.mjs`: target synchronization with timestamped backups before replacement.

Vendor snapshots live under `~/.agents/vendor/trusted-skills/`. Active canonical links live under `~/.agents/skills/`. Replaced paths are moved under `~/.agents/skill-backups/`.

## initial setup and recovery

Run from the repository root:

```bash
node scripts/manage-trusted-skills.mjs materialize
node scripts/manage-trusted-skills.mjs audit
node scripts/manage-trusted-skills.mjs plan
node scripts/manage-trusted-skills.mjs apply
node scripts/manage-trusted-skills.mjs verify
```

`materialize` writes only inactive immutable snapshots. `plan` is read-only. `apply` backs up each conflicting named path before activation and changes no unlisted skill. `verify` checks source hashes, frontmatter names, canonical links, configured harness links, and the absence of managed shadow copies.

Restart or reload already-running harness sessions after activation so their discovered skill catalog is rebuilt.

The matching `pnpm run trusted-skills:*` scripts are available for normal repository use. The direct Node commands are useful in a clean worktree without installing dependencies.

If activation must be reversed, use the `actions.json` file in the reported trusted-skill backup directory as the exact path ledger. Remove only the corresponding new named links and move those backups back. Distribution replacements have a separate timestamped ledger under `~/.agents/skill-backups/distribution/`. Inspect both ledgers before restoring anything.

## update gate

An upstream update changes executable agent policy. Treat it like code:

1. Create a candidate branch and fetch upstream without moving the active revision.
2. Diff the current and candidate commits, including referenced scripts and dependency skills.
3. Select the smallest allowlist and adapt conflicts in repo-owned skills rather than patching the upstream checkout.
4. Recompute directory hashes and use a new immutable local revision.
5. Run `materialize`, then `audit`.
6. Run the skill validators and the relevant routing, execution, adversarial, and weak-model evaluations.
7. Pilot on one bounded, reversible task.
8. Run `plan`, inspect every replacement, then `apply` and `verify`.
9. Keep the prior snapshot and backups until the new set has survived real use.

Never point an active canonical link at an upstream branch name. Never reuse a local immutable revision after changing its content.

## intentionally excluded

- Matt's `setup-matt-pocock-skills`: tracker and instruction-owner assumptions conflict with this environment.
- `implement` and `tdd`: prescriptive TDD and commit behavior conflict with repository-level authority.
- exact `to-spec`, `research`, `triage`, and `handoff`: they create Markdown artifacts already owned by Beads, Agent Mail, or a durable source document.
- exact `wayfinder` and `to-tickets`: their useful reasoning is carried by `beads-wayfinder`; tracker abstraction and local Markdown fallback are removed.
- `diagnosing-bugs`: the exact upstream browser and TDD advice conflicts with local browser policy and overlaps the existing debugging workflow.
- Matt's development linker and full plugin: both exceed the reviewed allowlist.

These exclusions remain installed nowhere through this trusted set. Existing unrelated legacy skills are not deleted merely because they came from the same upstream repository.

## textbook pilot

Use `ai-vascular-textbook` Bead `avt-zq62` as the first behavioral pilot. The pilot is read-only until the user explicitly asks to create a map.

Success requires:

- distinguishing the live 20-chapter book, the 72-chapter Stage 2 snapshot, and the 207-chapter source taxonomy;
- proposing stable book and chapter identity rather than a bare ordinal;
- asking no factual question the repository can answer;
- creating no planning Markdown, publication action, product-data mutation, or implementation change;
- showing a small decision frontier, real blockers, fog, scope boundaries, and stopping evidence;
- making the proposed graph resumable through `bd show` and `bd ready`.

### 2026-08-03 read-only result

The dry run correctly stopped before creating a map. `avt-zq62` predates M170, while current code already distinguishes `stage2_rutherford_72` from `production_legacy_20` and defaults maintenance to Stage 2. The remaining question is narrower: whether `{book_target, chapter_number}` is a sufficiently durable identity or should migrate to a stable chapter key.

The source-grounded preview lives at `extras/trusted-engineering-skills/skills/beads-wayfinder/evals/fixtures/ai-vascular-textbook-avt-zq62-preview.json`. It contains the proposed first frontier and records zero Beads, Markdown, textbook, data, deployment, or publication writes.

The proposed map epic and first decision ticket were also passed through `bd create --dry-run` against `bd 1.1.2`. Both shapes validated, and `.beads` remained unchanged before and after the probe.
