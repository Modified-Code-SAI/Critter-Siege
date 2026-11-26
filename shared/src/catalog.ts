import type {
  ApexDefinition,
  ApexId,
  ComputedCritterStats,
  GadgetDefinition,
  GadgetId,
  HardpointSlot,
  MutationDefinition,
  MutationId,
  SpeciesDefinition,
  SpeciesId,
  ThemeId,
} from "./types.js";

/** Ordered physical hardpoint slots on every critter rig. */
export const HARDPOINT_SLOTS: readonly HardpointSlot[] = [
  "back",
  "legs",
  "offense",
  "crest",
] as const;

/** All playable island biome themes. */
export const THEME_IDS: readonly ThemeId[] = [
  "emerald_spire",
  "canyon_arch",
  "twin_pillars",
] as const;

/** Complete catalog of starter and Siege-Essence-unlockable species. */
export const SPECIES_CATALOG: Readonly<Record<SpeciesId, SpeciesDefinition>> = {
  mole: {
    id: "mole",
    name: "Tunnel Mole",
    description:
      "Excavation specialist whose blasts carve wider craters and deeper tunnels.",
    starter: true,
    unlockCost: 0,
    baseHp: 240,
    moveSpeed: 3.6,
    jumpImpulse: 9.8,
    carveBonus: 1.2,
    knockbackResist: 0,
    grappleReachBonus: 1.0,
    podMagnetRadius: 1.4,
    airControl: 0.35,
    retreatRollBoost: 1.0,
    meleeThorns: 0,
  },
  norway_rat: {
    id: "norway_rat",
    name: "Norway Rat",
    description:
      "Nimble scavenger with +18% move stamina, quick footing, and wider Evo Pod magnet pull.",
    starter: true,
    unlockCost: 0,
    baseHp: 230,
    moveSpeed: 4.2,
    jumpImpulse: 10.8,
    carveBonus: 1.0,
    knockbackResist: 0,
    grappleReachBonus: 1.0,
    podMagnetRadius: 2.3,
    airControl: 0.4,
    retreatRollBoost: 1.0,
    meleeThorns: 0,
  },
  badger: {
    id: "badger",
    name: "Ridge Badger",
    description:
      "Sturdy ridge brawler boasting extra base health and built-in knockback brace.",
    starter: true,
    unlockCost: 0,
    baseHp: 275,
    moveSpeed: 3.3,
    jumpImpulse: 9.6,
    carveBonus: 1.0,
    knockbackResist: 0.2,
    grappleReachBonus: 1.0,
    podMagnetRadius: 1.4,
    airControl: 0.3,
    retreatRollBoost: 1.0,
    meleeThorns: 0,
  },
  glider_squirrel: {
    id: "glider_squirrel",
    name: "Glider Squirrel",
    description:
      "Aerial acrobat with responsive mid-air steering and extended Vine Grapple reach.",
    starter: true,
    unlockCost: 0,
    baseHp: 235,
    moveSpeed: 3.8,
    jumpImpulse: 10.2,
    carveBonus: 1.0,
    knockbackResist: 0,
    grappleReachBonus: 1.15,
    podMagnetRadius: 1.4,
    airControl: 0.75,
    retreatRollBoost: 1.0,
    meleeThorns: 0,
  },
  hedgehog: {
    id: "hedgehog",
    name: "Quill Hedgehog",
    description:
      "Spined defender that punishes close-quarters attackers with razor-sharp melee thorns.",
    starter: false,
    unlockCost: 80,
    baseHp: 250,
    moveSpeed: 3.5,
    jumpImpulse: 9.8,
    carveBonus: 1.0,
    knockbackResist: 0,
    grappleReachBonus: 1.0,
    podMagnetRadius: 1.4,
    airControl: 0.35,
    retreatRollBoost: 1.0,
    meleeThorns: 12,
  },
  armadillo: {
    id: "armadillo",
    name: "Plated Armadillo",
    description:
      "Armored roller with natural blast stability and rapid retreat-roll burst speed.",
    starter: false,
    unlockCost: 110,
    baseHp: 260,
    moveSpeed: 3.5,
    jumpImpulse: 9.8,
    carveBonus: 1.0,
    knockbackResist: 0.15,
    grappleReachBonus: 1.0,
    podMagnetRadius: 1.4,
    airControl: 0.35,
    retreatRollBoost: 1.45,
    meleeThorns: 0,
  },
};

