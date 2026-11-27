import { describe, expect, it } from "vitest";
import {
  GADGET_CATALOG,
  GRAVITY,
  MatchEngine,
  SDF_DIMS,
  SdfWorld,
  computeFallDamage,
  planBotTurn,
  sampleAimArc,
  simulateShot,
  type CritterState,
  type MatchConfig,
  type ShotParams,
} from "@critter/shared";

const WORLD_CENTER_X = SDF_DIMS.nx * SDF_DIMS.voxelSize * 0.5;
const WORLD_CENTER_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize * 0.5;

function makeBaseConfig(overrides?: Partial<MatchConfig>): MatchConfig {
  return {
    roomCode: "TEST",
    mode: "ffa",
    theme: "emerald_spire",
    seed: 1234,
    maxRounds: 3,
    players: [
      {
        id: "p1",
        name: "Milo",
        species: "mole",
        team: 0,
        isBot: false,
        color: "#e67e22",
      },
      {
        id: "p2",
        name: "Remy",
        species: "norway_rat",
        team: 1,
        isBot: false,
        color: "#3498db",
      },
    ],
    ...overrides,
  };
}

function makeDummyCritter(overrides: Partial<CritterState> & { id: string }): CritterState {
  return {
    name: overrides.id,
    species: "mole",
    isBot: false,
    team: null,
    seatIndex: 0,
    connected: true,
    position: { x: 14, y: 12.0, z: 14 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 240,
    maxHp: 240,
    moveStamina: 100,
    maxMoveDistance: 14,
    alive: true,
    evoCharge: 0,
    pendingEvoDraft: false,
    equipped: {},
    apex: null,
    coins: 45,
    loadout: ["gale_mortar", "quake_club", "vine_grapple"],
    gadgetCharges: {
      gale_mortar: null,
      quake_club: null,
      vine_grapple: 6,
      spore_burst: 2,
      burrow_bore: 2,
      seeker_firefly: 1,
      gravity_mine: 0,
      prism_wall: 0,
      shock_magnet: 0,
      mend_brew: 0,
    },
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
    color: "#e67e22",
    ...overrides,
  };
}

function advanceAndWalkTo(
  engine: MatchEngine,
  playerId: string,
  target: { x: number; y: number; z: number },
  maxTicks = 30,
  stopWhen?: (events: ReturnType<MatchEngine["applyMove"]>) => boolean,
): ReturnType<MatchEngine["applyMove"]> {
  const collected: ReturnType<MatchEngine["applyMove"]> = [];
  for (let i = 0; i < maxTicks; i++) {
    const snap = engine.getSnapshot();
    const tickSec = snap.mapScale === "grand" ? 36 : 29;
    if (snap.phase === "MATCH_OVER" || snap.phase === "ROUND_DRAFT") {
      break;
    }
    if (snap.phase === "DRAFT_IF_READY") {
      for (const d of snap.pendingDrafts) {
        const opt = d.options[0];
        if (opt) engine.applyMutationPick(d.playerId, opt);
      }
      continue;
    }
    if (snap.activePlayerId !== playerId || snap.phase !== "ACTIVE") {
      engine.tick(tickSec);
      continue;
    }
    const me = snap.critters.find((c) => c.id === playerId);
    if (!me || !me.alive) break;
    const dist = Math.hypot(target.x - me.position.x, target.z - me.position.z);
    if (dist <= 0.15) {
      const evs = engine.applyMove(playerId, target, 0, 0);
      collected.push(...evs);
      break;
    }
    const evs = engine.applyMove(playerId, target, 0, 0);
    collected.push(...evs);
    if (stopWhen && stopWhen(evs)) {
      break;
    }
    const after = engine.getSnapshot().critters.find((c) => c.id === playerId);
    if (!after || !after.alive) break;
    if (Math.hypot(target.x - after.position.x, target.z - after.position.z) <= 0.15) {
      break;
    }
    engine.tick(tickSec);
  }
  return collected;
}

describe("Ballistics & gadget simulation (physics.ts)", () => {
  it("curves gale_mortar with wind, supports extended optic_visor arc, and guards zero direction", () => {
    expect(GRAVITY).toBe(18.0);
    const world = new SdfWorld(42, "emerald_spire");
    const spawns = world.findSpawnPoints(2);
    const s0 = spawns[0];
    expect(s0).toBeDefined();
    if (!s0) return;

    const origin = { x: s0.x, y: s0.y + 0.8, z: s0.z };
    // Aim inward toward island center at a high arc so neither preview clips early
    const toCenterX = WORLD_CENTER_X - s0.x;
    const toCenterZ = WORLD_CENTER_Z - s0.z;
    const hLen = Math.hypot(toCenterX, toCenterZ) || 1;
    const direction = {
      x: (toCenterX / hLen) * 0.6,
      y: 0.8,
      z: (toCenterZ / hLen) * 0.6,
    };

    const calmArc = sampleAimArc(
      world,
      { gadgetId: "gale_mortar", origin, direction, power: 0.7 },
      { x: 0, y: 0, z: 0 },
      false,
    );
    const windyArc = sampleAimArc(
      world,
      { gadgetId: "gale_mortar", origin, direction, power: 0.7 },
      { x: 0, y: 0, z: 5.0 },
      true,
    );

    expect(calmArc.length).toBeGreaterThan(2);
    expect(calmArc.length).toBeLessThanOrEqual(20);
    expect(windyArc.length).toBeGreaterThan(calmArc.length);
    expect(windyArc.length).toBeLessThanOrEqual(36);

    const calmEnd = calmArc[calmArc.length - 1];
    const windyEnd = windyArc[windyArc.length - 1];
    expect(calmEnd).toBeDefined();
    expect(windyEnd).toBeDefined();
    if (calmEnd && windyEnd) {
      expect(windyEnd.z).toBeGreaterThan(calmEnd.z + 0.5);
    }

    // Zero-length direction guard
    const zeroSim = simulateShot(
      world,
      [],
      {
        shooterId: "p1",
        gadgetId: "gale_mortar",
        origin,
        direction: { x: 0, y: 0, z: 0 },
        power: 0.6,
        species: "mole",
        equipped: {},
        apex: null,
      },
      { x: 0, y: 0, z: 0 },
      1.5,
    );
    expect(zeroSim.impacts).toHaveLength(0);
    expect(zeroSim.carveOps).toHaveLength(0);
    expect(zeroSim.hits).toHaveLength(0);
  });

  it("simulates burrow_bore 0.6s capsule tunnel widened by mole passive", () => {
    const world = new SdfWorld(99, "emerald_spire");
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    if (!sp) return;

    const origin = { x: sp.x, y: sp.y + 1.0, z: sp.z };
    const direction = { x: 0, y: -1, z: 0 };

    const ratShot = simulateShot(
      world,
      [],
      {
        shooterId: "rat",
        gadgetId: "burrow_bore",
        origin,
        direction,
        power: 0.6,
        species: "norway_rat",
        equipped: {},
        apex: null,
      },
      { x: 0, y: 0, z: 0 },
      1.5,
    );

    const moleShot = simulateShot(
      world,
      [],
      {
        shooterId: "mole",
        gadgetId: "burrow_bore",
        origin,
        direction,
        power: 0.6,
        species: "mole",
        equipped: {},
        apex: null,
      },
      { x: 0, y: 0, z: 0 },
      1.5,
    );

    const ratCapsule = ratShot.carveOps.find((op) => op.shape === "capsule");
    const moleCapsule = moleShot.carveOps.find((op) => op.shape === "capsule");
    expect(ratCapsule).toBeDefined();
    expect(moleCapsule).toBeDefined();
    expect(moleCapsule?.end).toBeDefined();
    if (ratCapsule && moleCapsule && moleCapsule.end) {
      expect(moleCapsule.radius).toBeGreaterThan(ratCapsule.radius);
      const tunnelLen = Math.hypot(
        moleCapsule.end.x - moleCapsule.center.x,
        moleCapsule.end.y - moleCapsule.center.y,
        moleCapsule.end.z - moleCapsule.center.z,
      );
      expect(tunnelLen).toBeGreaterThan(2.0);
    }
    expect(moleShot.durationSec).toBeGreaterThanOrEqual(0.6);
  });

  it("simulates spore_burst spawning 5 deterministic sub-spore blasts", () => {
    const world = new SdfWorld(77, "emerald_spire");
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    if (!sp) return;

    const params: ShotParams = {
      shooterId: "p1",
      gadgetId: "spore_burst",
      origin: { x: sp.x, y: sp.y + 1.2, z: sp.z },
      direction: { x: 0.3, y: -0.95, z: 0 },
      power: 0.5,
      species: "norway_rat",
      equipped: {},
      apex: null,
    };

    const runA = simulateShot(world, [], params, { x: 1.5, y: 0, z: 0 }, 1.5);
    const runB = simulateShot(world, [], params, { x: 1.5, y: 0, z: 0 }, 1.5);

    const subSpores = runA.impacts.filter((imp) => imp.isSubSpore === true);
    expect(subSpores).toHaveLength(5);
    expect(runA.impacts).toEqual(runB.impacts);
  });

  it("simulates quake_club massive knockback and bramble_shell melee thorns back to attacker", () => {
    const world = new SdfWorld(55, "emerald_spire");
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    if (!sp) return;

    const attacker = makeDummyCritter({
      id: "attacker",
      species: "norway_rat",
      position: { x: sp.x, y: sp.y, z: sp.z },
      hp: 100,
    });
    const defender = makeDummyCritter({
      id: "defender",
      species: "hedgehog",
      position: { x: sp.x + 1.6, y: sp.y, z: sp.z },
      hp: 105,
      maxHp: 105,
      equipped: { back: "bramble_shell" },
    });

    const result = simulateShot(
      world,
      [attacker, defender],
      {
        shooterId: "attacker",
        gadgetId: "quake_club",
        origin: { x: attacker.position.x, y: attacker.position.y + 0.5, z: attacker.position.z },
        direction: { x: 1, y: 0, z: 0 },
        power: 1.0,
        species: "norway_rat",
        equipped: {},
        apex: null,
      },
      { x: 0, y: 0, z: 0 },
      1.5,
    );

    const defenderHit = result.hits.find((h) => h.critterId === "defender");
    const attackerThorns = result.hits.find((h) => h.critterId === "attacker");

    expect(defenderHit).toBeDefined();
    expect(attackerThorns).toBeDefined();
    if (defenderHit && attackerThorns) {
      expect(defenderHit.damage).toBeGreaterThan(0);
      const kbMag = Math.hypot(
        defenderHit.knockbackVelocity.x,
        defenderHit.knockbackVelocity.y,
        defenderHit.knockbackVelocity.z,
      );
      expect(kbMag).toBeGreaterThan(10);
      // Hedgehog (12) + Bramble Shell (10) = 22 melee thorns reflected!
      expect(attackerThorns.damage).toBe(22);
      expect(attackerThorns.newHp).toBe(78);
    }
    expect(result.carveOps[0]?.radius).toBeCloseTo(
      GADGET_CATALOG.quake_club.carveRadius,
      2,
    );
  });

  it("supports aegis_crest 1-hit shield absorption and gravity_mine inward pull", () => {
    const world = new SdfWorld(88, "emerald_spire");
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    if (!sp) return;

    const target = makeDummyCritter({
      id: "shielded",
      species: "badger",
      position: { x: sp.x, y: sp.y, z: sp.z },
      hp: 140,
      maxHp: 140,
      equipped: { crest: "aegis_crest" },
      roundShieldRemaining: 1,
    });

    const inwardSign = sp.x < WORLD_CENTER_X ? 1 : -1;
    const res = simulateShot(
      world,
      [target],
      {
        shooterId: "other",
        gadgetId: "gravity_mine",
        origin: { x: sp.x + inwardSign * 1.4, y: sp.y + 1.2, z: sp.z },
        direction: { x: 0, y: -1, z: 0 },
        power: 0.4,
        species: "mole",
        equipped: {},
        apex: null,
      },
      { x: 0, y: 0, z: 0 },
      1.5,
    );

    expect(res.impacts[0]?.isPull).toBe(true);
    const hit = res.hits.find((h) => h.critterId === "shielded");
    expect(hit).toBeDefined();
    if (hit) {
      expect(hit.shieldAbsorbed).toBe(true);
      expect(hit.damage).toBe(0);
      expect(hit.newHp).toBe(140);
      // Pulled inward toward mine origin along inwardSign
      expect(hit.knockbackVelocity.x * inwardSign).toBeGreaterThan(0);
    }
  });
});

describe("Authoritative MatchEngine turn state machine & review edge cases", () => {
  it("keeps ACTIVE phase on 18m vine_grapple utility and transitions ACTIVE (28s) -> RESOLVING -> RETREAT (6s) on gale_mortar", () => {
    const engine = new MatchEngine(makeBaseConfig());
    const init = engine.getSnapshot();
    expect(init.mapScale).toBe("duel");
    expect(init.phase).toBe("ACTIVE");
    expect(init.activePlayerId).toBe("p1");
    expect(init.phaseTimeRemainingSec).toBe(28);

    const p1 = init.critters.find((c) => c.id === "p1");
    expect(p1).toBeDefined();
    if (!p1) return;

    // Vine Grapple has 18m reach and does NOT end ACTIVE phase
    const toCenterX = WORLD_CENTER_X - p1.position.x;
    const toCenterZ = WORLD_CENTER_Z - p1.position.z;
    const hLen = Math.hypot(toCenterX, toCenterZ) || 1;
    const grappleTarget = {
      x: p1.position.x + (toCenterX / hLen) * 16.0,
      y: p1.position.y + 1.0,
      z: p1.position.z + (toCenterZ / hLen) * 16.0,
    };
    engine.applyUtility("p1", {
      gadgetId: "vine_grapple",
      direction: { x: toCenterX / hLen, y: 0.1, z: toCenterZ / hLen },
      target: grappleTarget,
    });
    const afterGrapple = engine.getSnapshot();
    expect(afterGrapple.phase).toBe("ACTIVE");
    expect(afterGrapple.activePlayerId).toBe("p1");
    const movedP1 = afterGrapple.critters.find((c) => c.id === "p1");
    expect(movedP1?.gadgetCharges.vine_grapple).toBe(5);
    expect(movedP1?.grappleUsedThisTurn).toBe(true);
    expect(movedP1?.moveStamina).toBe(100);
    if (movedP1) {
      const movedDist = Math.hypot(
        movedP1.position.x - p1.position.x,
        movedP1.position.y - p1.position.y,
        movedP1.position.z - p1.position.z,
      );
      expect(movedDist).toBeGreaterThan(15.0);
    }

    // Firing Gale Mortar transitions ACTIVE -> RESOLVING
    const fireEvents = engine.applyFire("p1", {
      gadgetId: "gale_mortar",
      direction: { x: 0.7, y: 0.7, z: 0 },
      power: 0.5,
    });
    expect(fireEvents.some((e) => e.type === "SHOT_RESOLVED")).toBe(true);
    const resolving = engine.getSnapshot();
    expect(resolving.phase).toBe("RESOLVING");
    expect(resolving.phaseTimeRemainingSec).toBeGreaterThan(1.2);

    // Completing RESOLVING transitions to RETREAT (6s) when shooter is alive
    engine.completeResolving();
    const retreat = engine.getSnapshot();
    expect(retreat.phase).toBe("RETREAT");
    expect(retreat.phaseTimeRemainingSec).toBe(6);
    expect(retreat.activePlayerId).toBe("p1");
    expect(retreat.critters.find((c) => c.id === "p1")?.moveStamina).toBe(40);

    // Retreat timer expiring transitions to next player's ACTIVE turn
    engine.tick(6.1);
    const nextTurn = engine.getSnapshot();
    expect(nextTurn.phase).toBe("ACTIVE");
    expect(nextTurn.activePlayerId).toBe("p2");
    expect(nextTurn.critters.find((c) => c.id === "p2")?.moveStamina).toBe(100);
  });

  it("Review Focus #2 (Self-KO): firing straight down to KO self skips RETREAT and awards 0 KO points", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
        roundDurationSec: 3600,
        players: [
          { id: "p1", name: "Milo", species: "mole", team: 0, isBot: false, color: "#e67e22" },
          { id: "p2", name: "Remy", species: "norway_rat", team: 1, isBot: false, color: "#3498db" },
          { id: "p3", name: "Bram", species: "badger", team: 0, isBot: false, color: "#2ecc71" },
        ],
      }),
    );

    expect(engine.getSnapshot().mapScale).toBe("grand");
    expect(engine.getSnapshot().phaseTimeRemainingSec).toBe(35);

    // Chip p1 down via vertical drops & self-blasts straight down at own feet until self-KO
    let selfKoResolved = false;
    for (let attempt = 0; attempt < 36; attempt++) {
      const snap = engine.getSnapshot();
      if (snap.activePlayerId !== "p1") {
        // Advance other players' turns by timing out ACTIVE (35s on grand)
        engine.tick(36);
        continue;
      }

      const p1Curr = snap.critters.find((c) => c.id === "p1");
      if (p1Curr && p1Curr.hp > 60) {
        // Chip down with purely vertical fall drops (0 moveStamina spent) so self-blast KOs cleanly
        const base = { ...p1Curr.position };
        for (let drop = 0; drop < 8; drop++) {
          const cur = engine.getSnapshot().critters.find((c) => c.id === "p1");
          if (!cur || !cur.alive || cur.hp <= 25) break;
          engine.applyMove("p1", { x: base.x, y: base.y + 15.0, z: base.z }, 0, 0);
          engine.applyMove("p1", base, 0, 0);
        }
      }

      engine.applyFire("p1", {
        gadgetId: "gale_mortar",
        direction: { x: 0, y: -1, z: 0 },
        power: 0.3,
      });

      const afterFire = engine.getSnapshot();
      const p1AfterFire = afterFire.critters.find((c) => c.id === "p1");
      const events = engine.completeResolving();
      const afterResolve = engine.getSnapshot();

      if (p1AfterFire && !p1AfterFire.alive) {
        selfKoResolved = true;
        // Must skip RETREAT completely!
        expect(afterResolve.phase).not.toBe("RETREAT");
        expect(events.some((e) => e.type === "PHASE_CHANGED" && e.phase === "RETREAT")).toBe(false);
        expect(afterResolve.phase).toBe("ACTIVE");
        expect(afterResolve.activePlayerId).toBe("p2");
        // Self-KO awards 0 KO points
        expect(afterResolve.scores.p1).toBe(0);
        expect(afterResolve.critters.find((c) => c.id === "p1")?.kills).toBe(0);
        break;
      } else {
        // Survived earlier chip blast -> finish 6s retreat to continue loop
        expect(afterResolve.phase).toBe("RETREAT");
        engine.tick(6.1);
      }
    }

    expect(selfKoResolved).toBe(true);
  });

  it("Review Focus #3 (2v2 Alternating Turns): strictly alternates A1 -> B1 -> A1 -> B2 -> A1 after A2 KO and awards 0 friendly-fire KO pts", () => {
    const engine = new MatchEngine({
      roomCode: "DUO2",
      mode: "2v2",
      theme: "emerald_spire",
      seed: 303,
      maxRounds: 3,
      roundDurationSec: 3600,
      players: [
        { id: "A1", name: "A1", species: "mole", team: 0, isBot: false, color: "#e74c3c" },
        { id: "A2", name: "A2", species: "norway_rat", team: 0, isBot: false, color: "#c0392b" },
        { id: "B1", name: "B1", species: "badger", team: 1, isBot: false, color: "#3498db" },
        { id: "B2", name: "B2", species: "glider_squirrel", team: 1, isBot: false, color: "#2980b9" },
      ],
    });

    expect(engine.getSnapshot().mapScale).toBe("grand");
    expect(engine.getSnapshot().activePlayerId).toBe("A1");

    const a2Pos = engine.getSnapshot().critters.find((c) => c.id === "A2")?.position;
    expect(a2Pos).toBeDefined();
    if (!a2Pos) return;

    // Advance A1 toward A2 across turns (respecting stamina & 1/turn grapple) and KO A2 via friendly fire
    let a2Ko = false;
    for (let guard = 0; guard < 28 && !a2Ko; guard++) {
      const snap = engine.getSnapshot();
      const active = snap.activePlayerId;
      if (active === "A2") {
        // Chip A2 down cleanly via vertical drops so A1's Quake Club finishes A2 on arrival
        const a2Curr = snap.critters.find((c) => c.id === "A2");
        if (a2Curr && a2Curr.hp > 20) {
          const base = { ...a2Curr.position };
          for (let d = 0; d < 9; d++) {
            const cur = engine.getSnapshot().critters.find((c) => c.id === "A2");
            if (!cur || !cur.alive || cur.hp <= 15) break;
            engine.applyMove("A2", { x: base.x, y: base.y + 15.0, z: base.z }, 0, 0);
            engine.applyMove("A2", base, 0, 0);
          }
          engine.tick(36);
          continue;
        }
      }
      if (active === "A1") {
        const a1Curr = snap.critters.find((c) => c.id === "A1");
        const a2Curr = snap.critters.find((c) => c.id === "A2");
        if (a1Curr && a2Curr && a2Curr.alive) {
          const inwardSign = a2Curr.position.x < engine.world.centerX ? 1 : -1;
          const safeX = a2Curr.position.x - inwardSign * 1.5;
          const safeY = engine.world.getSurfaceY(safeX, a2Curr.position.z) ?? a2Curr.position.y;
          const goal = { x: safeX, y: safeY, z: a2Curr.position.z };
          // Grapple toward teammate (free!) then walk remaining stamina distance
          const dx = goal.x - a1Curr.position.x;
          const dz = goal.z - a1Curr.position.z;
          if (Math.hypot(dx, dz) > 20) {
            engine.applyUtility("A1", {
              gadgetId: "vine_grapple",
              direction: { x: dx, y: 0.1, z: dz },
              target: goal,
            });
          }
          engine.applyMove("A1", goal, 0, 0);

          const a1AfterMove = engine.getSnapshot().critters.find((c) => c.id === "A1");
          if (
            a1AfterMove &&
            Math.hypot(
              a1AfterMove.position.x - a2Curr.position.x,
              a1AfterMove.position.z - a2Curr.position.z,
            ) <= 2.4 &&
            a2Curr.hp <= 24
          ) {
            engine.applyFire("A1", {
              gadgetId: "quake_club",
              direction: { x: inwardSign, y: 0.1, z: 0 },
              power: 1.0,
            });
            engine.completeResolving();
            if (engine.getSnapshot().phase === "RETREAT") {
              engine.tick(6.1);
            }
            const post = engine.getSnapshot();
            if (!post.critters.find((c) => c.id === "A2")?.alive) {
              a2Ko = true;
            }
            continue;
          }
        }
      }
      engine.tick(36);
    }

    const afterCheck = engine.getSnapshot();
    expect(a2Ko).toBe(true);
    // Friendly fire KO on teammate A2 must award 0 KO points to A1 and Team A!
    expect(afterCheck.scores.A1).toBe(0);
    expect(afterCheck.teamScores.A).toBe(0);
    expect(afterCheck.critters.find((c) => c.id === "A1")?.kills).toBe(0);

    // Advance until A1 is active so we can observe the exact sequence A1 -> B1 -> A1 -> B2 -> A1
    for (let i = 0; i < 4 && engine.getSnapshot().activePlayerId !== "A1"; i++) {
      engine.tick(36);
    }
    expect(engine.getSnapshot().activePlayerId).toBe("A1");

    const observed: Array<string | null> = [];
    for (let step = 0; step < 5; step++) {
      observed.push(engine.getSnapshot().activePlayerId);
      engine.tick(36);
    }

    // Must strictly alternate Team A (A1) and Team B (B1 / B2 cycling)
    expect(observed[0]).toBe("A1");
    expect(observed[2]).toBe("A1");
    expect(observed[4]).toBe("A1");
    expect(new Set([observed[1], observed[3]])).toEqual(new Set(["B1", "B2"]));
  });

  it("Review Focus #4 (Deferred Evo Pod Draft & Full 4 Hardpoints): uninterrupted ACTIVE timer, DRAFT_IF_READY after RETREAT, swap cards when full + Apex recalc", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
        roundDurationSec: 3600,
        players: [
          {
            id: "p1",
            name: "Milo",
            species: "norway_rat",
            team: 0,
            isBot: false,
            color: "#e67e22",
            unlockedBonusGadgets: ["gravity_mine"],
          },
          {
            id: "p2",
            name: "Remy",
            species: "mole",
            team: 1,
            isBot: false,
            color: "#3498db",
          },
        ],
      }),
    );

    // Advance turns so Evo Pods spawn on Turn 2 & Turn 4 (28s on Duel)
    engine.tick(29); // Turn 2 -> p2, spawns Pod #1
    expect(engine.getSnapshot().evoPods.length).toBeGreaterThanOrEqual(1);
    const pod1 = engine.getSnapshot().evoPods[0];
    expect(pod1).toBeDefined();
    if (!pod1) return;

    // Walk p1 to Pod #1 (+50% Evo Charge) cleanly respecting stamina budget
    const ev1 = advanceAndWalkTo(engine, "p1", { ...pod1.position });
    expect(ev1.some((e) => e.type === "EVO_POD_COLLECTED")).toBe(true);

    // Ensure a 2nd uncollected evo_dna Pod has spawned (cycling past med_berry & super_gadget)
    for (let guard = 0; guard < 16; guard++) {
      const s = engine.getSnapshot();
      if (
        s.activePlayerId === "p1" &&
        s.evoPods.some((p) => !p.collected && (p.kind ?? "evo_dna") === "evo_dna")
      ) {
        break;
      }
      engine.tick(29);
    }

    const pod2 = engine
      .getSnapshot()
      .evoPods.find((p) => !p.collected && (p.kind ?? "evo_dna") === "evo_dna");
    expect(pod2).toBeDefined();
    if (!pod2) return;

    // Walk close enough to Pod #2 so the final pickup happens on an ACTIVE turn whose timer we inspect
    for (let guard = 0; guard < 10; guard++) {
      const s = engine.getSnapshot();
      if (s.activePlayerId !== "p1") {
        engine.tick(29);
        continue;
      }
      const p1 = s.critters.find((c) => c.id === "p1");
      if (!p1) break;
      if (Math.hypot(pod2.position.x - p1.position.x, pod2.position.z - p1.position.z) <= p1.maxMoveDistance) {
        break;
      }
      engine.applyMove("p1", { ...pod2.position }, 0, 0);
      engine.tick(29);
    }

    // Tick 2s into ACTIVE turn so timer is 26s, then collect Pod #2 (+50% -> 100% Evo)
    expect(engine.getSnapshot().activePlayerId).toBe("p1");
    expect(engine.getSnapshot().phase).toBe("ACTIVE");
    engine.tick(2.0);
    expect(engine.getSnapshot().phaseTimeRemainingSec).toBeCloseTo(26.0, 2);

    const ev2 = engine.applyMove("p1", { ...pod2.position }, 0, 0);
    expect(ev2.some((e) => e.type === "EVO_POD_COLLECTED")).toBe(true);

    // MUST NOT interrupt ACTIVE phase or timer!
    const midActive = engine.getSnapshot();
    expect(midActive.phase).toBe("ACTIVE");
    expect(midActive.phaseTimeRemainingSec).toBeCloseTo(26.0, 2);
    expect(midActive.critters.find((c) => c.id === "p1")?.evoCharge).toBe(100);
    expect(midActive.critters.find((c) => c.id === "p1")?.pendingEvoDraft).toBe(true);

    // Fire shot -> RESOLVING -> RETREAT -> DRAFT_IF_READY
    engine.applyFire("p1", {
      gadgetId: "gale_mortar",
      direction: { x: 0.5, y: 0.85, z: 0 },
      power: 0.4,
    });
    engine.completeResolving();
    expect(engine.getSnapshot().phase).toBe("RETREAT");
    engine.tick(6.1);

    const draftSnap = engine.getSnapshot();
    expect(draftSnap.phase).toBe("DRAFT_IF_READY");
    expect(draftSnap.pendingDrafts).toHaveLength(1);
    const firstDraft = draftSnap.pendingDrafts[0];
    expect(firstDraft).toBeDefined();
    if (!firstDraft) return;
    expect(firstDraft.playerId).toBe("p1");
    expect(firstDraft.options).toHaveLength(3);
    expect(firstDraft.requiresSlotSwap).toBe(false);

    // Pick first offered mutation -> transitions cleanly to next turn
    const pick1 = firstDraft.options[0];
    expect(pick1).toBeDefined();
    if (!pick1) return;
    const pickEvents = engine.applyMutationPick("p1", pick1);
    expect(pickEvents.some((e) => e.type === "MUTATION_EQUIPPED")).toBe(true);
    expect(engine.getSnapshot().phase).toBe("ACTIVE");

    // Full 4-slot swap draft + Apex recalculation
    const fullEngine = new MatchEngine(
      makeBaseConfig({
        seed: 555,
        roundDurationSec: 3600,
        players: [
          { id: "p1", name: "Milo", species: "mole", team: 0, isBot: false, color: "#e67e22" },
          { id: "p2", name: "Remy", species: "badger", team: 1, isBot: false, color: "#3498db" },
        ],
      }),
    );

    let equippedSlots = 0;
    let sawSwapDraft = false;
    let sawTrailingReroll = false;
    let podsCollectedThisRound = 0;
    let lastRoundSeen = 1;

    for (let step = 0; step < 160 && !sawSwapDraft; step++) {
      const snap = fullEngine.getSnapshot();
      if (snap.phase === "MATCH_OVER") break;
      if (snap.round !== lastRoundSeen) {
        lastRoundSeen = snap.round;
        podsCollectedThisRound = 0;
      }

      if (snap.phase === "ROUND_DRAFT" || snap.phase === "DRAFT_IF_READY") {
        if (snap.phase === "ROUND_DRAFT" && !sawTrailingReroll) {
          const trailingDraft = snap.pendingDrafts.find(
            (d) => d.rerollsRemaining > 0,
          );
          if (trailingDraft) {
            fullEngine.applyRerollDraft(trailingDraft.playerId);
            const afterReroll = fullEngine
              .getSnapshot()
              .pendingDrafts.find((d) => d.playerId === trailingDraft.playerId);
            expect(afterReroll?.rerollsRemaining).toBe(0);
            sawTrailingReroll = true;
          }
        }

        const freshSnap = fullEngine.getSnapshot();
        for (const d of freshSnap.pendingDrafts) {
          if (d.playerId === "p1" && d.requiresSlotSwap) {
            sawSwapDraft = true;
            expect(d.cards).toHaveLength(3);
            expect(d.cards.every((c) => c.replacesMutationId !== null)).toBe(true);
            const swapCard = d.cards[0];
            expect(swapCard).toBeDefined();
            if (swapCard) {
              const eqEvents = fullEngine.applyMutationPick(
                "p1",
                swapCard.mutationId,
                swapCard.slot,
              );
              const eqEv = eqEvents.find((e) => e.type === "MUTATION_EQUIPPED");
              expect(eqEv).toBeDefined();
              const updatedP1 = fullEngine
                .getSnapshot()
                .critters.find((c) => c.id === "p1");
              expect(updatedP1?.equipped[swapCard.slot]).toBe(swapCard.mutationId);
              expect(updatedP1?.apex).not.toBeNull();
            }
            break;
          }
          const choice = d.options[0];
          if (choice) {
            fullEngine.applyMutationPick(d.playerId, choice);
          }
        }
        equippedSlots = Object.keys(
          fullEngine.getSnapshot().critters.find((c) => c.id === "p1")?.equipped ?? {},
        ).length;
        continue;
      }

      if (snap.phase === "ACTIVE" && snap.activePlayerId === "p1") {
        const p1 = snap.critters.find((c) => c.id === "p1");
        const uncollected = snap.evoPods.filter((p) => !p.collected);
        if (p1 && p1.alive && uncollected.length > 0) {
          // Pick nearest uncollected Evo Pod and move/grapple toward it
          uncollected.sort(
            (a, b) =>
              Math.hypot(a.position.x - p1.position.x, a.position.z - p1.position.z) -
              Math.hypot(b.position.x - p1.position.x, b.position.z - p1.position.z),
          );
          const nearest = uncollected[0];
          if (nearest) {
            const dx = nearest.position.x - p1.position.x;
            const dz = nearest.position.z - p1.position.z;
            if (Math.hypot(dx, dz) > 12 && (p1.gadgetCharges.vine_grapple ?? 0) > 0) {
              const uEvs = fullEngine.applyUtility("p1", {
                gadgetId: "vine_grapple",
                direction: { x: dx, y: 0.1, z: dz },
                target: { ...nearest.position },
              });
              if (uEvs.some((e) => e.type === "EVO_POD_COLLECTED")) {
                podsCollectedThisRound += 1;
              }
            }
            if (fullEngine.getSnapshot().critters.find((c) => c.id === "p1")?.alive) {
              const evs = fullEngine.applyMove("p1", { ...nearest.position }, 0, 0);
              if (evs.some((e) => e.type === "EVO_POD_COLLECTED")) {
                podsCollectedThisRound += 1;
              }
            }
          }
        }
      } else if (
        snap.phase === "ACTIVE" &&
        snap.activePlayerId === "p2" &&
        podsCollectedThisRound >= 2 &&
        snap.round < 3
      ) {
        // KO p2 via purely vertical drops (0 moveStamina spent) to enter ROUND_DRAFT
        const p2 = snap.critters.find((c) => c.id === "p2");
        if (p2) {
          const base = { ...p2.position };
          for (let d = 0; d < 16; d++) {
            const cur = fullEngine.getSnapshot().critters.find((c) => c.id === "p2");
            if (!cur || !cur.alive) break;
            fullEngine.applyMove("p2", { x: base.x, y: base.y + 15.0, z: base.z }, 0, 0);
            fullEngine.applyMove("p2", base, 0, 0);
          }
        }
        continue;
      }
      fullEngine.tick(29);
    }

    expect(equippedSlots).toBe(4);
    expect(sawSwapDraft).toBe(true);
    expect(sawTrailingReroll).toBe(true);
  });

  it("guarantees 8 turns per player (Water Rescue Parachute -35 HP in Cycles 1-8), raises water +0.65m/turn from Cycle 9+ Sudden Death, drowns lethally in Cycle 9+, enforces 1-per-turn drone wind nudge, and plans valid bot aim", () => {
    // 2p Duel: Cycles 1-8 = Turns 1..16 (water stays calm + water contact rescues for -35 HP!); Cycle 9 = Turn 17
    const duelEngine = new MatchEngine(makeBaseConfig({ roundDurationSec: 3600 }));
    const duelStartWater = duelEngine.getSnapshot().waterLevel;
    const duelP1Init = duelEngine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(duelP1Init).toBeDefined();
    if (!duelP1Init) return;

    // Cycle 1 early water plunge -> Parachute Rescue (-35 HP, survives on dry ground!)
    const rescueEvs = duelEngine.applyMove(
      "p1",
      { x: duelP1Init.position.x, y: duelStartWater - 0.3, z: duelP1Init.position.z },
      0,
      0,
    );
    expect(rescueEvs.some((e) => e.type === "WATER_RESCUED")).toBe(true);
    const afterRescue = duelEngine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(afterRescue?.alive).toBe(true);
    expect(afterRescue?.hp).toBe(duelP1Init.hp - 35);
    expect((afterRescue?.position.y ?? 0)).toBeGreaterThan(duelStartWater + 1.0);

    for (let t = 2; t <= 16; t++) {
      duelEngine.tick(29);
      expect(duelEngine.getSnapshot().turnNumber).toBe(t);
      expect(duelEngine.getSnapshot().waterLevel).toBe(duelStartWater);
    }
    const duelCycle9Events = duelEngine.tick(29);
    expect(duelEngine.getSnapshot().turnNumber).toBe(17);
    expect(duelEngine.getSnapshot().waterLevel).toBeCloseTo(duelStartWater + 0.65, 4);
    expect(duelCycle9Events.some((e) => e.type === "WATER_ROSE")).toBe(true);

    // 3p Grand: Cycles 1-8 = Turns 1..24; Sudden Death begins at Cycle 9 (Turn 25)
    const engine = new MatchEngine(
      makeBaseConfig({
        roundDurationSec: 3600,
        players: [
          { id: "p1", name: "Milo", species: "mole", team: 0, isBot: false, color: "#e67e22" },
          { id: "p2", name: "Remy", species: "norway_rat", team: 1, isBot: true, color: "#3498db" },
          { id: "p3", name: "Bram", species: "badger", team: 0, isBot: true, color: "#2ecc71" },
        ],
      }),
    );

    expect(engine.getSnapshot().mapScale).toBe("grand");
    const startWater = engine.getSnapshot().waterLevel;
    // Turns 1 -> 24 (Cycles 1..8): water stays constant on 3p Grand
    for (let t = 2; t <= 24; t++) {
      engine.tick(36);
      expect(engine.getSnapshot().turnNumber).toBe(t);
      expect(engine.getSnapshot().waterLevel).toBe(startWater);
    }

    // Turn 24 -> 25 (Cycle 9): water rises +0.65m and emits WATER_ROSE
    const cycle9Events = engine.tick(36);
    expect(engine.getSnapshot().turnNumber).toBe(25);
    expect(engine.getSnapshot().waterLevel).toBeCloseTo(startWater + 0.65, 4);
    expect(cycle9Events.some((e) => e.type === "WATER_ROSE")).toBe(true);

    // Advance to p1's turn in Cycle 9+ and drown p1 lethally by plunging straight below waterLevel
    for (let i = 0; i < 3 && engine.getSnapshot().activePlayerId !== "p1"; i++) {
      engine.tick(36);
    }
    const snapP1 = engine.getSnapshot();
    expect(snapP1.activePlayerId).toBe("p1");
    const p1Pos = snapP1.critters.find((c) => c.id === "p1")?.position;
    expect(p1Pos).toBeDefined();
    if (!p1Pos) return;
    engine.applyMove(
      "p1",
      { x: p1Pos.x, y: snapP1.waterLevel - 0.2, z: p1Pos.z },
      0,
      0,
    );
    const afterDrown = engine.getSnapshot();
    expect(afterDrown.critters.find((c) => c.id === "p1")?.alive).toBe(false);

    // KO'd critter (p1) gets exactly 1 Spectator Drone wind nudge per turn
    const windBefore = { ...afterDrown.wind };
    const nudge1 = engine.applyDroneNudge("p1", { x: 1.0, y: 0, z: 0 });
    expect(nudge1.some((e) => e.type === "WIND_NUDGED")).toBe(true);
    const windAfter1 = { ...engine.getSnapshot().wind };
    expect(windAfter1.x).not.toBe(windBefore.x);

    // Second nudge in same turn is rejected
    const nudge2 = engine.applyDroneNudge("p1", { x: 1.0, y: 0, z: 0 });
    expect(nudge2).toHaveLength(0);
    expect(engine.getSnapshot().wind).toEqual(windAfter1);

    // Bot planner produces valid non-zero aim toward an alive enemy on Grand maps
    const botSnap = engine.getSnapshot();
    const activeBotId = botSnap.activePlayerId;
    expect(activeBotId).not.toBeNull();
    if (!activeBotId) return;

    const plan = planBotTurn(botSnap, engine.world, activeBotId);
    const dirLen = Math.hypot(plan.direction.x, plan.direction.y, plan.direction.z);
    expect(dirLen).toBeCloseTo(1.0, 3);
    expect(plan.power).toBeGreaterThanOrEqual(0.25);
    expect(plan.power).toBeLessThanOrEqual(1.0);
    expect(Number.isFinite(plan.moveTarget.x)).toBe(true);
  });

  it("supports twin_pod bonus mini-dart, seeker_firefly homing, and 2v2 bot never targeting teammates", () => {
    const world = new SdfWorld(101, "emerald_spire");
    const spawns = world.findSpawnPoints(2);
    const s0 = spawns[0];
    const s1 = spawns[1];
    expect(s0).toBeDefined();
    expect(s1).toBeDefined();
    if (!s0 || !s1) return;

    const target = makeDummyCritter({
      id: "enemy",
      species: "norway_rat",
      position: { x: s0.x, y: s0.y, z: s0.z },
      hp: 230,
      maxHp: 230,
    });

    // Twin Shoulder Pod adds secondary mini-dart blast on direct hit
    const twinRes = simulateShot(
      world,
      [target],
      {
        shooterId: "shooter",
        gadgetId: "gale_mortar",
        origin: { x: s0.x, y: s0.y + 1.4, z: s0.z },
        direction: { x: 0, y: -1, z: 0 },
        power: 0.4,
        species: "mole",
        equipped: { offense: "twin_pod" },
        apex: "apex_hybrid",
      },
      { x: 0, y: 0, z: 0 },
      1.5,
    );
    expect(twinRes.impacts.length).toBe(2);
    expect(twinRes.carveOps.length).toBe(2);

    // Seeker Firefly homes smoothly over dividing walls onto droneTarget across the 60m archipelago
    const fireflyTarget = { x: s1.x, y: s1.y + 0.5, z: s1.z };
    const fireflyRes = simulateShot(
      world,
      [],
      {
        shooterId: "shooter",
        gadgetId: "seeker_firefly",
        origin: { x: s0.x, y: s0.y + 1.5, z: s0.z },
        direction: { x: 0.2, y: 0.98, z: 0 },
        power: 0.6,
        droneTarget: fireflyTarget,
        species: "mole",
        equipped: {},
        apex: null,
      },
      { x: 4, y: 0, z: 4 },
      1.5,
    );
    expect(fireflyRes.impacts.length).toBe(1);
    const impactPos = fireflyRes.impacts[0]?.position;
    expect(impactPos).toBeDefined();
    if (impactPos) {
      const startDist = Math.hypot(s1.x - s0.x, s1.z - s0.z);
      const endDist = Math.hypot(s1.x - impactPos.x, s1.z - impactPos.z);
      expect(endDist).toBeLessThan(startDist * 0.5);
    }

    // 2v2 Bot AI ignores adjacent teammate (A2) and targets distant enemy (B1)
    const duoEngine = new MatchEngine({
      roomCode: "BOT2",
      mode: "2v2",
      theme: "emerald_spire",
      seed: 202,
      players: [
        { id: "A1", name: "A1", species: "mole", team: 0, isBot: true, color: "#e74c3c" },
        { id: "A2", name: "A2", species: "norway_rat", team: 0, isBot: true, color: "#c0392b" },
        { id: "B1", name: "B1", species: "badger", team: 1, isBot: true, color: "#3498db" },
        { id: "B2", name: "B2", species: "glider_squirrel", team: 1, isBot: true, color: "#2980b9" },
      ],
    });
    const snap = duoEngine.getSnapshot();
    const a1 = snap.critters.find((c) => c.id === "A1");
    const a2 = snap.critters.find((c) => c.id === "A2");
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    if (a1 && a2) {
      // Place A2 1m away from A1 -> if bot targeted teammates it would pick quake_club!
      a2.position = { x: a1.position.x + 1.0, y: a1.position.y, z: a1.position.z };
      const plan2v2 = planBotTurn(snap, duoEngine.world, "A1");
      expect(plan2v2.gadgetId).not.toBe("quake_club");
    }
  });

  it("preserves outer-edge cliffs in Rounds 1-4 (no automatic crumbleOuterRing) while Cycle 9+ vine_grapple water plunge still drowns lethally", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
        roundDurationSec: 3600,
        players: [
          { id: "p1", name: "Milo", species: "mole", team: 0, isBot: false, color: "#e67e22" },
          { id: "p2", name: "Remy", species: "norway_rat", team: 1, isBot: false, color: "#3498db" },
          { id: "p3", name: "Bram", species: "badger", team: 0, isBot: false, color: "#2ecc71" },
        ],
      }),
    );

    expect(engine.getSnapshot().mapScale).toBe("grand");

    // Walk p1 outward onto the far rim (radius > 66m from center 72,72) across turns respecting stamina
    const rimGoal = { x: 141.5, y: 12.0, z: engine.world.centerZ };
    advanceAndWalkTo(engine, "p1", rimGoal, 20);
    expect(engine.getSnapshot().critters.find((c) => c.id === "p1")?.alive).toBe(true);

    // Advance to Cycle 9 (Turn 25 in 3p Grand): outer-ring crumble is disabled in R1-4 to preserve persistent island
    for (let guard = 0; guard < 40 && engine.getSnapshot().turnNumber < 25; guard++) {
      engine.tick(36);
    }

    const snap25 = engine.getSnapshot();
    expect(snap25.turnNumber).toBe(25);
    expect(snap25.waterLevel).toBeGreaterThan(1.5);
    const p1AtCycle9 = snap25.critters.find((c) => c.id === "p1");
    expect(p1AtCycle9?.alive).toBe(true);

    // Verify vine_grapple targeting below waterLevel during Cycle 9+ Sudden Death drowns lethally
    const activeId = snap25.activePlayerId;
    expect(activeId).not.toBeNull();
    if (!activeId) return;
    const activeCritter = snap25.critters.find((c) => c.id === activeId);
    expect(activeCritter).toBeDefined();
    if (!activeCritter) return;

    engine.applyUtility(activeId, {
      gadgetId: "vine_grapple",
      direction: { x: 0, y: -1, z: 0 },
      target: {
        x: activeCritter.position.x,
        y: snap25.waterLevel - 0.5,
        z: activeCritter.position.z,
      },
    });
    const afterPlunge = engine.getSnapshot();
    expect(afterPlunge.critters.find((c) => c.id === activeId)?.alive).toBe(false);
  });

  it("spawns 8-10 interactive hazards and triggers blast_barrel chain detonation, steam_geyser launch, and thorn_patch cooldown", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
        seed: 2027,
        theme: "emerald_spire",
      }),
    );

    const init = engine.getSnapshot();
    const hazards = init.hazards ?? [];
    expect(hazards.length).toBeGreaterThanOrEqual(8);
    expect(hazards.length).toBeLessThanOrEqual(10);
    expect(hazards.every((h) => h.active)).toBe(true);

    const barrel = hazards.find((h) => h.type === "blast_barrel");
    const geyser = hazards.find((h) => h.type === "steam_geyser");
    const thorn = hazards.find((h) => h.type === "thorn_patch");
    expect(barrel).toBeDefined();
    expect(geyser).toBeDefined();
    expect(thorn).toBeDefined();
    if (!barrel || !geyser || !thorn) return;

    // 1. Stepping onto a Thermal Steam Geyser catapults critter skyward and emits HAZARD_TRIGGERED
    const geyserEvents = advanceAndWalkTo(
      engine,
      "p1",
      { ...geyser.position },
      16,
      (evs) => evs.some((e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "steam_geyser"),
    );
    const geyserEv = geyserEvents.find(
      (e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "steam_geyser",
    );
    expect(geyserEv).toBeDefined();
    if (geyserEv && geyserEv.type === "HAZARD_TRIGGERED") {
      expect(geyserEv.hazardId).toBe(geyser.id);
      expect(geyserEv.affectedCritterIds).toContain("p1");
    }
    const p1AfterGeyser = engine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(p1AfterGeyser).toBeDefined();
    if (p1AfterGeyser) {
      expect(p1AfterGeyser.position.y).toBeGreaterThanOrEqual(geyser.position.y + 5.0);
    }

    // 2. Stepping into a Bramble Thorn Patch deals 12 damage + nudge, with 1-per-turn cooldown
    const hpBeforeThorn = p1AfterGeyser?.hp ?? 240;
    const thornEvents1 = advanceAndWalkTo(
      engine,
      "p1",
      { ...thorn.position },
      16,
      (evs) => evs.some((e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "thorn_patch"),
    );
    const thornEv1 = thornEvents1.find(
      (e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "thorn_patch",
    );
    expect(thornEv1).toBeDefined();
    const p1AfterThorn1 = engine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(p1AfterThorn1?.hp).toBe(hpBeforeThorn - 12);
    if (p1AfterThorn1) {
      const nudgeDist = Math.hypot(
        p1AfterThorn1.position.x - thorn.position.x,
        p1AfterThorn1.position.z - thorn.position.z,
      );
      expect(nudgeDist).toBeGreaterThan(0.2);
    }

    // Second step onto thorn patch on same turn must NOT re-trigger
    const thornEvents2 = engine.applyMove("p1", { ...thorn.position }, 0, 0);
    expect(
      thornEvents2.some(
        (e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "thorn_patch",
      ),
    ).toBe(false);
    expect(engine.getSnapshot().critters.find((c) => c.id === "p1")?.hp).toBe(
      hpBeforeThorn - 12,
    );

    // 3. Firing near a Blast Barrel detonates it (carving 2.8m crater, dealing 28+ dmg, chain-detonating neighbor barrels!)
    const barrelPartner = hazards.find(
      (h) =>
        h.type === "blast_barrel" &&
        h.id !== barrel.id &&
        Math.hypot(
          h.position.x - barrel.position.x,
          h.position.y - barrel.position.y,
          h.position.z - barrel.position.z,
        ) <= 4.6,
    );

    const shooterPos = {
      x: barrel.position.x + 2.0,
      y: barrel.position.y + 0.2,
      z: barrel.position.z,
    };
    advanceAndWalkTo(engine, "p1", shooterPos);
    const hpBeforeBarrel =
      engine.getSnapshot().critters.find((c) => c.id === "p1")?.hp ?? 240;

    const fireEvents = engine.applyFire("p1", {
      gadgetId: "gale_mortar",
      direction: { x: -1, y: -0.25, z: 0 },
      power: 0.2,
    });

    const barrelTriggers = fireEvents.filter(
      (e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "blast_barrel",
    );
    expect(barrelTriggers.length).toBeGreaterThanOrEqual(barrelPartner ? 2 : 1);

    const barrelCarve = fireEvents.find(
      (e) => e.type === "TERRAIN_CARVED" && Math.abs(e.op.radius - 2.8) < 0.01,
    );
    expect(barrelCarve).toBeDefined();

    const afterSnap = engine.getSnapshot();
    const updatedBarrel = afterSnap.hazards?.find((h) => h.id === barrel.id);
    expect(updatedBarrel?.active).toBe(false);
    if (barrelPartner) {
      const updatedPartner = afterSnap.hazards?.find(
        (h) => h.id === barrelPartner.id,
      );
      expect(updatedPartner?.active).toBe(false);
    }

    const p1AfterBarrel = afterSnap.critters.find((c) => c.id === "p1");
    expect(p1AfterBarrel).toBeDefined();
    if (p1AfterBarrel) {
      expect(p1AfterBarrel.hp).toBeLessThanOrEqual(hpBeforeBarrel - 28);
    }
  });

  it("scales grand matches with 35s turns, 26m/6-charge vine grapple, x1.35 blast carves, and explicit mapScale overrides", () => {
    // Explicit 'grand' override on a 2-player match
    const grandEngine = new MatchEngine(
      makeBaseConfig({
        seed: 777,
        mapScale: "grand",
      }),
    );
    const grandSnap = grandEngine.getSnapshot();
    expect(grandSnap.mapScale).toBe("grand");
    expect(grandSnap.phaseTimeRemainingSec).toBe(35);
    expect(grandEngine.world.worldWidth).toBe(144);
    expect(grandEngine.world.worldDepth).toBe(144);

    const p1 = grandSnap.critters.find((c) => c.id === "p1");
    expect(p1?.gadgetCharges.vine_grapple).toBe(6);

    if (p1) {
      // 26m grand Vine Grapple reach
      const toCenterX = grandEngine.world.centerX - p1.position.x;
      const toCenterZ = grandEngine.world.centerZ - p1.position.z;
      const len = Math.hypot(toCenterX, toCenterZ) || 1;
      grandEngine.applyUtility("p1", {
        gadgetId: "vine_grapple",
        direction: { x: toCenterX / len, y: 0.1, z: toCenterZ / len },
        target: {
          x: p1.position.x + (toCenterX / len) * 24.5,
          y: p1.position.y + 1.0,
          z: p1.position.z + (toCenterZ / len) * 24.5,
        },
      });
      const moved = grandEngine.getSnapshot().critters.find((c) => c.id === "p1");
      expect(moved?.gadgetCharges.vine_grapple).toBe(5);
      if (moved) {
        const horizMoved = Math.hypot(
          moved.position.x - p1.position.x,
          moved.position.z - p1.position.z,
        );
        expect(horizMoved).toBeGreaterThan(22.0);
      }

      // Blast carve radius is x1.35 larger on grand vs duel
      const grandFire = grandEngine.applyFire("p1", {
        gadgetId: "gale_mortar",
        direction: { x: 0, y: -1, z: 0 },
        power: 0.25,
      });
      const grandCarve = grandFire.find((e) => e.type === "TERRAIN_CARVED");
      expect(grandCarve).toBeDefined();
      if (grandCarve && grandCarve.type === "TERRAIN_CARVED") {
        // Mole (1.2x) * Gale Mortar (3.2) * Grand (1.35x) = 5.184m
        expect(grandCarve.op.radius).toBeCloseTo(3.2 * 1.2 * 1.35, 2);
      }
    }

    // Explicit 'duel' override on a 4-player match
    const forcedDuel = new MatchEngine(
      makeBaseConfig({
        seed: 778,
        mapScale: "duel",
        players: [
          { id: "p1", name: "A", species: "mole", team: 0 },
          { id: "p2", name: "B", species: "norway_rat", team: 1 },
          { id: "p3", name: "C", species: "badger", team: 0 },
          { id: "p4", name: "D", species: "glider_squirrel", team: 1 },
        ],
      }),
    );
    expect(forcedDuel.getSnapshot().mapScale).toBe("duel");
    expect(forcedDuel.getSnapshot().phaseTimeRemainingSec).toBe(28);
    expect(forcedDuel.world.worldWidth).toBe(60);
  });

  it("triggers spark_mine proximity detonation (2.4m) with crater carve, damage, knockback, and HAZARD_TRIGGERED", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
        seed: 4242,
        theme: "emerald_spire",
      }),
    );

    const init = engine.getSnapshot();
    const p1Before = init.critters.find((c) => c.id === "p1");
    expect(p1Before).toBeDefined();
    if (!p1Before) return;

    const mines = (init.hazards ?? []).filter((h) => h.type === "spark_mine");
    mines.sort(
      (a, b) =>
        Math.hypot(a.position.x - p1Before.position.x, a.position.z - p1Before.position.z) -
        Math.hypot(b.position.x - p1Before.position.x, b.position.z - p1Before.position.z),
    );
    const mine = mines[0];
    expect(mine).toBeDefined();
    if (!mine) return;
    expect(mine.active).toBe(true);
    expect(mine.radius).toBe(2.4);

    // Walk within 2.4m of the active spark_mine -> arms & detonates!
    const stepPos = {
      x: mine.position.x + 1.2,
      y: mine.position.y,
      z: mine.position.z,
    };
    const hpBefore = p1Before.hp;
    const events = advanceAndWalkTo(engine, "p1", stepPos);

    const triggerEv = events.find(
      (e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "spark_mine",
    );
    expect(triggerEv).toBeDefined();
    if (triggerEv && triggerEv.type === "HAZARD_TRIGGERED") {
      expect(triggerEv.hazardId).toBe(mine.id);
      expect(triggerEv.affectedCritterIds).toContain("p1");
    }

    const carveEv = events.find(
      (e) => e.type === "TERRAIN_CARVED" && Math.abs(e.op.radius - 2.2) < 0.01,
    );
    expect(carveEv).toBeDefined();

    const after = engine.getSnapshot();
    const updatedMine = after.hazards?.find((h) => h.id === mine.id);
    expect(updatedMine?.active).toBe(false);
    expect(updatedMine?.armed).toBe(true);

    const p1After = after.critters.find((c) => c.id === "p1");
    expect(p1After).toBeDefined();
    if (p1After) {
      // Deals 24 base damage (or more if knocked off cliff into fall/water)
      expect(p1After.hp).toBeLessThanOrEqual(hpBefore - 24);
      const knockSpeed = Math.hypot(
        p1After.velocity.x,
        p1After.velocity.y,
        p1After.velocity.z,
      );
      expect(knockSpeed).toBeGreaterThan(6.0);
    }
  });

  it("applies fair fall damage when dropping > 7.5m onto solid rock, capped at 25 and halved by Spring Paws", () => {
    // Pure formula verification
    expect(computeFallDamage(7.5, 0)).toBe(0);
    expect(computeFallDamage(5.0, 0)).toBe(0);
    expect(computeFallDamage(11.5, 0)).toBe(14);
    expect(computeFallDamage(11.5, 0.5)).toBe(7);
    expect(computeFallDamage(20.0, 0)).toBe(25);
    expect(computeFallDamage(20.0, 0.5)).toBe(13);

    // Runtime MatchEngine fall damage test on solid rock
    const engine = new MatchEngine(
      makeBaseConfig({
        seed: 3333,
        theme: "emerald_spire",
      }),
    );
    const init = engine.getSnapshot();
    const p1 = init.critters.find((c) => c.id === "p1");
    expect(p1).toBeDefined();
    if (!p1) return;

    const landingPos = { ...p1.position };
    const startHp = p1.hp;

    // Small drop (5.0m <= 7.5m) onto solid ground -> 0 fall damage
    engine.applyMove("p1", { x: landingPos.x, y: landingPos.y + 5.0, z: landingPos.z }, 0, 0);
    engine.applyMove("p1", landingPos, 0, 0);
    expect(engine.getSnapshot().critters.find((c) => c.id === "p1")?.hp).toBe(startHp);

    // Big drop (11.5m > 7.5m) onto solid rock -> (11.5 - 7.5) * 3.5 = 14 fall damage
    engine.applyMove("p1", { x: landingPos.x, y: landingPos.y + 11.5, z: landingPos.z }, 0, 0);
    engine.applyMove("p1", landingPos, 0, 0);
    expect(engine.getSnapshot().critters.find((c) => c.id === "p1")?.hp).toBe(startHp - 14);

    // Spring Paws (fallDamageResist: 0.5) halves fall damage on the same drop via simulateShot settle
    const world = new SdfWorld(3333, "emerald_spire");
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    if (!sp) return;

    const normalDropper = makeDummyCritter({
      id: "normal",
      species: "mole",
      position: { x: sp.x, y: sp.y + 11.5, z: sp.z },
      hp: 100,
    });
    const springDropper = makeDummyCritter({
      id: "spring",
      species: "mole",
      position: { x: sp.x, y: sp.y + 11.5, z: sp.z },
      hp: 100,
      equipped: { legs: "spring_paws" },
    });

    // Trigger post-carve settle from 11.5m directly above solid landing rock (zero direct blast damage)
    const simNormal = simulateShot(
      world,
      [normalDropper],
      {
        shooterId: "other",
        gadgetId: "gale_mortar",
        origin: { x: sp.x, y: sp.y + 1.0, z: sp.z },
        direction: { x: 0, y: -1, z: 0 },
        power: 0.2,
        species: "mole",
        equipped: {},
        apex: null,
      },
      { x: 0, y: 0, z: 0 },
      1.5,
    );
    const simSpring = simulateShot(
      world,
      [springDropper],
      {
        shooterId: "other",
        gadgetId: "gale_mortar",
        origin: { x: sp.x, y: sp.y + 1.0, z: sp.z },
        direction: { x: 0, y: -1, z: 0 },
        power: 0.2,
        species: "mole",
        equipped: {},
        apex: null,
      },
      { x: 0, y: 0, z: 0 },
      1.5,
    );

    const normalHit = simNormal.hits.find((h) => h.critterId === "normal");
    const springHit = simSpring.hits.find((h) => h.critterId === "spring");
    expect(normalHit).toBeDefined();
    expect(springHit).toBeDefined();
    if (normalHit && springHit) {
      expect(normalHit.damage).toBeGreaterThanOrEqual(14);
      expect(springHit.damage).toBe(Math.round(normalHit.damage * 0.5));
    }
  });

  it("caps per-turn walking distance to moveStamina budget (14m Duel / 20m Grand), allows aiming/firing/free grapple+rappel at 0%, grants fresh Retreat dash burst (+45% Armadillo), and refills on next ACTIVE turn", () => {
    // 1. Duel (60m): Mole = 14m, Norway Rat = 14 * 1.18 = 16.52m, Armadillo Retreat = 5 * 1.45 = 7.25m
    const duelEngine = new MatchEngine(
      makeBaseConfig({
        seed: 4444,
        theme: "emerald_spire",
        players: [
          { id: "p1", name: "Milo", species: "mole", team: 0 },
          { id: "p2", name: "Remy", species: "norway_rat", team: 1 },
        ],
      }),
    );

    const duelInit = duelEngine.getSnapshot();
    const p1Start = duelInit.critters.find((c) => c.id === "p1");
    const p2Start = duelInit.critters.find((c) => c.id === "p2");
    expect(p1Start?.moveStamina).toBe(100);
    expect(p1Start?.maxMoveDistance).toBeCloseTo(14.0, 3);
    expect(p2Start?.maxMoveDistance).toBeCloseTo(14.0 * 1.18, 3);
    if (!p1Start) return;

    // Attempt to walk 60m in a single ACTIVE turn -> cleanly capped at exactly 14m, stamina hits 0
    const toCenterX = duelEngine.world.centerX - p1Start.position.x;
    const toCenterZ = duelEngine.world.centerZ - p1Start.position.z;
    const norm = Math.hypot(toCenterX, toCenterZ) || 1;
    const dirX = toCenterX / norm;
    const dirZ = toCenterZ / norm;

    duelEngine.applyMove(
      "p1",
      {
        x: p1Start.position.x + dirX * 60.0,
        y: p1Start.position.y,
        z: p1Start.position.z + dirZ * 60.0,
      },
      0.5,
      0.2,
    );

    const afterCap = duelEngine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(afterCap).toBeDefined();
    if (!afterCap) return;
    const movedHoriz = Math.hypot(
      afterCap.position.x - p1Start.position.x,
      afterCap.position.z - p1Start.position.z,
    );
    expect(movedHoriz).toBeCloseTo(14.0, 2);
    expect(afterCap.moveStamina).toBe(0);

    // Further horizontal walk at 0% stamina is clamped, while yaw/pitch aiming still updates!
    duelEngine.applyMove(
      "p1",
      {
        x: afterCap.position.x + 10.0,
        y: afterCap.position.y,
        z: afterCap.position.z + 10.0,
      },
      1.35,
      -0.25,
    );
    const afterZeroAttempt = duelEngine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(afterZeroAttempt?.position.x).toBeCloseTo(afterCap.position.x, 4);
    expect(afterZeroAttempt?.position.z).toBeCloseTo(afterCap.position.z, 4);
    expect(afterZeroAttempt?.yaw).toBeCloseTo(1.35, 4);
    expect(afterZeroAttempt?.pitch).toBeCloseTo(-0.25, 4);
    expect(afterZeroAttempt?.moveStamina).toBe(0);

    // At 0% stamina, Vine Grapple (rappel down 6m without fall damage!) STILL works for FREE and emits VINE_GRAPPLED
    const hpBeforeRappel = afterCap.hp;
    const rappelTarget = {
      x: afterCap.position.x + dirX * 5.0,
      y: Math.max(duelInit.waterLevel + 1.2, afterCap.position.y - 4.0),
      z: afterCap.position.z + dirZ * 5.0,
    };
    const grappleEvs = duelEngine.applyUtility("p1", {
      gadgetId: "vine_grapple",
      direction: { x: dirX, y: -0.5, z: dirZ },
      target: rappelTarget,
    });
    expect(grappleEvs.some((e) => e.type === "VINE_GRAPPLED")).toBe(true);
    const afterGrapple = duelEngine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(afterGrapple?.moveStamina).toBe(0);
    expect(afterGrapple?.gadgetCharges.vine_grapple).toBe(5);
    expect(afterGrapple?.grappleUsedThisTurn).toBe(true);
    expect(afterGrapple?.hp).toBe(hpBeforeRappel);

    // Second Vine Grapple in the same turn is blocked (once-per-turn cap)
    const secondGrappleEvs = duelEngine.applyUtility("p1", {
      gadgetId: "vine_grapple",
      direction: { x: dirX, y: 0.2, z: dirZ },
      target: { x: p1Start.position.x, y: p1Start.position.y, z: p1Start.position.z },
    });
    expect(secondGrappleEvs).toHaveLength(0);
    expect(
      duelEngine.getSnapshot().critters.find((c) => c.id === "p1")?.gadgetCharges.vine_grapple,
    ).toBe(5);

    // At 0% stamina, critter can STILL fire and enters RETREAT with fresh 40% (5m) retreat dash burst!
    const fireEvs = duelEngine.applyFire("p1", {
      gadgetId: "gale_mortar",
      direction: { x: dirX, y: 0.85, z: dirZ },
      power: 0.4,
    });
    expect(fireEvs.some((e) => e.type === "SHOT_RESOLVED")).toBe(true);
    duelEngine.completeResolving();

    const retreatSnap = duelEngine.getSnapshot();
    expect(retreatSnap.phase).toBe("RETREAT");
    const p1RetreatStart = retreatSnap.critters.find((c) => c.id === "p1");
    expect(p1RetreatStart?.moveStamina).toBe(40);
    if (!p1RetreatStart) return;

    duelEngine.applyMove(
      "p1",
      {
        x: p1RetreatStart.position.x - dirX * 20.0,
        y: p1RetreatStart.position.y,
        z: p1RetreatStart.position.z - dirZ * 20.0,
      },
      0,
      0,
    );
    const p1AfterRetreat = duelEngine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(p1AfterRetreat?.moveStamina).toBe(0);
    if (p1AfterRetreat) {
      const retreatDist = Math.hypot(
        p1AfterRetreat.position.x - p1RetreatStart.position.x,
        p1AfterRetreat.position.z - p1RetreatStart.position.z,
      );
      expect(retreatDist).toBeCloseTo(5.0, 2);
    }

    // Advance through RETREAT + p2's turn -> p1's next ACTIVE turn refills moveStamina to 100 and resets grapple!
    duelEngine.tick(6.5); // -> p2 ACTIVE
    duelEngine.tick(29.0); // -> p1 ACTIVE
    const p1NextTurn = duelEngine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(duelEngine.getSnapshot().activePlayerId).toBe("p1");
    expect(p1NextTurn?.moveStamina).toBe(100);
    expect(p1NextTurn?.grappleUsedThisTurn).toBe(false);

    // 2. Grand (144m): Mole = 20m active budget; Armadillo gets +45% retreat burst (7 * 1.45 = 10.15m)
    const grandEngine = new MatchEngine(
      makeBaseConfig({
        seed: 5555,
        mapScale: "grand",
        players: [
          { id: "a1", name: "Roller", species: "armadillo", team: 0 },
          { id: "b1", name: "Milo", species: "mole", team: 1 },
        ],
      }),
    );
    const a1Start = grandEngine.getSnapshot().critters.find((c) => c.id === "a1");
    expect(a1Start?.maxMoveDistance).toBeCloseTo(20.0, 3);
    if (!a1Start) return;

    const gToX = grandEngine.world.centerX - a1Start.position.x;
    const gToZ = grandEngine.world.centerZ - a1Start.position.z;
    const gNorm = Math.hypot(gToX, gToZ) || 1;
    grandEngine.applyMove(
      "a1",
      {
        x: a1Start.position.x + (gToX / gNorm) * 60.0,
        y: a1Start.position.y,
        z: a1Start.position.z + (gToZ / gNorm) * 60.0,
      },
      0,
      0,
    );
    const a1AfterWalk = grandEngine.getSnapshot().critters.find((c) => c.id === "a1");
    expect(a1AfterWalk?.moveStamina).toBe(0);
    if (a1AfterWalk) {
      expect(
        Math.hypot(
          a1AfterWalk.position.x - a1Start.position.x,
          a1AfterWalk.position.z - a1Start.position.z,
        ),
      ).toBeCloseTo(20.0, 2);
    }

    // Armadillo RETREAT burst on Grand = 7.0 * 1.45 = 10.15m
    grandEngine.applyFire("a1", {
      gadgetId: "gale_mortar",
      direction: { x: gToX / gNorm, y: 0.85, z: gToZ / gNorm },
      power: 0.4,
    });
    grandEngine.completeResolving();
    const a1RetStart = grandEngine.getSnapshot().critters.find((c) => c.id === "a1");
    expect(a1RetStart?.moveStamina).toBe(40);
    if (a1RetStart) {
      grandEngine.applyMove(
        "a1",
        {
          x: a1RetStart.position.x - (gToX / gNorm) * 30.0,
          y: a1RetStart.position.y,
          z: a1RetStart.position.z - (gToZ / gNorm) * 30.0,
        },
        0,
        0,
      );
      const a1RetEnd = grandEngine.getSnapshot().critters.find((c) => c.id === "a1");
      expect(a1RetEnd?.moveStamina).toBe(0);
      if (a1RetEnd) {
        expect(
          Math.hypot(
            a1RetEnd.position.x - a1RetStart.position.x,
            a1RetEnd.position.z - a1RetStart.position.z,
          ),
        ).toBeCloseTo(7.0 * 1.45, 2);
      }
    }
  });

  it("cycles air-drop crates across evo_dna, med_berry (+55 HP heal clamped to maxHp), and super_gadget (rare gadget +25 Evo)", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
        seed: 7070,
        theme: "mountain_spine",
        roundDurationSec: 3600,
      }),
    );

    // Spawn 3 consecutive air-drop crates on Turns 2, 4, and 6
    const seenKinds: string[] = [];
    for (let guard = 0; guard < 12 && seenKinds.length < 3; guard++) {
      const evs = engine.tick(29);
      for (const ev of evs) {
        if (ev.type === "EVO_POD_SPAWNED") {
          seenKinds.push(ev.pod.kind ?? "missing");
        }
      }
    }
    expect(seenKinds).toEqual(["evo_dna", "med_berry", "super_gadget"]);

    const pods = engine.getSnapshot().evoPods;
    const medPod = pods.find((p) => p.kind === "med_berry");
    const superPod = pods.find((p) => p.kind === "super_gadget");
    expect(medPod).toBeDefined();
    expect(superPod).toBeDefined();
    if (!medPod || !superPod) return;

    // Damage p1 cleanly by ~75 HP via 3 vertical fall drops (25 dmg each) so +55 HP heals strictly without capping early
    for (let guard = 0; guard < 6 && engine.getSnapshot().activePlayerId !== "p1"; guard++) {
      engine.tick(29);
    }
    const p1BeforeDrop = engine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(p1BeforeDrop).toBeDefined();
    if (!p1BeforeDrop) return;
    const basePos = { ...p1BeforeDrop.position };
    for (let d = 0; d < 3; d++) {
      engine.applyMove("p1", { x: basePos.x, y: basePos.y + 15.0, z: basePos.z }, 0, 0);
      engine.applyMove("p1", basePos, 0, 0);
    }

    const p1Hurt = engine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(p1Hurt).toBeDefined();
    if (!p1Hurt) return;
    const hpBeforeHeal = p1Hurt.hp;
    expect(hpBeforeHeal).toBeLessThanOrEqual(p1Hurt.maxHp - 60);

    // Collect med_berry -> restores +55 HP (clamped to maxHp)
    const medEvs = advanceAndWalkTo(engine, "p1", { ...medPod.position });
    const medCollected = medEvs.find(
      (e) => e.type === "EVO_POD_COLLECTED" && e.podId === medPod.id,
    );
    expect(medCollected).toBeDefined();
    if (medCollected && medCollected.type === "EVO_POD_COLLECTED") {
      expect(medCollected.podKind).toBe("med_berry");
      expect(medCollected.healedHp).toBe(55);
      expect(medCollected.bonusGadget).toBeNull();
    }
    const p1AfterMed = engine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(p1AfterMed?.hp).toBe(Math.min(p1Hurt.maxHp, hpBeforeHeal + 55));

    // Collect super_gadget -> grants +1 rare gadget charge + +25 Evo Charge
    const evoBeforeSuper = p1AfterMed?.evoCharge ?? 0;
    const superEvs = advanceAndWalkTo(engine, "p1", { ...superPod.position });
    const superCollected = superEvs.find(
      (e) => e.type === "EVO_POD_COLLECTED" && e.podId === superPod.id,
    );
    expect(superCollected).toBeDefined();
    const rarePool = new Set([
      "gravity_mine",
      "shock_magnet",
      "spore_burst",
      "burrow_bore",
    ]);
    if (superCollected && superCollected.type === "EVO_POD_COLLECTED") {
      expect(superCollected.podKind).toBe("super_gadget");
      expect(superCollected.bonusGadget).not.toBeNull();
      if (superCollected.bonusGadget) {
        expect(rarePool.has(superCollected.bonusGadget)).toBe(true);
      }
    }
    const bonusEvoFromOtherPods = superEvs.reduce((sum, ev) => {
      if (ev.type !== "EVO_POD_COLLECTED" || ev.podId === superPod.id) return sum;
      return sum + (ev.podKind === "evo_dna" ? 50 : ev.podKind === "super_gadget" ? 25 : 0);
    }, 0);
    const p1AfterSuper = engine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(p1AfterSuper?.evoCharge).toBe(
      Math.min(100, evoBeforeSuper + bonusEvoFromOtherPods + 25),
    );
  });

  it("routes Spark Mine water plunges during Cycle 1 through Water Rescue (-35 HP) instead of instant KO", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
        seed: 2027,
        theme: "emerald_spire",
      }),
    );

    const init = engine.getSnapshot();
    const mine = (init.hazards ?? []).find((h) => h.type === "spark_mine");
    expect(mine).toBeDefined();
    if (!mine) return;

    // Carve a deep ocean channel directly on the +X side of the Spark Mine so its knockback plunges p1 into water
    for (let dx = 2; dx <= 16; dx += 4) {
      for (let y = mine.position.y + 1; y >= 0; y -= 4) {
        engine.world.applyCarve({
          shape: "sphere",
          center: { x: mine.position.x + dx, y, z: mine.position.z },
          radius: 4.5,
        });
      }
    }

    // Approach from the +X side so knockback launches p1 straight into the carved ocean pit
    const triggerPos = {
      x: mine.position.x + 1.2,
      y: mine.position.y,
      z: mine.position.z,
    };
    const evs = advanceAndWalkTo(
      engine,
      "p1",
      triggerPos,
      16,
      (stepEvs) =>
        stepEvs.some(
          (e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "spark_mine",
        ),
    );

    expect(
      evs.some(
        (e) => e.type === "HAZARD_TRIGGERED" && e.hazardType === "spark_mine",
      ),
    ).toBe(true);
    const rescueEv = evs.find(
      (e) => e.type === "WATER_RESCUED" && e.playerId === "p1",
    );
    expect(rescueEv).toBeDefined();
    if (rescueEv && rescueEv.type === "WATER_RESCUED") {
      expect(rescueEv.damage).toBe(35);
    }

    const afterSnap = engine.getSnapshot();
    const p1After = afterSnap.critters.find((c) => c.id === "p1");
    expect(p1After).toBeDefined();
    if (p1After) {
      expect(p1After.alive).toBe(true);
      expect(p1After.hp).toBeGreaterThan(0);
      expect(p1After.position.y).toBeGreaterThan(afterSnap.waterLevel + 1.0);
    }
  });
});

