import { createSeededRng, type ThemeId } from "@critter/shared";
import type {
  BiomePalette,
  ChordVoicing,
  MusicGameplayContext,
  MusicMood,
  PlannedStepEvent,
  StemMixTargets,
} from "./musicTypes.js";

const DEFAULT_PLANNER_SEED = 0x5e1e9a41;
const STEPS_PER_BAR = 16;
const MAX_HUMANIZE_SEC = 0.015;

export const MOOD_TARGET_BPM: Readonly<Record<MusicMood, number>> = {
  lobby: 74,
  shop: 72,
  battle: 86,
  intense: 102,
  flood: 114,
  victory: 80,
  defeat: 68,
};

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

function atSafe<T>(arr: readonly T[], index: number, fallback: T): T {
  const len = arr.length;
  if (len === 0) {
    return fallback;
  }
  const normalized = ((Math.floor(index) % len) + len) % len;
  return arr[normalized] ?? fallback;
}

function transpose(base: number, intervals: readonly number[]): readonly number[] {
  return intervals.map((offset) => base + offset);
}

function makeChord(
  name: string,
  rootMidi: number,
  padBase: number,
  padIntervals: readonly number[],
  pluckBase: number,
  pluckIntervals: readonly number[],
  melodyScale: readonly number[],
): ChordVoicing {
  return {
    name,
    rootMidi,
    padNotes: transpose(padBase, padIntervals),
    pluckNotes: transpose(pluckBase, pluckIntervals),
    melodyScale,
  };
}

// Wide open orchestral voicings (root + 5th + 9th/3rd/7th/11th spread >= 15 semitones)
const OPEN_MAJ9 = [0, 7, 14, 16, 23] as const;
const OPEN_ADD9 = [0, 7, 14, 16, 19] as const;
const OPEN_SUS2 = [0, 7, 12, 14, 19] as const;
const OPEN_M9 = [0, 7, 14, 15, 22] as const;
const OPEN_M11 = [0, 7, 15, 17, 22] as const;
const OPEN_MAJ7_SHARP11 = [0, 7, 16, 18, 23] as const;
const OPEN_7SUS4 = [0, 7, 10, 14, 17] as const;
const OPEN_6_9 = [0, 7, 9, 14, 16] as const;
const OPEN_M_MAJ9 = [0, 7, 14, 15, 23] as const;
const OPEN_7B9SUS4 = [0, 7, 10, 13, 17] as const;

// Sparkling upper-mid harp/lute arpeggio intervals
const PLUCK_MAJ9 = [0, 7, 12, 14, 16, 19] as const;
const PLUCK_M9 = [0, 7, 12, 14, 15, 19] as const;
const PLUCK_SUS2 = [0, 7, 12, 14, 19, 24] as const;
const PLUCK_LYDIAN = [0, 7, 11, 14, 18, 21] as const;
const PLUCK_TENSE = [0, 7, 10, 14, 15, 19] as const;

// Modal flute scales in singing concert-flute register (G4..A5)
const D_LYDIAN_FLUTE = [69, 71, 73, 74, 76, 78, 80, 81] as const;
const D_DORIAN_FLUTE = [69, 71, 72, 74, 76, 77, 79, 81] as const;
const D_AEOLIAN_FLUTE = [69, 70, 72, 74, 76, 77, 79, 81] as const;
const D_PHRYGIAN_FLUTE = [69, 70, 72, 74, 75, 77, 79, 81] as const;

const A_DORIAN_FLUTE = [69, 71, 72, 74, 76, 78, 79, 81] as const;
const A_PHRYGIAN_FLUTE = [69, 70, 72, 74, 76, 77, 79, 81] as const;
const A_LYDIAN_FLUTE = [69, 71, 73, 75, 76, 78, 80, 81] as const;
const A_AEOLIAN_FLUTE = [69, 71, 72, 74, 76, 77, 79, 81] as const;

const F_LYDIAN_FLUTE = [69, 71, 72, 74, 76, 77, 79, 81] as const;
const F_DORIAN_FLUTE = [68, 70, 72, 74, 75, 77, 79, 80] as const;
const F_AEOLIAN_FLUTE = [68, 70, 72, 73, 75, 77, 79, 80] as const;
const F_PHRYGIAN_FLUTE = [68, 70, 72, 73, 75, 77, 78, 80] as const;

const G_DORIAN_FLUTE = [67, 69, 70, 72, 74, 76, 77, 79] as const;
const G_AEOLIAN_FLUTE = [67, 69, 70, 72, 74, 75, 77, 79] as const;
const G_PHRYGIAN_FLUTE = [67, 68, 70, 72, 74, 75, 77, 79] as const;
const G_LYDIAN_FLUTE = [67, 69, 71, 73, 74, 76, 78, 79] as const;

