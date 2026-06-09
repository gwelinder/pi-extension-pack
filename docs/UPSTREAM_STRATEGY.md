# Skill upstream strategy

Most local skills under `~/.agents/skills` are not owned by this repo. They were installed from upstream GitHub repos and recorded in `~/.agents/.skill-lock.json`.

## Decision

Use a **hybrid source model**:

1. **Owned skills live in this package**
   - `skills/frontend-stack`
   - `skills/codex-ui-design`

2. **Third-party skills stay external and updateable**
   - Install them as Pi packages from GitHub sources using package filters.
   - Prefer a fork per upstream source repo when you care about durability or local patches.
   - Do not vendor every third-party skill into this repo unless upstream disappears or you intentionally take ownership.

3. **Fork per upstream repo, not per skill, by default**
   - Pi package identity is the package source/repo.
   - If one source repo contains many skills, install that repo once with a filtered `skills` list.
   - Forking every single skill into a separate repo is possible, but creates a lot of maintenance overhead.

## Is skill-by-skill forking possible?

Yes. A single-skill repo only needs a `package.json` with a `pi.skills` manifest or a conventional `skills/<name>/SKILL.md` structure:

```json
{
  "name": "my-skill-fork",
  "keywords": ["pi-package"],
  "pi": { "skills": ["./skills"] }
}
```

Then install it:

```bash
pi install git:github.com/gwelinder/my-skill-fork
```

Use this only when:

- you substantially edit one skill and do not want to carry the whole upstream repo;
- the upstream repo is noisy/broken as a Pi package;
- you want independent version tags for that one skill.

For normal upstream flow, prefer **fork per source repo + Pi filters**.

## Recommended fork model

For each upstream source you rely on heavily:

```bash
gh repo fork Leonxlnx/taste-skill --clone=false --remote=false
```

Then in settings/examples, use your fork as the source:

```json
{
  "source": "git:github.com/gwelinder/taste-skill",
  "extensions": [],
  "skills": ["brandkit", "imagegen-frontend-web", "image-to-code", "redesign-existing-projects"],
  "prompts": [],
  "themes": []
}
```

Keep the fork synced:

```bash
gh repo sync gwelinder/taste-skill --source Leonxlnx/taste-skill --branch main
```

Or clone the fork locally and add upstream:

```bash
git clone git@github.com:gwelinder/taste-skill.git
cd taste-skill
git remote add upstream https://github.com/Leonxlnx/taste-skill.git
git fetch upstream
git merge upstream/main
git push
```

## Pi package filters

Pi package filters can select skill folders by name because skill matching considers the `SKILL.md` parent directory.

Example:

```json
{
  "source": "git:github.com/Leonxlnx/taste-skill",
  "extensions": [],
  "skills": ["brandkit", "design-taste-frontend"],
  "prompts": [],
  "themes": []
}
```

If a filter fails because an upstream repo uses unusual layout, use the relative skill path instead, for example:

```json
"skills": ["skills/brandkit", "skills/imagegen-frontend-web"]
```

## Update policy

- Unpinned git sources update with `pi update --extensions`.
- `git:github.com/user/repo@v1.2.3` is pinned and skipped by updates.
- Keep day-to-day packages unpinned for upstream flow.
- Tag this repo (`v0.x.y`) for disaster recovery snapshots.

## Safe updates for locally modified third-party skills

Detailed design: [`SAFE_SKILL_UPDATES.md`](SAFE_SKILL_UPDATES.md).

Do **not** use `npx skills update` as the trusted update path for skills that may contain local edits.
The current `skills` CLI update flow detects upstream tree-hash changes, then reinstalls by calling `skills add -y`.
Its installer removes and recreates the target skill directory before copying the upstream version, so uncommitted local edits and local-only helper files can be overwritten.

Preferred model for skills we customize:

1. Keep a real git fork/clone for the upstream skill source.
2. Commit our customizations in that fork instead of editing only the live `~/.agents/skills/<name>` copy.
3. Pull/merge upstream into the fork using normal git conflict handling.
4. Let Pi load the fork with package filters, or sync reviewed fork contents into the live skill directory.

For skills that are still installed via `npx skills` and live only under `~/.agents/skills`, build a safe updater before doing bulk updates:

- read `~/.agents/.skill-lock.json` for `sourceUrl`, `ref`, `skillPath`, and recorded upstream `skillFolderHash`;
- fetch both the recorded base tree and the latest upstream tree for each skill;
- compare `base -> local -> upstream` file-by-file;
- auto-apply only clean cases where local equals base or local-only files are untouched;
- write conflict artifacts for files changed both locally and upstream instead of overwriting;
- update the lock only after the live directory has been safely merged and verified.

The first implementation should be report-first: no mutation unless the user explicitly approves a specific skill update plan.

## Ownership rules

Vendor a third-party skill into this repo only when one of these is true:

- you rewrote it enough that it is now yours;
- upstream is gone or unstable;
- it is required for core recovery and small enough to own;
- you need to patch it faster than upstream accepts PRs.

Otherwise, keep it external and tracked in `docs/bootstrap-settings.full-skills.example.json`.
