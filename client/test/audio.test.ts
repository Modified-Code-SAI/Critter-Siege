import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicEngine, type MusicMood } from "../src/audio/musicEngine.js";
import { SynthAudio } from "../src/audio/synthAudio.js";

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
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface MockBufferSourceNode {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface MockAudioContextHarness {
  ctx: AudioContext;
  gains: MockGainNode[];
  filters: MockFilterNode[];
  oscillators: MockOscillatorNode[];
  closeSpy: ReturnType<typeof vi.fn>;
  advanceTime: (deltaSec: number) => void;
}

function createMockParam(initial = 0): MockAudioParam {
  const param: MockAudioParam = {
    value: initial,
    setValueAtTime: vi.fn((val: number) => {
      param.value = val;
    }),
    linearRampToValueAtTime: vi.fn((val: number) => {
      param.value = val;
    }),
    exponentialRampToValueAtTime: vi.fn((val: number) => {
      param.value = val;
    }),
    setTargetAtTime: vi.fn((val: number) => {
      param.value = val;
    }),
    cancelScheduledValues: vi.fn(),
  };
  return param;
}

function createMockAudioContext(): MockAudioContextHarness {
  let currentTime = 1.0;
  const gains: MockGainNode[] = [];
  const filters: MockFilterNode[] = [];
  const oscillators: MockOscillatorNode[] = [];
  const closeSpy = vi.fn(() => Promise.resolve());

  const mock = {
    get currentTime(): number {
      return currentTime;
    },
    sampleRate: 44100,
    state: "running" as AudioContextState,
    destination: { connect: vi.fn() },
    resume: vi.fn(() => Promise.resolve()),
    close: closeSpy,
    createGain: vi.fn(() => {
      const node: MockGainNode = {
        gain: createMockParam(1),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(node);
      return node;
    }),
    createBiquadFilter: vi.fn(() => {
      const node: MockFilterNode = {
        type: "lowpass",
        frequency: createMockParam(12000),
        Q: createMockParam(1),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      filters.push(node);
      return node;
    }),
    createOscillator: vi.fn(() => {
      const node: MockOscillatorNode = {
        type: "sine",
        frequency: createMockParam(440),
        detune: createMockParam(0),
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(node);
      return node;
    }),
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return {
        sampleRate,
        length,
        getChannelData: () => data,
      };
    }),
    createBufferSource: vi.fn((): MockBufferSourceNode => ({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
  };

  return {
    ctx: mock as unknown as AudioContext,
    gains,
    filters,
    oscillators,
    closeSpy,
    advanceTime: (deltaSec: number) => {
      currentTime += deltaSec;
    },
  };
}

describe("MusicEngine & SynthAudio adaptive soundtrack and SFX", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("switches all 6 MusicEngine moods with exact BPMs, handles mute/duck/stingers, and disposes cleanly in headless Node", () => {
    const engine = new MusicEngine();

    const expectedMoods: ReadonlyArray<readonly [MusicMood, number]> = [
      ["lobby", 112],
      ["battle", 124],
      ["intense", 138],
      ["shop", 114],
      ["flood", 148],
      ["victory", 120],
    ];

    expect(engine.getMood()).toBe("lobby");
    expect(engine.getBpm()).toBe(112);

    for (const [mood, bpm] of expectedMoods) {
      engine.setMood(mood);
      expect(engine.getMood()).toBe(mood);
      expect(engine.getBpm()).toBe(bpm);
    }

    // Independent music mute vs master mute
    expect(engine.isMusicMuted()).toBe(false);
    expect(engine.toggleMusicMute()).toBe(true);
    expect(engine.isMusicMuted()).toBe(true);
    engine.setMasterMuted(true);
    expect(engine.isMusicMuted()).toBe(true);
    engine.setMusicMuted(false);
    expect(engine.isMusicMuted()).toBe(false);
    engine.setMasterMuted(false);

    // Safe headless start, ducking, stingers, stop, and dispose
    expect(() => {
      engine.start();
      engine.duck(0.35, 0.5);
      engine.playStinger("ko");
      engine.playStinger("round_end");
      engine.playStinger("flood_alarm");
      engine.playStinger("purchase");
      engine.stop();
      engine.dispose();
      // Subsequent calls after dispose must safely no-op
      engine.start();
      engine.duck(0.4, 0.3);
      engine.playStinger("ko");
    }).not.toThrow();
  });

  it("drives lookahead WebAudio scheduling, sweeps shop low-pass to 1150 Hz, ducks cleanly, and clears all timers on dispose", () => {
    vi.useFakeTimers();
    const harness = createMockAudioContext();
    const engine = new MusicEngine(() => harness.ctx);

    engine.start();
    expect(vi.getTimerCount()).toBe(1);

    // Music bus creates duckGain, musicGain, and lowpass musicFilter
    const duckGain = harness.gains[0];
    const musicGain = harness.gains[1];
    const musicFilter = harness.filters[0];
    expect(duckGain).toBeDefined();
    expect(musicGain).toBeDefined();
    expect(musicFilter).toBeDefined();

    // Mood sweep to shop lowers filter to 1150 Hz, then battle opens to 16000 Hz
    engine.setMood("shop");
    expect(musicFilter?.frequency.setTargetAtTime).toHaveBeenCalledWith(
      1150,
      expect.any(Number),
      expect.any(Number),
    );

    engine.setMood("battle");
    expect(musicFilter?.frequency.setTargetAtTime).toHaveBeenCalledWith(
      16000,
      expect.any(Number),
      expect.any(Number),
    );

    // Advance lookahead scheduler across multiple moods to verify procedural voice synthesis
    for (const mood of ["battle", "intense", "flood", "victory"] as const) {
      engine.setMood(mood);
      harness.advanceTime(0.12);
      vi.advanceTimersByTime(30);
    }
    expect(harness.oscillators.length).toBeGreaterThan(6);

    // Ducking reduces duckGain temporarily and schedules recovery
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

    // Stingers synthesize cleanly
    const oscBeforeStingers = harness.oscillators.length;
    engine.playStinger("ko");
    engine.playStinger("round_end");
    engine.playStinger("flood_alarm");
    engine.playStinger("purchase");
    expect(harness.oscillators.length).toBeGreaterThan(oscBeforeStingers);

    // Independent mute vs master mute updates musicGain cleanly
    engine.setMusicMuted(true);
    expect(musicGain?.gain.setTargetAtTime).toHaveBeenLastCalledWith(
      0,
      expect.any(Number),
      expect.any(Number),
    );
    engine.setMusicMuted(false);
    expect(musicGain?.gain.value).toBeGreaterThan(0);

    // Dispose clears interval cleanly and does NOT close shared external AudioContext
    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.closeSpy).not.toHaveBeenCalled();
  });

  it("integrates MusicEngine into SynthAudio with independent music mute, new SFX methods, and clean dispose", () => {
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
});
