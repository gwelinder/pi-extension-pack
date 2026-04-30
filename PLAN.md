# Pi Extension Pack Recovery Plan

## Goal

Make `pi-extension-pack` the canonical, git-backed bootstrap package for Gustav's owned Pi resources while keeping third-party skills updateable through upstream/forked package sources.

## Done in this pass

- [x] Read Pi package docs and current package manifest rules.
- [x] Added `codex-ui-gallery` to default extensions.
- [x] Added owned skills to default skills:
  - `frontend-stack`
  - `codex-ui-design`
- [x] Updated `package.json` to declare extensions, skills, prompts, and themes.
- [x] Added recovery/maintenance scripts:
  - `npm run audit`
  - `npm run check:secrets`
  - `npm run sync:owned`
- [x] Added docs:
  - `docs/BOOTSTRAP.md`
  - `docs/INVENTORY.md`
  - `docs/SECRETS.md`
  - `docs/UPSTREAM_STRATEGY.md`
  - settings/config examples
- [x] Added `.gitignore` guards for Pi state, generated outputs, and secret-bearing config names.

## Remaining decisions

- [ ] Push or create `gwelinder/pi-cloudflare-codemode` if Cloudflare Codemode should be recoverable from GitHub as a separate package.
- [ ] Decide which upstream skill sources should be forked under `gwelinder/*` first.
- [ ] Swap direct upstream URLs in `docs/bootstrap-settings.full-skills.example.json` to fork URLs as forks are created.
- [ ] Optionally split mature extras into separate packages later.

## Recommended fork priority

1. `Leonxlnx/taste-skill` — directly supports current frontend/image-first workflow.
2. `jakubkrehel/make-interfaces-feel-better` and `emilkowalski/skill` — high-value UI taste skills.
3. `vercel-labs/agent-skills`, `vercel-labs/next-skills`, `openai/skills`, `anthropics/skills` — core coding/frontend docs.
4. Marketing/CRO bundles only if still actively used.

## Validation before push

```bash
npm run audit > docs/INVENTORY.md
npm run check:secrets
node --check scripts/audit-local.mjs
node --check scripts/check-no-secrets.mjs
node --check scripts/sync-owned-resources.mjs
```

Then inspect:

```bash
git status --short
git diff --stat
```
