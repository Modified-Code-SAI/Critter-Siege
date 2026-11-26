import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GAME_TITLE, SPECIES_IDS } from "@critter/shared";
import { getSpeciesPortraitUrl } from "../src/ui/hud.js";

describe("client smoke", () => {
  it("resolves shared GAME_TITLE for client", () => {
    expect(GAME_TITLE).toBe("Critter Siege");
  });

  it("provides crisp 3D portrait JPG assets for all 6 playable species", () => {
    for (const species of SPECIES_IDS) {
      const url = getSpeciesPortraitUrl(species);
      expect(url).toBe(`/portraits/${species}.jpg`);
      const diskPath = resolve(process.cwd(), "client/public", url.slice(1));
      expect(existsSync(diskPath)).toBe(true);
      expect(statSync(diskPath).size).toBeGreaterThan(2048);
    }
  });
});
