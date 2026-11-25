import * as THREE from "three";
import {
  chunkKey,
  meshChunkSurfaceNets,
  type SdfWorld,
} from "@critter/shared";

function parseChunkKey(
  key: string,
): { cx: number; cy: number; cz: number } | null {
  const parts = key.split(",");
  if (parts.length !== 3) {
    return null;
  }
  const cx = Number(parts[0]);
  const cy = Number(parts[1]);
  const cz = Number(parts[2]);
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || !Number.isInteger(cz)) {
    return null;
  }
  return { cx, cy, cz };
}

/**
 * Chunked Three.js Surface Nets renderer for sculpted Critter Siege SDF islands.
 * Manages per-chunk BufferGeometry lifecycle with strict GPU disposal on carve updates.
 */
export class TerrainRenderer {
  public readonly group: THREE.Group;

  private readonly material: THREE.MeshStandardMaterial;
  private readonly chunkMeshes: Map<string, THREE.Mesh> = new Map();

  public constructor(world: SdfWorld) {
    this.group = new THREE.Group();
    this.group.name = "terrain_chunks";
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.04,
    });
    this.rebuildAll(world);
  }

  /** Rebuild only the specified dirty chunk keys, disposing replaced BufferGeometries. */
  public rebuildChunks(world: SdfWorld, dirtyKeys: readonly string[]): void {
    const uniqueKeys = new Set<string>(dirtyKeys);
    for (const key of uniqueKeys) {
      const coord = parseChunkKey(key);
      if (!coord) {
        continue;
      }
      this.rebuildSingleChunk(world, coord.cx, coord.cy, coord.cz);
    }
  }

  /** Dispose all existing chunk geometries and mesh every chunk of the SDF world. */
  public rebuildAll(world: SdfWorld): void {
    this.clearAllChunks();
    for (const coord of world.getAllChunkCoords()) {
      this.rebuildSingleChunk(world, coord.cx, coord.cy, coord.cz);
    }
  }

  /** Dispose all chunk geometries and the shared terrain material. */
  public dispose(): void {
    this.clearAllChunks();
    this.material.dispose();
  }

  private clearAllChunks(): void {
    for (const mesh of this.chunkMeshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
  }

  private rebuildSingleChunk(
    world: SdfWorld,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    const key = chunkKey(cx, cy, cz);
    const meshData = meshChunkSurfaceNets(world, cx, cy, cz);
    const existing = this.chunkMeshes.get(key);

    if (meshData.indices.length === 0 || meshData.positions.length === 0) {
      if (existing) {
        this.group.remove(existing);
        existing.geometry.dispose();
        this.chunkMeshes.delete(key);
      }
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(meshData.positions, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(meshData.normals, 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(meshData.colors, 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geometry;
      return;
    }

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = `chunk_${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.chunkMeshes.set(key, mesh);
  }
}
