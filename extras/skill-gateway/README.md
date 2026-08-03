# skill-gateway

Unified Pi skill search, loading, routing, and prompt-surface measurement.

## Why

Pi can discover a large skill catalog and still preserve `/skill:*` commands, but injecting every visible name and description into every turn is expensive. `skill-gateway` keeps native discovery intact while removing the generated `<available_skills>` block from the model prompt in routed mode.

The model sees only:

- the compact `skill_lookup` tool;
- zero or one bounded routing recommendation relevant to the current task;
- the full selected `SKILL.md` only after an explicit `name` load.

## Tool

Search:

```json
{ "query": "automate a logged-in browser workflow", "limit": 5 }
```

Load:

```json
{ "name": "browser-automation" }
```

A load returns the `SKILL.md`, source path, and base directory for relative references. Oversized skills are returned in bounded chunks (16k characters by default); continue with the reported `offset` rather than flooding one turn.

## Modes

Set `PI_SKILL_GATEWAY_MODE` or `~/.pi/agent/skill-gateway.json`:

- `routed` — strip native skill XML and add bounded recommendations;
- `observe` — keep the native prompt and measure it;
- `off` — keep the native prompt without recommendation changes.

Default: `routed`.

## Telemetry

Writes count-only JSONL records to:

```text
~/.pi/agent/telemetry/skill-gateway/YYYY-MM-DD.jsonl
```

Events include routing decisions, search/load operations, prompt characters removed, and final provider system/tool-schema sizes. Prompt and user text are hashed or omitted.

## Validation

```bash
pnpm run test:skill-gateway
pnpm run audit:harness-skills
```

The gateway can run with Pi native skills or `--no-skills`. Native discovery is preferred because it preserves Pi's deduplication, package/project skills, and slash commands; the gateway has a filesystem fallback for explicit `--no-skills` evaluation lanes.
