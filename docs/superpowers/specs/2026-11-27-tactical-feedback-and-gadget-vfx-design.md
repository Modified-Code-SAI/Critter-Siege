# Tactical Feedback, Drone Callouts & Signature Gadget Overhaul Design (`Critter Siege`)

**Date:** 2026-11-27
**Status:** Draft (Pending Approval)
**Scope:** Project — Countdown Timers & Audio, Drone Recon Player Highlights, Vine Grapple Two-Stage Animation, Burrow Bore 3D Spinning Drill & Progressive Tunneling, Quake Club -> `Gale Scatter` Shotgun Wind-Blast Overhaul, Gale Mortar Black Bomb Visual, and Seeker Firefly GPS Homing Missile & Target-Lock Visuals

---

## 1. Intent & Why

Five high-impact gameplay readability and game-feel upgrades requested to make every turn feel sharper, clearer, and physically grounded:

1. **Countdown Timers (10s Active Ticking / 5s Retreat Beeping):** Currently `main.ts` only plays a generic tick during the last 4 seconds of either phase, leaving players surprised by timeouts and unable to distinguish turn-ending urgency from retreat urgency by ear.
2. **Drone View (`Tab`) Player Identification:** From 50–100m Drone Recon altitude, small 3D critter nameplates become illegible and disappear behind cliffs/caves, making it hard to spot where you are vs. each rival before aiming.
3. **Vine Grapple Physical Hook & Pull:** Currently `VINE_GRAPPLED` instantly spawns a beam and zips the critter in `0.42s` without showing a grappling hook shoot out and latch first, and lacks an aim-latch preview.
4. **Burrow Bore Spinning 3D Drill & Visible Rock Boring:** Currently `burrow_bore` renders as the generic glowing orb and clips invisibly inside solid cliffs until the final explosion pops the whole tunnel open at once.
5. **Quake Club -> `Gale Scatter` Wind-Shotgun Overhaul:** Currently `"Quake Club"` has no aim preview, a tiny 2.8m sphere radius, and renders as a generic explosion sphere—failing to communicate its directional cone-blast knockback role.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- **Distinct 10s Active Ticking & 5s Retreat Beeping:** Crisp mechanical clock ticks starting at 10s left on your `ACTIVE` turn (escalating at 3s→1s) and clear pitched tactical countdown beeps starting at 5s left on your `RETREAT` turn (rising pitch at 2s→1s), paired with amber/red HUD timer pulses.
- **Unmistakable Drone View (`Tab`) Highlights:** Tall 3D glowing vertical light pillars + pulsing ground rings around every alive critter PLUS always-visible screen-space HUD callout tags (visible through terrain/caves, with edge indicators if off-screen) showing a distinct gold **`YOU`** badge on your critter and color-coded **Name · HP · Distance** (plus team tag in 2v2) on every rival.
- **Two-Stage Physical Vine Grapple:** Glowing grapple latch aim marker while aiming `vine_grapple`; on fire, a visible 3D multi-prong grappling hook shoots out on a growing vine rope (~0.20s) and latches with a metallic spark/clink, then visibly reels the critter along the taut vine (~0.55s) in **Over-the-Shoulder** view (exiting Drone Recon if active, unless the player is specifically in **First Person**, in which case stay in First Person). Safely handles Evo Pod yanks without moving the player.
- **Physical Spinning 3D Burrow Bore Drill:** A dedicated 3D metallic/amber spiral-auger drill projectile aligned to travel velocity and spinning rapidly around its forward axis; upon entering solid rock, progressively carves slices along the bore path in real time during the `0.6s` bore while spraying rock chips, sparks, and dust backward out of the bore hole with grinding drill audio, while Shot Cam pulls clear of solid terrain so it never clips inside rock before detonation.
- **`Gale Scatter` Shotgun Wind-Blast Overhaul:** Rename `"Quake Club"` display name to **`Gale Scatter`** (keeping internal `GadgetId = "quake_club"` stable for saves, server protocol, and loadouts), expand forward cone reach to `6.0m` (preserving point-blank `<= 1.6m` safety and `meleeThorns` compatibility), render a translucent shotgun-cone aim preview when selected, and fire a dramatic spreading gust of expanding wind rings, air-streaks, dust plumes, and punchy air-cannon shotgun audio.

