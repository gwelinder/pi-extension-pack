# Agent instructions

## Friction logging

- Run `frog list` before troubleshooting to see known repository friction.
- Log repository-specific papercuts as they happen with `frog log`.
- Keep global, system, harness, and cross-project friction out of this repository; log it with `frog log --cwd /Users/gfw/code/agent-friction`.
- Never create a title-only entry: use a short title, complete the body with real observations, and include a reproduction or artifact when practical.
