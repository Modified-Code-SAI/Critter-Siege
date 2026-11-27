import * as THREE from "three";
import {
  SDF_DIMS,
  type SdfWorld,
  type ThemeId,
  type Vec3,
} from "@critter/shared";

const DEFAULT_WORLD_SPAN_X = SDF_DIMS.nx * SDF_DIMS.voxelSize;
const DEFAULT_WORLD_SPAN_Y = SDF_DIMS.ny * SDF_DIMS.voxelSize;
const DEFAULT_WORLD_SPAN_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize;
const DEFAULT_WORLD_HALF = Math.max(DEFAULT_WORLD_SPAN_X, DEFAULT_WORLD_SPAN_Z) * 0.5;
const DEFAULT_ISLAND_CENTER = new THREE.Vector3(
  DEFAULT_WORLD_SPAN_X * 0.5,
  8.0,
  DEFAULT_WORLD_SPAN_Z * 0.5,
);
const DEFAULT_WATER_LEVEL = 2.0;
const FOG_COLOR_HEX = 0xdbeeff;
const DUEL_FOG_DENSITY = 0.0038;
const GRAND_FOG_DENSITY = 0.0022;
const BASE_OCEAN_SPAN = 420;
const BASE_CLOUD_RADIUS = DEFAULT_WORLD_SPAN_X * 1.12;
const BASE_SKY_RADIUS = Math.max(260, DEFAULT_WORLD_HALF * 9.5);
const SHADOW_MAP_SIZE = 2048;
const GRAND_FOCUS_SHADOW_HALF = 46.0;
const SHORELINE_TEX_RES = 128;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface AtmosphereKeyframe {
  readonly zenith: THREE.Color;
  readonly midSky: THREE.Color;
  readonly horizon: THREE.Color;
  readonly oceanBounce: THREE.Color;
  readonly sunColor: THREE.Color;
  readonly sunIntensity: number;
  readonly hemiSky: THREE.Color;
  readonly hemiGround: THREE.Color;
  readonly hemiIntensity: number;
  readonly fillColor: THREE.Color;
  readonly fillIntensity: number;
  readonly fogColor: THREE.Color;
}

const ATMOSPHERE_MORNING: AtmosphereKeyframe = {
  zenith: new THREE.Color(0x1e76cf),
  midSky: new THREE.Color(0x74c8f8),
  horizon: new THREE.Color(0xffe8c2),
  oceanBounce: new THREE.Color(0x1b92b5),
  sunColor: new THREE.Color(0xffebd0),
  sunIntensity: 2.2,
  hemiSky: new THREE.Color(0xa8e6ff),
  hemiGround: new THREE.Color(0x7a7b4c),
  hemiIntensity: 0.98,
  fillColor: new THREE.Color(0x88d4ff),
  fillIntensity: 0.52,
  fogColor: new THREE.Color(FOG_COLOR_HEX),
};

const ATMOSPHERE_AFTERNOON: AtmosphereKeyframe = {
  zenith: new THREE.Color(0x2254a4),
  midSky: new THREE.Color(0x8ea7db),
  horizon: new THREE.Color(0xffc17a),
  oceanBounce: new THREE.Color(0x1c6f94),
  sunColor: new THREE.Color(0xffd296),
  sunIntensity: 2.35,
  hemiSky: new THREE.Color(0xffd9b0),
  hemiGround: new THREE.Color(0x76643f),
  hemiIntensity: 0.92,
  fillColor: new THREE.Color(0x9bb8e8),
  fillIntensity: 0.48,
  fogColor: new THREE.Color(0xf4d8ba),
};

const ATMOSPHERE_SUNSET_STORM: AtmosphereKeyframe = {
  zenith: new THREE.Color(0x192356),
  midSky: new THREE.Color(0x6b467a),
  horizon: new THREE.Color(0xff7a4d),
  oceanBounce: new THREE.Color(0x173e62),
  sunColor: new THREE.Color(0xff9a62),
  sunIntensity: 2.5,
  hemiSky: new THREE.Color(0xd48e98),
  hemiGround: new THREE.Color(0x554238),
  hemiIntensity: 0.86,
  fillColor: new THREE.Color(0x6c88c4),
  fillIntensity: 0.44,
  fogColor: new THREE.Color(0xc89382),
};

const OCEAN_SHALLOW_BASE = new THREE.Color(0x1cd6d2);
const OCEAN_MID_BASE = new THREE.Color(0x0c88ba);
const OCEAN_DEEP_BASE = new THREE.Color(0x0a3d80);

const OCEAN_SHALLOW_STORM = new THREE.Color(0x138896);
const OCEAN_MID_STORM = new THREE.Color(0x0a4f78);
const OCEAN_DEEP_STORM = new THREE.Color(0x071e46);
const STORM_FOG_TINT = new THREE.Color(0x4a5b74);

/** Dynamically scaled visual parameters computed for a 60m Duel or 144m Grand world. */
export interface WorldSceneMetrics {
  worldSize: number;
  oceanSpan: number;
  shadowHalf: number;
  fogDensity: number;
  cloudRadius: number;
  isletMinDist: number;
  isletMaxDist: number;
}

/** Curated sunlit sky, lighting, cloud, distant-islet, and ocean palette tailored per biome. */
export interface ThemeAtmosphere {
  theme: ThemeId;
  skyZenith: number;
  skyMid: number;
  skyHorizon: number;
  oceanBounce: number;
  sunColor: number;
  sunIntensity: number;
  sunOffset: { x: number; y: number; z: number };
  sunCoreColor: number;
  sunHaloColor: number;
  hemiSkyColor: number;
  hemiGroundColor: number;
  hemiIntensity: number;
  fillColor: number;
  fillIntensity: number;
  fogColor: number;
  cloudHighlight: number;
  cloudShadow: number;
  oceanShallow: number;
  oceanMid: number;
  oceanDeep: number;
  oceanFoam: number;
  isletRockColor: number;
  isletGrassColor: number;
  isletPineColor: number;
}

const THEME_ATMOSPHERES: Readonly<Record<ThemeId, ThemeAtmosphere>> = {
  emerald_spire: {
    theme: "emerald_spire",
    skyZenith: 0x1a72d4,
    skyMid: 0x6ec6fa,
    skyHorizon: 0xffe9c4,
    oceanBounce: 0x1a95b8,
    sunColor: 0xffe6be,
    sunIntensity: 2.48,
    sunOffset: { x: 1.25, y: 1.65, z: 0.95 },
    sunCoreColor: 0xfff8de,
    sunHaloColor: 0xffd27a,
    hemiSkyColor: 0x9ce0ff,
    hemiGroundColor: 0x2f5a6e,
    hemiIntensity: 0.36,
    fillColor: 0x4ca8e8,
    fillIntensity: 0.2,
    fogColor: 0xdbeeff,
    cloudHighlight: 0xfff8e6,
    cloudShadow: 0x7ca2cc,
    oceanShallow: 0x1ed8d4,
    oceanMid: 0x0c88ba,
    oceanDeep: 0x0a3d80,
    oceanFoam: 0xefffff,
    isletRockColor: 0x8b7e78,
    isletGrassColor: 0x5c9c64,
    isletPineColor: 0x3b7652,
  },
  canyon_arch: {
    theme: "canyon_arch",
    skyZenith: 0x225eb8,
    skyMid: 0x76b4ea,
    skyHorizon: 0xffd49e,
    oceanBounce: 0x26859b,
    sunColor: 0xffd096,
    sunIntensity: 2.58,
    sunOffset: { x: 1.48, y: 1.32, z: 0.78 },
    sunCoreColor: 0xfff2d2,
    sunHaloColor: 0xffb35c,
    hemiSkyColor: 0xb6dbff,
    hemiGroundColor: 0x484f72,
    hemiIntensity: 0.34,
    fillColor: 0x5c9ce0,
    fillIntensity: 0.2,
    fogColor: 0xf4dec8,
    cloudHighlight: 0xffeed2,
    cloudShadow: 0x8984b0,
    oceanShallow: 0x22c8bd,
    oceanMid: 0x107a9e,
    oceanDeep: 0x0c3c6b,
    oceanFoam: 0xfff9ef,
    isletRockColor: 0xa67456,
    isletGrassColor: 0x7a9652,
    isletPineColor: 0x486e46,
  },
  twin_pillars: {
    theme: "twin_pillars",
    skyZenith: 0x1465c8,
    skyMid: 0x5ec9f5,
    skyHorizon: 0xdff6ff,
    oceanBounce: 0x1999bd,
    sunColor: 0xffeed2,
    sunIntensity: 2.46,
    sunOffset: { x: 1.05, y: 1.82, z: 1.12 },
    sunCoreColor: 0xfffdf0,
    sunHaloColor: 0xffe49c,
    hemiSkyColor: 0x94e0ff,
    hemiGroundColor: 0x295970,
    hemiIntensity: 0.38,
    fillColor: 0x52b6ec,
    fillIntensity: 0.18,
    fogColor: 0xd6f0ff,
    cloudHighlight: 0xfff9ea,
    cloudShadow: 0x739fc8,
    oceanShallow: 0x20e0da,
    oceanMid: 0x0b90c6,
    oceanDeep: 0x08408a,
    oceanFoam: 0xf2ffff,
    isletRockColor: 0x828488,
    isletGrassColor: 0x54a068,
    isletPineColor: 0x347458,
  },
  mountain_spine: {
    theme: "mountain_spine",
    skyZenith: 0x1b4fa8,
    skyMid: 0x6eaee6,
    skyHorizon: 0xe6effa,
    oceanBounce: 0x24739e,
    sunColor: 0xffeccd,
    sunIntensity: 2.4,
    sunOffset: { x: 1.18, y: 1.55, z: -1.05 },
    sunCoreColor: 0xfffbee,
    sunHaloColor: 0xffdfa0,
    hemiSkyColor: 0xaed8ff,
    hemiGroundColor: 0x354e70,
    hemiIntensity: 0.4,
    fillColor: 0x6ba6ea,
    fillIntensity: 0.22,
    fogColor: 0xdce8f6,
    cloudHighlight: 0xfff8ec,
    cloudShadow: 0x7892bf,
    oceanShallow: 0x2cc2c8,
    oceanMid: 0x1477ab,
    oceanDeep: 0x0a3469,
    oceanFoam: 0xf0f9ff,
    isletRockColor: 0x737d8c,
    isletGrassColor: 0x4f8c66,
    isletPineColor: 0x2c5e4b,
  },
};

