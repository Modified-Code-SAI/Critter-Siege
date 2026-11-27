export type MusicMood =
  | "lobby"
  | "battle"
  | "intense"
  | "shop"
  | "flood"
  | "victory";

export type MusicStingerKind = "ko" | "round_end" | "flood_alarm" | "purchase";

interface WebkitAudioGlobal {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SEC = 0.1;
const BASE_MUSIC_GAIN = 0.24;
const STEPS_PER_BAR = 16;
const BARS_PER_SECTION = 8;
const TOTAL_BARS = BARS_PER_SECTION * 2;
const TOTAL_STEPS = TOTAL_BARS * STEPS_PER_BAR;

const MOOD_BPM: Record<MusicMood, number> = {
  lobby: 112,
  shop: 114,
  battle: 124,
  intense: 138,
  flood: 148,
  victory: 120,
};

const MOOD_FILTER_HZ: Record<MusicMood, number> = {
  lobby: 12500,
  shop: 1150,
  battle: 16000,
  intense: 16000,
  flood: 16000,
  victory: 14500,
};

interface ChordSpec {
  readonly root: number;
  readonly notes: readonly [number, number, number, number];
}

// MIDI note helper (A4 = 69 -> 440 Hz)
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getAudioContextCtor(): (typeof AudioContext) | null {
  const scope = globalThis as unknown as WebkitAudioGlobal;
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

// Chord palette in D Major / D Mixolydian & D Minor / Dorian (MIDI pitch numbers)
const CHORDS: Record<string, ChordSpec> = {
  D: { root: 38, notes: [62, 66, 69, 74] }, // D4 F#4 A4 D5
  A: { root: 45, notes: [61, 64, 69, 73] }, // C#4 E4 A4 C#5
  A7: { root: 45, notes: [61, 64, 67, 69] }, // C#4 E4 G4 A4
  Bm: { root: 47, notes: [62, 66, 71, 74] }, // D4 F#4 B4 D5
  G: { root: 43, notes: [62, 67, 71, 74] }, // D4 G4 B4 D5
  C: { root: 36, notes: [60, 64, 67, 72] }, // C4 E4 G4 C5 (D Mixolydian bVII)
  Em: { root: 40, notes: [64, 67, 71, 76] }, // E4 G4 B4 E5
  Dm: { root: 38, notes: [62, 65, 69, 74] }, // D4 F4 A4 D5
  F: { root: 41, notes: [60, 65, 69, 72] }, // C4 F4 A4 C5
  Bb: { root: 46, notes: [62, 65, 70, 74] }, // D4 F4 Bb4 D5
  Gm: { root: 43, notes: [62, 67, 70, 74] }, // D4 G4 Bb4 D5
  Eb: { root: 39, notes: [63, 67, 70, 75] }, // Eb4 G4 Bb4 Eb5
  E_dim: { root: 40, notes: [64, 67, 70, 76] }, // E4 G4 Bb4 E5
  Fs_dim: { root: 42, notes: [66, 69, 72, 78] }, // F#4 A4 C5 F#5
  Ab: { root: 44, notes: [63, 68, 72, 75] }, // Eb4 Ab4 C5 Eb5
  Fm: { root: 41, notes: [60, 65, 68, 72] }, // C4 F4 Ab4 C5
};

// 16-bar chord progressions (8-bar Section A + 8-bar Section B)
const SUNNY_PROGRESSION: readonly string[] = [
  // Section A: Bright D Major island adventure
  "D", "A", "Bm", "G", "D", "G", "A", "D",
  // Section B: Mixolydian C lift -> turnaround
  "C", "G", "D", "A", "G", "Em", "A7", "D",
];

const INTENSE_PROGRESSION: readonly string[] = [
  // Section A: Urgent D Minor / Dorian tension
  "Dm", "C", "Bb", "A", "Dm", "F", "G", "A7",
  // Section B: Driving syncopated climax
  "Gm", "Dm", "C", "A", "Bb", "C", "Dm", "A7",
];

const FLOOD_PROGRESSION: readonly string[] = [
  // Section A: Chromatic rising ostinato D -> Eb -> E -> F -> F# -> G -> Ab -> A
  "Dm", "Eb", "E_dim", "F", "Fs_dim", "Gm", "Ab", "A7",
  // Section B: Surging storm cadence
  "Dm", "Eb", "Fm", "Gm", "Ab", "A", "Bb", "A7",
];

const VICTORY_PROGRESSION: readonly string[] = [
  // Section A: Triumphant sunlit fanfare
  "D", "G", "A", "D", "Bm", "G", "A", "D",
  // Section B: Warm peaceful ocean resolve
  "G", "D", "Em", "A", "G", "D", "A7", "D",
];

// 32-step (2-bar) upbeat catchy D Major island adventure melodies (MIDI or 0 = rest)
const BATTLE_MELODY_A1: readonly number[] = [
  74, 0, 76, 0, 78, 0, 81, 0, 0, 78, 76, 0, 74, 0, 0, 0,
  73, 0, 76, 0, 81, 0, 79, 0, 78, 0, 76, 0, 74, 0, 0, 0,
];
const BATTLE_MELODY_A2: readonly number[] = [
  71, 0, 74, 0, 78, 0, 83, 0, 0, 81, 78, 0, 76, 0, 74, 0,
  79, 0, 78, 0, 76, 0, 74, 0, 73, 0, 76, 0, 74, 0, 0, 0,
];
const BATTLE_MELODY_B1: readonly number[] = [
  72, 0, 76, 0, 79, 0, 84, 0, 0, 83, 79, 0, 76, 0, 0, 0,
  74, 0, 78, 0, 81, 0, 86, 0, 85, 0, 81, 0, 76, 0, 0, 0,
];
const BATTLE_MELODY_B2: readonly number[] = [
  79, 0, 83, 0, 86, 0, 83, 0, 79, 0, 76, 0, 79, 0, 81, 0,
  83, 0, 81, 0, 79, 0, 76, 0, 78, 0, 81, 0, 74, 0, 0, 0,
];

// Higher-octave urgent D Minor/Dorian counter-melodies for intense mood
const INTENSE_MELODY_A: readonly number[] = [
  74, 0, 77, 0, 81, 0, 79, 77, 76, 0, 79, 0, 84, 0, 81, 0,
  82, 0, 81, 0, 77, 0, 74, 0, 73, 0, 76, 0, 81, 0, 0, 0,
];
const INTENSE_MELODY_B: readonly number[] = [
  86, 0, 84, 0, 82, 0, 81, 0, 79, 0, 77, 0, 76, 0, 74, 0,
  77, 0, 79, 0, 81, 0, 84, 0, 85, 0, 81, 0, 86, 0, 0, 0,
];

// Dramatic rising stabs for flood mood (offsets above current chord root + 24)
const FLOOD_STAB_PATTERN: readonly number[] = [
  0, 0, 0, 3, 0, 0, 7, 0, 0, 10, 0, 7, 12, 0, 10, 7,
];

// Triumphant victory fanfare (Section A)
const VICTORY_FANFARE_A: readonly number[] = [
  74, 0, 0, 74, 78, 0, 81, 0, 86, 0, 0, 83, 81, 0, 0, 0,
  79, 0, 81, 0, 83, 0, 85, 0, 86, 0, 0, 0, 0, 0, 0, 0,
];

// Syncopated island marimba arpeggio indices (0..3 into chord.notes, -1 = rest)
const MARIMBA_PATTERN_A: readonly number[] = [
  0, -1, 2, 1, -1, 3, 2, -1, 1, -1, 2, 3, -1, 1, 0, -1,
];
const MARIMBA_PATTERN_B: readonly number[] = [
  0, 2, -1, 3, 1, -1, 2, 0, -1, 3, 2, -1, 1, 2, 3, -1,
];
const MARIMBA_SHOP_PATTERN: readonly number[] = [
  0, -1, -1, 1, -1, -1, 2, -1, 3, -1, -1, 2, -1, -1, 1, -1,
];

// Bass rhythmic patterns: 0 = rest, 1 = root, 2 = fifth (+7), 3 = octave (+12)
const BASS_GROOVE: readonly number[] = [
  1, 0, 0, 1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 2, 0, 0,
];
const BASS_INTENSE: readonly number[] = [
  1, 0, 1, 0, 1, 0, 2, 0, 1, 0, 1, 3, 2, 0, 1, 2,
];
const BASS_FLOOD: readonly number[] = [
  1, 1, 0, 1, 1, 0, 2, 1, 1, 1, 0, 2, 1, 2, 3, 2,
];
const BASS_SOFT: readonly number[] = [
  1, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 3, 0,
];

/**
 * Zero-asset procedural WebAudio adaptive soundtrack engine ("Sunny Island Adventure Groove").
 * Uses a 25ms lookahead scheduler with a 100ms scheduling window and routes through a dedicated
 * musicGain -> musicFilter -> destination bus so music mute operates independently of SFX mute.
 */
export class MusicEngine {
  private readonly getSharedContext: (() => AudioContext | null) | undefined;

  private ctx: AudioContext | null = null;
  private ownsContext = false;
  private duckGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private mood: MusicMood = "lobby";
  private musicMuted = false;
  private masterMuted = false;
  private running = false;
  private disposed = false;

  private timerId: ReturnType<typeof setInterval> | null = null;
  private nextStepTime = 0;
  private currentStep = 0;

  public constructor(getSharedContext?: () => AudioContext | null) {
    this.getSharedContext = getSharedContext;
  }

  /** Start the lookahead music scheduler idempotently (safe no-op without AudioContext). */
  public start(): void {
    if (this.disposed) {
      return;
    }
    this.running = true;

    const ready = this.ensureAudioGraph();
    if (!ready) {
      return;
    }

    if (ready.ctx.state === "suspended" && typeof ready.ctx.resume === "function") {
      try {
        void ready.ctx.resume().catch(() => undefined);
      } catch {
        // Ignore resume errors prior to user gesture
      }
    }

    if (this.timerId !== null) {
      return;
    }

    this.nextStepTime = ready.ctx.currentTime + 0.04;
    this.timerId = setInterval(() => {
      this.schedulerTick();
    }, LOOKAHEAD_MS);
  }

  /** Stop the music scheduler cleanly while preserving mood and mute preferences. */
  public stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /** Switch adaptive music mood, smoothly sweeping filter cutoff and tempo. */
  public setMood(mood: MusicMood): void {
    if (this.mood === mood) {
      return;
    }
    this.mood = mood;
    if (mood === "victory" || mood === "flood") {
      this.currentStep = 0;
    }
    this.applyFilterCutoff();
  }

  /** Return the currently active adaptive music mood. */
  public getMood(): MusicMood {
    return this.mood;
  }

  /** Return the exact tempo in BPM for the current mood. */
  public getBpm(): number {
    return MOOD_BPM[this.mood];
  }

  /** Mute or unmute background music independently of SFX mute. */
  public setMusicMuted(muted: boolean): void {
    this.musicMuted = muted;
    this.applyMusicGain();
  }

  /** Return whether background music is muted. */
  public isMusicMuted(): boolean {
    return this.musicMuted;
  }

  /** Toggle background music mute state and return the new muted value. */
  public toggleMusicMute(): boolean {
    this.setMusicMuted(!this.musicMuted);
    return this.musicMuted;
  }

  /** Synchronize global master mute state without altering musicMuted preference. */
  public setMasterMuted(muted: boolean): void {
    this.masterMuted = muted;
    this.applyMusicGain();
  }

  /** Briefly duck music gain (e.g. on big explosions) and smoothly recover. */
  public duck(depth = 0.35, durationSec = 0.5): void {
    if (this.disposed || !this.ctx || !this.duckGain) {
      return;
    }
    const safeDepth = clamp(Number.isFinite(depth) ? depth : 0.35, 0.05, 0.85);
    const safeDuration = clamp(
      Number.isFinite(durationSec) ? durationSec : 0.5,
      0.08,
      2.5,
    );
    const now = this.ctx.currentTime;
    const duckedLevel = clamp(1 - safeDepth, 0.12, 0.95);

    try {
      this.duckGain.gain.cancelScheduledValues(now);
      this.duckGain.gain.setTargetAtTime(duckedLevel, now, 0.018);
      this.duckGain.gain.setTargetAtTime(1.0, now + 0.05, safeDuration * 0.42);
    } catch {
      // Safe fallback for minimal mock AudioParam implementations
    }
  }

  /** Play a short procedural musical stinger for key match events. */
  public playStinger(kind: MusicStingerKind): void {
    if (this.disposed || this.masterMuted || this.musicMuted) {
      return;
    }
    const ready = this.ensureAudioGraph();
    if (!ready) {
      return;
    }
    const { ctx, input } = ready;
    const now = ctx.currentTime + 0.01;

    if (kind === "ko") {
      this.duck(0.4, 0.65);
      this.playBrassVoice(ctx, input, midiToFreq(69), now, 0.14, 0.24);
      this.playBrassVoice(ctx, input, midiToFreq(65), now + 0.12, 0.16, 0.24);
      this.playBrassVoice(ctx, input, midiToFreq(62), now + 0.26, 0.36, 0.28);
      this.playTimpani(ctx, input, 92, now, 0.35, 0.36);
      return;
    }

    if (kind === "round_end") {
      this.duck(0.35, 0.75);
      const chord = [62, 66, 69, 74];
      for (let i = 0; i < chord.length; i++) {
        const midi = chord[i];
        if (midi === undefined) continue;
        this.playMarimbaVoice(ctx, input, midiToFreq(midi), now + i * 0.06, 0.26, 0.24);
        this.playBrassVoice(ctx, input, midiToFreq(midi), now + i * 0.06, 0.32, 0.16);
      }
      return;
    }

    if (kind === "flood_alarm") {
      this.duck(0.45, 0.9);
      this.playBrassVoice(ctx, input, midiToFreq(50), now, 0.32, 0.3);
      this.playBrassVoice(ctx, input, midiToFreq(56), now + 0.18, 0.42, 0.3);
      this.playTimpani(ctx, input, 78, now, 0.45, 0.42);
      this.playTimpani(ctx, input, 88, now + 0.2, 0.45, 0.42);
      return;
    }

    // "purchase"
    const notes = [62, 69, 74, 78];
    for (let i = 0; i < notes.length; i++) {
      const midi = notes[i];
      if (midi === undefined) continue;
      this.playMarimbaVoice(ctx, input, midiToFreq(midi), now + i * 0.045, 0.18, 0.22);
    }
  }

  /** Stop timers, disconnect audio bus, and release owned resources cleanly. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.stop();
    this.disposed = true;

    try {
      this.duckGain?.disconnect();
      this.musicGain?.disconnect();
      this.musicFilter?.disconnect();
    } catch {
      // Ignore disconnect errors during teardown
    }

    const ownedCtx = this.ownsContext ? this.ctx : null;
    this.ctx = null;
    this.ownsContext = false;
    this.duckGain = null;
    this.musicGain = null;
    this.musicFilter = null;
    this.noiseBuffer = null;

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

  private ensureAudioGraph(): { ctx: AudioContext; input: GainNode } | null {
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

    if (!this.ctx || !this.duckGain) {
      return null;
    }
    return { ctx: this.ctx, input: this.duckGain };
  }

  private attachToContext(ctx: AudioContext, owns: boolean): void {
    try {
      this.duckGain?.disconnect();
      this.musicGain?.disconnect();
      this.musicFilter?.disconnect();
    } catch {
      // Ignore prior disconnect failures
    }

    const duckGain = ctx.createGain();
    duckGain.gain.value = 1.0;

    const musicGain = ctx.createGain();
    musicGain.gain.value = this.isEffectivelyMuted() ? 0 : BASE_MUSIC_GAIN;

    const musicFilter = ctx.createBiquadFilter();
    musicFilter.type = "lowpass";
    musicFilter.Q.value = 0.7;
    musicFilter.frequency.value = MOOD_FILTER_HZ[this.mood];

    // Dedicated music bus: voices -> duckGain -> musicGain -> musicFilter -> destination
    duckGain.connect(musicGain);
    musicGain.connect(musicFilter);
    musicFilter.connect(ctx.destination);

    this.ctx = ctx;
    this.ownsContext = owns;
    this.duckGain = duckGain;
    this.musicGain = musicGain;
    this.musicFilter = musicFilter;
    this.noiseBuffer = null;
  }

  private applyMusicGain(): void {
    if (!this.ctx || !this.musicGain) {
      return;
    }
    const target = this.isEffectivelyMuted() ? 0 : BASE_MUSIC_GAIN;
    try {
      this.musicGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
    } catch {
      this.musicGain.gain.value = target;
    }
  }

  private applyFilterCutoff(): void {
    if (!this.ctx || !this.musicFilter) {
      return;
    }
    const targetHz = MOOD_FILTER_HZ[this.mood];
    try {
      this.musicFilter.frequency.setTargetAtTime(
        targetHz,
        this.ctx.currentTime,
        0.14,
      );
    } catch {
      this.musicFilter.frequency.value = targetHz;
    }
  }

  private schedulerTick(): void {
    if (this.disposed || !this.running) {
      return;
    }
    const ready = this.ensureAudioGraph();
    if (!ready) {
      return;
    }
    const { ctx, input } = ready;
    if (ctx.state === "suspended") {
      return;
    }

    const now = ctx.currentTime;
    // Recover gracefully if browser tab was backgrounded
    if (this.nextStepTime < now - 0.25) {
      this.nextStepTime = now + 0.02;
    }

    const stepSec = 60 / this.getBpm() / 4;
    while (this.nextStepTime < now + SCHEDULE_AHEAD_SEC) {
      if (!this.isEffectivelyMuted()) {
        this.scheduleStep(ctx, input, this.currentStep, this.nextStepTime, stepSec);
      }
      this.nextStepTime += stepSec;
      this.currentStep = (this.currentStep + 1) % TOTAL_STEPS;
    }
  }

  private scheduleStep(
    ctx: AudioContext,
    bus: GainNode,
    stepIndex: number,
    time: number,
    stepSec: number,
  ): void {
    const bar = Math.floor(stepIndex / STEPS_PER_BAR) % TOTAL_BARS;
    const stepInBar = stepIndex % STEPS_PER_BAR;
    const stepInTwoBars = stepIndex % (STEPS_PER_BAR * 2);
    const isSectionB = bar >= BARS_PER_SECTION;

    const progression = this.getProgressionForMood(this.mood);
    const chordName = progression[bar] ?? "D";
    const chord = CHORDS[chordName] ?? CHORDS.D;
    if (!chord) {
      return;
    }

    // 1. Marimba / Kalimba island arpeggio & chord comp
    this.scheduleMarimba(ctx, bus, chord, stepInBar, isSectionB, time);

    // 2. Warm Sub/Pluck Bass
    this.scheduleBass(ctx, bus, chord, stepInBar, time, stepSec);

    // 3. Heroic Synth-Brass Lead
    this.scheduleLead(ctx, bus, chord, bar, stepInBar, stepInTwoBars, isSectionB, time, stepSec);

    // 4. Crisp Drum Kit & Timpani
    this.schedulePercussion(ctx, bus, bar, stepInBar, isSectionB, time);
  }

  private getProgressionForMood(mood: MusicMood): readonly string[] {
    if (mood === "intense") {
      return INTENSE_PROGRESSION;
    }
    if (mood === "flood") {
      return FLOOD_PROGRESSION;
    }
    if (mood === "victory") {
      return VICTORY_PROGRESSION;
    }
    return SUNNY_PROGRESSION;
  }

  private scheduleMarimba(
    ctx: AudioContext,
    bus: GainNode,
    chord: ChordSpec,
    stepInBar: number,
    isSectionB: boolean,
    time: number,
  ): void {
    const pattern =
      this.mood === "shop" || this.mood === "victory"
        ? MARIMBA_SHOP_PATTERN
        : isSectionB
          ? MARIMBA_PATTERN_B
          : MARIMBA_PATTERN_A;

    const noteIdx = pattern[stepInBar];
    if (noteIdx === undefined || noteIdx < 0) {
      return;
    }
    const midi = chord.notes[noteIdx];
    if (midi === undefined) {
      return;
    }

    const octaveBoost = this.mood === "intense" && stepInBar >= 8 ? 12 : 0;
    const gain =
      this.mood === "flood"
        ? 0.14
        : this.mood === "shop"
          ? 0.2
          : 0.24;
    this.playMarimbaVoice(ctx, bus, midiToFreq(midi + octaveBoost), time, 0.19, gain);
  }

  private scheduleBass(
    ctx: AudioContext,
    bus: GainNode,
    chord: ChordSpec,
    stepInBar: number,
    time: number,
    stepSec: number,
  ): void {
    const pattern =
      this.mood === "flood"
        ? BASS_FLOOD
        : this.mood === "intense"
          ? BASS_INTENSE
          : this.mood === "shop" || this.mood === "victory"
            ? BASS_SOFT
            : BASS_GROOVE;

    const deg = pattern[stepInBar];
    if (!deg) {
      return;
    }

    const semitoneOffset = deg === 1 ? 0 : deg === 2 ? 7 : 12;
    const freq = midiToFreq(chord.root + semitoneOffset);
    const dur =
      this.mood === "flood"
        ? stepSec * 1.4
        : this.mood === "intense"
          ? stepSec * 1.5
          : stepSec * 2.2;
    const gain = this.mood === "flood" ? 0.34 : this.mood === "shop" ? 0.2 : 0.28;
    this.playBassVoice(ctx, bus, freq, time, dur, gain);
  }

  private scheduleLead(
    ctx: AudioContext,
    bus: GainNode,
    chord: ChordSpec,
    bar: number,
    stepInBar: number,
    stepInTwoBars: number,
    isSectionB: boolean,
    time: number,
    stepSec: number,
  ): void {
    if (this.mood === "shop") {
      // Keep shop calm and spacious for tactical planning
      return;
    }

    if (this.mood === "lobby") {
      // Gentle welcoming motif only on phrase starts
      if (stepInBar === 0 && bar % 2 === 0) {
        const midi = chord.notes[isSectionB ? 3 : 2];
        if (midi !== undefined) {
          this.playBrassVoice(ctx, bus, midiToFreq(midi), time, stepSec * 4.5, 0.11);
        }
      }
      return;
    }

    if (this.mood === "battle") {
      const phraseIndex = Math.floor(bar / 2) % 4;
      const phrase =
        phraseIndex === 0
          ? BATTLE_MELODY_A1
          : phraseIndex === 1
            ? BATTLE_MELODY_A2
            : phraseIndex === 2
              ? BATTLE_MELODY_B1
              : BATTLE_MELODY_B2;
      const midi = phrase[stepInTwoBars];
      if (midi && midi > 0) {
        this.playBrassVoice(ctx, bus, midiToFreq(midi), time, stepSec * 2.1, 0.17);
      }
      return;
    }

    if (this.mood === "intense") {
      const phrase = isSectionB ? INTENSE_MELODY_B : INTENSE_MELODY_A;
      const midi = phrase[stepInTwoBars];
      if (midi && midi > 0) {
        this.playBrassVoice(ctx, bus, midiToFreq(midi), time, stepSec * 1.7, 0.19);
      }
      return;
    }

    if (this.mood === "flood") {
      const offset = FLOOD_STAB_PATTERN[stepInBar];
      if (offset !== undefined && (stepInBar === 0 || offset > 0)) {
        const midi = chord.root + 24 + offset;
        this.playBrassVoice(ctx, bus, midiToFreq(midi), time, stepSec * 1.5, 0.21);
      }
      return;
    }

    // "victory": triumphant fanfare in Section A, calm ocean resolve in Section B
    if (!isSectionB) {
      const midi = VICTORY_FANFARE_A[stepInTwoBars];
      if (midi && midi > 0) {
        this.playBrassVoice(ctx, bus, midiToFreq(midi), time, stepSec * 2.8, 0.19);
      }
    }
  }

  private schedulePercussion(
    ctx: AudioContext,
    bus: GainNode,
    bar: number,
    stepInBar: number,
    isSectionB: boolean,
    time: number,
  ): void {
    const isFillBar = bar % 4 === 3;

    if (this.mood === "lobby" || this.mood === "shop") {
      // Light breezy island shaker + soft wooden rim
      if (stepInBar % 2 === 0) {
        const accent = stepInBar % 4 === 0 ? 0.065 : 0.035;
        this.playHiHat(ctx, bus, time, accent, false);
      }
      if (stepInBar === 0 || stepInBar === 10) {
        this.playKick(ctx, bus, time, this.mood === "shop" ? 0.14 : 0.2);
      }
      if (stepInBar === 4 || stepInBar === 12) {
        this.playSnare(ctx, bus, time, 0.09, true);
      }
      return;
    }

    if (this.mood === "victory") {
      if (stepInBar === 0 || stepInBar === 8) {
        this.playKick(ctx, bus, time, 0.2);
      }
      if (!isSectionB && (stepInBar === 4 || stepInBar === 12)) {
        this.playSnare(ctx, bus, time, 0.12, true);
      }
      if (stepInBar % 4 === 2) {
        this.playHiHat(ctx, bus, time, 0.05, false);
      }
      return;
    }

    if (this.mood === "battle") {
      // Energetic island groove beat
      if (stepInBar === 0 || stepInBar === 6 || stepInBar === 10) {
        this.playKick(ctx, bus, time, 0.32);
      }
      if (stepInBar === 4 || stepInBar === 12 || (isFillBar && stepInBar === 14)) {
        this.playSnare(ctx, bus, time, 0.19, false);
      }
      if (stepInBar % 2 === 0) {
        this.playHiHat(ctx, bus, time, stepInBar % 4 === 2 ? 0.08 : 0.045, false);
      }
      return;
    }

    if (this.mood === "intense") {
      // Driving double-time hi-hat + punchy kick & snare fills
      if (stepInBar === 0 || stepInBar === 3 || stepInBar === 8 || stepInBar === 10) {
        this.playKick(ctx, bus, time, 0.36);
      }
      if (
        stepInBar === 4 ||
        stepInBar === 12 ||
        (isFillBar && (stepInBar === 13 || stepInBar === 14 || stepInBar === 15))
      ) {
        this.playSnare(ctx, bus, time, 0.22, false);
      }
      this.playHiHat(ctx, bus, time, stepInBar % 2 === 0 ? 0.075 : 0.04, stepInBar === 14);
      if (isFillBar && (stepInBar === 12 || stepInBar === 14)) {
        this.playTimpani(ctx, bus, stepInBar === 12 ? 105 : 88, time, 0.22, 0.26);
      }
      return;
    }

    // "flood": dramatic pounding kick + rolling timpani storm
    if (stepInBar % 4 === 0) {
      this.playKick(ctx, bus, time, 0.38);
    }
    if (stepInBar === 4 || stepInBar === 12) {
      this.playSnare(ctx, bus, time, 0.2, false);
    }
    if (stepInBar % 2 === 0 || stepInBar >= 12) {
      const pitch = 78 + ((bar * 3 + stepInBar) % 6) * 7;
      const gain = stepInBar >= 12 ? 0.28 : 0.2;
      this.playTimpani(ctx, bus, pitch, time, 0.26, gain);
    }
  }

  private playMarimbaVoice(
    ctx: AudioContext,
    bus: GainNode,
    freq: number,
    time: number,
    decaySec: number,
    peakGain: number,
  ): void {
    const fundamental = ctx.createOscillator();
    const harmonic = ctx.createOscillator();
    const harmGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();

    fundamental.type = "sine";
    fundamental.frequency.setValueAtTime(freq, time);

    harmonic.type = "triangle";
    harmonic.frequency.setValueAtTime(freq * 2, time);
    harmGain.gain.setValueAtTime(0.22, time);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2800, time);

    env.gain.setValueAtTime(0.0008, time);
    env.gain.linearRampToValueAtTime(peakGain, time + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0008, time + Math.max(0.06, decaySec));

    fundamental.connect(filter);
    harmonic.connect(harmGain);
    harmGain.connect(filter);
    filter.connect(env);
    env.connect(bus);

    const stopAt = time + decaySec + 0.02;
    fundamental.start(time);
    harmonic.start(time);
    fundamental.stop(stopAt);
    harmonic.stop(stopAt);
  }

  private playBassVoice(
    ctx: AudioContext,
    bus: GainNode,
    freq: number,
    time: number,
    durationSec: number,
    peakGain: number,
  ): void {
    const body = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();

    body.type = "triangle";
    body.frequency.setValueAtTime(freq, time);

    sub.type = "sine";
    sub.frequency.setValueAtTime(Math.max(30, freq * 0.5), time);
    subGain.gain.setValueAtTime(0.5, time);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(540, time);
    filter.frequency.exponentialRampToValueAtTime(220, time + Math.max(0.05, durationSec));

    env.gain.setValueAtTime(0.0008, time);
    env.gain.linearRampToValueAtTime(peakGain, time + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0008, time + Math.max(0.06, durationSec));

    body.connect(filter);
    sub.connect(subGain);
    subGain.connect(filter);
    filter.connect(env);
    env.connect(bus);

    const stopAt = time + durationSec + 0.02;
    body.start(time);
    sub.start(time);
    body.stop(stopAt);
    sub.stop(stopAt);
  }

  private playBrassVoice(
    ctx: AudioContext,
    bus: GainNode,
    freq: number,
    time: number,
    durationSec: number,
    peakGain: number,
  ): void {
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    const oscBGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();

    oscA.type = "triangle";
    oscA.frequency.setValueAtTime(freq * 0.992, time);
    oscA.frequency.exponentialRampToValueAtTime(freq, time + 0.025);
    oscA.detune.setValueAtTime(-5, time);

    oscB.type = "sawtooth";
    oscB.frequency.setValueAtTime(freq, time);
    oscB.detune.setValueAtTime(5, time);
    oscBGain.gain.setValueAtTime(0.35, time);

    filter.type = "lowpass";
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(850, time);
    filter.frequency.exponentialRampToValueAtTime(2400, time + 0.045);
    filter.frequency.exponentialRampToValueAtTime(
      1250,
      time + Math.max(0.08, durationSec),
    );

    env.gain.setValueAtTime(0.0008, time);
    env.gain.linearRampToValueAtTime(peakGain, time + 0.022);
    env.gain.exponentialRampToValueAtTime(0.0008, time + Math.max(0.08, durationSec));

    oscA.connect(filter);
    oscB.connect(oscBGain);
    oscBGain.connect(filter);
    filter.connect(env);
    env.connect(bus);

    const stopAt = time + durationSec + 0.025;
    oscA.start(time);
    oscB.start(time);
    oscA.stop(stopAt);
    oscB.stop(stopAt);
  }

  private playKick(
    ctx: AudioContext,
    bus: GainNode,
    time: number,
    peakGain: number,
  ): void {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(138, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.095);

    env.gain.setValueAtTime(0.001, time);
    env.gain.linearRampToValueAtTime(peakGain, time + 0.006);
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.14);

    osc.connect(env);
    env.connect(bus);
    osc.start(time);
    osc.stop(time + 0.155);
  }

  private playSnare(
    ctx: AudioContext,
    bus: GainNode,
    time: number,
    peakGain: number,
    softRim: boolean,
  ): void {
    const buffer = this.getNoiseBuffer(ctx);
    if (buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(softRim ? 2200 : 1650, time);
      filter.Q.value = softRim ? 2.2 : 1.1;

      const env = ctx.createGain();
      const dur = softRim ? 0.055 : 0.12;
      env.gain.setValueAtTime(0.001, time);
      env.gain.linearRampToValueAtTime(peakGain, time + 0.005);
      env.gain.exponentialRampToValueAtTime(0.001, time + dur);

      src.connect(filter);
      filter.connect(env);
      env.connect(bus);
      src.start(time);
      src.stop(time + dur + 0.015);
    }

    const body = ctx.createOscillator();
    const bodyEnv = ctx.createGain();
    body.type = "triangle";
    body.frequency.setValueAtTime(softRim ? 420 : 210, time);
    body.frequency.exponentialRampToValueAtTime(softRim ? 260 : 120, time + 0.05);
    bodyEnv.gain.setValueAtTime(0.001, time);
    bodyEnv.gain.linearRampToValueAtTime(peakGain * 0.55, time + 0.004);
    bodyEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

    body.connect(bodyEnv);
    bodyEnv.connect(bus);
    body.start(time);
    body.stop(time + 0.07);
  }

  private playHiHat(
    ctx: AudioContext,
    bus: GainNode,
    time: number,
    peakGain: number,
    openHat: boolean,
  ): void {
    const buffer = this.getNoiseBuffer(ctx);
    if (!buffer) {
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(openHat ? 7200 : 8400, time);

    const env = ctx.createGain();
    const dur = openHat ? 0.13 : 0.04;
    env.gain.setValueAtTime(0.0008, time);
    env.gain.linearRampToValueAtTime(peakGain, time + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0008, time + dur);

    src.connect(filter);
    filter.connect(env);
    env.connect(bus);
    src.start(time);
    src.stop(time + dur + 0.015);
  }

  private playTimpani(
    ctx: AudioContext,
    bus: GainNode,
    freq: number,
    time: number,
    decaySec: number,
    peakGain: number,
  ): void {
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq * 1.18, time);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq), time + 0.065);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(340, time);

    env.gain.setValueAtTime(0.001, time);
    env.gain.linearRampToValueAtTime(peakGain, time + 0.008);
    env.gain.exponentialRampToValueAtTime(0.001, time + Math.max(0.1, decaySec));

    osc.connect(filter);
    filter.connect(env);
    env.connect(bus);
    osc.start(time);
    osc.stop(time + decaySec + 0.02);
  }

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === ctx.sampleRate) {
      return this.noiseBuffer;
    }
    try {
      const length = Math.max(1, Math.floor(ctx.sampleRate * 0.25));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let seed = 0x73c9a1;
      for (let i = 0; i < length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        data[i] = (seed / 0xffffffff) * 2 - 1;
      }
      this.noiseBuffer = buffer;
      return buffer;
    } catch {
      return null;
    }
  }
}
