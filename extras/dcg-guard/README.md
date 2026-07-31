# DCG guard for Pi

This opt-in extension sends shell commands through Destructive Command Guard before Pi executes them.

Covered paths:

- Pi's built-in `bash` tool
- direct `exec_command` and `process.start` calls
- static `tools.exec_command(...)`, `tools.process(...)`, and `tools.bash(...)` calls inside Code Mode

Code Mode command values must be static string literals. Dynamic command construction is blocked because Pi extension hooks cannot intercept nested Code Mode tools after dispatch. The scanner deliberately ignores comments, quoted strings, template literals, and regular expressions.

The guard fails closed if DCG is missing, times out, or returns an unreadable decision. Set `DCG_BIN` only when the executable is installed at a non-standard path.

Run `/dcg-status` in Pi to confirm that the extension and executable are available.

This remains an extra rather than a package default because it changes command-execution policy. Install it under `~/.pi/agent/extensions/dcg-guard/` or load it explicitly with `pi -e /absolute/path/to/index.ts`.
