import * as THREE from "three";
import { SDF_DIMS } from "@critter/shared";

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
varying vec3 vWorldDir;

void main() {
  vec3 dir = normalize(vWorldDir);
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

  float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
  float warmGlow = pow(sunDot, 5.0) * 0.16;
  float sunHalo = pow(sunDot, 18.0) * 0.36;
  float sunCore = smoothstep(0.9965, 0.9993, sunDot) * 1.1;
  col += vec3(1.0, 0.89, 0.68) * warmGlow;
  col += vec3(1.0, 0.96, 0.84) * (sunHalo + sunCore);

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

/** Custom GLSL fragment shader for turquoise-to-cobalt gradient, sunlit shimmer, and surf foam. */
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

varying vec3 vWorldPos;
varying vec3 vWaveNormal;
varying float vWaveCrest;

void main() {
  vec3 N = normalize(vWaveNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);

  // Radial turquoise lagoon -> rich cerulean -> deep cobalt ocean gradient scaled to arena radius
  float distFromCenter = length(vWorldPos.xz - uIslandCenter);
  float normDist = distFromCenter / max(0.5, uIslandScale);
  float shallowToMid = smoothstep(14.0, 42.0, normDist);
  float midToDeep = smoothstep(38.0, 115.0, normDist);
  vec3 waterCol = mix(uShallowColor, uMidColor, shallowToMid);
  waterCol = mix(waterCol, uDeepColor, midToDeep);

  // Stylized animated caustic shimmer in shallow archipelago channels
  float causticA = sin(vWorldPos.x * 0.55 + uTime * 1.6 + sin(vWorldPos.z * 0.42));
  float causticB = cos(vWorldPos.z * 0.52 - uTime * 1.35 + cos(vWorldPos.x * 0.37));
  float caustic = smoothstep(0.45, 0.98, (causticA * causticB) * 0.5 + 0.5);
  waterCol += vec3(0.16, 0.32, 0.30) * caustic * (1.0 - shallowToMid * 0.72);

  // Subtle wave-crest turquoise brightening
  waterCol += vec3(0.05, 0.14, 0.14) * smoothstep(0.55, 1.0, vWaveCrest);

  // Sky reflection Fresnel + golden sunlit specular sparkle
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.4);
  waterCol = mix(waterCol, vec3(0.68, 0.90, 1.0), fresnel * 0.34);

  vec3 H = normalize(L + V);
  float specBroad = pow(max(dot(N, H), 0.0), 42.0) * 0.45;
  float specGlint = pow(max(dot(N, H), 0.0), 190.0) * 1.15;
  waterCol += vec3(1.0, 0.95, 0.80) * (specBroad + specGlint);

  // Animated coastal surf foam rings & lagoon shoreline froth
  float shoreWave = sin(distFromCenter * 0.75 - uTime * 2.2 + causticA * 1.4);
  float innerLagoonFoam = smoothstep(0.74, 0.96, shoreWave) *
    (1.0 - smoothstep(16.0, 36.0, normDist)) * 0.38;
  float outerSurfBand = exp(-pow((normDist - 26.5) / 5.5, 2.0)) *
    smoothstep(0.25, 0.9, sin(distFromCenter * 1.1 - uTime * 2.6 + causticB * 1.8) * 0.5 + 0.5);
  float crestFroth = smoothstep(0.84, 1.0, vWaveCrest) * 0.22;
  float foamMask = clamp(innerLagoonFoam + outerSurfBand * 0.52 + crestFroth, 0.0, 0.88);
  waterCol = mix(waterCol, uFoamColor, foamMask);

  // Exponential golden-hour distance fog matching scene.fog
  float camDist = length(cameraPosition - vWorldPos);
  float fogFactor = 1.0 - exp(-pow(camDist * uFogDensity, 2.0));
  waterCol = mix(waterCol, uFogColor, clamp(fogFactor, 0.0, 1.0));

  float alpha = mix(0.88, 0.98, clamp(shallowToMid + foamMask * 0.4, 0.0, 1.0));
  gl_FragColor = vec4(waterCol, alpha);
}
`;

/** Construct the custom GLSL stylized ocean ShaderMaterial. */
export function createOceanShaderMaterial(
  sunDir: THREE.Vector3,
): THREE.ShaderMaterial {
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
      uShallowColor: { value: new THREE.Color(0x1cd6d2) },
      uMidColor: { value: new THREE.Color(0x0c88ba) },
      uDeepColor: { value: new THREE.Color(0x0a3d80) },
      uFoamColor: { value: new THREE.Color(0xefffff) },
      uFogColor: { value: new THREE.Color(FOG_COLOR_HEX) },
      uFogDensity: { value: DUEL_FOG_DENSITY },
    },
  });
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    for (const item of material) {
      item.dispose();
    }
    return;
  }
  material.dispose();
}

function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    }
  });
}

/**
 * Sunlit floating sky-island Three.js scene, golden-hour lighting rig (2048x2048 shadows),
 * progressive Round 1-5 sky-gradient dome with glowing sun orb, distant silhouette floating islets,
 * drifting sculpted cloud clusters, and custom GLSL animated stylized ocean with churning flood waves.
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
  private readonly cloudsRoot: THREE.Group;
  private readonly clouds: CloudCluster[] = [];
  private readonly distantIsletsRoot: THREE.Group;
  private readonly distantIslets: DistantIslet[] = [];
  private readonly waterGroup: THREE.Group;
  private readonly oceanMesh: THREE.Mesh;
  private readonly oceanMat: THREE.ShaderMaterial;
  private readonly innerFoamRing: THREE.Mesh;
  private readonly outerFoamRing: THREE.Mesh;
  private readonly appendedToContainer: boolean;

  private readonly islandCenter = DEFAULT_ISLAND_CENTER.clone();
  private worldHalf = DEFAULT_WORLD_HALF;
  private worldScale = 1.0;
  private cloudYOffset = 0;
  private waterLevel = DEFAULT_WATER_LEVEL;
  private targetWaterLevel = DEFAULT_WATER_LEVEL;
  private currentRound = 1;
  private currentMaxRounds = 5;
  private floodIntensity = 0;

  public constructor(container: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(FOG_COLOR_HEX, DUEL_FOG_DENSITY);

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
    this.renderer.toneMappingExposure = 1.1;
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

    // Golden-hour daylight hemisphere + warm sun directional light casting 2048x2048 soft shadows
    this.hemiLight = new THREE.HemisphereLight(0xa8e6ff, 0x7a7b4c, 0.98);
    this.scene.add(this.hemiLight);

    const initialMetrics = computeWorldSceneMetrics(DEFAULT_WORLD_SPAN_X);
    this.sunLight = new THREE.DirectionalLight(0xffebd0, 2.2);
    this.sunLight.position.set(
      this.islandCenter.x + this.worldHalf * 1.25,
      Math.max(36, this.worldHalf * 1.65),
      this.islandCenter.z + this.worldHalf * 0.95,
    );
    this.sunLight.target.position.copy(this.islandCenter);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
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

    this.fillLight = new THREE.DirectionalLight(0x88d4ff, 0.52);
    this.fillLight.position.set(
      this.islandCenter.x - this.worldHalf * 1.1,
      Math.max(20, this.worldHalf * 0.9),
      this.islandCenter.z - this.worldHalf * 1.0,
    );
    this.scene.add(this.fillLight);

    // Stylized golden-hour sky-gradient dome + glowing sun orb
    const sunDir = new THREE.Vector3()
      .subVectors(this.sunLight.position, this.islandCenter)
      .normalize();
    const skyGeo = new THREE.SphereGeometry(BASE_SKY_RADIUS, 28, 20);
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenithColor: { value: new THREE.Color(0x1e76cf) },
        uMidSkyColor: { value: new THREE.Color(0x74c8f8) },
        uHorizonColor: { value: new THREE.Color(0xffe8c2) },
        uOceanBounceColor: { value: new THREE.Color(0x1b92b5) },
        uSunDir: { value: sunDir },
      },
    });
    this.skyDome = new THREE.Mesh(skyGeo, this.skyMat);
    this.skyDome.name = "sky_gradient_dome";
    this.skyDome.position.copy(this.islandCenter);
    this.scene.add(this.skyDome);

    this.sunOrbGroup = new THREE.Group();
    this.sunOrbGroup.name = "sun_orb_group";
    const sunOrbDist = BASE_SKY_RADIUS * 0.84;
    this.sunOrbGroup.position
      .copy(this.islandCenter)
      .addScaledVector(sunDir, sunOrbDist);

    const sunCoreMesh = new THREE.Mesh(
      new THREE.SphereGeometry(8.5, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xfff8de,
        fog: false,
      }),
    );
    const sunHaloMesh = new THREE.Mesh(
      new THREE.SphereGeometry(15.5, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffd27a,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sunOrbGroup.add(sunCoreMesh, sunHaloMesh);
    this.scene.add(this.sunOrbGroup);

    // Distant silhouette floating islets framing the archipelago horizon (local to island center)
    this.distantIsletsRoot = new THREE.Group();
    this.distantIsletsRoot.name = "distant_floating_islets";
    this.distantIsletsRoot.position.set(this.islandCenter.x, 0, this.islandCenter.z);
    this.buildDistantIslets();
    this.scene.add(this.distantIsletsRoot);

    // Drifting puffy sculpted low-poly cloud clusters (local to island center)
    this.cloudsRoot = new THREE.Group();
    this.cloudsRoot.name = "cloud_clusters";
    this.cloudsRoot.position.set(this.islandCenter.x, 0, this.islandCenter.z);
    this.buildClouds();
    this.scene.add(this.cloudsRoot);

    // Custom GLSL animated stylized ocean + translucent coastal surf foam rings
    this.waterGroup = new THREE.Group();
    this.waterGroup.name = "ocean_group";
    this.waterGroup.position.set(
      this.islandCenter.x,
      this.waterLevel,
      this.islandCenter.z,
    );

    const oceanGeo = new THREE.PlaneGeometry(BASE_OCEAN_SPAN, BASE_OCEAN_SPAN, 96, 96);
    this.oceanMat = createOceanShaderMaterial(sunDir);
    this.oceanMesh = new THREE.Mesh(oceanGeo, this.oceanMat);
    this.oceanMesh.name = "turquoise_shader_ocean";
    this.oceanMesh.rotation.x = -Math.PI * 0.5;
    this.waterGroup.add(this.oceanMesh);

    const innerFoamGeo = new THREE.RingGeometry(
      DEFAULT_WORLD_HALF * 0.62,
      DEFAULT_WORLD_HALF * 0.84,
      64,
      2,
    );
    const innerFoamMat = new THREE.MeshBasicMaterial({
      color: 0xeaffff,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.innerFoamRing = new THREE.Mesh(innerFoamGeo, innerFoamMat);
    this.innerFoamRing.name = "coastal_foam_inner";
    this.innerFoamRing.rotation.x = -Math.PI * 0.5;
    this.innerFoamRing.position.y = 0.08;
    this.waterGroup.add(this.innerFoamRing);

    const outerFoamGeo = new THREE.RingGeometry(
      DEFAULT_WORLD_HALF * 0.88,
      DEFAULT_WORLD_HALF * 1.04,
      64,
      1,
    );
    const outerFoamMat = new THREE.MeshBasicMaterial({
      color: 0xd0fbff,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.outerFoamRing = new THREE.Mesh(outerFoamGeo, outerFoamMat);
    this.outerFoamRing.name = "coastal_foam_outer";
    this.outerFoamRing.rotation.x = -Math.PI * 0.5;
    this.outerFoamRing.position.y = 0.06;
    this.waterGroup.add(this.outerFoamRing);

    this.scene.add(this.waterGroup);
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

    this.worldHalf = spanXZ * 0.5;
    this.worldScale = this.worldHalf / DEFAULT_WORLD_HALF;
    this.islandCenter.set(safeW * 0.5, Math.max(8.0, safeH * 0.3), safeD * 0.5);
    this.cloudYOffset = Math.max(0, safeH - DEFAULT_WORLD_SPAN_Y) * 0.85;

    this.sunLight.position.set(
      this.islandCenter.x + this.worldHalf * 1.25,
      Math.max(36, this.worldHalf * 1.65),
      this.islandCenter.z + this.worldHalf * 0.95,
    );
    this.sunLight.target.position.copy(this.islandCenter);
    this.sunLight.shadow.camera.left = -metrics.shadowHalf;
    this.sunLight.shadow.camera.right = metrics.shadowHalf;
    this.sunLight.shadow.camera.top = metrics.shadowHalf;
    this.sunLight.shadow.camera.bottom = -metrics.shadowHalf;
    this.sunLight.shadow.camera.far = Math.max(140, spanXZ * 3.2);
    this.sunLight.shadow.camera.updateProjectionMatrix();

    this.fillLight.position.set(
      this.islandCenter.x - this.worldHalf * 1.1,
      Math.max(20, this.worldHalf * 0.9),
      this.islandCenter.z - this.worldHalf * 1.0,
    );

    const skyScale = Math.max(1.0, (metrics.oceanSpan * 0.68) / BASE_SKY_RADIUS);
    const sunDir = new THREE.Vector3()
      .subVectors(this.sunLight.position, this.islandCenter)
      .normalize();
    this.skyDome.position.copy(this.islandCenter);
    this.skyDome.scale.setScalar(skyScale);
    this.sunOrbGroup.position
      .copy(this.islandCenter)
      .addScaledVector(sunDir, BASE_SKY_RADIUS * skyScale * 0.84);
    this.sunOrbGroup.scale.setScalar(skyScale);

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

  /** Animate GLSL ocean waves, smooth rising water level, coastal surf foam, distant islets, and drifting clouds. */
  public update(dtSec: number, elapsedSec: number): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;

    // Smoothly interpolate vertical water elevation toward targetWaterLevel at 60 FPS
    if (Math.abs(this.targetWaterLevel - this.waterLevel) > 1e-4) {
      const alpha = safeDt > 0 ? 1 - Math.exp(-7 * safeDt) : 1;
      this.waterLevel += (this.targetWaterLevel - this.waterLevel) * alpha;
      this.waterGroup.position.y = this.waterLevel;
    }

    // Advance GPU ocean wave shader clock
    const timeUniform = this.oceanMat.uniforms.uTime;
    if (timeUniform) {
      timeUniform.value = t;
    }

    // Coastal foam ring gentle breathing pulse scaled to current arena radius + storm surge
    const surgeSpeed = 1 + this.floodIntensity * 0.9;
    const foamBoost = this.floodIntensity * 0.18;
    const innerScale = this.worldScale * (1.0 + Math.sin(t * 1.35 * surgeSpeed) * 0.032);
    this.innerFoamRing.scale.set(innerScale, innerScale, 1);
    if (this.innerFoamRing.material instanceof THREE.MeshBasicMaterial) {
      this.innerFoamRing.material.opacity = clamp(
        0.22 + foamBoost + Math.sin(t * 1.35 * surgeSpeed) * 0.07,
        0.05,
        0.65,
      );
    }

    const outerScale =
      this.worldScale * (1.0 + Math.cos(t * 1.05 * surgeSpeed + 1.1) * 0.04);
    this.outerFoamRing.scale.set(outerScale, outerScale, 1);
    if (this.outerFoamRing.material instanceof THREE.MeshBasicMaterial) {
      this.outerFoamRing.material.opacity = clamp(
        0.14 + foamBoost * 0.8 + Math.cos(t * 1.05 * surgeSpeed + 1.1) * 0.05,
        0.05,
        0.55,
      );
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

  /** Dispose all scene geometries, materials, shadow maps, and WebGL context resources. */
  public dispose(): void {
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
    this.innerFoamRing.geometry.dispose();
    disposeMaterial(this.innerFoamRing.material);
    this.outerFoamRing.geometry.dispose();
    disposeMaterial(this.outerFoamRing.material);
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

  private applyAtmosphere(): void {
    const state = computeAtmosphereState(
      this.currentRound,
      this.currentMaxRounds,
      this.floodIntensity,
    );

    const zenithUniform = this.skyMat.uniforms.uZenithColor;
    if (zenithUniform && zenithUniform.value instanceof THREE.Color) {
      zenithUniform.value.copy(state.zenithColor);
    }
    const midSkyUniform = this.skyMat.uniforms.uMidSkyColor;
    if (midSkyUniform && midSkyUniform.value instanceof THREE.Color) {
      midSkyUniform.value.copy(state.midSkyColor);
    }
    const horizonUniform = this.skyMat.uniforms.uHorizonColor;
    if (horizonUniform && horizonUniform.value instanceof THREE.Color) {
      horizonUniform.value.copy(state.horizonColor);
    }
    const oceanBounceUniform = this.skyMat.uniforms.uOceanBounceColor;
    if (oceanBounceUniform && oceanBounceUniform.value instanceof THREE.Color) {
      oceanBounceUniform.value.copy(state.oceanBounceColor);
    }

    this.sunLight.color.copy(state.sunColor);
    this.sunLight.intensity = state.sunIntensity;
    this.hemiLight.color.copy(state.hemiSkyColor);
    this.hemiLight.groundColor.copy(state.hemiGroundColor);
    this.hemiLight.intensity = state.hemiIntensity;
    this.fillLight.color.copy(state.fillColor);
    this.fillLight.intensity = state.fillIntensity;

    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(state.fogColor);
    }

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
      shallowUniform.value.copy(state.shallowOceanColor);
    }
    const midUniform = this.oceanMat.uniforms.uMidColor;
    if (midUniform && midUniform.value instanceof THREE.Color) {
      midUniform.value.copy(state.midOceanColor);
    }
    const deepUniform = this.oceanMat.uniforms.uDeepColor;
    if (deepUniform && deepUniform.value instanceof THREE.Color) {
      deepUniform.value.copy(state.deepOceanColor);
    }
    const oceanFogUniform = this.oceanMat.uniforms.uFogColor;
    if (oceanFogUniform && oceanFogUniform.value instanceof THREE.Color) {
      oceanFogUniform.value.copy(state.fogColor);
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

    for (const sp of specs) {
      const group = new THREE.Group();
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x8b7e78,
        roughness: 0.94,
        metalness: 0.02,
        flatShading: true,
      });
      const grassMat = new THREE.MeshStandardMaterial({
        color: 0x5c9c64,
        roughness: 0.92,
        metalness: 0.0,
        flatShading: true,
      });

      // Tapered floating rock underside (inverted cone) + rounded meadow crown
      const underRock = new THREE.Mesh(
        new THREE.ConeGeometry(5.6, 11.0, 8),
        rockMat,
      );
      underRock.rotation.x = Math.PI;
      underRock.position.y = -4.8;

      const crown = new THREE.Mesh(
        new THREE.IcosahedronGeometry(5.8, 1),
        grassMat,
      );
      crown.scale.set(1.05, 0.36, 1.0);
      crown.position.y = 0.7;

      const spireTree = new THREE.Mesh(
        new THREE.ConeGeometry(1.4, 3.8, 6),
        new THREE.MeshStandardMaterial({
          color: 0x3b7652,
          roughness: 0.9,
          flatShading: true,
        }),
      );
      spireTree.position.set(1.2, 3.4, -0.6);

      const dist =
        initialMetrics.isletMinDist +
        sp.distT * (initialMetrics.isletMaxDist - initialMetrics.isletMinDist);
      group.add(underRock, crown, spireTree);
      group.position.set(
        Math.cos(sp.angle) * dist,
        sp.y,
        Math.sin(sp.angle) * dist,
      );
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
      const cloudMat = new THREE.MeshStandardMaterial({
        color: 0xfffdf8,
        roughness: 0.94,
        metalness: 0.0,
      });

      for (const puff of puffOffsets) {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(puff[3], 10, 8),
          cloudMat,
        );
        mesh.position.set(puff[0], puff[1], puff[2]);
        mesh.scale.set(1.15, 0.72, 1.0);
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