### Non-Goals
- No renaming of internal `GadgetId` `"quake_club"` in wire protocol or `localStorage` progression keys (only player-facing name, icon, description, cone physics, aim preview, and VFX/SFX change).
- No new npm dependencies or external paid assets.
- No changes to the newly built adaptive music engine (`musicEngine.ts`) beyond ensuring clean coexistence with the new timer/gadget SFX.

### Anti-Goals
- **No terrain desync on Burrow Bore:** Progressive visual bore carving on the client must carve strictly inside the authoritative `capsuleOp` envelope and stay synchronized with `appliedCarveCount` so the final SDF matches the server/authoritative simulation identically.
- **No Shot Cam inside solid rock:** Shot Cam must never sit inside solid SDF voxels during Burrow Bore tunneling.
- **No dangling DOM/Three.js leaks:** Drone callout tags, 3D beacons, drill mesh, grappling hook mesh, and shotgun aim cone must dispose cleanly on match exit / restart and hide immediately when leaving Drone View.
- **No Evo Pod yank teleport bug:** If `VINE_GRAPPLED` yanks an Evo Pod (`critter.position` unchanged at `from`), play the hook shoot-out and retract cleanly without zipping the critter to the pod's old air position.
- **No breaking existing tests:** All existing 152 tests must stay green (updating only explicit `"Quake Club"` name expectations if any, while keeping knockback/thorns/carve mechanics verified).

---

## 3. Architecture & Detailed Design

### 3.1 Feature 1: Countdown Timer Ticking (10s Active) & Beeping (5s Retreat)

- **`client/src/audio/synthAudio.ts`:**
  - Enhance `playTurnTick(urgent: boolean)`: crisp mechanical clock tick (short woody/metallic transient + subtle resonant click; sharper double-tick when `urgent` at `<= 3s`).
  - Add `playRetreatBeep(urgent: boolean)`: clear pitched tactical countdown beep (`sine` + soft `triangle` overtone around 760 Hz at 5s→3s, rising to 980 Hz / 1160 Hz double-chirp at 2s→1s) so Retreat sounds unmistakably different from Active ticking.
