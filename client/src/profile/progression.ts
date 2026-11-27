import {
  GADGET_CATALOG,
  SPECIES_CATALOG,
  SPECIES_IDS,
  type GadgetId,
  type SpeciesId,
} from "@critter/shared";

/** LocalStorage key for persisting the player's Critter Siege Essence profile. */
export const PROFILE_STORAGE_KEY = "critter_siege_profile_v1";

/** Unlockable Siege Essence cosmetic collar & aura accent definition. */
export interface CosmeticAccentDefinition {
  id: string;
  name: string;
  hex: string;
  cost: number;
  description: string;
}

/** Catalog of Siege Essence cosmetic collar & aura accents. */
export const COSMETIC_ACCENT_CATALOG: readonly CosmeticAccentDefinition[] = [
  {
    id: "neon_cyan",
    name: "Glacier Glow",
    hex: "#22d3ee",
    cost: 40,
    description: "Luminous arctic teal collar & aura accent.",
  },
  {
    id: "solar_gold",
    name: "Solar Crown",
    hex: "#facc15",
    cost: 60,
    description: "Radiant golden-hour champion trim.",
  },
  {
    id: "void_magenta",
    name: "Nebula Pulse",
    hex: "#ec4899",
    cost: 80,
    description: "Electric magenta apex energy accent.",
  },
  {
    id: "emerald_aura",
    name: "Emerald Sovereign",
    hex: "#10b981",
    cost: 100,
    description: "Vibrant forest-gemstone prestige glow.",
  },
];

const COSMETIC_ACCENT_MAP: ReadonlyMap<string, CosmeticAccentDefinition> =
  new Map(COSMETIC_ACCENT_CATALOG.map((def) => [def.id, def]));

/** Persistent browser-local player profile and Siege Essence unlocks. */
export interface PlayerProfile {
  displayName: string;
  essence: number;
  unlockedSpecies: SpeciesId[];
  unlockedBonusGadgets: GadgetId[];
  unlockedCosmetics: string[];
  selectedSpecies: SpeciesId;
  selectedColor: string;
  matchesPlayed: number;
  wins: number;
}

/** Match performance stats used to compute Siege Essence rewards. */
export interface MatchRewardInput {
  finished: boolean;
  kos: number;
  evoPodsCollected: number;
  won: boolean;
}

