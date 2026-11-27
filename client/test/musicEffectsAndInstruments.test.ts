import { describe, expect, it, vi } from "vitest";
import {
  createStudioAudioBus,
  type StudioAudioBus,
} from "../src/audio/musicEffects.js";
import { AcousticVoiceBank } from "../src/audio/musicInstruments.js";
import { getChordForBar, midiToFreq } from "../src/audio/musicTheory.js";
import type { ChordVoicing, MusicStingerKind } from "../src/audio/musicTypes.js";

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

interface MockBufferData {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  channels: Float32Array[];
  getChannelData: (channel: number) => Float32Array;
}

interface MockBufferSourceNode {
  buffer: AudioBuffer | null;
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

interface MockDynamicsCompressorNode {
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
  buffers: MockBufferData[];
  bufferSources: MockBufferSourceNode[];
  convolvers: MockConvolverNode[];
  delays: MockDelayNode[];
  panners: MockStereoPannerNode[];
  compressors: MockDynamicsCompressorNode[];
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

function createMockAudioContext(full: boolean): MockAudioContextHarness {
  const gains: MockGainNode[] = [];
  const filters: MockFilterNode[] = [];
  const oscillators: MockOscillatorNode[] = [];
  const buffers: MockBufferData[] = [];
  const bufferSources: MockBufferSourceNode[] = [];
  const convolvers: MockConvolverNode[] = [];
  const delays: MockDelayNode[] = [];
  const panners: MockStereoPannerNode[] = [];
  const compressors: MockDynamicsCompressorNode[] = [];

  const baseMock: Record<string, unknown> = {
    currentTime: 2.0,
    sampleRate: 44100,
    state: "running" as AudioContextState,
    destination: { connect: vi.fn() },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
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
        const buf: MockBufferData = {
          sampleRate,
          length,
          numberOfChannels,
          channels,
          getChannelData: (ch: number) =>
            channels[ch] ?? channels[0] ?? new Float32Array(length),
        };
        buffers.push(buf);
        return buf;
      },
    ),
    createBufferSource: vi.fn(() => {
      const node: MockBufferSourceNode = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      bufferSources.push(node);
      return node;
    }),
  };

