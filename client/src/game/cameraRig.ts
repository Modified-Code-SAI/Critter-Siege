import * as THREE from "three";
import { SDF_DIMS, type SdfWorld, type TurnPhase, type Vec3 } from "@critter/shared";

/** Supported camera perspective modes for Critter Siege gameplay. */
export type CameraMode =
  | "over_shoulder"
  | "first_person"
  | "drone_recon"
  | "shot_cam"
  | "spectator_drone";

/** Per-frame context passed to CameraRig.update(). */
export interface CameraUpdateContext {
  targetPos: Vec3;
  yaw: number;
  pitch: number;
  phase: TurnPhase;
  localAlive: boolean;
  shotPos: Vec3 | null;
  world: SdfWorld;
  dtSec: number;
}

const DEFAULT_FOV = 64;
const FIRST_PERSON_FOV = 52;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 720;

const OVER_SHOULDER_BACK = 4.6;
const OVER_SHOULDER_RIGHT = 1.15;
const OVER_SHOULDER_UP = 2.1;
const OVER_SHOULDER_PIVOT_Y = 1.1;
const FIRST_PERSON_EYE_Y = 0.85;

const DRONE_MIN_DIST = 20.0;
const DRONE_MAX_DIST = 68.0;
const DRONE_DEFAULT_DIST = 46.0;
const DRONE_GRAND_SCALE = 2.15;
const DRONE_MIN_PITCH = 0.25;
const DRONE_MAX_PITCH = 1.38;
const DRONE_DEFAULT_PITCH = Math.PI * 0.25;

const PULLBACK_STEP = 0.15;
const PULLBACK_MARGIN = 0.35;
const PULLBACK_SDF_CLEARANCE = 0.22;
const MIN_CAMERA_ARM = 0.65;

