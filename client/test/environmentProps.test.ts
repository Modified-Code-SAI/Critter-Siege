import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { SdfWorld, type HazardState } from "@critter/shared";
import {
  EnvironmentProps,
  attachLandmarkGlb,
  shouldHidePropForAim,
  type AimOcclusionQuery,
} from "../src/scene/environmentProps.js";
import {
  computeWorldSceneMetrics,
  createOceanShaderMaterial,
} from "../src/scene/worldScene.js";

function collectAllMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      meshes.push(obj);
    }
  });
  return meshes;
}

describe("EnvironmentProps lush scenery & interactive hazard visuals", () => {
  it("scatters instanced trees, shrubs/wildflowers, mossy boulders, and stone ruins with strictly zero BoxGeometry", () => {
    const world = new SdfWorld(4242, "emerald_spire");
    const spawns = world.findSpawnPoints(4);
    const props = new EnvironmentProps(world, 1.5, spawns);

    const counts = props.getPropCounts();
    expect(counts.trees).toBeGreaterThanOrEqual(20);
    expect(counts.flora).toBeGreaterThanOrEqual(60);
    expect(counts.boulders).toBeGreaterThanOrEqual(20);
    expect(counts.landmarks).toBeGreaterThanOrEqual(5);

    const meshes = collectAllMeshes(props.group);
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      expect(mesh.geometry.type).not.toBe("BoxGeometry");
    }

    // Verify all placed prop anchors respect spawn clearance
    const anchors = props.getVisiblePropPositions();
    expect(anchors.length).toBeGreaterThan(100);
    for (const pos of anchors) {
      expect(pos.y).toBeGreaterThan(1.5);
      for (const sp of spawns) {
        const dist = Math.hypot(pos.x - sp.x, pos.y - sp.y, pos.z - sp.z);
        expect(dist).toBeGreaterThanOrEqual(2.5);
      }
    }

    props.dispose();
  });

  it("syncs all 4 interactive hazard types including spark_mine, animates them, and disposes detonated hazards cleanly", () => {
    const world = new SdfWorld(7331, "canyon_arch");
    const spawns = world.findSpawnPoints(4);
    const placements = world.findHazardPoints(spawns);
    const hazards: HazardState[] = placements.map((p, idx) => ({
      id: `haz-${idx}`,
      type: p.type,
      position: { ...p.position },
      radius: p.radius,
      active: true,
    }));

    const hazardTypes = new Set(hazards.map((h) => h.type));
    expect(hazardTypes.has("blast_barrel")).toBe(true);
    expect(hazardTypes.has("spark_mine")).toBe(true);
    expect(hazardTypes.has("steam_geyser")).toBe(true);
    expect(hazardTypes.has("thorn_patch")).toBe(true);

    const props = new EnvironmentProps(world, 1.5, spawns);
    props.syncHazards(hazards, 0.5);

    const hazardGroup = props.group.getObjectByName("interactive_hazards");
    expect(hazardGroup).toBeDefined();
    expect(hazardGroup?.children.length).toBe(hazards.length);

    // Strictly sculpted non-cube hazard visuals
    const hazardMeshes = hazardGroup ? collectAllMeshes(hazardGroup) : [];
    expect(hazardMeshes.length).toBeGreaterThan(0);
    for (const m of hazardMeshes) {
      expect(m.geometry.type).not.toBe("BoxGeometry");
    }

    // Animate across elapsed time without throwing
    props.syncHazards(hazards, 2.25);

    // Detonate the first Blast Barrel and first Spark Mine -> must remove and dispose their geometries & materials
    const barrel = hazards.find((h) => h.type === "blast_barrel");
    const mine = hazards.find((h) => h.type === "spark_mine");
    const thorn = hazards.find((h) => h.type === "thorn_patch");
    expect(barrel).toBeDefined();
    expect(mine).toBeDefined();
    expect(thorn).toBeDefined();
    if (!barrel || !mine || !thorn) return;

    const barrelObj = hazardGroup?.getObjectByName(`hazard_${barrel.id}`);
    const mineObj = hazardGroup?.getObjectByName(`hazard_${mine.id}`);
    const thornObj = hazardGroup?.getObjectByName(`hazard_${thorn.id}`);
    expect(barrelObj).toBeDefined();
    expect(mineObj).toBeDefined();
    expect(thornObj).toBeDefined();

    // Verify Spark Mine has dark metallic dome, pulsing crimson LED beacon, shared pulsing prongs, and glowing sensor ring
    const mineBeacon = mineObj?.getObjectByName("spark_mine_beacon");
    const mineRing = mineObj?.getObjectByName("spark_mine_ring");
    expect(mineBeacon).toBeInstanceOf(THREE.Mesh);
    expect(mineRing).toBeInstanceOf(THREE.Mesh);
    if (mineBeacon instanceof THREE.Mesh && mineBeacon.material instanceof THREE.MeshStandardMaterial) {
      expect(mineBeacon.material.emissive.r).toBeGreaterThan(0.7);
      expect(mineBeacon.material.emissive.r).toBeGreaterThan(mineBeacon.material.emissive.b * 2);
    }

    const collectUniqueMaterials = (root: THREE.Object3D): THREE.Material[] => {
      const mats = new Set<THREE.Material>();
      for (const m of collectAllMeshes(root)) {
        if (Array.isArray(m.material)) {
          for (const item of m.material) mats.add(item);
        } else {
          mats.add(m.material);
        }
      }
      return Array.from(mats);
    };

    // All 6 spark_mine cone prongs must share a single pulsing material (zero orphaned clone)
    const mineProngMats = new Set(
      (mineObj ? collectAllMeshes(mineObj) : [])
        .filter((m) => m.geometry.type === "ConeGeometry")
        .map((m) => m.material),
    );
    expect(mineProngMats.size).toBe(1);

    // All 10 thorn_patch cone thorns must share a single material (zero orphaned clone)
    const thornConeMats = new Set(
      (thornObj ? collectAllMeshes(thornObj) : [])
        .filter((m) => m.geometry.type === "ConeGeometry")
        .map((m) => m.material),
    );
    expect(thornConeMats.size).toBe(1);

    const disposeSpies = [
      ...(barrelObj ? collectAllMeshes(barrelObj) : []),
      ...(mineObj ? collectAllMeshes(mineObj) : []),
    ].map((m) => vi.spyOn(m.geometry, "dispose"));
    const mineMatDisposeSpies = (mineObj ? collectUniqueMaterials(mineObj) : []).map((mat) =>
      vi.spyOn(mat, "dispose"),
    );
    const thornMatDisposeSpies = (thornObj ? collectUniqueMaterials(thornObj) : []).map((mat) =>
      vi.spyOn(mat, "dispose"),
    );
    expect(disposeSpies.length).toBeGreaterThan(2);
    expect(mineMatDisposeSpies.length).toBeGreaterThan(2);
    expect(thornMatDisposeSpies.length).toBeGreaterThan(1);

    const updatedHazards = hazards.map((h) =>
      h.id === barrel.id || h.id === mine.id ? { ...h, active: false } : h,
    );
    props.syncHazards(updatedHazards, 3.0);

    expect(hazardGroup?.children.length).toBe(hazards.length - 2);
    for (const spy of disposeSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    for (const spy of mineMatDisposeSpies) {
      expect(spy).toHaveBeenCalled();
    }

    props.dispose();
    for (const spy of thornMatDisposeSpies) {
      expect(spy).toHaveBeenCalled();
    }
  });

  it("scales instanced scenery cleanly across 144m grand worlds with lush density and zero BoxGeometry", () => {
    const grandWorld = new SdfWorld(8842, "emerald_spire", "grand");
    const spawns = grandWorld.findSpawnPoints(4);
    const props = new EnvironmentProps(grandWorld, 1.5, spawns);

    const counts = props.getPropCounts();
    expect(counts.trees).toBeGreaterThanOrEqual(70);
    expect(counts.flora).toBeGreaterThanOrEqual(190);
    expect(counts.boulders).toBeGreaterThanOrEqual(75);
    expect(counts.landmarks).toBeGreaterThanOrEqual(17);

    const positions = props.getVisiblePropPositions();
    const maxX = Math.max(...positions.map((p) => p.x));
    const maxZ = Math.max(...positions.map((p) => p.z));
    // Must spread well past the 60m duel boundary onto the 144m grand island
    expect(maxX).toBeGreaterThan(95);
    expect(maxZ).toBeGreaterThan(95);

    for (const mesh of collectAllMeshes(props.group)) {
      expect(mesh.geometry.type).not.toBe("BoxGeometry");
    }

    props.dispose();
  });

  it("prunes scenery props whose supporting terrain was carved away so nothing floats in mid-air", () => {
    const world = new SdfWorld(9001, "twin_pillars");
    const spawns = world.findSpawnPoints(4);
    const props = new EnvironmentProps(world, 1.5, spawns);

    const beforePositions = props.getVisiblePropPositions();
    expect(beforePositions.length).toBeGreaterThan(50);

    // Blast a 4.5m crater right under the first placed prop
    const victim = beforePositions[0];
    expect(victim).toBeDefined();
    if (!victim) return;

    world.applyCarve({
      shape: "sphere",
      center: { x: victim.x, y: victim.y - 0.5, z: victim.z },
      radius: 4.5,
    });

    const prunedCount = props.pruneAfterCarve(world, 1.5);
    expect(prunedCount).toBeGreaterThanOrEqual(1);
    expect(props.getVisiblePropPositions().length).toBe(
      beforePositions.length - prunedCount,
    );

    // Calling pruneAfterCarve again with no new carves prunes 0
    expect(props.pruneAfterCarve(world, 1.5)).toBe(0);

    props.dispose();
  });

  it("scales WorldScene metrics dynamically for 60m Duel and 144m Grand maps and builds ocean shader", () => {
    const duel = computeWorldSceneMetrics(60);
    expect(duel.oceanSpan).toBe(420);
    expect(duel.shadowHalf).toBeCloseTo(60 * 0.62, 3);
    expect(duel.fogDensity).toBeCloseTo(0.0038, 5);
    expect(duel.isletMinDist).toBeCloseTo(60 * 1.15, 2);
    expect(duel.isletMaxDist).toBeCloseTo(60 * 1.6, 2);

    const grand = computeWorldSceneMetrics(144);
    expect(grand.oceanSpan).toBeCloseTo(144 * 4.5, 2);
    expect(grand.shadowHalf).toBeCloseTo(144 * 0.62, 3);
    expect(grand.fogDensity).toBeCloseTo(0.0022, 5);
    expect(grand.isletMinDist).toBeCloseTo(144 * 1.15, 2);
    expect(grand.isletMaxDist).toBeCloseTo(144 * 1.6, 2);
    expect(grand.cloudRadius).toBeGreaterThan(duel.cloudRadius * 1.8);

    const mat = createOceanShaderMaterial(new THREE.Vector3(0.6, 0.7, 0.4));
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    expect(mat.uniforms.uTime).toBeDefined();
    expect(mat.uniforms.uSunDir).toBeDefined();
    expect(mat.uniforms.uShallowColor).toBeDefined();
    expect(mat.uniforms.uDeepColor).toBeDefined();
    expect(mat.uniforms.uFoamColor).toBeDefined();
    expect(mat.vertexShader).toContain("uTime");
    expect(mat.fragmentShader).toContain("uFoamColor");
    mat.dispose();
  });

  it("places watchtower, ruin_arch, and gnarled_pine landmarks on mountain_spine, swaps procedural fallbacks for cached GLB clones, and prunes cleanly on carve", () => {
    const world = new SdfWorld(4242, "mountain_spine");
    const spawns = world.findSpawnPoints(4);
    const props = new EnvironmentProps(world, 1.5, spawns);

    const watchtowerGroup = props.group.getObjectByName("watchtower_0");
    const archGroup = props.group.getObjectByName("ruin_arch_1");
    const pineGroup = props.group.getObjectByName("gnarled_pine_2");
    expect(watchtowerGroup).toBeInstanceOf(THREE.Group);
    expect(archGroup).toBeInstanceOf(THREE.Group);
    expect(pineGroup).toBeInstanceOf(THREE.Group);

    // Strictly zero BoxGeometry in procedural fallbacks
    for (const mesh of collectAllMeshes(props.group)) {
      expect(mesh.geometry.type).not.toBe("BoxGeometry");
    }

    if (watchtowerGroup instanceof THREE.Group) {
      const fallbackSpies = collectAllMeshes(watchtowerGroup).map((m) =>
        vi.spyOn(m.geometry, "dispose"),
      );
      expect(fallbackSpies.length).toBeGreaterThan(0);

      // Attach a cached GLB clone -> disposes procedural fallback, protects cached template on prune/dispose
      const cachedTemplateGeo = new THREE.CylinderGeometry(0.5, 0.6, 3.0, 8);
      const cachedTemplateMat = new THREE.MeshStandardMaterial({ color: 0x8b6b4d });
      const templateGeoSpy = vi.spyOn(cachedTemplateGeo, "dispose");
      const templateMatSpy = vi.spyOn(cachedTemplateMat, "dispose");

      const glbClone = new THREE.Group();
      glbClone.name = "glb_prop_watchtower";
      glbClone.userData.isCachedGlbClone = true;
      glbClone.add(new THREE.Mesh(cachedTemplateGeo, cachedTemplateMat));

      attachLandmarkGlb(watchtowerGroup, glbClone);
      for (const spy of fallbackSpies) {
        expect(spy).toHaveBeenCalledTimes(1);
      }
      expect(watchtowerGroup.getObjectByName("glb_prop_watchtower")).toBe(glbClone);

      // Carve right under the watchtower -> pruned cleanly & detached without corrupting cached template
      world.applyCarve({
        shape: "sphere",
        center: {
          x: watchtowerGroup.position.x,
          y: watchtowerGroup.position.y - 0.5,
          z: watchtowerGroup.position.z,
        },
        radius: 4.0,
      });
      const pruned = props.pruneAfterCarve(world, 1.5);
      expect(pruned).toBeGreaterThanOrEqual(1);
      expect(watchtowerGroup.visible).toBe(false);
      expect(watchtowerGroup.parent).toBeNull();
      expect(templateGeoSpy).not.toHaveBeenCalled();
      expect(templateMatSpy).not.toHaveBeenCalled();

      props.dispose();
      expect(templateGeoSpy).not.toHaveBeenCalled();
      expect(templateMatSpy).not.toHaveBeenCalled();

      cachedTemplateGeo.dispose();
      cachedTemplateMat.dispose();
    } else {
      props.dispose();
    }
  });
});

