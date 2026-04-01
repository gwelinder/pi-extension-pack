#!/usr/bin/env python3
"""Pi skill-observer → Cognee skills bridge.

Uses the cognee-skills self-improving loop directly:
  skills.ingest()          — parse SKILL.md, enrich via LLM, store in graph+vector
  skills.upsert()          — incremental re-ingest
  skills.observe()         — record skill run outcomes
  skills.inspect()         — LLM diagnoses why a skill fails
  skills.preview_amendify()— LLM generates improved instructions
  skills.amendify()        — apply a proposed amendment
  skills.evaluate_amendify()— compare pre/post scores
  skills.rollback_amendify()— revert an amendment
  skills.auto_amendify()   — full pipeline in one call
  skills.list()            — list all ingested skills

Commands:
  ingest       Load skills into cognee graph (with LLM enrichment)
  upsert       Incremental re-ingest (skip unchanged)
  observe      Process NDJSON run events → skills.observe()
  inspect      Analyze a failing skill
  preview      Preview a proposed amendment
  amend        Apply an amendment by ID
  auto-amend   Full inspect→preview→apply pipeline
  evaluate     Compare pre/post amendment scores
  rollback     Revert an amendment
  list         List all ingested skills
  report       Local observation statistics
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import os
import signal
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ── Defaults ──────────────────────────────────────────────────────────────

DEFAULT_LOG_PATH = Path.home() / ".pi" / "agent" / "skill-observer" / "observations.ndjson"
DEFAULT_STATE_DB = Path.home() / ".pi" / "agent" / "skill-observer" / "cognee-state.db"
DEFAULT_MANAGED_ROOT = Path.home() / ".pi" / "agent" / "skills-managed" / "active"
DEFAULT_COGNEE_ROOT = Path.home() / ".pi" / "agent" / "skill-observer" / "cognee"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Environment setup ─────────────────────────────────────────────────────

def configure_env(cognee_root: str) -> None:
    """Set cognee env defaults before any cognee import."""
    root = Path(cognee_root).expanduser().resolve()

    # Storage paths
    os.environ.setdefault("DATA_ROOT_DIRECTORY", str(root / ".data_storage"))
    os.environ.setdefault("SYSTEM_ROOT_DIRECTORY", str(root / ".cognee_system"))
    os.environ.setdefault("CACHE_ROOT_DIRECTORY", str(root / ".cognee_cache"))
    os.environ.setdefault("COGNEE_LOGS_DIR", str(root / "logs"))

    # Local embeddings (no external API needed)
    os.environ.setdefault("EMBEDDING_PROVIDER", "fastembed")
    os.environ.setdefault("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
    os.environ.setdefault("EMBEDDING_DIMENSIONS", "384")

    # LLM for enrichment/inspect/amend — use Gemini if available, else OpenAI
    gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")
    openai_key = os.environ.get("OPENAI_API_KEY", "")

    if gemini_key and not os.environ.get("LLM_API_KEY"):
        os.environ.setdefault("LLM_API_KEY", gemini_key)
        os.environ.setdefault("LLM_PROVIDER", "gemini")
        os.environ.setdefault("LLM_MODEL", "gemini/gemini-3-flash-preview")
    elif openai_key and not os.environ.get("LLM_API_KEY"):
        os.environ.setdefault("LLM_API_KEY", openai_key)
        os.environ.setdefault("LLM_PROVIDER", "openai")
        os.environ.setdefault("LLM_MODEL", "openai/gpt-4o-mini")

    # Create dirs
    for key in ["DATA_ROOT_DIRECTORY", "SYSTEM_ROOT_DIRECTORY",
                "CACHE_ROOT_DIRECTORY", "COGNEE_LOGS_DIR"]:
        Path(os.environ[key]).mkdir(parents=True, exist_ok=True)


def apply_import_shims() -> None:
    """Fix known dependency issues before importing cognee."""
    try:
        import mistralai
        if not hasattr(mistralai, "Mistral"):
            from mistralai.client import Mistral as _M
            mistralai.Mistral = _M
    except Exception:
        pass


def load_skills_client():
    """Import and return the cognee Skills singleton."""
    apply_import_shims()
    import cognee  # noqa: F401
    from cognee.cognee_skills.client import skills
    return skills


# ── Local state DB ────────────────────────────────────────────────────────

class StateDB:
    """SQLite for run dedup and local statistics."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self._init()

    def _init(self):
        self.conn.executescript("""
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS observed_runs (
              run_id TEXT PRIMARY KEY,
              session_id TEXT,
              skill_id TEXT,
              success_score REAL,
              duration_ms INTEGER,
              outcome TEXT,
              observed_at TEXT NOT NULL,
              reason TEXT
            );

            CREATE TABLE IF NOT EXISTS file_offsets (
              source TEXT PRIMARY KEY,
              inode INTEGER NOT NULL,
              offset INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
        """)
        # Migrate: add reason column if missing
        try:
            self.conn.execute("SELECT reason FROM observed_runs LIMIT 0")
        except Exception:
            self.conn.execute("ALTER TABLE observed_runs ADD COLUMN reason TEXT")
        self.conn.commit()

    def is_observed(self, run_id: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM observed_runs WHERE run_id=? LIMIT 1", (run_id,)
        ).fetchone() is not None

    def mark_observed(self, run_id: str, session_id: str, skill_id: str,
                      score: float, duration_ms: int, outcome: str,
                      reason: str = ""):
        self.conn.execute(
            """INSERT OR IGNORE INTO observed_runs
               (run_id,session_id,skill_id,success_score,duration_ms,outcome,observed_at,reason)
               VALUES (?,?,?,?,?,?,?,?)""",
            (run_id, session_id, skill_id, score, duration_ms, outcome, utc_now_iso(), reason)
        )
        self.conn.commit()

    def get_offset(self, source: str) -> Optional[Tuple[int, int]]:
        row = self.conn.execute(
            "SELECT inode, offset FROM file_offsets WHERE source=?", (source,)
        ).fetchone()
        return (row["inode"], row["offset"]) if row else None

    def set_offset(self, source: str, inode: int, offset: int):
        self.conn.execute(
            """INSERT INTO file_offsets(source,inode,offset,updated_at)
               VALUES(?,?,?,?)
               ON CONFLICT(source) DO UPDATE SET inode=excluded.inode,
               offset=excluded.offset, updated_at=excluded.updated_at""",
            (source, inode, offset, utc_now_iso())
        )
        self.conn.commit()

    def get_meta(self, key: str) -> Optional[str]:
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str):
        self.conn.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value)
        )
        self.conn.commit()

    def report(self) -> dict:
        total = self.conn.execute(
            "SELECT COUNT(*) c FROM observed_runs WHERE skill_id != '__none__'"
        ).fetchone()["c"]
        errors = self.conn.execute(
            "SELECT COUNT(*) c FROM observed_runs WHERE success_score < 0.5 AND skill_id != '__none__'"
        ).fetchone()["c"]
        skills = self.conn.execute("""
            SELECT skill_id, COUNT(*) runs,
                   SUM(CASE WHEN success_score < 0.5 THEN 1 ELSE 0 END) fails,
                   AVG(success_score) avg_score, AVG(duration_ms) avg_ms
            FROM observed_runs WHERE skill_id != '__none__'
            GROUP BY skill_id ORDER BY avg_score ASC LIMIT 30
        """).fetchall()

        # Include recent failure reasons for struggling skills
        failing_details = {}
        for s in skills:
            if s["avg_score"] < 0.6:
                reasons = self.conn.execute("""
                    SELECT success_score, reason, observed_at
                    FROM observed_runs
                    WHERE skill_id = ? AND reason != '' AND reason IS NOT NULL
                    ORDER BY observed_at DESC LIMIT 5
                """, (s["skill_id"],)).fetchall()
                if reasons:
                    failing_details[s["skill_id"]] = [
                        {"score": r["success_score"], "reason": r["reason"],
                         "at": r["observed_at"][:19]} for r in reasons
                    ]

        return {
            "total_runs": total,
            "error_runs": errors,
            "error_rate": round(errors / total, 3) if total else 0,
            "skills": [dict(s) for s in skills],
            "failing_details": failing_details,
        }

    def close(self):
        self.conn.close()


