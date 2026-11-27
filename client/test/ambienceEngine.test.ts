import { describe, expect, it, vi } from "vitest";
import { AmbienceEngine } from "../src/audio/ambienceEngine.js";
import { createStudioAudioBus } from "../src/audio/musicEffects.js";
import type { MusicGameplayContext } from "../src/audio/musicTypes.js";

interface MockAudioParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

interface MockGainNode {
  readonly kind: "gain";
  gain: MockAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockFilterNode {
  readonly kind: "filter";
  type: BiquadFilterType;
  frequency: MockAudioParam;
  Q: MockAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockOscillatorNode {
  readonly kind: "oscillator";
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
  duration: number;
  numberOfChannels: number;
  channels: Float32Array[];
  getChannelData: (channel: number) => Float32Array;
}

interface MockBufferSourceNode {
  readonly kind: "bufferSource";
  buffer: AudioBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

type AnyMockNode =
  | MockGainNode
  | MockFilterNode
  | MockOscillatorNode
  | MockBufferSourceNode;

interface MockAudioContextHarness {
  ctx: AudioContext;
  gains: MockGainNode[];
  filters: MockFilterNode[];
  oscillators: MockOscillatorNode[];
  buffers: MockBufferData[];
  bufferSources: MockBufferSourceNode[];
  createBufferSpy: ReturnType<typeof vi.fn>;
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

function createMockAudioContext(options?: {
  sampleRate?: number;
  rejectStereoBuffer?: boolean;
}): MockAudioContextHarness {
  const sampleRate = options?.sampleRate ?? 44100;
  const rejectStereoBuffer = options?.rejectStereoBuffer ?? false;

  const gains: MockGainNode[] = [];
  const filters: MockFilterNode[] = [];
  const oscillators: MockOscillatorNode[] = [];
  const buffers: MockBufferData[] = [];
  const bufferSources: MockBufferSourceNode[] = [];

  const createBufferSpy = vi.fn(
    (numberOfChannels: number, length: number, rate: number) => {
      if (rejectStereoBuffer && numberOfChannels > 1) {
        throw new Error("Stereo buffer unsupported");
      }
      const channels: Float32Array[] = [];
      for (let c = 0; c < numberOfChannels; c++) {
        channels.push(new Float32Array(length));
      }
      const buf: MockBufferData = {
        sampleRate: rate,
        length,
        duration: length / rate,
        numberOfChannels,
        channels,
        getChannelData: (ch: number) =>
          channels[ch] ?? channels[0] ?? new Float32Array(length),
      };
      buffers.push(buf);
      return buf;
    },
  );

  const mockCtx: Record<string, unknown> = {
    currentTime: 3.5,
    sampleRate,
    state: "running" as AudioContextState,
    destination: { connect: vi.fn() },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    createGain: vi.fn(() => {
      const node: MockGainNode = {
        kind: "gain",
        gain: createMockParam(1),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(node);
      return node;
    }),
    createBiquadFilter: vi.fn(() => {
      const node: MockFilterNode = {
        kind: "filter",
        type: "lowpass",
        frequency: createMockParam(1000),
        Q: createMockParam(1),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      filters.push(node);
      return node;
    }),
    createOscillator: vi.fn(() => {
      const node: MockOscillatorNode = {
        kind: "oscillator",
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
    createBuffer: createBufferSpy,
    createBufferSource: vi.fn(() => {
      const node: MockBufferSourceNode = {
        kind: "bufferSource",
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      bufferSources.push(node);
      return node;
    }),
  };

  return {
    ctx: mockCtx as unknown as AudioContext,
    gains,
    filters,
    oscillators,
    buffers,
    bufferSources,
    createBufferSpy,
  };
}

function makeContext(
  overrides?: Partial<MusicGameplayContext>,
): MusicGameplayContext {
  return {
    mood: "battle",
    theme: "emerald_spire",
    round: 1,
    maxRounds: 5,
    isMyTurn: true,
    isCharging: false,
    chargePower: 0,
    isShotFlight: false,
    isDroneView: false,
    hpRatio: 1,
    windSpeed: 3,
    waterLevel: 1.5,
    floodIntensity: 0,
    isShowdown: false,
    ...overrides,
  };
}

function getFirstConnectedTarget(node: AnyMockNode): unknown {
  const firstCall = node.connect.mock.calls[0];
  return firstCall ? firstCall[0] : undefined;
}

function traceLayerFromSource(source: MockBufferSourceNode): {
  filters: MockFilterNode[];
  outputGain: MockGainNode | null;
  destination: unknown;
} {
  const layerFilters: MockFilterNode[] = [];
  let outputGain: MockGainNode | null = null;
  let current: unknown = getFirstConnectedTarget(source);
  let hops = 0;
  while (current && hops < 8) {
    hops++;
    const maybeNode = current as Partial<AnyMockNode>;
    if (maybeNode.kind === "filter") {
      const f = current as MockFilterNode;
      layerFilters.push(f);
      current = getFirstConnectedTarget(f);
    } else if (maybeNode.kind === "gain") {
      const g = current as MockGainNode;
      outputGain = g;
      return {
        filters: layerFilters,
        outputGain,
        destination: getFirstConnectedTarget(g),
      };
    } else {
      break;
    }
  }
  return { filters: layerFilters, outputGain, destination: current };
}

function collectAllParams(harness: MockAudioContextHarness): MockAudioParam[] {
  const params: MockAudioParam[] = [];
  for (const g of harness.gains) {
    params.push(g.gain);
  }
  for (const f of harness.filters) {
    params.push(f.frequency, f.Q);
  }
  for (const o of harness.oscillators) {
    params.push(o.frequency, o.detune);
  }
  return params;
}

describe("AmbienceEngine", () => {
  it("generates a deterministic 3-second pink-weighted stereo noise buffer with smooth loop boundary and mono fallback", () => {
    const harnessA = createMockAudioContext({ sampleRate: 24000 });
    const busA = createStudioAudioBus(harnessA.ctx);
    const engineA = new AmbienceEngine();
    engineA.start(busA);

    const harnessB = createMockAudioContext({ sampleRate: 24000 });
    const busB = createStudioAudioBus(harnessB.ctx);
    const engineB = new AmbienceEngine();
    engineB.start(busB);

    const bufA = harnessA.buffers[0];
    const bufB = harnessB.buffers[0];
    expect(bufA).toBeDefined();
    expect(bufB).toBeDefined();
    expect(bufA?.numberOfChannels).toBe(2);
    expect(bufA?.length).toBe(24000 * 3);

    const leftA = bufA?.channels[0];
    const rightA = bufA?.channels[1];
    const leftB = bufB?.channels[0];
    expect(leftA).toBeDefined();
    expect(rightA).toBeDefined();
    expect(leftB).toBeDefined();

    if (leftA && rightA && leftB) {
      // Deterministic across instances (no Math.random())
      let maxDiff = 0;
      let stereoDiff = 0;
      for (let i = 0; i < 1024; i++) {
        maxDiff = Math.max(maxDiff, Math.abs((leftA[i] ?? 0) - (leftB[i] ?? 0)));
        stereoDiff += Math.abs((leftA[i] ?? 0) - (rightA[i] ?? 0));
      }
      expect(maxDiff).toBe(0);
      expect(stereoDiff).toBeGreaterThan(0);

      // Smooth loop boundary (no sudden jump between last sample and first sample)
      const boundaryJump = Math.abs(
        (leftA[leftA.length - 1] ?? 0) - (leftA[0] ?? 0),
      );
      expect(boundaryJump).toBeLessThan(0.18);

      // Pink-weighted spectrum: adjacent samples are positively correlated (warmer than white noise)
      let sameSignCount = 0;
      for (let i = 1; i < 4000; i++) {
        if (((leftA[i] ?? 0) >= 0) === ((leftA[i - 1] ?? 0) >= 0)) {
          sameSignCount++;
        }
      }
      expect(sameSignCount / 3999).toBeGreaterThan(0.62);
    }

    // Buffer reuse on stop() -> start() on the same AudioContext
    const bufferCallsAfterFirstStart = harnessA.createBufferSpy.mock.calls.length;
    engineA.stop();
    engineA.start(busA);
    expect(harnessA.createBufferSpy.mock.calls.length).toBe(
      bufferCallsAfterFirstStart,
    );

    engineA.dispose();
    engineB.dispose();
    busA.dispose();
    busB.dispose();

    // Mono fallback when stereo createBuffer is unsupported
    const monoHarness = createMockAudioContext({
      sampleRate: 24000,
      rejectStereoBuffer: true,
    });
    const monoBus = createStudioAudioBus(monoHarness.ctx);
    const monoEngine = new AmbienceEngine();
    expect(() => monoEngine.start(monoBus)).not.toThrow();
    expect(monoEngine.isRunning()).toBe(true);
    expect(monoHarness.buffers[0]?.numberOfChannels).toBe(1);
    monoEngine.dispose();
    monoBus.dispose();
  });

  it("starts 3 continuous looped layers routed into bus.ambienceIn with an ocean breathing LFO", () => {
    const harness = createMockAudioContext();
    const bus = createStudioAudioBus(harness.ctx);
    const engine = new AmbienceEngine();

    expect(engine.isRunning()).toBe(false);
    engine.start(bus);
    expect(engine.isRunning()).toBe(true);

    // 3 continuous looped buffer sources: Ocean Surf, Live Island Wind, Storm Wash
    expect(harness.bufferSources.length).toBe(3);
    for (const src of harness.bufferSources) {
      expect(src.loop).toBe(true);
      expect(src.buffer).not.toBeNull();
      expect(src.start).toHaveBeenCalledTimes(1);

      const traced = traceLayerFromSource(src);
      expect(traced.filters.length).toBeGreaterThanOrEqual(1);
      expect(traced.outputGain).not.toBeNull();
      expect(traced.destination).toBe(bus.ambienceIn);
    }

    // Ocean surf has a slow ~0.12 Hz sine LFO modulating its wave gain via a depth GainNode
    const oceanLfo = harness.oscillators.find(
      (osc) =>
        osc.type === "sine" &&
        osc.frequency.value >= 0.08 &&
        osc.frequency.value <= 0.16,
    );
    expect(oceanLfo).toBeDefined();
    expect(oceanLfo?.start).toHaveBeenCalledTimes(1);

    const depthNode = oceanLfo
      ? (getFirstConnectedTarget(oceanLfo) as Partial<MockGainNode> | undefined)
      : undefined;
    expect(depthNode?.kind).toBe("gain");
    const oceanSource = harness.bufferSources[0];
    expect(oceanSource).toBeDefined();
    if (!oceanSource) return;
    const oceanTrace = traceLayerFromSource(oceanSource);
    expect(getFirstConnectedTarget(depthNode as MockGainNode)).toBe(
      oceanTrace.outputGain?.gain,
    );

    // Repeated start(bus) on same bus is idempotent
    engine.start(bus);
    expect(harness.bufferSources.length).toBe(3);

    engine.dispose();
    bus.dispose();
  });

  it("adapts wind, drone view, ocean water level, and storm/flood intensity dynamically on update(ctx)", () => {
    const harness = createMockAudioContext();
    const bus = createStudioAudioBus(harness.ctx);
    const engine = new AmbienceEngine();
    engine.start(bus);

    const oceanSource = harness.bufferSources[0];
    const windSource = harness.bufferSources[1];
    const stormSource = harness.bufferSources[2];
    expect(oceanSource).toBeDefined();
    expect(windSource).toBeDefined();
    expect(stormSource).toBeDefined();
    if (!oceanSource || !windSource || !stormSource) return;

    const oceanLayer = traceLayerFromSource(oceanSource);
    const windLayer = traceLayerFromSource(windSource);
    const stormLayer = traceLayerFromSource(stormSource);

    const oceanFilter = oceanLayer.filters[0];
    const oceanGain = oceanLayer.outputGain;
    const windFilter = windLayer.filters[0];
    const windGain = windLayer.outputGain;
    const stormGain = stormLayer.outputGain;

    expect(oceanFilter).toBeDefined();
    expect(oceanGain).not.toBeNull();
    expect(windFilter).toBeDefined();
    expect(windGain).not.toBeNull();
    expect(stormGain).not.toBeNull();
    if (!oceanFilter || !oceanGain || !windFilter || !windGain || !stormGain) {
      return;
    }

    expect(oceanFilter.type).toBe("lowpass");
    expect(windFilter.type).toBe("bandpass");

    // 1. Calm lobby/shop keeps storm wash whisper-quiet (~0.002)
    engine.update(
      makeContext({
        mood: "lobby",
        round: 1,
        windSpeed: 1,
        waterLevel: 1.5,
        floodIntensity: 0,
      }),
    );
    const calmStormGain = stormGain.gain.value;
    expect(calmStormGain).toBeGreaterThan(0);
    expect(calmStormGain).toBeLessThanOrEqual(0.005);

    engine.update(
      makeContext({
        mood: "shop",
        round: 2,
        windSpeed: 1,
        waterLevel: 1.5,
        floodIntensity: 0,
      }),
    );
    expect(stormGain.gain.value).toBeLessThanOrEqual(0.005);

    // 2. Wind speed 1 -> 12 increases wind filter frequency & gain
    engine.update(
      makeContext({
        mood: "battle",
        round: 1,
        windSpeed: 1,
        waterLevel: 1.5,
        floodIntensity: 0,
        isDroneView: false,
      }),
    );
    const lowWindFreq = windFilter.frequency.value;
    const lowWindGain = windGain.gain.value;
    const baseOceanGain = oceanGain.gain.value;
    const baseOceanFreq = oceanFilter.frequency.value;

    expect(lowWindFreq).toBeGreaterThanOrEqual(300);
    expect(lowWindFreq).toBeLessThanOrEqual(500);

    engine.update(
      makeContext({
        mood: "battle",
        round: 1,
        windSpeed: 12,
        waterLevel: 1.5,
        floodIntensity: 0,
        isDroneView: false,
      }),
    );
    const highWindFreq = windFilter.frequency.value;
    const highWindGain = windGain.gain.value;
    expect(highWindFreq).toBeGreaterThan(lowWindFreq + 200);
    expect(highWindGain).toBeGreaterThan(lowWindGain);

    // 3. Drone Recon shifts wind brighter (~+280 Hz) & slightly airier while pulling ocean surf back
    const oceanBeforeDrone = oceanGain.gain.value;
    engine.update(
      makeContext({
        mood: "battle",
        round: 1,
        windSpeed: 12,
        waterLevel: 1.5,
        floodIntensity: 0,
        isDroneView: true,
      }),
    );
    expect(windFilter.frequency.value).toBeGreaterThanOrEqual(
      highWindFreq + 220,
    );
    expect(windFilter.frequency.value).toBeLessThanOrEqual(1300);
    expect(windGain.gain.value).toBeGreaterThan(highWindGain);
    expect(oceanGain.gain.value).toBeLessThan(oceanBeforeDrone);

    // 4. Rising waterLevel increases ocean surf presence & warms filter open within 280-520 Hz
    engine.update(
      makeContext({
        mood: "battle",
        round: 3,
        windSpeed: 4,
        waterLevel: 16,
        floodIntensity: 0.1,
        isDroneView: false,
      }),
    );
    expect(oceanGain.gain.value).toBeGreaterThan(baseOceanGain);
    expect(oceanFilter.frequency.value).toBeGreaterThan(baseOceanFreq);
    expect(oceanFilter.frequency.value).toBeGreaterThanOrEqual(280);
    expect(oceanFilter.frequency.value).toBeLessThanOrEqual(520);

    // 5. Late intense rounds raise storm wash, and Final Flood peaks it
    engine.update(
      makeContext({
        mood: "intense",
        round: 4,
        maxRounds: 5,
        windSpeed: 9,
        waterLevel: 8,
        floodIntensity: 0.35,
      }),
    );
    const lateIntenseStormGain = stormGain.gain.value;
    expect(lateIntenseStormGain).toBeGreaterThan(calmStormGain * 10);

    engine.update(
      makeContext({
        mood: "flood",
        round: 5,
        maxRounds: 5,
        windSpeed: 15,
        waterLevel: 18,
        floodIntensity: 1,
      }),
    );
    const floodStormGain = stormGain.gain.value;
    expect(floodStormGain).toBeGreaterThan(lateIntenseStormGain);

    engine.dispose();
    bus.dispose();
  });

  it("clamps NaN, Infinity, and negative/out-of-range telemetry so no AudioParam ever receives non-finite values (Review Focus #5)", () => {
    const harness = createMockAudioContext();
    const bus = createStudioAudioBus(harness.ctx);
    const engine = new AmbienceEngine();
    engine.start(bus);

    const toxicContexts: MusicGameplayContext[] = [
      makeContext({
        windSpeed: Number.NaN,
        waterLevel: Number.NaN,
        floodIntensity: Number.NaN,
        round: Number.NaN,
        maxRounds: Number.NaN,
      }),
      makeContext({
        windSpeed: Number.POSITIVE_INFINITY,
        waterLevel: Number.POSITIVE_INFINITY,
        floodIntensity: Number.POSITIVE_INFINITY,
        isDroneView: true,
        mood: "flood",
      }),
      makeContext({
        windSpeed: -99,
        waterLevel: -99,
        floodIntensity: -99,
        round: -5,
        maxRounds: 0,
      }),
      makeContext({
        windSpeed: Number.NEGATIVE_INFINITY,
        waterLevel: 999999,
        floodIntensity: 42,
        mood: "intense",
      }),
    ];

    for (const ctx of toxicContexts) {
      expect(() => engine.update(ctx)).not.toThrow();
    }

    const params = collectAllParams(harness);
    expect(params.length).toBeGreaterThan(0);

    let totalScheduledCalls = 0;
    for (const param of params) {
      expect(Number.isFinite(param.value)).toBe(true);
      for (const call of param.setTargetAtTime.mock.calls) {
        totalScheduledCalls++;
        const [target, startTime, timeConstant] = call as [
          number,
          number,
          number,
        ];
        expect(Number.isFinite(target)).toBe(true);
        expect(Number.isFinite(startTime)).toBe(true);
        expect(Number.isFinite(timeConstant)).toBe(true);
        expect(timeConstant).toBeGreaterThan(0);
      }
      for (const call of param.setValueAtTime.mock.calls) {
        totalScheduledCalls++;
        const [value, startTime] = call as [number, number];
        expect(Number.isFinite(value)).toBe(true);
        expect(Number.isFinite(startTime)).toBe(true);
      }
    }
    expect(totalScheduledCalls).toBeGreaterThan(0);

    engine.dispose();
    bus.dispose();
  });

  it("stops all active buffer sources and oscillators, disconnects nodes cleanly, and is idempotent (Review Focus #3)", () => {
    const harness = createMockAudioContext();
    const bus = createStudioAudioBus(harness.ctx);
    const engine = new AmbienceEngine();

    // Calling stop() before start() is a safe no-op
    expect(() => engine.stop()).not.toThrow();
    expect(engine.isRunning()).toBe(false);

    const gainCountBeforeStart = harness.gains.length;
    const filterCountBeforeStart = harness.filters.length;

    engine.start(bus);
    expect(engine.isRunning()).toBe(true);

    const createdSources = [...harness.bufferSources];
    const createdOscs = [...harness.oscillators];
    const createdGains = harness.gains.slice(gainCountBeforeStart);
    const createdFilters = harness.filters.slice(filterCountBeforeStart);

    expect(createdSources.length).toBe(3);
    expect(createdOscs.length).toBeGreaterThanOrEqual(1);

    engine.stop();
    expect(engine.isRunning()).toBe(false);

    for (const src of createdSources) {
      expect(src.stop).toHaveBeenCalledTimes(1);
      expect(src.disconnect).toHaveBeenCalledTimes(1);
    }
    for (const osc of createdOscs) {
      expect(osc.stop).toHaveBeenCalledTimes(1);
      expect(osc.disconnect).toHaveBeenCalledTimes(1);
    }
    for (const g of createdGains) {
      expect(g.disconnect).toHaveBeenCalledTimes(1);
    }
    for (const f of createdFilters) {
      expect(f.disconnect).toHaveBeenCalledTimes(1);
    }

    // Repeated stop() does not throw or double-stop/double-disconnect
    expect(() => engine.stop()).not.toThrow();
    for (const src of createdSources) {
      expect(src.stop).toHaveBeenCalledTimes(1);
      expect(src.disconnect).toHaveBeenCalledTimes(1);
    }
    for (const osc of createdOscs) {
      expect(osc.stop).toHaveBeenCalledTimes(1);
      expect(osc.disconnect).toHaveBeenCalledTimes(1);
    }

    // Can restart cleanly after stop(), then dispose() tears down permanently
    engine.start(bus);
    expect(engine.isRunning()).toBe(true);
    const restartedSources = harness.bufferSources.slice(createdSources.length);
    const restartedOscs = harness.oscillators.slice(createdOscs.length);
    expect(restartedSources.length).toBe(3);
    expect(restartedOscs.length).toBeGreaterThanOrEqual(1);

    engine.dispose();
    expect(engine.isRunning()).toBe(false);
    for (const src of restartedSources) {
      expect(src.stop).toHaveBeenCalledTimes(1);
      expect(src.disconnect).toHaveBeenCalledTimes(1);
    }
    for (const osc of restartedOscs) {
      expect(osc.stop).toHaveBeenCalledTimes(1);
      expect(osc.disconnect).toHaveBeenCalledTimes(1);
    }

    // Repeated dispose() and post-dispose calls safely no-op
    expect(() => {
      engine.dispose();
      engine.stop();
      engine.update(makeContext({ windSpeed: 10, mood: "flood" }));
      engine.start(bus);
    }).not.toThrow();
    expect(engine.isRunning()).toBe(false);

    bus.dispose();
  });
});
