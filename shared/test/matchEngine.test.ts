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
    const duelEngine = new MatchEngine(makeBaseConfig());
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

  it("drowns an outer-edge critter when Cycle 9+ grand cliff crumble leaves open ocean below and handles Cycle 9+ vine_grapple water plunge", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
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

    // Advance to Cycle 9 (Turn 25 in 3p Grand) so crumbleOuterRing(66.0) erodes the rim under p1 (surfY === null)
    while (engine.getSnapshot().turnNumber < 25) {
      engine.tick(36);
    }

    const snap25 = engine.getSnapshot();
    const p1AfterCrumble = snap25.critters.find((c) => c.id === "p1");
    expect(p1AfterCrumble?.alive).toBe(false);
    expect(p1AfterCrumble?.hp).toBe(0);
    expect(p1AfterCrumble?.position.y).toBeLessThanOrEqual(snap25.waterLevel);

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
});
