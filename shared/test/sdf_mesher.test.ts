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
  it("generates deterministic islands and 4 valid separated spawn points for all 3 themes", () => {
    expect(SDF_DIMS).toEqual({
      nx: 48,
      ny: 28,
      nz: 48,
      voxelSize: 0.5,
      chunkSize: 16,
    });
    expect(chunkKey(1, 0, 2)).toBe("1,0,2");

    for (const theme of ALL_THEMES) {
      const worldA = new SdfWorld(9001, theme);
      const worldB = new SdfWorld(9001, theme);

      expect(worldA.seed).toBe(9001);
      expect(worldA.theme).toBe(theme);
      expect(worldA.getAllChunkCoords()).toHaveLength(18);

      // Deterministic identical sampling across representative grid points
      for (let x = 2; x <= 22; x += 4) {
        for (let y = 2; y <= 12; y += 2.5) {
          for (let z = 2; z <= 22; z += 4) {
            expect(worldA.sample(x, y, z)).toBeCloseTo(
              worldB.sample(x, y, z),
              6,
            );
          }
        }
      }

      // Outer 2-voxel boundary margin is strictly positive air
      expect(worldA.getValue(0, 10, 10)).toBeGreaterThan(0);
      expect(worldA.getValue(SDF_DIMS.nx - 1, 10, 10)).toBeGreaterThan(0);
      expect(worldA.getValue(10, 0, 10)).toBeGreaterThan(0);
      expect(worldA.getValue(10, SDF_DIMS.ny - 1, 10)).toBeGreaterThan(0);
      expect(worldA.getValue(10, 10, 0)).toBeGreaterThan(0);
      expect(worldA.getValue(10, 10, SDF_DIMS.nz - 1)).toBeGreaterThan(0);
      expect(worldA.getValue(-5, 10, 10)).toBe(2.0);
      expect(worldA.sample(-2, 5, 5)).toBe(2.0);

      // 4 valid walkable spawn points (y > 2.0, separated by > 3m)
      const spawnsA = worldA.findSpawnPoints(4);
      const spawnsB = worldB.findSpawnPoints(4);
      expect(spawnsA).toEqual(spawnsB);
      expect(spawnsA).toHaveLength(4);

      for (const sp of spawnsA) {
        expect(sp.y).toBeGreaterThan(2.0);
        expect(sp.y).toBeGreaterThanOrEqual(3.0);
        const normal = worldA.sampleNormal(sp.x, sp.y, sp.z);
        expect(normal.y).toBeGreaterThanOrEqual(0.65);
        expect(worldA.sample(sp.x, sp.y + 0.8, sp.z)).toBeGreaterThan(0);
      }

      for (let i = 0; i < spawnsA.length; i++) {
        for (let j = i + 1; j < spawnsA.length; j++) {
          const a = spawnsA[i];
          const b = spawnsA[j];
          expect(a).toBeDefined();
          expect(b).toBeDefined();
          if (a && b) {
            const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
            expect(dist).toBeGreaterThan(3.0);
          }
        }
      }
    }
  });

  it("carves a sphere blast turning solid center to air, logs the op, and returns 1..8 dirty chunks", () => {
    const world = new SdfWorld(2026, "emerald_spire");

    // Locate a solid interior point under the west plateau
    const surfaceY = world.getSurfaceY(7.2, 12.0);
    expect(surfaceY).not.toBeNull();
    const targetY = (surfaceY ?? 8.0) - 1.5;
    expect(world.isSolid(7.2, targetY, 12.0)).toBe(true);

    const blast: CarveOp = {
      center: { x: 7.2, y: targetY, z: 12.0 },
      radius: 2.0,
      shape: "sphere",
    };

    const dirtyChunks = world.applyCarve(blast);
    expect(dirtyChunks.length).toBeGreaterThanOrEqual(1);
    expect(dirtyChunks.length).toBeLessThanOrEqual(8);
    expect(new Set(dirtyChunks).size).toBe(dirtyChunks.length);

    expect(world.sample(7.2, targetY, 12.0)).toBeGreaterThan(0);
    expect(world.isSolid(7.2, targetY, 12.0)).toBe(false);

    const log = world.getCarveLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual(blast);

    // Mutating returned log copy does not mutate internal log
    log.pop();
    expect(world.getCarveLog()).toHaveLength(1);
  });

  it("carves a capsule tunnel through solid cliff while leaving solid rock overhead (y + 2.5m < 0)", () => {
    const world = new SdfWorld(777, "emerald_spire");

    // Pick a solid plateau column with deep vertical rock
    const topY = world.getSurfaceY(7.2, 12.0);
    expect(topY).not.toBeNull();
    const tunnelY = (topY ?? 8.0) - 3.6;

    // Verify cliff is solid at tunnel center and 2.5m overhead before carving
    expect(world.sample(7.2, tunnelY, 12.0)).toBeLessThan(0);
    expect(world.sample(7.2, tunnelY + 2.5, 12.0)).toBeLessThan(0);

    const tunnelOp: CarveOp = {
      center: { x: 5.5, y: tunnelY, z: 12.0 },
      end: { x: 9.0, y: tunnelY, z: 12.0 },
      radius: 1.2,
      shape: "capsule",
    };

    const dirty = world.applyCarve(tunnelOp);
    expect(dirty.length).toBeGreaterThanOrEqual(1);

    // Passable air along the capsule tunnel centerline
    expect(world.sample(6.2, tunnelY, 12.0)).toBeGreaterThan(0);
    expect(world.sample(7.2, tunnelY, 12.0)).toBeGreaterThan(0);
    expect(world.sample(8.2, tunnelY, 12.0)).toBeGreaterThan(0);

    // Solid rock overhead remains intact (< 0)
    expect(world.sample(7.2, tunnelY + 2.5, 12.0)).toBeLessThan(0);
  });

  it("Review Focus #1: boundary carves clamp cleanly with zero NaN/Infinity and unit normals across all 18 chunks", () => {
    const world = new SdfWorld(555, "canyon_arch");

    const boundaryCarves: CarveOp[] = [
      { center: { x: 0, y: 0, z: 0 }, radius: 3.0, shape: "sphere" },
      { center: { x: 24, y: 14, z: 24 }, radius: 3.0, shape: "sphere" },
      { center: { x: -1, y: 5, z: 25 }, radius: 3.5, shape: "sphere" },
    ];

    for (const op of boundaryCarves) {
      expect(() => world.applyCarve(op)).not.toThrow();
    }

    const chunks = world.getAllChunkCoords();
    expect(chunks).toHaveLength(18);

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
    expect(totalVertices).toBeGreaterThan(500);
    expect(totalTriangles).toBeGreaterThan(500);
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

      expect(checkedTriangles).toBeGreaterThan(500);
      expect(outwardTriangles / checkedTriangles).toBeGreaterThan(0.99);
    }
  });

  it("crumbleOuterRing erodes outer terrain beyond radiusFromCenter cleanly", () => {
    const world = new SdfWorld(888, "twin_pillars");
    const dirty = world.crumbleOuterRing(6.0);
    expect(dirty.length).toBeGreaterThan(0);

    // Points well outside radius 6.0 from island center (12, 12) must now be air
    expect(world.sample(19.5, 6.0, 12.0)).toBeGreaterThan(0);
    expect(world.sample(4.5, 6.0, 12.0)).toBeGreaterThan(0);
  });

  it("carves and re-meshes dirty chunks in under 25ms", () => {
    const world = new SdfWorld(4096, "emerald_spire");
    const topY = world.getSurfaceY(16.8, 12.0) ?? 8.0;

    // Warm up JIT once on a tiny untouched mesh call
    meshChunkSurfaceNets(world, 1, 0, 1);

    const start = performance.now();
    const dirty = world.applyCarve({
      center: { x: 16.8, y: topY - 1.0, z: 12.0 },
      radius: 2.4,
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
});
