---
name: distribute-skill-to-all-agents
description: Distribute, replace, retire, or audit a skill across Gustav's Codex, Claude, Pi, Hermes, and OpenClaw harnesses. Use whenever the user asks to install skills everywhere, sync agent skills, use ~/.agents as the canonical source, create cross-harness symlinks, audit skill drift, or safely update an external skill. Prefer reviewed per-skill links and timestamped backups; never link or replace an entire harness skill root.
---

# Distribute a skill across harnesses

Make one reviewed skill directory canonical, then expose that exact directory only to the harnesses that should use it.

## topology

| Harness | Discovery | Portable-skill policy |
| --- | --- | --- |
| Codex / OpenAI Agents | `~/.agents/skills` | Canonical portable source; no second Codex copy. |
| Pi | `~/.agents/skills` and `~/.pi/agent/skills` | Use canonical `.agents`; reserve Pi-local for Pi-specific skills. |
| Claude Code | `~/.claude/skills` | Per-skill symlink to canonical when portable. |
| Hermes | `~/.hermes/skills` | Per-skill symlink to canonical when intentionally compatible. |
| OpenClaw | `~/.agents/skills` plus native roots | Use canonical `.agents`; reserve OpenClaw roots for native adapters. |

These roots are real directories. Never replace a whole root with a symlink. A harness can contain native skills alongside portable links.

## classify before distributing

1. **Portable**: shared reasoning or production workflow with compatible commands.
2. **Portable coding**: shared only across coding harnesses.
3. **Harness-native**: depends on one harness's tools, hooks, commands, or prompt contract.
4. **Project-local**: encodes one repository's domain or operational boundaries.

Keep harness-native and project-local skills where they belong. Broad distribution is not a quality signal.

## choose the canonical source

- Repo-owned skills should come from a reviewed, versioned repository source.
- Third-party skills used as executable policy should come from an immutable reviewed commit, with an allowlist and expected directory hash.
- Local adaptations should be separate repo-owned skills. Do not edit an upstream checkout in place.
- Link the entire skill directory so references, scripts, assets, and executable modes remain intact.

For the managed trusted set, first resolve a `pi-extension-pack` checkout that contains `config/trusted-skill-sources.json`. Run these commands from that checkout's root:

```bash
node scripts/manage-trusted-skills.mjs materialize
node scripts/manage-trusted-skills.mjs audit
node scripts/manage-trusted-skills.mjs plan
node scripts/manage-trusted-skills.mjs apply
node scripts/manage-trusted-skills.mjs verify
```

`config/trusted-skill-sources.json` owns source pins and hashes. `config/skill-distribution.json` owns harness targets and link strategy.

## safe replacement

Before changing one named target:

1. Resolve its exact path with `lstat`, `readlink`, and `realpath` as appropriate.
2. Confirm the intended canonical source contains a valid `SKILL.md` and all dependencies.
3. Show a report-only plan.
4. Move an existing conflicting path into a timestamped backup.
5. Create one per-skill symlink.
6. Verify the link target, skill hash, frontmatter name, and harness discovery.

Never delete or overwrite a directory merely because its name matches. It may be a harness-specific variant.

## external update gate

An upstream update is a policy change. Do not auto-pull it into active skills.

1. Fetch the candidate without moving the active pin.
2. Diff the reviewed and candidate commits.
3. Recompute dependency closure and scan scripts/instructions for new side effects.
4. Run routing, execution, adversarial, and weak-model evaluations appropriate to the change.
5. Pilot it on one bounded real task.
6. Update the immutable revision and hashes only after review.
7. Apply explicitly and retain the prior snapshot for rollback.

Repository Updater must not own trusted skill pins or use autostash around them.

## verification report

Report:

- canonical source and immutable revision;
- harnesses linked and intentionally omitted;
- backups created;
- hashes and validators run;
- shadow copies removed or deliberately retained;
- anything requiring a harness restart or reload.
