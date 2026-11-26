import { describe, expect, it } from "vitest";
import {
  APEX_CATALOG,
  GADGET_CATALOG,
  GAME_TITLE,
  MUTATION_CATALOG,
  SPECIES_CATALOG,
  computeApexSynergy,
  computeCritterStats,
  createDefaultGadgetCharges,
  parseClientMessage,
  type HardpointSlot,
  type MutationId,
} from "@critter/shared";

describe("Critter Siege catalogs & stats", () => {
  it("exports original Critter Siege title", () => {
    expect(GAME_TITLE).toBe("Critter Siege");
  });

  it("defines all 4 starter species and 2 unlockable species with exact stats", () => {
    expect(Object.keys(SPECIES_CATALOG).sort()).toEqual([
      "armadillo",
      "badger",
      "glider_squirrel",
      "hedgehog",
      "mole",
      "norway_rat",
    ]);

    expect(SPECIES_CATALOG.mole).toMatchObject({
      id: "mole",
      name: "Tunnel Mole",
      starter: true,
      unlockCost: 0,
      baseHp: 240,
      moveSpeed: 3.6,
      jumpImpulse: 9.8,
      carveBonus: 1.2,
      knockbackResist: 0,
      grappleReachBonus: 1.0,
      podMagnetRadius: 1.4,
      airControl: 0.35,
      retreatRollBoost: 1.0,
      meleeThorns: 0,
    });

    expect(SPECIES_CATALOG.norway_rat).toMatchObject({
      id: "norway_rat",
      name: "Norway Rat",
      starter: true,
      unlockCost: 0,
      baseHp: 230,
      moveSpeed: 4.2,
      jumpImpulse: 10.8,
      podMagnetRadius: 2.3,
      airControl: 0.4,
    });

    expect(SPECIES_CATALOG.badger).toMatchObject({
      id: "badger",
      name: "Ridge Badger",
      starter: true,
      unlockCost: 0,
      baseHp: 275,
      moveSpeed: 3.3,
      jumpImpulse: 9.6,
      knockbackResist: 0.2,
      airControl: 0.3,
    });

    expect(SPECIES_CATALOG.glider_squirrel).toMatchObject({
      id: "glider_squirrel",
      name: "Glider Squirrel",
      starter: true,
      unlockCost: 0,
      baseHp: 235,
      moveSpeed: 3.8,
      jumpImpulse: 10.2,
      grappleReachBonus: 1.15,
      airControl: 0.75,
    });

    expect(SPECIES_CATALOG.hedgehog).toMatchObject({
      id: "hedgehog",
      name: "Quill Hedgehog",
      starter: false,
      unlockCost: 80,
      baseHp: 250,
      moveSpeed: 3.5,
      meleeThorns: 12,
    });

    expect(SPECIES_CATALOG.armadillo).toMatchObject({
      id: "armadillo",
      name: "Plated Armadillo",
      starter: false,
      unlockCost: 110,
      baseHp: 260,
      moveSpeed: 3.5,
      knockbackResist: 0.15,
      retreatRollBoost: 1.45,
    });
  });

  it("maps all 8 mutations to the 4 hardpoint slots", () => {
    const slotCounts: Record<HardpointSlot, number> = {
      back: 0,
      legs: 0,
      offense: 0,
      crest: 0,
    };

    for (const mut of Object.values(MUTATION_CATALOG)) {
      slotCounts[mut.slot] += 1;
    }

    expect(Object.keys(MUTATION_CATALOG)).toHaveLength(8);
    expect(slotCounts).toEqual({
      back: 2,
      legs: 2,
      offense: 2,
      crest: 2,
    });

    expect(MUTATION_CATALOG.glider_wings.slot).toBe("back");
    expect(MUTATION_CATALOG.bramble_shell.slot).toBe("back");
    expect(MUTATION_CATALOG.spring_paws.slot).toBe("legs");
    expect(MUTATION_CATALOG.anchor_talons.slot).toBe("legs");
    expect(MUTATION_CATALOG.twin_pod.slot).toBe("offense");
    expect(MUTATION_CATALOG.burrow_claws.slot).toBe("offense");
    expect(MUTATION_CATALOG.optic_visor.slot).toBe("crest");
    expect(MUTATION_CATALOG.aegis_crest.slot).toBe("crest");
  });

  it("computes Apex synergies for all 4 named pairs, hybrid fallback, and null", () => {
    expect(Object.keys(APEX_CATALOG)).toHaveLength(5);

    expect(computeApexSynergy({})).toBeNull();
    expect(
      computeApexSynergy({
        back: "glider_wings",
        legs: "spring_paws",
      }),
    ).toBeNull();

    expect(
      computeApexSynergy({
        back: "glider_wings",
        offense: "twin_pod",
      }),
    ).toBe("sky_bomber");

    expect(
      computeApexSynergy({
        back: "bramble_shell",
        legs: "anchor_talons",
      }),
    ).toBe("bastion_tank");

    expect(
      computeApexSynergy({
        offense: "burrow_claws",
        legs: "spring_paws",
      }),
    ).toBe("tunnel_sapper");

    expect(
      computeApexSynergy({
        offense: "burrow_claws",
        crest: "aegis_crest",
      }),
    ).toBe("tunnel_sapper");

    expect(
      computeApexSynergy({
        offense: "twin_pod",
        crest: "optic_visor",
      }),
    ).toBe("siege_sniper");

    // 3+ parts with no named pair -> apex_hybrid
    expect(
      computeApexSynergy({
        back: "glider_wings",
        legs: "anchor_talons",
        crest: "optic_visor",
      }),
    ).toBe("apex_hybrid");
  });

  it("computes combined critter stats with equipped mutations", () => {
    const baseMole = computeCritterStats("mole", {});
    expect(baseMole.maxHp).toBe(240);
    expect(baseMole.carveMultiplier).toBeCloseTo(1.2, 4);
    expect(baseMole.enablesGlide).toBe(false);
    expect(baseMole.apex).toBeNull();

    const equipped: Partial<Record<HardpointSlot, MutationId>> = {
      back: "bramble_shell",
      legs: "anchor_talons",
      offense: "burrow_claws",
      crest: "aegis_crest",
    };
    const tankBadger = computeCritterStats("badger", equipped);
    // 275 + 50 + 25 + 45 = 395
    expect(tankBadger.maxHp).toBe(395);
    expect(tankBadger.meleeThorns).toBe(10);
    expect(tankBadger.roundShieldHits).toBe(1);
    expect(tankBadger.slopeCling).toBe(true);
    expect(tankBadger.enablesRetreatBurrow).toBe(true);
    expect(tankBadger.carveMultiplier).toBeCloseTo(1.3, 4);
    expect(tankBadger.apex).toBe("bastion_tank");

    const skySniper = computeCritterStats("glider_squirrel", {
      back: "glider_wings",
      legs: "spring_paws",
      offense: "twin_pod",
      crest: "optic_visor",
    });
    expect(skySniper.enablesGlide).toBe(true);
    expect(skySniper.fallDamageResist).toBe(0.5);
    expect(skySniper.bonusMiniDart).toBe(true);
    expect(skySniper.extendedTrajectory).toBe(true);
    expect(skySniper.mobilityBonus).toBe(65);
    expect(skySniper.moveSpeed).toBeCloseTo(3.8 * 1.65, 4);
    expect(skySniper.jumpImpulse).toBeCloseTo(10.2 * 1.22, 4);
    expect(skySniper.carveMultiplier).toBeCloseTo(1.6, 4);
    expect(skySniper.apex).toBe("sky_bomber");
  });

  it("initializes default gadget charges and optional bonus lobby gadget", () => {
    const standardCharges = createDefaultGadgetCharges();
    expect(standardCharges.gale_mortar).toBeNull();
    expect(standardCharges.vine_grapple).toBe(6);
    expect(standardCharges.seeker_firefly).toBe(1);
    expect(standardCharges.gravity_mine).toBe(0);

    const withBonus = createDefaultGadgetCharges("gravity_mine");
    expect(withBonus.gravity_mine).toBe(1);
    expect(withBonus.prism_wall).toBe(0);
  });

  it("defines all 6 standard gadgets and 3 bonus lobby gadgets with exact flags", () => {
    expect(Object.keys(GADGET_CATALOG)).toHaveLength(9);

    const standard = Object.values(GADGET_CATALOG).filter(
      (g) => !g.bonusLobbyOnly,
    );
    const bonus = Object.values(GADGET_CATALOG).filter((g) => g.bonusLobbyOnly);

    expect(standard).toHaveLength(6);
    expect(bonus).toHaveLength(3);

    expect(GADGET_CATALOG.gale_mortar).toMatchObject({
      id: "gale_mortar",
      name: "Gale Mortar",
      chargesPerRound: null,
      turnEnding: true,
      windAffected: true,
      baseDamage: 34,
      carveRadius: 3.2,
      knockback: 11,
      bonusLobbyOnly: false,
    });

    expect(GADGET_CATALOG.quake_club).toMatchObject({
      chargesPerRound: null,
      turnEnding: true,
      windAffected: false,
      baseDamage: 24,
      carveRadius: 0.9,
      knockback: 19,
    });

    expect(GADGET_CATALOG.vine_grapple).toMatchObject({
      chargesPerRound: 6,
      turnEnding: false,
      windAffected: false,
      baseDamage: 0,
      carveRadius: 0,
      knockback: 4,
    });

    expect(GADGET_CATALOG.spore_burst).toMatchObject({
      chargesPerRound: 2,
      turnEnding: true,
      windAffected: true,
      baseDamage: 16,
      carveRadius: 2.6,
      knockback: 12,
      subSporeCount: 5,
    });

    expect(GADGET_CATALOG.burrow_bore).toMatchObject({
      chargesPerRound: 2,
      turnEnding: true,
      windAffected: false,
      baseDamage: 36,
      carveRadius: 3.1,
      knockback: 10,
      tunnelDurationSec: 0.6,
    });

    expect(GADGET_CATALOG.seeker_firefly).toMatchObject({
      chargesPerRound: 1,
      turnEnding: true,
      windAffected: false,
      baseDamage: 30,
      carveRadius: 2.8,
      knockback: 11,
      requiresDronePing: true,
    });

    expect(GADGET_CATALOG.gravity_mine).toMatchObject({
      bonusLobbyOnly: true,
      unlockCost: 90,
      chargesPerRound: 0,
      turnEnding: true,
      baseDamage: 18,
      carveRadius: 2.2,
      knockback: -14,
    });

    expect(GADGET_CATALOG.prism_wall).toMatchObject({
      bonusLobbyOnly: true,
      unlockCost: 90,
      chargesPerRound: 0,
      turnEnding: false,
      baseDamage: 0,
      carveRadius: 0,
      knockback: 0,
    });

    expect(GADGET_CATALOG.shock_magnet).toMatchObject({
      bonusLobbyOnly: true,
      unlockCost: 110,
      chargesPerRound: 0,
      turnEnding: true,
      baseDamage: 22,
      carveRadius: 1.8,
      knockback: 14,
    });
  });
});

