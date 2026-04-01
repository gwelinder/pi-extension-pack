#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME}"
MANAGED_ROOT="${COGNEE_MANAGED_SKILL_ROOT:-$HOME_DIR/.pi/agent/skills-managed/active}"

mkdir -p "$MANAGED_ROOT"

link_skill() {
  local name="$1"
  local skill_md="$2"

  if [[ ! -f "$skill_md" ]]; then
    echo "[WARN] missing SKILL.md for $name: $skill_md" >&2
    return 0
  fi

  local abs_skill_md
  abs_skill_md="$(cd "$(dirname "$skill_md")" && pwd)/$(basename "$skill_md")"
  local target="$MANAGED_ROOT/$name"

  if [[ -e "$target" || -L "$target" ]]; then
    rm -rf "$target"
  fi

  mkdir -p "$target"
  ln -s "$abs_skill_md" "$target/SKILL.md"
  echo "[LINK] $name"
}

# ── Video / Media ──
link_skill "fal-generate"         "$HOME_DIR/.agents/skills/fal-generate/SKILL.md"
link_skill "ffmpeg"               "$HOME_DIR/.pi/agent/skills/ffmpeg/SKILL.md"
link_skill "kling-v2v"            "$HOME_DIR/.pi/agent/skills/kling-v2v/SKILL.md"
link_skill "ltx-video"            "$HOME_DIR/.pi/agent/skills/ltx-video/ltx-video/SKILL.md"
link_skill "ai-video-vfx"        "$HOME_DIR/.pi/agent/skills/New Folder With Items/ai-video-vfx/SKILL.md"
link_skill "gemini-film-analysis" "$HOME_DIR/.pi/agent/skills/New Folder With Items/gemini-film-analysis/gemini-film-analysis/SKILL.md"

# ── Infrastructure ──
link_skill "wrangler"             "$HOME_DIR/.pi/agent/skills/wrangler/SKILL.md"
link_skill "cloudflare"           "$HOME_DIR/.pi/agent/skills/cloudflare/SKILL.md"
link_skill "browser-tools"        "$HOME_DIR/.pi/agent/skills/pi-skills/browser-tools/SKILL.md"
link_skill "brave-search"         "$HOME_DIR/.pi/agent/skills/pi-skills/brave-search/SKILL.md"
link_skill "foreground-chains"    "$HOME_DIR/.pi/agent/skills/foreground-chains/SKILL.md"
link_skill "codex-cli"            "$HOME_DIR/.pi/agent/skills/codex-cli/SKILL.md"
link_skill "codex-5-3-prompting"  "$HOME_DIR/.pi/agent/skills/codex-5-3-prompting/SKILL.md"
link_skill "gpt-5-4-prompting"    "$HOME_DIR/.pi/agent/skills/gpt-5-4-prompting/SKILL.md"
link_skill "worker-reviewer-dispatch" "$HOME_DIR/.pi/agent/skills/worker-reviewer-dispatch/SKILL.md"

# ── Design Engineering ──
link_skill "frontend-design"      "$HOME_DIR/.pi/agent/skills/frontend-design/SKILL.md"
link_skill "emil-design-eng"      "$HOME_DIR/.pi/agent/skills/emil-design-eng/SKILL.md"
link_skill "make-interfaces-feel-better" "$HOME_DIR/.pi/agent/skills/make-interfaces-feel-better/SKILL.md"
link_skill "teach-impeccable"     "$HOME_DIR/.pi/agent/skills/teach-impeccable/SKILL.md"
link_skill "web-design-guidelines" "$HOME_DIR/.pi/agent/skills/web-design-guidelines/SKILL.md"
link_skill "userinterface-wiki"   "$HOME_DIR/.pi/agent/skills/userinterface-wiki/SKILL.md"

