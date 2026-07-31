# Pi release review

Pi and extension updates are not routine dependency bumps. Each release can change cache behavior, tool protocols, model capabilities, or extension APIs, so review release notes before mutating the installation.

## Upgrade loop

1. Record `pi --version`, installed package versions, and relevant extension config.
2. Read the Pi release notes and linked extension/provider documentation.
3. Read release notes for every reported package update.
4. Search owned extensions and `models.json` for breaking API/config names.
5. Map new capabilities to current harness bottlenecks before updating.
6. Update Pi and relevant packages separately.
7. Run a real request through each changed path and inspect tool results, cache reads, and status indicators.
8. Record the decision and remove superseded local workarounds.

## 0.80.7 review, 2026-07-14

### Relevant changes

- Native cache-friendly dynamic tool loading for Anthropic 4.5+ and OpenAI GPT-5.4+.
- Explicit `toolChoice` support for OpenAI and Codex Responses.
- Default system prompt no longer includes the current date, preventing daily prefix invalidation.
- `Ctrl+X` copies transcript/tree messages.
- Fable 5 supports native `xhigh` and `max` thinking.
- `compat.sendSessionIdHeader` was replaced by `compat.sessionAffinityFormat`.

### Compatibility audit

- No owned `models.json` or extension uses `sendSessionIdHeader`.
- No owned shortcut conflicts with `Ctrl+X`.
- Main-session prompt extensions add stable text; observed timestamps are used in logs/artifacts rather than the system prompt.
- The safe-skill-updater warnings shown at startup are unrelated: three upstream skill paths moved and the Supabase skill underwent a directory restructure. There is no clean update to apply from that run.

### Harness changes

- Upgraded Pi from 0.80.6 to 0.80.7.
- Upgraded `@howaboua/pi-codex-conversion` from 2.2.1 through 2.2.8. Version 2.2.2 specifically preserves Codex caches for Pi 0.80.7 dynamic tool activation and forwards explicit tool choice. Later patches fix Pi startup, respect Pi skill exclusions in Code Mode, and scope cached-WebSocket shutdown to one session so sibling in-process agents keep their connections. The remaining Code Mode proxy/guidance changes are inert under the current extra-tools-only configuration.
- Added the new native `max` thinking level to the custom `fal/anthropic/claude-fable-5` registration and verified the model registry exposes it.
- Replaced per-prompt tool-profile switching with a stable lean surface plus `tool_lookup`. The loader activates tools additively during its tool result, which lets GPT-5.6 use Pi's native deferred definitions instead of rewriting the cached prefix.
- Kept explicit profile replacement commands for manual escape hatches, with the documented cache cost.

### Live validation

A fresh GPT-5.6 Luna session started with the lean tool set, called `tool_lookup` for Cloudflare D1, and loaded `cf_codemode_schema` plus `cf_execute`. Pi recorded both names in `ToolResultMessage.addedToolNames`. The following request read 6,656 cached tokens while adding only 936 uncached input tokens, confirming that the custom Codex provider and Pi 0.80.7 deferred-tool path work together. The top-level provider surface stayed at nine tools; the two definitions were anchored at the tool result. Adding the loader itself increased the lean schema from 9,322 to 9,769 characters (+447, 4.8%).

### Package cleanup

`pi-edit-session-in-place` registered `/edit-turn` and `Ctrl+Shift+E` to rewind to an earlier user or assistant message and branch from edited text. Session-log inspection found zero explicit `/edit-turn` invocations. Its implementation depends on a guarded private writable `SessionManager` path and a custom editor wrapper, while Pi's native `/tree`, `/fork`, and message copy cover the underlying recovery workflow. Version 0.1.25 only refreshed its Pi 0.80.7 test baseline, so the unused package was removed instead of updated.

`pi-anycopy` also had zero explicit `/anycopy` invocations. Pi 0.80.7 now copies the selected `/tree` message with `Ctrl+X`, covering its main single-message use case. Anycopy still offers multi-select, previews, and persisted folds, but those unused extras did not justify a second tree implementation, so it was removed.

`pi-token-burden` measured `ctx.getSystemPrompt()` before `skill-gateway`'s `before_agent_start` rewrite. It therefore labeled 55 native catalog entries as 8,066 active skill tokens even though routed mode removed the generated skill block before the provider request. Historical interactive telemetry shows 31,995 characters removed, about 8,000 estimated o200k tokens. The misleading package was removed, `quietStartup` now hides the visual resource inventory, and `/prompt-surface` reports the gateway route plus the actual post-routing provider surface after a request.

