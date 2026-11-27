import * as THREE from "three";
import {
  SPECIES_CATALOG,
  type CritterState,
  type TeamId,
  type Vec3,
} from "@critter/shared";

const EDGE_MARGIN_X = 56;
const EDGE_MARGIN_TOP = 76;
const EDGE_MARGIN_BOTTOM = 86;
const MARKER_HEAD_OFFSET_Y = 2.35;

const _projVec = new THREE.Vector3();

export interface DronePlayerMarkerData {
  readonly id: string;
  readonly name: string;
  readonly speciesName: string;
  readonly color: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly team: TeamId | null;
  readonly isLocal: boolean;
  readonly isActiveTurn: boolean;
  readonly distanceMeters: number | null;
  readonly screenX: number;
  readonly screenY: number;
  readonly offscreen: boolean;
  readonly edgeAngleRad: number;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Project every living critter onto 2D viewport coordinates for Tactical Drone Recon
 * callout pills, clamping behind-camera and out-of-frustum critters cleanly onto the
 * viewport edge with an accurate directional angle.
 */
export function projectDroneMarkers(
  critters: readonly CritterState[],
  localPlayerId: string | null,
  activePlayerId: string | null,
  camera: THREE.Camera,
  viewportWidth: number,
  viewportHeight: number,
  positionOverrides?: ReadonlyMap<string, Vec3>,
): DronePlayerMarkerData[] {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return [];
  }

  camera.updateMatrixWorld();

  const localCritter =
    localPlayerId !== null
      ? (critters.find((c) => c.id === localPlayerId && c.alive) ?? null)
      : null;
  const localPos = localCritter
    ? (positionOverrides?.get(localCritter.id) ?? localCritter.position)
    : null;

  const cx = viewportWidth * 0.5;
  const cy = viewportHeight * 0.5;
  const minX = Math.min(EDGE_MARGIN_X, cx);
  const maxX = Math.max(minX, viewportWidth - EDGE_MARGIN_X);
  const minY = Math.min(EDGE_MARGIN_TOP, cy);
  const maxY = Math.max(minY, viewportHeight - EDGE_MARGIN_BOTTOM);

  const markers: DronePlayerMarkerData[] = [];

  for (let i = 0; i < critters.length; i++) {
    const critter = critters[i];
    if (!critter || !critter.alive) {
      continue;
    }

    const pos = positionOverrides?.get(critter.id) ?? critter.position;
    if (
      !Number.isFinite(pos.x) ||
      !Number.isFinite(pos.y) ||
      !Number.isFinite(pos.z)
    ) {
      continue;
    }

    const isLocal = localPlayerId !== null && critter.id === localPlayerId;
    const isActiveTurn =
      activePlayerId !== null && critter.id === activePlayerId;
    const distanceMeters =
      isLocal || localPos === null
        ? null
        : Math.round(Math.hypot(pos.x - localPos.x, pos.z - localPos.z));

    _projVec
      .set(pos.x, pos.y + MARKER_HEAD_OFFSET_Y, pos.z)
      .project(camera);

    const validNdc =
      Number.isFinite(_projVec.x) &&
      Number.isFinite(_projVec.y) &&
      Number.isFinite(_projVec.z);

    let ndcX = validNdc ? _projVec.x : 0;
    let ndcY = validNdc ? _projVec.y : -2;
    const behindCamera = !validNdc || _projVec.z > 1;

    if (behindCamera && validNdc) {
      ndcX = -ndcX;
      ndcY = -ndcY;
    }

    const outsideNdc =
      behindCamera ||
      _projVec.z < -1 ||
      ndcX < -1 ||
      ndcX > 1 ||
      ndcY < -1 ||
      ndcY > 1;

    let screenX: number;
    let screenY: number;
    let edgeAngleRad = 0;

    if (outsideNdc) {
      let dx = ndcX;
      let dy = -ndcY;
      if (Math.hypot(dx, dy) < 1e-5) {
        dx = 0;
        dy = 1;
      }
      edgeAngleRad = Math.atan2(dy, dx);

      const tX =
        dx > 1e-6
          ? (maxX - cx) / dx
          : dx < -1e-6
            ? (minX - cx) / dx
            : Number.POSITIVE_INFINITY;
      const tY =
        dy > 1e-6
          ? (maxY - cy) / dy
          : dy < -1e-6
            ? (minY - cy) / dy
            : Number.POSITIVE_INFINITY;
      const t = Math.min(tX, tY);

      screenX = Number.isFinite(t)
        ? clamp(cx + dx * t, minX, maxX)
        : cx;
      screenY = Number.isFinite(t)
        ? clamp(cy + dy * t, minY, maxY)
        : maxY;
    } else {
      const rawX = (ndcX * 0.5 + 0.5) * viewportWidth;
      const rawY = (-ndcY * 0.5 + 0.5) * viewportHeight;
      screenX = clamp(rawX, minX, maxX);
      screenY = clamp(rawY, minY, maxY);
    }

    markers.push({
      id: critter.id,
      name: critter.name,
      speciesName: SPECIES_CATALOG[critter.species].name,
      color: critter.color,
      hp: critter.hp,
      maxHp: critter.maxHp,
      team: critter.team,
      isLocal,
      isActiveTurn,
      distanceMeters,
      screenX,
      screenY,
      offscreen: outsideNdc,
      edgeAngleRad,
    });
  }

  return markers;
}
