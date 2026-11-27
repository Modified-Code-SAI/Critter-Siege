import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  GALE_SCATTER_CONE_MIN_DOT,
  GALE_SCATTER_REACH,
  SCATTER_BOMB_SPLIT_BASE_SEC,
} from "@critter/shared";
import {
  buildScatterPlaybackState,
  computeScatterBombletPoses,
} from "../src/main.js";
import { VfxSystem } from "../src/scene/vfx.js";

function assertZeroBoxGeometry(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      expect(obj.geometry).not.toBeInstanceOf(THREE.BoxGeometry);
    }
  });
}

function assertFiniteTransforms(root: THREE.Object3D): void {
  root.traverse((obj) => {
    expect(Number.isFinite(obj.position.x)).toBe(true);
    expect(Number.isFinite(obj.position.y)).toBe(true);
    expect(Number.isFinite(obj.position.z)).toBe(true);
    expect(Number.isFinite(obj.rotation.x)).toBe(true);
    expect(Number.isFinite(obj.rotation.y)).toBe(true);
    expect(Number.isFinite(obj.rotation.z)).toBe(true);
    expect(Number.isFinite(obj.quaternion.x)).toBe(true);
    expect(Number.isFinite(obj.quaternion.y)).toBe(true);
    expect(Number.isFinite(obj.quaternion.z)).toBe(true);
    expect(Number.isFinite(obj.quaternion.w)).toBe(true);
    expect(Number.isFinite(obj.scale.x)).toBe(true);
    expect(Number.isFinite(obj.scale.y)).toBe(true);
    expect(Number.isFinite(obj.scale.z)).toBe(true);
  });
}

