import * as THREE from "three";
import {
  chunkKey,
  meshChunkSurfaceNets,
  type SdfWorld,
} from "@critter/shared";

const UV_SCALE = 0.24;

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

/** Deterministic seamless 2D periodic micro-noise in [0, 1] for crisp tileable terrain textures. */
function samplePeriodicDetail(u: number, v: number, seedOffset: number): number {
  const tau = Math.PI * 2;
  const a = u * tau;
  const b = v * tau;

  // Stratified horizontal sedimentary bands + fine organic pebble & grass-blade grain
  const strata =
    Math.sin(b * 4 + Math.sin(a * 2 + seedOffset) * 0.55) * 0.22 +
    Math.sin(b * 10 - Math.cos(a * 3 - seedOffset) * 0.4) * 0.14;
  const organic =
    Math.sin(a * 6 + b * 5 + seedOffset) * Math.cos(a * 5 - b * 7) * 0.24 +
    Math.sin(a * 13 - b * 11 + seedOffset * 1.7) * 0.14 +
    Math.cos(a * 21 + b * 19 - seedOffset * 0.9) * 0.1;

  // Crisp micro-speckle hash (periodic in [0..1])
  const ix = Math.floor(u * 64) & 63;
  const iy = Math.floor(v * 64) & 63;
  const h =
    Math.sin(ix * 127.1 + iy * 311.7 + seedOffset * 74.7) * 43758.5453123;
  const grain = (h - Math.floor(h) - 0.5) * 0.22;

  return Math.max(0, Math.min(1, 0.5 + strata + organic + grain));
}

function createProceduralDetailTextures(): {
  bumpTexture: THREE.Texture;
  roughnessTexture: THREE.Texture;
} {
  const configure = (tex: THREE.Texture): THREE.Texture => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1);
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  };

  if (typeof document !== "undefined") {
    const size = 256;
    const bumpCanvas = document.createElement("canvas");
    bumpCanvas.width = size;
    bumpCanvas.height = size;
    const roughCanvas = document.createElement("canvas");
    roughCanvas.width = size;
    roughCanvas.height = size;

    const bumpCtx = bumpCanvas.getContext("2d");
    const roughCtx = roughCanvas.getContext("2d");

    if (bumpCtx && roughCtx) {
      const bumpImg = bumpCtx.createImageData(size, size);
      const roughImg = roughCtx.createImageData(size, size);

      for (let py = 0; py < size; py++) {
        const v = py / size;
        for (let px = 0; px < size; px++) {
          const u = px / size;
          const idx = (py * size + px) * 4;

          const h = samplePeriodicDetail(u, v, 1.3);
          const bumpByte = Math.round(h * 255);
          bumpImg.data[idx] = bumpByte;
          bumpImg.data[idx + 1] = bumpByte;
          bumpImg.data[idx + 2] = bumpByte;
          bumpImg.data[idx + 3] = 255;

          const r = samplePeriodicDetail(u, v, 9.7);
          const roughVal = Math.round((0.68 + r * 0.28) * 255);
          roughImg.data[idx] = roughVal;
          roughImg.data[idx + 1] = roughVal;
          roughImg.data[idx + 2] = roughVal;
          roughImg.data[idx + 3] = 255;
        }
      }

      bumpCtx.putImageData(bumpImg, 0, 0);
      roughCtx.putImageData(roughImg, 0, 0);

      return {
        bumpTexture: configure(new THREE.CanvasTexture(bumpCanvas)),
        roughnessTexture: configure(new THREE.CanvasTexture(roughCanvas)),
      };
    }
  }

  // Headless Node / Vitest fallback using deterministic DataTextures
  const size = 64;
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const u = px / size;
      const idx = (py * size + px) * 4;
      const bumpByte = Math.round(samplePeriodicDetail(u, v, 1.3) * 255);
      bumpData[idx] = bumpByte;
      bumpData[idx + 1] = bumpByte;
      bumpData[idx + 2] = bumpByte;
      bumpData[idx + 3] = 255;

      const roughByte = Math.round(
        (0.68 + samplePeriodicDetail(u, v, 9.7) * 0.28) * 255,
      );
      roughData[idx] = roughByte;
      roughData[idx + 1] = roughByte;
      roughData[idx + 2] = roughByte;
      roughData[idx + 3] = 255;
    }
  }

  return {
    bumpTexture: configure(new THREE.DataTexture(bumpData, size, size)),
    roughnessTexture: configure(new THREE.DataTexture(roughData, size, size)),
  };
}

/**
 * Compute world-space box-projected (triplanar-style) UVs from vertex positions & normals
 * so flat grass hilltops and steep sandstone cliffs both display crisp zero-stretch micro-detail.
 */
function buildBoxProjectedUvs(
  positions: Float32Array,
  normals: Float32Array,
): Float32Array {
  const vertCount = positions.length / 3;
  const uvs = new Float32Array(vertCount * 2);

  for (let i = 0; i < vertCount; i++) {
    const px = positions[i * 3] ?? 0;
    const py = positions[i * 3 + 1] ?? 0;
    const pz = positions[i * 3 + 2] ?? 0;

    const ax = Math.abs(normals[i * 3] ?? 0);
    const ay = Math.abs(normals[i * 3 + 1] ?? 1);
    const az = Math.abs(normals[i * 3 + 2] ?? 0);

    if (ay >= ax && ay >= az) {
      uvs[i * 2] = px * UV_SCALE;
      uvs[i * 2 + 1] = pz * UV_SCALE;
    } else if (ax >= az) {
      uvs[i * 2] = pz * UV_SCALE;
      uvs[i * 2 + 1] = py * UV_SCALE;
    } else {
      uvs[i * 2] = px * UV_SCALE;
      uvs[i * 2 + 1] = py * UV_SCALE;
    }
  }

  return uvs;
}

/**
 * Chunked Three.js Surface Nets renderer for sculpted Critter Siege SDF islands.
 * Applies world-space box-projected procedural micro-detail bump & roughness maps
 * and manages strict GPU disposal on carve updates.
 */
export class TerrainRenderer {
  public readonly group: THREE.Group;

  private readonly bumpTexture: THREE.Texture;
  private readonly roughnessTexture: THREE.Texture;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly chunkMeshes: Map<string, THREE.Mesh> = new Map();

  public constructor(world: SdfWorld) {
    this.group = new THREE.Group();
    this.group.name = "terrain_chunks";

    const textures = createProceduralDetailTextures();
    this.bumpTexture = textures.bumpTexture;
    this.roughnessTexture = textures.roughnessTexture;

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      roughnessMap: this.roughnessTexture,
      bumpMap: this.bumpTexture,
      bumpScale: 0.14,
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

  /** Dispose all chunk geometries, procedural textures, and the shared terrain material. */
  public dispose(): void {
    this.clearAllChunks();
    this.bumpTexture.dispose();
    this.roughnessTexture.dispose();
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

    const uvs = buildBoxProjectedUvs(meshData.positions, meshData.normals);

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
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
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
