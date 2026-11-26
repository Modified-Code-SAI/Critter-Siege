import { describe, expect, it } from "vitest";
import {
  PROFILE_STORAGE_KEY,
  ProgressionStore,
  calculateEssenceReward,
  type StorageLike,
} from "../src/profile/progression.js";

function createMemoryStorage(
  initial?: Record<string, string>,
): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    data,
    getItem(key: string): string | null {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      data.set(key, value);
    },
  };
}

describe("Siege Essence progression", () => {
  it("calculates exact Siege Essence rewards (+20 finish, +15/KO, +10/EvoPod, +30 win)", () => {
    expect(
      calculateEssenceReward({
        finished: true,
        kos: 0,
        evoPodsCollected: 0,
        won: false,
      }),
    ).toBe(20);

    expect(
      calculateEssenceReward({
        finished: true,
        kos: 2,
        evoPodsCollected: 3,
        won: true,
      }),
    ).toBe(20 + 30 + 30 + 30);

    expect(
      calculateEssenceReward({
        finished: false,
        kos: 1,
        evoPodsCollected: 2,
        won: false,
      }),
    ).toBe(15 + 20);
  });

  it("persists profile across instances, deducts Essence on purchases, and rejects duplicate or unaffordable unlocks", () => {
    const storage = createMemoryStorage();
    const storeA = new ProgressionStore(storage);

    const initial = storeA.getProfile();
    expect(initial.essence).toBe(0);
    expect(initial.selectedSpecies).toBe("mole");
    expect(initial.unlockedSpecies).toEqual([
      "mole",
      "norway_rat",
      "badger",
      "glider_squirrel",
    ]);

    // Unaffordable purchase should fail cleanly without mutating essence
    const tooPoor = storeA.purchaseSpecies("hedgehog");
    expect(tooPoor.ok).toBe(false);
    expect(tooPoor.reason).toBeTruthy();
    expect(tooPoor.profile.essence).toBe(0);
    expect(tooPoor.profile.unlockedSpecies).not.toContain("hedgehog");

    // Award 2 matches worth of essence: 2 * (20 + 30 + 20 + 30) = 200
    const reward1 = storeA.awardMatchEssence({
      finished: true,
      kos: 2,
      evoPodsCollected: 2,
      won: true,
    });
    expect(reward1.earned).toBe(100);
    const reward2 = storeA.awardMatchEssence({
      finished: true,
      kos: 2,
      evoPodsCollected: 2,
      won: true,
    });
    expect(reward2.earned).toBe(100);
    expect(reward2.profile.essence).toBe(200);
    expect(reward2.profile.matchesPlayed).toBe(2);
    expect(reward2.profile.wins).toBe(2);

    // Purchase Quill Hedgehog (80 Essence)
    const buyHedgehog = storeA.purchaseSpecies("hedgehog");
    expect(buyHedgehog.ok).toBe(true);
    expect(buyHedgehog.profile.essence).toBe(120);
    expect(buyHedgehog.profile.unlockedSpecies).toContain("hedgehog");

    // Duplicate species purchase rejected without deducting Essence
    const dupHedgehog = storeA.purchaseSpecies("hedgehog");
    expect(dupHedgehog.ok).toBe(false);
    expect(dupHedgehog.profile.essence).toBe(120);

    // Purchase Gravity Mine (90 Essence)
    const buyMine = storeA.purchaseBonusGadget("gravity_mine");
    expect(buyMine.ok).toBe(true);
    expect(buyMine.profile.essence).toBe(30);
    expect(buyMine.profile.unlockedBonusGadgets).toContain("gravity_mine");

    // Duplicate gadget purchase rejected without deducting Essence
    const dupMine = storeA.purchaseBonusGadget("gravity_mine");
    expect(dupMine.ok).toBe(false);
    expect(dupMine.profile.essence).toBe(30);

    // Unaffordable gadget purchase rejected without deducting Essence
    const tooPoorGadget = storeA.purchaseBonusGadget("shock_magnet");
    expect(tooPoorGadget.ok).toBe(false);
    expect(tooPoorGadget.profile.essence).toBe(30);
    expect(tooPoorGadget.profile.unlockedBonusGadgets).not.toContain(
      "shock_magnet",
    );

    storeA.setDisplayName("BurrowBoss");
    storeA.selectSpecies("hedgehog");
    storeA.selectColor("#22c55e");

    // Verify full persistence in a brand-new ProgressionStore reading the same storage
    const storeB = new ProgressionStore(storage);
    const persisted = storeB.getProfile();
    expect(storage.getItem(PROFILE_STORAGE_KEY)).not.toBeNull();
    expect(persisted.displayName).toBe("BurrowBoss");
    expect(persisted.essence).toBe(30);
    expect(persisted.selectedSpecies).toBe("hedgehog");
    expect(persisted.selectedColor).toBe("#22c55e");
    expect(persisted.unlockedSpecies).toContain("hedgehog");
    expect(persisted.unlockedBonusGadgets).toContain("gravity_mine");
    expect(persisted.matchesPlayed).toBe(2);
    expect(persisted.wins).toBe(2);
  });

  it("safely falls back to the default profile when storage contains corrupted JSON", () => {
    const storage = createMemoryStorage({
      [PROFILE_STORAGE_KEY]: "{not valid json!! [broken",
    });

    const store = new ProgressionStore(storage);
    const profile = store.getProfile();
    expect(profile.essence).toBe(0);
    expect(profile.selectedSpecies).toBe("mole");
    expect(profile.unlockedSpecies).toEqual([
      "mole",
      "norway_rat",
      "badger",
      "glider_squirrel",
    ]);
    expect(profile.unlockedBonusGadgets).toEqual([]);
  });
});