/** Complete catalog of 8 physical hardpoint mutations (2 per slot). */
export const MUTATION_CATALOG: Readonly<
  Record<MutationId, MutationDefinition>
> = {
  glider_wings: {
    id: "glider_wings",
    name: "Glider Wings",
    slot: "back",
    description: "Unfurls patagium wings for +35% mobility and sustained glide.",
    mobilityBonus: 35,
    enablesGlide: true,
  },
  bramble_shell: {
    id: "bramble_shell",
    name: "Bramble Shell",
    slot: "back",
    description:
      "Thorny carapace granting +50 max HP, +20% knockback resist, and +10 melee thorns.",
    maxHpBonus: 50,
    knockbackResistBonus: 0.2,
    meleeThornsBonus: 10,
  },
  spring_paws: {
    id: "spring_paws",
    name: "Spring Paws",
    slot: "legs",
    description:
      "Coiled hind limbs boosting mobility +30%, +20% move stamina, jump impulse +22%, and halving fall damage.",
    mobilityBonus: 30,
    jumpBonus: 0.22,
    fallDamageResist: 0.5,
  },
  anchor_talons: {
    id: "anchor_talons",
    name: "Anchor Talons",
    slot: "legs",
    description:
      "Heavy cliff claws granting +40% knockback resist, +25 max HP, and slope cling.",
    knockbackResistBonus: 0.4,
    maxHpBonus: 25,
    slopeCling: true,
  },
  twin_pod: {
    id: "twin_pod",
    name: "Twin Shoulder Pod",
    slot: "offense",
    description:
      "Dual mortar pods increasing crater carve +35% and launching a bonus mini-dart.",
    carveBonus: 35,
    bonusMiniDart: true,
  },
  burrow_claws: {
    id: "burrow_claws",
    name: "Burrow Claws",
    slot: "offense",
    description:
      "Reinforced digging claws adding +30% carve power, +10% brace, and retreat tunneling.",
    carveBonus: 30,
    knockbackResistBonus: 0.1,
    enablesRetreatBurrow: true,
  },
  optic_visor: {
    id: "optic_visor",
    name: "Optic Visor",
    slot: "crest",
    description:
      "Targeting monocle boosting crater carve +25% and extending live trajectory preview.",
    carveBonus: 25,
    extendedTrajectory: true,
  },
  aegis_crest: {
    id: "aegis_crest",
    name: "Aegis Crest",
    slot: "crest",
    description:
      "Crystal brow plate granting +45 max HP, +25% knockback resist, and a 1-hit round shield.",
    maxHpBonus: 45,
    knockbackResistBonus: 0.25,
    roundShieldHits: 1,
  },
};

/** Apex synergy metadata for HUD badges and visual highlights. */
export const APEX_CATALOG: Readonly<Record<ApexId, ApexDefinition>> = {
  sky_bomber: {
    id: "sky_bomber",
    name: "Sky Bomber",
    description: "Glider Wings + Twin Shoulder Pod: airborne barrage specialist.",
  },
  bastion_tank: {
    id: "bastion_tank",
    name: "Bastion Tank",
    description:
      "Bramble Shell + Anchor Talons: immovable armored fortress on cliff ledges.",
  },
  tunnel_sapper: {
    id: "tunnel_sapper",
    name: "Tunnel Sapper",
    description:
      "Burrow Claws + Spring Paws or Aegis Crest: rapid subterranean flanker.",
  },
  siege_sniper: {
    id: "siege_sniper",
    name: "Siege Sniper",
    description:
      "Twin Shoulder Pod + Optic Visor: pinpoint long-range island demolition.",
  },
  apex_hybrid: {
    id: "apex_hybrid",
    name: "Apex Hybrid",
    description:
      "3+ cross-discipline hardpoints evolved into a versatile siege predator.",
  },
};