/** Return the curated sunlit atmosphere palette for any island biome theme. */
export function getThemeAtmosphere(theme: ThemeId): ThemeAtmosphere {
  const palette = THEME_ATMOSPHERES[theme] ?? THEME_ATMOSPHERES.emerald_spire;
  return {
    ...palette,
    sunOffset: { ...palette.sunOffset },
  };
}

/** Computed round-progression sky/lighting palette and churning flood wave parameters. */
export interface AtmosphereState {
  roundProgress: number;
  floodIntensity: number;
  waveAmp: number;
  waveSpeed: number;
  zenithColor: THREE.Color;
  midSkyColor: THREE.Color;
  horizonColor: THREE.Color;
  oceanBounceColor: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSkyColor: THREE.Color;
  hemiGroundColor: THREE.Color;
  hemiIntensity: number;
  fillColor: THREE.Color;
  fillIntensity: number;
  fogColor: THREE.Color;
  shallowOceanColor: THREE.Color;
  midOceanColor: THREE.Color;
  deepOceanColor: THREE.Color;
}

/** Compute progressive Round 1-5 atmosphere colors and flood wave intensity deterministically. */
export function computeAtmosphereState(
  round: number,
  maxRounds: number,
  floodIntensity = 0,
): AtmosphereState {
  const safeMax = Number.isFinite(maxRounds) ? Math.max(1, Math.floor(maxRounds)) : 5;
  const safeRound = Number.isFinite(round) ? clamp(Math.floor(round), 1, safeMax) : 1;
  const roundProgress = safeMax <= 1 ? 0 : (safeRound - 1) / (safeMax - 1);
  const flood = clamp(Number.isFinite(floodIntensity) ? floodIntensity : 0, 0, 1);

  const from = roundProgress <= 0.5 ? ATMOSPHERE_MORNING : ATMOSPHERE_AFTERNOON;
  const to = roundProgress <= 0.5 ? ATMOSPHERE_AFTERNOON : ATMOSPHERE_SUNSET_STORM;
  const localT =
    roundProgress <= 0.5 ? roundProgress * 2 : (roundProgress - 0.5) * 2;

  const zenithColor = from.zenith.clone().lerp(to.zenith, localT);
  const midSkyColor = from.midSky.clone().lerp(to.midSky, localT);
  const horizonColor = from.horizon.clone().lerp(to.horizon, localT);
  const oceanBounceColor = from.oceanBounce.clone().lerp(to.oceanBounce, localT);
  const sunColor = from.sunColor.clone().lerp(to.sunColor, localT);
  const sunIntensity =
    from.sunIntensity + (to.sunIntensity - from.sunIntensity) * localT;
  const hemiSkyColor = from.hemiSky.clone().lerp(to.hemiSky, localT);
  const hemiGroundColor = from.hemiGround.clone().lerp(to.hemiGround, localT);
  const hemiIntensity =
    from.hemiIntensity + (to.hemiIntensity - from.hemiIntensity) * localT;
  const fillColor = from.fillColor.clone().lerp(to.fillColor, localT);
  const fillIntensity =
    from.fillIntensity + (to.fillIntensity - from.fillIntensity) * localT;
  const fogColor = from.fogColor
    .clone()
    .lerp(to.fogColor, localT)
    .lerp(STORM_FOG_TINT, flood * 0.58);

  if (flood > 0) {
    zenithColor.lerp(STORM_FOG_TINT, flood * 0.25);
    midSkyColor.lerp(STORM_FOG_TINT, flood * 0.35);
    oceanBounceColor.lerp(OCEAN_DEEP_STORM, flood * 0.45);
  }

  const shallowOceanColor = OCEAN_SHALLOW_BASE.clone().lerp(
    OCEAN_SHALLOW_STORM,
    flood,
  );
  const midOceanColor = OCEAN_MID_BASE.clone().lerp(OCEAN_MID_STORM, flood);
  const deepOceanColor = OCEAN_DEEP_BASE.clone().lerp(OCEAN_DEEP_STORM, flood);

  return {
    roundProgress,
    floodIntensity: flood,
    waveAmp: 1.0 + flood * 2.2,
    waveSpeed: 1.0 + flood * 1.1,
    zenithColor,
    midSkyColor,
    horizonColor,
    oceanBounceColor,
    sunColor,
    sunIntensity,
    hemiSkyColor,
    hemiGroundColor,
    hemiIntensity,
    fillColor,
    fillIntensity,
    fogColor,
    shallowOceanColor,
    midOceanColor,
    deepOceanColor,
  };
}

