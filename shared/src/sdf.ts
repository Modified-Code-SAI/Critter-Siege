import type {
  CarveOp,
  HazardType,
  MapScale,
  SdfDimensions,
  ThemeId,
  Vec3,
} from "./types.js";
import { createSeededRng } from "./rng.js";

/** Sculpted SDF voxel grid & chunk geometry presets for 2p Duel (60m) vs 4p Grand (144m). */
export const SDF_PRESETS = {
  duel: {
    nx: 80,
    ny: 36,
    nz: 80,
    voxelSize: 0.75,
    chunkSize: 16,
  },
  grand: {
    nx: 128,
    ny: 44,
    nz: 128,
    voxelSize: 1.125,
    chunkSize: 16,
  },
} as const satisfies Record<MapScale, SdfDimensions>;

/** Backward-compatible 60m Duel voxel grid & chunk geometry constants. */
export const SDF_DIMS = SDF_PRESETS.duel;

/** Chunk index triple identifying a single terrain chunk in the SDF grid. */
export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

/** Deterministic world placement specification for an interactive environmental hazard. */
export interface HazardPlacement {
  type: HazardType;
  position: Vec3;
  radius: number;
}

const OUTSIDE_AIR_VALUE = 2.0;
const BORDER_AIR_MIN = 1.5;

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
  const midRadius = Math.max(topRadius * 1.12, bottomRadius);
  let rAtY: number;
  if (t < 0.26) {
    const u = t / 0.26;
    const smoothU = u * u * (3 - 2 * u);
    rAtY = bottomRadius * 0.72 + (midRadius - bottomRadius * 0.72) * smoothU;
  } else {
    const u = (t - 0.26) / 0.74;
    const smoothU = u * u * (3 - 2 * u);
    rAtY = midRadius + (topRadius * 0.92 - midRadius) * smoothU;
  }
  const radial = Math.hypot(px - cx, pz - cz) - Math.max(0.1, rAtY - bevel);
  const halfH = Math.max(0.1, h * 0.5 - bevel);
  const midY = (bottomY + topY) * 0.5;
  const vertical = Math.abs(py - midY) - halfH;
  const outX = Math.max(radial, 0);
  const outY = Math.max(vertical, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(radial, vertical), 0) - bevel;
}

/**
 * Smooth sculpted destructible bastion wall / ridge fin between two XZ anchors,
 * featuring tapered sandstone flanks and a thinner central breach seam.
 */
function sdBastionWall(
  px: number,
  py: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  bottomY: number,
  topY: number,
  baseHalfThick: number,
  topHalfThick: number,
  bevel: number,
  seamPinchDepth = 0.22,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const t =
    lenSq > 1e-8
      ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq))
      : 0;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  const distXZ = Math.hypot(px - cx, pz - cz);

  const h = Math.max(0.4, topY - bottomY);
  const v = Math.max(0, Math.min(1, (py - bottomY) / h));
  const smoothV = v * v * (3 - 2 * v);
  const seamFactor = 1.0 - seamPinchDepth * Math.sin(t * Math.PI);
  const halfThick =
    (baseHalfThick + (topHalfThick - baseHalfThick) * smoothV) * seamFactor;

  // Gentle organic ridge crest profile peaking slightly near the inner buttress & tips
  const crestWave = Math.sin(t * Math.PI * 2.0) * 0.35;
  const effTopY = topY + crestWave;
  const effH = Math.max(0.4, effTopY - bottomY);
  const midY = (bottomY + effTopY) * 0.5;

  const horiz = distXZ - Math.max(0.25, halfThick - bevel);
  const halfH = Math.max(0.25, effH * 0.5 - bevel);
  const vert = Math.abs(py - midY) - halfH;
  const outX = Math.max(horiz, 0);
  const outY = Math.max(vert, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(horiz, vert), 0) - bevel;
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

interface ThemeLayoutContext {
  cx: number;
  cz: number;
  halfSpan: number;
  worldHeight: number;
  wScale: number;
  hScale: number;
  isGrand: boolean;
  bottomY: number;
  spawnTopY: number;
  wallTopY: number;
  centralPeakY: number;
  tunnelY: number;
}

