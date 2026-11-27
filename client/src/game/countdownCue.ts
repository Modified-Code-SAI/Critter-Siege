import type { TurnPhase } from "@critter/shared";

export type CountdownCueKind =
  | "none"
  | "active_tick"
  | "active_tick_urgent"
  | "retreat_beep"
  | "retreat_beep_urgent";

export interface CountdownCueResult {
  readonly cue: CountdownCueKind;
  readonly nextKey: string;
}

/**
 * Evaluates which per-second countdown audio cue should fire for the active player's
 * turn clock (`ACTIVE` 10s..1s mechanical ticks, `RETREAT` 5s..1s tactical beeps),
 * deduplicating repeated calls within the same ceiling second.
 */
export function evaluateCountdownCue(
  phase: TurnPhase,
  canMove: boolean,
  timeRemainingSec: number,
  lastKey: string,
): CountdownCueResult {
  if (!canMove || !Number.isFinite(timeRemainingSec)) {
    return { cue: "none", nextKey: "" };
  }

  const secCeil = Math.ceil(timeRemainingSec);

  if (phase === "ACTIVE") {
    if (secCeil < 1 || secCeil > 10) {
      return { cue: "none", nextKey: "" };
    }
    const key = `ACTIVE:${secCeil}`;
    if (key === lastKey) {
      return { cue: "none", nextKey: lastKey };
    }
    return {
      cue: secCeil <= 3 ? "active_tick_urgent" : "active_tick",
      nextKey: key,
    };
  }

  if (phase === "RETREAT") {
    if (secCeil < 1 || secCeil > 5) {
      return { cue: "none", nextKey: "" };
    }
    const key = `RETREAT:${secCeil}`;
    if (key === lastKey) {
      return { cue: "none", nextKey: lastKey };
    }
    return {
      cue: secCeil <= 2 ? "retreat_beep_urgent" : "retreat_beep",
      nextKey: key,
    };
  }

  return { cue: "none", nextKey: "" };
}
