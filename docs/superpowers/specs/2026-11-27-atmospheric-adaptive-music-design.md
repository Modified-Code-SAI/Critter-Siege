# Atmospheric Adaptive Music & Living Soundscape Design (`Critter Siege`)

**Date:** 2026-11-27
**Status:** Draft (Pending Approval)
**Scope:** Project — Client Audio Engine (`client/src/audio/`) & Gameplay Telemetry Integration (`client/src/main.ts`)

---

## 1. Intent & Why

Critter Siege's current soundtrack ([musicEngine.ts](file:///c:/Users/austi/.gemini/antigravity/scratch/Simple%20Game/client/src/audio/musicEngine.ts)) is a dry, rigid 16-step WebAudio sequencer built from bare quantized oscillators (bouncy marimba arpeggios, buzzy detuned saw/triangle synth-brass, and arcade drum patterns) running at brisk 112–148 BPM with no reverb, stereo depth, or ambient bed. It jumps abruptly between 6 discrete presets (`lobby`, `battle`, `intense`, `shop`, `flood`, `victory`) while ignoring the island biome, sky/storm progression, turn pacing, aiming/charging tension, projectile flight, and win/loss outcome.

The goal is to evolve the soundtrack into an **atmospheric woodland-adventure and tactical-tension score** (in the spirit of *Breath of the Wild*, *Ori*, and *Hollow Knight*) — lush, spacious, organic, and emotionally reactive — paired with a subtle **living island ambience layer** (ocean surf, wind gusts tied to match wind, and storm swell) so every match feels grounded in a real sky-island world and breathes with the ebb and flow of combat.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- **Lush, organic studio timbre & space:** Replace bare dry oscillators with acoustic-inspired synthesis (bowed string pads, Karplus-Strong / harmonic plucked harp & lute, breathy formant woodwind flute/ocarina, deep resonant cello/contrabass, organic frame drums & cinematic timpani) routed through a procedural stereo convolution reverb, subtle stereo ping-pong delay, stereo panning, and master bus glue compression.
- **Spacious, breathing musical pacing:** Grounded organic tempi (~68–118 BPM across states instead of 112–148 BPM arcade loops) with warm pads and gentle plucks carrying the pulse while flute/harp melodies enter in expressive, non-repeating generative waves with natural rests.
- **4 distinct island biome palettes:** Give `emerald_spire`, `canyon_arch`, `twin_pillars`, and `mountain_spine` unique musical keys, modal color, and instrumentation balance so switching islands in the lobby or starting a match immediately establishes a sense of place.
- **Full macro + micro gameplay correlation:**
  - *Macro arc:* Smoothly evolve instrumentation and harmonic tension from calm morning opening -> active skirmish -> late-round afternoon/sunset storm -> dramatic Round 5 `FINAL_FLOOD` -> distinct triumphant `victory` or bittersweet noble `defeat` resolution.
  - *Micro-moments:* Subtle harmonic tension swell while aiming/charging a shot; suspenseful breath/percussion pullback during Shot Cam projectile flight so explosions hit harder; calmer tactical bed during Armory/Draft, Drone Recon, or enemy turns; key-aware harmonic stingers for KO, Round End, Flood Alarm, Evolution/Mutation, and Armory Purchase.
- **Living island ambience:** Continuous procedural ocean surf, wind gusts scaled to the live match wind vector, airy altitude breeze in Drone Recon, and storm/rain wash in late rounds and Final Flood.
- **Clean HUD & independent mute ergonomics:** Keep the existing uncluttered HUD (`N` toggles Music, `M` toggles Master Audio). Muting Music (`N`) silences the musical score while leaving island ambience softly alive; Master Mute (`M`) silences everything (music, ambience, and SFX).

### Non-Goals
- No external paid audio assets, licensed music files, or multi-MB audio downloads (must remain zero-asset and fast-loading on GitHub Pages).
- No changes to `shared/` simulation code or `server/` multiplayer protocol.
- No HUD layout overhaul or new volume slider popovers.
- No replacement of core combat SFX in `synthAudio.ts` (other than ensuring clean bus headroom and ducking cohesion with the upgraded music/ambience engine).