# ── NDJSON reader ─────────────────────────────────────────────────────────

def read_new_lines(path: Path, last: Optional[Tuple[int, int]]) -> Tuple[List[str], int, int]:
    """Read new lines from an NDJSON file since last offset."""
    if not path.exists():
        return [], 0, 0
    inode = path.stat().st_ino
    start = 0
    if last and last[0] == inode:
        start = last[1]
    lines = []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        f.seek(start)
        for line in f:
            lines.append(line)
        end = f.tell()
    return lines, inode, end


# ── Event → skills.observe() mapping ─────────────────────────────────────

def map_run_event(start_evt: dict, end_evt: dict, include_text: bool) -> Optional[dict]:
    """Map a run_start + run_end NDJSON pair to a skills.observe() payload."""
    run_id = end_evt.get("runId", "")
    if not run_id:
        return None

    # Select skill
    loaded = end_evt.get("loadedSkills") or []
    explicit = start_evt.get("explicitSkillName", "")
    skill_id = explicit or ""
    if not skill_id:
        for s in loaded:
            if s.get("source") == "explicit_command":
                skill_id = s.get("name", "")
                break
    if not skill_id and loaded:
        skill_id = loaded[0].get("name", "")
    if not skill_id:
        skill_id = "__none__"

    # Score
    outcome = str(end_evt.get("executionOutcome", "")).lower()
    errors = int(end_evt.get("toolErrorCount", 0))
    if outcome == "ok":
        score = max(0.0, 1.0 - min(0.5, errors * 0.15))
    elif outcome == "tool_error":
        score = max(0.0, 0.35 - min(0.3, errors * 0.05))
    else:
        score = 0.5

    # Task text
    if include_text:
        task_text = start_evt.get("inputPreview", "") or f"[run {run_id}]"
    else:
        h = start_evt.get("inputHash", "")[:16]
        n = start_evt.get("inputLength", 0)
        task_text = f"[task hash={h} len={n}]" if h else f"[run {run_id}]"

    # Tool errors
    tool_errors = end_evt.get("toolErrors") or []
    error_type = tool_errors[0].get("toolName", "") if tool_errors else ""
    error_msg = tool_errors[0].get("message", "") if tool_errors else ""

    return {
        "run_id": run_id,
        "session_id": end_evt.get("sessionId", "default"),
        "task_text": task_text,
        "selected_skill_id": skill_id,
        "all_skill_ids": [s.get("name", "") for s in loaded if s.get("name")],
        "success_score": score,
        "result_summary": f"outcome={outcome} errors={errors}",
        "error_type": error_type,
        "error_message": error_msg[:500],
        "latency_ms": int(end_evt.get("durationMs", 0)),
        "candidate_skills": [
            {"skill_id": s.get("name", ""), "score": max(0.1, 1.0 - i * 0.1)}
            for i, s in enumerate(loaded)
        ],
        # For transcript evaluation
        "session_file": end_evt.get("sessionFile", ""),
        "started_at": start_evt.get("startedAt", end_evt.get("startedAt", "")),
        "ended_at": end_evt.get("endedAt", ""),
    }


# ── Session transcript evaluator ──────────────────────────────────────────

EVAL_SYSTEM_PROMPT = """\
You are a quality evaluator for an AI coding agent's skill system.

The agent has "skills" — instruction files (SKILL.md) that guide how it approaches tasks.
When the agent loads a skill, it reads the SKILL.md and follows its guidance.

You will receive:
- The user's task
- Which skills were loaded
- A transcript of what the agent did (tool calls, file reads/writes, responses)

Score how well each loaded skill's guidance was applied and whether the overall
outcome is useful. Be critical — the goal is to detect when skills are giving
bad guidance so they can be improved.

IMPORTANT: Score each skill INDEPENDENTLY based only on the parts of the transcript
where that skill's guidance was relevant. Do NOT penalize a skill for failures
caused by other skills or unrelated infrastructure issues. For example:
- If pptx tool errors occur, only penalize the pptx skill, not frontend-design
- If the API backend is slow/overloaded causing stalls, don't penalize any skill
- If browser automation fails, only penalize browser-tools, not the design skill

Respond with ONLY a JSON object:
{
  "overall_score": <float 0.0-1.0>,
  "overall_reason": "<one sentence>",
  "skill_scores": {
    "<skill_id>": {"score": <float 0.0-1.0>, "reason": "<one sentence>"}
  }
}

The skill_scores dict MUST include an entry for every loaded skill.

Scoring guide:
- 1.0: Excellent — skill guidance clearly produced high-quality output
- 0.7-0.9: Good — mostly followed, minor gaps
- 0.4-0.6: Mixed — skill was loaded but guidance wasn't well applied
- 0.1-0.3: Poor — skill guidance led to bad output or was ignored
- 0.0: Failed — skill completely wrong for this task or caused errors"""


def extract_run_transcript(session_file: str, run_start: str, run_end: str,
                           max_chars: int = 80000) -> Optional[str]:
    """Extract the conversation segment for a run from the session JSONL."""
    try:
        session_path = Path(session_file)
        if not session_path.exists():
            return None

        with session_path.open("r", encoding="utf-8", errors="replace") as f:
            entries = [json.loads(line) for line in f if line.strip()]
    except Exception:
        return None

    # Filter to entries within the run window
    run_entries = []
    for e in entries:
        ts = e.get("timestamp", e.get("ts", ""))
        if not ts:
            continue
        if ts >= run_start and ts <= run_end and e.get("type") == "message":
            run_entries.append(e)

    if not run_entries:
        return None

    # Build readable transcript
    parts = []
    total_chars = 0
    for e in run_entries:
        msg = e.get("message", {})
        role = msg.get("role", "?")
        content = msg.get("content", "")

        if isinstance(content, list):
            text_parts = []
            for p in content:
                if isinstance(p, dict):
                    if p.get("type") == "text":
                        text_parts.append(p.get("text", ""))
                    elif p.get("type") == "tool_use":
                        tool = p.get("name", "?")
                        inp = json.dumps(p.get("input", {}))
                        if len(inp) > 500:
                            inp = inp[:500] + "..."
                        text_parts.append(f"[tool_call: {tool}({inp})]")
                elif isinstance(p, str):
                    text_parts.append(p)
            text = "\n".join(text_parts)
        else:
            text = str(content)

        # Truncate very long tool results (file contents, etc.)
        if role == "toolResult" and len(text) > 2000:
            text = text[:1000] + "\n... [truncated] ...\n" + text[-500:]

        if text.strip():
            chunk = f"[{role}] {text}"
            if total_chars + len(chunk) > max_chars:
                parts.append(f"[{role}] ... [truncated, {len(text)} chars]")
                break
            parts.append(chunk)
            total_chars += len(chunk)

    return "\n\n".join(parts) if parts else None


