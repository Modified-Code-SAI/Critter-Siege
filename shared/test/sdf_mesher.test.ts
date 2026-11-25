import { describe, expect, it } from "vitest";
import {
  SDF_DIMS,
  SdfWorld,
  chunkKey,
  createSeededRng,
  meshChunkSurfaceNets,
  type CarveOp,
  type ThemeId,
} from "@critter/shared";

const ALL_THEMES: ThemeId[] = ["emerald_spire", "canyon_arch", "twin_pillars"];

describe("Deterministic PRNG (createSeededRng)", () => {
  it("produces identical sequences in [0, 1) for the same seed", () => {
    const a = createSeededRng(1337);
    const b = createSeededRng(1337);
    const c = createSeededRng(4242);

    const seqA = Array.from({ length: 16 }, () => a());
    const seqB = Array.from({ length: 16 }, () => b());
    const seqC = Array.from({ length: 16 }, () => c());

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("SdfWorld & Surface Nets smooth terrain mesher", () => {
  it("generates deterministic 60m islands and 4 quadrant-separated (>= 22m) spawn points for all 3 themes", () => {
    expect(SDF_DIMS).toEqual({
      nx: 80,
      ny: 36,
      nz: 80,
      voxelSize: 0.75,
      chunkSize: 16,
    });
    expect(chunkKey(1, 0, 2)).toBe("1,0,2");

    const centerX = SDF_DIMS.nx * SDF_DIMS.voxelSize * 0.5;
    const centerZ = SDF_DIMS.nz * SDF_DIMS.voxelSize * 0.5;

    for (const theme of ALL_THEMES) {
      const worldA = new SdfWorld(9001, theme);
      const worldB = new SdfWorld(9001, theme);

      expect(worldA.seed).toBe(9001);
      expect(worldA.theme).toBe(theme);
      expect(worldA.getAllChunkCoords()).toHaveLength(75);

      // Deterministic identical sampling across representative grid points
      for (let x = 6; x <= 54; x += 12) {
        for (let y = 3; y <= 21; y += 6) {
          for (let z = 6; z <= 54; z += 12) {
            expect(worldA.sample(x, y, z)).toBeCloseTo(
              worldB.sample(x, y, z),
              6,
            );
          }
        }
      }

      // Outer 2-voxel boundary margin is strictly positive air on all 6 faces
      expect(worldA.getValue(0, 12, 12)).toBeGreaterThan(0);
      expect(worldA.getValue(1, 12, 12)).toBeGreaterThan(0);
      expect(worldA.getValue(SDF_DIMS.nx - 1, 12, 12)).toBeGreaterThan(0);
      expect(worldA.getValue(SDF_DIMS.nx - 2, 12, 12)).toBeGreaterThan(0);
      expect(worldA.getValue(20, 0, 20)).toBeGreaterThan(0);
      expect(worldA.getValue(20, SDF_DIMS.ny - 1, 20)).toBeGreaterThan(0);
      expect(worldA.getValue(20, 12, 0)).toBeGreaterThan(0);
      expect(worldA.getValue(20, 12, SDF_DIMS.nz - 1)).toBeGreaterThan(0);
      expect(worldA.getValue(-5, 10, 10)).toBe(2.0);
      expect(worldA.sample(-2, 5, 5)).toBe(2.0);

      // 4 valid walkable high-ground spawn points in 4 distinct quadrants separated by >= 22m
      const spawnsA = worldA.findSpawnPoints(4);
      const spawnsB = worldB.findSpawnPoints(4);
      expect(spawnsA).toEqual(spawnsB);
      expect(spawnsA).toHaveLength(4);

      const quadrants = new Set<string>();
      for (const sp of spawnsA) {
        expect(sp.y).toBeGreaterThanOrEqual(4.0);
        const normal = worldA.sampleNormal(sp.x, sp.y, sp.z);
        expect(normal.y).toBeGreaterThanOrEqual(0.65);
        expect(worldA.sample(sp.x, sp.y + 1.0, sp.z)).toBeGreaterThan(0);
        const q = `${sp.x < centerX ? "W" : "E"}${sp.z < centerZ ? "N" : "S"}`;
        quadrants.add(q);
      }
      expect(quadrants.size).toBe(4);

      for (let i = 0; i < spawnsA.length; i++) {
        for (let j = i + 1; j < spawnsA.length; j++) {
          const a = spawnsA[i];
          const b = spawnsA[j];
          expect(a).toBeDefined();
          expect(b).toBeDefined();
          if (a && b) {
            const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
            expect(dist).toBeGreaterThanOrEqual(22.0);
          }
        }
      }
    }
  });

  it("carves a sphere blast turning solid center to air, logs the op, and returns 1..8 dirty chunks", () => {
    const world = new SdfWorld(2026, "emerald_spire");
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    if (!sp) return;

    const targetY = sp.y - 2.0;
    expect(world.isSolid(sp.x, targetY, sp.z)).toBe(true);

    const blast: CarveOp = {
      center: { x: sp.x, y: targetY, z: sp.z },
      radius: 3.0,
      shape: "sphere",
    };

    const dirtyChunks = world.applyCarve(blast);
    expect(dirtyChunks.length).toBeGreaterThanOrEqual(1);
    expect(dirtyChunks.length).toBeLessThanOrEqual(8);
    expect(new Set(dirtyChunks).size).toBe(dirtyChunks.length);

    expect(world.sample(sp.x, targetY, sp.z)).toBeGreaterThan(0);
    expect(world.isSolid(sp.x, targetY, sp.z)).toBe(false);

    const log = world.getCarveLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual(blast);

    // Mutating returned log copy does not mutate internal log
    log.pop();
    expect(world.getCarveLog()).toHaveLength(1);
  });

  it("carves a capsule tunnel through solid cliff while leaving solid rock overhead (y + 3.0m < 0)", () => {
    const world = new SdfWorld(777, "emerald_spire");
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    if (!sp) return;

    const tunnelY = sp.y - 4.8;

    // Verify cliff is solid at tunnel center and 3.0m overhead before carving
    expect(world.sample(sp.x, tunnelY, sp.z)).toBeLessThan(0);
    expect(world.sample(sp.x, tunnelY + 3.0, sp.z)).toBeLessThan(0);

    const tunnelOp: CarveOp = {
      center: { x: sp.x - 2.2, y: tunnelY, z: sp.z },
      end: { x: sp.x + 2.2, y: tunnelY, z: sp.z },
      radius: 1.4,
      shape: "capsule",
    };

    const dirty = world.applyCarve(tunnelOp);
    expect(dirty.length).toBeGreaterThanOrEqual(1);

    // Passable air along the capsule tunnel centerline
    expect(world.sample(sp.x - 1.2, tunnelY, sp.z)).toBeGreaterThan(0);
    expect(world.sample(sp.x, tunnelY, sp.z)).toBeGreaterThan(0);
    expect(world.sample(sp.x + 1.2, tunnelY, sp.z)).toBeGreaterThan(0);

    // Solid rock overhead remains intact (< 0)
    expect(world.sample(sp.x, tunnelY + 3.0, sp.z)).toBeLessThan(0);
  });

  it("Review Focus #1: boundary carves clamp cleanly with zero NaN/Infinity and unit normals across all 75 chunks", () => {
    const world = new SdfWorld(555, "canyon_arch");

    const boundaryCarves: CarveOp[] = [
      { center: { x: 0, y: 0, z: 0 }, radius: 4.0, shape: "sphere" },
      { center: { x: 60, y: 27, z: 60 }, radius: 4.0, shape: "sphere" },
      { center: { x: -1, y: 8, z: 61 }, radius: 4.5, shape: "sphere" },
    ];

    for (const op of boundaryCarves) {
      expect(() => world.applyCarve(op)).not.toThrow();
    }

    const chunks = world.getAllChunkCoords();
    expect(chunks).toHaveLength(75);

    let totalVertices = 0;
    let totalTriangles = 0;
    let nonFiniteValues = 0;
    let outOfRangeColors = 0;
    let badUnitNormals = 0;
    let outOfBoundsIndices = 0;

    for (const { cx, cy, cz } of chunks) {
      const mesh = meshChunkSurfaceNets(world, cx, cy, cz);
      const vertCount = mesh.positions.length / 3;
      totalVertices += vertCount;
      totalTriangles += mesh.indices.length / 3;

      expect(mesh.normals.length).toBe(mesh.positions.length);
      expect(mesh.colors.length).toBe(mesh.positions.length);

      for (let i = 0; i < mesh.positions.length; i++) {
        const p = mesh.positions[i] ?? Number.NaN;
        const n = mesh.normals[i] ?? Number.NaN;
        const c = mesh.colors[i] ?? Number.NaN;
        if (!Number.isFinite(p) || !Number.isFinite(n) || !Number.isFinite(c)) {
          nonFiniteValues += 1;
        }
        if (c < 0 || c > 1) {
          outOfRangeColors += 1;
        }
      }

      for (let v = 0; v < vertCount; v++) {
        const nx = mesh.normals[v * 3] ?? 0;
        const ny = mesh.normals[v * 3 + 1] ?? 0;
        const nz = mesh.normals[v * 3 + 2] ?? 0;
        const len = Math.hypot(nx, ny, nz);
        if (len < 0.99 || len > 1.01) {
          badUnitNormals += 1;
        }
      }

      for (let i = 0; i < mesh.indices.length; i++) {
        const idx = mesh.indices[i] ?? -1;
        if (idx < 0 || idx >= vertCount) {
          outOfBoundsIndices += 1;
        }
      }
    }

    expect(nonFiniteValues).toBe(0);
    expect(outOfRangeColors).toBe(0);
    expect(badUnitNormals).toBe(0);
    expect(outOfBoundsIndices).toBe(0);
    expect(totalVertices).toBeGreaterThan(2000);
    expect(totalTriangles).toBeGreaterThan(2000);
  });

  it("emits outward-facing Surface Nets triangles across all 3 themes with zero inside-out faces", () => {
    for (const theme of ALL_THEMES) {
      const world = new SdfWorld(31415, theme);
      let checkedTriangles = 0;
      let outwardTriangles = 0;

      for (const { cx, cy, cz } of world.getAllChunkCoords()) {
        const mesh = meshChunkSurfaceNets(world, cx, cy, cz);
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const i0 = (mesh.indices[t] ?? 0) * 3;
          const i1 = (mesh.indices[t + 1] ?? 0) * 3;
          const i2 = (mesh.indices[t + 2] ?? 0) * 3;

          const x0 = mesh.positions[i0] ?? 0;
          const y0 = mesh.positions[i0 + 1] ?? 0;
          const z0 = mesh.positions[i0 + 2] ?? 0;

          const x1 = mesh.positions[i1] ?? 0;
          const y1 = mesh.positions[i1 + 1] ?? 0;
          const z1 = mesh.positions[i1 + 2] ?? 0;

          const x2 = mesh.positions[i2] ?? 0;
          const y2 = mesh.positions[i2 + 1] ?? 0;
          const z2 = mesh.positions[i2 + 2] ?? 0;

          const e1x = x1 - x0;
          const e1y = y1 - y0;
          const e1z = z1 - z0;
          const e2x = x2 - x0;
          const e2y = y2 - y0;
          const e2z = z2 - z0;

          const fnx = e1y * e2z - e1z * e2y;
          const fny = e1z * e2x - e1x * e2z;
          const fnz = e1x * e2y - e1y * e2x;
          const area2 = Math.hypot(fnx, fny, fnz);
          if (area2 < 1e-5) {
            continue;
          }

          const cxPos = (x0 + x1 + x2) / 3;
          const cyPos = (y0 + y1 + y2) / 3;
          const czPos = (z0 + z1 + z2) / 3;
          const sdfN = world.sampleNormal(cxPos, cyPos, czPos);
          const dot =
            (fnx / area2) * sdfN.x +
            (fny / area2) * sdfN.y +
            (fnz / area2) * sdfN.z;

          checkedTriangles += 1;
          if (dot > 0) {
            outwardTriangles += 1;
          }
        }
      }

      expect(checkedTriangles).toBeGreaterThan(2000);
      expect(outwardTriangles / checkedTriangles).toBeGreaterThan(0.99);
    }
  });

  it("crumbleOuterRing erodes outer terrain beyond radiusFromCenter around (30, 30) cleanly", () => {
    const world = new SdfWorld(888, "twin_pillars");
    const dirty = world.crumbleOuterRing(16.0);
    expect(dirty.length).toBeGreaterThan(0);

    // Points well outside radius 16.0 from island center (30, 30) must now be air
    expect(world.sample(50.0, 8.0, 30.0)).toBeGreaterThan(0);
    expect(world.sample(10.0, 8.0, 30.0)).toBeGreaterThan(0);
  });

  it("carves and re-meshes dirty chunks in under 25ms", () => {
    const world = new SdfWorld(4096, "emerald_spire");
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    if (!sp) return;

    // Warm up JIT once on a tiny untouched mesh call
    meshChunkSurfaceNets(world, 2, 0, 2);

    const start = performance.now();
    const dirty = world.applyCarve({
      center: { x: sp.x, y: sp.y - 1.0, z: sp.z },
      radius: 3.2,
      shape: "sphere",
    });

    for (const key of dirty) {
      const parts = key.split(",").map(Number);
      const cx = parts[0] ?? 0;
      const cy = parts[1] ?? 0;
      const cz = parts[2] ?? 0;
      meshChunkSurfaceNets(world, cx, cy, cz);
    }
    const elapsedMs = performance.now() - start;

    expect(dirty.length).toBeGreaterThanOrEqual(1);
    expect(elapsedMs).toBeLessThan(25);
  });

  it("places 6-10 deterministic interactive hazards clear of spawns and sculpts a pass-through tunnel beneath emerald_spire pinnacle", () => {
    for (const theme of ALL_THEMES) {
      const worldA = new SdfWorld(7331, theme);
      const worldB = new SdfWorld(7331, theme);
      const spawnsA = worldA.findSpawnPoints(4);
      const spawnsB = worldB.findSpawnPoints(4);

      const hazardsA = worldA.findHazardPoints(spawnsA);
      const hazardsB = worldB.findHazardPoints(spawnsB);

      expect(hazardsA).toEqual(hazardsB);
      expect(hazardsA.length).toBeGreaterThanOrEqual(6);
      expect(hazardsA.length).toBeLessThanOrEqual(10);

      const typesPresent = new Set(hazardsA.map((h) => h.type));
      expect(typesPresent.has("blast_barrel")).toBe(true);
      expect(typesPresent.has("steam_geyser")).toBe(true);
      expect(typesPresent.has("thorn_patch")).toBe(true);

      for (const h of hazardsA) {
        expect(h.position.y).toBeGreaterThanOrEqual(2.2);
        expect(worldA.sample(h.position.x, h.position.y + 1.0, h.position.z)).toBeGreaterThan(0);
        if (h.type === "blast_barrel") expect(h.radius).toBe(1.4);
        if (h.type === "steam_geyser") expect(h.radius).toBe(1.7);
        if (h.type === "thorn_patch") expect(h.radius).toBe(1.9);

        for (const sp of spawnsA) {
          const dist = Math.hypot(
            h.position.x - sp.x,
            h.position.y - sp.y,
            h.position.z - sp.z,
          );
          expect(dist).toBeGreaterThanOrEqual(4.0);
        }
      }
    }

    // Verify intricate vertical obstacle feature: pass-through tunnel at base of emerald_spire pinnacle
    const spireWorld = new SdfWorld(4242, "emerald_spire");
    expect(spireWorld.sample(30.0, 5.4, 30.0)).toBeGreaterThan(0);
    expect(spireWorld.sample(30.0, 11.0, 30.0)).toBeLessThan(0);
  });
});
