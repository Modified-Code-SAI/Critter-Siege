import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  SdfWorld,
  type ApexId,
  type HardpointSlot,
  type MutationId,
  type SpeciesId,
} from "@critter/shared";
import { CritterRig } from "../src/scene/critterMesh.js";
import { TerrainRenderer } from "../src/scene/terrainRenderer.js";
import { VfxSystem } from "../src/scene/vfx.js";

const ALL_SPECIES: readonly SpeciesId[] = [
  "mole",
  "norway_rat",
  "badger",
  "glider_squirrel",
  "hedgehog",
  "armadillo",
];

const ALL_SLOTS: readonly HardpointSlot[] = [
  "back",
  "legs",
  "offense",
  "crest",
];

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      meshes.push(obj);
    }
  });
  return meshes;
}

describe("CritterRig & TerrainRenderer", () => {
  it("instantiates all 6 species cleanly in Node with non-empty smooth meshes and 4 named anchors", () => {
    for (const species of ALL_SPECIES) {
      const rig = new CritterRig(species, "#ff6b35", `Hero-${species}`);

      expect(rig.species).toBe(species);
      expect(rig.root).toBeInstanceOf(THREE.Group);

      const meshes = collectMeshes(rig.root);
      expect(meshes.length).toBeGreaterThan(0);

      // Strictly sculpted rounded shapes — never Minecraft/blocky BoxGeometry
      for (const mesh of meshes) {
        expect(mesh.geometry.type).not.toBe("BoxGeometry");
      }

      for (const slot of ALL_SLOTS) {
        const anchor = rig.anchors[slot];
        expect(anchor).toBeInstanceOf(THREE.Group);
        expect(anchor.name).toContain(slot);
        expect(anchor.children.length).toBe(0);
      }

      rig.setHp(80, 100, true);
      rig.updateAnimation(0.016, true, 0.5, true);
      rig.dispose();
    }
  });

  it("Review Focus #4: swaps occupied hardpoints cleanly 3 times in a row with zero leaked meshes and disposes old geometries", () => {
    const rig = new CritterRig("mole", "#38bdf8", "Driller");

    const setA: Partial<Record<HardpointSlot, MutationId>> = {
      back: "glider_wings",
      legs: "spring_paws",
      offense: "twin_pod",
      crest: "optic_visor",
    };

    const setB: Partial<Record<HardpointSlot, MutationId>> = {
      back: "bramble_shell",
      legs: "anchor_talons",
      offense: "burrow_claws",
      crest: "aegis_crest",
    };

    rig.applyMutations(setA, "sky_bomber");

    const initialDisposedSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    for (const slot of ALL_SLOTS) {
      const anchor = rig.anchors[slot];
      expect(anchor.children.length).toBe(1);
      const slotMeshes = collectMeshes(anchor);
      expect(slotMeshes.length).toBeGreaterThan(0);
      for (const mesh of slotMeshes) {
        expect(mesh.geometry.type).not.toBe("BoxGeometry");
        initialDisposedSpies.push(vi.spyOn(mesh.geometry, "dispose"));
      }
    }

    const swapSequence: ReadonlyArray<{
      equipped: Partial<Record<HardpointSlot, MutationId>>;
      apex: ApexId | null;
    }> = [
      { equipped: setB, apex: "bastion_tank" },
      { equipped: setA, apex: "siege_sniper" },
      { equipped: setB, apex: null },
    ];

    for (const step of swapSequence) {
      const prevGeometries: THREE.BufferGeometry[] = [];
      for (const slot of ALL_SLOTS) {
        for (const mesh of collectMeshes(rig.anchors[slot])) {
          prevGeometries.push(mesh.geometry);
        }
      }
      const stepSpies = prevGeometries.map((geo) => vi.spyOn(geo, "dispose"));

      rig.applyMutations(step.equipped, step.apex);

      for (const spy of stepSpies) {
        expect(spy).toHaveBeenCalledTimes(1);
      }

      for (const slot of ALL_SLOTS) {
        expect(rig.anchors[slot].children.length).toBe(1);
        const slotMeshes = collectMeshes(rig.anchors[slot]);
        expect(slotMeshes.length).toBeGreaterThan(0);
        for (const mesh of slotMeshes) {
          expect(mesh.geometry.type).not.toBe("BoxGeometry");
        }
      }
    }

    // Confirm initial setA geometries were disposed on first overwrite
    for (const spy of initialDisposedSpies) {
      expect(spy).toHaveBeenCalled();
    }

    // Also verify clearing all slots empties every anchor cleanly
    rig.applyMutations({}, null);
    for (const slot of ALL_SLOTS) {
      expect(rig.anchors[slot].children.length).toBe(0);
    }

    rig.dispose();
  });

  it("calibrates hardpoints for GLB custom models, protects cached GLB buffers on dispose, and toggles aiming barrel", () => {
    const rig = new CritterRig("badger", "#22c55e", "RidgeHero");
    expect(rig.isUsingCustomModel()).toBe(false);

    // Aiming indicator only visible when critter is active
    rig.updateAnimation(0.016, false, 0, false, 0.35);
    const aimIndicator = rig.root.getObjectByName("aim_indicator");
    expect(aimIndicator).toBeDefined();
    expect(aimIndicator?.visible).toBe(false);

    rig.updateAnimation(0.016, true, 1.5, true, 0.42);
    expect(aimIndicator?.visible).toBe(true);

    // Attach a cached GLB clone mock
    const glbClone = new THREE.Group();
    glbClone.userData.isCachedGlbClone = true;
    const sharedGeo = new THREE.SphereGeometry(0.6, 12, 10);
    const sharedMat = new THREE.MeshStandardMaterial({ color: 0xcccccc });
    const glbMesh = new THREE.Mesh(sharedGeo, sharedMat);
    glbMesh.castShadow = false;
    glbMesh.receiveShadow = false;
    glbClone.add(glbMesh);

    const sharedDisposeSpy = vi.spyOn(sharedGeo, "dispose");

    rig.attachCustomModel(glbClone);
    expect(rig.isUsingCustomModel()).toBe(true);
    expect(glbMesh.castShadow).toBe(true);
    expect(glbMesh.receiveShadow).toBe(true);
    expect(glbClone.rotation.y).toBe(0);
    // Calibrated for taller 1.48m sculpted badger GLB
    expect(rig.anchors.crest.position.y).toBeGreaterThan(1.0);
    expect(rig.anchors.back.position.z).toBeLessThan(0);

    // Disposing the rig must NOT destroy shared cached GLB template geometry
    rig.dispose();
    expect(sharedDisposeSpy).not.toHaveBeenCalled();

    sharedGeo.dispose();
    sharedMat.dispose();
  });

  it("positions, scales, hides, and disposes the airborne ground contact shadow disc and backflip animation cleanly", () => {
    const rig = new CritterRig("glider_squirrel", "#fb7185", "SkyHopper", false);
    const shadow = rig.root.getObjectByName("drop_shadow");
    expect(shadow).toBeInstanceOf(THREE.Mesh);
    if (!(shadow instanceof THREE.Mesh)) return;
    expect(shadow.geometry.type).not.toBe("BoxGeometry");

    // Grounded at y=10
    rig.root.position.set(20, 10, 20);
    rig.updateDropShadow(10);
    expect(shadow.visible).toBe(true);
    expect(rig.root.position.y + shadow.position.y).toBeCloseTo(10.04, 2);
    const groundedScale = shadow.scale.x;

    // Airborne 4m above ground -> shadow stays glued to groundY=10 and shrinks smoothly
    rig.root.position.set(20, 14, 20);
    rig.updateDropShadow(10);
    expect(shadow.visible).toBe(true);
    expect(rig.root.position.y + shadow.position.y).toBeCloseTo(10.04, 2);
    expect(shadow.scale.x).toBeLessThan(groundedScale);

    // Over open ocean void -> shadow hides cleanly
    rig.updateDropShadow(null);
    expect(shadow.visible).toBe(false);

    // Triggering a classic artillery backflip spins cleanly over ~0.55s without NaN
    rig.triggerBackflip();
    for (let i = 0; i < 10; i++) {
      rig.updateAnimation(0.06, false, 4.0 - i, true, 0.2);
    }

    const shadowDisposeSpy = vi.spyOn(shadow.geometry, "dispose");
    rig.dispose();
    expect(shadowDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it("builds smooth vertex-colored Surface Nets terrain chunks and rebuilds only dirty chunks on carve", () => {
    const world = new SdfWorld(42, "emerald_spire");
    const renderer = new TerrainRenderer(world);

    const initialMeshes = collectMeshes(renderer.group);
    expect(initialMeshes.length).toBeGreaterThan(0);

    const meshByKey = new Map<string, THREE.Mesh>();
    const geometryByKey = new Map<string, THREE.BufferGeometry>();

    for (const mesh of initialMeshes) {
      expect(mesh.geometry.getAttribute("position")).toBeDefined();
      expect(mesh.geometry.getAttribute("normal")).toBeDefined();
      expect(mesh.geometry.getAttribute("color")).toBeDefined();
      expect(mesh.geometry.getAttribute("uv")).toBeDefined();
      expect(mesh.geometry.getAttribute("position").count).toBeGreaterThan(0);
      if (mesh.material instanceof THREE.MeshStandardMaterial) {
        expect(mesh.material.bumpMap).not.toBeNull();
        expect(mesh.material.roughnessMap).not.toBeNull();
      }
      meshByKey.set(mesh.name, mesh);
      geometryByKey.set(mesh.name, mesh.geometry);
    }

    // Carve a crater on a solid peninsula plateau
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    const carveCenter = sp ?? { x: 14.0, y: 11.5, z: 14.5 };
    const dirtyChunks = world.applyCarve({
      center: { x: carveCenter.x, y: carveCenter.y, z: carveCenter.z },
      radius: 3.2,
      shape: "sphere",
    });
    expect(dirtyChunks.length).toBeGreaterThan(0);

    const dirtyNames = new Set(dirtyChunks.map((k) => `chunk_${k}`));
    const dirtyDisposeSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    for (const name of dirtyNames) {
      const oldGeo = geometryByKey.get(name);
      if (oldGeo) {
        dirtyDisposeSpies.push(vi.spyOn(oldGeo, "dispose"));
      }
    }

    expect(() => renderer.rebuildChunks(world, dirtyChunks)).not.toThrow();

    // Dirty chunk geometries must have been disposed
    expect(dirtyDisposeSpies.length).toBeGreaterThan(0);
    for (const spy of dirtyDisposeSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }

    // Non-dirty chunks must keep their exact untouched BufferGeometry references
    let untouchedVerified = 0;
    for (const [name, oldGeo] of geometryByKey.entries()) {
      if (!dirtyNames.has(name)) {
        const currentMesh = meshByKey.get(name);
        expect(currentMesh?.geometry).toBe(oldGeo);
        untouchedVerified += 1;
      }
    }
    expect(untouchedVerified).toBeGreaterThan(0);

    // Full rebuildAll and dispose should work cleanly
    renderer.rebuildAll(world);
    expect(collectMeshes(renderer.group).length).toBeGreaterThan(0);
    renderer.dispose();
    expect(renderer.group.children.length).toBe(0);
  });

  it("spawns non-cube faceted rock shards and cleanly syncs/disposes Evo Pods in VfxSystem", () => {
    const vfx = new VfxSystem();

    vfx.spawnExplosion({ x: 10, y: 6, z: 12 }, 2.2, false);
    vfx.spawnBarrelExplosion({ x: 24, y: 10, z: 26 }, 2.8);
    vfx.spawnGeyserBurst({ x: 18, y: 4, z: 22 });
    vfx.spawnGrappleBeam({ x: 8, y: 6, z: 8 }, { x: 16, y: 12, z: 10 });
    vfx.spawnSplash({ x: 4, y: 2, z: 12 });
    vfx.updateWindRibbons({ x: 2.5, y: 0, z: -1.0 }, 0.05);
    vfx.setProjectileVisual({ x: 11, y: 8, z: 12 }, 0xff9933);
    vfx.setDronePing({ x: 14, y: 6, z: 10 });

    expect(vfx.group.getObjectByName("vfx_pollen_motes")).toBeDefined();

    const meshes = collectMeshes(vfx.group);
    expect(meshes.length).toBeGreaterThan(20);
    const shardTypes = new Set<string>();
    for (const mesh of meshes) {
      expect(mesh.geometry.type).not.toBe("BoxGeometry");
      if (
        mesh.geometry.type === "DodecahedronGeometry" ||
        mesh.geometry.type === "TetrahedronGeometry"
      ) {
        shardTypes.add(mesh.geometry.type);
      }
    }
    expect(shardTypes.size).toBeGreaterThan(0);

    // Sync airborne & landed Evo Pods, then collect and verify disposal
    vfx.syncEvoPods(
      [
        {
          id: "pod-1",
          position: { x: 12, y: 11, z: 12 },
          collected: false,
          spawnedAtTurn: 1,
          parachuting: true,
        },
        {
          id: "pod-2",
          position: { x: 8, y: 7, z: 12 },
          collected: false,
          spawnedAtTurn: 1,
          parachuting: false,
        },
      ],
      1.2,
    );

    const podGroup = vfx.group.getObjectByName("vfx_evo_pods");
    expect(podGroup?.children.length).toBe(2);

    const pod1Obj = podGroup?.getObjectByName("evo_pod_pod-1");
    expect(pod1Obj).toBeDefined();
    const pod1Spies = pod1Obj
      ? collectMeshes(pod1Obj).map((m) => vi.spyOn(m.geometry, "dispose"))
      : [];
    expect(pod1Spies.length).toBeGreaterThan(0);

    // Mark pod-1 collected -> must remove & dispose its meshes cleanly
    vfx.syncEvoPods(
      [
        {
          id: "pod-1",
          position: { x: 12, y: 8, z: 12 },
          collected: true,
          spawnedAtTurn: 1,
          parachuting: false,
        },
        {
          id: "pod-2",
          position: { x: 8, y: 7, z: 12 },
          collected: false,
          spawnedAtTurn: 1,
          parachuting: false,
        },
      ],
      2.0,
    );

    expect(podGroup?.children.length).toBe(1);
    for (const spy of pod1Spies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }

    // Advance past all particle lifetimes to verify automatic particle cleanup
    for (let step = 0; step < 40; step++) {
      vfx.update(0.05, step * 0.05);
    }
    const particleGroup = vfx.group.getObjectByName("vfx_particles");
    expect(particleGroup?.children.length).toBe(0);

    vfx.setProjectileVisual(null);
    vfx.setDronePing(null);
    vfx.dispose();
  });
});