function evaluateThemeSdf(
  theme: ThemeId,
  x: number,
  y: number,
  z: number,
  ctx: ThemeLayoutContext,
  j: ThemeJitter,
  noise: (nx: number, ny: number, nz: number) => number,
): number {
  const {
    cx,
    cz,
    halfSpan,
    worldHeight,
    wScale,
    hScale,
    isGrand,
    bottomY,
    spawnTopY,
    wallTopY,
    centralPeakY,
    tunnelY,
  } = ctx;

  // Normalized radial coordinates u, v in ~[-1..1] across the playable island
  const u = (x - cx) / halfSpan;
  const v = (z - cz) / halfSpan;

  const n1 = noise(u * 3.4, (y / hScale) * 0.15, v * 3.4);
  const n2 = noise(
    u * 7.6 + 17.3,
    (y / hScale) * 0.29 + 5.1,
    v * 7.6 - 11.7,
  );
  const noiseAmp = isGrand ? 0.56 : 0.4;
  const organicNoise = (n1 * 0.72 + n2 * 0.28) * noiseAmp;

  const bevel = 1.15 * Math.min(1.65, wScale * 0.6 + 0.4);
  const wallBaseThick = isGrand ? 4.6 : 2.5;
  const wallTopThick = isGrand ? 3.1 : 1.72;
  const wallBevel = isGrand ? 1.1 : 0.75;
  const passY = worldHeight * 0.165;
  const passRadius = isGrand ? 2.55 : 1.55;
  const unionK = isGrand ? 3.4 : 1.7;
  const wallBottomY = Math.max(0.5, bottomY - 0.7);
  const plugBaseHalfThick = isGrand ? 1.85 : 1.48;
  const plugTopHalfThick = isGrand ? 1.55 : 1.24;
  const plugBevel = isGrand ? 0.55 : 0.42;
  const plugSpan = passRadius * 1.25;
  const plugTopY = passY + (isGrand ? 4.1 : 3.3);

  // Helper converting normalized (nu, nv) into world (x, z)
  const wx = (nu: number): number => cx + nu * halfSpan;
  const wz = (nv: number): number => cz + nv * halfSpan;

  const evalGatePlugs = (passOffset: number): number => {
    const bound = plugBaseHalfThick + 2.5;
    const dxCenter = Math.abs(x - cx);
    const dzCenter = Math.abs(z - cz);
    if (y > plugTopY + 2.5 || (dxCenter > bound && dzCenter > bound)) {
      return 10.0;
    }
    let best = 10.0;
    if (dxCenter <= bound) {
      const nPlug = sdBastionWall(
        x,
        y,
        z,
        cx,
        wz(-passOffset) - plugSpan,
        cx,
        wz(-passOffset) + plugSpan,
        wallBottomY,
        plugTopY,
        plugBaseHalfThick,
        plugTopHalfThick,
        plugBevel,
        0.06,
      );
      const sPlug = sdBastionWall(
        x,
        y,
        z,
        cx,
        wz(passOffset) - plugSpan,
        cx,
        wz(passOffset) + plugSpan,
        wallBottomY,
        plugTopY,
        plugBaseHalfThick,
        plugTopHalfThick,
        plugBevel,
        0.06,
      );
      best = Math.min(best, nPlug, sPlug);
    }
    if (dzCenter <= bound) {
      const wPlug = sdBastionWall(
        x,
        y,
        z,
        wx(-passOffset) - plugSpan,
        cz,
        wx(-passOffset) + plugSpan,
        cz,
        wallBottomY,
        plugTopY,
        plugBaseHalfThick,
        plugTopHalfThick,
        plugBevel,
        0.06,
      );
      const ePlug = sdBastionWall(
        x,
        y,
        z,
        wx(passOffset) - plugSpan,
        cz,
        wx(passOffset) + plugSpan,
        cz,
        wallBottomY,
        plugTopY,
        plugBaseHalfThick,
        plugTopHalfThick,
        plugBevel,
        0.06,
      );
      best = Math.min(best, wPlug, ePlug);
    }
    return best;
  };

  if (theme === "emerald_spire") {
    // 1. 4 sheltered quadrant emerald fort basins (NE, SW, NW, SE)
    const basinBotR = 0.22 * halfSpan;
    const basinTopR = 0.35 * halfSpan;
    const nwBasin = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.6 + j.northShift * 0.03),
      wz(-0.6),
      bottomY,
      spawnTopY + j.westHeight * 0.45,
      basinBotR,
      basinTopR,
      bevel,
    );
    const neBasin = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.6 + j.southShift * 0.03),
      wz(-0.6),
      bottomY,
      spawnTopY + 0.25 + j.eastHeight * 0.45,
      basinBotR,
      basinTopR,
      bevel,
    );
    const swBasin = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.6 - j.southShift * 0.025),
      wz(0.6),
      bottomY,
      spawnTopY + 0.15 + j.eastHeight * 0.35,
      basinBotR,
      basinTopR,
      bevel,
    );
    const seBasin = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.6 - j.northShift * 0.025),
      wz(0.6),
      bottomY,
      spawnTopY + 0.35 + j.westHeight * 0.35,
      basinBotR,
      basinTopR,
      bevel,
    );

    // 2. Stepped inner terraces & coastal sandy coves near waterline for flanking paths
    const coveTop = Math.max(bottomY + 1.3, worldHeight * 0.13);
    const terraceTop = worldHeight * 0.24;
    const nwCove = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.34),
      wz(-0.34),
      bottomY - 0.15,
      coveTop,
      0.15 * halfSpan,
      0.2 * halfSpan,
      bevel * 0.7,
    );
    const seCove = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.34),
      wz(0.34),
      bottomY - 0.15,
      coveTop,
      0.15 * halfSpan,
      0.2 * halfSpan,
      bevel * 0.7,
    );
    const neTerrace = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.35),
      wz(-0.35),
      bottomY,
      terraceTop,
      0.14 * halfSpan,
      0.2 * halfSpan,
      bevel * 0.8,
    );
    const swTerrace = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.35),
      wz(0.35),
      bottomY,
      terraceTop,
      0.14 * halfSpan,
      0.2 * halfSpan,
      bevel * 0.8,
    );

    // 3. Massive Central Emerald Citadel Spire (65-68% of worldHeight) + beach apron
    const centralSpire = sdTaperedPlateau(
      x,
      y,
      z,
      cx,
      cz,
      bottomY,
      centralPeakY + j.archBoost * 0.35,
      0.175 * halfSpan,
      0.2 * halfSpan,
      bevel,
    );
    const spireApron = sdTaperedPlateau(
      x,
      y,
      z,
      cx,
      cz,
      bottomY - 0.15,
      coveTop,
      0.22 * halfSpan,
      0.27 * halfSpan,
      bevel * 0.65,
    );

    // 4. 4 tall full-width radiating destructible bastion walls directly dividing NW/NE/SW/SE basins
    //    Extended past the outer shoreline into sheer coastal cliffs (zero coastal walk-around)
    const northWall = sdBastionWall(
      x,
      y,
      z,
      cx,
      wz(-0.08),
      cx,
      wz(-1.07),
      wallBottomY,
      wallTopY + j.westHeight * 0.25,
      wallBaseThick,
      wallTopThick,
      wallBevel,
    );
    const southWall = sdBastionWall(
      x,
      y,
      z,
      cx,
      wz(0.08),
      cx,
      wz(1.07),
      wallBottomY,
      wallTopY + j.eastHeight * 0.25,
      wallBaseThick,
      wallTopThick,
      wallBevel,
    );
    const westWall = sdBastionWall(
      x,
      y,
      z,
      wx(-0.08),
      cz,
      wx(-1.07),
      cz,
      wallBottomY,
      wallTopY + j.eastHeight * 0.2,
      wallBaseThick,
      wallTopThick,
      wallBevel,
    );
    const eastWall = sdBastionWall(
      x,
      y,
      z,
      wx(0.08),
      cz,
      wx(1.07),
      cz,
      wallBottomY,
      wallTopY + j.westHeight * 0.2,
      wallBaseThick,
      wallTopThick,
      wallBevel,
    );

    // 5. Two narrow curved diagonal stone arches crossing over the terraces via central spire
    const archWidth = isGrand ? 3.8 : 2.05;
    const archThick = isGrand ? 2.2 : 1.3;
    const diagArchA = sdStoneArch(
      x,
      y,
      z,
      wx(-0.54),
      wz(-0.54),
      wx(0.54),
      wz(0.54),
      spawnTopY + 1.0,
      centralPeakY - 0.5,
      archWidth,
      archThick,
    );
    const diagArchB = sdStoneArch(
      x,
      y,
      z,
      wx(-0.54),
      wz(0.54),
      wx(0.54),
      wz(-0.54),
      spawnTopY + 1.0,
      centralPeakY - 0.7,
      archWidth,
      archThick,
    );

    let d = smin(nwBasin, neBasin, unionK);
    d = smin(d, swBasin, unionK);
    d = smin(d, seBasin, unionK);
    d = smin(d, nwCove, unionK * 0.75);
    d = smin(d, seCove, unionK * 0.75);
    d = smin(d, neTerrace, unionK * 0.8);
    d = smin(d, swTerrace, unionK * 0.8);
    d = smin(d, centralSpire, unionK * 0.9);
    d = smin(d, spireApron, unionK * 0.65);
    d = smin(d, northWall, unionK * 0.7);
    d = smin(d, southWall, unionK * 0.7);
    d = smin(d, westWall, unionK * 0.7);
    d = smin(d, eastWall, unionK * 0.7);
    d = smin(d, diagArchA, unionK * 0.55);
    d = smin(d, diagArchB, unionK * 0.55);

    // 6. Carved pass-through cave tunnel straight through the central pinnacle's base
    const spireTunnelR = isGrand ? 3.8 : 2.3;
    const spireTunnel =
      distToSegment(
        x,
        y,
        z,
        wx(-0.34),
        tunnelY,
        cz,
        wx(0.34),
        tunnelY,
        cz,
      ) - spireTunnelR;
    d = smax(d, -spireTunnel, isGrand ? 1.1 : 0.65);

    // 7. Carved lower arched passes through the 4 radiating walls, sealed by thin destructible rock gate plugs
    const nPass =
      distToSegment(
        x,
        y,
        z,
        wx(-0.2),
        passY,
        wz(-0.58),
        wx(0.2),
        passY,
        wz(-0.58),
      ) - passRadius;
    const sPass =
      distToSegment(
        x,
        y,
        z,
        wx(-0.2),
        passY,
        wz(0.58),
        wx(0.2),
        passY,
        wz(0.58),
      ) - passRadius;
    const wPass =
      distToSegment(
        x,
        y,
        z,
        wx(-0.58),
        passY,
        wz(-0.2),
        wx(-0.58),
        passY,
        wz(0.2),
      ) - passRadius;
    const ePass =
      distToSegment(
        x,
        y,
        z,
        wx(0.58),
        passY,
        wz(-0.2),
        wx(0.58),
        passY,
        wz(0.2),
      ) - passRadius;

    d = smax(d, -nPass, 0.65);
    d = smax(d, -sPass, 0.65);
    d = smax(d, -wPass, 0.65);
    d = smax(d, -ePass, 0.65);
    d = smin(d, evalGatePlugs(0.58), isGrand ? 0.5 : 0.35);

    // Subtle floating-island skirt taper near outer archipelago rim (preserving sheer coastal bastion walls)
    const radialNorm = Math.hypot(u, v);
    const wallAxisRelief = Math.max(
      0,
      1 - Math.min(Math.abs(u), Math.abs(v)) / 0.18,
    );
    const skirtStart = 0.94 + wallAxisRelief * 0.14;
    const skirtCut =
      wallBottomY - y + Math.max(0, radialNorm - skirtStart) * halfSpan * 0.28;
    d = smax(d, skirtCut, 0.85);
    return d + organicNoise;
  }

  if (theme === "canyon_arch") {
    // Grand Split Redrock Gorge: massive deep S-curved canyon slicing North-to-South
    // between towering opposing tiered sandstone rim mesas, bridged by 2 soaring open
    // natural stone arches with shadowed cliffside alcoves and Monument Valley rim buttes.
    const canyonU = 0.22 * Math.sin(v * Math.PI * 0.95);
    const canyonSlope = 0.22 * Math.PI * 0.95 * Math.cos(v * Math.PI * 0.95);
    const canyonDistNorm = Math.abs(u - canyonU) / Math.hypot(1.0, canyonSlope);
    const canyonDist = canyonDistNorm * halfSpan;

    const mesaBaseTop = worldHeight * 0.475;
    const rawSide = (u - canyonU) * 5.0;
    const sideBlend = rawSide / (1.0 + Math.abs(rawSide));
    const eastWeight = 0.5 + 0.5 * sideBlend;
    const mesaTopY =
      mesaBaseTop +
      sideBlend * 0.38 * hScale +
      ((1 - eastWeight) * j.westHeight + eastWeight * j.eastHeight) *
        0.32 *
        hScale;

    // Broad sculpted opposing sandstone mesa body + 4 outer headland promontories
    const mainMesa = sdRoundedSlab(
      x,
      y,
      z,
      cx,
      cz,
      bottomY,
      mesaTopY,
      0.94 * halfSpan,
      0.95 * halfSpan,
      bevel,
      0.16,
    );
    const headRx = 0.33 * halfSpan;
    const headRz = 0.31 * halfSpan;
    const nwHead = sdRoundedSlab(
      x,
      y,
      z,
      wx(-0.66),
      wz(-0.62),
      bottomY,
      mesaBaseTop - 0.35 * hScale + j.westHeight * 0.3 * hScale,
      headRx,
      headRz,
      bevel * 0.9,
      0.18,
    );
    const neHead = sdRoundedSlab(
      x,
      y,
      z,
      wx(0.66),
      wz(-0.62),
      bottomY,
      mesaBaseTop + 0.35 * hScale + j.eastHeight * 0.3 * hScale,
      headRx,
      headRz,
      bevel * 0.9,
      0.18,
    );
    const swHead = sdRoundedSlab(
      x,
      y,
      z,
      wx(-0.66),
      wz(0.62),
      bottomY,
      mesaBaseTop - 0.25 * hScale + j.eastHeight * 0.25 * hScale,
      headRx,
      headRz,
      bevel * 0.9,
      0.18,
    );
    const seHead = sdRoundedSlab(
      x,
      y,
      z,
      wx(0.66),
      wz(0.62),
      bottomY,
      mesaBaseTop + 0.3 * hScale + j.westHeight * 0.25 * hScale,
      headRx,
      headRz,
      bevel * 0.9,
      0.18,
    );

    let d = smin(mainMesa, nwHead, unionK * 0.85);
    d = smin(d, neHead, unionK * 0.85);
    d = smin(d, swHead, unionK * 0.85);
    d = smin(d, seHead, unionK * 0.85);

    // Carve massive S-curved canyon gorge with stepped inner sandstone balconies
    const balconyY = worldHeight * 0.3;
    const floorY = bottomY + 1.15;
    const upperT = Math.max(
      0,
      Math.min(1, (y - balconyY) / (worldHeight * 0.12)),
    );
    const upperSmooth = upperT * upperT * (3 - 2 * upperT);
    const lowerT = Math.max(
      0,
      Math.min(1, (y - floorY) / Math.max(0.5, balconyY - floorY)),
    );
    const lowerSmooth = lowerT * lowerT * (3 - 2 * lowerT);
    const gorgeHalfW =
      (0.15 + 0.045 * lowerSmooth + 0.075 * upperSmooth) * halfSpan;
    const gorgeCut = Math.min(gorgeHalfW - canyonDist, y - floorY);
    d = smax(d, gorgeCut, isGrand ? 1.15 : 0.7);

    // Narrow sinuous river abyss channel carved right down the center of the gorge floor
    const riverAbyssCut = 0.078 * halfSpan - canyonDist;
    d = smax(d, riverAbyssCut, isGrand ? 0.9 : 0.55);

    // Hollowed shadowed alcoves carved into the steep opposing gorge faces
    const alcoveRX = 0.11 * halfSpan;
    const alcoveRY = 0.085 * worldHeight;
    const alcoveRZ = 0.13 * halfSpan;
    const westAlcove = sdEllipsoid(
      x,
      y,
      z,
      wx(CANYON_WEST_ALCOVE_U),
      worldHeight * 0.25,
      wz(0.14),
      alcoveRX,
      alcoveRY,
      alcoveRZ,
    );
    const eastAlcove = sdEllipsoid(
      x,
      y,
      z,
      wx(CANYON_EAST_ALCOVE_U),
      worldHeight * 0.25,
      wz(-0.14),
      alcoveRX,
      alcoveRY,
      alcoveRZ,
    );
    d = smax(d, -westAlcove, isGrand ? 1.0 : 0.65);
    d = smax(d, -eastAlcove, isGrand ? 1.0 : 0.65);

    // Towering Monument Valley redrock butte outcrops on West & East rims (natural sightline cover)
    const westButte = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.62),
      wz(0.02),
      bottomY,
      worldHeight * 0.68 + j.westHeight * 0.25 * hScale,
      0.24 * halfSpan,
      0.21 * halfSpan,
      bevel * 0.85,
    );
    const westCoastSpur = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.88),
      wz(0.0),
      bottomY,
      worldHeight * 0.61 + j.westHeight * 0.2 * hScale,
      0.16 * halfSpan,
      0.14 * halfSpan,
      bevel * 0.75,
    );
    const westBendShoulder = sdTaperedPlateau(
      x,
      y,
      z,
      wx(-0.34),
      wz(0.24),
      mesaBaseTop - 1.4 * hScale,
      worldHeight * 0.62 + j.eastHeight * 0.2 * hScale,
      0.15 * halfSpan,
      0.13 * halfSpan,
      bevel * 0.75,
    );

    const eastButte = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.62),
      wz(-0.02),
      bottomY,
      worldHeight * 0.7 + j.eastHeight * 0.25 * hScale,
      0.24 * halfSpan,
      0.21 * halfSpan,
      bevel * 0.85,
    );
    const eastCoastSpur = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.88),
      wz(0.0),
      bottomY,
      worldHeight * 0.62 + j.eastHeight * 0.2 * hScale,
      0.16 * halfSpan,
      0.14 * halfSpan,
      bevel * 0.75,
    );
    const eastBendShoulder = sdTaperedPlateau(
      x,
      y,
      z,
      wx(0.34),
      wz(-0.24),
      mesaBaseTop - 1.4 * hScale,
      worldHeight * 0.63 + j.westHeight * 0.2 * hScale,
      0.15 * halfSpan,
      0.13 * halfSpan,
      bevel * 0.75,
    );

    // Sculpted sandstone rim crag fins framing the inner canyon lips of all 4 mesas
    const cragBaseT = isGrand ? 4.3 : 2.15;
    const cragTopT = isGrand ? 2.5 : 1.3;
    const cragBottomY = mesaBaseTop - 1.8 * hScale;
    const cragTopY = worldHeight * 0.62;
    const nwRimCrag = sdBastionWall(
      x,
      y,
      z,
      wx(-0.5),
      wz(-0.84),
      wx(-0.48),
      wz(-0.42),
      cragBottomY,
      cragTopY + j.westHeight * 0.2 * hScale,
      cragBaseT,
      cragTopT,
      wallBevel * 0.8,
      0.08,
    );
    const neRimCrag = sdBastionWall(
      x,
      y,
      z,
      wx(0.38),
      wz(-0.84),
      wx(0.36),
      wz(-0.46),
      cragBottomY,
      cragTopY + 0.3 * hScale + j.eastHeight * 0.2 * hScale,
      cragBaseT,
      cragTopT,
      wallBevel * 0.8,
      0.08,
    );
    const swRimCrag = sdBastionWall(
      x,
      y,
      z,
      wx(-0.38),
      wz(0.84),
      wx(-0.36),
      wz(0.46),
      cragBottomY,
      cragTopY + j.eastHeight * 0.2 * hScale,
      cragBaseT,
      cragTopT,
      wallBevel * 0.8,
      0.08,
    );
    const seRimCrag = sdBastionWall(
      x,
      y,
      z,
      wx(0.5),
      wz(0.84),
      wx(0.48),
      wz(0.42),
      cragBottomY,
      cragTopY + 0.25 * hScale + j.westHeight * 0.2 * hScale,
      cragBaseT,
      cragTopT,
      wallBevel * 0.8,
      0.08,
    );

    d = smin(d, westButte, unionK * 0.75);
    d = smin(d, westCoastSpur, unionK * 0.65);
    d = smin(d, westBendShoulder, unionK * 0.65);
    d = smin(d, eastButte, unionK * 0.75);
    d = smin(d, eastCoastSpur, unionK * 0.65);
    d = smin(d, eastBendShoulder, unionK * 0.65);
    d = smin(d, nwRimCrag, unionK * 0.55);
    d = smin(d, neRimCrag, unionK * 0.55);
    d = smin(d, swRimCrag, unionK * 0.55);
    d = smin(d, seRimCrag, unionK * 0.55);

    // 2 Soaring Natural Stone Arches bridging high above the open canyon gorge
    const archW = isGrand ? 4.3 : 2.15;
    const archT = isGrand ? 2.1 : 1.25;
    const northArch = sdStoneArch(
      x,
      y,
      z,
      wx(-0.52),
      wz(-0.38),
      wx(0.18),
      wz(-0.38),
      mesaBaseTop - 0.35 * hScale,
      worldHeight * 0.6 + j.archBoost * 0.22 * hScale,
      archW,
      archT,
    );
    const southArch = sdStoneArch(
      x,
      y,
      z,
      wx(-0.18),
      wz(0.38),
      wx(0.52),
      wz(0.38),
      mesaBaseTop - 0.35 * hScale,
      worldHeight * 0.61 - j.archBoost * 0.22 * hScale,
      archW,
      archT,
    );
    d = smin(d, northArch, unionK * 0.5);
    d = smin(d, southArch, unionK * 0.5);

    // Subtle floating-island cliff skirt taper near outer shoreline
    const radialNorm = Math.hypot(u, v);
    const skirtCut =
      wallBottomY - y + Math.max(0, radialNorm - 0.96) * halfSpan * 0.34;
    d = smax(d, skirtCut, 0.85);

    return d + organicNoise;
  }

  if (theme === "mountain_spine") {
    // Dragon's Backbone Ridge: dramatic diagonal S-curved alpine spine sweeping SW-to-NE
    // over open ocean, crowned by 5 jagged serrated vertebrae crags, 4 staggered cantilevered
    // cliffside rib-terraces overhanging the sea, and 3 deep pass-through rib-tunnels.
    const along = (u - v) * Math.SQRT1_2;
    const rawCross = (u + v) * Math.SQRT1_2;
    const spineAngle = along * Math.PI * 1.05;
    const spineCurve = 0.14 * Math.sin(spineAngle);
    const cross = rawCross - spineCurve;
    const spineSlope = 0.14 * Math.PI * 1.05 * Math.cos(spineAngle);
    const crossDist = (Math.abs(cross) / Math.hypot(1.0, spineSlope)) * halfSpan;

    // Continuous steep diagonal alpine mountain mass along |along| <= 1.0
    const spineTopY = worldHeight * (0.49 - 0.11 * Math.min(1.0, along * along));
    const spineH = Math.max(1.0, spineTopY - bottomY);
    const spineT = Math.max(0, Math.min(1, (y - bottomY) / spineH));
    const spineSmoothT = spineT * spineT * (3 - 2 * spineT);
    const spineHalfW = (0.31 - 0.16 * spineSmoothT) * halfSpan;
    const spineAlongTrim = (Math.abs(along) - 1.0) * halfSpan;
    const spineHoriz = Math.max(crossDist - spineHalfW, spineAlongTrim);
    const spineMidY = (bottomY + spineTopY) * 0.5;
    const spineVert = Math.abs(y - spineMidY) - spineH * 0.5;
    const spineCore =
      Math.hypot(Math.max(spineHoriz, 0), Math.max(spineVert, 0)) +
      Math.min(Math.max(spineHoriz, spineVert), 0);

    // 5 Jagged Serrated "Vertebrae" Crag Peaks along the dragon's crest (zero per-voxel alloc)
    const peakCeiling = worldHeight - 2.6 * hScale;
    const peakBevel = bevel * 0.8;
    const peakK = unionK * 0.72;
    let d = spineCore;
    for (let i = 0; i < SPINE_PEAKS.length; i++) {
      const pk = SPINE_PEAKS[i];
      if (!pk) continue;
      const jitterVal =
        pk.jitterKind === 0
          ? j.westHeight
          : pk.jitterKind === 1
            ? j.eastHeight
            : j.archBoost;
      const peak = sdTaperedPlateau(
        x,
        y,
        z,
        wx(pk.u),
        wz(pk.v),
        bottomY,
        Math.min(peakCeiling, worldHeight * pk.heightFrac + jitterVal * 0.25 * hScale),
        pk.botR * halfSpan,
        pk.topR * halfSpan,
        peakBevel,
      );
      d = smin(d, peak, peakK);
    }

    // 4 Staggered Cantilevered Cliffside "Rib" Terraces overhanging open ocean in all 4 quadrants
    const nwTerraceTop = worldHeight * 0.34 + j.westHeight * 0.28 * hScale;
    const seTerraceTop = worldHeight * 0.37 + j.eastHeight * 0.28 * hScale;
    const swTerraceTop = worldHeight * 0.31 + j.eastHeight * 0.25 * hScale;
    const neTerraceTop = worldHeight * 0.41 + j.westHeight * 0.25 * hScale;

    const nwRib = sdRoundedSlab(
      x,
      y,
      z,
      wx(-0.52),
      wz(-0.5),
      worldHeight * 0.13,
      nwTerraceTop,
      0.27 * halfSpan,
      0.26 * halfSpan,
      peakBevel,
      0.28,
    );
    const seRib = sdRoundedSlab(
      x,
      y,
      z,
      wx(0.52),
      wz(0.5),
      worldHeight * 0.14,
      seTerraceTop,
      0.27 * halfSpan,
      0.26 * halfSpan,
      peakBevel,
      0.28,
    );
    const swRib = sdRoundedSlab(
      x,
      y,
      z,
      wx(-0.64),
      wz(0.46),
      bottomY,
      swTerraceTop,
      0.26 * halfSpan,
      0.27 * halfSpan,
      peakBevel,
      0.22,
    );
    const neRib = sdRoundedSlab(
      x,
      y,
      z,
      wx(0.64),
      wz(-0.46),
      bottomY,
      neTerraceTop,
      0.26 * halfSpan,
      0.27 * halfSpan,
      peakBevel,
      0.22,
    );

    // Solid cliff rib-buttresses anchoring the cantilevered NW & SE terraces into the dragon spine
    const nwRoot = sdRampArch(
      x,
      y,
      z,
      wx(SPINE_NW_ROOT[0]),
      worldHeight * 0.22,
      wz(SPINE_NW_ROOT[1]),
      wx(-0.5),
      nwTerraceTop - 1.2 * hScale,
      wz(-0.48),
      0.16 * halfSpan,
      worldHeight * 0.11,
      0.0,
    );
    const seRoot = sdRampArch(
      x,
      y,
      z,
      wx(SPINE_SE_ROOT[0]),
      worldHeight * 0.23,
      wz(SPINE_SE_ROOT[1]),
      wx(0.5),
      seTerraceTop - 1.2 * hScale,
      wz(0.48),
      0.16 * halfSpan,
      worldHeight * 0.11,
      0.0,
    );

    // Sculpted alpine flank rib-spurs jutting off Peaks 1 & 3 (natural Turn-1 LOS cover between NW<->SW and SE<->NE)
    const nwSpur = sdBastionWall(
      x,
      y,
      z,
      wx(SPINE_NW_SPUR_BASE[0]),
      wz(SPINE_NW_SPUR_BASE[1]),
      wx(-0.74),
      wz(-0.02),
      bottomY,
      worldHeight * 0.56 + j.westHeight * 0.2 * hScale,
      isGrand ? 4.8 : 2.5,
      isGrand ? 2.7 : 1.45,
      wallBevel * 0.85,
      0.12,
    );
    const seSpur = sdBastionWall(
      x,
      y,
      z,
      wx(SPINE_SE_SPUR_BASE[0]),
      wz(SPINE_SE_SPUR_BASE[1]),
      wx(0.74),
      wz(0.02),
      bottomY,
      worldHeight * 0.58 + j.eastHeight * 0.2 * hScale,
      isGrand ? 4.8 : 2.5,
      isGrand ? 2.7 : 1.45,
      wallBevel * 0.85,
      0.12,
    );

    // Narrow curved stone flank ridge arches linking adjacent rib-terraces over the ocean coves
    const flankW = isGrand ? 3.5 : 1.9;
    const flankT = isGrand ? 1.9 : 1.15;
    const nwSwArch = sdRampArch(
      x,
      y,
      z,
      wx(-0.56),
      nwTerraceTop - 0.5 * hScale,
      wz(-0.38),
      wx(-0.62),
      swTerraceTop - 0.4 * hScale,
      wz(0.34),
      flankW,
      flankT,
      1.6 * hScale,
    );
    const seNeArch = sdRampArch(
      x,
      y,
      z,
      wx(0.56),
      seTerraceTop - 0.5 * hScale,
      wz(0.38),
      wx(0.62),
      neTerraceTop - 0.4 * hScale,
      wz(-0.34),
      flankW,
      flankT,
      1.6 * hScale,
    );

    d = smin(d, nwRib, unionK * 0.8);
    d = smin(d, seRib, unionK * 0.8);
    d = smin(d, swRib, unionK * 0.8);
    d = smin(d, neRib, unionK * 0.8);
    d = smin(d, nwRoot, unionK * 0.7);
    d = smin(d, seRoot, unionK * 0.7);
    d = smin(d, nwSpur, unionK * 0.65);
    d = smin(d, seSpur, unionK * 0.65);
    d = smin(d, nwSwArch, unionK * 0.45);
    d = smin(d, seNeArch, unionK * 0.45);

    // 3 Deep Carved Rib-Tunnels piercing straight through the backbone (leaving solid jagged peaks overhead!)
    const swTunY = worldHeight * 0.2;
    const swTunR = isGrand ? 3.4 : 2.1;
    const swTunnel =
      distToSegment(
        x,
        y,
        z,
        wx(SPINE_SW_TUN_A[0]),
        swTunY,
        wz(SPINE_SW_TUN_A[1]),
        wx(SPINE_SW_TUN_B[0]),
        swTunY,
        wz(SPINE_SW_TUN_B[1]),
      ) - swTunR;

    const midTunY = worldHeight * 0.23;
    const midTunR = isGrand ? 3.7 : 2.25;
    const midTunnel =
      distToSegment(
        x,
        y,
        z,
        wx(SPINE_MID_TUN_A[0]),
        midTunY,
        wz(SPINE_MID_TUN_A[1]),
        wx(SPINE_MID_TUN_B[0]),
        midTunY,
        wz(SPINE_MID_TUN_B[1]),
      ) - midTunR;

    const neTunY = worldHeight * 0.27;
    const neTunR = isGrand ? 3.25 : 2.0;
    const neTunnel =
      distToSegment(
        x,
        y,
        z,
        wx(SPINE_NE_TUN_A[0]),
        neTunY,
        wz(SPINE_NE_TUN_A[1]),
        wx(SPINE_NE_TUN_B[0]),
        neTunY,
        wz(SPINE_NE_TUN_B[1]),
      ) - neTunR;

    d = smax(d, -swTunnel, isGrand ? 0.9 : 0.55);
    d = smax(d, -midTunnel, isGrand ? 0.95 : 0.6);
    d = smax(d, -neTunnel, isGrand ? 0.85 : 0.55);

    // Sheer ocean drop-offs outside the island perimeter
    const radialNorm = Math.hypot(u, v);
    const skirtCut =
      wallBottomY - y + Math.max(0, radialNorm - 0.96) * halfSpan * 0.36;
    d = smax(d, skirtCut, 0.8);

    return d + organicNoise;
  }

  // 'twin_pillars' (Two-Story Pillared Sky-Citadel):
  // Story 1 sunlit lower sea-level plaza & 4 outer coastal wings with open ocean moon-wells,
  // 8 towering tapered support pillars + 2 tall central sentinel obelisks,
  // Story 2 twin elevated sky-deck citadels overhead joined by a soaring central sky-bridge
  // and 2 curved outer stone climb ramps connecting Story 1 to Story 2.
  const deck1TopY = worldHeight * 0.21;
  const deck2BottomY = worldHeight * 0.49;
  const deck2TopY = worldHeight * 0.6;

  // Story 1: Central sunlit lower temple plaza + 4 outer coastal wings
  const lowerPlaza = sdRoundedSlab(
    x,
    y,
    z,
    cx,
    cz,
    bottomY,
    deck1TopY,
    0.66 * halfSpan,
    0.44 * halfSpan,
    bevel * 0.85,
    0.18,
  );
  const wingRx = 0.31 * halfSpan;
  const wingRz = 0.28 * halfSpan;
  const nwWing = sdRoundedSlab(
    x,
    y,
    z,
    wx(-0.62),
    wz(-0.58),
    bottomY,
    deck1TopY + 0.25 * hScale + j.westHeight * 0.2 * hScale,
    wingRx,
    wingRz,
    bevel * 0.8,
    0.2,
  );
  const neWing = sdRoundedSlab(
    x,
    y,
    z,
    wx(0.62),
    wz(-0.58),
    bottomY,
    deck1TopY + 0.35 * hScale + j.eastHeight * 0.2 * hScale,
    wingRx,
    wingRz,
    bevel * 0.8,
    0.2,
  );
  const swWing = sdRoundedSlab(
    x,
    y,
    z,
    wx(-0.62),
    wz(0.58),
    bottomY,
    deck1TopY + 0.2 * hScale + j.eastHeight * 0.2 * hScale,
    wingRx,
    wingRz,
    bevel * 0.8,
    0.2,
  );
  const seWing = sdRoundedSlab(
    x,
    y,
    z,
    wx(0.62),
    wz(0.58),
    bottomY,
    deck1TopY + 0.3 * hScale + j.westHeight * 0.2 * hScale,
    wingRx,
    wingRz,
    bevel * 0.8,
    0.2,
  );

  let d = smin(lowerPlaza, nwWing, unionK * 0.75);
  d = smin(d, neWing, unionK * 0.75);
  d = smin(d, swWing, unionK * 0.75);
  d = smin(d, seWing, unionK * 0.75);

  // Carve dramatic open ocean drop shafts / moon-wells through Story 1
  const northWell = Math.hypot(x - cx, z - wz(-0.58)) - 0.23 * halfSpan;
  const southWell = Math.hypot(x - cx, z - wz(0.58)) - 0.23 * halfSpan;
  const centerWell = Math.hypot(x - cx, z - cz) - 0.1 * halfSpan;
  d = smax(d, -northWell, isGrand ? 0.9 : 0.55);
  d = smax(d, -southWell, isGrand ? 0.9 : 0.55);
  d = smax(d, -centerWell, isGrand ? 0.75 : 0.45);

  // 8 Towering Tapered Sculpted Stone Support Pillars rising from bottomY through Story 1 into Story 2
  const pillarR = 0.092 * halfSpan;
  const pillarBevel = isGrand ? 0.75 : 0.48;
  const pillarTopY = deck2BottomY + 0.9 * hScale;
  const pillarK = unionK * 0.55;
  for (let i = 0; i < TWIN_SUPPORT_PILLARS.length; i++) {
    const pair = TWIN_SUPPORT_PILLARS[i];
    if (!pair) continue;
    const col = sdCylinderPillar(
      x,
      y,
      z,
      wx(pair[0]),
      wz(pair[1]),
      bottomY,
      pillarTopY,
      pillarR,
      pillarBevel,
      0.14,
    );
    d = smin(d, col, pillarK);
  }

  // 2 Tall Sentinel Monolith Obelisks framing the central sea-colonnade (blocking lower cross-plaza LOS)
  const obeliskR = 0.095 * halfSpan;
  const obeliskTopY = worldHeight * 0.72 + j.archBoost * 0.2 * hScale;
  const obeliskA = sdCylinderPillar(
    x,
    y,
    z,
    wx(0.16),
    wz(-0.15),
    bottomY,
    obeliskTopY,
    obeliskR,
    pillarBevel,
    0.18,
  );
  const obeliskB = sdCylinderPillar(
    x,
    y,
    z,
    wx(-0.16),
    wz(0.15),
    bottomY,
    obeliskTopY,
    obeliskR,
    pillarBevel,
    0.18,
  );
  d = smin(d, obeliskA, unionK * 0.5);
  d = smin(d, obeliskB, unionK * 0.5);

  // Story 2: Twin Elevated Sky-Deck Citadels overhead (~28% worldHeight open-air colonnade gap!)
  const westDeckTopY = deck2TopY + j.westHeight * 0.22 * hScale;
  const eastDeckTopY = deck2TopY + j.eastHeight * 0.22 * hScale;
  const westSkyDeck = sdRoundedSlab(
    x,
    y,
    z,
    wx(-0.44),
    wz(-0.04),
    deck2BottomY,
    westDeckTopY,
    0.29 * halfSpan,
    0.36 * halfSpan,
    bevel * 0.65,
    0.2,
  );
  const eastSkyDeck = sdRoundedSlab(
    x,
    y,
    z,
    wx(0.44),
    wz(0.04),
    deck2BottomY,
    eastDeckTopY,
    0.29 * halfSpan,
    0.36 * halfSpan,
    bevel * 0.65,
    0.2,
  );
  d = smin(d, westSkyDeck, unionK * 0.6);
  d = smin(d, eastSkyDeck, unionK * 0.6);

  // Sculpted stone temple parapet crags along inner corners of both Sky-Decks (natural Story 2 cover)
  const parapetH = worldHeight * 0.73;
  const parapetBaseT = isGrand ? 3.2 : 1.7;
  const parapetTopT = isGrand ? 2.1 : 1.15;
  const westParapet = sdBastionWall(
    x,
    y,
    z,
    wx(-0.24),
    wz(-0.36),
    wx(-0.24),
    wz(-0.14),
    deck2BottomY + 0.4 * hScale,
    parapetH,
    parapetBaseT,
    parapetTopT,
    wallBevel * 0.65,
    0.06,
  );
  const eastParapet = sdBastionWall(
    x,
    y,
    z,
    wx(0.24),
    wz(0.14),
    wx(0.24),
    wz(0.36),
    deck2BottomY + 0.4 * hScale,
    parapetH,
    parapetBaseT,
    parapetTopT,
    wallBevel * 0.65,
    0.06,
  );
  d = smin(d, westParapet, unionK * 0.4);
  d = smin(d, eastParapet, unionK * 0.4);

  // Coastal temple gate obelisks flanking the NE & SW lower climb ramp entrances
  const gateColR = 0.085 * halfSpan;
  const neGateCol = sdCylinderPillar(
    x,
    y,
    z,
    wx(0.42),
    wz(-0.48),
    bottomY,
    worldHeight * 0.52,
    gateColR,
    pillarBevel,
    0.15,
  );
  const swGateCol = sdCylinderPillar(
    x,
    y,
    z,
    wx(-0.42),
    wz(0.48),
    bottomY,
    worldHeight * 0.52,
    gateColR,
    pillarBevel,
    0.15,
  );
  d = smin(d, neGateCol, unionK * 0.45);
  d = smin(d, swGateCol, unionK * 0.45);

  // Soaring Central Sky-Bridge Arch linking West Sky-Deck <-> East Sky-Deck across open air
  const skyBridge = sdStoneArch(
    x,
    y,
    z,
    wx(-0.26),
    wz(-0.02),
    wx(0.26),
    wz(0.02),
    deck2TopY - 0.4 * hScale,
    worldHeight * 0.69 + j.archBoost * 0.18 * hScale,
    isGrand ? 4.2 : 2.2,
    isGrand ? 2.1 : 1.35,
  );
  d = smin(d, skyBridge, unionK * 0.45);

  // 2 Curved Outer Stone Climb Ramps connecting Story 1 coastal wings up onto Story 2 Sky-Decks
  const rampW = isGrand ? 3.8 : 2.05;
  const rampT = isGrand ? 2.0 : 1.2;
  const northRamp = sdRampArch(
    x,
    y,
    z,
    wx(0.62),
    deck1TopY - 0.1 * hScale,
    wz(-0.56),
    wx(0.56),
    eastDeckTopY - 0.35 * hScale,
    wz(-0.14),
    rampW,
    rampT,
    1.1 * hScale,
  );
  const southRamp = sdRampArch(
    x,
    y,
    z,
    wx(-0.62),
    deck1TopY - 0.1 * hScale,
    wz(0.56),
    wx(-0.56),
    westDeckTopY - 0.35 * hScale,
    wz(0.14),
    rampW,
    rampT,
    1.1 * hScale,
  );
  d = smin(d, northRamp, unionK * 0.5);
  d = smin(d, southRamp, unionK * 0.5);

  return d + organicNoise;
}

