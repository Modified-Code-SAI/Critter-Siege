import * as THREE from "three";
import {
  GALE_SCATTER_CONE_MIN_DOT,
  GALE_SCATTER_REACH,
  SDF_DIMS,
  type EvoPodState,
  type GadgetId,
  type PrismWallState,
  type Vec3,
} from "@critter/shared";

export interface ProjectileVisualOptions {
  readonly gadgetId?: GadgetId;
  readonly direction?: Vec3;
  readonly boring?: boolean;
  readonly targetPos?: Vec3 | null;
  readonly dtSec?: number;
}

export interface DroneBeaconInput {
  readonly id: string;
  readonly position: Vec3;
  readonly color: string;
  readonly isLocal: boolean;
  readonly isActiveTurn: boolean;
}

const WORLD_SPAN_X = SDF_DIMS.nx * SDF_DIMS.voxelSize;
const WORLD_SPAN_Y = SDF_DIMS.ny * SDF_DIMS.voxelSize;
const WORLD_SPAN_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize;
const POLLEN_MOTE_COUNT = 110;
const WIND_RIBBON_COUNT = 22;
const INSTANCE_POOL_CAPACITY = 96;
const GLOW_SPRITE_POOL_CAPACITY = 48;
const SMOKE_SPRITE_POOL_CAPACITY = 64;

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE_COLOR = new THREE.Color(0xffffff);
const FORWARD_Z = new THREE.Vector3(0, 0, 1);
const UP_Y = new THREE.Vector3(0, 1, 0);
const GALE_SCATTER_CONE_TAN = Math.tan(Math.acos(GALE_SCATTER_CONE_MIN_DOT));
const GPS_LOCK_CYAN = new THREE.Color(0x38f5ff);
const GPS_LOCK_CRIMSON = new THREE.Color(0xff3b5c);
const DRONE_BEACON_GOLD_HEX = 0xfacc15;
const DRONE_BEACON_PILLAR_HEIGHT = 18;
const DRONE_BEACON_BASE_Y_OFFSET = 0.15;

const ROCK_SHARD_PALETTE: readonly number[] = [
  0xb96c43,
  0x9a5938,
  0x7a7673,
  0xc98b5b,
  0x5e6268,
];

interface DynamicParticle {
  mesh: THREE.Mesh;
  material: THREE.Material;
  sharedMaterial?: boolean;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  gravity: number;
  age: number;
  maxAge: number;
  startScale: number;
  endScale: number;
  baseScaleVec: THREE.Vector3;
  baseOpacity: number;
  kind: "shockwave" | "beam" | "shard";
}

interface PooledInstanceSlot {
  active: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  rotation: THREE.Euler;
  spin: THREE.Vector3;
  gravity: number;
  age: number;
  maxAge: number;
  startScale: number;
  endScale: number;
  baseScaleVec: THREE.Vector3;
}

interface InstancedParticlePool {
  mesh: THREE.InstancedMesh;
  slots: PooledInstanceSlot[];
  cursor: number;
}

interface PooledSpriteSlot {
  active: boolean;
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  gravity: number;
  age: number;
  maxAge: number;
  startScale: number;
  endScale: number;
  baseOpacity: number;
  rotationSpeed: number;
}

interface SpriteParticlePool {
  slots: PooledSpriteSlot[];
  cursor: number;
}

interface PrismWallVisual {
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  rimMat: THREE.MeshBasicMaterial;
}

interface EvoPodVisual {
  group: THREE.Group;
  podCore: THREE.Mesh;
  parachuteGroup: THREE.Group;
  beaconMesh: THREE.Mesh;
  groundPoolMesh?: THREE.Mesh;
}

interface WindRibbon {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  speedFactor: number;
  phase: number;
}

interface DroneBeaconVisual {
  group: THREE.Group;
  pillar: THREE.Mesh;
  pillarMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
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
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  const addMat = (material: THREE.Material | THREE.Material[]): void => {
    if (Array.isArray(material)) {
      for (const item of material) {
        mats.add(item);
      }
      return;
    }
    mats.add(material);
  };
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      geos.add(obj.geometry);
      addMat(obj.material);
    } else if (obj instanceof THREE.Sprite) {
      // Dispose per-sprite SpriteMaterial without disposing class-owned shared textures
      addMat(obj.material);
    }
  });
  for (const g of geos) {
    g.dispose();
  }
  for (const m of mats) {
    m.dispose();
  }
}

function disposeObjectMaterialsOnly(root: THREE.Object3D): void {
  const mats = new Set<THREE.Material>();
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      if (Array.isArray(obj.material)) {
        for (const item of obj.material) {
          mats.add(item);
        }
      } else {
        mats.add(obj.material);
      }
    } else if (obj instanceof THREE.Sprite) {
      mats.add(obj.material);
    }
  });
  for (const m of mats) {
    m.dispose();
  }
}

function buildOrthonormalBasis(
  dir: THREE.Vector3,
  outRight: THREE.Vector3,
  outUp: THREE.Vector3,
): void {
  const ref = Math.abs(dir.y) > 0.92 ? FORWARD_Z : UP_Y;
  outRight.crossVectors(dir, ref).normalize();
  outUp.crossVectors(outRight, dir).normalize();
}

function wrapCoord(v: number, min: number, max: number): number {
  const span = max - min;
  if (v < min) {
    return max - ((min - v) % span);
  }
  if (v > max) {
    return min + ((v - min) % span);
  }
  return v;
}

/** Shared smooth radial glow texture for additive blast flashes, comet halos, and sparks. */
function createGlowTexture(): THREE.Texture {
  if (typeof document !== "undefined") {
    const size = 64;
    const half = size * 0.5;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0.0, "rgba(255, 255, 255, 1.0)");
      grad.addColorStop(0.24, "rgba(255, 255, 255, 0.78)");
      grad.addColorStop(0.54, "rgba(255, 255, 255, 0.24)");
      grad.addColorStop(0.84, "rgba(255, 255, 255, 0.04)");
      grad.addColorStop(1.0, "rgba(255, 255, 255, 0.0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      return tex;
    }
  }

  const size = 16;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot((x - center) / center, (y - center) / center);
      const alpha = Math.round(clamp01(Math.pow(Math.max(0, 1 - dist), 2.4)) * 255);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = alpha;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Shared multi-lobe billowing cloud puff radial texture for soft explosion smoke & geyser steam. */
