import { describe, expect, it } from "vitest";
import type { ThemeId } from "@critter/shared";
import type { MusicMood } from "../src/audio/musicTypes.js";
import {
  GenerativePhrasePlanner,
  MOOD_TARGET_BPM,
  computeStemMixTargets,
  createDefaultMusicContext,
  getBiomePalette,
  getChordForBar,
  midiToFreq,
} from "../src/audio/musicTheory.js";

const ALL_THEMES: readonly ThemeId[] = [
  "emerald_spire",
  "canyon_arch",
  "twin_pillars",
  "mountain_spine",
];

const ALL_MOODS: readonly MusicMood[] = [
  "lobby",
  "battle",
  "intense",
  "shop",
  "flood",
  "victory",
  "defeat",
];

describe("musicTheory", () => {
  it("defines exact target BPMs for every MusicMood", () => {
    expect(MOOD_TARGET_BPM).toEqual({
      lobby: 74,
      shop: 72,
      battle: 86,
      intense: 102,
      flood: 114,
      victory: 80,
      defeat: 68,
    });
  });

  it("converts MIDI pitches to accurate frequencies and guards non-finite inputs", () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 5);
    expect(midiToFreq(57)).toBeCloseTo(220, 5);
    expect(midiToFreq(81)).toBeCloseTo(880, 5);
    expect(midiToFreq(60)).toBeCloseTo(261.625565, 4);
    expect(Number.isFinite(midiToFreq(Number.NaN))).toBe(true);
    expect(Number.isFinite(midiToFreq(Number.POSITIVE_INFINITY))).toBe(true);
  });

  it("provides rich open 4+ note voicings across 4-8 bar progressions for all 4 biomes", () => {
    const expectedTonics: Record<ThemeId, number> = {
      emerald_spire: 62,
      canyon_arch: 57,
      twin_pillars: 65,
      mountain_spine: 55,
    };

    for (const theme of ALL_THEMES) {
      const palette = getBiomePalette(theme);
      expect(palette.theme).toBe(theme);
      expect(palette.tonicMidi).toBe(expectedTonics[theme]);

      const progressions = [
        palette.calmChords,
        palette.battleChords,
        palette.intenseChords,
        palette.floodChords,
        palette.victoryChords,
        palette.defeatChords,
      ];

      for (const progression of progressions) {
        expect(progression.length).toBeGreaterThanOrEqual(4);
        expect(progression.length).toBeLessThanOrEqual(8);

        for (const chord of progression) {
          expect(chord.name.length).toBeGreaterThan(0);
          expect(chord.padNotes.length).toBeGreaterThanOrEqual(4);
          expect(chord.pluckNotes.length).toBeGreaterThanOrEqual(4);
          expect(chord.melodyScale.length).toBeGreaterThanOrEqual(5);

          const minPad = Math.min(...chord.padNotes);
          const maxPad = Math.max(...chord.padNotes);
          // Open add9/maj7/sus2/m9 voicings span at least an octave
          expect(maxPad - minPad).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it("wraps getChordForBar safely across all moods and negative/large bar indices", () => {
    for (const theme of ALL_THEMES) {
      const palette = getBiomePalette(theme);
      for (const mood of ALL_MOODS) {
        const bar0 = getChordForBar(theme, mood, 0);
        const barNeg = getChordForBar(theme, mood, -1);
        const barLarge = getChordForBar(theme, mood, 128);
        const barNaN = getChordForBar(theme, mood, Number.NaN);
        expect(bar0.padNotes.length).toBeGreaterThanOrEqual(4);
        expect(barNeg.padNotes.length).toBeGreaterThanOrEqual(4);
        expect(barLarge.padNotes.length).toBeGreaterThanOrEqual(4);
        expect(barNaN).toEqual(bar0);
      }
      expect(getChordForBar(theme, "lobby", 0)).toEqual(palette.calmChords[0]);
      expect(getChordForBar(theme, "shop", 1)).toEqual(palette.calmChords[1]);
      expect(getChordForBar(theme, "defeat", 0)).toEqual(palette.defeatChords[0]);
    }
  });

  describe("computeStemMixTargets", () => {
    it("applies warm muffled filter and zero percussion in shop mood", () => {
      const ctx = {
        ...createDefaultMusicContext(),
        mood: "shop" as const,
        isShowdown: true,
        floodIntensity: 0.9,
      };
      const mix = computeStemMixTargets(ctx);
      expect(mix.filterHz).toBeLessThanOrEqual(1450);
      expect(mix.filterHz).toBeGreaterThanOrEqual(1150);
      expect(mix.percussion).toBe(0);
    });

    it("scales chargeShimmer when charging above 0.5 and stays zero at or below 0.5", () => {
      const base = {
        ...createDefaultMusicContext(),
        mood: "battle" as const,
      };
      const idle = computeStemMixTargets({
        ...base,
        isCharging: false,
        chargePower: 0.9,
      });
      const half = computeStemMixTargets({
        ...base,
        isCharging: true,
        chargePower: 0.5,
      });
      const midHigh = computeStemMixTargets({
        ...base,
        isCharging: true,
        chargePower: 0.72,
      });
      const full = computeStemMixTargets({
        ...base,
        isCharging: true,
        chargePower: 1.0,
      });

      expect(idle.chargeShimmer).toBe(0);
      expect(half.chargeShimmer).toBe(0);
      expect(midHigh.chargeShimmer).toBeGreaterThan(0);
      expect(full.chargeShimmer).toBeGreaterThan(midHigh.chargeShimmer);
      expect(full.chargeShimmer).toBeLessThanOrEqual(1);
    });

    it("pulls back percussion by >=45% and raises reverbWet during shot flight", () => {
      const battleBase = {
        ...createDefaultMusicContext(),
        mood: "battle" as const,
        isMyTurn: true,
        isShotFlight: false,
      };
      const normalMix = computeStemMixTargets(battleBase);
      const flightMix = computeStemMixTargets({
        ...battleBase,
        isShotFlight: true,
      });

      expect(normalMix.percussion).toBeGreaterThan(0);
      expect(flightMix.percussion).toBeLessThanOrEqual(normalMix.percussion * 0.55);
      expect(flightMix.reverbWet).toBeGreaterThan(normalMix.reverbWet);
    });

    it("pulls back percussion and raises reverbWet during drone recon view", () => {
      const battleBase = {
        ...createDefaultMusicContext(),
        mood: "battle" as const,
        isMyTurn: true,
        isDroneView: false,
      };
      const normalMix = computeStemMixTargets(battleBase);
      const droneMix = computeStemMixTargets({
        ...battleBase,
        isDroneView: true,
      });

      expect(droneMix.percussion).toBeLessThan(normalMix.percussion);
      expect(droneMix.reverbWet).toBeGreaterThan(normalMix.reverbWet);
    });

    it("softens flute and percussion when it is not the local player's turn", () => {
      const base = {
        ...createDefaultMusicContext(),
        mood: "battle" as const,
      };
      const myTurnMix = computeStemMixTargets({ ...base, isMyTurn: true });
      const rivalTurnMix = computeStemMixTargets({ ...base, isMyTurn: false });

      expect(rivalTurnMix.flute).toBeLessThan(myTurnMix.flute);
      expect(rivalTurnMix.percussion).toBeLessThan(myTurnMix.percussion);
    });

    it("safely clamps non-finite and out-of-range context inputs", () => {
      const extreme = computeStemMixTargets({
        mood: "intense",
        theme: "mountain_spine",
        round: Number.NaN,
        maxRounds: -5,
        isMyTurn: true,
        isCharging: true,
        chargePower: Number.POSITIVE_INFINITY,
        isShotFlight: false,
        isDroneView: false,
        hpRatio: -12,
        windSpeed: Number.NEGATIVE_INFINITY,
        waterLevel: Number.NaN,
        floodIntensity: 999,
        isShowdown: true,
      });

      const values = Object.values(extreme);
      for (const v of values) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(extreme.pad).toBeGreaterThanOrEqual(0);
      expect(extreme.pad).toBeLessThanOrEqual(1);
      expect(extreme.percussion).toBeGreaterThanOrEqual(0);
      expect(extreme.percussion).toBeLessThanOrEqual(1);
      expect(extreme.chargeShimmer).toBeGreaterThanOrEqual(0);
      expect(extreme.chargeShimmer).toBeLessThanOrEqual(1);
      expect(extreme.reverbWet).toBeGreaterThan(0);
      expect(extreme.reverbWet).toBeLessThanOrEqual(1);
      expect(extreme.filterHz).toBeGreaterThanOrEqual(600);
      expect(extreme.filterHz).toBeLessThanOrEqual(20000);
    });
  });

  describe("GenerativePhrasePlanner", () => {
    it("is strictly deterministic for a given seed and reset()", () => {
      const plannerA = new GenerativePhrasePlanner(1337);
      const plannerB = new GenerativePhrasePlanner(1337);

      const seqA = [];
      const seqB = [];
      for (let bar = 0; bar < 8; bar++) {
        for (let step = 0; step < 16; step++) {
          seqA.push(plannerA.planStep("emerald_spire", "battle", bar, step, true, false));
          seqB.push(plannerB.planStep("emerald_spire", "battle", bar, step, true, false));
        }
      }
      expect(seqA).toEqual(seqB);

      plannerA.reset(1337);
      const seqAReset = [];
      for (let bar = 0; bar < 8; bar++) {
        for (let step = 0; step < 16; step++) {
          seqAReset.push(
            plannerA.planStep("emerald_spire", "battle", bar, step, true, false),
          );
        }
      }
      expect(seqAReset).toEqual(seqA);
    });

    it("includes >=30% breathing rest bars and non-identical consecutive 8-bar flute contours", () => {
      for (const theme of ALL_THEMES) {
        const planner = new GenerativePhrasePlanner(4207);
        let silentFluteBars = 0;
        let activeFluteBars = 0;
        const firstHalfContour: Array<number | null> = [];
        const secondHalfContour: Array<number | null> = [];

        for (let bar = 0; bar < 16; bar++) {
          let fluteNotesInBar = 0;
          const chord = getChordForBar(theme, "battle", bar);

          for (let step = 0; step < 16; step++) {
            const ev = planner.planStep(theme, "battle", bar, step, true, false);
            expect(ev.humanizeSec).toBeGreaterThanOrEqual(-0.015);
            expect(ev.humanizeSec).toBeLessThanOrEqual(0.015);

            if (ev.fluteMidi !== null) {
              fluteNotesInBar++;
              expect(chord.melodyScale).toContain(ev.fluteMidi);
              expect(ev.fluteDurationSteps).toBeGreaterThanOrEqual(2);
            }
            if (ev.pluckMidi !== null) {
              expect(chord.pluckNotes).toContain(ev.pluckMidi);
            }

            if (bar < 8) {
              firstHalfContour.push(ev.fluteMidi);
            } else {
              secondHalfContour.push(ev.fluteMidi);
            }
          }

          if (fluteNotesInBar === 0) {
            silentFluteBars++;
          } else {
            activeFluteBars++;
          }
        }

        expect(silentFluteBars / 16).toBeGreaterThanOrEqual(0.3);
        expect(activeFluteBars).toBeGreaterThanOrEqual(4);
        expect(firstHalfContour).not.toEqual(secondHalfContour);
      }
    });

    it("clamps humanizeSec within [-0.015, 0.015] and mutes percussion in calm moods", () => {
      const planner = new GenerativePhrasePlanner(99);
      for (const mood of ALL_MOODS) {
        for (let bar = 0; bar < 4; bar++) {
          for (let step = 0; step < 16; step++) {
            const ev = planner.planStep("canyon_arch", mood, bar, step, true, false);
            expect(Number.isFinite(ev.humanizeSec)).toBe(true);
            expect(ev.humanizeSec).toBeGreaterThanOrEqual(-0.015);
            expect(ev.humanizeSec).toBeLessThanOrEqual(0.015);
            expect(ev.pluckPan).toBeGreaterThanOrEqual(-1);
            expect(ev.pluckPan).toBeLessThanOrEqual(1);

            if (mood === "lobby" || mood === "shop" || mood === "defeat") {
              expect(ev.frameDrumGain).toBe(0);
              expect(ev.shakerGain).toBe(0);
              expect(ev.timpaniGain).toBe(0);
              expect(ev.timpaniMidi).toBeNull();
            }
          }
        }
      }
    });
  });
});