const BIOME_PALETTES: Readonly<Record<ThemeId, BiomePalette>> = {
  // Emerald Spire: D Lydian / D Dorian (tonic D4 = 62) — sunlit woodland & misty ruins
  emerald_spire: {
    theme: "emerald_spire",
    tonicMidi: 62,
    calmChords: [
      makeChord("Dmaj9", 38, 50, OPEN_MAJ9, 57, PLUCK_MAJ9, D_LYDIAN_FLUTE),
      makeChord("Eadd9/D", 38, 52, OPEN_ADD9, 52, PLUCK_MAJ9, D_LYDIAN_FLUTE),
      makeChord("Bm9", 47, 47, OPEN_M9, 59, PLUCK_M9, D_LYDIAN_FLUTE),
      makeChord("F#m11", 42, 42, OPEN_M11, 54, PLUCK_M9, D_LYDIAN_FLUTE),
      makeChord("Gmaj7#11", 43, 43, OPEN_MAJ7_SHARP11, 55, PLUCK_LYDIAN, D_LYDIAN_FLUTE),
      makeChord("Dadd9", 38, 50, OPEN_ADD9, 62, PLUCK_SUS2, D_LYDIAN_FLUTE),
      makeChord("Em9", 40, 40, OPEN_M9, 59, PLUCK_M9, D_LYDIAN_FLUTE),
      makeChord("A7sus4", 45, 45, OPEN_7SUS4, 57, PLUCK_SUS2, D_LYDIAN_FLUTE),
    ],
    battleChords: [
      makeChord("Dm9", 38, 50, OPEN_M9, 62, PLUCK_M9, D_DORIAN_FLUTE),
      makeChord("Gadd9", 43, 43, OPEN_ADD9, 55, PLUCK_MAJ9, D_DORIAN_FLUTE),
      makeChord("Cmaj9", 36, 48, OPEN_MAJ9, 60, PLUCK_MAJ9, D_DORIAN_FLUTE),
      makeChord("Am9", 45, 45, OPEN_M9, 57, PLUCK_M9, D_DORIAN_FLUTE),
      makeChord("Fmaj9", 41, 41, OPEN_MAJ9, 53, PLUCK_MAJ9, D_DORIAN_FLUTE),
      makeChord("Em11", 40, 40, OPEN_M11, 52, PLUCK_M9, D_DORIAN_FLUTE),
      makeChord("Bbmaj7#11", 46, 46, OPEN_MAJ7_SHARP11, 58, PLUCK_LYDIAN, D_AEOLIAN_FLUTE),
      makeChord("Asus2", 45, 45, OPEN_SUS2, 57, PLUCK_SUS2, D_DORIAN_FLUTE),
    ],
    intenseChords: [
      makeChord("Dm9", 38, 50, OPEN_M9, 62, PLUCK_TENSE, D_AEOLIAN_FLUTE),
      makeChord("Bbmaj9", 46, 46, OPEN_MAJ9, 58, PLUCK_MAJ9, D_AEOLIAN_FLUTE),
      makeChord("Gm11", 43, 43, OPEN_M11, 55, PLUCK_TENSE, D_AEOLIAN_FLUTE),
      makeChord("Cadd9", 36, 48, OPEN_ADD9, 60, PLUCK_SUS2, D_AEOLIAN_FLUTE),
      makeChord("Ebmaj7#11", 39, 51, OPEN_MAJ7_SHARP11, 63, PLUCK_LYDIAN, D_PHRYGIAN_FLUTE),
      makeChord("A7b9sus4", 45, 45, OPEN_7B9SUS4, 57, PLUCK_TENSE, D_PHRYGIAN_FLUTE),
    ],
    floodChords: [
      makeChord("Dm11", 38, 50, OPEN_M11, 62, PLUCK_TENSE, D_PHRYGIAN_FLUTE),
      makeChord("Ebmaj7#11", 39, 51, OPEN_MAJ7_SHARP11, 63, PLUCK_LYDIAN, D_PHRYGIAN_FLUTE),
      makeChord("Gm(maj9)", 43, 43, OPEN_M_MAJ9, 55, PLUCK_TENSE, D_PHRYGIAN_FLUTE),
      makeChord("Abmaj7#11", 44, 44, OPEN_MAJ7_SHARP11, 56, PLUCK_LYDIAN, D_PHRYGIAN_FLUTE),
    ],
    victoryChords: [
      makeChord("Dmaj9", 38, 50, OPEN_MAJ9, 62, PLUCK_MAJ9, D_LYDIAN_FLUTE),
      makeChord("Gmaj9", 43, 43, OPEN_MAJ9, 55, PLUCK_MAJ9, D_LYDIAN_FLUTE),
      makeChord("Bm11", 47, 47, OPEN_M11, 59, PLUCK_M9, D_LYDIAN_FLUTE),
      makeChord("Aadd9", 45, 45, OPEN_ADD9, 57, PLUCK_SUS2, D_LYDIAN_FLUTE),
    ],
    defeatChords: [
      makeChord("Dm9", 38, 50, OPEN_M9, 62, PLUCK_M9, D_AEOLIAN_FLUTE),
      makeChord("Bbmaj9", 46, 46, OPEN_MAJ9, 58, PLUCK_MAJ9, D_AEOLIAN_FLUTE),
      makeChord("Gm9", 43, 43, OPEN_M9, 55, PLUCK_M9, D_AEOLIAN_FLUTE),
      makeChord("Asus2", 45, 45, OPEN_SUS2, 57, PLUCK_SUS2, D_AEOLIAN_FLUTE),
    ],
    timbreBias: {
      pad: 1.04,
      pluck: 1.08,
      flute: 1.12,
      cello: 0.96,
      percussion: 0.92,
    },
  },

  // Canyon Arch: A Dorian / A Phrygian (tonic A3 = 57) — warm terracotta winds & arches
  canyon_arch: {
    theme: "canyon_arch",
    tonicMidi: 57,
    calmChords: [
      makeChord("Am9", 45, 45, OPEN_M9, 57, PLUCK_M9, A_DORIAN_FLUTE),
      makeChord("Dadd9", 38, 50, OPEN_ADD9, 62, PLUCK_MAJ9, A_DORIAN_FLUTE),
      makeChord("Fmaj7#11", 41, 41, OPEN_MAJ7_SHARP11, 53, PLUCK_LYDIAN, A_AEOLIAN_FLUTE),
      makeChord("G6/9", 43, 43, OPEN_6_9, 55, PLUCK_SUS2, A_DORIAN_FLUTE),
      makeChord("Em11", 40, 40, OPEN_M11, 52, PLUCK_M9, A_DORIAN_FLUTE),
      makeChord("Am9", 45, 45, OPEN_M9, 57, PLUCK_M9, A_DORIAN_FLUTE),
      makeChord("Cmaj9", 36, 48, OPEN_MAJ9, 60, PLUCK_MAJ9, A_DORIAN_FLUTE),
      makeChord("Esus2", 40, 40, OPEN_SUS2, 52, PLUCK_SUS2, A_DORIAN_FLUTE),
    ],
    battleChords: [
      makeChord("Am9", 45, 45, OPEN_M9, 57, PLUCK_M9, A_DORIAN_FLUTE),
      makeChord("D7sus4", 38, 50, OPEN_7SUS4, 62, PLUCK_SUS2, A_DORIAN_FLUTE),
      makeChord("Bbmaj7#11", 46, 46, OPEN_MAJ7_SHARP11, 58, PLUCK_LYDIAN, A_PHRYGIAN_FLUTE),
      makeChord("Am9", 45, 45, OPEN_M9, 57, PLUCK_TENSE, A_PHRYGIAN_FLUTE),
      makeChord("Fmaj9", 41, 41, OPEN_MAJ9, 53, PLUCK_MAJ9, A_AEOLIAN_FLUTE),
      makeChord("Gadd9", 43, 43, OPEN_ADD9, 55, PLUCK_MAJ9, A_DORIAN_FLUTE),
      makeChord("Em9", 40, 40, OPEN_M9, 52, PLUCK_M9, A_DORIAN_FLUTE),
      makeChord("E7b9sus4", 40, 40, OPEN_7B9SUS4, 52, PLUCK_TENSE, A_PHRYGIAN_FLUTE),
    ],
    intenseChords: [
      makeChord("Am11", 45, 45, OPEN_M11, 57, PLUCK_TENSE, A_PHRYGIAN_FLUTE),
      makeChord("Bbmaj9", 46, 46, OPEN_MAJ9, 58, PLUCK_LYDIAN, A_PHRYGIAN_FLUTE),
      makeChord("Gm9", 43, 43, OPEN_M9, 55, PLUCK_TENSE, A_PHRYGIAN_FLUTE),
      makeChord("Fmaj7#11", 41, 41, OPEN_MAJ7_SHARP11, 53, PLUCK_LYDIAN, A_PHRYGIAN_FLUTE),
      makeChord("Dm11", 38, 50, OPEN_M11, 62, PLUCK_TENSE, A_PHRYGIAN_FLUTE),
      makeChord("E7b9sus4", 40, 40, OPEN_7B9SUS4, 52, PLUCK_TENSE, A_PHRYGIAN_FLUTE),
    ],
    floodChords: [
      makeChord("Am11", 45, 45, OPEN_M11, 57, PLUCK_TENSE, A_PHRYGIAN_FLUTE),
      makeChord("Bbmaj7#11", 46, 46, OPEN_MAJ7_SHARP11, 58, PLUCK_LYDIAN, A_PHRYGIAN_FLUTE),
      makeChord("Cm(maj9)", 36, 48, OPEN_M_MAJ9, 60, PLUCK_TENSE, A_PHRYGIAN_FLUTE),
      makeChord("Ebmaj7#11", 39, 51, OPEN_MAJ7_SHARP11, 63, PLUCK_LYDIAN, A_PHRYGIAN_FLUTE),
    ],
    victoryChords: [
      makeChord("Amaj9", 45, 45, OPEN_MAJ9, 57, PLUCK_MAJ9, A_LYDIAN_FLUTE),
      makeChord("Dmaj9", 38, 50, OPEN_MAJ9, 62, PLUCK_MAJ9, A_LYDIAN_FLUTE),
      makeChord("F#m11", 42, 42, OPEN_M11, 54, PLUCK_M9, A_LYDIAN_FLUTE),
      makeChord("Eadd9", 40, 40, OPEN_ADD9, 52, PLUCK_SUS2, A_LYDIAN_FLUTE),
    ],
    defeatChords: [
      makeChord("Am9", 45, 45, OPEN_M9, 57, PLUCK_M9, A_AEOLIAN_FLUTE),
      makeChord("Fmaj9", 41, 41, OPEN_MAJ9, 53, PLUCK_MAJ9, A_AEOLIAN_FLUTE),
      makeChord("Dm9", 38, 50, OPEN_M9, 62, PLUCK_M9, A_AEOLIAN_FLUTE),
      makeChord("Esus2", 40, 40, OPEN_SUS2, 52, PLUCK_SUS2, A_AEOLIAN_FLUTE),
    ],
    timbreBias: {
      pad: 0.96,
      pluck: 1.1,
      flute: 0.96,
      cello: 1.08,
      percussion: 1.12,
    },
  },

  // Twin Pillars: F Lydian / F Minor (tonic F4 = 65) — sweeping sky-sea cliffs
  twin_pillars: {
    theme: "twin_pillars",
    tonicMidi: 65,
    calmChords: [
      makeChord("Fmaj9", 41, 41, OPEN_MAJ9, 53, PLUCK_MAJ9, F_LYDIAN_FLUTE),
      makeChord("Gadd9/F", 41, 43, OPEN_ADD9, 55, PLUCK_MAJ9, F_LYDIAN_FLUTE),
      makeChord("Dm11", 38, 50, OPEN_M11, 62, PLUCK_M9, F_LYDIAN_FLUTE),
      makeChord("Am9", 45, 45, OPEN_M9, 57, PLUCK_M9, F_LYDIAN_FLUTE),
      makeChord("Bbmaj7#11", 46, 46, OPEN_MAJ7_SHARP11, 58, PLUCK_LYDIAN, F_LYDIAN_FLUTE),
      makeChord("Cadd9", 36, 48, OPEN_ADD9, 60, PLUCK_MAJ9, F_LYDIAN_FLUTE),
      makeChord("Gm11", 43, 43, OPEN_M11, 55, PLUCK_M9, F_LYDIAN_FLUTE),
      makeChord("Csus2", 36, 48, OPEN_SUS2, 60, PLUCK_SUS2, F_LYDIAN_FLUTE),
    ],
    battleChords: [
      makeChord("Fm9", 41, 41, OPEN_M9, 53, PLUCK_M9, F_DORIAN_FLUTE),
      makeChord("Bbadd9", 46, 46, OPEN_ADD9, 58, PLUCK_MAJ9, F_DORIAN_FLUTE),
      makeChord("Ebmaj9", 39, 51, OPEN_MAJ9, 63, PLUCK_MAJ9, F_DORIAN_FLUTE),
      makeChord("Cm11", 36, 48, OPEN_M11, 60, PLUCK_M9, F_DORIAN_FLUTE),
      makeChord("Dbmaj7#11", 37, 49, OPEN_MAJ7_SHARP11, 61, PLUCK_LYDIAN, F_AEOLIAN_FLUTE),
      makeChord("Fm9", 41, 41, OPEN_M9, 53, PLUCK_TENSE, F_AEOLIAN_FLUTE),
      makeChord("Bbm11", 46, 46, OPEN_M11, 58, PLUCK_M9, F_AEOLIAN_FLUTE),
      makeChord("C7sus4", 36, 48, OPEN_7SUS4, 60, PLUCK_SUS2, F_AEOLIAN_FLUTE),
    ],
    intenseChords: [
      makeChord("Fm11", 41, 41, OPEN_M11, 53, PLUCK_TENSE, F_AEOLIAN_FLUTE),
      makeChord("Dbmaj7#11", 37, 49, OPEN_MAJ7_SHARP11, 61, PLUCK_LYDIAN, F_AEOLIAN_FLUTE),
      makeChord("Bbm11", 46, 46, OPEN_M11, 58, PLUCK_TENSE, F_AEOLIAN_FLUTE),
      makeChord("Ebsus2", 39, 51, OPEN_SUS2, 63, PLUCK_SUS2, F_AEOLIAN_FLUTE),
      makeChord("Gbmaj7#11", 42, 42, OPEN_MAJ7_SHARP11, 54, PLUCK_LYDIAN, F_PHRYGIAN_FLUTE),
      makeChord("C7b9sus4", 36, 48, OPEN_7B9SUS4, 60, PLUCK_TENSE, F_PHRYGIAN_FLUTE),
    ],
    floodChords: [
      makeChord("Fm11", 41, 41, OPEN_M11, 53, PLUCK_TENSE, F_PHRYGIAN_FLUTE),
      makeChord("Gbmaj7#11", 42, 42, OPEN_MAJ7_SHARP11, 54, PLUCK_LYDIAN, F_PHRYGIAN_FLUTE),
      makeChord("Abm9", 44, 44, OPEN_M9, 56, PLUCK_TENSE, F_PHRYGIAN_FLUTE),
      makeChord("Bbm(maj9)", 46, 46, OPEN_M_MAJ9, 58, PLUCK_TENSE, F_PHRYGIAN_FLUTE),
    ],
    victoryChords: [
      makeChord("Fmaj9", 41, 41, OPEN_MAJ9, 53, PLUCK_MAJ9, F_LYDIAN_FLUTE),
      makeChord("Gadd9", 43, 43, OPEN_ADD9, 55, PLUCK_MAJ9, F_LYDIAN_FLUTE),
      makeChord("Dm9", 38, 50, OPEN_M9, 62, PLUCK_M9, F_LYDIAN_FLUTE),
      makeChord("Cadd9", 36, 48, OPEN_ADD9, 60, PLUCK_SUS2, F_LYDIAN_FLUTE),
    ],
    defeatChords: [
      makeChord("Fm9", 41, 41, OPEN_M9, 53, PLUCK_M9, F_AEOLIAN_FLUTE),
      makeChord("Dbmaj9", 37, 49, OPEN_MAJ9, 61, PLUCK_MAJ9, F_AEOLIAN_FLUTE),
      makeChord("Bbm9", 46, 46, OPEN_M9, 58, PLUCK_M9, F_AEOLIAN_FLUTE),
      makeChord("Csus2", 36, 48, OPEN_SUS2, 60, PLUCK_SUS2, F_AEOLIAN_FLUTE),
    ],
    timbreBias: {
      pad: 1.1,
      pluck: 1.12,
      flute: 1.06,
      cello: 1.0,
      percussion: 0.94,
    },
  },

  // Mountain Spine: G Dorian / G Aeolian (tonic G3 = 55) — noble alpine crags & caverns
  mountain_spine: {
    theme: "mountain_spine",
    tonicMidi: 55,
    calmChords: [
      makeChord("Gm9", 43, 43, OPEN_M9, 55, PLUCK_M9, G_DORIAN_FLUTE),
      makeChord("Cadd9", 36, 48, OPEN_ADD9, 60, PLUCK_MAJ9, G_DORIAN_FLUTE),
      makeChord("Ebmaj9", 39, 51, OPEN_MAJ9, 63, PLUCK_MAJ9, G_AEOLIAN_FLUTE),
      makeChord("Dm11", 38, 50, OPEN_M11, 62, PLUCK_M9, G_DORIAN_FLUTE),
      makeChord("F6/9", 41, 41, OPEN_6_9, 53, PLUCK_SUS2, G_DORIAN_FLUTE),
      makeChord("Gm9", 43, 43, OPEN_M9, 55, PLUCK_M9, G_DORIAN_FLUTE),
      makeChord("Bbmaj7#11", 46, 46, OPEN_MAJ7_SHARP11, 58, PLUCK_LYDIAN, G_DORIAN_FLUTE),
      makeChord("Dsus2", 38, 50, OPEN_SUS2, 62, PLUCK_SUS2, G_DORIAN_FLUTE),
    ],
    battleChords: [
      makeChord("Gm9", 43, 43, OPEN_M9, 55, PLUCK_M9, G_DORIAN_FLUTE),
      makeChord("Cm11", 36, 48, OPEN_M11, 60, PLUCK_M9, G_AEOLIAN_FLUTE),
      makeChord("Fadd9", 41, 41, OPEN_ADD9, 53, PLUCK_MAJ9, G_DORIAN_FLUTE),
      makeChord("Dm9", 38, 50, OPEN_M9, 62, PLUCK_M9, G_DORIAN_FLUTE),
      makeChord("Ebmaj7#11", 39, 51, OPEN_MAJ7_SHARP11, 63, PLUCK_LYDIAN, G_AEOLIAN_FLUTE),
      makeChord("Gm9", 43, 43, OPEN_M9, 55, PLUCK_TENSE, G_AEOLIAN_FLUTE),
      makeChord("Cm9", 36, 48, OPEN_M9, 60, PLUCK_M9, G_AEOLIAN_FLUTE),
      makeChord("D7sus4", 38, 50, OPEN_7SUS4, 62, PLUCK_SUS2, G_AEOLIAN_FLUTE),
    ],
    intenseChords: [
      makeChord("Gm11", 43, 43, OPEN_M11, 55, PLUCK_TENSE, G_AEOLIAN_FLUTE),
      makeChord("Ebmaj9", 39, 51, OPEN_MAJ9, 63, PLUCK_LYDIAN, G_AEOLIAN_FLUTE),
      makeChord("Cm11", 36, 48, OPEN_M11, 60, PLUCK_TENSE, G_AEOLIAN_FLUTE),
      makeChord("Abmaj7#11", 44, 44, OPEN_MAJ7_SHARP11, 56, PLUCK_LYDIAN, G_PHRYGIAN_FLUTE),
      makeChord("Fm9", 41, 41, OPEN_M9, 53, PLUCK_TENSE, G_PHRYGIAN_FLUTE),
      makeChord("D7b9sus4", 38, 50, OPEN_7B9SUS4, 62, PLUCK_TENSE, G_PHRYGIAN_FLUTE),
    ],
    floodChords: [
      makeChord("Gm11", 43, 43, OPEN_M11, 55, PLUCK_TENSE, G_PHRYGIAN_FLUTE),
      makeChord("Abmaj7#11", 44, 44, OPEN_MAJ7_SHARP11, 56, PLUCK_LYDIAN, G_PHRYGIAN_FLUTE),
      makeChord("Bbm(maj9)", 46, 46, OPEN_M_MAJ9, 58, PLUCK_TENSE, G_PHRYGIAN_FLUTE),
      makeChord("Dbmaj7#11", 37, 49, OPEN_MAJ7_SHARP11, 61, PLUCK_LYDIAN, G_PHRYGIAN_FLUTE),
    ],
    victoryChords: [
      makeChord("Gmaj9", 43, 43, OPEN_MAJ9, 55, PLUCK_MAJ9, G_LYDIAN_FLUTE),
      makeChord("Cmaj9", 36, 48, OPEN_MAJ9, 60, PLUCK_MAJ9, G_LYDIAN_FLUTE),
      makeChord("Em11", 40, 40, OPEN_M11, 52, PLUCK_M9, G_LYDIAN_FLUTE),
      makeChord("Dadd9", 38, 50, OPEN_ADD9, 62, PLUCK_SUS2, G_LYDIAN_FLUTE),
    ],
    defeatChords: [
      makeChord("Gm9", 43, 43, OPEN_M9, 55, PLUCK_M9, G_AEOLIAN_FLUTE),
      makeChord("Ebmaj9", 39, 51, OPEN_MAJ9, 63, PLUCK_MAJ9, G_AEOLIAN_FLUTE),
      makeChord("Cm9", 36, 48, OPEN_M9, 60, PLUCK_M9, G_AEOLIAN_FLUTE),
      makeChord("Dsus2", 38, 50, OPEN_SUS2, 62, PLUCK_SUS2, G_AEOLIAN_FLUTE),
    ],
    timbreBias: {
      pad: 1.06,
      pluck: 0.94,
      flute: 0.98,
      cello: 1.16,
      percussion: 1.08,
    },
  },
};

