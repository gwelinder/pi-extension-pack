---
name: fal-generate
description: Generate images and videos using fal.ai AI models with queue support. Use when the user requests "Generate image", "Create video", "Make a picture of...", "Text to image", "Image to video", "Search models", or similar generation tasks.
disable-model-invocation: true
metadata:
  author: fal-ai
  version: "4.0.0"
---

# fal.ai Generate

Generate images and videos using state-of-the-art AI models on fal.ai.

**Default model: `fal-ai/nano-banana-2`** — best overall T2I, supports up to 4K resolution.

## Scripts

Scripts are at `<project>/.agents/skills/fal-generate/scripts/`:

| Script | Purpose |
|--------|---------|
| `generate.sh` | Generate images/videos (queue-based) |
| `upload.sh` | Upload local files to fal CDN |
| `search-models.sh` | Search and discover models |
| `get-schema.sh` | Get OpenAPI schema for any model |

## Quick Start — Nano Banana 2

```bash
GEN=.agents/skills/fal-generate/scripts/generate.sh

# Default: 1K, 16:9, JPEG
bash "$GEN" -p "A sunset over the Kalahari"

# 4K cinematic
bash "$GEN" -p "A sunset over the Kalahari" -r 4K -a 16:9

# Square portrait at 2K, PNG
bash "$GEN" -p "Studio portrait of a dancer" -r 2K -a 1:1 -f png

# Multiple images
bash "$GEN" -p "Concept art variations" -r 2K --num-images 4
```

### Nano Banana 2 Parameters

| Param | Flag | Options | Default |
|-------|------|---------|---------|
| Resolution | `-r`, `--resolution` | `0.5K`, `1K`, `2K`, `4K` | `1K` |
| Aspect ratio | `-a`, `--aspect-ratio` | `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16` | `16:9` |
| Output format | `-f`, `--output-format` | `jpeg`, `png`, `webp` | `jpeg` |
| Web search | — | Pass via direct API | `false` |

**4K tips:**
- 4K PNGs are 15–25MB. Use `-f jpeg` (default) for 4–6MB files.
- 4K generation takes ~80s (vs ~30s for 1K).
- For concept art iteration, use 1K first, then upres the winner to 4K.

### Direct API (for advanced params)

When the script doesn't expose a param, hit the queue API directly:

```bash
curl -s -X POST "https://queue.fal.run/fal-ai/nano-banana-2" \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "...",
    "resolution": "4K",
    "aspect_ratio": "16:9",
    "output_format": "jpeg",
    "num_images": 1,
    "enable_web_search": false
  }'
# Returns: { "request_id": "...", "status_url": "..." }
# Poll status_url until COMPLETED, then GET response_url
```

## Nano Banana 2 Edit (Image-to-Image with Reference Images)

**Endpoint: `fal-ai/nano-banana-2/edit`** — multimodal image generation using reference images for style, setting, costume, and content guidance. Dramatically better visual consistency than pure T2I when you have reference material.

Also available: `fal-ai/nano-banana-pro/edit` (previous gen, still good).

> **When to use edit vs T2I:** Use `/edit` whenever you have reference images (location photos, costume refs, mood boards, existing concept art). The model uses them as visual guides for lighting, color palette, costume details, architecture, and composition. Results are significantly more consistent across a series of generated images. Use T2I only for initial exploration with no visual references.

### Edit Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | **Yes** | Describe the new scene. Reference the input images explicitly (e.g., "Using these reference images as visual guides for...") |
| `image_urls` | string[] | **Yes** | Array of fal CDN URLs. Upload local files first with `upload.sh`. Supports multiple refs (tested up to 4). |
| `resolution` | enum | No | `0.5K`, `1K`, `2K`, `4K` (default: `1K`) |
| `aspect_ratio` | enum | No | Same options as T2I (default: `auto`) |
| `output_format` | enum | No | `jpeg`, `png`, `webp` (default: `png`) |
| `num_images` | int | No | 1–4 (default: `1`) |
| `limit_generations` | bool | No | Default: `true` for edit mode |

### Edit Workflow

**Step 1 — Upload reference images to fal CDN:**

```bash
UPLOAD=.agents/skills/fal-generate/scripts/upload.sh

URL1=$(bash "$UPLOAD" --file "refs/location.jpg" 2>/dev/null | tail -1)
URL2=$(bash "$UPLOAD" --file "refs/costume.jpg" 2>/dev/null | tail -1)
URL3=$(bash "$UPLOAD" --file "refs/mood.jpg" 2>/dev/null | tail -1)
```

**Step 2 — Submit to the `/edit` queue endpoint:**

