import * as THREE from "three";
import { SDF_DIMS, type SdfWorld, type TurnPhase, type Vec3 } from "@critter/shared";

/** Supported camera perspective modes for Critter Siege gameplay. */
export type CameraMode =
  | "over_shoulder"
  | "first_person"
  | "drone_recon"
  | "shot_cam"
  | "spectator_drone"
  | "flood_cam";

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
  waterLevel?: number;
}

const DEFAULT_FOV = 64;
const FIRST_PERSON_FOV = 52;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 1100;

const OVER_SHOULDER_BACK = 4.6;
const OVER_SHOULDER_RIGHT = 1.15;
const OVER_SHOULDER_UP = 2.1;
const OVER_SHOULDER_PIVOT_Y = 1.1;
const FIRST_PERSON_EYE_Y = 0.85;

const DRONE_MIN_ZOOM_RATIO = 0.35;
const DRONE_MAX_ZOOM_RATIO = 1.15;
const DRONE_DEFAULT_ZOOM_RATIO = 0.72;
const DRONE_ZOOM_BASE_SPAN = 60.0;
const DRONE_MIN_PITCH = 0.25;
const DRONE_MAX_PITCH = 1.38;
const DRONE_DEFAULT_PITCH = Math.PI * 0.25;

const FLOOD_CAM_RADIUS_RATIO = 0.72;
const FLOOD_CAM_HEIGHT_RATIO = 0.72;
const FLOOD_CAM_ORBIT_SPEED = 0.28;
const FLOOD_CAM_WATER_CLEARANCE = 8.0;

const PULLBACK_STEP = 0.15;
const PULLBACK_MARGIN = 0.35;
const PULLBACK_SDF_CLEARANCE = 0.22;
const MIN_CAMERA_ARM = 0.65;

const SHOT_CAM_RAY_STEP = 0.25;
const SHOT_CAM_PULLBACK_MARGIN = 0.45;
const SHOT_CAM_SDF_CLEARANCE = 0.28;
const SHOT_CAM_MIN_ARM = 1.8;

