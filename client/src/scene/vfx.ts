import * as THREE from "three";
import {
  SDF_DIMS,
  type EvoPodState,
  type PrismWallState,
  type Vec3,
} from "@critter/shared";

const WORLD_SPAN_X = SDF_DIMS.nx * SDF_DIMS.voxelSize;
const WORLD_SPAN_Y = SDF_DIMS.ny * SDF_DIMS.voxelSize;
const WORLD_SPAN_Z = SDF_DIMS.nz * SDF_DIMS.voxelSize;
const POLLEN_MOTE_COUNT = 110;
const WIND_RIBBON_COUNT = 22;

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
  kind: "shard" | "smoke" | "shockwave" | "flash" | "droplet" | "spark" | "beam";
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
}

interface WindRibbon {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  speedFactor: number;
  phase: number;
}

const FORWARD_Z = new THREE.Vector3(0, 0, 1);
const ROCK_SHARD_PALETTE: readonly number[] = [
  0xb96c43,
  0x9a5938,
  0x7a7673,
  0xc98b5b,
  0x5e6268,
];

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
    }
  });
  for (const g of geos) {
    g.dispose();
  }
  for (const m of mats) {
    m.dispose();
  }
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

/**
 * Stylized 3D VFX system for Critter Siege: jagged rock-shard blasts, Blast Barrel
 * chain-explosions, Thermal Geyser steam bursts, ocean splashes, drifting golden
 * sunlit pollen motes, parachuting Evo Pods, scaled wind ribbons, and drone pings.
 */
export class VfxSystem {
  public readonly group: THREE.Group;

  private readonly particleGroup: THREE.Group;
  private readonly evoPodGroup: THREE.Group;
  private readonly prismWallGroup: THREE.Group;
  private readonly windGroup: THREE.Group;
  private readonly pollenPoints: THREE.Points;
  private readonly pollenPhases: Float32Array;
  private readonly pollenSpeeds: Float32Array;
  private lastWind: Vec3 = { x: 1.0, y: 0, z: 0.4 };

  private readonly sharedGeos: {
    shardDodeca: THREE.DodecahedronGeometry;
    shardTetra: THREE.TetrahedronGeometry;
    smoke: THREE.SphereGeometry;
    droplet: THREE.SphereGeometry;
    shockRing: THREE.TorusGeometry;
    flash: THREE.SphereGeometry;
    spark: THREE.OctahedronGeometry;
    ribbon: THREE.CylinderGeometry;
    grappleBeam: THREE.CylinderGeometry;
  };

  private readonly shardPaletteMaterials: THREE.MeshStandardMaterial[];
  private readonly prismShardMaterial: THREE.MeshStandardMaterial;
  private readonly tempVec = new THREE.Vector3();

  private readonly particles: DynamicParticle[] = [];
  private readonly evoPods: Map<string, EvoPodVisual> = new Map();
  private readonly prismWallVisuals = new Map<string, PrismWallVisual>();
  private readonly windRibbons: WindRibbon[] = [];

  private readonly projectileGroup: THREE.Group;
  private readonly projectileCoreMat: THREE.MeshStandardMaterial;
  private readonly projectileRingMat: THREE.MeshBasicMaterial;
  private lastProjectilePos: THREE.Vector3 | null = null;

  private readonly dronePingGroup: THREE.Group;
  private readonly droneOuterRing: THREE.Mesh;
  private readonly droneInnerRing: THREE.Mesh;

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

    this.evoPodGroup = new THREE.Group();
    this.evoPodGroup.name = "vfx_evo_pods";
    this.group.add(this.evoPodGroup);

    this.prismWallGroup = new THREE.Group();
    this.prismWallGroup.name = "vfx_prism_walls";
    this.group.add(this.prismWallGroup);

    this.windGroup = new THREE.Group();
    this.windGroup.name = "vfx_wind_ribbons";
    this.group.add(this.windGroup);

    const ribbonGeo = new THREE.CylinderGeometry(0.02, 0.062, 4.6, 6, 1, true);
    ribbonGeo.rotateX(Math.PI * 0.5);

