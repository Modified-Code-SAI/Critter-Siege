# Critter Siege Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build **Critter Siege**, a quick-join 2–4 player 3D browser PvP tactical artillery and hero-critter evolution game with smooth sculpted destructible SDF islands, 4 selectable woodland/burrowing species, 4 physical 3D hardpoint mutation slots, a 4-mode camera rig, a lightweight Node WebSocket room server, and an instant local Play-vs-Bots sandbox.

**Architecture:** An npm-workspace TypeScript monorepo (`shared/`, `server/`, `client/`) where `shared/` owns deterministic game data, seeded 3D Signed Distance Field (SDF) terrain generation + chunked Surface Nets meshing, projectile/wind physics, authoritative turn state machine, and AI bot planner; `server/` wraps that engine in a lightweight `ws` 4-letter room server with reconnect carve-log replay; and `client/` renders smooth sculpted Three.js islands, procedural species + bolt-on hardpoint meshes, 4 cameras, procedural WebAudio SFX, HUD/lobby UI, and `localStorage` Siege Essence progression.

**Tech Stack:** Node `v24.19.0`, npm `11.17.0` workspaces, TypeScript 5 (strict), Vite, Three.js, `ws`, Vitest, ESLint.

**Spec:** [critter_siege_design.md](file:///C:/Users/austi/.gemini/antigravity/brain/467d3a88-c3cd-4ea8-a53d-a9279960eca6/critter_siege_design.md)

## Global Constraints

- **Workspace Root:** `c:\Users\austi\.gemini\antigravity\scratch\Simple Game`
- **Visual Style:** Smooth sculpted 3D SDF terrain via chunked Surface Nets / Marching Cubes (`48 x 28 x 48` grid at `0.5m` spacing, `16 x 16 x 16` chunks, `<4 ms` chunk re-mesh) — strictly zero blocky/Minecraft cubes.
- **Original Identity:** 100% original **Critter Siege** branding, gear (`Gale Mortar`, `Quake Club`, `Vine Grapple`, `Spore Burst`, `Burrow Bore`, `Seeker Firefly`, plus Bonus Lobby Gadgets `Gravity Mine`, `Prism Wall`, `Shock Magnet`), and species (**Tunnel Mole**, **Norway Rat**, **Ridge Badger**, **Glider Squirrel**, plus unlockable **Quill Hedgehog** & **Plated Armadillo**).
- **Mode & Hero Rules:** Pure PvP (2–4 players, FFA or 2v2, `0–3` AI bots), 1 persistent evolving Hero Critter per player (`100` base HP), 3-round escalation (`15s` Active -> dynamic Shot Cam + `1.2s` settle -> `5s` Retreat), rising ocean `+0.5m/turn` from Turn 4+, Spectator Drone wind-nudge on early KO.
- **Zero Signup:** Local `localStorage` (`critter_siege_profile_v1`) for Siege Essence unlocks; `sessionStorage` tab `reconnectToken` for mid-match refreshes.
- **Verification Discipline:** After every single code file edit, run `npm run verify` (`typecheck` + `lint` + `vitest` + `build`) and confirm `PASS` before proceeding.

## Review Focus

1. **SDF Boundary Carve Safety:** Carving a sphere or tunnel overlapping grid edges (`0` or `47`/`27`) must clamp cleanly without out-of-bounds memory writes or `NaN` vertices/normals in chunk meshing *(pinned in Task 3)*.
2. **Self-KO & Simultaneous KO During `RESOLVING`:** If the firing critter knocks itself into water or `0 HP`, the state machine must skip `RETREAT`, award `0` self-KO points, and resolve round end cleanly *(pinned in Task 4)*.
3. **2v2 Alternating Turns After Early KO:** When one team loses a player (leaving 1v2), the turn queue must still strictly alternate Team A / Team B rather than granting back-to-back turns *(pinned in Task 4)*.
4. **Mid-Round 100% Evo Charge & Full 4 Hardpoints:** Collecting an Evo Pod during `ACTIVE` must queue the 1-of-3 draft to turn-end (never pausing/breaking the 15s timer), and drafting when all 4 hardpoint slots are occupied must offer swap cards and recalculate Apex synergies without leaking Three.js sub-meshes *(pinned in Tasks 4 & 6)*.
5. **Mid-Turn Disconnect & Reconnect Terrain Fidelity:** If the active player disconnects mid-turn, a `15s` grace timer triggers an AI bot turn so the lobby never stalls, and reconnecting with `reconnectToken` replays the exact seed + `{ center, radius, shape }` carve log so terrain matches 100% *(pinned in Task 5)*.

---

## File Structure Map

```text
Simple Game/
  AGENTS.md                                  (Bootstrap complete)
  .gemini/settings.json                      (Bootstrap complete)
  .gemini/agents/{builder,reviewer}.md       (Bootstrap complete)
  skills/{verify-project,dev-playtest}/      (Bootstrap complete)
  package.json                               (Task 1: workspaces + verify script)
  tsconfig.base.json                         (Task 1: strict TS config)
  eslint.config.mjs                          (Task 1: flat ESLint config)
  vitest.config.ts                           (Task 1: shared + server + client unit tests)
  shared/src/
    types.ts                                 (Task 2: core domain & state types)
    catalog.ts                               (Task 2: species, hardpoints, mutations, apexes, gadgets)
    protocol.ts                              (Task 2: WebSocket message types & runtime validators)
    rng.ts                                   (Task 3: seeded deterministic PRNG)
    sdf.ts                                   (Task 3: 48x28x48 SDF island generator + carve ops)
    mesher.ts                                (Task 3: 16x16x16 chunked Surface Nets mesher)
    physics.ts                               (Task 4: wind-curved ballistics, tunnel bore, knockback)
    matchEngine.ts                           (Task 4: authoritative PvP turn/round/evo state machine)
    botAi.ts                                 (Task 4: AI critter tactical planner)
  server/src/
    roomManager.ts                           (Task 5: 4-letter rooms, timers, reconnect, bot fallback)
    index.ts                                 (Task 5: Node HTTP + ws server entrypoint)
  client/src/
    scene/worldScene.ts                      (Task 6: Three.js renderer, sky, lighting, rising ocean)
    scene/terrainRenderer.ts                 (Task 6: chunked BufferGeometry mesh manager & disposal)
    scene/critterMesh.ts                     (Task 6: 4 starter species + 2 unlockables + 4 hardpoint rigs)
    scene/vfx.ts                             (Task 6: jagged rock shards, blasts, wind ribbons, Evo Pods)
    game/cameraRig.ts                        (Task 7: Over-Shoulder, FPS Visor, Drone Recon, Shot Cam)
    game/inputController.ts                  (Task 7: WASD, jump/glide, RMB aim, Tab drone, charge fire)
    game/trajectoryPreview.ts                (Task 7: live 3D dotted wind-curved aiming arc)
    audio/synthAudio.ts                      (Task 7: procedural WebAudio SFX synthesizer)
    net/gameClient.ts                        (Task 8: WebSocket client + local Play-vs-Bots adapter)
    profile/progression.ts                   (Task 8: localStorage Siege Essence & unlocks)
    ui/hud.ts                                (Task 8: Lobby, HUD, Optic Visor, Drone overlay, Evo Draft)
    main.ts                                  (Task 8: application bootstrap & game loop)
```

---

### Task 1: Workspace Scaffold & Verification Harness

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/index.ts`
- Create: `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`, `client/src/main.ts`
- Test: `shared/test/smoke.test.ts`

**Interfaces:**
- Produces: Root scripts `npm run verify` (`npm run typecheck && npm run lint && npm test && npm run build`), `npm run dev:server`, `npm run dev:client`.

- [ ] **Step 1: Initialize git repo and write workspace manifests & strict configs**
  Create root `package.json` with workspaces `["shared", "server", "client"]`, dependencies (`three`, `@types/three`, `ws`, `@types/ws`, `vite`, `typescript`, `vitest`, `tsx`, `eslint`, `typescript-eslint`), `tsconfig.base.json` (`strict: true`, `noUncheckedIndexedAccess: true`), `eslint.config.mjs`, and `vitest.config.ts`.
- [ ] **Step 2: Install npm dependencies**
  Run: `npm install`
  Expected: Lockfile created, exit code `0`.
- [ ] **Step 3: Write smoke test and minimal entrypoints**
  Create `shared/test/smoke.test.ts` asserting `GAME_TITLE === "Critter Siege"`, minimal `shared/src/index.ts`, `server/src/index.ts`, `client/index.html`, `client/src/main.ts`.
- [ ] **Step 4: Verify full pipeline green**
  Run: `npm run verify`
  Expected: `typecheck`, `lint`, `vitest` (1 passed), and `build` all `PASS` (exit code `0`).
- [ ] **Step 5: Commit**
  `git init && git add -A && git commit -m "chore: bootstrap Critter Siege TypeScript workspace"`

---

### Task 2: Shared Catalog (Species, Mutations, Apexes, Gadgets) & Protocol Schemas

**Files:**
- Create: `shared/src/types.ts`
- Create: `shared/src/catalog.ts`
- Create: `shared/src/protocol.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/test/catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 workspace setup.
- Produces:
  - Types: `SpeciesId`, `HardpointSlot`, `MutationId`, `ApexId`, `GadgetId`, `ThemeId`, `GameMode`, `TurnPhase`, `CarveOp`, `Vec3`, `CritterState`, `EvoPodState`, `MatchState`, `ClientMessage`, `ServerMessage`.
  - Functions: `SPECIES_CATALOG`, `MUTATION_CATALOG`, `GADGET_CATALOG`, `computeCritterStats(species: SpeciesId, equipped: Partial<Record<HardpointSlot, MutationId>>): ComputedCritterStats`, `computeApexSynergy(equipped: Partial<Record<HardpointSlot, MutationId>>): ApexId | null`, `parseClientMessage(raw: unknown): ClientMessage | null`.

- [ ] **Step 1: Write failing catalog & protocol tests**
  In `shared/test/catalog.test.ts`, assert:
  - All 4 starter species (`mole`, `norway_rat`, `badger`, `glider_squirrel`) and 2 unlockable species (`hedgehog`, `armadillo`) exist with spec passives (`badger` base HP = `115`, others `100`).
  - All 8 mutations map to the 4 slots (`back`, `legs`, `offense`, `crest`).
  - `computeApexSynergy` triggers `sky_bomber` (`glider_wings` + `twin_pod`), `bastion_tank` (`bramble_shell` + `anchor_talons`), `tunnel_sapper` (`burrow_claws` + `spring_paws`/`aegis_crest`), `siege_sniper` (`twin_pod` + `optic_visor`), and `apex_hybrid` (any 3+ parts).
  - All 6 standard gadgets + 3 bonus gadgets exist with exact `turnEnding` flags (`vine_grapple` is `false`; weapons are `true`).
  - `parseClientMessage` accepts valid messages and rejects malformed payloads without throwing.
- [ ] **Step 2: Verify test fails**
  Run: `npx vitest run shared/test/catalog.test.ts`
  Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `types.ts`, `catalog.ts`, `protocol.ts`, and re-export from `shared/src/index.ts`**
  Run `npm run verify` after each file edit.
- [ ] **Step 4: Confirm green and commit**
  Run: `npm run verify` -> Expected: `PASS`. Commit `feat(shared): add species, mutation, gadget catalogs and WS protocol`.

---

### Task 3: Smooth Sculpted 3D SDF Island Generator & Chunked Surface Nets Mesher

**Files:**
- Create: `shared/src/rng.ts`
- Create: `shared/src/sdf.ts`
- Create: `shared/src/mesher.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/test/sdf_mesher.test.ts`

**Interfaces:**
- Consumes: `ThemeId`, `CarveOp`, `Vec3` from Task 2.
- Produces:
  - `SDF_DIMS = { nx: 48, ny: 28, nz: 48, voxelSize: 0.5, chunkSize: 16 } as const`
  - `class SdfWorld`: `constructor(seed: number, theme: ThemeId)`, `sample(x: number, y: number, z: number): number`, `sampleNormal(x: number, y: number, z: number): Vec3`, `applyCarve(op: CarveOp): string[]` (returns dirty chunk keys), `findSpawnPoints(count: number): Vec3[]`, `getSurfaceY(x: number, z: number): number | null`, `getCarveLog(): CarveOp[]`.
  - `meshChunkSurfaceNets(world: SdfWorld, cx: number, cy: number, cz: number): ChunkMeshData` returning `{ positions: Float32Array; normals: Float32Array; colors: Float32Array; indices: Uint32Array }`.

- [ ] **Step 1: Write failing SDF & Surface Nets tests (including Review Focus #1)**
  In `shared/test/sdf_mesher.test.ts`, assert:
  - Seeded generation is deterministic for `emerald_spire`, `canyon_arch`, and `twin_pillars`, producing solid land with arches/plateaus and 4 distinct valid spawn points above water.
  - `applyCarve({ center, radius: 2.5, shape: 'sphere' })` reduces solid density inside the blast and returns `1–4` dirty chunk keys.
  - `applyCarve({ center, end, radius: 1.2, shape: 'capsule' })` carves a passable 3D tunnel through a cliff while keeping roof density solid above it.
  - **Review Focus #1 (Boundary carve):** Carving at `(0, 0, 0)` and `(24, 14, 24)` clamps cleanly and `meshChunkSurfaceNets` produces zero `NaN` values in `positions`, `normals`, or `colors`.
  - Re-meshing a carved chunk completes in `<10 ms` in Node (verifying performance budget).
- [ ] **Step 2: Verify test fails**
  Run: `npx vitest run shared/test/sdf_mesher.test.ts` -> Expected: FAIL.
- [ ] **Step 3: Implement `rng.ts`, `sdf.ts`, and `mesher.ts`**
  Use smooth-min / smooth-max SDF primitives (ellipsoids, arch bridges, cliff pillars, organic fBm hills) so islands have smooth rounded contours; extract smooth indexed quads/triangles via Dual Surface Nets with SDF gradient normals and slope/altitude biome vertex colors (lush grass top, terracotta/sandstone cliffs, mossy stone arches, crystal seams). Run `npm run verify` after each file edit.
- [ ] **Step 4: Confirm green and commit**
  Run: `npm run verify` -> Expected: `PASS`. Commit `feat(shared): implement smooth sculpted SDF terrain and Surface Nets mesher`.

---

### Task 4: Ballistics, Knockback, Authoritative PvP Match Engine & AI Bot Planner

**Files:**
- Create: `shared/src/physics.ts`
- Create: `shared/src/matchEngine.ts`
- Create: `shared/src/botAi.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/test/matchEngine.test.ts`

**Interfaces:**
- Consumes: `SdfWorld`, `catalog.ts`, `types.ts` from Tasks 2–3.
- Produces:
  - `simulateTrajectory(world: SdfWorld, params: ShotParams, wind: Vec3): ShotSimulationResult` (returns sampled flight path for Shot Cam, impact point, carve ops, spore sub-blasts, and critter hits/knockbacks).
  - `class MatchEngine`: `create(config: MatchConfig): MatchEngine`, `applyMove(playerId, move)`, `applyUtility(playerId, action)` (`vine_grapple`, `sky_bomber_drop`), `applyFire(playerId, fire)` -> transitions `ACTIVE -> RESOLVING`, `completeResolving()` -> transitions to `RETREAT` (or skips if shooter KO'd), `applyRetreatBurrow(playerId, dir)`, `applyDroneNudge(playerId, windDelta)`, `applyMutationPick(playerId, mutationId, replaceSlot?)`, `tick(dtMs: number): EngineEvent[]`, `getSnapshot(): MatchState`.
  - `planBotTurn(state: MatchState, world: SdfWorld, botId: string): BotPlan` (computes move/aim/gadget shot accounting for wind and ledges).

- [ ] **Step 1: Write failing match engine & physics tests (including Review Focus #2, #3, #4)**
  In `shared/test/matchEngine.test.ts`, assert:
  - Wind bends `gale_mortar` trajectories deterministically; `burrow_bore` tunnels `0.6s` into rock before detonating; `spore_burst` spawns 5 secondary blasts; `quake_club` deals high knockback with tiny carve.
  - `vine_grapple` does NOT end `ACTIVE` phase; firing `gale_mortar` immediately enters `RESOLVING`, then `RETREAT` (`5s`) after `completeResolving()`.
  - **Review Focus #2 (Self-KO):** Firing at own feet to KO self skips `RETREAT`, awards `0` KO points, and advances/ends the round cleanly.
  - **Review Focus #3 (2v2 Alternating Turns):** In a 2v2 match where Team A Player 2 is KO'd, turns strictly alternate `A1 -> B1 -> A1 -> B2 -> A1`.
  - **Review Focus #4 (Deferred Evo Pod Draft & Full Slots):** Picking up an Evo Pod at 100% charge during `ACTIVE` keeps the 15s timer uninterrupted, queues `DRAFT_IF_READY` after `RETREAT`, and offers slot-swap cards when all 4 hardpoints are occupied.
  - Turn 4+ raises `waterLevel` by `+0.5m` per turn and drowns critters below water; eliminated players can trigger exactly 1 Spectator Drone wind-nudge per turn.
  - `planBotTurn` returns a valid aim & charge that lands near a live enemy critter.
- [ ] **Step 2: Verify test fails**
  Run: `npx vitest run shared/test/matchEngine.test.ts` -> Expected: FAIL.
- [ ] **Step 3: Implement `physics.ts`, `matchEngine.ts`, `botAi.ts`**
  Run `npm run verify` after each file edit.
- [ ] **Step 4: Confirm green and commit**
  Run: `npm run verify` -> Expected: `PASS`. Commit `feat(shared): add ballistics, authoritative PvP match engine, and AI bot planner`.

---

### Task 5: Lightweight Node WebSocket Room Server & Reconnect Replay

**Files:**
- Create: `server/src/roomManager.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/roomServer.test.ts`

**Interfaces:**
- Consumes: `MatchEngine`, `SdfWorld`, `planBotTurn`, `parseClientMessage`, protocol types from `shared/`.
- Produces:
  - `class RoomManager`: handles `CREATE_ROOM` (4-letter uppercase code), `JOIN_ROOM`, `RECONNECT_ROOM`, `LOBBY_CONFIG`, `START_MATCH`, `MOVE_STATE`, `UTILITY_ACTION`, `FIRE_ACTION`, `RETREAT_BURROW`, `DRONE_NUDGE`, `PICK_MUTATION`, `15s` disconnect grace timer -> bot fallback, and `STATE_SNAPSHOT` with `carveLog`.
  - `startServer(port: number): Promise<{ port: number; close(): Promise<void> }>` serving `/ws` and health check `/health`.

- [ ] **Step 1: Write failing WebSocket room integration tests (including Review Focus #5)**
  In `server/test/roomServer.test.ts` (using ephemeral port `0` and real `ws` clients), assert:
  - Host creates a 4-letter room, second client joins, host starts a 2-player + 1-bot match, both receive `STATE_SNAPSHOT` with matching island seed.
  - Non-active player sending `FIRE_ACTION` is rejected cleanly.
  - **Review Focus #5 (Disconnect bot fallback & reconnect replay):** After a crater is carved, Player 1 disconnects; after the configurable grace timeout (shortened to `150ms` in test config), the bot takes Player 1's turn automatically; when Player 1 reconnects with their `reconnectToken`, they reclaim their seat and receive the exact `carveLog` matching the live island.
- [ ] **Step 2: Verify test fails**
  Run: `npx vitest run server/test/roomServer.test.ts` -> Expected: FAIL.
- [ ] **Step 3: Implement `roomManager.ts` and `server/src/index.ts`**
  Run `npm run verify` after each file edit.
- [ ] **Step 4: Confirm green and commit**
  Run: `npm run verify` -> Expected: `PASS`. Commit `feat(server): add authoritative WebSocket room server with reconnect replay`.

---

### Task 6: Three.js Smooth Island Renderer, Sculpted Species & Hardpoint Rigs

**Files:**
- Create: `client/src/scene/worldScene.ts`
- Create: `client/src/scene/terrainRenderer.ts`
- Create: `client/src/scene/critterMesh.ts`
- Create: `client/src/scene/vfx.ts`
- Test: `client/test/critterMesh.test.ts`

**Interfaces:**
- Consumes: `SdfWorld`, `meshChunkSurfaceNets`, `SpeciesId`, `HardpointSlot`, `MutationId`, `ApexId` from `shared/`.
- Produces:
  - `WorldScene`: Three.js WebGLRenderer, sunlit daylight hemisphere + directional shadows, stylized gradient sky dome, puffy stylized clouds, animated rising turquoise ocean plane with shore foam ring.
  - `TerrainRenderer`: builds and updates `16x16x16` SDF chunks using `meshChunkSurfaceNets`, cleanly calling `geometry.dispose()` on dirty chunk rebuilds (zero GPU leaks).
  - `CritterRig`: builds expressive, smooth rounded 3D meshes for all 4 starter species (**Tunnel Mole**, **Norway Rat**, **Ridge Badger**, **Glider Squirrel**) + 2 unlockables (**Quill Hedgehog**, **Plated Armadillo**) with 4 named attachment anchors (`back`, `legs`, `offense`, `crest`), `applyMutations(equipped, apex)` that swaps/disposes hardpoint sub-meshes cleanly, plus floating HP pips and idle/hop/recoil animations.
  - `VfxSystem`: spawns irregular faceted rock shards (never cubes!), stylized blast rings/smoke puffs, parachuting glowing cyan Evo Pods, and animated translucent sky wind ribbons.

- [ ] **Step 1: Write failing unit test for CritterRig hardpoint swaps & disposal (Review Focus #4 mesh safety)**
  In `client/test/critterMesh.test.ts`, instantiate `CritterRig` for each of the 6 species, attach all 4 hardpoint mutations, then overwrite an occupied slot and assert the old sub-mesh is removed from the parent anchor and child counts stay bounded (zero leaked meshes).
- [ ] **Step 2: Verify test fails**
  Run: `npx vitest run client/test/critterMesh.test.ts` -> Expected: FAIL.
- [ ] **Step 3: Implement `worldScene.ts`, `terrainRenderer.ts`, `critterMesh.ts`, and `vfx.ts`**
  Run `npm run verify` after each file edit.
- [ ] **Step 4: Confirm green and commit**
  Run: `npm run verify` -> Expected: `PASS`. Commit `feat(client): add smooth SDF Three.js terrain, sculpted species rigs, and VFX`.

---

### Task 7: 4-Mode Camera Rig, Input Controller, 3D Trajectory Arc & Procedural WebAudio

**Files:**
- Create: `client/src/game/cameraRig.ts`
- Create: `client/src/game/inputController.ts`
- Create: `client/src/game/trajectoryPreview.ts`
- Create: `client/src/audio/synthAudio.ts`
- Test: `client/test/cameraRig.test.ts`

**Interfaces:**
- Consumes: `WorldScene`, `SdfWorld`, `simulateTrajectory` from Tasks 3, 4, 6.
- Produces:
  - `CameraRig`: manages `over_shoulder`, `first_person`, `drone_recon`, `shot_cam`, and `spectator_drone` modes with smooth damped transitions, SDF terrain collision pullback, and `Tab` / `RMB` / `V` bindings.
  - `InputController`: WASD movement relative to camera yaw, Space jump/glide, hold-LMB power charge & release to fire, Drone View raycast target ping for `Seeker Firefly`, Retreat burrow trigger (`F`), and Spectator Drone wind-nudge (`E`).
  - `TrajectoryPreview`: renders the glowing dotted cyan 3D wind-curved aiming arc (extended when `Optic Visor` is equipped).
  - `SynthAudio`: zero-asset WebAudio procedural SFX (charge whine, Gale Mortar thump, smooth rock crumble, Spore pop, water splash, mutation chime, countdown tick) with mute toggle.

- [ ] **Step 1: Write failing unit tests for CameraRig state transitions**
  In `client/test/cameraRig.test.ts`, verify mode switches (`over_shoulder <-> first_person`, `Tab` toggling `drone_recon`, forced `shot_cam` during `RESOLVING` returning cleanly to `over_shoulder` on `RETREAT`, and `spectator_drone` when local hero is KO'd).
- [ ] **Step 2: Verify test fails**
  Run: `npx vitest run client/test/cameraRig.test.ts` -> Expected: FAIL.
- [ ] **Step 3: Implement `cameraRig.ts`, `inputController.ts`, `trajectoryPreview.ts`, `synthAudio.ts`**
  Run `npm run verify` after each file edit.
- [ ] **Step 4: Confirm green and commit**
  Run: `npm run verify` -> Expected: `PASS`. Commit `feat(client): add 4-mode camera rig, controls, 3D trajectory preview, and synth audio`.

---

### Task 8: Lobby, Evolution Draft HUD, Persistent Progression & End-to-End Playtest

**Files:**
- Create: `client/src/profile/progression.ts`
- Create: `client/src/net/gameClient.ts`
- Create: `client/src/ui/hud.ts`
- Modify: `client/index.html`, `client/src/main.ts`
- Test: `client/test/progression.test.ts`

**Interfaces:**
- Consumes: All modules from Tasks 2–7.
- Produces:
  - `ProgressionStore`: loads/saves `critter_siege_profile_v1` in `localStorage`, awards Siege Essence (`+20` finish, `+15` KO, `+10` Evo Pod, `+30` win), handles species/palette/bonus-gadget unlocks.
  - `GameClient`: unified facade switching cleanly between live WebSocket room mode (with `sessionStorage` `reconnectToken` & `?room=XXXX` invite URL) and instant in-browser **Play vs Bots** sandbox mode.
  - `HudController`: clean minimal UI matching our mockups—Lobby (create/join 4-letter room, copy invite link, species picker with live 3D rotating critter preview, FFA/2v2 toggle, bot slider, Siege Essence shop), In-Game HUD (top-center turn timer + wind arrow, bottom-left HP + equipped hardpoint pills, bottom-right gadget hotbar, First-Person Optic Visor overlay, Drone Recon `[TAB] EXIT` badge & compass), Between-Round / Evo Pod 1-of-3 Mutation Draft modal with comeback reroll, and Match Summary Essence payout screen.

- [ ] **Step 1: Write failing unit tests for `ProgressionStore`**
  In `client/test/progression.test.ts`, test Siege Essence payout math, unlock purchase deduction, persistence round-trip, and safe fallback on corrupted storage JSON.
- [ ] **Step 2: Verify test fails**
  Run: `npx vitest run client/test/progression.test.ts` -> Expected: FAIL.
- [ ] **Step 3: Implement `progression.ts`, `gameClient.ts`, `hud.ts`, `client/index.html`, and `client/src/main.ts`**
  Run `npm run verify` after each file edit.
- [ ] **Step 4: Full Verification & Live Browser Playtest**
  1. Run `npm run verify` -> Expected: `PASS` across `typecheck`, `lint`, all unit/integration tests, and production build.
  2. Start `npm run dev:server` and `npm run dev:client`, open in browser, verify smooth sculpted 3D island, species selection, all 4 camera views, firing + crater carving, mutation draft, and 2-tab 4-letter room join with zero console errors.
  3. Dispatch independent read-only `reviewer` subagent across the full diff against `AGENTS.md` Do-Not Rules -> Expected: `Overall Verdict: PASS`.
- [ ] **Step 5: Final commit**
  Commit `feat(client): complete lobby, HUD, progression, and multiplayer integration`.

---

## Bootstrap & Acceptance Checks

- [x] `./AGENTS.md` created with tailored Build Commands, Conventions, Do-Not Rules, Definition of Done, and Rule 2 Single-Edit Verification Loop.
- [x] `./.gemini/settings.json` and `./.gemini/agents/{builder,reviewer}.md` created for repo portability.
- [x] `./skills/{verify-project,dev-playtest}/SKILL.md` created for reusable project workflows.
- [ ] User approves this plan and selects execution approach before any application code is written.
