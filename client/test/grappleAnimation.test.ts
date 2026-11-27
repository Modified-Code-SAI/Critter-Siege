import type { Vec3 } from "@critter/shared";
import { describe, expect, it } from "vitest";
import type { CameraMode } from "../src/game/cameraRig.js";
import {
  GRAPPLE_LAUNCH_DURATION_SEC,
  GRAPPLE_PULL_DURATION_SEC,
  createGrappleAnimState,
  shouldExitDroneForGrapple,
  stepGrappleAnim,
} from "../src/game/grappleAnimation.js";

describe("grappleAnimation (Review Focus #3)", () => {
  const from: Vec3 = { x: 10, y: 6, z: 12 };
  const to: Vec3 = { x: 22, y: 14, z: 12 };

  it("keeps critterPos at from while extending tetherTo with easeOutCubic during launch", () => {
    const state = createGrappleAnimState(from, to, false);
    expect(state.launchDurationSec).toBe(GRAPPLE_LAUNCH_DURATION_SEC);
    expect(state.pullDurationSec).toBe(GRAPPLE_PULL_DURATION_SEC);
    expect(state.latchTriggered).toBe(false);

    const f1 = stepGrappleAnim(state, 0.05);
    expect(f1.phase).toBe("launch");
    expect(f1.justLatched).toBe(false);
    expect(f1.critterPos).toEqual(from);
    expect(f1.tetherFrom).toEqual(from);
    expect(f1.tetherTo.x).toBeGreaterThan(from.x);
    expect(f1.tetherTo.x).toBeLessThan(to.x);

    const f2 = stepGrappleAnim(state, 0.05);
    expect(f2.phase).toBe("launch");
    expect(f2.justLatched).toBe(false);
    expect(f2.critterPos).toEqual(from);
    expect(f2.tetherTo.x).toBeGreaterThan(f1.tetherTo.x);
    // easeOutCubic(0.5) = 1 - 0.125 = 0.875
    expect(f2.tetherTo.x).toBeCloseTo(from.x + (to.x - from.x) * 0.875, 4);
    expect(f2.tetherTo.y).toBeCloseTo(from.y + (to.y - from.y) * 0.875, 4);
  });

  it("fires justLatched exactly once upon crossing 0.20s and smoothly pulls critter with arc lift to to", () => {
    const state = createGrappleAnimState(from, to, false);

    // Advance to 0.15s (still launch)
    const preLatch = stepGrappleAnim(state, 0.15);
    expect(preLatch.phase).toBe("launch");
    expect(preLatch.justLatched).toBe(false);

    // Cross 0.20s exactly -> latch fires once and enters pull
    const atLatch = stepGrappleAnim(state, 0.05);
    expect(atLatch.phase).toBe("pull");
    expect(atLatch.justLatched).toBe(true);
    expect(state.latchTriggered).toBe(true);
    expect(atLatch.critterPos).toEqual(from);
    expect(atLatch.tetherTo).toEqual(to);

    // Mid-pull: justLatched must NOT fire again, critter advances with subtle upward arcLift
    const midPull = stepGrappleAnim(state, GRAPPLE_PULL_DURATION_SEC * 0.5);
    expect(midPull.phase).toBe("pull");
    expect(midPull.justLatched).toBe(false);
    expect(midPull.critterPos.x).toBeCloseTo((from.x + to.x) * 0.5, 3);
    const linearMidY = (from.y + to.y) * 0.5;
    expect(midPull.critterPos.y).toBeGreaterThan(linearMidY);
    expect(midPull.tetherFrom).toEqual(midPull.critterPos);
    expect(midPull.tetherTo).toEqual(to);

    // Finish pull (>= 0.75s total)
    const done = stepGrappleAnim(state, GRAPPLE_PULL_DURATION_SEC * 0.5 + 0.05);
    expect(done.phase).toBe("done");
    expect(done.justLatched).toBe(false);
    expect(done.critterPos).toEqual(to);
  });

  it("keeps critterPos at from and retracts tetherTo from to -> from during pull when isPodPull is true", () => {
    const state = createGrappleAnimState(from, to, true);

    const launch = stepGrappleAnim(state, 0.1);
    expect(launch.phase).toBe("launch");
    expect(launch.critterPos).toEqual(from);
    expect(launch.tetherTo.x).toBeGreaterThan(from.x);

    // Cross latch boundary into pod retraction
    const latch = stepGrappleAnim(state, 0.1);
    expect(latch.phase).toBe("pull");
    expect(latch.justLatched).toBe(true);
    expect(latch.critterPos).toEqual(from);
    expect(latch.tetherFrom).toEqual(from);
    expect(latch.tetherTo).toEqual(to);

    // Halfway through pod pull: critter stays firmly at from while hook retracts halfway back
    const midRetract = stepGrappleAnim(state, GRAPPLE_PULL_DURATION_SEC * 0.5);
    expect(midRetract.phase).toBe("pull");
    expect(midRetract.justLatched).toBe(false);
    expect(midRetract.critterPos).toEqual(from);
    expect(midRetract.tetherFrom).toEqual(from);
    expect(midRetract.tetherTo.x).toBeCloseTo((from.x + to.x) * 0.5, 3);
    expect(midRetract.tetherTo.y).toBeCloseTo((from.y + to.y) * 0.5, 3);

    // Complete pod pull: critter remains at from
    const done = stepGrappleAnim(state, GRAPPLE_PULL_DURATION_SEC * 0.5 + 0.05);
    expect(done.phase).toBe("done");
    expect(done.justLatched).toBe(false);
    expect(done.critterPos).toEqual(from);
    expect(done.tetherTo).toEqual(from);
  });

  it("shouldExitDroneForGrapple returns true only for drone_recon and preserves first_person and over_shoulder", () => {
    expect(shouldExitDroneForGrapple("drone_recon")).toBe(true);

    const preserveModes: readonly CameraMode[] = [
      "first_person",
      "over_shoulder",
      "shot_cam",
      "spectator_drone",
      "flood_cam",
    ];
    for (const mode of preserveModes) {
      expect(shouldExitDroneForGrapple(mode)).toBe(false);
    }
  });
});