/** Complete gadget arsenal: 6 standard match tools plus 3 Siege Essence lobby unlocks. */
export const GADGET_CATALOG: Readonly<Record<GadgetId, GadgetDefinition>> = {
  gale_mortar: {
    id: "gale_mortar",
    name: "Gale Mortar",
    description:
      "Wind-curved arc shell that blasts smooth bowl craters and launches rivals.",
    bonusLobbyOnly: false,
    unlockCost: 0,
    chargesPerRound: null,
    turnEnding: true,
    windAffected: true,
    baseDamage: 34,
    carveRadius: 3.2,
    knockback: 11,
  },
  quake_club: {
    id: "quake_club",
    name: "Quake Club",
    description:
      "Heavy close-range shock slam delivering massive knockback with minimal terrain loss.",
    bonusLobbyOnly: false,
    unlockCost: 0,
    chargesPerRound: null,
    turnEnding: true,
    windAffected: false,
    baseDamage: 24,
    carveRadius: 0.9,
    knockback: 19,
  },
  vine_grapple: {
    id: "vine_grapple",
    name: "Vine Grapple",
    description:
      "Snap-tether rope (6/round, 1/turn) that zips up cliffs or rappels safely down without ending the turn.",
    bonusLobbyOnly: false,
    unlockCost: 0,
    chargesPerRound: 6,
    turnEnding: false,
    windAffected: false,
    baseDamage: 0,
    carveRadius: 0,
    knockback: 4,
  },
  spore_burst: {
    id: "spore_burst",
    name: "Spore Burst",
    description:
      "Splits into 5 buoyant fungal sub-spores on impact to pepper wide ridges.",
    bonusLobbyOnly: false,
    unlockCost: 0,
    chargesPerRound: 2,
    turnEnding: true,
    windAffected: true,
    baseDamage: 16,
    carveRadius: 2.6,
    knockback: 12,
    subSporeCount: 5,
  },
  burrow_bore: {
    id: "burrow_bore",
    name: "Burrow Bore",
    description:
      "Subterranean drill shell that carves straight through rock for 0.6s before detonating.",
    bonusLobbyOnly: false,
    unlockCost: 0,
    chargesPerRound: 2,
    turnEnding: true,
    windAffected: false,
    baseDamage: 36,
    carveRadius: 3.1,
    knockback: 10,
    tunnelDurationSec: 0.6,
  },
  seeker_firefly: {
    id: "seeker_firefly",
    name: "Seeker Firefly",
    description:
      "Guided bioluminescent round that arcs cleanly onto a Drone Recon target ping.",
    bonusLobbyOnly: false,
    unlockCost: 0,
    chargesPerRound: 1,
    turnEnding: true,
    windAffected: false,
    baseDamage: 30,
    carveRadius: 2.8,
    knockback: 11,
    requiresDronePing: true,
  },
  gravity_mine: {
    id: "gravity_mine",
    name: "Gravity Mine",
    description:
      "Vortex charge that implodes inward, yanking nearby critters off safe ledges.",
    bonusLobbyOnly: true,
    unlockCost: 90,
    chargesPerRound: 0,
    turnEnding: true,
    windAffected: true,
    baseDamage: 18,
    carveRadius: 2.2,
    knockback: -14,
  },
  prism_wall: {
    id: "prism_wall",
    name: "Prism Wall",
    description:
      "Deploys a temporary translucent crystal barrier without ending the active turn.",
    bonusLobbyOnly: true,
    unlockCost: 90,
    chargesPerRound: 0,
    turnEnding: false,
    windAffected: false,
    baseDamage: 0,
    carveRadius: 0,
    knockback: 0,
  },
  shock_magnet: {
    id: "shock_magnet",
    name: "Shock Magnet",
    description:
      "Electrified pulse beacon that snaps onto rock and jolts adjacent rivals away.",
    bonusLobbyOnly: true,
    unlockCost: 110,
    chargesPerRound: 0,
    turnEnding: true,
    windAffected: false,
    baseDamage: 22,
    carveRadius: 1.8,
    knockback: 14,
  },
};

export const SPECIES_IDS: readonly SpeciesId[] = Object.keys(
  SPECIES_CATALOG,
) as SpeciesId[];

export const MUTATION_IDS: readonly MutationId[] = Object.keys(
  MUTATION_CATALOG,
) as MutationId[];

export const GADGET_IDS: readonly GadgetId[] = Object.keys(
  GADGET_CATALOG,
) as GadgetId[];

