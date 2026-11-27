# Tactical Feedback, Drone Callouts & Signature Gadget Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver seven high-impact readability, camera, audio, and 3D VFX upgrades across Critter Siege: 10s Active ticking & 5s Retreat beeping, Drone View player beacons & screen-space callouts, two-stage physical Vine Grapple hook & pull, spinning 3D Burrow Bore drill with progressive rock carving & rock-safe Shot Cam, `Gale Scatter` wind-shotgun overhaul, `Gale Mortar` black bomb with burning wick, and `Seeker Firefly` guided GPS homing missile with target-lock visuals.

**Architecture:** Keep deterministic physics & shared constants (`GALE_SCATTER_REACH`, `GALE_SCATTER_CONE_MIN_DOT`, `sampleGrappleTarget`, `VINE_GRAPPLED.isPodPull`) in pure Node-compatible `shared/`, isolate pure client logic into small testable helpers (`countdownCue.ts`, `droneProjection.ts`, `grappleAnimation.ts`), build pooled/reusable procedural 3D meshes in `vfx.ts` & `trajectoryPreview.ts`, and orchestrate playback and HUD updates in `main.ts` and `hud.ts`.

**Tech Stack:** TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), Three.js, WebAudio API, Vitest, ESLint, Vite (`shared/` + `client/`).

