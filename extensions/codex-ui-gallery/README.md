# Codex UI Gallery Pi extension

High-quality native image gallery for `codex-ui-design` outputs inside the Pi TUI.

The gallery now uses Pi's native terminal image renderer in a **non-overlay** custom view, matching the pattern used by Pi's Antigravity image-generation example. This avoids the overlay compositor bug while keeping full-quality Kitty/Ghostty image rendering.

## Commands

```text
/codex-gallery [output-dir|summary.json|image-path]
/codex-image <image-path>  # open high-quality native image viewer in Pi
/codex-gallery-clear      # clear lingering terminal graphics if the terminal leaves a ghost image
```

If no path is provided, the extension looks for the newest `summary.json` under:

- `.codex-ui-design/`
- `.codex-imagegen/`
- `output/codex-app-imagegen/`

## Tool

The extension registers `show_codex_ui_gallery`, so the agent can open the gallery after image generation. When used as a tool, the selected image is also returned as a normal Pi image attachment, like the Antigravity image-generation example.

## Auto-open

When a bash tool run appears to invoke `codex-ui-design` / `codex-app-imagegen` and emits a `summary.json` path, the extension opens the gallery automatically.

Disable auto-open:

```bash
export PI_CODEX_GALLERY_AUTO=0
```

## Keys

- `←/→`, `j/k`, `n/p` — navigate
- `f` / `0` — fit full image to the visible terminal height
- `w` — fit width/detail mode, may exceed the visible height
- `+` / `-` — manual zoom
- `v` / `enter` — select current image and close
- `i` — toggle full prompt/revised prompt
- `o` — open selected image in the OS viewer
- `c` — copy selected image path on macOS
- `esc`, `q` — close