/** Minimal synchronous key-value storage contract (compatible with localStorage). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DEFAULT_DISPLAY_NAME = "Critter";
const DEFAULT_SELECTED_COLOR = "#f97316";

const STARTER_SPECIES: readonly SpeciesId[] = SPECIES_IDS.filter(
  (id) => SPECIES_CATALOG[id].starter,
);

function createMemoryFallbackStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
  };
}

function resolveDefaultStorage(): StorageLike {
  try {
    if (
      typeof globalThis !== "undefined" &&
      "localStorage" in globalThis &&
      globalThis.localStorage !== undefined &&
      globalThis.localStorage !== null
    ) {
      return globalThis.localStorage;
    }
  } catch {
    // Restricted storage environment (e.g. private iframe / headless Node)
  }
  return createMemoryFallbackStorage();
}

function createDefaultProfile(): PlayerProfile {
  return {
    displayName: DEFAULT_DISPLAY_NAME,
    essence: 0,
    unlockedSpecies: [...STARTER_SPECIES],
    unlockedBonusGadgets: [],
    unlockedCosmetics: [],
    selectedSpecies: "mole",
    selectedColor: DEFAULT_SELECTED_COLOR,
    matchesPlayed: 0,
    wins: 0,
  };
}

function cloneProfile(profile: PlayerProfile): PlayerProfile {
  return {
    displayName: profile.displayName,
    essence: profile.essence,
    unlockedSpecies: [...profile.unlockedSpecies],
    unlockedBonusGadgets: [...profile.unlockedBonusGadgets],
    unlockedCosmetics: [...profile.unlockedCosmetics],
    selectedSpecies: profile.selectedSpecies,
    selectedColor: profile.selectedColor,
    matchesPlayed: profile.matchesPlayed,
    wins: profile.wins,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSpeciesId(value: unknown): value is SpeciesId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SPECIES_CATALOG, value)
  );
}

function isValidBonusGadgetId(value: unknown): value is GadgetId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(GADGET_CATALOG, value) &&
    GADGET_CATALOG[value as GadgetId].bonusLobbyOnly
  );
}

function isValidCosmeticId(value: unknown): value is string {
  return typeof value === "string" && COSMETIC_ACCENT_MAP.has(value);
}

function sanitizeNonNegativeInt(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function parseStoredProfile(raw: string | null): PlayerProfile {
  if (!raw) {
    return createDefaultProfile();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createDefaultProfile();
  }
  if (!isRecord(parsed)) {
    return createDefaultProfile();
  }

  const defaults = createDefaultProfile();

  const rawName =
    typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
  const displayName =
    rawName.length > 0 ? rawName.slice(0, 20) : defaults.displayName;

  const essence = sanitizeNonNegativeInt(parsed.essence, 0);
  const matchesPlayed = sanitizeNonNegativeInt(parsed.matchesPlayed, 0);
  const wins = sanitizeNonNegativeInt(parsed.wins, 0);

  const unlockedSpeciesSet = new Set<SpeciesId>(STARTER_SPECIES);
  if (Array.isArray(parsed.unlockedSpecies)) {
    for (const item of parsed.unlockedSpecies) {
      if (isValidSpeciesId(item)) {
        unlockedSpeciesSet.add(item);
      }
    }
  }
  const unlockedSpecies = Array.from(unlockedSpeciesSet);

  const unlockedGadgetSet = new Set<GadgetId>();
  if (Array.isArray(parsed.unlockedBonusGadgets)) {
    for (const item of parsed.unlockedBonusGadgets) {
      if (isValidBonusGadgetId(item)) {
        unlockedGadgetSet.add(item);
      }
    }
  }
  const unlockedBonusGadgets = Array.from(unlockedGadgetSet);

  const unlockedCosmeticSet = new Set<string>();
  if (Array.isArray(parsed.unlockedCosmetics)) {
    for (const item of parsed.unlockedCosmetics) {
      if (isValidCosmeticId(item)) {
        unlockedCosmeticSet.add(item);
      }
    }
  }
  const unlockedCosmetics = Array.from(unlockedCosmeticSet);

  const selectedSpecies: SpeciesId =
    isValidSpeciesId(parsed.selectedSpecies) &&
    unlockedSpeciesSet.has(parsed.selectedSpecies)
      ? parsed.selectedSpecies
      : "mole";

  const rawColor =
    typeof parsed.selectedColor === "string" ? parsed.selectedColor.trim() : "";
  const selectedColor =
    rawColor.length > 0 ? rawColor : defaults.selectedColor;

  return {
    displayName,
    essence,
    unlockedSpecies,
    unlockedBonusGadgets,
    unlockedCosmetics,
    selectedSpecies,
    selectedColor,
    matchesPlayed,
    wins,
  };
}

/**
 * Compute Siege Essence earned from a match:
 * +20 finished, +15 per KO, +10 per Evo Pod collected, +30 match win.
 */
export function calculateEssenceReward(input: MatchRewardInput): number {
  const finishBonus = input.finished ? 20 : 0;
  const koBonus = sanitizeNonNegativeInt(input.kos, 0) * 15;
  const podBonus = sanitizeNonNegativeInt(input.evoPodsCollected, 0) * 10;
  const winBonus = input.won ? 30 : 0;
  return finishBonus + koBonus + podBonus + winBonus;
}

/**
 * Local persistent progression store for Siege Essence, species unlocks,
 * bonus lobby gadget unlocks, and player customization.
 */
export class ProgressionStore {
  private readonly storage: StorageLike;
  private profile: PlayerProfile;

  public constructor(storage?: StorageLike) {
    this.storage = storage ?? resolveDefaultStorage();
    this.profile = this.loadProfile();
  }

  /** Read and return a defensive copy of the current player profile. */
  public getProfile(): PlayerProfile {
    this.profile = this.loadProfile();
    return cloneProfile(this.profile);
  }

  /** Update and persist the player's display name (1..20 chars). */
  public setDisplayName(name: string): PlayerProfile {
    const trimmed = name.trim().slice(0, 20);
    if (trimmed.length > 0) {
      this.profile.displayName = trimmed;
      this.saveProfile();
    }
    return cloneProfile(this.profile);
  }

  /** Select an unlocked species as the player's active critter. */
  public selectSpecies(species: SpeciesId): PlayerProfile {
    if (
      isValidSpeciesId(species) &&
      this.profile.unlockedSpecies.includes(species)
    ) {
      this.profile.selectedSpecies = species;
      this.saveProfile();
    }
    return cloneProfile(this.profile);
  }