describe("Dynamic Aim Sightline Prop Clearing", () => {
  const baseQuery: AimOcclusionQuery = {
    cameraPos: { x: 0, y: 7, z: -6 },
    critterPos: { x: 0, y: 5, z: 0 },
    aimDir: { x: 0, y: 0, z: 1 },
    maxRange: 22,
  };

  it("hides tree, landmark, and boulder between camera and critter, in shoulder halo, and along forward 22m aim corridor", () => {
    // 1. Camera-to-critter segment (between z = -6 and z = 0)
    expect(shouldHidePropForAim({ x: 0, y: 4.5, z: -3 }, "tree", baseQuery)).toBe(true);
    expect(shouldHidePropForAim({ x: 0.5, y: 4.5, z: -3.5 }, "landmark", baseQuery)).toBe(true);
    expect(shouldHidePropForAim({ x: 0, y: 5.5, z: -3 }, "boulder", baseQuery)).toBe(true);

    // 2. Immediate shoulder halo (off to side of critter within radius + 2.0)
    expect(shouldHidePropForAim({ x: 4.8, y: 5.0, z: 0.0 }, "tree", baseQuery)).toBe(true);
    expect(shouldHidePropForAim({ x: -5.4, y: 5.0, z: 0.2 }, "landmark", baseQuery)).toBe(true);
    expect(shouldHidePropForAim({ x: 3.8, y: 5.0, z: -0.2 }, "boulder", baseQuery)).toBe(true);

    // 3. Forward 22m aim corridor
    expect(shouldHidePropForAim({ x: 1.5, y: 4.0, z: 14 }, "tree", baseQuery)).toBe(true);
    expect(shouldHidePropForAim({ x: -2.0, y: 4.0, z: 18 }, "landmark", baseQuery)).toBe(true);
    expect(shouldHidePropForAim({ x: 0.5, y: 5.2, z: 12 }, "boulder", baseQuery)).toBe(true);

    // Just beyond 22m maxRange -> not hidden
    expect(shouldHidePropForAim({ x: 0, y: 5.0, z: 24.5 }, "tree", baseQuery)).toBe(false);
  });

  it("returns false for props behind or far off to the side of the aim corridor", () => {
    // Far behind the camera
    expect(shouldHidePropForAim({ x: 0, y: 5, z: -15 }, "tree", baseQuery)).toBe(false);
    expect(shouldHidePropForAim({ x: 0, y: 5, z: -15 }, "landmark", baseQuery)).toBe(false);
    expect(shouldHidePropForAim({ x: 0, y: 5, z: -15 }, "boulder", baseQuery)).toBe(false);

    // Far off to the side
    expect(shouldHidePropForAim({ x: 16, y: 5, z: 10 }, "tree", baseQuery)).toBe(false);
    expect(shouldHidePropForAim({ x: -18, y: 5, z: 10 }, "landmark", baseQuery)).toBe(false);
    expect(shouldHidePropForAim({ x: 12, y: 5, z: 10 }, "boulder", baseQuery)).toBe(false);

    // Outside vertical shoulder halo band
    expect(shouldHidePropForAim({ x: 4.5, y: 12.0, z: 0 }, "tree", baseQuery)).toBe(false);
    expect(shouldHidePropForAim({ x: 3.5, y: 0.5, z: 0 }, "boulder", baseQuery)).toBe(false);
  });

  it("always returns false for flora even right next to the critter or between camera and critter", () => {
    expect(shouldHidePropForAim({ x: 0, y: 5, z: 0 }, "flora", baseQuery)).toBe(false);
    expect(shouldHidePropForAim({ x: 0, y: 5, z: -3 }, "flora", baseQuery)).toBe(false);
    expect(shouldHidePropForAim({ x: 0, y: 5, z: 8 }, "flora", baseQuery)).toBe(false);
  });

  it("handles non-finite coordinates and near-zero aimDir safely without throwing", () => {
    expect(shouldHidePropForAim({ x: Number.NaN, y: 5, z: 5 }, "tree", baseQuery)).toBe(false);
    expect(
      shouldHidePropForAim({ x: 0, y: 5, z: 5 }, "tree", {
        ...baseQuery,
        cameraPos: { x: Number.POSITIVE_INFINITY, y: 7, z: -6 },
      }),
    ).toBe(false);
    expect(
      shouldHidePropForAim({ x: 0, y: 5, z: 5 }, "tree", {
        ...baseQuery,
        critterPos: { x: 0, y: Number.NEGATIVE_INFINITY, z: 0 },
      }),
    ).toBe(false);
    expect(
      shouldHidePropForAim({ x: 0, y: 5, z: 5 }, "tree", {
        ...baseQuery,
        aimDir: { x: 0, y: Number.NaN, z: 1 },
      }),
    ).toBe(false);

    // Near-zero aimDir skips forward corridor, but still evaluates camera segment & shoulder halo
    const zeroAimQuery: AimOcclusionQuery = {
      cameraPos: { x: 0, y: 7, z: -6 },
      critterPos: { x: 0, y: 5, z: 0 },
      aimDir: { x: 0, y: 0, z: 0 },
    };
    expect(shouldHidePropForAim({ x: 0, y: 4.5, z: -3 }, "tree", zeroAimQuery)).toBe(true);
    expect(shouldHidePropForAim({ x: 0, y: 5.0, z: 12 }, "tree", zeroAimQuery)).toBe(false);
  });

  it("temporarily hides trees, boulders, and landmarks along aim sightline without changing getPropCounts, restores exact matrices on null/turn-away, and never revives carved props", () => {
    const world = new SdfWorld(4242, "mountain_spine");
    const spawns = world.findSpawnPoints(4);
    const props = new EnvironmentProps(world, 1.5, spawns);

    const initialCounts = props.getPropCounts();
    const initialVisiblePositions = props.getVisiblePropPositions();

    const sceneryGroup = props.group.getObjectByName("scenery_props");
    expect(sceneryGroup).toBeInstanceOf(THREE.Group);

    const watchtower = props.group.getObjectByName("watchtower_0");
    expect(watchtower).toBeInstanceOf(THREE.Group);
    if (!(watchtower instanceof THREE.Group)) {
      props.dispose();
      return;
    }

    // Snapshot all non-zero instanced matrices before any aim occlusion
    const instancedMeshes: THREE.InstancedMesh[] = [];
    if (sceneryGroup) {
      for (const child of sceneryGroup.children) {
        if (child instanceof THREE.InstancedMesh) {
          instancedMeshes.push(child);
        }
      }
    }
    expect(instancedMeshes.length).toBeGreaterThan(0);

    const isZeroMatrix = (m: THREE.Matrix4): boolean => {
      const e = m.elements;
      return (
        Math.hypot(e[0], e[1], e[2]) < 1e-6 &&
        Math.hypot(e[4], e[5], e[6]) < 1e-6 &&
        Math.hypot(e[8], e[9], e[10]) < 1e-6
      );
    };

    const snapshotMatrices = (): Map<THREE.InstancedMesh, Float32Array> => {
      const map = new Map<THREE.InstancedMesh, Float32Array>();
      for (const mesh of instancedMeshes) {
        map.set(mesh, new Float32Array(mesh.instanceMatrix.array as Float32Array));
      }
      return map;
    };

    const originalSnapshots = snapshotMatrices();

    // Aim directly through the watchtower from 6m behind it along +Z
    const aimAtWatchtower: AimOcclusionQuery = {
      cameraPos: {
        x: watchtower.position.x,
        y: watchtower.position.y + 2.0,
        z: watchtower.position.z - 10.0,
      },
      critterPos: {
        x: watchtower.position.x,
        y: watchtower.position.y,
        z: watchtower.position.z - 5.0,
      },
      aimDir: { x: 0, y: 0, z: 1 },
      maxRange: 22,
    };

    const hiddenCount = props.updateAimOcclusion(aimAtWatchtower);
    expect(hiddenCount).toBeGreaterThanOrEqual(1);
    expect(watchtower.visible).toBe(false);
    // Counts and visible anchor positions must remain strictly unchanged
    expect(props.getPropCounts()).toEqual(initialCounts);
    expect(props.getVisiblePropPositions().length).toBe(initialVisiblePositions.length);

    // Also aim through a tree/boulder cluster across the island center to verify instanced matrices become zero-scale
    const centerQuery: AimOcclusionQuery = {
      cameraPos: { x: world.centerX - 18, y: 12, z: world.centerZ - 18 },
      critterPos: { x: world.centerX - 12, y: 10, z: world.centerZ - 12 },
      aimDir: { x: 0.707, y: 0, z: 0.707 },
      maxRange: 30,
    };
    const centerHidden = props.updateAimOcclusion(centerQuery);
    expect(centerHidden).toBeGreaterThan(0);

    // Verify at least one previously non-zero instanced binding is now zero-scale
    let zeroedInstanceCount = 0;
    const mat = new THREE.Matrix4();
    const origMat = new THREE.Matrix4();
    for (const mesh of instancedMeshes) {
      const origArr = originalSnapshots.get(mesh);
      if (!origArr) continue;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, mat);
        origMat.fromArray(origArr, i * 16);
        if (!isZeroMatrix(origMat) && isZeroMatrix(mat)) {
          zeroedInstanceCount += 1;
        }
      }
    }
    expect(zeroedInstanceCount).toBeGreaterThan(0);

    // Turning aim away / clearing with null restores all props to their exact original matrices & visibility
    expect(props.updateAimOcclusion(null)).toBe(0);
    expect(watchtower.visible).toBe(true);
    for (const mesh of instancedMeshes) {
      const origArr = originalSnapshots.get(mesh);
      if (!origArr) continue;
      const curArr = mesh.instanceMatrix.array as Float32Array;
      expect(curArr.length).toBe(origArr.length);
      for (let i = 0; i < origArr.length; i++) {
        expect(curArr[i]).toBeCloseTo(origArr[i] ?? 0, 5);
      }
    }

    // Re-hide watchtower with aim, then permanently carve under it -> must NEVER be revived by updateAimOcclusion(null)
    expect(props.updateAimOcclusion(aimAtWatchtower)).toBeGreaterThanOrEqual(1);
    expect(watchtower.visible).toBe(false);

    world.applyCarve({
      shape: "sphere",
      center: {
        x: watchtower.position.x,
        y: watchtower.position.y - 0.5,
        z: watchtower.position.z,
      },
      radius: 4.5,
    });
    const pruned = props.pruneAfterCarve(world, 1.5);
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(watchtower.visible).toBe(false);
    expect(watchtower.parent).toBeNull();

    // Clearing aim occlusion must NEVER revive permanently pruned watchtower or pruned instanced props
    const prunedPositionsCount = props.getVisiblePropPositions().length;
    expect(prunedPositionsCount).toBe(initialVisiblePositions.length - pruned);
    expect(props.updateAimOcclusion(null)).toBe(0);
    expect(watchtower.visible).toBe(false);
    expect(watchtower.parent).toBeNull();
    expect(props.getVisiblePropPositions().length).toBe(prunedPositionsCount);

    // Also verify a permanently pruned instanced prop stays zero-matrix after aim hide + null restore
    const prunedSnapshot = snapshotMatrices();
    props.updateAimOcclusion(centerQuery);
    expect(props.updateAimOcclusion(null)).toBe(0);
    for (const mesh of instancedMeshes) {
      const afterPruneArr = prunedSnapshot.get(mesh);
      if (!afterPruneArr) continue;
      const curArr = mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < afterPruneArr.length; i++) {
        expect(curArr[i]).toBeCloseTo(afterPruneArr[i] ?? 0, 5);
      }
    }

    props.dispose();
  });
});
