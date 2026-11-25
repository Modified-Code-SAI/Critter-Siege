import type { CarveOp, ThemeId, Vec3 } from "./types.js";
import { createSeededRng } from "./rng.js";

/** Fixed voxel grid & chunk geometry constants for Critter Siege SDF worlds. */
export const SDF_DIMS = {
  nx: 48,
  ny: 28,
  nz: 48,
  voxelSize: 0.5,
  chunkSize: 16,
} as const;

/** Chunk index triple identifying one of the 18 terrain chunks (3 x 2 x 3). */
export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

const OUTSIDE_AIR_VALUE = 2.0;
const BORDER_AIR_MIN = 1.5;
const CHUNKS_X = Math.ceil(SDF_DIMS.nx / SDF_DIMS.chunkSize);
const CHUNKS_Y = Math.ceil(SDF_DIMS.ny / SDF_DIMS.chunkSize);
const CHUNKS_Z = Math.ceil(SDF_DIMS.nz / SDF_DIMS.chunkSize);
const WORLD_CENTER_X = SDF_DIMS.nx * SDF_DIMS.voxelSize * 0.5;
const WORLD_CENTER_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize * 0.5;

/** Format a deterministic map key for a chunk coordinate. */
export function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Polynomial smooth minimum for organic sculpted SDF unions. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Polynomial smooth maximum for organic sculpted SDF intersections/subtractions. */
function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

function sdSphere(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): number {
  return Math.hypot(px - cx, py - cy, pz - cz) - r;
}

function sdEllipsoid(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
): number {
  const qx = (px - cx) / rx;
  const qy = (py - cy) / ry;
  const qz = (pz - cz) / rz;
  const k0 = Math.hypot(qx, qy, qz);
  if (k0 < 1e-6) {
    return -Math.min(rx, ry, rz);
  }
  const k1 = Math.hypot(qx / rx, qy / ry, qz / rz);
  return (k0 * (k0 - 1.0)) / Math.max(k1, 1e-6);
}

function sdTaperedPlateau(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cz: number,
  bottomY: number,
  topY: number,
  bottomRadius: number,
  topRadius: number,
  bevel: number,
): number {
  const h = Math.max(0.2, topY - bottomY);
  const t = Math.max(0, Math.min(1, (py - bottomY) / h));
  const midRadius = Math.max(topRadius * 1.16, bottomRadius);
  let rAtY: number;
  if (t < 0.26) {
    // Floating rock underside tapers gracefully inward below the cliff waist
    const u = t / 0.26;
    const smoothU = u * u * (3 - 2 * u);
    rAtY = bottomRadius * 0.75 + (midRadius - bottomRadius * 0.75) * smoothU;
  } else {
    // Terracotta cliff faces slope smoothly inward toward the grassy plateau crown
    const u = (t - 0.26) / 0.74;
    const smoothU = u * u * (3 - 2 * u);
    rAtY = midRadius + (topRadius * 0.88 - midRadius) * smoothU;
  }
  const radial = Math.hypot(px - cx, pz - cz) - Math.max(0.1, rAtY - bevel);
  const halfH = Math.max(0.1, h * 0.5 - bevel);
  const midY = (bottomY + topY) * 0.5;
  const vertical = Math.abs(py - midY) - halfH;
  const outX = Math.max(radial, 0);
  const outY = Math.max(vertical, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(radial, vertical), 0) - bevel;
}

function sdStoneArch(
  px: number,
  py: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  baseY: number,
  apexY: number,
  width: number,
  thickness: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const span = Math.hypot(dx, dz);
  if (span < 1e-5) {
    return sdSphere(px, py, pz, ax, apexY, az, thickness);
  }
  const ux = dx / span;
  const uz = dz / span;
  const proj = (px - ax) * ux + (pz - az) * uz;
  const t = Math.max(0, Math.min(1, proj / span));
  const clampedProj = t * span;
  const cx = ax + ux * clampedProj;
  const cz = az + uz * clampedProj;
  const archY = baseY + 4 * t * (1 - t) * (apexY - baseY);

  const distXZ = Math.hypot(px - cx, pz - cz);
  const distY = Math.abs(py - archY);
  const nx = distXZ / Math.max(0.2, width);
  const ny = distY / Math.max(0.2, thickness);
  const normDist = Math.hypot(nx, ny);
  return (normDist - 1.0) * Math.min(width, thickness);
}

function distToSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  if (abLenSq < 1e-8) {
    return Math.hypot(px - ax, py - ay, pz - az);
  }
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / abLenSq),
  );
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const cz = az + abz * t;
  return Math.hypot(px - cx, py - cy, pz - cz);
}

/** Deterministic 3D smooth value noise sampler seeded via Mulberry32. */
function createValueNoise3D(seed: number): (x: number, y: number, z: number) => number {
  const rng = createSeededRng(seed ^ 0x9e3779b9);
  const perm = new Uint8Array(256);
  const vals = new Float32Array(256);

  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = rng() * 2 - 1;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = perm[i] ?? 0;
    perm[i] = perm[j] ?? 0;
    perm[j] = tmp;
  }

  const hash = (ix: number, iy: number, iz: number): number => {
    const hx = perm[ix & 255] ?? 0;
    const hy = perm[(hx + iy) & 255] ?? 0;
    const hz = perm[(hy + iz) & 255] ?? 0;
    return vals[hz] ?? 0;
  };

  return (x: number, y: number, z: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fy = y - y0;
    const fz = z - z0;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const uz = fz * fz * (3 - 2 * fz);

    const c000 = hash(x0, y0, z0);
    const c100 = hash(x0 + 1, y0, z0);
    const c010 = hash(x0, y0 + 1, z0);
    const c110 = hash(x0 + 1, y0 + 1, z0);
    const c001 = hash(x0, y0, z0 + 1);
    const c101 = hash(x0 + 1, y0, z0 + 1);
    const c011 = hash(x0, y0 + 1, z0 + 1);
    const c111 = hash(x0 + 1, y0 + 1, z0 + 1);

    const x00 = c000 + (c100 - c000) * ux;
    const x10 = c010 + (c110 - c010) * ux;
    const x01 = c001 + (c101 - c001) * ux;
    const x11 = c011 + (c111 - c011) * ux;

    const y0v = x00 + (x10 - x00) * uy;
    const y1v = x01 + (x11 - x01) * uy;

    return y0v + (y1v - y0v) * uz;
  };
}

interface ThemeJitter {
  westHeight: number;
  eastHeight: number;
  archBoost: number;
  northShift: number;
  southShift: number;
}