interface MoodStemDefaults {
  readonly pad: number;
  readonly pluck: number;
  readonly cello: number;
  readonly flute: number;
  readonly percussion: number;
  readonly filterHz: number;
  readonly reverbWet: number;
}

const MOOD_STEM_DEFAULTS: Readonly<Record<MusicMood, MoodStemDefaults>> = {
  lobby: {
    pad: 0.84,
    pluck: 0.66,
    cello: 0.44,
    flute: 0.62,
    percussion: 0,
    filterHz: 11800,
    reverbWet: 0.44,
  },
  shop: {
    pad: 0.78,
    pluck: 0.52,
    cello: 0.36,
    flute: 0.4,
    percussion: 0,
    filterHz: 1350,
    reverbWet: 0.48,
  },
  battle: {
    pad: 0.76,
    pluck: 0.78,
    cello: 0.68,
    flute: 0.72,
    percussion: 0.68,
    filterHz: 14800,
    reverbWet: 0.32,
  },
  intense: {
    pad: 0.82,
    pluck: 0.8,
    cello: 0.84,
    flute: 0.78,
    percussion: 0.86,
    filterHz: 16000,
    reverbWet: 0.28,
  },
  flood: {
    pad: 0.88,
    pluck: 0.72,
    cello: 0.92,
    flute: 0.74,
    percussion: 0.94,
    filterHz: 16600,
    reverbWet: 0.36,
  },
  victory: {
    pad: 0.9,
    pluck: 0.76,
    cello: 0.62,
    flute: 0.86,
    percussion: 0.22,
    filterHz: 14600,
    reverbWet: 0.46,
  },
  defeat: {
    pad: 0.82,
    pluck: 0.44,
    cello: 0.76,
    flute: 0.54,
    percussion: 0,
    filterHz: 7800,
    reverbWet: 0.54,
  },
};