const CANYON_WEST_ALCOVE_U = 0.22 * Math.sin(0.14 * Math.PI * 0.95) - 0.25;
const CANYON_EAST_ALCOVE_U = 0.22 * Math.sin(-0.14 * Math.PI * 0.95) + 0.25;

function spineNormUV(along: number, cross: number): readonly [number, number] {
  const rc = cross + 0.14 * Math.sin(along * Math.PI * 1.05);
  return [(along + rc) * Math.SQRT1_2, (rc - along) * Math.SQRT1_2];
}

interface SpinePeakSpec {
  readonly u: number;
  readonly v: number;
  readonly heightFrac: number;
  readonly botR: number;
  readonly topR: number;
  readonly jitterKind: 0 | 1 | 2;
}

const SPINE_PEAKS: readonly SpinePeakSpec[] = (
  [
    [-0.74, 0.6, 0.165, 0.08, 0],
    [-0.37, 0.68, 0.18, 0.088, 1],
    [0.0, 0.73, 0.2, 0.095, 2],
    [0.37, 0.69, 0.18, 0.088, 0],
    [0.74, 0.61, 0.165, 0.08, 1],
  ] as const
).map(([along, heightFrac, botR, topR, jitterKind]) => {
  const [u, v] = spineNormUV(along, 0);
  return { u, v, heightFrac, botR, topR, jitterKind };
});

