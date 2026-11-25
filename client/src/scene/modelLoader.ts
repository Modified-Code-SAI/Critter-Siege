import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SpeciesId } from "@critter/shared";

/** Starter species backed by sculpted Hunyuan3D-2 + Blender GLB hero models. */
const CUSTOM_GLB_URLS: Partial<Record<SpeciesId, string>> = {
  mole: "/models/mole.glb",
  norway_rat: "/models/norway_rat.glb",
  badger: "/models/badger.glb",
  glider_squirrel: "/models/glider_squirrel.glb",
};

const templateCache = new Map<SpeciesId, Promise<THREE.Group | null>>();
const resolvedTemplates = new Map<SpeciesId, THREE.Group>();
let sharedLoader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
  }
  return sharedLoader;
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

function disposeTemplateTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    }
  });
}

function tuneGlbMaterial(material: THREE.Material): void {
  if (material instanceof THREE.MeshStandardMaterial) {
    material.roughness = Math.max(0.48, Math.min(0.92, material.roughness));
    material.metalness = Math.min(0.22, Math.max(0.0, material.metalness));
    material.envMapIntensity = 0.85;
    if (material.map) {
      material.map.colorSpace = THREE.SRGBColorSpace;
    }
  }
}

/** Return true if a species has a sculpted GLB hero model in client/public/models/. */
export function hasCustomGlbSpecies(species: SpeciesId): boolean {
  return CUSTOM_GLB_URLS[species] !== undefined;
}

/** Return the static Vite public URL for a species GLB model, or null if procedural. */
export function getSpeciesModelUrl(species: SpeciesId): string | null {
  return CUSTOM_GLB_URLS[species] ?? null;
}

/**
 * Normalize a loaded glTF scene into a grounded (min.y === 0), +Z-facing,
 * shadow-casting THREE.Group tuned for Critter Siege's sunlit outdoor lighting.
 */
export function normalizeGlbModel(
  sceneRoot: THREE.Object3D,
  species: SpeciesId,
): THREE.Group {
  const wrapper = new THREE.Group();
  wrapper.name = `glb_${species}`;

  sceneRoot.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      obj.frustumCulled = true;
      if (Array.isArray(obj.material)) {
        for (const mat of obj.material) {
          tuneGlbMaterial(mat);
        }
      } else {
        tuneGlbMaterial(obj.material);
      }
    }
  });

  wrapper.add(sceneRoot);
  wrapper.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(wrapper);
  if (
    Number.isFinite(box.min.y) &&
    Number.isFinite(box.max.y) &&
    Math.abs(box.min.y) > 0.002 &&
    Math.abs(box.min.y) < 5
  ) {
    sceneRoot.position.y -= box.min.y;
    wrapper.updateMatrixWorld(true);
  }

  return wrapper;
}

function cloneNormalizedTemplate(template: THREE.Group): THREE.Group {
  const clone = template.clone(true);
  clone.userData.isCachedGlbClone = true;
  clone.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  return clone;
}

/**
 * Load and cache a sculpted GLB hero model for the requested species.
 * Returns a ready-to-attach cloned THREE.Group, or null in headless Node / offline
 * environments or for procedural-only species (hedgehog, armadillo).
 */
export async function loadSpeciesModel(
  species: SpeciesId,
): Promise<THREE.Group | null> {
  const url = getSpeciesModelUrl(species);
  if (!url) {
    return null;
  }

  // Graceful fallback in headless Node Vitest or SSR environments
  if (typeof window === "undefined" || typeof fetch === "undefined") {
    return null;
  }

  let pending = templateCache.get(species);
  if (!pending) {
    const loader = getLoader();
    pending = loader
      .loadAsync(url)
      .then((gltf) => {
        const normalized = normalizeGlbModel(gltf.scene, species);
        resolvedTemplates.set(species, normalized);
        return normalized;
      })
      .catch(() => null);
    templateCache.set(species, pending);
  }

  const template = await pending;
  if (!template) {
    return null;
  }
  return cloneNormalizedTemplate(template);
}

/** Warm the browser cache for all 4 sculpted GLB hero critters in the background. */
export function preloadAllSpeciesModels(): void {
  if (typeof window === "undefined" || typeof fetch === "undefined") {
    return;
  }
  const speciesList: readonly SpeciesId[] = [
    "mole",
    "norway_rat",
    "badger",
    "glider_squirrel",
  ];
  for (const species of speciesList) {
    void loadSpeciesModel(species);
  }
}

/** Clear and GPU-dispose all cached GLB templates (primarily for cleanup & tests). */
export function clearModelCache(): void {
  for (const template of resolvedTemplates.values()) {
    disposeTemplateTree(template);
  }
  resolvedTemplates.clear();
  templateCache.clear();
}
