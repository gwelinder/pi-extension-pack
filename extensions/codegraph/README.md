# codegraph

Pi-native wrapper around [`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph).

It registers a `codegraph` tool for indexed code exploration:

- `context` — focused architecture/task context
- `search` — symbol search
- `files` — indexed file tree
- `callers` / `callees` — call graph lookup
- `impact` — blast-radius analysis
- `affected` — likely affected tests from changed files
- `node` — exact symbol details and optional source
- `explore` — source for several related symbols/files grouped by file
- `trace` — call path between two symbols through the MCP server
- `status`, `sync`, `init`, `index` — index maintenance

The extension resolves the CLI in this order:

1. `PI_CODEGRAPH_BIN`
2. the package dependency `@colbymchenry/codegraph`
3. nearest ancestor `node_modules/.bin/codegraph`
4. `codegraph` on `PATH`

Each tool result and failure reports the chosen executable and its source. This
lets a linked worktree use this package's own dependency without relying on a
globally installed `codegraph` command.

## one canonical CodeGraph extension

Pi deduplicates the same package identity when it appears in both global and
project settings. The project package entry wins, so it is safe to use the same
`git:github.com/gwelinder/pi-extension-pack` source globally and in a project
when both select `extensions/codegraph/**`. Pi loads one copy of this extension.

Do not copy this extension into `.pi/extensions/codegraph` while it is also
selected from this package. Those are different extension paths. Pi reports the
duplicate `codegraph` tool and uses the first loaded registration, which is a
diagnostic rather than a supported installation strategy.

For a new repo, ask Pi to initialize CodeGraph or run:

```bash
codegraph init -i
```

Large outputs are truncated in chat and archived under `~/.pi/agent/artifacts/codegraph/`.
