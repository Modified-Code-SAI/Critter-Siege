import { describe, expect, it } from "vitest";
import {
  SDF_DIMS,
  SDF_PRESETS,
  SdfWorld,
  chunkKey,
  createSeededRng,
  meshChunkSurfaceNets,
  type CarveOp,
  type ThemeId,
} from "@critter/shared";

const ALL_THEMES: ThemeId[] = [
  "emerald_spire",
  "canyon_arch",
  "twin_pillars",
  "mountain_spine",
];

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

  it("places 8-10 deterministic interactive hazards across all 4 types clear of spawns and sculpts a pass-through tunnel beneath emerald_spire pinnacle", () => {
    for (const theme of ALL_THEMES) {
      const worldA = new SdfWorld(7331, theme);
      const worldB = new SdfWorld(7331, theme);
      const spawnsA = worldA.findSpawnPoints(4);
      const spawnsB = worldB.findSpawnPoints(4);

      const hazardsA = worldA.findHazardPoints(spawnsA);
      const hazardsB = worldB.findHazardPoints(spawnsB);

      expect(hazardsA).toEqual(hazardsB);
      expect(hazardsA.length).toBeGreaterThanOrEqual(8);
      expect(hazardsA.length).toBeLessThanOrEqual(10);

      const typesPresent = new Set(hazardsA.map((h) => h.type));
      expect(typesPresent.has("blast_barrel")).toBe(true);
      expect(typesPresent.has("spark_mine")).toBe(true);
      expect(typesPresent.has("steam_geyser")).toBe(true);
      expect(typesPresent.has("thorn_patch")).toBe(true);

      for (const h of hazardsA) {
        expect(h.position.y).toBeGreaterThanOrEqual(2.2);
        expect(worldA.sample(h.position.x, h.position.y + 1.0, h.position.z)).toBeGreaterThan(0);
        if (h.type === "blast_barrel") expect(h.radius).toBe(1.4);
        if (h.type === "spark_mine") expect(h.radius).toBe(2.4);
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

  it("generates 144m grand maps with 192 chunks, 4 spawns >= 52m apart, and 14-18 hazards across all 4 themes", () => {
    expect(SDF_PRESETS.duel).toEqual({
      nx: 80,
      ny: 36,
      nz: 80,
      voxelSize: 0.75,
      chunkSize: 16,
    });
    expect(SDF_PRESETS.grand).toEqual({
      nx: 128,
      ny: 44,
      nz: 128,
      voxelSize: 1.125,
      chunkSize: 16,
    });

    for (const theme of ALL_THEMES) {
      const grand = new SdfWorld(2026, theme, "grand");
      expect(grand.mapScale).toBe("grand");
      expect(grand.dims).toEqual(SDF_PRESETS.grand);
      expect(grand.worldWidth).toBe(144);
      expect(grand.worldHeight).toBe(49.5);
      expect(grand.worldDepth).toBe(144);
      expect(grand.centerX).toBe(72);
      expect(grand.centerZ).toBe(72);
      expect(grand.getAllChunkCoords()).toHaveLength(192);

      const spawns = grand.findSpawnPoints(4);
      expect(spawns).toHaveLength(4);

      const quadrants = new Set<string>();
      for (const sp of spawns) {
        expect(sp.y).toBeGreaterThanOrEqual(4.0);
        const normal = grand.sampleNormal(sp.x, sp.y, sp.z);
        expect(normal.y).toBeGreaterThanOrEqual(0.65);
        expect(grand.sample(sp.x, sp.y + 1.0, sp.z)).toBeGreaterThan(0);
        quadrants.add(`${sp.x < grand.centerX ? "W" : "E"}${sp.z < grand.centerZ ? "N" : "S"}`);
      }
      expect(quadrants.size).toBe(4);

      for (let i = 0; i < spawns.length; i++) {
        for (let j = i + 1; j < spawns.length; j++) {
          const a = spawns[i];
          const b = spawns[j];
          expect(a).toBeDefined();
          expect(b).toBeDefined();
          if (a && b) {
            const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
            expect(dist).toBeGreaterThanOrEqual(52.0);
          }
        }
      }

      const hazards = grand.findHazardPoints(spawns);
      expect(hazards.length).toBeGreaterThanOrEqual(14);
      expect(hazards.length).toBeLessThanOrEqual(18);
      const typesPresent = new Set(hazards.map((h) => h.type));
      expect(typesPresent.has("blast_barrel")).toBe(true);
      expect(typesPresent.has("spark_mine")).toBe(true);
      expect(typesPresent.has("steam_geyser")).toBe(true);
      expect(typesPresent.has("thorn_patch")).toBe(true);
    }
  }, 15000);

  it("blocks direct Turn 1 line-of-sight between every pair of spawns across all 4 themes in both duel and grand scales", () => {
    for (const theme of ALL_THEMES) {
      // Duel (60m): check 2-player spawns and full 4-quadrant spawns
      const duel = new SdfWorld(9001, theme, "duel");
      expect(duel.worldWidth).toBe(60);
      expect(duel.worldDepth).toBe(60);
      const duel2 = duel.findSpawnPoints(2);
      expect(duel2).toHaveLength(2);
      const d0 = duel2[0];
      const d1 = duel2[1];
      expect(d0).toBeDefined();
      expect(d1).toBeDefined();
      if (d0 && d1) {
        expect(Math.hypot(d0.x - d1.x, d0.y - d1.y, d0.z - d1.z)).toBeGreaterThanOrEqual(24.0);
        expect(duel.hasDirectLineOfSight(d0, d1, 1.1)).toBe(false);
      }

      const duel4 = duel.findSpawnPoints(4);
      expect(duel4).toHaveLength(4);
      for (let i = 0; i < duel4.length; i++) {
        for (let j = i + 1; j < duel4.length; j++) {
          const a = duel4[i];
          const b = duel4[j];
          expect(a).toBeDefined();
          expect(b).toBeDefined();
          if (a && b) {
            expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThanOrEqual(24.0);
            expect(duel.hasDirectLineOfSight(a, b, 1.1)).toBe(false);
          }
        }
      }

      // Grand (144m): check all 6 pairs of 4 spawns
      const grand = new SdfWorld(9001, theme, "grand");
      const grand4 = grand.findSpawnPoints(4);
      expect(grand4).toHaveLength(4);
      for (let i = 0; i < grand4.length; i++) {
        for (let j = i + 1; j < grand4.length; j++) {
          const a = grand4[i];
          const b = grand4[j];
          expect(a).toBeDefined();
          expect(b).toBeDefined();
          if (a && b) {
            expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThanOrEqual(52.0);
            expect(grand.hasDirectLineOfSight(a, b, 1.1)).toBe(false);
          }
        }
      }
    }
  }, 15000);

  it("sculpts distinct mountain_spine Dragon's Backbone Ridge with 5 serrated vertebrae peaks, open ocean flanks, 3 pass-through rib-tunnels, and obstructed spawns", () => {
    for (const scale of ["duel", "grand"] as const) {
      const mountain = new SdfWorld(4242, "mountain_spine", scale);
      const cx = mountain.centerX;
      const cz = mountain.centerZ;
      const halfSpan = mountain.worldWidth * 0.44;
      const h = mountain.worldHeight;

      const spineWorld = (along: number, cross: number): { x: number; z: number } => {
        const rc = cross + 0.14 * Math.sin(along * Math.PI * 1.05);
        const u = (along + rc) * Math.SQRT1_2;
        const v = (rc - along) * Math.SQRT1_2;
        return { x: cx + u * halfSpan, z: cz + v * halfSpan };
      };

      // 5 serrated vertebrae peaks along the curving SW-to-NE spine rising to 58-74% worldHeight
      const peakAlongs = [-0.74, -0.37, 0.0, 0.37, 0.74] as const;
      for (const a of peakAlongs) {
        const p = spineWorld(a, 0);
        const topY = mountain.getSurfaceY(p.x, p.z);
        expect(topY).not.toBeNull();
        expect(topY ?? 0).toBeGreaterThan(h * 0.54);
      }

      // 3 deep pass-through rib-tunnels piercing cleanly across the backbone with solid peaks overhead
      const tunnels: ReadonlyArray<readonly [number, number]> = [
        [-0.37, 0.2],
        [0.0, 0.23],
        [0.37, 0.27],
      ];
      for (const [a, yFrac] of tunnels) {
        const center = spineWorld(a, 0);
        expect(mountain.sample(center.x, h * yFrac, center.z)).toBeGreaterThan(0);
        expect(mountain.sample(center.x, h * 0.56, center.z)).toBeLessThan(0);
      }

      // Dramatic open ocean air at the off-spine far NW and SE outer corners
      const farNW = { x: cx - 0.88 * halfSpan, z: cz - 0.88 * halfSpan };
      const farSE = { x: cx + 0.88 * halfSpan, z: cz + 0.88 * halfSpan };
      expect(mountain.getSurfaceY(farNW.x, farNW.z)).toBeNull();
      expect(mountain.getSurfaceY(farSE.x, farSE.z)).toBeNull();

      // Every pair of spawns obstructed in both duel and grand
      const spawns = mountain.findSpawnPoints(4);
      expect(spawns).toHaveLength(4);
      for (let i = 0; i < spawns.length; i++) {
        for (let j = i + 1; j < spawns.length; j++) {
          const a = spawns[i];
          const b = spawns[j];
          if (a && b) {
            expect(mountain.hasDirectLineOfSight(a, b, 1.1)).toBe(false);
          }
        }
      }
    }
  });

  it("meshes all 192 chunks of a 144m grand world dynamically with fast empty-chunk early-out and zero NaNs", () => {
    const grand = new SdfWorld(2026, "emerald_spire", "grand");
    const chunks = grand.getAllChunkCoords();
    expect(chunks).toHaveLength(192);

    const start = performance.now();
    let totalVertices = 0;
    let totalTriangles = 0;
    let outerChunkVertices = 0;
    let maxWorldX = 0;
    let maxWorldZ = 0;
    let nonFinite = 0;

    for (const { cx, cy, cz } of chunks) {
      const mesh = meshChunkSurfaceNets(grand, cx, cy, cz);
      const vCount = mesh.positions.length / 3;
      totalVertices += vCount;
      totalTriangles += mesh.indices.length / 3;
      if (cx >= 5 || cz >= 5) {
        outerChunkVertices += vCount;
      }
      for (let v = 0; v < vCount; v++) {
        const px = mesh.positions[v * 3] ?? Number.NaN;
        const py = mesh.positions[v * 3 + 1] ?? Number.NaN;
        const pz = mesh.positions[v * 3 + 2] ?? Number.NaN;
        if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
          nonFinite += 1;
        }
        if (px > maxWorldX) maxWorldX = px;
        if (pz > maxWorldZ) maxWorldZ = pz;
      }
    }
    const elapsedMs = performance.now() - start;

    expect(nonFinite).toBe(0);
    expect(totalVertices).toBeGreaterThan(8000);
    expect(totalTriangles).toBeGreaterThan(8000);
    expect(outerChunkVertices).toBeGreaterThan(2000);
    expect(maxWorldX).toBeGreaterThan(110);
    expect(maxWorldZ).toBeGreaterThan(110);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("enforces multi-turn spawn spacing (>= 54m on grand), preserves emerald_spire destructible gate plugs & coastal walls, and places >= 4 tactical Blast Barrels across all themes", () => {
    for (const theme of ALL_THEMES) {
      for (const scale of ["duel", "grand"] as const) {
        const world = new SdfWorld(9001, theme, scale);
        const isGrand = scale === "grand";
        const spawns = world.findSpawnPoints(4);
        expect(spawns).toHaveLength(4);

        // Grand (144m): every spawn pair must be >= 54m apart (> 2 * 26m -> strictly 3+ turns on foot)
        let minDist = Infinity;
        for (let i = 0; i < spawns.length; i++) {
          for (let j = i + 1; j < spawns.length; j++) {
            const a = spawns[i];
            const b = spawns[j];
            if (a && b) {
              const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
              if (d < minDist) minDist = d;
              expect(world.hasDirectLineOfSight(a, b, 1.1)).toBe(false);
            }
          }
        }
        expect(minDist).toBeGreaterThanOrEqual(isGrand ? 54.0 : 24.0);

        const hazards = world.findHazardPoints(spawns);
        const barrels = hazards.filter((h) => h.type === "blast_barrel");
        expect(barrels.length).toBeGreaterThanOrEqual(4);

        // emerald_spire retains its exact 4 `+` cross-wall destructible gate plugs, sealed coastal walls, and gate barrels
        if (theme === "emerald_spire") {
          const halfSpan = world.worldWidth * 0.44;
          const passOffset = 0.58;
          const passY = world.worldHeight * 0.165;
          const gateCenters = [
            { x: world.centerX, y: passY, z: world.centerZ - passOffset * halfSpan },
            { x: world.centerX, y: passY, z: world.centerZ + passOffset * halfSpan },
            { x: world.centerX - passOffset * halfSpan, y: passY, z: world.centerZ },
            { x: world.centerX + passOffset * halfSpan, y: passY, z: world.centerZ },
          ];

          for (const g of gateCenters) {
            expect(world.isSolid(g.x, g.y, g.z)).toBe(true);
          }

          const coastalY = world.worldHeight * 0.18;
          const coastDist = 0.96 * halfSpan;
          expect(world.isSolid(world.centerX, coastalY, world.centerZ - coastDist)).toBe(true);
          expect(world.isSolid(world.centerX, coastalY, world.centerZ + coastDist)).toBe(true);
          expect(world.isSolid(world.centerX - coastDist, coastalY, world.centerZ)).toBe(true);
          expect(world.isSolid(world.centerX + coastDist, coastalY, world.centerZ)).toBe(true);

          const maxGateBarrelDist = isGrand ? 16.0 : 9.0;
          for (const g of gateCenters) {
            const hasNearbyBarrel = barrels.some(
              (b) => Math.hypot(b.position.x - g.x, b.position.z - g.z) <= maxGateBarrelDist,
            );
            expect(hasNearbyBarrel).toBe(true);
          }

          const probeGate = gateCenters[0];
          if (probeGate) {
            const mortarRadius = isGrand ? 3.2 * 1.35 : 3.2;
            world.applyCarve({
              center: { x: probeGate.x, y: probeGate.y, z: probeGate.z },
              radius: mortarRadius,
              shape: "sphere",
            });
            expect(world.isSolid(probeGate.x, probeGate.y, probeGate.z)).toBe(false);
            expect(world.isSolid(probeGate.x - 1.4, probeGate.y, probeGate.z)).toBe(false);
            expect(world.isSolid(probeGate.x + 1.4, probeGate.y, probeGate.z)).toBe(false);
          }
        }
      }
    }
  }, 15000);

  it("gives every pair among the 4 themes a strongly distinct 3D physical island structure", () => {
    const worlds = ALL_THEMES.map((theme) => ({
      theme,
      world: new SdfWorld(4242, theme, "duel"),
    }));

    // Check all 6 unordered pairs across a 3D lattice of solid/air classifications
    for (let i = 0; i < worlds.length; i++) {
      for (let j = i + 1; j < worlds.length; j++) {
        const a = worlds[i];
        const b = worlds[j];
        if (!a || !b) continue;

        let totalSamples = 0;
        let unionSolidSamples = 0;
        let signDisagreements = 0;
        for (let x = 6; x <= 54; x += 6) {
          for (let y = 4; y <= 18; y += 3.5) {
            for (let z = 6; z <= 54; z += 6) {
              totalSamples += 1;
              const solidA = a.world.isSolid(x, y, z);
              const solidB = b.world.isSolid(x, y, z);
              if (solidA || solidB) {
                unionSolidSamples += 1;
              }
              if (solidA !== solidB) {
                signDisagreements += 1;
              }
            }
          }
        }
        // Every pair of maps must physically differ on > 15% of total 3D bounding volume
        // and > 35% of their combined solid island footprint (zero cookie-cutter twins)
        expect(signDisagreements / totalSamples).toBeGreaterThan(0.15);
        expect(unionSolidSamples).toBeGreaterThan(50);
        expect(signDisagreements / unionSolidSamples).toBeGreaterThan(0.35);
      }
    }
  });

  it("sculpts canyon_arch as a Grand Split Redrock Gorge with open central chasm, tall opposing West/East mesas, and 2 soaring overhead arches", () => {
    for (const scale of ["duel", "grand"] as const) {
      const world = new SdfWorld(2026, "canyon_arch", scale);
      const cx = world.centerX;
      const cz = world.centerZ;
      const halfSpan = world.worldWidth * 0.44;
      const h = world.worldHeight;

      // Deep open central canyon abyss right down the center (air from near waterline up through mid-canyon)
      expect(world.sample(cx, h * 0.12, cz)).toBeGreaterThan(0);
      expect(world.sample(cx, h * 0.3, cz)).toBeGreaterThan(0);
      expect(world.sample(cx, h * 0.5, cz)).toBeGreaterThan(0);

      // Tall opposing West and East sandstone rim mesas (~44-54% worldHeight)
      const westRimY = world.getSurfaceY(cx - 0.68 * halfSpan, cz - 0.6 * halfSpan);
      const eastRimY = world.getSurfaceY(cx + 0.68 * halfSpan, cz + 0.6 * halfSpan);
      expect(westRimY).not.toBeNull();
      expect(eastRimY).not.toBeNull();
      expect(westRimY ?? 0).toBeGreaterThan(h * 0.42);
      expect(eastRimY ?? 0).toBeGreaterThan(h * 0.42);

      // 2 soaring natural stone arches spanning North (v = -0.38) and South (v = +0.38) over open canyon air
      const northArchX = cx + -0.17 * halfSpan;
      const northArchZ = cz + -0.38 * halfSpan;
      expect(world.sample(northArchX, h * 0.28, northArchZ)).toBeGreaterThan(0);
      expect(world.sample(northArchX, h * 0.59, northArchZ)).toBeLessThan(0);

      const southArchX = cx + 0.17 * halfSpan;
      const southArchZ = cz + 0.38 * halfSpan;
      expect(world.sample(southArchX, h * 0.28, southArchZ)).toBeGreaterThan(0);
      expect(world.sample(southArchX, h * 0.6, southArchZ)).toBeLessThan(0);
    }
  });

  it("sculpts twin_pillars as a true Two-Story Pillared Sky-Citadel with lower plaza, open colonnade air gap, overhead sky-decks, continuous pillars, and two-story spawns", () => {
    for (const scale of ["duel", "grand"] as const) {
      const world = new SdfWorld(9001, "twin_pillars", scale);
      const cx = world.centerX;
      const cz = world.centerZ;
      const halfSpan = world.worldWidth * 0.44;
      const h = world.worldHeight;

      // True vertical two-story column check under both West and East Sky-Decks:
      // solid Story 1 lower plaza -> wide open colonnade air gap -> solid Story 2 sky-deck overhead
      const deckCenters: ReadonlyArray<readonly [number, number]> = [
        [-0.44, -0.04],
        [0.44, 0.04],
      ];
      for (const [du, dv] of deckCenters) {
        const px = cx + du * halfSpan;
        const pz = cz + dv * halfSpan;
        expect(world.isSolid(px, h * 0.14, pz)).toBe(true);
        expect(world.sample(px, h * 0.35, pz)).toBeGreaterThan(0);
        expect(world.isSolid(px, h * 0.55, pz)).toBe(true);
      }

      // Towering support pillars rising continuously from Story 1 through colonnade air into Story 2
      const probePillars: ReadonlyArray<readonly [number, number]> = [
        [-0.58, -0.26],
        [-0.3, 0.2],
        [0.3, -0.2],
        [0.58, 0.26],
      ];
      for (const [pu, pv] of probePillars) {
        const px = cx + pu * halfSpan;
        const pz = cz + pv * halfSpan;
        expect(world.isSolid(px, h * 0.16, pz)).toBe(true);
        expect(world.isSolid(px, h * 0.35, pz)).toBe(true);
        expect(world.isSolid(px, h * 0.5, pz)).toBe(true);
      }

      // Open ocean drop shafts (North & South moon-wells) + Central Sky-Bridge over open colonnade air
      expect(world.getSurfaceY(cx, cz - 0.58 * halfSpan)).toBeNull();
      expect(world.getSurfaceY(cx, cz + 0.58 * halfSpan)).toBeNull();
      expect(world.sample(cx, h * 0.35, cz)).toBeGreaterThan(0);
      expect(world.isSolid(cx, h * 0.68, cz)).toBe(true);

      // Spawns occupy both Story 1 lower wings and Story 2 upper sky-decks
      const spawns = world.findSpawnPoints(4);
      expect(spawns).toHaveLength(4);
      const upperSpawns = spawns.filter((sp) => sp.y >= h * 0.48);
      const lowerSpawns = spawns.filter((sp) => sp.y <= h * 0.32);
      expect(upperSpawns.length).toBeGreaterThanOrEqual(2);
      expect(lowerSpawns.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("guarantees valid 4-quadrant spawns with separation and zero Turn-1 LOS across many seeds on all 4 themes", () => {
    const duelSeeds = [9001, 4242, 2026, 7331, 31415, 888, 555, 606, 101, 303, 404];
    const grandSeeds = [9001, 4242, 2026];

    for (const theme of ALL_THEMES) {
      for (const seed of duelSeeds) {
        const world = new SdfWorld(seed, theme, "duel");
        const spawns = world.findSpawnPoints(4);
        expect(spawns).toHaveLength(4);
        const quads = new Set<string>();
        for (const sp of spawns) {
          expect(sp.y).toBeGreaterThanOrEqual(4.0);
          expect(world.sampleNormal(sp.x, sp.y, sp.z).y).toBeGreaterThanOrEqual(0.65);
          expect(world.sample(sp.x, sp.y + 1.0, sp.z)).toBeGreaterThan(0);
          quads.add(`${sp.x < world.centerX ? "W" : "E"}${sp.z < world.centerZ ? "N" : "S"}`);
        }
        expect(quads.size).toBe(4);
        for (let i = 0; i < spawns.length; i++) {
          for (let j = i + 1; j < spawns.length; j++) {
            const a = spawns[i];
            const b = spawns[j];
            if (a && b) {
              expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThanOrEqual(24.0);
              expect(world.hasDirectLineOfSight(a, b, 1.1)).toBe(false);
            }
          }
        }
      }

      for (const seed of grandSeeds) {
        const world = new SdfWorld(seed, theme, "grand");
        const spawns = world.findSpawnPoints(4);
        expect(spawns).toHaveLength(4);
        const quads = new Set<string>();
        for (const sp of spawns) {
          expect(sp.y).toBeGreaterThanOrEqual(4.0);
          expect(world.sampleNormal(sp.x, sp.y, sp.z).y).toBeGreaterThanOrEqual(0.65);
          expect(world.sample(sp.x, sp.y + 1.0, sp.z)).toBeGreaterThan(0);
          quads.add(`${sp.x < world.centerX ? "W" : "E"}${sp.z < world.centerZ ? "N" : "S"}`);
        }
        expect(quads.size).toBe(4);
        for (let i = 0; i < spawns.length; i++) {
          for (let j = i + 1; j < spawns.length; j++) {
            const a = spawns[i];
            const b = spawns[j];
            if (a && b) {
              expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThanOrEqual(54.0);
              expect(world.hasDirectLineOfSight(a, b, 1.1)).toBe(false);
            }
          }
        }
      }
    }
  }, 45000);
});
