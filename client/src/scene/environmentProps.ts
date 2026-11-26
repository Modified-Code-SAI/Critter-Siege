import * as THREE from "three";
import {
  createSeededRng,
  type HazardState,
  type SdfWorld,
  type Vec3,
} from "@critter/shared";

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

interface InstancedBinding {
  mesh: THREE.InstancedMesh;
  index: number;
}

interface TrackedPropAnchor {
  category: "tree" | "flora" | "boulder" | "landmark";
  pos: Vec3;
  visible: boolean;
  bindings: InstancedBinding[];
  landmarkGroup?: THREE.Group;
}

interface HazardVisual {
  type: HazardState["type"];
  group: THREE.Group;
  pulseMaterials: THREE.MeshStandardMaterial[];
  warningRing?: THREE.Mesh;
  steamPuffs?: THREE.Mesh[];
  phaseOffset: number;
}

/** Quantitative scenery & hazard counts for diagnostics and tests. */
export interface EnvironmentPropCounts {
  trees: number;
  flora: number;
  boulders: number;
  landmarks: number;
  activeHazards: number;
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
    if (obj instanceof THREE.InstancedMesh) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    } else if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    }
  });
}

function distSq3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Lush instanced 3D scenery (multi-tier pine/oak trees, flowering bushes, wildflower
 * clusters, sculpted mossy boulders, ancient stone ruins, glowing lantern posts) AND
 * animated 3D visuals for interactive environmental hazards with non-floating carve pruning.
 */
export class EnvironmentProps {
  public readonly group: THREE.Group;

  private readonly sceneryGroup: THREE.Group;
  private readonly hazardGroup: THREE.Group;

  private readonly anchors: TrackedPropAnchor[] = [];
  private readonly hazardVisuals = new Map<string, HazardVisual>();

  private treeCount = 0;
  private floraCount = 0;
  private boulderCount = 0;
  private landmarkCount = 0;

  public constructor(
    world: SdfWorld,
    waterLevel = 1.5,
    avoidPoints: readonly Vec3[] = [],
  ) {
    this.group = new THREE.Group();
    this.group.name = "environment_props";

    this.sceneryGroup = new THREE.Group();
    this.sceneryGroup.name = "scenery_props";
    this.group.add(this.sceneryGroup);

    this.hazardGroup = new THREE.Group();
    this.hazardGroup.name = "interactive_hazards";
    this.group.add(this.hazardGroup);

    this.rebuild(world, waterLevel, avoidPoints);
  }