export function createDefaultMusicContext(): MusicGameplayContext {
  return {
    mood: "lobby",
    theme: "emerald_spire",
    round: 1,
    maxRounds: 5,
    isMyTurn: true,
    isCharging: false,
    chargePower: 0,
    isShotFlight: false,
    isDroneView: false,
    hpRatio: 1,
    windSpeed: 0,
    waterLevel: 0,
    floodIntensity: 0,
    isShowdown: false,
  };
}

export function midiToFreq(midi: number): number {
  const safeMidi = safeClamp(midi, -24, 144, 69);
  return 440 * Math.pow(2, (safeMidi - 69) / 12);
}

export function getBiomePalette(theme: ThemeId): BiomePalette {
  return BIOME_PALETTES[theme] ?? BIOME_PALETTES.emerald_spire;
}

export function getChordForBar(
  theme: ThemeId,
  mood: MusicMood,
  barIndex: number,
): ChordVoicing {
  const palette = getBiomePalette(theme);
  let progression: readonly ChordVoicing[];
  switch (mood) {
    case "lobby":
    case "shop":
      progression = palette.calmChords;
      break;
    case "battle":
      progression = palette.battleChords;
      break;
    case "intense":
      progression = palette.intenseChords;
      break;
    case "flood":
      progression = palette.floodChords;
      break;
    case "victory":
      progression = palette.victoryChords;
      break;
    case "defeat":
      progression = palette.defeatChords;
      break;
  }

  const safeBar = Number.isFinite(barIndex) ? Math.floor(barIndex) : 0;
  const fallback = palette.calmChords[0];
  if (fallback === undefined) {
    throw new Error("Biome palette must define at least one calm chord.");
  }
  return atSafe(progression, safeBar, fallback);
}

