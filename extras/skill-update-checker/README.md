# skill-update-checker

Generic watched-source update checker for externally maintained Pi skills.

Why this exists:
- some external skill packs update regularly
- Pi can load copied/manual skills that are **not** installed as updatable Pi packages
- in that setup, `pi update` alone is not enough because Pi may have no package source to poll

This extension adds a lightweight daily reminder flow inspired by PSPDFKit's `pi-skills-update-checker`, but makes it configurable for your own watched skill sources.

## What it does

- reads watched sources from config
- checks each watched git source once per day on `session_start`
- compares local `HEAD` to remote `HEAD` / branch head via `git ls-remote`
- stores pending update state in:
  - `~/.pi/agent/extensions/skill-update-checker/state.json`
- re-shows pending reminders until the local source catches up
- exposes commands:
  - `/skill-updates-status`
  - `/skill-updates-check`

## Config

Global config path:
- `~/.pi/agent/skill-update-checker.json`

Optional project config path:
- `<cwd>/.pi/skill-update-checker.json`

Shape:

```json
{
  "watch": [
    {
      "id": "pi-skills",
      "label": "PSPDFKit pi-skills",
      "localPath": "~/.pi/agent/git/github.com/PSPDFKit-labs/pi-skills",
      "remoteUrl": "https://github.com/PSPDFKit-labs/pi-skills.git",
      "branch": "main",
      "applyHint": "Run pi update and then /reload to apply."
    }
  ]
}
```

## Important caveat

This only works when the watched source is a **real local git checkout**.

If your current external skills are copied into:
- `~/.agents/skills/`
- `~/.pi/agent/skills/`

without preserving the source repo as a local git clone somewhere, then there is no local `HEAD` to compare, and you should either:
1. keep a local clone of the upstream skill repo and watch that path, or
2. add another sync process that updates the copied skill directory from the watched clone.

## Commands

### `/skill-updates-status`
Show configured watches and current pending/error/up-to-date state.

### `/skill-updates-check`
Force an immediate remote check, bypassing the once-per-day gate.

## Suggested next refinement

If you want this to become fully automatic for copied skills, add a separate sync/apply command that copies updated skill files from the watched git checkout into the live skill directory after review.