The safe-skill updater also injected its multi-line unresolved-report reminder as a custom message on every startup, which entered session context. It now exposes only a compact `skill-updates:<count>!` status; `/skill-updates-status` remains the explicit detail surface.

A final-system-prompt capture found the memory layer consuming 14,863 of 21,048 characters. It injected the full user index plus five selected memories, and the fallback selector gave every recent memory a freshness score even with zero lexical relevance. A generic `Reply exactly OK` prompt therefore received unrelated betting and design memories. Memory routing now requires exact token matches, applies freshness only after relevance, selects at most two memories, caps each excerpt at 1,200 characters, and keeps MEMORY.md indexes out of model context. The generic final system prompt fell from 21,048 to 7,125 characters. Current routed telemetry estimates about 1,780 system tokens plus 2,079 tool-schema tokens, roughly 3,859 stable tokens total.

The `pi-interactive-shell` conflict came from a stale user-skill symlink to a second global copy of the same package. The symlink was removed, leaving the Pi-managed package skill as the single source. The extension remains installed because it provides a real PTY overlay, user takeover, attachable scrollback, and event-driven completion/monitoring that plain tmux does not expose to Pi. Telemetry showed two actual tool calls. Generic orchestration now loads only the Pi-native `process` tool; `interactive_shell` is lazy-loaded only for explicit interactive PTY needs, preserving tmux as the default durable worker substrate.

### Fast-mode correction

`pi-codex-conversion` was configured in extra-tools-only mode (`apply_patch` only). In that mode its status intentionally renders only `Codex adapter • extra tools: apply_patch`, and its adapter request rewrite does not own fast mode. A true `openai.fast` value was therefore misleading and did not produce a visible fast indicator.

Fast tier now has one owner:

- installed `@calesennett/pi-codex-fast`;
- persisted `pi-codex-fast.enabled: true`;
- set `pi-codex-conversion.openai.fast: false`;
- use `/codex-fast` to toggle or `pi --fast` for startup;
- hide the conversion package's static extra-tools-only footer text, leaving the standalone `fast` indicator and dynamic tool/skill state visible.

A controlled extension-order probe observed `service_tier: "priority"` with the same session-based `prompt_cache_key`. Restart or `/reload` is required before the standalone `fast` status appears in an already-running TUI.

## 0.80.10 review, 2026-07-17

### Recommendation

Upgrade Pi from 0.80.7 to 0.80.10 and `@howaboua/pi-codex-conversion` from 2.2.8 to 2.2.11 in the same maintenance pass, with Pi updated first and the conversion package immediately afterward. Pi 0.80.8 changes the internal model/auth runtime, while conversion 2.2.10 is the corresponding compatibility release. The update is worth taking because 0.80.9–0.80.10 add native Kimi K3 catalogs, adaptive thinking, empty-signature replay, and deferred tool loading—the exact path now used by the Kimi subscription.

### Relevant Pi changes

- 0.80.8 introduces the async `ModelRuntime`, provider-owned authentication/catalog refresh, `models-store.json`, background `/model` refresh, and `pi update --models`.
- SDK callers must replace `authStorage`/`modelRegistry` session options and direct `ModelRegistry` auth assembly with `ModelRuntime`. The synchronous extension-facing `ctx.modelRegistry` compatibility facade remains available; `refresh()` is now async.
- 0.80.9 adds built-in `kimi-coding/k3` and native Kimi deferred-tool serialization.
- 0.80.10 fixes Kimi adaptive effort, exposes only K3's supported `max` effort, and permits empty-signature thinking replay for K3 and K2.7 Code.
- The remaining 0.80.9 catalog changes concern xAI and do not affect the active harness.

### Owned-extension compatibility

- `extras/worker-prompt-compiler` uses `ctx.modelRegistry.find()` and already awaits `getApiKeyAndHeaders()`. Both remain on the extension compatibility facade; it never calls `refresh()`, so no code change is required.
- `extras/tool-profiles` activates tools additively with `setActiveTools()`, matching Pi's Kimi deferred-tool protocol. No adapter-specific branch is needed.
- `extras/skill-gateway`, harness telemetry, and the Pi memory system use event surfaces unchanged by 0.80.8–0.80.10.
- Custom Fable and OpenAI Codex entries in `models.json` remain immutable inputs to the composed model runtime.
- The temporary custom `kimi-code` provider should be removed after upgrading. Store the Keychain command as the built-in `kimi-coding` credential and update enabled model IDs to `kimi-coding/*`; otherwise both custom and built-in Kimi catalogs appear and the custom route misses native Kimi deferred serialization.