/** Compute ocean, sun-shadow, fog, cloud, and distant-islet metrics for any world width. */
export function computeWorldSceneMetrics(worldSize: number): WorldSceneMetrics {
  const safeSize =
    Number.isFinite(worldSize) && worldSize > 0 ? worldSize : DEFAULT_WORLD_SPAN_X;
  return {
    worldSize: safeSize,
    oceanSpan: Math.max(420, safeSize * 4.5),
    shadowHalf: safeSize * 0.62,
    fogDensity: safeSize > 90 ? GRAND_FOG_DENSITY : DUEL_FOG_DENSITY,
    cloudRadius: Math.max(36, safeSize * 1.12),
    isletMinDist: safeSize * 1.15,
    isletMaxDist: safeSize * 1.6,
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Sample the SDF waterline and submerged shelf into a smoothed RGBA lookup buffer
 * (`R` = shoreline proximity: 0 inside solid rock, ~0.18 at coastline, 1.0 at >= 9m open water;
 *  `G` = submerged seabed proximity for turquoise cove shallows).
 */
export function buildShorelineDepthData(
  world: SdfWorld,
  waterLevel: number,
  resolution = SHORELINE_TEX_RES,
): Uint8Array {
  const res = Math.max(
    4,
    Math.min(512, Math.floor(Number.isFinite(resolution) ? resolution : SHORELINE_TEX_RES)),
  );
  const safeWaterY = Number.isFinite(waterLevel) ? waterLevel : DEFAULT_WATER_LEVEL;
  const worldW = Math.max(1, world.worldWidth);
  const worldD = Math.max(1, world.worldDepth);
  const vs = Math.max(0.05, world.dims.voxelSize);

  // Stay inside the non-border interior of the SDF voxel grid so BORDER_AIR_MIN (1.5m)
  // never clamps true open-ocean distances down to 1.5m near world edges or the keel floor.
  const minX = vs * 2.0;
  const maxX = Math.max(minX, (world.dims.nx - 3.001) * vs);
  const minZ = vs * 2.0;
  const maxZ = Math.max(minZ, (world.dims.nz - 3.001) * vs);
  const minY = vs * 2.0;
  const maxY = Math.max(minY, (world.dims.ny - 3.001) * vs);

  const ySurf = Math.max(minY, Math.min(maxY, safeWaterY + 0.15));
  const ySub = Math.max(minY, Math.min(maxY, safeWaterY - 1.1));

  const texelCount = res * res;
  const rawR = new Float32Array(texelCount);
  const rawG = new Float32Array(texelCount);

  for (let iz = 0; iz < res; iz++) {
    const wz = ((iz + 0.5) / res) * worldD;
    const sz = Math.max(minZ, Math.min(maxZ, wz));
    const dzEdge = wz - sz;
    const rowOffset = iz * res;

    for (let ix = 0; ix < res; ix++) {
      const wx = ((ix + 0.5) / res) * worldW;
      const sx = Math.max(minX, Math.min(maxX, wx));
      const dxEdge = wx - sx;
      const edgeDist = Math.hypot(dxEdge, dzEdge);

      const dSurf = world.sample(sx, ySurf, sz) + edgeDist;
      const dSub = world.sample(sx, ySub, sz) + edgeDist;
      const dShore = Math.min(dSurf, dSub);

      // Encode R: -2m (deep solid) -> 0.0, 0m (coastline) -> 2/11 (~0.182), +9m (open sea) -> 1.0
      rawR[rowOffset + ix] = clamp01((dShore + 2.0) / 11.0);
      // Encode G: submerged shelf / cove shallows proximity (-2m -> 0.0, +11m -> 1.0)
      rawG[rowOffset + ix] = clamp01((dSub + 2.0) / 13.0);
    }
  }

  // Fast 1-pass separable 3-tap box blur (horizontal then vertical) for smooth coastal foam
  const tmpR = new Float32Array(texelCount);
  const tmpG = new Float32Array(texelCount);
  for (let iz = 0; iz < res; iz++) {
    const rowOffset = iz * res;
    for (let ix = 0; ix < res; ix++) {
      const left = ix > 0 ? ix - 1 : 0;
      const right = ix + 1 < res ? ix + 1 : res - 1;
      tmpR[rowOffset + ix] =
        ((rawR[rowOffset + left] ?? 1) +
          (rawR[rowOffset + ix] ?? 1) +
          (rawR[rowOffset + right] ?? 1)) /
        3;
      tmpG[rowOffset + ix] =
        ((rawG[rowOffset + left] ?? 1) +
          (rawG[rowOffset + ix] ?? 1) +
          (rawG[rowOffset + right] ?? 1)) /
        3;
    }
  }

  const rgba = new Uint8Array(texelCount * 4);
  for (let iz = 0; iz < res; iz++) {
    const up = (iz > 0 ? iz - 1 : 0) * res;
    const mid = iz * res;
    const down = (iz + 1 < res ? iz + 1 : res - 1) * res;
    for (let ix = 0; ix < res; ix++) {
      const rBlur =
        ((tmpR[up + ix] ?? 1) + (tmpR[mid + ix] ?? 1) + (tmpR[down + ix] ?? 1)) / 3;
      const gBlur =
        ((tmpG[up + ix] ?? 1) + (tmpG[mid + ix] ?? 1) + (tmpG[down + ix] ?? 1)) / 3;
      const outIdx = (mid + ix) * 4;
      rgba[outIdx] = Math.round(clamp01(rBlur) * 255);
      rgba[outIdx + 1] = Math.round(clamp01(gBlur) * 255);
      rgba[outIdx + 2] = 255;
      rgba[outIdx + 3] = 255;
    }
  }

  return rgba;
}

interface CloudCluster {
  group: THREE.Group;
  speed: number;
  baseY: number;
  bobPhase: number;
}

interface DistantIslet {
  group: THREE.Group;
  angle: number;
  distT: number;
  baseScale: number;
  baseY: number;
  bobPhase: number;
}

const SKY_VERTEX_SHADER = `
varying vec3 vWorldDir;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldDir = normalize(position);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const SKY_FRAGMENT_SHADER = `
uniform vec3 uZenithColor;
uniform vec3 uMidSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uOceanBounceColor;
uniform vec3 uSunDir;
uniform float uTime;
varying vec3 vWorldDir;

void main() {
  vec3 dir = normalize(vWorldDir);
  vec3 sunDir = normalize(uSunDir);
  float h = dir.y;

  vec3 col;
  if (h >= 0.0) {
    float lowMix = smoothstep(0.0, 0.24, h);
    float highMix = smoothstep(0.2, 0.85, h);
    col = mix(uHorizonColor, uMidSkyColor, lowMix);
    col = mix(col, uZenithColor, highMix);
  } else {
    float belowMix = smoothstep(0.0, -0.35, h);
    col = mix(uHorizonColor, uOceanBounceColor, belowMix);
  }

  // Horizon Mie forward-scattering golden glow + sun corona & crisp disc
  float sunDot = max(dot(dir, sunDir), 0.0);
  float horizonBelt = pow(1.0 - clamp(abs(h), 0.0, 1.0), 4.2);
  float mieScatter = pow(sunDot, 2.6) * horizonBelt * 0.34;
  float warmGlow = pow(sunDot, 5.0) * 0.18;
  float sunHalo = pow(sunDot, 18.0) * 0.38;
  float sunCore = smoothstep(0.9965, 0.9993, sunDot) * 1.15;
  col += mix(uHorizonColor, vec3(1.0, 0.88, 0.66), 0.55) * (mieScatter + warmGlow);
  col += vec3(1.0, 0.96, 0.86) * (sunHalo + sunCore);

  // Subtle high-altitude wispy sunlit cirrus streaks drifting across upper sky
  if (h > 0.06) {
    vec2 skyUv = dir.xz / (h + 0.24);
    vec2 driftA = skyUv * vec2(1.45, 3.1) + vec2(uTime * 0.012, -uTime * 0.004);
    vec2 driftB = skyUv * vec2(2.7, 5.4) + vec2(-uTime * 0.008, uTime * 0.006);
    float waveA = sin(driftA.x * 2.1 + sin(driftA.y * 1.6)) * cos(driftA.y * 1.35 - driftA.x * 0.5);
    float waveB = sin(driftB.x * 1.9 - cos(driftB.y * 1.8)) * 0.5 + 0.5;
    float cirrus = smoothstep(0.32, 0.86, waveA * 0.5 + 0.5) * smoothstep(0.25, 0.9, waveB);
    float altMask = smoothstep(0.06, 0.24, h) * smoothstep(0.94, 0.42, h);
    vec3 cirrusCol = mix(vec3(0.95, 0.97, 1.0), vec3(1.0, 0.94, 0.82), pow(sunDot, 2.0));
    col = mix(col, cirrusCol, cirrus * altMask * 0.24);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

const IBL_SKY_FRAGMENT_SHADER = `
uniform vec3 uZenithColor;
uniform vec3 uMidSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uOceanBounceColor;
uniform vec3 uGroundBounceColor;
uniform vec3 uSunDir;
varying vec3 vWorldDir;

void main() {
  vec3 dir = normalize(vWorldDir);
  float h = dir.y;

  vec3 col;
  if (h >= 0.0) {
    float lowMix = smoothstep(0.0, 0.28, h);
    float highMix = smoothstep(0.22, 0.88, h);
    col = mix(uHorizonColor, uMidSkyColor, lowMix);
    col = mix(col, uZenithColor, highMix);
  } else {
    float belowMix = smoothstep(0.0, -0.45, h);
    vec3 bounceCol = mix(uOceanBounceColor, uGroundBounceColor, 0.45);
    col = mix(uHorizonColor * 0.88, bounceCol, belowMix);
  }

  float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
  col += vec3(1.0, 0.93, 0.78) * (pow(sunDot, 8.0) * 0.42 + pow(sunDot, 48.0) * 0.9);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Custom GLSL vertex shader for Critter Siege's animated stylized ocean waves. */
export const OCEAN_VERTEX_SHADER = `
uniform float uTime;
uniform float uWaveAmp;
uniform float uWaveSpeed;
varying vec3 vWorldPos;
varying vec3 vWaveNormal;
varying float vWaveCrest;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  float wx = worldPos.x;
  float wz = worldPos.z;
  float t = uTime * uWaveSpeed;

  float w1 = sin(wx * 0.18 + t * 1.45) * 0.13 * uWaveAmp;
  float w2 = cos(wz * 0.15 - t * 1.18) * 0.11 * uWaveAmp;
  float w3 = sin((wx * 0.12 + wz * 0.11) + t * 0.92) * 0.08 * uWaveAmp;
  float w4 = cos((wx * 0.27 - wz * 0.23) - t * 1.85) * 0.04 * uWaveAmp;
  float disp = w1 + w2 + w3 + w4;
  worldPos.y += disp;

  float dHx = (
    cos(wx * 0.18 + t * 1.45) * 0.13 * 0.18 +
    cos((wx * 0.12 + wz * 0.11) + t * 0.92) * 0.08 * 0.12 -
    sin((wx * 0.27 - wz * 0.23) - t * 1.85) * 0.04 * 0.27
  ) * uWaveAmp;
  float dHz = (
    -sin(wz * 0.15 - t * 1.18) * 0.11 * 0.15 +
    cos((wx * 0.12 + wz * 0.11) + t * 0.92) * 0.08 * 0.11 +
    sin((wx * 0.27 - wz * 0.23) - t * 1.85) * 0.04 * 0.23
  ) * uWaveAmp;

  vWaveNormal = normalize(vec3(-dHx * 2.2, 1.0, -dHz * 2.2));
  vWorldPos = worldPos.xyz;
  vWaveCrest = clamp(disp * 2.2 + 0.5 + max(0.0, uWaveAmp - 1.0) * 0.14, 0.0, 1.0);

  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

/** Custom GLSL fragment shader for SDF-hugging turquoise lagoon shallows, micro-ripple sparkle, and coastal surf foam. */
export const OCEAN_FRAGMENT_SHADER = `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec2 uIslandCenter;
uniform float uIslandScale;
uniform vec3 uShallowColor;
uniform vec3 uMidColor;
uniform vec3 uDeepColor;
uniform vec3 uFoamColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform sampler2D uShoreTex;
uniform vec2 uWorldOrigin;
uniform vec2 uWorldSpan;
uniform float uHasShoreTex;

varying vec3 vWorldPos;
varying vec3 vWaveNormal;
varying float vWaveCrest;

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);
  float camDist = length(cameraPosition - vWorldPos);

  // Dual-octave animated micro-ripple normal perturbation for crisp sparkling sun glints
  float rippleFade = 1.0 - smoothstep(38.0, 165.0, camDist);
  float r1x = cos(vWorldPos.x * 1.55 + vWorldPos.z * 0.52 + uTime * 2.25) * 0.048;
  float r1z = sin(vWorldPos.z * 1.62 - vWorldPos.x * 0.44 - uTime * 1.98) * 0.048;
  float r2x = cos(vWorldPos.x * 3.15 - vWorldPos.z * 2.15 - uTime * 3.25) * 0.026;
  float r2z = sin(vWorldPos.z * 2.95 + vWorldPos.x * 2.35 + uTime * 2.95) * 0.026;
  vec3 N = normalize(vWaveNormal + vec3((r1x + r2x) * rippleFade, 0.0, (r1z + r2z) * rippleFade));

  // Sample SDF shoreline proximity texture (falling back cleanly to radial gradient when unavailable)
  float distFromCenter = length(vWorldPos.xz - uIslandCenter);
  float normDist = distFromCenter / max(0.5, uIslandScale);
  float radialShallowToMid = smoothstep(14.0, 42.0, normDist);
  float midToDeep = smoothstep(38.0, 115.0, normDist);

  float useSdf = step(0.5, uHasShoreTex);
  vec2 shoreUv = (vWorldPos.xz - uWorldOrigin) / max(vec2(1.0), uWorldSpan);
  float uvFade =
    smoothstep(0.0, 0.035, shoreUv.x) *
    smoothstep(1.0, 0.965, shoreUv.x) *
    smoothstep(0.0, 0.035, shoreUv.y) *
    smoothstep(1.0, 0.965, shoreUv.y);
  vec4 shoreTexel = texture2D(uShoreTex, clamp(shoreUv, 0.004, 0.996));
  float shoreProx = mix(1.0, shoreTexel.r, uvFade);
  float seabedProx = mix(1.0, shoreTexel.g, uvFade);

  float sdfShallowToMid = smoothstep(0.24, 0.88, min(shoreProx, seabedProx));
  float shallowToMid = mix(
    radialShallowToMid,
    clamp(sdfShallowToMid * 0.86 + radialShallowToMid * 0.22, 0.0, 1.0),
    useSdf
  );

  vec3 waterCol = mix(uShallowColor, uMidColor, shallowToMid);
  waterCol = mix(waterCol, uDeepColor, midToDeep);

  // Stylized animated caustic shimmer strictly restricted to shallow lagoon waters near the island
  float causticA = sin(vWorldPos.x * 0.55 + uTime * 1.6 + sin(vWorldPos.z * 0.42));
  float causticB = cos(vWorldPos.z * 0.52 - uTime * 1.35 + cos(vWorldPos.x * 0.37));
  float caustic = smoothstep(0.45, 0.98, (causticA * causticB) * 0.5 + 0.5);
  float foamRipple = (causticA * 0.55 + causticB * 0.45) * 0.028;
  float shoreDist = shoreProx + foamRipple;
  float causticShallowMask = mix(
    1.0 - shallowToMid,
    1.0 - smoothstep(0.15, 0.55, shoreDist),
    useSdf
  );
  waterCol += vec3(0.16, 0.32, 0.30) * caustic * causticShallowMask;

  // Subtle wave-crest turquoise brightening
  waterCol += vec3(0.04, 0.11, 0.12) * smoothstep(0.58, 1.0, vWaveCrest);

  // Sky reflection Fresnel + golden sunlit specular sparkle driven by micro-rippled normal
  float fresnel = pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 3.4);
  waterCol = mix(waterCol, mix(uFogColor, vec3(0.72, 0.92, 1.0), 0.5), fresnel * 0.34);

  vec3 H = normalize(L + V);
  float specBroad = pow(max(dot(N, H), 0.0), 52.0) * 0.42;
  float specGlint = pow(max(dot(N, H), 0.0), 240.0) * 1.45;
  waterCol += vec3(1.0, 0.95, 0.80) * (specBroad + specGlint);

  // Coastal surf foam: exact SDF-hugging multi-wave surf when available, radial fallback otherwise
  float shoreWaveRadial = sin(distFromCenter * 0.75 - uTime * 2.2 + causticA * 1.4);
  float radialLagoonFoam = smoothstep(0.74, 0.96, shoreWaveRadial) *
    (1.0 - smoothstep(16.0, 36.0, normDist)) * 0.38;
  float radialSurfDelta = (normDist - 26.5) / 5.5;
  float radialSurfBand = exp(-(radialSurfDelta * radialSurfDelta)) *
    smoothstep(0.25, 0.9, sin(distFromCenter * 1.1 - uTime * 2.6 + causticB * 1.8) * 0.5 + 0.5);
  float radialFoam = radialLagoonFoam + radialSurfBand * 0.52;

  float contactFoam = (1.0 - smoothstep(0.19, 0.31, shoreDist)) * smoothstep(0.04, 0.16, shoreDist);
  float surfWave1 = smoothstep(0.56, 0.94, sin(shoreProx * 29.0 + uTime * 2.7 + causticA * 1.35) * 0.5 + 0.5) *
    smoothstep(0.12, 0.24, shoreProx) * (1.0 - smoothstep(0.32, 0.56, shoreProx));
  float surfWave2 = smoothstep(0.64, 0.96, sin(shoreProx * 18.0 + uTime * 1.95 - causticB * 1.55) * 0.5 + 0.5) *
    smoothstep(0.26, 0.40, shoreProx) * (1.0 - smoothstep(0.52, 0.76, shoreProx)) * 0.55;
  float sdfFoam = contactFoam * 0.85 + surfWave1 * 0.62 + surfWave2 * 0.42;

  float crestFroth = smoothstep(0.86, 1.0, vWaveCrest) * 0.12;
  float foamMask = clamp(mix(radialFoam, sdfFoam, useSdf) + crestFroth, 0.0, 0.92);
  waterCol = mix(waterCol, uFoamColor, foamMask);

  // Exponential atmospheric distance fog matching scene.fog
  float fogDist = camDist * uFogDensity;
  float fogFactor = 1.0 - exp(-(fogDist * fogDist));
  waterCol = mix(waterCol, uFogColor, clamp(fogFactor, 0.0, 1.0));

  // Translucent turquoise shoreline fade letting sunlit sandy coves peek beneath the shallows
  float shoreAlpha = mix(0.72, 0.97, smoothstep(0.16, 0.55, shoreProx));
  float radialAlpha = mix(0.88, 0.98, shallowToMid);
  float baseAlpha = mix(radialAlpha, shoreAlpha, useSdf);
  float alpha = clamp(mix(baseAlpha, 0.96, foamMask * 0.65), 0.70, 0.98);
  gl_FragColor = vec4(waterCol, alpha);
}
`;

function createFallbackShorelineTexture(): THREE.DataTexture {
  const data = new Uint8Array([255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Construct the custom GLSL stylized ocean ShaderMaterial. */
export function createOceanShaderMaterial(
  sunDir: THREE.Vector3,
): THREE.ShaderMaterial {
  const fallbackShoreTex = createFallbackShorelineTexture();
  return new THREE.ShaderMaterial({
    vertexShader: OCEAN_VERTEX_SHADER,
    fragmentShader: OCEAN_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: true,
    uniforms: {
      uTime: { value: 0 },
      uWaveAmp: { value: 1.0 },
      uWaveSpeed: { value: 1.0 },
      uSunDir: { value: sunDir.clone().normalize() },
      uIslandCenter: {
        value: new THREE.Vector2(DEFAULT_ISLAND_CENTER.x, DEFAULT_ISLAND_CENTER.z),
      },
      uIslandScale: { value: 1.0 },
      uShallowColor: { value: new THREE.Color(0x1ed8d4) },
      uMidColor: { value: new THREE.Color(0x0c88ba) },
      uDeepColor: { value: new THREE.Color(0x0a3d80) },
      uFoamColor: { value: new THREE.Color(0xefffff) },
      uFogColor: { value: new THREE.Color(FOG_COLOR_HEX) },
      uFogDensity: { value: DUEL_FOG_DENSITY },
      uShoreTex: { value: fallbackShoreTex },
      uWorldOrigin: { value: new THREE.Vector2(0, 0) },
      uWorldSpan: {
        value: new THREE.Vector2(DEFAULT_WORLD_SPAN_X, DEFAULT_WORLD_SPAN_Z),
      },
      uHasShoreTex: { value: 0.0 },
    },
  });
}

function disposeObjectTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      geometries.add(obj.geometry);
      if (Array.isArray(obj.material)) {
        for (const item of obj.material) {
          materials.add(item);
        }
      } else {
        materials.add(obj.material);
      }
    }
  });

  for (const geo of geometries) {
    geo.dispose();
  }
  for (const mat of materials) {
    mat.dispose();
  }
}

function bakeCloudPuffVertexColors(
  geometry: THREE.SphereGeometry,
  highlightHex: number,
  shadowHex: number,
): void {
  const posAttr = geometry.getAttribute("position");
  const count = posAttr.count;
  const warmCreamLift = new THREE.Color(0xfff5db);
  const coolIndigoTint = new THREE.Color(0x6180b8);
  const topColor = new THREE.Color(highlightHex).lerp(warmCreamLift, 0.22);
  const bottomColor = new THREE.Color(shadowHex).lerp(coolIndigoTint, 0.24);
  const blended = new THREE.Color();

  let colorAttr = geometry.getAttribute("color");
  if (!(colorAttr instanceof THREE.BufferAttribute) || colorAttr.count !== count) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    geometry.setAttribute("color", colorAttr);
  }

  for (let i = 0; i < count; i++) {
    const ny = posAttr.getY(i);
    const t = clamp01((ny + 1.0) * 0.5);
    const smoothT = t * t * (3.0 - 2.0 * t);
    const stylizedT = Math.pow(Math.max(smoothT, 0.001), 1.18);
    blended.copy(bottomColor).lerp(topColor, stylizedT);
    colorAttr.setXYZ(i, blended.r, blended.g, blended.b);
  }
  colorAttr.needsUpdate = true;
}

/**
 * Sunlit floating sky-island Three.js scene with theme-tailored atmospheres, procedural
 * PMREM sky-ground IBL, focus-snapped 2048x2048 soft shadows, progressive Round 1-5
 * animated cirrus sky dome with glowing sun orb, backlit vertex-colored cloud clusters,
 * multi-tiered distant floating islets, and SDF-hugging custom GLSL stylized ocean with
 * coastal surf foam and churning flood waves.
 */
export class WorldScene {
  public readonly scene: THREE.Scene;
  public readonly renderer: THREE.WebGLRenderer;

  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly fillLight: THREE.DirectionalLight;
  private readonly skyDome: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly sunOrbGroup: THREE.Group;
  private readonly sunCoreMat: THREE.MeshBasicMaterial;
  private readonly sunHaloMat: THREE.MeshBasicMaterial;
  private readonly cloudsRoot: THREE.Group;
  private readonly clouds: CloudCluster[] = [];
  private readonly cloudPuffGeo: THREE.SphereGeometry;
  private readonly cloudMat: THREE.MeshStandardMaterial;
  private readonly distantIsletsRoot: THREE.Group;
  private readonly distantIslets: DistantIslet[] = [];
  private readonly isletRockMat: THREE.MeshStandardMaterial;
  private readonly isletGrassMat: THREE.MeshStandardMaterial;
  private readonly isletPineMat: THREE.MeshStandardMaterial;
  private readonly waterGroup: THREE.Group;
  private readonly oceanMesh: THREE.Mesh;
  private readonly oceanMat: THREE.ShaderMaterial;
  private readonly appendedToContainer: boolean;

  private readonly islandCenter = DEFAULT_ISLAND_CENTER.clone();
  private readonly lastShadowFocus = DEFAULT_ISLAND_CENTER.clone();
  private readonly sunDirScratch = new THREE.Vector3();
  private readonly sunOffsetScratch = new THREE.Vector3();
  private readonly lightRightScratch = new THREE.Vector3();
  private readonly lightUpScratch = new THREE.Vector3();
  private readonly focusScratch = new THREE.Vector3();
  private readonly snappedTargetScratch = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);

  private activeTheme: ThemeId = "emerald_spire";
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private shoreTex: THREE.DataTexture | null = null;
  private hasShoreTex = false;
  private worldHalf = DEFAULT_WORLD_HALF;
  private duelShadowHalf = computeWorldSceneMetrics(DEFAULT_WORLD_SPAN_X).shadowHalf;
  private worldScale = 1.0;
  private skyScale = 1.0;
  private cloudYOffset = 0;
  private waterLevel = DEFAULT_WATER_LEVEL;
  private targetWaterLevel = DEFAULT_WATER_LEVEL;
  private currentRound = 1;
  private currentMaxRounds = 5;
  private floodIntensity = 0;

  public constructor(container: HTMLElement) {
    const initialAtm = getThemeAtmosphere(this.activeTheme);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(initialAtm.fogColor, DUEL_FOG_DENSITY);
    this.scene.environmentIntensity = 0.34;

    const isCanvas =
      typeof HTMLCanvasElement !== "undefined" &&
      container instanceof HTMLCanvasElement;

    this.renderer = new THREE.WebGLRenderer({
      ...(isCanvas ? { canvas: container } : {}),
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(
      Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2),
    );

    const width = Math.max(1, container.clientWidth || 1280);
    const height = Math.max(1, container.clientHeight || 720);
    this.renderer.setSize(width, height, true);

    if (!isCanvas) {
      this.renderer.domElement.style.display = "block";
      this.renderer.domElement.style.width = "100%";
      this.renderer.domElement.style.height = "100%";
      container.appendChild(this.renderer.domElement);
      this.appendedToContainer = true;
    } else {
      this.appendedToContainer = false;
    }

    // Theme-tailored hemisphere + warm directional sun (2048x2048 soft shadows) + cool sky fill
    this.hemiLight = new THREE.HemisphereLight(
      initialAtm.hemiSkyColor,
      initialAtm.hemiGroundColor,
      initialAtm.hemiIntensity,
    );
    this.scene.add(this.hemiLight);

    const initialMetrics = computeWorldSceneMetrics(DEFAULT_WORLD_SPAN_X);
    this.sunLight = new THREE.DirectionalLight(
      initialAtm.sunColor,
      initialAtm.sunIntensity,
    );
    const initialSunOffset = this.computeSunOffsetVector(initialAtm);
    this.sunLight.position.copy(this.islandCenter).add(initialSunOffset);
    this.sunLight.target.position.copy(this.islandCenter);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sunLight.shadow.camera.near = 4;
    this.sunLight.shadow.camera.far = Math.max(140, initialMetrics.worldSize * 3.2);
    this.sunLight.shadow.camera.left = -initialMetrics.shadowHalf;
    this.sunLight.shadow.camera.right = initialMetrics.shadowHalf;
    this.sunLight.shadow.camera.top = initialMetrics.shadowHalf;
    this.sunLight.shadow.camera.bottom = -initialMetrics.shadowHalf;
    this.sunLight.shadow.bias = -0.00045;
    this.sunLight.shadow.normalBias = 0.04;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.fillLight = new THREE.DirectionalLight(
      initialAtm.fillColor,
      initialAtm.fillIntensity,
    );
    this.fillLight.position.set(
      this.islandCenter.x - this.worldHalf * 1.1,
      Math.max(20, this.worldHalf * 0.9),
      this.islandCenter.z - this.worldHalf * 1.0,
    );
    this.scene.add(this.fillLight);

    // Stylized sunlit sky-gradient dome with wispy cirrus clouds + glowing sun orb
    const sunDir = initialSunOffset.clone().normalize();
    const skyGeo = new THREE.SphereGeometry(BASE_SKY_RADIUS, 28, 20);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenithColor: { value: new THREE.Color(initialAtm.skyZenith) },
        uMidSkyColor: { value: new THREE.Color(initialAtm.skyMid) },
        uHorizonColor: { value: new THREE.Color(initialAtm.skyHorizon) },
        uOceanBounceColor: { value: new THREE.Color(initialAtm.oceanBounce) },
        uSunDir: { value: sunDir.clone() },
        uTime: { value: 0 },
      },
    });
    this.skyDome = new THREE.Mesh(skyGeo, this.skyMat);
    this.skyDome.name = "sky_gradient_dome";
    this.skyDome.position.copy(this.islandCenter);
    this.scene.add(this.skyDome);

    this.sunOrbGroup = new THREE.Group();
    this.sunOrbGroup.name = "sun_orb_group";
    this.sunOrbGroup.position
      .copy(this.islandCenter)
      .addScaledVector(sunDir, BASE_SKY_RADIUS * 0.84);

    this.sunCoreMat = new THREE.MeshBasicMaterial({
      color: initialAtm.sunCoreColor,
      fog: false,
    });
    this.sunHaloMat = new THREE.MeshBasicMaterial({
      color: initialAtm.sunHaloColor,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      fog: false,
    });
    const sunCoreMesh = new THREE.Mesh(
      new THREE.SphereGeometry(8.5, 16, 12),
      this.sunCoreMat,
    );
    const sunHaloMesh = new THREE.Mesh(
      new THREE.SphereGeometry(15.5, 16, 12),
      this.sunHaloMat,
    );
    this.sunOrbGroup.add(sunCoreMesh, sunHaloMesh);
    this.scene.add(this.sunOrbGroup);

    // Shared materials for richer multi-tiered distant silhouette floating islets
    this.isletRockMat = new THREE.MeshStandardMaterial({
      color: initialAtm.isletRockColor,
      roughness: 0.94,
      metalness: 0.02,
      flatShading: true,
    });
    this.isletGrassMat = new THREE.MeshStandardMaterial({
      color: initialAtm.isletGrassColor,
      roughness: 0.92,
      metalness: 0.0,
      flatShading: true,
    });
    this.isletPineMat = new THREE.MeshStandardMaterial({
      color: initialAtm.isletPineColor,
      roughness: 0.9,
      metalness: 0.0,
      flatShading: true,
    });
    this.distantIsletsRoot = new THREE.Group();
    this.distantIsletsRoot.name = "distant_floating_islets";
    this.distantIsletsRoot.position.set(this.islandCenter.x, 0, this.islandCenter.z);
    this.buildDistantIslets();
    this.scene.add(this.distantIsletsRoot);

    // Shared backlit vertex-colored cloud geometry & material across all drifting clusters
    this.cloudPuffGeo = new THREE.SphereGeometry(1.0, 10, 8);
    bakeCloudPuffVertexColors(
      this.cloudPuffGeo,
      initialAtm.cloudHighlight,
      initialAtm.cloudShadow,
    );
    this.cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
    });
    this.cloudsRoot = new THREE.Group();
    this.cloudsRoot.name = "cloud_clusters";
    this.cloudsRoot.position.set(this.islandCenter.x, 0, this.islandCenter.z);
    this.buildClouds();
    this.scene.add(this.cloudsRoot);

    // Custom GLSL animated stylized ocean with SDF-hugging shoreline surf foam
    this.waterGroup = new THREE.Group();
    this.waterGroup.name = "ocean_group";
    this.waterGroup.position.set(
      this.islandCenter.x,
      this.waterLevel,
      this.islandCenter.z,
    );

    const oceanGeo = new THREE.PlaneGeometry(BASE_OCEAN_SPAN, BASE_OCEAN_SPAN, 96, 96);
    this.oceanMat = createOceanShaderMaterial(sunDir);
    const initialShoreUniform = this.oceanMat.uniforms.uShoreTex;
    if (
      initialShoreUniform &&
      initialShoreUniform.value instanceof THREE.DataTexture
    ) {
      this.shoreTex = initialShoreUniform.value;
    }
    this.applyOceanPalette(initialAtm, sunDir);
    this.oceanMesh = new THREE.Mesh(oceanGeo, this.oceanMat);
    this.oceanMesh.name = "turquoise_shader_ocean";
    this.oceanMesh.rotation.x = -Math.PI * 0.5;
    this.waterGroup.add(this.oceanMesh);
    this.scene.add(this.waterGroup);

    // Build procedural PMREM sky-ground IBL for realistic sunlit specular/ambient fill
    this.rebuildEnvironmentMap(initialAtm, sunDir);
  }

  /** Switch sky, lights, fog, clouds, distant islets, ocean colors, and PMREM IBL to match `theme`. */
  public setTheme(theme: ThemeId): void {
    this.activeTheme = theme;
    const atm = getThemeAtmosphere(theme);

    this.hemiLight.color.setHex(atm.hemiSkyColor);
    this.hemiLight.groundColor.setHex(atm.hemiGroundColor);
    this.hemiLight.intensity = atm.hemiIntensity;

    this.sunLight.color.setHex(atm.sunColor);
    this.sunLight.intensity = atm.sunIntensity;

    this.fillLight.color.setHex(atm.fillColor);
    this.fillLight.intensity = atm.fillIntensity;

    const sunDir = this.computeSunOffsetVector(atm).clone().normalize();

    const zenithUniform = this.skyMat.uniforms.uZenithColor;
    if (zenithUniform && zenithUniform.value instanceof THREE.Color) {
      zenithUniform.value.setHex(atm.skyZenith);
    }
    const midSkyUniform = this.skyMat.uniforms.uMidSkyColor;
    if (midSkyUniform && midSkyUniform.value instanceof THREE.Color) {
      midSkyUniform.value.setHex(atm.skyMid);
    }
    const horizonUniform = this.skyMat.uniforms.uHorizonColor;
    if (horizonUniform && horizonUniform.value instanceof THREE.Color) {
      horizonUniform.value.setHex(atm.skyHorizon);
    }
    const oceanBounceUniform = this.skyMat.uniforms.uOceanBounceColor;
    if (oceanBounceUniform && oceanBounceUniform.value instanceof THREE.Color) {
      oceanBounceUniform.value.setHex(atm.oceanBounce);
    }
    const skySunUniform = this.skyMat.uniforms.uSunDir;
    if (skySunUniform && skySunUniform.value instanceof THREE.Vector3) {
      skySunUniform.value.copy(sunDir);
    }

    this.sunOrbGroup.position
      .copy(this.islandCenter)
      .addScaledVector(sunDir, BASE_SKY_RADIUS * this.skyScale * 0.84);
    this.sunCoreMat.color.setHex(atm.sunCoreColor);
    this.sunHaloMat.color.setHex(atm.sunHaloColor);

    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(atm.fogColor);
    }

    this.applyOceanPalette(atm, sunDir);
    bakeCloudPuffVertexColors(
      this.cloudPuffGeo,
      atm.cloudHighlight,
      atm.cloudShadow,
    );

    this.isletRockMat.color.setHex(atm.isletRockColor);
    this.isletGrassMat.color.setHex(atm.isletGrassColor);
    this.isletPineMat.color.setHex(atm.isletPineColor);

    this.applyAtmosphere();
    this.setShadowFocus(this.lastShadowFocus);
    this.rebuildEnvironmentMap(atm, sunDir);
  }

  /** Recompute and upload the SDF-hugging shoreline lookup texture for the ocean shader. */
  public updateShorelineFromWorld(world: SdfWorld, waterLevel: number): void {
    const data = buildShorelineDepthData(world, waterLevel, SHORELINE_TEX_RES);
    const nextTex = new THREE.DataTexture(
      data,
      SHORELINE_TEX_RES,
      SHORELINE_TEX_RES,
      THREE.RGBAFormat,
    );
    nextTex.wrapS = THREE.ClampToEdgeWrapping;
    nextTex.wrapT = THREE.ClampToEdgeWrapping;
    nextTex.magFilter = THREE.LinearFilter;
    nextTex.minFilter = THREE.LinearFilter;
    nextTex.generateMipmaps = false;
    nextTex.needsUpdate = true;

    const prevTex = this.shoreTex;
    this.shoreTex = nextTex;
    this.hasShoreTex = true;

    const shoreTexUniform = this.oceanMat.uniforms.uShoreTex;
    if (shoreTexUniform) {
      shoreTexUniform.value = nextTex;
    }
    const originUniform = this.oceanMat.uniforms.uWorldOrigin;
    if (originUniform && originUniform.value instanceof THREE.Vector2) {
      originUniform.value.set(0, 0);
    }
    const spanUniform = this.oceanMat.uniforms.uWorldSpan;
    if (spanUniform && spanUniform.value instanceof THREE.Vector2) {
      spanUniform.value.set(
        Math.max(1, world.worldWidth),
        Math.max(1, world.worldDepth),
      );
    }
    const hasTexUniform = this.oceanMat.uniforms.uHasShoreTex;
    if (hasTexUniform) {
      hasTexUniform.value = 1.0;
    }

    prevTex?.dispose();
  }

  /**
   * Focus and texel-snap directional sun shadows around `focus` on 144m Grand worlds
   * (`shadowHalf = 46m`, zero shadow swimming), while keeping full-island shadow coverage on 60m Duel maps.
   */
  public setShadowFocus(focus: Vec3): void {
    const fx = Number.isFinite(focus.x) ? focus.x : this.islandCenter.x;
    const fy = Number.isFinite(focus.y) ? focus.y : this.islandCenter.y;
    const fz = Number.isFinite(focus.z) ? focus.z : this.islandCenter.z;
    this.lastShadowFocus.set(fx, fy, fz);

    const atm = THEME_ATMOSPHERES[this.activeTheme];
    const sunOffset = this.computeSunOffsetVector(atm);
    const sunDist = sunOffset.length();
    const sunDir = this.sunDirScratch.copy(sunOffset).normalize();

    let shadowHalf: number;
    if (this.worldHalf > 40) {
      shadowHalf = GRAND_FOCUS_SHADOW_HALF;
      const texelSize = (shadowHalf * 2) / SHADOW_MAP_SIZE;

      // Build stable orthonormal light-space basis and snap target to exact shadow texel grid
      this.lightRightScratch.crossVectors(this.worldUp, sunDir);
      if (this.lightRightScratch.lengthSq() < 1e-6) {
        this.lightRightScratch.set(1, 0, 0);
      } else {
        this.lightRightScratch.normalize();
      }
      this.lightUpScratch.crossVectors(sunDir, this.lightRightScratch).normalize();

      this.focusScratch.set(fx, fy, fz);
      const rx = this.focusScratch.dot(this.lightRightScratch);
      const ry = this.focusScratch.dot(this.lightUpScratch);
      const rz = this.focusScratch.dot(sunDir);

      const snappedRx = Math.round(rx / texelSize) * texelSize;
      const snappedRy = Math.round(ry / texelSize) * texelSize;

      this.snappedTargetScratch
        .set(0, 0, 0)
        .addScaledVector(this.lightRightScratch, snappedRx)
        .addScaledVector(this.lightUpScratch, snappedRy)
        .addScaledVector(sunDir, rz);

      this.sunLight.target.position.copy(this.snappedTargetScratch);
      this.sunLight.position
        .copy(this.snappedTargetScratch)
        .addScaledVector(sunDir, sunDist);
    } else {
      shadowHalf = this.duelShadowHalf;
      this.sunLight.target.position.copy(this.islandCenter);
      this.sunLight.position
        .copy(this.islandCenter)
        .addScaledVector(sunDir, sunDist);
    }

    const cam = this.sunLight.shadow.camera;
    if (
      cam.left !== -shadowHalf ||
      cam.right !== shadowHalf ||
      cam.top !== shadowHalf ||
      cam.bottom !== -shadowHalf
    ) {
      cam.left = -shadowHalf;
      cam.right = shadowHalf;
      cam.top = shadowHalf;
      cam.bottom = -shadowHalf;
      cam.updateProjectionMatrix();
    }
    this.sunLight.target.updateMatrixWorld();
  }

  /**
   * Dynamically scale ocean plane, directional sun shadow bounds, fog density,
   * cloud radius, sky dome, and distant floating silhouette islets to `worldSize`.
   */
  public configureForWorldSize(
    worldSize: number,
    worldHeight?: number,
    worldDepth?: number,
  ): void {
    const safeW =
      Number.isFinite(worldSize) && worldSize > 0 ? worldSize : DEFAULT_WORLD_SPAN_X;
    const safeD =
      worldDepth !== undefined && Number.isFinite(worldDepth) && worldDepth > 0
        ? worldDepth
        : safeW;
    const safeH =
      worldHeight !== undefined && Number.isFinite(worldHeight) && worldHeight > 0
        ? worldHeight
        : safeW > 90
          ? 49.5
          : DEFAULT_WORLD_SPAN_Y;

    const spanXZ = Math.max(safeW, safeD);
    const metrics = computeWorldSceneMetrics(spanXZ);
    const atm = getThemeAtmosphere(this.activeTheme);

    this.worldHalf = spanXZ * 0.5;
    this.duelShadowHalf = metrics.shadowHalf;
    this.worldScale = this.worldHalf / DEFAULT_WORLD_HALF;
    this.islandCenter.set(safeW * 0.5, Math.max(8.0, safeH * 0.3), safeD * 0.5);
    this.cloudYOffset = Math.max(0, safeH - DEFAULT_WORLD_SPAN_Y) * 0.85;

    this.sunLight.shadow.camera.far = Math.max(140, spanXZ * 3.2);
    this.sunLight.shadow.camera.updateProjectionMatrix();
    this.setShadowFocus(this.islandCenter);

    this.fillLight.position.set(
      this.islandCenter.x - this.worldHalf * 1.1,
      Math.max(20, this.worldHalf * 0.9),
      this.islandCenter.z - this.worldHalf * 1.0,
    );

    this.skyScale = Math.max(1.0, (metrics.oceanSpan * 0.68) / BASE_SKY_RADIUS);
    const sunDir = this.computeSunOffsetVector(atm).clone().normalize();
    this.skyDome.position.copy(this.islandCenter);
    this.skyDome.scale.setScalar(this.skyScale);
    this.sunOrbGroup.position
      .copy(this.islandCenter)
      .addScaledVector(sunDir, BASE_SKY_RADIUS * this.skyScale * 0.84);
    this.sunOrbGroup.scale.setScalar(this.skyScale);

    // Position distant floating silhouette islets cleanly at worldSize * 1.15 .. 1.6
    this.distantIsletsRoot.position.set(this.islandCenter.x, 0, this.islandCenter.z);
    this.distantIsletsRoot.scale.set(1, 1, 1);
    const isletVisualScale = Math.max(1.0, (spanXZ / DEFAULT_WORLD_SPAN_X) * 0.85);
    for (const islet of this.distantIslets) {
      const dist =
        metrics.isletMinDist +
        islet.distT * (metrics.isletMaxDist - metrics.isletMinDist);
      islet.group.position.x = Math.cos(islet.angle) * dist;
      islet.group.position.z = Math.sin(islet.angle) * dist;
      islet.group.scale.setScalar(islet.baseScale * isletVisualScale);
    }

    const cloudScale = metrics.cloudRadius / BASE_CLOUD_RADIUS;
    this.cloudsRoot.position.set(this.islandCenter.x, 0, this.islandCenter.z);
    this.cloudsRoot.scale.set(cloudScale, 1.0, cloudScale);

    this.waterGroup.position.set(
      this.islandCenter.x,
      this.waterLevel,
      this.islandCenter.z,
    );
    const oceanScale = metrics.oceanSpan / BASE_OCEAN_SPAN;
    this.oceanMesh.scale.set(oceanScale, oceanScale, 1);

    const centerUniform = this.oceanMat.uniforms.uIslandCenter;
    if (centerUniform && centerUniform.value instanceof THREE.Vector2) {
      centerUniform.value.set(this.islandCenter.x, this.islandCenter.z);
    }
    const scaleUniform = this.oceanMat.uniforms.uIslandScale;
    if (scaleUniform) {
      scaleUniform.value = this.worldScale;
    }
    if (!this.hasShoreTex) {
      const spanUniform = this.oceanMat.uniforms.uWorldSpan;
      if (spanUniform && spanUniform.value instanceof THREE.Vector2) {
        spanUniform.value.set(safeW, safeD);
      }
    }

    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = metrics.fogDensity;
    }
    const fogUniform = this.oceanMat.uniforms.uFogDensity;
    if (fogUniform) {
      fogUniform.value = metrics.fogDensity;
    }
  }

  /** Recenter and scale sun shadows, ocean, sky dome, clouds, and horizon islets for Duel (60m) vs Grand (144m) worlds. */
  public setWorldBounds(
    worldWidth: number,
    worldHeight: number,
    worldDepth: number,
  ): void {
    this.configureForWorldSize(worldWidth, worldHeight, worldDepth);
  }

  /** Set vertical ocean height (snaps immediately by default; smooth 60 FPS rise when immediate is false). */
  public setWaterLevel(y: number, immediate = true): void {
    if (!Number.isFinite(y)) {
      return;
    }
    this.targetWaterLevel = y;
    if (immediate || y < this.waterLevel - 1.5) {
      this.waterLevel = y;
      this.waterGroup.position.y = y;
    }
  }

  /** Set smooth 60 FPS target water elevation for rising warning tide and Round 5 Final Deluge. */
  public setWaterTargetLevel(y: number): void {
    this.setWaterLevel(y, false);
  }

  /** Shift daylight lighting and sky-dome palette smoothly across Rounds 1-5 (morning -> afternoon -> stormy sunset). */
  public setRoundAtmosphere(round: number, maxRounds: number): void {
    this.currentRound = Number.isFinite(round) ? Math.max(1, Math.floor(round)) : 1;
    this.currentMaxRounds = Number.isFinite(maxRounds)
      ? Math.max(1, Math.floor(maxRounds))
      : 5;
    this.applyAtmosphere();
  }

  /** Scale churning ocean wave amplitude/speed and storm ocean/fog tint cleanly across 0..1 flood intensity. */
  public setFloodIntensity(intensity: number): void {
    this.floodIntensity = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
    this.applyAtmosphere();
  }

  /** Resize renderer viewport cleanly. */
  public resize(width: number, height: number): void {
    const safeW = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
    const safeH = Math.max(1, Math.floor(Number.isFinite(height) ? height : 1));
    this.renderer.setSize(safeW, safeH, true);
  }

  /** Animate GLSL sky cirrus, ocean waves, smooth rising water level, SDF coastal surf foam, distant islets, and drifting clouds. */
  public update(dtSec: number, elapsedSec: number): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;

    // Smoothly interpolate vertical water elevation toward targetWaterLevel at 60 FPS
    if (Math.abs(this.targetWaterLevel - this.waterLevel) > 1e-4) {
      const alpha = safeDt > 0 ? 1 - Math.exp(-7 * safeDt) : 1;
      this.waterLevel += (this.targetWaterLevel - this.waterLevel) * alpha;
      this.waterGroup.position.y = this.waterLevel;
    }

    // Advance GPU sky cirrus drift & ocean wave shader clocks
    const skyTimeUniform = this.skyMat.uniforms.uTime;
    if (skyTimeUniform) {
      skyTimeUniform.value = t;
    }
    const oceanTimeUniform = this.oceanMat.uniforms.uTime;
    if (oceanTimeUniform) {
      oceanTimeUniform.value = t;
    }

    // Gentle vertical hover on distant silhouette floating islets
    for (const islet of this.distantIslets) {
      islet.group.position.y =
        islet.baseY + Math.sin(t * 0.35 + islet.bobPhase) * 0.45;
    }

    // Drifting clouds spanning the archipelago sky (local space around island center)
    const wrapMin = -DEFAULT_WORLD_HALF * 3.4;
    const wrapMax = DEFAULT_WORLD_HALF * 3.4;
    for (const cloud of this.clouds) {
      cloud.group.position.x += cloud.speed * safeDt;
      if (cloud.group.position.x > wrapMax) {
        cloud.group.position.x = wrapMin;
      }
      cloud.group.position.y =
        cloud.baseY + this.cloudYOffset + Math.sin(t * 0.45 + cloud.bobPhase) * 0.35;
    }
  }

  /** Render the scene with the active Three.js camera. */
  public render(camera: THREE.Camera): void {
    this.renderer.render(this.scene, camera);
  }

  /** Dispose all scene geometries, materials, textures, PMREM IBL, shadow maps, and WebGL resources. */
  public dispose(): void {
    if (this.envRenderTarget) {
      this.scene.environment = null;
      this.envRenderTarget.dispose();
      this.envRenderTarget = null;
    }

    this.skyDome.geometry.dispose();
    this.skyMat.dispose();
    this.scene.remove(this.skyDome);

    disposeObjectTree(this.sunOrbGroup);
    this.scene.remove(this.sunOrbGroup);

    disposeObjectTree(this.distantIsletsRoot);
    this.scene.remove(this.distantIsletsRoot);
    this.distantIslets.length = 0;

    disposeObjectTree(this.cloudsRoot);
    this.scene.remove(this.cloudsRoot);
    this.clouds.length = 0;

    this.oceanMesh.geometry.dispose();
    this.oceanMat.dispose();
    if (this.shoreTex) {
      this.shoreTex.dispose();
      this.shoreTex = null;
    }
    this.scene.remove(this.waterGroup);

    this.sunLight.shadow.map?.dispose();
    this.scene.remove(this.sunLight);
    this.scene.remove(this.sunLight.target);
    this.scene.remove(this.hemiLight);
    this.scene.remove(this.fillLight);

    this.renderer.dispose();
    if (this.appendedToContainer && this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(
        this.renderer.domElement,
      );
    }
  }

  private computeSunOffsetVector(atm: ThemeAtmosphere): THREE.Vector3 {
    return this.sunOffsetScratch.set(
      this.worldHalf * atm.sunOffset.x,
      Math.max(36, this.worldHalf * atm.sunOffset.y),
      this.worldHalf * atm.sunOffset.z,
    );
  }

  private applyOceanPalette(atm: ThemeAtmosphere, sunDir: THREE.Vector3): void {
    const sunUniform = this.oceanMat.uniforms.uSunDir;
    if (sunUniform && sunUniform.value instanceof THREE.Vector3) {
      sunUniform.value.copy(sunDir);
    }
    const shallowUniform = this.oceanMat.uniforms.uShallowColor;
    if (shallowUniform && shallowUniform.value instanceof THREE.Color) {
      shallowUniform.value.setHex(atm.oceanShallow);
    }
    const midUniform = this.oceanMat.uniforms.uMidColor;
    if (midUniform && midUniform.value instanceof THREE.Color) {
      midUniform.value.setHex(atm.oceanMid);
    }
    const deepUniform = this.oceanMat.uniforms.uDeepColor;
    if (deepUniform && deepUniform.value instanceof THREE.Color) {
      deepUniform.value.setHex(atm.oceanDeep);
    }
    const foamUniform = this.oceanMat.uniforms.uFoamColor;
    if (foamUniform && foamUniform.value instanceof THREE.Color) {
      foamUniform.value.setHex(atm.oceanFoam);
    }
    const fogUniform = this.oceanMat.uniforms.uFogColor;
    if (fogUniform && fogUniform.value instanceof THREE.Color) {
      fogUniform.value.setHex(atm.fogColor);
    }
  }

  private rebuildEnvironmentMap(
    atm: ThemeAtmosphere,
    sunDir: THREE.Vector3,
  ): void {
    let pmremGenerator: THREE.PMREMGenerator | null = null;
    let envGeo: THREE.SphereGeometry | null = null;
    let envMat: THREE.ShaderMaterial | null = null;
    let sunDiscGeo: THREE.SphereGeometry | null = null;
    let sunDiscMat: THREE.MeshBasicMaterial | null = null;

    try {
      pmremGenerator = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();

      envGeo = new THREE.SphereGeometry(20, 24, 16);
      envMat = new THREE.ShaderMaterial({
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: IBL_SKY_FRAGMENT_SHADER,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          uZenithColor: { value: new THREE.Color(atm.skyZenith) },
          uMidSkyColor: { value: new THREE.Color(atm.skyMid) },
          uHorizonColor: { value: new THREE.Color(atm.skyHorizon) },
          uOceanBounceColor: { value: new THREE.Color(atm.oceanBounce) },
          uGroundBounceColor: { value: new THREE.Color(atm.hemiGroundColor) },
          uSunDir: { value: sunDir.clone().normalize() },
        },
      });
      envScene.add(new THREE.Mesh(envGeo, envMat));

      sunDiscGeo = new THREE.SphereGeometry(2.1, 12, 10);
      sunDiscMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(atm.sunCoreColor).multiplyScalar(2.2),
      });
      const sunDisc = new THREE.Mesh(sunDiscGeo, sunDiscMat);
      sunDisc.position.copy(sunDir).normalize().multiplyScalar(16);
      envScene.add(sunDisc);

      const nextTarget = pmremGenerator.fromScene(envScene, 0.04);
      const prevTarget = this.envRenderTarget;
      this.envRenderTarget = nextTarget;
      this.scene.environment = nextTarget.texture;
      prevTarget?.dispose();
    } catch {
      // Gracefully degrade when WebGL context is unavailable or headless
    } finally {
      envGeo?.dispose();
      envMat?.dispose();
      sunDiscGeo?.dispose();
      sunDiscMat?.dispose();
      pmremGenerator?.dispose();
    }
  }

  private applyAtmosphere(): void {
    const atm = THEME_ATMOSPHERES[this.activeTheme];
    const state = computeAtmosphereState(
      this.currentRound,
      this.currentMaxRounds,
      this.floodIntensity,
    );
    const rp = state.roundProgress;
    const flood = state.floodIntensity;

    // Layer progressive Round 1-5 atmosphere smoothly on top of the active theme palette
    const blendThemeColor = (
      themeHex: number,
      afternoonCol: THREE.Color,
      sunsetCol: THREE.Color,
    ): THREE.Color => {
      const out = new THREE.Color(themeHex);
      if (rp <= 0.5) {
        out.lerp(afternoonCol, rp * 2);
      } else {
        out.copy(afternoonCol).lerp(sunsetCol, (rp - 0.5) * 2);
      }
      return out;
    };

    const zenithColor = blendThemeColor(
      atm.skyZenith,
      ATMOSPHERE_AFTERNOON.zenith,
      ATMOSPHERE_SUNSET_STORM.zenith,
    );
    const midSkyColor = blendThemeColor(
      atm.skyMid,
      ATMOSPHERE_AFTERNOON.midSky,
      ATMOSPHERE_SUNSET_STORM.midSky,
    );
    const horizonColor = blendThemeColor(
      atm.skyHorizon,
      ATMOSPHERE_AFTERNOON.horizon,
      ATMOSPHERE_SUNSET_STORM.horizon,
    );
    const oceanBounceColor = blendThemeColor(
      atm.oceanBounce,
      ATMOSPHERE_AFTERNOON.oceanBounce,
      ATMOSPHERE_SUNSET_STORM.oceanBounce,
    );
    const sunColor = blendThemeColor(
      atm.sunColor,
      ATMOSPHERE_AFTERNOON.sunColor,
      ATMOSPHERE_SUNSET_STORM.sunColor,
    );
    const hemiSkyColor = blendThemeColor(
      atm.hemiSkyColor,
      ATMOSPHERE_AFTERNOON.hemiSky,
      ATMOSPHERE_SUNSET_STORM.hemiSky,
    );
    const hemiGroundColor = blendThemeColor(
      atm.hemiGroundColor,
      ATMOSPHERE_AFTERNOON.hemiGround,
      ATMOSPHERE_SUNSET_STORM.hemiGround,
    );
    const fillColor = blendThemeColor(
      atm.fillColor,
      ATMOSPHERE_AFTERNOON.fillColor,
      ATMOSPHERE_SUNSET_STORM.fillColor,
    );
    const fogColor = blendThemeColor(
      atm.fogColor,
      ATMOSPHERE_AFTERNOON.fogColor,
      ATMOSPHERE_SUNSET_STORM.fogColor,
    ).lerp(STORM_FOG_TINT, flood * 0.58);

    if (flood > 0) {
      zenithColor.lerp(STORM_FOG_TINT, flood * 0.25);
      midSkyColor.lerp(STORM_FOG_TINT, flood * 0.35);
      oceanBounceColor.lerp(OCEAN_DEEP_STORM, flood * 0.45);
    }

    // Scale theme light intensities proportionally so PMREM IBL exposure stays balanced
    const sunScale = state.sunIntensity / ATMOSPHERE_MORNING.sunIntensity;
    const hemiScale = state.hemiIntensity / ATMOSPHERE_MORNING.hemiIntensity;
    const fillScale = state.fillIntensity / ATMOSPHERE_MORNING.fillIntensity;

    const zenithUniform = this.skyMat.uniforms.uZenithColor;
    if (zenithUniform && zenithUniform.value instanceof THREE.Color) {
      zenithUniform.value.copy(zenithColor);
    }
    const midSkyUniform = this.skyMat.uniforms.uMidSkyColor;
    if (midSkyUniform && midSkyUniform.value instanceof THREE.Color) {
      midSkyUniform.value.copy(midSkyColor);
    }
    const horizonUniform = this.skyMat.uniforms.uHorizonColor;
    if (horizonUniform && horizonUniform.value instanceof THREE.Color) {
      horizonUniform.value.copy(horizonColor);
    }
    const oceanBounceUniform = this.skyMat.uniforms.uOceanBounceColor;
    if (oceanBounceUniform && oceanBounceUniform.value instanceof THREE.Color) {
      oceanBounceUniform.value.copy(oceanBounceColor);
    }

    this.sunLight.color.copy(sunColor);
    this.sunLight.intensity = atm.sunIntensity * sunScale;
    this.hemiLight.color.copy(hemiSkyColor);
    this.hemiLight.groundColor.copy(hemiGroundColor);
    this.hemiLight.intensity = atm.hemiIntensity * hemiScale;
    this.fillLight.color.copy(fillColor);
    this.fillLight.intensity = atm.fillIntensity * fillScale;

    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(fogColor);
    }

    const shallowOceanColor = new THREE.Color(atm.oceanShallow).lerp(
      OCEAN_SHALLOW_STORM,
      flood,
    );
    const midOceanColor = new THREE.Color(atm.oceanMid).lerp(
      OCEAN_MID_STORM,
      flood,
    );
    const deepOceanColor = new THREE.Color(atm.oceanDeep).lerp(
      OCEAN_DEEP_STORM,
      flood,
    );

    const waveAmpUniform = this.oceanMat.uniforms.uWaveAmp;
    if (waveAmpUniform) {
      waveAmpUniform.value = state.waveAmp;
    }
    const waveSpeedUniform = this.oceanMat.uniforms.uWaveSpeed;
    if (waveSpeedUniform) {
      waveSpeedUniform.value = state.waveSpeed;
    }
    const shallowUniform = this.oceanMat.uniforms.uShallowColor;
    if (shallowUniform && shallowUniform.value instanceof THREE.Color) {
      shallowUniform.value.copy(shallowOceanColor);
    }
    const midUniform = this.oceanMat.uniforms.uMidColor;
    if (midUniform && midUniform.value instanceof THREE.Color) {
      midUniform.value.copy(midOceanColor);
    }
    const deepUniform = this.oceanMat.uniforms.uDeepColor;
    if (deepUniform && deepUniform.value instanceof THREE.Color) {
      deepUniform.value.copy(deepOceanColor);
    }
    const oceanFogUniform = this.oceanMat.uniforms.uFogColor;
    if (oceanFogUniform && oceanFogUniform.value instanceof THREE.Color) {
      oceanFogUniform.value.copy(fogColor);
    }
  }

  private buildDistantIslets(): void {
    const initialMetrics = computeWorldSceneMetrics(DEFAULT_WORLD_SPAN_X);
    const specs: ReadonlyArray<{
      angle: number;
      distT: number;
      y: number;
      scale: number;
      phase: number;
    }> = [
      { angle: 0.35, distT: 0.12, y: 12, scale: 1.3, phase: 0.4 },
      { angle: 1.25, distT: 0.62, y: 18, scale: 1.65, phase: 1.7 },
      { angle: 2.15, distT: 0.25, y: 10, scale: 1.15, phase: 2.8 },
      { angle: 3.1, distT: 0.96, y: 21, scale: 1.85, phase: 3.9 },
      { angle: 4.05, distT: 0.48, y: 14, scale: 1.4, phase: 4.6 },
      { angle: 5.05, distT: 0.05, y: 9, scale: 1.1, phase: 5.5 },
      { angle: 5.75, distT: 0.78, y: 16, scale: 1.55, phase: 1.1 },
    ];

    // Share base sculpted geometries across all distant islets (3 shared materials total)
    const mainRockGeo = new THREE.ConeGeometry(5.6, 11.2, 8);
    const sideCragGeo = new THREE.ConeGeometry(3.2, 7.6, 7);
    const keelSpireGeo = new THREE.ConeGeometry(2.1, 5.6, 6);
    const crownGeo = new THREE.IcosahedronGeometry(5.8, 1);
    const knollGeo = new THREE.IcosahedronGeometry(3.1, 1);
    const pineLowerGeo = new THREE.ConeGeometry(1.55, 3.2, 7);
    const pineUpperGeo = new THREE.ConeGeometry(1.05, 2.5, 7);

    for (const sp of specs) {
      const group = new THREE.Group();

      // Multi-tiered sculpted floating rock underside + side crag + keel tip
      const underRock = new THREE.Mesh(mainRockGeo, this.isletRockMat);
      underRock.rotation.x = Math.PI;
      underRock.position.y = -4.9;

      const sideCrag = new THREE.Mesh(sideCragGeo, this.isletRockMat);
      sideCrag.rotation.set(Math.PI - 0.14, sp.phase, 0.18);
      sideCrag.position.set(-2.5, -2.9, 1.3);

      const keelSpire = new THREE.Mesh(keelSpireGeo, this.isletRockMat);
      keelSpire.rotation.x = Math.PI;
      keelSpire.position.set(1.1, -9.2, -0.8);

      // Layered sculpted meadow crown + elevated grassy knoll
      const crown = new THREE.Mesh(crownGeo, this.isletGrassMat);
      crown.scale.set(1.08, 0.36, 1.0);
      crown.position.y = 0.75;

      const knoll = new THREE.Mesh(knollGeo, this.isletGrassMat);
      knoll.scale.set(1.05, 0.45, 0.95);
      knoll.position.set(-1.3, 1.85, 0.8);

      // Twin stylized tiered alpine/island pines
      const pineTallBase = new THREE.Mesh(pineLowerGeo, this.isletPineMat);
      pineTallBase.position.set(1.35, 3.35, -0.55);
      const pineTallTop = new THREE.Mesh(pineUpperGeo, this.isletPineMat);
      pineTallTop.position.set(1.35, 5.15, -0.55);

      const pineShortBase = new THREE.Mesh(pineLowerGeo, this.isletPineMat);
      pineShortBase.scale.setScalar(0.76);
      pineShortBase.position.set(-1.75, 3.35, 0.95);
      const pineShortTop = new THREE.Mesh(pineUpperGeo, this.isletPineMat);
      pineShortTop.scale.setScalar(0.74);
      pineShortTop.position.set(-1.75, 4.7, 0.95);

      const dist =
        initialMetrics.isletMinDist +
        sp.distT * (initialMetrics.isletMaxDist - initialMetrics.isletMinDist);
      group.add(
        underRock,
        sideCrag,
        keelSpire,
        crown,
        knoll,
        pineTallBase,
        pineTallTop,
        pineShortBase,
        pineShortTop,
      );
      group.position.set(
        Math.cos(sp.angle) * dist,
        sp.y,
        Math.sin(sp.angle) * dist,
      );
      group.rotation.y = sp.phase * 0.7;
      group.scale.setScalar(sp.scale);
      this.distantIsletsRoot.add(group);
      this.distantIslets.push({
        group,
        angle: sp.angle,
        distT: sp.distT,
        baseScale: sp.scale,
        baseY: sp.y,
        bobPhase: sp.phase,
      });
    }
  }

  private buildClouds(): void {
    const span = Math.max(24, DEFAULT_WORLD_HALF * 2.2);
    const cloudSpecs: ReadonlyArray<{
      ox: number;
      y: number;
      oz: number;
      scale: number;
      speed: number;
      phase: number;
    }> = [
      { ox: -span * 1.15, y: 31, oz: -span * 0.95, scale: 1.9, speed: 0.85, phase: 0.2 },
      { ox: span * 0.15, y: 35, oz: -span * 1.25, scale: 2.2, speed: 0.65, phase: 1.4 },
      { ox: span * 1.1, y: 30, oz: -span * 0.55, scale: 1.75, speed: 0.95, phase: 2.3 },
      { ox: -span * 1.3, y: 34, oz: span * 0.75, scale: 2.05, speed: 0.72, phase: 3.1 },
      { ox: -span * 0.1, y: 38, oz: span * 1.2, scale: 2.3, speed: 0.58, phase: 4.0 },
      { ox: span * 1.05, y: 32, oz: span * 0.95, scale: 1.85, speed: 0.88, phase: 5.2 },
      { ox: -span * 0.65, y: 36, oz: -span * 0.1, scale: 1.7, speed: 0.78, phase: 1.9 },
      { ox: span * 1.35, y: 39, oz: span * 0.25, scale: 2.1, speed: 0.68, phase: 2.8 },
    ];

    const puffOffsets: ReadonlyArray<readonly [number, number, number, number]> = [
      [0, 0.35, 0, 2.2],
      [-2.1, -0.1, 0.3, 1.65],
      [2.2, -0.05, -0.2, 1.75],
      [-0.9, 0.45, -1.1, 1.45],
      [1.1, 0.25, 1.1, 1.4],
    ];

    for (const spec of cloudSpecs) {
      const cluster = new THREE.Group();

      for (const puff of puffOffsets) {
        const mesh = new THREE.Mesh(this.cloudPuffGeo, this.cloudMat);
        mesh.position.set(puff[0], puff[1], puff[2]);
        mesh.scale.set(puff[3] * 1.15, puff[3] * 0.72, puff[3]);
        cluster.add(mesh);
      }

      cluster.position.set(spec.ox, spec.y, spec.oz);
      cluster.scale.setScalar(spec.scale);
      this.cloudsRoot.add(cluster);

      this.clouds.push({
        group: cluster,
        speed: spec.speed,
        baseY: spec.y,
        bobPhase: spec.phase,
      });
    }
  }
}
