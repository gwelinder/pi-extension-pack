# meta-muse

Registers the **Meta Model API** as a Pi provider with Muse Spark 1.3 models over the OpenAI-compatible Responses API.

## Models

| Model | Tier | Input | Cached input | Output | Notes |
|---|---|---|---|---|---|
| `muse-spark-1.3` | Standard | $1.25/M | $0.15/M | $4.25/M | Private tier; prompts not used for training |
| `muse-spark-1.3-contributor` | Contributor | $0.10/M | $0.002/M | $0.20/M | Heavily discounted; prompts/outputs may train Meta models |

Both models: 1,048,576-token context, image input, reasoning effort `minimal`–`xhigh` (no `off`/`max`).

## Auth

Resolution order:

1. **Muse Code subscription credential** from macOS Keychain (`security find-generic-password -s ai.meta.dev.credentials`). Muse Code onboarding provisions this key and it carries the flat-rate subscription instead of pay-as-you-go billing.
2. `MODEL_API_KEY` / `META_API_KEY` environment variables (pay-as-you-go).
3. `/login meta` inside Pi (stores an API key in `~/.pi/agent/auth.json`).

If a manually created API key was previously stored via `/login`, remove the stale `meta` entry from `auth.json` so the Keychain subscription credential wins, or keep it if you intentionally want pay-as-you-go.

## Usage

```bash
pi --provider meta --model muse-spark-1.3-contributor --thinking high
pi --provider meta --model muse-spark-1.3 --thinking xhigh
```

## Notes

- The subscription credential only exists after Muse Code CLI onboarding has run on the machine.
- Meta's subscription terms describe usage through the Muse Code CLI; this provider works technically because the subscription credential itself authorizes the Model API. Use at your own policy discretion.