const SPINE_NW_ROOT = spineNormUV(-0.04, -0.14);
const SPINE_SE_ROOT = spineNormUV(0.04, 0.14);
const SPINE_NW_SPUR_BASE = spineNormUV(-0.37, -0.04);
const SPINE_SE_SPUR_BASE = spineNormUV(0.37, 0.04);
const SPINE_SW_TUN_A = spineNormUV(-0.37, -0.44);
const SPINE_SW_TUN_B = spineNormUV(-0.37, 0.44);
const SPINE_MID_TUN_A = spineNormUV(0.0, -0.48);
const SPINE_MID_TUN_B = spineNormUV(0.0, 0.48);
const SPINE_NE_TUN_A = spineNormUV(0.37, -0.44);
const SPINE_NE_TUN_B = spineNormUV(0.37, 0.44);

const TWIN_SUPPORT_PILLARS: ReadonlyArray<readonly [number, number]> = [
  [-0.58, -0.26],
  [-0.3, -0.24],
  [-0.58, 0.18],
  [-0.3, 0.2],
  [0.3, -0.2],
  [0.58, -0.18],
  [0.3, 0.24],
  [0.58, 0.26],
];

/**
 * Smooth sculpted cylindrical stone pillar with subtle organic waist taper,
 * zero-trig algebraic fluting, and smoothly flared base & capital rings.
 */
