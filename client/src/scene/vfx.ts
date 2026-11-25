import * as THREE from "three";
import type { EvoPodState, Vec3 } from "@critter/shared";

interface DynamicParticle {
  mesh: THREE.Mesh;
  material: THREE.Material;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  gravity: number;
  age: number;
  maxAge: number;
  startScale: number;
  endScale: number;
  baseScaleVec: THREE.Vector3;
  baseOpacity: number;
  kind: "shard" | "smoke" | "shockwave" | "flash" | "droplet" | "spark";
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
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    } else if (obj instanceof THREE.Line) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    }
  });
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
 * Stylized 3D VFX system for Critter Siege: jagged rock-shard blasts, ocean splashes,
 * parachuting glowing cyan Evo Pods, sunlit wind-stream ribbons, projectile trails, and drone pings.
 */
export class VfxSystem {
  public readonly group: THREE.Group;

  private readonly particleGroup: THREE.Group;
  private readonly evoPodGroup: THREE.Group;
  private readonly windGroup: THREE.Group;

  private readonly sharedGeos: {
    shardDodeca: THREE.DodecahedronGeometry;
    shardTetra: THREE.TetrahedronGeometry;
    smoke: THREE.SphereGeometry;
    droplet: THREE.SphereGeometry;
    shockRing: THREE.TorusGeometry;
    flash: THREE.SphereGeometry;
    spark: THREE.OctahedronGeometry;
    ribbon: THREE.CylinderGeometry;
  };

  private readonly particles: DynamicParticle[] = [];
  private readonly evoPods: Map<string, EvoPodVisual> = new Map();
  private readonly windRibbons: WindRibbon[] = [];

  private readonly projectileGroup: THREE.Group;
  private readonly projectileCoreMat: THREE.MeshStandardMaterial;
  private readonly projectileRingMat: THREE.MeshBasicMaterial;
  private lastProjectilePos: THREE.Vector3 | null = null;

  private readonly dronePingGroup: THREE.Group;
  private readonly droneOuterRing: THREE.Mesh;
  private readonly droneInnerRing: THREE.Mesh;

  private pseudoSeed = 1337;

  public constructor() {
    this.group = new THREE.Group();
    this.group.name = "vfx_system";

    this.particleGroup = new THREE.Group();
    this.particleGroup.name = "vfx_particles";
    this.group.add(this.particleGroup);

    this.evoPodGroup = new THREE.Group();
    this.evoPodGroup.name = "vfx_evo_pods";
    this.group.add(this.evoPodGroup);

    this.windGroup = new THREE.Group();
    this.windGroup.name = "vfx_wind_ribbons";
    this.group.add(this.windGroup);

    const ribbonGeo = new THREE.CylinderGeometry(0.014, 0.048, 3.0, 6, 1, true);
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
    };

