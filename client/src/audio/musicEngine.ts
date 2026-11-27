import type { ThemeId } from "@critter/shared";
import { AmbienceEngine } from "./ambienceEngine.js";
import { createStudioAudioBus, type StudioAudioBus } from "./musicEffects.js";
import { AcousticVoiceBank } from "./musicInstruments.js";
import {
  computeStemMixTargets,
  createDefaultMusicContext,
  GenerativePhrasePlanner,
  getBiomePalette,
  getChordForBar,
  MOOD_TARGET_BPM,
} from "./musicTheory.js";
import type {
  MusicGameplayContext,
  MusicMood,
  MusicStingerKind,
  StemMixTargets,
} from "./musicTypes.js";

export type { MusicGameplayContext, MusicMood, MusicStingerKind };

interface WebkitAudioGlobal {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SEC = 0.12;
const STEPS_PER_BAR = 16;
const MAX_STEPS_PER_TICK = 8;
const TAB_SLEEP_THRESHOLD_SEC = 0.35;
const TEMPO_GLIDE_FACTOR = 0.14;
const TEMPO_SNAP_EPSILON = 0.15;

const VALID_MOODS: ReadonlySet<MusicMood> = new Set<MusicMood>([
  "lobby",
  "battle",
  "intense",
  "shop",
  "flood",
  "victory",
  "defeat",
]);

const VALID_THEMES: ReadonlySet<ThemeId> = new Set<ThemeId>([
  "emerald_spire",
  "canyon_arch",
  "twin_pillars",
  "mountain_spine",
]);

const IMMEDIATE_TRANSITION_MOODS: ReadonlySet<MusicMood> = new Set<MusicMood>([
  "flood",
  "victory",
  "defeat",
]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeClamp(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

function getSafeCurrentTime(ctx: AudioContext): number {
  const t = ctx.currentTime;
  return Number.isFinite(t) && t >= 0 ? t : 0;
}

function getAudioContextCtor(): (typeof AudioContext) | null {
  const scope = globalThis as unknown as WebkitAudioGlobal;
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function isValidMood(mood: MusicMood | undefined): mood is MusicMood {
  return mood !== undefined && VALID_MOODS.has(mood);
}

function isValidTheme(theme: ThemeId | undefined): theme is ThemeId {
  return theme !== undefined && VALID_THEMES.has(theme);
}

/**
 * Adaptive atmospheric soundtrack conductor for Critter Siege.
 * Coordinates vertical orchestral stems, biome-keyed modal harmony, generative
 * breathing phrases, micro-moment telemetry shaping, living island ambience,
 * smooth tempo glides, and safe background-tab sleep recovery.
 */
export class MusicEngine {
  private readonly getSharedContext: (() => AudioContext | null) | undefined;
  private readonly getOutputNode: (() => AudioNode | null) | undefined;
  private readonly planner = new GenerativePhrasePlanner();
  private readonly voices = new AcousticVoiceBank();
  private readonly ambience = new AmbienceEngine();

  private ctx: AudioContext | null = null;
  private bus: StudioAudioBus | null = null;
  private ownsContext = false;

  private context: MusicGameplayContext = createDefaultMusicContext();
  private mixTargets: StemMixTargets = computeStemMixTargets(this.context);
  private activeMood: MusicMood = this.context.mood;
  private activeTheme: ThemeId = this.context.theme;

  private targetBpm: number = MOOD_TARGET_BPM[this.context.mood];
  private currentBpm: number = this.targetBpm;

  private musicMuted = false;
  private masterMuted = false;
  private running = false;
  private disposed = false;

  private timerId: ReturnType<typeof setInterval> | null = null;
  private nextStepTime = 0;
  private currentBar = 0;
  private stepInBar = 0;
  private forcePadOnNextStep = true;
  private prevFluteMidi: number | null = null;
  private stepsSinceLastFlute = 0;

  public constructor(
    getSharedContext?: () => AudioContext | null,
    getOutputNode?: () => AudioNode | null,
  ) {
    this.getSharedContext = getSharedContext;
    this.getOutputNode = getOutputNode;
  }

  /** Start the lookahead conductor and living island ambience idempotently. */
  public start(): void {
    if (this.disposed) {
      return;
    }
    this.running = true;

    const bus = this.ensureAudioGraph();
    if (!bus) {
      return;
    }

    if (bus.ctx.state === "suspended" && typeof bus.ctx.resume === "function") {
      try {
        void bus.ctx.resume().catch(() => undefined);
      } catch {
        // Ignore resume errors prior to user gesture
      }
    }

    // Keep island ambience alive even when only music is muted (unless masterMuted)
    if (!this.masterMuted) {
      this.ambience.start(bus);
      this.ambience.update(this.context);
    }

    if (this.timerId !== null) {
      return;
    }

    this.nextStepTime = getSafeCurrentTime(bus.ctx) + 0.04;
    this.forcePadOnNextStep = true;
    this.timerId = setInterval(() => {
      this.schedulerTick();
    }, LOOKAHEAD_MS);
  }

  /** Stop the lookahead conductor and ambience while preserving state & mute settings. */
  public stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.ambience.stop();
  }

  /** Switch adaptive music mood cleanly through setContext. */
  public setMood(mood: MusicMood): void {
    if (this.disposed || !isValidMood(mood)) {
      return;
    }
    this.setContext({ mood });
  }

  /** Switch active biome harmonic palette cleanly through setContext. */
  public setTheme(theme: ThemeId): void {
    if (this.disposed || !isValidTheme(theme)) {
      return;
    }
    this.setContext({ theme });
  }

  /** Push live gameplay telemetry to adapt stem mix, filter veil, reverb, tempo, and ambience. */
  public setContext(partial: Partial<MusicGameplayContext>): void {
    if (this.disposed) {
      return;
    }

    const prev = this.context;
    const nextMood = isValidMood(partial.mood) ? partial.mood : prev.mood;
    const nextTheme = isValidTheme(partial.theme) ? partial.theme : prev.theme;

    const nextRound = Math.round(
      partial.round !== undefined
        ? safeClamp(partial.round, 1, 99, 1)
        : prev.round,
    );
    const nextMaxRounds = Math.round(
      partial.maxRounds !== undefined
        ? safeClamp(partial.maxRounds, 1, 99, 5)
        : prev.maxRounds,
    );
    const nextChargePower =
      partial.chargePower !== undefined
        ? safeClamp(partial.chargePower, 0, 1, 0)
        : prev.chargePower;
    const nextHpRatio =
      partial.hpRatio !== undefined
        ? safeClamp(partial.hpRatio, 0, 1, 1)
        : prev.hpRatio;
    const nextWindSpeed =
      partial.windSpeed !== undefined
        ? safeClamp(Math.abs(partial.windSpeed), 0, 20, 0)
        : prev.windSpeed;
    const nextWaterLevel =
      partial.waterLevel !== undefined
        ? safeClamp(partial.waterLevel, 0, 24, 0)
        : prev.waterLevel;
    const nextFloodIntensity =
      partial.floodIntensity !== undefined
        ? safeClamp(partial.floodIntensity, 0, 1, 0)
        : prev.floodIntensity;

    const nextContext: MusicGameplayContext = {
      mood: nextMood,
      theme: nextTheme,
      round: nextRound,
      maxRounds: nextMaxRounds,
      isMyTurn:
        partial.isMyTurn !== undefined ? Boolean(partial.isMyTurn) : prev.isMyTurn,
      isCharging:
        partial.isCharging !== undefined
          ? Boolean(partial.isCharging)
          : prev.isCharging,
      chargePower: nextChargePower,
      isShotFlight:
        partial.isShotFlight !== undefined
          ? Boolean(partial.isShotFlight)
          : prev.isShotFlight,
      isDroneView:
        partial.isDroneView !== undefined
          ? Boolean(partial.isDroneView)
          : prev.isDroneView,
      hpRatio: nextHpRatio,
      windSpeed: nextWindSpeed,
      waterLevel: nextWaterLevel,
      floodIntensity: nextFloodIntensity,
      isShowdown:
        partial.isShowdown !== undefined
          ? Boolean(partial.isShowdown)
          : prev.isShowdown,
    };

    const moodChanged = nextContext.mood !== prev.mood;
    const themeChanged = nextContext.theme !== prev.theme;
    this.context = nextContext;

    this.targetBpm = MOOD_TARGET_BPM[nextContext.mood];
    if (this.timerId === null) {
      // Deterministic tempo snapshot when scheduler is not running (e.g., pre-start / headless)
      this.currentBpm = this.targetBpm;
      if (moodChanged || themeChanged) {
        this.activeMood = nextContext.mood;
        this.activeTheme = nextContext.theme;
        this.prevFluteMidi = null;
        this.forcePadOnNextStep = true;
      }
    } else if (moodChanged && IMMEDIATE_TRANSITION_MOODS.has(nextContext.mood)) {
      // Major dramatic mood shifts respond immediately rather than waiting for bar end
      this.activeMood = nextContext.mood;
      this.activeTheme = nextContext.theme;
      this.currentBar = 0;
      this.stepInBar = 0;
      this.prevFluteMidi = null;
      this.forcePadOnNextStep = true;
    } else if (themeChanged && nextContext.mood === "lobby") {
      // Lobby biome browsing previews new island harmony immediately
      this.activeTheme = nextContext.theme;
      this.activeMood = nextContext.mood;
      this.prevFluteMidi = null;
      this.forcePadOnNextStep = true;
    }

    this.mixTargets = computeStemMixTargets(this.context);
    if (this.bus) {
      this.bus.setFilterCutoff(this.mixTargets.filterHz);
      this.bus.setReverbWet(this.mixTargets.reverbWet);
    }

    this.ambience.update(this.context);
  }

  /** Return a defensive copy of the current gameplay audio context. */
  public getContext(): MusicGameplayContext {
    return { ...this.context };
  }

  /** Return the currently selected adaptive music mood. */
  public getMood(): MusicMood {
    return this.context.mood;
  }

  /** Return the current (possibly gliding) tempo in BPM. */
  public getBpm(): number {
    return this.currentBpm;
  }

  /** Return the target grounded tempo in BPM for the current mood. */
  public getTargetBpm(): number {
    return this.targetBpm;
  }

  /** Mute or unmute musical stems independently while keeping island ambience alive. */
  public setMusicMuted(muted: boolean): void {
    if (this.disposed) {
      return;
    }
    const wasMuted = this.musicMuted;
    this.musicMuted = muted;
    this.bus?.setMusicMuted(muted);
    if (wasMuted && !muted) {
      this.forcePadOnNextStep = true;
    }
  }

  /** Return whether musical stems are muted independently of master mute. */
  public isMusicMuted(): boolean {
    return this.musicMuted;
  }

  /** Toggle independent music mute state and return the new muted flag. */
  public toggleMusicMute(): boolean {
    this.setMusicMuted(!this.musicMuted);
    return this.musicMuted;
  }

  /** Synchronize global master mute (zeroing both music and ambience) without altering musicMuted. */
  public setMasterMuted(muted: boolean): void {
    if (this.disposed) {
      return;
    }
    this.masterMuted = muted;
    this.bus?.setMasterMuted(muted);

    if (!muted && this.running) {
      const bus = this.ensureAudioGraph();
      if (bus) {
        this.ambience.start(bus);
        this.ambience.update(this.context);
      }
    }
  }

  /** Smoothly duck music gain (e.g., on explosions or stingers) and recover naturally. */
  public duck(depth = 0.32, durationSec = 0.55): void {
    if (this.disposed || !this.bus) {
      return;
    }
    this.bus.duck(depth, durationSec);
  }

  /** Trigger a biome-key-aware orchestral stinger for major match moments. */
  public playStinger(kind: MusicStingerKind, apexBonus = false): void {
    if (this.disposed || this.masterMuted || this.musicMuted) {
      return;
    }
    const bus = this.ensureAudioGraph();
    if (!bus) {
      return;
    }

    if (kind === "ko") {
      this.duck(0.38, 0.65);
    } else if (kind === "round_end") {
      this.duck(0.32, 0.72);
    } else if (kind === "flood_alarm") {
      this.duck(0.42, 0.85);
    }

    const currentChord = getChordForBar(
      this.context.theme,
      this.context.mood,
      this.currentBar,
    );
    const now = getSafeCurrentTime(bus.ctx);
    this.voices.playStinger(bus, kind, currentChord, now + 0.01, Boolean(apexBonus));
  }

  /** Stop timers, release ambience/voice/bus resources, and close only an owned AudioContext. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.stop();
    this.disposed = true;

    this.ambience.dispose();
    this.voices.dispose();
    this.bus?.dispose();

    const ownedCtx = this.ownsContext ? this.ctx : null;
    this.bus = null;
    this.ctx = null;
    this.ownsContext = false;
    this.prevFluteMidi = null;

    if (ownedCtx && typeof ownedCtx.close === "function") {
      try {
        void ownedCtx.close().catch(() => undefined);
      } catch {
        // Safe cleanup in restricted environments
      }
    }
  }

  private isEffectivelyMuted(): boolean {
    return this.masterMuted || this.musicMuted;
  }

  private ensureAudioGraph(): StudioAudioBus | null {
    if (this.disposed) {
      return null;
    }

    const sharedCtx = this.getSharedContext?.() ?? null;
    if (sharedCtx && this.ctx !== sharedCtx) {
      this.attachToContext(sharedCtx, false);
    } else if (!this.ctx) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) {
        return null;
      }
      try {
        const localCtx = new Ctor();
        this.attachToContext(localCtx, true);
      } catch {
        return null;
      }
    }

    return this.bus;
  }

  private attachToContext(ctx: AudioContext, owns: boolean): void {
    this.ambience.stop();
    this.bus?.dispose();

    const destination = this.getOutputNode?.() ?? null;
    const bus = createStudioAudioBus(ctx, destination);
    bus.setMusicMuted(this.musicMuted);
    bus.setMasterMuted(this.masterMuted);
    bus.setFilterCutoff(this.mixTargets.filterHz);
    bus.setReverbWet(this.mixTargets.reverbWet);

    this.ctx = ctx;
    this.bus = bus;
    this.ownsContext = owns;
    this.forcePadOnNextStep = true;
    this.nextStepTime = getSafeCurrentTime(ctx) + 0.04;
  }

  private glideTempoStep(): void {
    const diff = this.targetBpm - this.currentBpm;
    if (Math.abs(diff) <= TEMPO_SNAP_EPSILON) {
      this.currentBpm = this.targetBpm;
    } else {
      this.currentBpm += diff * TEMPO_GLIDE_FACTOR;
    }
  }

  private schedulerTick(): void {
    if (this.disposed || !this.running) {
      return;
    }
    const bus = this.ensureAudioGraph();
    if (!bus) {
      return;
    }
    if (bus.ctx.state === "suspended") {
      return;
    }

    const now = getSafeCurrentTime(bus.ctx);

    // Review Focus #5: recover safely from background-tab sleep or non-finite timestamps
    if (
      !Number.isFinite(this.nextStepTime) ||
      this.nextStepTime < now - TAB_SLEEP_THRESHOLD_SEC ||
      this.nextStepTime > now + 2.0
    ) {
      this.nextStepTime = now + 0.02;
    }

    let stepsScheduled = 0;
    while (
      this.nextStepTime < now + SCHEDULE_AHEAD_SEC &&
      stepsScheduled < MAX_STEPS_PER_TICK
    ) {
      this.glideTempoStep();
      const safeBpm = clamp(
        Number.isFinite(this.currentBpm) ? this.currentBpm : this.targetBpm,
        40,
        200,
      );
      const stepSec = 60 / safeBpm / 4;

      this.scheduleStep(bus, now, this.nextStepTime, stepSec);

      this.nextStepTime += stepSec;
      this.stepInBar++;
      if (this.stepInBar >= STEPS_PER_BAR) {
        this.stepInBar = 0;
        this.currentBar++;
      }
      stepsScheduled++;
    }
  }

  private scheduleStep(
    bus: StudioAudioBus,
    now: number,
    time: number,
    stepSec: number,
  ): void {
    // Bar-aligned harmonic transition for normal mood/theme changes
    if (
      this.stepInBar === 0 &&
      (this.activeMood !== this.context.mood ||
        this.activeTheme !== this.context.theme)
    ) {
      this.activeMood = this.context.mood;
      this.activeTheme = this.context.theme;
      this.prevFluteMidi = null;
      this.forcePadOnNextStep = true;
    }

    if (this.isEffectivelyMuted()) {
      this.stepsSinceLastFlute++;
      return;
    }

    const barIndex = this.currentBar;
    const stepInBar = this.stepInBar;
    const chord = getChordForBar(this.activeTheme, this.activeMood, barIndex);
    const targets = this.mixTargets;
    const bias = getBiomePalette(this.activeTheme).timbreBias;

    // 1. Lush 2-bar bowed string / harmonic pad bed
    const isPadBoundary = stepInBar === 0 && barIndex % 2 === 0;
    if (targets.pad > 0.01 && (isPadBoundary || this.forcePadOnNextStep)) {
      const remainingSteps =
        this.forcePadOnNextStep && stepInBar > 0
          ? STEPS_PER_BAR - stepInBar
          : STEPS_PER_BAR * 2;
      const padDur = clamp(remainingSteps * stepSec, 0.5, 12.0);
      const padGain = clamp(targets.pad * 0.24 * (0.9 + 0.1 * bias.pad), 0, 1);
      this.voices.playPadChord(bus, chord.padNotes, time, padDur, padGain);
      this.forcePadOnNextStep = false;
    }

    // 2. Generative phrase planner for plucks, flute, cello, and organic percussion
    const plan = this.planner.planStep(
      this.activeTheme,
      this.activeMood,
      barIndex,
      stepInBar,
      this.context.isMyTurn,
      this.context.isShotFlight,
    );
    const noteTime = Math.max(now, time + plan.humanizeSec);

    // 2a. Woody harp / lute plucks
    if (plan.pluckMidi !== null && targets.pluck > 0.01) {
      const pluckVel = clamp(
        plan.pluckVelocity * targets.pluck * (0.9 + 0.1 * bias.pluck),
        0,
        1,
      );
      if (pluckVel > 0.01) {
        this.voices.playPluckNote(
          bus,
          plan.pluckMidi,
          noteTime,
          pluckVel,
          plan.pluckPan,
        );
      }
    }

    // 2b. Expressive breathing woodland flute with legato portamento
    if (
      plan.fluteMidi !== null &&
      plan.fluteDurationSteps > 0 &&
      targets.flute > 0.01
    ) {
      const fluteDur = clamp(plan.fluteDurationSteps * stepSec, 0.18, 6.0);
      const fluteVel = clamp(
        plan.fluteVelocity * targets.flute * (0.9 + 0.1 * bias.flute),
        0,
        1,
      );
      if (fluteVel > 0.01) {
        const glideFrom =
          this.stepsSinceLastFlute <= 12 ? this.prevFluteMidi : null;
        this.voices.playFluteNote(
          bus,
          plan.fluteMidi,
          noteTime,
          fluteDur,
          fluteVel,
          glideFrom,
        );
        this.prevFluteMidi = plan.fluteMidi;
        this.stepsSinceLastFlute = 0;
      } else {
        this.stepsSinceLastFlute++;
      }
    } else {
      this.stepsSinceLastFlute++;
    }

    // 2c. Warm bowed cello swells
    if (
      plan.celloMidi !== null &&
      plan.celloDurationSteps > 0 &&
      targets.cello > 0.01
    ) {
      const celloDur = clamp(plan.celloDurationSteps * stepSec, 0.25, 8.0);
      const celloGain = clamp(
        targets.cello * 0.24 * (0.9 + 0.1 * bias.cello),
        0,
        1,
      );
      if (celloGain > 0.01) {
        this.voices.playCelloNote(
          bus,
          plan.celloMidi,
          noteTime,
          celloDur,
          celloGain,
        );
      }
    }

    // 2d. Organic percussion: hand frame drum, brush shaker, tuned timpani
    if (targets.percussion > 0.01) {
      const percScale = targets.percussion * (0.9 + 0.1 * bias.percussion);

      if (plan.frameDrumGain > 0.01) {
        const accent = stepInBar === 0 || stepInBar === 8;
        const drumGain = clamp(plan.frameDrumGain * percScale * 0.34, 0, 1);
        if (drumGain > 0.01) {
          this.voices.playFrameDrum(bus, noteTime, drumGain, accent);
        }
      }

      if (plan.shakerGain > 0.01) {
        const shakerGain = clamp(plan.shakerGain * percScale * 0.26, 0, 1);
        if (shakerGain > 0.01) {
          this.voices.playBrushShaker(bus, noteTime, shakerGain);
        }
      }

      if (plan.timpaniMidi !== null && plan.timpaniGain > 0.01) {
        const timpGain = clamp(plan.timpaniGain * percScale * 0.4, 0, 1);
        if (timpGain > 0.01) {
          const timpDur = clamp(stepSec * 5.5, 0.45, 1.4);
          this.voices.playTimpani(
            bus,
            plan.timpaniMidi,
            noteTime,
            timpDur,
            timpGain,
          );
        }
      }
    }

    // 3. Rising harmonic charge shimmer while drawing shot power above 50%
    if (
      this.context.isCharging &&
      targets.chargeShimmer > 0.01 &&
      (stepInBar % 4 === 0 ||
        (targets.chargeShimmer > 0.65 && stepInBar % 2 === 0))
    ) {
      const shimmerDur = clamp(stepSec * 3.8, 0.28, 1.2);
      this.voices.playChargeShimmer(
        bus,
        chord,
        time,
        shimmerDur,
        targets.chargeShimmer,
      );
    }
  }
}