  if (full) {
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
        delayTime: createMockParam(0),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      delays.push(node);
      return node;
    });
    baseMock.createStereoPanner = vi.fn(() => {
      const node: MockStereoPannerNode = {
        pan: createMockParam(0),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      panners.push(node);
      return node;
    });
    baseMock.createDynamicsCompressor = vi.fn(() => {
      const node: MockDynamicsCompressorNode = {
        threshold: createMockParam(-24),
        knee: createMockParam(30),
        ratio: createMockParam(12),
        attack: createMockParam(0.003),
        release: createMockParam(0.25),
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
    buffers,
    bufferSources,
    convolvers,
    delays,
    panners,
    compressors,
  };
}

function collectScheduledFrequencies(
  oscillators: readonly MockOscillatorNode[],
  startIndex: number,
): number[] {
  const freqs: number[] = [];
  for (let i = startIndex; i < oscillators.length; i++) {
    const osc = oscillators[i];
    if (!osc) continue;
    for (const call of osc.frequency.setValueAtTime.mock.calls) {
      const val = call[0] as number;
      if (Number.isFinite(val)) {
        freqs.push(val);
      }
    }
    for (const call of osc.frequency.exponentialRampToValueAtTime.mock.calls) {
      const val = call[0] as number;
      if (Number.isFinite(val)) {
        freqs.push(val);
      }
    }
    if (
      osc.frequency.setValueAtTime.mock.calls.length === 0 &&
      osc.frequency.exponentialRampToValueAtTime.mock.calls.length === 0
    ) {
      freqs.push(osc.frequency.value);
    }
  }
  return freqs;
}

function chordAllowedPitchClasses(chord: ChordVoicing): Set<number> {
  const set = new Set<number>();
  const allMidis = [
    chord.rootMidi,
    ...chord.padNotes,
    ...chord.pluckNotes,
    ...chord.melodyScale,
  ];
  for (const m of allMidis) {
    set.add(((Math.round(m) % 12) + 12) % 12);
  }
  return set;
}

function freqMatchesAllowedPitchClassOrOvertones(
  freq: number,
  allowedPitchClasses: Set<number>,
): boolean {
  // Ignore sub-25 Hz LFO frequencies (vibrato)
  if (freq < 25) {
    return true;
  }
  // Check fundamental, 2nd harmonic (/2), 3rd harmonic (/3), or kettle 1.5x mode (/1.5)
  const divisors = [1, 1.5, 2, 3];
  for (const d of divisors) {
    const baseFreq = freq / d;
    if (baseFreq <= 0) continue;
    const midi = 69 + 12 * Math.log2(baseFreq / 440);
    const nearest = Math.round(midi);
    if (Math.abs(midi - nearest) <= 0.35) {
      const pc = ((nearest % 12) + 12) % 12;
      if (allowedPitchClasses.has(pc)) {
        return true;
      }
    }
  }
  return false;
}

describe("musicEffects — StudioAudioBus", () => {
  it("builds full spatial bus with stereo 2.1s convolution IR, stereo ping-pong delay, and glue compressor", () => {
    const harness = createMockAudioContext(true);
    const bus = createStudioAudioBus(harness.ctx);

    expect(bus.hasConvolver).toBe(true);
    expect(bus.hasDelay).toBe(true);
    expect(bus.hasCompressor).toBe(true);
    expect(harness.convolvers.length).toBe(1);
    expect(harness.delays.length).toBeGreaterThanOrEqual(2);
    expect(harness.compressors.length).toBe(1);

    // Verify deterministic 2.1s stereo impulse response buffer properties
    const ir = harness.buffers[0];
    expect(ir).toBeDefined();
    expect(ir?.numberOfChannels).toBe(2);
    expect(ir?.length).toBe(Math.round(44100 * 2.1));

    const left = ir?.channels[0];
    const right = ir?.channels[1];
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    if (left && right) {
      let earlyEnergy = 0;
      let lateEnergy = 0;
      let diffEnergy = 0;
      for (let i = 441; i < 4410; i++) {
        earlyEnergy += (left[i] ?? 0) * (left[i] ?? 0);
        diffEnergy += Math.abs((left[i] ?? 0) - (right[i] ?? 0));
      }
      for (let i = left.length - 4410; i < left.length; i++) {
        lateEnergy += (left[i] ?? 0) * (left[i] ?? 0);
      }
      expect(earlyEnergy).toBeGreaterThan(0);
      expect(diffEnergy).toBeGreaterThan(0);
      expect(lateEnergy).toBeLessThan(earlyEnergy * 0.2);
    }

    // Parameter setters & ducking clamp safely and never throw
    expect(() => {
      bus.setFilterCutoff(1350, 0.15);
      bus.setFilterCutoff(Number.NaN, -5);
      bus.setFilterCutoff(999999, 99);
      bus.setReverbWet(0.45, 0.2);
      bus.setReverbWet(Number.NaN);
      bus.setReverbWet(2.5);
      bus.duck(0.35, 0.6);
      bus.duck(Number.NaN, -1);
    }).not.toThrow();

    expect(bus.musicToneFilter.frequency.value).toBeLessThanOrEqual(18000);
    expect(bus.musicToneFilter.frequency.value).toBeGreaterThanOrEqual(120);

    // Dispose disconnects cleanly and is idempotent
    expect(() => {
      bus.dispose();
      bus.dispose();
      bus.setFilterCutoff(2000);
      bus.setReverbWet(0.2);
      bus.duck(0.3, 0.4);
      bus.setMusicMuted(true);
      bus.setMasterMuted(true);
    }).not.toThrow();
    expect(
      (bus.musicDryIn as unknown as MockGainNode).disconnect,
    ).toHaveBeenCalledTimes(1);
  });

  it("falls back cleanly on minimal AudioContext without optional spatial/compressor factories (Review Focus #1)", () => {
    const harness = createMockAudioContext(false);
    let bus: StudioAudioBus | null = null;
    expect(() => {
      bus = createStudioAudioBus(harness.ctx);
    }).not.toThrow();

    expect(bus).not.toBeNull();
    if (!bus) return;
    const resolvedBus: StudioAudioBus = bus;

    expect(resolvedBus.hasConvolver).toBe(false);
    expect(resolvedBus.hasDelay).toBe(false);
    expect(resolvedBus.hasCompressor).toBe(false);

    expect(() => {
      resolvedBus.setFilterCutoff(1400);
      resolvedBus.setReverbWet(0.4);
      resolvedBus.duck(0.3, 0.5);
      resolvedBus.setMusicMuted(true);
      resolvedBus.setMasterMuted(true);
      resolvedBus.setMasterMuted(false);
      resolvedBus.setMusicMuted(false);
      resolvedBus.dispose();
    }).not.toThrow();
  });

  it("keeps ambience softly alive when only music is muted, and zeroes both on master mute", () => {
    const harness = createMockAudioContext(true);
    const bus = createStudioAudioBus(harness.ctx);

    const initialMusicGain = bus.musicMuteGain.gain.value;
    const initialAmbienceGain = bus.ambienceMuteGain.gain.value;
    expect(initialMusicGain).toBeGreaterThan(0);
    expect(initialAmbienceGain).toBeGreaterThan(0);

    // Music mute -> music is 0, ambience remains softly alive (> 0 and gently attenuated)
    bus.setMusicMuted(true);
    expect(bus.musicMuteGain.gain.value).toBe(0);
    expect(bus.ambienceMuteGain.gain.value).toBeGreaterThan(0);
    expect(bus.ambienceMuteGain.gain.value).toBeLessThan(initialAmbienceGain);

    // Master mute -> BOTH music and ambience ramp to 0
    bus.setMasterMuted(true);
    expect(bus.musicMuteGain.gain.value).toBe(0);
    expect(bus.ambienceMuteGain.gain.value).toBe(0);

    // Unmuting master while music remains muted restores soft ambience only
    bus.setMasterMuted(false);
    expect(bus.musicMuteGain.gain.value).toBe(0);
    expect(bus.ambienceMuteGain.gain.value).toBeGreaterThan(0);

    // Unmuting music restores both full unmuted levels
    bus.setMusicMuted(false);
    expect(bus.musicMuteGain.gain.value).toBeCloseTo(initialMusicGain, 4);
    expect(bus.ambienceMuteGain.gain.value).toBeCloseTo(initialAmbienceGain, 4);

    bus.dispose();
  });
});

describe("musicInstruments — AcousticVoiceBank", () => {
  it("synthesizes all acoustic voices cleanly on both full and minimal AudioContexts", () => {
    for (const full of [true, false]) {
      const harness = createMockAudioContext(full);
      const bus = createStudioAudioBus(harness.ctx);
      const bank = new AcousticVoiceBank();
      const chord = getChordForBar("emerald_spire", "battle", 0);

      expect(() => {
        bank.playPadChord(bus, chord.padNotes, 2.0, 2.6, 0.24);
        bank.playPluckNote(bus, chord.pluckNotes[0] ?? 62, 2.1, 0.72, -0.35);
        bank.playFluteNote(bus, 74, 2.2, 0.85, 0.68, null);
        bank.playFluteNote(bus, 76, 3.1, 0.9, 0.74, 74);
        bank.playCelloNote(bus, chord.rootMidi, 2.0, 1.4, 0.28);
        bank.playFrameDrum(bus, 2.0, 0.32, true);
        bank.playFrameDrum(bus, 2.4, 0.2, false);
        bank.playBrushShaker(bus, 2.25, 0.14);
        bank.playTimpani(bus, chord.rootMidi, 2.5, 0.9, 0.36);
        bank.playChargeShimmer(bus, chord, 2.6, 0.8, 0.85);
      }).not.toThrow();

      expect(harness.oscillators.length).toBeGreaterThan(10);
      expect(harness.bufferSources.length).toBeGreaterThan(2);

      // Verify flute vibrato LFO (~5.2 Hz) and stereo panners when full
      const freqs = collectScheduledFrequencies(harness.oscillators, 0);
      expect(freqs.every((f) => Number.isFinite(f) && f > 0)).toBe(true);
      expect(freqs.some((f) => f >= 4.5 && f <= 6.0)).toBe(true);
      if (full) {
        expect(harness.panners.length).toBeGreaterThan(0);
      } else {
        expect(harness.panners.length).toBe(0);
      }

      // Verify timpani tuned to exact chord.rootMidi frequency
      const expectedTimpaniHz = midiToFreq(chord.rootMidi);
      expect(
        freqs.some((f) => Math.abs(f - expectedTimpaniHz) < 1.0),
      ).toBe(true);

      // Dispose prevents further voice creation cleanly
      const oscCountBeforeDispose = harness.oscillators.length;
      bank.dispose();
      expect(() => {
        bank.playPluckNote(bus, 69, 4.0, 0.6, 0);
        bank.playStinger(bus, "purchase", chord, 4.1);
      }).not.toThrow();
      expect(harness.oscillators.length).toBe(oscCountBeforeDispose);

      bus.dispose();
    }
  });

  it("derives all 5 key-aware stingers from chord across biomes and adds overtone bloom for apex evolution", () => {
    const stingerKinds: readonly MusicStingerKind[] = [
      "ko",
      "round_end",
      "flood_alarm",
      "purchase",
      "evolution",
    ];
    const themes = [
      "emerald_spire",
      "canyon_arch",
      "twin_pillars",
      "mountain_spine",
    ] as const;

    for (const full of [true, false]) {
      const harness = createMockAudioContext(full);
      const bus = createStudioAudioBus(harness.ctx);
      const bank = new AcousticVoiceBank();

      for (const theme of themes) {
        const chord = getChordForBar(theme, "battle", 1);
        const allowedPCs = chordAllowedPitchClasses(chord);

        for (const kind of stingerKinds) {
          const startIdx = harness.oscillators.length;
          expect(() => {
            bank.playStinger(bus, kind, chord, 2.2, false);
          }).not.toThrow();

          const freqs = collectScheduledFrequencies(harness.oscillators, startIdx);
          expect(freqs.length).toBeGreaterThan(0);
          for (const freq of freqs) {
            expect(Number.isFinite(freq)).toBe(true);
            expect(freq).toBeGreaterThan(0);
            expect(
              freqMatchesAllowedPitchClassOrOvertones(freq, allowedPCs),
            ).toBe(true);
          }
        }
      }

      // Apex evolution adds extra high overtone shimmer compared to standard evolution
      const chord = getChordForBar("twin_pillars", "victory", 0);
      const beforeStd = harness.oscillators.length;
      bank.playStinger(bus, "evolution", chord, 3.0, false);
      const stdCount = harness.oscillators.length - beforeStd;

      const beforeApex = harness.oscillators.length;
      bank.playStinger(bus, "evolution", chord, 4.0, true);
      const apexCount = harness.oscillators.length - beforeApex;

      expect(apexCount).toBeGreaterThan(stdCount);

      bank.dispose();
      bus.dispose();
    }
  });
});