    // Build translucent sunlit wind-stream ribbons
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.sharedGeos.ribbon, mat);
      mesh.position.set(
        2 + this.nextRand() * 20,
        5.5 + this.nextRand() * 7.5,
        2 + this.nextRand() * 20,
      );
      this.windGroup.add(mesh);
      this.windRibbons.push({
        mesh,
        material: mat,
        speedFactor: 0.75 + this.nextRand() * 0.55,
        phase: this.nextRand() * Math.PI * 2,
      });
    }

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
      const paletteColor =
        ROCK_SHARD_PALETTE[i % ROCK_SHARD_PALETTE.length] ?? 0xb96c43;
      const shardMat = new THREE.MeshStandardMaterial({
        color: paletteColor,
        roughness: 0.85,
        metalness: 0.05,
        flatShading: true,
        transparent: true,
        opacity: 1.0,
      });
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
        endScale: 0.15,
        baseScaleVec,
        baseOpacity: 1.0,
        kind: "shard",
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

  /** Synchronize glowing cyan Evo Pods and parachutes with authoritative match state. */
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

      let visual = this.evoPods.get(pod.id);
      if (!visual) {
        visual = this.createEvoPodVisual(pod.id);
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

  /** Animate sunlit white wind ribbons streaming in the exact 3D wind direction and speed. */
  public updateWindRibbons(wind: Vec3, dtSec: number): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    const speed = Math.hypot(wind.x, wind.y, wind.z);
    const hasWind = Number.isFinite(speed) && speed > 0.08;

    const dir = hasWind
      ? new THREE.Vector3(wind.x / speed, wind.y / speed, wind.z / speed)
      : new THREE.Vector3(1, 0, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(FORWARD_Z, dir);
    const driftSpeed = hasWind ? Math.max(1.8, speed * 1.35) : 0.4;
    const targetOpacity = hasWind ? Math.min(0.45, 0.12 + speed * 0.045) : 0.06;

    for (const ribbon of this.windRibbons) {
      ribbon.mesh.quaternion.copy(quat);
      ribbon.mesh.position.addScaledVector(
        dir,
        driftSpeed * ribbon.speedFactor * safeDt,
      );
      ribbon.mesh.position.x = wrapCoord(ribbon.mesh.position.x, -2, 26);
      ribbon.mesh.position.y = wrapCoord(ribbon.mesh.position.y, 4.5, 13.5);
      ribbon.mesh.position.z = wrapCoord(ribbon.mesh.position.z, -2, 26);
      ribbon.material.opacity = targetOpacity;
      const stretch = hasWind ? Math.min(1.8, 0.75 + speed * 0.14) : 0.55;
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

  /** Advance active VFX particle lifetimes, spins, fades, and clean up expired effects. */
  public update(dtSec: number, elapsedSec: number): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      if (!p) {
        continue;
      }
      p.age += safeDt;
      if (p.age >= p.maxAge) {
        this.particleGroup.remove(p.mesh);
        p.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }

      const frac = p.age / p.maxAge;
      p.velocity.y -= p.gravity * safeDt;
      p.mesh.position.addScaledVector(p.velocity, safeDt);
      p.mesh.rotation.x += p.spin.x * safeDt;
      p.mesh.rotation.y += p.spin.y * safeDt;
      p.mesh.rotation.z += p.spin.z * safeDt;

      const s = p.startScale + (p.endScale - p.startScale) * frac;
      p.mesh.scale.set(
        p.baseScaleVec.x * s,
        p.baseScaleVec.y * s,
        p.baseScaleVec.z * s,
      );

      if (
        p.material instanceof THREE.MeshBasicMaterial ||
        p.material instanceof THREE.MeshStandardMaterial
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

  /** Dispose all active particles, Evo Pods, wind ribbons, markers, and shared geometries. */
  public dispose(): void {
    for (const p of this.particles) {
      this.particleGroup.remove(p.mesh);
      p.material.dispose();
    }
    this.particles.length = 0;

    for (const visual of this.evoPods.values()) {
      this.evoPodGroup.remove(visual.group);
      disposeObjectTree(visual.group);
    }
    this.evoPods.clear();

    for (const ribbon of this.windRibbons) {
      this.windGroup.remove(ribbon.mesh);
      ribbon.material.dispose();
    }
    this.windRibbons.length = 0;

    disposeObjectTree(this.projectileGroup);
    disposeObjectTree(this.dronePingGroup);

    this.sharedGeos.shardDodeca.dispose();
    this.sharedGeos.shardTetra.dispose();
    this.sharedGeos.smoke.dispose();
    this.sharedGeos.droplet.dispose();
    this.sharedGeos.shockRing.dispose();
    this.sharedGeos.flash.dispose();
    this.sharedGeos.spark.dispose();
    this.sharedGeos.ribbon.dispose();
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

  private createEvoPodVisual(id: string): EvoPodVisual {
    const group = new THREE.Group();
    group.name = `evo_pod_${id}`;

    // Glowing cyan icosahedral pod core + hexagonal energy collar
    const podCore = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32, 0),
      new THREE.MeshStandardMaterial({
        color: 0x38f2ff,
        emissive: 0x10cce8,
        emissiveIntensity: 0.95,
        roughness: 0.2,
        metalness: 0.25,
      }),
    );
    podCore.castShadow = true;

    const hexCollar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.38, 0.38, 0.12, 6, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xd8faff,
        emissive: 0x26d8f8,
        emissiveIntensity: 0.6,
        roughness: 0.3,
        metalness: 0.7,
        side: THREE.DoubleSide,
      }),
    );
    podCore.add(hexCollar);
    group.add(podCore);

    // Open canopy parachute + 4 suspension cords for airborne descent
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
        color: 0xf0fdff,
        emissive: 0x38d8f0,
        emissiveIntensity: 0.2,
        roughness: 0.6,
        side: THREE.DoubleSide,
      }),
    );
    canopy.position.y = 1.05;
    parachuteGroup.add(canopy);

    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI * 0.25;
      const cord = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 1.15, 6),
        new THREE.MeshBasicMaterial({ color: 0xbff7ff }),
      );
      cord.position.set(Math.cos(a) * 0.34, 0.62, Math.sin(a) * 0.34);
      cord.rotation.set(Math.sin(a) * 0.42, 0, -Math.cos(a) * 0.42);
      parachuteGroup.add(cord);
    }
    group.add(parachuteGroup);

    // Translucent landed beacon column
    const beaconMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.42, 2.8, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x38f2ff,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    beaconMesh.position.y = 1.35;
    group.add(beaconMesh);

    return { group, podCore, parachuteGroup, beaconMesh };
  }

  private nextRand(): number {
    this.pseudoSeed = (this.pseudoSeed * 1664525 + 1013904223) >>> 0;
    return this.pseudoSeed / 0x100000000;
  }
}