  /** Rebuild all deterministic instanced scenery for a new world, round, or theme. */
  public rebuild(
    world: SdfWorld,
    waterLevel = 1.5,
    avoidPoints: readonly Vec3[] = [],
  ): void {
    this.clearScenery();

    const rng = createSeededRng(world.seed ^ 0x4a7b2c);
    const placedTrees: Vec3[] = [];
    const placedLandmarks: Vec3[] = [];
    const placedBoulders: Vec3[] = [];

    const isClearOfAvoid = (p: Vec3, minDist: number): boolean => {
      const minSq = minDist * minDist;
      for (const av of avoidPoints) {
        if (distSq3(p, av) < minSq) {
          return false;
        }
      }
      return true;
    };

    const isClearOfList = (p: Vec3, list: readonly Vec3[], minDist: number): boolean => {
      const minSq = minDist * minDist;
      for (const item of list) {
        if (distSq3(p, item) < minSq) {
          return false;
        }
      }
      return true;
    };

    interface SurfaceSpot {
      pos: Vec3;
      normalY: number;
      isGrass: boolean;
      isRock: boolean;
      order: number;
    }

    const worldMaxX = world.worldWidth;
    const worldMaxZ = world.worldDepth;
    const isGrand = world.mapScale === "grand";
    const margin = isGrand ? 6.0 : 4.5;
    const gridStep = isGrand ? 2.4 : 1.35;
    const jitter = isGrand ? 1.4 : 0.9;
    const maxLandmarks = isGrand ? 22 : 10;
    const maxTrees = isGrand ? 90 : 38;
    const maxBoulders = isGrand ? 95 : 45;
    const maxFlora = isGrand ? 220 : 120;

    const spots: SurfaceSpot[] = [];
    for (let x = margin; x <= worldMaxX - margin; x += gridStep) {
      for (let z = margin; z <= worldMaxZ - margin; z += gridStep) {
        const jx = x + (rng() - 0.5) * jitter;
        const jz = z + (rng() - 0.5) * jitter;
        const sy = world.getSurfaceY(jx, jz);
        if (sy === null || sy <= waterLevel + 0.65) {
          continue;
        }
        const n = world.sampleNormal(jx, sy, jz);
        if (n.y < 0.48) {
          continue;
        }
        if (
          world.sample(jx, sy + 0.9, jz) <= 0.05 ||
          !world.isSolid(jx, sy - 0.65, jz)
        ) {
          continue;
        }
        spots.push({
          pos: { x: jx, y: sy, z: jz },
          normalY: n.y,
          isGrass: n.y >= 0.68 && sy > 3.1,
          isRock: n.y >= 0.48 && n.y <= 0.86,
          order: rng(),
        });
      }
    }

    spots.sort((a, b) => b.order - a.order);

    // 1. Pick carved stone ruins & lantern posts first so trees don't overlap them
    const landmarkSpots: Array<{ pos: Vec3; kind: "ruin" | "lantern"; rotY: number }> = [];
    for (const spot of spots) {
      if (landmarkSpots.length >= maxLandmarks) break;
      if (spot.normalY < 0.72 || spot.pos.y < 3.2) continue;
      if (!isClearOfAvoid(spot.pos, 3.3)) continue;
      if (!isClearOfList(spot.pos, placedLandmarks, isGrand ? 8.6 : 6.2)) continue;
      placedLandmarks.push(spot.pos);
      landmarkSpots.push({
        pos: spot.pos,
        kind: landmarkSpots.length % 2 === 0 ? "lantern" : "ruin",
        rotY: rng() * Math.PI * 2,
      });
    }

    // 2. Pick multi-tier pine & oak trees on broad sunlit grassy tops
    const pineSpots: Array<{ pos: Vec3; scale: number; rotY: number; tint: number }> = [];
    const oakSpots: Array<{ pos: Vec3; scale: number; rotY: number; tint: number }> = [];
    for (const spot of spots) {
      if (pineSpots.length + oakSpots.length >= maxTrees) break;
      if (!spot.isGrass || spot.pos.y < 3.5) continue;
      if (world.sample(spot.pos.x, spot.pos.y + 3.2, spot.pos.z) <= 0.1) continue;
      if (!isClearOfAvoid(spot.pos, 3.1)) continue;
      if (!isClearOfList(spot.pos, placedLandmarks, 3.2)) continue;
      if (!isClearOfList(spot.pos, placedTrees, isGrand ? 3.8 : 2.9)) continue;

      placedTrees.push(spot.pos);
      const entry = {
        pos: spot.pos,
        scale: 0.78 + rng() * 0.56,
        rotY: rng() * Math.PI * 2,
        tint: rng(),
      };
      if ((pineSpots.length + oakSpots.length) % 5 < 3) {
        pineSpots.push(entry);
      } else {
        oakSpots.push(entry);
      }
    }

    // 3. Pick sculpted mossy boulders across cliff rims, coves, and meadows
    const boulderSpots: Array<{
      pos: Vec3;
      sx: number;
      sy: number;
      sz: number;
      rotX: number;
      rotY: number;
      rotZ: number;
      tint: number;
      mossy: boolean;
    }> = [];
    for (const spot of spots) {
      if (boulderSpots.length >= maxBoulders) break;
      if (!isClearOfAvoid(spot.pos, 2.8)) continue;
      if (!isClearOfList(spot.pos, placedLandmarks, 2.4)) continue;
      if (!isClearOfList(spot.pos, placedTrees, 1.9)) continue;
      if (!isClearOfList(spot.pos, placedBoulders, isGrand ? 2.9 : 2.2)) continue;

      placedBoulders.push(spot.pos);
      const base = 0.52 + rng() * 0.72;
      boulderSpots.push({
        pos: spot.pos,
        sx: base * (0.85 + rng() * 0.5),
        sy: base * (0.62 + rng() * 0.42),
        sz: base * (0.85 + rng() * 0.5),
        rotX: (rng() - 0.5) * 0.35,
        rotY: rng() * Math.PI * 2,
        rotZ: (rng() - 0.5) * 0.35,
        tint: rng(),
        mossy: spot.pos.y > 3.2 && rng() > 0.25,
      });
    }

    // 4. Pick lush grass tufts, flowering shrubs & wildflower clusters
    const floraSpots: Array<{
      pos: Vec3;
      scale: number;
      rotY: number;
      kind: "shrub" | "tuft";
      flowerColorIdx: number;
      hasFlowers: boolean;
    }> = [];
    for (const spot of spots) {
      if (floraSpots.length >= maxFlora) break;
      if (spot.normalY < 0.62 || spot.pos.y < 3.0) continue;
      if (!isClearOfAvoid(spot.pos, 2.65)) continue;
      if (!isClearOfList(spot.pos, placedLandmarks, 1.5)) continue;
      if (!isClearOfList(spot.pos, placedBoulders, 1.2)) continue;

      const kind = rng() > 0.45 ? "shrub" : "tuft";
      floraSpots.push({
        pos: spot.pos,
        scale: 0.65 + rng() * 0.65,
        rotY: rng() * Math.PI * 2,
        kind,
        flowerColorIdx: Math.floor(rng() * 4),
        hasFlowers: rng() > 0.38,
      });
    }

    this.buildInstancedPines(pineSpots);
    this.buildInstancedOaks(oakSpots);
    this.buildInstancedBoulders(boulderSpots);
    this.buildInstancedFlora(floraSpots);
    this.buildLandmarks(landmarkSpots);

    this.treeCount = pineSpots.length + oakSpots.length;
    this.boulderCount = boulderSpots.length;
    this.floraCount = floraSpots.length;
    this.landmarkCount = landmarkSpots.length;
  }

