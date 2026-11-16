---
title: 'Skill gateway routed mode does not strip structured skill section'
severity: 'minor'
---

## Expected Behavior
Routed mode removes the native skill catalog.

## Current Behavior
2026-09-26 route telemetry: beforeChars=afterChars=72264, strippedChars=0, 109 visible skills.

## Possible Solution
Test an opt-in exact structured-section match; do not change defaults before task-quality evaluation.

## Minimal Reproducible Example
Build a current Pi system prompt, then test prompt.includes(formatSkillsForPrompt(skills)). Pi trims the formatter output, but the gateway searches for its leading newlines.

## Context
extras/skill-gateway/index.ts; installed Pi dist/core/system-prompt.js. Session 01a0de02-fb2a-72bb-848b-ba5815549deb.