# ── Design Ops (polish/refine) ──
link_skill "adapt"                "$HOME_DIR/.pi/agent/skills/adapt/SKILL.md"
link_skill "delight"              "$HOME_DIR/.pi/agent/skills/delight/SKILL.md"
link_skill "distill"              "$HOME_DIR/.pi/agent/skills/distill/SKILL.md"
link_skill "extract"              "$HOME_DIR/.pi/agent/skills/extract/SKILL.md"
link_skill "polish"               "$HOME_DIR/.pi/agent/skills/polish/SKILL.md"
link_skill "animate"              "$HOME_DIR/.pi/agent/skills/animate/SKILL.md"
link_skill "audit"                "$HOME_DIR/.pi/agent/skills/audit/SKILL.md"
link_skill "bolder"               "$HOME_DIR/.pi/agent/skills/bolder/SKILL.md"
link_skill "clarify"              "$HOME_DIR/.pi/agent/skills/clarify/SKILL.md"
link_skill "colorize"             "$HOME_DIR/.pi/agent/skills/colorize/SKILL.md"
link_skill "critique"             "$HOME_DIR/.pi/agent/skills/critique/SKILL.md"
link_skill "harden"               "$HOME_DIR/.pi/agent/skills/harden/SKILL.md"
link_skill "normalize"            "$HOME_DIR/.pi/agent/skills/normalize/SKILL.md"
link_skill "onboard"              "$HOME_DIR/.pi/agent/skills/onboard/SKILL.md"
link_skill "optimize"             "$HOME_DIR/.pi/agent/skills/optimize/SKILL.md"
link_skill "quieter"              "$HOME_DIR/.pi/agent/skills/quieter/SKILL.md"

# ── React / Next.js ──
link_skill "vercel-composition-patterns"   "$HOME_DIR/.pi/agent/skills/vercel-composition-patterns/SKILL.md"
link_skill "vercel-react-best-practices"   "$HOME_DIR/.pi/agent/skills/vercel-react-best-practices/SKILL.md"
link_skill "next-best-practices"           "$HOME_DIR/.pi/agent/skills/next-best-practices/SKILL.md"

# ── Copywriting / Content ──
link_skill "copywriting"          "$HOME_DIR/.agents/skills/copywriting/SKILL.md"
link_skill "copy-editing"         "$HOME_DIR/.agents/skills/copy-editing/SKILL.md"
link_skill "content-strategy"     "$HOME_DIR/.agents/skills/content-strategy/SKILL.md"

# ── SEO / Growth ──
link_skill "seo-audit"            "$HOME_DIR/.pi/agent/skills/seo-audit/SKILL.md"
link_skill "ai-seo"               "$HOME_DIR/.agents/skills/ai-seo/SKILL.md"
link_skill "programmatic-seo"     "$HOME_DIR/.agents/skills/programmatic-seo/SKILL.md"
link_skill "analytics-tracking"   "$HOME_DIR/.agents/skills/analytics-tracking/SKILL.md"

# ── CRO / Conversion ──
link_skill "page-cro"             "$HOME_DIR/.agents/skills/page-cro/SKILL.md"
link_skill "form-cro"             "$HOME_DIR/.agents/skills/form-cro/SKILL.md"
link_skill "popup-cro"            "$HOME_DIR/.agents/skills/popup-cro/SKILL.md"
link_skill "onboarding-cro"       "$HOME_DIR/.agents/skills/onboarding-cro/SKILL.md"
link_skill "paywall-upgrade-cro"  "$HOME_DIR/.agents/skills/paywall-upgrade-cro/SKILL.md"
link_skill "ab-test-setup"        "$HOME_DIR/.agents/skills/ab-test-setup/SKILL.md"

# ── Marketing ──
link_skill "ad-creative"          "$HOME_DIR/.agents/skills/ad-creative/SKILL.md"
link_skill "cold-email"           "$HOME_DIR/.agents/skills/cold-email/SKILL.md"
link_skill "competitor-alternatives" "$HOME_DIR/.agents/skills/competitor-alternatives/SKILL.md"
link_skill "launch-strategy"      "$HOME_DIR/.agents/skills/launch-strategy/SKILL.md"
link_skill "marketing-ideas"      "$HOME_DIR/.agents/skills/marketing-ideas/SKILL.md"
link_skill "marketing-psychology" "$HOME_DIR/.agents/skills/marketing-psychology/SKILL.md"
link_skill "paid-ads"             "$HOME_DIR/.agents/skills/paid-ads/SKILL.md"
link_skill "product-marketing-context" "$HOME_DIR/.agents/skills/product-marketing-context/SKILL.md"

