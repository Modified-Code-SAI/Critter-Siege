# Critter Siege (`Simple Game`) — Repository Master Context (`AGENTS.md`)

Browser-based 3D multiplayer PvP tactical artillery and hero-critter evolution game built with **Vite + TypeScript + Three.js** (`client/`), **Node + TypeScript + `ws`** (`server/`), and deterministic shared simulation/SDF modules (`shared/`).

## Mandatory Governance Rules

1. **Rule 1 — Repo Governance:** Keep `./AGENTS.md`, `./.gemini/settings.json`, `./.gemini/agents/`, and `./skills/` intact and up to date as tooling evolves.
2. **Rule 2 — Single-Edit Verification Loop (Zero Batching):**
   - After **every single code file edit** (`write_file` or `edit_file`), immediately run the full repository verification suite:
     ```powershell
     npm run verify
     ```
   - Report `PASS` or `FAIL` from `npm run verify` **before** touching any other file or proceeding to the next step. Never batch unverified code edits.
   - *(Bootstrap note: `npm run verify` becomes active as soon as Task 1 scaffolds `package.json`.)*
3. **Rule 3 — Subagent Enforcement:**
   - Route implementation through the `builder` subagent (`.gemini/agents/builder.md`).
   - Validate every completed diff through the isolated, strictly read-only `reviewer` subagent (`.gemini/agents/reviewer.md`) with zero shared memory from `builder`, checking against `## Do-Not Rules` and live `npm run verify` output.

---

## Build Commands

All commands run from the repository root (`c:\Users\austi\.gemini\antigravity\scratch\Simple Game`) using Node `v24+` and npm `11+`:

```powershell
# 1. Full Repository Verification Suite (Typecheck + Lint + Unit Tests + Production Build)
npm run verify

# 2. Individual Checks
npm run typecheck
npm run lint
npm test
npm run build

# 3. Local Development (WebSocket Server + Vite Three.js Client)
npm run dev:server
npm run dev:client
```

---

## Conventions

- **Workspace Architecture:** npm workspaces with three packages:
  - `shared/` — pure TypeScript (zero DOM/Three.js dependencies): types, species/mutation/gadget catalog, seeded 3D Signed Distance Field (SDF) island generator & chunked Surface Nets / Marching Cubes mesher, deterministic projectile/wind physics, authoritative turn state machine, and AI bot planner.
  - `server/` — Node + TypeScript + `ws` authoritative 4-letter room server, turn timers, reconnect carve-log replay, and disconnect bot-fallback.
  - `client/` — Vite + TypeScript + Three.js renderer, procedural sculpted species + bolt-on 3D hardpoint meshes, 4-mode camera rig (Over-the-Shoulder, First-Person Optic Visor, Tactical Drone Recon, Projectile Shot Cam), procedural WebAudio synth, HUD/lobby UI, local `localStorage` Siege Essence profile, and local Play-vs-Bots sandbox.
- **Visual Direction:** Smooth, organic, sculpted stylized 3D terrain via chunked SDF meshing (rounded grass hilltops, smooth terracotta/sandstone cliffs, natural stone arches, bowl craters, round tunnels, jagged low-poly rock shards) and expressive rounded woodland/burrowing species (**Tunnel Mole**, **Norway Rat**, **Ridge Badger**, **Glider Squirrel**, plus unlockable **Quill Hedgehog** & **Plated Armadillo**).
- **Code Quality:** Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), explicit return types on exported functions, clean modular files with single responsibility, deterministic seeded PRNG for island generation and tests.

---

## Do-Not Rules

- **DO NOT render blocky/Minecraft cube terrain:** Always mesh the 3D SDF density grid with smooth sculpted Surface Nets / Marching Cubes and spawn irregular rock shards on blasts.
- **DO NOT reference or copy external artillery franchises:** All branding, gear names (`Gale Mortar`, `Spore Burst`, `Quake Club`, `Burrow Bore`, `Vine Grapple`, `Seeker Firefly`), and copy must stay 100% original to **Critter Siege**.
- **DO NOT couple `shared/` to browser DOM or Three.js:** Keep `shared/` runnable in pure Node for server authority and fast Vitest unit tests.
- **DO NOT batch multiple unverified edits** once `npm run verify` exists; verify after every individual file edit.
- **DO NOT use `any` casts or silence linter/type errors** with `@ts-ignore` or `eslint-disable` without explicit justification.
- **DO NOT hardcode secrets, API keys, or external paid services.**

---

## Definition of Done

1. `npm run verify` exits with code `0` (`typecheck`, `lint`, `vitest`, and `build` all `PASS`).
2. All 5 Review Focus edge cases (SDF boundary carving, self-KO skipping retreat, 2v2 alternating turns after KO, disconnect bot-fallback + reconnect carve replay, deferred Evo Pod draft with full hardpoints) have passing automated tests.
3. Live browser playtest confirms smooth sculpted island rendering, all 4 camera modes, species selection, hardpoint mutation visual attachment, Play-vs-Bots sandbox, and 2-tab WebSocket room join.
4. Independent strictly read-only `reviewer` subagent audits the diff against `## Do-Not Rules` and live verification output (`Overall Verdict: PASS`).
