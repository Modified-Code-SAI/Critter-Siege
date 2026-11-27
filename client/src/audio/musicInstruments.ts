import { createSeededRng } from "@critter/shared";
import type { StudioAudioBus } from "./musicEffects.js";
import { midiToFreq } from "./musicTheory.js";
import type { ChordVoicing, MusicStingerKind } from "./musicTypes.js";

const NOISE_SEED = 0x51a7c0de;
const NOISE_DURATION_SEC = 1.2;
const MIN_EXP_GAIN = 0.0001;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeClamp(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

function safeTime(ctx: AudioContext, time: number): number {
  if (Number.isFinite(time) && time >= 0) {
    return time;
  }
  const now = ctx.currentTime;
  return Number.isFinite(now) && now >= 0 ? now : 0;
}

function setParamAt(param: AudioParam, value: number, time: number): void {
  try {
    if (typeof param.setValueAtTime === "function") {
      param.setValueAtTime(value, time);
      return;
    }
  } catch {
    // Fallback below
  }
  try {
    param.value = value;
  } catch {
    // Ignore constrained mock AudioParam errors
  }
}

function linearRamp(param: AudioParam, value: number, endTime: number): void {
  try {
    if (typeof param.linearRampToValueAtTime === "function") {
      param.linearRampToValueAtTime(value, endTime);
      return;
    }
  } catch {
    // Fallback below
  }
  setParamAt(param, value, endTime);
}

function expRamp(param: AudioParam, value: number, endTime: number): void {
  const safeVal = Math.max(MIN_EXP_GAIN, value);
  try {
    if (typeof param.exponentialRampToValueAtTime === "function") {
      param.exponentialRampToValueAtTime(safeVal, endTime);
      return;
    }
  } catch {
    // Fallback below
  }
  setParamAt(param, safeVal, endTime);
}

function createOptionalPanner(
  ctx: AudioContext,
  pan: number,
): StereoPannerNode | null {
  const optionalCtx = ctx as Partial<AudioContext>;
  if (typeof optionalCtx.createStereoPanner !== "function") {
    return null;
  }
  try {
    const panner = optionalCtx.createStereoPanner();
    const safePan = safeClamp(pan, -0.95, 0.95, 0);
    panner.pan.value = safePan;
    return panner;
  } catch {
    return null;
  }
}

function routeVoiceOutput(
  source: AudioNode,
  bus: StudioAudioBus,
  dryLevel: number,
  reverbLevel: number,
  delayLevel: number,
  pan = 0,
): void {
  const ctx = bus.ctx;
  let stage: AudioNode = source;
  const panner = createOptionalPanner(ctx, pan);
  if (panner) {
    source.connect(panner);
    stage = panner;
  }

  if (dryLevel > 0.0005) {
    if (Math.abs(dryLevel - 1) < 0.001) {
      stage.connect(bus.musicDryIn);
    } else {
      const dryGain = ctx.createGain();
      dryGain.gain.value = clamp(dryLevel, 0, 1.5);
      stage.connect(dryGain);
      dryGain.connect(bus.musicDryIn);
    }
  }

  if (reverbLevel > 0.0005) {
    const revSend = ctx.createGain();
    revSend.gain.value = clamp(reverbLevel, 0, 1.5);
    stage.connect(revSend);
    revSend.connect(bus.reverbSend);
  }

  if (delayLevel > 0.0005) {
    const delSend = ctx.createGain();
    delSend.gain.value = clamp(delayLevel, 0, 1.5);
    stage.connect(delSend);
    delSend.connect(bus.delaySend);
  }
}

function pickAt<T>(arr: readonly T[], index: number, fallback: T): T {
  if (arr.length === 0) {
    return fallback;
  }
  const normalized = ((Math.floor(index) % arr.length) + arr.length) % arr.length;
  return arr[normalized] ?? fallback;
}

function deriveHarmonicNotes(chord: ChordVoicing): {
  root: number;
  pad: readonly number[];
  pluck: readonly number[];
  scale: readonly number[];
} {
  const root = Number.isFinite(chord.rootMidi) ? chord.rootMidi : 38;
  const validPad = chord.padNotes.filter((n) => Number.isFinite(n));
  const validPluck = chord.pluckNotes.filter((n) => Number.isFinite(n));
  const validScale = chord.melodyScale.filter((n) => Number.isFinite(n));

  const pad =
    validPad.length > 0 ? validPad : [root + 12, root + 19, root + 24];
  const pluck =
    validPluck.length > 0 ? validPluck : pad.map((n) => n + 12);
  const scale =
    validScale.length > 0
      ? validScale
      : [root + 24, root + 26, root + 29, root + 31, root + 36];

  return { root, pad, pluck, scale };
}

/**
 * Procedural acoustic-inspired instrument voice bank for Critter Siege.
 * Synthesizes warm bowed string pads, woody harp/lute plucks, breathy vibrato woodland
 * flutes, resonant cellos, organic frame drums/shakers/timpani, airy charge shimmers,
 * and biome-key-aware stingers routed into StudioAudioBus.
 */
export class AcousticVoiceBank {
  private disposed = false;
  private noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();

  /** Warm multi-voice bowed string / atmospheric pad chord with slow swell and lush tail. */
  public playPadChord(
    bus: StudioAudioBus,
    midiNotes: readonly number[],
    time: number,
    durationSec: number,
    peakGain: number,
  ): void {
    if (this.disposed) {
      return;
    }
    const notes = midiNotes.filter((n) => Number.isFinite(n));
    const safeGain = safeClamp(peakGain, 0, 1, 0);
    if (notes.length === 0 || safeGain <= 0.0005) {
      return;
    }

    const ctx = bus.ctx;
    const start = safeTime(ctx, time);
    const dur = safeClamp(durationSec, 0.35, 16, 2.8);
    const attack =
      dur >= 1.8
        ? clamp(dur * 0.34, 0.65, 1.2)
        : clamp(dur * 0.45, 0.16, 0.65);
    const release = clamp(dur * 0.45, 0.9, 2.2);
    const stopTime = start + dur + release + 0.08;
    const voicePeak = (safeGain / Math.sqrt(notes.length)) * 0.72;

    for (let i = 0; i < notes.length; i++) {
      const midi = notes[i];
      if (midi === undefined) continue;
      const freq = midiToFreq(midi);

      const coreOsc = ctx.createOscillator();
      coreOsc.type = "triangle";
      setParamAt(coreOsc.frequency, freq, start);
      const detuneBase = (i % 2 === 0 ? -1 : 1) * (3.2 + (i % 3) * 1.1);
      setParamAt(coreOsc.detune, detuneBase, start);

      const bowOsc = ctx.createOscillator();
      bowOsc.type = "sawtooth";
      setParamAt(bowOsc.frequency, freq, start);
      setParamAt(bowOsc.detune, -detuneBase * 1.65, start);

      const coreMix = ctx.createGain();
      coreMix.gain.value = 0.76;

      const bowMix = ctx.createGain();
      bowMix.gain.value = 0.24;

      const toneFilter = ctx.createBiquadFilter();
      toneFilter.type = "lowpass";
      toneFilter.Q.value = 0.75;
      const startCutoff = clamp(freq * 2.1, 460, 1200);
      const bloomCutoff = clamp(freq * 4.2, 950, 2200);
      setParamAt(toneFilter.frequency, startCutoff, start);
      expRamp(toneFilter.frequency, bloomCutoff, start + attack + dur * 0.25);
      expRamp(toneFilter.frequency, startCutoff * 0.85, start + dur + release);

      const env = ctx.createGain();
      setParamAt(env.gain, MIN_EXP_GAIN, start);
      linearRamp(env.gain, voicePeak, start + attack);
      linearRamp(env.gain, voicePeak * 0.86, start + dur);
      expRamp(env.gain, MIN_EXP_GAIN, start + dur + release);

      coreOsc.connect(coreMix);
      bowOsc.connect(bowMix);
      coreMix.connect(toneFilter);
      bowMix.connect(toneFilter);
      toneFilter.connect(env);

      const spreadPan =
        notes.length > 1 ? -0.48 + (i / (notes.length - 1)) * 0.96 : 0;
      routeVoiceOutput(env, bus, 0.68, 0.74, 0.0, spreadPan);

      coreOsc.start(start);
      bowOsc.start(start);
      coreOsc.stop(stopTime);
      bowOsc.stop(stopTime);
    }
  }

  /** Organic woody harp / lute pluck with damped harmonics, soundboard transient, and stereo ping-pong send. */
  public playPluckNote(
    bus: StudioAudioBus,
    midi: number,
    time: number,
    velocity: number,
    pan: number,
  ): void {
    if (this.disposed || !Number.isFinite(midi)) {
      return;
    }
    const vel = safeClamp(velocity, 0, 1, 0);
    if (vel <= 0.0005) {
      return;
    }

    const ctx = bus.ctx;
    const start = safeTime(ctx, time);
    const freq = midiToFreq(midi);
    const safePan = safeClamp(pan, -0.85, 0.85, 0);

    // Lower strings bloom slightly longer; higher harp notes sparkle and decay crisper
    const ringSec = clamp(1.38 - (midi - 48) * 0.015, 0.68, 1.45);
    const peak = vel * 0.28;
    const stopTime = start + ringSec + 0.08;

    const fundOsc = ctx.createOscillator();
    fundOsc.type = "triangle";
    setParamAt(fundOsc.frequency, freq, start);

    const harm2Osc = ctx.createOscillator();
    harm2Osc.type = "sine";
    setParamAt(harm2Osc.frequency, freq * 2, start);

    const harm3Osc = ctx.createOscillator();
    harm3Osc.type = "sine";
    setParamAt(harm3Osc.frequency, freq * 3, start);

    const harm2Env = ctx.createGain();
    setParamAt(harm2Env.gain, 0.34, start);
    expRamp(harm2Env.gain, MIN_EXP_GAIN, start + ringSec * 0.42);

    const harm3Env = ctx.createGain();
    setParamAt(harm3Env.gain, 0.13, start);
    expRamp(harm3Env.gain, MIN_EXP_GAIN, start + ringSec * 0.22);

    const pluckFilter = ctx.createBiquadFilter();
    pluckFilter.type = "lowpass";
    pluckFilter.Q.value = 0.85;
    const openHz = clamp(freq * (3.2 + vel * 3.8), 900, 6200);
    const settledHz = clamp(freq * 1.45, 340, 1650);
    setParamAt(pluckFilter.frequency, openHz, start);
    expRamp(pluckFilter.frequency, settledHz, start + Math.min(0.42, ringSec * 0.5));

    const env = ctx.createGain();
    setParamAt(env.gain, MIN_EXP_GAIN, start);
    linearRamp(env.gain, peak, start + 0.0045);
    expRamp(env.gain, peak * 0.34, start + ringSec * 0.28);
    expRamp(env.gain, MIN_EXP_GAIN, start + ringSec);

    fundOsc.connect(pluckFilter);
    harm2Osc.connect(harm2Env);
    harm2Env.connect(pluckFilter);
    harm3Osc.connect(harm3Env);
    harm3Env.connect(pluckFilter);

    // Subtle woody soundboard finger-pluck transient
    this.scheduleFilteredNoiseBurst(
      ctx,
      pluckFilter,
      start,
      0.022,
      clamp(freq * 2.2, 420, 1850),
      2.4,
      "bandpass",
      peak * 0.26,
    );

    pluckFilter.connect(env);
    routeVoiceOutput(env, bus, 0.84, 0.46, 0.34, safePan);

    fundOsc.start(start);
    harm2Osc.start(start);
    harm3Osc.start(start);
    fundOsc.stop(stopTime);
    harm2Osc.stop(stopTime);
    harm3Osc.stop(stopTime);
  }

  /** Breathy woodland flute with portamento glide, breath-chiff attack, and delayed 5.2 Hz vibrato. */
  public playFluteNote(
    bus: StudioAudioBus,
    midi: number,
    time: number,
    durationSec: number,
    velocity: number,
    prevMidi: number | null = null,
  ): void {
    if (this.disposed || !Number.isFinite(midi)) {
      return;
    }
    const vel = safeClamp(velocity, 0, 1, 0);
    if (vel <= 0.0005) {
      return;
    }

    const ctx = bus.ctx;
    const start = safeTime(ctx, time);
    const dur = safeClamp(durationSec, 0.16, 8, 0.85);
    const freq = midiToFreq(midi);
    const peak = vel * 0.22;

    const attack = clamp(dur * 0.22, 0.085, 0.19);
    const release = clamp(dur * 0.32, 0.2, 0.44);
    const stopTime = start + dur + release + 0.08;

    const sineOsc = ctx.createOscillator();
    sineOsc.type = "sine";

    const triOsc = ctx.createOscillator();
    triOsc.type = "triangle";

    // Gentle legato portamento glide when moving from a nearby previous flute note
    const hasGlide =
      prevMidi !== null &&
      Number.isFinite(prevMidi) &&
      Math.abs(midi - prevMidi) > 0 &&
      Math.abs(midi - prevMidi) <= 12;

    if (hasGlide && prevMidi !== null) {
      const fromFreq = midiToFreq(prevMidi);
      const glideSec = clamp(0.045 + Math.abs(midi - prevMidi) * 0.008, 0.045, 0.12);
      setParamAt(sineOsc.frequency, fromFreq, start);
      expRamp(sineOsc.frequency, freq, start + glideSec);
      setParamAt(triOsc.frequency, fromFreq, start);
      expRamp(triOsc.frequency, freq, start + glideSec);
    } else {
      setParamAt(sineOsc.frequency, freq, start);
      setParamAt(triOsc.frequency, freq, start);
    }

    // Subtle delayed vibrato LFO (~5.2 Hz) blooming after initial pitch settles
    const vibLfo = ctx.createOscillator();
    vibLfo.type = "sine";
    setParamAt(vibLfo.frequency, 5.2, start);

    const vibDepth = ctx.createGain();
    const vibOnset = start + Math.min(0.16, dur * 0.35);
    const vibFull = start + Math.min(0.45, dur * 0.78);
    const maxCents = dur >= 0.45 ? 11.5 : 6.0;
    setParamAt(vibDepth.gain, 0, start);
    setParamAt(vibDepth.gain, 0, vibOnset);
    linearRamp(vibDepth.gain, maxCents, vibFull);

    vibLfo.connect(vibDepth);
    vibDepth.connect(sineOsc.detune);
    vibDepth.connect(triOsc.detune);

    const sineMix = ctx.createGain();
    sineMix.gain.value = 0.78;
    const triMix = ctx.createGain();
    triMix.gain.value = 0.24;

    const fluteFilter = ctx.createBiquadFilter();
    fluteFilter.type = "lowpass";
    fluteFilter.Q.value = 0.7;
    setParamAt(fluteFilter.frequency, clamp(freq * 3.4, 1400, 5200), start);

    const env = ctx.createGain();
    setParamAt(env.gain, MIN_EXP_GAIN, start);
    linearRamp(env.gain, peak * 0.92, start + attack);
    linearRamp(env.gain, peak, start + Math.max(attack + 0.04, dur * 0.62));
    linearRamp(env.gain, peak * 0.72, start + dur);
    expRamp(env.gain, MIN_EXP_GAIN, start + dur + release);

    sineOsc.connect(sineMix);
    triOsc.connect(triMix);
    sineMix.connect(fluteFilter);
    triMix.connect(fluteFilter);
    fluteFilter.connect(env);

    // Brief breath-chiff noise transient over embouchure hole
    this.scheduleFilteredNoiseBurst(
      ctx,
      env,
      start,
      0.095,
      clamp(freq * 2.0, 950, 3600),
      3.2,
      "bandpass",
      peak * 0.16,
    );

    routeVoiceOutput(env, bus, 0.82, 0.58, 0.22, 0.12);

    sineOsc.start(start);
    triOsc.start(start);
    vibLfo.start(start);
    sineOsc.stop(stopTime);
    triOsc.stop(stopTime);
    vibLfo.stop(stopTime);
  }

  /** Deep warm bowed cello / contrabass with smooth 220-680 Hz bow-pressure tone shaping. */
  public playCelloNote(
    bus: StudioAudioBus,
    midi: number,
    time: number,
    durationSec: number,
    peakGain: number,
  ): void {
    if (this.disposed || !Number.isFinite(midi)) {
      return;
    }
    const safeGain = safeClamp(peakGain, 0, 1, 0);
    if (safeGain <= 0.0005) {
      return;
    }

    const ctx = bus.ctx;
    const start = safeTime(ctx, time);
    const dur = safeClamp(durationSec, 0.2, 12, 1.4);
    const freq = midiToFreq(midi);
    const attack = clamp(dur * 0.24, 0.14, 0.34);
    const release = clamp(dur * 0.3, 0.24, 0.5);
    const stopTime = start + dur + release + 0.08;

    const sawOsc = ctx.createOscillator();
    sawOsc.type = "sawtooth";
    setParamAt(sawOsc.frequency, freq, start);

    const triOsc = ctx.createOscillator();
    triOsc.type = "triangle";
    setParamAt(triOsc.frequency, freq, start);
    setParamAt(triOsc.detune, -3.5, start);

    const sawMix = ctx.createGain();
    sawMix.gain.value = 0.56;
    const triMix = ctx.createGain();
    triMix.gain.value = 0.48;

    const subCleanHp = ctx.createBiquadFilter();
    subCleanHp.type = "highpass";
    subCleanHp.Q.value = 0.7;
    setParamAt(subCleanHp.frequency, 52, start);

    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = "lowpass";
    bodyFilter.Q.value = 1.05;
    const peakCutoff = clamp(400 + safeGain * 280, 360, 680);
    setParamAt(bodyFilter.frequency, 220, start);
    expRamp(bodyFilter.frequency, peakCutoff, start + attack + dur * 0.2);
    expRamp(bodyFilter.frequency, 240, start + dur + release);

    const env = ctx.createGain();
    setParamAt(env.gain, MIN_EXP_GAIN, start);
    linearRamp(env.gain, safeGain * 0.85, start + attack);
    linearRamp(env.gain, safeGain * 0.78, start + dur);
    expRamp(env.gain, MIN_EXP_GAIN, start + dur + release);

    sawOsc.connect(sawMix);
    triOsc.connect(triMix);
    sawMix.connect(subCleanHp);
    triMix.connect(subCleanHp);
    subCleanHp.connect(bodyFilter);
    bodyFilter.connect(env);

    routeVoiceOutput(env, bus, 0.92, 0.34, 0.0, -0.14);

    sawOsc.start(start);
    triOsc.start(start);
    sawOsc.stop(stopTime);
    triOsc.stop(stopTime);
  }

  /** Organic hand-struck frame drum with natural skin pitch drop and warm palm transient. */
  public playFrameDrum(
    bus: StudioAudioBus,
    time: number,
    peakGain: number,
    accent = false,
  ): void {
    if (this.disposed) {
      return;
    }
    const safeGain = safeClamp(peakGain, 0, 1, 0);
    if (safeGain <= 0.0005) {
      return;
    }

    const ctx = bus.ctx;
    const start = safeTime(ctx, time);
    const decaySec = accent ? 0.29 : 0.19;
    const stopTime = start + decaySec + 0.06;

    const skinOsc = ctx.createOscillator();
    skinOsc.type = "triangle";
    const startHz = accent ? 142 : 186;
    const settleHz = accent ? 74 : 108;
    const tailHz = accent ? 62 : 94;
    setParamAt(skinOsc.frequency, startHz, start);
    expRamp(skinOsc.frequency, settleHz, start + 0.068);
    expRamp(skinOsc.frequency, tailHz, start + decaySec);

    const bodyOsc = ctx.createOscillator();
    bodyOsc.type = "sine";
    setParamAt(bodyOsc.frequency, startHz * 0.72, start);
    expRamp(bodyOsc.frequency, tailHz, start + 0.085);

    const bodyMix = ctx.createGain();
    bodyMix.gain.value = 0.55;

    const drumLp = ctx.createBiquadFilter();
    drumLp.type = "lowpass";
    drumLp.Q.value = 0.85;
    setParamAt(drumLp.frequency, accent ? 520 : 780, start);

    const env = ctx.createGain();
    setParamAt(env.gain, MIN_EXP_GAIN, start);
    linearRamp(env.gain, safeGain * (accent ? 0.92 : 0.72), start + 0.006);
    expRamp(env.gain, MIN_EXP_GAIN, start + decaySec);

    skinOsc.connect(drumLp);
    bodyOsc.connect(bodyMix);
    bodyMix.connect(drumLp);
    drumLp.connect(env);

    // Tactile palm-on-hide strike transient
    this.scheduleFilteredNoiseBurst(
      ctx,
      drumLp,
      start,
      0.034,
      accent ? 380 : 620,
      1.8,
      "bandpass",
      safeGain * (accent ? 0.28 : 0.22),
    );

    routeVoiceOutput(env, bus, 0.9, 0.28, 0.0, accent ? -0.08 : 0.14);

    skinOsc.start(start);
    bodyOsc.start(start);
    skinOsc.stop(stopTime);
    bodyOsc.stop(stopTime);
  }

  /** Soft organic brushed seed-pod / brushwork percussion shaker. */
  public playBrushShaker(
    bus: StudioAudioBus,
    time: number,
    peakGain: number,
  ): void {
    if (this.disposed) {
      return;
    }
    const safeGain = safeClamp(peakGain, 0, 1, 0);
    if (safeGain <= 0.0005) {
      return;
    }

    const ctx = bus.ctx;
    const start = safeTime(ctx, time);
    const buffer = this.getOrCreateSoftNoiseBuffer(ctx);
    const optionalCtx = ctx as Partial<AudioContext>;
    if (!buffer || typeof optionalCtx.createBufferSource !== "function") {
      return;
    }

    const src = optionalCtx.createBufferSource();
    src.buffer = buffer;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.Q.value = 0.7;
    setParamAt(hp.frequency, 2400, start);

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.9;
    setParamAt(bp.frequency, 4600, start);

    const env = ctx.createGain();
    setParamAt(env.gain, MIN_EXP_GAIN, start);
    linearRamp(env.gain, safeGain * 0.48, start + 0.01);
    expRamp(env.gain, MIN_EXP_GAIN, start + 0.078);

    src.connect(hp);
    hp.connect(bp);
    bp.connect(env);

    routeVoiceOutput(env, bus, 0.78, 0.22, 0.0, 0.24);

    src.start(start);
    src.stop(start + 0.095);
  }

  /** Deep resonant orchestral timpani tuned accurately to the supplied MIDI pitch. */
  public playTimpani(
    bus: StudioAudioBus,
    midi: number,
    time: number,
    durationSec: number,
    peakGain: number,
  ): void {
    if (this.disposed || !Number.isFinite(midi)) {
      return;
    }
    const safeGain = safeClamp(peakGain, 0, 1, 0);
    if (safeGain <= 0.0005) {
      return;
    }

    const ctx = bus.ctx;
    const start = safeTime(ctx, time);
    const dur = safeClamp(durationSec, 0.3, 2.2, 0.85);
    const freq = midiToFreq(midi);
    const stopTime = start + dur + 0.08;

    // Fundamental kettledrum head locked to exact tuned MIDI frequency;
    // calfskin strike tension bend applied smoothly via detune cents
    const headOsc = ctx.createOscillator();
    headOsc.type = "sine";
    setParamAt(headOsc.frequency, freq, start);
    setParamAt(headOsc.detune, 195, start);
    linearRamp(headOsc.detune, 0, start + 0.044);

    // Characteristic orchestral timpani fifth overtone mode (1.5x)
    const kettleOsc = ctx.createOscillator();
    kettleOsc.type = "triangle";
    setParamAt(kettleOsc.frequency, freq * 1.5, start);

    const kettleEnv = ctx.createGain();
    setParamAt(kettleEnv.gain, 0.26, start);
    expRamp(kettleEnv.gain, MIN_EXP_GAIN, start + dur * 0.45);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.8;
    setParamAt(lp.frequency, clamp(freq * 4.5, 280, 900), start);

    const env = ctx.createGain();
    setParamAt(env.gain, MIN_EXP_GAIN, start);
    linearRamp(env.gain, safeGain * 0.92, start + 0.008);
    expRamp(env.gain, safeGain * 0.36, start + dur * 0.38);
    expRamp(env.gain, MIN_EXP_GAIN, start + dur);

    headOsc.connect(lp);
    kettleOsc.connect(kettleEnv);
    kettleEnv.connect(lp);
    lp.connect(env);

    // Soft felt mallet impact thump
    this.scheduleFilteredNoiseBurst(
      ctx,
      lp,
      start,
      0.03,
      320,
      0.9,
      "lowpass",
      safeGain * 0.32,
    );

    routeVoiceOutput(env, bus, 0.9, 0.44, 0.0, -0.18);

    headOsc.start(start);
    kettleOsc.start(start);
    headOsc.stop(stopTime);
    kettleOsc.stop(stopTime);
  }

  /** Subtle airy fifth/ninth harmonic swell whose glow and brightness scale with shot charge intensity. */
  public playChargeShimmer(
    bus: StudioAudioBus,
    chord: ChordVoicing,
    time: number,
    durationSec: number,
    intensity: number,
  ): void {
    if (this.disposed) {
      return;
    }
    const safeIntensity = safeClamp(intensity, 0, 1, 0);
    if (safeIntensity <= 0.01) {
      return;
    }

    const ctx = bus.ctx;
    const start = safeTime(ctx, time);
    const dur = safeClamp(durationSec, 0.2, 4.0, 0.75);
    const release = clamp(dur * 0.5, 0.25, 0.85);
    const stopTime = start + dur + release + 0.06;

    const { root, pad, pluck } = deriveHarmonicNotes(chord);
    // Airy upper tonic + fifth + ninth/color tone drawn harmonically from the active chord
    const fifthMidi = pickAt(pad, 1, root + 19);
    const colorMidi = pickAt(pad, 2, pickAt(pluck, 3, root + 26));
    const shimmerMidis: number[] = [
      root + 24,
      fifthMidi + 12,
      colorMidi + 12,
    ];
    if (safeIntensity > 0.6) {
      const upperColor = pickAt(pluck, pluck.length - 1, root + 31);
      shimmerMidis.push(upperColor + 12);
    }

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.9;
    const startHz = 850 + safeIntensity * 1400;
    const peakHz = 1400 + safeIntensity * 3200;
    setParamAt(filter.frequency, startHz, start);
    expRamp(filter.frequency, peakHz, start + dur * 0.75);
    expRamp(filter.frequency, startHz * 0.8, start + dur + release);

    const env = ctx.createGain();
    const peak = (0.04 + safeIntensity * 0.12) / Math.sqrt(shimmerMidis.length);
    setParamAt(env.gain, MIN_EXP_GAIN, start);
    linearRamp(env.gain, peak, start + dur * 0.65);
    expRamp(env.gain, MIN_EXP_GAIN, start + dur + release);

    for (let i = 0; i < shimmerMidis.length; i++) {
      const midi = shimmerMidis[i];
      if (midi === undefined) continue;
      const osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? "sine" : "triangle";
      setParamAt(osc.frequency, midiToFreq(midi), start);
      setParamAt(osc.detune, i % 2 === 0 ? -4.5 : 4.5, start);
      osc.connect(filter);
      osc.start(start);
      osc.stop(stopTime);
    }

    filter.connect(env);
    routeVoiceOutput(env, bus, 0.36, 0.82, 0.36, 0);
  }

  /** Biome-key-aware orchestral stingers deriving all pitches directly from the active chord. */
  public playStinger(
    bus: StudioAudioBus,
    kind: MusicStingerKind,
    chord: ChordVoicing,
    time: number,
    apexBonus = false,
  ): void {
    if (this.disposed) {
      return;
    }
    const start = safeTime(bus.ctx, time);
    const { root, pad, pluck, scale } = deriveHarmonicNotes(chord);

    switch (kind) {
      case "ko": {
        // Decisive low timpani & cello cadence with a descending woodland flute sigh
        this.playTimpani(bus, root, start, 0.95, 0.38);
        this.playCelloNote(bus, root, start, 0.9, 0.28);
        const top = pickAt(scale, scale.length - 2, root + 31);
        const mid = pickAt(scale, Math.floor(scale.length / 2), root + 26);
        const low = pickAt(scale, 0, root + 24);
        this.playFluteNote(bus, top, start + 0.04, 0.28, 0.62, null);
        this.playFluteNote(bus, mid, start + 0.22, 0.3, 0.56, top);
        this.playFluteNote(bus, low, start + 0.42, 0.58, 0.66, mid);
        return;
      }

      case "round_end": {
        // Warm woodland harp flourish + glowing bowed pad chord + soaring flute resolve
        this.playPadChord(bus, pad.slice(0, 4), start, 1.5, 0.22);
        const arpCount = Math.min(4, pluck.length);
        for (let i = 0; i < arpCount; i++) {
          const midi = pickAt(pluck, i, root + 24);
          const pan = -0.45 + (i / Math.max(1, arpCount - 1)) * 0.9;
          this.playPluckNote(bus, midi, start + i * 0.085, 0.68, pan);
        }
        const resolveMidi = pickAt(scale, scale.length - 1, root + 36);
        this.playFluteNote(bus, resolveMidi, start + 0.24, 0.95, 0.72, null);
        return;
      }

      case "flood_alarm": {
        // Ominous rising tide surge: deep double timpani + dark cello + haunted flute dyad
        const fifth = pickAt(pad, 1, root + 19);
        this.playTimpani(bus, root, start, 0.85, 0.42);
        this.playTimpani(bus, root, start + 0.28, 1.0, 0.46);
        this.playCelloNote(bus, root, start, 1.15, 0.34);
        const warnLow = pickAt(scale, 1, fifth + 12);
        const warnHigh = pickAt(scale, 3, root + 31);
        this.playFluteNote(bus, warnLow, start + 0.08, 0.45, 0.58, null);
        this.playFluteNote(bus, warnHigh, start + 0.34, 0.72, 0.66, warnLow);
        return;
      }

      case "purchase": {
        // Buoyant ascending harp sparkle across the stereo field + warm flute grace
        const sparkleCount = Math.min(4, pluck.length);
        for (let i = 0; i < sparkleCount; i++) {
          const midi = pickAt(pluck, i, root + 24);
          const pan = -0.38 + (i / Math.max(1, sparkleCount - 1)) * 0.76;
          this.playPluckNote(bus, midi, start + i * 0.055, 0.66 + i * 0.04, pan);
        }
        const chimeMidi = pickAt(scale, scale.length - 2, root + 31);
        this.playFluteNote(bus, chimeMidi, start + 0.16, 0.42, 0.54, null);
        return;
      }

      case "evolution": {
        // Radiant heroic metamorphosis: full pad swell + ascending harp + soaring flute
        this.playPadChord(bus, pad, start, 1.85, 0.26);
        const flourishCount = Math.min(5, pluck.length);
        for (let i = 0; i < flourishCount; i++) {
          const midi = pickAt(pluck, i, root + 24);
          const pan = -0.5 + (i / Math.max(1, flourishCount - 1)) * 1.0;
          this.playPluckNote(bus, midi, start + i * 0.07, 0.74, pan);
        }
        const callStart = pickAt(scale, 2, root + 26);
        const callPeak = pickAt(scale, scale.length - 1, root + 36);
        this.playFluteNote(bus, callStart, start + 0.12, 0.36, 0.68, null);
        this.playFluteNote(bus, callPeak, start + 0.38, 1.05, 0.8, callStart);

        if (apexBonus) {
          // Extra shimmering high-overtone bloom (+12 octave bells & airy harmonic halo)
          const apexHalo = [
            pickAt(pad, 0, root + 12) + 24,
            pickAt(pad, 1, root + 19) + 24,
            pickAt(scale, scale.length - 1, root + 36) + 12,
          ];
          this.playApexOvertoneBloom(bus, apexHalo, start + 0.28, 1.45, 0.16);
        }
        return;
      }
    }
  }

  /** Releases cached buffer references and prevents further scheduled synthesis. */
  public dispose(): void {
    this.disposed = true;
    this.noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();
  }

  private playApexOvertoneBloom(
    bus: StudioAudioBus,
    midiNotes: readonly number[],
    start: number,
    durationSec: number,
    peakGain: number,
  ): void {
    const ctx = bus.ctx;
    const stopTime = start + durationSec + 0.45;
    const perNoteGain = peakGain / Math.max(1, Math.sqrt(midiNotes.length));

    for (let i = 0; i < midiNotes.length; i++) {
      const midi = midiNotes[i];
      if (midi === undefined || !Number.isFinite(midi)) continue;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      setParamAt(osc.frequency, midiToFreq(midi), start);
      setParamAt(osc.detune, i % 2 === 0 ? -3 : 3, start);

      const env = ctx.createGain();
      setParamAt(env.gain, MIN_EXP_GAIN, start);
      linearRamp(env.gain, perNoteGain, start + 0.18 + i * 0.05);
      expRamp(env.gain, MIN_EXP_GAIN, start + durationSec + 0.35);

      osc.connect(env);
      const pan = -0.45 + (i / Math.max(1, midiNotes.length - 1)) * 0.9;
      routeVoiceOutput(env, bus, 0.42, 0.88, 0.45, pan);

      osc.start(start + i * 0.04);
      osc.stop(stopTime);
    }
  }

  private scheduleFilteredNoiseBurst(
    ctx: AudioContext,
    destination: AudioNode,
    start: number,
    durationSec: number,
    centerHz: number,
    q: number,
    filterType: BiquadFilterType,
    peakGain: number,
  ): void {
    const buffer = this.getOrCreateSoftNoiseBuffer(ctx);
    const optionalCtx = ctx as Partial<AudioContext>;
    if (
      !buffer ||
      typeof optionalCtx.createBufferSource !== "function" ||
      peakGain <= 0.0005
    ) {
      return;
    }

    const src = optionalCtx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    setParamAt(filter.frequency, clamp(centerHz, 120, 12000), start);

    const env = ctx.createGain();
    const attack = Math.min(0.012, durationSec * 0.3);
    setParamAt(env.gain, MIN_EXP_GAIN, start);
    linearRamp(env.gain, peakGain, start + attack);
    expRamp(env.gain, MIN_EXP_GAIN, start + durationSec);

    src.connect(filter);
    filter.connect(env);
    env.connect(destination);

    src.start(start);
    src.stop(start + durationSec + 0.02);
  }

  private getOrCreateSoftNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
    const cached = this.noiseBuffers.get(ctx);
    if (cached) {
      return cached;
    }
    const optionalCtx = ctx as Partial<AudioContext>;
    if (typeof optionalCtx.createBuffer !== "function") {
      return null;
    }

    const rawRate = ctx.sampleRate;
    const sampleRate =
      Number.isFinite(rawRate) && rawRate >= 8000 ? Math.round(rawRate) : 44100;
    const length = Math.max(256, Math.round(sampleRate * NOISE_DURATION_SEC));

    let buffer: AudioBuffer;
    try {
      buffer = optionalCtx.createBuffer(1, length, sampleRate);
    } catch {
      return null;
    }

    const data = buffer.getChannelData(0);
    if (!data || data.length === 0) {
      return null;
    }

    // Soft pink-tinted noise (3-pole Paul Kellet style smoothing) for warm acoustic breath & wood
    const rng = createSeededRng(NOISE_SEED);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < length; i++) {
      const white = rng() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = clamp((b0 + b1 + b2 + white * 0.1848) * 0.24, -1, 1);
    }

    this.noiseBuffers.set(ctx, buffer);
    return buffer;
  }
}