function evaluateThemeSdf(
  theme: ThemeId,
  x: number,
  y: number,
  z: number,
  j: ThemeJitter,
  noise: (nx: number, ny: number, nz: number) => number,
): number {
  const n1 = noise(x * 0.24, y * 0.24, z * 0.24);
  const n2 = noise(x * 0.52 + 17.3, y * 0.52 + 5.1, z * 0.52 - 11.7);
  const organicNoise = n1 * 0.28 + n2 * 0.11;

  if (theme === "emerald_spire") {
    // Twin grassy plateaus linked by a smooth curved stone arch over a central channel
    const westPlateau = sdTaperedPlateau(
      x,
      y,
      z,
      7.2,
      12.0 + j.northShift,
      2.0,
      8.3 + j.westHeight,
      2.6,
      4.6,
      0.85,
    );
    const eastPlateau = sdTaperedPlateau(
      x,
      y,
      z,
      16.8,
      12.0 + j.southShift,
      2.0,
      8.6 + j.eastHeight,
      2.6,
      4.6,
      0.85,
    );
    const northHill = sdTaperedPlateau(
      x,
      y,
      z,
      12.0,
      6.4,
      2.3,
      7.2 + j.westHeight * 0.5,
      2.2,
      3.9,
      0.9,
    );
    const southHill = sdTaperedPlateau(
      x,
      y,
      z,
      12.0,
      17.6,
      2.3,
      7.0 + j.eastHeight * 0.5,
      2.2,
      3.8,
      0.9,
    );
    const spire = sdEllipsoid(
      x,
      y,
      z,
      12.0,
      8.6,
      5.8,
      1.9,
      2.8 + j.archBoost * 0.4,
      1.8,
    );

    let d = smin(westPlateau, eastPlateau, 1.4);
    d = smin(d, northHill, 1.5);
    d = smin(d, southHill, 1.5);
    d = smin(d, spire, 1.1);

    // Carve an airy channel under the central span so the arch truly bridges open air
    const channelCut = sdEllipsoid(x, y, z, 12.0, 5.2, 12.0, 2.35, 3.3, 4.0);
    d = smax(d, -channelCut, 0.8);

    // Smooth curved natural stone arch bridge linking west and east plateaus
    const archBridge = sdStoneArch(
      x,
      y,
      z,
      8.1,
      12.0 + j.northShift * 0.5,
      15.9,
      12.0 + j.southShift * 0.5,
      7.6,
      9.4 + j.archBoost,
      1.55,
      0.88,
    );
    d = smin(d, archBridge, 0.75);

    // Subtle rocky underside taper above waterline
    const skirtCut = 2.0 - y + Math.max(0, Math.hypot(x - 12, z - 12) - 7.5) * 0.35;
    d = smax(d, skirtCut, 0.65);
    return d + organicNoise;
  }

  if (theme === "canyon_arch") {
    // Dramatic U-shaped canyon rim with a wide curved stone arch and carved side alcove
    const mainRim = sdTaperedPlateau(
      x,
      y,
      z,
      12.0,
      11.6,
      2.0,
      9.0 + j.westHeight * 0.6,
      5.8,
      8.6,
      0.95,
    );
    const northCrown = sdTaperedPlateau(
      x,
      y,
      z,
      12.0 + j.northShift,
      6.4,
      3.0,
      9.7 + j.eastHeight * 0.5,
      3.0,
      4.4,
      0.85,
    );
    let d = smin(mainRim, northCrown, 1.4);

    // Carve dramatic U-shaped canyon opening southward
    const canyonCore =
      distToSegment(x, y, z, 12.0, 6.8, 10.6, 12.0, 6.4, 21.5) - 3.0;
    const canyonUpper = sdEllipsoid(x, y, z, 12.0, 9.2, 14.5, 3.6, 3.6, 5.8);
    const canyonCut = smin(canyonCore, canyonUpper, 1.0);
    d = smax(d, -canyonCut, 0.85);

    // Carved side alcove along the northwest inner canyon wall
    const alcove = sdEllipsoid(x, y, z, 8.6, 5.9, 10.2, 2.0, 1.6, 2.1);
    d = smax(d, -alcove, 0.55);

    // Wide curved stone arch spanning the canyon mouth
    const canyonArch = sdStoneArch(
      x,
      y,
      z,
      6.8,
      15.2,
      17.2,
      15.2,
      7.4,
      9.8 + j.archBoost,
      1.65,
      0.95,
    );
    d = smin(d, canyonArch, 0.8);

    return d + organicNoise;
  }

  // 'twin_pillars': Two high sculpted mesas connected by a low saddle ridge and overhanging ledges
  const westMesa = sdTaperedPlateau(
    x,
    y,
    z,
    7.2,
    9.8 + j.northShift * 0.5,
    2.0,
    9.6 + j.westHeight,
    2.4,
    4.6,
    0.85,
  );
  const eastMesa = sdTaperedPlateau(
    x,
    y,
    z,
    16.8,
    14.2 + j.southShift * 0.5,
    2.0,
    9.9 + j.eastHeight,
    2.4,
    4.6,
    0.85,
  );
  const saddle = sdStoneArch(
    x,
    y,
    z,
    7.6,
    10.0,
    16.4,
    14.0,
    5.8,
    6.4 + j.archBoost * 0.5,
    2.1,
    1.25,
  );
  const saddleBase = sdTaperedPlateau(
    x,
    y,
    z,
    12.0,
    12.0,
    2.2,
    6.3,
    2.2,
    3.5,
    0.9,
  );

  // Overhanging cliff ledges on opposite flanks
  const northEastLedge = sdEllipsoid(x, y, z, 16.4, 7.0, 7.8, 3.0, 1.15, 2.7);
  const southWestLedge = sdEllipsoid(x, y, z, 7.6, 6.8, 16.2, 3.0, 1.15, 2.7);

  let d = smin(westMesa, eastMesa, 1.3);
  d = smin(d, saddle, 1.1);
  d = smin(d, saddleBase, 1.2);
  d = smin(d, northEastLedge, 0.85);
  d = smin(d, southWestLedge, 0.85);

  // Carve dramatic underside hollows beneath the overhanging cliff ledges
  const underNE = sdEllipsoid(x, y, z, 16.6, 4.8, 7.6, 2.5, 1.4, 2.3);
  const underSW = sdEllipsoid(x, y, z, 7.4, 4.6, 16.4, 2.5, 1.4, 2.3);
  d = smax(d, -underNE, 0.55);
  d = smax(d, -underSW, 0.55);

  return d + organicNoise;
}