export function computeStemMixTargets(ctx: MusicGameplayContext): StemMixTargets {
  const palette = getBiomePalette(ctx.theme);
  const base = MOOD_STEM_DEFAULTS[ctx.mood] ?? MOOD_STEM_DEFAULTS.lobby;

  const round = safeClamp(ctx.round, 1, 99, 1);
  const maxRounds = safeClamp(ctx.maxRounds, 1, 99, 5);
  const roundProgress =
    maxRounds > 1 ? clamp((round - 1) / (maxRounds - 1), 0, 1) : 0;
  const chargePower = safeClamp(ctx.chargePower, 0, 1, 0);
  const hpRatio = safeClamp(ctx.hpRatio, 0, 1, 1);
  const windNorm = safeClamp(Math.abs(ctx.windSpeed), 0, 20, 0) / 20;
  const floodIntensity = safeClamp(ctx.floodIntensity, 0, 1, 0);

  // Subtle biome timbre coloring (keeps zero stems strictly zero)
  let pad = base.pad * (0.85 + 0.15 * palette.timbreBias.pad);
  let pluck = base.pluck * (0.85 + 0.15 * palette.timbreBias.pluck);
  let cello = base.cello * (0.85 + 0.15 * palette.timbreBias.cello);
  let flute = base.flute * (0.85 + 0.15 * palette.timbreBias.flute);
  let percussion = base.percussion * (0.85 + 0.15 * palette.timbreBias.percussion);
  let filterHz = base.filterHz;
  let reverbWet = base.reverbWet + windNorm * 0.04;

  const isActiveCombat =
    ctx.mood === "battle" || ctx.mood === "intense" || ctx.mood === "flood";

  if (isActiveCombat) {
    cello += roundProgress * 0.1;
    if (percussion > 0) {
      percussion += roundProgress * 0.12;
    }

    if (hpRatio < 0.4) {
      const lowHpUrgency = (0.4 - hpRatio) / 0.4;
      cello += lowHpUrgency * 0.14;
      pad += lowHpUrgency * 0.05;
    }

    if (ctx.isShowdown) {
      cello += 0.12;
      if (percussion > 0) {
        percussion += 0.1;
      }
      filterHz += 600;
    }

    if (floodIntensity > 0) {
      pad += floodIntensity * 0.08;
      cello += floodIntensity * 0.12;
      if (percussion > 0) {
        percussion += floodIntensity * 0.12;
      }
      reverbWet += floodIntensity * 0.06;
    }
  }

  // Turn ownership softens rival turns so player turns feel poised and expressive
  if (!ctx.isMyTurn) {
    flute *= 0.62;
    percussion *= 0.72;
    filterHz *= 0.88;
  }

  // Shot charge shimmer engages cleanly above 50% power
  const chargeShimmer =
    ctx.isCharging && chargePower > 0.5
      ? clamp((chargePower - 0.5) / 0.5, 0, 1)
      : 0;
  if (chargeShimmer > 0) {
    flute *= 1 - 0.2 * chargeShimmer;
  }

  // Suspended breath during projectile flight (>=45% percussion pullback + airy reverb)
  if (ctx.isShotFlight) {
    percussion *= 0.38;
    pluck *= 0.78;
    pad *= 1.08;
    reverbWet += 0.18;
  }

  // High aerial spaciousness in Tactical Drone Recon view
  if (ctx.isDroneView) {
    percussion *= 0.52;
    cello *= 0.84;
    pad *= 1.06;
    reverbWet += 0.14;
  }

  // Shop guarantees warm low-pass intimacy and zero percussion
  if (ctx.mood === "shop") {
    percussion = 0;
    filterHz = Math.min(filterHz, 1350);
  }

  return {
    pad: clamp(pad, 0, 1),
    pluck: clamp(pluck, 0, 1),
    cello: clamp(cello, 0, 1),
    flute: clamp(flute, 0, 1),
    percussion: clamp(percussion, 0, 1),
    chargeShimmer: clamp(chargeShimmer, 0, 1),
    filterHz: clamp(filterHz, 600, 18000),
    reverbWet: clamp(reverbWet, 0.08, 0.85),
  };
}

