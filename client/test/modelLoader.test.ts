import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearModelCache,
  getPropModelUrl,
  getSpeciesModelUrl,
  hasCustomGlbSpecies,
  loadPropModel,
  loadSpeciesModel,
  normalizeGlbModel,
  normalizePropGlbModel,
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

  it("maps the 3 Blender GLB landmark props, falls back to null in Node, and normalizes prop GLBs cleanly", async () => {
    expect(getPropModelUrl("watchtower")).toBe("/models/props/watchtower.glb");
    expect(getPropModelUrl("ruin_arch")).toBe("/models/props/ruin_arch.glb");
    expect(getPropModelUrl("gnarled_pine")).toBe("/models/props/gnarled_pine.glb");

    await expect(loadPropModel("watchtower")).resolves.toBeNull();
    await expect(loadPropModel("ruin_arch")).resolves.toBeNull();
    await expect(loadPropModel("gnarled_pine")).resolves.toBeNull();

    const raw = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.12,
      metalness: 0.7,
    });
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 2.0, 8), mat);
    mesh.position.set(0, 1.5, 0);
    raw.add(mesh);

    const normalized = normalizePropGlbModel(raw, "watchtower");
    expect(normalized.name).toBe("glb_prop_watchtower");
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(mat.roughness).toBeGreaterThanOrEqual(0.45);

    const box = new THREE.Box3().setFromObject(normalized);
    expect(Math.abs(box.min.y)).toBeLessThan(0.01);

    mesh.geometry.dispose();
    mat.dispose();
  });
});