    this.sharedGeos = {
      shardDodeca: new THREE.DodecahedronGeometry(0.18, 0),
      shardTetra: new THREE.TetrahedronGeometry(0.18, 0),
      smoke: new THREE.SphereGeometry(0.32, 10, 8),
      droplet: new THREE.SphereGeometry(0.11, 8, 6),
      shockRing: new THREE.TorusGeometry(0.5, 0.06, 8, 28),
      flash: new THREE.SphereGeometry(0.52, 12, 10),
      spark: new THREE.OctahedronGeometry(0.085, 0),
      ribbon: ribbonGeo,
      grappleBeam: new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8, 1, false),
    };

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

    // Build translucent sunlit wind-stream ribbons spanning the 60m archipelago sky
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

    // Drifting golden sunlit ambient pollen motes floating lazily above the archipelago
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
      size: 0.26,
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.pollenPoints = new THREE.Points(pollenGeo, pollenMat);
    this.pollenPoints.name = "vfx_pollen_motes";
    this.group.add(this.pollenPoints);

    // Glowing projectile energy shell
    this.projectileGroup = new THREE.Group();
    this.projectileGroup.name = "vfx_projectile";
    this.projectileGroup.visible = false;

    this.projectileCoreMat = new THREE.MeshStandardMaterial({
      color: 0xffb347,
      emissive: 0xff8c24,
      emissiveIntensity: 1.2,
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
    this.projectileGroup.add(projCore, projRing);
    this.group.add(this.projectileGroup);

    // Glowing cyan drone recon target ping
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

    this.dronePingGroup.add(this.droneOuterRing, this.droneInnerRing, pingBeam);
    this.group.add(this.dronePingGroup);
  }

  /**
   * Spawn a stylized blast with an expanding shockwave ring, smoke puffs,
   * and 14-22 tumbling jagged rock shards (DodecahedronGeometry / TetrahedronGeometry).
   */
  public spawnExplosion(
    position: Vec3,
    radius: number,
    isPull = false,
  ): void {
    const safeRadius = Number.isFinite(radius) ? Math.max(0.6, radius) : 1.6;
    const accentColor = isPull ? 0x38f2ff : 0xff8a2b;
    const coreColor = isPull ? 0xa6fbff : 0xffe48f;

    // Expanding shockwave ring
    const ringMat = new THREE.MeshBasicMaterial({
      color: accentColor,
      transparent: true,
      opacity: 0.92,
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

    // Core flash sphere
    const flashMat = new THREE.MeshBasicMaterial({
      color: coreColor,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const flashMesh = new THREE.Mesh(this.sharedGeos.flash, flashMat);
    flashMesh.position.set(position.x, position.y, position.z);
    this.particleGroup.add(flashMesh);
    this.particles.push({
      mesh: flashMesh,
      material: flashMat,
      velocity: new THREE.Vector3(0, 0.4, 0),
      spin: new THREE.Vector3(0, 0, 0),
      gravity: 0,
      age: 0,
      maxAge: 0.26,
      startScale: 0.45,
      endScale: safeRadius * 1.15,
      baseScaleVec: new THREE.Vector3(1, 1, 1),
      baseOpacity: 0.9,
      kind: "flash",
    });

    // Rising stylized smoke puffs
    const smokeCount = 6;
    for (let i = 0; i < smokeCount; i++) {
      const angle = (i / smokeCount) * Math.PI * 2 + this.nextRand() * 0.5;
      const spread = (0.35 + this.nextRand() * 0.65) * safeRadius * 0.4;
      const smokeMat = new THREE.MeshStandardMaterial({
        color: isPull ? 0xb4f3ff : 0xf4eee6,
        roughness: 0.95,
        metalness: 0.0,
        transparent: true,
        opacity: 0.72,
      });
      const smokeMesh = new THREE.Mesh(this.sharedGeos.smoke, smokeMat);
      smokeMesh.position.set(
        position.x + Math.cos(angle) * spread,
        position.y + 0.15 + this.nextRand() * 0.35,
        position.z + Math.sin(angle) * spread,
      );
      this.particleGroup.add(smokeMesh);
      this.particles.push({
        mesh: smokeMesh,
        material: smokeMat,
        velocity: new THREE.Vector3(
          Math.cos(angle) * (0.8 + this.nextRand() * 1.0),
          1.4 + this.nextRand() * 1.6,
          Math.sin(angle) * (0.8 + this.nextRand() * 1.0),
        ),
        spin: new THREE.Vector3(0.4, 0.6, 0.3),
        gravity: -0.6,
        age: 0,
        maxAge: 0.75 + this.nextRand() * 0.35,
        startScale: 0.45,
        endScale: 1.55 + safeRadius * 0.25,
        baseScaleVec: new THREE.Vector3(1, 1, 1),
        baseOpacity: 0.72,
        kind: "smoke",
      });
    }

    // 14-22 tumbling irregular faceted rock shards (NEVER BoxGeometry)
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
  }

  /** Spawn a fiery crimson-amber Blast Barrel chain-explosion with double shockwave & ember shower. */
  public spawnBarrelExplosion(position: Vec3, radius = 2.8): void {
    const safeRadius = Number.isFinite(radius) ? Math.max(1.4, radius) : 2.8;
    this.spawnExplosion(position, safeRadius, false);

    // Secondary fiery crimson shockwave ring
    const crimsonRingMat = new THREE.MeshBasicMaterial({
      color: 0xff3d1f,
      transparent: true,
      opacity: 0.95,
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

    // Fiery ember octahedron sparks flying in high arcs
    for (let i = 0; i < 16; i++) {
      const emberMat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xffb82e : 0xff4b1f,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      });
      const emberMesh = new THREE.Mesh(this.sharedGeos.spark, emberMat);
      const angle = (i / 16) * Math.PI * 2 + this.nextRand() * 0.4;
      const spd = 4.2 + this.nextRand() * 5.8;
      emberMesh.position.set(position.x, position.y + 0.4, position.z);
      this.particleGroup.add(emberMesh);
      this.particles.push({
        mesh: emberMesh,
        material: emberMat,
        velocity: new THREE.Vector3(
          Math.cos(angle) * spd,
          4.5 + this.nextRand() * 5.5,
          Math.sin(angle) * spd,
        ),
        spin: new THREE.Vector3(8, 10, 7),
        gravity: 12.5,
        age: 0,
        maxAge: 0.65 + this.nextRand() * 0.45,
        startScale: 1.5,
        endScale: 0.15,
        baseScaleVec: new THREE.Vector3(1, 1, 1),
        baseOpacity: 0.95,
        kind: "spark",
      });
    }
  }

  /** Spawn a pressurized vertical Thermal Steam Geyser eruption plume & sky-cyan launch ring. */
  public spawnGeyserBurst(position: Vec3): void {
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x7ef9ff,
      transparent: true,
      opacity: 0.9,
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

    // Billowing pressurized steam column
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + this.nextRand() * 0.35;
      const steamMat = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0xbefaff : 0xf2ffff,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
      });
      const steamMesh = new THREE.Mesh(this.sharedGeos.smoke, steamMat);
      steamMesh.position.set(
        position.x + Math.cos(a) * 0.25,
        position.y + 0.25 + i * 0.12,
        position.z + Math.sin(a) * 0.25,
      );
      this.particleGroup.add(steamMesh);
      this.particles.push({
        mesh: steamMesh,
        material: steamMat,
        velocity: new THREE.Vector3(
          Math.cos(a) * (0.4 + this.nextRand() * 0.9),
          7.5 + this.nextRand() * 5.5,
          Math.sin(a) * (0.4 + this.nextRand() * 0.9),
        ),
        spin: new THREE.Vector3(0.5, 1.2, 0.5),
        gravity: 2.5,
        age: 0,
        maxAge: 0.72 + this.nextRand() * 0.4,
        startScale: 0.65,
        endScale: 2.35,
        baseScaleVec: new THREE.Vector3(1, 1.15, 1),
        baseOpacity: 0.78,
        kind: "smoke",
      });
    }

    // Sparkling geothermal spray droplets
    for (let i = 0; i < 10; i++) {
      const a = this.nextRand() * Math.PI * 2;
      const dropMat = new THREE.MeshBasicMaterial({
        color: 0x76f7ff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const dropMesh = new THREE.Mesh(this.sharedGeos.droplet, dropMat);
      dropMesh.position.set(position.x, position.y + 0.3, position.z);
      this.particleGroup.add(dropMesh);
      this.particles.push({
        mesh: dropMesh,
        material: dropMat,
        velocity: new THREE.Vector3(
          Math.cos(a) * (1.2 + this.nextRand() * 1.8),
          9.5 + this.nextRand() * 5.0,
          Math.sin(a) * (1.2 + this.nextRand() * 1.8),
        ),
        spin: new THREE.Vector3(0, 0, 0),
        gravity: 15.0,
        age: 0,
        maxAge: 0.75 + this.nextRand() * 0.35,
        startScale: 1.0,
        endScale: 0.2,
        baseScaleVec: new THREE.Vector3(1, 1.4, 1),
        baseOpacity: 0.9,
        kind: "droplet",
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

    const dropletCount = 14;
    for (let i = 0; i < dropletCount; i++) {
      const angle = (i / dropletCount) * Math.PI * 2 + this.nextRand() * 0.35;
      const radialSpeed = 1.6 + this.nextRand() * 2.6;
      const dropMat = new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? 0x62f2ff : 0xe4ffff,
        roughness: 0.2,
        metalness: 0.05,
        transparent: true,
        opacity: 0.9,
      });
      const dropMesh = new THREE.Mesh(this.sharedGeos.droplet, dropMat);
      dropMesh.position.set(position.x, position.y + 0.08, position.z);
      this.particleGroup.add(dropMesh);
      this.particles.push({
        mesh: dropMesh,
        material: dropMat,
        velocity: new THREE.Vector3(
          Math.cos(angle) * radialSpeed,
          4.2 + this.nextRand() * 3.4,
          Math.sin(angle) * radialSpeed,
        ),
        spin: new THREE.Vector3(0, 0, 0),
        gravity: 16.5,
        age: 0,
        maxAge: 0.65 + this.nextRand() * 0.35,
        startScale: 1.0,
        endScale: 0.2,
        baseScaleVec: new THREE.Vector3(1, 1.3, 1),
        baseOpacity: 0.9,
        kind: "droplet",
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

    // Glowing anchor burst rings at origin & destination
    for (const pt of [start, end]) {
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x6ee7b7,
        transparent: true,
        opacity: 0.92,
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
    }

    // Trailing emerald rope sparks spaced cleanly along the tether line
    const sparkCount = Math.min(10, Math.max(4, Math.floor(dist / 2.2)));
    for (let i = 0; i < sparkCount; i++) {
      const frac = (i + 0.5) / sparkCount;
      const pt = start.clone().addScaledVector(delta, frac);
      const sparkMat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0x34d399 : 0x5eead4,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      });
      const sparkMesh = new THREE.Mesh(this.sharedGeos.spark, sparkMat);
      sparkMesh.position.copy(pt);
      this.particleGroup.add(sparkMesh);
      this.particles.push({
        mesh: sparkMesh,
        material: sparkMat,
        velocity: new THREE.Vector3(
          (this.nextRand() - 0.5) * 1.4,
          0.6 + this.nextRand() * 1.2,
          (this.nextRand() - 0.5) * 1.4,
        ),
        spin: new THREE.Vector3(6, 7, 5),
        gravity: 3.2,
        age: 0,
        maxAge: 0.45 + this.nextRand() * 0.25,
        startScale: 1.15,
        endScale: 0.1,
        baseScaleVec: new THREE.Vector3(1, 1, 1),
        baseOpacity: 0.92,
        kind: "spark",
      });
    }
  }

  /**
   * Maintain a live taut glowing 3D vine tether between a gliding critter and its cliff anchor
   * during the 0.42s animated grapple reel-up / rappel. Pass `from = null` to release & dispose.
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
        existing.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            disposeMaterial(obj.material);
          }
        });
      }
      return;
    }

    const start = new THREE.Vector3(from.x, from.y + 0.55, from.z);
    const end = new THREE.Vector3(to.x, to.y + 0.45, to.z);
    const delta = end.clone().sub(start);
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
      tetherGroup.add(outerMesh, coreMesh);
      this.group.add(tetherGroup);
    }

    const dir = delta.clone().divideScalar(dist);
    const mid = start.clone().addScaledVector(delta, 0.5);
    const upY = new THREE.Vector3(0, 1, 0);
    tetherGroup.position.copy(mid);
    tetherGroup.quaternion.setFromUnitVectors(upY, dir);

    const outer = tetherGroup.getObjectByName("tether_outer");
    if (outer) {
      outer.scale.set(1.15, dist, 1.15);
    }
    const core = tetherGroup.getObjectByName("tether_core");
    if (core) {
      core.scale.set(0.42, dist, 0.42);
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

  /** Position the glowing artillery shell and emit trailing sparks during Shot Cam. */
  public setProjectileVisual(
    position: Vec3 | null,
    gadgetColor?: number,
  ): void {
    if (!position) {
      this.projectileGroup.visible = false;
      this.lastProjectilePos = null;
      return;
    }

    const color = gadgetColor ?? 0xffb347;
    this.projectileCoreMat.color.setHex(color);
    this.projectileCoreMat.emissive.setHex(color);
    this.projectileRingMat.color.setHex(color);

    this.projectileGroup.visible = true;
    this.projectileGroup.position.set(position.x, position.y, position.z);

    if (
      !this.lastProjectilePos ||
      this.lastProjectilePos.distanceToSquared(this.projectileGroup.position) > 0.04
    ) {
      this.spawnProjectileSpark(position, color);
      this.lastProjectilePos = this.projectileGroup.position.clone();
    }
  }

  /** Show or hide the glowing cyan Drone Recon ground target ring. */
  public setDronePing(position: Vec3 | null): void {
    if (!position) {
      this.dronePingGroup.visible = false;
      return;
    }
    this.dronePingGroup.visible = true;
    this.dronePingGroup.position.set(position.x, position.y, position.z);
  }

  /** Advance active VFX particle lifetimes, sunlit pollen drift, spins, fades, and cleanup. */
  public update(dtSec: number, elapsedSec: number): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;

    // Gentle sunlit golden pollen motes drifting in the island breeze
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
        const fade = p.kind === "shard" ? Math.min(1, (1 - frac) * 2.2) : 1 - frac;
        p.material.opacity = Math.max(0, p.baseOpacity * fade);
      }
    }

    if (this.projectileGroup.visible) {
      this.projectileGroup.rotation.y += safeDt * 7.5;
      this.projectileGroup.rotation.x += safeDt * 4.5;
    }

    if (this.dronePingGroup.visible) {
      const pulse = 1.0 + Math.sin(t * 5.2) * 0.12;
      this.droneOuterRing.scale.set(pulse, pulse, 1);
      this.droneInnerRing.rotation.z = t * 2.4;
    }
  }

  /** Dispose all active particles, pollen motes, Evo Pods, Prism Walls, wind ribbons, markers, shared materials, and shared geometries. */
  public dispose(): void {
    for (const p of this.particles) {
      this.disposeParticle(p);
    }
    this.particles.length = 0;

    for (let i = this.group.children.length - 1; i >= 0; i--) {
      const child = this.group.children[i];
      if (child && child.userData.isGrappleTether === true) {
        this.group.remove(child);
        child.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            disposeMaterial(obj.material);
          }
        });
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
    disposeObjectTree(this.dronePingGroup);

    for (const mat of this.shardPaletteMaterials) {
      mat.dispose();
    }
    this.prismShardMaterial.dispose();

    this.sharedGeos.shardDodeca.dispose();
    this.sharedGeos.shardTetra.dispose();
    this.sharedGeos.smoke.dispose();
    this.sharedGeos.droplet.dispose();
    this.sharedGeos.shockRing.dispose();
    this.sharedGeos.flash.dispose();
    this.sharedGeos.spark.dispose();
    this.sharedGeos.ribbon.dispose();
    this.sharedGeos.grappleBeam.dispose();
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
    const sparkMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const sparkMesh = new THREE.Mesh(this.sharedGeos.spark, sparkMat);
    sparkMesh.position.set(
      position.x + (this.nextRand() - 0.5) * 0.12,
      position.y + (this.nextRand() - 0.5) * 0.12,
      position.z + (this.nextRand() - 0.5) * 0.12,
    );
    this.particleGroup.add(sparkMesh);
    this.particles.push({
      mesh: sparkMesh,
      material: sparkMat,
      velocity: new THREE.Vector3(
        (this.nextRand() - 0.5) * 0.8,
        0.4 + this.nextRand() * 0.6,
        (this.nextRand() - 0.5) * 0.8,
      ),
      spin: new THREE.Vector3(4, 5, 3),
      gravity: 1.5,
      age: 0,
      maxAge: 0.34,
      startScale: 1.0,
      endScale: 0.1,
      baseScaleVec: new THREE.Vector3(1, 1, 1),
      baseOpacity: 0.9,
      kind: "spark",
    });
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

    return { group, podCore, parachuteGroup, beaconMesh };
  }

  private nextRand(): number {
    this.pseudoSeed = (this.pseudoSeed * 1664525 + 1013904223) >>> 0;
    return this.pseudoSeed / 0x100000000;
  }
}
