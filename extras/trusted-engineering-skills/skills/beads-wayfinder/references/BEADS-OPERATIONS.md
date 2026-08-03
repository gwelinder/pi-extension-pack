# Beads operations for Wayfinder

Validated against `bd 1.1.2`. Run `bd prime` and command help in the current repository before relying on this reference.

## inspect without writing

```bash
bd show <map-id> --json
bd ready --parent <map-id> --unassigned --json
bd blocked --json
bd dep tree <map-id>
```

Use `--readonly` for exploratory commands in a worker sandbox. For a proposed shape, `bd create --dry-run` validates one issue without creating it.

## create a map

```bash
bd create \
  --title="<destination name>" \
  --type=epic \
  --priority=2 \
  --labels=wayfinder:map \
  --description="<destination, boundaries, stopping evidence>" \
  --design="<domain model and durable design constraints>" \
  --notes="<fog, out of scope, coordination>" \
  --acceptance="<evidence that the route is clear>" \
  --json
```

## create visible decision tickets

```bash
bd create \
  --title="<precise decision question>" \
  --type=decision \
  --parent=<map-id> \
  --priority=2 \
  --labels=wayfinder:grilling \
  --description="<question and why the destination waits on it>" \
  --acceptance="<what a resolved answer must establish>" \
  --json
```

Use one of `wayfinder:grilling`, `wayfinder:research`, `wayfinder:prototype`, or `wayfinder:task`. A necessary non-decision action may use `--type=task`.

Create all currently visible children first. Wire dependencies after real IDs exist:

```bash
bd dep add <blocked-ticket> <prerequisite-ticket>
```

The first argument depends on the second.

## claim and resolve one ticket

```bash
bd update <ticket-id> --claim --json
bd comment <ticket-id> "<answer, evidence, tradeoff, and resulting constraint>"
bd close <ticket-id> --reason="Decided: <one-line resolution>" --suggest-next
```

Use `bd update <map-id> --append-notes="..."` for newly visible fog or scope boundaries. Do not copy the full resolution into the map.

## graph health

```bash
bd ready --parent <map-id> --unassigned --json
bd blocked --json
bd doctor --check=conventions
```

If `bv` is available, use only robot modes:

```bash
bv --robot-insights
bv --robot-plan
```

Never launch the interactive TUI from an agent session.
