import { describe, expect, it } from "vitest";
import type { CritterState, GadgetId, Vec3 } from "@critter/shared";
import {
  capturePreImpactCritters,
  createShotVisualFreeze,
  isShotVisualFreezeActive,
  releaseShotVisualFreeze,
  resolveCritterVisualState,
} from "../src/game/shotVisualFreeze.js";

function makeCritter(
  overrides: Partial<CritterState> & { id: string },
): CritterState {
  const defaultCharges: Record<GadgetId, number | null> = {
    gale_mortar: null,
    quake_club: null,
    vine_grapple: 1,
    spore_burst: 2,
    burrow_bore: 2,
    seeker_firefly: 1,
    gravity_mine: 1,
    prism_wall: 1,
    shock_magnet: 1,
    mend_brew: 1,
  };

  return {
    name: overrides.id,
    species: "mole",
    isBot: false,
    team: null,
    seatIndex: 0,
    connected: true,
    position: { x: 20, y: 10, z: 20 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 240,
    maxHp: 240,
    moveStamina: 100,
    maxMoveDistance: 10,
    alive: true,
    evoCharge: 0,
    pendingEvoDraft: false,
    equipped: {},
    apex: null,
    coins: 0,
    loadout: ["gale_mortar", "quake_club", "vine_grapple"],
    gadgetCharges: defaultCharges,
    roundShieldRemaining: 0,
    kills: 0,
    damageDealt: 0,
    podsCollected: 0,
    score: 0,
    droneNudgeUsedThisTurn: false,
    retreatBurrowUsedThisTurn: false,
    skyBomberDropUsedThisTurn: false,
    grappleUsedThisTurn: false,
    colorIndex: 0,
    color: "#38bdf8",
    ...overrides,
  };
}

describe("Shot pre-impact visual freeze helper", () => {
  it("holds pre-impact live position, HP, and alive status while shot is in flight and releases cleanly on impact", () => {
    const preFireRival = makeCritter({
      id: "rival",
      position: { x: 40, y: 12, z: 30 },
      hp: 120,
      maxHp: 240,
      alive: true,
    });
    const preFireShooter = makeCritter({
      id: "shooter",
      position: { x: 15, y: 11, z: 18 },
      hp: 240,
      maxHp: 240,
      alive: true,
    });

    const livePositions = new Map<string, Vec3>([
      ["rival", { x: 40.2, y: 12.1, z: 30.3 }],
    ]);

    const freeze = createShotVisualFreeze(
      [preFireShooter, preFireRival],
      livePositions,
      false,
    );
    expect(isShotVisualFreezeActive(freeze)).toBe(true);
    expect(freeze.preImpactCritters.size).toBe(2);

    // Authoritative STATE_SNAPSHOT arrives immediately with post-blast knockback & KO
    const postBlastRival = makeCritter({
      id: "rival",
      position: { x: 52, y: 4, z: 39 },
      hp: 0,
      maxHp: 240,
      alive: false,
    });

    // During projectile flight, rival remains frozen at pre-impact live rig spot & HP/alive
    const duringFlight = resolveCritterVisualState(postBlastRival, freeze);
    expect(duringFlight.frozen).toBe(true);
    expect(duringFlight.position).toEqual({ x: 40.2, y: 12.1, z: 30.3 });
    expect(duringFlight.hp).toBe(120);
    expect(duringFlight.maxHp).toBe(240);
    expect(duringFlight.alive).toBe(true);

    // Critter without live override falls back to pre-fire CritterState position
    const postShooter = makeCritter({
      id: "shooter",
      position: { x: 14, y: 11, z: 17 },
      hp: 210,
    });
    const shooterDuringFlight = resolveCritterVisualState(postShooter, freeze);
    expect(shooterDuringFlight.frozen).toBe(true);
    expect(shooterDuringFlight.position).toEqual({ x: 15, y: 11, z: 18 });
    expect(shooterDuringFlight.hp).toBe(240);

    // On exact impact arrival, freeze releases and exposes authoritative post-blast state
    releaseShotVisualFreeze(freeze);
    expect(isShotVisualFreezeActive(freeze)).toBe(false);

    const afterImpact = resolveCritterVisualState(postBlastRival, freeze);
    expect(afterImpact.frozen).toBe(false);
    expect(afterImpact.position).toEqual({ x: 52, y: 4, z: 39 });
    expect(afterImpact.hp).toBe(0);
    expect(afterImpact.alive).toBe(false);
  });

  it("releases immediately for instant blasts and safely handles null/untracked critters", () => {
    const rival = makeCritter({
      id: "rival",
      position: { x: 30, y: 10, z: 25 },
      hp: 80,
    });

    // Instant quake_club blast starts with initialReleased = true
    const instantFreeze = createShotVisualFreeze([rival], undefined, true);
    expect(isShotVisualFreezeActive(instantFreeze)).toBe(false);

    const postBlast = makeCritter({
      id: "rival",
      position: { x: 38, y: 9, z: 25 },
      hp: 40,
    });
    const resolvedInstant = resolveCritterVisualState(postBlast, instantFreeze);
    expect(resolvedInstant.frozen).toBe(false);
    expect(resolvedInstant.position).toEqual({ x: 38, y: 9, z: 25 });
    expect(resolvedInstant.hp).toBe(40);

    // Untracked critter or null freeze never gets stuck
    const snaps = capturePreImpactCritters([]);
    expect(snaps.size).toBe(0);
    expect(isShotVisualFreezeActive(null)).toBe(false);
    const untracked = resolveCritterVisualState(postBlast, null);
    expect(untracked.frozen).toBe(false);
    expect(untracked.position).toEqual(postBlast.position);
  });
});