describe("WebSocket client message parser", () => {
  it("accepts valid ClientMessage payloads", () => {
    expect(
      parseClientMessage({
        type: "CREATE_ROOM",
        playerName: "Sapper",
        species: "mole",
        theme: "emerald_spire",
        mode: "ffa",
        botCount: 2,
      }),
    ).toEqual({
      type: "CREATE_ROOM",
      playerName: "Sapper",
      species: "mole",
      theme: "emerald_spire",
      mode: "ffa",
      botCount: 2,
    });

    expect(
      parseClientMessage({
        type: "JOIN_ROOM",
        roomCode: "abcd",
        playerName: "Bandit",
        species: "norway_rat",
      }),
    ).toEqual({
      type: "JOIN_ROOM",
      roomCode: "ABCD",
      playerName: "Bandit",
      species: "norway_rat",
    });

    expect(
      parseClientMessage({
        type: "FIRE_ACTION",
        gadgetId: "gale_mortar",
        origin: { x: 1, y: 2, z: 3 },
        direction: { x: 0, y: 0.5, z: 0.86 },
        power: 0.75,
      }),
    ).toEqual({
      type: "FIRE_ACTION",
      gadgetId: "gale_mortar",
      origin: { x: 1, y: 2, z: 3 },
      direction: { x: 0, y: 0.5, z: 0.86 },
      power: 0.75,
    });

    expect(
      parseClientMessage({
        type: "PICK_MUTATION",
        mutationId: "optic_visor",
        replaceSlot: "crest",
      }),
    ).toEqual({
      type: "PICK_MUTATION",
      mutationId: "optic_visor",
      replaceSlot: "crest",
    });

    expect(parseClientMessage({ type: "START_MATCH" })).toEqual({
      type: "START_MATCH",
    });
    expect(parseClientMessage({ type: "REROLL_DRAFT" })).toEqual({
      type: "REROLL_DRAFT",
    });

    expect(
      parseClientMessage({
        type: "RECONNECT_ROOM",
        roomCode: "WXYZ",
        playerId: "p1",
        reconnectToken: "tok-123",
      }),
    ).toEqual({
      type: "RECONNECT_ROOM",
      roomCode: "WXYZ",
      playerId: "p1",
      reconnectToken: "tok-123",
    });

    expect(
      parseClientMessage({
        type: "LOBBY_CONFIG",
        theme: "canyon_arch",
        mode: "2v2",
        botCount: 1,
        mapScale: "grand",
        species: "badger",
        team: "B",
        bonusGadget: null,
      }),
    ).toEqual({
      type: "LOBBY_CONFIG",
      theme: "canyon_arch",
      mode: "2v2",
      botCount: 1,
      mapScale: "grand",
      species: "badger",
      team: "B",
      bonusGadget: null,
    });

    expect(
      parseClientMessage({
        type: "LOBBY_CONFIG",
        theme: "mountain_spine",
        mapScale: "auto",
      }),
    ).toEqual({
      type: "LOBBY_CONFIG",
      theme: "mountain_spine",
      mapScale: "auto",
    });

    expect(
      parseClientMessage({
        type: "CREATE_ROOM",
        playerName: "Sapper",
        species: "mole",
        mapScale: "duel",
      }),
    ).toEqual({
      type: "CREATE_ROOM",
      playerName: "Sapper",
      species: "mole",
      mapScale: "duel",
    });

    expect(
      parseClientMessage({
        type: "MOVE_STATE",
        position: { x: 2, y: 5, z: -1 },
        velocity: { x: 0, y: 0, z: 0 },
        yaw: 1.57,
      }),
    ).toEqual({
      type: "MOVE_STATE",
      position: { x: 2, y: 5, z: -1 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 1.57,
    });

    expect(
      parseClientMessage({
        type: "UTILITY_ACTION",
        gadgetId: "vine_grapple",
        origin: { x: 0, y: 4, z: 0 },
        direction: { x: 1, y: 0.5, z: 0 },
        target: { x: 5, y: 7, z: 0 },
      }),
    ).toEqual({
      type: "UTILITY_ACTION",
      gadgetId: "vine_grapple",
      origin: { x: 0, y: 4, z: 0 },
      direction: { x: 1, y: 0.5, z: 0 },
      target: { x: 5, y: 7, z: 0 },
    });

    expect(
      parseClientMessage({
        type: "RETREAT_BURROW",
        direction: { x: 0, y: 0, z: 1 },
      }),
    ).toEqual({
      type: "RETREAT_BURROW",
      direction: { x: 0, y: 0, z: 1 },
    });

    expect(
      parseClientMessage({
        type: "DRONE_NUDGE",
        windDelta: { x: 1.5, y: 0, z: -0.5 },
      }),
    ).toEqual({
      type: "DRONE_NUDGE",
      windDelta: { x: 1.5, y: 0, z: -0.5 },
    });
  });

  it("rejects malformed or invalid inputs cleanly without throwing", () => {
    const malformedInputs: unknown[] = [
      null,
      undefined,
      42,
      "CREATE_ROOM",
      [],
      {},
      { type: "UNKNOWN_MSG" },
      { type: "CREATE_ROOM", playerName: "", species: "mole" },
      { type: "CREATE_ROOM", playerName: "   ", species: "mole" },
      { type: "CREATE_ROOM", playerName: "Scout", species: "dragon" },
      { type: "CREATE_ROOM", playerName: "Scout", species: "toString" },
      {
        type: "CREATE_ROOM",
        playerName: "Scout",
        species: "mole",
        botCount: 9,
      },
      {
        type: "JOIN_ROOM",
        roomCode: "12",
        playerName: "Scout",
        species: "mole",
      },
      {
        type: "FIRE_ACTION",
        gadgetId: "gale_mortar",
        origin: { x: Number.NaN, y: 0, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        power: 0.5,
      },
      {
        type: "FIRE_ACTION",
        gadgetId: "gale_mortar",
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 0 },
        power: 0.5,
      },
      {
        type: "FIRE_ACTION",
        gadgetId: "gale_mortar",
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        power: 1.5,
      },
      {
        type: "PICK_MUTATION",
        mutationId: "laser_eyes",
      },
      {
        type: "PICK_MUTATION",
        mutationId: "constructor",
      },
      {
        type: "DRONE_NUDGE",
        windDelta: { x: 1, y: Infinity, z: 0 },
      },
    ];

    for (const input of malformedInputs) {
      expect(() => parseClientMessage(input)).not.toThrow();
      expect(parseClientMessage(input)).toBeNull();
    }
  });
});