  /** Update and persist the player's team/collar accent color. */
  public selectColor(color: string): PlayerProfile {
    const trimmed = color.trim();
    if (trimmed.length > 0) {
      this.profile.selectedColor = trimmed;
      this.saveProfile();
    }
    return cloneProfile(this.profile);
  }

  /** Credit Siege Essence and match stats after a completed match. */
  public awardMatchEssence(input: MatchRewardInput): {
    earned: number;
    profile: PlayerProfile;
  } {
    const earned = calculateEssenceReward(input);
    this.profile.essence += earned;
    this.profile.matchesPlayed += 1;
    if (input.won) {
      this.profile.wins += 1;
    }
    this.saveProfile();
    return {
      earned,
      profile: cloneProfile(this.profile),
    };
  }

  /** Unlock a locked species using Siege Essence if affordable. */
  public purchaseSpecies(species: SpeciesId): {
    ok: boolean;
    reason?: string;
    profile: PlayerProfile;
  } {
    if (!isValidSpeciesId(species)) {
      return {
        ok: false,
        reason: "Unknown species.",
        profile: cloneProfile(this.profile),
      };
    }
    if (this.profile.unlockedSpecies.includes(species)) {
      return {
        ok: false,
        reason: `${SPECIES_CATALOG[species].name} is already unlocked.`,
        profile: cloneProfile(this.profile),
      };
    }

    const cost = SPECIES_CATALOG[species].unlockCost;
    if (this.profile.essence < cost) {
      return {
        ok: false,
        reason: `Need ${cost} Essence to unlock ${SPECIES_CATALOG[species].name}.`,
        profile: cloneProfile(this.profile),
      };
    }

    this.profile.essence -= cost;
    this.profile.unlockedSpecies.push(species);
    this.saveProfile();

    return {
      ok: true,
      profile: cloneProfile(this.profile),
    };
  }

  /** Unlock a bonus lobby gadget using Siege Essence if affordable. */
  public purchaseBonusGadget(gadget: GadgetId): {
    ok: boolean;
    reason?: string;
    profile: PlayerProfile;
  } {
    if (!isValidBonusGadgetId(gadget)) {
      return {
        ok: false,
        reason: "Gadget is not a purchasable bonus lobby gadget.",
        profile: cloneProfile(this.profile),
      };
    }
    if (this.profile.unlockedBonusGadgets.includes(gadget)) {
      return {
        ok: false,
        reason: `${GADGET_CATALOG[gadget].name} is already unlocked.`,
        profile: cloneProfile(this.profile),
      };
    }

    const cost = GADGET_CATALOG[gadget].unlockCost;
    if (this.profile.essence < cost) {
      return {
        ok: false,
        reason: `Need ${cost} Essence to unlock ${GADGET_CATALOG[gadget].name}.`,
        profile: cloneProfile(this.profile),
      };
    }

    this.profile.essence -= cost;
    this.profile.unlockedBonusGadgets.push(gadget);
    this.saveProfile();

    return {
      ok: true,
      profile: cloneProfile(this.profile),
    };
  }

  /** Unlock a cosmetic critter collar accent using Siege Essence and automatically equip its color. */
  public purchaseCosmetic(cosmeticId: string): {
    ok: boolean;
    reason?: string;
    profile: PlayerProfile;
  } {
    const def = COSMETIC_ACCENT_MAP.get(cosmeticId);
    if (!def) {
      return {
        ok: false,
        reason: "Unknown cosmetic accent.",
        profile: cloneProfile(this.profile),
      };
    }
    if (this.profile.unlockedCosmetics.includes(cosmeticId)) {
      return {
        ok: false,
        reason: `${def.name} is already unlocked.`,
        profile: cloneProfile(this.profile),
      };
    }
    if (this.profile.essence < def.cost) {
      return {
        ok: false,
        reason: `Need ${def.cost} Essence to unlock ${def.name}.`,
        profile: cloneProfile(this.profile),
      };
    }

    this.profile.essence -= def.cost;
    this.profile.unlockedCosmetics.push(cosmeticId);
    this.profile.selectedColor = def.hex;
    this.saveProfile();

    return {
      ok: true,
      profile: cloneProfile(this.profile),
    };
  }

  private loadProfile(): PlayerProfile {
    try {
      return parseStoredProfile(this.storage.getItem(PROFILE_STORAGE_KEY));
    } catch {
      return createDefaultProfile();
    }
  }

  private saveProfile(): void {
    try {
      this.storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(this.profile));
    } catch {
      // Ignore quota / restricted storage failures gracefully
    }
  }
}
