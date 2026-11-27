import type { CritterState, Vec3 } from "@critter/shared";

/** Frozen pre-impact visual snapshot for a single critter captured at shot launch. */
export interface PreImpactCritterSnapshot {
  readonly position: Vec3;
  readonly hp: number;
  readonly maxHp: number;
  readonly alive: boolean;
}

/** Structural freeze state carried on ShotPlayback while a projectile is still in flight. */
export interface ShotVisualFreezeState {
  readonly preImpactCritters: ReadonlyMap<string, PreImpactCritterSnapshot>;
  impactReleased: boolean;
}

/** Resolved visual position, HP, and alive status to render for a critter on the current frame. */
export interface ResolvedCritterVisualState {
  readonly position: Vec3;
  readonly hp: number;
  readonly maxHp: number;
  readonly alive: boolean;
  readonly frozen: boolean;
}

/**
 * Capture every critter's pre-impact live visual position, HP, and alive status
 * when SHOT_RESOLVED arrives (before the post-fire STATE_SNAPSHOT mutates positions).
 */
export function capturePreImpactCritters(
  critters: readonly CritterState[],
  livePositions?: ReadonlyMap<string, Vec3>,
): Map<string, PreImpactCritterSnapshot> {
  const snapshots = new Map<string, PreImpactCritterSnapshot>();
  for (let i = 0; i < critters.length; i++) {
    const c = critters[i];
    if (!c) {
      continue;
    }
    const pos = livePositions?.get(c.id) ?? c.position;
    snapshots.set(c.id, {
      position: { x: pos.x, y: pos.y, z: pos.z },
      hp: c.hp,
      maxHp: c.maxHp,
      alive: c.alive,
    });
  }
  return snapshots;
}

/**
 * Build a ShotVisualFreezeState for a newly launched shot. Instant blasts such as
 * Gale Scatter (`quake_club`) pass `initialReleased = true`.
 */
export function createShotVisualFreeze(
  critters: readonly CritterState[],
  livePositions?: ReadonlyMap<string, Vec3>,
  initialReleased = false,
): ShotVisualFreezeState {
  return {
    preImpactCritters: capturePreImpactCritters(critters, livePositions),
    impactReleased: initialReleased,
  };
}

/** Release the visual freeze so critter rigs sync to their authoritative post-impact state. */
export function releaseShotVisualFreeze(
  freeze: ShotVisualFreezeState | null | undefined,
): void {
  if (freeze) {
    freeze.impactReleased = true;
  }
}

/** Return true while a shot's visual freeze is still holding pre-impact critter state. */
export function isShotVisualFreezeActive(
  freeze: ShotVisualFreezeState | null | undefined,
): boolean {
  return freeze !== null && freeze !== undefined && !freeze.impactReleased;
}

/**
 * Resolve the visual position, HP, and alive status to display for a critter.
 * While `!freeze.impactReleased`, critters captured in `preImpactCritters` stay at their
 * pre-impact snapshot until the explosion lands on screen.
 */
export function resolveCritterVisualState(
  critter: CritterState,
  freeze: ShotVisualFreezeState | null | undefined,
): ResolvedCritterVisualState {
  if (freeze && !freeze.impactReleased) {
    const snap = freeze.preImpactCritters.get(critter.id);
    if (snap) {
      return {
        position: snap.position,
        hp: snap.hp,
        maxHp: snap.maxHp,
        alive: snap.alive,
        frozen: true,
      };
    }
  }
  return {
    position: critter.position,
    hp: critter.hp,
    maxHp: critter.maxHp,
    alive: critter.alive,
    frozen: false,
  };
}
