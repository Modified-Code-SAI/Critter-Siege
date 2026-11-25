import type { GadgetId } from "@critter/shared";

interface WebkitAudioGlobal {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getAudioContextCtor(): (typeof AudioContext) | null {
  const scope = globalThis as unknown as WebkitAudioGlobal;
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Zero-asset procedural WebAudio synthesizer for Critter Siege sound effects.
 * Lazily initializes AudioContext on first playback and safely no-ops when
 * muted, disposed, or running headless without WebAudio support.
 */
export class SynthAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private disposed = false;

  /** Enable or disable audio output cleanly. */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(
        muted ? 0 : 0.45,
        this.ctx.currentTime,
        0.015,
      );
    }
  }

  /** Return whether audio output is currently muted. */
  public isMuted(): boolean {
    return this.muted;
  }

  /** Toggle mute state and return the new muted value. */
  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Rising charge whine tick while holding shot power. */
  public playChargeTick(power: number): void {
    const ready = this.ensureReady();
    if (!ready) return;
    const { ctx, master } = ready;

    const p = clamp(Number.isFinite(power) ? power : 0.5, 0, 1);
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    const baseFreq = 220 + p * 540;
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.12, now + 0.055);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.11 + p * 0.08, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    osc.stop(now + 0.065);
  }

  /** Weapon/gadget launch sound tailored to each Critter Siege gadget. */
  public playLaunch(gadgetId: GadgetId): void {
    const ready = this.ensureReady();
    if (!ready) return;
    const { ctx, master } = ready;
    const now = ctx.currentTime;

    if (gadgetId === "gale_mortar") {
      // Punchy low mortar thump + crisp air puff
      this.playTone(ctx, master, "sine", 165, 52, 0.22, 0.36, now);
      this.playFilteredNoise(ctx, master, "bandpass", 620, 180, 0.18, 0.22, 1.2, now);
      return;
    }

    if (gadgetId === "spore_burst") {
      // Bouncy organic spore pop
      this.playTone(ctx, master, "sine", 240, 560, 0.11, 0.25, now);
      this.playTone(ctx, master, "triangle", 480, 320, 0.09, 0.14, now + 0.06);
      return;
    }

    if (gadgetId === "quake_club") {
      // Heavy melee club crack & thud
      this.playTone(ctx, master, "triangle", 130, 44, 0.18, 0.38, now);
      this.playFilteredNoise(ctx, master, "bandpass", 1100, 380, 0.1, 0.26, 1.4, now);
      return;
    }

    if (gadgetId === "burrow_bore") {
      // Mechanical drill spin-up whir
      this.playTone(ctx, master, "sawtooth", 140, 310, 0.26, 0.16, now);
      this.playFilteredNoise(ctx, master, "bandpass", 900, 1600, 0.24, 0.14, 2.0, now);
      return;
    }

    if (gadgetId === "vine_grapple") {
      // Snappy upward vine zip
      this.playTone(ctx, master, "triangle", 320, 880, 0.14, 0.2, now);
      this.playFilteredNoise(ctx, master, "highpass", 1400, 2200, 0.1, 0.12, 0.9, now);
      return;
    }

    if (gadgetId === "seeker_firefly") {
      // Shimmering dual-oscillator firefly chirp
      this.playTone(ctx, master, "sine", 680, 1180, 0.12, 0.18, now);
      this.playTone(ctx, master, "sine", 920, 1460, 0.14, 0.14, now + 0.07);
      return;
    }

    // Bonus gadgets: gravity_mine, prism_wall, shock_magnet
    this.playTone(ctx, master, "sine", 420, 740, 0.18, 0.2, now);
    this.playTone(ctx, master, "triangle", 210, 380, 0.2, 0.14, now + 0.04);
  }

  /** Layered low-end explosion thump plus smooth crumbling rock debris noise. */
  public playExplosion(radius: number): void {
    const ready = this.ensureReady();
    if (!ready) return;
    const { ctx, master } = ready;
    const now = ctx.currentTime;

    const r = clamp(Number.isFinite(radius) ? radius : 2.0, 0.8, 5.0);
    const scale = clamp(r / 2.4, 0.55, 1.4);
    const duration = 0.34 * scale;

    // Sub-bass boom
    this.playTone(ctx, master, "sine", 115, 34, duration, 0.42 * scale, now);
    // Mid-low earthen punch
    this.playTone(ctx, master, "triangle", 210, 58, duration * 0.7, 0.2 * scale, now);
    // Crumbling rock & dust tail
    this.playFilteredNoise(
      ctx,
      master,
      "lowpass",
      1150,
      190,
      duration * 1.25,
      0.32 * scale,
      0.9,
      now,
    );
  }

  /** Water splash cascade with subtle bubble plop when a critter or shot hits the ocean. */
  public playSplash(): void {
    const ready = this.ensureReady();
    if (!ready) return;
    const { ctx, master } = ready;
    const now = ctx.currentTime;

    this.playFilteredNoise(ctx, master, "bandpass", 1500, 360, 0.36, 0.28, 1.1, now);
    this.playTone(ctx, master, "sine", 280, 540, 0.1, 0.16, now + 0.05);
    this.playTone(ctx, master, "sine", 360, 620, 0.09, 0.12, now + 0.13);
  }

  /** Bright ascending harmonic arpeggio chime on Evo Pod draft / mutation equip. */
  public playMutationChime(): void {
    const ready = this.ensureReady();
    if (!ready) return;
    const { ctx, master } = ready;
    const now = ctx.currentTime;

    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) {
      const freq = notes[i];
      if (freq === undefined) continue;
      const start = now + i * 0.065;
      this.playTone(ctx, master, "triangle", freq, freq * 1.005, 0.22, 0.18, start);
    }
  }

  /** Countdown turn timer tick (soft normally, sharper double-tone when urgent). */
  public playTurnTick(urgent: boolean): void {
    const ready = this.ensureReady();
    if (!ready) return;
    const { ctx, master } = ready;
    const now = ctx.currentTime;

    if (urgent) {
      this.playTone(ctx, master, "square", 880, 820, 0.055, 0.14, now);
      this.playTone(ctx, master, "square", 1046, 980, 0.055, 0.12, now + 0.075);
      return;
    }

    this.playTone(ctx, master, "sine", 540, 480, 0.045, 0.09, now);
  }

  /** Tactile soft UI button click. */
  public playUiClick(): void {
    const ready = this.ensureReady();
    if (!ready) return;
    const { ctx, master } = ready;
    const now = ctx.currentTime;

    this.playTone(ctx, master, "sine", 660, 880, 0.045, 0.11, now);
  }

  /** Release WebAudio resources and silence all future calls. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const ctx = this.ctx;
    this.ctx = null;
    this.masterGain = null;
    this.noiseBuffer = null;

    if (ctx && typeof ctx.close === "function") {
      try {
        void ctx.close().catch(() => undefined);
      } catch {
        // Safe cleanup in restricted environments
      }
    }
  }

  private ensureReady(): { ctx: AudioContext; master: GainNode } | null {
    if (this.disposed || this.muted) {
      return null;
    }
    if (!this.ctx) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) {
        return null;
      }
      try {
        const ctx = new Ctor();
        const master = ctx.createGain();
        master.gain.value = 0.45;
        master.connect(ctx.destination);
        this.ctx = ctx;
        this.masterGain = master;
      } catch {
        return null;
      }
    }

    if (!this.ctx || !this.masterGain) {
      return null;
    }

    if (this.ctx.state === "suspended" && typeof this.ctx.resume === "function") {
      try {
        void this.ctx.resume().catch(() => undefined);
      } catch {
        // Ignore resume rejection prior to gesture
      }
    }

    return { ctx: this.ctx, master: this.masterGain };
  }

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === ctx.sampleRate) {
      return this.noiseBuffer;
    }
    try {
      const length = Math.max(1, Math.floor(ctx.sampleRate * 0.6));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      // Deterministic lightweight LCG noise so buffer creation stays fast & self-contained
      let seed = 0x51a9c3;
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

  private playTone(
    ctx: AudioContext,
    master: GainNode,
    type: OscillatorType,
    startFreq: number,
    endFreq: number,
    durationSec: number,
    peakGain: number,
    startTime: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, startFreq), startTime);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(20, endFreq),
      startTime + Math.max(0.01, durationSec),
    );

    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.linearRampToValueAtTime(
      clamp(peakGain, 0.005, 0.8),
      startTime + Math.min(0.015, durationSec * 0.25),
    );
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      startTime + Math.max(0.015, durationSec),
    );

    osc.connect(gain);
    gain.connect(master);
    osc.start(startTime);
    osc.stop(startTime + durationSec + 0.01);
  }

  private playFilteredNoise(
    ctx: AudioContext,
    master: GainNode,
    filterType: BiquadFilterType,
    startFreq: number,
    endFreq: number,
    durationSec: number,
    peakGain: number,
    q: number,
    startTime: number,
  ): void {
    const buffer = this.getNoiseBuffer(ctx);
    if (!buffer) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(40, startFreq), startTime);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(40, endFreq),
      startTime + Math.max(0.02, durationSec),
    );

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.linearRampToValueAtTime(
      clamp(peakGain, 0.005, 0.8),
      startTime + Math.min(0.018, durationSec * 0.2),
    );
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      startTime + Math.max(0.02, durationSec),
    );

    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(startTime);
    src.stop(startTime + durationSec + 0.01);
  }
}
