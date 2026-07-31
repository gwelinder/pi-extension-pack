---
name: nextjs-ubs-review
description: Run a narrow Ultimate Bug Scanner review on changed Next.js server boundaries, API routes, middleware, and server actions, then validate candidates against source. Use for pre-PR review, security review, or reliability review of changed Next.js backend code. Do not use as a whole-monorepo scanner or as a substitute for tests and type checking.
---

# Changed Next.js server review with UBS

Use UBS as a candidate generator on the small part of a Next.js change where its JavaScript rules are most useful. A UBS count is not a finding until the source confirms it.

## Scope the scan

1. Read the repository instructions and inspect the current diff.
2. Resolve `scripts/scan.mjs` relative to this skill's directory.
3. From the repository root, choose one mode:

   ```bash
   node '<skill-dir>/scripts/scan.mjs'
   node '<skill-dir>/scripts/scan.mjs' --staged
   node '<skill-dir>/scripts/scan.mjs' --base origin/main
   ```

The wrapper selects changed JavaScript or TypeScript files at Next.js server boundaries:

- App Router `route.ts` or `route.js` files
- Pages Router `pages/api/**`
- `api`, `server`, `actions`, and `src/lib/server` paths
- `middleware.ts` or `server.ts`
- changed files containing a top-level `use server` directive

It refuses more than 200 files. If that happens, split the review by package or base range. Do not bypass the limit with a whole-repository UBS run.

## Validate every candidate

For each critical or warning candidate:

1. Open the cited file and surrounding call path.
2. Confirm that the reported input is reachable and that framework behavior does not already make it safe.
3. Check authentication, authorization, validation, data mutation, error handling, timeouts, and secrets at the actual boundary.
4. Run the project's normal typecheck, lint, and targeted tests where available.
5. Classify the candidate as confirmed, likely, dismissed false positive, or not verified.

Do not edit code when the user requested review only. When a fix is in scope, fix only source-confirmed issues and rerun the wrapper plus the relevant project checks.

## Report

Return:

1. Scanned files and comparison mode.
2. Confirmed findings, ordered by severity, with file and line evidence.
3. Likely findings that need runtime or product context.
4. Dismissed high-signal false positives and why they are safe.
5. Checks run and checks skipped.

If no applicable changed server files exist, report that narrow no-op. Do not expand automatically into client UI or the full monorepo.
