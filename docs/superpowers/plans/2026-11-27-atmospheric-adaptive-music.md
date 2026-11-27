# Atmospheric Adaptive Music & Living Soundscape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Critter Siege's dry 16-step arcade soundtrack with a studio-grade, zero-asset procedural WebAudio woodland-adventure score and living island ambience engine deeply correlated with island biomes, match progression, and tactical micro-moments.

**Architecture:** Decompose `client/src/audio/` into six focused modules (`musicTypes`, `musicTheory`, `musicEffects`, `musicInstruments`, `ambienceEngine`, `musicEngine`) routed through a shared peak-safety limiter in `synthAudio.ts`, with `main.ts` feeding a throttled `MusicGameplayContext` derived via a pure testable helper.

**Tech Stack:** TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), WebAudio API (zero external assets), Vitest, ESLint, Vite (`client/` workspace only).

**Spec:** [2026-11-27-atmospheric-adaptive-music-design.md](file:///c:/Users/austi/.gemini/antigravity/scratch/Simple%20Game/docs/superpowers/specs/2026-11-27-atmospheric-adaptive-music-design.md)

## Global Constraints

- **Zero external audio assets:** Everything is synthesized procedurally in browser-native WebAudio with zero new npm dependencies and zero changes to `shared/` or `server/`.
- **Strict TypeScript & Governance:** `strict: true`, `noUncheckedIndexedAccess: true`, explicit return types on all exported functions, zero `any` casts or `@ts-ignore`/`eslint-disable`, and `npm run verify` (`typecheck`, `lint`, `vitest`, `build`) MUST pass after every individual file edit (`AGENTS.md` Rule 2).
- **Subagent Governance (`AGENTS.md` Rule 3):** Implementation runs through `builder` and final validation runs through strictly read-only `reviewer`.
- **Clean HUD preserved:** No new HUD controls or sliders; `N` toggles Music (leaving island ambience softly alive), `M` toggles Master Audio (silencing SFX, music, and ambience).
- **Backwards-compatible public API:** Preserve `MusicEngine` (`start`, `stop`, `setMood`, `getMood`, `getBpm`, `setMusicMuted`, `isMusicMuted`, `toggleMusicMute`, `setMasterMuted`, `duck`, `playStinger`, `dispose`) and all existing `SynthAudio` methods.

## Review Focus

1. **Minimal / Partial WebAudio & Headless Safety:** Running in Node (no `AudioContext`) or under mocks lacking `createConvolver`, `createStereoPanner`, `createDynamicsCompressor`, or `createDelay` must fall back cleanly with zero throws (pinned in Tasks 2 & 4).
2. **Duel-Safe 1v1 Showdown Detection:** A 2-player Duel (`critters.length === 2`) on Round 1 Turn 1 must stay in `battle` mood, whereas a 3–4+ player FFA narrowed to 2 survivors (or 4-player 2v2 narrowed to 1v1) sets `isShowdown = true` and enters `intense` (pinned in Task 6).
3. **Independent Music Mute (`N`) vs Master Mute (`M`) & Clean Teardown:** `setMusicMuted(true)` ramps music gain to `0` while keeping island ambience audible (`> 0`); `setMasterMuted(true)` zeroes both; `dispose()` clears all timers, stops continuous ambience sources, disconnects nodes, and never closes a shared external `AudioContext` (pinned in Tasks 3 & 4).
4. **No Bitonal UI SFX Clash & No Bot Stinger Spam:** `playShopBuy()` suppresses its fallback D-major triad while music is unmuted (leaving the biome-key-aware `purchase` stinger clash-free), and `MUTATION_EQUIPPED` fires `playStinger("evolution")` only for the local player (pinned in Tasks 5 & 6).
5. **Non-Finite Telemetry & Background-Tab Recovery:** Passing `NaN`/`Infinity`/out-of-range telemetry (`windSpeed`, `chargePower`, `waterLevel`, `hpRatio`, `floodIntensity`) or jumping `ctx.currentTime` forward by 30+ seconds after tab sleep must clamp safely without scheduling non-finite `AudioParam` values or freezing in a catch-up loop (pinned in Tasks 3 & 4).

---

### Task 1: Music Types, Biome Harmonic Palettes & Generative Phrase Planner

**Files:**
- Create: `client/src/audio/musicTypes.ts`
- Create: `client/src/audio/musicTheory.ts`
- Create: `client/test/musicTheory.test.ts`

**Interfaces:**
- Consumes: `ThemeId` from `@critter/shared`
- Produces:
  - `client/src/audio/musicTypes.ts`:
    - `export type MusicMood = "lobby" | "battle" | "intense" | "shop" | "flood" | "victory" | "defeat";`
    - `export type MusicStingerKind = "ko" | "round_end" | "flood_alarm" | "purchase" | "evolution";`
    - `export interface MusicGameplayContext { mood: MusicMood; theme: ThemeId; round: number; maxRounds: number; isMyTurn: boolean; isCharging: boolean; chargePower: number; isShotFlight: boolean; isDroneView: boolean; hpRatio: number; windSpeed: number; waterLevel: number; floodIntensity: number; isShowdown: boolean; }`
    - `export interface StemMixTargets { pad: number; pluck: number; cello: number; flute: number; percussion: number; chargeShimmer: number; filterHz: number; reverbWet: number; }`
    - `export interface ChordVoicing { readonly name: string; readonly rootMidi: number; readonly padNotes: readonly number[]; readonly pluckNotes: readonly number[]; readonly melodyScale: readonly number[]; }`
    - `export interface BiomePalette { readonly theme: ThemeId; readonly tonicMidi: number; readonly calmChords: readonly ChordVoicing[]; readonly battleChords: readonly ChordVoicing[]; readonly intenseChords: readonly ChordVoicing[]; readonly floodChords: readonly ChordVoicing[]; readonly victoryChords: readonly ChordVoicing[]; readonly defeatChords: readonly ChordVoicing[]; readonly timbreBias: { readonly pad: number; readonly pluck: number; readonly flute: number; readonly cello: number; readonly percussion: number; }; }`
    - `export interface PlannedStepEvent { readonly pluckMidi: number | null; readonly pluckVelocity: number; readonly pluckPan: number; readonly fluteMidi: number | null; readonly fluteDurationSteps: number; readonly fluteVelocity: number; readonly celloMidi: number | null; readonly celloDurationSteps: number; readonly frameDrumGain: number; readonly shakerGain: number; readonly timpaniMidi: number | null; readonly timpaniGain: number; readonly humanizeSec: number; }`
  - `client/src/audio/musicTheory.ts`:
    - `export const MOOD_TARGET_BPM: Readonly<Record<MusicMood, number>>` (`lobby: 74, shop: 72, battle: 86, intense: 102, flood: 114, victory: 80, defeat: 68`)
    - `export function createDefaultMusicContext(): MusicGameplayContext`
    - `export function midiToFreq(midi: number): number`
    - `export function getBiomePalette(theme: ThemeId): BiomePalette`
    - `export function getChordForBar(theme: ThemeId, mood: MusicMood, barIndex: number): ChordVoicing`
    - `export function computeStemMixTargets(ctx: MusicGameplayContext): StemMixTargets`
    - `export class GenerativePhrasePlanner` with `planStep(theme: ThemeId, mood: MusicMood, barIndex: number, stepInBar: number, isMyTurn: boolean, isShotFlight: boolean): PlannedStepEvent` and `reset(seed?: number): void`

- [ ] **Step 1: Create `client/src/audio/musicTypes.ts` with all exported audio types**

Run: `npm run verify`
Expected: PASS

- [ ] **Step 2: Write failing unit tests in `client/test/musicTheory.test.ts`**

Test assertions to include:
- All 4 biome palettes (`emerald_spire`, `canyon_arch`, `twin_pillars`, `mountain_spine`) have distinct tonic MIDI notes (`62` D, `57` A, `65` F, `55` G) and non-empty 4–8 bar open voicings (`padNotes.length >= 4`) for every mood.
- Grounded organic BPM targets match spec (`lobby: 74`, `shop: 72`, `battle: 86`, `intense: 102`, `flood: 114`, `victory: 80`, `defeat: 68`).
- `computeStemMixTargets` applies spec micro-moments:
  - `shop` lowers `filterHz <= 1450` and mutes `percussion === 0`.
  - `isCharging && chargePower > 0.5` raises `chargeShimmer > 0`.
  - `isShotFlight` pulls back `percussion` by at least 45% relative to normal `battle` and raises `reverbWet`.
  - `isDroneView` pulls back `percussion` and raises `reverbWet`.
  - `isMyTurn === false` softens `flute` and `percussion` compared to `isMyTurn === true`.
- `GenerativePhrasePlanner` includes intentional breathing rest bars (over 16 bars of `battle`, at least 30% of bars have zero flute notes) and generates non-identical consecutive 8-bar flute contours while clamping `humanizeSec` within `[-0.015, 0.015]`.

Run: `npx vitest run client/test/musicTheory.test.ts`
Expected: FAIL (`musicTheory.js` not found)

- [ ] **Step 3: Implement `client/src/audio/musicTheory.ts`**

Implement the 4 distinct modal biome palettes (`emerald_spire` D Lydian/Dorian, `canyon_arch` A Dorian/Phrygian, `twin_pillars` F Lydian/Minor, `mountain_spine` G Dorian/Aeolian) with wide open add9/maj7/sus2/m9 voicings, deterministic PRNG-driven `GenerativePhrasePlanner` with breathing windows and weighted stepwise contours, and `computeStemMixTargets`.

Run: `npm run verify`
Expected: PASS

- [ ] **Step 4: Commit Task 1**

```powershell
git add client/src/audio/musicTypes.ts client/src/audio/musicTheory.ts client/test/musicTheory.test.ts
git commit -m "feat(audio): add music types, 4 biome harmonic palettes, and generative phrase planner"
```

---

### Task 2: Studio Spatial Effects Bus & Acoustic-Inspired Instrument Voices

**Files:**
- Create: `client/src/audio/musicEffects.ts`
- Create: `client/src/audio/musicInstruments.ts`
- Create: `client/test/musicEffectsAndInstruments.test.ts`

**Interfaces:**
- Consumes: `ChordVoicing`, `MusicStingerKind` from `./musicTypes.js`, `midiToFreq` from `./musicTheory.js`
- Produces:
  - `client/src/audio/musicEffects.ts`:
    - `export interface StudioAudioBus { readonly ctx: AudioContext; readonly musicDryIn: GainNode; readonly reverbSend: GainNode; readonly delaySend: GainNode; readonly ambienceIn: GainNode; readonly duckGain: GainNode; readonly musicMuteGain: GainNode; readonly ambienceMuteGain: GainNode; readonly musicToneFilter: BiquadFilterNode; readonly hasConvolver: boolean; readonly hasDelay: boolean; readonly hasCompressor: boolean; setMusicMuted(muted: boolean): void; setMasterMuted(muted: boolean): void; setFilterCutoff(hz: number, timeConstantSec?: number): void; setReverbWet(wet: number, timeConstantSec?: number): void; duck(depth?: number, durationSec?: number): void; dispose(): void; }`
    - `export function createStudioAudioBus(ctx: AudioContext, destination?: AudioNode | null): StudioAudioBus`
  - `client/src/audio/musicInstruments.ts`:
    - `export class AcousticVoiceBank`
      - `playPadChord(bus: StudioAudioBus, midiNotes: readonly number[], time: number, durationSec: number, peakGain: number): void`
      - `playPluckNote(bus: StudioAudioBus, midi: number, time: number, velocity: number, pan: number): void`
      - `playFluteNote(bus: StudioAudioBus, midi: number, time: number, durationSec: number, velocity: number, prevMidi?: number | null): void`
      - `playCelloNote(bus: StudioAudioBus, midi: number, time: number, durationSec: number, peakGain: number): void`
      - `playFrameDrum(bus: StudioAudioBus, time: number, peakGain: number, accent?: boolean): void`
      - `playBrushShaker(bus: StudioAudioBus, time: number, peakGain: number): void`
      - `playTimpani(bus: StudioAudioBus, midi: number, time: number, durationSec: number, peakGain: number): void`
      - `playChargeShimmer(bus: StudioAudioBus, chord: ChordVoicing, time: number, durationSec: number, intensity: number): void`
      - `playStinger(bus: StudioAudioBus, kind: MusicStingerKind, chord: ChordVoicing, time: number, apexBonus?: boolean): void`
      - `dispose(): void`

- [ ] **Step 1: Write failing tests in `client/test/musicEffectsAndInstruments.test.ts`**

Test assertions to include:
- **Review Focus #1 (Full vs Minimal Mock Fallback):**
  - On a full mock `AudioContext` (with `createConvolver`, `createDelay`, `createStereoPanner`, `createDynamicsCompressor`), `createStudioAudioBus` builds convolution IR, ping-pong delay, and glue compressor (`hasConvolver === true`, `hasDelay === true`, `hasCompressor === true`).
  - On a minimal mock `AudioContext` (omitting `createConvolver`, `createDelay`, `createStereoPanner`, `createDynamicsCompressor`), `createStudioAudioBus` falls back cleanly (`hasConvolver === false`, `hasDelay === false`, `hasCompressor === false`) with zero throws.
- Independent mute routing on `StudioAudioBus`: `setMusicMuted(true)` drives `musicMuteGain` to `0` while keeping `ambienceMuteGain > 0`; `setMasterMuted(true)` drives both `musicMuteGain` and `ambienceMuteGain` to `0`.
- `AcousticVoiceBank` synthesizes all voices (`playPadChord`, `playPluckNote`, `playFluteNote`, `playCelloNote`, `playFrameDrum`, `playBrushShaker`, `playTimpani`, `playChargeShimmer`) and all 5 key-aware stingers (`ko`, `round_end`, `flood_alarm`, `purchase`, `evolution`) cleanly on both full and minimal mock contexts, scheduling valid finite frequencies derived from `chord.rootMidi`.

Run: `npx vitest run client/test/musicEffectsAndInstruments.test.ts`
Expected: FAIL (`musicEffects.js` / `musicInstruments.js` not found)

- [ ] **Step 2: Implement `client/src/audio/musicEffects.ts`**

Generate a cached deterministic stereo room/valley impulse response (~2.1s warm exponential decay with subtle early reflections and high-frequency damping), build optional stereo ping-pong delay + gentle glue `DynamicsCompressorNode`, route `musicDryIn`/`reverbSend`/`delaySend` -> `duckGain` -> `musicToneFilter` -> `musicMuteGain` and `ambienceIn` -> `ambienceMuteGain`, and gracefully bypass unavailable optional nodes.

Run: `npm run verify`
Expected: PASS (note: test file still imports `musicInstruments.js` so create `musicInstruments.ts` before expecting that test file to pass, OR keep test imports split cleanly — wait: to uphold Rule 2 single-edit verification strictly, create `musicEffects.ts` FIRST, run `npm run verify`, create `musicInstruments.ts`, run `npm run verify`, then add/run `musicEffectsAndInstruments.test.ts` or write each module's test right before its module!).
**Rule 2 Execution Discipline Note:** To satisfy BOTH TDD and Rule 2 (`npm run verify` PASS after every single file edit), keep `musicEffects.test.ts` / `musicEffectsAndInstruments.test.ts` cleanly structured so each single-file edit compiles and passes `npm run verify` before moving to the next file (for TDD red check, run targeted `npx vitest run` on the new test right after writing it, then immediately implement the module so `npm run verify` returns to green).

- [ ] **Step 3: Implement `client/src/audio/musicInstruments.ts`**

Build warm bowed string pad (detuned ensemble + gentle slow LFO + long attack/release), organic harp/lute pluck (woody filtered attack + warm harmonic decay sent to reverb + delay), breathy wooden flute (soft chiff noise transient + portamento glide + delayed 5.2 Hz vibrato + expressive envelope), deep cello swell, organic frame drum + brush shaker + deep timpani, harmonic charge shimmer, and key-aware stingers for all 5 kinds (including extra radiant overtone flourish when `apexBonus` is true on `evolution`).

Run: `npm run verify`
Expected: PASS

- [ ] **Step 4: Commit Task 2**

```powershell
git add client/src/audio/musicEffects.ts client/src/audio/musicInstruments.ts client/test/musicEffectsAndInstruments.test.ts
git commit -m "feat(audio): add studio spatial effects bus and acoustic instrument voices"
```

---

### Task 3: Living Procedural Island Ambience Engine

**Files:**
- Create: `client/src/audio/ambienceEngine.ts`
- Create: `client/test/ambienceEngine.test.ts`

**Interfaces:**
- Consumes: `StudioAudioBus` from `./musicEffects.js`, `MusicGameplayContext` from `./musicTypes.js`
- Produces:
  - `client/src/audio/ambienceEngine.ts`:
    - `export class AmbienceEngine`
      - `start(bus: StudioAudioBus): void`
      - `update(ctx: MusicGameplayContext): void`
      - `stop(): void`
      - `isRunning(): boolean`
      - `dispose(): void`

- [ ] **Step 1: Write failing unit tests in `client/test/ambienceEngine.test.ts`**

Test assertions to include:
- `start(bus)` starts looped noise sources for ocean surf, island wind, and storm wash routed into `bus.ambienceIn` and sets `isRunning() === true`.
- `update(ctx)` scales wind filter frequency & gain upward when `windSpeed` rises from `1` to `12`, elevates airy altitude wind when `isDroneView` is `true`, deepens ocean surf as `waterLevel` increases, and ramps storm wash gain upward when `floodIntensity` moves from `0` to `1`.
- **Review Focus #5 (Non-Finite Telemetry Safety):** Passing `NaN`, `Infinity`, and `-50` for `windSpeed`, `waterLevel`, `floodIntensity` clamps safely without passing `NaN`/`Infinity` to any `AudioParam` method.
- **Review Focus #3 (Clean Teardown):** `stop()` and `dispose()` stop all started buffer sources and oscillators, disconnect nodes cleanly, and are idempotent.

Run: `npx vitest run client/test/ambienceEngine.test.ts`
Expected: FAIL (`ambienceEngine.js` not found)

- [ ] **Step 2: Implement `client/src/audio/ambienceEngine.ts`**

Create a deterministic 3-second pink-weighted stereo noise buffer (cached per `sampleRate`), wire 3 continuous lightweight looped layers into `bus.ambienceIn`:
1. Ocean surf (lowpass filter + slow ~0.12 Hz sine LFO modulating wave swell gain).
2. Live island wind (bandpass filter whose frequency & gain track clamped `windSpeed`, plus brighter airy shelf/band shift when `isDroneView` is active).
3. Storm & Final Deluge wash (bandpass rain/gust bed that stays near-silent at `stormFactor = 0` and blooms smoothly across Rounds 4–5 and `FINAL_FLOOD`).

Run: `npm run verify`
Expected: PASS

- [ ] **Step 3: Commit Task 3**

```powershell
git add client/src/audio/ambienceEngine.ts client/test/ambienceEngine.test.ts
git commit -m "feat(audio): add procedural living island ambience engine"
```

---

### Task 4: Adaptive Conductor `MusicEngine` Overhaul

**Files:**
- Modify: `client/src/audio/musicEngine.ts`
- Modify: `client/test/audio.test.ts`

**Interfaces:**
- Consumes: `musicTypes.ts`, `musicTheory.ts`, `musicEffects.ts`, `musicInstruments.ts`, `ambienceEngine.ts`, `ThemeId` from `@critter/shared`
- Produces:
  - `client/src/audio/musicEngine.ts`:
    - Re-exports `MusicMood`, `MusicStingerKind`, `MusicGameplayContext`
    - `export class MusicEngine`
      - `constructor(getSharedContext?: () => AudioContext | null, getOutputNode?: () => AudioNode | null)`
      - `start(): void`
      - `stop(): void`
      - `setMood(mood: MusicMood): void`
      - `setTheme(theme: ThemeId): void`
      - `setContext(context: Partial<MusicGameplayContext>): void`
      - `getContext(): MusicGameplayContext`
      - `getMood(): MusicMood`
      - `getBpm(): number` (returns current smoothed or target BPM cleanly)
      - `getTargetBpm(): number`
      - `setMusicMuted(muted: boolean): void`
      - `isMusicMuted(): boolean`
      - `toggleMusicMute(): boolean`
      - `setMasterMuted(muted: boolean): void`
      - `duck(depth?: number, durationSec?: number): void`
      - `playStinger(kind: MusicStingerKind, apexBonus?: boolean): void`
      - `dispose(): void`

- [ ] **Step 1: Implement upgraded `client/src/audio/musicEngine.ts`**

Replace the legacy dry 16-step arcade sequencer with the atmospheric vertical-layering conductor:
- Uses `StudioAudioBus`, `AcousticVoiceBank`, `GenerativePhrasePlanner`, and `AmbienceEngine`.
- Smoothly glides `currentBpm` toward `MOOD_TARGET_BPM[mood]` on scheduled steps (no abrupt jarring tempo jumps) while `getTargetBpm()` exposes target BPM and `getBpm()` reflects the current tempo (snapping cleanly when scheduler isn't running so headless `setMood` -> `getBpm()` checks are exact and deterministic).
- Applies vertical stem targets (`pad`, `pluck`, `cello`, `flute`, `percussion`, `chargeShimmer`, `filterHz`, `reverbWet`) smoothly on context updates.
- Schedules warm sustained 2-bar bowed pads, generative harp/lute plucks, expressive breathy flute waves with breathing rest bars, deep cello swells, organic frame drums/timpani, and subtle rising harmonic charge shimmer when `isCharging && chargePower > 0.05`.
- Recovers safely from long background-tab sleeps (`nextStepTime < now - 0.35` resets cleanly to `now + 0.02`, capping max steps scheduled per tick to `8` — **Review Focus #5**).
- Keeps island ambience running softly when only `musicMuted` is `true`, and silences everything when `masterMuted` is `true` (**Review Focus #3**).

Run: `npm run verify`
Expected: `client/test/audio.test.ts` fails on legacy arcade BPMs (`112/124/138/148`) and old `1150 Hz`/`16000 Hz` filter assertions — confirming the old arcade contract is replaced.

- [ ] **Step 2: Update `client/test/audio.test.ts` for the upgraded `MusicEngine` contract**

Update and expand `client/test/audio.test.ts` to verify:
- All 7 moods (`lobby: 74`, `shop: 72`, `battle: 86`, `intense: 102`, `flood: 114`, `victory: 80`, `defeat: 68`) and all 4 biome themes (`emerald_spire`, `canyon_arch`, `twin_pillars`, `mountain_spine`).
- Smooth tempo glide when running and switching moods, shop filter veil (`<= 1450 Hz`), micro-moment `setContext` reactivity (charging shimmer, Shot Cam breath, Drone Recon, enemy turn).
- **Review Focus #1:** Works cleanly on both full mock `AudioContext` and minimal mock `AudioContext` (no convolver/delay/panner/compressor) as well as headless Node.
- **Review Focus #3:** `setMusicMuted(true)` zeroes `musicMuteGain` while `ambienceMuteGain > 0`; `setMasterMuted(true)` zeroes both; `dispose()` clears all timers (`vi.getTimerCount() === 0`) and never closes shared external `AudioContext`.
- **Review Focus #5:** Non-finite context values and a `+60s` clock jump after tab backgrounding clamp safely without scheduling `NaN` or hanging.

Run: `npm run verify`
Expected: PASS

- [ ] **Step 3: Commit Task 4**

```powershell
git add client/src/audio/musicEngine.ts client/test/audio.test.ts
git commit -m "feat(audio): overhaul MusicEngine with atmospheric vertical-stem conductor"
```

---

### Task 5: `SynthAudio` Shared Safety Limiter & Key-Aware UI SFX Cohesion

**Files:**
- Modify: `client/src/audio/synthAudio.ts`
- Modify: `client/test/audio.test.ts`

**Interfaces:**
- Consumes: `MusicEngine`, `MusicMood`, `MusicStingerKind`, `MusicGameplayContext` from `./musicEngine.js`, `ThemeId` from `@critter/shared`
- Produces:
  - `client/src/audio/synthAudio.ts`:
    - Re-exports `MusicMood`, `MusicStingerKind`, `MusicGameplayContext`
    - Adds `setMusicContext(context: Partial<MusicGameplayContext>): void`
    - Adds `setMusicTheme(theme: ThemeId): void`
    - Updates `playStinger(kind: MusicStingerKind, apexBonus?: boolean): void`
    - Routes `masterGain` AND `MusicEngine` output through an optional transparent `sharedSafetyLimiter` (`DynamicsCompressorNode` ahead of `ctx.destination` when supported)
    - Updates `playShopBuy()` so it always plays the crisp non-pitched mechanical latch click, and only plays its fallback D-major triad when background music is muted (preventing bitonal clashes with biome-key-aware `purchase` stingers — **Review Focus #4**)

- [ ] **Step 1: Add failing tests in `client/test/audio.test.ts` for `SynthAudio` new methods & bitonal clash prevention**

Test assertions to include:
- `SynthAudio` exposes `setMusicContext`, `setMusicTheme`, and `playStinger("evolution", true)`.
- **Review Focus #4:** When `audio.isMusicMuted() === false`, `audio.playShopBuy()` only creates the single tactile latch oscillator (no 6-oscillator hardcoded D-major triad); when `audio.isMusicMuted() === true` (and not master-muted), `audio.playShopBuy()` plays the fallback triad.
- When `AudioContext` supports `createDynamicsCompressor`, `SynthAudio` creates a shared safety limiter and connects both SFX `masterGain` and `MusicEngine` through it.

Run: `npx vitest run client/test/audio.test.ts`
Expected: FAIL (`setMusicContext` not defined / `playShopBuy` always plays triad)

- [ ] **Step 2: Update `client/src/audio/synthAudio.ts`**

Wire `sharedSafetyLimiter` (`threshold: -2`, `knee: 6`, `ratio: 10`, `attack: 0.003`, `release: 0.12`), pass `() => this.outputBus` as the second constructor argument to `MusicEngine`, add `setMusicContext` / `setMusicTheme` / `apexBonus` forwarding, and gate `playShopBuy`'s fallback D-major triad on `this.music.isMusicMuted()`.

Run: `npm run verify`
Expected: PASS

- [ ] **Step 3: Commit Task 5**

```powershell
git add client/src/audio/synthAudio.ts client/test/audio.test.ts
git commit -m "feat(audio): add shared safety limiter, music context facade, and clash-free shop SFX"
```

---

### Task 6: Gameplay Telemetry Derivation Helper, `main.ts` Wiring & Browser Playtest

**Files:**
- Create: `client/src/audio/musicContextMapper.ts`
- Create: `client/test/musicContextMapper.test.ts`
- Modify: `client/src/main.ts`

**Interfaces:**
- Consumes: `MatchState`, `ThemeId` from `@critter/shared`, `MusicGameplayContext`, `MusicMood` from `./musicTypes.js`, `CameraMode` from `../game/cameraRig.js`
- Produces:
  - `client/src/audio/musicContextMapper.ts`:
    - `export interface MusicContextInput { readonly inMatch: boolean; readonly matchState: MatchState | null; readonly lobbyTheme: ThemeId; readonly localPlayerId: string | null; readonly armoryOpen: boolean; readonly isCharging: boolean; readonly chargePower: number; readonly isShotFlight: boolean; readonly cameraMode: CameraMode; }`
    - `export function deriveMusicGameplayContext(input: MusicContextInput): MusicGameplayContext`
    - `export function shouldPlayEvolutionStinger(eventPlayerId: string, localPlayerId: string | null): boolean`

- [ ] **Step 1: Write failing unit tests in `client/test/musicContextMapper.test.ts`**

Test assertions to include:
- Lobby state (`inMatch: false`) produces `mood: "lobby"` with `theme: lobbyTheme`.
- **Review Focus #2 (Duel-Safe Showdown):**
  - 2-player FFA Duel (`critters.length === 2, aliveCount === 2`, Round 1, high HP, > 60s remaining) produces `isShowdown: false` and `mood: "battle"`.
  - 4-player FFA with 2 eliminated (`critters.length === 4, aliveCount === 2`) produces `isShowdown: true` and `mood: "intense"`.
  - 4-player `2v2` with 1 survivor on Team A and 1 on Team B produces `isShowdown: true` and `mood: "intense"`, while 2 survivors on Team A and 0 on Team B does not falsely claim 1v1 showdown.
- `MATCH_OVER` produces `mood: "victory"` when local player/team won and `mood: "defeat"` when local player/team lost.
- `FINAL_FLOOD` produces `mood: "flood"` and scales `floodIntensity` cleanly in `[0.5, 1]`.
- `armoryOpen` or `ROUND_DRAFT`/`DRAFT_IF_READY` produces `mood: "shop"`.
- Maps `isCharging`, `chargePower`, `isShotFlight`, `isDroneView`, `windSpeed = Math.hypot(wind.x, wind.z)`, and `hpRatio` accurately.
- **Review Focus #4 (No Bot Stinger Spam):** `shouldPlayEvolutionStinger(evPlayerId, localId)` returns `true` only when `localId !== null && evPlayerId === localId`.

Run: `npx vitest run client/test/musicContextMapper.test.ts`
Expected: FAIL (`musicContextMapper.js` not found)

- [ ] **Step 2: Implement `client/src/audio/musicContextMapper.ts`**

Implement `deriveMusicGameplayContext` and `shouldPlayEvolutionStinger` cleanly with zero DOM/Three.js dependencies.

Run: `npm run verify`
Expected: PASS

- [ ] **Step 3: Wire `deriveMusicGameplayContext`, biome preview, and stingers into `client/src/main.ts`**

Exact changes in `client/src/main.ts`:
- Add `knockedOut?: boolean` to `ShotHitPopup` and populate `knockedOut: h.knockedOut` when constructing `shotPlayback` in `SHOT_FIRED`.
- In `advanceShotPlayback` when `hitsPopupsDone` triggers, call `this.audio.playStinger("ko")` once if any hit has `knockedOut === true`.
- In `CRITTER_ENGULFED`, call `this.audio.playStinger("ko")`.
- In `onPickMutation` (line ~755), remove the redundant `this.audio.playMutationChime()` (the server/local snapshot emits `MUTATION_EQUIPPED`).
- In `MUTATION_EQUIPPED` (line ~1447), replace `this.audio.playMutationChime()` with `if (shouldPlayEvolutionStinger(ev.playerId, localId)) { this.audio.playStinger("evolution", ev.apex !== null); }`.
- In `rebuildLobbyPreview(theme)`, call `this.audio.setMusicTheme(theme)` so switching biomes in the lobby immediately updates the musical palette.
- Update `updateAdaptiveMusicMood(isCharging?: boolean, chargePower?: number)` to derive `MusicGameplayContext` via `deriveMusicGameplayContext(...)` and forward it via `this.audio.setMusicContext(ctx)` (with lightweight diffing so unchanged continuous values don't spam updates).

Run: `npm run verify`
Expected: PASS

- [ ] **Step 4: Live Browser Verification & Independent Read-Only Review**

1. Start local Vite dev client (`npm run dev:client`), open in the browser subagent, verify:
   - Switching lobby biomes (`emerald_spire`, `canyon_arch`, `twin_pillars`, `mountain_spine`) updates audio cleanly with zero console errors.
   - Starting Play-vs-Bots sandbox match, aiming/charging a shot, firing into Shot Cam, toggling Drone Recon (`Tab`), opening/closing Armory (`B`), and toggling Music (`N`) and Master Mute (`M`) all run smoothly with zero console/WebAudio errors.
2. Dispatch the strictly read-only `reviewer` subagent to audit the entire diff against `AGENTS.md` Do-Not Rules, the design spec, all 5 Review Focus edge cases, and live `npm run verify` output (`Overall Verdict: PASS`).
3. Commit Task 6:

```powershell
git add client/src/audio/musicContextMapper.ts client/test/musicContextMapper.test.ts client/src/main.ts
git commit -m "feat(audio): connect full gameplay telemetry, biome previews, and stingers to adaptive music"
```
