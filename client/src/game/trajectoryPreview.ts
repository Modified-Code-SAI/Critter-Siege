import * as THREE from "three";
import {
  sampleAimArc,
  type GadgetId,
  type PrismWallState,
  type SdfWorld,
  type Vec3,
} from "@critter/shared";

/** Aim parameters passed to TrajectoryPreview.update(). */
export interface TrajectoryPreviewParams {
  gadgetId: GadgetId;
  origin: Vec3;
  direction: Vec3;
  power: number;
  droneTarget?: Vec3;
}

const MAX_ARC_DOTS = 40;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Glowing dotted cyan 3D wind-curved trajectory preview rendered via a single
 * InstancedMesh of smooth spheres plus a subtle glowing landing ring marker,
 * alongside an optional translucent gold Last-Shot Ghost trajectory arc.
 */
export class TrajectoryPreview {
  public readonly group: THREE.Group;

  private readonly dotGeometry: THREE.SphereGeometry;
  private readonly dotMaterial: THREE.MeshBasicMaterial;
  private readonly instancedDots: THREE.InstancedMesh;

  private readonly ringGeometry: THREE.TorusGeometry;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly landingRing: THREE.Mesh;

  private readonly ghostDotGeometry: THREE.SphereGeometry;
  private readonly ghostDotMaterial: THREE.MeshBasicMaterial;
  private readonly ghostDots: THREE.InstancedMesh;

  private readonly ghostRingGeometry: THREE.TorusGeometry;
  private readonly ghostRingMaterial: THREE.MeshBasicMaterial;
  private readonly ghostLandingRing: THREE.Mesh;