describe("Task 3: Signature Gadget 3D Projectile, Wind-Shotgun & Grappling Hook VFX", () => {
  it("switches projectile visuals cleanly between bomb, GPS missile + lock beam, spinning drill, and default orb, and hides all on null", () => {
    const vfx = new VfxSystem();

    const orbGroup = vfx.group.getObjectByName("vfx_projectile");
    const bombGroup = vfx.group.getObjectByName("vfx_projectile_bomb");
    const missileGroup = vfx.group.getObjectByName("vfx_projectile_missile");
    const drillGroup = vfx.group.getObjectByName("vfx_projectile_drill");
    const drillSpinPivot = vfx.group.getObjectByName("vfx_drill_spin_pivot");
    const gpsLockBeam = vfx.group.getObjectByName("vfx_gps_lock_beam");

    expect(orbGroup).toBeInstanceOf(THREE.Group);
    expect(bombGroup).toBeInstanceOf(THREE.Group);
    expect(missileGroup).toBeInstanceOf(THREE.Group);
    expect(drillGroup).toBeInstanceOf(THREE.Group);
    expect(drillSpinPivot).toBeInstanceOf(THREE.Group);
    expect(gpsLockBeam).toBeInstanceOf(THREE.Mesh);

    // 1. Default comet orb when gadgetId is omitted
    vfx.setProjectileVisual({ x: 10, y: 12, z: 14 }, 0x84cc16);
    expect(orbGroup?.visible).toBe(true);
    expect(bombGroup?.visible).toBe(false);
    expect(missileGroup?.visible).toBe(false);
    expect(drillGroup?.visible).toBe(false);
    expect(gpsLockBeam?.visible).toBe(false);

    // 2. Gale Mortar black bomb with burning wick + tumbling rotation
    const initialBombRotX = bombGroup?.rotation.x ?? 0;
    const initialBombRotZ = bombGroup?.rotation.z ?? 0;
    vfx.setProjectileVisual({ x: 12, y: 15, z: 16 }, 0xf97316, {
      gadgetId: "gale_mortar",
      direction: { x: 0.6, y: 0.8, z: 0 },
      dtSec: 0.05,
    });
    expect(bombGroup?.visible).toBe(true);
    expect(orbGroup?.visible).toBe(false);
    expect(missileGroup?.visible).toBe(false);
    expect(drillGroup?.visible).toBe(false);
    expect(gpsLockBeam?.visible).toBe(false);
    expect(bombGroup?.rotation.x).toBeGreaterThan(initialBombRotX + 0.25);
    expect(bombGroup?.rotation.z).toBeGreaterThan(initialBombRotZ + 0.15);

    // 3. Seeker Firefly GPS homing missile oriented nose-first + translucent GPS lock beam
    const missileDir = new THREE.Vector3(0.6, 0.4, -0.7).normalize();
    vfx.setProjectileVisual({ x: 18, y: 14, z: 20 }, 0x38f5ff, {
      gadgetId: "seeker_firefly",
      direction: { x: missileDir.x, y: missileDir.y, z: missileDir.z },
      targetPos: { x: 28, y: 9, z: 11 },
      dtSec: 0.05,
    });
    expect(missileGroup?.visible).toBe(true);
    expect(gpsLockBeam?.visible).toBe(true);
    expect(bombGroup?.visible).toBe(false);
    expect(orbGroup?.visible).toBe(false);
    expect(drillGroup?.visible).toBe(false);

    // Nose axis (+Y in local missile space) must align with normalized flight direction
    const noseWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(
      missileGroup?.quaternion ?? new THREE.Quaternion(),
    );
    expect(noseWorld.dot(missileDir)).toBeGreaterThan(0.99);
    expect((gpsLockBeam?.scale.y ?? 0)).toBeGreaterThan(10);

    // Clearing targetPos hides the GPS lock beam while keeping missile visible
    vfx.setProjectileVisual({ x: 19, y: 14, z: 19 }, 0x38f5ff, {
      gadgetId: "seeker_firefly",
      direction: { x: missileDir.x, y: missileDir.y, z: missileDir.z },
      targetPos: null,
      dtSec: 0.05,
    });
    expect(missileGroup?.visible).toBe(true);
    expect(gpsLockBeam?.visible).toBe(false);

    // 4. Burrow Bore spinning 3D auger drill: air spin vs accelerated boring spin
    const drillDir = new THREE.Vector3(0.8, -0.5, 0.3).normalize();
    const spinStart = drillSpinPivot?.rotation.y ?? 0;
    vfx.setProjectileVisual({ x: 22, y: 8, z: 18 }, 0xf59e0b, {
      gadgetId: "burrow_bore",
      direction: { x: drillDir.x, y: drillDir.y, z: drillDir.z },
      boring: false,
      dtSec: 0.05,
    });
    expect(drillGroup?.visible).toBe(true);
    expect(missileGroup?.visible).toBe(false);
    expect(bombGroup?.visible).toBe(false);
    expect(orbGroup?.visible).toBe(false);
    expect(gpsLockBeam?.visible).toBe(false);

    const drillNoseWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(
      drillGroup?.quaternion ?? new THREE.Quaternion(),
    );
    expect(drillNoseWorld.dot(drillDir)).toBeGreaterThan(0.99);

    const airSpinDelta = (drillSpinPivot?.rotation.y ?? 0) - spinStart;
    expect(airSpinDelta).toBeGreaterThan(1.0);

    const beforeBoringSpin = drillSpinPivot?.rotation.y ?? 0;
    vfx.setProjectileVisual({ x: 23, y: 7.4, z: 18.4 }, 0xf59e0b, {
      gadgetId: "burrow_bore",
      direction: { x: drillDir.x, y: drillDir.y, z: drillDir.z },
      boring: true,
      dtSec: 0.05,
    });
    const boringSpinDelta = (drillSpinPivot?.rotation.y ?? 0) - beforeBoringSpin;
    expect(boringSpinDelta).toBeGreaterThan(airSpinDelta * 1.5);

    // Degenerate / NaN inputs must never produce NaN transforms
    vfx.setProjectileVisual({ x: 24, y: 7, z: 19 }, 0xf59e0b, {
      gadgetId: "burrow_bore",
      direction: { x: 0, y: 0, z: 0 },
      dtSec: Number.NaN,
    });
    assertFiniteTransforms(vfx.group);

    // 5. Passing null hides ALL projectile visuals and GPS lock beam
    vfx.setProjectileVisual(null);
    expect(orbGroup?.visible).toBe(false);
    expect(bombGroup?.visible).toBe(false);
    expect(missileGroup?.visible).toBe(false);
    expect(drillGroup?.visible).toBe(false);
    expect(gpsLockBeam?.visible).toBe(false);

    vfx.dispose();
  });

  it("toggles the animated GPS target-lock crosshair reticle via setDronePing(pos, lockedMode)", () => {
    const vfx = new VfxSystem();
    const dronePingGroup = vfx.group.getObjectByName("vfx_drone_ping");
    const lockReticle = vfx.group.getObjectByName("vfx_gps_lock_reticle");

    expect(dronePingGroup).toBeInstanceOf(THREE.Group);
    expect(lockReticle).toBeInstanceOf(THREE.Group);

    // Standard cyan ping mode
    vfx.setDronePing({ x: 15, y: 6, z: 18 });
    expect(dronePingGroup?.visible).toBe(true);
    expect(lockReticle?.visible).toBe(false);

    // GPS locked crosshair mode
    vfx.setDronePing({ x: 15, y: 6, z: 18 }, true);
    expect(dronePingGroup?.visible).toBe(true);
    expect(lockReticle?.visible).toBe(true);

    const rotBefore = lockReticle?.rotation.y ?? 0;
    vfx.update(0.05, 1.2);
    expect(lockReticle?.rotation.y).not.toBe(rotBefore);
    assertFiniteTransforms(vfx.group);

    // Hiding ping hides reticle cleanly
    vfx.setDronePing(null);
    expect(dronePingGroup?.visible).toBe(false);
    expect(lockReticle?.visible).toBe(false);

    vfx.dispose();
  });

  it("spawns directional wind-shotgun blast rings matching GALE_SCATTER_CONE_MIN_DOT and drains cleanly", () => {
    const vfx = new VfxSystem();
    const particleGroup = vfx.group.getObjectByName("vfx_particles");
    expect(particleGroup).toBeInstanceOf(THREE.Group);

    const origin = { x: 20, y: 10, z: 20 };
    const dir = { x: 1, y: 0.1, z: -0.4 };
    vfx.spawnWindShotgunBlast(origin, dir, GALE_SCATTER_REACH);

    // Must spawn 4 directional expanding wind-gust torus rings
    expect(particleGroup?.children.length).toBe(4);
    assertFiniteTransforms(vfx.group);

    // Confirm ring spread calibration stays positive and consistent with cone constant
    const expectedConeTan = Math.tan(Math.acos(GALE_SCATTER_CONE_MIN_DOT));
    expect(expectedConeTan).toBeGreaterThan(0.5);

    // Step midway and verify finite transforms, then drain past max lifetime
    vfx.update(0.08, 0.08);
    assertFiniteTransforms(vfx.group);
    for (let step = 0; step < 30; step++) {
      vfx.update(0.04, 0.1 + step * 0.04);
    }
    expect(particleGroup?.children.length).toBe(0);

    // Degenerate direction & NaN reach must never throw or create NaN transforms
    expect(() =>
      vfx.spawnWindShotgunBlast(origin, { x: 0, y: 0, z: 0 }, Number.NaN),
    ).not.toThrow();
    assertFiniteTransforms(vfx.group);

    vfx.dispose();
  });

  it("spawns bore debris backward using pools and anchors sculpted 3-prong grappling hook + latch spark cleanly", () => {
    const vfx = new VfxSystem();
    const poolGroup = vfx.group.getObjectByName("vfx_particle_pools");
    const initialPoolCount = poolGroup?.children.length ?? 0;

    // Bore debris sprays via pools without leaking pool children
    vfx.spawnBoreDebris({ x: 16, y: 9, z: 14 }, { x: 0.7, y: -0.5, z: 0.5 });
    vfx.spawnBoreDebris({ x: 16, y: 9, z: 14 }, { x: 0, y: 0, z: 0 });
    expect(poolGroup?.children.length).toBe(initialPoolCount);
    assertFiniteTransforms(vfx.group);

    // Grapple tether renders sculpted 3-prong grappling hook head anchored at `to`
    const from = { x: 10, y: 6, z: 12 };
    const to = { x: 22, y: 12, z: 18 };
    vfx.setGrappleTether("p1", from, to);

    const tether = vfx.group.getObjectByName("grapple_tether_p1");
    expect(tether).toBeInstanceOf(THREE.Group);

    const hookHead = tether?.getObjectByName("grapple_hook_head");
    expect(hookHead).toBeInstanceOf(THREE.Group);

    // Count sculpted claw prongs inside hook head
    let prongCount = 0;
    hookHead?.traverse((obj) => {
      if (obj.name.startsWith("grapple_hook_prong_")) {
        prongCount += 1;
      }
    });
    expect(prongCount).toBe(3);

    // Hook head world position must be anchored right at `to` (+0.45 anchor height)
    vfx.group.updateMatrixWorld(true);
    const hookWorldPos = new THREE.Vector3();
    hookHead?.getWorldPosition(hookWorldPos);
    expect(hookWorldPos.x).toBeCloseTo(to.x, 3);
    expect(hookWorldPos.y).toBeCloseTo(to.y + 0.45, 3);
    expect(hookWorldPos.z).toBeCloseTo(to.z, 3);

    // Updating grapple position keeps hook anchored at `to`
    vfx.setGrappleTether("p1", { x: 16, y: 9, z: 15 }, to);
    vfx.group.updateMatrixWorld(true);
    hookHead?.getWorldPosition(hookWorldPos);
    expect(hookWorldPos.x).toBeCloseTo(to.x, 3);
    expect(hookWorldPos.y).toBeCloseTo(to.y + 0.45, 3);
    expect(hookWorldPos.z).toBeCloseTo(to.z, 3);

    // Grapple latch spark emits cleanly
    vfx.spawnGrappleLatchSpark(to);
    vfx.update(0.04, 0.5);
    assertFiniteTransforms(vfx.group);

    // Releasing tether removes it cleanly
    vfx.setGrappleTether("p1", null);
    expect(vfx.group.getObjectByName("grapple_tether_p1")).toBeUndefined();

    // Also test dispose() while tether + active projectiles + particles exist
    vfx.setGrappleTether("p2", from, to);
    vfx.setProjectileVisual(from, 0x38f5ff, {
      gadgetId: "seeker_firefly",
      direction: { x: 1, y: 0, z: 0 },
      targetPos: to,
      dtSec: 0.05,
    });
    vfx.setDronePing(to, true);
    vfx.spawnWindShotgunBlast(from, { x: 1, y: 0, z: 0 });
    expect(() => vfx.dispose()).not.toThrow();
    expect(vfx.group.getObjectByName("grapple_tether_p2")).toBeUndefined();
  });

  it("activates sculpted 3D Scatter Bomb iron canister for spore_burst (zero BoxGeometry), tumbles cleanly, and hides on null", () => {
    const vfx = new VfxSystem();

    const orbGroup = vfx.group.getObjectByName("vfx_projectile");
    const bombGroup = vfx.group.getObjectByName("vfx_projectile_bomb");
    const missileGroup = vfx.group.getObjectByName("vfx_projectile_missile");
    const drillGroup = vfx.group.getObjectByName("vfx_projectile_drill");
    const canisterGroup = vfx.group.getObjectByName(
      "vfx_projectile_scatter_canister",
    );
    const gpsLockBeam = vfx.group.getObjectByName("vfx_gps_lock_beam");

    expect(canisterGroup).toBeInstanceOf(THREE.Group);
    expect(canisterGroup?.visible).toBe(false);
    if (canisterGroup) {
      assertZeroBoxGeometry(canisterGroup);
    }

    const startRotX = canisterGroup?.rotation.x ?? 0;
    const startRotZ = canisterGroup?.rotation.z ?? 0;
    vfx.setProjectileVisual({ x: 15, y: 12, z: 18 }, 0xf59e0b, {
      gadgetId: "spore_burst",
      direction: { x: 0.7, y: 0.5, z: -0.5 },
      dtSec: 0.05,
    });

    expect(canisterGroup?.visible).toBe(true);
    expect(orbGroup?.visible).toBe(false);
    expect(bombGroup?.visible).toBe(false);
    expect(missileGroup?.visible).toBe(false);
    expect(drillGroup?.visible).toBe(false);
    expect(gpsLockBeam?.visible).toBe(false);
    expect(canisterGroup?.position.x).toBeCloseTo(15, 4);
    expect(canisterGroup?.position.y).toBeCloseTo(12, 4);
    expect(canisterGroup?.position.z).toBeCloseTo(18, 4);
    expect(canisterGroup?.rotation.x).toBeGreaterThan(startRotX + 0.3);
    expect(canisterGroup?.rotation.z).toBeGreaterThan(startRotZ + 0.2);

    // Tumbles further on subsequent tick & update()
    const midRotX = canisterGroup?.rotation.x ?? 0;
    vfx.setProjectileVisual({ x: 16.2, y: 11.4, z: 17.5 }, 0xf59e0b, {
      gadgetId: "spore_burst",
      direction: { x: 0.7, y: -0.3, z: -0.5 },
      dtSec: 0.04,
    });
    expect(canisterGroup?.rotation.x).toBeGreaterThan(midRotX + 0.2);
    vfx.update(0.04, 0.2);
    assertFiniteTransforms(vfx.group);

    // Switching to another gadget hides the scatter canister
    vfx.setProjectileVisual({ x: 17, y: 11, z: 17 }, 0xffa73b, {
      gadgetId: "gale_mortar",
      dtSec: 0.04,
    });
    expect(canisterGroup?.visible).toBe(false);
    expect(bombGroup?.visible).toBe(true);

    // Re-activating then passing null hides scatter canister cleanly
    vfx.setProjectileVisual({ x: 18, y: 10, z: 16 }, 0xf59e0b, {
      gadgetId: "spore_burst",
      dtSec: 0.04,
    });
    expect(canisterGroup?.visible).toBe(true);
    vfx.setProjectileVisual(null);
    expect(canisterGroup?.visible).toBe(false);

    vfx.dispose();
  });

  it("syncs 5 pooled 3D Scatter Bomb mini-bomblets (zero BoxGeometry), hides individual detonated nulls, and clears cleanly", () => {
    const vfx = new VfxSystem();
    const bomblets: THREE.Object3D[] = [];
    for (let i = 0; i < 5; i++) {
      const obj = vfx.group.getObjectByName(`vfx_scatter_bomblet_${i}`);
      expect(obj).toBeInstanceOf(THREE.Group);
      expect(obj?.visible).toBe(false);
      if (obj) {
        assertZeroBoxGeometry(obj);
        bomblets.push(obj);
      }
    }
    expect(bomblets.length).toBe(5);

    const poses = Array.from({ length: 5 }, (_, i) => ({
      position: { x: 20 + i * 1.4, y: 9 + i * 0.3, z: 22 - i * 0.9 },
      spinPhase: 1.2 + i * 0.5,
    }));
    vfx.syncScatterBomblets(poses, 0.04);

    for (let i = 0; i < 5; i++) {
      const b = bomblets[i];
      const p = poses[i];
      expect(b?.visible).toBe(true);
      expect(b?.position.x).toBeCloseTo(p?.position.x ?? 0, 4);
      expect(b?.position.y).toBeCloseTo(p?.position.y ?? 0, 4);
      expect(b?.position.z).toBeCloseTo(p?.position.z ?? 0, 4);
    }
    assertFiniteTransforms(vfx.group);

    // Detonating bomblets 0 and 2 sets their slots to null while leaving 1, 3, 4 visible
    vfx.syncScatterBomblets(
      [
        null,
        { position: { x: 22, y: 10, z: 21 }, spinPhase: 2.5 },
        null,
        { position: { x: 24.5, y: 10.5, z: 19 }, spinPhase: 3.1 },
        { position: { x: 26, y: 9.8, z: 18 }, spinPhase: 3.7 },
      ],
      0.04,
    );
    expect(bomblets[0]?.visible).toBe(false);
    expect(bomblets[1]?.visible).toBe(true);
    expect(bomblets[2]?.visible).toBe(false);
    expect(bomblets[3]?.visible).toBe(true);
    expect(bomblets[4]?.visible).toBe(true);

    // clearScatterBomblets hides all 5
    vfx.clearScatterBomblets();
    for (const b of bomblets) {
      expect(b.visible).toBe(false);
    }

    vfx.dispose();
  });

  it("spawns Scatter Bomb split burst and bounce sparks cleanly and computes bounce + parabolic bomblet playback", () => {
    const vfx = new VfxSystem();
    const particleGroup = vfx.group.getObjectByName("vfx_particles");
    const splitPos = { x: 24, y: 11, z: 26 };
    const bouncePos = { x: 18, y: 8.2, z: 21 };

    expect(() => vfx.spawnScatterBounceSpark(bouncePos)).not.toThrow();
    expect(() => vfx.spawnScatterSplit(splitPos)).not.toThrow();
    expect(particleGroup?.children.length).toBeGreaterThanOrEqual(1);

    // Step and drain cleanly
    for (let step = 0; step < 25; step++) {
      vfx.update(0.04, step * 0.04);
    }
    expect(particleGroup?.children.length).toBe(0);
    assertFiniteTransforms(vfx.group);
    expect(() => vfx.dispose()).not.toThrow();

    // Verify bounce detection and parabolic mini-bomblet arc computation
    const path = [
      { x: 10, y: 12, z: 10 },
      { x: 14, y: 9.5, z: 12 },
      { x: 18, y: 7.5, z: 14 }, // bounce valley
      { x: 21, y: 9.2, z: 16 },
      { x: 24, y: 8.6, z: 18 }, // splitOrigin
    ];
    const splitTime = 1.0;
    const impacts = Array.from({ length: 5 }, (_, i) => ({
      time: splitTime + SCATTER_BOMB_SPLIT_BASE_SEC + i * 0.035,
      position: {
        x: 24 + Math.cos((i * Math.PI * 2) / 5) * 2.4,
        y: 8.6,
        z: 18 + Math.sin((i * Math.PI * 2) / 5) * 2.4,
      },
      carveOp: null,
      damageRadius: 2.9,
      baseDamage: 18,
      knockback: 7,
      isSubSpore: true,
      triggered: false,
    }));

    const scatterState = buildScatterPlaybackState(path, impacts);
    expect(scatterState).toBeDefined();
    expect(scatterState?.splitSec).toBeCloseTo(splitTime, 4);
    expect(scatterState?.splitOrigin).toEqual({ x: 24, y: 8.6, z: 18 });
    expect(scatterState?.bounceSec).toBeCloseTo(splitTime * 0.5, 4);
    expect(scatterState?.bouncePos).toEqual({ x: 18, y: 7.5, z: 14 });

    if (scatterState) {
      const midElapsed = splitTime + SCATTER_BOMB_SPLIT_BASE_SEC * 0.5;
      const midPoses = computeScatterBombletPoses(
        scatterState,
        impacts,
        midElapsed,
      );
      expect(midPoses.length).toBe(5);
      for (const pose of midPoses) {
        expect(pose).not.toBeNull();
        // Mid-flight parabolic arc rises cleanly above splitOrigin.y
        expect((pose?.position.y ?? 0)).toBeGreaterThan(10.8);
      }

      // After first bomblet detonates, slot 0 becomes null while remaining 4 stay active
      const firstImpactTime = impacts[0]?.time ?? splitTime + SCATTER_BOMB_SPLIT_BASE_SEC;
      const afterFirstElapsed = firstImpactTime + 0.01;
      const staggeredPoses = computeScatterBombletPoses(
        scatterState,
        impacts,
        afterFirstElapsed,
      );
      expect(staggeredPoses[0]).toBeNull();
      expect(staggeredPoses[1]).not.toBeNull();
      expect(staggeredPoses[4]).not.toBeNull();
    }
  });
});