function sdCylinderPillar(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cz: number,
  bottomY: number,
  topY: number,
  radius: number,
  bevel: number,
  waistPinch = 0.14,
): number {
  const h = Math.max(0.4, topY - bottomY);
  const t = Math.max(0, Math.min(1, (py - bottomY) / h));
  const flare = 1.0 - waistPinch * 4.0 * t * (1.0 - t);
  const baseT = Math.max(0, Math.min(1, (0.2 - t) * 5.0));
  const capT = Math.max(0, Math.min(1, (t - 0.8) * 5.0));
  const baseFlare = baseT * baseT * (3 - 2 * baseT) * 0.22;
  const capFlare = capT * capT * (3 - 2 * capT) * 0.24;
  const dx = px - cx;
  const dz = pz - cz;
  const dx2 = dx * dx;
  const dz2 = dz * dz;
  const rSq = dx2 + dz2;
  const flute =
    rSq > 1e-6
      ? 1.0 + 0.03 * (((dx2 - dz2) * (dx2 - dz2)) / (rSq * rSq) - 0.5)
      : 1.0;
  const effR = Math.max(
    0.25,
    radius * (flare + baseFlare + capFlare) * flute - bevel,
  );
  const radial = Math.sqrt(rSq) - effR;
  const midY = (bottomY + topY) * 0.5;
  const halfH = Math.max(0.25, h * 0.5 - bevel);
  const vert = Math.abs(py - midY) - halfH;
  const outX = Math.max(radial, 0);
  const outY = Math.max(vert, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(radial, vert), 0) - bevel;
}

/**
 * Smooth elliptical stone slab / sky-deck with flat walkable top and
 * tapered sculpted underside for floating citadels, mesas, and cantilevered terraces.
 */
function sdRoundedSlab(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cz: number,
  bottomY: number,
  topY: number,
  rx: number,
  rz: number,
  bevel: number,
  undersideTaper = 0.2,
): number {
  const h = Math.max(0.4, topY - bottomY);
  const t = Math.max(0, Math.min(1, (py - bottomY) / h));
  const smoothT = t * t * (3 - 2 * t);
  const scale = 1.0 - undersideTaper * (1.0 - smoothT);
  const effRx = Math.max(0.35, rx * scale - bevel);
  const effRz = Math.max(0.35, rz * scale - bevel);
  const qx = (px - cx) / effRx;
  const qz = (pz - cz) / effRz;
  const k0 = Math.hypot(qx, qz);
  const radial =
    k0 < 1e-6
      ? -Math.min(effRx, effRz)
      : (k0 * (k0 - 1.0)) / Math.max(Math.hypot(qx / effRx, qz / effRz), 1e-6);
  const midY = (bottomY + topY) * 0.5;
  const halfH = Math.max(0.2, h * 0.5 - bevel);
  const vert = Math.abs(py - midY) - halfH;
  const outX = Math.max(radial, 0);
  const outY = Math.max(vert, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(radial, vert), 0) - bevel;
}

/**
 * Smooth sculpted sloped stone ramp / curved ridge causeway connecting two 3D points
 * with optional upward arch lift.
 */
function sdRampArch(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  width: number,
  thickness: number,
  archLift = 0.0,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const span = Math.hypot(dx, dz);
  if (span < 1e-5) {
    return sdSphere(px, py, pz, ax, (ay + by) * 0.5, az, thickness);
  }
  const ux = dx / span;
  const uz = dz / span;
  const proj = (px - ax) * ux + (pz - az) * uz;
  const t = Math.max(0, Math.min(1, proj / span));
  const cx = ax + ux * (t * span);
  const cz = az + uz * (t * span);
  const smoothT = t * t * (3 - 2 * t);
  const pathY = ay + (by - ay) * smoothT + 4 * t * (1 - t) * archLift;
  const distXZ = Math.hypot(px - cx, pz - cz);
  const distY = Math.abs(py - pathY);
  const nx = distXZ / Math.max(0.2, width);
  const ny = distY / Math.max(0.2, thickness);
  return (Math.hypot(nx, ny) - 1.0) * Math.min(width, thickness);
}

/**
 * Deterministic 3D Signed Distance Field sculpted sky-island terrain world.
 * Sign convention: negative (< 0) = solid rock/earth, positive (> 0) = air, 0 = smooth surface.
 */
export class SdfWorld {
  public readonly seed: number;
  public readonly theme: ThemeId;
  public readonly mapScale: MapScale;
  public readonly dims: SdfDimensions;
  public readonly worldWidth: number;
  public readonly worldHeight: number;
  public readonly worldDepth: number;
  public readonly centerX: number;
  public readonly centerZ: number;

  private readonly chunksX: number;
  private readonly chunksY: number;
  private readonly chunksZ: number;
  private readonly values: Float32Array;
  private readonly carveLog: CarveOp[] = [];

  public constructor(
    seed: number,
    theme: ThemeId,
    mapScale: MapScale = "duel",
  ) {
    this.seed = seed;
    this.theme = theme;
    this.mapScale = mapScale;
    const preset = SDF_PRESETS[mapScale];
    this.dims = { ...preset };
    this.worldWidth = preset.nx * preset.voxelSize;
    this.worldHeight = preset.ny * preset.voxelSize;
    this.worldDepth = preset.nz * preset.voxelSize;
    this.centerX = this.worldWidth * 0.5;
    this.centerZ = this.worldDepth * 0.5;
    this.chunksX = Math.ceil(preset.nx / preset.chunkSize);
    this.chunksY = Math.ceil(preset.ny / preset.chunkSize);
    this.chunksZ = Math.ceil(preset.nz / preset.chunkSize);
    this.values = new Float32Array(preset.nx * preset.ny * preset.nz);
    this.generateTerrain();
  }

  /** Read raw SDF grid value at integer voxel index, returning +2.0 outside bounds. */
  public getValue(ix: number, iy: number, iz: number): number {
    const { nx, ny, nz } = this.dims;
    if (!(ix >= 0 && ix < nx && iy >= 0 && iy < ny && iz >= 0 && iz < nz)) {
      return OUTSIDE_AIR_VALUE;
    }
    const x = Math.trunc(ix);
    const y = Math.trunc(iy);
    const z = Math.trunc(iz);
    const idx = x + nx * (y + ny * z);
    return this.values[idx] ?? OUTSIDE_AIR_VALUE;
  }

  /** Trilinearly sample the SDF in world meters, returning +2.0 outside bounds. */
  public sample(x: number, y: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return OUTSIDE_AIR_VALUE;
    }
    const { nx, ny, nz, voxelSize } = this.dims;
    const gx = x / voxelSize;
    const gy = y / voxelSize;
    const gz = z / voxelSize;

