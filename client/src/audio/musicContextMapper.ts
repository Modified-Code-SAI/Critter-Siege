import type { MatchState, ThemeId } from "@critter/shared";
import type { CameraMode } from "../game/cameraRig.js";
import type { MusicGameplayContext, MusicMood } from "./musicTypes.js";

/** Inputs sampled from client runtime state to derive adaptive music telemetry. */
export interface MusicContextInput {
  readonly inMatch: boolean;
  readonly matchState: MatchState | null;
  readonly lobbyTheme: ThemeId;
  readonly localPlayerId: string | null;
  readonly armoryOpen: boolean;
  readonly isCharging: boolean;
  readonly chargePower: number;
  readonly isShotFlight: boolean;
  readonly cameraMode: CameraMode;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Pure gameplay-to-soundtrack telemetry mapper for Critter Siege.
 * Derives mood, Duel-safe 1v1 showdown state, flood progression, and
 * per-frame micro-moment signals without touching WebAudio or Three.js.
 */
export function deriveMusicGameplayContext(
  input: MusicContextInput,
): MusicGameplayContext {
  const state = input.matchState;
  if (!input.inMatch || !state) {
    return {
      mood: "lobby",
      theme: input.lobbyTheme,
      round: 1,
      maxRounds: 5,
      isMyTurn: true,
      isCharging: false,
      chargePower: 0,
      isShotFlight: false,
      isDroneView: false,
      hpRatio: 1,
      windSpeed: 2.6,
      waterLevel: 1.8,
      floodIntensity: 0,
      isShowdown: false,
    };
  }

  const localCritter =
    input.localPlayerId !== null
      ? (state.critters.find((c) => c.id === input.localPlayerId) ?? null)
      : null;

  const aliveCritters = state.critters.filter((c) => c.alive);
  const aliveCount = aliveCritters.length;

  const isMyTurn =
    input.localPlayerId !== null &&
    state.activePlayerId === input.localPlayerId &&
    Boolean(localCritter?.alive) &&
    (state.phase === "ACTIVE" || state.phase === "RETREAT");

  const hpRatio =
    localCritter !== null
      ? localCritter.alive
        ? clamp(
            finiteOr(localCritter.hp, 0) /
              Math.max(1, finiteOr(localCritter.maxHp, 100)),
            0,
            1,
          )
        : 0
      : 1;

  const windSpeed = Math.hypot(
    finiteOr(state.wind.x, 0),
    finiteOr(state.wind.z, 0),
  );
  const isDroneView =
    input.cameraMode === "drone_recon" ||
    input.cameraMode === "spectator_drone";

  // Duel-safe showdown detection: 2-player Duel on Turn 1 stays in battle mood
  let isShowdown = false;
  if (state.mode === "2v2") {
    const teamAAlive = aliveCritters.filter((c) => c.team === "A").length;
    const teamBAlive = aliveCritters.filter((c) => c.team === "B").length;
    isShowdown =
      state.critters.length >= 4 && teamAAlive === 1 && teamBAlive === 1;
  } else {
    isShowdown = state.critters.length > 2 && aliveCount === 2;
  }

  const waterLevel = finiteOr(state.waterLevel, 1.8);
  let floodIntensity = 0;
  if (state.phase === "FINAL_FLOOD") {
    const targetY =
      state.floodTargetWaterLevel !== null &&
      Number.isFinite(state.floodTargetWaterLevel)
        ? state.floodTargetWaterLevel
        : 16;
    const frac = clamp((waterLevel - 4.0) / Math.max(1, targetY - 4.0), 0, 1);
    floodIntensity = 0.5 + 0.5 * frac;
  } else if (state.round >= 4 || state.roundTimeRemainingSec <= 60) {
    const clockRamp =
      state.roundTimeRemainingSec <= 60
        ? clamp(1 - state.roundTimeRemainingSec / 60, 0, 1)
        : 0;
    const roundFloor =
      state.round >= state.maxRounds && state.round >= 4 ? 0.25 : 0.2;
    floodIntensity = clamp(
      roundFloor + (0.45 - roundFloor) * clockRamp,
      0.2,
      0.45,
    );
  }

  let mood: MusicMood;
  if (state.phase === "MATCH_OVER") {
    const localWon =
      state.matchEndReason !== "flood_draw" &&
      ((state.mode === "2v2" &&
        state.winnerTeam !== null &&
        localCritter?.team === state.winnerTeam) ||
        (state.mode === "ffa" &&
          localCritter !== null &&
          state.winnerId === localCritter.id));
    mood = localWon ? "victory" : "defeat";
  } else if (state.phase === "FINAL_FLOOD") {
    mood = "flood";
  } else if (
    input.armoryOpen ||
    state.phase === "ROUND_DRAFT" ||
    state.phase === "DRAFT_IF_READY"
  ) {
    mood = "shop";
  } else {
    const urgent =
      state.roundTimeRemainingSec <= 60 ||
      (isMyTurn && state.phaseTimeRemainingSec <= 6) ||
      (Boolean(localCritter?.alive) && hpRatio < 0.35) ||
      state.round >= Math.max(4, state.maxRounds - 1) ||
      isShowdown;
    mood = urgent ? "intense" : "battle";
  }

  return {
    mood,
    theme: state.theme,
    round: state.round,
    maxRounds: state.maxRounds,
    isMyTurn,
    isCharging: Boolean(input.isCharging),
    chargePower: input.isCharging
      ? clamp(finiteOr(input.chargePower, 0), 0, 1)
      : 0,
    isShotFlight: Boolean(input.isShotFlight),
    isDroneView,
    hpRatio,
    windSpeed,
    waterLevel,
    floodIntensity,
    isShowdown,
  };
}

/**
 * Gate evolution stingers to the local player only so rival bot mutation picks
 * never spam stingers during rounds or end-of-round drafts.
 */
export function shouldPlayEvolutionStinger(
  eventPlayerId: string,
  localPlayerId: string | null,
): boolean {
  return localPlayerId !== null && eventPlayerId === localPlayerId;
}
