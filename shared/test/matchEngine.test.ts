import { describe, expect, it } from "vitest";
import {
  GRAVITY,
  MatchEngine,
  SdfWorld,
  planBotTurn,
  sampleAimArc,
  simulateShot,
  type CritterState,
  type MatchConfig,
  type ShotParams,
} from "@critter/shared";

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
    position: { x: 8, y: 8.5, z: 12 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    maxHp: 100,
    alive: true,
    evoCharge: 0,
    pendingEvoDraft: false,
    equipped: {},
    apex: null,
    gadgetCharges: {
      gale_mortar: null,
      quake_club: null,
      vine_grapple: 2,
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
    colorIndex: 0,
    color: "#e67e22",
    ...overrides,
  };
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
    const direction = { x: 0.6, y: 0.8, z: 0 };

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
    const surfaceY = world.getSurfaceY(7.2, 12.0);
    expect(surfaceY).not.toBeNull();
    if (surfaceY === null) return;

    const origin = { x: 7.2, y: surfaceY + 1.0, z: 12.0 };
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
      expect(tunnelLen).toBeGreaterThan(1.5);
    }
    expect(moleShot.durationSec).toBeGreaterThanOrEqual(0.6);
  });

  it("simulates spore_burst spawning 5 deterministic sub-spore blasts", () => {
    const world = new SdfWorld(77, "emerald_spire");
    const surfaceY = world.getSurfaceY(7.2, 12.0);
    expect(surfaceY).not.toBeNull();
    if (surfaceY === null) return;

    const params: ShotParams = {
      shooterId: "p1",
      gadgetId: "spore_burst",
      origin: { x: 7.2, y: surfaceY + 1.2, z: 12.0 },
      direction: { x: 0.4, y: -0.9, z: 0 },
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
    const surfaceY = world.getSurfaceY(7.2, 12.0);
    expect(surfaceY).not.toBeNull();
    if (surfaceY === null) return;

    const attacker = makeDummyCritter({
      id: "attacker",
      species: "norway_rat",
      position: { x: 7.2, y: surfaceY, z: 12.0 },
      hp: 100,
    });
    const defender = makeDummyCritter({
      id: "defender",
      species: "hedgehog",
      position: { x: 8.8, y: surfaceY, z: 12.0 },
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
    expect(result.carveOps[0]?.radius).toBeCloseTo(0.7, 2);
  });

  it("supports aegis_crest 1-hit shield absorption and gravity_mine inward pull", () => {
    const world = new SdfWorld(88, "emerald_spire");
    const surfaceY = world.getSurfaceY(7.2, 12.0);
    expect(surfaceY).not.toBeNull();
    if (surfaceY === null) return;

    const target = makeDummyCritter({
      id: "shielded",
      species: "badger",
      position: { x: 7.2, y: surfaceY, z: 12.0 },
      hp: 140,
      maxHp: 140,
      equipped: { crest: "aegis_crest" },
      roundShieldRemaining: 1,
    });

    const res = simulateShot(
      world,
      [target],
      {
        shooterId: "other",
        gadgetId: "gravity_mine",
        origin: { x: 8.6, y: surfaceY + 1.2, z: 12.0 },
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
      // Pulled inward toward x=8.6 from x=7.2 => positive x velocity
      expect(hit.knockbackVelocity.x).toBeGreaterThan(0);
    }
  });
});

describe("Authoritative MatchEngine turn state machine & review edge cases", () => {
  it("keeps ACTIVE phase on vine_grapple utility and transitions ACTIVE -> RESOLVING -> RETREAT (5s) on gale_mortar", () => {
    const engine = new MatchEngine(makeBaseConfig());
    const init = engine.getSnapshot();
    expect(init.phase).toBe("ACTIVE");
    expect(init.activePlayerId).toBe("p1");
    expect(init.phaseTimeRemainingSec).toBe(15);

    const p1 = init.critters.find((c) => c.id === "p1");
    expect(p1).toBeDefined();
    if (!p1) return;

    // Vine Grapple does NOT end ACTIVE phase
    engine.applyUtility("p1", {
      gadgetId: "vine_grapple",
      direction: { x: 1, y: 0.4, z: 0 },
      target: { x: p1.position.x + 2, y: p1.position.y + 1, z: p1.position.z },
    });
    const afterGrapple = engine.getSnapshot();
    expect(afterGrapple.phase).toBe("ACTIVE");
    expect(afterGrapple.activePlayerId).toBe("p1");
    expect(afterGrapple.critters.find((c) => c.id === "p1")?.gadgetCharges.vine_grapple).toBe(1);

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

    // Completing RESOLVING transitions to RETREAT (5s) when shooter is alive
    engine.completeResolving();
    const retreat = engine.getSnapshot();
    expect(retreat.phase).toBe("RETREAT");
    expect(retreat.phaseTimeRemainingSec).toBe(5);
    expect(retreat.activePlayerId).toBe("p1");

    // Retreat timer expiring transitions to next player's ACTIVE turn
    engine.tick(5.1);
    const nextTurn = engine.getSnapshot();
    expect(nextTurn.phase).toBe("ACTIVE");
    expect(nextTurn.activePlayerId).toBe("p2");
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

    // Chip p1 down via self-blasts straight down at own feet until self-KO
    let selfKoResolved = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const snap = engine.getSnapshot();
      if (snap.activePlayerId !== "p1") {
        // Advance other players' turns by timing out ACTIVE
        engine.tick(16);
        continue;
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
        // Survived earlier chip blast -> finish retreat to continue loop
        expect(afterResolve.phase).toBe("RETREAT");
        engine.tick(5.1);
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

    expect(engine.getSnapshot().activePlayerId).toBe("A1");

    // Move A2 right next to A1 on A2's turn, or move A1 right next to A2 and friendly-fire KO A2
    const a2Pos = engine.getSnapshot().critters.find((c) => c.id === "A2")?.position;
    expect(a2Pos).toBeDefined();
    if (!a2Pos) return;

    // Move A1 adjacent to A2 and blast A2 repeatedly (friendly fire!) until A2 is KO'd
    let a2Ko = false;
    for (let guard = 0; guard < 16 && !a2Ko; guard++) {
      const snap = engine.getSnapshot();
      const active = snap.activePlayerId;
      if (active === "A1") {
        const a2Curr = snap.critters.find((c) => c.id === "A2");
        if (a2Curr && a2Curr.alive) {
          // Stand 1.5m away from A2 and fire gale_mortar at A2's feet (out of self-KO range)
          const safeX = a2Curr.position.x - 2.0;
          const safeY = engine.world.getSurfaceY(safeX, a2Curr.position.z) ?? a2Curr.position.y;
          engine.applyMove("A1", { x: safeX, y: safeY, z: a2Curr.position.z }, 0, 0);
          engine.applyFire("A1", {
            gadgetId: "quake_club",
            direction: { x: 1, y: 0.1, z: 0 },
            power: 1.0,
          });
          engine.completeResolving();
          if (engine.getSnapshot().phase === "RETREAT") {
            engine.tick(5.1);
          }
          const post = engine.getSnapshot();
          if (!post.critters.find((c) => c.id === "A2")?.alive) {
            a2Ko = true;
          }
          continue;
        }
      }
      // Other players time out their turn without killing anyone
      engine.tick(16);
    }

    // If quake_club didn't finish A2 due to terrain bounce, finish via drowning A2 on A2's own turn or verify friendly fire KO
    const afterCheck = engine.getSnapshot();
    expect(a2Ko).toBe(true);
    // Friendly fire KO on teammate A2 must award 0 KO points to A1 and Team A!
    expect(afterCheck.scores.A1).toBe(0);
    expect(afterCheck.teamScores.A).toBe(0);
    expect(afterCheck.critters.find((c) => c.id === "A1")?.kills).toBe(0);

    // Advance until A1 is active so we can observe the exact sequence A1 -> B1 -> A1 -> B2 -> A1
    for (let i = 0; i < 4 && engine.getSnapshot().activePlayerId !== "A1"; i++) {
      engine.tick(16);
    }
    expect(engine.getSnapshot().activePlayerId).toBe("A1");

    const observed: Array<string | null> = [];
    for (let step = 0; step < 5; step++) {
      observed.push(engine.getSnapshot().activePlayerId);
      engine.tick(16);
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

    // Advance 2 turns so an Evo Pod spawns on Turn 2 (and Turn 4 for second pod)
    // Better yet: advance to Turn 2, collect pod #1 (+50%), advance to Turn 4, collect pod #2 (+50% -> 100%)
    engine.tick(16); // Turn 2 -> p2, spawns Pod #1
    expect(engine.getSnapshot().evoPods.length).toBeGreaterThanOrEqual(1);
    engine.tick(16); // Turn 3 -> p1
    engine.tick(16); // Turn 4 -> p2, spawns Pod #2
    engine.tick(16); // Turn 5 -> p1 (now >= 2 uncollected pods exist!)

    const beforeCollect = engine.getSnapshot();
    expect(beforeCollect.activePlayerId).toBe("p1");
    expect(beforeCollect.phase).toBe("ACTIVE");
    const uncollected = beforeCollect.evoPods.filter((p) => !p.collected);
    expect(uncollected.length).toBeGreaterThanOrEqual(2);

    const pod1 = uncollected[0];
    const pod2 = uncollected[1];
    expect(pod1).toBeDefined();
    expect(pod2).toBeDefined();
    if (!pod1 || !pod2) return;

    // Tick 2s into ACTIVE turn so timer is 13s
    engine.tick(2.0);
    expect(engine.getSnapshot().phaseTimeRemainingSec).toBeCloseTo(13.0, 2);

    // Collect Pod 1 (+50% charge) and Pod 2 (+50% -> 100% charge) during ACTIVE
    const ev1 = engine.applyMove("p1", { ...pod1.position }, 0, 0);
    const ev2 = engine.applyMove("p1", { ...pod2.position }, 0, 0);
    expect(ev1.some((e) => e.type === "EVO_POD_COLLECTED")).toBe(true);
    expect(ev2.some((e) => e.type === "EVO_POD_COLLECTED")).toBe(true);

    // MUST NOT interrupt ACTIVE phase or timer!
    const midActive = engine.getSnapshot();
    expect(midActive.phase).toBe("ACTIVE");
    expect(midActive.phaseTimeRemainingSec).toBeCloseTo(13.0, 2);
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
    engine.tick(5.1);

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

    // Now test full 4-slot swap draft + Apex recalculation using deterministic helper
    // Fill all 4 slots on p1 via 3 more evo drafts or direct round drafts
    const fullEngine = new MatchEngine(
      makeBaseConfig({
        seed: 555,
        players: [
          { id: "p1", name: "Milo", species: "mole", team: 0, isBot: false, color: "#e67e22" },
          { id: "p2", name: "Remy", species: "badger", team: 1, isBot: false, color: "#3498db" },
        ],
      }),
    );

    // Equip all 4 slots across rounds + Evo Pods, verifying trailing reroll & full-slot swap cards
    let equippedSlots = 0;
    let sawSwapDraft = false;
    let sawTrailingReroll = false;
    let podsCollectedThisRound = 0;
    let lastRoundSeen = 1;

    for (let step = 0; step < 80 && !sawSwapDraft; step++) {
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
        const pods = snap.evoPods.filter((p) => !p.collected);
        for (const pod of pods) {
          if (fullEngine.getSnapshot().critters.find((c) => c.id === "p1")?.alive) {
            const evs = fullEngine.applyMove("p1", { ...pod.position }, 0, 0);
            if (evs.some((e) => e.type === "EVO_POD_COLLECTED")) {
              podsCollectedThisRound += 1;
            }
          }
        }
      } else if (
        snap.phase === "ACTIVE" &&
        snap.activePlayerId === "p2" &&
        podsCollectedThisRound >= 2 &&
        snap.round < 3
      ) {
        fullEngine.applyMove(
          "p2",
          { x: 12, y: snap.waterLevel - 0.5, z: 12 },
          0,
          0,
        );
        continue;
      }
      fullEngine.tick(16);
    }

    expect(equippedSlots).toBe(4);
    expect(sawSwapDraft).toBe(true);
    expect(sawTrailingReroll).toBe(true);
  });

  it("raises water +0.5m/turn from Turn 4+, drowns submerged critters, enforces 1-per-turn drone wind nudge, and plans valid bot aim", () => {
    const engine = new MatchEngine(
      makeBaseConfig({
        players: [
          { id: "p1", name: "Milo", species: "mole", team: 0, isBot: false, color: "#e67e22" },
          { id: "p2", name: "Remy", species: "norway_rat", team: 1, isBot: true, color: "#3498db" },
          { id: "p3", name: "Bram", species: "badger", team: 0, isBot: true, color: "#2ecc71" },
        ],
      }),
    );

    const startWater = engine.getSnapshot().waterLevel;
    // Turn 1 -> 2 -> 3: water stays constant
    engine.tick(16);
    expect(engine.getSnapshot().turnNumber).toBe(2);
    expect(engine.getSnapshot().waterLevel).toBe(startWater);

    engine.tick(16);
    expect(engine.getSnapshot().turnNumber).toBe(3);
    expect(engine.getSnapshot().waterLevel).toBe(startWater);

    // Turn 3 -> 4: water rises +0.5m and emits WATER_ROSE
    const turn4Events = engine.tick(16);
    expect(engine.getSnapshot().turnNumber).toBe(4);
    expect(engine.getSnapshot().waterLevel).toBeCloseTo(startWater + 0.5, 4);
    expect(turn4Events.some((e) => e.type === "WATER_ROSE")).toBe(true);

    // Drown active critter (p1) by moving below waterLevel
    const snap4 = engine.getSnapshot();
    expect(snap4.activePlayerId).toBe("p1");
    engine.applyMove("p1", { x: 12, y: snap4.waterLevel - 0.2, z: 12 }, 0, 0);
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

    // Bot planner produces valid non-zero aim toward an alive enemy
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
    const surfY = world.getSurfaceY(7.2, 12.0);
    expect(surfY).not.toBeNull();
    if (surfY === null) return;

    const target = makeDummyCritter({
      id: "enemy",
      species: "norway_rat",
      position: { x: 7.2, y: surfY, z: 12.0 },
      hp: 100,
    });

    // Twin Shoulder Pod adds secondary mini-dart blast on direct hit
    const twinRes = simulateShot(
      world,
      [target],
      {
        shooterId: "shooter",
        gadgetId: "gale_mortar",
        origin: { x: 7.2, y: surfY + 1.4, z: 12.0 },
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

    // Seeker Firefly homes smoothly onto droneTarget
    const fireflyTarget = { x: 16.0, y: surfY + 0.5, z: 12.0 };
    const fireflyRes = simulateShot(
      world,
      [],
      {
        shooterId: "shooter",
        gadgetId: "seeker_firefly",
        origin: { x: 7.2, y: surfY + 1.2, z: 12.0 },
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
      expect(impactPos.x).toBeGreaterThan(10.0);
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
});