  private readonly dummy = new THREE.Object3D();
  private readonly normalVec = new THREE.Vector3();
  private readonly alignQuat = new THREE.Quaternion();
  private readonly flatQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI * 0.5,
  );
  private disposed = false;

  public constructor() {
    this.group = new THREE.Group();
    this.group.name = "trajectory_preview";
    this.group.visible = false;

    this.dotGeometry = new THREE.SphereGeometry(0.11, 10, 8);
    this.dotMaterial = new THREE.MeshBasicMaterial({
      color: 0x4df4ff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });

    this.instancedDots = new THREE.InstancedMesh(
      this.dotGeometry,
      this.dotMaterial,
      MAX_ARC_DOTS,
    );
    this.instancedDots.name = "trajectory_arc_dots";
    this.instancedDots.count = 0;
    this.instancedDots.frustumCulled = false;
    this.group.add(this.instancedDots);

    this.ringGeometry = new THREE.TorusGeometry(0.36, 0.045, 8, 24);
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x7df9ff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.landingRing = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
    this.landingRing.name = "trajectory_landing_ring";
    this.landingRing.visible = false;
    this.landingRing.quaternion.copy(this.flatQuat);
    this.group.add(this.landingRing);

    // Translucent gold Last-Shot Ghost trajectory arc & landing ring
    this.ghostDotGeometry = new THREE.SphereGeometry(0.095, 8, 6);
    this.ghostDotMaterial = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.ghostDots = new THREE.InstancedMesh(
      this.ghostDotGeometry,
      this.ghostDotMaterial,
      MAX_ARC_DOTS,
    );
    this.ghostDots.name = "trajectory_ghost_dots";
    this.ghostDots.count = 0;
    this.ghostDots.frustumCulled = false;
    this.group.add(this.ghostDots);

    this.ghostRingGeometry = new THREE.TorusGeometry(0.38, 0.036, 8, 24);
    this.ghostRingMaterial = new THREE.MeshBasicMaterial({
      color: 0xfde047,
      transparent: true,
      opacity: 0.46,
      depthWrite: false,
    });
    this.ghostLandingRing = new THREE.Mesh(
      this.ghostRingGeometry,
      this.ghostRingMaterial,
    );
    this.ghostLandingRing.name = "trajectory_ghost_landing_ring";
    this.ghostLandingRing.visible = false;
    this.ghostLandingRing.quaternion.copy(this.flatQuat);
    this.group.add(this.ghostLandingRing);
  }

  /**
   * Re-sample the wind-curved deterministic aim arc (and optional Last-Shot Ghost arc)
   * and update all instanced dots plus landing ring markers.
   */
  public update(
    world: SdfWorld,
    params: TrajectoryPreviewParams,
    wind: Vec3,
    extended: boolean,
    visible: boolean,
    ghostParams?: TrajectoryPreviewParams | null,
    prismWalls?: readonly PrismWallState[],
    shooterId?: string,
  ): void {
    if (this.disposed || !visible) {
      this.group.visible = false;
      this.instancedDots.count = 0;
      this.landingRing.visible = false;
      this.ghostDots.count = 0;
      this.ghostLandingRing.visible = false;
      return;
    }

    const activeCount = this.applyArc(
      world,
      params,
      wind,
      extended,
      this.instancedDots,
      this.landingRing,
      prismWalls,
      shooterId,
    );

    const ghostCount = ghostParams
      ? this.applyArc(
          world,
          ghostParams,
          wind,
          extended,
          this.ghostDots,
          this.ghostLandingRing,
          prismWalls,
          shooterId,
        )
      : 0;

    if (!ghostParams || ghostCount === 0) {
      this.ghostDots.count = 0;
      this.ghostLandingRing.visible = false;
    }

    this.group.visible = activeCount > 0 || ghostCount > 0;
  }

  /** Dispose all Three.js geometries and materials cleanly. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dotGeometry.dispose();
    this.dotMaterial.dispose();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
    this.ghostDotGeometry.dispose();
    this.ghostDotMaterial.dispose();
    this.ghostRingGeometry.dispose();
    this.ghostRingMaterial.dispose();
    this.group.clear();
  }

  private applyArc(
    world: SdfWorld,
    params: TrajectoryPreviewParams,
    wind: Vec3,
    extended: boolean,
    dotsMesh: THREE.InstancedMesh,
    ringMesh: THREE.Mesh,
    prismWalls?: readonly PrismWallState[],
    shooterId?: string,
  ): number {
    const points = sampleAimArc(
      world,
      params,
      wind,
      extended,
      prismWalls,
      shooterId,
    );
    const dotCount = Math.min(points.length, MAX_ARC_DOTS);

    if (dotCount === 0) {
      dotsMesh.count = 0;
      ringMesh.visible = false;
      return 0;
    }

    const denom = Math.max(1, dotCount - 1);

    for (let i = 0; i < dotCount; i++) {
      const pt = points[i];
      if (!pt) {
        continue;
      }
      const progress = i / denom;
      // Smooth size taper from 1.05 near shooter down to 0.52 near predicted landing
      const scale = 1.05 - progress * 0.53;
      this.dummy.position.set(pt.x, pt.y, pt.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(scale);
      this.dummy.updateMatrix();
      dotsMesh.setMatrixAt(i, this.dummy.matrix);
    }

    dotsMesh.count = dotCount;
    dotsMesh.instanceMatrix.needsUpdate = true;

    const landing = points[dotCount - 1];
    if (landing && dotCount >= 2) {
      ringMesh.visible = true;
      if (world.isSolid(landing.x, landing.y, landing.z)) {
        const n = world.sampleNormal(landing.x, landing.y, landing.z);
        this.normalVec.set(n.x, n.y, n.z);
        if (this.normalVec.lengthSq() > 1e-4) {
          this.normalVec.normalize();
        } else {
          this.normalVec.copy(WORLD_UP);
        }
        ringMesh.position.set(
          landing.x + this.normalVec.x * 0.08,
          landing.y + this.normalVec.y * 0.08,
          landing.z + this.normalVec.z * 0.08,
        );
        this.alignQuat.setFromUnitVectors(WORLD_UP, this.normalVec);
        ringMesh.quaternion.copy(this.alignQuat).multiply(this.flatQuat);
      } else {
        ringMesh.position.set(landing.x, landing.y + 0.04, landing.z);
        ringMesh.quaternion.copy(this.flatQuat);
      }
    } else {
      ringMesh.visible = false;
    }

    return dotCount;
  }
}