async def evaluate_run_quality(
    task_text: str,
    skill_ids: List[str],
    session_file: str,
    run_start: str,
    run_end: str,
) -> Optional[Dict[str, Any]]:
    """Evaluate run quality using LLM on the session transcript."""
    import litellm
    from cognee.infrastructure.llm import get_llm_config

    transcript = extract_run_transcript(session_file, run_start, run_end)
    if not transcript:
        return None

    llm_config = get_llm_config()

    user_prompt = (
        f"## Task\n{task_text}\n\n"
        f"## Skills loaded\n{', '.join(skill_ids)}\n\n"
        f"## Agent transcript\n{transcript}"
    )

    try:
        response = await litellm.acompletion(
            model=llm_config.llm_model,
            messages=[
                {"role": "system", "content": EVAL_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            api_key=llm_config.llm_api_key,
        )
        raw = response.choices[0].message.content or ""
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        result = json.loads(cleaned)
        return {
            "overall_score": max(0.0, min(1.0, float(result.get("overall_score", 0.5)))),
            "overall_reason": str(result.get("overall_reason", "")),
            "skill_scores": result.get("skill_scores", {}),
        }
    except Exception as e:
        return None


# ── Commands ──────────────────────────────────────────────────────────────

async def cmd_ingest(args):
    """Ingest skills into cognee graph."""
    skills = load_skills_client()
    folder = str(Path(args.managed_root).expanduser().resolve())
    enrich = not args.skip_enrichment
    print(f"Ingesting skills from {folder} (enrich={enrich})")
    await skills.ingest(
        skills_folder=folder,
        dataset_name=args.dataset,
        source_repo="pi-managed-skills",
        skip_enrichment=not enrich,
    )
    print("Ingesting meta-skill (self-improvement loop guide)")
    await skills.ingest_meta_skill()
    print("✓ Ingest complete")


async def cmd_upsert(args):
    """Incremental re-ingest."""
    skills = load_skills_client()
    folder = str(Path(args.managed_root).expanduser().resolve())
    print(f"Upserting skills from {folder}")
    result = await skills.upsert(skills_folder=folder, dataset_name=args.dataset)
    print(f"✓ Upsert: {result}")


async def cmd_observe(args):
    """Process NDJSON events → skills.observe()."""
    log_path = Path(args.log_path).expanduser().resolve()
    state = StateDB(Path(args.state_db).expanduser().resolve())

    # Load cognee only if not dry-run
    sk = None
    if not args.dry_run:
        sk = load_skills_client()

    source_key = str(log_path)
    run_starts: Dict[str, dict] = {}
    stats = {"events": 0, "observed": 0, "skipped": 0, "no_skill": 0, "errors": 0}

    async def process_once():
        last = state.get_offset(source_key)
        lines, inode, offset = read_new_lines(log_path, last)
        if not lines:
            state.set_offset(source_key, inode, offset)
            return

        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError:
                stats["errors"] += 1
                continue
            stats["events"] += 1

            ev_type = evt.get("event", "")
            if ev_type == "run_start":
                rid = evt.get("runId", "")
                if rid:
                    run_starts[rid] = evt
            elif ev_type == "run_abandoned":
                run_starts.pop(evt.get("runId", ""), None)
            elif ev_type == "run_end":
                rid = evt.get("runId", "")
                if not rid or state.is_observed(rid):
                    stats["skipped"] += 1
                    continue

                start_evt = run_starts.pop(rid, {})
                payload = map_run_event(start_evt, evt, args.include_text)
                if not payload:
                    continue

                skill_id = payload["selected_skill_id"]
                if skill_id == "__none__" and args.require_skill:
                    state.mark_observed(rid, payload["session_id"], skill_id,
                                        0.0, payload["latency_ms"], "skipped_no_skill")
                    stats["no_skill"] += 1
                    continue

                if args.dry_run:
                    print(f"  [dry] observe: skill={skill_id} score={payload['success_score']:.2f}")
                else:
                    try:
                        await sk.observe(payload)
                    except Exception as e:
                        print(f"  [warn] observe failed for {rid}: {e}")

                state.mark_observed(
                    rid, payload["session_id"], skill_id,
                    payload["success_score"], payload["latency_ms"],
                    str(evt.get("executionOutcome", ""))
                )
                stats["observed"] += 1

        state.set_offset(source_key, inode, offset)

    try:
        if args.mode == "once":
            await process_once()
        else:
            poll = max(0.25, args.poll_seconds)
            print(f"Following {log_path} (poll={poll}s)")
            while True:
                await process_once()
                await asyncio.sleep(poll)
    finally:
        state.close()

    print(f"✓ Observe: {stats}")


async def cmd_inspect(args):
    """Inspect a failing skill."""
    skills = load_skills_client()
    result = await skills.inspect(
        skill_id=args.skill_id,
        min_runs=args.min_runs,
        score_threshold=args.threshold,
    )
    if result is None:
        print(f"No actionable failures for '{args.skill_id}' (min_runs={args.min_runs}, threshold={args.threshold})")
        return
    print(json.dumps(result, indent=2, default=str))


async def cmd_preview(args):
    """Preview a proposed amendment."""
    skills = load_skills_client()
    result = await skills.preview_amendify(
        skill_id=args.skill_id,
        min_runs=args.min_runs,
        score_threshold=args.threshold,
    )
    if result is None:
        print(f"No amendment needed for '{args.skill_id}'")
        return
    print(json.dumps(result, indent=2, default=str))


async def cmd_amend(args):
    """Apply an amendment."""
    skills = load_skills_client()
    result = await skills.amendify(
        amendment_id=args.amendment_id,
        write_to_disk=args.write_to_disk,
    )
    print(json.dumps(result, indent=2, default=str))


async def cmd_auto_amend(args):
    """Full inspect→preview→apply pipeline."""
    skills = load_skills_client()
    result = await skills.auto_amendify(
        skill_id=args.skill_id,
        min_runs=args.min_runs,
        score_threshold=args.threshold,
        write_to_disk=args.write_to_disk,
    )
    if result is None:
        print(f"No amendment needed for '{args.skill_id}'")
        return
    print(json.dumps(result, indent=2, default=str))


async def cmd_evaluate(args):
    """Evaluate an amendment."""
    skills = load_skills_client()
    result = await skills.evaluate_amendify(amendment_id=args.amendment_id)
    print(json.dumps(result, indent=2, default=str))


async def cmd_rollback(args):
    """Rollback an amendment."""
    skills = load_skills_client()
    result = await skills.rollback_amendify(amendment_id=args.amendment_id)
    print(f"Rollback: {result}")


async def cmd_run(args):
    """Find best skill and execute it."""
    skills = load_skills_client()
    result = await skills.run(
        task_text=args.task_text,
        auto_evaluate=not args.no_evaluate,
        auto_amendify=args.auto_amendify,
        amendify_min_runs=args.min_runs,
    )
    print(json.dumps(result, indent=2, default=str))


async def cmd_execute(args):
    """Execute a specific skill."""
    skills = load_skills_client()
    result = await skills.execute(
        skill_id=args.skill_id,
        task_text=args.task_text,
        auto_observe=True,
        auto_evaluate=not args.no_evaluate,
        auto_amendify=args.auto_amendify,
    )
    print(json.dumps(result, indent=2, default=str))


async def cmd_recommend(args):
    """Get skill recommendations for a task."""
    skills = load_skills_client()
    result = await skills.get_context(task_text=args.task_text, top_k=args.top_k)
    print(json.dumps(result, indent=2, default=str))


async def cmd_load(args):
    """Load full details for a skill."""
    skills = load_skills_client()
    result = await skills.load(skill_id=args.skill_id)
    if result is None:
        print(f"Skill '{args.skill_id}' not found")
        return
    print(json.dumps(result, indent=2, default=str))


async def cmd_remove(args):
    """Remove a skill."""
    skills = load_skills_client()
    result = await skills.remove(skill_id=args.skill_id)
    print(f"Removed: {result}")


async def cmd_list(args):
    """List all ingested skills."""
    skills = load_skills_client()
    result = await skills.list()
    if not result:
        print("No skills ingested yet. Run: cognee_ingester.py ingest")
        return
    for s in result:
        tags = ", ".join(s.get("tags", []))
        print(f"  {s['skill_id']:30s}  {s.get('complexity','?'):10s}  [{tags}]")
        if s.get("instruction_summary"):
            print(f"    {s['instruction_summary'][:120]}")
    print(f"\nTotal: {len(result)} skills")


async def cmd_daemon(args):
    """Autonomous loop: observe runs → auto-inspect failing skills → propose amendments.

    Runs continuously. On each cycle:
      1. Read new NDJSON events, call skills.observe() for each run
      2. Check which skills have accumulated enough failures
      3. Auto-inspect + generate amendment proposals for failing skills
      4. Optionally auto-apply amendments (--auto-apply)

    Uses a lockfile to ensure only ONE daemon runs across all Pi sessions.
    """
    log_path = Path(args.log_path).expanduser().resolve()
    state = StateDB(Path(args.state_db).expanduser().resolve())
    pidfile = Path(args.state_db).with_suffix(".daemon.pid")
    lockfile_path = Path(args.state_db).with_suffix(".daemon.lock")

    # ── Singleton lock: only one daemon across all Pi instances ──
    lockfile_path.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = open(lockfile_path, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        # Another daemon holds the lock
        existing_pid = "(unknown)"
        try:
            existing_pid = pidfile.read_text().strip()
        except Exception:
            pass
        print(f"[daemon] another instance already running (pid={existing_pid}). exiting.")
        lock_fd.close()
        return 0

    # We got the lock — write PID
    pidfile.write_text(str(os.getpid()))
    lock_fd.write(str(os.getpid()))
    lock_fd.flush()

    sk = load_skills_client()
    source_key = str(log_path)
    run_starts: Dict[str, dict] = {}
    cycle = 0

    # Track which skills we've already inspected this session (avoid spamming LLM)
    inspected_this_session: Dict[str, float] = {}  # skill_id → timestamp
    INSPECT_COOLDOWN = 3600  # re-inspect at most once per hour per skill

    print(f"[daemon] started pid={os.getpid()} poll={args.poll_seconds}s "
          f"min_runs={args.min_runs} threshold={args.threshold} "
          f"auto_apply={args.auto_apply}")

    try:
        while True:
            cycle += 1
            observed_skills: Dict[str, list] = {}  # skill_id → [scores]

            # ── Step 1: observe new events ────────────────────────────
            last = state.get_offset(source_key)
            lines, inode, offset = read_new_lines(log_path, last)

            for raw in lines:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    evt = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                ev_type = evt.get("event", "")
                if ev_type == "run_start":
                    rid = evt.get("runId", "")
                    if rid:
                        run_starts[rid] = evt
                elif ev_type == "run_abandoned":
                    run_starts.pop(evt.get("runId", ""), None)
                elif ev_type == "run_end":
                    rid = evt.get("runId", "")
                    if not rid or state.is_observed(rid):
                        continue

                    start_evt = run_starts.pop(rid, {})
                    payload = map_run_event(start_evt, evt, args.include_text)
                    if not payload:
                        continue

                    skill_id = payload["selected_skill_id"]
                    if skill_id == "__none__":
                        state.mark_observed(rid, payload["session_id"], skill_id,
                                            0.0, payload["latency_ms"], "skipped_no_skill")
                        continue

                    # Evaluate quality via LLM if skills were loaded
                    all_skills = payload.get("all_skill_ids", [])
                    eval_score = payload["success_score"]
                    per_skill_scores: Dict[str, Any] = {}

                    if all_skills and payload.get("session_file") and payload.get("started_at"):
                        try:
                            evaluation = await evaluate_run_quality(
                                task_text=payload["task_text"],
                                skill_ids=all_skills,
                                session_file=payload["session_file"],
                                run_start=payload["started_at"],
                                run_end=payload["ended_at"],
                            )
                            if evaluation:
                                eval_score = evaluation["overall_score"]
                                per_skill_scores = evaluation.get("skill_scores", {})
                                payload["success_score"] = eval_score
                                print(f"[daemon] evaluated run {rid[:8]}: "
                                      f"score={eval_score:.2f} reason={evaluation['overall_reason'][:80]}")
                                for sid, ss in per_skill_scores.items():
                                    print(f"[daemon]   {sid}: {ss.get('score', '?')} — {ss.get('reason', '')[:60]}")
                        except Exception as e:
                            per_skill_scores = {}
                            print(f"[daemon] evaluation error: {e}")

                    # Use per-skill score if the LLM provided one for this skill,
                    # otherwise fall back to overall score. This prevents e.g. a
                    # pptx tool failure from tanking frontend-design's score.
                    skill_score = eval_score
                    skill_reason = evaluation.get("overall_reason", "") if evaluation else ""
                    if per_skill_scores and skill_id in per_skill_scores:
                        try:
                            ss = per_skill_scores[skill_id]
                            skill_score = float(ss.get("score", eval_score))
                            skill_score = max(0.0, min(1.0, skill_score))
                            skill_reason = ss.get("reason", skill_reason)
                        except (TypeError, ValueError):
                            skill_score = eval_score

                    try:
                        payload_copy = {**payload, "success_score": skill_score}
                        await sk.observe(payload_copy)
                    except Exception as e:
                        print(f"[daemon] observe error: {e}")

                    state.mark_observed(
                        rid, payload["session_id"], skill_id,
                        skill_score, payload["latency_ms"],
                        str(evt.get("executionOutcome", "")),
                        reason=skill_reason,
                    )
                    observed_skills.setdefault(skill_id, []).append(skill_score)

            state.set_offset(source_key, inode, offset)

            # ── Step 2: auto-inspect failing skills ───────────────────
            if observed_skills:
                for skill_id, scores in observed_skills.items():
                    fails = sum(1 for s in scores if s < args.threshold)
                    if fails == 0:
                        continue

                    # Cooldown check
                    last_inspected = inspected_this_session.get(skill_id, 0)
                    if time.time() - last_inspected < INSPECT_COOLDOWN:
                        continue

                    print(f"[daemon] skill '{skill_id}' has {fails} new failure(s), inspecting...")

                    try:
                        inspection = await sk.inspect(
                            skill_id=skill_id,
                            min_runs=args.min_runs,
                            score_threshold=args.threshold,
                        )
                        inspected_this_session[skill_id] = time.time()

                        if inspection is None:
                            print(f"[daemon] '{skill_id}': not enough failures yet (need {args.min_runs})")
                            continue

                        print(f"[daemon] '{skill_id}' inspection: "
                              f"category={inspection.get('failure_category')} "
                              f"severity={inspection.get('severity')} "
                              f"confidence={inspection.get('inspection_confidence')}")

                        # Auto-generate gotchas → write to SKILL.md
                        try:
                            # Pull eval scores + reasons from SQLite for richer context
                            skill_evals = []
                            db_rows = state.conn.execute("""
                                SELECT success_score, reason, observed_at
                                FROM observed_runs
                                WHERE skill_id = ? AND reason != '' AND reason IS NOT NULL
                                ORDER BY observed_at DESC LIMIT 10
                            """, (skill_id,)).fetchall()
                            for row in db_rows:
                                skill_evals.append({
                                    "score": row["success_score"],
                                    "reason": row["reason"],
                                    "at": row["observed_at"][:19],
                                })
                            # Also include current session scores if no DB reasons yet
                            if not skill_evals:
                                for s in observed_skills.get(skill_id, []):
                                    if isinstance(s, (int, float)):
                                        skill_evals.append({"score": s})

                            gotchas_path = await auto_generate_gotchas(
                                skill_id=skill_id,
                                inspection=inspection,
                                eval_scores=skill_evals,
                                skills_client=sk,
                            )
                            if gotchas_path:
                                print(f"[daemon] '{skill_id}' gotchas written to {gotchas_path}")
                            else:
                                print(f"[daemon] '{skill_id}' gotchas generation failed (no path)")
                        except Exception as e:
                            print(f"[daemon] '{skill_id}' gotchas error: {e}")

                        # Generate amendment proposal in cognee graph
                        amendment = await sk.preview_amendify(
                            skill_id=skill_id,
                            inspection_id=inspection.get("inspection_id"),
                        )

                        if amendment:
                            print(f"[daemon] '{skill_id}' amendment proposed: "
                                  f"id={amendment.get('amendment_id')} "
                                  f"confidence={amendment.get('amendment_confidence')}")

                            if args.auto_apply:
                                result = await sk.amendify(
                                    amendment_id=amendment["amendment_id"],
                                    write_to_disk=args.write_to_disk,
                                )
                                print(f"[daemon] '{skill_id}' amendment applied: {result.get('success')}")
                            else:
                                print(f"[daemon] '{skill_id}' amendment ready — "
                                      f"apply with: ./run-cognee-ingester.sh amend {amendment.get('amendment_id')}")

                    except Exception as e:
                        print(f"[daemon] inspect/amend error for '{skill_id}': {e}")

            # ── Step 3: periodic upsert (check for skill file changes) ─
            if cycle % 60 == 0:  # ~every 2 minutes at 2s poll
                try:
                    managed_root = str(Path(args.managed_root).expanduser().resolve())
                    import io, contextlib
                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf):
                        result = await sk.upsert(skills_folder=managed_root)
                    changes = result.get("updated", 0) + result.get("added", 0) + result.get("removed", 0)
                    if changes:
                        print(f"[daemon] upsert: {result}")
                except Exception as e:
                    print(f"[daemon] upsert error: {e}")

            await asyncio.sleep(args.poll_seconds)

    except KeyboardInterrupt:
        print("\n[daemon] stopped")
    finally:
        pidfile.unlink(missing_ok=True)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            lock_fd.close()
            lockfile_path.unlink(missing_ok=True)
        except Exception:
            pass
        state.close()


RELATE_SYSTEM_PROMPT = """\
You are an expert at analyzing relationships between agentic skills.
Given a set of skills with their names, descriptions, and instruction summaries,
identify meaningful relationships between them.

Relationship types (use ONLY these):
- uses_api: Skill A uses Skill B's API, infrastructure, or tooling (e.g. kling-v2v uses fal-generate's fal.ai queue API)
- depends_on: Skill A requires Skill B to function properly (e.g. ai-video-vfx depends on ffmpeg for format conversion)
- composes_with: Skills chain naturally in a pipeline (e.g. ltx-video → kling-v2v for I2V then V2V editing)
- complements: Skills cover different aspects of the same domain (e.g. ffmpeg and all video generation skills)
- evaluates: Skill A can judge or score Skill B's output (e.g. gemini-film-analysis evaluates video generation skills)

Rules:
- Only propose relationships that are genuinely useful for routing and composition
- Each relationship must have a clear, specific reason
- Prefer fewer high-quality edges over many weak ones
- A→B does not imply B→A (relationships are directional)
- confidence: 0.0-1.0 based on how certain you are"""

RELATE_USER_PROMPT = """\
Here are all the skills in the system:

{skills_block}

Analyze these skills and propose relationship edges between them.
For each relationship, provide:
- from_skill: skill_id of the source
- to_skill: skill_id of the target
- relationship: one of uses_api, depends_on, composes_with, complements, evaluates
- reason: one sentence explaining why this relationship exists
- confidence: 0.0-1.0

Return a JSON array of relationship objects."""


# ── Auto-gotchas helper (used by daemon + cmd_gotchas) ────────────────────

async def auto_generate_gotchas(
    skill_id: str,
    inspection: Dict[str, Any],
    eval_scores: List[Dict[str, Any]],
    skills_client,
) -> Optional[str]:
    """Generate and write gotchas to SKILL.md from inspection + eval data. Returns path if written."""
    import litellm
    from cognee.infrastructure.llm import get_llm_config

    skill = await skills_client.load(skill_id)
    if not skill:
        return None

    failure_lines = [
        f"INSPECTION:\n"
        f"  Category: {inspection.get('failure_category')}\n"
        f"  Root cause: {inspection.get('root_cause')}\n"
        f"  Severity: {inspection.get('severity')}\n"
        f"  Hypothesis: {inspection.get('improvement_hypothesis')}\n"
        f"  Runs analyzed: {inspection.get('analyzed_run_count')}\n"
        f"  Avg score: {inspection.get('avg_success_score')}"
    ]
    for ev in eval_scores:
        failure_lines.append(f"EVAL: score={ev.get('score', '?')} reason={ev.get('reason', '')}")

    failure_data = "\n\n".join(failure_lines)
    instructions = skill.get("instructions", "")[:3000]

    llm_config = get_llm_config()
    response = await litellm.acompletion(
        model=llm_config.llm_model,
        messages=[
            {"role": "system", "content": GOTCHAS_SYSTEM_PROMPT},
            {"role": "user", "content": (
                f"## Skill: {skill_id}\n\n"
                f"### Current instructions (first 3000 chars):\n{instructions}\n\n"
                f"### Failure data from production runs:\n{failure_data}\n\n"
                f"Write a Gotchas section addressing these specific failures."
            )},
        ],
        api_key=llm_config.llm_api_key,
    )

    gotchas_content = response.choices[0].message.content or ""
    if not gotchas_content.strip():
        return None

    gotchas_section = f"\n\n## Gotchas (auto-generated from production data)\n\n{gotchas_content.strip()}\n"

    # Find the actual SKILL.md and follow symlinks
    skill_path = skill.get("source_path", "")
    if not skill_path:
        return None

    skill_md = Path(skill_path) / "SKILL.md"
    if skill_md.is_symlink():
        skill_md = skill_md.resolve()
    if not skill_md.exists():
        return None

    content = skill_md.read_text(encoding="utf-8")

    marker = "## Gotchas (auto-generated from production data)"
    if marker in content:
        start = content.index(marker)
        rest = content[start + len(marker):]
        next_heading = rest.find("\n## ")
        if next_heading >= 0:
            content = content[:start] + gotchas_section.strip() + "\n" + content[start + len(marker) + next_heading:]
        else:
            content = content[:start] + gotchas_section.strip() + "\n"
    else:
        content = content.rstrip() + gotchas_section

    skill_md.write_text(content, encoding="utf-8")
    return str(skill_md)


GOTCHAS_SYSTEM_PROMPT = """\
You are an expert at writing "Gotchas" sections for AI agent skill files.

You'll receive a skill's current instructions and real failure data from production runs
(LLM evaluation scores and reasons). Your job is to write a concise, high-signal Gotchas
section that addresses the actual failures observed.

Anthropic's guidance: "The highest-signal content in any skill is the Gotchas section.
These should be built up from common failure points."

Rules:
- Each gotcha must address a REAL observed failure, not theoretical problems
- Be specific and actionable: "When doing X, always Y — otherwise Z happens"
- Include the concrete failure pattern so the agent recognizes it
- Keep it to 3-8 gotchas (quality over quantity)
- Use imperative tone: "Always...", "Never...", "Before doing X, first..."
- If a failure is about skipping a required step, make the gotcha unmissable

Output ONLY the gotchas content (no markdown header — the caller adds that).
Use bullet points with bold lead-ins."""


async def cmd_gotchas(args):
    """Generate or update Gotchas section from cognee failure data."""
    sk = load_skills_client()  # applies shims + loads cognee

    import litellm
    from cognee.infrastructure.llm import get_llm_config

    # Load skill
    skill = await sk.load(args.skill_id)
    if not skill:
        print(f"Skill '{args.skill_id}' not found in cognee")
        return

    # Gather failure data from multiple sources
    failure_lines = []

    # 1. Cognee inspection (if available)
    try:
        inspection = await sk.inspect(
            skill_id=args.skill_id,
            min_runs=1,
            score_threshold=args.threshold,
        )
        if inspection:
            failure_lines.append(
                f"INSPECTION (from {inspection.get('analyzed_run_count', '?')} failed runs):\n"
                f"  Category: {inspection.get('failure_category')}\n"
                f"  Root cause: {inspection.get('root_cause')}\n"
                f"  Severity: {inspection.get('severity')}\n"
                f"  Hypothesis: {inspection.get('improvement_hypothesis')}"
            )
    except Exception:
        pass

    # 2. Local eval scores from our state DB
    state = StateDB(Path(args.state_db).expanduser().resolve())
    rows = state.conn.execute(
        "SELECT success_score, outcome, observed_at FROM observed_runs WHERE skill_id=? ORDER BY observed_at",
        (args.skill_id,)
    ).fetchall()
    state.close()

    if rows:
        scores = [r["success_score"] for r in rows]
        avg = sum(scores) / len(scores)
        low_runs = [r for r in rows if r["success_score"] < args.threshold]
        failure_lines.append(
            f"RUN HISTORY ({len(rows)} runs, avg score: {avg:.2f}):\n"
            f"  Low-scoring runs: {len(low_runs)}/{len(rows)}"
        )

    # 3. Re-run evaluation on sessions where this skill was loaded
    obs_path = Path(args.log_path).expanduser().resolve()
    if obs_path.exists():
        with obs_path.open() as f:
            for line in f:
                try:
                    evt = json.loads(line.strip())
                    if evt.get("event") != "run_end":
                        continue
                    loaded = [s.get("name", "") for s in evt.get("loadedSkills", [])]
                    if args.skill_id not in loaded:
                        continue
                    session_file = evt.get("sessionFile", "")
                    started = evt.get("startedAt", "")
                    ended = evt.get("endedAt", "")
                    if session_file and started and ended:
                        eval_result = await evaluate_run_quality(
                            task_text=f"[task for run {evt.get('runId', '')[:8]}]",
                            skill_ids=loaded,
                            session_file=session_file,
                            run_start=started,
                            run_end=ended,
                        )
                        if eval_result:
                            skill_score = eval_result.get("skill_scores", {}).get(args.skill_id, {})
                            if skill_score:
                                failure_lines.append(
                                    f"EVALUATION for '{args.skill_id}':\n"
                                    f"  Score: {skill_score.get('score', '?')}\n"
                                    f"  Reason: {skill_score.get('reason', 'N/A')}"
                                )
                            failure_lines.append(
                                f"OVERALL RUN EVALUATION:\n"
                                f"  Score: {eval_result.get('overall_score', '?')}\n"
                                f"  Reason: {eval_result.get('overall_reason', 'N/A')}"
                            )
                except Exception:
                    continue

    if not failure_lines:
        print(f"No failure data found for '{args.skill_id}'. Run some tasks using this skill first.")
        return

    failure_data = "\n\n".join(failure_lines)
    instructions = skill.get("instructions", "")[:3000]

    print(f"Generating gotchas from {len(failure_lines)} data sources...")

    llm_config = get_llm_config()
    response = await litellm.acompletion(
        model=llm_config.llm_model,
        messages=[
            {"role": "system", "content": GOTCHAS_SYSTEM_PROMPT},
            {"role": "user", "content": (
                f"## Skill: {args.skill_id}\n\n"
                f"### Current instructions (first 3000 chars):\n{instructions}\n\n"
                f"### Failure data from production runs:\n{failure_data}\n\n"
                f"Write a Gotchas section addressing these specific failures."
            )},
        ],
        api_key=llm_config.llm_api_key,
    )

    gotchas_content = response.choices[0].message.content or ""
    gotchas_section = f"\n\n## Gotchas (auto-generated from production data)\n\n{gotchas_content.strip()}\n"

    print(f"\n{'='*60}")
    print(gotchas_section)
    print(f"{'='*60}")

    if args.preview:
        print(f"\nPreview only. Use --apply to write to SKILL.md")
        return

    if not args.apply:
        print(f"\nDry run. Use --apply to write, or --preview for just the text.")
        return

    # Find the actual SKILL.md file and follow symlinks
    skill_path = skill.get("source_path", "")
    if not skill_path:
        print(f"No source_path for '{args.skill_id}' — can't write")
        return

    skill_md = Path(skill_path) / "SKILL.md"
    if skill_md.is_symlink():
        skill_md = skill_md.resolve()
    if not skill_md.exists():
        print(f"SKILL.md not found at {skill_md}")
        return

    content = skill_md.read_text(encoding="utf-8")

    # Replace existing auto-generated gotchas, or append
    marker = "## Gotchas (auto-generated from production data)"
    if marker in content:
        start = content.index(marker)
        rest = content[start + len(marker):]
        next_heading = rest.find("\n## ")
        if next_heading >= 0:
            end = start + len(marker) + next_heading
            content = content[:start] + gotchas_section.strip() + "\n" + content[end:]
        else:
            content = content[:start] + gotchas_section.strip() + "\n"
    else:
        content = content.rstrip() + gotchas_section

    skill_md.write_text(content, encoding="utf-8")
    print(f"\n✓ Gotchas written to: {skill_md}")
    print(f"  Run 'upsert' to sync changes to cognee graph")


SUGGEST_EVALS_PROMPT = """\
You are an expert at writing binary eval criteria for AI skill optimization.

Given a skill's inspection data (failure analysis from real production runs),
generate 4-6 binary yes/no eval questions that would catch the failures
that have been observed.

Rules (from Karpathy's autoresearch methodology):
- Every eval MUST be binary: yes or no. No scales, no vibes.
- Specific enough that two different agents would score the same output identically.
- Not so narrow that the skill games the eval without actually improving.
- Each eval tests something distinct (no overlapping checks).
- 4-6 evals is the sweet spot.

Output format — return a JSON array:
[
  {
    "name": "Short name",
    "question": "Yes/no question about the output",
    "pass": "What 'yes' looks like — one sentence",
    "fail": "What triggers 'no' — one sentence"
  }
]"""


async def cmd_suggest_evals(args):
    """Generate autoresearch eval criteria from cognee's failure data."""
    sk = load_skills_client()

    # Get inspection
    inspection = await sk.inspect(
        skill_id=args.skill_id,
        min_runs=args.min_runs,
        score_threshold=args.threshold,
    )

    # Also get the skill details
    skill = await sk.load(args.skill_id)
    if not skill:
        print(f"Skill '{args.skill_id}' not found in cognee")
        return

    if inspection:
        failure_context = (
            f"Failure category: {inspection.get('failure_category')}\n"
            f"Root cause: {inspection.get('root_cause')}\n"
            f"Severity: {inspection.get('severity')}\n"
            f"Hypothesis: {inspection.get('improvement_hypothesis')}\n"
            f"Analyzed runs: {inspection.get('analyzed_run_count')}\n"
            f"Avg score: {inspection.get('avg_success_score')}"
        )
    else:
        failure_context = "(No failures recorded yet — generating general evals based on skill description)"

    user_prompt = (
        f"## Skill: {args.skill_id}\n"
        f"Summary: {skill.get('instruction_summary', '')}\n"
        f"Tags: {', '.join(skill.get('tags', []))}\n\n"
        f"## Failure Analysis\n{failure_context}\n\n"
        f"Generate binary eval criteria for autoresearch optimization of this skill."
    )

    import litellm
    from cognee.infrastructure.llm import get_llm_config
    llm_config = get_llm_config()

    response = await litellm.acompletion(
        model=llm_config.llm_model,
        messages=[
            {"role": "system", "content": SUGGEST_EVALS_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        api_key=llm_config.llm_api_key,
    )

    raw = response.choices[0].message.content or ""
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    evals = json.loads(cleaned)

    print(f"Suggested evals for '{args.skill_id}':\n")
    for i, ev in enumerate(evals, 1):
        print(f"EVAL {i}: {ev['name']}")
        print(f"  Question: {ev['question']}")
        print(f"  Pass: {ev['pass']}")
        print(f"  Fail: {ev['fail']}")
        print()

    print(f"To run autoresearch with these evals:")
    print(f"  pi \"run autoresearch on {args.skill_id} with these evals: {', '.join(e['question'] for e in evals)}\"")


async def cmd_relate(args):
    """Discover and create inter-skill relationship edges using LLM."""
    from pydantic import BaseModel, Field
    from typing import List, Literal

    class SkillRelationship(BaseModel):
        from_skill: str
        to_skill: str
        relationship: Literal["uses_api", "depends_on", "composes_with", "complements", "evaluates"]
        reason: str
        confidence: float = Field(ge=0.0, le=1.0)

    class RelationshipProposal(BaseModel):
        relationships: List[SkillRelationship]

    sk = load_skills_client()

    # Load all skills
    all_skills = await sk.list()
    if not all_skills:
        print("No skills ingested. Run: ingest first")
        return

    # Filter if --only specified
    if args.only:
        only_set = set(args.only)
        all_skills = [s for s in all_skills if s["skill_id"] in only_set]
        missing = only_set - {s["skill_id"] for s in all_skills}
        if missing:
            print(f"[warn] skills not found: {missing}")
        if not all_skills:
            print("No matching skills found")
            return

    # Build skills block for LLM
    skills_block = ""
    for s in all_skills:
        tags = ", ".join(s.get("tags", []))
        skills_block += (
            f"skill_id: {s['skill_id']}\n"
            f"  name: {s.get('name', '')}\n"
            f"  complexity: {s.get('complexity', '')}\n"
            f"  tags: [{tags}]\n"
            f"  summary: {s.get('instruction_summary', '')}\n\n"
        )

    dense_hint = ""
    if args.dense:
        dense_hint = (
            "\n\nIMPORTANT: These skills are known to work together as part of the same workflow domain. "
            "Be thorough — find ALL meaningful relationships, not just the most obvious ones. "
            "Aim for dense interconnection where genuinely useful. "
            "Think about workflow chains: what comes before, after, alongside each skill?"
        )

    user_prompt = RELATE_USER_PROMPT.format(skills_block=skills_block) + dense_hint

    print(f"Analyzing {len(all_skills)} skills for relationships...")

    # LLM structured output
    from cognee.infrastructure.llm.LLMGateway import LLMGateway
    proposal: RelationshipProposal = await LLMGateway.acreate_structured_output(
        text_input=user_prompt,
        system_prompt=RELATE_SYSTEM_PROMPT,
        response_model=RelationshipProposal,
    )

    rels = proposal.relationships
    print(f"\nProposed {len(rels)} relationships:\n")

    # Validate skill IDs
    valid_ids = {s["skill_id"] for s in all_skills}
    valid_rels = []
    for r in rels:
        if r.from_skill not in valid_ids:
            print(f"  [skip] {r.from_skill} → {r.to_skill}: unknown source skill")
            continue
        if r.to_skill not in valid_ids:
            print(f"  [skip] {r.from_skill} → {r.to_skill}: unknown target skill")
            continue
        valid_rels.append(r)
        marker = "✓" if r.confidence >= 0.7 else "?"
        print(f"  {marker} {r.from_skill} --{r.relationship}--> {r.to_skill}  "
              f"(conf={r.confidence:.2f})  {r.reason}")

    if not valid_rels:
        print("\nNo valid relationships to apply.")
        return

    if args.preview:
        # Just dump JSON for review
        print(f"\n--- Preview ({len(valid_rels)} edges) ---")
        print(json.dumps([r.model_dump() for r in valid_rels], indent=2))
        print(f"\nTo apply: ./run-cognee-ingester.sh relate --apply")
        return

    if not args.apply:
        print(f"\nDry run. Use --apply to write edges or --preview for JSON.")
        return

    # Apply: write edges to cognee graph
    from cognee.infrastructure.databases.graph import get_graph_engine
    from cognee.modules.engine.models.node_set import NodeSet

    engine = await get_graph_engine()
    nodes, _ = await engine.get_nodeset_subgraph(node_type=NodeSet, node_name=["skills"])

    # Build skill_id → node_id map
    skill_nid = {}
    for nid, props in nodes:
        if props.get("type") == "Skill":
            skill_nid[props.get("skill_id", "")] = str(nid)

    edges_to_add = []
    for r in valid_rels:
        src_nid = skill_nid.get(r.from_skill)
        tgt_nid = skill_nid.get(r.to_skill)
        if not src_nid or not tgt_nid:
            continue
        edges_to_add.append((
            src_nid,
            tgt_nid,
            r.relationship,
            {
                "reason": r.reason,
                "confidence": r.confidence,
                "source": "llm_relate",
            },
        ))

    if edges_to_add:
        await engine.add_edges(edges_to_add)
        print(f"\n✓ Applied {len(edges_to_add)} relationship edges to graph")
    else:
        print("\nNo edges could be mapped to graph nodes")


async def cmd_graph(args):
    """Generate interactive graph visualization."""
    apply_import_shims()
    import cognee

    out = Path(args.output).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    print(f"Generating graph → {out}")
    html_path = await cognee.visualize_graph(str(out))
    print(f"✓ Graph saved to: {html_path}")

    if not args.no_open:
        import subprocess
        subprocess.Popen(["open", str(html_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("Opened in browser")


def cmd_report(args):
    """Local observation statistics."""
    state = StateDB(Path(args.state_db).expanduser().resolve())
    try:
        r = state.report()
        print(json.dumps(r, indent=2, default=str))
    finally:
        state.close()


# ── CLI ───────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Pi → Cognee skills bridge")
    p.add_argument("--cognee-root", default=str(DEFAULT_COGNEE_ROOT))
    sub = p.add_subparsers(dest="command")

    # ingest
    ing = sub.add_parser("ingest", help="Load skills into cognee graph")
    ing.add_argument("--managed-root", default=str(DEFAULT_MANAGED_ROOT))
    ing.add_argument("--dataset", default="skills")
    ing.add_argument("--skip-enrichment", action="store_true",
                     help="Skip LLM enrichment (faster but no task patterns)")
    ing.add_argument("--reset", action="store_true",
                     help="Delete cognee storage first")

    # upsert
    ups = sub.add_parser("upsert", help="Incremental re-ingest")
    ups.add_argument("--managed-root", default=str(DEFAULT_MANAGED_ROOT))
    ups.add_argument("--dataset", default="skills")

    # daemon
    dm = sub.add_parser("daemon", help="Autonomous loop: observe → inspect → amend (runs forever)")
    dm.add_argument("--log-path", default=str(DEFAULT_LOG_PATH))
    dm.add_argument("--state-db", default=str(DEFAULT_STATE_DB))
    dm.add_argument("--managed-root", default=str(DEFAULT_MANAGED_ROOT))
    dm.add_argument("--poll-seconds", type=float, default=2.0)
    dm.add_argument("--min-runs", type=int, default=3,
                    help="Min failed runs before auto-inspect triggers")
    dm.add_argument("--threshold", type=float, default=0.5,
                    help="Score below which a run counts as failure")
    dm.add_argument("--auto-apply", action="store_true",
                    help="Auto-apply amendments (default: propose only)")
    dm.add_argument("--write-to-disk", action="store_true",
                    help="Write amended SKILL.md to disk when applying")
    dm.add_argument("--include-text", action="store_true", default=True,
                    help="Include task text in evaluations (default: on for daemon)")

    # observe
    obs = sub.add_parser("observe", help="Process NDJSON events → skills.observe()")
    obs.add_argument("--mode", choices=["once", "follow"], default="once")
    obs.add_argument("--log-path", default=str(DEFAULT_LOG_PATH))
    obs.add_argument("--state-db", default=str(DEFAULT_STATE_DB))
    obs.add_argument("--poll-seconds", type=float, default=2.0)
    obs.add_argument("--include-text", action="store_true")
    obs.add_argument("--no-require-skill", dest="require_skill", action="store_false", default=True)
    obs.add_argument("--dry-run", action="store_true")

    # inspect
    ins = sub.add_parser("inspect", help="Analyze a failing skill")
    ins.add_argument("skill_id")
    ins.add_argument("--min-runs", type=int, default=1)
    ins.add_argument("--threshold", type=float, default=0.5)

    # preview
    pre = sub.add_parser("preview", help="Preview a proposed amendment")
    pre.add_argument("skill_id")
    pre.add_argument("--min-runs", type=int, default=1)
    pre.add_argument("--threshold", type=float, default=0.5)

    # amend
    amd = sub.add_parser("amend", help="Apply an amendment")
    amd.add_argument("amendment_id")
    amd.add_argument("--write-to-disk", action="store_true")

    # auto-amend
    aa = sub.add_parser("auto-amend", help="Full inspect→preview→apply")
    aa.add_argument("skill_id")
    aa.add_argument("--min-runs", type=int, default=1)
    aa.add_argument("--threshold", type=float, default=0.5)
    aa.add_argument("--write-to-disk", action="store_true")

    # evaluate
    ev = sub.add_parser("evaluate", help="Compare pre/post amendment scores")
    ev.add_argument("amendment_id")

    # rollback
    rb = sub.add_parser("rollback", help="Revert an amendment")
    rb.add_argument("amendment_id")

    # run
    rn = sub.add_parser("run", help="Find best skill and execute a task")
    rn.add_argument("task_text")
    rn.add_argument("--no-evaluate", action="store_true")
    rn.add_argument("--auto-amendify", action="store_true")
    rn.add_argument("--min-runs", type=int, default=3)

    # execute
    ex = sub.add_parser("execute", help="Execute a specific skill")
    ex.add_argument("skill_id")
    ex.add_argument("task_text")
    ex.add_argument("--no-evaluate", action="store_true")
    ex.add_argument("--auto-amendify", action="store_true")

    # recommend
    rec = sub.add_parser("recommend", help="Skill recommendations for a task")
    rec.add_argument("task_text")
    rec.add_argument("--top-k", type=int, default=5)

    # load
    ld = sub.add_parser("load", help="Full details for a skill")
    ld.add_argument("skill_id")

    # remove
    rm = sub.add_parser("remove", help="Remove a skill")
    rm.add_argument("skill_id")

    # gotchas
    gc = sub.add_parser("gotchas", help="Generate Gotchas section from production failure data")
    gc.add_argument("skill_id")
    gc.add_argument("--threshold", type=float, default=0.7)
    gc.add_argument("--state-db", default=str(DEFAULT_STATE_DB))
    gc.add_argument("--log-path", default=str(DEFAULT_LOG_PATH))
    gc.add_argument("--preview", action="store_true", help="Show gotchas without writing")
    gc.add_argument("--apply", action="store_true", help="Write gotchas to SKILL.md")

    # suggest-evals
    se = sub.add_parser("suggest-evals", help="Generate autoresearch eval criteria from cognee failure data")
    se.add_argument("skill_id")
    se.add_argument("--min-runs", type=int, default=1)
    se.add_argument("--threshold", type=float, default=0.5)

    # relate
    rl = sub.add_parser("relate", help="Discover inter-skill relationships via LLM")
    rl.add_argument("--preview", action="store_true", help="Output JSON for review, don't write")
    rl.add_argument("--apply", action="store_true", help="Write relationship edges to graph")
    rl.add_argument("--only", nargs="+", help="Only analyze these skill IDs (focused mode)")
    rl.add_argument("--dense", action="store_true", help="Ask LLM to find MORE edges (less conservative)")

    # graph
    gr = sub.add_parser("graph", help="Generate interactive graph visualization")
    gr.add_argument("--output", default=str(Path.home() / ".pi" / "agent" / "skill-observer" / "graph.html"))
    gr.add_argument("--no-open", action="store_true", help="Don't auto-open in browser")

    # list
    sub.add_parser("list", help="List all ingested skills")

    # report
    rp = sub.add_parser("report", help="Local observation statistics")
    rp.add_argument("--state-db", default=str(DEFAULT_STATE_DB))

    return p


def main():
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    # Configure cognee environment
    configure_env(args.cognee_root)

    # Handle reset
    if args.command == "ingest" and getattr(args, "reset", False):
        import shutil
        root = Path(args.cognee_root).expanduser().resolve()
        for d in [root / ".data_storage", root / ".cognee_system"]:
            if d.exists():
                shutil.rmtree(d)
        print(f"Reset cognee storage under {root}")

    # Dispatch
    cmd_map = {
        "ingest": cmd_ingest,
        "upsert": cmd_upsert,
        "daemon": cmd_daemon,
        "observe": cmd_observe,
        "inspect": cmd_inspect,
        "preview": cmd_preview,
        "amend": cmd_amend,
        "auto-amend": cmd_auto_amend,
        "evaluate": cmd_evaluate,
        "rollback": cmd_rollback,
        "run": cmd_run,
        "execute": cmd_execute,
        "recommend": cmd_recommend,
        "load": cmd_load,
        "remove": cmd_remove,
        "gotchas": cmd_gotchas,
        "suggest-evals": cmd_suggest_evals,
        "relate": cmd_relate,
        "graph": cmd_graph,
        "list": cmd_list,
    }

    if args.command == "report":
        return cmd_report(args)

    handler = cmd_map.get(args.command)
    if not handler:
        parser.print_help()
        return 1

    return asyncio.run(handler(args))


if __name__ == "__main__":
    raise SystemExit(main() or 0)