### Conversion-package impact

- 2.2.9 removes redundant Code Mode labels; inert in the current extra-tools-only setup.
- 2.2.10 adapts Codex device login and review-session proxy handling to Pi 0.80.8's model runtime; this is the compatibility reason to update.
- 2.2.11 restores Code Mode parsing for configured Responses proxies, sanitizes resumed Code Mode history, and writes settings atomically with mode 0600. Code Mode remains disabled here, so these behavior changes are inert except for safer settings persistence.
- `pi-codex-fast` remains the sole fast-tier owner. Keep conversion `openai.fast: false`, `applyPatchOnly: true`, and cached WebSockets enabled.

### Pre-upgrade validation

- Pi 0.80.10 started successfully against the current extension set and completed a live GPT-5.6 Luna request.
- Built-in `kimi-coding/k3` read the live catalog as 1,048,576 context tokens, accepted `max` adaptive thinking, called the existing `tool_lookup`, activated a lazy tool, and completed the following turn.
- Conversion 2.2.11 loaded under Pi 0.80.10 in isolation and its bundled `apply_patch` created the requested smoke-test file through a live Codex request.

### Applied and validated

- Upgraded Pi to 0.80.10 and `@howaboua/pi-codex-conversion` to 2.2.11.
- Migrated the Keychain-backed credential to built-in `kimi-coding`, removed the temporary `kimi-code` provider, and updated the three enabled Kimi model IDs. The live catalog now exposes K3 at 1,048,576 context tokens and 131,072 output tokens with image support.
- K3 completed native `max` thinking, deferred `tool_lookup`, and a real image-input check.
- Codex completed deferred activation and `apply_patch` across a cached-WebSocket continuation. Cache reads rose from zero on the initial request to 3,584 and then 4,608 tokens on the continuations.
- An ordered request probe confirmed `pi-codex-fast` still adds `service_tier: "priority"` while preserving the session `prompt_cache_key`.
- Skill-gateway tests remain top-1 92.5% and top-3 100%; all 11 Pi memory tests pass; live pnpm/uv recall passes. The routed provider surface remains ten tools, about 2,130 system tokens plus 2,263 tool-schema tokens.
- `pi update --models` could not complete a global refresh because Anthropic authentication required an interactive refresh. This does not block Kimi/Codex or the shipped 0.80.10 catalog.

### Code Mode evaluation

Code Mode is a schema-free Codex execution protocol: the provider emits JavaScript for a local V8 host, and that code composes nested shell, patch, image, and web operations. An isolated Pi 0.80.10/2.2.11 profile successfully read files, patched a new file, ran a verification command, and completed a second shell task. Its provider requests carried no top-level tool schemas, versus ten tools and about 2,263 schema tokens in the normal routed profile.

The original 0.80.10 recommendation was not to enable Code Mode globally because its nested-tool contract covers the conversion package's shell/patch/image/web surface rather than Pi extension tools such as `memory`, `finder`, `ask_user_question`, `skill_lookup`, `tool_lookup`, or Cloudflare Code Mode. Code Mode has since been deliberately enabled for the Codex profile; native mode remains the escape hatch when those extension tools are required.

Code Mode remains promising as an isolated mechanical-work profile for shell-heavy Codex tasks. Promote it only after an eval shows that its zero-schema savings and tool composition outweigh the lost extension interoperability, or after the required extension tools have clean nested adapters.

An opt-in `codex-mode-toggle` extension exposes `/codex-mode`. The default selector switches profiles in a fresh session so cache and protocol history do not contaminate comparisons; `code`, `native`, and `toggle` are direct arguments, while `here` explicitly reloads the current session. Code Mode is currently selected. Mode changes are atomic, preserve unrelated conversion settings, keep `pi-codex-fast` as the sole fast owner, and write bounded evaluation telemetry. A tmux integration test switched native → Code Mode → native, completed a real Code Mode shell task, and verified clean-session switching.

### 2.2.16 update

