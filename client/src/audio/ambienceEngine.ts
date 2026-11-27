import { createSeededRng } from "@critter/shared";
import type { StudioAudioBus } from "./musicEffects.js";
import type { MusicGameplayContext } from "./musicTypes.js";

const NOISE_DURATION_SEC = 3;
const PINK_NOISE_LEFT_SEED = 0x53757266; // deterministic sky-island surf/wind seed (L)
const PINK_NOISE_RIGHT_SEED = 0x57696e64; // deterministic sky-island surf/wind seed (R)
const DEFAULT_SAMPLE_RATE = 44100;
const LOOP_CROSSFADE_SEC = 0.18;

interface PinkStereoPcm {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly length: number;
}

// Deterministic pink-weighted stereo PCM cached per sampleRate (zero Math.random())
const PINK_PCM_CACHE = new Map<number, PinkStereoPcm>();

// Per-AudioContext AudioBuffer cache keyed by sampleRate so buffers reuse cleanly & auto-GC
const AUDIO_BUFFER_CACHE = new WeakMap<AudioContext, Map<number, AudioBuffer>>();

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

function getSafeCurrentTime(ctx: AudioContext): number {
  const t = ctx.currentTime;
  return Number.isFinite(t) && t >= 0 ? t : 0;
}

function getSafeSampleRate(ctx: AudioContext): number {
  const raw = ctx.sampleRate;
  return Number.isFinite(raw) && raw >= 8000 && raw <= 192000
    ? Math.round(raw)
    : DEFAULT_SAMPLE_RATE;
}

function setParamImmediate(
  param: AudioParam,
  value: number,
  now: number,
): void {
  const safeVal = Number.isFinite(value) ? value : 0;
  const safeNow = Number.isFinite(now) && now >= 0 ? now : 0;
  try {
    if (typeof param.setValueAtTime === "function") {
      param.setValueAtTime(safeVal, safeNow);
      return;
    }
  } catch {
    // Fallback to direct property assignment below
  }
  try {
    param.value = safeVal;
  } catch {
    // Ignore constrained mock AudioParam errors
  }
}

function setParamSmooth(
  param: AudioParam,
  target: number,
  now: number,
  timeConstantSec: number,
): void {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const safeNow = Number.isFinite(now) && now >= 0 ? now : 0;
  const safeTc =
    Number.isFinite(timeConstantSec) && timeConstantSec > 0
      ? clamp(timeConstantSec, 0.005, 5.0)
      : 0.25;
  try {
    if (typeof param.setTargetAtTime === "function") {
      param.setTargetAtTime(safeTarget, safeNow, safeTc);
      return;
    }
  } catch {
    // Fallback to direct property assignment below
  }
  try {
    param.value = safeTarget;
  } catch {
    // Ignore constrained mock AudioParam errors
  }
}

function safeStartBufferSource(
  source: AudioBufferSourceNode,
  when: number,
  offsetSec: number,
): void {
  const safeWhen = Number.isFinite(when) && when >= 0 ? when : 0;
  const safeOffset = Number.isFinite(offsetSec) && offsetSec >= 0 ? offsetSec : 0;
  try {
    source.start(safeWhen, safeOffset);
    return;
  } catch {
    // Fallback for constrained mocks that accept only 1 argument
  }
  try {
    source.start(safeWhen);
  } catch {
    // Ignore start failure in constrained environments
  }
}

function generatePinkChannel(
  totalSamples: number,
  seed: number,
): Float32Array {
  const rng = createSeededRng(seed);
  const out = new Float32Array(totalSamples);

  // Paul Kellet 7-stage pink noise state (natural -3 dB/octave warm spectrum)
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;

  // Gentle air smoothing + DC blocker for silky, fatigue-free ambience
  let lp = 0;
  let hpPrev = 0;
  let hpOut = 0;

  for (let i = 0; i < totalSamples; i++) {
    // Triangular-ish PDF white source (smoother crest factor than uniform white)
    const white = rng() + rng() - 1;

    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;

    // Gentle high-frequency air rolloff so it never sounds like harsh static hiss
    lp += 0.38 * (pink - lp);

    // Subtle sub-20 Hz DC blocker
    hpOut = 0.996 * (hpOut + lp - hpPrev);
    hpPrev = lp;

    out[i] = hpOut;
  }

  return out;
}