interface FluteNoteSlot {
  readonly midi: number;
  readonly durationSteps: number;
  readonly velocity: number;
}

interface PluckNoteSlot {
  readonly midi: number;
  readonly velocity: number;
  readonly pan: number;
}

interface CelloNoteSlot {
  readonly midi: number;
  readonly durationSteps: number;
}

interface PercussionSlot {
  readonly frameDrumGain: number;
  readonly shakerGain: number;
  readonly timpaniMidi: number | null;
  readonly timpaniGain: number;
}

interface CachedBarPlan {
  readonly key: string;
  readonly fluteByStep: ReadonlyArray<FluteNoteSlot | null>;
  readonly pluckByStep: ReadonlyArray<PluckNoteSlot | null>;
  readonly celloByStep: ReadonlyArray<CelloNoteSlot | null>;
  readonly percByStep: readonly PercussionSlot[];
  readonly humanizeByStep: readonly number[];
}

// Expressive lyrical flute rhythm templates: [stepInBar, durationSteps]
const FLUTE_RHYTHM_TEMPLATES: readonly (readonly (readonly [number, number])[])[] = [
  [
    [0, 6],
    [8, 6],
  ],
  [
    [2, 6],
    [10, 5],
  ],
  [
    [0, 4],
    [6, 4],
    [12, 4],
  ],
  [[4, 8]],
  [
    [0, 3],
    [4, 5],
    [10, 6],
  ],
  [
    [2, 4],
    [8, 7],
  ],
];

// Organic harp arpeggio step patterns (indices into chord.pluckNotes)
const PLUCK_PATTERNS: readonly (readonly (readonly [number, number])[])[] = [
  // Rising woodland ripple
  [
    [0, 0],
    [2, 1],
    [4, 2],
    [6, 3],
    [8, 4],
    [10, 5],
    [12, 3],
    [14, 2],
  ],
  // Broken arch
  [
    [0, 0],
    [3, 2],
    [6, 4],
    [8, 3],
    [11, 5],
    [14, 1],
  ],
  // Open fifths sway
  [
    [0, 0],
    [4, 1],
    [6, 3],
    [8, 2],
    [12, 4],
    [14, 5],
  ],
  // Syncopated sunlit lilt
  [
    [0, 1],
    [2, 3],
    [5, 4],
    [8, 2],
    [10, 5],
    [13, 3],
  ],
];

const FLUTE_STEP_INTERVALS: readonly number[] = [-1, 1, 1, -1, 2, -2, 3, -3, 0];

const SILENT_PERC: PercussionSlot = {
  frameDrumGain: 0,
  shakerGain: 0,
  timpaniMidi: null,
  timpaniGain: 0,
};

export class GenerativePhrasePlanner {
  private seed: number;
  private rng: () => number;
  private cachedBar: CachedBarPlan | null = null;
  private lastFluteScaleIdx = 3;
  private lastFluteTemplateIdx = -1;
  private lastPluckPatternIdx = -1;
  private consecutiveFluteBars = 0;

  public constructor(seed: number = DEFAULT_PLANNER_SEED) {
    this.seed = Number.isFinite(seed) ? Math.floor(seed) : DEFAULT_PLANNER_SEED;
    this.rng = createSeededRng(this.seed);
  }

  public reset(seed?: number): void {
    if (seed !== undefined && Number.isFinite(seed)) {
      this.seed = Math.floor(seed);
    }
    this.rng = createSeededRng(this.seed);
    this.cachedBar = null;
    this.lastFluteScaleIdx = 3;
    this.lastFluteTemplateIdx = -1;
    this.lastPluckPatternIdx = -1;
    this.consecutiveFluteBars = 0;
  }