### Anti-Goals (Failure Modes to Avoid)
- **No gimmicky/toy-like sound:** Never fall back to dry quantized arcade melodies, chiptune lead riffs, or bouncy pop-drum loops.
- **No jarring transitions:** Never hard-cut tempos or reset measures mid-phrase when moods or micro-states change; crossfade vertical stems smoothly and glide tempi organically.
- **No wall-of-sound fatigue:** Never run nonstop dense lead lines during tactical thinking turns; preserve silence, sustain, and breathing room.
- **No clipping or WebAudio instability:** Never clip when explosions overlap with Flood music and ambience; never leak timers or throw in headless Node tests or browsers with suspended/partial WebAudio APIs.

---

## 3. Approaches Considered

| Approach | Summary | Trade-offs | Decision |
| :--- | :--- | :--- | :--- |
| **1. Upgraded Zero-Asset Procedural WebAudio Studio Engine** | Modular WebAudio engine with procedural stereo convolution reverb, ping-pong delay, dynamics compression, acoustic-inspired synthesis (plucked strings, breathy flutes, bowed pads, frame drums), generative non-repeating phrasing, vertical stem mixing, and procedural island ambience. | Tiny bundle size, instant load on GitHub Pages, infinite non-repeating variation, continuous real-time reactivity to wind/charge/flight/biome. Requires careful DSP tuning and voice-count budgeting so voices stay rich yet lightweight. | **Selected** |
| **2. Pre-rendered Multi-Stem Audio Tracks** | Render static multi-stem `.ogg`/`.mp3` loops offline and crossfade stems in WebAudio. | Rich static mastering, but adds multi-MB downloads to GitHub Pages, locks matches to repeating fixed loop lengths, and makes biome × micro-moment reactivity rigid. | Rejected |
| **3. Hybrid (Sampled Instruments + Procedural)** | Bundle lightweight acoustic instrument samples or ambient loops and trigger/layer them procedurally. | Realistic single-note attack, but introduces async asset-loading latency, licensing/asset curation overhead, and larger deployment footprint. | Rejected |

---

## 4. Architecture & Module Breakdown

Keep `client/src/audio/musicEngine.ts` clean and maintainable by decomposing the studio engine into focused single-responsibility modules under `client/src/audio/`:

```text
client/src/audio/
├── musicTypes.ts        # Shared types: MusicMood, MusicStingerKind, MusicGameplayContext, BiomePalette, LayerTargets
├── musicTheory.ts       # 4 biome modal palettes, rich chord voicings (add9/maj7/sus2/m9), generative phrase & humanization engine
├── musicEffects.ts      # Stereo convolution reverb (procedural IR), stereo ping-pong delay, master bus compressor, music & ambience buses
├── musicInstruments.ts  # Acoustic-inspired voices: bowed string pads, plucked harp/lute, breathy flute, cello bass, frame drums/timpani, harmonic stingers
├── ambienceEngine.ts    # Continuous procedural island soundscape: ocean surf, live wind-vector gusts, drone altitude breeze, storm/flood swell
├── musicEngine.ts       # Adaptive conductor: lookahead scheduler, smooth tempo glide, vertical stem crossfading, micro-moment reactivity
└── synthAudio.ts        # Existing SFX + MusicEngine facade (adds setMusicContext, preserves all existing methods)
```

### 4.1 Audio Signal Graph & Independent Mute Routing

