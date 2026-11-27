import { createSeededRng } from "@critter/shared";

export interface StudioAudioBus {
  readonly ctx: AudioContext;
  readonly musicDryIn: GainNode;
  readonly reverbSend: GainNode;
  readonly delaySend: GainNode;
  readonly ambienceIn: GainNode;
  readonly duckGain: GainNode;
  readonly musicMuteGain: GainNode;
  readonly ambienceMuteGain: GainNode;
  readonly musicToneFilter: BiquadFilterNode;
  readonly hasConvolver: boolean;
  readonly hasDelay: boolean;
  readonly hasCompressor: boolean;
  setMusicMuted(muted: boolean): void;
  setMasterMuted(muted: boolean): void;
  setFilterCutoff(hz: number, timeConstantSec?: number): void;
  setReverbWet(wet: number, timeConstantSec?: number): void;
  duck(depth?: number, durationSec?: number): void;
  dispose(): void;
}

const BASE_MUSIC_GAIN = 0.26;
const AMBIENCE_UNMUTED_GAIN = 0.86;
const AMBIENCE_MUSIC_MUTED_GAIN = 0.58;
const DEFAULT_FILTER_HZ = 14000;
const DEFAULT_REVERB_WET = 0.36;
const VALLEY_IR_DURATION_SEC = 2.1;
const VALLEY_IR_SEED = 0x43726974; // deterministic valley reflection seed

// Cached stereo valley impulse responses keyed per AudioContext so they auto-GC cleanly
const VALLEY_IR_CACHE = new WeakMap<AudioContext, AudioBuffer>();

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

function setParamSmooth(
  param: AudioParam,
  target: number,
  now: number,
  timeConstantSec: number,
): void {
  try {
    if (typeof param.setTargetAtTime === "function") {
      param.setTargetAtTime(target, now, timeConstantSec);
      return;
    }
  } catch {
    // Fallback to direct value assignment below
  }
  try {
    param.value = target;
  } catch {
    // Ignore constrained mock AudioParam errors
  }
}

function setParamValue(param: AudioParam, value: number): void {
  try {
    param.value = value;
  } catch {
    // Ignore constrained mock AudioParam errors
  }
}

function getSafeCurrentTime(ctx: AudioContext): number {
  const t = ctx.currentTime;
  return Number.isFinite(t) && t >= 0 ? t : 0;
}

/**
 * Generates (and caches per AudioContext) a deterministic 2.1s stereo room/valley
 * impulse response with warm early reflections, smooth dual-slope exponential decay,
 * gentle stereo decorrelation, and progressive high-frequency air damping.
 */
