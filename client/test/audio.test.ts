import type { ThemeId } from "@critter/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MusicEngine,
  type MusicMood,
  type MusicStingerKind,
} from "../src/audio/musicEngine.js";
import {
  SynthAudio,
  type MusicGameplayContext,
} from "../src/audio/synthAudio.js";

interface MockAudioParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

interface MockGainNode {
  gain: MockAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockFilterNode {
  type: BiquadFilterType;
  frequency: MockAudioParam;
  Q: MockAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockOscillatorNode {
  type: OscillatorType;
  frequency: MockAudioParam;
  detune: MockAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface MockBufferSourceNode {
  buffer: AudioBuffer | null;
  loop: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface MockConvolverNode {
  buffer: AudioBuffer | null;
  normalize: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockDelayNode {
  delayTime: MockAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockStereoPannerNode {
  pan: MockAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockCompressorNode {
  threshold: MockAudioParam;
  knee: MockAudioParam;
  ratio: MockAudioParam;
  attack: MockAudioParam;
  release: MockAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockAudioContextHarness {
  ctx: AudioContext;
  gains: MockGainNode[];
  filters: MockFilterNode[];
  oscillators: MockOscillatorNode[];
  bufferSources: MockBufferSourceNode[];
  convolvers: MockConvolverNode[];
  delays: MockDelayNode[];
  panners: MockStereoPannerNode[];
  compressors: MockCompressorNode[];
  recordedParamNumbers: number[];
  closeSpy: ReturnType<typeof vi.fn>;
  advanceTime: (deltaSec: number) => void;
}

function createMockParam(
  initial: number,
  recordedParamNumbers: number[],
): MockAudioParam {
  const record = (...nums: number[]): void => {
    for (const n of nums) {
      recordedParamNumbers.push(n);
    }
  };
  const param: MockAudioParam = {
    value: initial,
    setValueAtTime: vi.fn((val: number, time: number) => {
      record(val, time);
      param.value = val;
    }),
    linearRampToValueAtTime: vi.fn((val: number, time: number) => {
      record(val, time);
      param.value = val;
    }),
    exponentialRampToValueAtTime: vi.fn((val: number, time: number) => {
      record(val, time);
      param.value = val;
    }),
    setTargetAtTime: vi.fn((val: number, time: number, tc: number) => {
      record(val, time, tc);
      param.value = val;
    }),
    cancelScheduledValues: vi.fn((time: number) => {
      record(time);
    }),
  };
  return param;
}

function createMockAudioContext(options?: {
  minimal?: boolean;
}): MockAudioContextHarness {
  const minimal = options?.minimal ?? false;
  let currentTime = 1.0;
  const gains: MockGainNode[] = [];
  const filters: MockFilterNode[] = [];
  const oscillators: MockOscillatorNode[] = [];
  const bufferSources: MockBufferSourceNode[] = [];
  const convolvers: MockConvolverNode[] = [];
  const delays: MockDelayNode[] = [];
  const panners: MockStereoPannerNode[] = [];
  const compressors: MockCompressorNode[] = [];
  const recordedParamNumbers: number[] = [];
  const closeSpy = vi.fn(() => Promise.resolve());

  const baseMock: Record<string, unknown> = {
    get currentTime(): number {
      return currentTime;
    },
    sampleRate: 44100,
    state: "running" as AudioContextState,
    destination: { connect: vi.fn(), disconnect: vi.fn() },
    resume: vi.fn(() => Promise.resolve()),
    close: closeSpy,
    createGain: vi.fn(() => {
      const node: MockGainNode = {
        gain: createMockParam(1, recordedParamNumbers),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(node);
      return node;
    }),
    createBiquadFilter: vi.fn(() => {
      const node: MockFilterNode = {
        type: "lowpass",
        frequency: createMockParam(12000, recordedParamNumbers),
        Q: createMockParam(1, recordedParamNumbers),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      filters.push(node);
      return node;
    }),
    createOscillator: vi.fn(() => {
      const node: MockOscillatorNode = {
        type: "sine",
        frequency: createMockParam(440, recordedParamNumbers),
        detune: createMockParam(0, recordedParamNumbers),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(node);
      return node;
    }),
    createBuffer: vi.fn(
      (numberOfChannels: number, length: number, sampleRate: number) => {
        const channels: Float32Array[] = [];
        for (let c = 0; c < numberOfChannels; c++) {
          channels.push(new Float32Array(length));
        }
        return {
          sampleRate,
          length,
          numberOfChannels,
          duration: length / sampleRate,
          getChannelData: (idx: number) =>
            channels[idx] ?? channels[0] ?? new Float32Array(length),
        };
      },
    ),
    createBufferSource: vi.fn((): MockBufferSourceNode => {
      const node: MockBufferSourceNode = {
        buffer: null,
        loop: false,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      bufferSources.push(node);
      return node;
    }),
  };

  if (!minimal) {
    baseMock.createConvolver = vi.fn(() => {
      const node: MockConvolverNode = {
        buffer: null,
        normalize: true,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      convolvers.push(node);
      return node;
    });
    baseMock.createDelay = vi.fn(() => {
      const node: MockDelayNode = {
        delayTime: createMockParam(0.3, recordedParamNumbers),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      delays.push(node);
      return node;
    });
    baseMock.createStereoPanner = vi.fn(() => {
      const node: MockStereoPannerNode = {
        pan: createMockParam(0, recordedParamNumbers),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      panners.push(node);
      return node;
    });
    baseMock.createDynamicsCompressor = vi.fn(() => {
      const node: MockCompressorNode = {
        threshold: createMockParam(-14, recordedParamNumbers),
        knee: createMockParam(18, recordedParamNumbers),
        ratio: createMockParam(3.2, recordedParamNumbers),
        attack: createMockParam(0.014, recordedParamNumbers),
        release: createMockParam(0.22, recordedParamNumbers),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      compressors.push(node);
      return node;
    });
  }

  return {
    ctx: baseMock as unknown as AudioContext,
    gains,
    filters,
    oscillators,
    bufferSources,
    convolvers,
    delays,
    panners,
    compressors,
    recordedParamNumbers,
    closeSpy,
    advanceTime: (deltaSec: number) => {
      currentTime += deltaSec;
    },
  };
}

function stubGlobalAudioContext(ctx: AudioContext): void {
  const MockAudioContext = function MockAudioContext(): AudioContext {
    return ctx;
  };
  vi.stubGlobal("AudioContext", MockAudioContext);
}

describe("MusicEngine & SynthAudio atmospheric adaptive soundtrack and SFX", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("supports all 7 moods with grounded BPMs, all 4 biome themes, stingers, and safe headless Node execution", () => {
    const engine = new MusicEngine();

    const expectedMoods: ReadonlyArray<readonly [MusicMood, number]> = [
      ["lobby", 74],
      ["battle", 86],
      ["intense", 102],
      ["shop", 72],
      ["flood", 114],
      ["victory", 80],
      ["defeat", 68],
    ];

    expect(engine.getMood()).toBe("lobby");
    expect(engine.getBpm()).toBe(74);
    expect(engine.getTargetBpm()).toBe(74);

    for (const [mood, bpm] of expectedMoods) {
      engine.setMood(mood);
      expect(engine.getMood()).toBe(mood);
      expect(engine.getBpm()).toBe(bpm);
      expect(engine.getTargetBpm()).toBe(bpm);
    }

    const themes: readonly ThemeId[] = [
      "emerald_spire",
      "canyon_arch",
      "twin_pillars",
      "mountain_spine",
    ];
    for (const theme of themes) {
      engine.setTheme(theme);
      expect(engine.getContext().theme).toBe(theme);
    }

    // Independent music mute vs master mute state
    expect(engine.isMusicMuted()).toBe(false);
    expect(engine.toggleMusicMute()).toBe(true);
    expect(engine.isMusicMuted()).toBe(true);
    engine.setMasterMuted(true);
    expect(engine.isMusicMuted()).toBe(true);
    engine.setMusicMuted(false);
    expect(engine.isMusicMuted()).toBe(false);
    engine.setMasterMuted(false);

    // Safe headless start, context updates, ducking, all 5 stingers, stop, and dispose
    const stingers: readonly MusicStingerKind[] = [
      "ko",
      "round_end",
      "flood_alarm",
      "purchase",
      "evolution",
    ];
    expect(() => {
      engine.start();
      engine.setContext({
        mood: "battle",
        theme: "canyon_arch",
        isCharging: true,
        chargePower: 0.85,
        isShotFlight: true,
        isDroneView: true,
        windSpeed: 14,
      });
      engine.duck(0.35, 0.5);
      for (const kind of stingers) {
        engine.playStinger(kind);
      }
      engine.playStinger("evolution", true);
      engine.stop();
      engine.dispose();
      // Subsequent calls after dispose must safely no-op
      engine.start();
      engine.setMood("flood");
      engine.setTheme("mountain_spine");
      engine.setContext({ isCharging: true });
      engine.duck(0.4, 0.3);
      engine.playStinger("ko");
    }).not.toThrow();
  });

  it("conducts vertical stems, smooth tempo glide, shop filter veil, micro-moments, and key-aware stingers on full AudioContext", () => {
    vi.useFakeTimers();
    const harness = createMockAudioContext({ minimal: false });
    const customOutput = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
    const engine = new MusicEngine(
      () => harness.ctx,
      () => customOutput,
    );

    engine.start();
    expect(vi.getTimerCount()).toBe(1);
    expect(harness.convolvers.length).toBe(1);
    expect(harness.delays.length).toBe(2);
    expect(harness.compressors.length).toBe(1);
    expect(harness.compressors[0]?.connect).toHaveBeenCalledWith(customOutput);

    // Core StudioAudioBus node indices (created deterministically at bus init)
    const reverbWetGain = harness.gains[4];
    const duckGain = harness.gains[5];
    const musicToneFilter = harness.filters[0];
    expect(reverbWetGain).toBeDefined();
    expect(duckGain).toBeDefined();
    expect(musicToneFilter).toBeDefined();

    // Shop mood lowers filter veil to <= 1450 Hz (1350 Hz)
    engine.setMood("shop");
    expect(musicToneFilter?.frequency.value).toBeLessThanOrEqual(1450);

    // Battle opens tone filter cleanly
    engine.setMood("battle");
    const battleFilterHz = musicToneFilter?.frequency.value ?? 0;
    expect(battleFilterHz).toBeGreaterThan(10000);

    // Enemy turn subtly softens cutoff vs player turn
    engine.setContext({ isMyTurn: false });
    expect(musicToneFilter?.frequency.value ?? 0).toBeLessThan(battleFilterHz);
    engine.setContext({ isMyTurn: true });

    // Smooth tempo glide while running: battle (86) -> intense (102)
    // First settle current BPM to battle target (86)
    for (let i = 0; i < 45; i++) {
      harness.advanceTime(0.12);
      vi.advanceTimersByTime(25);
    }
    expect(engine.getBpm()).toBeCloseTo(86, 1);

    engine.setMood("intense");
    expect(engine.getTargetBpm()).toBe(102);
    // Does not snap abruptly before scheduler ticks
    expect(engine.getBpm()).toBeCloseTo(86, 1);

    // After a couple steps, tempo is partway through the smooth glide
    harness.advanceTime(0.24);
    vi.advanceTimersByTime(25);
    expect(engine.getBpm()).toBeGreaterThan(86.5);
    expect(engine.getBpm()).toBeLessThan(101.5);

    // Over subsequent steps, tempo glides and snaps cleanly to 102 BPM
    for (let i = 0; i < 50; i++) {
      harness.advanceTime(0.14);
      vi.advanceTimersByTime(25);
    }
    expect(engine.getBpm()).toBe(102);

    // Micro-moment telemetry: Shot Cam breath & Tactical Drone Recon expand reverb space
    const baseReverbWet = reverbWetGain?.gain.value ?? 0;
    engine.setContext({ isShotFlight: true });
    expect(reverbWetGain?.gain.value ?? 0).toBeGreaterThan(baseReverbWet + 0.08);
    engine.setContext({ isShotFlight: false, isDroneView: true });
    expect(reverbWetGain?.gain.value ?? 0).toBeGreaterThan(baseReverbWet + 0.05);
    engine.setContext({ isDroneView: false });

    // Micro-moment telemetry: charging above 50% triggers charge shimmer voices
    const oscBeforeCharge = harness.oscillators.length;
    engine.setContext({
      mood: "battle",
      isCharging: true,
      chargePower: 0.9,
    });
    for (let i = 0; i < 6; i++) {
      harness.advanceTime(0.18);
      vi.advanceTimersByTime(25);
    }
    expect(harness.oscillators.length).toBeGreaterThan(oscBeforeCharge + 4);
    engine.setContext({ isCharging: false, chargePower: 0 });

    // Immediate transitions across all biomes & dramatic moods synthesize voices cleanly
    const themes: readonly ThemeId[] = [
      "emerald_spire",
      "canyon_arch",
      "twin_pillars",
      "mountain_spine",
    ];
    for (const theme of themes) {
      engine.setMood("lobby");
      engine.setTheme(theme);
      harness.advanceTime(0.2);
      vi.advanceTimersByTime(25);
    }
    for (const mood of ["flood", "victory", "defeat"] as const) {
      engine.setMood(mood);
      harness.advanceTime(0.22);
      vi.advanceTimersByTime(25);
    }

    // Ducking smoothly dips duckGain and schedules recovery to 1.0
    engine.duck(0.35, 0.55);
    expect(duckGain?.gain.setTargetAtTime).toHaveBeenCalledWith(
      expect.closeTo(0.65, 2),
      expect.any(Number),
      expect.any(Number),
    );
    expect(duckGain?.gain.setTargetAtTime).toHaveBeenCalledWith(
      1.0,
      expect.any(Number),
      expect.any(Number),
    );

    // All 5 key-aware stingers synthesize cleanly, with apexBonus adding extra overtone halo
    const oscBeforeStingers = harness.oscillators.length;
    engine.playStinger("ko");
    engine.playStinger("round_end");
    engine.playStinger("flood_alarm");
    engine.playStinger("purchase");
    const oscAfterBase4 = harness.oscillators.length;
    expect(oscAfterBase4).toBeGreaterThan(oscBeforeStingers + 8);

    const beforeEvoBase = harness.oscillators.length;
    engine.playStinger("evolution", false);
    const evoBaseDelta = harness.oscillators.length - beforeEvoBase;

    const beforeEvoApex = harness.oscillators.length;
    engine.playStinger("evolution", true);
    const evoApexDelta = harness.oscillators.length - beforeEvoApex;
    expect(evoApexDelta).toBeGreaterThan(evoBaseDelta);

    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.closeSpy).not.toHaveBeenCalled();
  });

  it("works cleanly on a minimal mock AudioContext lacking convolver, delay, panner, and compressor (Review Focus #1)", () => {
    vi.useFakeTimers();
    const minimal = createMockAudioContext({ minimal: true });
    const engine = new MusicEngine(() => minimal.ctx);

    expect(() => {
      engine.start();
      engine.setContext({
        mood: "battle",
        theme: "twin_pillars",
        isCharging: true,
        chargePower: 0.85,
        windSpeed: 10,
      });
      for (let i = 0; i < 8; i++) {
        minimal.advanceTime(0.16);
        vi.advanceTimersByTime(25);
      }
      engine.setMood("shop");
      engine.setMood("flood");
      engine.playStinger("flood_alarm");
      engine.playStinger("evolution", true);
      engine.duck(0.3, 0.4);
      engine.dispose();
    }).not.toThrow();

    expect(minimal.convolvers.length).toBe(0);
    expect(minimal.delays.length).toBe(0);
    expect(minimal.panners.length).toBe(0);
    expect(minimal.compressors.length).toBe(0);
    expect(minimal.oscillators.length).toBeGreaterThan(6);
    expect(minimal.bufferSources.length).toBeGreaterThanOrEqual(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(minimal.closeSpy).not.toHaveBeenCalled();
  });

  it("keeps island ambience alive on Music Mute (N), zeroes both on Master Mute (M), and tears down cleanly on dispose (Review Focus #3)", () => {
    vi.useFakeTimers();
    const harness = createMockAudioContext({ minimal: false });
    const engine = new MusicEngine(() => harness.ctx);

    // Even when starting with music already muted (N), ambience must attach and run
    engine.setMusicMuted(true);
    engine.start();

    const musicMuteGain = harness.gains[6];
    const ambienceMuteGain = harness.gains[7];
    expect(musicMuteGain).toBeDefined();
    expect(ambienceMuteGain).toBeDefined();

    // Music muted -> musicMuteGain = 0, ambienceMuteGain > 0, and ambience loop sources started
    expect(musicMuteGain?.gain.value).toBe(0);
    expect(ambienceMuteGain?.gain.value ?? 0).toBeGreaterThan(0);
    const ambienceSources = harness.bufferSources.filter((src) => src.loop);
    expect(ambienceSources.length).toBe(3);

    // Master mute (M) drives BOTH music and ambience to 0
    engine.setMasterMuted(true);
    expect(musicMuteGain?.gain.value).toBe(0);
    expect(ambienceMuteGain?.gain.value).toBe(0);

    // Unmuting master while musicMute stays true restores ambience while music stays 0
    engine.setMasterMuted(false);
    expect(musicMuteGain?.gain.value).toBe(0);
    expect(ambienceMuteGain?.gain.value ?? 0).toBeGreaterThan(0);

    // Unmuting music restores music gain too
    engine.setMusicMuted(false);
    expect(musicMuteGain?.gain.value ?? 0).toBeGreaterThan(0);
    expect(ambienceMuteGain?.gain.value ?? 0).toBeGreaterThan(0);

    // Dispose clears timer, stops ambience sources, disconnects bus, and never closes external AudioContext
    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
    for (const src of ambienceSources) {
      expect(src.stop).toHaveBeenCalled();
    }
    expect(musicMuteGain?.disconnect).toHaveBeenCalled();
    expect(ambienceMuteGain?.disconnect).toHaveBeenCalled();
    expect(harness.closeSpy).not.toHaveBeenCalled();
  });

  it("clamps non-finite telemetry safely and recovers from +60s background tab sleep without hanging (Review Focus #5)", () => {
    vi.useFakeTimers();
    const harness = createMockAudioContext({ minimal: false });
    const engine = new MusicEngine(() => harness.ctx);

    engine.start();

    // Feed non-finite telemetry and duck arguments
    expect(() => {
      engine.setContext({
        mood: "battle",
        round: Number.NaN,
        maxRounds: Number.POSITIVE_INFINITY,
        chargePower: Number.NaN,
        hpRatio: Number.NEGATIVE_INFINITY,
        windSpeed: Number.POSITIVE_INFINITY,
        waterLevel: Number.NaN,
        floodIntensity: Number.POSITIVE_INFINITY,
        isCharging: true,
      });
      engine.duck(Number.NaN, Number.POSITIVE_INFINITY);
    }).not.toThrow();

    const sanitized = engine.getContext();
    expect(Number.isFinite(sanitized.round)).toBe(true);
    expect(Number.isFinite(sanitized.maxRounds)).toBe(true);
    expect(Number.isFinite(sanitized.chargePower)).toBe(true);
    expect(Number.isFinite(sanitized.hpRatio)).toBe(true);
    expect(Number.isFinite(sanitized.windSpeed)).toBe(true);
    expect(Number.isFinite(sanitized.waterLevel)).toBe(true);
    expect(Number.isFinite(sanitized.floodIntensity)).toBe(true);
    expect(Number.isFinite(engine.getBpm())).toBe(true);

    // Run a couple normal ticks first
    harness.advanceTime(0.15);
    vi.advanceTimersByTime(25);

    // Simulate a +60 second background-tab clock jump in a single tick
    const oscBeforeWakeup = harness.oscillators.length;
    harness.advanceTime(60.0);
    vi.advanceTimersByTime(25);
    const oscAfterWakeup = harness.oscillators.length;

    // Must recover smoothly instead of catch-up bursting hundreds of steps
    expect(oscAfterWakeup - oscBeforeWakeup).toBeLessThan(60);

    // Subsequent normal ticks continue scheduling smoothly
    harness.advanceTime(0.2);
    vi.advanceTimersByTime(25);
    expect(harness.oscillators.length).toBeGreaterThanOrEqual(oscAfterWakeup);

    // Every AudioParam number ever passed across the entire run must be strictly finite
    expect(harness.recordedParamNumbers.length).toBeGreaterThan(0);
    for (const num of harness.recordedParamNumbers) {
      expect(Number.isFinite(num)).toBe(true);
    }

    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("integrates MusicEngine into SynthAudio with independent music mute, SFX methods, and clean dispose", () => {
    const audio = new SynthAudio();

    expect(audio.isMuted()).toBe(false);
    expect(audio.isMusicMuted()).toBe(false);
    expect(audio.getMusicMood()).toBe("lobby");

    // Music mute toggles independently from SFX master mute
    expect(audio.toggleMusicMute()).toBe(true);
    expect(audio.isMusicMuted()).toBe(true);
    expect(audio.isMuted()).toBe(false);

    expect(audio.toggleMute()).toBe(true);
    expect(audio.isMuted()).toBe(true);
    expect(audio.isMusicMuted()).toBe(true);

    audio.setMuted(false);
    expect(audio.isMuted()).toBe(false);
    expect(audio.isMusicMuted()).toBe(true);

    audio.setMusicMuted(false);
    expect(audio.isMusicMuted()).toBe(false);

    expect(() => {
      audio.unlockAndStartMusic();
      audio.setMusicMood("battle");
      expect(audio.getMusicMood()).toBe("battle");
      audio.setMusicMood("shop");
      expect(audio.getMusicMood()).toBe("shop");
      audio.setMusicMood("intense");
      expect(audio.getMusicMood()).toBe("intense");
      audio.setMusicMood("flood");
      expect(audio.getMusicMood()).toBe("flood");
      audio.setMusicMood("victory");
      expect(audio.getMusicMood()).toBe("victory");
      audio.setMusicMood("defeat");
      expect(audio.getMusicMood()).toBe("defeat");

      audio.duckMusic(0.35, 0.55);
      audio.playExplosion(3.2);
      audio.playCoinEarned();
      audio.playShopBuy();
      audio.playHealChime();
      audio.playFloodRumble();
      audio.playLaunch("mend_brew");
      audio.playStinger("ko");
      audio.playStinger("round_end");
      audio.playStinger("flood_alarm");
      audio.playStinger("purchase");
      audio.playStinger("evolution");
    }).not.toThrow();

    audio.dispose();
    expect(() => {
      audio.unlockAndStartMusic();
      audio.playCoinEarned();
      audio.playShopBuy();
      audio.playHealChime();
      audio.playFloodRumble();
      audio.playStinger("ko");
    }).not.toThrow();
  });

  it("forwards setMusicContext, setMusicTheme, and playStinger with apexBonus cleanly through SynthAudio", () => {
    vi.useFakeTimers();
    const harness = createMockAudioContext({ minimal: false });
    stubGlobalAudioContext(harness.ctx);
    const audio = new SynthAudio();

    audio.unlockAndStartMusic();

    const partialContext: Partial<MusicGameplayContext> = {
      mood: "battle",
      theme: "canyon_arch",
      round: 3,
      isShotFlight: true,
      windSpeed: 12,
    };
    audio.setMusicContext(partialContext);
    expect(audio.getMusicMood()).toBe("battle");

    audio.setMusicTheme("mountain_spine");
    // Reverb wet gain reflects Shot Cam expansion forwarded via setMusicContext
    const reverbWetGain = harness.gains[5];
    expect(reverbWetGain?.gain.value ?? 0).toBeGreaterThan(0.4);

    // playStinger forwards apexBonus cleanly to MusicEngine
    const oscBeforeBase = harness.oscillators.length;
    audio.playStinger("evolution", false);
    const baseOscCount = harness.oscillators.length - oscBeforeBase;

    const oscBeforeApex = harness.oscillators.length;
    audio.playStinger("evolution", true);
    const apexOscCount = harness.oscillators.length - oscBeforeApex;

    expect(baseOscCount).toBeGreaterThan(0);
    expect(apexOscCount).toBeGreaterThan(baseOscCount);

    audio.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plays only the tactile latch click in playShopBuy when music is active, and adds D-major triad only when music is muted (Review Focus #4)", () => {
    vi.useFakeTimers();
    const harness = createMockAudioContext({ minimal: false });
    stubGlobalAudioContext(harness.ctx);
    const audio = new SynthAudio();
    audio.unlockAndStartMusic();

    // Music unmuted: latch click ONLY (1 oscillator, 0 D-major triad oscillators)
    expect(audio.isMusicMuted()).toBe(false);
    const oscBeforeUnmutedBuy = harness.oscillators.length;
    audio.playShopBuy();
    expect(harness.oscillators.length - oscBeforeUnmutedBuy).toBe(1);

    // Music muted (master unmuted): latch click + fallback D-major triad (> 3 oscillators)
    audio.setMusicMuted(true);
    expect(audio.isMusicMuted()).toBe(true);
    expect(audio.isMuted()).toBe(false);
    const oscBeforeMutedBuy = harness.oscillators.length;
    audio.playShopBuy();
    expect(harness.oscillators.length - oscBeforeMutedBuy).toBeGreaterThan(3);

    audio.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("routes both SFX masterGain and MusicEngine output through a shared safety limiter when supported", () => {
    vi.useFakeTimers();
    const harness = createMockAudioContext({ minimal: false });
    stubGlobalAudioContext(harness.ctx);
    const audio = new SynthAudio();

    // Even when starting with music muted, unlockAndStartMusic starts ambience safely
    audio.setMusicMuted(true);
    audio.unlockAndStartMusic();

    // compressors[0] = SynthAudio sharedSafetyLimiter; compressors[1] = MusicEngine glue compressor
    expect(harness.compressors.length).toBe(2);
    const sharedLimiter = harness.compressors[0];
    const musicGlueCompressor = harness.compressors[1];
    const sfxMasterGain = harness.gains[0];

    expect(sharedLimiter).toBeDefined();
    expect(sharedLimiter?.threshold.value).toBe(-2);
    expect(sharedLimiter?.knee.value).toBe(6);
    expect(sharedLimiter?.ratio.value).toBe(10);
    expect(sharedLimiter?.attack.value).toBe(0.003);
    expect(sharedLimiter?.release.value).toBe(0.12);
    expect(sharedLimiter?.connect).toHaveBeenCalledWith(harness.ctx.destination);

    expect(sfxMasterGain?.connect).toHaveBeenCalledWith(sharedLimiter);
    expect(musicGlueCompressor?.connect).toHaveBeenCalledWith(sharedLimiter);

    // Ambience loop sources start even when musicMuted === true
    const ambienceSources = harness.bufferSources.filter((src) => src.loop);
    expect(ambienceSources.length).toBe(3);

    audio.dispose();
    expect(sfxMasterGain?.disconnect).toHaveBeenCalled();
    expect(sharedLimiter?.disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
