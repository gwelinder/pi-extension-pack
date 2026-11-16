---
title: 'Skill routing quality gate fails on current catalog'
severity: 'minor'
---

## Expected Behavior
The routing evaluation meets its configured 80% top-three threshold before catalog offloading is enabled.

## Current Behavior
2026-09-26 pnpm test:skill-gateway: core tests PASS; routing eval 30/40 (75%), gate failed. Missing or renamed expected skills include ab-test-setup and next-best-practices; valid skills such as pptx also miss top three.

## Possible Solution
Refresh stale fixtures against approved catalog, then improve and validate retrieval without lowering the gate. Keep structured skill stripping disabled meanwhile.

## Minimal Reproducible Example
pnpm test:skill-gateway

## Context
No routing/scoring or policy changes were made in this audit. The new structured-strip experiment defaults off.