    if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) {
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
    const eps = this.dims.voxelSize * 0.5;
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
   * March segment `(a + eyeOffsetY) -> (b + eyeOffsetY)` in `0.45 * dims.voxelSize` steps.
   * Returns `false` immediately upon intersecting any solid rock (`sample < 0`).
   */
  public hasDirectLineOfSight(a: Vec3, b: Vec3, eyeOffsetY = 1.1): boolean {
    if (!isFiniteVec3(a) || !isFiniteVec3(b) || !Number.isFinite(eyeOffsetY)) {
      return false;
    }
    const ax = a.x;
    const ay = a.y + eyeOffsetY;
    const az = a.z;
    const bx = b.x;
    const by = b.y + eyeOffsetY;
    const bz = b.z;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-5) {
      return this.sample(ax, ay, az) >= 0;
    }
    const step = 0.45 * this.dims.voxelSize;
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (this.sample(ax + dx * t, ay + dy * t, az + dz * t) < 0) {
        return false;
      }
    }
    return true;
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

    const { nx, ny, nz, voxelSize: vs } = this.dims;
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
    const maxIx = Math.min(nx - 2, Math.ceil(maxX / vs));
    const minIy = Math.max(1, Math.floor(minY / vs));
    const maxIy = Math.min(ny - 2, Math.ceil(maxY / vs));
    const minIz = Math.max(1, Math.floor(minZ / vs));
    const maxIz = Math.min(nz - 2, Math.ceil(maxZ / vs));

    if (minIx > maxIx || minIy > maxIy || minIz > maxIz) {
      return [];
    }

    const dirtyChunks = new Set<string>();
    const isCapsule = op.shape === "capsule" && endPoint !== undefined;

    for (let iz = minIz; iz <= maxIz; iz++) {
      const wz = iz * vs;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const wy = iy * vs;
        const rowBase = nx * (iy + ny * iz);
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

  /** Erode outer island terrain beyond radiusFromCenter around world center for sudden-death ledge crumble. */
  public crumbleOuterRing(radiusFromCenter: number): string[] {
    if (!Number.isFinite(radiusFromCenter)) {
      return [];
    }
    const radius = Math.max(0, radiusFromCenter);
    const { nx, ny, nz, voxelSize: vs } = this.dims;
    const dirtyChunks = new Set<string>();

    for (let iz = 1; iz <= nz - 2; iz++) {
      const dz = iz * vs - this.centerZ;
      for (let iy = 1; iy <= ny - 2; iy++) {
        const rowBase = nx * (iy + ny * iz);
        for (let ix = 1; ix <= nx - 2; ix++) {
          const dx = ix * vs - this.centerX;
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
   * with 4 binary search steps. Uses a fast direct voxel-layer bracket to skip
   * open-air trilinear samples while returning mathematically identical heights.
   * Returns null if the column is all air.
   */
  public getSurfaceY(x: number, z: number): number | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return null;
    }
    const { nx, ny, nz, voxelSize: vs } = this.dims;
    const maxX = (nx - 1) * vs;
    const maxZ = (nz - 1) * vs;
    if (x < 0 || x > maxX || z < 0 || z > maxZ) {
      return null;
    }

    const ix = Math.max(0, Math.min(nx - 2, Math.floor(x / vs)));
    const iz = Math.max(0, Math.min(nz - 2, Math.floor(z / vs)));
    const baseZ0 = ix + nx * ny * iz;
    const baseZ1 = baseZ0 + nx * ny;

    let firstNegIy = -1;
    for (let iy = ny - 2; iy >= 1; iy--) {
      const yOff = iy * nx;
      const v00 = this.values[baseZ0 + yOff] ?? OUTSIDE_AIR_VALUE;
      const v10 = this.values[baseZ0 + yOff + 1] ?? OUTSIDE_AIR_VALUE;
      const v01 = this.values[baseZ1 + yOff] ?? OUTSIDE_AIR_VALUE;
      const v11 = this.values[baseZ1 + yOff + 1] ?? OUTSIDE_AIR_VALUE;
      if (v00 < 0 || v10 < 0 || v01 < 0 || v11 < 0) {
        firstNegIy = iy;
        break;
      }
    }

    if (firstNegIy < 0) {
      return null;
    }

    const step = vs * 0.5;
    const maxY = (ny - 2) * vs;
    const minY = vs;
    const startY = Math.min(maxY, (firstNegIy + 1) * vs);

    let prevY = startY;
    let prevVal = this.sample(x, prevY, z);

    for (let y = startY - step; y >= minY; y -= step) {
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
   * Deterministically pick `count` well-separated walkable spawn points in the 4
   * sheltered quadrant basins (`>= 24m` apart on duel, `>= 52m` apart on grand),
   * guaranteeing `hasDirectLineOfSight(spawns[i], spawns[j], 1.1) === false` for
   * every pair among the primary 4 spawns.
   */
  public findSpawnPoints(count: number): Vec3[] {
    if (!Number.isFinite(count) || count <= 0) {
      return [];
    }
    const targetCount = Math.floor(count);
    const rng = createSeededRng(this.seed ^ 0x51a9c3);
    const isGrand = this.mapScale === "grand";
    const halfSpan = this.worldWidth * 0.44;
    const minSep = isGrand ? 54.5 : 24.5;
    const minBasinRadial = halfSpan * 0.55;
    const maxSafeRadial = isGrand ? 55.5 : 24.5;
    const maxBasinY = isGrand ? 21.0 : 12.2;
    const minBasinY = isGrand ? 11.0 : 7.0;
    const margin = isGrand ? 9.0 : 5.0;
    const step = isGrand ? 2.25 : 1.5;

    interface SpawnCandidate {
      pos: Vec3;
      quadrant: number;
      radial: number;
      inBasin: boolean;
      score: number;
    }

    const candidates: SpawnCandidate[] = [];

    for (let x = margin; x <= this.worldWidth - margin; x += step) {
      for (let z = margin; z <= this.worldDepth - margin; z += step) {
        const surfaceY = this.getSurfaceY(x, z);
        if (surfaceY === null || surfaceY < 4.0) {
          continue;
        }
        const normal = this.sampleNormal(x, surfaceY, z);
        if (normal.y < 0.65) {
          continue;
        }
        if (
          this.sample(x, surfaceY + 1.0, z) <= 0.1 ||
          this.sample(x, surfaceY + 2.0, z) <= 0.1 ||
          !this.isSolid(x, surfaceY - 1.5, z)
        ) {
          continue;
        }

        const footOff = isGrand ? 2.0 : 1.4;
        const stableFooting =
          this.isSolid(x + footOff, surfaceY - 1.0, z) &&
          this.isSolid(x - footOff, surfaceY - 1.0, z) &&
          this.isSolid(x, surfaceY - 1.0, z + footOff) &&
          this.isSolid(x, surfaceY - 1.0, z - footOff);

        const u = (x - this.centerX) / halfSpan;
        const v = (z - this.centerZ) / halfSpan;
        const radial = Math.hypot(x - this.centerX, z - this.centerZ);
        const quadrant =
          (x < this.centerX ? 0 : 1) + (z < this.centerZ ? 0 : 2);
        let inBasin: boolean;
        let distFromBasinIdeal: number;
        let heightCapForScore = maxBasinY;

        if (this.theme === "emerald_spire") {
          inBasin =
            Math.abs(u) >= 0.38 &&
            Math.abs(v) >= 0.38 &&
            radial >= minBasinRadial &&
            radial <= maxSafeRadial &&
            surfaceY >= minBasinY &&
            surfaceY <= maxBasinY;
          distFromBasinIdeal = Math.hypot(
            Math.abs(u) - 0.6,
            Math.abs(v) - 0.6,
          );
        } else if (this.theme === "canyon_arch") {
          const canyonMinY = this.worldHeight * 0.38;
          const canyonMaxY = this.worldHeight * 0.56;
          heightCapForScore = canyonMaxY;
          inBasin =
            Math.abs(u) >= 0.48 &&
            Math.abs(v) >= 0.42 &&
            radial >= halfSpan * 0.62 &&
            radial <= maxSafeRadial &&
            surfaceY >= canyonMinY &&
            surfaceY <= canyonMaxY;
          distFromBasinIdeal = Math.hypot(
            Math.abs(u) - 0.68,
            Math.abs(v) - 0.58,
          );
        } else if (this.theme === "twin_pillars") {
          const isUpperDeckQuad = quadrant === 0 || quadrant === 3;
          if (isUpperDeckQuad) {
            heightCapForScore = this.worldHeight * 0.66;
            inBasin =
              Math.abs(u) >= 0.32 &&
              Math.abs(u) <= 0.64 &&
              Math.abs(v) >= 0.14 &&
              Math.abs(v) <= 0.4 &&
              surfaceY >= this.worldHeight * 0.52 &&
              surfaceY <= this.worldHeight * 0.66;
            distFromBasinIdeal = Math.hypot(
              Math.abs(u) - 0.48,
              Math.abs(v) - 0.28,
            );
          } else {
            heightCapForScore = this.worldHeight * 0.3;
            inBasin =
              Math.abs(u) >= 0.48 &&
              Math.abs(v) >= 0.46 &&
              radial >= minBasinRadial &&
              radial <= maxSafeRadial &&
              surfaceY >= Math.max(4.2, this.worldHeight * 0.16) &&
              surfaceY <= this.worldHeight * 0.3;
            distFromBasinIdeal = Math.hypot(
              Math.abs(u) - 0.64,
              Math.abs(v) - 0.6,
            );
          }
        } else {
          // mountain_spine: 4 staggered cantilevered cliffside rib-terraces
          const spineMinY = this.worldHeight * 0.24;
          const spineMaxY = this.worldHeight * 0.48;
          heightCapForScore = spineMaxY;
          const isOuterRib = quadrant === 1 || quadrant === 2;
          const idealU = isOuterRib ? 0.64 : 0.52;
          const idealV = isOuterRib ? 0.46 : 0.5;
          inBasin =
            Math.abs(u) >= 0.36 &&
            Math.abs(v) >= 0.32 &&
            radial >= minBasinRadial &&
            radial <= maxSafeRadial &&
            surfaceY >= spineMinY &&
            surfaceY <= spineMaxY;
          distFromBasinIdeal = Math.hypot(
            Math.abs(u) - idealU,
            Math.abs(v) - idealV,
          );
        }

        // Prefer broad central flats inside each sheltered quadrant basin
        const basinCenterBonus = Math.max(0, 1.0 - distFromBasinIdeal * 2.2) * 8.0;
        const footingBonus = stableFooting ? 5.0 : 0.0;
        const score =
          (inBasin ? 30.0 : 0.0) +
          basinCenterBonus +
          normal.y * 4.0 +
          footingBonus +
          Math.min(surfaceY, heightCapForScore) * 0.35 +
          rng() * 0.35;

        candidates.push({
          pos: { x, y: surfaceY, z },
          quadrant,
          radial,
          inBasin,
          score,
        });
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    candidates.sort((a, b) => b.score - a.score);

    const primaryTarget = Math.min(targetCount, 4);
    const basinPreferred = candidates.filter((c) => c.inBasin);
    const firstPool = basinPreferred.length > 0 ? basinPreferred : candidates;

    const runGreedyPrimary = (startCand: SpawnCandidate): Vec3[] => {
      const picked: Vec3[] = [{ ...startCand.pos }];
      const usedQuads = new Set<number>([startCand.quadrant]);

      while (picked.length < primaryTarget && picked.length < candidates.length) {
        let bestCandidate: SpawnCandidate | null = null;
        let bestMetric = -Infinity;

        const unusedQuadPool = candidates.filter(
          (c) => !usedQuads.has(c.quadrant),
        );
        const searchPool = unusedQuadPool.length > 0 ? unusedQuadPool : candidates;

        for (const cand of searchPool) {
          let minDist = Infinity;
          let blocksAllLos = true;
          for (const existing of picked) {
            const d = Math.hypot(
              cand.pos.x - existing.x,
              cand.pos.y - existing.y,
              cand.pos.z - existing.z,
            );
            if (d < minDist) {
              minDist = d;
            }
            if (blocksAllLos && this.hasDirectLineOfSight(cand.pos, existing, 1.1)) {
              blocksAllLos = false;
            }
          }
          if (minDist < 0.01) {
            continue;
          }
          const losBonus = blocksAllLos ? 500.0 : 0.0;
          const meetsSeparation = minDist >= minSep ? 120.0 : 0.0;
          const basinBonus = cand.inBasin ? 60.0 : 0.0;
          const safeInnerRing = cand.radial <= maxSafeRadial ? 25.0 : 0.0;
          const metric =
            losBonus +
            meetsSeparation +
            basinBonus +
            safeInnerRing +
            Math.min(minDist, minSep * 1.45) +
            cand.score * 0.35;
          if (metric > bestMetric) {
            bestMetric = metric;
            bestCandidate = cand;
          }
        }

        if (!bestCandidate) {
          break;
        }
        picked.push({ ...bestCandidate.pos });
        usedQuads.add(bestCandidate.quadrant);
      }
      return picked;
    };

    const scorePrimarySet = (pts: readonly Vec3[]): number => {
      let minPair = Infinity;
      let losFailures = 0;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i];
          const b = pts[j];
          if (!a || !b) continue;
          const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
          if (d < minPair) minPair = d;
          if (this.hasDirectLineOfSight(a, b, 1.1)) {
            losFailures += 1;
          }
        }
      }
      const sepOk = pts.length < 2 || minPair >= minSep ? 1 : 0;
      return (losFailures === 0 ? 1000 : -losFailures * 500) + sepOk * 200 + Math.min(minPair, minSep * 1.5);
    };

    const first = firstPool[0];
    let selected: Vec3[] = first ? runGreedyPrimary(first) : [];

    // For non-emerald_spire distinct layouts, if greedy start missed any LOS/separation pair, try alternate quadrant starts
    if (this.theme !== "emerald_spire" && selected.length >= 2) {
      let bestSetScore = scorePrimarySet(selected);
      if (bestSetScore < 1200) {
        for (let q = 0; q < 4; q++) {
          const altStart = firstPool.find((c) => c.quadrant === q);
          if (!altStart || altStart === first) continue;
          const altSelected = runGreedyPrimary(altStart);
          const altScore = scorePrimarySet(altSelected);
          if (altScore > bestSetScore) {
            bestSetScore = altScore;
            selected = altSelected;
            if (bestSetScore >= 1200) break;
          }
        }
      }
    }

    // Extra points beyond 4 (Evo Pod drop zones including central high-ground spires & arches)
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
        const metric = minDist + cand.pos.y * 0.55 + cand.score * 0.1;
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

  /**
   * Scan the current SDF density grid to find the tallest remaining solid surface height (in meters).
   * Used by Round 5's Stage 2 Ocean Deluge to guarantee water submerges every surviving peak.
   */
  public getHighestSolidY(): number {
    const { nx, ny, nz, voxelSize: vs } = this.dims;
    let highest = 0;

    for (let iy = ny - 2; iy >= 1; iy--) {
      let foundAtLayer = false;
      for (let iz = 1; iz < nz - 1; iz++) {
        const rowBase = nx * (iy + ny * iz);
        for (let ix = 1; ix < nx - 1; ix++) {
          const v = this.values[ix + rowBase] ?? OUTSIDE_AIR_VALUE;
          if (v < 0) {
            foundAtLayer = true;
            const above = this.values[ix + nx * (iy + 1 + ny * iz)] ?? OUTSIDE_AIR_VALUE;
            const denom = above - v;
            const frac = denom > 1e-6 ? Math.max(0, Math.min(1, -v / denom)) : 0;
            const y = (iy + frac) * vs;
            if (y > highest) {
              highest = y;
            }
          }
        }
      }
      if (foundAtLayer) {
        return Number(highest.toFixed(4));
      }
    }

    return 0;
  }

  /**
   * Find dry spawn points across a persistently carved multi-round island.
   * Starts with standard `findSpawnPoints(count)` above `waterLevel + 0.8`,
   * then progressively relaxes slope/clearance (`normal.y >= 0.35`), then picks
   * highest remaining solid terrain above `waterLevel + 0.3`, with an emergency fallback.
   */
  public findPersistentRoundSpawnPoints(
    count: number,
    waterLevel: number,
  ): Vec3[] {
    const targetCount = Math.max(0, Math.floor(count));
    if (targetCount === 0) {
      return [];
    }

    const selected: Vec3[] = this.findSpawnPoints(targetCount).filter(
      (pt) => pt.y > waterLevel + 0.8,
    );
    if (selected.length >= targetCount) {
      return selected.slice(0, targetCount);
    }

    const isGrand = this.mapScale === "grand";
    const margin = isGrand ? 6.0 : 3.5;
    const step = isGrand ? 2.6 : 1.5;

    const appendMaximallySeparated = (pool: readonly Vec3[], minDistFloor: number): void => {
      while (selected.length < targetCount && pool.length > 0) {
        let best: Vec3 | null = null;
        let bestScore = -Infinity;
        for (const cand of pool) {
          let minDist = Infinity;
          for (const existing of selected) {
            const d = Math.hypot(
              cand.x - existing.x,
              cand.y - existing.y,
              cand.z - existing.z,
            );
            if (d < minDist) {
              minDist = d;
            }
          }
          if (selected.length > 0 && minDist < minDistFloor) {
            continue;
          }
          const score =
            (selected.length === 0 ? 0 : Math.min(minDist, isGrand ? 40.0 : 20.0)) +
            cand.y * 0.45;
          if (score > bestScore) {
            bestScore = score;
            best = cand;
          }
        }
        if (!best) {
          break;
        }
        selected.push({ ...best });
      }
    };

    // Pass 2: progressively relaxed slope (normal.y >= 0.35) & clearance above waterLevel + 0.8
    const relaxedCandidates: Vec3[] = [];
    for (let x = margin; x <= this.worldWidth - margin; x += step) {
      for (let z = margin; z <= this.worldDepth - margin; z += step) {
        const surfaceY = this.getSurfaceY(x, z);
        if (surfaceY === null || surfaceY <= waterLevel + 0.8) {
          continue;
        }
        const normal = this.sampleNormal(x, surfaceY, z);
        if (normal.y < 0.35) {
          continue;
        }
        if (this.sample(x, surfaceY + 0.9, z) <= 0) {
          continue;
        }
        relaxedCandidates.push({ x, y: surfaceY, z });
      }
    }
    appendMaximallySeparated(relaxedCandidates, 1.4);

    // Pass 3: highest remaining solid voxels above waterLevel + 0.3
    if (selected.length < targetCount) {
      const solidFallback: Vec3[] = [];
      for (let x = margin; x <= this.worldWidth - margin; x += step) {
        for (let z = margin; z <= this.worldDepth - margin; z += step) {
          const surfaceY = this.getSurfaceY(x, z);
          if (surfaceY === null || surfaceY <= waterLevel + 0.3) {
            continue;
          }
          solidFallback.push({ x, y: surfaceY, z });
        }
      }
      solidFallback.sort((a, b) => b.y - a.y);
      appendMaximallySeparated(solidFallback, 1.0);
      // If still short due to tight remaining rock pillar, allow closer placement
      if (selected.length < targetCount) {
        appendMaximallySeparated(solidFallback, 0.2);
      }
    }

    // Pass 4: absolute emergency fallback if entire island was somehow vaporized
    while (selected.length < targetCount) {
      const idx = selected.length;
      const offset = idx === 0 ? 0 : (idx % 2 === 0 ? 1 : -1) * Math.ceil(idx / 2) * 1.2;
      selected.push({
        x: this.centerX + offset,
        y: waterLevel + 2.0,
        z: this.centerZ,
      });
    }

    return selected.slice(0, targetCount);
  }

  /**
   * Deterministically place 8-10 interactive hazards on Duel (60m) and 14-18 hazards
   * on Grand (144m) across all 4 types (blast_barrel, spark_mine, steam_geyser, thorn_patch),
   * tucking Blast Barrels near destructible wall seams and Spark Mines in narrow passes.
   */
  public findHazardPoints(spawnPoints: readonly Vec3[]): HazardPlacement[] {
    const rng = createSeededRng(this.seed ^ 0x7c3e91);
    const isGrand = this.mapScale === "grand";
    const halfSpan = this.worldWidth * 0.44;
    const margin = isGrand ? 10.0 : 5.5;
    const step = isGrand ? 2.6 : 1.5;
    const spawnClearance = isGrand ? 5.2 : 4.2;
    const maxRadial = isGrand ? 61.5 : 25.5;

    interface HazardCandidate {
      pos: Vec3;
      radial: number;
      isWallSeam: boolean;
      isPassMine: boolean;
      isValleyLaunch: boolean;
      isShortcut: boolean;
      jitter: number;
    }

    const candidates: HazardCandidate[] = [];
    const probeDist = isGrand ? 3.8 : 2.4;

    for (let x = margin; x <= this.worldWidth - margin; x += step) {
      for (let z = margin; z <= this.worldDepth - margin; z += step) {
        const surfaceY = this.getSurfaceY(x, z);
        if (surfaceY === null || surfaceY < 2.25) {
          continue;
        }
        const normal = this.sampleNormal(x, surfaceY, z);
        if (normal.y < 0.65) {
          continue;
        }
        if (
          this.sample(x, surfaceY + 1.0, z) <= 0.1 ||
          this.sample(x, surfaceY + 2.0, z) <= 0.1 ||
          !this.isSolid(x, surfaceY - 1.0, z)
        ) {
          continue;
        }

        let tooCloseToSpawn = false;
        for (const sp of spawnPoints) {
          if (Math.hypot(x - sp.x, surfaceY - sp.y, z - sp.z) < spawnClearance) {
            tooCloseToSpawn = true;
            break;
          }
        }
        if (tooCloseToSpawn) {
          continue;
        }

        const radial = Math.hypot(x - this.centerX, z - this.centerZ);
        if (radial > maxRadial) {
          continue;
        }

        let hasNearbyDrop = false;
        let hasNearbyHighCliff = false;
        const probes: ReadonlyArray<readonly [number, number]> = [
          [probeDist, 0],
          [-probeDist, 0],
          [0, probeDist],
          [0, -probeDist],
        ];
        for (const [dx, dz] of probes) {
          const ny = this.getSurfaceY(x + dx, z + dz);
          if (ny === null || ny <= surfaceY - 2.2) {
            hasNearbyDrop = true;
          }
          if (ny !== null && ny >= surfaceY + 2.6) {
            hasNearbyHighCliff = true;
          }
        }

        let clearSky = true;
        const skyLimit = isGrand ? 14.0 : 9.0;
        for (let h = 2.5; h <= skyLimit; h += 1.8) {
          if (this.isSolid(x, surfaceY + h, z)) {
            clearSky = false;
            break;
          }
        }

        const u = Math.abs((x - this.centerX) / halfSpan);
        const v = Math.abs((z - this.centerZ) / halfSpan);
        const nearAxisWall = Math.min(u, v) <= 0.28;
        const hasOpenFlank =
          this.sample(x + 1.8, surfaceY + 0.8, z) > 0.05 &&
          this.sample(x - 1.8, surfaceY + 0.8, z) > 0.05 &&
          this.sample(x, surfaceY + 0.8, z + 1.8) > 0.05 &&
          this.sample(x, surfaceY + 0.8, z - 1.8) > 0.05;

        const isWallSeam =
          hasOpenFlank &&
          surfaceY >= 3.8 &&
          (nearAxisWall || hasNearbyHighCliff || hasNearbyDrop);
        const isPassMine =
          surfaceY >= 3.0 &&
          (nearAxisWall || (radial >= halfSpan * 0.2 && radial <= halfSpan * 0.85));
        const isValleyLaunch =
          clearSky &&
          surfaceY >= 2.25 &&
          surfaceY <= (isGrand ? 18.0 : 11.2) &&
          (hasNearbyHighCliff || surfaceY <= (isGrand ? 15.0 : 8.8));
        const isShortcut =
          surfaceY >= 3.0 &&
          radial >= halfSpan * 0.22 &&
          radial <= halfSpan * 0.9;

        candidates.push({
          pos: { x, y: surfaceY, z },
          radial,
          isWallSeam,
          isPassMine,
          isValleyLaunch,
          isShortcut,
          jitter: rng(),
        });
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    const placed: HazardPlacement[] = [];

    const farEnough = (pos: Vec3, minDist: number): boolean => {
      for (const h of placed) {
        const d = Math.hypot(
          pos.x - h.position.x,
          pos.y - h.position.y,
          pos.z - h.position.z,
        );
        if (d < minDist) {
          return false;
        }
      }
      return true;
    };

    const pickFromPool = (
      pool: HazardCandidate[],
      type: HazardType,
      radius: number,
      count: number,
      minSpacing: number,
    ): void => {
      const sorted = [...pool].sort((a, b) => b.jitter - a.jitter);
      let added = 0;
      for (const cand of sorted) {
        if (added >= count) break;
        if (!farEnough(cand.pos, minSpacing)) continue;
        placed.push({ type, position: { ...cand.pos }, radius });
        added += 1;
      }
      if (added < count) {
        const fallback = [...candidates].sort((a, b) => b.jitter - a.jitter);
        for (const cand of fallback) {
          if (added >= count) break;
          if (!farEnough(cand.pos, Math.max(3.6, minSpacing * 0.6))) continue;
          placed.push({ type, position: { ...cand.pos }, radius });
          added += 1;
        }
      }
    };

    const spacingMult = isGrand ? 1.55 : 1.0;

    // 1. Blast Barrels (radius 1.4): guarantee 1 volatile barrel near each theme's 4 signature chokepoints
    //    (emerald_spire keeps exact 4 destructible gate seams unchanged)
    const gateSeamAnchors: ReadonlyArray<readonly [number, number]> =
      this.theme === "emerald_spire"
        ? [
            [this.centerX, this.centerZ - 0.58 * halfSpan],
            [this.centerX, this.centerZ + 0.58 * halfSpan],
            [this.centerX - 0.58 * halfSpan, this.centerZ],
            [this.centerX + 0.58 * halfSpan, this.centerZ],
          ]
        : this.theme === "canyon_arch"
          ? [
              [this.centerX - 0.42 * halfSpan, this.centerZ - 0.38 * halfSpan],
              [this.centerX + 0.32 * halfSpan, this.centerZ - 0.38 * halfSpan],
              [this.centerX - 0.32 * halfSpan, this.centerZ + 0.38 * halfSpan],
              [this.centerX + 0.42 * halfSpan, this.centerZ + 0.38 * halfSpan],
            ]
          : this.theme === "twin_pillars"
            ? [
                [this.centerX - 0.28 * halfSpan, this.centerZ - 0.04 * halfSpan],
                [this.centerX + 0.28 * halfSpan, this.centerZ + 0.04 * halfSpan],
                [this.centerX + 0.56 * halfSpan, this.centerZ - 0.38 * halfSpan],
                [this.centerX - 0.56 * halfSpan, this.centerZ + 0.38 * halfSpan],
              ]
            : [
                // mountain_spine: central rib-tunnel mouths & curved flank ridge necks
                [this.centerX - 0.28 * halfSpan, this.centerZ - 0.24 * halfSpan],
                [this.centerX + 0.28 * halfSpan, this.centerZ + 0.24 * halfSpan],
                [this.centerX - 0.56 * halfSpan, this.centerZ - 0.02 * halfSpan],
                [this.centerX + 0.56 * halfSpan, this.centerZ + 0.02 * halfSpan],
              ];
    for (const [gx, gz] of gateSeamAnchors) {
      let bestGateCand: HazardCandidate | null = null;
      let bestGateScore = Infinity;
      for (const cand of candidates) {
        if (!farEnough(cand.pos, isGrand ? 5.0 : 3.6)) continue;
        const dSeam = Math.hypot(cand.pos.x - gx, cand.pos.z - gz);
        const score = dSeam - (cand.isWallSeam ? 1.2 : 0);
        if (score < bestGateScore) {
          bestGateScore = score;
          bestGateCand = cand;
        }
      }
      if (bestGateCand) {
        placed.push({
          type: "blast_barrel",
          position: { ...bestGateCand.pos },
          radius: 1.4,
        });
      }
    }

    // Add chain-detonation partner barrels on Grand (2 extra -> 6 total barrels)
    const barrelPool = candidates.filter((c) => c.isWallSeam);
    const partnerCount = isGrand ? 2 : 0;
    const primaryBarrels = placed.filter((h) => h.type === "blast_barrel");
    for (let pIdx = 0; pIdx < partnerCount; pIdx++) {
      const anchorBarrel = primaryBarrels[pIdx];
      if (!anchorBarrel) {
        pickFromPool(barrelPool, "blast_barrel", 1.4, 1, 5.5 * spacingMult);
        continue;
      }
      const partner = candidates.find((c) => {
        const dAnchor = Math.hypot(
          c.pos.x - anchorBarrel.position.x,
          c.pos.y - anchorBarrel.position.y,
          c.pos.z - anchorBarrel.position.z,
        );
        if (dAnchor < 3.1 || dAnchor > 4.2) return false;
        return placed.every((other) => {
          if (other === anchorBarrel) return true;
          return (
            Math.hypot(
              c.pos.x - other.position.x,
              c.pos.y - other.position.y,
              c.pos.z - other.position.z,
            ) >= 4.5
          );
        });
      });
      if (partner) {
        placed.push({
          type: "blast_barrel",
          position: { ...partner.pos },
          radius: 1.4,
        });
      } else {
        pickFromPool(barrelPool, "blast_barrel", 1.4, 1, 5.5 * spacingMult);
      }
    }

    // 2. Spark Mines (radius 2.4) guarding narrow passes & dividing-wall approaches
    const minePool = candidates.filter((c) => c.isPassMine);
    pickFromPool(
      minePool,
      "spark_mine",
      2.4,
      isGrand ? 4 : 2,
      6.4 * spacingMult,
    );

    // 3. Thermal Steam Geysers (radius 1.7) in valleys & beside tall walls for vertical flanking
    const geyserPool = candidates
      .filter((c) => c.isValleyLaunch)
      .sort((a, b) => a.pos.y - b.pos.y + (b.jitter - a.jitter) * 3.0);
    pickFromPool(
      geyserPool,
      "steam_geyser",
      1.7,
      isGrand ? 4 : 2,
      6.2 * spacingMult,
    );

    // 4. Bramble Thorn Patches (radius 1.9) in canyon shortcuts & flanking routes
    const thornPool = candidates.filter((c) => c.isShortcut);
    pickFromPool(
      thornPool,
      "thorn_patch",
      1.9,
      isGrand ? 3 : 2,
      5.8 * spacingMult,
    );

    return placed.slice(0, isGrand ? 18 : 10);
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

  /** Return all chunk coordinates covering the SDF world (75 on Duel, 192 on Grand). */
  public getAllChunkCoords(): ChunkCoord[] {
    const coords: ChunkCoord[] = [];
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cz = 0; cz < this.chunksZ; cz++) {
        for (let cx = 0; cx < this.chunksX; cx++) {
          coords.push({ cx, cy, cz });
        }
      }
    }
    return coords;
  }

  private generateTerrain(): void {
    const rng = createSeededRng(this.seed);
    const jitter: ThemeJitter = {
      westHeight: (rng() - 0.5) * 1.2,
      eastHeight: (rng() - 0.5) * 1.2,
      archBoost: (rng() - 0.5) * 1.0,
      northShift: (rng() - 0.5) * 1.4,
      southShift: (rng() - 0.5) * 1.4,
    };
    const noise = createValueNoise3D(this.seed);
    const { nx, ny, nz, voxelSize: vs } = this.dims;
    const isGrand = this.mapScale === "grand";
    const halfSpan = this.worldWidth * 0.44;
    const spawnTopY = isGrand ? 16.0 : 9.1;
    const layout: ThemeLayoutContext = {
      cx: this.centerX,
      cz: this.centerZ,
      halfSpan,
      worldHeight: this.worldHeight,
      wScale: halfSpan / 26.4,
      hScale: this.worldHeight / 27.0,
      isGrand,
      bottomY: isGrand ? 2.4 : 1.85,
      spawnTopY,
      wallTopY: spawnTopY + (isGrand ? 11.4 : 8.5),
      centralPeakY: this.worldHeight * 0.66,
      tunnelY: this.worldHeight * 0.2,
    };

    for (let iz = 0; iz < nz; iz++) {
      const wz = iz * vs;
      const zBorder = iz <= 1 || iz >= nz - 2;
      for (let iy = 0; iy < ny; iy++) {
        const wy = iy * vs;
        const yBorder = iy <= 1 || iy >= ny - 2;
        const rowBase = nx * (iy + ny * iz);
        for (let ix = 0; ix < nx; ix++) {
          const xBorder = ix <= 1 || ix >= nx - 2;
          const idx = ix + rowBase;
          if (xBorder || yBorder || zBorder) {
            this.values[idx] = BORDER_AIR_MIN;
            continue;
          }
          const wx = ix * vs;
          const d = evaluateThemeSdf(this.theme, wx, wy, wz, layout, jitter, noise);
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
    const cs = this.dims.chunkSize;
    const minCx = Math.max(0, Math.floor((ix - 2) / cs));
    const maxCx = Math.min(this.chunksX - 1, Math.floor((ix + 1) / cs));
    const minCy = Math.max(0, Math.floor((iy - 2) / cs));
    const maxCy = Math.min(this.chunksY - 1, Math.floor((iy + 1) / cs));
    const minCz = Math.max(0, Math.floor((iz - 2) / cs));
    const maxCz = Math.min(this.chunksZ - 1, Math.floor((iz + 1) / cs));

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          dirtyChunks.add(chunkKey(cx, cy, cz));
        }
      }
    }
  }
}