function getOrCreateValleyImpulseResponse(
  ctx: AudioContext,
): AudioBuffer | null {
  const cached = VALLEY_IR_CACHE.get(ctx);
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
  const length = Math.max(256, Math.round(sampleRate * VALLEY_IR_DURATION_SEC));

  let buffer: AudioBuffer;
  try {
    buffer = optionalCtx.createBuffer(2, length, sampleRate);
  } catch {
    return null;
  }

  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  if (!left || !right || left.length === 0 || right.length === 0) {
    return null;
  }

  const rngL = createSeededRng(VALLEY_IR_SEED);
  const rngR = createSeededRng(VALLEY_IR_SEED ^ 0x5bd1e995);

  // 1. Warm early valley / woodland reflections (taps between 14ms and 92ms)
  const earlyTaps: ReadonlyArray<readonly [number, number, number]> = [
    [0.014, 0.34, 0.24],
    [0.023, 0.22, 0.33],
    [0.036, -0.26, 0.19],
    [0.051, 0.19, -0.25],
    [0.068, -0.17, -0.14],
    [0.089, 0.14, 0.16],
  ];

  for (const [delaySec, gainL, gainR] of earlyTaps) {
    const baseIdx = Math.floor(delaySec * sampleRate);
    // Softly smear each early reflection over ~4ms so it feels like foliage & canyon rock
    const smearLen = Math.max(8, Math.floor(sampleRate * 0.004));
    for (let s = 0; s < smearLen; s++) {
      const idx = baseIdx + s;
      if (idx >= length) break;
      const win = Math.sin((Math.PI * (s + 0.5)) / smearLen);
      const norm = (win * win) / (smearLen * 0.35);
      left[idx] = (left[idx] ?? 0) + gainL * norm;
      right[idx] = (right[idx] ?? 0) + gainR * norm;
    }
  }

  // 2. Smooth diffuse late tail with stereo decorrelation & progressive HF damping
  const fadeInSamples = Math.max(1, Math.floor(sampleRate * 0.028));
  let lpL = 0;
  let lpR = 0;
  let hpPrevL = 0;
  let hpOutL = 0;
  let hpPrevR = 0;
  let hpOutR = 0;
  let peak = 0;

  for (let i = 0; i < length; i++) {
    const tNorm = i / length;
    const fadeIn = i < fadeInSamples ? i / fadeInSamples : 1;

    // Dual-slope organic decay: warm mid-valley bloom + lingering distant air
    const env =
      fadeIn * (0.72 * Math.exp(-3.5 * tNorm) + 0.28 * Math.exp(-6.2 * tNorm));

    // Triangular-ish PDF noise (sum of 2 uniform samples) sounds silkier than raw white noise
    const nL = rngL() + rngL() - 1;
    const nR = rngR() + rngR() - 1;

    // Subtle stereo decorrelation: keep cohesive center weight while widening spatial air
    const mid = (nL + nR) * 0.5;
    const side = (nL - nR) * 0.5;
    const rawL = (mid * 0.58 + side * 0.72) * env;
    const rawR = (mid * 0.58 - side * 0.72) * env;

    // Progressive one-pole lowpass damping: air absorbs highs faster as tail decays
    const dampAlpha = 0.26 - 0.19 * tNorm;
    lpL += dampAlpha * (rawL - lpL);
    lpR += dampAlpha * (rawR - lpR);

    // Gentle DC / sub-rumble blocker (~35 Hz)
    const sampleL = (left[i] ?? 0) + lpL;
    const sampleR = (right[i] ?? 0) + lpR;
    hpOutL = 0.995 * (hpOutL + sampleL - hpPrevL);
    hpPrevL = sampleL;
    hpOutR = 0.995 * (hpOutR + sampleR - hpPrevR);
    hpPrevR = sampleR;

    left[i] = hpOutL;
    right[i] = hpOutR;

    const absL = Math.abs(hpOutL);
    const absR = Math.abs(hpOutR);
    if (absL > peak) peak = absL;
    if (absR > peak) peak = absR;
  }

  // Normalize peak to balanced studio headroom (0.65)
  if (peak > 0.0001) {
    const scale = 0.65 / peak;
    for (let i = 0; i < length; i++) {
      left[i] = (left[i] ?? 0) * scale;
      right[i] = (right[i] ?? 0) * scale;
    }
  }

  VALLEY_IR_CACHE.set(ctx, buffer);
  return buffer;
}

/**
 * Builds the Studio Spatial Audio Bus for Critter Siege's adaptive soundtrack:
 * - Procedural stereo 2.1s valley convolution reverb (with clean fallback if unavailable)
 * - Optional stereo ping-pong dotted-feel delay (0.34s L / 0.51s R, 2200 Hz feedback damping)
 * - Warm tone filter, ducking stage, and independent music vs. ambience mute routing
 * - Optional warm glue DynamicsCompressor ahead of destination
 */