const DEFAULT_ISLAND_CENTER = new THREE.Vector3(
  SDF_DIMS.nx * SDF_DIMS.voxelSize * 0.5,
  SDF_DIMS.ny * SDF_DIMS.voxelSize * 0.25,
  SDF_DIMS.nz * SDF_DIMS.voxelSize * 0.5,
);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Seamless multi-mode Three.js camera rig (Over-the-Shoulder, First-Person Optic Visor,
 * Tactical Drone Recon, Projectile Shot Cam, Spectator Drone when KO'd, and panoramic Flood Cam)
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
  private droneZoomRatio = DRONE_DEFAULT_ZOOM_RATIO;
  private floodOrbitYaw = Math.PI * 0.25;

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

  private shakeIntensity = 0;
  private shakeDurationSec = 0;
  private shakeElapsedSec = 0;
  private shakePhase = 0;

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
    this.droneZoomRatio = clamp(
      this.droneZoomRatio + dZoom / DRONE_ZOOM_BASE_SPAN,
      DRONE_MIN_ZOOM_RATIO,
      DRONE_MAX_ZOOM_RATIO,
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

  /** Trigger brief decaying tactical camera screen-shake (scaled to blast radius). */
  public triggerShake(intensity: number, durationSec = 0.32): void {
    const safeIntensity = clamp(finiteOr(intensity, 0), 0, 1.5);
    const safeDuration = clamp(finiteOr(durationSec, 0.32), 0.05, 1.2);
    if (safeIntensity <= 0) {
      return;
    }
    this.shakeIntensity = Math.min(
      1.5,
      Math.max(this.shakeIntensity, safeIntensity),
    );
    this.shakeDurationSec = Math.max(
      this.shakeDurationSec - this.shakeElapsedSec,
      safeDuration,
    );
    this.shakeElapsedSec = 0;
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
    const centerY = ctx.world.worldHeight * 0.25;
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

    if (this.mode === "flood_cam") {
      dampRate = 4.5;
      this.computeFloodCamPose(ctx.world, safeDt, targetY, ctx.waterLevel);
    } else if (this.mode === "shot_cam") {
      dampRate = 9.0;
      this.computeShotCamPose(ctx.shotPos, ctx.world);
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

      // Hard safety guard in over_shoulder & shot_cam: damped camera position may never reside in solid rock
      if (
        (this.mode === "over_shoulder" || this.mode === "shot_cam") &&
        ctx.world.isSolid(
          this.currentPos.x,
          this.currentPos.y,
          this.currentPos.z,
        )
      ) {
        this.currentPos.copy(this.desiredPos);
      }
    }

    // Final hard safety guard: over_shoulder & shot_cam may never end up inside solid SDF rock
    if (
      (this.mode === "over_shoulder" || this.mode === "shot_cam") &&
      ctx.world.isSolid(
        this.currentPos.x,
        this.currentPos.y,
        this.currentPos.z,
      )
    ) {
      this.currentPos.y = Math.max(
        this.currentPos.y,
        ctx.world.worldHeight + 4.0,
      );
    }

    // Hard safety guard in flood_cam: never dip beneath the rising deluge crest
    if (this.mode === "flood_cam") {
      const safeWater =
        ctx.waterLevel !== undefined && Number.isFinite(ctx.waterLevel)
          ? ctx.waterLevel
          : 2.0;
      const minFloodCamY = safeWater + FLOOD_CAM_WATER_CLEARANCE;
      if (this.currentPos.y < minFloodCamY) {
        this.currentPos.y = minFloodCamY;
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
    if (this.shakeIntensity > 0 && this.shakeDurationSec > 0) {
      this.shakeElapsedSec += safeDt;
      if (this.shakeElapsedSec >= this.shakeDurationSec) {
        this.shakeIntensity = 0;
        this.shakeDurationSec = 0;
        this.shakeElapsedSec = 0;
      } else {
        const remain = 1 - this.shakeElapsedSec / this.shakeDurationSec;
        const amp = this.shakeIntensity * remain * remain;
        this.shakePhase += safeDt * 58;
        const sx = Math.sin(this.shakePhase * 1.13) * amp;
        const sy = Math.cos(this.shakePhase * 1.47) * amp * 0.72;
        const sz = Math.sin(this.shakePhase * 0.89 + 1.3) * amp * 0.65;
        this.camera.position.set(
          this.currentPos.x + sx,
          this.currentPos.y + sy,
          this.currentPos.z + sz,
        );
        if (
          (this.mode === "over_shoulder" || this.mode === "shot_cam") &&
          ctx.world.isSolid(
            this.camera.position.x,
            this.camera.position.y,
            this.camera.position.z,
          )
        ) {
          this.camera.position.copy(this.currentPos);
        }
      }
    }
    this.camera.lookAt(this.currentLookAt);
  }

  private resolveMode(ctx: CameraUpdateContext): CameraMode {
    if (ctx.phase === "FINAL_FLOOD") {
      return "flood_cam";
    }
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
    if (this.prevPhase === "FINAL_FLOOD") {
      this.mode = "flood_cam";
    } else if (this.shotCamActive) {
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
    const centerX = world.centerX;
    const centerY = world.worldHeight * 0.25;
    const centerZ = world.centerZ;
    const minZoom = world.worldWidth * DRONE_MIN_ZOOM_RATIO;
    const maxZoom = world.worldWidth * DRONE_MAX_ZOOM_RATIO;
    const effectiveDist = clamp(
      world.worldWidth * this.droneZoomRatio,
      minZoom,
      maxZoom,
    );

    this.desiredPos.set(
      centerX + Math.sin(this.droneYaw) * cosP * effectiveDist,
      centerY + sinP * effectiveDist,
      centerZ + Math.cos(this.droneYaw) * cosP * effectiveDist,
    );
    this.desiredLookAt.set(centerX, centerY, centerZ);
  }

  private computeFloodCamPose(
    world: SdfWorld,
    dtSec: number,
    targetY: number,
    waterLevel?: number,
  ): void {
    this.floodOrbitYaw += dtSec * FLOOD_CAM_ORBIT_SPEED;

    const worldSpan = Math.max(world.worldWidth, world.worldDepth);
    const radius = worldSpan * FLOOD_CAM_RADIUS_RATIO;
    const safeWater =
      waterLevel !== undefined && Number.isFinite(waterLevel) ? waterLevel : 2.0;

    const elevatedY = Math.max(
      world.worldHeight * FLOOD_CAM_HEIGHT_RATIO,
      targetY + 12.0,
      safeWater + FLOOD_CAM_WATER_CLEARANCE + 1.5,
    );
    const lookY = Math.max(world.worldHeight * 0.28, safeWater + 1.0);

    this.desiredPos.set(
      world.centerX + Math.sin(this.floodOrbitYaw) * radius,
      elevatedY,
      world.centerZ + Math.cos(this.floodOrbitYaw) * radius,
    );
    this.desiredLookAt.set(world.centerX, lookY, world.centerZ);
  }

  private computeShotCamPose(shotPos: Vec3 | null, world: SdfWorld): void {
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

    const idealX =
      this.lastShotPos.x - this.shotTravelDir.x * 5.2 + sideX * 1.6;
    const idealY = Math.max(3.2, this.lastShotPos.y + 2.8);
    const idealZ =
      this.lastShotPos.z - this.shotTravelDir.z * 5.2 + sideZ * 1.6;

    const isClearVantage = (
      x: number,
      y: number,
      z: number,
      clearance: number,
    ): boolean => !world.isSolid(x, y, z) && world.sample(x, y, z) >= clearance;

    this.desiredLookAt.copy(this.lastShotPos);

    const shotInsideRock = world.isSolid(
      this.lastShotPos.x,
      this.lastShotPos.y,
      this.lastShotPos.z,
    );

    if (!shotInsideRock) {
      const rayDx = idealX - this.lastShotPos.x;
      const rayDy = idealY - this.lastShotPos.y;
      const rayDz = idealZ - this.lastShotPos.z;
      const rayLen = Math.hypot(rayDx, rayDy, rayDz);

      let obstructedDist: number | null = null;
      if (rayLen > 1e-4) {
        const ux = rayDx / rayLen;
        const uy = rayDy / rayLen;
        const uz = rayDz / rayLen;
        for (
          let dist = SHOT_CAM_RAY_STEP;
          dist <= rayLen;
          dist += SHOT_CAM_RAY_STEP
        ) {
          const px = this.lastShotPos.x + ux * dist;
          const py = this.lastShotPos.y + uy * dist;
          const pz = this.lastShotPos.z + uz * dist;
          if (
            world.isSolid(px, py, pz) ||
            world.sample(px, py, pz) < SHOT_CAM_SDF_CLEARANCE
          ) {
            obstructedDist = dist;
            break;
          }
        }
      }

      if (
        obstructedDist === null &&
        isClearVantage(idealX, idealY, idealZ, SHOT_CAM_SDF_CLEARANCE)
      ) {
        this.desiredPos.set(idealX, idealY, idealZ);
        return;
      }

      if (obstructedDist !== null && rayLen > 1e-4) {
        const safeDist = obstructedDist - SHOT_CAM_PULLBACK_MARGIN;
        if (safeDist >= SHOT_CAM_MIN_ARM) {
          const frac = safeDist / rayLen;
          const cx = this.lastShotPos.x + rayDx * frac;
          const cy = this.lastShotPos.y + rayDy * frac;
          const cz = this.lastShotPos.z + rayDz * frac;
          if (isClearVantage(cx, cy, cz, SHOT_CAM_SDF_CLEARANCE)) {
            this.desiredPos.set(cx, cy, cz);
            return;
          }
        }
      }
    }

    // Projectile is inside solid rock (e.g. Burrow Bore tunneling) or default offset is blocked:
    // find the nearest open-air vantage outside the cliff looking back at lastShotPos.
    const found =
      this.findOpenAirShotVantage(
        world,
        idealX,
        idealY,
        idealZ,
        sideX,
        sideZ,
        SHOT_CAM_SDF_CLEARANCE,
      ) ||
      this.findOpenAirShotVantage(
        world,
        idealX,
        idealY,
        idealZ,
        sideX,
        sideZ,
        0,
      );

    if (!found) {
      this.desiredPos.set(
        idealX,
        Math.max(idealY, world.worldHeight + 4.0),
        idealZ,
      );
    }
  }

  private findOpenAirShotVantage(
    world: SdfWorld,
    idealX: number,
    idealY: number,
    idealZ: number,
    sideX: number,
    sideZ: number,
    clearance: number,
  ): boolean {
    const isClear = (x: number, y: number, z: number): boolean =>
      !world.isSolid(x, y, z) && world.sample(x, y, z) >= clearance;

    // 1. Back out along reverse travel direction + upward lift (outside tunnel entrance)
    const backDistances = [3.5, 5.5, 7.5, 10, 13, 17, 22, 28];
    for (const d of backDistances) {
      const bx = this.lastShotPos.x - this.shotTravelDir.x * d + sideX * 1.6;
      const by = Math.max(3.2, this.lastShotPos.y + 2.2 + d * 0.35);
      const bz = this.lastShotPos.z - this.shotTravelDir.z * d + sideZ * 1.6;
      if (isClear(bx, by, bz)) {
        this.desiredPos.set(bx, by, bz);
        return true;
      }

      const rx = this.lastShotPos.x - this.shotTravelDir.x * d;
      const ry = Math.max(3.2, this.lastShotPos.y + 1.8 + d * 0.2);
      const rz = this.lastShotPos.z - this.shotTravelDir.z * d;
      if (isClear(rx, ry, rz)) {
        this.desiredPos.set(rx, ry, rz);
        return true;
      }
    }

    // 2. Lift cleanly above the cliff crest at idealX/idealZ
    const surfY = world.getSurfaceY(idealX, idealZ);
    if (surfY !== null) {
      const crestY = Math.max(idealY, surfY + 3.2);
      if (isClear(idealX, crestY, idealZ)) {
        this.desiredPos.set(idealX, crestY, idealZ);
        return true;
      }
    }
    const lifts = [2, 4, 6, 9, 12, 16, 20, 26];
    for (const lift of lifts) {
      if (isClear(idealX, idealY + lift, idealZ)) {
        this.desiredPos.set(idealX, idealY + lift, idealZ);
        return true;
      }
    }

    // 3. Sideways open-air flanks
    const flankDistances = [5, 8, 12, 16, 22];
    for (const d of flankDistances) {
      const fy = Math.max(3.2, this.lastShotPos.y + 3.0 + d * 0.25);
      for (const sign of [1, -1]) {
        const fx =
          this.lastShotPos.x + sideX * d * sign - this.shotTravelDir.x * 2.5;
        const fz =
          this.lastShotPos.z + sideZ * d * sign - this.shotTravelDir.z * 2.5;
        if (isClear(fx, fy, fz)) {
          this.desiredPos.set(fx, fy, fz);
          return true;
        }
      }
    }

    return false;
  }
}
