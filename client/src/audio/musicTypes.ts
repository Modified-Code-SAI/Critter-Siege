import type { ThemeId } from "@critter/shared";

export type MusicMood =
  | "lobby"
  | "battle"
  | "intense"
  | "shop"
  | "flood"
  | "victory"
  | "defeat";

export type MusicStingerKind =
  | "ko"
  | "round_end"
  | "flood_alarm"
  | "purchase"
  | "evolution";

export interface MusicGameplayContext {
  mood: MusicMood;
  theme: ThemeId;
  round: number;
  maxRounds: number;
  isMyTurn: boolean;
  isCharging: boolean;
  chargePower: number;
  isShotFlight: boolean;
  isDroneView: boolean;
  hpRatio: number;
  windSpeed: number;
  waterLevel: number;
  floodIntensity: number;
  isShowdown: boolean;
}

export interface StemMixTargets {
  pad: number;
  pluck: number;
  cello: number;
  flute: number;
  percussion: number;
  chargeShimmer: number;
  filterHz: number;
  reverbWet: number;
}

export interface ChordVoicing {
  readonly name: string;
  readonly rootMidi: number;
  readonly padNotes: readonly number[];
  readonly pluckNotes: readonly number[];
  readonly melodyScale: readonly number[];
}

export interface BiomePalette {
  readonly theme: ThemeId;
  readonly tonicMidi: number;
  readonly calmChords: readonly ChordVoicing[];
  readonly battleChords: readonly ChordVoicing[];
  readonly intenseChords: readonly ChordVoicing[];
  readonly floodChords: readonly ChordVoicing[];
  readonly victoryChords: readonly ChordVoicing[];
  readonly defeatChords: readonly ChordVoicing[];
  readonly timbreBias: {
    readonly pad: number;
    readonly pluck: number;
    readonly flute: number;
    readonly cello: number;
    readonly percussion: number;
  };
}

export interface PlannedStepEvent {
  readonly pluckMidi: number | null;
  readonly pluckVelocity: number;
  readonly pluckPan: number;
  readonly fluteMidi: number | null;
  readonly fluteDurationSteps: number;
  readonly fluteVelocity: number;
  readonly celloMidi: number | null;
  readonly celloDurationSteps: number;
  readonly frameDrumGain: number;
  readonly shakerGain: number;
  readonly timpaniMidi: number | null;
  readonly timpaniGain: number;
  readonly humanizeSec: number;
}