```text
[Musical Voices: Pad, Pluck, Flute, Cello, Percussion, Stingers]
   ├── Dry Send ──────────────────────┐
   ├── Reverb Send ──> ConvolverNode ─┤──> musicStemSum ──> duckGain ──> musicToneFilter ──> musicMuteGain ──┐
   └── Delay Send ───> PingPongDelay ─┘                                                                       │
                                                                                                              ├──> musicBusGlue ──┐
[Living Ambience: Ocean Surf, Wind Gusts, Altitude Breeze, Storm Swell]                                       │                   ├──> sharedSafetyLimiter ──> ctx.destination
   └── ambienceSum ──> ambienceDuckGain ──────────────────────────────────────────────────> ambienceMuteGain ─┘                   │
                                                                                                                                  │
[Combat & UI SFX (SynthAudio)] ──> sfxMasterGain ─────────────────────────────────────────────────────────────────────────────────┘
```

- **Shared Peak-Safety Limiting (Architect's Call):** `SynthAudio` creates an optional `DynamicsCompressorNode` (`sharedSafetyLimiter`, tuned as a transparent peak limiter so explosions don't pump ambience) before `ctx.destination`, and passes it to `MusicEngine` via an optional second constructor callback `getOutputNode?: () => AudioNode | null` (defaulting to `ctx.destination` for standalone `MusicEngine` usage and tests). `MusicEngine` retains its own gentle `musicBusGlue` compressor on the music+ambience sum.
- **Music Mute (`N`):** Smoothly ramps `musicMuteGain` to `0`, while `ambienceMuteGain` remains gently audible (softened slightly so the island still breathes).
- **Master Mute (`M`):** Smoothly ramps `musicMuteGain`, `ambienceMuteGain`, and `sfxMasterGain` to `0`.
- **Explosion / Stinger Ducking:** `duckGain` dips cleanly (e.g. -4 to -6 dB with fast 18ms attack and smooth ~0.5–0.8s release) so explosions and stingers cut through without pumping or clipping.
- **Graceful Headless / Mock Fallback:** `musicEffects.ts` and `synthAudio.ts` check for optional WebAudio factory methods (`createConvolver`, `createStereoPanner`, `createDynamicsCompressor`, `createDelay`) and fall back seamlessly to direct gain/filter routing when running under minimal unit-test mocks.

### 4.2 Biome Musical Palettes (`musicTheory.ts`)

Each of the 4 island biomes defines a distinct tonic, scale/mode, chord progression family (calm, active, storm/intense, flood), and subtle timbral weighting:

| Biome (`ThemeId`) | Key & Mode | Emotional Color | Signature Instrumentation Emphasis |
| :--- | :--- | :--- | :--- |
| `emerald_spire` | **D Lydian / Major9** (shifts to D Dorian/Aeolian in storm) | Sunlit pastoral wonder, verdant open sky | Warm lush pads, bright harp arpeggios, airy wooden flute |
| `canyon_arch` | **A Dorian / Mixolydian** (shifts to A Phrygian-tinged in storm) | Sun-baked sandstone warmth, mysterious canyon echoes | Resonant nylon/lute plucks, deeper warm cello swells, hand frame drum |
| `twin_pillars` | **F Lydian / Major7** (shifts to F Minor/Dorian in storm) | Crisp sea-stack breezes, glassy open coastal horizon | Shimmering high harp harmonics, spacious ping-pong echoes, airy flute |
| `mountain_spine` | **G Dorian / Aeolian** (shifts to G Harmonic/Natural Minor in storm) | Cool alpine mist, noble highland resolve | Deep resonant cello/string ensemble, stately distant horn/flute, resonant timpani |

- **Rich Voicings:** Chords use open 4–5 note voicings (root + fifth + ninth/seventh/third spread across octaves) rather than tight triad blocks, preventing muddy low-mid buildup.
- **Generative Non-Repeating Phrasing:** Instead of looping a rigid 2-bar melody forever, each 4-bar phrase selects from curated melodic motifs and weighted step-wise scale contours with **intentional breathing bars** (rest windows where only pads, cello, and sparse harp plucks carry the air), subtle timing micro-humanization (±6–14ms), and velocity contours.

### 4.3 Acoustic-Inspired Instrument Voices (`musicInstruments.ts`)