  /**
   * Synchronize and animate live 3D hazard visuals (pulsing Blast Barrels,
   * bubbling Thermal Steam Geysers, and glowing Bramble Thorn Patches).
   * Detonated/inactive hazards are removed and GPU-disposed cleanly.
   */
  public syncHazards(
    hazards: readonly HazardState[],
    elapsedSec: number,
  ): void {
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;
    const activeIds = new Set<string>();

    for (const hazard of hazards) {
      if (!hazard.active) {
        continue;
      }
      activeIds.add(hazard.id);

      let visual = this.hazardVisuals.get(hazard.id);
      if (!visual || visual.type !== hazard.type) {
        if (visual) {
          this.hazardGroup.remove(visual.group);
          disposeObjectTree(visual.group);
        }
        visual = this.createHazardVisual(hazard);
        this.hazardVisuals.set(hazard.id, visual);
        this.hazardGroup.add(visual.group);
      }

      visual.group.position.set(
        hazard.position.x,
        hazard.position.y,
        hazard.position.z,
      );
      this.animateHazardVisual(visual, t);
    }

    for (const [id, visual] of this.hazardVisuals.entries()) {
      if (!activeIds.has(id)) {
        this.hazardGroup.remove(visual.group);
        disposeObjectTree(visual.group);
        this.hazardVisuals.delete(id);
      }
    }
  }