function createSmokeTexture(): THREE.Texture {
  if (typeof document !== "undefined") {
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, size, size);
      const lobes: ReadonlyArray<readonly [number, number, number, number]> = [
        [0.5, 0.5, 0.42, 0.72],
        [0.37, 0.44, 0.28, 0.55],
        [0.64, 0.46, 0.27, 0.52],
        [0.48, 0.36, 0.26, 0.58],
        [0.54, 0.62, 0.28, 0.48],
      ];
      for (const [cx, cy, rad, peak] of lobes) {
        const px = cx * size;
        const py = cy * size;
        const pr = rad * size;
        const grad = ctx.createRadialGradient(px, py, pr * 0.08, px, py, pr);
        grad.addColorStop(0.0, `rgba(255, 255, 255, ${peak.toFixed(2)})`);
        grad.addColorStop(0.55, `rgba(242, 244, 248, ${(peak * 0.45).toFixed(2)})`);
        grad.addColorStop(1.0, "rgba(230, 236, 242, 0.0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      return tex;
    }
  }

  const size = 16;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot((x - center) / center, (y - center) / center);
      const puff = clamp01(1.0 - dist * dist);
      const idx = (y * size + x) * 4;
      data[idx] = 250;
      data[idx + 1] = 250;
      data[idx + 2] = 252;
      data[idx + 3] = Math.round(puff * 235);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Shared crisp soft-edged round bokeh texture so ambient sunlit pollen motes never look square. */
function createBokehTexture(): THREE.Texture {
  if (typeof document !== "undefined") {
    const size = 32;
    const half = size * 0.5;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0.0, "rgba(255, 255, 255, 1.0)");
      grad.addColorStop(0.55, "rgba(255, 252, 235, 0.85)");
      grad.addColorStop(0.82, "rgba(255, 240, 190, 0.28)");
      grad.addColorStop(1.0, "rgba(255, 235, 180, 0.0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      return tex;
    }
  }

  const size = 16;
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot((x - center) / center, (y - center) / center);
      const softCircle = clamp01((1.0 - dist) * 2.2);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 252;
      data[idx + 2] = 235;
      data[idx + 3] = Math.round(softCircle * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function createInstancedPool(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  name: string,
  castShadow: boolean,
): InstancedParticlePool {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;

  const slots: PooledInstanceSlot[] = [];
  for (let i = 0; i < capacity; i++) {
    mesh.setMatrixAt(i, ZERO_MATRIX);
    mesh.setColorAt(i, WHITE_COLOR);
    slots.push({
      active: false,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      spin: new THREE.Vector3(),
      gravity: 0,
      age: 0,
      maxAge: 1,
      startScale: 1,
      endScale: 0.1,
      baseScaleVec: new THREE.Vector3(1, 1, 1),
    });
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }

  return { mesh, slots, cursor: 0 };
}

function createSpritePool(
  texture: THREE.Texture,
  capacity: number,
  additive: boolean,
  parent: THREE.Group,
): SpriteParticlePool {
  const slots: PooledSpriteSlot[] = [];
  for (let i = 0; i < capacity; i++) {
    const mat = new THREE.SpriteMaterial({
      map: texture,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      ...(additive ? { blending: THREE.AdditiveBlending } : {}),
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.frustumCulled = false;
    parent.add(sprite);
    slots.push({
      active: false,
      sprite,
      velocity: new THREE.Vector3(),
      gravity: 0,
      age: 0,
      maxAge: 1,
      startScale: 1,
      endScale: 1,
      baseOpacity: 1,
      rotationSpeed: 0,
    });
  }
  return { slots, cursor: 0 };
}

/**
 * Stylized 3D VFX system for Critter Siege: pooled InstancedMesh jagged rock shards,
 * additive billboard blast flashes & comet halos, soft billowing smoke/steam plumes,
 * round bokeh pollen motes, parachuting Evo Pods, scaled wind ribbons, and drone pings.
 */
export class VfxSystem {
  public readonly group: THREE.Group;

  private readonly particleGroup: THREE.Group;
  private readonly poolGroup: THREE.Group;
  private readonly evoPodGroup: THREE.Group;
  private readonly prismWallGroup: THREE.Group;
  private readonly windGroup: THREE.Group;
  private readonly pollenPoints: THREE.Points;
  private readonly pollenPhases: Float32Array;
  private readonly pollenSpeeds: Float32Array;
  private lastWind: Vec3 = { x: 1.0, y: 0, z: 0.4 };

  private readonly glowTexture: THREE.Texture;
  private readonly smokeTexture: THREE.Texture;
  private readonly bokehTexture: THREE.Texture;

  private readonly sharedGeos: {
    shardDodeca: THREE.DodecahedronGeometry;
    shardTetra: THREE.TetrahedronGeometry;
    droplet: THREE.SphereGeometry;
    shockRing: THREE.TorusGeometry;
    spark: THREE.OctahedronGeometry;
    ribbon: THREE.CylinderGeometry;
    grappleBeam: THREE.CylinderGeometry;
    hookCollar: THREE.CylinderGeometry;
    hookShankRing: THREE.TorusGeometry;
    hookProngCurve: THREE.TubeGeometry;
    hookProngTip: THREE.ConeGeometry;
    droneBeaconPillar: THREE.CylinderGeometry;
    droneBeaconRing: THREE.TorusGeometry;
  };

  private readonly dodecaShardPool: InstancedParticlePool;
  private readonly tetraShardPool: InstancedParticlePool;
  private readonly sparkPool: InstancedParticlePool;
  private readonly dropletPool: InstancedParticlePool;
  private readonly glowSpritePool: SpriteParticlePool;
  private readonly smokeSpritePool: SpriteParticlePool;

  private readonly shardPaletteMaterials: THREE.MeshStandardMaterial[];
  private readonly prismShardMaterial: THREE.MeshStandardMaterial;
  private readonly dummyObj = new THREE.Object3D();
  private readonly scratchColor = new THREE.Color();
  private readonly tempVec = new THREE.Vector3();
  private readonly tempDir = new THREE.Vector3();
  private readonly tempRight = new THREE.Vector3();
  private readonly tempUp = new THREE.Vector3();
  private readonly tempTarget = new THREE.Vector3();
  private readonly tempOrigin = new THREE.Vector3();
  private readonly tempQuat = new THREE.Quaternion();

  private readonly particles: DynamicParticle[] = [];
  private readonly evoPods: Map<string, EvoPodVisual> = new Map();
  private readonly prismWallVisuals = new Map<string, PrismWallVisual>();
  private readonly windRibbons: WindRibbon[] = [];

  private readonly projectileGroup: THREE.Group;
  private readonly projectileCoreMat: THREE.MeshStandardMaterial;
  private readonly projectileRingMat: THREE.MeshBasicMaterial;
  private readonly projectileHalo: THREE.Sprite;
  private readonly bombGroup: THREE.Group;
  private readonly bombFlameSprite: THREE.Sprite;
  private readonly bombFlameCoreSprite: THREE.Sprite;
  private readonly bombWickTipLocal = new THREE.Vector3(0.18, 0.45, 0.08);
  private readonly missileGroup: THREE.Group;
  private readonly missileThrusterSprite: THREE.Sprite;
  private readonly gpsLockBeam: THREE.Mesh;
  private readonly drillGroup: THREE.Group;
  private readonly drillSpinPivot: THREE.Group;
  private readonly drillThrusterSprite: THREE.Sprite;
  private lastProjectilePos: THREE.Vector3 | null = null;
  private readonly lastProjectileDir = new THREE.Vector3(0, 1, 0);
  private trailEmitCounter = 0;
  private drillIsBoring = false;
  private bombRotatedThisTick = false;
  private drillSpunThisTick = false;
  private flamePhase = 0;

  private readonly dronePingGroup: THREE.Group;
  private readonly droneOuterRing: THREE.Mesh;
  private readonly droneInnerRing: THREE.Mesh;
  private readonly droneLockReticleGroup: THREE.Group;
  private readonly droneLockInnerRing: THREE.Mesh;
  private readonly droneLockInnerMat: THREE.MeshBasicMaterial;
  private droneLockMode = false;
  private readonly droneBeaconGroup: THREE.Group;
  private readonly droneBeacons = new Map<string, DroneBeaconVisual>();

  private pseudoSeed = 1337;
  private worldSpanX = WORLD_SPAN_X;
  private worldSpanY = WORLD_SPAN_Y;
  private worldSpanZ = WORLD_SPAN_Z;

  public constructor() {
    this.group = new THREE.Group();
    this.group.name = "vfx_system";

    this.particleGroup = new THREE.Group();
    this.particleGroup.name = "vfx_particles";
    this.group.add(this.particleGroup);

    this.poolGroup = new THREE.Group();
    this.poolGroup.name = "vfx_particle_pools";
    this.group.add(this.poolGroup);

    this.evoPodGroup = new THREE.Group();
    this.evoPodGroup.name = "vfx_evo_pods";
    this.group.add(this.evoPodGroup);

    this.prismWallGroup = new THREE.Group();
    this.prismWallGroup.name = "vfx_prism_walls";
    this.group.add(this.prismWallGroup);

    this.windGroup = new THREE.Group();
    this.windGroup.name = "vfx_wind_ribbons";
    this.group.add(this.windGroup);

    this.glowTexture = createGlowTexture();
    this.smokeTexture = createSmokeTexture();
    this.bokehTexture = createBokehTexture();

    const ribbonGeo = new THREE.CylinderGeometry(0.02, 0.062, 4.6, 6, 1, true);
    ribbonGeo.rotateX(Math.PI * 0.5);

    const hookCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.06, 0.06),
      new THREE.Vector3(0, 0.14, 0.21),
      new THREE.Vector3(0, -0.02, 0.29),
      new THREE.Vector3(0, -0.15, 0.21),
    ]);

    this.sharedGeos = {
      shardDodeca: new THREE.DodecahedronGeometry(0.18, 0),
      shardTetra: new THREE.TetrahedronGeometry(0.18, 0),
      droplet: new THREE.SphereGeometry(0.11, 8, 6),
      shockRing: new THREE.TorusGeometry(0.5, 0.06, 8, 28),
      spark: new THREE.OctahedronGeometry(0.085, 0),
      ribbon: ribbonGeo,
      grappleBeam: new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8, 1, false),
      hookCollar: new THREE.CylinderGeometry(0.105, 0.082, 0.22, 10),
      hookShankRing: new THREE.TorusGeometry(0.082, 0.022, 6, 14),
      hookProngCurve: new THREE.TubeGeometry(hookCurve, 12, 0.024, 6, false),
      hookProngTip: new THREE.ConeGeometry(0.032, 0.13, 8),
      droneBeaconPillar: new THREE.CylinderGeometry(
        0.18,
        0.72,
        DRONE_BEACON_PILLAR_HEIGHT,
        12,
        1,
        true,
      ),
      droneBeaconRing: new THREE.TorusGeometry(1.15, 0.08, 8, 28),
    };

    // Pooled InstancedMesh rock chips, additive sparks, and glossy water droplets (zero per-blast churn)
    const shardMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
    });
    this.dodecaShardPool = createInstancedPool(
      this.sharedGeos.shardDodeca,
      shardMat,
      INSTANCE_POOL_CAPACITY,
      "vfx_pool_dodeca_shards",
      true,
    );
    this.tetraShardPool = createInstancedPool(
      this.sharedGeos.shardTetra,
      shardMat,
      INSTANCE_POOL_CAPACITY,
      "vfx_pool_tetra_shards",
      true,
    );

    const sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.sparkPool = createInstancedPool(
      this.sharedGeos.spark,
      sparkMat,
      INSTANCE_POOL_CAPACITY,
      "vfx_pool_sparks",
      false,
    );

    const dropletMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.16,
      metalness: 0.08,
    });
    this.dropletPool = createInstancedPool(
      this.sharedGeos.droplet,
      dropletMat,
      INSTANCE_POOL_CAPACITY,
      "vfx_pool_droplets",
      false,
    );

    this.poolGroup.add(
      this.dodecaShardPool.mesh,
      this.tetraShardPool.mesh,
      this.sparkPool.mesh,
      this.dropletPool.mesh,
    );

    // Pooled additive glow & billowing smoke billboard sprites
    this.glowSpritePool = createSpritePool(
      this.glowTexture,
      GLOW_SPRITE_POOL_CAPACITY,
      true,
      this.poolGroup,
    );
    this.smokeSpritePool = createSpritePool(
      this.smokeTexture,
      SMOKE_SPRITE_POOL_CAPACITY,
      false,
      this.poolGroup,
    );

    // Shared rock palette & crystal prism shard materials (zero per-blast material allocation)
    this.shardPaletteMaterials = ROCK_SHARD_PALETTE.map(
      (color) =>
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.85,
          metalness: 0.05,
          flatShading: true,
        }),
    );
    this.prismShardMaterial = new THREE.MeshStandardMaterial({
      color: 0x67e8f9,
      emissive: 0x22d3ee,
      emissiveIntensity: 0.85,
      roughness: 0.18,
      metalness: 0.12,
      flatShading: true,
      transparent: true,
      opacity: 0.85,
    });

    // Build translucent sunlit wind-stream ribbons spanning the archipelago sky
    for (let i = 0; i < WIND_RIBBON_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.sharedGeos.ribbon, mat);
      mesh.position.set(
        2 + this.nextRand() * (WORLD_SPAN_X - 4),
        Math.max(5.5, WORLD_SPAN_Y * 0.26) + this.nextRand() * (WORLD_SPAN_Y * 0.56),
        2 + this.nextRand() * (WORLD_SPAN_Z - 4),
      );
      this.windGroup.add(mesh);
      this.windRibbons.push({
        mesh,
        material: mat,
        speedFactor: 0.75 + this.nextRand() * 0.55,
        phase: this.nextRand() * Math.PI * 2,
      });
    }

    // Drifting golden sunlit ambient pollen motes rendered as soft round bokeh orbs
    const pollenPositions = new Float32Array(POLLEN_MOTE_COUNT * 3);
    const pollenColors = new Float32Array(POLLEN_MOTE_COUNT * 3);
    this.pollenPhases = new Float32Array(POLLEN_MOTE_COUNT);
    this.pollenSpeeds = new Float32Array(POLLEN_MOTE_COUNT);

    for (let i = 0; i < POLLEN_MOTE_COUNT; i++) {
      pollenPositions[i * 3] = 4 + this.nextRand() * (WORLD_SPAN_X - 8);
      pollenPositions[i * 3 + 1] = 3.2 + this.nextRand() * (WORLD_SPAN_Y * 0.65);
      pollenPositions[i * 3 + 2] = 4 + this.nextRand() * (WORLD_SPAN_Z - 8);

      const warmMix = this.nextRand();
      pollenColors[i * 3] = 1.0;
      pollenColors[i * 3 + 1] = 0.88 + warmMix * 0.1;
      pollenColors[i * 3 + 2] = 0.48 + warmMix * 0.34;

      this.pollenPhases[i] = this.nextRand() * Math.PI * 2;
      this.pollenSpeeds[i] = 0.35 + this.nextRand() * 0.55;
    }

    const pollenGeo = new THREE.BufferGeometry();
    pollenGeo.setAttribute("position", new THREE.BufferAttribute(pollenPositions, 3));
    pollenGeo.setAttribute("color", new THREE.BufferAttribute(pollenColors, 3));
    const pollenMat = new THREE.PointsMaterial({
      size: 0.38,
      map: this.bokehTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.pollenPoints = new THREE.Points(pollenGeo, pollenMat);
    this.pollenPoints.name = "vfx_pollen_motes";
    this.group.add(this.pollenPoints);

    // Glowing projectile energy shell + soft additive comet halo
    this.projectileGroup = new THREE.Group();
    this.projectileGroup.name = "vfx_projectile";
    this.projectileGroup.visible = false;

    this.projectileCoreMat = new THREE.MeshStandardMaterial({
      color: 0xffb347,
      emissive: 0xff8c24,
      emissiveIntensity: 1.35,
      roughness: 0.2,
      metalness: 0.1,
    });
    const projCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 14, 12),
      this.projectileCoreMat,
    );
    this.projectileRingMat = new THREE.MeshBasicMaterial({
      color: 0xfff0c2,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const projRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.036, 8, 20),
      this.projectileRingMat,
    );
    const projHaloMat = new THREE.SpriteMaterial({
      map: this.glowTexture,
      color: 0xffb347,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.projectileHalo = new THREE.Sprite(projHaloMat);
    this.projectileHalo.name = "vfx_projectile_halo";
    this.projectileHalo.scale.set(1.55, 1.55, 1);

    this.projectileGroup.add(projCore, projRing, this.projectileHalo);
    this.group.add(this.projectileGroup);

    // Signature 3D Projectile Visuals: Gale Mortar black bomb, Seeker Firefly GPS missile + lock beam, Burrow Bore auger drill
    const bombBuilt = this.createBombVisual();
    this.bombGroup = bombBuilt.group;
    this.bombFlameSprite = bombBuilt.flameSprite;
    this.bombFlameCoreSprite = bombBuilt.flameCoreSprite;
    this.bombGroup.visible = false;
    this.group.add(this.bombGroup);

    const missileBuilt = this.createMissileVisual();
    this.missileGroup = missileBuilt.group;
    this.missileThrusterSprite = missileBuilt.thrusterSprite;
    this.missileGroup.visible = false;
    this.group.add(this.missileGroup);

    this.gpsLockBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.028, 1.0, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x38f5ff,
        transparent: true,
        opacity: 0.36,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.gpsLockBeam.name = "vfx_gps_lock_beam";
    this.gpsLockBeam.visible = false;
    this.group.add(this.gpsLockBeam);

    const drillBuilt = this.createDrillVisual();
    this.drillGroup = drillBuilt.group;
    this.drillSpinPivot = drillBuilt.spinPivot;
    this.drillThrusterSprite = drillBuilt.thrusterSprite;
    this.drillGroup.visible = false;
    this.group.add(this.drillGroup);

    // Glowing cyan drone recon target ping + GPS target-lock crosshair reticle
    this.dronePingGroup = new THREE.Group();
    this.dronePingGroup.name = "vfx_drone_ping";
    this.dronePingGroup.visible = false;

    this.droneOuterRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.05, 8, 32),
      new THREE.MeshBasicMaterial({
        color: 0x38f5ff,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
      }),
    );
    this.droneOuterRing.rotation.x = Math.PI * 0.5;
    this.droneOuterRing.position.y = 0.08;

    this.droneInnerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.04, 8, 24),
      new THREE.MeshBasicMaterial({
        color: 0xb8fcff,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
    );
    this.droneInnerRing.rotation.x = Math.PI * 0.5;
    this.droneInnerRing.position.y = 0.1;

    const pingBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.12, 3.2, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x38f5ff,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    pingBeam.position.y = 1.65;

    const reticleBuilt = this.createDroneLockReticle();
    this.droneLockReticleGroup = reticleBuilt.group;
    this.droneLockInnerRing = reticleBuilt.innerRing;
    this.droneLockInnerMat = reticleBuilt.innerMat;
    this.droneLockReticleGroup.visible = false;

    this.dronePingGroup.add(
      this.droneOuterRing,
      this.droneInnerRing,
      pingBeam,
      this.droneLockReticleGroup,
    );
    this.group.add(this.dronePingGroup);

    // Tall vertical 3D player beacons shown only while Tactical Drone View is active
    this.droneBeaconGroup = new THREE.Group();
    this.droneBeaconGroup.name = "vfx_drone_player_beacons";
    this.droneBeaconGroup.visible = false;
    this.group.add(this.droneBeaconGroup);
  }

  /**
   * Spawn a stylized blast with an expanding shockwave ring, luminous additive glow flash,
   * soft billowing smoke billboards, and 14-22 pooled tumbling jagged rock shards.
   */
  public spawnExplosion(
    position: Vec3,
    radius: number,
    isPull = false,
  ): void {
    const safeRadius = Number.isFinite(radius) ? Math.max(0.6, radius) : 1.6;
    const accentColor = isPull ? 0x38f2ff : 0xff8a2b;
    const coreColor = isPull ? 0xb4fbff : 0xffdf80;

    // Expanding shockwave ring
    const ringMat = new THREE.MeshBasicMaterial({
      color: accentColor,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(this.sharedGeos.shockRing, ringMat);
    ringMesh.position.set(position.x, position.y + 0.06, position.z);
    ringMesh.rotation.x = Math.PI * 0.5;
    this.particleGroup.add(ringMesh);
    this.particles.push({
      mesh: ringMesh,
      material: ringMat,
      velocity: new THREE.Vector3(0, 0.15, 0),
      spin: new THREE.Vector3(0, 0, 0),
      gravity: 0,
      age: 0,
      maxAge: 0.48,
      startScale: isPull ? safeRadius * 2.1 : 0.35,
      endScale: isPull ? 0.25 : safeRadius * 2.2,
      baseScaleVec: new THREE.Vector3(1, 1, 1),
      baseOpacity: 0.92,
      kind: "shockwave",
    });

    // Luminous additive core flash + outer warm bloom halo
    this.emitSpriteFromPool(this.glowSpritePool, {
      x: position.x,
      y: position.y + 0.18,
      z: position.z,
      vx: 0,
      vy: 0.5,
      vz: 0,
      gravity: 0,
      maxAge: 0.28,
      startScale: safeRadius * 1.15,
      endScale: safeRadius * 2.95,
      colorHex: coreColor,
      baseOpacity: 0.95,
      rotationSpeed: 0,
    });
    this.emitSpriteFromPool(this.glowSpritePool, {
      x: position.x,
      y: position.y + 0.25,
      z: position.z,
      vx: 0,
      vy: 0.8,
      vz: 0,
      gravity: 0,
      maxAge: 0.42,
      startScale: safeRadius * 1.4,
      endScale: safeRadius * 3.4,
      colorHex: accentColor,
      baseOpacity: 0.65,
      rotationSpeed: 0,
    });

    // Soft billowing smoke cloud billboards
    const smokeCount = 7;
    for (let i = 0; i < smokeCount; i++) {
      const angle = (i / smokeCount) * Math.PI * 2 + this.nextRand() * 0.5;
      const spread = (0.32 + this.nextRand() * 0.6) * safeRadius * 0.42;
      const smokeTint = isPull
        ? 0xb4f3ff
        : i % 2 === 0
          ? 0xf4ece2
          : 0xd9cfc4;
      this.emitSpriteFromPool(this.smokeSpritePool, {
        x: position.x + Math.cos(angle) * spread,
        y: position.y + 0.18 + this.nextRand() * 0.35,
        z: position.z + Math.sin(angle) * spread,
        vx: Math.cos(angle) * (0.75 + this.nextRand() * 0.95),
        vy: 1.35 + this.nextRand() * 1.55,
        vz: Math.sin(angle) * (0.75 + this.nextRand() * 0.95),
        gravity: -0.55,
        maxAge: 0.8 + this.nextRand() * 0.4,
        startScale: 0.9 + safeRadius * 0.22,
        endScale: 2.8 + safeRadius * 0.55,
        colorHex: smokeTint,
        baseOpacity: 0.56,
        rotationSpeed: (this.nextRand() - 0.5) * 1.1,
      });
    }

    // 14-22 tumbling irregular faceted rock shards reusing shared palette materials (zero per-blast material allocation)
    const shardCount = 14 + Math.floor(this.nextRand() * 9);
    for (let i = 0; i < shardCount; i++) {
      const useTetra = i % 3 === 0;
      const shardGeo = useTetra
        ? this.sharedGeos.shardTetra
        : this.sharedGeos.shardDodeca;
      const shardMat =
        this.shardPaletteMaterials[i % this.shardPaletteMaterials.length] ??
        this.shardPaletteMaterials[0];
      if (!shardMat) {
        continue;
      }
      const shardMesh = new THREE.Mesh(shardGeo, shardMat);
      shardMesh.castShadow = true;

      const theta = this.nextRand() * Math.PI * 2;
      const elev = 0.35 + this.nextRand() * 0.95;
      const speed = (3.4 + this.nextRand() * 5.2) * Math.min(1.6, safeRadius * 0.65);

      shardMesh.position.set(
        position.x + Math.cos(theta) * 0.25,
        position.y + 0.12 + this.nextRand() * 0.25,
        position.z + Math.sin(theta) * 0.25,
      );
      shardMesh.rotation.set(
        this.nextRand() * Math.PI,
        this.nextRand() * Math.PI,
        this.nextRand() * Math.PI,
      );

      // Irregular non-uniform aspect ratios for authentic fractured rock silhouettes
      const baseScaleVec = new THREE.Vector3(
        0.55 + this.nextRand() * 0.95,
        0.45 + this.nextRand() * 0.85,
        0.5 + this.nextRand() * 0.9,
      );

      this.particleGroup.add(shardMesh);
      this.particles.push({
        mesh: shardMesh,
        material: shardMat,
        sharedMaterial: true,
        velocity: new THREE.Vector3(
          Math.cos(theta) * Math.cos(elev) * speed * (isPull ? -0.4 : 1),
          Math.sin(elev) * speed + 2.4,
          Math.sin(theta) * Math.cos(elev) * speed * (isPull ? -0.4 : 1),
        ),
        spin: new THREE.Vector3(
          (this.nextRand() - 0.5) * 14,
          (this.nextRand() - 0.5) * 14,
          (this.nextRand() - 0.5) * 14,
        ),
        gravity: 18.0,
        age: 0,
        maxAge: 0.85 + this.nextRand() * 0.5,
        startScale: 1.0,
        endScale: 0.72,
        baseScaleVec,
        baseOpacity: 1.0,
        kind: "shard",
      });
    }

    // Secondary burst of 8 pooled InstancedMesh fine rock chips for extra blast debris density
    for (let i = 0; i < 8; i++) {
      const pool = i % 2 === 0 ? this.tetraShardPool : this.dodecaShardPool;
      const paletteColor =
        ROCK_SHARD_PALETTE[i % ROCK_SHARD_PALETTE.length] ?? 0xb96c43;
      const theta = this.nextRand() * Math.PI * 2;
      const elev = 0.4 + this.nextRand() * 0.95;
      const speed = (4.2 + this.nextRand() * 6.0) * Math.min(1.6, safeRadius * 0.65);

      this.emitInstanceFromPool(pool, {
        x: position.x + Math.cos(theta) * 0.2,
        y: position.y + 0.14 + this.nextRand() * 0.25,
        z: position.z + Math.sin(theta) * 0.2,
        vx: Math.cos(theta) * Math.cos(elev) * speed * (isPull ? -0.4 : 1),
        vy: Math.sin(elev) * speed + 2.8,
        vz: Math.sin(theta) * Math.cos(elev) * speed * (isPull ? -0.4 : 1),
        spinX: (this.nextRand() - 0.5) * 16,
        spinY: (this.nextRand() - 0.5) * 16,
        spinZ: (this.nextRand() - 0.5) * 16,
        gravity: 18.5,
        maxAge: 0.65 + this.nextRand() * 0.45,
        startScale: 0.62,
        endScale: 0.08,
        sx: 0.45 + this.nextRand() * 0.65,
        sy: 0.4 + this.nextRand() * 0.55,
        sz: 0.45 + this.nextRand() * 0.6,
        colorHex: paletteColor,
      });
    }
  }

  /** Spawn a fiery crimson-amber Blast Barrel chain-explosion with double shockwave, fireball glow & pooled ember shower. */
  public spawnBarrelExplosion(position: Vec3, radius = 2.8): void {
    const safeRadius = Number.isFinite(radius) ? Math.max(1.4, radius) : 2.8;
    this.spawnExplosion(position, safeRadius, false);

    // Secondary fiery crimson shockwave ring
    const crimsonRingMat = new THREE.MeshBasicMaterial({
      color: 0xff3d1f,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const crimsonRing = new THREE.Mesh(this.sharedGeos.shockRing, crimsonRingMat);
    crimsonRing.position.set(position.x, position.y + 0.22, position.z);
    crimsonRing.rotation.x = Math.PI * 0.5;
    this.particleGroup.add(crimsonRing);
    this.particles.push({
      mesh: crimsonRing,
      material: crimsonRingMat,
      velocity: new THREE.Vector3(0, 0.55, 0),
      spin: new THREE.Vector3(0, 0, 0),
      gravity: 0,
      age: 0,
      maxAge: 0.56,
      startScale: 0.5,
      endScale: safeRadius * 2.8,
      baseScaleVec: new THREE.Vector3(1, 1, 1),
      baseOpacity: 0.95,
      kind: "shockwave",
    });

    // Fiery barrel core fireball bloom
    this.emitSpriteFromPool(this.glowSpritePool, {
      x: position.x,
      y: position.y + 0.45,
      z: position.z,
      vx: 0,
      vy: 1.4,
      vz: 0,
      gravity: 0,
      maxAge: 0.46,
      startScale: safeRadius * 1.45,
      endScale: safeRadius * 3.8,
      colorHex: 0xff5a1f,
      baseOpacity: 0.85,
      rotationSpeed: 0,
    });

    // Pooled fiery ember octahedron sparks flying in high arcs
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2 + this.nextRand() * 0.4;
      const spd = 4.2 + this.nextRand() * 5.8;
      this.emitInstanceFromPool(this.sparkPool, {
        x: position.x,
        y: position.y + 0.4,
        z: position.z,
        vx: Math.cos(angle) * spd,
        vy: 4.5 + this.nextRand() * 5.5,
        vz: Math.sin(angle) * spd,
        spinX: 8,
        spinY: 10,
        spinZ: 7,
        gravity: 12.5,
        maxAge: 0.65 + this.nextRand() * 0.45,
        startScale: 1.55,
        endScale: 0.12,
        sx: 1,
        sy: 1,
        sz: 1,
        colorHex: i % 2 === 0 ? 0xffc83b : 0xff4b1f,
      });
    }
  }

  /** Spawn a pressurized vertical Thermal Steam Geyser eruption plume & sky-cyan launch ring. */
  public spawnGeyserBurst(position: Vec3): void {
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x7ef9ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(this.sharedGeos.shockRing, ringMat);
    ringMesh.position.set(position.x, position.y + 0.15, position.z);
    ringMesh.rotation.x = Math.PI * 0.5;
    this.particleGroup.add(ringMesh);
    this.particles.push({
      mesh: ringMesh,
      material: ringMat,
      velocity: new THREE.Vector3(0, 4.5, 0),
      spin: new THREE.Vector3(0, 0, 0),
      gravity: 0,
      age: 0,
      maxAge: 0.52,
      startScale: 0.55,
      endScale: 2.6,
      baseScaleVec: new THREE.Vector3(1, 1, 1),
      baseOpacity: 0.9,
      kind: "shockwave",
    });

    // Soft cyan geothermal flash at vent mouth
    this.emitSpriteFromPool(this.glowSpritePool, {
      x: position.x,
      y: position.y + 0.4,
      z: position.z,
      vx: 0,
      vy: 2.2,
      vz: 0,
      gravity: 0,
      maxAge: 0.36,
      startScale: 1.4,
      endScale: 3.1,
      colorHex: 0x6ef7ff,
      baseOpacity: 0.72,
      rotationSpeed: 0,
    });

    // Pooled billowing pressurized steam cloud billboards
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + this.nextRand() * 0.35;
      this.emitSpriteFromPool(this.smokeSpritePool, {
        x: position.x + Math.cos(a) * 0.25,
        y: position.y + 0.25 + i * 0.12,
        z: position.z + Math.sin(a) * 0.25,
        vx: Math.cos(a) * (0.4 + this.nextRand() * 0.9),
        vy: 7.5 + this.nextRand() * 5.5,
        vz: Math.sin(a) * (0.4 + this.nextRand() * 0.9),
        gravity: 2.5,
        maxAge: 0.72 + this.nextRand() * 0.4,
        startScale: 1.05,
        endScale: 3.1,
        colorHex: i % 3 === 0 ? 0xc2fbff : 0xf4ffff,
        baseOpacity: 0.58,
        rotationSpeed: (this.nextRand() - 0.5) * 1.4,
      });
    }

    // Pooled sparkling geothermal spray droplets
    for (let i = 0; i < 10; i++) {
      const a = this.nextRand() * Math.PI * 2;
      this.emitInstanceFromPool(this.dropletPool, {
        x: position.x,
        y: position.y + 0.3,
        z: position.z,
        vx: Math.cos(a) * (1.2 + this.nextRand() * 1.8),
        vy: 9.5 + this.nextRand() * 5.0,
        vz: Math.sin(a) * (1.2 + this.nextRand() * 1.8),
        spinX: 0,
        spinY: 0,
        spinZ: 0,
        gravity: 15.0,
        maxAge: 0.75 + this.nextRand() * 0.35,
        startScale: 1.0,
        endScale: 0.2,
        sx: 1,
        sy: 1.4,
        sz: 1,
        colorHex: 0x76f7ff,
      });
    }
  }

  /** Spawn a turquoise ocean splash spray and surface foam ripple. */
  public spawnSplash(position: Vec3): void {
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xe6ffff,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(this.sharedGeos.shockRing, ringMat);
    ringMesh.position.set(position.x, position.y + 0.05, position.z);
    ringMesh.rotation.x = Math.PI * 0.5;
    this.particleGroup.add(ringMesh);
    this.particles.push({
      mesh: ringMesh,
      material: ringMat,
      velocity: new THREE.Vector3(0, 0.02, 0),
      spin: new THREE.Vector3(0, 0, 0),
      gravity: 0,
      age: 0,
      maxAge: 0.72,
      startScale: 0.4,
      endScale: 3.1,
      baseScaleVec: new THREE.Vector3(1, 1, 1),
      baseOpacity: 0.88,
      kind: "shockwave",
    });

    // Soft sea-spray mist burst
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + this.nextRand() * 0.5;
      this.emitSpriteFromPool(this.smokeSpritePool, {
        x: position.x + Math.cos(a) * 0.35,
        y: position.y + 0.35,
        z: position.z + Math.sin(a) * 0.35,
        vx: Math.cos(a) * 1.1,
        vy: 2.4 + this.nextRand() * 1.4,
        vz: Math.sin(a) * 1.1,
        gravity: 3.5,
        maxAge: 0.58,
        startScale: 0.9,
        endScale: 2.35,
        colorHex: 0xdffeff,
        baseOpacity: 0.5,
        rotationSpeed: (this.nextRand() - 0.5) * 0.8,
      });
    }

    const dropletCount = 14;
    for (let i = 0; i < dropletCount; i++) {
      const angle = (i / dropletCount) * Math.PI * 2 + this.nextRand() * 0.35;
      const radialSpeed = 1.6 + this.nextRand() * 2.6;
      this.emitInstanceFromPool(this.dropletPool, {
        x: position.x,
        y: position.y + 0.08,
        z: position.z,
        vx: Math.cos(angle) * radialSpeed,
        vy: 4.2 + this.nextRand() * 3.4,
        vz: Math.sin(angle) * radialSpeed,
        spinX: 0,
        spinY: 0,
        spinZ: 0,
        gravity: 16.5,
        maxAge: 0.65 + this.nextRand() * 0.35,
        startScale: 1.0,
        endScale: 0.2,
        sx: 1,
        sy: 1.3,
        sz: 1,
        colorHex: i % 2 === 0 ? 0x62f2ff : 0xe4ffff,
      });
    }
  }

  /** Spawn a glowing 3D emerald-cyan vine/rope tether beam between grapple origin and anchor. */
  public spawnGrappleBeam(from: Vec3, to: Vec3): void {
    const start = new THREE.Vector3(from.x, from.y + 0.55, from.z);
    const end = new THREE.Vector3(to.x, to.y + 0.45, to.z);
    const delta = end.clone().sub(start);
    const dist = delta.length();
    if (!Number.isFinite(dist) || dist < 0.1) {
      return;
    }

    const dir = delta.clone().divideScalar(dist);
    const mid = start.clone().addScaledVector(delta, 0.5);
    const upY = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(upY, dir);

    // Outer luminous emerald vine rope cylinder
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const outerMesh = new THREE.Mesh(this.sharedGeos.grappleBeam, outerMat);
    outerMesh.position.copy(mid);
    outerMesh.quaternion.copy(quat);
    outerMesh.scale.set(1.25, dist, 1.25);
    this.particleGroup.add(outerMesh);
    this.particles.push({
      mesh: outerMesh,
      material: outerMat,
      velocity: new THREE.Vector3(0, 0, 0),
      spin: new THREE.Vector3(0, 0, 0),
      gravity: 0,
      age: 0,
      maxAge: 0.68,
      startScale: 1.25,
      endScale: 0.2,
      baseScaleVec: new THREE.Vector3(1, dist, 1),
      baseOpacity: 0.9,
      kind: "beam",
    });

    // Bright inner cyan-white energy core
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xd1fae5,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const coreMesh = new THREE.Mesh(this.sharedGeos.grappleBeam, coreMat);
    coreMesh.position.copy(mid);
    coreMesh.quaternion.copy(quat);
    coreMesh.scale.set(0.45, dist, 0.45);
    this.particleGroup.add(coreMesh);
    this.particles.push({
      mesh: coreMesh,
      material: coreMat,
      velocity: new THREE.Vector3(0, 0, 0),
      spin: new THREE.Vector3(0, 0, 0),
      gravity: 0,
      age: 0,
      maxAge: 0.54,
      startScale: 0.45,
      endScale: 0.08,
      baseScaleVec: new THREE.Vector3(1, dist, 1),
      baseOpacity: 0.95,
      kind: "beam",
    });

    // Glowing anchor burst rings & soft additive flash at origin & destination
    for (const pt of [start, end]) {
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x6ee7b7,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ringMesh = new THREE.Mesh(this.sharedGeos.shockRing, ringMat);
      ringMesh.position.copy(pt);
      ringMesh.rotation.x = Math.PI * 0.5;
      this.particleGroup.add(ringMesh);
      this.particles.push({
        mesh: ringMesh,
        material: ringMat,
        velocity: new THREE.Vector3(0, 0.2, 0),
        spin: new THREE.Vector3(0, 0, 0),
        gravity: 0,
        age: 0,
        maxAge: 0.45,
        startScale: 0.35,
        endScale: 1.45,
        baseScaleVec: new THREE.Vector3(1, 1, 1),
        baseOpacity: 0.92,
        kind: "shockwave",
      });

      this.emitSpriteFromPool(this.glowSpritePool, {
        x: pt.x,
        y: pt.y,
        z: pt.z,
        vx: 0,
        vy: 0.25,
        vz: 0,
        gravity: 0,
        maxAge: 0.32,
        startScale: 0.9,
        endScale: 1.85,
        colorHex: 0x6ee7b7,
        baseOpacity: 0.78,
        rotationSpeed: 0,
      });
    }

    // Pooled trailing emerald rope sparks spaced cleanly along the tether line
    const sparkCount = Math.min(10, Math.max(4, Math.floor(dist / 2.2)));
    for (let i = 0; i < sparkCount; i++) {
      const frac = (i + 0.5) / sparkCount;
      const pt = start.clone().addScaledVector(delta, frac);
      this.emitInstanceFromPool(this.sparkPool, {
        x: pt.x,
        y: pt.y,
        z: pt.z,
        vx: (this.nextRand() - 0.5) * 1.4,
        vy: 0.6 + this.nextRand() * 1.2,
        vz: (this.nextRand() - 0.5) * 1.4,
        spinX: 6,
        spinY: 7,
        spinZ: 5,
        gravity: 3.2,
        maxAge: 0.45 + this.nextRand() * 0.25,
        startScale: 1.15,
        endScale: 0.1,
        sx: 1,
        sy: 1,
        sz: 1,
        colorHex: i % 2 === 0 ? 0x34d399 : 0x5eead4,
      });
    }
  }

  /**
   * Maintain a live taut glowing 3D vine tether with a sculpted 3-prong grappling hook claw head
   * anchored at `to` and oriented along `from -> to`. Pass `from = null` to release & dispose.
   */
  public setGrappleTether(
    id: string,
    from: Vec3 | null,
    to?: Vec3,
  ): void {
    const name = `grapple_tether_${id}`;
    const existing = this.group.getObjectByName(name);

    if (!from || !to) {
      if (existing) {
        this.group.remove(existing);
        disposeObjectMaterialsOnly(existing);
      }
      return;
    }

    const start = this.tempOrigin.set(from.x, from.y + 0.55, from.z);
    const end = this.tempTarget.set(to.x, to.y + 0.45, to.z);
    const delta = this.tempVec.subVectors(end, start);
    const dist = delta.length();
    if (!Number.isFinite(dist) || dist < 0.08) {
      this.setGrappleTether(id, null);
      return;
    }

    let tetherGroup: THREE.Group;
    if (existing instanceof THREE.Group) {
      tetherGroup = existing;
    } else {
      tetherGroup = new THREE.Group();
      tetherGroup.name = name;
      tetherGroup.userData.isGrappleTether = true;
      const outerMesh = new THREE.Mesh(
        this.sharedGeos.grappleBeam,
        new THREE.MeshBasicMaterial({
          color: 0x34d399,
          transparent: true,
          opacity: 0.92,
          depthWrite: false,
        }),
      );
      outerMesh.name = "tether_outer";
      const coreMesh = new THREE.Mesh(
        this.sharedGeos.grappleBeam,
        new THREE.MeshBasicMaterial({
          color: 0xd1fae5,
          transparent: true,
          opacity: 0.96,
          depthWrite: false,
        }),
      );
      coreMesh.name = "tether_core";

      // Sculpted 3-prong metallic grappling hook claw head anchored right at `to`
      const hookHead = new THREE.Group();
      hookHead.name = "grapple_hook_head";
      const ironMat = new THREE.MeshStandardMaterial({
        color: 0x475569,
        roughness: 0.3,
        metalness: 0.78,
      });
      const brassMat = new THREE.MeshStandardMaterial({
        color: 0xd97706,
        roughness: 0.32,
        metalness: 0.72,
        emissive: 0x451a03,
        emissiveIntensity: 0.18,
      });

      const collar = new THREE.Mesh(this.sharedGeos.hookCollar, brassMat);
      collar.name = "grapple_hook_collar";
      collar.position.set(0, -0.02, 0);
      hookHead.add(collar);

      const shankRing = new THREE.Mesh(this.sharedGeos.hookShankRing, ironMat);
      shankRing.name = "grapple_hook_ring";
      shankRing.position.set(0, -0.15, 0);
      hookHead.add(shankRing);

      for (let i = 0; i < 3; i++) {
        const prongGroup = new THREE.Group();
        prongGroup.name = `grapple_hook_prong_${i}`;
        prongGroup.rotation.y = (i * Math.PI * 2) / 3;

        const arm = new THREE.Mesh(this.sharedGeos.hookProngCurve, ironMat);
        const tip = new THREE.Mesh(this.sharedGeos.hookProngTip, ironMat);
        tip.position.set(0, -0.18, 0.19);
        tip.rotation.x = Math.PI * 0.82;
        prongGroup.add(arm, tip);
        hookHead.add(prongGroup);
      }

      tetherGroup.add(outerMesh, coreMesh, hookHead);
      this.group.add(tetherGroup);
    }

    const dir = this.tempDir.copy(delta).divideScalar(dist);
    tetherGroup.position.copy(start).addScaledVector(delta, 0.5);
    tetherGroup.quaternion.setFromUnitVectors(UP_Y, dir);

    const outer = tetherGroup.getObjectByName("tether_outer");
    if (outer) {
      outer.scale.set(1.15, dist, 1.15);
    }
    const core = tetherGroup.getObjectByName("tether_core");
    if (core) {
      core.scale.set(0.42, dist, 0.42);
    }
    const hookHead = tetherGroup.getObjectByName("grapple_hook_head");
    if (hookHead) {
      hookHead.position.set(0, dist * 0.5, 0);
    }
  }

  /** Emit a crisp emerald/gold metallic latch spark burst + small shock ring when a grappling hook locks onto rock or an Evo Pod. */
  public spawnGrappleLatchSpark(position: Vec3): void {
    const px = Number.isFinite(position.x) ? position.x : 0;
    const py = Number.isFinite(position.y) ? position.y : 0;
    const pz = Number.isFinite(position.z) ? position.z : 0;

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x6ee7b7,
      transparent: true,
      opacity: 0.94,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(this.sharedGeos.shockRing, ringMat);
    ringMesh.position.set(px, py + 0.35, pz);
    ringMesh.rotation.x = Math.PI * 0.5;
    this.particleGroup.add(ringMesh);
    this.particles.push({
      mesh: ringMesh,
      material: ringMat,
      velocity: new THREE.Vector3(0, 0.15, 0),
      spin: new THREE.Vector3(0, 0, 0),
      gravity: 0,
      age: 0,
      maxAge: 0.34,
      startScale: 0.25,
      endScale: 1.38,
      baseScaleVec: new THREE.Vector3(1, 1, 1),
      baseOpacity: 0.94,
      kind: "shockwave",
    });

    this.emitSpriteFromPool(this.glowSpritePool, {
      x: px,
      y: py + 0.35,
      z: pz,
      vx: 0,
      vy: 0.2,
      vz: 0,
      gravity: 0,
      maxAge: 0.22,
      startScale: 0.65,
      endScale: 1.45,
      colorHex: 0xfde047,
      baseOpacity: 0.9,
      rotationSpeed: 0,
    });

    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + this.nextRand() * 0.35;
      const spd = 2.8 + this.nextRand() * 4.2;
      this.emitInstanceFromPool(this.sparkPool, {
        x: px,
        y: py + 0.35,
        z: pz,
        vx: Math.cos(a) * spd,
        vy: 2.0 + this.nextRand() * 3.4,
        vz: Math.sin(a) * spd,
        spinX: 9,
        spinY: 11,
        spinZ: 8,
        gravity: 11.5,
        maxAge: 0.28 + this.nextRand() * 0.2,
        startScale: 1.15,
        endScale: 0.1,
        sx: 1,
        sy: 1,
        sz: 1,
        colorHex: i % 3 === 0 ? 0xfde047 : i % 2 === 0 ? 0x34d399 : 0x6ee7b7,
      });
    }
  }

  /** Spray jagged rock shards, hot orange drill sparks, and warm dust plumes backward out of a Burrow Bore tunnel. */
  public spawnBoreDebris(position: Vec3, direction: Vec3): void {
    const px = Number.isFinite(position.x) ? position.x : 0;
    const py = Number.isFinite(position.y) ? position.y : 0;
    const pz = Number.isFinite(position.z) ? position.z : 0;

    const dir = this.resolveUnitDirection(direction, this.tempDir);
    buildOrthonormalBasis(dir, this.tempRight, this.tempUp);

    // Pooled jagged rock chips ejected backward (-dir + radial spray)
    for (let i = 0; i < 7; i++) {
      const pool = i % 2 === 0 ? this.dodecaShardPool : this.tetraShardPool;
      const colorHex =
        ROCK_SHARD_PALETTE[i % ROCK_SHARD_PALETTE.length] ?? 0x9a5938;
      const angle = (i / 7) * Math.PI * 2 + this.nextRand() * 0.5;
      const radial = 0.28 + this.nextRand() * 0.58;
      const speed = 3.8 + this.nextRand() * 4.6;
      const cosA = Math.cos(angle) * radial;
      const sinA = Math.sin(angle) * radial;
      const vx = (-dir.x + this.tempRight.x * cosA + this.tempUp.x * sinA) * speed;
      const vy =
        (-dir.y + this.tempRight.y * cosA + this.tempUp.y * sinA) * speed + 1.6;
      const vz = (-dir.z + this.tempRight.z * cosA + this.tempUp.z * sinA) * speed;

      this.emitInstanceFromPool(pool, {
        x: px - dir.x * 0.25,
        y: py - dir.y * 0.25,
        z: pz - dir.z * 0.25,
        vx,
        vy,
        vz,
        spinX: (this.nextRand() - 0.5) * 18,
        spinY: (this.nextRand() - 0.5) * 18,
        spinZ: (this.nextRand() - 0.5) * 18,
        gravity: 17.5,
        maxAge: 0.52 + this.nextRand() * 0.34,
        startScale: 0.72,
        endScale: 0.1,
        sx: 0.55 + this.nextRand() * 0.65,
        sy: 0.45 + this.nextRand() * 0.55,
        sz: 0.5 + this.nextRand() * 0.6,
        colorHex,
      });
    }

    // Bright hot orange/gold auger friction sparks spraying backward
    for (let i = 0; i < 9; i++) {
      const angle = this.nextRand() * Math.PI * 2;
      const radial = 0.35 + this.nextRand() * 0.72;
      const speed = 5.2 + this.nextRand() * 5.8;
      const cosA = Math.cos(angle) * radial;
      const sinA = Math.sin(angle) * radial;
      const vx = (-dir.x + this.tempRight.x * cosA + this.tempUp.x * sinA) * speed;
      const vy =
        (-dir.y + this.tempRight.y * cosA + this.tempUp.y * sinA) * speed + 1.1;
      const vz = (-dir.z + this.tempRight.z * cosA + this.tempUp.z * sinA) * speed;

      this.emitInstanceFromPool(this.sparkPool, {
        x: px - dir.x * 0.2,
        y: py - dir.y * 0.2,
        z: pz - dir.z * 0.2,
        vx,
        vy,
        vz,
        spinX: 12,
        spinY: 14,
        spinZ: 10,
        gravity: 12.0,
        maxAge: 0.26 + this.nextRand() * 0.22,
        startScale: 1.15,
        endScale: 0.1,
        sx: 1,
        sy: 1,
        sz: 1,
        colorHex: i % 3 === 0 ? 0xfde047 : 0xff7b1a,
      });
    }

    // Warm earthen rock-dust plumes billowing out of the bore hole
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + this.nextRand() * 0.6;
      const radial = 0.35 + this.nextRand() * 0.35;
      const speed = 1.6 + this.nextRand() * 1.4;
      const cosA = Math.cos(angle) * radial;
      const sinA = Math.sin(angle) * radial;

      this.emitSpriteFromPool(this.smokeSpritePool, {
        x: px - dir.x * 0.35,
        y: py - dir.y * 0.35,
        z: pz - dir.z * 0.35,
        vx: (-dir.x + this.tempRight.x * cosA + this.tempUp.x * sinA) * speed,
        vy:
          (-dir.y + this.tempRight.y * cosA + this.tempUp.y * sinA) * speed + 0.9,
        vz: (-dir.z + this.tempRight.z * cosA + this.tempUp.z * sinA) * speed,
        gravity: -0.35,
        maxAge: 0.55 + this.nextRand() * 0.3,
        startScale: 0.55,
        endScale: 1.85,
        colorHex: i % 2 === 0 ? 0xc7a37e : 0x9e8268,
        baseOpacity: 0.5,
        rotationSpeed: (this.nextRand() - 0.5) * 1.4,
      });
    }
  }

  /**
   * Spawn a directional Gale Scatter wind-shotgun blast along `direction`:
   * 4 staggered expanding white-cyan/rose wind-gust torus rings calibrated to GALE_SCATTER_CONE_MIN_DOT,
   * 16 high-speed diverging air-streak sparks, and 6 swirling mist/dust puffs.
   */
  public spawnWindShotgunBlast(
    origin: Vec3,
    direction: Vec3,
    reach = GALE_SCATTER_REACH,
  ): void {
    const ox = Number.isFinite(origin.x) ? origin.x : 0;
    const oy = Number.isFinite(origin.y) ? origin.y : 0;
    const oz = Number.isFinite(origin.z) ? origin.z : 0;
    const safeReach =
      Number.isFinite(reach) && reach > 0.5 ? reach : GALE_SCATTER_REACH;

    const dir = this.resolveUnitDirection(direction, this.tempDir);
    buildOrthonormalBasis(dir, this.tempRight, this.tempUp);

    const ringQuat = this.tempQuat.setFromUnitVectors(FORWARD_Z, dir);
    const ringColors: readonly number[] = [0xe0faff, 0x7ef9ff, 0xfda4af, 0xf8fafc];

    // 4 staggered expanding wind-gust torus rings rushing forward across the scatter cone
    for (let i = 0; i < 4; i++) {
      const frac = i / 3;
      const maxAge = 0.22 + frac * 0.2;
      const travelDist = safeReach * (0.5 + frac * 0.5);
      const speed = travelDist / maxAge;
      const coneEndRadius = travelDist * GALE_SCATTER_CONE_TAN;
      const ringMat = new THREE.MeshBasicMaterial({
        color: ringColors[i] ?? 0xe0faff,
        transparent: true,
        opacity: 0.8 - frac * 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ringMesh = new THREE.Mesh(this.sharedGeos.shockRing, ringMat);
      ringMesh.position.set(
        ox + dir.x * (0.35 + frac * 0.4),
        oy + dir.y * (0.35 + frac * 0.4),
        oz + dir.z * (0.35 + frac * 0.4),
      );
      ringMesh.quaternion.copy(ringQuat);
      this.particleGroup.add(ringMesh);
      this.particles.push({
        mesh: ringMesh,
        material: ringMat,
        velocity: new THREE.Vector3(dir.x * speed, dir.y * speed, dir.z * speed),
        spin: new THREE.Vector3(0, 0, 0),
        gravity: 0,
        age: 0,
        maxAge,
        startScale: 0.38 + frac * 0.16,
        endScale: Math.max(1.25, coneEndRadius * 2.0),
        baseScaleVec: new THREE.Vector3(1, 1, 1),
        baseOpacity: 0.8 - frac * 0.12,
        kind: "shockwave",
      });
    }

    // Bright directional wind-muzzle flash sprite at blast mouth
    this.emitSpriteFromPool(this.glowSpritePool, {
      x: ox + dir.x * 0.45,
      y: oy + dir.y * 0.45,
      z: oz + dir.z * 0.45,
      vx: dir.x * 2.2,
      vy: dir.y * 2.2,
      vz: dir.z * 2.2,
      gravity: 0,
      maxAge: 0.2,
      startScale: 0.85,
      endScale: 2.1,
      colorHex: 0xbef8ff,
      baseOpacity: 0.78,
      rotationSpeed: 0,
    });

    // 16 high-speed diverging air-streak sparks fanning across the forward cone
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2 + this.nextRand() * 0.32;
      const radialMag = (0.18 + this.nextRand() * 0.82) * GALE_SCATTER_CONE_TAN;
      const cosA = Math.cos(angle) * radialMag;
      const sinA = Math.sin(angle) * radialMag;
      const rawX = dir.x + this.tempRight.x * cosA + this.tempUp.x * sinA;
      const rawY = dir.y + this.tempRight.y * cosA + this.tempUp.y * sinA;
      const rawZ = dir.z + this.tempRight.z * cosA + this.tempUp.z * sinA;
      const norm = Math.hypot(rawX, rawY, rawZ) || 1;
      const speed = 13.5 + this.nextRand() * 11.5;

      this.emitInstanceFromPool(this.sparkPool, {
        x: ox + dir.x * 0.35,
        y: oy + dir.y * 0.35,
        z: oz + dir.z * 0.35,
        vx: (rawX / norm) * speed,
        vy: (rawY / norm) * speed,
        vz: (rawZ / norm) * speed,
        spinX: 6,
        spinY: 8,
        spinZ: 7,
        gravity: 0.6,
        maxAge: 0.2 + this.nextRand() * 0.18,
        startScale: 1.2,
        endScale: 0.14,
        sx: 0.75,
        sy: 0.75,
        sz: 1.9,
        colorHex:
          i % 4 === 0 ? 0xfda4af : i % 2 === 0 ? 0xffffff : 0x7ef9ff,
      });
    }

    // 6 swirling wind mist/dust puffs fanning across the forward cone
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + this.nextRand() * 0.5;
      const radialMag = (0.25 + this.nextRand() * 0.65) * GALE_SCATTER_CONE_TAN;
      const cosA = Math.cos(angle) * radialMag;
      const sinA = Math.sin(angle) * radialMag;
      const speed = 6.5 + this.nextRand() * 5.2;

      this.emitSpriteFromPool(this.smokeSpritePool, {
        x: ox + dir.x * 0.55,
        y: oy + dir.y * 0.55,
        z: oz + dir.z * 0.55,
        vx: (dir.x + this.tempRight.x * cosA + this.tempUp.x * sinA) * speed,
        vy:
          (dir.y + this.tempRight.y * cosA + this.tempUp.y * sinA) * speed + 0.45,
        vz: (dir.z + this.tempRight.z * cosA + this.tempUp.z * sinA) * speed,
        gravity: -0.4,
        maxAge: 0.36 + this.nextRand() * 0.2,
        startScale: 0.65,
        endScale: 2.25,
        colorHex: i % 3 === 0 ? 0xffe4e6 : 0xe8fcff,
        baseOpacity: 0.44,
        rotationSpeed: (this.nextRand() - 0.5) * 2.2,
      });
    }
  }

  /** Synchronize color-coded Evo DNA, Med-Berry, and Super Gadget air-drop crates & parachutes. */
  public syncEvoPods(
    pods: readonly EvoPodState[],
    elapsedSec: number,
  ): void {
    const activeIds = new Set<string>();
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;

    for (const pod of pods) {
      if (pod.collected) {
        continue;
      }
      activeIds.add(pod.id);
      const kind = pod.kind ?? "evo_dna";

      let visual = this.evoPods.get(pod.id);
      if (!visual || visual.group.userData.podKind !== kind) {
        if (visual) {
          this.evoPodGroup.remove(visual.group);
          disposeObjectTree(visual.group);
        }
        visual = this.createEvoPodVisual(pod.id, kind);
        this.evoPods.set(pod.id, visual);
        this.evoPodGroup.add(visual.group);
      }

      const bob = pod.parachuting ? 0 : Math.sin(t * 3.4) * 0.12;
      visual.group.position.set(
        pod.position.x,
        pod.position.y + 0.34 + bob,
        pod.position.z,
      );
      visual.podCore.rotation.y = t * 1.8;
      visual.parachuteGroup.visible = pod.parachuting;
      if (pod.parachuting) {
        visual.parachuteGroup.rotation.z = Math.sin(t * 2.6) * 0.14;
      }
      visual.beaconMesh.visible = !pod.parachuting;
      if (!pod.parachuting && visual.beaconMesh.material instanceof THREE.MeshBasicMaterial) {
        visual.beaconMesh.material.opacity = 0.22 + Math.sin(t * 4.0) * 0.1;
      }
      if (visual.groundPoolMesh) {
        visual.groundPoolMesh.visible = !pod.parachuting;
        if (!pod.parachuting) {
          // Keep luminous ground light pool anchored flat at terrain height (pod.position.y + 0.06)
          visual.groundPoolMesh.position.y = -0.28 - bob;
          const poolPulse = 0.5 + 0.5 * Math.sin(t * 3.6);
          const poolScale = 0.92 + poolPulse * 0.16;
          visual.groundPoolMesh.scale.set(poolScale, poolScale, 1);
          if (visual.groundPoolMesh.material instanceof THREE.MeshBasicMaterial) {
            visual.groundPoolMesh.material.opacity = 0.28 + poolPulse * 0.2;
          }
        }
      }
    }

    for (const [id, visual] of this.evoPods.entries()) {
      if (!activeIds.has(id)) {
        this.evoPodGroup.remove(visual.group);
        disposeObjectTree(visual.group);
        this.evoPods.delete(id);
      }
    }
  }

  /**
   * Synchronize glowing 3D crystal Prism Wall barriers (beveled extruded crystal slab +
   * glowing cyan rim frame, NEVER BoxGeometry) and cleanly dispose expired/shattered walls.
   */
  public syncPrismWalls(
    walls: readonly PrismWallState[],
    elapsedSec: number,
  ): void {
    const activeIds = new Set<string>();
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;

    for (const wall of walls) {
      if (!wall.active || wall.turnsLeft <= 0) {
        continue;
      }
      activeIds.add(wall.id);

      let visual = this.prismWallVisuals.get(wall.id);
      if (
        !visual ||
        visual.group.userData.wallWidth !== wall.width ||
        visual.group.userData.wallHeight !== wall.height
      ) {
        if (visual) {
          this.prismWallGroup.remove(visual.group);
          disposeObjectTree(visual.group);
        }
        visual = this.createPrismWallVisual(wall);
        this.prismWallVisuals.set(wall.id, visual);
        this.prismWallGroup.add(visual.group);
      }

      visual.group.position.set(
        wall.position.x,
        wall.position.y + wall.height * 0.5,
        wall.position.z,
      );
      visual.group.rotation.y = Math.atan2(wall.normal.x, wall.normal.z);

      const shimmer = Math.sin(t * 4.2 + wall.position.x * 0.3);
      visual.mat.emissiveIntensity = 0.7 + shimmer * 0.22;
      visual.rimMat.opacity = 0.78 + shimmer * 0.16;
    }

    for (const [id, visual] of this.prismWallVisuals.entries()) {
      if (!activeIds.has(id)) {
        this.prismWallGroup.remove(visual.group);
        disposeObjectTree(visual.group);
        this.prismWallVisuals.delete(id);
      }
    }
  }

  /** Burst 16 shimmering cyan crystal shards and an expanding cyan shockwave ring when a Prism Wall shatters. */
  public spawnPrismShatter(position: Vec3): void {
    // Expanding cyan shockwave ring
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(this.sharedGeos.shockRing, ringMat);
    ringMesh.position.set(position.x, position.y + 0.4, position.z);
    ringMesh.rotation.x = Math.PI * 0.5;
    this.particleGroup.add(ringMesh);
    this.particles.push({
      mesh: ringMesh,
      material: ringMat,
      velocity: new THREE.Vector3(0, 0.25, 0),
      spin: new THREE.Vector3(0, 0, 0),
      gravity: 0,
      age: 0,
      maxAge: 0.52,
      startScale: 0.45,
      endScale: 3.4,
      baseScaleVec: new THREE.Vector3(1, 1, 1),
      baseOpacity: 0.94,
      kind: "shockwave",
    });

    // 16 shimmering cyan tetrahedral crystal shards reusing shared prismShardMaterial
    for (let i = 0; i < 16; i++) {
      const shardMesh = new THREE.Mesh(
        this.sharedGeos.shardTetra,
        this.prismShardMaterial,
      );
      const theta = (i / 16) * Math.PI * 2 + this.nextRand() * 0.35;
      const elev = 0.15 + this.nextRand() * 0.95;
      const speed = 3.8 + this.nextRand() * 4.8;

      shardMesh.position.set(
        position.x + Math.cos(theta) * 0.45,
        position.y + 0.5 + this.nextRand() * 1.1,
        position.z + Math.sin(theta) * 0.45,
      );
      shardMesh.rotation.set(
        this.nextRand() * Math.PI,
        this.nextRand() * Math.PI,
        this.nextRand() * Math.PI,
      );

      const baseScaleVec = new THREE.Vector3(
        0.55 + this.nextRand() * 0.85,
        0.85 + this.nextRand() * 0.95,
        0.45 + this.nextRand() * 0.7,
      );

      this.particleGroup.add(shardMesh);
      this.particles.push({
        mesh: shardMesh,
        material: this.prismShardMaterial,
        sharedMaterial: true,
        velocity: new THREE.Vector3(
          Math.cos(theta) * Math.cos(elev) * speed,
          Math.sin(elev) * speed + 2.2,
          Math.sin(theta) * Math.cos(elev) * speed,
        ),
        spin: new THREE.Vector3(
          (this.nextRand() - 0.5) * 16,
          (this.nextRand() - 0.5) * 16,
          (this.nextRand() - 0.5) * 16,
        ),
        gravity: 16.0,
        age: 0,
        maxAge: 0.78 + this.nextRand() * 0.42,
        startScale: 1.1,
        endScale: 0.75,
        baseScaleVec,
        baseOpacity: 0.85,
        kind: "shard",
      });
    }
  }

  /** Resize atmospheric wind-ribbon and sunlit pollen bounds for Duel (60m) vs Grand (144m) worlds. */
  public setWorldBounds(
    worldWidth: number,
    worldHeight: number,
    worldDepth: number,
  ): void {
    const safeW = Number.isFinite(worldWidth) && worldWidth > 10 ? worldWidth : WORLD_SPAN_X;
    const safeH = Number.isFinite(worldHeight) && worldHeight > 10 ? worldHeight : WORLD_SPAN_Y;
    const safeD = Number.isFinite(worldDepth) && worldDepth > 10 ? worldDepth : WORLD_SPAN_Z;

    this.worldSpanX = safeW;
    this.worldSpanY = safeH;
    this.worldSpanZ = safeD;

    for (const ribbon of this.windRibbons) {
      ribbon.mesh.position.set(
        2 + this.nextRand() * (safeW - 4),
        Math.max(5.5, safeH * 0.26) + this.nextRand() * (safeH * 0.56),
        2 + this.nextRand() * (safeD - 4),
      );
    }

    const pollenPos = this.pollenPoints.geometry.getAttribute("position");
    if (pollenPos instanceof THREE.BufferAttribute) {
      for (let i = 0; i < POLLEN_MOTE_COUNT; i++) {
        pollenPos.setXYZ(
          i,
          4 + this.nextRand() * (safeW - 8),
          3.2 + this.nextRand() * (safeH * 0.65),
          4 + this.nextRand() * (safeD - 8),
        );
      }
      pollenPos.needsUpdate = true;
    }
  }

  /** Animate sunlit white wind ribbons streaming in the exact 3D wind direction and speed. */
  public updateWindRibbons(wind: Vec3, dtSec: number): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    this.lastWind = { x: wind.x, y: wind.y, z: wind.z };
    const speed = Math.hypot(wind.x, wind.y, wind.z);
    const hasWind = Number.isFinite(speed) && speed > 0.08;

    const dir = hasWind
      ? this.tempVec.set(wind.x / speed, wind.y / speed, wind.z / speed)
      : this.tempVec.set(1, 0, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(FORWARD_Z, dir);
    const driftSpeed = hasWind ? Math.max(2.0, speed * 1.45) : 0.45;
    const targetOpacity = hasWind ? Math.min(0.46, 0.13 + speed * 0.045) : 0.06;

    for (const ribbon of this.windRibbons) {
      ribbon.mesh.quaternion.copy(quat);
      ribbon.mesh.position.addScaledVector(
        dir,
        driftSpeed * ribbon.speedFactor * safeDt,
      );
      ribbon.mesh.position.x = wrapCoord(ribbon.mesh.position.x, -3, this.worldSpanX + 3);
      ribbon.mesh.position.y = wrapCoord(
        ribbon.mesh.position.y,
        Math.max(4.5, this.worldSpanY * 0.24),
        this.worldSpanY * 0.88,
      );
      ribbon.mesh.position.z = wrapCoord(ribbon.mesh.position.z, -3, this.worldSpanZ + 3);
      ribbon.material.opacity = targetOpacity;
      const stretch = hasWind ? Math.min(2.1, 0.8 + speed * 0.16) : 0.6;
      ribbon.mesh.scale.set(1, 1, stretch);
    }
  }

  /**
   * Position the active 3D projectile visual (Gale Mortar black bomb, Seeker Firefly GPS missile + lock beam,
   * Burrow Bore spinning auger drill, or glowing comet orb) and emit gadget-specific trails.
   */
  public setProjectileVisual(
    position: Vec3 | null,
    gadgetColor?: number,
    options?: ProjectileVisualOptions,
  ): void {
    if (!position) {
      this.projectileGroup.visible = false;
      this.bombGroup.visible = false;
      this.missileGroup.visible = false;
      this.drillGroup.visible = false;
      this.gpsLockBeam.visible = false;
      this.lastProjectilePos = null;
      this.trailEmitCounter = 0;
      this.drillIsBoring = false;
      this.bombRotatedThisTick = false;
      this.drillSpunThisTick = false;
      return;
    }

    const px = Number.isFinite(position.x) ? position.x : 0;
    const py = Number.isFinite(position.y) ? position.y : 0;
    const pz = Number.isFinite(position.z) ? position.z : 0;
    const safeDt =
      options?.dtSec !== undefined && Number.isFinite(options.dtSec)
        ? Math.max(0, Math.min(options.dtSec, 0.1))
        : 0;
    const gadgetId = options?.gadgetId;

    // Infer fallback travel direction from previous position if caller omitted direction
    let fallbackDir: THREE.Vector3 | undefined;
    if (this.lastProjectilePos) {
      this.tempVec.set(
        px - this.lastProjectilePos.x,
        py - this.lastProjectilePos.y,
        pz - this.lastProjectilePos.z,
      );
      if (this.tempVec.lengthSq() > 1e-5) {
        fallbackDir = this.tempVec.normalize();
      }
    }

    const movedEnough =
      !this.lastProjectilePos ||
      this.lastProjectilePos.distanceToSquared(
        this.tempOrigin.set(px, py, pz),
      ) > 0.04;

    this.projectileGroup.visible = false;
    this.bombGroup.visible = false;
    this.missileGroup.visible = false;
    this.drillGroup.visible = false;
    this.gpsLockBeam.visible = false;

    if (gadgetId === "gale_mortar") {
      this.bombGroup.visible = true;
      this.bombGroup.position.set(px, py, pz);
      if (safeDt > 0) {
        this.bombGroup.rotation.x += safeDt * 6.5;
        this.bombGroup.rotation.z += safeDt * 4.2;
        this.flamePhase += safeDt * 24.0;
        this.bombRotatedThisTick = true;
      }
      const flicker = 0.56 + Math.sin(this.flamePhase) * 0.14;
      this.bombFlameSprite.scale.set(flicker, flicker * 1.12, 1);
      this.bombFlameCoreSprite.scale.set(flicker * 0.52, flicker * 0.58, 1);

      if (movedEnough) {
        this.spawnBombTrail(px, py, pz);
        this.lastProjectilePos = new THREE.Vector3(px, py, pz);
      }
      return;
    }

    if (gadgetId === "seeker_firefly") {
      const dir = this.resolveUnitDirection(
        options?.direction,
        this.tempDir,
        fallbackDir ?? this.lastProjectileDir,
      );
      this.lastProjectileDir.copy(dir);
      this.missileGroup.visible = true;
      this.missileGroup.position.set(px, py, pz);
      this.missileGroup.quaternion.setFromUnitVectors(UP_Y, dir);

      const target = options?.targetPos;
      if (
        target &&
        Number.isFinite(target.x) &&
        Number.isFinite(target.y) &&
        Number.isFinite(target.z)
      ) {
        const noseStart = this.tempOrigin.set(
          px + dir.x * 0.56,
          py + dir.y * 0.56,
          pz + dir.z * 0.56,
        );
        const lockEnd = this.tempTarget.set(target.x, target.y, target.z);
        const beamDelta = this.tempVec.subVectors(lockEnd, noseStart);
        const beamLen = beamDelta.length();
        if (Number.isFinite(beamLen) && beamLen > 0.12) {
          this.gpsLockBeam.visible = true;
          this.gpsLockBeam.position
            .copy(noseStart)
            .addScaledVector(beamDelta, 0.5);
          beamDelta.divideScalar(beamLen);
          this.gpsLockBeam.quaternion.setFromUnitVectors(UP_Y, beamDelta);
          this.gpsLockBeam.scale.set(1, beamLen, 1);
        }
      }

      if (movedEnough) {
        this.spawnMissileTrail(px, py, pz, dir);
        this.lastProjectilePos = new THREE.Vector3(px, py, pz);
      }
      return;
    }

    if (gadgetId === "burrow_bore") {
      const dir = this.resolveUnitDirection(
        options?.direction,
        this.tempDir,
        fallbackDir ?? this.lastProjectileDir,
      );
      this.lastProjectileDir.copy(dir);
      this.drillIsBoring = Boolean(options?.boring);
      this.drillGroup.visible = true;
      this.drillGroup.position.set(px, py, pz);
      this.drillGroup.quaternion.setFromUnitVectors(UP_Y, dir);
      if (safeDt > 0) {
        const spinRate = this.drillIsBoring ? 55 : 28;
        this.drillSpinPivot.rotation.y += safeDt * spinRate;
        this.drillSpunThisTick = true;
      }
      const thrustScale = this.drillIsBoring ? 1.18 : 0.72;
      this.drillThrusterSprite.scale.set(thrustScale, thrustScale, 1);

      if (movedEnough) {
        this.spawnDrillTrail(px, py, pz, dir, this.drillIsBoring);
        this.lastProjectilePos = new THREE.Vector3(px, py, pz);
      }
      return;
    }

    const color = gadgetColor ?? 0xffb347;
    this.projectileCoreMat.color.setHex(color);
    this.projectileCoreMat.emissive.setHex(color);
    this.projectileRingMat.color.setHex(color);
    this.projectileHalo.material.color.setHex(color);

    this.projectileGroup.visible = true;
    this.projectileGroup.position.set(px, py, pz);

    if (movedEnough) {
      this.spawnProjectileSpark({ x: px, y: py, z: pz }, color);
      this.lastProjectilePos = new THREE.Vector3(px, py, pz);
    }
  }

  /** Show or hide the glowing cyan Drone Recon ground target ring, or animated GPS target-lock crosshair when `lockedMode` is true. */
  public setDronePing(position: Vec3 | null, lockedMode?: boolean): void {
    if (!position) {
      this.dronePingGroup.visible = false;
      this.droneLockMode = false;
      this.droneLockReticleGroup.visible = false;
      return;
    }
    const px = Number.isFinite(position.x) ? position.x : 0;
    const py = Number.isFinite(position.y) ? position.y : 0;
    const pz = Number.isFinite(position.z) ? position.z : 0;
    this.dronePingGroup.visible = true;
    this.dronePingGroup.position.set(px, py, pz);

    this.droneLockMode = Boolean(lockedMode);
    this.droneLockReticleGroup.visible = this.droneLockMode;
    this.droneOuterRing.visible = !this.droneLockMode;
    this.droneInnerRing.visible = !this.droneLockMode;
  }

  /**
   * Synchronize vertical 3D player light pillars and pulsing ground rings for Drone View.
   * Local player receives an unmistakable radiant gold pillar and wider 1.35x ring; rivals
   * and allies are color-coded with subtle pulse emphasis on the active turn holder.
   */
  public syncDronePlayerBeacons(
    beacons: readonly DroneBeaconInput[],
    visible: boolean,
    elapsedSec: number,
  ): void {
    this.droneBeaconGroup.visible = visible;
    if (!visible) {
      return;
    }

    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;
    const seen = new Set<string>();

    for (let i = 0; i < beacons.length; i++) {
      const beacon = beacons[i];
      if (
        !beacon ||
        !Number.isFinite(beacon.position.x) ||
        !Number.isFinite(beacon.position.y) ||
        !Number.isFinite(beacon.position.z)
      ) {
        continue;
      }

      seen.add(beacon.id);
      let visual = this.droneBeacons.get(beacon.id);
      if (!visual) {
        const rig = new THREE.Group();
        rig.name = `drone_beacon_${beacon.id}`;

        const pillarMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.32,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const pillar = new THREE.Mesh(
          this.sharedGeos.droneBeaconPillar,
          pillarMat,
        );
        pillar.name = "drone_beacon_pillar";
        pillar.position.y =
          DRONE_BEACON_BASE_Y_OFFSET + DRONE_BEACON_PILLAR_HEIGHT * 0.5;
        pillar.frustumCulled = false;

        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const ring = new THREE.Mesh(this.sharedGeos.droneBeaconRing, ringMat);
        ring.name = "drone_beacon_ring";
        ring.rotation.x = Math.PI * 0.5;
        ring.position.y = DRONE_BEACON_BASE_Y_OFFSET + 0.06;
        ring.frustumCulled = false;

        rig.add(pillar, ring);
        this.droneBeaconGroup.add(rig);
        visual = { group: rig, pillar, pillarMat, ring, ringMat };
        this.droneBeacons.set(beacon.id, visual);
      }

      visual.group.position.set(
        beacon.position.x,
        beacon.position.y,
        beacon.position.z,
      );

      if (beacon.isLocal) {
        visual.pillarMat.color.setHex(DRONE_BEACON_GOLD_HEX);
        visual.ringMat.color.setHex(DRONE_BEACON_GOLD_HEX);
      } else {
        visual.pillarMat.color.set(beacon.color);
        visual.ringMat.color.set(beacon.color);
      }

      const wave = Math.sin(t * (beacon.isActiveTurn ? 5.6 : 3.2));
      const pulse = 0.5 + 0.5 * wave;

      if (beacon.isLocal) {
        const ringScale = 1.35 * (1.0 + wave * 0.08);
        visual.ring.scale.set(ringScale, ringScale, 1);
        visual.pillar.scale.set(1.12, 1, 1.12);
        visual.pillarMat.opacity = 0.42 + pulse * 0.14;
        visual.ringMat.opacity = 0.88 + pulse * 0.12;
      } else {
        const baseRingScale = beacon.isActiveTurn ? 1.12 : 1.0;
        const ringScale =
          baseRingScale * (1.0 + wave * (beacon.isActiveTurn ? 0.1 : 0.05));
        visual.ring.scale.set(ringScale, ringScale, 1);
        const pillarWidth = beacon.isActiveTurn ? 1.04 : 0.94;
        visual.pillar.scale.set(pillarWidth, 1, pillarWidth);
        visual.pillarMat.opacity = beacon.isActiveTurn
          ? 0.34 + pulse * 0.14
          : 0.24 + pulse * 0.08;
        visual.ringMat.opacity = beacon.isActiveTurn
          ? 0.8 + pulse * 0.16
          : 0.65 + pulse * 0.12;
      }
    }

    for (const [id, visual] of this.droneBeacons.entries()) {
      if (!seen.has(id)) {
        this.droneBeaconGroup.remove(visual.group);
        visual.pillarMat.dispose();
        visual.ringMat.dispose();
        this.droneBeacons.delete(id);
      }
    }
  }

  /** Advance active VFX particle lifetimes, pooled shards/sprites, sunlit pollen drift, and cleanup. */
  public update(dtSec: number, elapsedSec: number): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;

    // Gentle sunlit golden bokeh pollen motes drifting in the island breeze
    const pollenPos = this.pollenPoints.geometry.getAttribute("position");
    if (pollenPos instanceof THREE.BufferAttribute) {
      const wx = this.lastWind.x * 0.22;
      const wz = this.lastWind.z * 0.22;
      for (let i = 0; i < POLLEN_MOTE_COUNT; i++) {
        const phase = this.pollenPhases[i] ?? 0;
        const spd = this.pollenSpeeds[i] ?? 0.5;
        let x = pollenPos.getX(i) + (wx + Math.sin(t * 0.7 + phase) * 0.35) * spd * safeDt;
        let y = pollenPos.getY(i) + Math.cos(t * 0.9 + phase * 1.3) * 0.28 * safeDt;
        let z = pollenPos.getZ(i) + (wz + Math.cos(t * 0.65 + phase) * 0.35) * spd * safeDt;

        x = wrapCoord(x, 3, this.worldSpanX - 3);
        y = wrapCoord(y, 2.8, this.worldSpanY * 0.78);
        z = wrapCoord(z, 3, this.worldSpanZ - 3);
        pollenPos.setXYZ(i, x, y, z);
      }
      pollenPos.needsUpdate = true;
    }

    // Advance lightweight shockwave rings & grapple beams in vfx_particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      if (!p) {
        continue;
      }
      p.age += safeDt;
      if (p.age >= p.maxAge) {
        this.disposeParticle(p);
        this.particles.splice(i, 1);
        continue;
      }

      const frac = p.age / p.maxAge;
      p.velocity.y -= p.gravity * safeDt;
      p.mesh.position.addScaledVector(p.velocity, safeDt);
      p.mesh.rotation.x += p.spin.x * safeDt;
      p.mesh.rotation.y += p.spin.y * safeDt;
      p.mesh.rotation.z += p.spin.z * safeDt;

      let s = p.startScale + (p.endScale - p.startScale) * frac;
      if (p.sharedMaterial && p.kind === "shard" && frac > 0.75) {
        const tailFrac = (frac - 0.75) / 0.25;
        s = s * (1 - tailFrac) + 0.05 * tailFrac;
      }
      if (p.kind === "beam") {
        p.mesh.scale.set(
          p.baseScaleVec.x * s,
          p.baseScaleVec.y,
          p.baseScaleVec.z * s,
        );
      } else {
        p.mesh.scale.set(
          p.baseScaleVec.x * s,
          p.baseScaleVec.y * s,
          p.baseScaleVec.z * s,
        );
      }

      if (
        !p.sharedMaterial &&
        (p.material instanceof THREE.MeshBasicMaterial ||
          p.material instanceof THREE.MeshStandardMaterial)
      ) {
        p.material.opacity = Math.max(0, p.baseOpacity * (1 - frac));
      }
    }

    // Advance pooled InstancedMesh particle buffers
    this.updateInstancedPool(this.dodecaShardPool, safeDt);
    this.updateInstancedPool(this.tetraShardPool, safeDt);
    this.updateInstancedPool(this.sparkPool, safeDt);
    this.updateInstancedPool(this.dropletPool, safeDt);

    // Advance pooled billboard glow & smoke sprites
    this.updateSpritePool(this.glowSpritePool, safeDt);
    this.updateSpritePool(this.smokeSpritePool, safeDt);

    if (this.projectileGroup.visible) {
      this.projectileGroup.rotation.y += safeDt * 7.5;
      this.projectileGroup.rotation.x += safeDt * 4.5;
      const haloPulse = 1.45 + Math.sin(t * 18.0) * 0.22;
      this.projectileHalo.scale.set(haloPulse, haloPulse, 1);
    }

    if (this.bombGroup.visible) {
      if (!this.bombRotatedThisTick) {
        this.bombGroup.rotation.x += safeDt * 6.5;
        this.bombGroup.rotation.z += safeDt * 4.2;
      }
      this.bombRotatedThisTick = false;
      const flicker = 0.56 + Math.sin(t * 28.0) * 0.14 + Math.cos(t * 41.0) * 0.06;
      this.bombFlameSprite.scale.set(flicker, flicker * 1.15, 1);
      this.bombFlameCoreSprite.scale.set(flicker * 0.5, flicker * 0.56, 1);
    }

    if (this.missileGroup.visible) {
      const thrustPulse = 0.74 + Math.sin(t * 26.0) * 0.16;
      this.missileThrusterSprite.scale.set(thrustPulse, thrustPulse, 1);
      if (
        this.gpsLockBeam.visible &&
        this.gpsLockBeam.material instanceof THREE.MeshBasicMaterial
      ) {
        this.gpsLockBeam.material.opacity = 0.3 + Math.sin(t * 14.0) * 0.12;
      }
    }

    if (this.drillGroup.visible) {
      if (!this.drillSpunThisTick) {
        const spinRate = this.drillIsBoring ? 55 : 28;
        this.drillSpinPivot.rotation.y += safeDt * spinRate;
      }
      this.drillSpunThisTick = false;
      const baseThrust = this.drillIsBoring ? 1.15 : 0.72;
      const drillPulse = baseThrust + Math.sin(t * 24.0) * 0.14;
      this.drillThrusterSprite.scale.set(drillPulse, drillPulse, 1);
    }

    if (this.dronePingGroup.visible) {
      if (this.droneLockMode && this.droneLockReticleGroup.visible) {
        this.droneLockReticleGroup.rotation.y += safeDt * 2.6;
        const lockPulse = 0.5 + 0.5 * Math.sin(t * 9.0);
        const innerScale = 0.88 + lockPulse * 0.24;
        this.droneLockInnerRing.scale.set(innerScale, innerScale, 1);
        this.droneLockInnerMat.color
          .copy(GPS_LOCK_CYAN)
          .lerp(GPS_LOCK_CRIMSON, lockPulse);
      } else {
        const pulse = 1.0 + Math.sin(t * 5.2) * 0.12;
        this.droneOuterRing.scale.set(pulse, pulse, 1);
        this.droneInnerRing.rotation.z = t * 2.4;
      }
    }
  }

  /** Dispose all active particles, pools, shared textures, pollen motes, Evo Pods, Prism Walls, wind ribbons, markers, shared materials, and shared geometries. */
  public dispose(): void {
    for (const p of this.particles) {
      this.disposeParticle(p);
    }
    this.particles.length = 0;

    // Dispose pooled InstancedMesh materials & pooled SpriteMaterials cleanly
    disposeObjectTree(this.poolGroup);
    this.poolGroup.clear();

    for (let i = this.group.children.length - 1; i >= 0; i--) {
      const child = this.group.children[i];
      if (child && child.userData.isGrappleTether === true) {
        this.group.remove(child);
        disposeObjectMaterialsOnly(child);
      }
    }

    for (const visual of this.evoPods.values()) {
      this.evoPodGroup.remove(visual.group);
      disposeObjectTree(visual.group);
    }
    this.evoPods.clear();

    for (const visual of this.prismWallVisuals.values()) {
      this.prismWallGroup.remove(visual.group);
      disposeObjectTree(visual.group);
    }
    this.prismWallVisuals.clear();
    this.group.remove(this.prismWallGroup);

    for (const ribbon of this.windRibbons) {
      this.windGroup.remove(ribbon.mesh);
      ribbon.material.dispose();
    }
    this.windRibbons.length = 0;

    this.pollenPoints.geometry.dispose();
    disposeMaterial(this.pollenPoints.material);
    this.group.remove(this.pollenPoints);

    disposeObjectTree(this.projectileGroup);
    disposeObjectTree(this.bombGroup);
    disposeObjectTree(this.missileGroup);
    disposeObjectTree(this.drillGroup);
    disposeObjectTree(this.gpsLockBeam);
    disposeObjectTree(this.dronePingGroup);

    for (const visual of this.droneBeacons.values()) {
      this.droneBeaconGroup.remove(visual.group);
      visual.pillarMat.dispose();
      visual.ringMat.dispose();
    }
    this.droneBeacons.clear();
    this.group.remove(this.droneBeaconGroup);

    for (const mat of this.shardPaletteMaterials) {
      mat.dispose();
    }
    this.prismShardMaterial.dispose();

    this.sharedGeos.shardDodeca.dispose();
    this.sharedGeos.shardTetra.dispose();
    this.sharedGeos.droplet.dispose();
    this.sharedGeos.shockRing.dispose();
    this.sharedGeos.spark.dispose();
    this.sharedGeos.ribbon.dispose();
    this.sharedGeos.grappleBeam.dispose();
    this.sharedGeos.hookCollar.dispose();
    this.sharedGeos.hookShankRing.dispose();
    this.sharedGeos.hookProngCurve.dispose();
    this.sharedGeos.hookProngTip.dispose();
    this.sharedGeos.droneBeaconPillar.dispose();
    this.sharedGeos.droneBeaconRing.dispose();

    this.glowTexture.dispose();
    this.smokeTexture.dispose();
    this.bokehTexture.dispose();
  }

  private emitInstanceFromPool(
    pool: InstancedParticlePool,
    cfg: {
      x: number;
      y: number;
      z: number;
      vx: number;
      vy: number;
      vz: number;
      spinX: number;
      spinY: number;
      spinZ: number;
      gravity: number;
      maxAge: number;
      startScale: number;
      endScale: number;
      sx: number;
      sy: number;
      sz: number;
      colorHex: number;
    },
  ): void {
    const cap = pool.slots.length;
    if (cap === 0) return;

    let chosenIdx = -1;
    for (let step = 0; step < cap; step++) {
      const idx = (pool.cursor + step) % cap;
      const candidate = pool.slots[idx];
      if (candidate && !candidate.active) {
        chosenIdx = idx;
        break;
      }
    }
    if (chosenIdx < 0) {
      chosenIdx = pool.cursor % cap;
    }
    pool.cursor = (chosenIdx + 1) % cap;

    const slot = pool.slots[chosenIdx];
    if (!slot) return;

    slot.active = true;
    slot.position.set(cfg.x, cfg.y, cfg.z);
    slot.velocity.set(cfg.vx, cfg.vy, cfg.vz);
    slot.rotation.set(
      this.nextRand() * Math.PI,
      this.nextRand() * Math.PI,
      this.nextRand() * Math.PI,
    );
    slot.spin.set(cfg.spinX, cfg.spinY, cfg.spinZ);
    slot.gravity = cfg.gravity;
    slot.age = 0;
    slot.maxAge = Math.max(0.05, cfg.maxAge);
    slot.startScale = cfg.startScale;
    slot.endScale = cfg.endScale;
    slot.baseScaleVec.set(cfg.sx, cfg.sy, cfg.sz);

    this.dummyObj.position.copy(slot.position);
    this.dummyObj.rotation.copy(slot.rotation);
    this.dummyObj.scale.set(
      cfg.sx * cfg.startScale,
      cfg.sy * cfg.startScale,
      cfg.sz * cfg.startScale,
    );
    this.dummyObj.updateMatrix();
    pool.mesh.setMatrixAt(chosenIdx, this.dummyObj.matrix);
    this.scratchColor.setHex(cfg.colorHex);
    pool.mesh.setColorAt(chosenIdx, this.scratchColor);
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.mesh.instanceColor) {
      pool.mesh.instanceColor.needsUpdate = true;
    }
  }

  private updateInstancedPool(pool: InstancedParticlePool, dtSec: number): void {
    let dirty = false;
    for (let i = 0; i < pool.slots.length; i++) {
      const slot = pool.slots[i];
      if (!slot || !slot.active) {
        continue;
      }
      slot.age += dtSec;
      if (slot.age >= slot.maxAge) {
        slot.active = false;
        pool.mesh.setMatrixAt(i, ZERO_MATRIX);
        dirty = true;
        continue;
      }

      const frac = slot.age / slot.maxAge;
      slot.velocity.y -= slot.gravity * dtSec;
      slot.position.addScaledVector(slot.velocity, dtSec);
      slot.rotation.x += slot.spin.x * dtSec;
      slot.rotation.y += slot.spin.y * dtSec;
      slot.rotation.z += slot.spin.z * dtSec;

      const s = slot.startScale + (slot.endScale - slot.startScale) * frac;
      this.dummyObj.position.copy(slot.position);
      this.dummyObj.rotation.copy(slot.rotation);
      this.dummyObj.scale.set(
        slot.baseScaleVec.x * s,
        slot.baseScaleVec.y * s,
        slot.baseScaleVec.z * s,
      );
      this.dummyObj.updateMatrix();
      pool.mesh.setMatrixAt(i, this.dummyObj.matrix);
      dirty = true;
    }

    if (dirty) {
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private emitSpriteFromPool(
    pool: SpriteParticlePool,
    cfg: {
      x: number;
      y: number;
      z: number;
      vx: number;
      vy: number;
      vz: number;
      gravity: number;
      maxAge: number;
      startScale: number;
      endScale: number;
      colorHex: number;
      baseOpacity: number;
      rotationSpeed: number;
    },
  ): void {
    const cap = pool.slots.length;
    if (cap === 0) return;

    let chosenIdx = -1;
    for (let step = 0; step < cap; step++) {
      const idx = (pool.cursor + step) % cap;
      const candidate = pool.slots[idx];
      if (candidate && !candidate.active) {
        chosenIdx = idx;
        break;
      }
    }
    if (chosenIdx < 0) {
      chosenIdx = pool.cursor % cap;
    }
    pool.cursor = (chosenIdx + 1) % cap;

    const slot = pool.slots[chosenIdx];
    if (!slot) return;

    slot.active = true;
    slot.velocity.set(cfg.vx, cfg.vy, cfg.vz);
    slot.gravity = cfg.gravity;
    slot.age = 0;
    slot.maxAge = Math.max(0.05, cfg.maxAge);
    slot.startScale = cfg.startScale;
    slot.endScale = cfg.endScale;
    slot.baseOpacity = cfg.baseOpacity;
    slot.rotationSpeed = cfg.rotationSpeed;

    slot.sprite.visible = true;
    slot.sprite.position.set(cfg.x, cfg.y, cfg.z);
    slot.sprite.scale.set(cfg.startScale, cfg.startScale, 1);
    slot.sprite.material.color.setHex(cfg.colorHex);
    slot.sprite.material.opacity = cfg.baseOpacity;
    slot.sprite.material.rotation = this.nextRand() * Math.PI * 2;
  }

  private updateSpritePool(pool: SpriteParticlePool, dtSec: number): void {
    for (const slot of pool.slots) {
      if (!slot.active) {
        continue;
      }
      slot.age += dtSec;
      if (slot.age >= slot.maxAge) {
        slot.active = false;
        slot.sprite.visible = false;
        slot.sprite.material.opacity = 0;
        continue;
      }

      const frac = slot.age / slot.maxAge;
      slot.velocity.y -= slot.gravity * dtSec;
      slot.sprite.position.addScaledVector(slot.velocity, dtSec);
      const s = slot.startScale + (slot.endScale - slot.startScale) * frac;
      slot.sprite.scale.set(s, s, 1);
      slot.sprite.material.rotation += slot.rotationSpeed * dtSec;
      // Smooth ease-out alpha decay
      const fade = (1.0 - frac) * (1.0 - frac * 0.35);
      slot.sprite.material.opacity = Math.max(0, slot.baseOpacity * fade);
    }
  }

  private disposeParticle(p: DynamicParticle): void {
    this.particleGroup.remove(p.mesh);
    if (!p.sharedMaterial) {
      p.material.dispose();
    }
  }

  private createPrismWallVisual(wall: PrismWallState): PrismWallVisual {
    const group = new THREE.Group();
    group.name = `prism_wall_${wall.id}`;
    group.userData.wallWidth = wall.width;
    group.userData.wallHeight = wall.height;

    const hw = Math.max(0.6, wall.width * 0.5);
    const hh = Math.max(0.6, wall.height * 0.5);
    const bevel = 0.05;
    const sx = Math.max(0.25, hw - bevel);
    const sy = Math.max(0.25, hh - bevel);
    const ch = Math.min(sx * 0.28, sy * 0.24, 0.36);

    const shape = new THREE.Shape();
    shape.moveTo(-sx + ch, -sy);
    shape.lineTo(sx - ch, -sy);
    shape.lineTo(sx, -sy + ch);
    shape.lineTo(sx, sy - ch);
    shape.lineTo(sx - ch, sy);
    shape.lineTo(-sx + ch, sy);
    shape.lineTo(-sx, sy - ch);
    shape.lineTo(-sx, -sy + ch);
    shape.closePath();

    const slabGeo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.14,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
    });
    slabGeo.translate(0, 0, -0.07);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x67e8f9,
      emissive: 0x06b6d4,
      emissiveIntensity: 0.72,
      roughness: 0.16,
      metalness: 0.22,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const slabMesh = new THREE.Mesh(slabGeo, mat);
    slabMesh.name = "prism_wall_slab";
    group.add(slabMesh);

    const rimMat = new THREE.MeshBasicMaterial({
      color: 0xa5f3fc,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const rimCurve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(-hw + ch, -hh, 0),
        new THREE.Vector3(hw - ch, -hh, 0),
        new THREE.Vector3(hw, -hh + ch, 0),
        new THREE.Vector3(hw, hh - ch, 0),
        new THREE.Vector3(hw - ch, hh, 0),
        new THREE.Vector3(-hw + ch, hh, 0),
        new THREE.Vector3(-hw, hh - ch, 0),
        new THREE.Vector3(-hw, -hh + ch, 0),
      ],
      true,
      "catmullrom",
      0.08,
    );
    const rimMesh = new THREE.Mesh(
      new THREE.TubeGeometry(rimCurve, 32, 0.045, 6, true),
      rimMat,
    );
    rimMesh.name = "prism_wall_rim";
    group.add(rimMesh);

    const innerHexRing = new THREE.Mesh(
      new THREE.TorusGeometry(Math.min(hw, hh) * 0.54, 0.024, 6, 6),
      rimMat,
    );
    innerHexRing.name = "prism_wall_emblem";
    group.add(innerHexRing);

    for (const side of [-1, 1] as const) {
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.085, 0.125, wall.height * 0.94, 6),
        mat,
      );
      pillar.position.set(side * (hw - 0.08), 0, 0);
      group.add(pillar);
    }

    return { group, mat, rimMat };
  }

  private spawnProjectileSpark(position: Vec3, color: number): void {
    this.trailEmitCounter += 1;

    // Pooled glowing comet spark shard
    this.emitInstanceFromPool(this.sparkPool, {
      x: position.x + (this.nextRand() - 0.5) * 0.12,
      y: position.y + (this.nextRand() - 0.5) * 0.12,
      z: position.z + (this.nextRand() - 0.5) * 0.12,
      vx: (this.nextRand() - 0.5) * 0.8,
      vy: 0.35 + this.nextRand() * 0.55,
      vz: (this.nextRand() - 0.5) * 0.8,
      spinX: 4,
      spinY: 5,
      spinZ: 3,
      gravity: 1.5,
      maxAge: 0.34,
      startScale: 1.05,
      endScale: 0.1,
      sx: 1,
      sy: 1,
      sz: 1,
      colorHex: color,
    });

    // Soft additive glowing comet trail mote
    this.emitSpriteFromPool(this.glowSpritePool, {
      x: position.x,
      y: position.y,
      z: position.z,
      vx: (this.nextRand() - 0.5) * 0.3,
      vy: 0.15,
      vz: (this.nextRand() - 0.5) * 0.3,
      gravity: 0,
      maxAge: 0.24,
      startScale: 0.72,
      endScale: 0.16,
      colorHex: color,
      baseOpacity: 0.65,
      rotationSpeed: 0,
    });

    // Gentle wispy smoke puff on alternating trail emissions
    if (this.trailEmitCounter % 2 === 0) {
      this.emitSpriteFromPool(this.smokeSpritePool, {
        x: position.x,
        y: position.y,
        z: position.z,
        vx: (this.nextRand() - 0.5) * 0.4,
        vy: 0.45 + this.nextRand() * 0.35,
        vz: (this.nextRand() - 0.5) * 0.4,
        gravity: -0.2,
        maxAge: 0.48,
        startScale: 0.42,
        endScale: 1.15,
        colorHex: 0xf6f2ec,
        baseOpacity: 0.34,
        rotationSpeed: (this.nextRand() - 0.5) * 0.9,
      });
    }
  }

  private createEvoPodVisual(
    id: string,
    kind: NonNullable<EvoPodState["kind"]> = "evo_dna",
  ): EvoPodVisual {
    const group = new THREE.Group();
    group.name = `evo_pod_${id}`;
    group.userData.podKind = kind;

    const palette =
      kind === "med_berry"
        ? {
            core: 0x22c55e,
            emissive: 0x10b981,
            collar: 0xd1fae5,
            collarEmissive: 0x34d399,
            canopy: 0xecfdf5,
            canopyEmissive: 0x22c55e,
            cord: 0xa7f3d0,
            beacon: 0x34d399,
          }
        : kind === "super_gadget"
          ? {
              core: 0xfbbf24,
              emissive: 0xf59e0b,
              collar: 0xfef3c7,
              collarEmissive: 0xf59e0b,
              canopy: 0xfffbeb,
              canopyEmissive: 0xfbbf24,
              cord: 0xfde68a,
              beacon: 0xfbbf24,
            }
          : {
              core: 0x38f2ff,
              emissive: 0x10cce8,
              collar: 0xd8faff,
              collarEmissive: 0x26d8f8,
              canopy: 0xf0fdff,
              canopyEmissive: 0x38d8f0,
              cord: 0xbff7ff,
              beacon: 0x38f2ff,
            };

    const coreGeo =
      kind === "med_berry"
        ? new THREE.CylinderGeometry(0.32, 0.34, 0.44, 10)
        : kind === "super_gadget"
          ? new THREE.OctahedronGeometry(0.36, 0)
          : new THREE.IcosahedronGeometry(0.32, 0);

    const podCore = new THREE.Mesh(
      coreGeo,
      new THREE.MeshStandardMaterial({
        color: palette.core,
        emissive: palette.emissive,
        emissiveIntensity: 0.95,
        roughness: 0.22,
        metalness: kind === "super_gadget" ? 0.45 : 0.22,
      }),
    );
    podCore.castShadow = true;

    const hexCollar = new THREE.Mesh(
      kind === "super_gadget"
        ? new THREE.TorusGeometry(0.4, 0.055, 8, 20)
        : new THREE.CylinderGeometry(0.38, 0.38, 0.12, 6, 1, true),
      new THREE.MeshStandardMaterial({
        color: palette.collar,
        emissive: palette.collarEmissive,
        emissiveIntensity: 0.65,
        roughness: 0.3,
        metalness: 0.68,
        side: THREE.DoubleSide,
      }),
    );
    if (kind === "super_gadget") {
      hexCollar.rotation.x = Math.PI * 0.5;
    }
    podCore.add(hexCollar);

    if (kind === "med_berry") {
      // Sculpted glowing white-mint cross emblem on Med-Berry crate (zero BoxGeometry!)
      const crossGroup = new THREE.Group();
      crossGroup.name = "med_berry_cross";
      const crossMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x6ee7b7,
        emissiveIntensity: 1.15,
        roughness: 0.2,
        metalness: 0.05,
      });
      const barA = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.36, 8),
        crossMat,
      );
      barA.position.y = 0.26;
      barA.rotation.z = Math.PI * 0.5;
      const barB = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.36, 8),
        crossMat,
      );
      barB.position.y = 0.26;
      barB.rotation.x = Math.PI * 0.5;
      crossGroup.add(barA, barB);
      podCore.add(crossGroup);
    }

    group.add(podCore);

    // Open canopy parachute + 4 suspension cords (shared cord material) for airborne descent
    const parachuteGroup = new THREE.Group();
    parachuteGroup.name = "evo_pod_parachute";

    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(
        0.78,
        16,
        10,
        0,
        Math.PI * 2,
        0,
        Math.PI * 0.52,
      ),
      new THREE.MeshStandardMaterial({
        color: palette.canopy,
        emissive: palette.canopyEmissive,
        emissiveIntensity: 0.24,
        roughness: 0.58,
        side: THREE.DoubleSide,
      }),
    );
    canopy.position.y = 1.05;
    parachuteGroup.add(canopy);

    const cordMat = new THREE.MeshBasicMaterial({ color: palette.cord });
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI * 0.25;
      const cord = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 1.15, 6),
        cordMat,
      );
      cord.position.set(Math.cos(a) * 0.34, 0.62, Math.sin(a) * 0.34);
      cord.rotation.set(Math.sin(a) * 0.42, 0, -Math.cos(a) * 0.42);
      parachuteGroup.add(cord);
    }
    group.add(parachuteGroup);

    // Translucent landed beacon column matching crate color
    const beaconMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.42, 2.8, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color: palette.beacon,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    beaconMesh.name = "evo_pod_beacon";
    beaconMesh.position.y = 1.35;
    group.add(beaconMesh);

    // Subtle luminous additive ground light pool matching crate color (evo_dna cyan, med_berry emerald, super_gadget gold)
    const groundPoolMesh = new THREE.Mesh(
      new THREE.CircleGeometry(1.55, 24),
      new THREE.MeshBasicMaterial({
        map: this.glowTexture,
        color: palette.beacon,
        transparent: true,
        opacity: 0.38,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    );
    groundPoolMesh.name = "evo_pod_ground_pool";
    groundPoolMesh.rotation.x = -Math.PI * 0.5;
    groundPoolMesh.position.y = 0.06;
    groundPoolMesh.castShadow = false;
    groundPoolMesh.receiveShadow = false;
    group.add(groundPoolMesh);

    return { group, podCore, parachuteGroup, beaconMesh, groundPoolMesh };
  }

  private resolveUnitDirection(
    direction: Vec3 | undefined,
    out: THREE.Vector3,
    fallback?: THREE.Vector3,
  ): THREE.Vector3 {
    if (
      direction &&
      Number.isFinite(direction.x) &&
      Number.isFinite(direction.y) &&
      Number.isFinite(direction.z)
    ) {
      const len = Math.hypot(direction.x, direction.y, direction.z);
      if (len > 1e-5) {
        return out.set(direction.x / len, direction.y / len, direction.z / len);
      }
    }
    if (fallback && fallback.lengthSq() > 1e-8) {
      return out.copy(fallback).normalize();
    }
    return out.set(0, 1, 0);
  }

  private createBombVisual(): {
    group: THREE.Group;
    flameSprite: THREE.Sprite;
    flameCoreSprite: THREE.Sprite;
  } {
    const group = new THREE.Group();
    group.name = "vfx_projectile_bomb";

    const ironBody = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 18, 14),
      new THREE.MeshStandardMaterial({
        color: 0x1c1f26,
        emissive: 0x141822,
        emissiveIntensity: 0.28,
        roughness: 0.42,
        metalness: 0.55,
      }),
    );
    ironBody.name = "bomb_body";
    ironBody.castShadow = true;
    group.add(ironBody);

    const castSeam = new THREE.Mesh(
      new THREE.TorusGeometry(0.282, 0.015, 6, 22),
      new THREE.MeshStandardMaterial({
        color: 0x2d3340,
        roughness: 0.35,
        metalness: 0.68,
      }),
    );
    castSeam.rotation.x = Math.PI * 0.5;
    group.add(castSeam);

    const fuseCollar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.088, 0.108, 0.085, 12),
      new THREE.MeshStandardMaterial({
        color: 0xd97706,
        emissive: 0x451a03,
        emissiveIntensity: 0.2,
        roughness: 0.3,
        metalness: 0.72,
      }),
    );
    fuseCollar.name = "bomb_fuse_collar";
    fuseCollar.position.y = 0.27;
    group.add(fuseCollar);

    const wickCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.3, 0),
      new THREE.Vector3(0.04, 0.4, 0.02),
      new THREE.Vector3(0.12, 0.47, 0.05),
      new THREE.Vector3(
        this.bombWickTipLocal.x,
        this.bombWickTipLocal.y,
        this.bombWickTipLocal.z,
      ),
    ]);
    const wickMesh = new THREE.Mesh(
      new THREE.TubeGeometry(wickCurve, 12, 0.026, 6, false),
      new THREE.MeshStandardMaterial({
        color: 0xa38255,
        roughness: 0.9,
        metalness: 0.02,
      }),
    );
    wickMesh.name = "bomb_wick";
    group.add(wickMesh);

    const wickEmber = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 6),
      new THREE.MeshStandardMaterial({
        color: 0xff6b1a,
        emissive: 0xff4500,
        emissiveIntensity: 1.9,
        roughness: 0.2,
      }),
    );
    wickEmber.position.copy(this.bombWickTipLocal);
    group.add(wickEmber);

    const flameSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0xff9922,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    flameSprite.name = "bomb_wick_flame";
    flameSprite.position.set(
      this.bombWickTipLocal.x,
      this.bombWickTipLocal.y + 0.02,
      this.bombWickTipLocal.z,
    );
    flameSprite.scale.set(0.58, 0.64, 1);
    group.add(flameSprite);

    const flameCoreSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0xfde047,
        transparent: true,
        opacity: 0.98,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    flameCoreSprite.name = "bomb_wick_flame_core";
    flameCoreSprite.position.copy(flameSprite.position);
    flameCoreSprite.scale.set(0.3, 0.34, 1);
    group.add(flameCoreSprite);

    return { group, flameSprite, flameCoreSprite };
  }

  private createMissileVisual(): {
    group: THREE.Group;
    thrusterSprite: THREE.Sprite;
  } {
    const group = new THREE.Group();
    group.name = "vfx_projectile_missile";

    const fuselage = new THREE.Mesh(
      new THREE.CylinderGeometry(0.102, 0.114, 0.62, 14),
      new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        roughness: 0.26,
        metalness: 0.42,
      }),
    );
    fuselage.name = "missile_fuselage";
    fuselage.castShadow = true;
    group.add(fuselage);

    const slateBand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.112, 0.113, 0.095, 14),
      new THREE.MeshStandardMaterial({
        color: 0x334155,
        roughness: 0.38,
        metalness: 0.55,
      }),
    );
    slateBand.position.y = -0.05;
    group.add(slateBand);

    const noseCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.102, 0.28, 14),
      new THREE.MeshStandardMaterial({
        color: 0xef4444,
        emissive: 0x7f1d1d,
        emissiveIntensity: 0.24,
        roughness: 0.26,
        metalness: 0.34,
      }),
    );
    noseCone.name = "missile_nose";
    noseCone.position.y = 0.45;
    group.add(noseCone);

    const seekerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.102, 0.022, 8, 20),
      new THREE.MeshStandardMaterial({
        color: 0x38f5ff,
        emissive: 0x06b6d4,
        emissiveIntensity: 1.85,
        roughness: 0.18,
        metalness: 0.2,
      }),
    );
    seekerRing.name = "missile_gps_ring";
    seekerRing.rotation.x = Math.PI * 0.5;
    seekerRing.position.y = 0.31;
    group.add(seekerRing);

    const seekerDome = new THREE.Mesh(
      new THREE.SphereGeometry(0.048, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x7ef9ff }),
    );
    seekerDome.name = "missile_gps_dome";
    seekerDome.position.y = 0.56;
    group.add(seekerDome);

    // 4 swept aerodynamic stabilizing tail fins (ExtrudeGeometry, zero BoxGeometry)
    const finShape = new THREE.Shape();
    finShape.moveTo(0.09, 0.14);
    finShape.lineTo(0.27, -0.08);
    finShape.lineTo(0.27, -0.2);
    finShape.lineTo(0.09, -0.16);
    finShape.closePath();

    const finGeo = new THREE.ExtrudeGeometry(finShape, {
      depth: 0.024,
      bevelEnabled: false,
    });
    finGeo.translate(0, 0, -0.012);
    const finMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.38,
      metalness: 0.55,
    });
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeo, finMat);
      fin.name = `missile_fin_${i}`;
      fin.position.y = -0.15;
      fin.rotation.y = (i * Math.PI) / 2;
      group.add(fin);
    }

    const nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.088, 0.064, 0.1, 12),
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.42,
        metalness: 0.68,
      }),
    );
    nozzle.position.y = -0.35;
    group.add(nozzle);

    const thrusterCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.072, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x38f5ff }),
    );
    thrusterCore.position.y = -0.4;
    group.add(thrusterCore);

    const thrusterSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0x38f5ff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    thrusterSprite.name = "missile_thruster_glow";
    thrusterSprite.position.y = -0.46;
    thrusterSprite.scale.set(0.76, 0.76, 1);
    group.add(thrusterSprite);

    return { group, thrusterSprite };
  }

  private createDrillVisual(): {
    group: THREE.Group;
    spinPivot: THREE.Group;
    thrusterSprite: THREE.Sprite;
  } {
    const group = new THREE.Group();
    group.name = "vfx_projectile_drill";

    const spinPivot = new THREE.Group();
    spinPivot.name = "vfx_drill_spin_pivot";
    group.add(spinPivot);

    const augerCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.72, 16),
      new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        roughness: 0.28,
        metalness: 0.78,
      }),
    );
    augerCone.name = "drill_auger_cone";
    augerCone.position.y = 0.14;
    augerCone.castShadow = true;
    spinPivot.add(augerCone);

    const hotTip = new THREE.Mesh(
      new THREE.ConeGeometry(0.064, 0.18, 12),
      new THREE.MeshStandardMaterial({
        color: 0xf97316,
        emissive: 0xff6b00,
        emissiveIntensity: 1.55,
        roughness: 0.22,
        metalness: 0.45,
      }),
    );
    hotTip.name = "drill_tip";
    hotTip.position.y = 0.48;
    spinPivot.add(hotTip);

    // Sculpted 2.5-turn helical spiral auger flute wrapping the tapered cone
    const helixPts: THREE.Vector3[] = [];
    const helixSteps = 26;
    for (let i = 0; i <= helixSteps; i++) {
      const u = i / helixSteps;
      const y = -0.18 + u * 0.6;
      const radius = 0.185 * (1 - u) + 0.052 * u;
      const theta = u * Math.PI * 5.0;
      helixPts.push(
        new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius),
      );
    }
    const helixCurve = new THREE.CatmullRomCurve3(helixPts);
    const helixFlute = new THREE.Mesh(
      new THREE.TubeGeometry(helixCurve, 36, 0.024, 6, false),
      new THREE.MeshStandardMaterial({
        color: 0xcbd5e1,
        emissive: 0xf97316,
        emissiveIntensity: 0.45,
        roughness: 0.26,
        metalness: 0.8,
      }),
    );
    helixFlute.name = "drill_helix_flute";
    spinPivot.add(helixFlute);

    // 3 tilted glowing auger bands reinforcing rapid rotational readability
    const bandMat = new THREE.MeshStandardMaterial({
      color: 0xf97316,
      emissive: 0xea580c,
      emissiveIntensity: 1.15,
      roughness: 0.28,
      metalness: 0.52,
    });
    const bandConfigs: ReadonlyArray<readonly [number, number]> = [
      [-0.1, 0.175],
      [0.08, 0.14],
      [0.26, 0.1],
    ];
    for (let i = 0; i < bandConfigs.length; i++) {
      const cfg = bandConfigs[i];
      if (!cfg) continue;
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(cfg[1], 0.02, 6, 18),
        bandMat,
      );
      band.position.y = cfg[0];
      band.rotation.x = Math.PI * 0.5 + 0.22;
      band.rotation.y = (i * Math.PI) / 3;
      spinPivot.add(band);
    }

    const rearCollar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.19, 0.175, 0.14, 14),
      new THREE.MeshStandardMaterial({
        color: 0x334155,
        roughness: 0.4,
        metalness: 0.72,
      }),
    );
    rearCollar.name = "drill_collar";
    rearCollar.position.y = -0.26;
    spinPivot.add(rearCollar);

    const tailThruster = new THREE.Mesh(
      new THREE.ConeGeometry(0.11, 0.18, 12),
      new THREE.MeshStandardMaterial({
        color: 0xf97316,
        emissive: 0xff7b1a,
        emissiveIntensity: 1.6,
        roughness: 0.2,
      }),
    );
    tailThruster.position.y = -0.38;
    tailThruster.rotation.x = Math.PI;
    spinPivot.add(tailThruster);

    const thrusterSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0xff8c24,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    thrusterSprite.name = "drill_thruster_glow";
    thrusterSprite.position.y = -0.46;
    thrusterSprite.scale.set(0.75, 0.75, 1);
    group.add(thrusterSprite);

    return { group, spinPivot, thrusterSprite };
  }

  private createDroneLockReticle(): {
    group: THREE.Group;
    innerRing: THREE.Mesh;
    innerMat: THREE.MeshBasicMaterial;
  } {
    const group = new THREE.Group();
    group.name = "vfx_gps_lock_reticle";

    const arcGeo = new THREE.TorusGeometry(1.12, 0.048, 8, 14, Math.PI * 0.34);
    const arcMat = new THREE.MeshBasicMaterial({
      color: 0xff3b5c,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });

    const tickGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.38, 8);
    const tickMat = new THREE.MeshBasicMaterial({
      color: 0x38f5ff,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });

    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;

      const arc = new THREE.Mesh(arcGeo, arcMat);
      arc.name = `gps_lock_arc_${i}`;
      arc.rotation.x = Math.PI * 0.5;
      arc.rotation.z = a + 0.24;
      arc.position.y = 0.14;
      group.add(arc);

      const tick = new THREE.Mesh(tickGeo, tickMat);
      tick.name = `gps_lock_tick_${i}`;
      tick.position.set(Math.cos(a) * 0.96, 0.16, Math.sin(a) * 0.96);
      tick.rotation.z = Math.PI * 0.5;
      tick.rotation.y = -a;
      group.add(tick);
    }

    const innerMat = new THREE.MeshBasicMaterial({
      color: 0x38f5ff,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
    });
    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.54, 0.046, 8, 28),
      innerMat,
    );
    innerRing.name = "gps_lock_inner_ring";
    innerRing.rotation.x = Math.PI * 0.5;
    innerRing.position.y = 0.16;
    group.add(innerRing);

    const centerPip = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.11, 0),
      new THREE.MeshBasicMaterial({
        color: 0xff3b5c,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
    );
    centerPip.name = "gps_lock_pip";
    centerPip.position.y = 0.36;
    group.add(centerPip);

    return { group, innerRing, innerMat };
  }

  private spawnBombTrail(px: number, py: number, pz: number): void {
    this.trailEmitCounter += 1;

    // Emit burning wick ember sparks from rotated wick tip
    this.tempVec
      .copy(this.bombWickTipLocal)
      .applyEuler(this.bombGroup.rotation)
      .add(this.tempOrigin.set(px, py, pz));

    for (let i = 0; i < 2; i++) {
      this.emitInstanceFromPool(this.sparkPool, {
        x: this.tempVec.x + (this.nextRand() - 0.5) * 0.08,
        y: this.tempVec.y + (this.nextRand() - 0.5) * 0.08,
        z: this.tempVec.z + (this.nextRand() - 0.5) * 0.08,
        vx: (this.nextRand() - 0.5) * 2.2,
        vy: 0.9 + this.nextRand() * 1.4,
        vz: (this.nextRand() - 0.5) * 2.2,
        spinX: 8,
        spinY: 9,
        spinZ: 7,
        gravity: 5.5,
        maxAge: 0.24 + this.nextRand() * 0.14,
        startScale: 0.95,
        endScale: 0.1,
        sx: 1,
        sy: 1,
        sz: 1,
        colorHex: i === 0 ? 0xfde047 : 0xff7b1a,
      });
    }

    if (this.trailEmitCounter % 2 === 0) {
      this.emitSpriteFromPool(this.smokeSpritePool, {
        x: this.tempVec.x,
        y: this.tempVec.y,
        z: this.tempVec.z,
        vx: (this.nextRand() - 0.5) * 0.45,
        vy: 0.6 + this.nextRand() * 0.35,
        vz: (this.nextRand() - 0.5) * 0.45,
        gravity: -0.25,
        maxAge: 0.46,
        startScale: 0.36,
        endScale: 1.05,
        colorHex: 0x646b78,
        baseOpacity: 0.36,
        rotationSpeed: (this.nextRand() - 0.5) * 1.2,
      });
    }
  }

  private spawnMissileTrail(
    px: number,
    py: number,
    pz: number,
    dir: THREE.Vector3,
  ): void {
    this.trailEmitCounter += 1;
    const tx = px - dir.x * 0.44;
    const ty = py - dir.y * 0.44;
    const tz = pz - dir.z * 0.44;

    // Bright cyan/orange thruster sparks shooting behind the tail nozzle
    this.emitInstanceFromPool(this.sparkPool, {
      x: tx,
      y: ty,
      z: tz,
      vx: -dir.x * 2.4 + (this.nextRand() - 0.5) * 0.9,
      vy: -dir.y * 2.4 + (this.nextRand() - 0.5) * 0.9,
      vz: -dir.z * 2.4 + (this.nextRand() - 0.5) * 0.9,
      spinX: 6,
      spinY: 7,
      spinZ: 6,
      gravity: 0.5,
      maxAge: 0.24,
      startScale: 1.05,
      endScale: 0.1,
      sx: 1,
      sy: 1,
      sz: 1,
      colorHex: this.trailEmitCounter % 2 === 0 ? 0x38f5ff : 0xff9922,
    });

    this.emitSpriteFromPool(this.glowSpritePool, {
      x: tx,
      y: ty,
      z: tz,
      vx: -dir.x * 0.8,
      vy: -dir.y * 0.8,
      vz: -dir.z * 0.8,
      gravity: 0,
      maxAge: 0.18,
      startScale: 0.58,
      endScale: 0.14,
      colorHex: 0x38f5ff,
      baseOpacity: 0.72,
      rotationSpeed: 0,
    });

    // Crisp billowing white smoke contrail puffs tracing the curved homing arc
    this.emitSpriteFromPool(this.smokeSpritePool, {
      x: tx,
      y: ty,
      z: tz,
      vx: (this.nextRand() - 0.5) * 0.35,
      vy: 0.25 + this.nextRand() * 0.25,
      vz: (this.nextRand() - 0.5) * 0.35,
      gravity: -0.18,
      maxAge: 0.65,
      startScale: 0.42,
      endScale: 1.45,
      colorHex: 0xf8fafc,
      baseOpacity: 0.52,
      rotationSpeed: (this.nextRand() - 0.5) * 1.0,
    });
  }

  private spawnDrillTrail(
    px: number,
    py: number,
    pz: number,
    dir: THREE.Vector3,
    boring: boolean,
  ): void {
    this.trailEmitCounter += 1;
    const tx = px - dir.x * 0.42;
    const ty = py - dir.y * 0.42;
    const tz = pz - dir.z * 0.42;

    if (boring) {
      // Intense orange friction sparks + warm earthen rock-dust plumes while chewing through rock
      for (let i = 0; i < 3; i++) {
        this.emitInstanceFromPool(this.sparkPool, {
          x: px + (this.nextRand() - 0.5) * 0.16,
          y: py + (this.nextRand() - 0.5) * 0.16,
          z: pz + (this.nextRand() - 0.5) * 0.16,
          vx: -dir.x * 3.8 + (this.nextRand() - 0.5) * 3.2,
          vy: -dir.y * 3.8 + 1.2 + this.nextRand() * 2.2,
          vz: -dir.z * 3.8 + (this.nextRand() - 0.5) * 3.2,
          spinX: 12,
          spinY: 14,
          spinZ: 10,
          gravity: 11.5,
          maxAge: 0.28 + this.nextRand() * 0.16,
          startScale: 1.15,
          endScale: 0.1,
          sx: 1,
          sy: 1,
          sz: 1,
          colorHex: i === 0 ? 0xfde047 : 0xf97316,
        });
      }

      this.emitSpriteFromPool(this.smokeSpritePool, {
        x: tx,
        y: ty,
        z: tz,
        vx: -dir.x * 1.4 + (this.nextRand() - 0.5) * 1.1,
        vy: -dir.y * 1.4 + 0.75 + this.nextRand() * 0.55,
        vz: -dir.z * 1.4 + (this.nextRand() - 0.5) * 1.1,
        gravity: -0.25,
        maxAge: 0.52,
        startScale: 0.52,
        endScale: 1.65,
        colorHex: this.trailEmitCounter % 2 === 0 ? 0xc7a37e : 0x9e8268,
        baseOpacity: 0.48,
        rotationSpeed: (this.nextRand() - 0.5) * 1.5,
      });
      return;
    }

    this.emitInstanceFromPool(this.sparkPool, {
      x: tx,
      y: ty,
      z: tz,
      vx: -dir.x * 1.8 + (this.nextRand() - 0.5) * 0.7,
      vy: -dir.y * 1.8 + 0.2,
      vz: -dir.z * 1.8 + (this.nextRand() - 0.5) * 0.7,
      spinX: 8,
      spinY: 9,
      spinZ: 7,
      gravity: 1.8,
      maxAge: 0.24,
      startScale: 0.95,
      endScale: 0.1,
      sx: 1,
      sy: 1,
      sz: 1,
      colorHex: 0xf97316,
    });
  }

  private nextRand(): number {
    this.pseudoSeed = (this.pseudoSeed * 1664525 + 1013904223) >>> 0;
    return this.pseudoSeed / 0x100000000;
  }
}
