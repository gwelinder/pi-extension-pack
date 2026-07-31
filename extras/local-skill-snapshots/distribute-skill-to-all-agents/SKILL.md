---
name: distribute-skill-to-all-agents
description: Distribute or audit a skill across Gustav's local agent harnesses (Codex/OpenAI Agents, Claude Code, Pi, Hermes, OpenClaw). Use when the user says distribute this skill, sync skills across agents, audit agent skill folders, or clean up cross-harness skill drift. Covers this machine's real non-symlink layout and warns against blindly copying harness-specific skills everywhere.
---

# Distribute a Skill Across Gustav's Agent Harnesses

Use this only after deciding a skill should be global. Many skills are harness-specific and should stay local.

## Actual local topology

On this machine these are real directories, not symlinks:

| Harness | Global skill folder | Role |
|---|---|---|
| Codex / OpenAI Agents | `~/.agents/skills/` | Canonical source for generally portable skills and skills installed by the `skills` CLI. |
| Claude Code | `~/.claude/skills/` | Independent Claude skill folder; may contain Claude/plugin-specific skills. |
| Pi | `~/.pi/agent/skills/` plus `~/.agents/skills/` | Pi loads both. Prefer not duplicating a portable skill into Pi if `~/.agents/skills` is enough; use Pi-local only for Pi-specific skills/router skills. |
| Hermes | `~/.hermes/skills/` | Independent folder with Hermes-specific categories and snapshots. Copy only intentionally portable skills. |
| OpenClaw | `~/.agents/skills/` plus `~/.openclaw/skills/` and workspace skills | Portable canonical skills are already discovered from `.agents`; keep OpenClaw-native skills in OpenClaw roots. |

Older advice that `~/.claude/skills` or `~/.pi/agent/skills` are symlinks to `~/.agents/skills` is wrong for this machine. Always verify with `test -L <dir>` before relying on symlink behavior.

## Distribution workflow

1. Author or update the canonical portable copy in `~/.agents/skills/<skill-name>/SKILL.md`.
2. Validate the frontmatter: `name` must be lowercase/hyphenated, `description` should be specific and under 1024 chars.
3. Decide target harnesses explicitly:
   - portable coding/research/design workflow: canonical `.agents`, plus explicit Claude/Hermes copies when their loaders need them; OpenClaw already discovers `.agents`.
   - Pi-specific routing/tool policy: usually `~/.pi/agent/skills/` or this Pi package repo, not every harness.
   - Hermes/OpenClaw app-control skills: keep in their native folder unless deliberately generalized.
4. Sync with deletion only for the one named skill folder, never an entire skills root:

```bash
SKILL=<skill-name>
for dst in ~/.claude/skills ~/.hermes/skills; do
  mkdir -p "$dst/$SKILL"
  rsync -a --delete ~/.agents/skills/$SKILL/ "$dst/$SKILL/"
done
```

Pi normally sees the `.agents` copy. If Pi needs a different Pi-specific version, place that in `~/.pi/agent/skills/<skill-name>/` deliberately and document why.

## Verification

```bash
SKILL=<skill-name>
for p in ~/.agents/skills ~/.claude/skills ~/.pi/agent/skills ~/.hermes/skills ~/.openclaw/skills; do
  if [ -f "$p/$SKILL/SKILL.md" ]; then
    printf "%s: " "$p/$SKILL"
    shasum -a 256 "$p/$SKILL/SKILL.md"
  else
    echo "$p/$SKILL: missing"
  fi
done
```

Expect matching hashes only for harnesses that intentionally share the same copy. Pi may show `missing` under `~/.pi/agent/skills` while still loading the `.agents` copy.

## Removal workflow

Deletion is destructive. First audit usage/duplicates, then remove the named folder from selected harnesses only:

```bash
SKILL=<skill-name>
rm -rf ~/.agents/skills/$SKILL ~/.claude/skills/$SKILL ~/.hermes/skills/$SKILL
# Remove ~/.openclaw/skills/$SKILL only if it is a redundant managed copy, not an OpenClaw-native variant.
# Only remove ~/.pi/agent/skills/$SKILL if it is a deliberate Pi-local copy.
```

## Quality rule for updates

Do not append every anecdote. Convert repeated, validated failures into short decision rules, routing criteria, or checklists. Remove obsolete text while adding new guidance. Prefer small, tested skills with references/scripts over huge always-visible instructions.