function completeAllPendingDrafts(
  engine: MatchEngine,
  avoidAegis = false,
): void {
  const snap = engine.getSnapshot();
  for (const d of snap.pendingDrafts) {
    const choice = avoidAegis
      ? (d.options.find((opt) => opt !== "aegis_crest") ?? d.options[0])
      : d.options[0];
    if (choice) {
      engine.applyMutationPick(d.playerId, choice);
    }
  }
}

function eliminateCritterByVerticalDrops(
  engine: MatchEngine,
  playerId: string,
): void {
  const tickSec = engine.getSnapshot().mapScale === "grand" ? 36 : 29;
  for (let guard = 0; guard < 12; guard++) {
    const snap = engine.getSnapshot();
    if (snap.phase !== "ACTIVE") break;
    if (snap.activePlayerId === playerId) break;
    engine.tick(tickSec);
  }
  const target = engine.getSnapshot().critters.find((c) => c.id === playerId);
  if (!target || !target.alive) return;
  const base = { ...target.position };
  for (let drop = 0; drop < 45; drop++) {
    const cur = engine.getSnapshot().critters.find((c) => c.id === playerId);
    if (!cur || !cur.alive || engine.getSnapshot().phase !== "ACTIVE") {
      break;
    }
    engine.applyMove(playerId, { x: base.x, y: base.y + 15.0, z: base.z }, 0, 0);
    engine.applyMove(playerId, base, 0, 0);
  }
}