1. **Bowed String / Atmospheric Pad:** Sustained 2–4 bar chords using softly detuned warm waveforms + slow LFO pitch/filter drift through a resonant lowpass filter with slow attack (0.6–1.4s) and long release (1.0–2.0s), panned softly wide and fed generously into the stereo convolution reverb.
2. **Organic Harp / Lute Pluck:** Plucked-string voice combining a filtered noise/impulse excitation or warm damped harmonic stack with fast woody body decay and subtle stereo placement, feeding both reverb and subtle ping-pong delay so notes bloom into the sky.
3. **Breathy Woodland Flute / Ocarina:** Expressive solo melody voice combining a soft sine/triangle core with subtle bandpassed breath-chiff noise on attack, gentle pitch glide into held notes, delayed gentle vibrato LFO (5.2 Hz), and expressive swell envelope.
4. **Warm Cello / Contrabass Drone & Swell:** Deep bowed low-register foundation anchored on chord roots/fifths (slow bow-pressure lowpass swell rather than staccato synth-bass pulses), giving emotional weight and grounding.
5. **Organic Frame Drum, Shaker & Cinematic Timpani:** Soft low skin resonance, gentle brushed percussive texture, and resonant deep timpani rolls/swells. Absent or whispered during calm lobby/planning moments; layered smoothly as round tension, low HP, or Final Flood escalates.
6. **Key-Aware Harmonic Stingers:**
   - `ko`: Dramatic resonant low timpani + descending modal cello/horn fifth in the active biome's key.
   - `round_end`: Warm ascending harp + lush chord swell resolving to the biome tonic.
   - `flood_alarm`: Deep sub-swell + ominous minor-second / tritone horn & rolling timpani surge.
   - `purchase`: Gentle warm lute/harp harmonic dyad (subtle, non-jarring inside Armory).
   - `evolution`: Shimmering ascending Lydian harp & airy flute overtone bloom on Evo Pod mutation / Apex synergy.

### 4.4 Living Island Ambience (`ambienceEngine.ts`)

A lightweight continuous noise-sculpting engine using looped deterministic stereo noise buffers (no high CPU per-frame allocations):
- **Ocean Surf:** Dual slow-LFO-modulated lowpass/bandpass wave beds (~0.11 Hz and ~0.17 Hz uncorrelated wave cycles) that deepen and rise subtly as `waterLevel` increases.
- **Live Island Wind:** Resonant bandpass wind layer whose center frequency and gain track live `windSpeed = hypot(wind.x, wind.z)` from match state, giving players an intuitive *audible* feel for heavy crosswinds.
- **Drone Recon Altitude Breeze:** When `cameraMode === "drone_recon" || cameraMode === "spectator_drone"`, wind shifts slightly brighter and airier while low ocean rumble pulls back.
- **Storm & Final Deluge Wash:** High-shelf rain mist + low-band turbulent storm gusts fade in smoothly across Rounds 4–5 (`stormFactor` 0 -> 1) and swell prominently during `FINAL_FLOOD`.

### 4.5 Gameplay-to-Music Correlation & Smooth Transitions (`musicEngine.ts` + `main.ts`)