**Spec:** [2026-11-27-tactical-feedback-and-gadget-vfx-design.md](file:///c:/Users/austi/.gemini/antigravity/scratch/Simple%20Game/docs/superpowers/specs/2026-11-27-tactical-feedback-and-gadget-vfx-design.md)

## Global Constraints

- **Original Critter Siege branding:** Keep internal `GadgetId = "quake_club"` stable across saves/protocol; rename player-facing display name to **`Gale Scatter`**; keep **`Seeker Firefly`** name; zero external artillery franchise references.
- **Zero new dependencies / zero external assets:** All 3D projectiles, beacons, cones, and audio cues are procedural Three.js / WebAudio; `shared/` remains 100% pure TypeScript with zero DOM/Three.js imports.
- **Strict TypeScript & Governance (`AGENTS.md` Rules 2 & 3):** `strict: true`, `noUncheckedIndexedAccess: true`, explicit return types on exported functions, zero `any` casts or `@ts-ignore`/`eslint-disable`, `npm run verify` PASS after every code file edit, implementation via `builder` and validation via isolated read-only `reviewer`.
- **Clean resource disposal:** Every new Three.js `BufferGeometry`, `Material`, and DOM element must be reused/pooled and cleanly disposed in `dispose()` / hidden when inactive.

## Review Focus

1. **Terrain Parity on Progressive Burrow Bore Carving:** Progressive visual bore carving during the `0.6s` drill sequence must carve strictly inside the authoritative `capsuleOp` envelope and synchronize with `appliedCarveCount` so the final SDF matches authoritative `state.carveLog` identically (pinned in Task 6).
2. **Shot Cam Rock-Clearance Safety:** `CameraRig.computeShotCamPose` must never leave the camera inside solid SDF voxels while following Burrow Bore into a cliff face (`!world.isSolid(camPos)`) (pinned in Task 5).
3. **Vine Grapple Evo Pod Yank vs. Terrain Grapple & Camera Rule:** `VINE_GRAPPLED` with `isPodPull: true` must shoot the hook to the pod and retract without moving the critter into mid-air; local terrain grapples exit Drone Recon to Over-the-Shoulder while preserving First Person if already in First Person (pinned in Tasks 1 & 6).
4. **Active-to-Retreat Countdown Phase Boundary:** Keying countdown triggers by `${phase}:${secCeil}` guarantees switching from `ACTIVE` (e.g., 2s left) to `RETREAT` (5s→1s) never drops a beep, and non-finite / rival-turn timers never fire local countdown cues (pinned in Task 2).
5. **Exact `Gale Scatter` Cone Parity & Wall Occlusion:** Physics (`shared/src/physics.ts`), aim preview (`TrajectoryPreview`), and blast VFX (`VfxSystem.spawnWindShotgunBlast`) all derive from shared constants `GALE_SCATTER_REACH = 6.0` and `GALE_SCATTER_CONE_MIN_DOT = 0.85` (~31.8° half-angle), preserving close-range `<= 1.6m` hit & `<= 2.8m` `meleeThorns` while blocking blasts through solid walls beyond `2.0m` (pinned in Tasks 1 & 5).

---

### Task 1: Shared `Gale Scatter` Cone Physics, Catalog Rename & Vine Grapple `isPodPull` / `sampleGrappleTarget`

**Files:**
- Modify: `shared/src/types.ts`
- Modify: `shared/src/catalog.ts`
- Modify: `shared/src/physics.ts`
- Modify: `shared/src/matchEngine.ts`
- Modify: `shared/src/index.ts`
- Modify: `shared/test/catalog.test.ts`
- Modify: `shared/test/matchEngine.test.ts`

**Interfaces:**
- Produces (`shared/src/index.ts`):
  - `export const GALE_SCATTER_REACH = 6.0;`
  - `export const GALE_SCATTER_CONE_MIN_DOT = 0.85;`
  - `export interface GrapplePreviewHit { readonly target: Vec3; readonly isPod: boolean; }`
  - `export function sampleGrappleTarget(world: SdfWorld, origin: Vec3, direction: Vec3, reach: number, waterLevel: number, evoPods?: readonly EvoPodState[]): GrapplePreviewHit | null`
  - `VINE_GRAPPLED` union member gains optional `isPodPull?: boolean`
  - `GADGET_CATALOG.quake_club.name === "Gale Scatter"`

- [ ] **Step 1: Add failing shared tests in `shared/test/catalog.test.ts` and `shared/test/matchEngine.test.ts`**
  - Verify `GADGET_CATALOG.quake_club.name === "Gale Scatter"`.
  - **Review Focus #5:** Verify `Gale Scatter` hits an enemy at `5.0m` straight ahead inside cone (`dot >= 0.85`) with smooth falloff, misses an enemy at `4.5m` off to the side (`dot < 0.85`), is blocked by a thick solid wall beyond `2.0m`, and still triggers `bramble_shell` `meleeThorns` at close range (`<= 2.8m`).
  - **Review Focus #3:** Verify direction-only `vine_grapple` aimed at an uncollected Evo Pod within reach yanks the pod and emits `VINE_GRAPPLED` with `isPodPull: true` while keeping `critter.position` grounded, AND downward cliff rappel still works identically when no pod is in the ray. Verify `sampleGrappleTarget` returns `{ target, isPod: true }` for a pod in ray and `{ target, isPod: false }` for a cliff within reach.

- [ ] **Step 2: Update `shared/src/types.ts`, `shared/src/catalog.ts`, `shared/src/physics.ts`, `shared/src/matchEngine.ts`, and `shared/src/index.ts`**
  - Single-edit verification (`npm run verify`) after each file edit until all shared + client + server tests pass cleanly.

- [ ] **Step 3: Commit Task 1**
  - `git commit -m "feat(shared): upgrade Gale Scatter 6m cone physics and Vine Grapple pod-pull targeting"`

---

### Task 2: Countdown Timers (10s Active Ticking / 5s Retreat Beeping), Gadget SFX & HUD Timer Pulse

**Files:**
- Create: `client/src/game/countdownCue.ts`
- Create: `client/test/countdownCue.test.ts`
- Modify: `client/src/audio/synthAudio.ts`
- Modify: `client/test/audio.test.ts`
- Modify: `client/src/ui/hud.ts`
- Modify: `client/index.html`

**Interfaces:**
- Produces (`client/src/game/countdownCue.ts`):
  - `export type CountdownCueKind = "none" | "active_tick" | "active_tick_urgent" | "retreat_beep" | "retreat_beep_urgent";`
  - `export interface CountdownCueResult { readonly cue: CountdownCueKind; readonly nextKey: string; }`
  - `export function evaluateCountdownCue(phase: TurnPhase, canMove: boolean, timeRemainingSec: number, lastKey: string): CountdownCueResult`
- Produces (`client/src/audio/synthAudio.ts`):
  - `playTurnTick(urgent: boolean): void` (crisp mechanical clock tick at 10s→4s, sharper double-tick at 3s→1s)
  - `playRetreatBeep(urgent: boolean): void` (distinct pitched tactical countdown beep at 5s→3s, rising double-chirp at 2s→1s)
  - `playGrappleLatch(): void` (crisp metallic claw latch clink)
  - `playDrillGrindTick(): void` (short crunchy spinning auger rock-grinding burst)
  - Upgraded `playLaunch("quake_club")` (punchy pneumatic wind-shotgun boom + wide pressurized air gust)

- [ ] **Step 1: Write failing unit tests in `client/test/countdownCue.test.ts` & extend `client/test/audio.test.ts`**
  - **Review Focus #4:** Verify `ACTIVE` yields `active_tick` at `10..4s`, `active_tick_urgent` at `3..1s`, `none` at `> 10s` or repeated same second; `RETREAT` yields `retreat_beep` at `5..3s`, `retreat_beep_urgent` at `2..1s`; transitioning directly from `ACTIVE:2` to `RETREAT:5` emits `retreat_beep`; `canMove: false` or `NaN` yields `none`.
  - Verify `SynthAudio.playRetreatBeep`, `playGrappleLatch`, `playDrillGrindTick`, and `playLaunch("quake_club")` synthesize cleanly in headless and mocked WebAudio contexts.

- [ ] **Step 2: Implement `countdownCue.ts`, update `synthAudio.ts`, and update HUD timer classes (`cs-timer-warn` / `cs-timer-urgent`) in `hud.ts` & `client/index.html`**
  - Run `npm run verify` after each file edit.

- [ ] **Step 3: Commit Task 2**
  - `git commit -m "feat(hud,audio): add 10s active clock ticking, 5s retreat beeping, and gadget SFX"`

---

### Task 3: Signature 3D Projectile Visuals (Bomb, GPS Missile, Spinning Drill), Wind-Shotgun Blast & Hook Tether VFX

**Files:**
- Modify: `client/src/scene/vfx.ts`
- Create: `client/test/gadgetVfx.test.ts`

**Interfaces:**
- Consumes: `GadgetId`, `Vec3`, `GALE_SCATTER_REACH`, `GALE_SCATTER_CONE_MIN_DOT` from `@critter/shared`
- Produces (`client/src/scene/vfx.ts`):
  - `export interface ProjectileVisualOptions { readonly gadgetId?: GadgetId; readonly direction?: Vec3; readonly boring?: boolean; readonly targetPos?: Vec3 | null; readonly dtSec?: number; }`
  - `setProjectileVisual(position: Vec3 | null, gadgetColor?: number, options?: ProjectileVisualOptions): void`
    - `gale_mortar`: matte iron-black spherical bomb (`bombGroup`) + brass collar + curved braided wick + flickering fiery flame sprite + warm ember/smoke trail + smooth tumbling rotation.
    - `seeker_firefly`: white/slate guided GPS missile (`missileGroup`) + crimson nose cone + glowing cyan GPS seeker dome + 4 tail fins + bright thruster plume + white smoke contrail + nose-aligned velocity orientation + translucent cyan GPS lock beam to `targetPos`.
    - `burrow_bore`: metallic/amber spiral-auger spinning drill (`drillGroup`) oriented nose-first along `direction`, spinning faster while `boring === true`.
    - Other gadgets: existing glowing comet orb visual.
  - `setDronePing(position: Vec3 | null, lockedMode?: boolean): void` — adds animated spinning segmented GPS target-lock crosshair ring when `lockedMode === true` (active when `seeker_firefly` is selected with a ping or in flight).
  - `spawnBoreDebris(position: Vec3, direction: Vec3): void` — backward spray of rock shards, fiery sparks, and earthen dust from a boring drill face.
  - `spawnWindShotgunBlast(origin: Vec3, direction: Vec3, reach?: number): void` — 4 expanding forward-rushing wind torus rings + 14+ diverging air-streak pellets + billowing mist/dust across `GALE_SCATTER_CONE_MIN_DOT` cone.
  - `setGrappleTether(id: string, from: Vec3 | null, to?: Vec3): void` — renders a sculpted 3-prong grappling hook claw head oriented at `to` alongside the glowing vine rope; plus `spawnGrappleLatchSpark(position: Vec3): void`.

- [ ] **Step 1: Write failing tests in `client/test/gadgetVfx.test.ts`**
  - Verify `setProjectileVisual` switches cleanly between `bombGroup` (`gale_mortar`), `missileGroup` + lock beam (`seeker_firefly`), `drillGroup` with spin advancement (`burrow_bore`), and generic orb, hiding all on `null`.
  - Verify `spawnWindShotgunBlast`, `spawnBoreDebris`, `setGrappleTether` (with hook head), `spawnGrappleLatchSpark`, and `setDronePing(pos, true)` execute cleanly without NaNs and dispose all geometries/materials cleanly in `dispose()`.

- [ ] **Step 2: Implement the procedural 3D meshes and VFX methods in `client/src/scene/vfx.ts`**
  - Run `npm run verify` and confirm PASS.

- [ ] **Step 3: Commit Task 3**
  - `git commit -m "feat(vfx): add black bomb, GPS missile, spinning drill, grappling hook, and wind shotgun VFX"`

---

### Task 4: Drone View (`Tab`) 3D Vertical Player Beacons & Always-Visible Screen-Space HUD Callouts

**Files:**
- Create: `client/src/game/droneProjection.ts`
- Create: `client/test/droneMarkers.test.ts`
- Modify: `client/src/scene/vfx.ts`
- Modify: `client/src/ui/hud.ts`
- Modify: `client/index.html`

**Interfaces:**
- Produces (`client/src/game/droneProjection.ts`):
  - `export interface DronePlayerMarkerData { readonly id: string; readonly name: string; readonly speciesName: string; readonly color: string; readonly hp: number; readonly maxHp: number; readonly team: TeamId | null; readonly isLocal: boolean; readonly isActiveTurn: boolean; readonly distanceMeters: number | null; readonly screenX: number; readonly screenY: number; readonly offscreen: boolean; readonly edgeAngleRad: number; }`
  - `export function projectDroneMarkers(critters: readonly CritterState[], localPlayerId: string | null, activePlayerId: string | null, camera: THREE.Camera, viewportWidth: number, viewportHeight: number, positionOverrides?: ReadonlyMap<string, Vec3>): DronePlayerMarkerData[]`
- Produces (`client/src/scene/vfx.ts`):
  - `export interface DroneBeaconInput { readonly id: string; readonly position: Vec3; readonly color: string; readonly isLocal: boolean; readonly isActiveTurn: boolean; }`
  - `syncDronePlayerBeacons(beacons: readonly DroneBeaconInput[], visible: boolean, elapsedSec: number): void`
- Produces (`client/src/ui/hud.ts`):
  - `HudFrameData` accepts optional `droneMarkers?: readonly DronePlayerMarkerData[]` and renders them inside `.cs-drone-markers` in `droneOverlay` (showing gold `★ YOU` badge on local critter and color-coded `Name · HP · Xm` + team/turn badges on rivals, cleanly hidden outside Drone View).

- [ ] **Step 1: Write failing tests in `client/test/droneMarkers.test.ts`**
  - Verify `projectDroneMarkers` marks local critter `isLocal: true` with `distanceMeters: null`, computes accurate horizontal distances to rivals, clamps behind-camera / off-screen critters into viewport margins with `offscreen: true` and finite `edgeAngleRad`, and omits dead critters.
  - Verify `VfxSystem.syncDronePlayerBeacons` creates gold beacon for local player and color-coded beacons for rivals when `visible: true`, hides all when `visible: false`, removes dead critters, and disposes cleanly.

- [ ] **Step 2: Implement `droneProjection.ts`, `VfxSystem.syncDronePlayerBeacons`, and `HudController` + CSS callout pills**
  - Run `npm run verify` after each file edit.

- [ ] **Step 3: Commit Task 4**
  - `git commit -m "feat(drone): add 3D player beacons and screen-space callout markers in Drone View"`

---

### Task 5: Shotgun Cone & Grapple Latch Aim Previews, Instant-Fire `Gale Scatter`, Icons & Shot Cam Rock-Clearance

**Files:**
- Modify: `client/src/game/trajectoryPreview.ts`
- Modify: `client/src/game/inputController.ts`
- Modify: `client/src/game/cameraRig.ts`
- Modify: `client/src/ui/hud.ts`
- Modify: `client/test/cameraRig.test.ts`

**Interfaces:**
- Produces (`client/src/game/trajectoryPreview.ts`):
  - `TrajectoryPreview.update(...)` supports:
    - `quake_club` (`Gale Scatter`): renders translucent glowing 3D spread cone + 5 diverging wind rays sized strictly from `GALE_SCATTER_REACH` & `GALE_SCATTER_CONE_MIN_DOT`.
    - `vine_grapple`: uses `sampleGrappleTarget(...)` to show an emerald straight dotted sightline + glowing latch ring (or gold ring on Evo Pod lock), hidden when out of range.
- Produces (`client/src/game/inputController.ts`):
  - Treats `quake_club` as instant-fire (`power = 1.0`, no charge ramp, preserving pointer-lock click-to-lock zero-misfire).
- Produces (`client/src/ui/hud.ts`):
  - Updates `GADGET_TOOLTIP`, `GADGET_SHORT_TOOLTIP`, and SVG icons for `quake_club` (`Gale Scatter` scatter-cone icon) and `seeker_firefly` (guided GPS missile + crosshair icon); labels fire button `"FIRE BLAST"` when `quake_club` is selected.
- Produces (`client/src/game/cameraRig.ts`):
  - `computeShotCamPose(shotPos, world)` checks solid SDF terrain along `shotPos -> desiredCamPos` and pulls/lifts the camera cleanly outside solid rock (**Review Focus #2**).

- [ ] **Step 1: Add failing tests in `client/test/cameraRig.test.ts`**
  - **Review Focus #2:** Verify `CameraRig` in `shot_cam` mode never places `camera.position` inside solid SDF terrain when `shotPos` enters the middle of a solid island cliff (simulating Burrow Bore).
  - **Review Focus #5:** Verify `TrajectoryPreview` displays the `Gale Scatter` cone mesh when `gadgetId === "quake_club"` and displays the grapple latch preview when `gadgetId === "vine_grapple"`, hiding both cleanly when switching back or disposing.

- [ ] **Step 2: Implement updates in `trajectoryPreview.ts`, `inputController.ts`, `cameraRig.ts`, and `hud.ts`**
  - Run `npm run verify` after each file edit.

- [ ] **Step 3: Commit Task 5**
  - `git commit -m "feat(aim,camera): add Gale Scatter cone & grapple previews, instant-fire trigger, and rock-safe Shot Cam"`

---

### Task 6: Two-Stage Grapple State Machine, `main.ts` Full Integration, Live Browser Playtest & Final Audit

**Files:**
- Create: `client/src/game/grappleAnimation.ts`
- Create: `client/test/grappleAnimation.test.ts`
- Modify: `client/src/main.ts`

**Interfaces:**
- Produces (`client/src/game/grappleAnimation.ts`):
  - `export interface GrappleAnimState { readonly from: Vec3; readonly to: Vec3; readonly isPodPull: boolean; elapsedSec: number; readonly launchDurationSec: number; readonly pullDurationSec: number; latchTriggered: boolean; }`
  - `export interface GrappleAnimFrame { readonly phase: "launch" | "pull" | "done"; readonly critterPos: Vec3; readonly tetherFrom: Vec3; readonly tetherTo: Vec3; readonly justLatched: boolean; }`
  - `export function createGrappleAnimState(from: Vec3, to: Vec3, isPodPull: boolean): GrappleAnimState` (`launchDurationSec = 0.20`, `pullDurationSec = 0.55`)
  - `export function stepGrappleAnim(state: GrappleAnimState, dtSec: number): GrappleAnimFrame`
  - `export function shouldExitDroneForGrapple(currentMode: CameraMode): boolean` (`true` for `drone_recon`, `false` for `first_person` and `over_shoulder`)

- [ ] **Step 1: Write failing tests in `client/test/grappleAnimation.test.ts`**
  - **Review Focus #3:** Verify `stepGrappleAnim` keeps `critterPos === from` during `0..0.20s` `launch` while `tetherTo` extends smoothly from `from` to `to`, fires `justLatched: true` once at `0.20s`, then during `pull` (`0.20..0.75s`) moves `critterPos` smoothly to `to` with arc lift when `isPodPull === false`, OR keeps `critterPos === from` while retracting `tetherTo` back toward `from` when `isPodPull === true`. Verify `shouldExitDroneForGrapple` returns `true` for `"drone_recon"` and `false` for `"first_person"` and `"over_shoulder"`.

- [ ] **Step 2: Implement `client/src/game/grappleAnimation.ts` and verify with `npm run verify`**

- [ ] **Step 3: Integrate all 7 features cleanly into `client/src/main.ts`**
  - Replace countdown block with `evaluateCountdownCue` + `playTurnTick` / `playRetreatBeep`.
  - Compute `droneMarkers` via `projectDroneMarkers` when in Drone View, sync 3D beacons via `vfx.syncDronePlayerBeacons`, and pass `droneMarkers` into `hud.updateMatchHud`.
  - Upgrade `grappleGlides` to `GrappleAnimState` using `stepGrappleAnim`, play `audio.playGrappleLatch()` + `vfx.spawnGrappleLatchSpark(to)` on `justLatched`, exit `drone_recon` -> `over_shoulder` on local grapple (preserving `first_person`), and track `localPos` continuously through launch + pull.
  - Enable `TrajectoryPreview` for `quake_club` (`Gale Scatter`) and `vine_grapple` (passing `evoPods` and `waterLevel`), and pass `lockedMode = selectedGadget === "seeker_firefly" || shotPlayback?.gadgetId === "seeker_firefly"` to `vfx.setDronePing`.
  - Upgrade `ShotPlayback` & `advanceShotPlayback`:
    - Pass `{ gadgetId: pb.gadgetId, direction, boring, targetPos, dtSec }` into `vfx.setProjectileVisual(...)` so `gale_mortar` shows tumbling black bomb, `seeker_firefly` shows guided GPS missile + lock beam, and `burrow_bore` shows spinning 3D drill.
    - For `burrow_bore`: compute `boreCapsuleOp` & `boreStartSec`, progressively carve 6 incremental capsule slices into `this.activeWorld` + rebuild dirty chunks + emit `vfx.spawnBoreDebris` + `audio.playDrillGrindTick()` during the `0.6s` bore, then let `flushPendingCarves(state)` commit the authoritative `capsuleOp` + `detonateOp` with zero desync (**Review Focus #1**).
    - For `quake_club` (`Gale Scatter`): do NOT switch to Shot Cam; trigger `vfx.spawnWindShotgunBlast(origin, dir, GALE_SCATTER_REACH)` immediately + subtle punch camera shake + impact damage popups!
  - Run full `npm run verify` and confirm PASS.

- [ ] **Step 4: Live Browser Playtest & Final Read-Only Audit**
  - Commit Task 6 (`feat(client): integrate timers, drone callouts, two-stage grapple, progressive drill, and signature projectiles`).
  - Run live browser playtest on Vite dev server verifying all 7 features with zero console errors.
  - Dispatch isolated read-only `pro` `reviewer` subagent across the full diff against `AGENTS.md` Do-Not Rules, the spec, and all 5 Review Focus failure modes.