- **`client/src/main.ts`:**
  - Extract a pure testable helper `evaluateCountdownCue(phase, canMove, timeRemainingSec, lastTriggeredKey)` (in `client/src/game/countdownCue.ts` or similar) returning `"none" | "active_tick" | "active_tick_urgent" | "retreat_beep" | "retreat_beep_urgent"` keyed by `${phase}:${secCeil}` so switching from `ACTIVE` (e.g., 2s left) into `RETREAT` (6s → 5s) never drops a cue due to a shared `lastCountdownSec` number!
  - Exact thresholds (local player's turn only, `canMove === true`):
    - `ACTIVE`: `secCeil` in `1..10` -> `active_tick` (`4..10`), `active_tick_urgent` (`1..3`).
    - `RETREAT`: `secCeil` in `1..5` -> `retreat_beep` (`3..5`), `retreat_beep_urgent` (`1..2`).
- **`client/src/ui/hud.ts` + `client/index.html` CSS:**
  - Update `topTimerEl` styling classes:
    - `cs-timer-warn` (amber pulse): `ACTIVE` when `4 <= secs <= 10`.
    - `cs-timer-urgent` (red urgent pulse): `ACTIVE` when `secs <= 3`, OR `RETREAT` when `secs <= 5`.

### 3.2 Feature 2: Drone View (`Tab`) Player Highlights & Callouts

- **3D Glowing Vertical Beacons (`client/src/scene/vfx.ts`):**
  - Add `syncDronePlayerBeacons(critters: readonly DroneBeaconInput[], visible: boolean, elapsedSec: number): void`.
  - When `visible` (`cameraMode === "drone_recon" || cameraMode === "spectator_drone"`), render a tall translucent tapered light pillar (height ~18m, additive/unlit, `depthWrite: false`) + pulsing concentric ground ring around every alive critter:
    - Local player (`isLocal === true`): radiant **gold (`0xfacc15`)** pillar & ring so you spot yourself instantly.
    - Teammate (2v2): **emerald/cyan (`0x34d399`)** or team color.
    - Rivals: distinct critter/team color (`critter.color`) with high-visibility glow.
  - Hidden immediately (`group.visible = false`) outside Drone View; pooled/reused by critter ID and disposed cleanly in `VfxSystem.dispose()`.
- **Always-Visible Screen-Space HUD Callout Tags (`client/src/ui/hud.ts` + `client/src/main.ts`):**
  - Add a dedicated `.cs-drone-markers` container inside `droneOverlay` (`pointer-events: none`).
  - Project each alive critter's world head position (`y + 2.3`) via `camera.matrixWorldInverse` / `projectionMatrix` into viewport `(x, y)` pixels (clamping gently to viewport margins with a directional indicator if behind/outside camera frustum so nobody is ever lost off-screen).
  - Render compact glass pills with color-coded left accent bar + pointer stem:
    - Local player: gold **`★ YOU · <Name>`** badge + HP bar/text (`240 HP`).
    - Rivals / Allies: **`<Name>`** (with `TEAM A`/`TEAM B` badge in 2v2, or `ACTIVE` pip on current turn-holder) + species/HP + exact horizontal distance from you (`42m`).
  - Automatically hidden when leaving Drone View (`!isDrone`).

### 3.3 Feature 3: Vine Grapple Two-Stage Hook Shot, Pull & Camera Lock

- **Protocol & Crosshair Pod-Yank Support (Architect's Call):**
  - Add optional `isPodPull?: boolean` on `VINE_GRAPPLED` in `shared/src/types.ts` and set `isPodPull: true` whenever `pulledPod` triggers in `shared/src/matchEngine.ts`.
  - In `shared/src/matchEngine.ts`, extend the `pulledPod` check so direction-only grapples (`action.target === undefined`) also detect an uncollected Evo Pod lying along the aim ray within `reach` (perpendicular distance `<= 1.6m` and in front of the critter), so players can aim directly at an Evo Pod with the crosshair without breaking cliff-rappel terrain raycasts.
- **Grapple Latch Aim Preview (`client/src/game/trajectoryPreview.ts` + `client/src/main.ts`):**
  - Add a shared-compatible pure helper `sampleGrappleTarget(world, origin, dir, reach, waterLevel, evoPods?)` matching `matchEngine.ts`'s exact grapple raycast/reach (`18m` duel / `26m` grand × `grappleReachBonus`) and Evo Pod ray check.
  - When `selectedGadget === "vine_grapple"` and `canFire` (and grapple has charges & unused this turn), show a crisp emerald dotted straight sightline + glowing emerald latch-target ring where the hook will grab (or golden ring when locked onto an Evo Pod; hidden when out of range).
- **Two-Stage Animation (`client/src/main.ts` + `client/src/scene/vfx.ts`):**
  - Upgrade `grappleGlides` state machine per critter:
    - **Phase 1 — `launch` (`0.20s`):** A visible 3D multi-prong grappling hook (`VfxSystem.setGrappleTether` upgraded with a sculpted 3-prong iron/emerald claw head oriented along `from -> to`) shoots rapidly from critter chest (`from`) to `to`, with the taut glowing vine rope extending behind it. Upon reaching `to`, spawn an anchor latch spark burst + metallic latch click SFX!
    - **Phase 2 — `pull` (`0.55s`):**
      - If `!isPodPull`: the hook stays anchored at `to` while the critter visibly reels along the shrinking taut vine from `from` to `to` with a subtle upward pull arc (`arcLift`), settling smoothly onto `to` at `t = 1`.
      - If `isPodPull`: the hook retracts from `to` back to `from`, yanking the pod cleanly while the critter stays grounded at `from`.
  - **Camera Rule (`client/src/main.ts`):**
    - On local `VINE_GRAPPLED`: NEVER activate `shot_cam`. If currently in `drone_recon`, call `this.cameraRig.exitDroneRecon()` so camera returns to **Over-the-Shoulder** (`over_shoulder`) to visibly watch the hook shoot out and pull your character! If already in `first_person`, keep `first_person` untouched!
    - While `localIsGliding` (both `launch` and `pull` stages), `cameraRig` tracks `localPos` smoothly so Over-the-Shoulder visibly follows your character being pulled across the island to the anchor point!

### 3.4 Feature 4: Burrow Bore Spinning 3D Drill & Progressive Tunnel Carving

- **3D Spinning Drill Projectile Mesh (`client/src/scene/vfx.ts`):**
  - Add a dedicated procedural 3D **Burrow Bore Auger/Drill group** inside `VfxSystem` (`drillGroup` with tapered metallic nose cone, helical spiral auger flutes using tilted torus/cone bands, glowing amber thruster collar, and rotating spin pivot).
  - Extend `VfxSystem.setProjectileVisual(position, gadgetColor?, options?: { gadgetId?: GadgetId; direction?: Vec3; boring?: boolean; dtSec?: number })`:
    - When `gadgetId === "burrow_bore"`: display the 3D spinning drill mesh oriented nose-first along `direction` (`quaternion.setFromUnitVectors`), spinning rapidly around its local nose axis (~28 rad/s in air, accelerating to ~55 rad/s while `boring === true`), with bright orange sparks & heavy rock-dust spray shooting backward out of the bore hole while `boring === true`!
    - All other projectiles keep their existing comet orb visual cleanly.
- **Progressive Tunnel Carving & Bore Timing (`client/src/main.ts` + `shared/src/physics.ts`):**
  - `physics.ts` already simulates `burrow_bore` flight -> `entryPos` -> 6 linear tunnel steps over `tunnelDuration = 0.6s` -> `endPos` with `carveOps = [capsuleOp, detonateOp]`.
  - In `ShotPlayback` (`client/src/main.ts`): detect `burrow_bore` capsule `carveOp` (`shape === "capsule"` with `center = entryPos`, `end = endPos`, `radius`), compute exact `boreStartSec = Math.max(0.05, durationSec - 0.6)`, and track `boreProgressSlices` (`0..6`).
  - During `advanceShotPlayback`:
    - While `elapsedSec < boreStartSec`: drill flies cleanly through air spinning nose-first.
    - When `elapsedSec >= boreStartSec` and `elapsedSec < durationSec`: `boring = true`. On each of the 6 slice thresholds, carve the incremental short capsule segment `[prevSlicePos -> curSlicePos]` with `capsuleOp.radius` directly into `this.activeWorld`, immediately rebuild only the dirty chunks via `this.terrainRenderer.rebuildChunks(...)`, emit backward rock-shard & dust bursts at the bore face (`vfx.spawnBoreDebris(curPos, boreDir)`), trigger micro screen-rumble, and pulse a grinding drill audio loop (`audio.playDrillGrindTick()`).
    - At detonation (`elapsedSec >= durationSec`): `flushPendingCarves(state)` runs the authoritative `capsuleOp` + `detonateOp` (guaranteeing 100% deterministic parity with `state.carveLog`) and triggers the final subterranean blast!
- **Shot Cam Rock-Clearance Framing (`client/src/game/cameraRig.ts`):**
  - Update `computeShotCamPose(shotPos, world)` so Shot Cam checks whether its offset camera position (or line-of-sight to `shotPos`) is inside solid SDF rock; if obstructed (as when Burrow Bore enters a cliff face!), pull/lift the camera cleanly outside the entry rock face looking directly at the spinning drill chewing into the tunnel!

### 3.5 Feature 5: Quake Club -> `Gale Scatter` Wind-Shotgun Overhaul

- **Catalog & Copy (`shared/src/catalog.ts`, `client/src/ui/hud.ts`, `AGENTS.md` branding check):**
  - Keep internal `GadgetId = "quake_club"` unchanged for full save/protocol compatibility.
  - Rename display name to **`Gale Scatter`** (100% original Critter Siege name!).
  - Update description: `"Wide-cone pneumatic wind shotgun that blasts rivals back with a spreading gale gust."`
  - Update HUD tooltip, Armory blurb, and SVG icon in `hud.ts` (stylized scatter-cone / wind-blaster icon instead of melee club).
- **Directional Shotgun Cone Physics (`shared/src/physics.ts`) — Exact Geometry (Architect's Call):**
  - Export shared constants `GALE_SCATTER_REACH = 6.0` and `GALE_SCATTER_CONE_MIN_DOT = 0.85` (`arccos(0.85) ≈ 31.8°` half-angle / `63.6°` full shotgun spread; base radius at `6.0m` is `6.0 * tan(31.8°) ≈ 3.72m`) so physics, `TrajectoryPreview` cone mesh, and `VfxSystem.spawnWindShotgunBlast` share one exact source of truth.
  - Point-blank (`dist <= 1.6m`): hits immediately in front/adjacent (preserving existing close-quarters test behavior and `meleeThorns` on close range `<= 2.8m`).
  - Mid-cone (`1.6m < dist <= 6.0m`): hits targets inside the forward spread cone (`dot >= 0.85`) with smooth distance damage/knockback scaling (`1.0` at `<= 2.8m`, tapering linearly to `0.65` at `6.0m`), plus terrain line-of-sight sampling so thick solid walls block wind gusts beyond `2.0m`.
  - Carve impact placed cleanly along the cone (`origin + normDir * 2.2`, small `0.9` carve radius) so it scorches/chips rock without blowing yourself up.
- **Instant-Fire Shotgun Trigger (Architect's Call):**
  - In `client/src/game/inputController.ts` and `client/src/ui/hud.ts`: treat `quake_club` (`Gale Scatter`) as **instant-fire on click / Enter / HUD button tap** (`power = 1.0`, no fake charge bar or charge whine ticks; HUD fire button labels `"FIRE BLAST"` when selected, while keeping pointer-lock click-to-lock zero-misfire guard intact).
- **Shotgun Cone Aim Preview (`client/src/game/trajectoryPreview.ts` + `client/src/main.ts`):**
  - Enable preview for `quake_club` (`Gale Scatter`)! Render a translucent glowing **3D forward spread cone + 5 diverging wind-ray lines** (`length = GALE_SCATTER_REACH = 6.0m`, exact half-angle `arccos(GALE_SCATTER_CONE_MIN_DOT) ≈ 31.8°`) originating from the critter along aim direction so you can see *exactly* who is inside the shotgun blast spread!
- **Spreading Wind-Shotgun Blast VFX & Audio (`client/src/scene/vfx.ts`, `client/src/audio/synthAudio.ts`, `client/src/main.ts`):**
  - Add `VfxSystem.spawnWindShotgunBlast(origin: Vec3, direction: Vec3, reach: number)`:
    - 4 expanding translucent wind-gust torus rings rushing forward along `direction` at staggered speeds.
    - 14+ high-speed diverging air-streak pellets/sparks fanning out across the 6m cone.
    - Billowing white-cyan wind mist puffs & scattered ground dust swirling outward.
  - Update `SynthAudio.playLaunch("quake_club")` to a punchy pneumatic shotgun wind-blast (deep sub-thump + wide stereo-feel high-energy pressurized air whoosh).
  - In `advanceShotPlayback` (`main.ts`): when `pb.gadgetId === "quake_club"`, trigger `vfx.spawnWindShotgunBlast(...)` from `pb.path[0]` along the shot aim direction instead of a tiny generic mortar orb, and keep the camera in Over-the-Shoulder / First Person (or brief subtle punch shake) instead of snapping awkwardly to Shot Cam for a 0.25s instant shotgun blast!

### 3.6 Feature 6: Gale Mortar Black Bomb with Burning Wick Visual

- **Pure Visual Swap (Zero Physics Changes):** `gale_mortar` keeps its exact wind-curved ballistic arc, damage, knockback, and crater carve physics.
- **3D Black Bomb Mesh (`client/src/scene/vfx.ts`):**
  - Dedicated procedural `bombGroup` inside `VfxSystem` activated when `setProjectileVisual(..., { gadgetId: "gale_mortar" })`:
    - Matte iron-black spherical bomb casing (`MeshStandardMaterial`, dark charcoal-iron `#1c1f26`, metallic sheen, subtle rim contrast so it reads clearly against both sunlit sky and dark cliffs).
    - Top brass/bronze fuse collar + curved braided cord wick sticking out the top.
    - Flickering fiery orange-gold flame sprite & spark cluster at the wick tip (pulsing scale/intensity each frame) + warm ember sparks and soft charcoal smoke trail emitted along the arc while the bomb smoothly tumbles (`rotation.x` / `rotation.z`) through the air before exploding on impact!

### 3.7 Feature 7: Seeker Firefly Guided GPS Homing Missile & Target-Lock Visuals

- **Keep Display Name `"Seeker Firefly"`:** Keep `GADGET_CATALOG.seeker_firefly.name = "Seeker Firefly"` and update its hotbar/armory SVG icon to a sleek guided missile + target-lock reticle while preserving its exact high-altitude climbing & diving homing physics.
- **3D Guided GPS Homing Missile Mesh (`client/src/scene/vfx.ts`):**
  - Dedicated procedural `missileGroup` inside `VfxSystem` activated when `setProjectileVisual(..., { gadgetId: "seeker_firefly", direction, targetPos })`:
    - Sleek white/slate cylindrical fuselage with crimson/red nose cone, glowing cyan GPS seeker lens dome near the nose, 4 angled tail stabilizing fins, and bright glowing thruster nozzle at the tail.
    - Dynamically oriented nose-first along instantaneous velocity `direction` (`quaternion.setFromUnitVectors`) so players visibly watch it pitch upward on launch, bank at cruise altitude, and dive nose-first onto the target!
    - Emits crisp bright thruster glow sparks + a billowing white smoke contrail ribbon along its curved flight path.
- **Animated GPS Target-Lock Crosshair & Lock Beam (`client/src/scene/vfx.ts` + `client/src/main.ts`):**
  - Upgrade the Drone Ping / target marker when `seeker_firefly` is selected (with an active Drone Ping) OR while a `seeker_firefly` missile is in flight:
    - Spinning segmented target-lock crosshair ring (cyan -> pulsing crimson-cyan lock-on ticks) hovering cleanly at the target point.
    - Faint translucent cyan GPS lock laser beam connecting the missile's seeker nose to its locked target during flight (especially crisp during the terminal dive!), automatically cleared the moment the missile detonates or playback ends.

---

## 4. What's Left to the Builder

- Exact 3D procedural geometry dimensions/colors for the grappling hook prongs, Burrow Bore spiral auger flutes, Drone vertical pillars, and Gale Scatter wind-cone mesh.
- Exact CSS styling for Drone screen-space callout pills and `cs-timer-warn` / `cs-timer-urgent` keyframe pulses in `client/index.html`.
- Updating any existing unit tests that check `"Quake Club"` string or `quake_club` reach while adding thorough unit tests for all 5 new features.

---

## 5. Verification & Acceptance Criteria

1. **`npm run verify` exits `0`** (`typecheck`, `lint`, `vitest`, production `build`).
2. **Automated Tests Covering All 5 Features:**
   - Countdown cue helper: verifies `ACTIVE` ticks at `10..1` (urgent `3..1`), `RETREAT` beeps at `5..1` (urgent `2..1`), phase transitions don't swallow cues, and `SynthAudio.playRetreatBeep` synthesizes cleanly.
   - Drone beacons & HUD callout projection: verifies `syncDronePlayerBeacons` shows/hides gold local beacon + rival beacons cleanly and disposes cleanly; verifies projection helper clamps off-screen markers cleanly.
   - Vine Grapple: verifies `VINE_GRAPPLED` carries `isPodPull` on pod yanks, two-stage launch+pull timing/interpolation helper, and camera rule (returns from Drone to Over-the-Shoulder, preserves First Person).
   - Burrow Bore: verifies 3D drill visual activation/spinning, progressive bore slice timing, and Shot Cam rock-clearance guard (`!world.isSolid(camPos)`).
   - `Gale Scatter` (`quake_club`): verifies display name `"Gale Scatter"`, 6m forward cone hit/miss geometry + distance falloff + close-range `meleeThorns`, cone preview visibility, and `spawnWindShotgunBlast` VFX + disposal.
   - `Gale Mortar` & `Seeker Firefly`: verifies `setProjectileVisual` switches cleanly between black bomb (with wick flame), guided GPS missile (nose-aligned + lock beam to target), spinning 3D Burrow Bore drill, and generic orb, hiding/disposing cleanly on `null` or `dispose()`.
3. **Live Browser Playtest:** Verify Drone View (`Tab`) highlights & labels all players including `YOU`, `Gale Mortar` fires the tumbling black bomb with burning wick, `Seeker Firefly` fires the guided GPS missile with target-lock crosshair/beam, `Gale Scatter` shows cone preview and fires spreading wind blast, Vine Grapple visibly shoots hook and pulls in Over-the-Shoulder (and stays FP in First Person), Burrow Bore visibly shoots spinning 3D drill boring through rock, and countdown ticks/beeps fire with zero console errors.
4. **Independent Read-Only Review:** Isolated `reviewer` audits full diff against `AGENTS.md` Do-Not Rules and live `npm run verify` output.
