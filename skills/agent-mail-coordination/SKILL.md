---
name: agent-mail-coordination
description: Coordinate two or more coding agents working in the same repository with MCP Agent Mail. Use when parallel agents need explicit file ownership, conflict prevention, task-thread messages, acknowledgements, or handoffs. Do not use for a single agent or agents working in isolated worktrees with no shared files.
---

# Agent Mail coordination

Use the `am` CLI as a small coordination layer around real work. Keep ownership paths narrow and make the repository's absolute path the project key.

## Start a shared-repository task

1. Confirm Agent Mail is healthy with `am --version`. If state health is uncertain, run `am doctor mcp-selftest` before coordinating live work.
2. Resolve the repository root with `git rev-parse --show-toplevel` and use that absolute path as `PROJECT`.
3. Split the work into non-overlapping file paths or globs. Do not reserve the whole repository unless every file is genuinely owned by one agent.
4. Check the proposed paths before editing:

   ```bash
   am file_reservations conflicts "$PROJECT" 'path/one/**' 'path/two/file.ts'
   ```

5. Start each agent session and reserve its exact ownership paths:

   ```bash
   am macros start-session \
     --project "$PROJECT" \
     --program pi \
     --model '<current-model>' \
     --task '<bounded task>' \
     --reserve 'path/one/**' \
     --reserve 'path/two/file.ts' \
     --reserve-reason '<why this agent owns these files>' \
     --format json
   ```

Record the returned agent name in the task context. Never print, copy, or pass identity tokens. The CLI reuses the persisted identity automatically.

## Work without collisions

- Treat an exclusive reservation owned by another agent as a stop sign. Inspect `am reservations --project "$PROJECT" --all --json`, then negotiate ownership instead of editing through it.
- Check `am inbox --project "$PROJECT" --agent "$AGENT" --unread --include-bodies --json` at task boundaries and before merging a handoff.
- Use one stable thread ID per task. Prefer its Beads issue ID when one exists.
- Send messages for blockers, interface changes, and handoffs, not routine narration:

  ```bash
  am mail send \
    --project "$PROJECT" \
    --from "$AGENT" \
    --to '<recipient-agent>' \
    --subject '<literal subject>' \
    --body '<decision, evidence, affected paths, next action>' \
    --thread-id '<task-or-bead-id>' \
    --ack-required
  ```

- Acknowledge required messages after reading and acting on them:

  ```bash
  am mail ack --project "$PROJECT" --agent "$AGENT" '<message-id>'
  ```

- For work lasting beyond the reservation TTL, renew the reservation before it expires. Do not silently create a second overlapping reservation.

## Finish cleanly

1. Send a handoff containing the result, verification, affected paths, commit or branch, and any unresolved risk.
2. Confirm required acknowledgements or explicitly report who has not acknowledged.
3. Release the agent's reservations:

   ```bash
   am file_reservations release "$PROJECT" "$AGENT"
   ```

4. Recheck `am reservations --project "$PROJECT" --agent "$AGENT" --json`. The task is coordinated only when the agent has no stale reservations and required handoffs are acknowledged.

## Boundaries

- Do not start the background HTTP service for ordinary Pi work. The CLI-first path is sufficient and easier to audit.
- Do not put credentials, cookies, tokens, customer data, or private keys in messages.
- Agent Mail coordinates ownership and handoffs. Git remains the source of truth for code, and Beads remains the source of truth for issue state.
- If Agent Mail is unavailable, stop shared-checkout edits or move agents to isolated worktrees. Do not pretend coordination succeeded.
