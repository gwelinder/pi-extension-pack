# Harness prompt-surface audit

Generated: 2026-07-14T11:31:36.623Z

## Installed harnesses

| Harness | Version |
| --- | --- |
| Pi | 0.80.6 |
| Claude Code | 2.1.209 (Claude Code) |
| Codex | codex-cli 0.144.0 |
| Hermes | Hermes Agent v0.16.0 (2026.6.5) · upstream 57775e9e · local 0d74de48 (+2 carried commits) Project: ~/.hermes/hermes-agent Python: 3.11.14 OpenAI SDK: 2 |
| OpenClaw | OpenClaw 2026.6.1 (2e08f0f) |

## Measured Pi provider payloads

Measurements come from `before_provider_request`; no prompt or user text is retained, only counts. Compare probes using the same model/tool profile.

| Mode | Catalog | Native visible | Active tools | Prompt before | Prompt after | Skill chars removed | Route chars | Provider system chars | Provider tools | Tool schema chars |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| routed | 162 | 55 | 12 | 55287 | 23751 | 31995 | 457 | 23751 | 12 | 13724 |
| routed | 162 | 55 | 8 | 53563 | 22060 | 31995 | 490 | 22060 | 8 | 9105 |
| routed | 162 | 55 | 10 | 55038 | 23492 | 31995 | 447 | 24253 | 10 | 31755 |
| routed | 162 | 55 | 10 | 54449 | 22912 | 31995 | 456 | 23242 | 10 | 31755 |
| routed | 162 | 55 | 12 | 55279 | 23732 | 31995 | 446 | 23732 | 12 | 13507 |
| routed | 162 | 55 | 11 | 54015 | 22466 | 31995 | 444 | 22466 | 11 | 13457 |
| routed | 162 | 55 | 12 | 54361 | 22839 | 31995 | 471 | 22839 | 12 | 32151 |
| routed | 162 | 55 | 8 | 53601 | 21606 | 31995 | 0 | 21606 | 8 | 9105 |
| routed | 162 | 55 | 13 | 55437 | 23442 | 31995 | 0 | 23442 | 13 | 16658 |
| routed | 162 | 55 | 5 | 34753 | 2758 | 31995 | 0 | 2758 | 5 | 3376 |

A matched observe/routed pair saved **31,995 provider-system characters** in routed mode.
The routed lean 8-tool surface used **7,553 fewer tool-schema characters** than the measured 13-tool surface.

## Measured non-Pi probes

| Harness | Model | System chars/bytes | Skill chars/bytes | Skills | Tool chars/bytes | Tools | Input/prompt tokens | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | claude-fable-5 | not exposed | not exposed | not exposed | not exposed | not exposed | 18749 | Actual one-turn usage with tools disabled; Claude did not expose a stable skill-only breakdown. |
| codex | default | not exposed | not exposed | not exposed | not exposed | not exposed | 22234 | Actual one-turn usage. Codex emitted a warning that skill descriptions were shortened to its 2% skill-context budget. |
| hermes | gpt-5.5 | 32906 | 18471 | not exposed | 59252 | 42 | not exposed | Harness-native prompt-size report; no model call. |
| openclaw | openai/gpt-5.5 | 25918 | 8699 | 60 | 8781 | 17 | 26966 | Actual one-turn embedded-agent report from meta.systemPromptReport. |

These probes use each harness's own reporting/usage output. They are not directly comparable across models because providers count cached input and tool schemas differently. Claude and Codex expose total initial usage but not a stable skill-only breakdown; do not infer skill cost from those totals alone.