  public planStep(
    theme: ThemeId,
    mood: MusicMood,
    barIndex: number,
    stepInBar: number,
    isMyTurn: boolean,
    isShotFlight: boolean,
  ): PlannedStepEvent {
    const safeBar = Number.isFinite(barIndex) ? Math.floor(barIndex) : 0;
    const safeStep = Number.isFinite(stepInBar)
      ? (((Math.floor(stepInBar) % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR)
      : 0;
    const key = `${theme}:${mood}:${safeBar}`;

    if (this.cachedBar === null || this.cachedBar.key !== key) {
      this.cachedBar = this.buildBarPlan(key, theme, mood, safeBar);
    }

    const bar = this.cachedBar;
    const pluck = bar.pluckByStep[safeStep] ?? null;
    const flute = bar.fluteByStep[safeStep] ?? null;
    const cello = bar.celloByStep[safeStep] ?? null;
    const perc = bar.percByStep[safeStep] ?? SILENT_PERC;
    const humanizeSec = clamp(
      bar.humanizeByStep[safeStep] ?? 0,
      -MAX_HUMANIZE_SEC,
      MAX_HUMANIZE_SEC,
    );

    const turnFluteScale = isMyTurn ? 1 : 0.78;
    const flightFluteScale = isShotFlight ? 0.72 : 1;
    const turnPercScale = isMyTurn ? 1 : 0.72;
    const flightDrumScale = isShotFlight ? 0.2 : 1;
    const flightShakerScale = isShotFlight ? 0.15 : 1;
    const flightTimpaniScale = isShotFlight ? 0.25 : 1;

    const frameDrumGain = clamp(
      perc.frameDrumGain * turnPercScale * flightDrumScale,
      0,
      1,
    );
    const shakerGain = clamp(
      perc.shakerGain * turnPercScale * flightShakerScale,
      0,
      1,
    );
    const timpaniGain = clamp(
      perc.timpaniGain * turnPercScale * flightTimpaniScale,
      0,
      1,
    );

    return {
      pluckMidi: pluck ? pluck.midi : null,
      pluckVelocity: pluck ? clamp(pluck.velocity, 0, 1) : 0,
      pluckPan: pluck ? clamp(pluck.pan, -1, 1) : 0,
      fluteMidi: flute ? flute.midi : null,
      fluteDurationSteps: flute ? flute.durationSteps : 0,
      fluteVelocity: flute
        ? clamp(flute.velocity * turnFluteScale * flightFluteScale, 0, 1)
        : 0,
      celloMidi: cello ? cello.midi : null,
      celloDurationSteps: cello ? cello.durationSteps : 0,
      frameDrumGain,
      shakerGain,
      timpaniMidi: timpaniGain > 0 ? perc.timpaniMidi : null,
      timpaniGain,
      humanizeSec,
    };
  }

  private buildBarPlan(
    key: string,
    theme: ThemeId,
    mood: MusicMood,
    barIndex: number,
  ): CachedBarPlan {
    const chord = getChordForBar(theme, mood, barIndex);
    const fluteByStep: Array<FluteNoteSlot | null> = new Array<FluteNoteSlot | null>(
      STEPS_PER_BAR,
    ).fill(null);
    const pluckByStep: Array<PluckNoteSlot | null> = new Array<PluckNoteSlot | null>(
      STEPS_PER_BAR,
    ).fill(null);
    const celloByStep: Array<CelloNoteSlot | null> = new Array<CelloNoteSlot | null>(
      STEPS_PER_BAR,
    ).fill(null);
    const percByStep: PercussionSlot[] = new Array<PercussionSlot>(
      STEPS_PER_BAR,
    ).fill(SILENT_PERC);
    const humanizeByStep: number[] = new Array<number>(STEPS_PER_BAR).fill(0);

    // 1. Subtle micro-timing humanization per step (tighter on beat 1 downbeat)
    for (let step = 0; step < STEPS_PER_BAR; step++) {
      const spread = step === 0 ? 0.005 : step % 4 === 0 ? 0.009 : 0.013;
      const offset = (this.rng() * 2 - 1) * spread;
      humanizeByStep[step] = clamp(offset, -MAX_HUMANIZE_SEC, MAX_HUMANIZE_SEC);
    }

    // 2. Harp / lute pluck arpeggios
    this.populatePluck(pluckByStep, chord, mood, barIndex);

    // 3. Expressive breathing flute melody
    this.populateFlute(fluteByStep, chord, mood, barIndex);

    // 4. Warm bowed cello bass/baritone voice
    this.populateCello(celloByStep, chord, mood, barIndex);

    // 5. Organic earthy percussion (frame drum, shaker, timpani)
    this.populatePercussion(percByStep, chord, mood, barIndex);

    return {
      key,
      fluteByStep,
      pluckByStep,
      celloByStep,
      percByStep,
      humanizeByStep,
    };
  }

  private populatePluck(
    pluckByStep: Array<PluckNoteSlot | null>,
    chord: ChordVoicing,
    mood: MusicMood,
    barIndex: number,
  ): void {
    let patternIdx = Math.floor(this.rng() * PLUCK_PATTERNS.length);
    if (patternIdx === this.lastPluckPatternIdx) {
      patternIdx = (patternIdx + 1) % PLUCK_PATTERNS.length;
    }
    this.lastPluckPatternIdx = patternIdx;
    const pattern = atSafe(PLUCK_PATTERNS, patternIdx, PLUCK_PATTERNS[0] ?? []);
    const baseNote = chord.pluckNotes[0] ?? chord.rootMidi + 12;

    const isSparse = mood === "shop" || mood === "defeat" || mood === "lobby";
    const reverseContour = this.rng() < 0.35;
    const panDirection = barIndex % 2 === 0 ? 1 : -1;

    for (let i = 0; i < pattern.length; i++) {
      const pair = pattern[i];
      if (!pair) {
        continue;
      }
      const [step, rawNoteIdx] = pair;
      if (isSparse && step > 0 && this.rng() < 0.32) {
        continue;
      }
      const noteIdx = reverseContour
        ? chord.pluckNotes.length - 1 - (rawNoteIdx % Math.max(1, chord.pluckNotes.length))
        : rawNoteIdx;
      const midi = atSafe(chord.pluckNotes, noteIdx, baseNote);
      const accent = step === 0 ? 0.78 : step % 4 === 0 ? 0.64 : 0.48;
      const velocity = clamp(accent + (this.rng() - 0.5) * 0.16, 0.25, 0.9);
      const panProgress = pattern.length > 1 ? i / (pattern.length - 1) : 0.5;
      const pan = clamp((panProgress * 2 - 1) * 0.42 * panDirection, -0.5, 0.5);

      pluckByStep[step] = { midi, velocity, pan };
    }
  }

  private populateFlute(
    fluteByStep: Array<FluteNoteSlot | null>,
    chord: ChordVoicing,
    mood: MusicMood,
    barIndex: number,
  ): void {
    const barMod4 = ((barIndex % 4) + 4) % 4;
    const barMod8 = ((barIndex % 8) + 8) % 8;

    let isRestBar = false;
    if (mood === "lobby" || mood === "shop" || mood === "defeat") {
      isRestBar = barMod4 === 1 || barMod4 === 3 || this.rng() < 0.22;
    } else if (mood === "battle") {
      // Intentional breathing rests: bars 2, 6, 7, 10, 14, 15 guaranteed (~37.5%+)
      isRestBar =
        barMod4 === 2 ||
        barMod8 === 7 ||
        (this.consecutiveFluteBars >= 2 && this.rng() < 0.45);
    } else if (mood === "intense" || mood === "flood") {
      isRestBar =
        barMod4 === 3 || (this.consecutiveFluteBars >= 3 && this.rng() < 0.4);
    } else {
      // victory
      isRestBar = barMod4 === 3;
    }

    if (isRestBar) {
      this.consecutiveFluteBars = 0;
      return;
    }

    this.consecutiveFluteBars++;
    let templateIdx = Math.floor(this.rng() * FLUTE_RHYTHM_TEMPLATES.length);
    if (templateIdx === this.lastFluteTemplateIdx) {
      templateIdx = (templateIdx + 1) % FLUTE_RHYTHM_TEMPLATES.length;
    }
    this.lastFluteTemplateIdx = templateIdx;
    const template = atSafe(
      FLUTE_RHYTHM_TEMPLATES,
      templateIdx,
      FLUTE_RHYTHM_TEMPLATES[0] ?? [],
    );

    const scaleLen = chord.melodyScale.length;
    const fallbackMidi = chord.melodyScale[0] ?? chord.rootMidi + 24;

    // Gentle phrase arch: lift slightly toward climax bars 4-5 of an 8-bar phrase
    const phraseTargetIdx =
      barMod8 === 4 || barMod8 === 5
        ? Math.min(scaleLen - 1, Math.floor(scaleLen * 0.72))
        : barMod8 === 6
          ? Math.floor(scaleLen * 0.35)
          : Math.floor(scaleLen * 0.5);

    for (let i = 0; i < template.length; i++) {
      const slot = template[i];
      if (!slot) {
        continue;
      }
      const [step, durationSteps] = slot;

      const intervalPick = atSafe(
        FLUTE_STEP_INTERVALS,
        Math.floor(this.rng() * FLUTE_STEP_INTERVALS.length),
        1,
      );
      const pull =
        this.lastFluteScaleIdx < phraseTargetIdx
          ? 1
          : this.lastFluteScaleIdx > phraseTargetIdx
            ? -1
            : 0;
      const stepMove = this.rng() < 0.35 ? pull : intervalPick;
      let nextIdx = this.lastFluteScaleIdx + stepMove;
      if (nextIdx < 0) {
        nextIdx = Math.min(scaleLen - 1, 1);
      } else if (nextIdx >= scaleLen) {
        nextIdx = Math.max(0, scaleLen - 2);
      }
      this.lastFluteScaleIdx = nextIdx;

      const midi = atSafe(chord.melodyScale, nextIdx, fallbackMidi);
      const baseVel =
        mood === "victory" ? 0.78 : mood === "intense" || mood === "flood" ? 0.74 : 0.66;
      const archBoost = i === 0 ? 0.06 : -0.02;
      const velocity = clamp(
        baseVel + archBoost + (this.rng() - 0.5) * 0.14,
        0.38,
        0.92,
      );

      fluteByStep[step] = {
        midi,
        durationSteps,
        velocity,
      };
    }
  }

  private populateCello(
    celloByStep: Array<CelloNoteSlot | null>,
    chord: ChordVoicing,
    mood: MusicMood,
    barIndex: number,
  ): void {
    const isCalm = mood === "lobby" || mood === "shop" || mood === "defeat";
    const downbeatDuration = isCalm ? 16 : 8;
    celloByStep[0] = {
      midi: chord.rootMidi,
      durationSteps: downbeatDuration,
    };

    if (!isCalm) {
      // Expressive fifth or octave bow swell on beat 3
      const useFifth = barIndex % 2 === 0 || this.rng() < 0.6;
      const secondMidi = useFifth ? chord.rootMidi + 7 : chord.rootMidi + 12;
      celloByStep[8] = {
        midi: secondMidi,
        durationSteps: 8,
      };
    } else if (barIndex % 2 === 1 && this.rng() < 0.5) {
      celloByStep[8] = {
        midi: chord.rootMidi + 7,
        durationSteps: 8,
      };
    }
  }

  private populatePercussion(
    percByStep: PercussionSlot[],
    chord: ChordVoicing,
    mood: MusicMood,
    barIndex: number,
  ): void {
    if (mood === "lobby" || mood === "shop" || mood === "defeat") {
      return;
    }

    if (mood === "victory") {
      percByStep[0] = {
        frameDrumGain: 0,
        shakerGain: 0,
        timpaniMidi: chord.rootMidi,
        timpaniGain: barIndex % 2 === 0 ? 0.52 : 0.34,
      };
      return;
    }

    const isFlood = mood === "flood";
    const isIntense = mood === "intense";

    for (let step = 0; step < STEPS_PER_BAR; step++) {
      let frameDrumGain = 0;
      let shakerGain = 0;
      let timpaniMidi: number | null = null;
      let timpaniGain = 0;

      if (isFlood) {
        if (step === 0 || step === 4 || step === 8 || step === 12) {
          frameDrumGain = step === 0 ? 0.85 : 0.64;
        } else if (step === 6 || step === 10 || step === 14) {
          frameDrumGain = 0.44;
        }
        if (step % 2 === 0) {
          shakerGain = step % 4 === 2 ? 0.46 : 0.28;
        }
        if (step === 0 || step === 8 || (step === 14 && barIndex % 2 === 1)) {
          timpaniMidi = step === 8 ? chord.rootMidi + 7 : chord.rootMidi;
          timpaniGain = step === 0 ? 0.82 : 0.54;
        }
      } else if (isIntense) {
        if (step === 0 || step === 6 || step === 8 || step === 14) {
          frameDrumGain = step === 0 ? 0.78 : 0.52;
        } else if (step === 10 && this.rng() < 0.65) {
          frameDrumGain = 0.42;
        }
        if (step % 2 === 0) {
          shakerGain = step % 4 === 2 ? 0.38 : 0.2;
        }
        if (step === 0 || (step === 12 && barIndex % 2 === 1)) {
          timpaniMidi = chord.rootMidi;
          timpaniGain = step === 0 ? 0.72 : 0.46;
        }
      } else {
        // battle: grounded, spacious woodland frame drum & leaf shaker
        if (step === 0) {
          frameDrumGain = 0.66;
        } else if (step === 6 || step === 10) {
          frameDrumGain = 0.42 + (this.rng() - 0.5) * 0.08;
        } else if (step === 14 && this.rng() < 0.45) {
          frameDrumGain = 0.32;
        }

        if (step === 2 || step === 4 || step === 8 || step === 12 || step === 14) {
          shakerGain = step % 4 === 2 ? 0.28 : 0.16;
        }

        if (step === 0 && barIndex % 2 === 0) {
          timpaniMidi = chord.rootMidi;
          timpaniGain = 0.58;
        }
      }

      if (
        frameDrumGain > 0 ||
        shakerGain > 0 ||
        timpaniGain > 0
      ) {
        percByStep[step] = {
          frameDrumGain: clamp(frameDrumGain, 0, 1),
          shakerGain: clamp(shakerGain, 0, 1),
          timpaniMidi,
          timpaniGain: clamp(timpaniGain, 0, 1),
        };
      }
    }
  }
}
