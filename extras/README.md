# Extras

These extensions are included in the repository for reference, but are **not** part of the default Pi package manifest.

## Why they are excluded

### `dcg-guard`
Useful and installed locally, but it changes command-execution policy:
- sends Pi `bash`, direct command tools, and static Code Mode command calls through DCG
- fails closed when a nested command is dynamic or DCG cannot decide
- stays opt-in until the Code Mode scanner has longer real-session evidence

### `skill-observer`
Useful, but still coupled to a more local / transitional setup:
- analytics-only by default now
- legacy Cognee scripts still live beside it
- better shipped as a separate package after cleanup

### `retired/skill-router`
Superseded by `skill-gateway`. Its offline eval fixtures and historical routing decisions remain archived for comparison.

### `skill-update-checker`
Safe external skill updater:
- report-first scans for `skills` CLI installs under `~/.agents/skills`
- compares recorded upstream base, local live files, and latest upstream
- preserves local edits and writes conflict artifacts instead of overwriting
- shows unresolved scans as a compact status item; full details remain behind `/skill-updates-status` instead of entering every session context
- not enabled by default because it is still an operator tool for sensitive skill updates

### `local-skill-snapshots`
Disaster-recovery copies of local skills not recorded in `~/.agents/.skill-lock.json` at inventory time. They are intentionally not auto-loaded by the package manifest.

### `operating-principles`
Small prompt-layer nudge extension for always-on Pi working style and Gustav's core operating principles. Kept as an opt-in extra because it intentionally changes the system prompt.

### `process-fixer`
Runtime guardrails for common `process` tool footguns: invalid log-watch regexes, unsupported output args, manual backgrounding, mutating npm/npx commands, unbounded session-log queries, and child-process failures.

### `retired/skill-bundle-router`
Superseded by `skill-gateway`. Its dry-run implementation remains as migration evidence; do not activate both routers together.

### `skill-gateway`
Unified, model-callable skill search and loading. It preserves Pi's native catalog and slash commands while removing the full visible skill XML block from routed turns, injects only a bounded relevant recommendation, and records prompt/provider-surface counts without prompt text. It replaces active use of `skill-router` and `skill-bundle-router`.

### `subagent-model-defaults`
Single routing-policy shim for Finder and Librarian. Finder uses GPT-5.6 Luna medium with Terra medium failover; Librarian reverses that order for deeper source work. Disable the extension to supply routing elsewhere. Kept opt-in because model routing is operator policy, not package baseline behavior.

### `tool-profiles`
Cache-aware tool router for Pi 0.80.7+. Sessions start with a nine-tool lean surface including `tool_lookup`; the model can add relevant registered tools at a native deferred-loading boundary without rewriting the cached prompt prefix. Explicit `+profile` and `/tools <profile>` replacements remain available. Kept opt-in because it changes the available tool surface during a session.

### `codex-mode-toggle`
Operator switch between the normal routed Pi tool fabric and `pi-codex-conversion` Code Mode. `/codex-mode` offers clean-session profile choices; `/codex-mode code|native|toggle` is the direct path, and adding `here` reloads in place. It changes only the conversion package's Code Mode, apply-patch-only, Responses Lite, and fast-owner fields, preserves unrelated settings atomically, and logs mode switches for later evaluation. Kept opt-in because Code Mode intentionally hides Pi extension tools from Codex.

### `worker-prompt-compiler`
Experimental compiler for long worker prompts launched through `process`. It rewrites selected worker prompts into more model-specific artifacts and records harness telemetry.

### `zz-harness-telemetry`
Lifecycle telemetry extension for sessions, turns, selected models, tool calls/results, and assistant-message diagnostics. The `zz-` prefix makes it load late and observe the final runtime shape.

### `zz-tool-output-budget`
Context-budget guardrail that archives oversized text tool results and feeds the model compact head/tail/diagnostic excerpts. The `zz-` prefix makes it load late enough to see final tool results.

### `retired/pi-magic-docs`
Sunset Magic Docs extension. Archived for reference only; no longer default because telemetry showed tracked reads but essentially no successful maintenance edits.

### `retired/pi-session-notebook`
Old automatic per-session notebook. Archived for reference only; no longer default because it overlaps with Pi's native session persistence and `pi-memory-system` while adding prompt weight every turn.