const DEFAULT_ISLAND_CENTER = new THREE.Vector3(
  SDF_DIMS.nx * SDF_DIMS.voxelSize * 0.5,
  8.0,
  SDF_DIMS.nz * SDF_DIMS.voxelSize * 0.5,
);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Seamless 4-mode Three.js camera rig (Over-the-Shoulder, First-Person Optic Visor,
 * Tactical Drone Recon, Projectile Shot Cam, plus Spectator Drone when KO'd)
 * with smooth exponential damping and SDF terrain collision pullback.
 */
export class CameraRig {
  public readonly camera: THREE.PerspectiveCamera;

  private mode: CameraMode = "over_shoulder";
  private firstPersonRequested = false;
  private droneReconRequested = false;
  private spectatorOverride = false;
  private shotCamActive = false;
  private prevPhase: TurnPhase | null = null;
  private initialized = false;

  private droneYaw = Math.PI * 0.25;
  private dronePitch = DRONE_DEFAULT_PITCH;
  private droneDistance = DRONE_DEFAULT_DIST;

  private readonly currentPos = new THREE.Vector3(
    DEFAULT_ISLAND_CENTER.x,
    22,
    DEFAULT_ISLAND_CENTER.z + 32,
  );
  private readonly currentLookAt = DEFAULT_ISLAND_CENTER.clone();
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLookAt = new THREE.Vector3();
  private readonly lastShotPos = DEFAULT_ISLAND_CENTER.clone();
  private readonly shotTravelDir = new THREE.Vector3(0, 0, 1);
  private hasLastShotPos = false;
  private currentFov = DEFAULT_FOV;

  public constructor(aspect = 16 / 9) {
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
    this.camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV,
      safeAspect,
      CAMERA_NEAR,
      CAMERA_FAR,
    );
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }

  /** Return the currently active camera mode. */
  public getMode(): CameraMode {
    return this.mode;
  }

  /** Enable or disable First-Person Optic Visor aiming mode. */
  public setFirstPerson(enabled: boolean): void {
    this.firstPersonRequested = enabled;
    if (enabled) {
      this.droneReconRequested = false;
    }
    this.syncImmediateMode();
  }

  /** Toggle First-Person Optic Visor aiming mode. */
  public toggleFirstPerson(): void {
    this.setFirstPerson(!this.firstPersonRequested);
  }

  /** Toggle Tactical Drone Recon elevated sky view. */
  public toggleDroneRecon(): void {
    if (this.droneReconRequested) {
      this.exitDroneRecon();
      return;
    }
    this.droneReconRequested = true;
    this.firstPersonRequested = false;
    this.syncImmediateMode();
  }

  /** Exit Tactical Drone Recon back to aiming view. */
  public exitDroneRecon(): void {
    this.droneReconRequested = false;
    this.syncImmediateMode();
  }

  /** Orbit and zoom the Tactical Drone / Spectator Drone camera smoothly around the island center. */
  public orbitDrone(deltaYaw: number, deltaPitch: number, deltaZoom = 0): void {
    const dYaw = finiteOr(deltaYaw, 0);
    const dPitch = finiteOr(deltaPitch, 0);
    const dZoom = finiteOr(deltaZoom, 0);
    this.droneYaw += dYaw;
    this.dronePitch = clamp(
      this.dronePitch + dPitch,
      DRONE_MIN_PITCH,
      DRONE_MAX_PITCH,
    );
    this.droneDistance = clamp(
      this.droneDistance + dZoom,
      DRONE_MIN_DIST,
      DRONE_MAX_DIST,
    );
  }

  /** Force or clear dead-player spectator drone mode. */
  public setSpectatorOverride(isDeadSpectator: boolean): void {
    this.spectatorOverride = isDeadSpectator;
    this.syncImmediateMode();
  }

  /** Force or clear temporary projectile shot-cam mode. */
  public setShotCamActive(active: boolean): void {
    this.shotCamActive = active;
    if (!active) {
      this.hasLastShotPos = false;
    }
    this.syncImmediateMode();
  }

  /** Update viewport aspect ratio cleanly. */
  public resize(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) {
      return;
    }
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Advance active camera mode priority, terrain pullback, damping, and projection FOV. */
  public update(ctx: CameraUpdateContext): void {
    const safeDt = clamp(finiteOr(ctx.dtSec, 0.016), 0, 0.25);
    const safeYaw = finiteOr(ctx.yaw, 0);
    const safePitch = clamp(finiteOr(ctx.pitch, 0), -1.2, 1.2);
    const centerY = ctx.world.mapScale === "grand" ? 14.0 : 8.0;
    const targetX = finiteOr(ctx.targetPos.x, ctx.world.centerX);
    const targetY = finiteOr(ctx.targetPos.y, centerY);
    const targetZ = finiteOr(ctx.targetPos.z, ctx.world.centerZ);

    // Leaving RESOLVING into RETREAT or ACTIVE clears temporary shot_cam and drone_recon
    if (
      this.prevPhase === "RESOLVING" &&
      (ctx.phase === "RETREAT" || ctx.phase === "ACTIVE")
    ) {
      this.shotCamActive = false;
      this.droneReconRequested = false;
      this.hasLastShotPos = false;
    }
    this.prevPhase = ctx.phase;

    const prevMode = this.mode;
    this.mode = this.resolveMode(ctx);

    let snapImmediate = !this.initialized;
    let dampRate = 10.0;
    let targetFov = DEFAULT_FOV;
    let obstructPulledIn = false;

    if (this.mode === "shot_cam") {
      dampRate = 9.0;
      this.computeShotCamPose(ctx.shotPos);
    } else if (this.mode === "spectator_drone" || this.mode === "drone_recon") {
      dampRate = 8.5;
      this.computeDronePose(ctx.world);
    } else if (this.mode === "first_person") {
      snapImmediate = true;
      targetFov = FIRST_PERSON_FOV;
      this.computeFirstPersonPose(targetX, targetY, targetZ, safeYaw, safePitch);
    } else {
      dampRate = 12.0;
      obstructPulledIn = this.computeOverShoulderPose(
        targetX,
        targetY,
        targetZ,
        safeYaw,
        safePitch,
        ctx.world,
      );
    }

    if (snapImmediate || prevMode === "first_person") {
      this.currentPos.copy(this.desiredPos);
      this.currentLookAt.copy(this.desiredLookAt);
      this.initialized = true;
    } else {
      const alpha = safeDt > 0 ? 1 - Math.exp(-dampRate * safeDt) : 1;
      if (obstructPulledIn) {
        // Pull inward immediately when cliffs obstruct so the camera never clips inside rock
        const pivot = new THREE.Vector3(
          targetX,
          targetY + OVER_SHOULDER_PIVOT_Y,
          targetZ,
        );
        const curDist = this.currentPos.distanceTo(pivot);
        const desDist = this.desiredPos.distanceTo(pivot);
        if (desDist < curDist) {
          this.currentPos.copy(this.desiredPos);
        } else {
          this.currentPos.lerp(this.desiredPos, alpha);
        }
      } else {
        this.currentPos.lerp(this.desiredPos, alpha);
      }
      this.currentLookAt.lerp(this.desiredLookAt, alpha);

      // Hard safety guard in over_shoulder: damped camera position may never reside in solid rock
      if (
        this.mode === "over_shoulder" &&
        ctx.world.isSolid(
          this.currentPos.x,
          this.currentPos.y,
          this.currentPos.z,
        )
      ) {
        this.currentPos.copy(this.desiredPos);
      }
    }

    const fovAlpha =
      snapImmediate || this.mode === "first_person"
        ? 1
        : safeDt > 0
          ? 1 - Math.exp(-14 * safeDt)
          : 1;
    const nextFov = this.currentFov + (targetFov - this.currentFov) * fovAlpha;
    if (Math.abs(nextFov - this.camera.fov) > 0.01) {
      this.currentFov = nextFov;
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    } else {
      this.currentFov = targetFov;
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }

  private resolveMode(ctx: CameraUpdateContext): CameraMode {
    if ((ctx.phase === "RESOLVING" && ctx.shotPos !== null) || this.shotCamActive) {
      return "shot_cam";
    }
    if ((!ctx.localAlive && ctx.phase !== "LOBBY") || this.spectatorOverride) {
      return "spectator_drone";
    }
    if (this.droneReconRequested) {
      return "drone_recon";
    }
    if (this.firstPersonRequested) {
      return "first_person";
    }
    return "over_shoulder";
  }

  private syncImmediateMode(): void {
    if (this.shotCamActive) {
      this.mode = "shot_cam";
    } else if (this.spectatorOverride) {
      this.mode = "spectator_drone";
    } else if (this.droneReconRequested) {
      this.mode = "drone_recon";
    } else if (this.firstPersonRequested) {
      this.mode = "first_person";
    } else {
      this.mode = "over_shoulder";
    }

    const immediateFov =
      this.mode === "first_person" ? FIRST_PERSON_FOV : DEFAULT_FOV;
    if (Math.abs(this.camera.fov - immediateFov) > 0.01) {
      this.currentFov = immediateFov;
      this.camera.fov = immediateFov;
      this.camera.updateProjectionMatrix();
    }
  }

  private computeFirstPersonPose(
    tx: number,
    ty: number,
    tz: number,
    yaw: number,
    pitch: number,
  ): void {
    const cosPitch = Math.cos(pitch);
    const fx = Math.sin(yaw) * cosPitch;
    const fy = Math.sin(pitch);
    const fz = Math.cos(yaw) * cosPitch;

    this.desiredPos.set(tx, ty + FIRST_PERSON_EYE_Y, tz);
    this.desiredLookAt.set(
      this.desiredPos.x + fx * 12,
      this.desiredPos.y + fy * 12,
      this.desiredPos.z + fz * 12,
    );
  }

  private computeOverShoulderPose(
    tx: number,
    ty: number,
    tz: number,
    yaw: number,
    pitch: number,
    world: SdfWorld,
  ): boolean {
    const cosPitch = Math.cos(pitch);
    const aimX = Math.sin(yaw) * cosPitch;
    const aimY = Math.sin(pitch);
    const aimZ = Math.cos(yaw) * cosPitch;

    const horizForwardX = Math.sin(yaw);
    const horizForwardZ = Math.cos(yaw);
    // Right vector in Three.js (+Z forward, +Y up) = forward x up = (-cos(yaw), 0, sin(yaw))
    const rightX = -Math.cos(yaw);
    const rightZ = Math.sin(yaw);

    const pivotX = tx;
    const pivotY = ty + OVER_SHOULDER_PIVOT_Y;
    const pivotZ = tz;

    const idealX =
      tx - horizForwardX * OVER_SHOULDER_BACK + rightX * OVER_SHOULDER_RIGHT;
    const idealY = ty + OVER_SHOULDER_UP - aimY * 1.15;
    const idealZ =
      tz - horizForwardZ * OVER_SHOULDER_BACK + rightZ * OVER_SHOULDER_RIGHT;

    const rayDx = idealX - pivotX;
    const rayDy = idealY - pivotY;
    const rayDz = idealZ - pivotZ;
    const rayLen = Math.hypot(rayDx, rayDy, rayDz);

    let pulledIn = false;
    let safeFrac = 1.0;

    if (rayLen > 1e-4) {
      const ux = rayDx / rayLen;
      const uy = rayDy / rayLen;
      const uz = rayDz / rayLen;

      // March along the shoulder arm ray AND straight-back spine to catch cliff walls
      for (let dist = PULLBACK_STEP; dist <= rayLen; dist += PULLBACK_STEP) {
        const px = pivotX + ux * dist;
        const py = pivotY + uy * dist;
        const pz = pivotZ + uz * dist;

        const spineDist = Math.min(dist, OVER_SHOULDER_BACK);
        const sx = pivotX - horizForwardX * spineDist;
        const sy = pivotY + (idealY - pivotY) * (dist / rayLen);
        const sz = pivotZ - horizForwardZ * spineDist;

        const hitArm =
          world.isSolid(px, py, pz) ||
          world.sample(px, py, pz) < PULLBACK_SDF_CLEARANCE;
        const hitSpine = world.isSolid(sx, sy, sz);

        if (hitArm || hitSpine) {
          const safeDist = Math.max(MIN_CAMERA_ARM, dist - PULLBACK_MARGIN);
          safeFrac = Math.min(safeFrac, safeDist / rayLen);
          pulledIn = true;
          break;
        }
      }
    }

    this.desiredPos.set(
      pivotX + rayDx * safeFrac,
      pivotY + rayDy * safeFrac,
      pivotZ + rayDz * safeFrac,
    );

    // Extra safety step if desiredPos still touches rock
    while (
      safeFrac > 0.05 &&
      world.isSolid(this.desiredPos.x, this.desiredPos.y, this.desiredPos.z)
    ) {
      safeFrac = Math.max(0, safeFrac - 0.08);
      this.desiredPos.set(
        pivotX + rayDx * safeFrac,
        pivotY + rayDy * safeFrac,
        pivotZ + rayDz * safeFrac,
      );
      pulledIn = true;
    }

    this.desiredLookAt.set(
      pivotX + aimX * 14,
      pivotY + aimY * 14,
      pivotZ + aimZ * 14,
    );

    return pulledIn;
  }

  private computeDronePose(world: SdfWorld): void {
    const cosP = Math.cos(this.dronePitch);
    const sinP = Math.sin(this.dronePitch);
    const isGrand = world.mapScale === "grand";
    const scale = isGrand ? DRONE_GRAND_SCALE : 1.0;
    const centerX = world.centerX;
    const centerY = isGrand ? 14.0 : 8.0;
    const centerZ = world.centerZ;
    const effectiveDist = this.droneDistance * scale;

    this.desiredPos.set(
      centerX + Math.sin(this.droneYaw) * cosP * effectiveDist,
      centerY + sinP * effectiveDist,
      centerZ + Math.cos(this.droneYaw) * cosP * effectiveDist,
    );
    this.desiredLookAt.set(centerX, centerY, centerZ);
  }

  private computeShotCamPose(shotPos: Vec3 | null): void {
    if (shotPos !== null) {
      const sx = finiteOr(shotPos.x, this.lastShotPos.x);
      const sy = finiteOr(shotPos.y, this.lastShotPos.y);
      const sz = finiteOr(shotPos.z, this.lastShotPos.z);

      if (this.hasLastShotPos) {
        const dx = sx - this.lastShotPos.x;
        const dz = sz - this.lastShotPos.z;
        const horizLen = Math.hypot(dx, dz);
        if (horizLen > 1e-3) {
          this.shotTravelDir.set(dx / horizLen, 0, dz / horizLen);
        }
      }
      this.lastShotPos.set(sx, sy, sz);
      this.hasLastShotPos = true;
    }

    // Slight right/back elevated cinematic framing behind the projectile
    const sideX = -this.shotTravelDir.z;
    const sideZ = this.shotTravelDir.x;

    this.desiredPos.set(
      this.lastShotPos.x - this.shotTravelDir.x * 5.2 + sideX * 1.6,
      Math.max(3.2, this.lastShotPos.y + 2.8),
      this.lastShotPos.z - this.shotTravelDir.z * 5.2 + sideZ * 1.6,
    );
    this.desiredLookAt.copy(this.lastShotPos);
  }
}
