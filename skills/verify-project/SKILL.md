---
name: verify-project
description: Run the complete Critter Siege verification suite (TypeScript typecheck, ESLint, Vitest unit tests, and Vite/server production build) and report PASS or FAIL.
---

# Verify Project Workflow (`verify-project`)

## Trigger Description

Invoke immediately after every single code file edit (Rule 2) and before submitting any task to the `reviewer` subagent.

## Numbered Steps

1. Run `npm run verify` from `c:\Users\austi\.gemini\antigravity\scratch\Simple Game`.
2. Confirm all four stages pass with exit code `0`:
   - `npm run typecheck` (strict `tsc --noEmit` across `shared`, `server`, `client`)
   - `npm run lint` (ESLint across all `.ts` files)
   - `npm test` (Vitest deterministic suite covering SDF, physics, match state machine, AI, and WebSocket room integration)
   - `npm run build` (Vite client bundle + server TypeScript emit)
3. Report `PASS` or `FAIL` with exact error output. If `FAIL`, stop and remediate before touching any other file.
