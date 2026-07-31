# Skill quality and continuous-improvement policy

## Principle

Telemetry selects what deserves investigation. It does not author production instructions.

A tool failure in a session where a skill was loaded is correlation only. Determine whether the cause was routing, instructions, environment, model behavior, or an unrelated tool call before changing the skill.

## Evidence lifecycle

1. **Observe**
   - gateway recommendation, search, explicit load, or load miss;
   - downstream tool calls and validation results;
   - provider/tool surface cost;
   - repeated user correction where it can be reviewed safely.
2. **Cluster** repeated failures by mechanism. Ignore isolated anecdotes unless severity is high.
3. **Diagnose** one failure class:
   - routing description/alias;
   - missing or incorrect workflow instruction;
   - stale command/API;
   - wrong skill boundary;
   - environment/setup issue;
   - unrelated failure.
4. **Propose** the smallest replacement. Include text to remove, not only text to add.
5. **Evaluate** routing and execution separately.
6. **Review** before propagation to any harness.
7. **Measure** subsequent sessions and revert if the change does not help.

## Change gate

A skill change is eligible only when it has:

- cited evidence from multiple sessions or one high-severity reproducible incident;
- a causal diagnosis;
- a bounded diff;
- an eval or reproducible validation command;
- explicit handling of obsolete text;
- a human/model review separate from the proposer.

No automatic amendment may write directly to an active skill.

## Length invariant

A maintenance change should stay size-neutral or shrink. It may grow only when adding a new, tested capability that cannot live in a script or direct reference.

Prefer, in order:

1. delete obsolete or duplicated instructions;
2. replace prose with a decision rule;
3. move rare detail to a directly linked `references/` file;
4. move deterministic behavior into a script;
5. add concise body text only when judgment is required.

## Eval layers

- **Routing eval:** prompts that should and should not retrieve the skill; top-3 gate is at least 80%, with no critical miss.
- **Execution eval:** representative task/replay with expected artifacts and validation.
- **Adversarial eval:** ambiguous prompt, overlapping skill, stale setup, and failure path.
- **Weak-model eval:** test against the weakest model expected to use the skill.

Description edits require routing evals. Workflow edits require execution evals. Boundary changes require both.

## Promotion and retirement

- **Promote routing:** frequently searched/loaded with successful outcomes.
- **Improve:** frequently loaded with repeated causal failures.
- **Consolidate:** multiple skills compete for the same task and one router can own the boundary.
- **Hide from a harness:** useful elsewhere but irrelevant to that harness.
- **Retire:** no demand, duplicated capability, stale dependencies, or worse outcomes than the replacement.

Use `npm run propose:skill-maintenance` to generate evidence candidates. Treat the report as a queue for investigation, never as an automatic patch list.