The earlier 2.2.11 hold was lifted on 2026-07-22 after deliberately accepting the GPT-5.6 context clamp from 1.05M to 272K. Upgraded `@howaboua/pi-codex-conversion` to 2.2.16 alongside Pi 0.81.1. The intervening releases improve Responses compaction, Code Mode continuation and command-tool recovery, model-facing prompt/tool metadata, and sessionless Codex WebSocket request IDs.

The configured package pin is now 2.2.16, Code Mode remains enabled, and `pi --list-models gpt-5.6-sol` reports 272K context with 128K maximum output. Package installation completed with no reported vulnerabilities. A fresh Pi session is required before treating the updated runtime as live-validated.

## 0.83.0 review, 2026-07-31

### Applied

- Upgraded Pi from 0.82.1 to 0.83.0.
- Upgraded `pi-interactive-shell` to 0.14.0, `pi-design-deck` to 0.4.0, `@plannotator/pi-extension` to 0.25.1, `@aliou/pi-processes` to 0.9.5, and `@juicesharp/rpiv-ask-user-question` to 2.2.0.
- Moved the pinned `@howaboua/pi-codex-conversion` package from 2.2.28 to 3.0.5. Existing settings remain valid; Code Mode remains enabled and GPT-5.6 Sol remains at the accepted 272K context window.
- Updated the compatible `minimatch` transitive dependency used by `pi-prompt-template-model`, moving off vulnerable `brace-expansion` 5.0.7. The user package tree now audits with zero known vulnerabilities.

### Compatibility

- Pi 0.83 removes deprecated TypeBox APIs. No owned or configured extension uses `Type.Base`, `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`, `Type.Options`, or `Value.Mutate`.
- Pi 0.83 also moved legacy global `complete()` off the root `@earendil-works/pi-ai` export. `worker-prompt-compiler` now uses the selected provider's current `streamSimple(...).result()` API with resolved model-registry authentication instead of the temporary compatibility entrypoint.
- Codex conversion 3 makes the native structured adapter canonical and removes legacy PATH mode. The local `/codex-mode` toggle still targets supported `beta.codeMode` and `tools.applyPatchOnly` settings; its unit tests pass.
- `pi-processes` no longer stores raw stdout/stderr arrays in tool-result details. The worker prompt compiler, process fixer, and telemetry consume bounded text content and metadata, so no compatibility change is needed.

### Owned-extension follow-up

1. Replaced repeated literal unions in `memory` and `codegraph` with Pi's Google-compatible `StringEnum`. Provider strict sampling remains off: these tools intentionally have optional action-specific fields, while supported OpenAI strict mode requires every property to be required. Enabling `strict: "prefer"` would therefore turn a supported-provider request into a schema error rather than a fallback.
2. `worker-prompt-compiler` now respects `ctx.scopedModels`. It uses the configured compiler when allowed, otherwise explicitly selects the active scoped model; model, reasoning, selection source, and parent-session correlation are included in cache keys, manifests, and telemetry.
3. `skill-observer` now preserves package source, source origin, and base directory on loaded-skill records and emits a source-counted `skill_catalog_refreshed` event after startup or reload.
4. Harness telemetry now records redacted `user_bash` events from TUI and RPC modes, including command hash/length/first word without raw command text.
5. Harness and worker-compiler telemetry now carry the same session/model/reasoning identifiers exposed to bash as `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`, allowing local log correlation without prompt injection.
6. `pi auth print-api-key` and `print-bearer-token` remain explicit external-client escape hatches rather than automatic fallbacks; printing credentials expands the secret-handling surface.

### Validation

- Local package inventory and secret scan pass.
- Skill-gateway core tests pass; routing remains 90% top-1 and 100% top-3 over the expanded 152-skill catalog.
- All 11 memory tests and all three Codex-mode toggle tests pass.
- A strict TypeScript check against Pi 0.83's installed declarations passes for the changed memory, CodeGraph, worker compiler, skill observer, and harness telemetry extensions.
- `pi --list-models gpt-5.6-sol` reports the expected 272K Codex context and 128K maximum output.
- Fresh Pi startups load the updated live extension copies. A real `!` shell probe produced a redacted `user_bash` telemetry record with matching Pi session environment identifiers, and `skill-observer` emitted package/top-level source counts for 168 loaded skills.
- Paid provider turns, Plannotator plan execution, process-output stress, and questionnaire interaction remain outside this local validation pass.