function getOrCreatePinkStereoPcm(sampleRate: number): PinkStereoPcm {
  const cached = PINK_PCM_CACHE.get(sampleRate);
  if (cached) {
    return cached;
  }

  const length = Math.max(512, Math.round(sampleRate * NOISE_DURATION_SEC));
  const crossfadeLen = Math.min(
    Math.floor(length * 0.1),
    Math.max(64, Math.round(sampleRate * LOOP_CROSSFADE_SEC)),
  );
  // Warmup prefix lets the pink filter settle before sample 0
  const warmupLen = Math.min(2048, Math.max(256, Math.round(sampleRate * 0.05)));
  const totalLen = warmupLen + length + crossfadeLen;

  const rawL = generatePinkChannel(totalLen, PINK_NOISE_LEFT_SEED);
  const rawR = generatePinkChannel(totalLen, PINK_NOISE_RIGHT_SEED);

  const left = new Float32Array(length);
  const right = new Float32Array(length);

  // Copy core body and apply equal-power cosine/sine crossfade from extra tail over head
  for (let i = 0; i < length; i++) {
    let sL = rawL[warmupLen + i] ?? 0;
    let sR = rawR[warmupLen + i] ?? 0;

    if (i < crossfadeLen) {
      const phase = ((i + 0.5) / crossfadeLen) * (Math.PI * 0.5);
      const fadeIn = Math.sin(phase);
      const fadeOut = Math.cos(phase);
      const tailL = rawL[warmupLen + length + i] ?? 0;
      const tailR = rawR[warmupLen + length + i] ?? 0;
      sL = sL * fadeIn + tailL * fadeOut;
      sR = sR * fadeIn + tailR * fadeOut;
    }

    // Natural mid/side stereo blend for open sky-island width without phase hollowing
    const mid = (sL + sR) * 0.5;
    const side = (sL - sR) * 0.5;
    left[i] = mid * 0.72 + side * 0.56;
    right[i] = mid * 0.72 - side * 0.56;
  }

  // Normalize peak to balanced 0.72 headroom
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const aL = Math.abs(left[i] ?? 0);
    const aR = Math.abs(right[i] ?? 0);
    if (aL > peak) peak = aL;
    if (aR > peak) peak = aR;
  }
  if (peak > 0.0001) {
    const scale = 0.72 / peak;
    for (let i = 0; i < length; i++) {
      left[i] = (left[i] ?? 0) * scale;
      right[i] = (right[i] ?? 0) * scale;
    }
  }

  const pcm: PinkStereoPcm = { left, right, length };
  PINK_PCM_CACHE.set(sampleRate, pcm);
  return pcm;
}

function getOrCreatePinkNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
  const sampleRate = getSafeSampleRate(ctx);

  let perCtxMap = AUDIO_BUFFER_CACHE.get(ctx);
  if (perCtxMap) {
    const existing = perCtxMap.get(sampleRate);
    if (existing) {
      return existing;
    }
  }

  const optionalCtx = ctx as Partial<AudioContext>;
  if (typeof optionalCtx.createBuffer !== "function") {
    return null;
  }

  const pcm = getOrCreatePinkStereoPcm(sampleRate);
  let buffer: AudioBuffer | null = null;
  let channels = 2;

  try {
    buffer = optionalCtx.createBuffer(2, pcm.length, sampleRate);
  } catch {
    channels = 1;
    try {
      buffer = optionalCtx.createBuffer(1, pcm.length, sampleRate);
    } catch {
      return null;
    }
  }

  if (channels === 2) {
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.getChannelData(1);
    ch0.set(pcm.left.subarray(0, ch0.length));
    ch1.set(pcm.right.subarray(0, ch1.length));
  } else {
    const ch0 = buffer.getChannelData(0);
    const limit = Math.min(ch0.length, pcm.length);
    for (let i = 0; i < limit; i++) {
      ch0[i] = ((pcm.left[i] ?? 0) + (pcm.right[i] ?? 0)) * 0.5;
    }
  }

  if (!perCtxMap) {
    perCtxMap = new Map<number, AudioBuffer>();
    AUDIO_BUFFER_CACHE.set(ctx, perCtxMap);
  }
  perCtxMap.set(sampleRate, buffer);
  return buffer;
}

