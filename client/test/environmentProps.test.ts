import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { SdfWorld, type HazardState } from "@critter/shared";
import { EnvironmentProps } from "../src/scene/environmentProps.js";
import { createOceanShaderMaterial } from "../src/scene/worldScene.js";

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

    // Detonate the first Blast Barrel and first Spark Mine -> must remove and dispose their geometries
    const barrel = hazards.find((h) => h.type === "blast_barrel");
    const mine = hazards.find((h) => h.type === "spark_mine");
    expect(barrel).toBeDefined();
    expect(mine).toBeDefined();
    if (!barrel || !mine) return;

    const barrelObj = hazardGroup?.getObjectByName(`hazard_${barrel.id}`);
    const mineObj = hazardGroup?.getObjectByName(`hazard_${mine.id}`);
    expect(barrelObj).toBeDefined();
    expect(mineObj).toBeDefined();
    const disposeSpies = [
      ...(barrelObj ? collectAllMeshes(barrelObj) : []),
      ...(mineObj ? collectAllMeshes(mineObj) : []),
    ].map((m) => vi.spyOn(m.geometry, "dispose"));
    expect(disposeSpies.length).toBeGreaterThan(2);

    const updatedHazards = hazards.map((h) =>
      h.id === barrel.id || h.id === mine.id ? { ...h, active: false } : h,
    );
    props.syncHazards(updatedHazards, 3.0);

    expect(hazardGroup?.children.length).toBe(hazards.length - 2);
    for (const spy of disposeSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }

    props.dispose();
  });

  it("scales instanced scenery cleanly across 144m grand worlds with zero BoxGeometry", () => {
    const grandWorld = new SdfWorld(8842, "emerald_spire", "grand");
    const spawns = grandWorld.findSpawnPoints(4);
    const props = new EnvironmentProps(grandWorld, 1.5, spawns);

    const counts = props.getPropCounts();
    expect(counts.trees).toBeGreaterThanOrEqual(40);
    expect(counts.flora).toBeGreaterThanOrEqual(100);
    expect(counts.boulders).toBeGreaterThanOrEqual(40);
    expect(counts.landmarks).toBeGreaterThanOrEqual(8);

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

  it("constructs the custom GLSL stylized ocean ShaderMaterial with wave, depth-gradient, and surf foam uniforms", () => {
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
});