**Mood Ownership & Contract (Architect's Call):** `main.ts` continues owning discrete `MusicMood` derivation (keeping match timers, win/loss detection, and Duel-safe showdown logic decoupled from `MusicEngine`) and passes both `mood` and continuous telemetry in a single `MusicGameplayContext` payload via `setContext(ctx)` (while `setMood(mood)` remains a direct convenience setter that updates `ctx.mood` cleanly for backwards compatibility and unit tests):

```ts
export interface MusicGameplayContext {
  mood: MusicMood;
  theme: ThemeId;
  round: number;
  maxRounds: number;
  isMyTurn: boolean;
  isCharging: boolean;
  chargePower: number;     // 0..1
  isShotFlight: boolean;   // true during Shot Cam / RESOLVING
  isDroneView: boolean;    // true during drone_recon / spectator_drone
  hpRatio: number;         // 0..1 local critter health ratio
  windSpeed: number;       // hypot(wind.x, wind.z) in m/s
  waterLevel: number;      // current world water Y
  floodIntensity: number;  // 0..1 storm/deluge ramp
  isShowdown: boolean;     // true only after eliminations narrow a >2-player match to final 1v1
}
```

- **Duel-Safe Showdown Rule (Architect's Call):** `isShowdown` is computed in `main.ts` as:
  - FFA: `state.critters.length > 2 && aliveCount === 2`
  - 2v2: `state.critters.length >= 4 && teamAAlive === 1 && teamBAlive === 1`
  This guarantees 2-player Duel matches (`critters.length === 2`) experience the full calm-morning -> skirmish -> storm macro arc instead of starting in `intense` on Turn 1.
- **Moods & Grounded Tempi:**
  - `lobby`: ~74 BPM — Serene sunlit pads, gentle harp plucks, sparse welcoming flute phrases, warm ocean & breeze.
  - `shop` (Armory open / Draft phases): ~72 BPM — Intimate lowpass veil (~1350 Hz), warm sustained pad + sparse gentle plucks, percussion muted so tactical reading is calm.
  - `battle` (Active match, early/mid rounds): ~86 BPM — Full breathing woodland-adventure score; pads + harp + cello pulse + expressive flute phrases with rest bars; light organic frame drum enters on active turns.
  - `intense` (Late rounds 4+, `roundTimeRemainingSec <= 60`, low HP `< 35%`, `isShowdown`, or active turn `phaseTimeRemainingSec <= 6`): ~102 BPM — Shifts biome scale toward darker Dorian/Aeolian tension, adds driving rhythmic cello ostinato, fuller frame drums & timpani accents, higher flute urgency.
  - `flood` (`FINAL_FLOOD` Round 5 deluge): ~114 BPM — Rising chromatic/modal storm progression, surging storm ambience, relentless deep timpani & sweeping dramatic strings.
  - `victory` (`MATCH_OVER` & local player/team won): ~80 BPM — Radiant major/Lydian resolution, uplifting harp cascade + noble triumphant flute theme, warm peaceful ocean settle.
  - `defeat` (`MATCH_OVER` & local player/team lost): ~68 BPM — Poignant, dignified bittersweet minor/Dorian cello + sparse echoing harp resolution, calm ocean twilight.
- **Smooth Transitions:**
  - Tempo glides smoothly toward target BPM per scheduled step (never an abrupt jump).
  - Vertical stem gains (`pad`, `pluck`, `cello`, `flute`, `percussion`, `chargeShimmer`) interpolate smoothly via `AudioParam.setTargetAtTime` (0.35s–1.2s time constants).
  - Harmonic key/progression changes take effect cleanly at bar boundaries (or immediately on major match-state transitions like `FINAL_FLOOD` / `MATCH_OVER` with a lush crossfade tail).
- **Micro-Moment Modifiers (Layered Over Base Mood):**
  1. **Aiming / Charging (`isCharging`, `chargePower` 0..1):** Gently swells a subtle high harmonic string/shimmer tension voice and slightly tightens percussion focus as `chargePower` climbs; releases cleanly when fired or cancelled.
  2. **Shot Flight / Shot Cam (`isShotFlight` / `phase === "RESOLVING"`):** Creates a brief cinematic "breath" — percussion pulls back ~55%, reverb/pad bloom slightly — so the incoming artillery explosion and `duck()` land with dramatic contrast.
  3. **Your Turn vs Enemy Turn:** On enemy turns, percussion and lead flute soften slightly (~-3 dB) while pads/cello stay warm, subtly reinforcing turn ownership without losing flow.
  4. **Drone Recon Camera (`isDroneView`):** Pulls back low percussion slightly, opens pad reverb/airy space, and elevates the high-altitude wind ambience.
  5. **Lobby Biome Preview:** Changing the island biome in the lobby immediately transitions the harmonic palette so players hear each island's identity while browsing maps.

---

## 5. Integration Surface (`main.ts` & `synthAudio.ts`)

- `SynthAudio` adds `setMusicContext(context: MusicGameplayContext): void` and `setMusicTheme(theme: ThemeId): void`, delegating directly to `MusicEngine`, while keeping every existing public method intact.
- **Avoiding Bitonal UI SFX Clashes & Bot Stinger Spam (Architect's Call):**
  - `playShopBuy()` keeps its crisp non-pitched mechanical latch click, and only plays its fallback D-major triad when background music is muted; when music is unmuted, the biome-key-aware `playStinger("purchase")` supplies the harmonic chime cleanly with zero bitonal clash.
  - For `MUTATION_EQUIPPED` (exact `EngineEvent` type in `shared/src/types.ts`): trigger `this.audio.playStinger("evolution")` **only when `ev.playerId === localId`** (preventing AI bots drafting back-to-back from spamming overlapping stingers), with an extra radiant overtone flourish when `ev.apex !== null`. Remove the duplicate hardcoded C-major `playMutationChime()` from in-match `onPickMutation` / local `MUTATION_EQUIPPED` while preserving `playMutationChime()` for lobby unlocks and Prism Wall shatter.
  - Wire `this.audio.playStinger("ko")` when a critter is knocked out during match resolution (`CRITTER_KO` / KO hit playback).
- `CritterSiegeApp` (`client/src/main.ts`):
  - Computes `MusicMood` (including `victory` vs `defeat` via `winnerTeam`/`winnerId`, `roundTimeRemainingSec`, `phaseTimeRemainingSec`, and Duel-safe `isShowdown`) and pushes `MusicGameplayContext` in `updateAdaptiveMusicMood()` and lobby theme changes.
  - Keeps updates lightweight by diffing/throttling continuous telemetry (`chargePower`, `windSpeed`, `waterLevel`, `floodIntensity`) so AudioParam ramps aren't spammed unnecessarily every animation frame.

---

## 6. What's Left to the Builder

- Exact DSP filter Q values, impulse-response decay curves, voice gain trim tables, and stereo pan positions (tuned for pleasant, fatigue-free headphone/speaker balance with zero clipping).
- Exact Markov/motif transition weights and voice-polyphony caps to guarantee low CPU usage during 60fps Three.js rendering.
- Exact throttling epsilon for continuous context updates (`chargePower`, `windSpeed`, `waterLevel`) in `main.ts`.
- Updating `client/test/audio.test.ts` to assert the new grounded BPM ranges, 7 moods (including `defeat`), 4 biome palettes, micro-moment reactivity, independent music-vs-ambience mute routing, and mock-AudioContext graceful degradation.

---

## 7. Verification & Acceptance Criteria

1. **Automated Verification Suite (`npm run verify`):** `typecheck`, `lint`, `vitest`, and `build` all exit `0`.
2. **Unit Test Coverage (`client/test/audio.test.ts`):**
   - Verifies all 7 moods (`lobby`, `battle`, `intense`, `shop`, `flood`, `victory`, `defeat`) and smooth tempo glide / filter transitions.
   - Verifies all 4 biome palettes produce distinct harmonic content and clean transitions.
   - Verifies micro-moment context updates (charging shimmer, Shot Cam breath, Drone Recon, Armory filter veil, enemy turn softening, live wind-to-ambience coupling).
   - Verifies independent `N` (Music Mute keeps ambience alive) vs `M` (Master Mute silences music + ambience + SFX).
   - Verifies zero throws under headless Node (no `AudioContext`) and minimal mock `AudioContext`, plus zero lingering timers on `dispose()`.
3. **Live Browser Verification:** Start dev client in browser, exercise lobby biome switching, Play-vs-Bots battle, aiming/charging, firing into Shot Cam, Drone Recon, Armory open/close, and `N`/`M` toggles with zero console or WebAudio errors.
4. **Independent Read-Only Review:** `reviewer` subagent audits full diff against `AGENTS.md` Do-Not Rules and live `npm run verify` output (`Overall Verdict: PASS`).
