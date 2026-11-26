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
const FOG_DENSITY = 0.0023;
const BASE_SKY_RADIUS = Math.max(210, DEFAULT_WORLD_HALF * 8.5);

interface CloudCluster {
  group: THREE.Group;
  speed: number;
  baseY: number;
  bobPhase: number;
}

interface DistantIslet {
  group: THREE.Group;
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
varying vec3 vWorldPos;
varying vec3 vWaveNormal;
varying float vWaveCrest;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  float wx = worldPos.x;
  float wz = worldPos.z;

  float w1 = sin(wx * 0.18 + uTime * 1.45) * 0.13;
  float w2 = cos(wz * 0.15 - uTime * 1.18) * 0.11;
  float w3 = sin((wx * 0.12 + wz * 0.11) + uTime * 0.92) * 0.08;
  float w4 = cos((wx * 0.27 - wz * 0.23) - uTime * 1.85) * 0.04;
  float disp = w1 + w2 + w3 + w4;
  worldPos.y += disp;

  float dHx =
    cos(wx * 0.18 + uTime * 1.45) * 0.13 * 0.18 +
    cos((wx * 0.12 + wz * 0.11) + uTime * 0.92) * 0.08 * 0.12 -
    sin((wx * 0.27 - wz * 0.23) - uTime * 1.85) * 0.04 * 0.27;
  float dHz =
    -sin(wz * 0.15 - uTime * 1.18) * 0.11 * 0.15 +
    cos((wx * 0.12 + wz * 0.11) + uTime * 0.92) * 0.08 * 0.11 +
    sin((wx * 0.27 - wz * 0.23) - uTime * 1.85) * 0.04 * 0.23;

  vWaveNormal = normalize(vec3(-dHx * 2.2, 1.0, -dHz * 2.2));
  vWorldPos = worldPos.xyz;
  vWaveCrest = clamp(disp * 2.2 + 0.5, 0.0, 1.0);

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
      uFogDensity: { value: FOG_DENSITY },
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
 * sky-gradient dome with glowing sun orb, distant silhouette floating islets, drifting
 * sculpted cloud clusters, and custom GLSL animated stylized ocean with coastal surf foam.
 */
export class WorldScene {
  public readonly scene: THREE.Scene;
  public readonly renderer: THREE.WebGLRenderer;

  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly fillLight: THREE.DirectionalLight;
  private readonly skyDome: THREE.Mesh;
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

