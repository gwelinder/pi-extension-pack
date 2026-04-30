---
name: video-prompting
description: "Use when writing or debugging prompts for AI video generation models like Gen-3 or Veo. Also triggers on: text-to-video, shot types, camera, scene."
disable-model-invocation: true
---

# Video Prompting

## Quick workflow

1. Gather constraints (ask if missing): **model**, **duration**, **aspect ratio**, **subject**, **action**, **setting**, **mood**, **style**, **camera**, **lighting**.
2. Write **one scene per prompt** using the structure formula below.
3. Ensure the prompt includes **motion** (action and/or camera movement) and **lighting**.
4. Sanity-check for contradictions (e.g., clashing styles) and remove anything non-essential.

## Prompt structure formula

**Formula:**

`[Shot Type] + [Subject] + [Action] + [Setting] + [Lighting] + [Style] + [Technical]`

> Camera movement is usually expressed in **Shot Type** (e.g., “handheld close-up”) or **Action** (e.g., “camera dolly-in”).

### Example breakdown

**Prompt**

> “Slow motion close-up of coffee being poured into a white ceramic cup, steam rising, morning sunlight streaming through window, warm color grading, cinematic, 4K, shallow depth of field”

**Fields**

- **Shot Type:** Slow motion close-up
- **Subject:** Coffee
- **Action:** Being poured
- **Setting:** White ceramic cup, window
- **Lighting:** Morning sunlight
- **Style:** Warm color grading, cinematic
- **Technical:** 4K, shallow depth of field

## Shot types

| Shot Type | Description | Use For |
|---|---|---|
| Wide shot | Shows entire scene | Establishing location |
| Medium shot | Waist-up framing | Conversations, actions |
| Close-up | Face or detail | Emotion, product detail |
| Extreme close-up | Single feature | Drama, texture |
| Aerial shot | Bird’s eye view | Landscapes, scale |
| Low angle | Camera looking up | Power, grandeur |
| High angle | Camera looking down | Vulnerability |
| Dutch angle | Tilted camera | Unease, tension |
| POV shot | First person view | Immersion |

## Camera movements

| Movement | Description | Effect |
|---|---|---|
| Tracking shot | Camera follows subject | Dynamic, engaging |
| Dolly in/out | Camera moves toward/away | Focus, reveal |
| Pan | Horizontal rotation | Survey scene |
| Tilt | Vertical rotation | Reveal height |
| Crane shot | Vertical + horizontal | Dramatic reveal |
| Handheld | Slight shake | Realism, urgency |
| Steadicam | Smooth following | Professional, cinematic |
| Zoom | Lens zoom in/out | Quick focus change |
| Static | No movement | Contemplation, stability |

## Lighting keywords

| Keyword | Effect |
|---|---|
| Golden hour | Warm, soft, romantic |
| Blue hour | Cool, moody, twilight |
| High key | Bright, minimal shadows |
| Low key | Dark, dramatic shadows |
| Rim lighting | Subject outlined with light |
| Backlit | Light from behind subject |
| Soft lighting | Gentle, flattering |
| Hard lighting | Sharp shadows, contrast |
| Neon | Colorful, urban, cyberpunk |
| Natural lighting | Realistic, documentary |

## Style keywords

### Cinematic styles

cinematic, film grain, anamorphic lens, letterbox, shallow depth of field, bokeh, 35mm film, color grading, theatrical

### Visual aesthetics

minimalist, maximalist, vintage, retro, futuristic, cyberpunk, steampunk, noir, pastel, vibrant, muted colors, high contrast, desaturated

### Quality keywords

4K, 8K, high resolution, photorealistic, hyperrealistic, ultra detailed, professional, broadcast quality, HDR

## Common mistakes to avoid

| Mistake | Problem | Better approach |
|---|---|---|
| Too vague | “A nice video” | Specify shot, subject, style |
| Too complex | Multiple scenes | One scene per prompt |
| No motion | Static description | Include camera movement or action |
| Conflicting styles | “Minimalist maximalist” | Choose one aesthetic |
| No lighting | Undefined mood | Specify lighting conditions |

## Model-specific tips

### Google Veo

- Excels at realistic, cinematic content
- Supports audio generation (Veo 3+)
- Best with detailed, professional prompts
- Frame interpolation available in 3.1

### Seedance

- Strong at dance and human motion
- First-frame control available
- Good for consistent character motion
- Works well with reference images

### Wan 2.5

- Best for image-to-video
- Animates still images naturally
- Good motion prediction
- Works with any image style

### Grok

- Good general-purpose video
- Configurable duration (5–10s)
- Creative interpretations
- Works well with abstract concepts
