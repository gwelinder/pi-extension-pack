# codegraph

Pi-native wrapper around [`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph).

It registers a `codegraph` tool for indexed code exploration:

- `context` — focused architecture/task context
- `search` — symbol search
- `files` — indexed file tree
- `callers` / `callees` — call graph lookup
- `impact` — blast-radius analysis
- `affected` — likely affected tests from changed files
- `status`, `sync`, `init`, `index` — index maintenance

The extension resolves the CLI in this order:

1. `PI_CODEGRAPH_BIN`
2. the package dependency `@colbymchenry/codegraph`
3. nearest ancestor `node_modules/.bin/codegraph`
4. `codegraph` on `PATH`

For a new repo, ask Pi to initialize CodeGraph or run:

```bash
codegraph init -i
```

Large outputs are truncated in chat and archived under `~/.pi/agent/artifacts/codegraph/`.
