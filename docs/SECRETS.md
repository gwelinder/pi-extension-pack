# Secrets and machine-local state

This repo is the source of truth for Pi resources, **not** for credentials or runtime state.

## Never commit

- `~/.pi/agent/auth.json`
- raw `~/.pi/agent/settings.json`
- raw `~/.pi/agent/extensions/cloudflare-codemode.json`
- provider API keys, OAuth tokens, ChatGPT/Codex auth, Cloudflare tokens
- sessions, run history, logs, notebooks, generated images, caches
- memory files unless you intentionally export a sanitized subset

## Commit examples instead

Use example files with placeholders:

- `docs/bootstrap-settings.minimal.example.json`
- `docs/bootstrap-settings.full-skills.example.json`
- `docs/cloudflare-codemode.example.json`

## Pre-commit check

Run:

```bash
npm run check:secrets
```

The checker blocks obvious credential files and common token patterns. It is a guardrail, not a substitute for review.

## Cloudflare Codemode

Store the token in your shell environment or macOS keychain-backed shell setup, not in git:

```bash
export CF_CODEMODE_URL="https://cloudflare-codemode-worker.<you>.workers.dev"
export CF_CODEMODE_TOKEN="..."
```

Then use config like:

```json
{
  "baseUrl": "https://cloudflare-codemode-worker.<you>.workers.dev",
  "tokenEnvVar": "CF_CODEMODE_TOKEN",
  "timeoutMs": 120000,
  "requireApplyConfirmation": true,
  "blockApplyWithoutUI": true,
  "promptInjectionMode": "lazy",
  "auditWidget": false
}
```
