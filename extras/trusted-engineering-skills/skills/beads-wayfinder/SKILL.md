---
name: beads-wayfinder
description: Map and resolve a foggy, multi-session engineering effort as a Beads decision graph. Use when the destination is meaningful but the route is unclear, several decisions or investigations depend on one another, concurrent agents need a claimable frontier, or the user mentions Wayfinder, wayfinding, decision maps, or planning a large migration. Do not use for a clear one-session task. Never fall back to Markdown tickets.
compatibility: Requires bd 1.x and a human-initialized Beads repository.
---

# Beads Wayfinder

Chart the route to a destination as a small Beads graph of decision tickets. Resolve the graph one frontier ticket at a time until implementation can be planned safely.

This skill adapts Matt Pocock's Wayfinder and tracer-bullet ticketing ideas to Beads, Agent Mail, and Gustav's evidence-first repository workflow.

## boundary

Wayfinding resolves decisions. It does not implement the destination.

Use it only when:

- the effort will outlive one context window or session;
- the route contains meaningful uncertainty, dependencies, or fog;
- a durable destination and stopping condition can be stated;
- Beads is already initialized by a human.

For a clear task that fits one session, skip the map and proceed through the repository's normal planning or implementation workflow.

Never initialize Beads, create local Markdown tickets, open a pull request, push, deploy, publish, send messages, or mutate product data merely because this skill was invoked.

## truth and coordination

- Git owns code and implementation history.
- Beads owns the map, decisions, dependencies, claims, and resolution record.
- Agent Mail owns temporary file reservations and handoffs when multiple agents share a checkout.
- Durable domain glossaries and ADRs use the `domain-modeling` gates.

Do not duplicate a decision in a map summary and a child ticket. The closed decision Bead and its resolution comment are the detailed truth.

## orient every session

1. Read the applicable `AGENTS.md`; follow its instruction owner and safety boundaries.
2. Run `bd prime` because the installed CLI is the command authority.
3. Load the map at low resolution with `bd show <map>`.
4. Query the frontier rather than opening every child.
5. Inspect code or source systems for facts before asking the user.

Use [the tested Beads operations](references/BEADS-OPERATIONS.md). If the installed CLI differs, follow `bd prime` and `bd <command> --help` rather than stale examples.

## chart a map

### 1. name the destination

Use `grill-with-docs` and `domain-modeling` as needed. Define:

- the outcome this map is finding a route toward;
- explicit scope and safety boundaries;
- what evidence proves the route is clear;
- what belongs to later implementation.

If the destination cannot yet be stated, continue the one-question-at-a-time interview. Do not create an epic with a vague title.

### 2. expose only the visible frontier

Explore breadth-first. Create a ticket now only when its question can be stated precisely. Keep dimly perceived in-scope work as fog in the map's notes until a prior answer makes it precise.

Classify visible tickets:

- `wayfinder:grilling`: a human decision, resolved one question at a time;
- `wayfinder:research`: facts requiring bounded investigation;
- `wayfinder:prototype`: a cheap artifact needed to make a choice concrete;
- `wayfinder:task`: necessary manual work that unblocks a decision but does not deliver the destination.

Create decision questions as Beads type `decision`. Use `task` only for non-decision work that genuinely blocks one.

### 3. preview before durable writes when intent is ambiguous

For a review, recommendation, or test request, show the proposed destination, first frontier, dependencies, fog, and stopping condition without writing Beads. `bd create --dry-run` may validate individual shapes.

When the user explicitly asks to create, track, start, or map the effort, create the epic and visible children, then wire dependencies in a second pass.

Store:

- destination and boundaries in the epic description;
- modeling approach and durable design constraints in `design`;
- fog, out-of-scope items, and coordination notes in `notes`;
- each answer in the decision Bead's resolution comment.

### 4. verify the graph

Check that:

- every child contributes to the destination;
- blockers represent real prerequisite knowledge or work;
- the frontier contains open, unblocked, unclaimed children;
- no implementation slice is disguised as a decision;
- no decision is duplicated in multiple artifacts.

## work one frontier ticket

1. Select the named ticket or the first suitable result from `bd ready --parent <map> --unassigned`.
2. Claim it atomically with `bd update <id> --claim` before work.
3. Resolve discoverable facts from the repository or source system.
4. For a human choice, ask one question with a recommendation and wait.
5. Post the answer as a resolution comment.
6. Close the ticket with a reason that states the decision, not merely "done".
7. Add only newly visible tickets and dependencies. Move newly clarified fog into those tickets.
8. Stop. Resolve no second decision ticket in the same session unless the user explicitly asks.

If several agents work concurrently, Beads claims prevent duplicate ticket ownership. Before edits, Agent Mail reserves only the exact paths each agent owns and records acknowledgement-required handoffs.

## scope and cancellation

When a ticket is outside the destination, close it with an out-of-scope reason and summarize that boundary in the map notes. Do not let it return to the frontier unless the destination changes.

Cancel or supersede a map when the destination becomes invalid. Do not force every map to completion.

## handoff to implementation

The map is complete when no unresolved decision blocks a coherent implementation plan. Then create implementation issues through the repository's normal workflow:

- prefer narrow vertical slices that produce independently verifiable behavior;
- use expand-migrate-contract for wide mechanical refactors;
- encode real blocking edges in Beads;
- keep each issue within one fresh working context;
- retain the map as decision provenance, not as an execution dashboard.

## completion report

Report:

- destination and whether the route is now clear;
- decision resolved in this session;
- evidence and tradeoff behind it;
- newly visible frontier and blockers;
- remaining fog and explicit out-of-scope items;
- Beads or source changes made, plus checks run.

## provenance

Adapted from Matt Pocock's `wayfinder`, `to-tickets`, `grilling`, and `domain-modeling` skills at commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c` under the MIT license. This version replaces tracker abstraction and Markdown artifacts with Beads, removes automatic subagents and remote writes, and makes implementation an explicit handoff.
