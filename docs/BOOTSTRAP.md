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

## 4. Restore optional agent infrastructure

Install the narrow supporting CLIs:

```bash
brew install bash
brew install dicklesworthstone/tap/ru
brew install dicklesworthstone/tap/mcp-agent-mail
brew install dicklesworthstone/tap/ubs
brew install dicklesworthstone/tap/cass
```

Install the latest DCG release from its official release assets, verify its published checksum, then copy the local policy:

```bash
mkdir -p ~/.config/dcg
cp docs/dcg-config.example.toml ~/.config/dcg/config.toml
dcg doctor
```

The DCG Pi adapter is deliberately opt-in. From a local checkout of this repository:

```bash
mkdir -p ~/.pi/agent/extensions/dcg-guard
cp extras/dcg-guard/index.ts extras/dcg-guard/core.ts extras/dcg-guard/README.md ~/.pi/agent/extensions/dcg-guard/
```

Initialize Repository Updater, then set `PROJECTS_DIR` to the local checkout parent, keep `UPDATE_STRATEGY=ff-only`, `AUTOSTASH=false`, and start with `PARALLEL=1`. Add repositories explicitly with `ru add`; always run a dry run before a real pull.

Do not initialize CASS until its data directory has enough free space for the full session archive and index.

## 5. Restore secret-bearing config manually

Do **not** commit raw config with tokens.

Cloudflare Codemode example:

```bash
mkdir -p ~/.pi/agent/extensions
cp docs/cloudflare-codemode.example.json ~/.pi/agent/extensions/cloudflare-codemode.json
$EDITOR ~/.pi/agent/extensions/cloudflare-codemode.json
export CF_CODEMODE_TOKEN="..."
```

## 6. Verify

```bash
pi list
pi update --extensions
```

Inside Pi:

```text
/reload
/memory-status
/codex-gallery-clear
/dcg-status
```

For Codex UI design:

```bash
bash ~/.pi/agent/git/github.com/gwelinder/pi-extension-pack/skills/codex-ui-design/scripts/probe.sh --out /tmp/codex-ui-probe
```

Path may differ if installed from npm/local path; use `pi list` to inspect package location.

## 7. Maintenance cadence

When local owned resources change:

```bash
cd /path/to/pi-extension-pack
pnpm run sync:owned
pnpm run audit > docs/INVENTORY.md
pnpm run check:secrets
git status
```

Then commit and push.
