import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  SdfWorld,
  meshChunkSurfaceNets,
  type ThemeId,
} from "@critter/shared";
import {
  buildShorelineDepthData,
  createOceanShaderMaterial,
  getThemeAtmosphere,
} from "../src/scene/worldScene.js";
import { TerrainRenderer } from "../src/scene/terrainRenderer.js";
import { EnvironmentProps } from "../src/scene/environmentProps.js";
import { VfxSystem } from "../src/scene/vfx.js";

const ALL_THEMES: readonly ThemeId[] = [
  "emerald_spire",
  "canyon_arch",
  "twin_pillars",
  "mountain_spine",
];

describe("Stylized Sunlit PBR Graphics Upgrade", () => {
  it("returns distinct curated sunlit atmospheres for all 4 biome themes", () => {
    const palettes = ALL_THEMES.map((theme) => getThemeAtmosphere(theme));
    const zenithSet = new Set(palettes.map((p) => p.skyZenith));
    const horizonSet = new Set(palettes.map((p) => p.skyHorizon));
    const fogSet = new Set(palettes.map((p) => p.fogColor));
    const shallowSet = new Set(palettes.map((p) => p.oceanShallow));
    const sunOffsetKeys = new Set(
      palettes.map(
        (p) =>
          `${p.sunOffset.x.toFixed(2)},${p.sunOffset.y.toFixed(2)},${p.sunOffset.z.toFixed(2)}`,
      ),
    );

    expect(zenithSet.size).toBe(4);
    expect(horizonSet.size).toBe(4);
    expect(fogSet.size).toBe(4);
    expect(shallowSet.size).toBe(4);
    expect(sunOffsetKeys.size).toBe(4);

    // Defensive copies prevent accidental mutation of shared palette presets
    const copyA = getThemeAtmosphere("canyon_arch");
    copyA.sunOffset.x = 999;
    expect(getThemeAtmosphere("canyon_arch").sunOffset.x).not.toBe(999);
  });

  it("builds smoothed SDF shoreline depth data distinguishing solid rock from deep ocean and updates on coastal carve", () => {
    const world = new SdfWorld(4242, "emerald_spire");
    const res = 64;
    const waterLevel = 2.0;
    const before = buildShorelineDepthData(world, waterLevel, res);

    expect(before.length).toBe(res * res * 4);

    let solidCount = 0;
    let deepWaterCount = 0;
    let targetIx = -1;
    let targetIz = -1;

    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const idx = (iz * res + ix) * 4;
        const r = before[idx] ?? 0;
        const a = before[idx + 3] ?? 0;
        expect(a).toBe(255);
        if (r < 60) {
          solidCount += 1;
          if (targetIx < 0 && ix > 8 && ix < res - 8 && iz > 8 && iz < res - 8) {
            targetIx = ix;
            targetIz = iz;
          }
        }
        if (r > 200) {
          deepWaterCount += 1;
        }
      }
    }

    expect(solidCount).toBeGreaterThan(20);
    expect(deepWaterCount).toBeGreaterThan(100);
    expect(targetIx).toBeGreaterThan(0);

    // Carve a wide coastal crater right at the sampled solid waterline coordinate
    const carveX = ((targetIx + 0.5) / res) * world.worldWidth;
    const carveZ = ((targetIz + 0.5) / res) * world.worldDepth;
    world.applyCarve({
      shape: "sphere",
      center: { x: carveX, y: waterLevel, z: carveZ },
      radius: 5.0,
    });

    const after = buildShorelineDepthData(world, waterLevel, res);
    const targetIdx = (targetIz * res + targetIx) * 4;
    const rBefore = before[targetIdx] ?? 0;
    const rAfter = after[targetIdx] ?? 0;
    expect(rAfter).toBeGreaterThan(rBefore + 30);

    // Verify ocean shader exposes the new SDF shoreline uniforms alongside legacy ones
    const oceanMat = createOceanShaderMaterial(new THREE.Vector3(0.6, 0.8, 0.4));
    expect(oceanMat.uniforms.uShoreTex?.value).toBeInstanceOf(THREE.DataTexture);
    expect(oceanMat.uniforms.uWorldOrigin).toBeDefined();
    expect(oceanMat.uniforms.uWorldSpan).toBeDefined();
    expect(oceanMat.uniforms.uHasShoreTex?.value).toBe(0.0);
    if (oceanMat.uniforms.uShoreTex?.value instanceof THREE.DataTexture) {
      oceanMat.uniforms.uShoreTex.value.dispose();
    }
    oceanMat.dispose();
  });

  it("applies baked SDF crevice AO and scorches freshly blasted crater walls with finite [0, 1] RGB", () => {
    const world = new SdfWorld(2026, "emerald_spire");
    const spawn = world.findSpawnPoints(1)[0];
    expect(spawn).toBeDefined();
    if (!spawn) return;

    const vs = world.dims.voxelSize;
    const cs = world.dims.chunkSize;
    const cx = Math.floor(spawn.x / (vs * cs));
    const cy = Math.floor(spawn.y / (vs * cs));
    const cz = Math.floor(spawn.z / (vs * cs));

    const beforeMesh = meshChunkSurfaceNets(world, cx, cy, cz);
    expect(beforeMesh.colors.length).toBeGreaterThan(0);

    // Measure average sunlit meadow luminance near the uncarved spawn plateau
    let meadowLumSum = 0;
    let meadowVerts = 0;
    const beforeVertCount = beforeMesh.positions.length / 3;
    for (let i = 0; i < beforeVertCount; i++) {
      const px = beforeMesh.positions[i * 3] ?? 0;
      const py = beforeMesh.positions[i * 3 + 1] ?? 0;
      const pz = beforeMesh.positions[i * 3 + 2] ?? 0;
      const ny = beforeMesh.normals[i * 3 + 1] ?? 0;
      const r = beforeMesh.colors[i * 3] ?? 0;
      const g = beforeMesh.colors[i * 3 + 1] ?? 0;
      const b = beforeMesh.colors[i * 3 + 2] ?? 0;
      expect(Number.isFinite(r) && r >= 0 && r <= 1).toBe(true);
      expect(Number.isFinite(g) && g >= 0 && g <= 1).toBe(true);
      expect(Number.isFinite(b) && b >= 0 && b <= 1).toBe(true);

      if (Math.hypot(px - spawn.x, py - spawn.y, pz - spawn.z) < 3.6 && ny > 0.65) {
        meadowLumSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        meadowVerts += 1;
      }
    }
    expect(meadowVerts).toBeGreaterThan(0);
    const avgMeadowLum = meadowLumSum / meadowVerts;

    // Blast a 3.2m crater directly at the spawn point
    const blastRadius = 3.2;
    world.applyCarve({
      shape: "sphere",
      center: { x: spawn.x, y: spawn.y, z: spawn.z },
      radius: blastRadius,
    });

    const afterMesh = meshChunkSurfaceNets(world, cx, cy, cz);
    const afterVertCount = afterMesh.positions.length / 3;
    let craterLumSum = 0;
    let craterVerts = 0;

    for (let i = 0; i < afterVertCount; i++) {
      const px = afterMesh.positions[i * 3] ?? 0;
      const py = afterMesh.positions[i * 3 + 1] ?? 0;
      const pz = afterMesh.positions[i * 3 + 2] ?? 0;
      const r = afterMesh.colors[i * 3] ?? 0;
      const g = afterMesh.colors[i * 3 + 1] ?? 0;
      const b = afterMesh.colors[i * 3 + 2] ?? 0;
      expect(Number.isFinite(r) && r >= 0 && r <= 1).toBe(true);
      expect(Number.isFinite(g) && g >= 0 && g <= 1).toBe(true);
      expect(Number.isFinite(b) && b >= 0 && b <= 1).toBe(true);

      const distFromWall = Math.abs(
        Math.hypot(px - spawn.x, py - spawn.y, pz - spawn.z) - blastRadius,
      );
      if (distFromWall < 0.75) {
        craterLumSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        craterVerts += 1;
      }
    }

    expect(craterVerts).toBeGreaterThan(0);
    const avgCraterLum = craterLumSum / craterVerts;
    // Charred crater wall + baked cavity AO must be clearly darker than sunlit meadow
    expect(avgCraterLum).toBeLessThan(avgMeadowLum * 0.65);
  });

  it("updates TerrainRenderer water level safely while preserving bumpMap, roughnessMap, and triplanar shader hook", () => {
    const world = new SdfWorld(77, "canyon_arch");
    const renderer = new TerrainRenderer(world);

    expect(() => renderer.setWaterLevel(3.6)).not.toThrow();
    expect(() => renderer.setWaterLevel(Number.NaN)).not.toThrow();
    expect(() => renderer.setWaterLevel(Number.POSITIVE_INFINITY)).not.toThrow();

    let checkedMeshes = 0;
    renderer.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
        expect(obj.material.bumpMap).not.toBeNull();
        expect(obj.material.roughnessMap).not.toBeNull();
        expect(obj.geometry.getAttribute("uv")).toBeDefined();
        expect(obj.material.customProgramCacheKey()).toBe(
          "critter_terrain_triplanar_v1",
        );
        checkedMeshes += 1;
      }
    });
    expect(checkedMeshes).toBeGreaterThan(0);

    renderer.dispose();
  });

  it("consolidates tree foliage materials, disables castShadow on ground flora, and updates wind sway cleanly", () => {
    const world = new SdfWorld(4242, "emerald_spire");
    const spawns = world.findSpawnPoints(4);
    const props = new EnvironmentProps(world, 1.5, spawns);

    expect(() => props.updateWind({ x: 3.4, y: 0, z: -1.6 }, 1.5)).not.toThrow();
    expect(() =>
      props.updateWind({ x: Number.NaN, y: 0, z: Number.POSITIVE_INFINITY }, Number.NaN),
    ).not.toThrow();

    const scenery = props.group.getObjectByName("scenery_props");
    expect(scenery).toBeDefined();

    const instanced: THREE.InstancedMesh[] = [];
    scenery?.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) {
        instanced.push(obj);
      }
    });
    expect(instanced.length).toBeGreaterThan(6);

    // All 3 instanced pine cone tiers must share a single foliage material
    const pineTiers = instanced.filter((m) => m.geometry.type === "ConeGeometry");
    expect(pineTiers.length).toBe(3);
    expect(new Set(pineTiers.map((m) => m.material)).size).toBe(1);

    // Sculpted grass tufts (BufferGeometry) & wildflowers (OctahedronGeometry) disable castShadow
    const grassTufts = instanced.filter((m) => m.geometry.type === "BufferGeometry");
    const wildflowers = instanced.filter(
      (m) => m.geometry.type === "OctahedronGeometry",
    );
    expect(grassTufts.length).toBe(1);
    expect(wildflowers.length).toBe(1);
    for (const floraMesh of [...grassTufts, ...wildflowers]) {
      expect(floraMesh.castShadow).toBe(false);
      expect(floraMesh.receiveShadow).toBe(true);
    }

    // Oak crowns (3 IcosahedronGeometry instanced meshes sharing 1 material) vs shrubs (castShadow=false)
    const icosaInstanced = instanced.filter(
      (m) => m.geometry.type === "IcosahedronGeometry",
    );
    const oakCrowns = icosaInstanced.filter((m) => m.castShadow);
    const groundShrubs = icosaInstanced.filter((m) => !m.castShadow);
    expect(oakCrowns.length).toBe(3);
    expect(new Set(oakCrowns.map((m) => m.material)).size).toBe(1);
    expect(groundShrubs.length).toBe(1);
    expect(groundShrubs[0]?.receiveShadow).toBe(true);

    props.dispose();
  });

  it("reuses pooled vfx_particle_pools across repeated blast bursts without leaking vfx_particles children", () => {
    const vfx = new VfxSystem();
    const poolGroup = vfx.group.getObjectByName("vfx_particle_pools");
    const particleGroup = vfx.group.getObjectByName("vfx_particles");

    expect(poolGroup).toBeInstanceOf(THREE.Group);
    expect(particleGroup).toBeInstanceOf(THREE.Group);

    const initialPoolChildren = poolGroup?.children.length ?? 0;
    expect(initialPoolChildren).toBeGreaterThan(20);

    // Trigger 5 heavy bursts to saturate & wrap ring-buffer pools
    for (let i = 0; i < 5; i++) {
      vfx.spawnExplosion({ x: 10 + i * 4, y: 8, z: 12 + i * 3 }, 2.4, i % 2 === 1);
      vfx.spawnBarrelExplosion({ x: 20 + i * 3, y: 9, z: 22 - i * 2 }, 2.8);
    }

    // Pool child count remains strictly fixed (zero per-blast pool allocation growth)
    expect(poolGroup?.children.length).toBe(initialPoolChildren);
    expect(particleGroup?.children.length).toBeGreaterThan(0);

    // Advance past all particle lifetimes -> dynamic vfx_particles drains to 0 cleanly
    for (let step = 0; step < 50; step++) {
      vfx.update(0.05, step * 0.05);
    }
    expect(particleGroup?.children.length).toBe(0);
    expect(poolGroup?.children.length).toBe(initialPoolChildren);

    vfx.dispose();
  });
});