```bash
curl -s -X POST "https://queue.fal.run/fal-ai/nano-banana-2/edit" \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Using these reference images as visual guides for the village setting, costume details, and cinematography — generate a new scene: [detailed scene description]",
    "image_urls": ["'"$URL1"'", "'"$URL2"'", "'"$URL3"'"],
    "resolution": "4K",
    "aspect_ratio": "16:9",
    "output_format": "jpeg"
  }'
# Returns: { "request_id": "abc123", "status_url": "...", ... }
```

**Step 3 — Poll status and fetch result:**

> ⚠️ **CRITICAL GOTCHA**: The status and result URLs use the path
> `/fal-ai/nano-banana-2/requests/{id}/status` — **WITHOUT** `/edit/` in the path.
> This is different from the submit URL. The response JSON `status_url` field is correct;
> if building URLs manually, drop `/edit/` from the polling path.

```bash
# Poll status (note: NO /edit/ in path)
curl -s "https://queue.fal.run/fal-ai/nano-banana-2/requests/${REQUEST_ID}/status" \
  -H "Authorization: Key $FAL_KEY"
# Returns: { "status": "IN_PROGRESS" | "COMPLETED" | "FAILED", ... }

# Fetch result when COMPLETED (note: NO /edit/ in path)
curl -s "https://queue.fal.run/fal-ai/nano-banana-2/requests/${REQUEST_ID}" \
  -H "Authorization: Key $FAL_KEY"
# Returns: { "images": [{ "url": "https://v3b.fal.media/...", ... }], ... }
```

### Full Edit Example (Multi-Reference, 4K)

```bash
source .env  # loads FAL_KEY
UPLOAD=.agents/skills/fal-generate/scripts/upload.sh

# 1. Upload references
VILLAGE=$(bash "$UPLOAD" --file "refs/village-kgotla.jpg" 2>/dev/null | tail -1)
COSTUME=$(bash "$UPLOAD" --file "refs/blue-leteisi.jpg" 2>/dev/null | tail -1)
TRAILER=$(bash "$UPLOAD" --file "refs/cattle-trailer.jpg" 2>/dev/null | tail -1)

# 2. Submit edit job
RESP=$(curl -s -X POST "https://queue.fal.run/fal-ai/nano-banana-2/edit" \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Using these reference images as visual guides for the village setting, the metal cage livestock trailer, and women costume — create a cinematic wide shot of...",
    "image_urls": ["'"$VILLAGE"'", "'"$COSTUME"'", "'"$TRAILER"'"],
    "resolution": "4K",
    "aspect_ratio": "16:9",
    "output_format": "jpeg"
  }')
RID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['request_id'])")

# 3. Poll until done (4K takes ~80s)
while true; do
  S=$(curl -s "https://queue.fal.run/fal-ai/nano-banana-2/requests/$RID/status" \
    -H "Authorization: Key $FAL_KEY" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  echo "$S"
  [ "$S" = "COMPLETED" ] && break
  [ "$S" = "FAILED" ] && echo "FAILED" && exit 1
  sleep 10
done

# 4. Fetch result
IMG=$(curl -s "https://queue.fal.run/fal-ai/nano-banana-2/requests/$RID" \
  -H "Authorization: Key $FAL_KEY" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['images'][0]['url'])")
curl -sL "$IMG" -o "output/scene-4k.jpg"
```

### Multi-Reference Tips

- **More refs = better consistency.** Use 2–4 images covering location, costume, props, and mood.
- **Name what each ref provides** in the prompt: "Using image 1 for the village architecture, image 2 for the costume colors, image 3 for the trailer design..."
- **Mix AI-generated + real photos.** An existing concept art piece + real location photos + costume reference photos all work together.
- **4K edit takes ~60–80s** (vs ~30s at 1K). Use JPEG output to keep files at 3–6MB instead of 15–25MB PNGs.
- The `generate.sh` script does **not** support the `/edit` endpoint — use direct curl as shown above.

### Edit Model Variants

| Model | Category | Notes |
|-------|----------|-------|
| **`fal-ai/nano-banana-2/edit`** | image-to-image | **Best overall.** Latest model, supports 0.5K–4K, multi-ref. |
| `fal-ai/nano-banana-pro/edit` | image-to-image | Previous gen. Still good quality. |
| `fal-ai/nano-banana/edit` | image-to-image | Original. Basic editing. |
| `fal-ai/gemini-3.1-flash-image-preview/edit` | image-to-image | Alias for nano-banana-2/edit |
| `fal-ai/gemini-3-pro-image-preview/edit` | image-to-image | Alias for nano-banana-pro/edit |

## Queue System (Default)

```
User Request → Queue Submit → Poll Status → Get Result
                   ↓
              request_id
```

