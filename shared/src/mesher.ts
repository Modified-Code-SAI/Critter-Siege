import type { SdfWorld } from "./sdf.js";

/** Indexed smooth triangle mesh buffers produced for a single terrain chunk. */
export interface ChunkMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

const CORNER_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

const CUBE_EDGES: ReadonlyArray<readonly [number, number]> = [
  // X-aligned edges
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  // Y-aligned edges
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  // Z-aligned edges
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function pickTerrainColor(
  worldX: number,
  worldY: number,
  worldZ: number,
  normalY: number,
  theme: SdfWorld["theme"],
  worldHeight: number,
): readonly [number, number, number] {
  // Deterministic world-space organic color variation for sculpted natural biomes
  const patch =
    Math.sin(worldX * 0.17 + Math.cos(worldZ * 0.15) * 1.4) *
    Math.cos(worldZ * 0.19 - worldX * 0.07);
  const micro = Math.sin(worldX * 0.43 - worldZ * 0.39 + worldY * 0.31);

  // Deep cool slate rock on arch undersides and cave roofs
  if (normalY < 0.18) {
    const shade = patch * 0.035 + micro * 0.02;
    return [
      clamp01(0.35 + shade),
      clamp01(0.39 + shade),
      clamp01(0.45 + shade * 1.15),
    ];
  }

  // Sunlit alpine snow-dusted summit caps on Mountain Spine high peaks
  if (theme === "mountain_spine" && worldY > worldHeight * 0.56 && normalY > 0.52) {
    const glint = patch * 0.025 + micro * 0.015;
    return [
      clamp01(0.89 + glint),
      clamp01(0.93 + glint),
      clamp01(0.97 + glint),
    ];
  }

  // Warm golden sandy cove shoreline near the waterline
  if (worldY <= 3.0 && normalY > 0.45) {
    const ripple = patch * 0.035 + micro * 0.02;
    return [
      clamp01(0.89 + ripple),
      clamp01(0.79 + ripple * 0.9),
      clamp01(0.54 + ripple * 0.65),
    ];
  }

  // Sunlit lush emerald meadow grass on flat tops with subtle warm/cool patches
  if (normalY > 0.66 && worldY > 3.0) {
    const altGlow = Math.min(0.06, Math.max(0, (worldY - 6.0) * 0.005));
    const warmCool = patch * 0.055 + micro * 0.022;
    if (theme === "mountain_spine") {
      // Crisp pine-alpine emerald meadow on Mountain Spine terraces
      return [
        clamp01(0.24 + warmCool * 0.9 + altGlow * 0.5),
        clamp01(0.66 + warmCool * 0.45 + altGlow),
        clamp01(0.30 - warmCool * 0.4 + altGlow * 0.4),
      ];
    }
    return [
      clamp01(0.28 + warmCool * 1.1 + altGlow * 0.6),
      clamp01(0.72 + warmCool * 0.45 + altGlow),
      clamp01(0.22 - warmCool * 0.55 + altGlow * 0.3),
    ];
  }

  // Crisp mossy transition rim between meadow tops and steep cliffs
  if (normalY > 0.48 && normalY <= 0.66) {
    const mossMix = patch * 0.04 + micro * 0.02;
    return [
      clamp01(0.42 + mossMix),
      clamp01(0.62 + mossMix * 0.5),
      clamp01(0.26 - mossMix * 0.3),
    ];
  }

  // Stratified cliff bands (cool granite/slate on Mountain Spine, warm sandstone elsewhere)
  const strata =
    Math.sin(worldY * 1.4 + patch * 0.35) * 0.065 +
    Math.sin(worldY * 3.1 + micro * 0.25) * 0.025;
  const cliffTone = patch * 0.035;
  if (theme === "mountain_spine") {
    return [
      clamp01(0.52 + strata * 0.8 + cliffTone),
      clamp01(0.56 + strata * 0.78 + cliffTone),
      clamp01(0.62 + strata * 0.72 + cliffTone),
    ];
  }
  return [
    clamp01(0.77 + strata + cliffTone),
    clamp01(0.48 + strata * 0.78 + cliffTone * 0.6),
    clamp01(0.29 + strata * 0.52 + cliffTone * 0.35),
  ];
}

function emitQuad(
  indices: number[],
  positions: number[],
  a: number,
  b: number,
  c: number,
  d: number,
  flipWinding: boolean,
): void {
  const ax = positions[a * 3] ?? 0;
  const ay = positions[a * 3 + 1] ?? 0;
  const az = positions[a * 3 + 2] ?? 0;
  const bx = positions[b * 3] ?? 0;
  const by = positions[b * 3 + 1] ?? 0;
  const bz = positions[b * 3 + 2] ?? 0;
  const cx = positions[c * 3] ?? 0;
  const cy = positions[c * 3 + 1] ?? 0;
  const cz = positions[c * 3 + 2] ?? 0;
  const dx = positions[d * 3] ?? 0;
  const dy = positions[d * 3 + 1] ?? 0;
  const dz = positions[d * 3 + 2] ?? 0;

  const diagAC = (cx - ax) * (cx - ax) + (cy - ay) * (cy - ay) + (cz - az) * (cz - az);
  const diagBD = (dx - bx) * (dx - bx) + (dy - by) * (dy - by) + (dz - bz) * (dz - bz);

  if (diagAC <= diagBD) {
    if (!flipWinding) {
      indices.push(a, b, c, a, c, d);
    } else {
      indices.push(a, c, b, a, d, c);
    }
  } else if (!flipWinding) {
    indices.push(a, b, d, b, c, d);
  } else {
    indices.push(a, d, b, b, d, c);
  }
}

/**
 * Extract a smooth Dual Surface Nets triangle mesh for chunk (cx, cy, cz).
 * Overlaps 1 cell on high borders so adjacent chunks stitch seamlessly with zero cracks.
 */
export function meshChunkSurfaceNets(
  world: SdfWorld,
  cx: number,
  cy: number,
  cz: number,
): ChunkMeshData {
  const { nx, ny, nz, voxelSize: vs, chunkSize: cs } = world.dims;
  const maxCellLimitX = nx - 2;
  const maxCellLimitY = ny - 2;
  const maxCellLimitZ = nz - 2;

  const startX = cx * cs;
  const startY = cy * cs;
  const startZ = cz * cs;

  if (
    !Number.isInteger(cx) ||
    !Number.isInteger(cy) ||
    !Number.isInteger(cz) ||
    startX < 0 ||
    startY < 0 ||
    startZ < 0 ||
    startX > maxCellLimitX ||
    startY > maxCellLimitY ||
    startZ > maxCellLimitZ
  ) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  // Owned cells: [start .. ownedEnd - 1]; vertex cells include +1 high-border overlap
  const ownedEndX = Math.min(startX + cs, nx - 1);
  const ownedEndY = Math.min(startY + cs, ny - 1);
  const ownedEndZ = Math.min(startZ + cs, nz - 1);

  const maxCellX = Math.min(ownedEndX, maxCellLimitX);
  const maxCellY = Math.min(ownedEndY, maxCellLimitY);
  const maxCellZ = Math.min(ownedEndZ, maxCellLimitZ);

  // Fast empty-chunk early-out: skip chunks whose corner voxels all share the same sign
  const firstSolid = world.getValue(startX, startY, startZ) < 0;
  let hasSignChange = false;
  scan: for (let z = startZ; z <= maxCellZ + 1; z++) {
    for (let y = startY; y <= maxCellY + 1; y++) {
      for (let x = startX; x <= maxCellX + 1; x++) {
        if ((world.getValue(x, y, z) < 0) !== firstSolid) {
          hasSignChange = true;
          break scan;
        }
      }
    }
  }
  if (!hasSignChange) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  const sizeX = maxCellX - startX + 1;
  const sizeY = maxCellY - startY + 1;
  const sizeZ = maxCellZ - startZ + 1;

  const cellToVert = new Int32Array(sizeX * sizeY * sizeZ);
  cellToVert.fill(-1);

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const corners = new Float64Array(8);

  // Pass 1: Place one smooth dual vertex inside every sign-changing cell
  for (let lz = 0; lz < sizeZ; lz++) {
    const z = startZ + lz;
    for (let ly = 0; ly < sizeY; ly++) {
      const y = startY + ly;
      const rowOffset = sizeX * (ly + sizeY * lz);
      for (let lx = 0; lx < sizeX; lx++) {
        const x = startX + lx;

        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const offset = CORNER_OFFSETS[c];
          const val = offset
            ? world.getValue(x + offset[0], y + offset[1], z + offset[2])
            : 2.0;
          corners[c] = val;
          if (val < 0) {
            mask |= 1 << c;
          }
        }

        if (mask === 0 || mask === 255) {
          continue;
        }

        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        let edgeCount = 0;

        for (let e = 0; e < 12; e++) {
          const edge = CUBE_EDGES[e];
          if (!edge) {
            continue;
          }
          const c0 = edge[0];
          const c1 = edge[1];
          const v0 = corners[c0] ?? 2.0;
          const v1 = corners[c1] ?? 2.0;
          if ((v0 < 0) === (v1 < 0)) {
            continue;
          }
          const denom = v0 - v1;
          const rawT = Math.abs(denom) > 1e-6 ? v0 / denom : 0.5;
          const t = Math.max(0, Math.min(1, Number.isFinite(rawT) ? rawT : 0.5));
          const p0 = CORNER_OFFSETS[c0];
          const p1 = CORNER_OFFSETS[c1];
          if (!p0 || !p1) {
            continue;
          }
          sumX += p0[0] + (p1[0] - p0[0]) * t;
          sumY += p0[1] + (p1[1] - p0[1]) * t;
          sumZ += p0[2] + (p1[2] - p0[2]) * t;
          edgeCount += 1;
        }

        if (edgeCount === 0) {
          continue;
        }

        const invCount = 1 / edgeCount;
        const wx = (x + sumX * invCount) * vs;
        const wy = (y + sumY * invCount) * vs;
        const wz = (z + sumZ * invCount) * vs;

        if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) {
          continue;
        }

        const normal = world.sampleNormal(wx, wy, wz);
        const rgb = pickTerrainColor(
          wx,
          wy,
          wz,
          normal.y,
          world.theme,
          world.worldHeight,
        );

        const vertIdx = positions.length / 3;
        positions.push(wx, wy, wz);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(rgb[0], rgb[1], rgb[2]);

        cellToVert[lx + rowOffset] = vertIdx;
      }
    }
  }

  const getVert = (lx: number, ly: number, lz: number): number => {
    return cellToVert[lx + sizeX * (ly + sizeY * lz)] ?? -1;
  };

  // Pass 2: Emit outward-facing quads across sign-changing interior +X, +Y, +Z edges
  const ownedCountX = ownedEndX - startX;
  const ownedCountY = ownedEndY - startY;
  const ownedCountZ = ownedEndZ - startZ;

  for (let lz = 0; lz < ownedCountZ; lz++) {
    const z = startZ + lz;
    for (let ly = 0; ly < ownedCountY; ly++) {
      const y = startY + ly;
      for (let lx = 0; lx < ownedCountX; lx++) {
        const x = startX + lx;
        const a = getVert(lx, ly, lz);
        if (a < 0) {
          continue;
        }

        // +X edge: (x, y+1, z+1) -> (x+1, y+1, z+1)
        if (ly + 1 < sizeY && lz + 1 < sizeZ) {
          const v0 = world.getValue(x, y + 1, z + 1);
          const v1 = world.getValue(x + 1, y + 1, z + 1);
          if ((v0 < 0) !== (v1 < 0)) {
            const b = getVert(lx, ly + 1, lz);
            const c = getVert(lx, ly + 1, lz + 1);
            const d = getVert(lx, ly, lz + 1);
            if (b >= 0 && c >= 0 && d >= 0) {
              emitQuad(indices, positions, a, b, c, d, v0 >= 0);
            }
          }
        }

        // +Y edge: (x+1, y, z+1) -> (x+1, y+1, z+1)
        if (lx + 1 < sizeX && lz + 1 < sizeZ) {
          const v0 = world.getValue(x + 1, y, z + 1);
          const v1 = world.getValue(x + 1, y + 1, z + 1);
          if ((v0 < 0) !== (v1 < 0)) {
            const b = getVert(lx, ly, lz + 1);
            const c = getVert(lx + 1, ly, lz + 1);
            const d = getVert(lx + 1, ly, lz);
            if (b >= 0 && c >= 0 && d >= 0) {
              emitQuad(indices, positions, a, b, c, d, v0 >= 0);
            }
          }
        }

        // +Z edge: (x+1, y+1, z) -> (x+1, y+1, z+1)
        if (lx + 1 < sizeX && ly + 1 < sizeY) {
          const v0 = world.getValue(x + 1, y + 1, z);
          const v1 = world.getValue(x + 1, y + 1, z + 1);
          if ((v0 < 0) !== (v1 < 0)) {
            const b = getVert(lx + 1, ly, lz);
            const c = getVert(lx + 1, ly + 1, lz);
            const d = getVert(lx, ly + 1, lz);
            if (b >= 0 && c >= 0 && d >= 0) {
              emitQuad(indices, positions, a, b, c, d, v0 >= 0);
            }
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
