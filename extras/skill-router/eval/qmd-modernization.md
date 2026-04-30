# QMD modernization — independent track

## Result

The local QMD skill and runtime install were modernized to the current package flow.

## What changed

### Skill doc

Updated `~/.agents/skills/qmd/SKILL.md` to:

- point to **`@tobilu/qmd`** instead of the old GitHub-only install flow
- document modern install commands:
  - `npm install -g @tobilu/qmd`
  - `bun install -g @tobilu/qmd`
- document current command surface
- add MCP guidance for:
  - stdio MCP
  - HTTP MCP (`qmd mcp --http`)
  - daemon mode (`qmd mcp --http --daemon`, `qmd mcp stop`)
- keep the skill hidden by default with `disable-model-invocation: true`

### Local runtime install

Verified the local binary path and upgraded the actual installed package.

Before upgrade:

- `which qmd` → `/Users/gfw/.bun/bin/qmd`
- symlink target pointed at old package name: `.../node_modules/qmd/...`
- installed package metadata showed:
  - name: `qmd`
  - version: `1.0.0`

After upgrade:

- ran:

```bash
bun install -g @tobilu/qmd
```

- `which qmd` still resolves to:
  - `/Users/gfw/.bun/bin/qmd`
- symlink target now points at:
  - `../install/global/node_modules/@tobilu/qmd/bin/qmd`
- installed package metadata now shows:
  - name: `@tobilu/qmd`
  - version: `2.1.0`

## Verification

Confirmed:

```bash
which qmd
qmd status
npm view @tobilu/qmd version
```

Observed:

- binary path updated to the new package
- `qmd status` works
- npm latest is `2.1.0`
- local installed package is also `2.1.0`

## Notes

- The old `qmd@1.0.0` package is still present under Bun's global node_modules, but the active `qmd` binary now points to `@tobilu/qmd`.
- QMD modernization is complete, but **Phase 2 did not require QMD** to hit the router eval target.