All requests queue by default. Long tasks (video, 4K) won't timeout.

## Other Models

### Text-to-Image

| Model | Notes |
|-------|-------|
| **`fal-ai/nano-banana-2`** | **Default. Best overall.** Supports 0.5K–4K, JPEG/PNG/WebP, aspect ratios. |
| `fal-ai/nano-banana-pro` | Previous gen — still good quality |
| `fal-ai/flux-2-turbo` | Open source, high quality |
| `fal-ai/flux/dev` | Good balance, uses `image_size` not `resolution` |
| `fal-ai/flux/schnell` | ~1 second |
| `fal-ai/ideogram/v3` | Best for text rendering |

### Image-to-Image (Edit with Reference Images)

| Model | Notes |
|-------|-------|
| **`fal-ai/nano-banana-2/edit`** | **Best for reference-guided generation.** Multi-ref, 0.5K–4K. See [Edit section](#nano-banana-2-edit-image-to-image-with-reference-images) above. |
| `fal-ai/nano-banana-pro/edit` | Previous gen edit. Good quality. |
| `fal-ai/nano-banana/edit` | Original edit model. Basic. |

### Text-to-Video

| Model | Notes |
|-------|-------|
| `fal-ai/veo3.1` | High quality |
| `fal-ai/bytedance/seedance/v1/pro` | Fast, good quality |
| `fal-ai/sora-2/pro` | OpenAI Sora |
| `fal-ai/kling-video/v2.5-turbo/pro` | Fast, reliable |

### Image-to-Video

| Model | Notes |
|-------|-------|
| `fal-ai/kling-video/v2.6/pro/image-to-video` | **Best overall** |
| `fal-ai/veo3/fast` | Fast, high quality |
| `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` | Smooth motion |

## Arguments Reference

| Argument | Description | Default |
|----------|-------------|---------|
| `--prompt`, `-p` | Text description | (required) |
| `--model`, `-m` | Model ID | `fal-ai/nano-banana-2` |
| `--resolution`, `-r` | `0.5K`, `1K`, `2K`, `4K` (nano-banana) | `1K` |
| `--aspect-ratio`, `-a` | `16:9`, `3:2`, `1:1`, etc (nano-banana) | `16:9` |
| `--output-format`, `-f` | `jpeg`, `png`, `webp` (nano-banana) | `jpeg` |
| `--image-url` | Input image URL for I2V | - |
| `--file`, `--image` | Local file (auto-uploads) | - |
| `--size` | `square`, `portrait`, `landscape` (flux models) | `landscape_4_3` |
| `--num-images` | Number of images | 1 |

**Mode Options:**
| Argument | Description |
|----------|-------------|
| (default) | Queue mode - submit and poll until complete |
| `--async` | Submit to queue, return request_id immediately |
| `--sync` | Synchronous (not recommended for video/4K) |
| `--logs` | Show generation logs while polling |

**Queue Operations:**
| Argument | Description |
|----------|-------------|
| `--status ID` | Check status of a queued request |
| `--result ID` | Get result of a completed request |
| `--cancel ID` | Cancel a queued request |

**Advanced:**
| Argument | Description | Default |
|----------|-------------|---------|
| `--poll-interval` | Seconds between status checks | 2 |
| `--timeout` | Max seconds to wait | 600 |
| `--lifecycle N` | Object expiration in seconds | - |
| `--schema [MODEL]` | Get OpenAPI schema | - |

## File Upload

```bash
# Auto-upload local file
bash generate.sh --file "/path/to/photo.jpg" \
  --model "fal-ai/kling-video/v2.6/pro/image-to-video" \
  --prompt "Camera zooms in slowly"

# Or manual upload
URL=$(bash upload.sh --file "/path/to/photo.jpg")
bash generate.sh --image-url "$URL" --model "..." --prompt "..."
```

## Async Mode (Video / Long Jobs)

```bash
# Submit and return immediately
bash generate.sh -p "Epic scene" -m fal-ai/veo3.1 --async
# → Request ID: abc123-def456

# Check later
bash generate.sh --status "abc123-def456" -m fal-ai/veo3.1
bash generate.sh --result "abc123-def456" -m fal-ai/veo3.1
```

## Search Models & Schema

```bash
bash search-models.sh --query "nano-banana"
bash search-models.sh --category "text-to-video"

bash get-schema.sh --model "fal-ai/nano-banana-2" --input
```

## Troubleshooting

- **Timeout on 4K**: Increase `--timeout 300` or use `--async`
- **FAL_KEY not set**: Run `./generate.sh --add-fal-key` or `export FAL_KEY=...`
- **Large 4K files**: Use `--output-format jpeg` (default) instead of PNG