describe("Phase 1 Overhaul: 5-Round Persistent Map, Two-Stage Tide & Siege Coin Economy", () => {
  it("defaults to 5 rounds x 300s, always plays all 5 rounds despite 3-0 lead, resolves R1-4 time-up draws with stipends, and breaks R5 ties via Score -> Kills -> DamageDealt", () => {
    const engine = new MatchEngine({
      roomCode: "FIVE",
      mode: "ffa",
      theme: "emerald_spire",
      seed: 9101,
      players: [
        { id: "p1", name: "Milo", species: "mole", color: "#e67e22" },
        { id: "p2", name: "Remy", species: "norway_rat", color: "#3498db" },
      ],
    });

    const init = engine.getSnapshot();
    expect(init.maxRounds).toBe(5);
    expect(init.roundDurationSec).toBe(300);
    expect(init.roundTimeRemainingSec).toBe(300);
    expect(init.round).toBe(1);

    // p1 wins Rounds 1, 2, and 3 (3-0 lead) -> match MUST NOT end early!
    for (let r = 1; r <= 3; r++) {
      expect(engine.getSnapshot().round).toBe(r);
      eliminateCritterByVerticalDrops(engine, "p2");
      const draftSnap = engine.getSnapshot();
      expect(draftSnap.phase).toBe("ROUND_DRAFT");
      expect(draftSnap.roundWinners).toHaveLength(r);
      expect(draftSnap.roundWinners[r - 1]).toBe("p1");
      completeAllPendingDrafts(engine);
    }

    const r4Start = engine.getSnapshot();
    expect(r4Start.round).toBe(4);
    expect(r4Start.phase).toBe("ACTIVE");
    expect(r4Start.roundTimeRemainingSec).toBe(300);

    // Round 4 hits 0:00 -> Round Draw + Siege Coin stipends (trailing p2 gets +50 comeback stipend, leader p1 gets +35)
    const p1CoinsBeforeR4Draw =
      r4Start.critters.find((c) => c.id === "p1")?.coins ?? 0;
    const p2CoinsBeforeR4Draw =
      r4Start.critters.find((c) => c.id === "p2")?.coins ?? 0;

    const r4TimeUpEvs = engine.tick(300);
    expect(
      r4TimeUpEvs.some(
        (e) =>
          e.type === "ROUND_ENDED" && e.round === 4 && e.winnerLabel === "Draw",
      ),
    ).toBe(true);
    const r4Draft = engine.getSnapshot();
    expect(r4Draft.phase).toBe("ROUND_DRAFT");
    expect(r4Draft.roundWinners[3]).toBeNull();
    expect(r4Draft.critters.find((c) => c.id === "p1")?.coins).toBe(
      p1CoinsBeforeR4Draw + 35,
    );
    expect(r4Draft.critters.find((c) => c.id === "p2")?.coins).toBe(
      p2CoinsBeforeR4Draw + 50,
    );

    completeAllPendingDrafts(engine);
    expect(engine.getSnapshot().round).toBe(5);
    expect(engine.getSnapshot().phase).toBe("ACTIVE");

    // Round 5 elimination before 0:00 -> MATCH_OVER (no Round 6)
    eliminateCritterByVerticalDrops(engine, "p2");
    const finalSnap = engine.getSnapshot();
    expect(finalSnap.phase).toBe("MATCH_OVER");
    expect(finalSnap.round).toBe(5);
    expect(finalSnap.winnerId).toBe("p1");
    expect(finalSnap.matchEndReason).toBe("score");
    expect(finalSnap.roundWinners).toEqual(["p1", "p1", "p1", null, "p1"]);

    // Tiebreaker verification: Tied Total Score (2 vs 2) and Tied Kills (0 vs 0) -> DamageDealt breaks tie on Round 5 elimination!
    const tieEngine = new MatchEngine({
      roomCode: "TIEB",
      mode: "ffa",
      theme: "emerald_spire",
      seed: 9102,
      roundDurationSec: 3600,
      players: [
        { id: "p1", name: "Milo", species: "mole", color: "#e67e22" },
        { id: "p2", name: "Remy", species: "norway_rat", color: "#3498db" },
      ],
    });

    // Round 1: p1 self-falls -> p2 wins Round 1 (score: p1=0, p2=2, kills 0-0, dmg 0-0)
    eliminateCritterByVerticalDrops(tieEngine, "p1");
    completeAllPendingDrafts(tieEngine, true);

    // Rounds 2, 3, 4: time-up draws
    for (let r = 2; r <= 4; r++) {
      tieEngine.tick(3600);
      completeAllPendingDrafts(tieEngine, true);
    }
    expect(tieEngine.getSnapshot().round).toBe(5);

    // Round 5: p1 walks close to p2 and lands 1 Quake Club strike (dealing > 0 damage without KO),
    // then p2 self-falls -> p1 wins Round 5 (+2 score -> tied 2-2, kills 0-0, p1.damageDealt > p2.damageDealt)!
    const p2StartR5 = tieEngine
      .getSnapshot()
      .critters.find((c) => c.id === "p2");
    expect(p2StartR5).toBeDefined();
    if (p2StartR5) {
      const inwardSign = p2StartR5.position.x < tieEngine.world.centerX ? 1 : -1;
      const strikeSpot = {
        x: p2StartR5.position.x + inwardSign * 1.4,
        y: p2StartR5.position.y,
        z: p2StartR5.position.z,
      };
      advanceAndWalkTo(tieEngine, "p1", strikeSpot, 20);
      for (
        let guard = 0;
        guard < 6 && tieEngine.getSnapshot().activePlayerId !== "p1";
        guard++
      ) {
        tieEngine.tick(29);
      }
      const p1Now = tieEngine
        .getSnapshot()
        .critters.find((c) => c.id === "p1");
      const p2Now = tieEngine
        .getSnapshot()
        .critters.find((c) => c.id === "p2");
      if (p1Now && p2Now) {
        const dx = p2Now.position.x - p1Now.position.x;
        const dz = p2Now.position.z - p1Now.position.z;
        tieEngine.applyFire("p1", {
          gadgetId: "quake_club",
          direction: { x: dx || 1, y: 0.1, z: dz },
          power: 1.0,
        });
        tieEngine.completeResolving();
        if (tieEngine.getSnapshot().phase === "RETREAT") {
          tieEngine.tick(6.1);
        }
      }
    }

    const midR5 = tieEngine.getSnapshot();
    expect(midR5.critters.find((c) => c.id === "p1")?.damageDealt).toBeGreaterThan(
      0,
    );
    expect(midR5.critters.find((c) => c.id === "p2")?.alive).toBe(true);

    eliminateCritterByVerticalDrops(tieEngine, "p2");
    const tieFinal = tieEngine.getSnapshot();
    expect(tieFinal.phase).toBe("MATCH_OVER");
    expect(tieFinal.scores.p1).toBe(2);
    expect(tieFinal.scores.p2).toBe(2);
    expect(tieFinal.critters.find((c) => c.id === "p1")?.kills).toBe(0);
    expect(tieFinal.critters.find((c) => c.id === "p2")?.kills).toBe(0);
    expect(tieFinal.winnerId).toBe("p1");
    expect(tieFinal.matchEndReason).toBe("score");
  });

  it("persists carved craters and cumulative carveLog across rounds while respawning critters and fresh hazards on dry ground", () => {
    const engine = new MatchEngine({
      roomCode: "PERS",
      mode: "ffa",
      theme: "emerald_spire",
      seed: 8202,
      players: [
        { id: "p1", name: "Milo", species: "mole", color: "#e67e22" },
        { id: "p2", name: "Remy", species: "norway_rat", color: "#3498db" },
      ],
    });

    const p1R1 = engine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(p1R1).toBeDefined();
    if (!p1R1) return;

    // Sample a solid subterranean point directly beneath p1's spawn ledge
    const rockPoint = {
      x: p1R1.position.x,
      y: p1R1.position.y - 1.0,
      z: p1R1.position.z,
    };
    expect(engine.world.isSolid(rockPoint.x, rockPoint.y, rockPoint.z)).toBe(
      true,
    );

    // Carve a crater in Round 1
    const fireEvsR1 = engine.applyFire("p1", {
      gadgetId: "gale_mortar",
      direction: { x: 0, y: -1, z: 0 },
      power: 0.25,
    });
    expect(fireEvsR1.some((e) => e.type === "TERRAIN_CARVED")).toBe(true);
    engine.completeResolving();

    const afterCarveR1 = engine.getSnapshot();
    const carveCountR1 = afterCarveR1.carveLog.length;
    expect(carveCountR1).toBeGreaterThanOrEqual(1);
    expect(engine.world.isSolid(rockPoint.x, rockPoint.y, rockPoint.z)).toBe(
      false,
    );

    // Finish Round 1 -> Round 2
    engine.tick(300);
    expect(engine.getSnapshot().phase).toBe("ROUND_DRAFT");
    completeAllPendingDrafts(engine);

    const r2Snap = engine.getSnapshot();
    expect(r2Snap.round).toBe(2);
    expect(r2Snap.phase).toBe("ACTIVE");
    // Crater from Round 1 MUST remain carved air in Round 2 and carveLog stays cumulative!
    expect(engine.world.isSolid(rockPoint.x, rockPoint.y, rockPoint.z)).toBe(
      false,
    );
    expect(r2Snap.carveLog.length).toBe(carveCountR1);
    expect(r2Snap.carveLog).toEqual(afterCarveR1.carveLog);

    // Critters respawn alive at full HP safely above water; fresh hazards sit above water
    for (const c of r2Snap.critters) {
      expect(c.alive).toBe(true);
      expect(c.hp).toBe(c.maxHp);
      expect(c.position.y).toBeGreaterThan(r2Snap.waterLevel + 0.5);
    }
    const r2Hazards = r2Snap.hazards ?? [];
    expect(r2Hazards.length).toBeGreaterThan(0);
    expect(
      r2Hazards.every((h) => h.active && h.position.y > r2Snap.waterLevel + 0.5),
    ).toBe(true);

    // Carving again in Round 2 appends to cumulative carveLog
    const activeR2 = r2Snap.activePlayerId;
    expect(activeR2).not.toBeNull();
    if (activeR2) {
      engine.applyFire(activeR2, {
        gadgetId: "gale_mortar",
        direction: { x: 0, y: -1, z: 0 },
        power: 0.25,
      });
      expect(engine.getSnapshot().carveLog.length).toBeGreaterThan(
        carveCountR1,
      );
    }
  });

  it("executes Round 5 Two-Stage Tide (60s warning creep + lethal water) and FINAL_FLOOD ocean deluge on 0:00 and simultaneous KO", () => {
    // Part A: Round 5 Stage 1 warning creep -> 0:00 Stage 2 FINAL_FLOOD
    const engine = new MatchEngine({
      roomCode: "TIDE",
      mode: "ffa",
      theme: "emerald_spire",
      seed: 9501,
      floodDurationSec: 6.0,
      players: [
        { id: "p1", name: "Milo", species: "mole", color: "#e67e22" },
        { id: "p2", name: "Remy", species: "norway_rat", color: "#3498db" },
      ],
    });

    // Advance Rounds 1..4 via time-up draws to reach Round 5
    for (let r = 1; r <= 4; r++) {
      engine.tick(300);
      completeAllPendingDrafts(engine, true);
    }
    expect(engine.getSnapshot().round).toBe(5);
    expect(engine.getSnapshot().waterLevel).toBe(1.5);

    // Tick down to 60s remaining (Stage 1 warning begins) -> water still at 1.5m
    engine.tick(240);
    expect(engine.getSnapshot().roundTimeRemainingSec).toBe(60);
    expect(engine.getSnapshot().waterLevel).toBe(1.5);

    // Tick 30s into Stage 1 warning -> water creeps +1.25m to 2.75m and emits WATER_ROSE
    const stage1Evs = engine.tick(30);
    expect(engine.getSnapshot().roundTimeRemainingSec).toBe(30);
    expect(engine.getSnapshot().waterLevel).toBeCloseTo(2.75, 2);
    expect(stage1Evs.some((e) => e.type === "WATER_ROSE")).toBe(true);

    // Tick final 30s to 0:00 -> triggers FINAL_FLOOD (Stage 2)
    const floodStartEvs = engine.tick(30);
    expect(floodStartEvs.some((e) => e.type === "FINAL_FLOOD_STARTED")).toBe(
      true,
    );
    const floodStartSnap = engine.getSnapshot();
    expect(floodStartSnap.phase).toBe("FINAL_FLOOD");
    expect(floodStartSnap.activePlayerId).toBeNull();
    expect(floodStartSnap.floodTargetWaterLevel).not.toBeNull();
    expect(floodStartSnap.floodTargetWaterLevel ?? 0).toBeGreaterThan(
      engine.world.getHighestSolidY(),
    );

    // Tick through FINAL_FLOOD in 0.5s increments -> engulfs every critter and ends in flood_draw
    const engulfedIds = new Set<string>();
    let sawMatchEnded = false;
    for (let step = 0; step < 20; step++) {
      const evs = engine.tick(0.5);
      for (const ev of evs) {
        if (ev.type === "CRITTER_ENGULFED") {
          engulfedIds.add(ev.playerId);
        }
        if (ev.type === "MATCH_ENDED") {
          sawMatchEnded = true;
        }
      }
      if (engine.getSnapshot().phase === "MATCH_OVER") {
        break;
      }
    }

    const endSnap = engine.getSnapshot();
    expect(engulfedIds).toEqual(new Set(["p1", "p2"]));
    expect(sawMatchEnded).toBe(true);
    expect(endSnap.phase).toBe("MATCH_OVER");
    expect(endSnap.waterLevel).toBeGreaterThan(engine.world.getHighestSolidY());
    expect(endSnap.critters.every((c) => !c.alive && c.hp === 0)).toBe(true);
    expect(endSnap.winnerId).toBeNull();
    expect(endSnap.winnerTeam).toBeNull();
    expect(endSnap.matchEndReason).toBe("flood_draw");

    // Part B: Stage 1 water plunge is lethal (no parachute) & simultaneous KO in final round triggers FINAL_FLOOD
    const simEngine = new MatchEngine({
      roomCode: "SIMK",
      mode: "ffa",
      theme: "emerald_spire",
      seed: 9502,
      maxRounds: 1,
      roundDurationSec: 300,
      floodDurationSec: 4.0,
      players: [
        { id: "p1", name: "Milo", species: "mole", color: "#e67e22" },
        { id: "p2", name: "Remy", species: "norway_rat", color: "#3498db" },
      ],
    });

    // Verify Stage 1 warning water plunge is lethal (no WATER_RESCUED)
    const lethalCheck = new MatchEngine({
      roomCode: "LETH",
      mode: "ffa",
      theme: "emerald_spire",
      seed: 9502,
      maxRounds: 1,
      roundDurationSec: 300,
      players: [
        { id: "p1", name: "Milo", species: "mole", color: "#e67e22" },
        { id: "p2", name: "Remy", species: "norway_rat", color: "#3498db" },
      ],
    });
    lethalCheck.tick(260); // 40s left -> inside final 60s Stage 1 warning
    const activeLethal = lethalCheck.getSnapshot().activePlayerId;
    expect(activeLethal).not.toBeNull();
    if (activeLethal) {
      const c = lethalCheck
        .getSnapshot()
        .critters.find((x) => x.id === activeLethal);
      if (c) {
        const plungeEvs = lethalCheck.applyMove(
          activeLethal,
          {
            x: c.position.x,
            y: lethalCheck.getSnapshot().waterLevel - 0.3,
            z: c.position.z,
          },
          0,
          0,
        );
        expect(plungeEvs.some((e) => e.type === "WATER_RESCUED")).toBe(false);
        expect(
          lethalCheck
            .getSnapshot()
            .critters.find((x) => x.id === activeLethal)?.alive,
        ).toBe(false);
      }
    }

    // Simultaneous KO on final round: chip both critters down to <= 20 HP, stand adjacent, fire straight down
    const chipToLowHp = (eng: MatchEngine, id: string): void => {
      for (
        let g = 0;
        g < 6 && eng.getSnapshot().activePlayerId !== id;
        g++
      ) {
        eng.tick(29);
      }
      const c = eng.getSnapshot().critters.find((x) => x.id === id);
      if (!c) return;
      const base = { ...c.position };
      for (let d = 0; d < 12; d++) {
        const cur = eng.getSnapshot().critters.find((x) => x.id === id);
        if (!cur || !cur.alive || cur.hp <= 20) break;
        eng.applyMove(id, { x: base.x, y: base.y + 15.0, z: base.z }, 0, 0);
        eng.applyMove(id, base, 0, 0);
      }
    };

    // Move p1 next to p2 first, then chip both to <= 20 HP and blast both at once
    const p2Ref = simEngine.getSnapshot().critters.find((c) => c.id === "p2");
    expect(p2Ref).toBeDefined();
    if (p2Ref) {
      const inwardSign = p2Ref.position.x < simEngine.world.centerX ? 1 : -1;
      const adj = {
        x: p2Ref.position.x + inwardSign * 1.2,
        y: p2Ref.position.y,
        z: p2Ref.position.z,
      };
      advanceAndWalkTo(simEngine, "p1", adj, 12);
    }
    chipToLowHp(simEngine, "p1");
    chipToLowHp(simEngine, "p2");
    for (
      let g = 0;
      g < 6 && simEngine.getSnapshot().activePlayerId !== "p1";
      g++
    ) {
      simEngine.tick(29);
    }
    simEngine.applyFire("p1", {
      gadgetId: "gale_mortar",
      direction: { x: 0, y: -1, z: 0 },
      power: 0.25,
    });
    const simResolveEvs = simEngine.completeResolving();
    expect(simResolveEvs.some((e) => e.type === "FINAL_FLOOD_STARTED")).toBe(
      true,
    );
    expect(simEngine.getSnapshot().phase).toBe("FINAL_FLOOD");
    simEngine.tick(4.5);
    const simEnd = simEngine.getSnapshot();
    expect(simEnd.phase).toBe("MATCH_OVER");
    expect(simEnd.winnerId).toBeNull();
    expect(simEnd.winnerTeam).toBeNull();
    expect(simEnd.matchEndReason).toBe("flood_draw");
  });

  it("enforces 10-ability Siege Coin economy, mend_brew +45 HP non-turn-ending heal, anytime armory buys/refills/50% trade-in swaps, and persistent free per-round refills", () => {
    // Part A: Starting loadout budget enforcement, mend_brew, and rival-turn open-slot purchase
    const engine = new MatchEngine({
      roomCode: "SHOP",
      mode: "ffa",
      theme: "emerald_spire",
      seed: 9601,
      players: [
        {
          id: "p1",
          name: "Alchemist",
          species: "mole",
          // 25 + 30 + 40 = 95 <= 100; seeker_firefly (70) exceeds remaining 5 -> rejected
          startingLoadout: [
            "quake_club",
            "vine_grapple",
            "mend_brew",
            "seeker_firefly",
          ],
        },
        {
          id: "p2",
          name: "Merchant",
          species: "norway_rat",
        },
      ],
    });

    const init = engine.getSnapshot();
    const p1Init = init.critters.find((c) => c.id === "p1");
    const p2Init = init.critters.find((c) => c.id === "p2");
    expect(p1Init?.loadout).toEqual([
      "gale_mortar",
      "quake_club",
      "vine_grapple",
      "mend_brew",
    ]);
    expect(p1Init?.coins).toBe(5);
    expect(p1Init?.gadgetCharges.mend_brew).toBe(2);
    expect(p1Init?.gadgetCharges.seeker_firefly).toBe(0);
    expect(p2Init?.loadout).toEqual([
      "gale_mortar",
      "quake_club",
      "vine_grapple",
    ]);
    expect(p2Init?.coins).toBe(45);

    // mend_brew at full HP is rejected without spending charge
    expect(
      engine.applyUtility("p1", {
        gadgetId: "mend_brew",
        direction: { x: 1, y: 0, z: 0 },
      }),
    ).toHaveLength(0);
    expect(
      engine.getSnapshot().critters.find((c) => c.id === "p1")?.gadgetCharges
        .mend_brew,
    ).toBe(2);

    // Hurt p1 by 25 HP -> mend_brew heals +25 (clamped to maxHp), stays ACTIVE!
    if (!p1Init) return;
    const base = { ...p1Init.position };
    engine.applyMove("p1", { x: base.x, y: base.y + 15.0, z: base.z }, 0, 0);
    engine.applyMove("p1", base, 0, 0);
    expect(engine.getSnapshot().critters.find((c) => c.id === "p1")?.hp).toBe(
      p1Init.maxHp - 25,
    );

    const heal1Evs = engine.applyUtility("p1", {
      gadgetId: "mend_brew",
      direction: { x: 1, y: 0, z: 0 },
    });
    expect(heal1Evs).toEqual([
      {
        type: "ABILITY_HEALED",
        playerId: "p1",
        amount: 25,
        newHp: p1Init.maxHp,
      },
    ]);
    expect(engine.getSnapshot().phase).toBe("ACTIVE");
    expect(engine.getSnapshot().activePlayerId).toBe("p1");
    expect(
      engine.getSnapshot().critters.find((c) => c.id === "p1")?.gadgetCharges
        .mend_brew,
    ).toBe(1);

    // Hurt p1 by 50 HP -> mend_brew heals exact +45 HP, stays ACTIVE, charges -> 0
    for (let d = 0; d < 2; d++) {
      engine.applyMove("p1", { x: base.x, y: base.y + 15.0, z: base.z }, 0, 0);
      engine.applyMove("p1", base, 0, 0);
    }
    const heal2Evs = engine.applyUtility("p1", {
      gadgetId: "mend_brew",
      direction: { x: 1, y: 0, z: 0 },
    });
    expect(heal2Evs).toEqual([
      {
        type: "ABILITY_HEALED",
        playerId: "p1",
        amount: 45,
        newHp: p1Init.maxHp - 5,
      },
    ]);
    expect(engine.getSnapshot().phase).toBe("ACTIVE");
    expect(
      engine.getSnapshot().critters.find((c) => c.id === "p1")?.gadgetCharges
        .mend_brew,
    ).toBe(0);
    // 0 charges left -> rejected
    expect(
      engine.applyUtility("p1", {
        gadgetId: "mend_brew",
        direction: { x: 1, y: 0, z: 0 },
      }),
    ).toHaveLength(0);

    // Anytime Armory: WHILE IT IS STILL p1's TURN, p2 buys into an open slot and fails overspend
    expect(engine.getSnapshot().activePlayerId).toBe("p1");
    expect(engine.applyBuyAbility("p2", "seeker_firefly")).toHaveLength(0); // 70 > 45
    const buyOpenEvs = engine.applyBuyAbility("p2", "mend_brew"); // 40 <= 45
    expect(buyOpenEvs).toEqual([
      {
        type: "ABILITY_PURCHASED",
        playerId: "p2",
        gadgetId: "mend_brew",
        isRefill: false,
        replacedGadgetId: null,
        cost: 40,
        refund: 0,
        newBalance: 5,
      },
    ]);
    const p2AfterOpen = engine
      .getSnapshot()
      .critters.find((c) => c.id === "p2");
    expect(p2AfterOpen?.loadout).toContain("mend_brew");
    expect(p2AfterOpen?.gadgetCharges.mend_brew).toBe(2);

    // Coin awards on Evo Pod (+25), enemy damage, and enemy KO (+40)
    const coinEngine = new MatchEngine({
      roomCode: "COIN",
      mode: "ffa",
      theme: "emerald_spire",
      seed: 9602,
      roundDurationSec: 3600,
      players: [
        { id: "p1", name: "Hunter", species: "mole" },
        { id: "p2", name: "Prey", species: "norway_rat" },
      ],
    });
    // Spawn Pod on Turn 2 and collect with p1 (+25 Siege Coins)
    coinEngine.tick(29);
    const pod = coinEngine.getSnapshot().evoPods[0];
    expect(pod).toBeDefined();
    if (pod) {
      const coinsBeforePod =
        coinEngine.getSnapshot().critters.find((c) => c.id === "p1")?.coins ??
        0;
      const podEvs = advanceAndWalkTo(coinEngine, "p1", { ...pod.position });
      expect(
        podEvs.some(
          (e) =>
            e.type === "COINS_EARNED" &&
            e.playerId === "p1" &&
            e.amount === 25 &&
            e.reason === "pod_collected",
        ),
      ).toBe(true);
      expect(
        coinEngine.getSnapshot().critters.find((c) => c.id === "p1")?.coins,
      ).toBeGreaterThanOrEqual(coinsBeforePod + 25);
    }

    // Chip p2 low so p1's Quake Club deals damage AND scores enemy KO -> enemy_damage + enemy_ko (+40) coins!
    for (
      let g = 0;
      g < 6 && coinEngine.getSnapshot().activePlayerId !== "p2";
      g++
    ) {
      coinEngine.tick(29);
    }
    const p2Target = coinEngine
      .getSnapshot()
      .critters.find((c) => c.id === "p2");
    if (p2Target) {
      const p2Base = { ...p2Target.position };
      for (let d = 0; d < 12; d++) {
        const cur = coinEngine
          .getSnapshot()
          .critters.find((c) => c.id === "p2");
        if (!cur || !cur.alive || cur.hp <= 15) break;
        coinEngine.applyMove(
          "p2",
          { x: p2Base.x, y: p2Base.y + 15.0, z: p2Base.z },
          0,
          0,
        );
        coinEngine.applyMove("p2", p2Base, 0, 0);
      }
      const inwardSign =
        p2Target.position.x < coinEngine.world.centerX ? 1 : -1;
      advanceAndWalkTo(
        coinEngine,
        "p1",
        {
          x: p2Target.position.x + inwardSign * 1.3,
          y: p2Target.position.y,
          z: p2Target.position.z,
        },
        20,
      );
      for (
        let g = 0;
        g < 6 && coinEngine.getSnapshot().activePlayerId !== "p1";
        g++
      ) {
        coinEngine.tick(29);
      }
      const p1Att = coinEngine
        .getSnapshot()
        .critters.find((c) => c.id === "p1");
      const p2Def = coinEngine
        .getSnapshot()
        .critters.find((c) => c.id === "p2");
      if (p1Att && p2Def) {
        const koFireEvs = coinEngine.applyFire("p1", {
          gadgetId: "quake_club",
          direction: {
            x: p2Def.position.x - p1Att.position.x || 1,
            y: 0.05,
            z: p2Def.position.z - p1Att.position.z,
          },
          power: 1.0,
        });
        expect(
          koFireEvs.some(
            (e) =>
              e.type === "COINS_EARNED" &&
              e.playerId === "p1" &&
              e.reason === "enemy_damage",
          ),
        ).toBe(true);
        expect(
          koFireEvs.some(
            (e) =>
              e.type === "COINS_EARNED" &&
              e.playerId === "p1" &&
              e.amount === 40 &&
              e.reason === "enemy_ko",
          ),
        ).toBe(true);
      }
    }

    // Part B: Full 6-slot mid-round refill, 50% Trade-In Swap, gale_mortar protection & persistent free per-round refills
    const shopEngine = new MatchEngine({
      roomCode: "SWAP",
      mode: "ffa",
      theme: "emerald_spire",
      seed: 9603,
      startingCoins: 300,
      players: [
        { id: "p1", name: "Host", species: "mole" },
        { id: "p2", name: "Shopper", species: "badger" },
      ],
    });
    // p2 starts with default kit (55 spent -> 245 coins left), activePlayerId is p1
    expect(shopEngine.getSnapshot().activePlayerId).toBe("p1");
    expect(
      shopEngine.getSnapshot().critters.find((c) => c.id === "p2")?.coins,
    ).toBe(245);

    // Fill slots 4, 5, 6 during p1's turn (40 + 35 + 50 = 125 -> 120 coins left)
    expect(shopEngine.applyBuyAbility("p2", "mend_brew")).toHaveLength(1);
    expect(shopEngine.applyBuyAbility("p2", "prism_wall")).toHaveLength(1);
    expect(shopEngine.applyBuyAbility("p2", "spore_burst")).toHaveLength(1);
    const p2Full = shopEngine
      .getSnapshot()
      .critters.find((c) => c.id === "p2");
    expect(p2Full?.loadout).toEqual([
      "gale_mortar",
      "quake_club",
      "vine_grapple",
      "mend_brew",
      "prism_wall",
      "spore_burst",
    ]);
    expect(p2Full?.coins).toBe(120);

    // Mid-round charge refill on owned mend_brew (refillCost 25 -> 95 coins, charges 2 -> 4)
    const refillEvs = shopEngine.applyBuyAbility("p2", "mend_brew");
    expect(refillEvs).toEqual([
      {
        type: "ABILITY_PURCHASED",
        playerId: "p2",
        gadgetId: "mend_brew",
        isRefill: true,
        replacedGadgetId: null,
        cost: 25,
        refund: 0,
        newBalance: 95,
      },
    ]);
    expect(
      shopEngine.getSnapshot().critters.find((c) => c.id === "p2")
        ?.gadgetCharges.mend_brew,
    ).toBe(4);

    // Reject 7th ability without replaceGadgetId AND reject replacing gale_mortar
    expect(shopEngine.applyBuyAbility("p2", "seeker_firefly")).toHaveLength(0);
    expect(
      shopEngine.applyBuyAbility("p2", "seeker_firefly", "gale_mortar"),
    ).toHaveLength(0);

    // 50% Trade-In Swap: spore_burst (50 -> 25 refund) for seeker_firefly (70 -> net 45, balance 95 -> 50)
    const swapEvs = shopEngine.applyBuyAbility(
      "p2",
      "seeker_firefly",
      "spore_burst",
    );
    expect(swapEvs).toEqual([
      {
        type: "ABILITY_PURCHASED",
        playerId: "p2",
        gadgetId: "seeker_firefly",
        isRefill: false,
        replacedGadgetId: "spore_burst",
        cost: 45,
        refund: 25,
        newBalance: 50,
      },
    ]);
    const p2Swapped = shopEngine
      .getSnapshot()
      .critters.find((c) => c.id === "p2");
    expect(p2Swapped?.loadout).toEqual([
      "gale_mortar",
      "quake_club",
      "vine_grapple",
      "mend_brew",
      "prism_wall",
      "seeker_firefly",
    ]);
    expect(p2Swapped?.gadgetCharges.spore_burst).toBe(0);
    expect(p2Swapped?.gadgetCharges.seeker_firefly).toBe(1);

    // Spend p2's vine_grapple charge on p2's turn, then advance Round 1 -> Round 2
    shopEngine.tick(29);
    expect(shopEngine.getSnapshot().activePlayerId).toBe("p2");
    const p2Turn = shopEngine
      .getSnapshot()
      .critters.find((c) => c.id === "p2");
    if (p2Turn) {
      shopEngine.applyUtility("p2", {
        gadgetId: "vine_grapple",
        direction: { x: 1, y: 0.2, z: 0 },
        target: {
          x: p2Turn.position.x + 2.0,
          y: p2Turn.position.y + 0.5,
          z: p2Turn.position.z,
        },
      });
      expect(
        shopEngine.getSnapshot().critters.find((c) => c.id === "p2")
          ?.gadgetCharges.vine_grapple,
      ).toBe(5);
    }

    // Time-up Round 1 -> Round 2: Persistent loadout + unspent coins (+35 stipend) + FREE charge refills!
    shopEngine.tick(300);
    completeAllPendingDrafts(shopEngine);
    const r2P2 = shopEngine
      .getSnapshot()
      .critters.find((c) => c.id === "p2");
    expect(shopEngine.getSnapshot().round).toBe(2);
    expect(r2P2?.loadout).toEqual([
      "gale_mortar",
      "quake_club",
      "vine_grapple",
      "mend_brew",
      "prism_wall",
      "seeker_firefly",
    ]);
    expect(r2P2?.coins).toBe(85); // 50 unspent + 35 stipend
    expect(r2P2?.gadgetCharges.vine_grapple).toBe(6);
    expect(r2P2?.gadgetCharges.mend_brew).toBe(2);
    expect(r2P2?.gadgetCharges.seeker_firefly).toBe(1);
    expect(r2P2?.gadgetCharges.spore_burst).toBe(0);
  });

  it("deploys Prism Wall into MatchState, intercepts enemy mortar with zero damage/carve, shatters cleanly, and lets the follow-up shot through", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
        seed: 1234,
        roundDurationSec: 3600,
        players: [
          {
            id: "p1",
            name: "ShieldMole",
            species: "mole",
            startingLoadout: ["gale_mortar", "prism_wall"],
          },
          {
            id: "p2",
            name: "MortarRat",
            species: "norway_rat",
            startingLoadout: ["gale_mortar"],
          },
        ],
      }),
    );

    const initSnap = engine.getSnapshot();
    const p1Init = initSnap.critters.find((c) => c.id === "p1");
    expect(p1Init).toBeDefined();
    if (!p1Init) return;

    // Pick a flat, unobstructed shooter spot ~6.0m from p1 on the same basin
    let shooterSpot: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 16; i++) {
      const ang = (i * Math.PI * 2) / 16;
      const sx = p1Init.position.x + Math.cos(ang) * 6.0;
      const sz = p1Init.position.z + Math.sin(ang) * 6.0;
      const sy = engine.world.getSurfaceY(sx, sz);
      if (sy === null || Math.abs(sy - p1Init.position.y) > 1.0) continue;
      const wx = p1Init.position.x + Math.cos(ang) * 2.4;
      const wz = p1Init.position.z + Math.sin(ang) * 2.4;
      const wy = engine.world.getSurfaceY(wx, wz);
      if (wy === null || Math.abs(wy - p1Init.position.y) > 1.0) continue;
      if (
        engine.world.hasDirectLineOfSight(
          p1Init.position,
          { x: sx, y: sy, z: sz },
          0.7,
        )
      ) {
        shooterSpot = { x: sx, y: sy, z: sz };
        break;
      }
    }
    expect(shooterSpot).not.toBeNull();
    if (!shooterSpot) return;

    // Walk p2 to shooterSpot, then cycle back to p1's ACTIVE turn
    advanceAndWalkTo(engine, "p2", shooterSpot, 40);
    for (
      let g = 0;
      g < 8 && engine.getSnapshot().activePlayerId !== "p1";
      g++
    ) {
      engine.tick(29);
    }
    expect(engine.getSnapshot().activePlayerId).toBe("p1");

    const p1Now = engine.getSnapshot().critters.find((c) => c.id === "p1");
    const p2Now = engine.getSnapshot().critters.find((c) => c.id === "p2");
    expect(p1Now?.alive).toBe(true);
    expect(p2Now?.alive).toBe(true);
    if (!p1Now || !p2Now) return;

    // p1 deploys Prism Wall facing p2 (non-turn-ending utility)
    const deployEvents = engine.applyUtility("p1", {
      gadgetId: "prism_wall",
      direction: {
        x: p2Now.position.x - p1Now.position.x,
        y: 0,
        z: p2Now.position.z - p1Now.position.z,
      },
    });
    const deployedEv = deployEvents.find(
      (e) => e.type === "PRISM_WALL_DEPLOYED",
    );
    expect(deployedEv).toBeDefined();
    expect(engine.getSnapshot().phase).toBe("ACTIVE");
    const deployedWalls = engine.getSnapshot().prismWalls ?? [];
    expect(deployedWalls).toHaveLength(1);
    const activeWall = deployedWalls[0];
    expect(activeWall).toBeDefined();
    if (!activeWall) return;
    expect(activeWall.ownerId).toBe("p1");
    expect(activeWall.active).toBe(true);

    // End p1's turn -> p2 becomes ACTIVE while wall remains active
    engine.tick(29);
    expect(engine.getSnapshot().activePlayerId).toBe("p2");
    expect(engine.getSnapshot().prismWalls).toHaveLength(1);

    const p1HpBefore =
      engine.getSnapshot().critters.find((c) => c.id === "p1")?.hp ?? 0;
    const carvesBefore = engine.getSnapshot().carveLog.length;
    const aimDir = {
      x: p1Now.position.x - p2Now.position.x,
      y: p1Now.position.y - p2Now.position.y + 1.1,
      z: p1Now.position.z - p2Now.position.z,
    };

    // Shot #1: intercepted by Prism Wall -> 0 damage, 0 carve, wall shatters!
    const blockedEvents = engine.applyFire("p2", {
      gadgetId: "gale_mortar",
      direction: aimDir,
      power: 0.6,
    });
    const shatterEv = blockedEvents.find(
      (e) => e.type === "PRISM_WALL_SHATTERED",
    );
    expect(shatterEv).toBeDefined();
    if (shatterEv && shatterEv.type === "PRISM_WALL_SHATTERED") {
      expect(shatterEv.wallId).toBe(activeWall.id);
    }
    const shot1Ev = blockedEvents.find((e) => e.type === "SHOT_RESOLVED");
    expect(shot1Ev).toBeDefined();
    if (shot1Ev && shot1Ev.type === "SHOT_RESOLVED") {
      expect(shot1Ev.simulation.shatteredPrismWallIds).toEqual([activeWall.id]);
      expect(shot1Ev.simulation.carveOps).toHaveLength(0);
      expect(shot1Ev.simulation.hits).toHaveLength(0);
    }

    const afterBlockSnap = engine.getSnapshot();
    expect(
      afterBlockSnap.critters.find((c) => c.id === "p1")?.hp,
    ).toBe(p1HpBefore);
    expect(afterBlockSnap.carveLog.length).toBe(carvesBefore);
    expect(afterBlockSnap.prismWalls).toHaveLength(0);

    // Complete p2's turn and skip p1's turn -> p2 fires exact same shot again!
    engine.completeResolving();
    if (engine.getSnapshot().phase === "RETREAT") {
      engine.tick(6.1);
    }
    for (
      let g = 0;
      g < 6 && engine.getSnapshot().activePlayerId !== "p2";
      g++
    ) {
      engine.tick(29);
    }
    expect(engine.getSnapshot().activePlayerId).toBe("p2");

    // Shot #2: wall is gone -> hits p1 and carves terrain cleanly!
    const followUpEvents = engine.applyFire("p2", {
      gadgetId: "gale_mortar",
      direction: aimDir,
      power: 0.6,
    });
    expect(
      followUpEvents.some((e) => e.type === "PRISM_WALL_SHATTERED"),
    ).toBe(false);
    const afterFollowUpSnap = engine.getSnapshot();
    expect(afterFollowUpSnap.carveLog.length).toBeGreaterThan(carvesBefore);
    expect(
      afterFollowUpSnap.critters.find((c) => c.id === "p1")?.hp ?? p1HpBefore,
    ).toBeLessThan(p1HpBefore);
  });

  it("allows owner one-way fire & aim arc through own Prism Wall, keeps bot preUtilities+fire intact, and blocks max-speed Grand tailwind shots without tunneling", () => {
    // 1. Caster deploys Prism Wall directly in front of them, fires straight through it to damage rival
    const engine = new MatchEngine(
      makeBaseConfig({
        seed: 77,
        theme: "emerald_spire",
        roundDurationSec: 3600,
        players: [
          {
            id: "p1",
            name: "ShieldMole",
            species: "mole",
            team: 0,
            isBot: false,
            color: "#e67e22",
            startingLoadout: ["gale_mortar", "prism_wall"],
          },
          {
            id: "p2",
            name: "RivalRat",
            species: "norway_rat",
            team: 1,
            isBot: false,
            color: "#3498db",
            startingLoadout: ["gale_mortar"],
          },
        ],
      }),
    );

    const p1Init = engine.getSnapshot().critters.find((c) => c.id === "p1");
    expect(p1Init).toBeDefined();
    if (!p1Init) return;

    let rivalSpot: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 16; i++) {
      const ang = (i * Math.PI * 2) / 16;
      const sx = p1Init.position.x + Math.cos(ang) * 6.0;
      const sz = p1Init.position.z + Math.sin(ang) * 6.0;
      const sy = engine.world.getSurfaceY(sx, sz);
      if (sy === null || Math.abs(sy - p1Init.position.y) > 1.0) continue;
      const wx = p1Init.position.x + Math.cos(ang) * 2.4;
      const wz = p1Init.position.z + Math.sin(ang) * 2.4;
      const wy = engine.world.getSurfaceY(wx, wz);
      if (wy === null || Math.abs(wy - p1Init.position.y) > 1.0) continue;
      if (
        engine.world.hasDirectLineOfSight(
          p1Init.position,
          { x: sx, y: sy, z: sz },
          0.7,
        )
      ) {
        rivalSpot = { x: sx, y: sy, z: sz };
        break;
      }
    }
    expect(rivalSpot).not.toBeNull();
    if (!rivalSpot) return;

    advanceAndWalkTo(engine, "p2", rivalSpot, 40);
    for (
      let g = 0;
      g < 8 && engine.getSnapshot().activePlayerId !== "p1";
      g++
    ) {
      engine.tick(29);
    }
    expect(engine.getSnapshot().activePlayerId).toBe("p1");

    const p1Now = engine.getSnapshot().critters.find((c) => c.id === "p1");
    const p2Now = engine.getSnapshot().critters.find((c) => c.id === "p2");
    expect(p1Now?.alive).toBe(true);
    expect(p2Now?.alive).toBe(true);
    if (!p1Now || !p2Now) return;

    const toRival = {
      x: p2Now.position.x - p1Now.position.x,
      y: 0,
      z: p2Now.position.z - p1Now.position.z,
    };
    engine.applyUtility("p1", {
      gadgetId: "prism_wall",
      direction: toRival,
    });
    const wallsAfterDeploy = engine.getSnapshot().prismWalls ?? [];
    expect(wallsAfterDeploy).toHaveLength(1);
    const ownWall = wallsAfterDeploy[0];
    expect(ownWall?.ownerId).toBe("p1");
    if (!ownWall) return;

    // Verify sampleAimArc passes through own wall for p1, but stops on p1's wall for p2
    const p1AimDir = {
      x: p2Now.position.x - p1Now.position.x,
      y: p2Now.position.y - p1Now.position.y + 1.1,
      z: p2Now.position.z - p1Now.position.z,
    };
    const ownArc = sampleAimArc(
      engine.world,
      {
        gadgetId: "gale_mortar",
        origin: { x: p1Now.position.x, y: p1Now.position.y + 0.6, z: p1Now.position.z },
        direction: p1AimDir,
        power: 0.45,
      },
      engine.getSnapshot().wind,
      false,
      wallsAfterDeploy,
      "p1",
    );
    const ownArcEnd = ownArc[ownArc.length - 1];
    expect(ownArcEnd).toBeDefined();
    if (ownArcEnd) {
      const distFromP1 = Math.hypot(
        ownArcEnd.x - p1Now.position.x,
        ownArcEnd.z - p1Now.position.z,
      );
      expect(distFromP1).toBeGreaterThan(3.5);
    }

    const rivalAimDir = {
      x: p1Now.position.x - p2Now.position.x,
      y: p1Now.position.y - p2Now.position.y + 1.1,
      z: p1Now.position.z - p2Now.position.z,
    };
    const enemyArc = sampleAimArc(
      engine.world,
      {
        gadgetId: "gale_mortar",
        origin: { x: p2Now.position.x, y: p2Now.position.y + 0.6, z: p2Now.position.z },
        direction: rivalAimDir,
        power: 0.6,
      },
      engine.getSnapshot().wind,
      false,
      wallsAfterDeploy,
      "p2",
    );
    const enemyArcEnd = enemyArc[enemyArc.length - 1];
    expect(enemyArcEnd).toBeDefined();
    if (enemyArcEnd) {
      const distToWall = Math.hypot(
        enemyArcEnd.x - ownWall.position.x,
        enemyArcEnd.z - ownWall.position.z,
      );
      expect(distToWall).toBeLessThan(1.8);
    }

    // p1 fires gale_mortar directly through own Prism Wall -> wall stays intact & p2 takes damage!
    const p2HpBefore = p2Now.hp;
    const ownerShotEvents = engine.applyFire("p1", {
      gadgetId: "gale_mortar",
      direction: p1AimDir,
      power: 0.35,
    });
    expect(
      ownerShotEvents.some((e) => e.type === "PRISM_WALL_SHATTERED"),
    ).toBe(false);
    const afterOwnerShot = engine.getSnapshot();
    expect(afterOwnerShot.prismWalls).toHaveLength(1);
    expect(afterOwnerShot.prismWalls?.[0]?.id).toBe(ownWall.id);
    expect(
      afterOwnerShot.critters.find((c) => c.id === "p2")?.hp ?? p2HpBefore,
    ).toBeLessThan(p2HpBefore);

    // Complete p1's turn -> p2 fires return shot and is intercepted by p1's still-standing wall!
    engine.completeResolving();
    if (engine.getSnapshot().phase === "RETREAT") {
      engine.tick(6.1);
    }
    expect(engine.getSnapshot().activePlayerId).toBe("p2");

    const preReturnSnap = engine.getSnapshot();
    const p2Current = preReturnSnap.critters.find((c) => c.id === "p2");
    expect(p2Current?.alive).toBe(true);
    if (!p2Current) return;

    const p1HpBeforeReturn =
      preReturnSnap.critters.find((c) => c.id === "p1")?.hp ?? 0;
    const carvesBeforeReturn = preReturnSnap.carveLog.length;
    const retOrigin = {
      x: p2Current.position.x,
      y: p2Current.position.y + 0.6,
      z: p2Current.position.z,
    };
    const retTarget = {
      x: ownWall.position.x,
      y: ownWall.position.y + ownWall.height * 0.5,
      z: ownWall.position.z,
    };
    const rdx = retTarget.x - retOrigin.x;
    const rdy = retTarget.y - retOrigin.y;
    const rdz = retTarget.z - retOrigin.z;
    const retSpeed = 9.0 + 0.65 * 18.5;
    const retT = Math.max(0.12, Math.hypot(rdx, rdy, rdz) / retSpeed);
    const returnAimDir = {
      x: rdx - 0.5 * preReturnSnap.wind.x * retT * retT,
      y: rdy + 0.5 * GRAVITY * retT * retT,
      z: rdz - 0.5 * preReturnSnap.wind.z * retT * retT,
    };

    const returnEvents = engine.applyFire("p2", {
      gadgetId: "gale_mortar",
      direction: returnAimDir,
      power: 0.65,
    });
    expect(
      returnEvents.some((e) => e.type === "PRISM_WALL_SHATTERED"),
    ).toBe(true);
    const afterReturn = engine.getSnapshot();
    expect(afterReturn.critters.find((c) => c.id === "p1")?.hp).toBe(
      p1HpBeforeReturn,
    );
    expect(afterReturn.carveLog.length).toBe(carvesBeforeReturn);
    expect(afterReturn.prismWalls).toHaveLength(0);

    // 2. Executing planBotTurn's preUtilities (mend_brew + prism_wall) + applyFire never self-shatters
    const botEngine = new MatchEngine(
      makeBaseConfig({
        seed: 77,
        theme: "emerald_spire",
        roundDurationSec: 3600,
        players: [
          {
            id: "bot-1",
            name: "Bramble (Bot)",
            species: "badger",
            team: 0,
            isBot: true,
            color: "#22c55e",
            startingLoadout: ["gale_mortar", "mend_brew", "prism_wall"],
          },
          {
            id: "human-1",
            name: "TargetRat",
            species: "norway_rat",
            team: 1,
            isBot: false,
            color: "#3498db",
            startingLoadout: ["gale_mortar"],
          },
        ],
      }),
    );

    const botInit = botEngine.getSnapshot().critters.find((c) => c.id === "bot-1");
    expect(botInit).toBeDefined();
    if (!botInit) return;

    // Walk human-1 into unobstructed LOS of bot-1
    let humanSpot: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 16; i++) {
      const ang = (i * Math.PI * 2) / 16;
      const sx = botInit.position.x + Math.cos(ang) * 7.5;
      const sz = botInit.position.z + Math.sin(ang) * 7.5;
      const sy = botEngine.world.getSurfaceY(sx, sz);
      if (sy === null || Math.abs(sy - botInit.position.y) > 1.2) continue;
      if (
        botEngine.world.hasDirectLineOfSight(
          botInit.position,
          { x: sx, y: sy, z: sz },
          1.1,
        )
      ) {
        humanSpot = { x: sx, y: sy, z: sz };
        break;
      }
    }
    expect(humanSpot).not.toBeNull();
    if (!humanSpot) return;

    advanceAndWalkTo(botEngine, "human-1", humanSpot, 40);
    for (
      let g = 0;
      g < 8 && botEngine.getSnapshot().activePlayerId !== "bot-1";
      g++
    ) {
      botEngine.tick(29);
    }
    expect(botEngine.getSnapshot().activePlayerId).toBe("bot-1");

    // Chip bot-1 down to <= 65% HP via vertical drops so planBotTurn queues both mend_brew & prism_wall
    const botBase = botEngine.getSnapshot().critters.find((c) => c.id === "bot-1");
    expect(botBase).toBeDefined();
    if (!botBase) return;
    const basePos = { ...botBase.position };
    for (let d = 0; d < 6; d++) {
      const cur = botEngine.getSnapshot().critters.find((c) => c.id === "bot-1");
      if (!cur || cur.hp <= cur.maxHp * 0.62) break;
      botEngine.applyMove("bot-1", { x: basePos.x, y: basePos.y + 15.0, z: basePos.z }, 0, 0);
      botEngine.applyMove("bot-1", basePos, 0, 0);
    }

    const botSnapBefore = botEngine.getSnapshot();
    const botBefore = botSnapBefore.critters.find((c) => c.id === "bot-1");
    expect(botBefore).toBeDefined();
    if (!botBefore) return;
    expect(botBefore.hp).toBeLessThanOrEqual(botBefore.maxHp * 0.65);

    const botPlan = planBotTurn(botSnapBefore, botEngine.world, "bot-1");
    expect(botPlan.preUtilities?.map((u) => u.gadgetId)).toEqual([
      "mend_brew",
      "prism_wall",
    ]);

    botEngine.applyMove("bot-1", botPlan.moveTarget, 0, 0);
    for (const util of botPlan.preUtilities ?? []) {
      botEngine.applyUtility("bot-1", util);
    }
    expect(botEngine.getSnapshot().prismWalls).toHaveLength(1);

    const botFireEvents = botEngine.applyFire("bot-1", {
      gadgetId: botPlan.gadgetId,
      direction: botPlan.direction,
      power: botPlan.power,
      ...(botPlan.droneTarget ? { droneTarget: botPlan.droneTarget } : {}),
    });
    expect(
      botFireEvents.some((e) => e.type === "PRISM_WALL_SHATTERED"),
    ).toBe(false);
    expect(botEngine.getSnapshot().prismWalls).toHaveLength(1);
    expect(botEngine.getSnapshot().prismWalls?.[0]?.ownerId).toBe("bot-1");

    // 3. Max Grand launch speed (42 m/s) + strong tailwind (>48 m/s -> >1.2m/step): zero tunneling!
    const grandWorld = new SdfWorld(77, "emerald_spire", "grand");
    const grandCenterY = grandWorld.worldHeight * 0.85;
    const shieldedPos = {
      x: grandWorld.centerX + 12.0,
      y: grandCenterY,
      z: grandWorld.centerZ,
    };
    const shooterPos = {
      x: grandWorld.centerX - 12.0,
      y: grandCenterY,
      z: grandWorld.centerZ,
    };
    const grandWall = {
      id: "grand-wall-1",
      ownerId: "p1",
      position: {
        x: shieldedPos.x - 2.4,
        y: shieldedPos.y - 0.5,
        z: shieldedPos.z,
      },
      normal: { x: -1, y: 0, z: 0 },
      width: 3.4,
      height: 2.8,
      active: true,
    };
    const shieldedCritter = makeDummyCritter({
      id: "p1",
      position: shieldedPos,
      hp: 240,
      maxHp: 240,
    });
    const highSpeedSim = simulateShot(
      grandWorld,
      [shieldedCritter],
      {
        shooterId: "p2",
        gadgetId: "gale_mortar",
        origin: { x: shooterPos.x, y: shooterPos.y + 0.6, z: shooterPos.z },
        direction: { x: 0.99, y: 0.14, z: 0 },
        power: 1.0,
        species: "norway_rat",
        equipped: {},
        apex: null,
      },
      { x: 14.0, y: 0, z: 0 },
      1.5,
      [grandWall],
    );
    expect(highSpeedSim.shatteredPrismWallIds).toEqual(["grand-wall-1"]);
    expect(highSpeedSim.hits).toHaveLength(0);
    expect(highSpeedSim.carveOps).toHaveLength(0);
    const interceptImpact = highSpeedSim.impacts[0];
    expect(interceptImpact).toBeDefined();
    if (interceptImpact) {
      expect(
        Math.abs(interceptImpact.position.x - grandWall.position.x),
      ).toBeLessThanOrEqual(0.45 + 1e-4);
    }
  });

  it("plans tactical bot mend_brew, prism_wall, shock_magnet, and gravity_mine actions only when owned", () => {
    const world = new SdfWorld(42, "emerald_spire", "duel");
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    if (!sp) return;

    // Place enemy 10m outward at matching elevation near a cliff dropoff with clean unobstructed LOS
    let enemyPos: { x: number; y: number; z: number } | null = null;
    for (let i = 0; i < 24; i++) {
      const ang = (i * Math.PI * 2) / 24;
      const ex = sp.x + Math.cos(ang) * 10.0;
      const ez = sp.z + Math.sin(ang) * 10.0;
      const cand = { x: ex, y: sp.y, z: ez };
      const hasDrop =
        world.getSurfaceY(ex + 3.5, ez) === null ||
        world.getSurfaceY(ex - 3.5, ez) === null ||
        world.getSurfaceY(ex, ez + 3.5) === null ||
        world.getSurfaceY(ex, ez - 3.5) === null;
      if (hasDrop && world.hasDirectLineOfSight(sp, cand, 1.1)) {
        enemyPos = cand;
        break;
      }
    }
    expect(enemyPos).not.toBeNull();
    if (!enemyPos) return;

    const makeState = (
      botOverrides: Partial<CritterState>,
      enemyOverrides?: Partial<CritterState>,
    ) => {
      const bot = makeDummyCritter({
        id: "bot-1",
        isBot: true,
        position: { ...sp },
        moveStamina: 0,
        hp: 120,
        maxHp: 240,
        ...botOverrides,
      });
      const enemy = makeDummyCritter({
        id: "enemy-1",
        position: { ...enemyPos },
        hp: 200,
        maxHp: 240,
        ...enemyOverrides,
      });
      return {
        matchId: "bot-test",
        roomCode: "BOTT",
        seed: 42,
        theme: "emerald_spire" as const,
        mode: "ffa" as const,
        mapScale: "duel" as const,
        phase: "ACTIVE" as const,
        round: 1,
        maxRounds: 5,
        turnNumber: 1,
        activeCritterId: bot.id,
        activePlayerId: bot.id,
        phaseTimerMs: 28000,
        phaseTimeRemainingSec: 28,
        roundTimeRemainingSec: 300,
        roundDurationSec: 300,
        waterLevel: 1.5,
        floodTargetWaterLevel: null,
        matchEndReason: null,
        wind: { x: 0, y: 0, z: 0 },
        critters: [bot, enemy],
        evoPods: [],
        hazards: [],
        prismWalls: [],
        pendingDrafts: [],
        carveLog: [],
        scores: { "bot-1": 0, "enemy-1": 0 },
        teamScores: { A: 0, B: 0 },
        winnerId: null,
        winnerTeam: null,
        roundWinners: [],
      };
    };

    // 1. Damaged bot with mend_brew + prism_wall + shock_magnet queues both preUtilities and fires shock_magnet
    const shockState = makeState({
      loadout: ["gale_mortar", "mend_brew", "prism_wall", "shock_magnet"],
      gadgetCharges: {
        gale_mortar: null,
        quake_club: 0,
        vine_grapple: 0,
        spore_burst: 0,
        burrow_bore: 0,
        seeker_firefly: 0,
        gravity_mine: 0,
        prism_wall: 2,
        shock_magnet: 2,
        mend_brew: 2,
      },
    });
    const shockPlan = planBotTurn(shockState, world, "bot-1");
    expect(shockPlan.preUtilities?.map((u) => u.gadgetId)).toEqual([
      "mend_brew",
      "prism_wall",
    ]);
    expect(shockPlan.gadgetId).toBe("shock_magnet");

    // 2. Bot with gravity_mine (and no shock_magnet) targeting low-ledge enemy fires gravity_mine
    const gravityState = makeState({
      hp: 240,
      maxHp: 240,
      loadout: ["gale_mortar", "gravity_mine"],
      gadgetCharges: {
        gale_mortar: null,
        quake_club: 0,
        vine_grapple: 0,
        spore_burst: 0,
        burrow_bore: 0,
        seeker_firefly: 0,
        gravity_mine: 2,
        prism_wall: 0,
        shock_magnet: 0,
        mend_brew: 0,
      },
    });
    const gravityPlan = planBotTurn(gravityState, world, "bot-1");
    expect(gravityPlan.preUtilities).toBeUndefined();
    expect(gravityPlan.gadgetId).toBe("gravity_mine");

    // 3. Bot without shock_magnet/gravity_mine in loadout never fires unowned gadgets
    const starterState = makeState({
      loadout: ["gale_mortar"],
      gadgetCharges: {
        gale_mortar: null,
        quake_club: 0,
        vine_grapple: 0,
        spore_burst: 0,
        burrow_bore: 0,
        seeker_firefly: 0,
        gravity_mine: 2,
        prism_wall: 2,
        shock_magnet: 2,
        mend_brew: 2,
      },
    });
    const starterPlan = planBotTurn(starterState, world, "bot-1");
    expect(starterPlan.preUtilities).toBeUndefined();
    expect(starterPlan.gadgetId).toBe("gale_mortar");
  });

  it("matches exact brute-force trilinear surface heights in SdfWorld.getSurfaceY across all 4 themes", () => {
    const referenceGetSurfaceY = (
      world: SdfWorld,
      x: number,
      z: number,
    ): number | null => {
      const { ny, voxelSize: vs } = world.dims;
      const step = vs * 0.5;
      const maxY = (ny - 2) * vs;
      const minY = vs;
      let prevY = maxY;
      let prevVal = world.sample(x, prevY, z);
      for (let y = maxY - step; y >= minY; y -= step) {
        const currVal = world.sample(x, y, z);
        if (prevVal >= 0 && currVal < 0) {
          let lo = y;
          let hi = prevY;
          for (let iter = 0; iter < 4; iter++) {
            const mid = (lo + hi) * 0.5;
            if (world.sample(x, mid, z) < 0) {
              lo = mid;
            } else {
              hi = mid;
            }
          }
          return (lo + hi) * 0.5;
        }
        prevY = y;
        prevVal = currVal;
      }
      return null;
    };

    const themes = [
      "emerald_spire",
      "canyon_arch",
      "twin_pillars",
      "mountain_spine",
    ] as const;

    for (const theme of themes) {
      const world = new SdfWorld(777, theme, "duel");
      // Also apply a crater carve near center to test carved columns too
      world.applyCarve({
        center: { x: world.centerX + 4.2, y: 12.0, z: world.centerZ - 3.1 },
        radius: 3.4,
        shape: "sphere",
      });

      let solidChecks = 0;
      let airChecks = 0;
      for (let x = -1.0; x <= world.worldWidth + 1.0; x += 3.35) {
        for (let z = -1.0; z <= world.worldDepth + 1.0; z += 3.35) {
          const fastY = world.getSurfaceY(x, z);
          const refY = referenceGetSurfaceY(world, x, z);
          expect(fastY).toBe(refY);
          if (fastY !== null) {
            solidChecks += 1;
          } else {
            airChecks += 1;
          }
        }
      }
      expect(solidChecks).toBeGreaterThan(20);
      expect(airChecks).toBeGreaterThan(20);
    }
  });
});
