# skill-observer (Pi extension)

Analytics-first skill telemetry for Pi, with optional legacy Cognee self-improvement tooling.

The extension’s default role is to observe runs, skill loads, and tool failures into NDJSON so you can understand how Pi is actually behaving. The older Cognee daemon workflow is still available, but it is now treated as an explicit opt-in path rather than the default operating mode.

## How it works

1. **Pi extension** (`index.ts`) hooks into agent lifecycle and logs telemetry to NDJSON
2. **Optional Cognee daemon** can run in the background when explicitly enabled:
   - Observes new runs → `skills.observe()`
   - Checks for skills with accumulated failures
   - Auto-inspects failing skills → `skills.inspect()`
   - Generates amendment proposals → `skills.preview_amendify()`
   - Optionally auto-applies fixes → `skills.amendify()`
   - Periodically upserts skills to detect file changes
3. **Managed skills** are symlinks (zero duplication) pointing at source skill dirs

## Setup (one-time)

```bash
# Install cognee
pip install 'cognee==0.5.4.dev2'

# Symlink managed skills (no file copying)
~/.pi/agent/extensions/skill-observer/sync-managed-skills.sh

# Ingest skills with LLM enrichment (uses GEMINI_API_KEY)
~/.pi/agent/extensions/skill-observer/run-cognee-ingester.sh ingest

# Reload Pi to activate the extension
/reload
```

## Daemon mode is opt-in

By default, the extension stays in analytics / telemetry mode only.
To enable the legacy Cognee daemon path, set `COGNEE_SKILL_OBSERVER_ENABLE_DAEMON=1` before starting Pi. You can still disable auto-start separately with `COGNEE_SKILL_OBSERVER_NO_DAEMON=1`.

Status and analytics in Pi:

```
/skill-observer-status
/skill-analytics
/skill-analytics top=30
/skill-daemon
/skill-daemon log
/skill-daemon stop
/skill-daemon start
```

`/skill-observer-status` reports log size, rotation settings, archive count, daemon health, and whether a stale PID was cleaned during the last check.
`/skill-analytics` reports top skills, broad reusable skills, project-specific candidates, project-local skills, and unused managed skills from the NDJSON telemetry logs.

Or manually:
```bash
# Start daemon (runs forever)
~/.pi/agent/extensions/skill-observer/run-cognee-ingester.sh daemon

# With auto-apply (applies amendments without asking)
~/.pi/agent/extensions/skill-observer/run-cognee-ingester.sh daemon --auto-apply
```

## Full CLI

```bash
# ── Ingestion ──
./run-cognee-ingester.sh ingest              # Full ingest with enrichment
./run-cognee-ingester.sh ingest --reset      # Clean slate
./run-cognee-ingester.sh upsert              # Incremental (skip unchanged)

# ── Autonomous loop ──
./run-cognee-ingester.sh daemon              # Observe + auto-inspect (propose only)
./run-cognee-ingester.sh daemon --auto-apply # Observe + auto-inspect + auto-apply

# ── Manual observation ──
./run-cognee-ingester.sh observe --mode once
./run-cognee-ingester.sh observe --mode follow

# ── Self-improvement ──
./run-cognee-ingester.sh inspect <skill_id>
./run-cognee-ingester.sh preview <skill_id>
./run-cognee-ingester.sh amend <amendment_id>
./run-cognee-ingester.sh auto-amend <skill_id>
./run-cognee-ingester.sh evaluate <amendment_id>
./run-cognee-ingester.sh rollback <amendment_id>

# ── Execution ──
./run-cognee-ingester.sh run "compress this conversation"
./run-cognee-ingester.sh execute kling-v2v "edit this video"
./run-cognee-ingester.sh recommend "search the web for docs"

# ── Management ──
./run-cognee-ingester.sh list
./run-cognee-ingester.sh load <skill_id>
./run-cognee-ingester.sh remove <skill_id>
./run-cognee-ingester.sh report
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `COGNEE_SKILL_OBSERVER_DISABLED` | `false` | Disable the extension entirely |
| `COGNEE_SKILL_OBSERVER_ENABLE_DAEMON` | `false` | Opt into the legacy Cognee daemon mode |
| `COGNEE_SKILL_OBSERVER_NO_DAEMON` | `false` | In daemon mode, don't auto-start the daemon |
| `COGNEE_SKILL_OBSERVER_INCLUDE_TEXT` | `false` | Include task/response text in logs |
| `COGNEE_SKILL_OBSERVER_LOG_PATH` | `~/.pi/agent/skill-observer/observations.ndjson` | NDJSON log path |
| `COGNEE_SKILL_OBSERVER_MAX_LOG_BYTES` | `10485760` | Rotate active NDJSON log when it exceeds this size |
| `COGNEE_SKILL_OBSERVER_MAX_ARCHIVES` | `3` | Number of rotated NDJSON archives to keep |
| `GEMINI_API_KEY` | — | Used for LLM enrichment + inspect/amend |
| `OPENAI_API_KEY` | — | Fallback LLM if no Gemini key |

## The self-improvement loop

```
skill fails → observe records it → daemon detects threshold
  → inspect: LLM diagnoses root cause, severity, hypothesis
  → preview: LLM generates improved instructions
  → amendify: fix applied to graph (original preserved)
  → evaluate: before/after scores compared
  → rollback: one call to revert if fix didn't help
```

## Operational notes

- The active NDJSON log rotates automatically once it exceeds the configured size limit.
- `/skill-analytics` reads the active NDJSON log plus retained archives; increase `COGNEE_SKILL_OBSERVER_MAX_ARCHIVES` if you need longer trend windows.
- Stale daemon PID files are cleaned during health checks so `/skill-daemon` and `/skill-observer-status` reflect reality.
- If you are developing locally and your installed copy under `~/.pi/agent/extensions/skill-observer/` differs from the repo, update the repo first and then sync/reinstall the runtime copy.

## Architecture

```
Pi Extension (index.ts)
  │ hooks: input, tool_call, agent_end, etc.
  │ writes: observations.ndjson
  │ auto-starts: daemon
  │
  ▼
Cognee Daemon (cognee_ingester.py daemon)
  │ reads: observations.ndjson (follow mode)
  │ calls: skills.observe(), skills.inspect(), skills.preview_amendify()
  │ writes: cognee graph (lancedb + networkx)
  │
  ▼
Cognee Graph
  │ Skill nodes (enriched, with task patterns)
  │ SkillRun nodes (observations)
  │ SkillInspection nodes (failure analysis)
  │ SkillAmendment nodes (proposed/applied fixes)
  │ prefers edges (routing weights from experience)
  │
  ▼
Skills folder (symlinks → source dirs)
  ~/.pi/agent/skills-managed/active/
    kling-v2v → ~/.pi/agent/skills/kling-v2v
    ltx-video → ~/.pi/agent/skills/ltx-video/ltx-video
    ...
```