  /**
   * Hide any scenery prop whose supporting terrain was carved away or submerged
   * so no tree, shrub, boulder, or ruin ever floats in mid-air.
   */
  public pruneAfterCarve(world: SdfWorld, waterLevel: number): number {
    let pruned = 0;
    const dirtyMeshes = new Set<THREE.InstancedMesh>();

    for (const anchor of this.anchors) {
      if (!anchor.visible) {
        continue;
      }
      const submerged = anchor.pos.y <= waterLevel + 0.05;
      const supportLost =
        world.sample(anchor.pos.x, anchor.pos.y - 0.45, anchor.pos.z) > 0.05;

      if (submerged || supportLost) {
        anchor.visible = false;
        pruned += 1;
        for (const binding of anchor.bindings) {
          binding.mesh.setMatrixAt(binding.index, ZERO_MATRIX);
          dirtyMeshes.add(binding.mesh);
        }
        if (anchor.landmarkGroup) {
          anchor.landmarkGroup.visible = false;
        }
      }
    }

    for (const mesh of dirtyMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    return pruned;
  }

  /** Return current scenery & active hazard counts. */
  public getPropCounts(): EnvironmentPropCounts {
    return {
      trees: this.treeCount,
      flora: this.floraCount,
      boulders: this.boulderCount,
      landmarks: this.landmarkCount,
      activeHazards: this.hazardVisuals.size,
    };
  }

  /** Return positions of all currently visible scenery anchors (useful for verification tests). */
  public getVisiblePropPositions(): Vec3[] {
    const result: Vec3[] = [];
    for (const a of this.anchors) {
      if (a.visible) {
        result.push({ ...a.pos });
      }
    }
    return result;
  }

  /** Dispose all instanced scenery meshes, landmarks, and active hazard meshes cleanly. */
  public dispose(): void {
    this.clearScenery();
    for (const visual of this.hazardVisuals.values()) {
      this.hazardGroup.remove(visual.group);
      disposeObjectTree(visual.group);
    }
    this.hazardVisuals.clear();
  }

  private clearScenery(): void {
    disposeObjectTree(this.sceneryGroup);
    this.sceneryGroup.clear();
    this.anchors.length = 0;
    this.treeCount = 0;
    this.floraCount = 0;
    this.boulderCount = 0;
    this.landmarkCount = 0;
  }

  private buildInstancedPines(
    spots: ReadonlyArray<{ pos: Vec3; scale: number; rotY: number; tint: number }>,
  ): void {
    const count = spots.length;
    if (count === 0) return;

    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.24, 1.45, 7);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x6f4b32,
      roughness: 0.92,
      metalness: 0.02,
    });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    trunks.castShadow = true;
    trunks.receiveShadow = true;

    const tier1Geo = new THREE.ConeGeometry(1.18, 1.65, 8);
    const tier2Geo = new THREE.ConeGeometry(0.92, 1.45, 8);
    const tier3Geo = new THREE.ConeGeometry(0.62, 1.25, 7);

    const foliageMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.84,
      metalness: 0.02,
      flatShading: true,
    });

    const tier1 = new THREE.InstancedMesh(tier1Geo, foliageMat, count);
    const tier2 = new THREE.InstancedMesh(tier2Geo, foliageMat.clone(), count);
    const tier3 = new THREE.InstancedMesh(tier3Geo, foliageMat.clone(), count);
    for (const m of [tier1, tier2, tier3]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const sp = spots[i];
      if (!sp) continue;
      const s = sp.scale;

      dummy.position.set(sp.pos.x, sp.pos.y + 0.62 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);

      dummy.position.set(sp.pos.x, sp.pos.y + 1.55 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY, 0);
      dummy.updateMatrix();
      tier1.setMatrixAt(i, dummy.matrix);

      dummy.position.set(sp.pos.x, sp.pos.y + 2.38 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY + 0.45, 0);
      dummy.updateMatrix();
      tier2.setMatrixAt(i, dummy.matrix);

      dummy.position.set(sp.pos.x, sp.pos.y + 3.12 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY + 0.9, 0);
      dummy.updateMatrix();
      tier3.setMatrixAt(i, dummy.matrix);

      const hShift = 0.34 + sp.tint * 0.06;
      color.setHSL(hShift, 0.56, 0.24 + sp.tint * 0.07);
      tier1.setColorAt(i, color);
      color.setHSL(hShift - 0.01, 0.58, 0.3 + sp.tint * 0.07);
      tier2.setColorAt(i, color);
      color.setHSL(hShift - 0.02, 0.62, 0.36 + sp.tint * 0.07);
      tier3.setColorAt(i, color);

      this.anchors.push({
        category: "tree",
        pos: { ...sp.pos },
        visible: true,
        bindings: [
          { mesh: trunks, index: i },
          { mesh: tier1, index: i },
          { mesh: tier2, index: i },
          { mesh: tier3, index: i },
        ],
      });
    }

    for (const m of [trunks, tier1, tier2, tier3]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) {
        m.instanceColor.needsUpdate = true;
      }
      this.sceneryGroup.add(m);
    }
  }

  private buildInstancedOaks(
    spots: ReadonlyArray<{ pos: Vec3; scale: number; rotY: number; tint: number }>,
  ): void {
    const count = spots.length;
    if (count === 0) return;

    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.28, 1.65, 8);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x7b563a,
      roughness: 0.9,
      metalness: 0.02,
    });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    trunks.castShadow = true;
    trunks.receiveShadow = true;

    const crownMainGeo = new THREE.IcosahedronGeometry(1.05, 1);
    const crownSideGeo = new THREE.IcosahedronGeometry(0.76, 1);

    const makeLeafMat = (): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.82,
        metalness: 0.02,
        flatShading: true,
      });

    const crownMain = new THREE.InstancedMesh(crownMainGeo, makeLeafMat(), count);
    const crownSideA = new THREE.InstancedMesh(crownSideGeo, makeLeafMat(), count);
    const crownSideB = new THREE.InstancedMesh(crownSideGeo.clone(), makeLeafMat(), count);
    for (const m of [crownMain, crownSideA, crownSideB]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const sp = spots[i];
      if (!sp) continue;
      const s = sp.scale;
      const cosR = Math.cos(sp.rotY);
      const sinR = Math.sin(sp.rotY);

      dummy.position.set(sp.pos.x, sp.pos.y + 0.75 * s, sp.pos.z);
      dummy.rotation.set(0, sp.rotY, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);

      dummy.position.set(sp.pos.x, sp.pos.y + 2.18 * s, sp.pos.z);
      dummy.rotation.set(0.15, sp.rotY, 0.1);
      dummy.scale.set(1.12 * s, 0.88 * s, 1.08 * s);
      dummy.updateMatrix();
      crownMain.setMatrixAt(i, dummy.matrix);

      dummy.position.set(
        sp.pos.x + cosR * 0.72 * s,
        sp.pos.y + 1.88 * s,
        sp.pos.z + sinR * 0.72 * s,
      );
      dummy.scale.set(0.95 * s, 0.82 * s, 0.95 * s);
      dummy.updateMatrix();
      crownSideA.setMatrixAt(i, dummy.matrix);

      dummy.position.set(
        sp.pos.x - cosR * 0.65 * s,
        sp.pos.y + 1.98 * s,
        sp.pos.z - sinR * 0.62 * s,
      );
      dummy.scale.set(0.9 * s, 0.8 * s, 0.9 * s);
      dummy.updateMatrix();
      crownSideB.setMatrixAt(i, dummy.matrix);

      const hue = 0.25 + sp.tint * 0.08;
      color.setHSL(hue, 0.58, 0.36 + sp.tint * 0.08);
      crownMain.setColorAt(i, color);
      color.setHSL(hue + 0.02, 0.55, 0.31 + sp.tint * 0.07);
      crownSideA.setColorAt(i, color);
      color.setHSL(hue - 0.02, 0.64, 0.42 + sp.tint * 0.08);
      crownSideB.setColorAt(i, color);

      this.anchors.push({
        category: "tree",
        pos: { ...sp.pos },
        visible: true,
        bindings: [
          { mesh: trunks, index: i },
          { mesh: crownMain, index: i },
          { mesh: crownSideA, index: i },
          { mesh: crownSideB, index: i },
        ],
      });
    }

    for (const m of [trunks, crownMain, crownSideA, crownSideB]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) {
        m.instanceColor.needsUpdate = true;
      }
      this.sceneryGroup.add(m);
    }
  }

  private buildInstancedBoulders(
    spots: ReadonlyArray<{
      pos: Vec3;
      sx: number;
      sy: number;
      sz: number;
      rotX: number;
      rotY: number;
      rotZ: number;
      tint: number;
      mossy: boolean;
    }>,
  ): void {
    const count = spots.length;
    if (count === 0) return;

    const rockGeo = new THREE.DodecahedronGeometry(0.56, 1);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0.05,
      flatShading: true,
    });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, count);
    rocks.castShadow = true;
    rocks.receiveShadow = true;

    const mossGeo = new THREE.SphereGeometry(0.42, 8, 6);
    const mossMat = new THREE.MeshStandardMaterial({
      color: 0x4b8f38,
      roughness: 0.9,
      metalness: 0.02,
      flatShading: true,
    });
    const mossCaps = new THREE.InstancedMesh(mossGeo, mossMat, count);
    mossCaps.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const sp = spots[i];
      if (!sp) continue;

      dummy.position.set(sp.pos.x, sp.pos.y + sp.sy * 0.28, sp.pos.z);
      dummy.rotation.set(sp.rotX, sp.rotY, sp.rotZ);
      dummy.scale.set(sp.sx, sp.sy, sp.sz);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);

      // Warm sandstone/slate palette variation
      if (sp.tint < 0.45) {
        color.setHSL(0.07, 0.34, 0.44 + sp.tint * 0.16);
      } else {
        color.setHSL(0.58, 0.1, 0.42 + sp.tint * 0.14);
      }
      rocks.setColorAt(i, color);

      if (sp.mossy) {
        dummy.position.set(sp.pos.x, sp.pos.y + sp.sy * 0.56, sp.pos.z);
        dummy.rotation.set(0, sp.rotY, 0);
        dummy.scale.set(sp.sx * 0.92, sp.sy * 0.32, sp.sz * 0.92);
        dummy.updateMatrix();
        mossCaps.setMatrixAt(i, dummy.matrix);
      } else {
        mossCaps.setMatrixAt(i, ZERO_MATRIX);
      }

      this.anchors.push({
        category: "boulder",
        pos: { ...sp.pos },
        visible: true,
        bindings: [
          { mesh: rocks, index: i },
          { mesh: mossCaps, index: i },
        ],
      });
    }

    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    mossCaps.instanceMatrix.needsUpdate = true;
    this.sceneryGroup.add(rocks, mossCaps);
  }

  private buildInstancedFlora(
    spots: ReadonlyArray<{
      pos: Vec3;
      scale: number;
      rotY: number;
      kind: "shrub" | "tuft";
      flowerColorIdx: number;
      hasFlowers: boolean;
    }>,
  ): void {
    const count = spots.length;
    if (count === 0) return;

    const shrubGeo = new THREE.IcosahedronGeometry(0.42, 1);
    const shrubMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0.02,
      flatShading: true,
    });
    const shrubs = new THREE.InstancedMesh(shrubGeo, shrubMat, count);
    shrubs.castShadow = true;
    shrubs.receiveShadow = true;

    const tuftGeo = new THREE.ConeGeometry(0.085, 0.46, 5);
    const tuftMat = new THREE.MeshStandardMaterial({
      color: 0x4ca63c,
      roughness: 0.85,
      metalness: 0.0,
    });
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, count);

    const flowerGeo = new THREE.OctahedronGeometry(0.11, 0);
    const flowerMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x2a1a05,
      emissiveIntensity: 0.25,
      roughness: 0.55,
      metalness: 0.02,
    });
    const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, count);

    const flowerPalette = [0xffd84a, 0xff7062, 0x6ce5ff, 0xd896ff];
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const sp = spots[i];
      if (!sp) continue;
      const s = sp.scale;

      if (sp.kind === "shrub") {
        dummy.position.set(sp.pos.x, sp.pos.y + 0.22 * s, sp.pos.z);
        dummy.rotation.set(0, sp.rotY, 0);
        dummy.scale.set(1.22 * s, 0.74 * s, 1.18 * s);
        dummy.updateMatrix();
        shrubs.setMatrixAt(i, dummy.matrix);

        color.setHSL(0.27 + (i % 7) * 0.014, 0.6, 0.34 + (i % 5) * 0.03);
        shrubs.setColorAt(i, color);
        tufts.setMatrixAt(i, ZERO_MATRIX);
      } else {
        dummy.position.set(sp.pos.x, sp.pos.y + 0.2 * s, sp.pos.z);
        dummy.rotation.set(0.16, sp.rotY, -0.12);
        dummy.scale.set(1.25 * s, 1.0 * s, 1.25 * s);
        dummy.updateMatrix();
        tufts.setMatrixAt(i, dummy.matrix);
        shrubs.setMatrixAt(i, ZERO_MATRIX);
      }

      if (sp.hasFlowers) {
        const yOff = sp.kind === "shrub" ? 0.46 * s : 0.32 * s;
        dummy.position.set(
          sp.pos.x + Math.cos(sp.rotY) * 0.14 * s,
          sp.pos.y + yOff,
          sp.pos.z + Math.sin(sp.rotY) * 0.14 * s,
        );
        dummy.rotation.set(0.3, sp.rotY, 0.2);
        dummy.scale.setScalar(0.95 * s);
        dummy.updateMatrix();
        flowers.setMatrixAt(i, dummy.matrix);

        color.setHex(flowerPalette[sp.flowerColorIdx % flowerPalette.length] ?? 0xffd84a);
        flowers.setColorAt(i, color);
      } else {
        flowers.setMatrixAt(i, ZERO_MATRIX);
      }

      this.anchors.push({
        category: "flora",
        pos: { ...sp.pos },
        visible: true,
        bindings: [
          { mesh: shrubs, index: i },
          { mesh: tufts, index: i },
          { mesh: flowers, index: i },
        ],
      });
    }

    for (const m of [shrubs, tufts, flowers]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.sceneryGroup.add(m);
    }
  }

  private buildLandmarks(
    spots: ReadonlyArray<{ pos: Vec3; kind: "ruin" | "lantern"; rotY: number }>,
  ): void {
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      if (!sp) continue;

      const group = new THREE.Group();
      group.name = `${sp.kind}_${i}`;
      group.position.set(sp.pos.x, sp.pos.y, sp.pos.z);
      group.rotation.y = sp.rotY;

      if (sp.kind === "ruin") {
        // Ancient carved stone ruin column (strictly cylindrical/torus sculpted forms)
        const stoneMat = new THREE.MeshStandardMaterial({
          color: 0xc2b7a3,
          roughness: 0.88,
          metalness: 0.04,
          flatShading: true,
        });
        const base = new THREE.Mesh(
          new THREE.CylinderGeometry(0.46, 0.56, 0.34, 8),
          stoneMat,
        );
        base.position.y = 0.14;
        base.castShadow = true;
        base.receiveShadow = true;

        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28, 0.35, 2.05, 8),
          stoneMat.clone(),
        );
        shaft.position.y = 1.24;
        shaft.castShadow = true;
        shaft.receiveShadow = true;

        const collar = new THREE.Mesh(
          new THREE.TorusGeometry(0.32, 0.06, 7, 16),
          stoneMat.clone(),
        );
        collar.rotation.x = Math.PI * 0.5;
        collar.position.y = 2.1;

        const cap = new THREE.Mesh(
          new THREE.CylinderGeometry(0.44, 0.3, 0.26, 8),
          stoneMat.clone(),
        );
        cap.position.y = 2.34;
        cap.rotation.z = 0.08;
        cap.castShadow = true;

        group.add(base, shaft, collar, cap);
      } else {
        // Warm glowing island lantern post
        const woodMat = new THREE.MeshStandardMaterial({
          color: 0x6b472e,
          roughness: 0.86,
          metalness: 0.05,
        });
        const ironMat = new THREE.MeshStandardMaterial({
          color: 0x3b424d,
          roughness: 0.52,
          metalness: 0.65,
        });
        const glowMat = new THREE.MeshStandardMaterial({
          color: 0xffe49e,
          emissive: 0xffa62b,
          emissiveIntensity: 1.45,
          roughness: 0.25,
          metalness: 0.1,
        });

        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.08, 0.13, 2.35, 7),
          woodMat,
        );
        post.position.y = 1.12;
        post.castShadow = true;

        const footing = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.3, 0.24, 7),
          ironMat,
        );
        footing.position.y = 0.08;

        const arm = new THREE.Mesh(
          new THREE.CylinderGeometry(0.036, 0.044, 0.65, 6),
          ironMat.clone(),
        );
        arm.position.set(0.24, 2.22, 0);
        arm.rotation.z = -Math.PI * 0.38;

        const roof = new THREE.Mesh(
          new THREE.ConeGeometry(0.22, 0.2, 6),
          ironMat.clone(),
        );
        roof.position.set(0.48, 2.18, 0);

        const crystal = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.16, 0),
          glowMat,
        );
        crystal.position.set(0.48, 1.98, 0);

        group.add(post, footing, arm, roof, crystal);
      }

      this.sceneryGroup.add(group);
      this.anchors.push({
        category: "landmark",
        pos: { ...sp.pos },
        visible: true,
        bindings: [],
        landmarkGroup: group,
      });
    }
  }

  private createHazardVisual(hazard: HazardState): HazardVisual {
    const group = new THREE.Group();
    group.name = `hazard_${hazard.id}`;
    const pulseMaterials: THREE.MeshStandardMaterial[] = [];
    const phaseOffset =
      (hazard.position.x * 0.7 + hazard.position.z * 0.5) % (Math.PI * 2);

    if (hazard.type === "blast_barrel") {
      // Bulging sculpted explosive barrel via LatheGeometry + forged hoops + glowing core
      const profile = [
        new THREE.Vector2(0.01, 0.0),
        new THREE.Vector2(0.4, 0.0),
        new THREE.Vector2(0.48, 0.32),
        new THREE.Vector2(0.52, 0.62),
        new THREE.Vector2(0.48, 0.92),
        new THREE.Vector2(0.4, 1.18),
        new THREE.Vector2(0.01, 1.18),
      ];
      const barrelMat = new THREE.MeshStandardMaterial({
        color: 0xc93524,
        emissive: 0x6b1408,
        emissiveIntensity: 0.45,
        roughness: 0.52,
        metalness: 0.22,
      });
      pulseMaterials.push(barrelMat);

      const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 14), barrelMat);
      body.castShadow = true;
      body.receiveShadow = true;

      const hoopMat = new THREE.MeshStandardMaterial({
        color: 0x2c3038,
        roughness: 0.42,
        metalness: 0.75,
      });
      const lowHoop = new THREE.Mesh(
        new THREE.TorusGeometry(0.49, 0.038, 8, 20),
        hoopMat,
      );
      lowHoop.rotation.x = Math.PI * 0.5;
      lowHoop.position.y = 0.28;

      const highHoop = new THREE.Mesh(
        new THREE.TorusGeometry(0.49, 0.038, 8, 20),
        hoopMat.clone(),
      );
      highHoop.rotation.x = Math.PI * 0.5;
      highHoop.position.y = 0.88;

      const coreMat = new THREE.MeshStandardMaterial({
        color: 0xffc845,
        emissive: 0xff6214,
        emissiveIntensity: 1.5,
        roughness: 0.22,
        metalness: 0.1,
      });
      pulseMaterials.push(coreMat);

      const emberTop = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), coreMat);
      emberTop.position.y = 1.24;

      const warningRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.74, 0.032, 8, 24),
        new THREE.MeshBasicMaterial({
          color: 0xff7b29,
          transparent: true,
          opacity: 0.58,
          depthWrite: false,
        }),
      );
      warningRing.rotation.x = Math.PI * 0.5;
      warningRing.position.y = 0.08;

      group.add(body, lowHoop, highHoop, emberTop, warningRing);
      return {
        type: hazard.type,
        group,
        pulseMaterials,
        warningRing,
        phaseOffset,
      };
    }

    if (hazard.type === "steam_geyser") {
      // Sculpted volcanic geothermal vent + glowing spring pool + rising steam puffs
      const rockMat = new THREE.MeshStandardMaterial({
        color: 0x5c6670,
        roughness: 0.9,
        metalness: 0.08,
        flatShading: true,
      });
      const mound = new THREE.Mesh(
        new THREE.CylinderGeometry(0.68, 1.15, 0.42, 10),
        rockMat,
      );
      mound.position.y = 0.18;
      mound.castShadow = true;
      mound.receiveShadow = true;

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.76, 0.22, 8, 18),
        rockMat.clone(),
      );
      rim.rotation.x = Math.PI * 0.5;
      rim.position.y = 0.34;

      const poolMat = new THREE.MeshStandardMaterial({
        color: 0x7ef9ff,
        emissive: 0x1fd8f0,
        emissiveIntensity: 1.2,
        roughness: 0.18,
        metalness: 0.1,
      });
      pulseMaterials.push(poolMat);

      const pool = new THREE.Mesh(
        new THREE.CylinderGeometry(0.62, 0.62, 0.08, 14),
        poolMat,
      );
      pool.position.y = 0.32;

      const steamPuffs: THREE.Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const puff = new THREE.Mesh(
          new THREE.SphereGeometry(0.3, 10, 8),
          new THREE.MeshBasicMaterial({
            color: 0xe8ffff,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          }),
        );
        puff.position.y = 0.55 + i * 0.55;
        group.add(puff);
        steamPuffs.push(puff);
      }

      group.add(mound, rim, pool);
      return {
        type: hazard.type,
        group,
        pulseMaterials,
        steamPuffs,
        phaseOffset,
      };
    }

    if (hazard.type === "spark_mine") {
      // Sculpted proximity Spark Mine: dark forged metallic dome + pulsing crimson LED beacon + glowing sensor ring
      const hullMat = new THREE.MeshStandardMaterial({
        color: 0x262d38,
        roughness: 0.36,
        metalness: 0.78,
      });
      const baseRing = new THREE.Mesh(
        new THREE.CylinderGeometry(0.48, 0.58, 0.18, 14),
        hullMat,
      );
      baseRing.position.y = 0.09;
      baseRing.castShadow = true;
      baseRing.receiveShadow = true;

      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(0.44, 14, 10),
        hullMat.clone(),
      );
      dome.name = "spark_mine_dome";
      dome.scale.set(1.0, 0.56, 1.0);
      dome.position.y = 0.21;
      dome.castShadow = true;
      dome.receiveShadow = true;

      const collarMat = new THREE.MeshStandardMaterial({
        color: 0x3b4454,
        roughness: 0.34,
        metalness: 0.82,
      });
      const ledCollar = new THREE.Mesh(
        new THREE.TorusGeometry(0.16, 0.036, 8, 16),
        collarMat,
      );
      ledCollar.rotation.x = Math.PI * 0.5;
      ledCollar.position.y = 0.44;

      const beaconMat = new THREE.MeshStandardMaterial({
        color: 0xff3b5c,
        emissive: 0xff1744,
        emissiveIntensity: 1.9,
        roughness: 0.16,
        metalness: 0.1,
      });
      pulseMaterials.push(beaconMat);

      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.135, 12, 10),
        beaconMat,
      );
      beacon.name = "spark_mine_beacon";
      beacon.position.y = 0.51;

      const prongMat = new THREE.MeshStandardMaterial({
        color: 0x525d70,
        emissive: 0xb91c1c,
        emissiveIntensity: 0.45,
        roughness: 0.34,
        metalness: 0.76,
      });
      pulseMaterials.push(prongMat);

      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const prong = new THREE.Mesh(
          new THREE.ConeGeometry(0.06, 0.24, 6),
          prongMat.clone(),
        );
        prong.position.set(Math.cos(a) * 0.44, 0.31, Math.sin(a) * 0.44);
        prong.rotation.set(Math.sin(a) * 0.78, -a, -Math.cos(a) * 0.78);
        prong.castShadow = true;
        group.add(prong);
      }

      const warningRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.88, 0.038, 8, 28),
        new THREE.MeshBasicMaterial({
          color: 0xff4769,
          transparent: true,
          opacity: 0.64,
          depthWrite: false,
        }),
      );
      warningRing.name = "spark_mine_ring";
      warningRing.rotation.x = Math.PI * 0.5;
      warningRing.position.y = 0.08;

      group.add(baseRing, dome, ledCollar, beacon, warningRing);
      return {
        type: hazard.type,
        group,
        pulseMaterials,
        warningRing,
        phaseOffset,
      };
    }

    // 'thorn_patch': Tangled bramble vine coils + sharp conical thorns + glowing magenta spores
    const vineMat = new THREE.MeshStandardMaterial({
      color: 0x3b1f3d,
      roughness: 0.85,
      metalness: 0.05,
    });
    const outerCoil = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.11, 8, 22),
      vineMat,
    );
    outerCoil.rotation.x = Math.PI * 0.5;
    outerCoil.position.y = 0.12;
    outerCoil.castShadow = true;

    const innerCoil = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.09, 7, 18),
      vineMat.clone(),
    );
    innerCoil.rotation.set(Math.PI * 0.42, 0.4, 0.25);
    innerCoil.position.y = 0.22;

    const thornMat = new THREE.MeshStandardMaterial({
      color: 0x6c246e,
      emissive: 0x420a48,
      emissiveIntensity: 0.4,
      roughness: 0.6,
      metalness: 0.15,
    });
    const sporeMat = new THREE.MeshStandardMaterial({
      color: 0xff62e8,
      emissive: 0xe61fd6,
      emissiveIntensity: 1.35,
      roughness: 0.25,
      metalness: 0.1,
    });
    pulseMaterials.push(sporeMat);

    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const rad = i % 2 === 0 ? 0.92 : 0.46;
      const thorn = new THREE.Mesh(
        new THREE.ConeGeometry(0.11, 0.72, 6),
        thornMat.clone(),
      );
      thorn.position.set(Math.cos(a) * rad, 0.34, Math.sin(a) * rad);
      thorn.rotation.set(Math.sin(a) * 0.38, -a, -Math.cos(a) * 0.38);
      thorn.castShadow = true;
      group.add(thorn);

      if (i % 2 === 0) {
        const bud = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.11, 0),
          sporeMat,
        );
        bud.position.set(Math.cos(a) * (rad * 0.85), 0.52, Math.sin(a) * (rad * 0.85));
        group.add(bud);
      }
    }

    group.add(outerCoil, innerCoil);
    return {
      type: hazard.type,
      group,
      pulseMaterials,
      phaseOffset,
    };
  }

  private animateHazardVisual(visual: HazardVisual, elapsedSec: number): void {
    const phase = elapsedSec * 3.6 + visual.phaseOffset;

    if (visual.type === "blast_barrel") {
      const pulse = 0.5 + 0.5 * Math.sin(phase * 1.4);
      const bodyMat = visual.pulseMaterials[0];
      const coreMat = visual.pulseMaterials[1];
      if (bodyMat) {
        bodyMat.emissiveIntensity = 0.3 + pulse * 0.55;
      }
      if (coreMat) {
        coreMat.emissiveIntensity = 1.0 + pulse * 1.1;
      }
      if (visual.warningRing) {
        const ringScale = 0.92 + pulse * 0.24;
        visual.warningRing.scale.set(ringScale, ringScale, 1);
      }
      return;
    }

    if (visual.type === "spark_mine") {
      const pulse = 0.5 + 0.5 * Math.sin(phase * 2.1);
      const coreMat = visual.pulseMaterials[0];
      const prongMat = visual.pulseMaterials[1];
      if (coreMat) {
        coreMat.emissiveIntensity = 1.15 + pulse * 1.35;
      }
      if (prongMat) {
        prongMat.emissiveIntensity = 0.45 + pulse * 0.75;
      }
      if (visual.warningRing) {
        const ringScale = 0.9 + pulse * 0.28;
        visual.warningRing.scale.set(ringScale, ringScale, 1);
      }
      return;
    }

    if (visual.type === "steam_geyser") {
      const poolMat = visual.pulseMaterials[0];
      if (poolMat) {
        poolMat.emissiveIntensity = 0.95 + Math.sin(phase) * 0.35;
      }
      if (visual.steamPuffs) {
        const count = visual.steamPuffs.length;
        for (let i = 0; i < count; i++) {
          const puff = visual.steamPuffs[i];
          if (!puff) continue;
          const cycle = (elapsedSec * 0.75 + i / count + visual.phaseOffset * 0.1) % 1;
          const swirlAngle = cycle * Math.PI * 2 + i * 1.7;
          const spread = cycle * 0.34;
          puff.position.set(
            Math.cos(swirlAngle) * spread,
            0.42 + cycle * 2.55,
            Math.sin(swirlAngle) * spread,
          );
          const s = 0.45 + cycle * 1.15;
          puff.scale.setScalar(s);
          if (puff.material instanceof THREE.MeshBasicMaterial) {
            puff.material.opacity = Math.sin(cycle * Math.PI) * 0.58;
          }
        }
      }
      return;
    }

    const sporeMat = visual.pulseMaterials[0];
    if (sporeMat) {
      sporeMat.emissiveIntensity = 0.85 + Math.sin(phase * 1.15) * 0.55;
    }
  }
}