/**
 * Deterministic 3D Signed Distance Field sculpted sky-island terrain world.
 * Sign convention: negative (< 0) = solid rock/earth, positive (> 0) = air, 0 = smooth surface.
 */
export class SdfWorld {
  public readonly seed: number;
  public readonly theme: ThemeId;

  private readonly values: Float32Array;
  private readonly carveLog: CarveOp[] = [];

  public constructor(seed: number, theme: ThemeId) {
    this.seed = seed;
    this.theme = theme;
    this.values = new Float32Array(SDF_DIMS.nx * SDF_DIMS.ny * SDF_DIMS.nz);
    this.generateTerrain();
  }

  /** Read raw SDF grid value at integer voxel index, returning +2.0 outside bounds. */
  public getValue(ix: number, iy: number, iz: number): number {
    if (
      !(
        ix >= 0 &&
        ix < SDF_DIMS.nx &&
        iy >= 0 &&
        iy < SDF_DIMS.ny &&
        iz >= 0 &&
        iz < SDF_DIMS.nz
      )
    ) {
      return OUTSIDE_AIR_VALUE;
    }
    const x = Math.trunc(ix);
    const y = Math.trunc(iy);
    const z = Math.trunc(iz);
    const idx = x + SDF_DIMS.nx * (y + SDF_DIMS.ny * z);
    return this.values[idx] ?? OUTSIDE_AIR_VALUE;
  }

  /** Trilinearly sample the SDF in world meters ([0..24, 0..14, 0..24]), returning +2.0 outside. */
  public sample(x: number, y: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return OUTSIDE_AIR_VALUE;
    }
    const gx = x / SDF_DIMS.voxelSize;
    const gy = y / SDF_DIMS.voxelSize;
    const gz = z / SDF_DIMS.voxelSize;

    if (
      gx < 0 ||
      gy < 0 ||
      gz < 0 ||
      gx >= SDF_DIMS.nx ||
      gy >= SDF_DIMS.ny ||
      gz >= SDF_DIMS.nz
    ) {
      return OUTSIDE_AIR_VALUE;
    }

    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;

    const c000 = this.getValue(x0, y0, z0);
    const c100 = this.getValue(x0 + 1, y0, z0);
    const c010 = this.getValue(x0, y0 + 1, z0);
    const c110 = this.getValue(x0 + 1, y0 + 1, z0);
    const c001 = this.getValue(x0, y0, z0 + 1);
    const c101 = this.getValue(x0 + 1, y0, z0 + 1);
    const c011 = this.getValue(x0, y0 + 1, z0 + 1);
    const c111 = this.getValue(x0 + 1, y0 + 1, z0 + 1);

    const x00 = c000 + (c100 - c000) * fx;
    const x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx;
    const x11 = c011 + (c111 - c011) * fx;

    const y0v = x00 + (x10 - x00) * fy;
    const y1v = x01 + (x11 - x01) * fy;