# ── Retention / Monetization ──
link_skill "churn-prevention"     "$HOME_DIR/.agents/skills/churn-prevention/SKILL.md"
link_skill "pricing-strategy"     "$HOME_DIR/.agents/skills/pricing-strategy/SKILL.md"
link_skill "referral-program"     "$HOME_DIR/.agents/skills/referral-program/SKILL.md"
link_skill "free-tool-strategy"   "$HOME_DIR/.agents/skills/free-tool-strategy/SKILL.md"

# ── Signup ──
link_skill "signup-flow-cro"      "$HOME_DIR/.agents/skills/signup-flow-cro/SKILL.md"

# ── Sales & GTM ──
link_skill "revops"               "$HOME_DIR/.pi/agent/skills/revops/SKILL.md"
link_skill "sales-enablement"     "$HOME_DIR/.pi/agent/skills/sales-enablement/SKILL.md"

# ── SEO Architecture ──
link_skill "site-architecture"    "$HOME_DIR/.pi/agent/skills/site-architecture/SKILL.md"

echo ""
echo "[DONE] $(find "$MANAGED_ROOT" -name SKILL.md -type l | wc -l | tr -d ' ') skills linked into: $MANAGED_ROOT"

# ── Remaining active skills ──
link_skill "email-sequence"       "$HOME_DIR/.agents/skills/email-sequence/SKILL.md"
link_skill "social-content"       "$HOME_DIR/.agents/skills/social-content/SKILL.md"
link_skill "schema-markup"        "$HOME_DIR/.agents/skills/schema-markup/SKILL.md"
link_skill "runwayml"             "$HOME_DIR/.agents/skills/runwayml/SKILL.md"
link_skill "video-prompting"      "$HOME_DIR/.agents/skills/video-prompting/SKILL.md"
link_skill "video-understanding"  "$HOME_DIR/.pi/agent/skills/video-understanding/SKILL.md"
link_skill "visual-explainer"     "$HOME_DIR/.pi/agent/skills/visual-explainer/SKILL.md"
link_skill "pdf"                  "$HOME_DIR/.pi/agent/skills/pdf/SKILL.md"
link_skill "pptx"                 "$HOME_DIR/.pi/agent/skills/pptx/SKILL.md"
link_skill "voice-dna"            "$HOME_DIR/.pi/agent/skills/voice-dna/SKILL.md"
link_skill "ai-sdk"               "$HOME_DIR/.pi/agent/skills/ai-sdk/SKILL.md"
link_skill "supabase-postgres-best-practices" "$HOME_DIR/.agents/skills/supabase-postgres-best-practices/SKILL.md"
link_skill "skill-creator"        "$HOME_DIR/.pi/agent/skills/skill-creator/SKILL.md"
link_skill "qmd"                  "$HOME_DIR/.pi/agent/skills/qmd/SKILL.md"
link_skill "deep-think-swarm"     "$HOME_DIR/.pi/agent/skills/deep-think-swarm/SKILL.md"
link_skill "oracle-parallel-deepthink-tabs" "$HOME_DIR/.pi/agent/skills/oracle-parallel-deepthink-tabs/SKILL.md"
link_skill "arena-duel-dispatch"  "$HOME_DIR/.pi/agent/skills/arena-duel-dispatch/SKILL.md"
link_skill "wacli"                "$HOME_DIR/.pi/agent/skills/wacli/SKILL.md"
link_skill "autoresearch"         "$HOME_DIR/.pi/agent/skills/autoresearch/SKILL.md"