/**
 * Procedural Living Island Ambience Engine:
 * Runs 3 continuous looped pink-noise soundscape layers into `bus.ambienceIn`:
 *   1. Ocean Surf — lowpassed surf with slow ~0.12 Hz breathing wave LFO
 *   2. Live Island Wind — resonant bandpass gusts tied to `windSpeed` & Drone Recon altitude
 *   3. Storm & Final Deluge Wash — whisper-quiet early, swelling through late rounds & Final Flood
 */
export class AmbienceEngine {
  private running = false;
  private disposed = false;
  private bus: StudioAudioBus | null = null;
  private lastContext: MusicGameplayContext | null = null;

  private sources: AudioBufferSourceNode[] = [];
  private oscillators: OscillatorNode[] = [];
  private nodes: AudioNode[] = [];

  // Layer 1: Ocean Surf
  private oceanFilter: BiquadFilterNode | null = null;
  private oceanGain: GainNode | null = null;
  private oceanLfo: OscillatorNode | null = null;
  private oceanLfoDepth: GainNode | null = null;

  // Layer 2: Live Island Wind
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windGustDepth: GainNode | null = null;

  // Layer 3: Storm & Final Deluge Wash
  private stormBandFilter: BiquadFilterNode | null = null;
  private stormLowFilter: BiquadFilterNode | null = null;
  private stormGain: GainNode | null = null;

  public start(bus: StudioAudioBus): void {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      if (this.bus === bus) {
        return;
      }
      this.stop();
    }

    const ctx = bus.ctx;
    const pinkBuffer = getOrCreatePinkNoiseBuffer(ctx);
    if (!pinkBuffer) {
      return;
    }

    const now = getSafeCurrentTime(ctx);
    const trackNode = <T extends AudioNode>(node: T): T => {
      this.nodes.push(node);
      return node;
    };