export function createStudioAudioBus(
  ctx: AudioContext,
  destination?: AudioNode | null,
): StudioAudioBus {
  const optionalCtx = ctx as Partial<AudioContext>;
  const targetOut = destination ?? ctx.destination;
  const ownedNodes: AudioNode[] = [];

  const track = <T extends AudioNode>(node: T): T => {
    ownedNodes.push(node);
    return node;
  };

  // Core required bus nodes
  const musicDryIn = track(ctx.createGain());
  setParamValue(musicDryIn.gain, 1.0);

  const reverbSend = track(ctx.createGain());
  setParamValue(reverbSend.gain, 1.0);

  const delaySend = track(ctx.createGain());
  setParamValue(delaySend.gain, 1.0);

  const ambienceIn = track(ctx.createGain());
  setParamValue(ambienceIn.gain, 1.0);

  const reverbWetGain = track(ctx.createGain());
  setParamValue(reverbWetGain.gain, DEFAULT_REVERB_WET);

  const musicToneFilter = track(ctx.createBiquadFilter());
  musicToneFilter.type = "lowpass";
  setParamValue(musicToneFilter.frequency, DEFAULT_FILTER_HZ);
  setParamValue(musicToneFilter.Q, 0.65);

  const duckGain = track(ctx.createGain());
  setParamValue(duckGain.gain, 1.0);

  const musicMuteGain = track(ctx.createGain());
  setParamValue(musicMuteGain.gain, BASE_MUSIC_GAIN);

  const ambienceMuteGain = track(ctx.createGain());
  setParamValue(ambienceMuteGain.gain, AMBIENCE_UNMUTED_GAIN);

  // 1. Dry music -> tone filter -> duck -> music mute
  musicDryIn.connect(musicToneFilter);
  musicToneFilter.connect(duckGain);
  duckGain.connect(musicMuteGain);

  // 2. Ambience -> ambience mute (independent of music mute)
  ambienceIn.connect(ambienceMuteGain);

  // 3. Optional Stereo Convolution Reverb (2.1s valley IR)
  let hasConvolver = false;
  let reverbPreInput: AudioNode | null = null;
  if (typeof optionalCtx.createConvolver === "function") {
    const ir = getOrCreateValleyImpulseResponse(ctx);
    if (ir) {
      try {
        const preHp = track(ctx.createBiquadFilter());
        preHp.type = "highpass";
        setParamValue(preHp.frequency, 145);
        setParamValue(preHp.Q, 0.7);

        const convolver = track(optionalCtx.createConvolver());
        convolver.normalize = true;
        convolver.buffer = ir;

        const dampLp = track(ctx.createBiquadFilter());
        dampLp.type = "lowpass";
        setParamValue(dampLp.frequency, 4800);
        setParamValue(dampLp.Q, 0.65);

        reverbSend.connect(preHp);
        preHp.connect(convolver);
        convolver.connect(dampLp);
        dampLp.connect(reverbWetGain);
        reverbWetGain.connect(musicToneFilter);

        reverbPreInput = preHp;
        hasConvolver = true;
      } catch {
        hasConvolver = false;
      }
    }
  }

  if (!hasConvolver) {
    const fallbackTrim = track(ctx.createGain());
    setParamValue(fallbackTrim.gain, 0.22);
    reverbSend.connect(fallbackTrim);
    fallbackTrim.connect(reverbWetGain);
    reverbWetGain.connect(musicToneFilter);
  }

  // 4. Optional Stereo Ping-Pong Valley Delay (0.34s L / 0.51s R)
  let hasDelay = false;
  if (typeof optionalCtx.createDelay === "function") {
    try {
      const delayInFilter = track(ctx.createBiquadFilter());
      delayInFilter.type = "lowpass";
      setParamValue(delayInFilter.frequency, 2600);
      setParamValue(delayInFilter.Q, 0.7);

      const delayLeft = track(optionalCtx.createDelay(1.5));
      setParamValue(delayLeft.delayTime, 0.34);

      const delayRight = track(optionalCtx.createDelay(1.5));
      setParamValue(delayRight.delayTime, 0.51);

      const fbFilterL = track(ctx.createBiquadFilter());
      fbFilterL.type = "lowpass";
      setParamValue(fbFilterL.frequency, 2200);
      setParamValue(fbFilterL.Q, 0.7);

      const fbFilterR = track(ctx.createBiquadFilter());
      fbFilterR.type = "lowpass";
      setParamValue(fbFilterR.frequency, 2200);
      setParamValue(fbFilterR.Q, 0.7);

      const fbGainL = track(ctx.createGain());
      setParamValue(fbGainL.gain, 0.28);

      const fbGainR = track(ctx.createGain());
      setParamValue(fbGainR.gain, 0.26);

      const delayReturnGain = track(ctx.createGain());
      setParamValue(delayReturnGain.gain, 0.34);

      delaySend.connect(delayInFilter);
      delayInFilter.connect(delayLeft);

      // Ping-pong cross-feedback L -> R -> L
      delayLeft.connect(fbFilterL);
      fbFilterL.connect(fbGainL);
      fbGainL.connect(delayRight);

      delayRight.connect(fbFilterR);
      fbFilterR.connect(fbGainR);
      fbGainR.connect(delayLeft);

      if (typeof optionalCtx.createStereoPanner === "function") {
        const panL = track(optionalCtx.createStereoPanner());
        setParamValue(panL.pan, -0.55);
        const panR = track(optionalCtx.createStereoPanner());
        setParamValue(panR.pan, 0.55);

        delayLeft.connect(panL);
        panL.connect(delayReturnGain);
        delayRight.connect(panR);
        panR.connect(delayReturnGain);
      } else {
        delayLeft.connect(delayReturnGain);
        delayRight.connect(delayReturnGain);
      }

      delayReturnGain.connect(musicToneFilter);

      // Gentle acyclic tap from delay return into reverb valley tail
      if (reverbPreInput) {
        const delayToReverb = track(ctx.createGain());
        setParamValue(delayToReverb.gain, 0.18);
        delayReturnGain.connect(delayToReverb);
        delayToReverb.connect(reverbPreInput);
      }

      hasDelay = true;
    } catch {
      hasDelay = false;
    }
  }

  if (!hasDelay) {
    const delayFallbackTrim = track(ctx.createGain());
    setParamValue(delayFallbackTrim.gain, 0.14);
    delaySend.connect(delayFallbackTrim);
    delayFallbackTrim.connect(musicToneFilter);
  }

  // 5. Optional Warm Glue Dynamics Compressor ahead of destination
  let hasCompressor = false;
  let outputStage: AudioNode = targetOut;
  if (typeof optionalCtx.createDynamicsCompressor === "function") {
    try {
      const compressor = track(optionalCtx.createDynamicsCompressor());
      setParamValue(compressor.threshold, -14);
      setParamValue(compressor.knee, 18);
      setParamValue(compressor.ratio, 3.2);
      setParamValue(compressor.attack, 0.014);
      setParamValue(compressor.release, 0.22);
      compressor.connect(targetOut);
      outputStage = compressor;
      hasCompressor = true;
    } catch {
      hasCompressor = false;
      outputStage = targetOut;
    }
  }

  musicMuteGain.connect(outputStage);
  ambienceMuteGain.connect(outputStage);

  let musicMuted = false;
  let masterMuted = false;
  let disposed = false;

  const applyMuteState = (): void => {
    if (disposed) {
      return;
    }
    const now = getSafeCurrentTime(ctx);
    const targetMusic = masterMuted || musicMuted ? 0 : BASE_MUSIC_GAIN;
    const targetAmbience = masterMuted
      ? 0
      : musicMuted
        ? AMBIENCE_MUSIC_MUTED_GAIN
        : AMBIENCE_UNMUTED_GAIN;

    setParamSmooth(musicMuteGain.gain, targetMusic, now, 0.035);
    setParamSmooth(ambienceMuteGain.gain, targetAmbience, now, 0.055);
  };

  return {
    ctx,
    musicDryIn,
    reverbSend,
    delaySend,
    ambienceIn,
    duckGain,
    musicMuteGain,
    ambienceMuteGain,
    musicToneFilter,
    hasConvolver,
    hasDelay,
    hasCompressor,

    setMusicMuted(muted: boolean): void {
      if (disposed) {
        return;
      }
      musicMuted = muted;
      applyMuteState();
    },

    setMasterMuted(muted: boolean): void {
      if (disposed) {
        return;
      }
      masterMuted = muted;
      applyMuteState();
    },

    setFilterCutoff(hz: number, timeConstantSec = 0.14): void {
      if (disposed) {
        return;
      }
      const safeHz = safeClamp(hz, 120, 18000, DEFAULT_FILTER_HZ);
      const safeTc = safeClamp(timeConstantSec, 0.005, 3.0, 0.14);
      setParamSmooth(
        musicToneFilter.frequency,
        safeHz,
        getSafeCurrentTime(ctx),
        safeTc,
      );
    },

    setReverbWet(wet: number, timeConstantSec = 0.18): void {
      if (disposed) {
        return;
      }
      const safeWet = safeClamp(wet, 0, 1, DEFAULT_REVERB_WET);
      const safeTc = safeClamp(timeConstantSec, 0.005, 3.0, 0.18);
      setParamSmooth(
        reverbWetGain.gain,
        safeWet,
        getSafeCurrentTime(ctx),
        safeTc,
      );
    },

    duck(depth = 0.32, durationSec = 0.55): void {
      if (disposed) {
        return;
      }
      const safeDepth = safeClamp(depth, 0.05, 0.85, 0.32);
      const safeDuration = safeClamp(durationSec, 0.08, 3.0, 0.55);
      const now = getSafeCurrentTime(ctx);
      const duckedLevel = clamp(1 - safeDepth, 0.12, 0.95);

      try {
        if (typeof duckGain.gain.cancelScheduledValues === "function") {
          duckGain.gain.cancelScheduledValues(now);
        }
      } catch {
        // Ignore mock cancelScheduledValues edge errors
      }
      setParamSmooth(duckGain.gain, duckedLevel, now, 0.018);
      setParamSmooth(duckGain.gain, 1.0, now + 0.05, safeDuration * 0.42);
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const node of ownedNodes) {
        try {
          node.disconnect();
        } catch {
          // Ignore disconnect errors during teardown
        }
      }
      ownedNodes.length = 0;
    },
  };
}
