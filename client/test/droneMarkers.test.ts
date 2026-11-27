import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  SPECIES_CATALOG,
  type CritterState,
  type GadgetId,
  type Vec3,
} from "@critter/shared";
import {
  projectDroneMarkers,
  resolveDronePingTarget,
} from "../src/game/droneProjection.js";
import { VfxSystem, type DroneBeaconInput } from "../src/scene/vfx.js";

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
    position: { x: 30, y: 10, z: 30 },
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

function makeDroneCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1280 / 720, 0.2, 400);
  camera.position.set(30, 34, 52);
  camera.lookAt(30, 10, 30);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

describe("Task 4: Drone View 3D Player Beacons & Screen-Space Callout Markers", () => {
  it("projects alive critters, marks local player with null distance, computes rival distance, uses position overrides, and omits dead critters", () => {
    const camera = makeDroneCamera();
    const critters: CritterState[] = [
      makeCritter({
        id: "p1",
        name: "BurrowBoss",
        species: "mole",
        team: "A",
        position: { x: 30, y: 10, z: 30 },
        hp: 215,
        maxHp: 240,
        color: "#f97316",
      }),
      makeCritter({
        id: "p2",
        name: "SkyGlider",
        species: "glider_squirrel",
        team: "B",
        position: { x: 33, y: 10, z: 34 },
        hp: 150,
        maxHp: 200,
        color: "#fb7185",
      }),
      makeCritter({
        id: "p3",
        name: "FallenRat",
        species: "norway_rat",
        alive: false,
        hp: 0,
        position: { x: 25, y: 8, z: 25 },
        color: "#22c55e",
      }),
    ];

    const overrides = new Map<string, Vec3>([
      ["p2", { x: 36, y: 11, z: 38 }], // dx=6, dz=8 => hypot = 10m
    ]);

    const markers = projectDroneMarkers(
      critters,
      "p1",
      "p2",
      camera,
      1280,
      720,
      overrides,
    );

    expect(markers).toHaveLength(2);
    expect(markers.find((m) => m.id === "p3")).toBeUndefined();

    const local = markers.find((m) => m.id === "p1");
    expect(local).toBeDefined();
    expect(local?.isLocal).toBe(true);
    expect(local?.isActiveTurn).toBe(false);
    expect(local?.distanceMeters).toBeNull();
    expect(local?.speciesName).toBe(SPECIES_CATALOG.mole.name);
    expect(local?.team).toBe("A");
    expect(local?.offscreen).toBe(false);
    expect(local?.screenX).toBeGreaterThan(56);
    expect(local?.screenX).toBeLessThan(1280 - 56);
    expect(local?.screenY).toBeGreaterThan(76);
    expect(local?.screenY).toBeLessThan(720 - 86);

    const rival = markers.find((m) => m.id === "p2");
    expect(rival).toBeDefined();
    expect(rival?.isLocal).toBe(false);
    expect(rival?.isActiveTurn).toBe(true);
    expect(rival?.distanceMeters).toBe(10);
    expect(rival?.speciesName).toBe(SPECIES_CATALOG.glider_squirrel.name);
    expect(rival?.team).toBe("B");
    expect(rival?.offscreen).toBe(false);
  });

  it("clamps behind-camera and far-offscreen targets cleanly into viewport bounds with offscreen: true and finite edgeAngleRad", () => {
    const camera = makeDroneCamera();
    const width = 1280;
    const height = 720;

    const critters: CritterState[] = [
      makeCritter({
        id: "behind",
        name: "RearSneak",
        position: { x: 32, y: 40, z: 95 }, // well behind camera at z=52 looking toward z=30
        color: "#a855f7",
      }),
      makeCritter({
        id: "far-right",
        name: "EdgeScout",
        position: { x: 140, y: 10, z: 30 }, // far outside right frustum edge
        color: "#ef4444",
      }),
    ];

    const markers = projectDroneMarkers(
      critters,
      null,
      null,
      camera,
      width,
      height,
    );

    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(marker.offscreen).toBe(true);
      expect(Number.isFinite(marker.edgeAngleRad)).toBe(true);
      expect(marker.screenX).toBeGreaterThanOrEqual(56);
      expect(marker.screenX).toBeLessThanOrEqual(width - 56);
      expect(marker.screenY).toBeGreaterThanOrEqual(76);
      expect(marker.screenY).toBeLessThanOrEqual(height - 86);
    }

    const farRight = markers.find((m) => m.id === "far-right");
    expect(farRight?.screenX).toBeCloseTo(width - 56, 1);

    // Zero or non-finite viewports are safely guarded
    expect(projectDroneMarkers(critters, null, null, camera, 0, height)).toEqual([]);
    expect(projectDroneMarkers(critters, null, null, camera, width, Number.NaN)).toEqual([]);
  });

  it("syncDronePlayerBeacons renders gold local beacon + colored rival beacons, hides on visible=false, prunes eliminated critters, and disposes cleanly", () => {
    const vfx = new VfxSystem();
    const beaconGroup = vfx.group.getObjectByName("vfx_drone_player_beacons");
    expect(beaconGroup).toBeInstanceOf(THREE.Group);
    expect(beaconGroup?.visible).toBe(false);

    const localBeacon: DroneBeaconInput = {
      id: "local-1",
      position: { x: 20, y: 10, z: 22 },
      color: "#38bdf8",
      isLocal: true,
      isActiveTurn: false,
    };
    const rivalBeacon: DroneBeaconInput = {
      id: "rival-1",
      position: { x: 42, y: 14, z: 18 },
      color: "#fb7185",
      isLocal: false,
      isActiveTurn: true,
    };
    const beacons: DroneBeaconInput[] = [localBeacon, rivalBeacon];

    vfx.syncDronePlayerBeacons(beacons, true, 0);
    expect(beaconGroup?.visible).toBe(true);
    expect(beaconGroup?.children).toHaveLength(2);

    const localRig = beaconGroup?.getObjectByName("drone_beacon_local-1");
    const rivalRig = beaconGroup?.getObjectByName("drone_beacon_rival-1");
    expect(localRig).toBeInstanceOf(THREE.Group);
    expect(rivalRig).toBeInstanceOf(THREE.Group);

    const localPillar = localRig?.getObjectByName("drone_beacon_pillar") as THREE.Mesh;
    const localRing = localRig?.getObjectByName("drone_beacon_ring") as THREE.Mesh;
    const rivalPillar = rivalRig?.getObjectByName("drone_beacon_pillar") as THREE.Mesh;
    const rivalRing = rivalRig?.getObjectByName("drone_beacon_ring") as THREE.Mesh;

    // Local beacon is unmistakable gold (0xfacc15) with wider 1.35x ring
    expect((localPillar.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xfacc15);
    expect((localRing.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xfacc15);
    expect(localRing.scale.x).toBeGreaterThan(rivalRing.scale.x);
    expect(localRing.scale.x).toBeCloseTo(1.35, 1);

    // Pillar base rests cleanly at pos.y + 0.15 (height 18 => center at local y = 9.15)
    expect(localRig?.position.y).toBeCloseTo(10, 4);
    expect(localPillar.position.y).toBeCloseTo(9.15, 3);

    // Rival beacon uses rival's assigned color
    expect((rivalPillar.material as THREE.MeshBasicMaterial).color.getHex()).toBe(
      new THREE.Color("#fb7185").getHex(),
    );

    // Prune eliminated rival when omitted from beacons list
    vfx.syncDronePlayerBeacons([localBeacon], true, 0.5);
    expect(beaconGroup?.children).toHaveLength(1);
    expect(beaconGroup?.getObjectByName("drone_beacon_rival-1")).toBeUndefined();

    // Instant hiding on exiting Drone View
    vfx.syncDronePlayerBeacons([localBeacon], false, 1.0);
    expect(beaconGroup?.visible).toBe(false);

    // Clean disposal
    expect(() => vfx.dispose()).not.toThrow();
    expect(beaconGroup?.children).toHaveLength(0);
  });

  it("resolveDronePingTarget snaps dead-center onto rival under ray instead of distant hill behind them", () => {
    const critters: CritterState[] = [
      makeCritter({
        id: "me",
        name: "LocalMole",
        position: { x: 10, y: 10, z: 10 },
      }),
      makeCritter({
        id: "rival-1",
        name: "RidgeBadger",
        position: { x: 30, y: 10, z: 30 },
      }),
      makeCritter({
        id: "dead-rival",
        name: "FallenRat",
        alive: false,
        hp: 0,
        position: { x: 30, y: 10, z: 35 },
      }),
    ];

    // Oblique drone camera at (30, 34, 52) clicking right on rival-1's body center (30, 10.7, 30),
    // while the terrain ray continues through them onto a distant hill behind them at (30, 2, 10)
    const rayOrigin: Vec3 = { x: 30, y: 34, z: 52 };
    const rayDir: Vec3 = { x: 0, y: 10.7 - 34, z: 30 - 52 };
    const distantHillHit: Vec3 = { x: 30, y: 2, z: 10 };

    const res = resolveDronePingTarget(
      distantHillHit,
      rayOrigin,
      rayDir,
      critters,
      "me",
    );
    expect(res).toEqual({
      point: { x: 30, y: 10.4, z: 30 },
      lockedCritterId: "rival-1",
      lockedCritterName: "RidgeBadger",
    });

    // Live rig position override takes precedence over stale CritterState.position
    const liveOverrides = new Map<string, Vec3>([
      ["rival-1", { x: 31, y: 11, z: 30 }],
    ]);
    const liveRayDir: Vec3 = { x: 1, y: 11.7 - 34, z: 30 - 52 };
    const resLive = resolveDronePingTarget(
      distantHillHit,
      rayOrigin,
      liveRayDir,
      critters,
      "me",
      liveOverrides,
    );
    expect(resLive).toEqual({
      point: { x: 31, y: 11.4, z: 30 },
      lockedCritterId: "rival-1",
      lockedCritterName: "RidgeBadger",
    });
  });

  it("resolveDronePingTarget locks silhouetted rivals with terrainHit=null, falls back to terrainHit when far, and ignores local & dead critters", () => {
    const critters: CritterState[] = [
      makeCritter({
        id: "me",
        name: "LocalMole",
        position: { x: 20, y: 10, z: 20 },
      }),
      makeCritter({
        id: "dead-1",
        name: "Fallen",
        alive: false,
        hp: 0,
        position: { x: 35, y: 14, z: 20 },
      }),
      makeCritter({
        id: "sky-rival",
        name: "CliffSquirrel",
        position: { x: 45, y: 20, z: 15 },
      }),
    ];

    // Silhouette click (no terrain behind rival -> terrainHit: null) still locks rival
    const skyOrigin: Vec3 = { x: 45, y: 22, z: 40 };
    const skyDir: Vec3 = { x: 0, y: 20.7 - 22, z: 15 - 40 };
    const skyLock = resolveDronePingTarget(
      null,
      skyOrigin,
      skyDir,
      critters,
      "me",
    );
    expect(skyLock).toEqual({
      point: { x: 45, y: 20.4, z: 15 },
      lockedCritterId: "sky-rival",
      lockedCritterName: "CliffSquirrel",
    });

    // Clicking empty sky away from any rival returns null
    const missSky = resolveDronePingTarget(
      null,
      skyOrigin,
      { x: 1, y: 0.4, z: 0 },
      critters,
      "me",
    );
    expect(missSky).toBeNull();

    // Clicking directly on local player or dead critter ignores them and falls back to terrainHit
    const localTerrainHit: Vec3 = { x: 20, y: 10, z: 20 };
    const clickLocal = resolveDronePingTarget(
      localTerrainHit,
      { x: 20, y: 30, z: 40 },
      { x: 0, y: -19.3, z: -20 },
      critters,
      "me",
    );
    expect(clickLocal).toEqual({
      point: localTerrainHit,
      lockedCritterId: null,
      lockedCritterName: null,
    });

    const deadTerrainHit: Vec3 = { x: 35, y: 14, z: 20 };
    const clickDead = resolveDronePingTarget(
      deadTerrainHit,
      { x: 35, y: 30, z: 40 },
      { x: 0, y: -15.3, z: -20 },
      critters,
      "me",
    );
    expect(clickDead).toEqual({
      point: deadTerrainHit,
      lockedCritterId: null,
      lockedCritterName: null,
    });

    // Clicking ground within 2.6m of rival snaps onto rival even if ray slightly outside 2.2m
    const nearFootHit: Vec3 = { x: 47.3, y: 20.7, z: 15 };
    const nearLock = resolveDronePingTarget(
      nearFootHit,
      { x: 47.3, y: 40, z: 15 },
      { x: 0, y: -1, z: 0 },
      critters,
      "me",
    );
    expect(nearLock).toEqual({
      point: { x: 45, y: 20.4, z: 15 },
      lockedCritterId: "sky-rival",
      lockedCritterName: "CliffSquirrel",
    });
  });
});
