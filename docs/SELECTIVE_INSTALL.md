# Selective install

Pi supports package filters in `settings.json`, so users can load only selected extensions, skills, prompts, or themes from this public repo.

## Important behavior

- Filters control what Pi **loads**, not what git/npm downloads.
- `pi install git:github.com/gwelinder/pi-extension-pack` writes a simple string package entry, which loads the package defaults.
- To select specific resources, edit the package entry into object form in `~/.pi/agent/settings.json` or project `.pi/settings.json`.
- Omit a resource key to load all defaults of that type.
- Use `[]` to load none of that type.
- Filter paths are relative to the package root.

## Examples

### Gallery only

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "extensions": ["extensions/codex-ui-gallery/**"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

### Memory only

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "extensions": ["extensions/pi-memory-system/**"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

### Retired archives

Retired extensions are sunset and no longer part of package defaults. If you explicitly need to test one, load its archived path under `extras/retired/`.

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "extensions": ["extras/retired/pi-magic-docs/**"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

### Compact Exa search only

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "extensions": ["extensions/exa/**"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

### Rich content fetch only

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "extensions": ["extensions/rich-fetch/**"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

### CodeGraph only

Use this when you only want the Pi-native `codegraph` tool. The package installs `@colbymchenry/codegraph`; initialize each repo with `codegraph init -i` or ask Pi to run the tool's `init` action.

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "extensions": ["extensions/codegraph/**"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

### Frontend/UI workflow only

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "extensions": [
        "extensions/codex-ui-gallery/**",
        "extensions/duel-deck/**"
      ],
      "skills": [
        "skills/frontend-stack",
        "skills/codex-ui-design"
      ],
      "prompts": [],
      "themes": []
    }
  ]
}
```

### All extensions, no skills

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Because `extensions` is omitted here, all default extensions from the package manifest load.

### One extension file

```json
{
  "packages": [
    {
      "source": "git:github.com/gwelinder/pi-extension-pack",
      "extensions": ["extensions/finder-model-default.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Interactive alternative

Users can also install normally and then run Pi's config UI to disable resources:

```bash
pi install git:github.com/gwelinder/pi-extension-pack
pi config
```

The object-form filter is better for reproducible team/project settings.

## Extras and default-off resources

Pi filters narrow the package manifest. They are good for selecting among resources that the package manifest exposes.

This repo's `extras/` directory is intentionally **not** in the default manifest. If an extra should become user-installable without loading everything else, the clean options are:

1. promote it into a default manifest path and document filters; or
2. split it into a separate Pi package/repo; or
3. publish a small npm/git package for that one extension/skill.

For public UX, prefer split packages for large or niche optional bundles.