    return y0v + (y1v - y0v) * fz;
  }

  /** Compute outward-pointing unit normal via central differences; never returns NaN. */
  public sampleNormal(x: number, y: number, z: number): Vec3 {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return { x: 0, y: 1, z: 0 };
    }
    const eps = SDF_DIMS.voxelSize * 0.5;
    const dx = this.sample(x + eps, y, z) - this.sample(x - eps, y, z);
    const dy = this.sample(x, y + eps, z) - this.sample(x, y - eps, z);
    const dz = this.sample(x, y, z + eps) - this.sample(x, y, z - eps);
    const len = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(len) || len < 1e-5) {
      return { x: 0, y: 1, z: 0 };
    }
    return { x: dx / len, y: dy / len, z: dz / len };
  }

  /** Returns true when world coordinate (x, y, z) lies inside solid rock/earth. */
  public isSolid(x: number, y: number, z: number): boolean {
    return this.sample(x, y, z) < 0;
  }

  /**
   * Smoothly subtract a sphere or capsule volume from the SDF within clamped interior bounds.
   * Records the carve op and returns deduplicated dirty chunk keys.
   */
  public applyCarve(op: CarveOp): string[] {
    if (
      !Number.isFinite(op.radius) ||
      op.radius <= 0 ||
      !isFiniteVec3(op.center)
    ) {
      return [];
    }

    const endPoint =
      op.shape === "capsule" && op.end && isFiniteVec3(op.end)
        ? { ...op.end }
        : undefined;

    const recorded: CarveOp = endPoint
      ? {
          center: { ...op.center },
          radius: op.radius,
          shape: op.shape,
          end: endPoint,
        }
      : {
          center: { ...op.center },
          radius: op.radius,
          shape: op.shape,
        };
    this.carveLog.push(recorded);

    const vs = SDF_DIMS.voxelSize;
    const pad = op.radius + vs * 2;
    const bx = endPoint ? endPoint.x : op.center.x;
    const by = endPoint ? endPoint.y : op.center.y;
    const bz = endPoint ? endPoint.z : op.center.z;

    const minX = Math.min(op.center.x, bx) - pad;
    const maxX = Math.max(op.center.x, bx) + pad;
    const minY = Math.min(op.center.y, by) - pad;
    const maxY = Math.max(op.center.y, by) + pad;
    const minZ = Math.min(op.center.z, bz) - pad;
    const maxZ = Math.max(op.center.z, bz) + pad;

    // Clamp strictly inside [1..nx-2, 1..ny-2, 1..nz-2] so boundary air shell stays intact
    const minIx = Math.max(1, Math.floor(minX / vs));
    const maxIx = Math.min(SDF_DIMS.nx - 2, Math.ceil(maxX / vs));
    const minIy = Math.max(1, Math.floor(minY / vs));
    const maxIy = Math.min(SDF_DIMS.ny - 2, Math.ceil(maxY / vs));
    const minIz = Math.max(1, Math.floor(minZ / vs));
    const maxIz = Math.min(SDF_DIMS.nz - 2, Math.ceil(maxZ / vs));

    if (minIx > maxIx || minIy > maxIy || minIz > maxIz) {
      return [];
    }

    const dirtyChunks = new Set<string>();
    const isCapsule = op.shape === "capsule" && endPoint !== undefined;

    for (let iz = minIz; iz <= maxIz; iz++) {
      const wz = iz * vs;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const wy = iy * vs;
        const rowBase = SDF_DIMS.nx * (iy + SDF_DIMS.ny * iz);
        for (let ix = minIx; ix <= maxIx; ix++) {
          const wx = ix * vs;
          const dist = isCapsule
            ? distToSegment(
                wx,
                wy,
                wz,
                op.center.x,
                op.center.y,
                op.center.z,
                bx,
                by,
                bz,
              )
            : Math.hypot(
                wx - op.center.x,
                wy - op.center.y,
                wz - op.center.z,
              );
          const carvedVal = op.radius - dist;
          const idx = ix + rowBase;
          const oldVal = this.values[idx] ?? OUTSIDE_AIR_VALUE;
          if (carvedVal > oldVal) {
            this.values[idx] = carvedVal;
            this.markDirtyChunksForVoxel(ix, iy, iz, dirtyChunks);
          }
        }
      }
    }

    return Array.from(dirtyChunks);
  }

  /** Erode outer island terrain beyond radiusFromCenter for sudden-death ledge crumble. */
  public crumbleOuterRing(radiusFromCenter: number): string[] {
    if (!Number.isFinite(radiusFromCenter)) {
      return [];
    }
    const radius = Math.max(0, radiusFromCenter);
    const vs = SDF_DIMS.voxelSize;
    const dirtyChunks = new Set<string>();

    for (let iz = 1; iz <= SDF_DIMS.nz - 2; iz++) {
      const dz = iz * vs - WORLD_CENTER_Z;
      for (let iy = 1; iy <= SDF_DIMS.ny - 2; iy++) {
        const rowBase = SDF_DIMS.nx * (iy + SDF_DIMS.ny * iz);
        for (let ix = 1; ix <= SDF_DIMS.nx - 2; ix++) {
          const dx = ix * vs - WORLD_CENTER_X;
          const radial = Math.hypot(dx, dz);
          const erodeVal = radial - radius;
          if (erodeVal <= -1.5) {
            continue;
          }
          const idx = ix + rowBase;
          const oldVal = this.values[idx] ?? OUTSIDE_AIR_VALUE;
          if (erodeVal > oldVal) {
            this.values[idx] = erodeVal;
            this.markDirtyChunksForVoxel(ix, iy, iz, dirtyChunks);
          }
        }
      }
    }

    return Array.from(dirtyChunks);
  }

  /**
   * Scan top-down at (x, z) for the highest air-to-solid crossing and refine
   * with 4 binary search steps. Returns null if the column is all air.
   */
  public getSurfaceY(x: number, z: number): number | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return null;
    }
    const step = SDF_DIMS.voxelSize * 0.5;
    const maxY = (SDF_DIMS.ny - 2) * SDF_DIMS.voxelSize;
    const minY = SDF_DIMS.voxelSize;

    let prevY = maxY;
    let prevVal = this.sample(x, prevY, z);

    for (let y = maxY - step; y >= minY; y -= step) {
      const currVal = this.sample(x, y, z);
      if (prevVal >= 0 && currVal < 0) {
        let lo = y;
        let hi = prevY;
        for (let iter = 0; iter < 4; iter++) {
          const mid = (lo + hi) * 0.5;
          if (this.sample(x, mid, z) < 0) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        return (lo + hi) * 0.5;
      }
      prevY = y;
      prevVal = currVal;
    }

    return null;
  }

  /**
   * Deterministically pick `count` well-separated walkable high-ground spawn
   * points (y >= 3.0, normal.y >= 0.65) around the sculpted island.
   */
  public findSpawnPoints(count: number): Vec3[] {
    if (!Number.isFinite(count) || count <= 0) {
      return [];
    }
    const targetCount = Math.floor(count);
    const rng = createSeededRng(this.seed ^ 0x51a9c3);

    interface SpawnCandidate {
      pos: Vec3;
      score: number;
    }

    const candidates: SpawnCandidate[] = [];
    for (let x = 2.5; x <= 21.5; x += 0.75) {
      for (let z = 2.5; z <= 21.5; z += 0.75) {
        const surfaceY = this.getSurfaceY(x, z);
        if (surfaceY === null || surfaceY < 3.0) {
          continue;
        }
        const normal = this.sampleNormal(x, surfaceY, z);
        if (normal.y < 0.65) {
          continue;
        }
        // Require clear headroom above the spawn point
        if (
          this.sample(x, surfaceY + 0.8, z) <= 0.1 ||
          this.sample(x, surfaceY + 1.5, z) <= 0.1
        ) {
          continue;
        }
        const radialFromCenter = Math.hypot(
          x - WORLD_CENTER_X,
          z - WORLD_CENTER_Z,
        );
        const score =
          surfaceY * 1.2 +
          normal.y * 2.0 +
          Math.min(radialFromCenter, 7.0) * 0.15 +
          rng() * 0.35;
        candidates.push({ pos: { x, y: surfaceY, z }, score });
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    candidates.sort((a, b) => b.score - a.score);

    const selected: Vec3[] = [];
    const first = candidates[0];
    if (first) {
      selected.push({ ...first.pos });
    }

    while (selected.length < targetCount && selected.length < candidates.length) {
      let bestCandidate: SpawnCandidate | null = null;
      let bestMetric = -Infinity;

      for (const cand of candidates) {
        let minDist = Infinity;
        for (const existing of selected) {
          const d = Math.hypot(
            cand.pos.x - existing.x,
            cand.pos.y - existing.y,
            cand.pos.z - existing.z,
          );
          if (d < minDist) {
            minDist = d;
          }
        }
        if (minDist < 0.01) {
          continue;
        }
        const metric = minDist + cand.pos.y * 0.12 + cand.score * 0.02;
        if (metric > bestMetric) {
          bestMetric = metric;
          bestCandidate = cand;
        }
      }

      if (!bestCandidate) {
        break;
      }
      selected.push({ ...bestCandidate.pos });
    }

    return selected;
  }

  /** Return a shallow copy of all applied carve operations. */
  public getCarveLog(): CarveOp[] {
    return this.carveLog.map((op) =>
      op.end
        ? {
            center: { ...op.center },
            radius: op.radius,
            shape: op.shape,
            end: { ...op.end },
          }
        : {
            center: { ...op.center },
            radius: op.radius,
            shape: op.shape,
          },
    );
  }

  /** Return all 18 chunk coordinates covering the SDF world (3 x 2 x 3). */
  public getAllChunkCoords(): ChunkCoord[] {
    const coords: ChunkCoord[] = [];
    for (let cy = 0; cy < CHUNKS_Y; cy++) {
      for (let cz = 0; cz < CHUNKS_Z; cz++) {
        for (let cx = 0; cx < CHUNKS_X; cx++) {
          coords.push({ cx, cy, cz });
        }
      }
    }
    return coords;
  }

  private generateTerrain(): void {
    const rng = createSeededRng(this.seed);
    const jitter: ThemeJitter = {
      westHeight: (rng() - 0.5) * 0.8,
      eastHeight: (rng() - 0.5) * 0.8,
      archBoost: (rng() - 0.5) * 0.5,
      northShift: (rng() - 0.5) * 0.8,
      southShift: (rng() - 0.5) * 0.8,
    };
    const noise = createValueNoise3D(this.seed);
    const vs = SDF_DIMS.voxelSize;

    for (let iz = 0; iz < SDF_DIMS.nz; iz++) {
      const wz = iz * vs;
      const zBorder = iz <= 1 || iz >= SDF_DIMS.nz - 2;
      for (let iy = 0; iy < SDF_DIMS.ny; iy++) {
        const wy = iy * vs;
        const yBorder = iy <= 1 || iy >= SDF_DIMS.ny - 2;
        const rowBase = SDF_DIMS.nx * (iy + SDF_DIMS.ny * iz);
        for (let ix = 0; ix < SDF_DIMS.nx; ix++) {
          const xBorder = ix <= 1 || ix >= SDF_DIMS.nx - 2;
          const idx = ix + rowBase;
          if (xBorder || yBorder || zBorder) {
            this.values[idx] = BORDER_AIR_MIN;
            continue;
          }
          const wx = ix * vs;
          const d = evaluateThemeSdf(this.theme, wx, wy, wz, jitter, noise);
          this.values[idx] = Number.isFinite(d) ? d : BORDER_AIR_MIN;
        }
      }
    }
  }

  private markDirtyChunksForVoxel(
    ix: number,
    iy: number,
    iz: number,
    dirtyChunks: Set<string>,
  ): void {
    const cs = SDF_DIMS.chunkSize;
    const minCx = Math.max(0, Math.floor((ix - 2) / cs));
    const maxCx = Math.min(CHUNKS_X - 1, Math.floor((ix + 1) / cs));
    const minCy = Math.max(0, Math.floor((iy - 2) / cs));
    const maxCy = Math.min(CHUNKS_Y - 1, Math.floor((iy + 1) / cs));
    const minCz = Math.max(0, Math.floor((iz - 2) / cs));
    const maxCz = Math.min(CHUNKS_Z - 1, Math.floor((iz + 1) / cs));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          dirtyChunks.add(chunkKey(cx, cy, cz));
        }
      }
    }
  }
}