  public constructor(container: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(FOG_COLOR_HEX, FOG_DENSITY);

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

    const shadowHalf = Math.max(36, this.worldHalf + 10);
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
    this.sunLight.shadow.camera.far = Math.max(120, this.worldHalf * 5.8);
    this.sunLight.shadow.camera.left = -shadowHalf;
    this.sunLight.shadow.camera.right = shadowHalf;
    this.sunLight.shadow.camera.top = shadowHalf;
    this.sunLight.shadow.camera.bottom = -shadowHalf;
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
    const skyMat = new THREE.ShaderMaterial({
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
    this.skyDome = new THREE.Mesh(skyGeo, skyMat);
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

    const oceanSpan = Math.max(360, DEFAULT_WORLD_HALF * 14);
    const oceanGeo = new THREE.PlaneGeometry(oceanSpan, oceanSpan, 96, 96);
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

  /** Recenter and scale sun shadows, ocean, sky dome, clouds, and horizon islets for Duel (60m) vs Grand (144m) worlds. */
  public setWorldBounds(
    worldWidth: number,
    worldHeight: number,
    worldDepth: number,
  ): void {
    const safeW = Number.isFinite(worldWidth) && worldWidth > 0 ? worldWidth : DEFAULT_WORLD_SPAN_X;
    const safeH = Number.isFinite(worldHeight) && worldHeight > 0 ? worldHeight : DEFAULT_WORLD_SPAN_Y;
    const safeD = Number.isFinite(worldDepth) && worldDepth > 0 ? worldDepth : DEFAULT_WORLD_SPAN_Z;

    this.worldHalf = Math.max(safeW, safeD) * 0.5;
    this.worldScale = this.worldHalf / DEFAULT_WORLD_HALF;
    this.islandCenter.set(safeW * 0.5, Math.max(8.0, safeH * 0.3), safeD * 0.5);
    this.cloudYOffset = Math.max(0, safeH - DEFAULT_WORLD_SPAN_Y) * 0.85;

    const shadowHalf = Math.max(36, this.worldHalf + 12);
    this.sunLight.position.set(
      this.islandCenter.x + this.worldHalf * 1.25,
      Math.max(36, this.worldHalf * 1.65),
      this.islandCenter.z + this.worldHalf * 0.95,
    );
    this.sunLight.target.position.copy(this.islandCenter);
    this.sunLight.shadow.camera.left = -shadowHalf;
    this.sunLight.shadow.camera.right = shadowHalf;
    this.sunLight.shadow.camera.top = shadowHalf;
    this.sunLight.shadow.camera.bottom = -shadowHalf;
    this.sunLight.shadow.camera.far = Math.max(120, this.worldHalf * 5.8);
    this.sunLight.shadow.camera.updateProjectionMatrix();

    this.fillLight.position.set(
      this.islandCenter.x - this.worldHalf * 1.1,
      Math.max(20, this.worldHalf * 0.9),
      this.islandCenter.z - this.worldHalf * 1.0,
    );

    const skyScale = Math.max(1.0, this.worldScale * 0.88);
    const sunDir = new THREE.Vector3()
      .subVectors(this.sunLight.position, this.islandCenter)
      .normalize();
    this.skyDome.position.copy(this.islandCenter);
    this.skyDome.scale.setScalar(skyScale);
    this.sunOrbGroup.position
      .copy(this.islandCenter)
      .addScaledVector(sunDir, BASE_SKY_RADIUS * skyScale * 0.84);
    this.sunOrbGroup.scale.setScalar(skyScale);

    this.distantIsletsRoot.position.set(this.islandCenter.x, 0, this.islandCenter.z);
    this.distantIsletsRoot.scale.set(
      this.worldScale,
      Math.max(1.0, this.worldScale * 0.72),
      this.worldScale,
    );

    this.cloudsRoot.position.set(this.islandCenter.x, 0, this.islandCenter.z);
    this.cloudsRoot.scale.set(this.worldScale, 1.0, this.worldScale);

    this.waterGroup.position.set(
      this.islandCenter.x,
      this.waterLevel,
      this.islandCenter.z,
    );
    const oceanScale = Math.max(1.0, this.worldScale);
    this.oceanMesh.scale.set(oceanScale, oceanScale, 1);

    const centerUniform = this.oceanMat.uniforms.uIslandCenter;
    if (centerUniform && centerUniform.value instanceof THREE.Vector2) {
      centerUniform.value.set(this.islandCenter.x, this.islandCenter.z);
    }
    const scaleUniform = this.oceanMat.uniforms.uIslandScale;
    if (scaleUniform) {
      scaleUniform.value = this.worldScale;
    }

    const effectiveFogDensity = FOG_DENSITY / Math.sqrt(Math.max(1.0, this.worldScale));
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = effectiveFogDensity;
    }
    const fogUniform = this.oceanMat.uniforms.uFogDensity;
    if (fogUniform) {
      fogUniform.value = effectiveFogDensity;
    }
  }

  /** Set the vertical ocean height (for sudden-death rising tide). */
  public setWaterLevel(y: number): void {
    if (!Number.isFinite(y)) {
      return;
    }
    this.waterLevel = y;
    this.waterGroup.position.y = y;
  }

  /** Resize renderer viewport cleanly. */
  public resize(width: number, height: number): void {
    const safeW = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
    const safeH = Math.max(1, Math.floor(Number.isFinite(height) ? height : 1));
    this.renderer.setSize(safeW, safeH, true);
  }

  /** Animate GLSL ocean waves, coastal surf foam, distant islets, and drifting clouds. */
  public update(dtSec: number, elapsedSec: number): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;

    // Advance GPU ocean wave shader clock
    const timeUniform = this.oceanMat.uniforms.uTime;
    if (timeUniform) {
      timeUniform.value = t;
    }

    // Coastal foam ring gentle breathing pulse scaled to current arena radius
    const innerScale = this.worldScale * (1.0 + Math.sin(t * 1.35) * 0.032);
    this.innerFoamRing.scale.set(innerScale, innerScale, 1);
    if (this.innerFoamRing.material instanceof THREE.MeshBasicMaterial) {
      this.innerFoamRing.material.opacity = 0.22 + Math.sin(t * 1.35) * 0.07;
    }

    const outerScale = this.worldScale * (1.0 + Math.cos(t * 1.05 + 1.1) * 0.04);
    this.outerFoamRing.scale.set(outerScale, outerScale, 1);
    if (this.outerFoamRing.material instanceof THREE.MeshBasicMaterial) {
      this.outerFoamRing.material.opacity = 0.14 + Math.cos(t * 1.05 + 1.1) * 0.05;
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
    disposeMaterial(this.skyDome.material);
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

  private buildDistantIslets(): void {
    const specs: ReadonlyArray<{
      angle: number;
      dist: number;
      y: number;
      scale: number;
      phase: number;
    }> = [
      { angle: 0.35, dist: 92, y: 12, scale: 1.3, phase: 0.4 },
      { angle: 1.25, dist: 112, y: 18, scale: 1.65, phase: 1.7 },
      { angle: 2.15, dist: 96, y: 10, scale: 1.15, phase: 2.8 },
      { angle: 3.1, dist: 124, y: 21, scale: 1.85, phase: 3.9 },
      { angle: 4.05, dist: 104, y: 14, scale: 1.4, phase: 4.6 },
      { angle: 5.05, dist: 88, y: 9, scale: 1.1, phase: 5.5 },
      { angle: 5.75, dist: 118, y: 16, scale: 1.55, phase: 1.1 },
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

      group.add(underRock, crown, spireTree);
      group.position.set(
        Math.cos(sp.angle) * sp.dist,
        sp.y,
        Math.sin(sp.angle) * sp.dist,
      );
      group.scale.setScalar(sp.scale);
      this.distantIsletsRoot.add(group);
      this.distantIslets.push({ group, baseY: sp.y, bobPhase: sp.phase });
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
