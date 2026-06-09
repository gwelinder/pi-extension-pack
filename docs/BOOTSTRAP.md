# Bootstrap a new Pi machine

This is the recovery path if the current MacBook disappears.

## 1. Install Pi

Install Pi normally, then log in to any providers you use. Do not copy `auth.json` from another machine.

```bash
pi --version
codex login status || codex login
```

## 2. Install core packages

Recommended global package sources live in `docs/bootstrap-settings.minimal.example.json`.

The essential owned package is:

```bash
pi install git:github.com/gwelinder/pi-extension-pack
```

If Cloudflare Codemode has been pushed as its own repo, install it separately:

```bash
pi install git:github.com/gwelinder/pi-cloudflare-codemode
```

If it is not pushed yet, install from a local checkout after cloning it.

## 3. Restore external skills

For full skill restoration, copy the `packages` entries from:

```text
docs/bootstrap-settings.full-skills.example.json
```

into `~/.pi/agent/settings.json`, or install the important sources manually with `pi install`.

Prefer using forks under `gwelinder/*` for important upstreams, then keep those forks synced. See `docs/UPSTREAM_STRATEGY.md`.

## 4. Restore secret-bearing config manually

Do **not** commit raw config with tokens.

Cloudflare Codemode example:

```bash
mkdir -p ~/.pi/agent/extensions
cp docs/cloudflare-codemode.example.json ~/.pi/agent/extensions/cloudflare-codemode.json
$EDITOR ~/.pi/agent/extensions/cloudflare-codemode.json
export CF_CODEMODE_TOKEN="..."
```

## 5. Verify

```bash
pi list
pi update --extensions
```

Inside Pi:

```text
/reload
/memory-status
/codex-gallery-clear
```

For Codex UI design:

```bash
bash ~/.pi/agent/git/github.com/gwelinder/pi-extension-pack/skills/codex-ui-design/scripts/probe.sh --out /tmp/codex-ui-probe
```

Path may differ if installed from npm/local path; use `pi list` to inspect package location.

## 6. Maintenance cadence

When local owned resources change:

```bash
cd /path/to/pi-extension-pack
npm run sync:owned
npm run audit > docs/INVENTORY.md
npm run check:secrets
git status
```

Then commit and push.