    try {
      // --- Layer 1: Ocean Surf (slow breathing wave swells) ---
      const oceanSource = trackNode(ctx.createBufferSource());
      oceanSource.buffer = pinkBuffer;
      oceanSource.loop = true;

      const oceanFilter = trackNode(ctx.createBiquadFilter());
      oceanFilter.type = "lowpass";
      setParamImmediate(oceanFilter.frequency, 330, now);
      setParamImmediate(oceanFilter.Q, 0.65, now);

      const oceanGain = trackNode(ctx.createGain());
      setParamImmediate(oceanGain.gain, 0.135, now);

      const oceanLfo = trackNode(ctx.createOscillator());
      oceanLfo.type = "sine";
      setParamImmediate(oceanLfo.frequency, 0.12, now);

      const oceanLfoDepth = trackNode(ctx.createGain());
      setParamImmediate(oceanLfoDepth.gain, 0.036, now);

      oceanSource.connect(oceanFilter);
      oceanFilter.connect(oceanGain);
      oceanGain.connect(bus.ambienceIn);

      oceanLfo.connect(oceanLfoDepth);
      oceanLfoDepth.connect(oceanGain.gain);

      // --- Layer 2: Live Island Wind (gusts tied to windSpeed & Drone Recon) ---
      const windSource = trackNode(ctx.createBufferSource());
      windSource.buffer = pinkBuffer;
      windSource.loop = true;

      const windFilter = trackNode(ctx.createBiquadFilter());
      windFilter.type = "bandpass";
      setParamImmediate(windFilter.frequency, 380, now);
      setParamImmediate(windFilter.Q, 1.45, now);

      const windGain = trackNode(ctx.createGain());
      setParamImmediate(windGain.gain, 0.038, now);

      const windGustLfo = trackNode(ctx.createOscillator());
      windGustLfo.type = "sine";
      setParamImmediate(windGustLfo.frequency, 0.19, now);

      const windGustDepth = trackNode(ctx.createGain());
      setParamImmediate(windGustDepth.gain, 26, now);

      windSource.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(bus.ambienceIn);

      windGustLfo.connect(windGustDepth);
      windGustDepth.connect(windFilter.frequency);

      // --- Layer 3: Storm & Final Deluge Wash ---
      const stormSource = trackNode(ctx.createBufferSource());
      stormSource.buffer = pinkBuffer;
      stormSource.loop = true;

      const stormBandFilter = trackNode(ctx.createBiquadFilter());
      stormBandFilter.type = "bandpass";
      setParamImmediate(stormBandFilter.frequency, 640, now);
      setParamImmediate(stormBandFilter.Q, 0.85, now);

      const stormLowFilter = trackNode(ctx.createBiquadFilter());
      stormLowFilter.type = "lowpass";
      setParamImmediate(stormLowFilter.frequency, 1550, now);
      setParamImmediate(stormLowFilter.Q, 0.65, now);

      const stormGain = trackNode(ctx.createGain());
      setParamImmediate(stormGain.gain, 0.002, now);

      stormSource.connect(stormBandFilter);
      stormBandFilter.connect(stormLowFilter);
      stormLowFilter.connect(stormGain);
      stormGain.connect(bus.ambienceIn);

      // Start all 3 buffer sources at staggered loop offsets to eliminate comb filtering
      safeStartBufferSource(oceanSource, now, 0);
      safeStartBufferSource(windSource, now, 0.97);
      safeStartBufferSource(stormSource, now, 1.93);

      oceanLfo.start(now);
      windGustLfo.start(now);

      this.sources.push(oceanSource, windSource, stormSource);
      this.oscillators.push(oceanLfo, windGustLfo);

      this.oceanFilter = oceanFilter;
      this.oceanGain = oceanGain;
      this.oceanLfo = oceanLfo;
      this.oceanLfoDepth = oceanLfoDepth;
      this.windFilter = windFilter;
      this.windGain = windGain;
      this.windGustDepth = windGustDepth;
      this.stormBandFilter = stormBandFilter;
      this.stormLowFilter = stormLowFilter;
      this.stormGain = stormGain;

      this.bus = bus;
      this.running = true;

      if (this.lastContext) {
        this.update(this.lastContext);
      }
    } catch {
      this.cleanupGraph();
    }
  }

  public update(ctx: MusicGameplayContext): void {
    this.lastContext = { ...ctx };

    if (this.disposed || !this.running || !this.bus) {
      return;
    }

    const now = getSafeCurrentTime(this.bus.ctx);

    // Review Focus #5: strictly sanitize all telemetry before touching any AudioParam
    const windSpeed = safeClamp(ctx.windSpeed, 0, 18, 0);
    const waterLevel = safeClamp(ctx.waterLevel, 0, 24, 1.5);
    const floodIntensity = safeClamp(ctx.floodIntensity, 0, 1, 0);
    const round = safeClamp(ctx.round, 1, 99, 1);
    const maxRounds = safeClamp(ctx.maxRounds, 1, 99, 5);
    const isDroneView = Boolean(ctx.isDroneView);

    const windNorm = windSpeed / 18;
    const waterNorm = waterLevel / 24;
    const isLateRound = round >= Math.max(2, maxRounds - 1);

    // 1. Ocean Surf: deepens & rises with waterLevel / flood, pulls back subtly in Drone Recon
    const oceanPresence = clamp(waterNorm * 0.78 + floodIntensity * 0.42, 0, 1);
    const oceanFreqTarget = clamp(
      305 + oceanPresence * 205 - (isDroneView ? 25 : 0),
      280,
      520,
    );
    const oceanMoodScale =
      ctx.mood === "shop"
        ? 0.84
        : ctx.mood === "victory" || ctx.mood === "defeat"
          ? 0.88
          : 1.0;
    const oceanDroneScale = isDroneView ? 0.74 : 1.0;
    const oceanGainTarget = clamp(
      (0.12 + oceanPresence * 0.15) * oceanMoodScale * oceanDroneScale,
      0.06,
      0.3,
    );
    const oceanLfoDepthTarget = clamp(oceanGainTarget * 0.28, 0.015, 0.075);
    const oceanLfoRateTarget = clamp(0.115 + oceanPresence * 0.04, 0.09, 0.18);

    if (this.oceanFilter) {
      setParamSmooth(this.oceanFilter.frequency, oceanFreqTarget, now, 0.45);
    }
    if (this.oceanGain) {
      setParamSmooth(this.oceanGain.gain, oceanGainTarget, now, 0.45);
    }
    if (this.oceanLfoDepth) {
      setParamSmooth(this.oceanLfoDepth.gain, oceanLfoDepthTarget, now, 0.45);
    }
    if (this.oceanLfo) {
      setParamSmooth(this.oceanLfo.frequency, oceanLfoRateTarget, now, 0.6);
    }

    // 2. Live Island Wind: scales with clamped windSpeed (0..18 m/s) + airy altitude shift in Drone Recon
    const windBaseFreq = 320 + windNorm * 650;
    const windFreqTarget = clamp(
      windBaseFreq + (isDroneView ? 280 : 0),
      320,
      1250,
    );
    const windQTarget = clamp(
      isDroneView ? 1.15 + windNorm * 0.65 : 1.35 + windNorm * 1.1,
      1.0,
      2.5,
    );
    const windMoodScale = ctx.mood === "shop" ? 0.82 : 1.0;
    const windGainTarget = clamp(
      (0.024 + Math.pow(windNorm, 0.85) * 0.14) * windMoodScale +
        (isDroneView ? 0.028 : 0),
      0.015,
      0.22,
    );
    const windGustDepthTarget = clamp(
      20 + windNorm * 56 + (isDroneView ? 18 : 0),
      15,
      95,
    );

    if (this.windFilter) {
      setParamSmooth(this.windFilter.frequency, windFreqTarget, now, 0.28);
      setParamSmooth(this.windFilter.Q, windQTarget, now, 0.32);
    }
    if (this.windGain) {
      setParamSmooth(this.windGain.gain, windGainTarget, now, 0.28);
    }
    if (this.windGustDepth) {
      setParamSmooth(this.windGustDepth.gain, windGustDepthTarget, now, 0.35);
    }

    // 3. Storm & Final Deluge Wash: whisper-quiet early, rises late/intense, peaks in Final Flood
    let stormGainTarget: number;
    if (
      (ctx.mood === "lobby" || ctx.mood === "shop") &&
      floodIntensity < 0.05
    ) {
      stormGainTarget = 0.002;
    } else if (ctx.mood === "flood") {
      stormGainTarget = clamp(0.115 + floodIntensity * 0.115, 0.09, 0.24);
    } else if (ctx.mood === "victory" || ctx.mood === "defeat") {
      stormGainTarget = clamp(0.003 + floodIntensity * 0.04, 0.002, 0.06);
    } else if (ctx.mood === "intense" || isLateRound) {
      const lateBoost = isLateRound ? 0.024 : 0;
      const intenseBoost = ctx.mood === "intense" ? 0.026 : 0;
      stormGainTarget = clamp(
        0.028 + lateBoost + intenseBoost + floodIntensity * 0.11 + windNorm * 0.015,
        0.02,
        0.21,
      );
    } else {
      stormGainTarget = clamp(
        0.002 + floodIntensity * 0.14 + Math.max(0, windNorm - 0.45) * 0.018,
        0.002,
        0.16,
      );
    }

    const stormEnergy = clamp((stormGainTarget - 0.002) / 0.22, 0, 1);
    const stormBandFreqTarget = clamp(620 + stormEnergy * 480, 580, 1180);
    const stormLowFreqTarget = clamp(1500 + stormEnergy * 1100, 1300, 2700);

    if (this.stormBandFilter) {
      setParamSmooth(
        this.stormBandFilter.frequency,
        stormBandFreqTarget,
        now,
        0.48,
      );
    }
    if (this.stormLowFilter) {
      setParamSmooth(
        this.stormLowFilter.frequency,
        stormLowFreqTarget,
        now,
        0.48,
      );
    }
    if (this.stormGain) {
      setParamSmooth(this.stormGain.gain, stormGainTarget, now, 0.52);
    }
  }

  public stop(): void {
    if (!this.running) {
      return;
    }
    this.cleanupGraph();
  }

  public isRunning(): boolean {
    return this.running;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.stop();
    this.disposed = true;
    this.lastContext = null;
  }

  private cleanupGraph(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // Ignore already-stopped source errors during teardown
      }
    }
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        // Ignore already-stopped oscillator errors during teardown
      }
    }
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        // Ignore disconnect errors during teardown
      }
    }

    this.sources = [];
    this.oscillators = [];
    this.nodes = [];

    this.oceanFilter = null;
    this.oceanGain = null;
    this.oceanLfo = null;
    this.oceanLfoDepth = null;
    this.windFilter = null;
    this.windGain = null;
    this.windGustDepth = null;
    this.stormBandFilter = null;
    this.stormLowFilter = null;
    this.stormGain = null;

    this.bus = null;
    this.running = false;
  }
}
