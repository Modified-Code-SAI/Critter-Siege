import type { Vec3 } from "@critter/shared";
import type { CameraMode } from "./cameraRig.js";

export const GRAPPLE_LAUNCH_DURATION_SEC = 0.2;
export const GRAPPLE_PULL_DURATION_SEC = 0.55;

export interface GrappleAnimState {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly isPodPull: boolean;
  elapsedSec: number;
  readonly launchDurationSec: number;
  readonly pullDurationSec: number;
  latchTriggered: boolean;
}

export interface GrappleAnimFrame {
  readonly phase: "launch" | "pull" | "done";
  readonly critterPos: Vec3;
  readonly tetherFrom: Vec3;
  readonly tetherTo: Vec3;
  readonly justLatched: boolean;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/**
 * Create a two-stage Vine Grapple animation state (`launch` hook extension -> `pull` reel-in or pod retraction).
 */
export function createGrappleAnimState(
  from: Vec3,
  to: Vec3,
  isPodPull = false,
): GrappleAnimState {
  return {
    from: cloneVec3(from),
    to: cloneVec3(to),
    isPodPull,
    elapsedSec: 0,
    launchDurationSec: GRAPPLE_LAUNCH_DURATION_SEC,
    pullDurationSec: GRAPPLE_PULL_DURATION_SEC,
    latchTriggered: false,
  };
}

/**
 * Advance a two-stage Vine Grapple animation by `dtSec` and compute the current
 * critter position, taut vine tether endpoints, and one-shot latch trigger flag.
 */
export function stepGrappleAnim(
  state: GrappleAnimState,
  dtSec: number,
): GrappleAnimFrame {
  const safeDt = Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0;
  state.elapsedSec += safeDt;

  const launchDur = Math.max(1e-4, state.launchDurationSec);
  const pullDur = Math.max(1e-4, state.pullDurationSec);
  const totalDur = launchDur + pullDur;

  if (state.elapsedSec < launchDur) {
    const t = clamp01(state.elapsedSec / launchDur);
    const eased = 1 - (1 - t) ** 3;
    return {
      phase: "launch",
      critterPos: cloneVec3(state.from),
      tetherFrom: cloneVec3(state.from),
      tetherTo: lerpVec3(state.from, state.to, eased),
      justLatched: false,
    };
  }

  let justLatched = false;
  if (!state.latchTriggered) {
    state.latchTriggered = true;
    justLatched = true;
  }

  if (state.elapsedSec >= totalDur) {
    const finalPos = state.isPodPull
      ? cloneVec3(state.from)
      : cloneVec3(state.to);
    return {
      phase: "done",
      critterPos: finalPos,
      tetherFrom: cloneVec3(finalPos),
      tetherTo: cloneVec3(finalPos),
      justLatched,
    };
  }

  const rawT = clamp01((state.elapsedSec - launchDur) / pullDur);
  const u = rawT * rawT * (3 - 2 * rawT);

  if (state.isPodPull) {
    return {
      phase: "pull",
      critterPos: cloneVec3(state.from),
      tetherFrom: cloneVec3(state.from),
      tetherTo: lerpVec3(state.to, state.from, u),
      justLatched,
    };
  }

  const dist = Math.hypot(
    state.to.x - state.from.x,
    state.to.y - state.from.y,
    state.to.z - state.from.z,
  );
  const arcLift = Math.sin(rawT * Math.PI) * Math.min(1.1, dist * 0.08);
  const critterPos: Vec3 = {
    x: state.from.x + (state.to.x - state.from.x) * u,
    y: state.from.y + (state.to.y - state.from.y) * u + arcLift,
    z: state.from.z + (state.to.z - state.from.z) * u,
  };

  return {
    phase: "pull",
    critterPos,
    tetherFrom: cloneVec3(critterPos),
    tetherTo: cloneVec3(state.to),
    justLatched,
  };
}

/**
 * Only exit Tactical Drone Recon when firing a local grapple so Over-the-Shoulder
 * watches the pull while First-Person Optic Visor remains untouched.
 */
export function shouldExitDroneForGrapple(currentMode: CameraMode): boolean {
  return currentMode === "drone_recon";
}