/** Resolves the active Apex synergy from a critter's equipped hardpoints. */
export function computeApexSynergy(
  equipped: Partial<Record<HardpointSlot, MutationId>>,
): ApexId | null {
  if (
    equipped.back === "glider_wings" &&
    equipped.offense === "twin_pod"
  ) {
    return "sky_bomber";
  }
  if (
    equipped.back === "bramble_shell" &&
    equipped.legs === "anchor_talons"
  ) {
    return "bastion_tank";
  }
  if (
    equipped.offense === "burrow_claws" &&
    (equipped.legs === "spring_paws" || equipped.crest === "aegis_crest")
  ) {
    return "tunnel_sapper";
  }
  if (
    equipped.offense === "twin_pod" &&
    equipped.crest === "optic_visor"
  ) {
    return "siege_sniper";
  }

  let equippedCount = 0;
  for (const slot of HARDPOINT_SLOTS) {
    if (equipped[slot] !== undefined) {
      equippedCount += 1;
    }
  }
  if (equippedCount >= 3) {
    return "apex_hybrid";
  }
  return null;
}

/** Computes effective combat and movement stats from species + equipped hardpoints. */
export function computeCritterStats(
  species: SpeciesId,
  equipped: Partial<Record<HardpointSlot, MutationId>>,
): ComputedCritterStats {
  const base = SPECIES_CATALOG[species];

  let maxHpBonus = 0;
  let mobilityBonus = 0;
  let carveBonusPercent = 0;
  let knockbackResistBonus = 0;
  let meleeThornsBonus = 0;
  let jumpBonus = 0;
  let fallDamageResist = 0;
  let roundShieldHits = 0;
  let enablesGlide = false;
  let slopeCling = false;
  let bonusMiniDart = false;
  let enablesRetreatBurrow = false;
  let extendedTrajectory = false;

  for (const slot of HARDPOINT_SLOTS) {
    const mutId = equipped[slot];
    if (!mutId) continue;
    const mut = MUTATION_CATALOG[mutId];
    if (!mut || mut.slot !== slot) continue;

    maxHpBonus += mut.maxHpBonus ?? 0;
    mobilityBonus += mut.mobilityBonus ?? 0;
    carveBonusPercent += mut.carveBonus ?? 0;
    knockbackResistBonus += mut.knockbackResistBonus ?? 0;
    meleeThornsBonus += mut.meleeThornsBonus ?? 0;
    jumpBonus += mut.jumpBonus ?? 0;
    fallDamageResist += mut.fallDamageResist ?? 0;
    roundShieldHits += mut.roundShieldHits ?? 0;
    if (mut.enablesGlide) enablesGlide = true;
    if (mut.slopeCling) slopeCling = true;
    if (mut.bonusMiniDart) bonusMiniDart = true;
    if (mut.enablesRetreatBurrow) enablesRetreatBurrow = true;
    if (mut.extendedTrajectory) extendedTrajectory = true;
  }

  return {
    species,
    maxHp: base.baseHp + maxHpBonus,
    moveSpeed: Number(
      (base.moveSpeed * (1 + mobilityBonus / 100)).toFixed(4),
    ),
    jumpImpulse: Number((base.jumpImpulse * (1 + jumpBonus)).toFixed(4)),
    carveMultiplier: Number(
      (base.carveBonus * (1 + carveBonusPercent / 100)).toFixed(4),
    ),
    knockbackResist: Math.min(
      0.85,
      Number((base.knockbackResist + knockbackResistBonus).toFixed(4)),
    ),
    grappleReachBonus: base.grappleReachBonus,
    podMagnetRadius: base.podMagnetRadius,
    airControl: base.airControl,
    retreatRollBoost: base.retreatRollBoost,
    meleeThorns: base.meleeThorns + meleeThornsBonus,
    fallDamageResist: Math.min(1, fallDamageResist),
    roundShieldHits,
    mobilityBonus,
    carveBonusPercent,
    enablesGlide,
    slopeCling,
    bonusMiniDart,
    enablesRetreatBurrow,
    extendedTrajectory,
    apex: computeApexSynergy(equipped),
  };
}

/** Creates per-round gadget charge counts, optionally granting 1 bonus lobby gadget charge. */
export function createDefaultGadgetCharges(
  bonusGadget?: GadgetId | null,
): Record<GadgetId, number | null> {
  const charges = {} as Record<GadgetId, number | null>;
  for (const id of GADGET_IDS) {
    const def = GADGET_CATALOG[id];
    charges[id] = def.chargesPerRound;
  }
  if (bonusGadget && GADGET_CATALOG[bonusGadget]?.bonusLobbyOnly) {
    charges[bonusGadget] = 1;
  }
  return charges;
}
