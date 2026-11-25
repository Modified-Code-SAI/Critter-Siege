import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearModelCache,
  getSpeciesModelUrl,
  hasCustomGlbSpecies,
  loadSpeciesModel,
  normalizeGlbModel,
} from "../src/scene/modelLoader.js";

describe("modelLoader", () => {
  afterEach(() => {
    clearModelCache();
  });

  it("maps the 4 Hunyuan3D starter species to /models/<species>.glb and leaves unlockables procedural", () => {
    expect(hasCustomGlbSpecies("mole")).toBe(true);
    expect(hasCustomGlbSpecies("norway_rat")).toBe(true);
    expect(hasCustomGlbSpecies("badger")).toBe(true);
    expect(hasCustomGlbSpecies("glider_squirrel")).toBe(true);

    expect(hasCustomGlbSpecies("hedgehog")).toBe(false);
    expect(hasCustomGlbSpecies("armadillo")).toBe(false);

    expect(getSpeciesModelUrl("mole")).toBe("/models/mole.glb");
    expect(getSpeciesModelUrl("norway_rat")).toBe("/models/norway_rat.glb");
    expect(getSpeciesModelUrl("badger")).toBe("/models/badger.glb");
    expect(getSpeciesModelUrl("glider_squirrel")).toBe(
      "/models/glider_squirrel.glb",
    );
    expect(getSpeciesModelUrl("hedgehog")).toBeNull();
    expect(getSpeciesModelUrl("armadillo")).toBeNull();
  });

  it("falls back gracefully to null in headless Node environments without throwing", async () => {
    await expect(loadSpeciesModel("mole")).resolves.toBeNull();
    await expect(loadSpeciesModel("hedgehog")).resolves.toBeNull();
  });

  it("normalizes GLB meshes with shadows, grounded y=0 feet, +Z forward orientation, and sunlit PBR roughness", () => {
    const raw = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.1,
      metalness: 0.8,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), mat);
    mesh.position.set(0, 0.75, 0);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    raw.add(mesh);

    const normalized = normalizeGlbModel(raw, "badger");
    expect(normalized.name).toBe("glb_badger");
    expect(normalized.rotation.y).toBe(0);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(mat.roughness).toBeGreaterThanOrEqual(0.45);
    expect(mat.metalness).toBeLessThanOrEqual(0.25);

    const box = new THREE.Box3().setFromObject(normalized);
    expect(Math.abs(box.min.y)).toBeLessThan(0.01);

    mesh.geometry.dispose();
    mat.dispose();
  });
});
