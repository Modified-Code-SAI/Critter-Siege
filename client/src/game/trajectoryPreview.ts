import * as THREE from "three";
import {
  GALE_SCATTER_CONE_MIN_DOT,
  GALE_SCATTER_REACH,
  sampleAimArc,
  sampleGrappleTarget,
  type EvoPodState,
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
  grappleReach?: number;
  waterLevel?: number;
  evoPods?: readonly EvoPodState[];
}

const MAX_ARC_DOTS = 40;
const DEFAULT_GRAPPLE_REACH = 18;
const DEFAULT_WATER_LEVEL = 1.8;
const SCATTER_CONE_RADIUS =
  GALE_SCATTER_REACH * Math.tan(Math.acos(GALE_SCATTER_CONE_MIN_DOT));
const SCATTER_RAY_COUNT = 5;
const GRAPPLE_TERRAIN_COLOR = 0x34d399;
const GRAPPLE_POD_COLOR = 0xfacc15;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * Glowing dotted cyan 3D wind-curved trajectory preview rendered via a single
 * InstancedMesh of smooth spheres plus a subtle glowing landing ring marker,
 * alongside an optional translucent gold Last-Shot Ghost trajectory arc,
 * a Gale Scatter wide-cone wind-shotgun spread preview, and a Vine Grapple
 * latch beam & target ring preview.
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

  private readonly scatterConeGroup: THREE.Group;
  private readonly scatterShellGeometry: THREE.ConeGeometry;
  private readonly scatterShellMaterial: THREE.MeshBasicMaterial;
  private readonly scatterRingGeometry: THREE.TorusGeometry;
  private readonly scatterRingMaterial: THREE.MeshBasicMaterial;
  private readonly scatterRaysGeometry: THREE.BufferGeometry;
  private readonly scatterRaysMaterial: THREE.LineBasicMaterial;

  private readonly grapplePreviewGroup: THREE.Group;
  private readonly grappleBeamGeometry: THREE.CylinderGeometry;
  private readonly grappleBeamMaterial: THREE.MeshBasicMaterial;
  private readonly grappleBeam: THREE.Mesh;
  private readonly grappleRingGeometry: THREE.TorusGeometry;
  private readonly grappleRingMaterial: THREE.MeshBasicMaterial;
  private readonly grappleLatchRing: THREE.Mesh;

  private readonly dummy = new THREE.Object3D();
  private readonly normalVec = new THREE.Vector3();
  private readonly dirVec = new THREE.Vector3();
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

    // Gale Scatter (quake_club) wide-cone wind-shotgun aim preview
    this.scatterConeGroup = new THREE.Group();
    this.scatterConeGroup.name = "gale_scatter_cone";
    this.scatterConeGroup.visible = false;

    this.scatterShellGeometry = new THREE.ConeGeometry(
      SCATTER_CONE_RADIUS,
      GALE_SCATTER_REACH,
      24,
      1,
      true,
    );
    this.scatterShellGeometry.rotateX(-Math.PI * 0.5);
    this.scatterShellGeometry.translate(0, 0, GALE_SCATTER_REACH * 0.5);
    this.scatterShellMaterial = new THREE.MeshBasicMaterial({
      color: 0x38e8ff,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const scatterShellMesh = new THREE.Mesh(
      this.scatterShellGeometry,
      this.scatterShellMaterial,
    );
    scatterShellMesh.name = "gale_scatter_cone_shell";
    this.scatterConeGroup.add(scatterShellMesh);

    this.scatterRingGeometry = new THREE.TorusGeometry(
      SCATTER_CONE_RADIUS,
      0.048,
      8,
      32,
    );
    this.scatterRingMaterial = new THREE.MeshBasicMaterial({
      color: 0xfb7185,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
    });
    const scatterMouthRing = new THREE.Mesh(
      this.scatterRingGeometry,
      this.scatterRingMaterial,
    );
    scatterMouthRing.name = "gale_scatter_mouth_ring";
    scatterMouthRing.position.set(0, 0, GALE_SCATTER_REACH);
    this.scatterConeGroup.add(scatterMouthRing);

    const rayPositions = new Float32Array(SCATTER_RAY_COUNT * 2 * 3);
    for (let i = 0; i < SCATTER_RAY_COUNT; i++) {
      const angle = (i / SCATTER_RAY_COUNT) * Math.PI * 2;
      const base = i * 6;
      rayPositions[base] = 0;
      rayPositions[base + 1] = 0;
      rayPositions[base + 2] = 0;
      rayPositions[base + 3] = Math.cos(angle) * SCATTER_CONE_RADIUS;
      rayPositions[base + 4] = Math.sin(angle) * SCATTER_CONE_RADIUS;
      rayPositions[base + 5] = GALE_SCATTER_REACH;
    }
    this.scatterRaysGeometry = new THREE.BufferGeometry();
    this.scatterRaysGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(rayPositions, 3),
    );
    this.scatterRaysMaterial = new THREE.LineBasicMaterial({
      color: 0xfda4af,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const scatterWindRays = new THREE.LineSegments(
      this.scatterRaysGeometry,
      this.scatterRaysMaterial,
    );
    scatterWindRays.name = "gale_scatter_wind_rays";
    this.scatterConeGroup.add(scatterWindRays);
    this.group.add(this.scatterConeGroup);

    // Vine Grapple straight latch beam & target ring preview
    this.grapplePreviewGroup = new THREE.Group();
    this.grapplePreviewGroup.name = "grapple_latch_preview";
    this.grapplePreviewGroup.visible = false;

    this.grappleBeamGeometry = new THREE.CylinderGeometry(0.032, 0.032, 1, 8, 1);
    this.grappleBeamMaterial = new THREE.MeshBasicMaterial({
      color: GRAPPLE_TERRAIN_COLOR,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    this.grappleBeam = new THREE.Mesh(
      this.grappleBeamGeometry,
      this.grappleBeamMaterial,
    );
    this.grappleBeam.name = "grapple_latch_beam";
    this.grapplePreviewGroup.add(this.grappleBeam);

    this.grappleRingGeometry = new THREE.TorusGeometry(0.46, 0.055, 8, 28);
    this.grappleRingMaterial = new THREE.MeshBasicMaterial({
      color: GRAPPLE_TERRAIN_COLOR,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.grappleLatchRing = new THREE.Mesh(
      this.grappleRingGeometry,
      this.grappleRingMaterial,
    );
    this.grappleLatchRing.name = "grapple_latch_ring";
    this.grappleLatchRing.quaternion.copy(this.flatQuat);
    this.grapplePreviewGroup.add(this.grappleLatchRing);
    this.group.add(this.grapplePreviewGroup);
  }

  /**
   * Re-sample the wind-curved deterministic aim arc (and optional Last-Shot Ghost arc),
   * Gale Scatter wind-shotgun cone, or Vine Grapple latch target marker.
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
      this.hideAll();
      return;
    }

    if (params.gadgetId === "quake_club") {
      this.hideBallisticArcs();
      this.grapplePreviewGroup.visible = false;

      this.dirVec.set(params.direction.x, params.direction.y, params.direction.z);
      if (
        !Number.isFinite(this.dirVec.x) ||
        !Number.isFinite(this.dirVec.y) ||
        !Number.isFinite(this.dirVec.z) ||
        this.dirVec.lengthSq() <= 1e-6
      ) {
        this.scatterConeGroup.visible = false;
        this.group.visible = false;
        return;
      }
      this.dirVec.normalize();
      this.scatterConeGroup.position.set(
        params.origin.x,
        params.origin.y,
        params.origin.z,
      );
      this.scatterConeGroup.quaternion.setFromUnitVectors(
        LOCAL_FORWARD,
        this.dirVec,
      );
      this.scatterConeGroup.visible = true;
      this.group.visible = true;
      return;
    }

    if (params.gadgetId === "vine_grapple") {
      this.hideBallisticArcs();
      this.scatterConeGroup.visible = false;

      const hit = sampleGrappleTarget(
        world,
        params.origin,
        params.direction,
        params.grappleReach ?? DEFAULT_GRAPPLE_REACH,
        params.waterLevel ?? DEFAULT_WATER_LEVEL,
        params.evoPods,
      );
      if (!hit) {
        this.grapplePreviewGroup.visible = false;
        this.group.visible = false;
        return;
      }

      const dx = hit.target.x - params.origin.x;
      const dy = hit.target.y - params.origin.y;
      const dz = hit.target.z - params.origin.z;
      const dist = Math.hypot(dx, dy, dz);

      this.grappleBeam.position.set(
        params.origin.x + dx * 0.5,
        params.origin.y + dy * 0.5,
        params.origin.z + dz * 0.5,
      );
      this.grappleBeam.scale.set(1, Math.max(0.05, dist), 1);
      if (dist > 1e-4) {
        this.dirVec.set(dx / dist, dy / dist, dz / dist);
        this.grappleBeam.quaternion.setFromUnitVectors(WORLD_UP, this.dirVec);
      } else {
        this.grappleBeam.quaternion.identity();
      }

      this.grappleRingMaterial.color.setHex(
        hit.isPod ? GRAPPLE_POD_COLOR : GRAPPLE_TERRAIN_COLOR,
      );

      if (hit.isPod) {
        this.grappleLatchRing.position.set(
          hit.target.x,
          hit.target.y,
          hit.target.z,
        );
        if (dist > 1e-4) {
          this.grappleLatchRing.quaternion.setFromUnitVectors(
            LOCAL_FORWARD,
            this.dirVec,
          );
        } else {
          this.grappleLatchRing.quaternion.copy(this.flatQuat);
        }
      } else if (world.isSolid(hit.target.x, hit.target.y, hit.target.z)) {
        const n = world.sampleNormal(hit.target.x, hit.target.y, hit.target.z);
        this.normalVec.set(n.x, n.y, n.z);
        if (this.normalVec.lengthSq() > 1e-4) {
          this.normalVec.normalize();
        } else {
          this.normalVec.copy(WORLD_UP);
        }
        this.grappleLatchRing.position.set(
          hit.target.x + this.normalVec.x * 0.08,
          hit.target.y + this.normalVec.y * 0.08,
          hit.target.z + this.normalVec.z * 0.08,
        );
        this.alignQuat.setFromUnitVectors(WORLD_UP, this.normalVec);
        this.grappleLatchRing.quaternion
          .copy(this.alignQuat)
          .multiply(this.flatQuat);
      } else {
        this.grappleLatchRing.position.set(
          hit.target.x,
          hit.target.y + 0.08,
          hit.target.z,
        );
        this.grappleLatchRing.quaternion.copy(this.flatQuat);
      }

      this.grapplePreviewGroup.visible = true;
      this.group.visible = true;
      return;
    }

    this.scatterConeGroup.visible = false;
    this.grapplePreviewGroup.visible = false;

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
    this.scatterShellGeometry.dispose();
    this.scatterShellMaterial.dispose();
    this.scatterRingGeometry.dispose();
    this.scatterRingMaterial.dispose();
    this.scatterRaysGeometry.dispose();
    this.scatterRaysMaterial.dispose();
    this.grappleBeamGeometry.dispose();
    this.grappleBeamMaterial.dispose();
    this.grappleRingGeometry.dispose();
    this.grappleRingMaterial.dispose();
    this.scatterConeGroup.clear();
    this.grapplePreviewGroup.clear();
    this.group.clear();
  }

  private hideBallisticArcs(): void {
    this.instancedDots.count = 0;
    this.landingRing.visible = false;
    this.ghostDots.count = 0;
    this.ghostLandingRing.visible = false;
  }

  private hideAll(): void {
    this.group.visible = false;
    this.hideBallisticArcs();
    this.scatterConeGroup.visible = false;
    this.grapplePreviewGroup.visible = false;
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
