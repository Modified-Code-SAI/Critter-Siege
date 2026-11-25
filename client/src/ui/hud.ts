import {
  APEX_CATALOG,
  GADGET_CATALOG,
  GAME_TITLE,
  HARDPOINT_SLOTS,
  MUTATION_CATALOG,
  SPECIES_CATALOG,
  SPECIES_IDS,
  type CritterState,
  type GadgetId,
  type GameMode,
  type HardpointSlot,
  type MatchState,
  type MutationId,
  type PendingDraftState,
  type SpeciesId,
  type ThemeId,
} from "@critter/shared";
import type { CameraMode } from "../game/cameraRig.js";
import type { LobbyViewState } from "../net/gameClient.js";
import type { PlayerProfile } from "../profile/progression.js";

/** Breakdown displayed on the Match Over Siege Essence summary modal. */
export interface MatchEssenceBreakdown {
  finishedBonus: number;
  koBonus: number;
  kos: number;
  podBonus: number;
  pods: number;
  winBonus: number;
  totalEarned: number;
  newBalance: number;
}

/** Callbacks raised by HudController when the user interacts with lobby or HUD controls. */
export interface HudCallbacks {
  onNameChange: (name: string) => void;
  onColorChange: (color: string) => void;
  onSelectSpecies: (species: SpeciesId) => void;
  onUnlockSpecies: (species: SpeciesId) => void;
  onSelectBonusGadget: (gadget: GadgetId | null) => void;
  onUnlockBonusGadget: (gadget: GadgetId) => void;
  onThemeChange: (theme: ThemeId) => void;
  onGameModeChange: (mode: GameMode) => void;
  onBotCountChange: (count: number) => void;
  onPlaySandbox: () => void;
  onCreateRoom: () => void;
  onJoinRoom: (roomCode: string) => void;
  onStartOnlineMatch: () => void;
  onLeaveRoom: () => void;
  onCopyInviteLink: () => void;
  onSelectGadget: (gadgetId: GadgetId) => void;
  onPickMutation: (mutationId: MutationId, replaceSlot?: HardpointSlot) => void;
  onRerollDraft: () => void;
  onToggleMute: () => void;
  onPlayAgain: () => void;
  onBackToLobby: () => void;
}

/** Per-frame dynamic HUD input during an active match. */
export interface HudFrameState {
  matchState: MatchState;
  localPlayerId: string | null;
  cameraMode: CameraMode;
  selectedGadget: GadgetId;
  charging: boolean;
  chargePower: number;
  muted: boolean;
  dronePingActive: boolean;
  essenceBreakdown: MatchEssenceBreakdown | null;
}

/** Local lobby selection state managed between HudController and main.ts. */
export interface LobbySelectionState {
  theme: ThemeId;
  gameMode: GameMode;
  botCount: number;
  bonusGadget: GadgetId | null;
  joinCodeInput: string;
}

const STANDARD_GADGETS: readonly GadgetId[] = [
  "gale_mortar",
  "quake_club",
  "vine_grapple",
  "spore_burst",
  "burrow_bore",
  "seeker_firefly",
];

const BONUS_GADGETS: readonly GadgetId[] = [
  "gravity_mine",
  "prism_wall",
  "shock_magnet",
];

const THEME_META: ReadonlyArray<{ id: ThemeId; label: string; subtitle: string }> = [
  { id: "emerald_spire", label: "Emerald Spire", subtitle: "Lush ridge & stone arch" },
  { id: "canyon_arch", label: "Canyon Arch", subtitle: "Twin sandstone bridges" },
  { id: "twin_pillars", label: "Twin Pillars", subtitle: "Split spires & sky deck" },
];

const COLOR_SWATCHES: readonly string[] = [
  "#f97316",
  "#38bdf8",
  "#22c55e",
  "#f43f5e",
  "#a855f7",
  "#eab308",
];

const SLOT_LABELS: Record<HardpointSlot, string> = {
  back: "BACK",
  legs: "LEGS",
  offense: "OFFENSE",
  crest: "CREST",
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getWindCompassLabel(vx: number, vz: number): string {
  const speed = Math.hypot(vx, vz);
  if (speed < 0.15) {
    return "CALM";
  }
  const deg = ((Math.atan2(vx, -vz) * 180) / Math.PI + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(deg / 45) % 8;
  return dirs[idx] ?? "N";
}

function formatSpeciesTrait(species: SpeciesId): string {
  switch (species) {
    case "mole":
      return "+20% crater & tunnel carve";
    case "norway_rat":
      return "+12% jump/speed · wide pod magnet";
    case "badger":
      return "115 HP · 20% knockback brace";
    case "glider_squirrel":
      return "High air control · +15% grapple";
    case "hedgehog":
      return "105 HP · 12 melee thorns reflect";
    case "armadillo":
      return "110 HP · 15% brace · fast retreat";
  }
}

/**
 * Translucent glassmorphism DOM HUD and Lobby controller for Critter Siege.
 * Uses fine-grained DOM updates at 60fps and structural diffing for modals/panels.
 */
export class HudController {
  private readonly root: HTMLElement;
  private readonly callbacks: HudCallbacks;

  private readonly lobbyLayer: HTMLDivElement;
  private readonly gameLayer: HTMLDivElement;
  private readonly visorOverlay: HTMLDivElement;
  private readonly droneOverlay: HTMLDivElement;
  private readonly draftModal: HTMLDivElement;
  private readonly matchOverModal: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;

  // Fast-updated In-Game HUD element references
  private readonly topRoundEl: HTMLSpanElement;
  private readonly topPhaseEl: HTMLSpanElement;
  private readonly topTimerEl: HTMLSpanElement;
  private readonly topActiveEl: HTMLSpanElement;
  private readonly windArrowEl: HTMLDivElement;
  private readonly windSpeedEl: HTMLSpanElement;
  private readonly muteBtnEl: HTMLButtonElement;
  private readonly chargeBarWrapEl: HTMLDivElement;
  private readonly chargeBarFillEl: HTMLDivElement;
  private readonly chargeBarPctEl: HTMLSpanElement;

  private readonly blSpeciesEl: HTMLSpanElement;
  private readonly blTeamEl: HTMLSpanElement;
  private readonly blHpTextEl: HTMLSpanElement;
  private readonly blHpFillEl: HTMLDivElement;
  private readonly blShieldEl: HTMLSpanElement;
  private readonly blEvoFillEl: HTMLDivElement;
  private readonly blEvoTextEl: HTMLSpanElement;
  private readonly blHardpointsEl: HTMLDivElement;
  private readonly blApexEl: HTMLDivElement;
  private readonly hotbarListEl: HTMLDivElement;

  private readonly visorChargeArcEl: SVGPathElement;
  private readonly visorChargePctEl: HTMLSpanElement;
  private readonly droneBadgeEl: HTMLDivElement;
  private readonly droneCompassEl: HTMLDivElement;

  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHardpointSig = "";
  private lastHotbarSig = "";
  private lastDraftSig = "";
  private lastMatchOverSig = "";
  private lastLobbySig = "";

  public constructor(root: HTMLElement, callbacks: HudCallbacks) {
    this.root = root;
    this.callbacks = callbacks;

    this.root.innerHTML = "";

    // 1. Lobby Layer
    this.lobbyLayer = document.createElement("div");
    this.lobbyLayer.className = "cs-lobby-layer";
    this.root.appendChild(this.lobbyLayer);

    // 2. In-Game HUD Layer
    this.gameLayer = document.createElement("div");
    this.gameLayer.className = "cs-game-layer cs-hidden";
    this.root.appendChild(this.gameLayer);

    // Top-center match telemetry bar
    const topBar = document.createElement("div");
    topBar.className = "cs-top-bar";
    topBar.innerHTML = `
      <div class="cs-glass cs-turn-pill">
        <span class="cs-round-badge" data-ref="round">R1/3</span>
        <span class="cs-phase-badge" data-ref="phase">ACTIVE</span>
        <span class="cs-timer-readout" data-ref="timer">15s</span>
        <span class="cs-divider"></span>
        <span class="cs-active-player" data-ref="active">Critter</span>
        <span class="cs-divider"></span>
        <div class="cs-wind-widget">
          <div class="cs-wind-arrow" data-ref="wind-arrow">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M12 3l6 15-6-3.5L6 18z" fill="currentColor"></path>
            </svg>
          </div>
          <span class="cs-wind-speed" data-ref="wind-speed">0.0 m/s</span>
        </div>
      </div>
      <div class="cs-top-actions">
        <button type="button" class="cs-glass cs-icon-btn" data-ref="mute" title="Toggle Audio (M)">Audio ON</button>
        <button type="button" class="cs-glass cs-icon-btn" data-ref="exit-lobby" title="Return to Lobby">Lobby</button>
      </div>
    `;
    this.gameLayer.appendChild(topBar);

    this.topRoundEl = topBar.querySelector('[data-ref="round"]') as HTMLSpanElement;
    this.topPhaseEl = topBar.querySelector('[data-ref="phase"]') as HTMLSpanElement;
    this.topTimerEl = topBar.querySelector('[data-ref="timer"]') as HTMLSpanElement;
    this.topActiveEl = topBar.querySelector('[data-ref="active"]') as HTMLSpanElement;
    this.windArrowEl = topBar.querySelector('[data-ref="wind-arrow"]') as HTMLDivElement;
    this.windSpeedEl = topBar.querySelector('[data-ref="wind-speed"]') as HTMLSpanElement;
    this.muteBtnEl = topBar.querySelector('[data-ref="mute"]') as HTMLButtonElement;

    this.muteBtnEl.addEventListener("click", () => this.callbacks.onToggleMute());
    const exitBtn = topBar.querySelector('[data-ref="exit-lobby"]') as HTMLButtonElement;
    exitBtn.addEventListener("click", () => this.callbacks.onBackToLobby());

    // Live shot power charge bar (bottom-center)
    this.chargeBarWrapEl = document.createElement("div");
    this.chargeBarWrapEl.className = "cs-charge-wrap cs-hidden";
    this.chargeBarWrapEl.innerHTML = `
      <div class="cs-glass cs-charge-box">
        <div class="cs-charge-header">
          <span>SHOT POWER</span>
          <span data-ref="charge-pct">15%</span>
        </div>
        <div class="cs-charge-track">
          <div class="cs-charge-fill" data-ref="charge-fill"></div>
        </div>
      </div>
    `;
    this.gameLayer.appendChild(this.chargeBarWrapEl);
    this.chargeBarFillEl = this.chargeBarWrapEl.querySelector(
      '[data-ref="charge-fill"]',
    ) as HTMLDivElement;
    this.chargeBarPctEl = this.chargeBarWrapEl.querySelector(
      '[data-ref="charge-pct"]',
    ) as HTMLSpanElement;

    // Bottom-left critter status & hardpoints panel
    const bottomLeft = document.createElement("div");
    bottomLeft.className = "cs-bottom-left cs-glass";
    bottomLeft.innerHTML = `
      <div class="cs-bl-head">
        <span class="cs-bl-species" data-ref="bl-species">Tunnel Mole</span>
        <span class="cs-bl-team cs-hidden" data-ref="bl-team">TEAM A</span>
        <span class="cs-bl-shield cs-hidden" data-ref="bl-shield">AEGIS SHIELD</span>
      </div>
      <div class="cs-bar-row">
        <div class="cs-hp-track">
          <div class="cs-hp-fill" data-ref="bl-hp-fill"></div>
        </div>
        <span class="cs-hp-text" data-ref="bl-hp-text">100 / 100</span>
      </div>
      <div class="cs-evo-row">
        <span class="cs-evo-label">EVO</span>
        <div class="cs-evo-track">
          <div class="cs-evo-fill" data-ref="bl-evo-fill"></div>
        </div>
        <span class="cs-evo-text" data-ref="bl-evo-text">0%</span>
      </div>
      <div class="cs-hardpoints" data-ref="bl-hardpoints"></div>
      <div class="cs-apex-badge cs-hidden" data-ref="bl-apex"></div>
    `;
    this.gameLayer.appendChild(bottomLeft);
    this.blSpeciesEl = bottomLeft.querySelector('[data-ref="bl-species"]') as HTMLSpanElement;
    this.blTeamEl = bottomLeft.querySelector('[data-ref="bl-team"]') as HTMLSpanElement;
    this.blShieldEl = bottomLeft.querySelector('[data-ref="bl-shield"]') as HTMLSpanElement;
    this.blHpFillEl = bottomLeft.querySelector('[data-ref="bl-hp-fill"]') as HTMLDivElement;
    this.blHpTextEl = bottomLeft.querySelector('[data-ref="bl-hp-text"]') as HTMLSpanElement;
    this.blEvoFillEl = bottomLeft.querySelector('[data-ref="bl-evo-fill"]') as HTMLDivElement;
    this.blEvoTextEl = bottomLeft.querySelector('[data-ref="bl-evo-text"]') as HTMLSpanElement;
    this.blHardpointsEl = bottomLeft.querySelector(
      '[data-ref="bl-hardpoints"]',
    ) as HTMLDivElement;
    this.blApexEl = bottomLeft.querySelector('[data-ref="bl-apex"]') as HTMLDivElement;

    // Bottom-right gadget hotbar + control hint strip
    const bottomRight = document.createElement("div");
    bottomRight.className = "cs-bottom-right";
    bottomRight.innerHTML = `
      <div class="cs-hotbar-list" data-ref="hotbar"></div>
      <div class="cs-controls-strip cs-glass">
        WASD Move · Space Jump/Glide · LMB Hold Fire · RMB/V Visor · Tab Drone · F Burrow · M Mute
      </div>
    `;
    this.gameLayer.appendChild(bottomRight);
    this.hotbarListEl = bottomRight.querySelector('[data-ref="hotbar"]') as HTMLDivElement;

    // 3. First-Person Optic Visor Overlay
    this.visorOverlay = document.createElement("div");
    this.visorOverlay.className = "cs-visor-overlay cs-hidden";
    this.visorOverlay.innerHTML = `
      <div class="cs-visor-corner cs-vc-tl"></div>
      <div class="cs-visor-corner cs-vc-tr"></div>
      <div class="cs-visor-corner cs-vc-bl"></div>
      <div class="cs-visor-corner cs-vc-br"></div>
      <div class="cs-visor-tag">OPTIC VISOR · PRECISION AIM</div>
      <div class="cs-visor-reticle">
        <svg viewBox="0 0 180 180" width="180" height="180" aria-hidden="true">
          <circle cx="90" cy="90" r="32" fill="none" stroke="rgba(77,244,255,0.55)" stroke-width="1.5" stroke-dasharray="6 5"></circle>
          <line x1="90" y1="36" x2="90" y2="74" stroke="rgba(77,244,255,0.85)" stroke-width="1.5"></line>
          <line x1="90" y1="106" x2="90" y2="144" stroke="rgba(77,244,255,0.85)" stroke-width="1.5"></line>
          <line x1="36" y1="90" x2="74" y2="90" stroke="rgba(77,244,255,0.85)" stroke-width="1.5"></line>
          <line x1="106" y1="90" x2="144" y2="90" stroke="rgba(77,244,255,0.85)" stroke-width="1.5"></line>
          <line x1="82" y1="60" x2="98" y2="60" stroke="rgba(77,244,255,0.65)" stroke-width="1.2"></line>
          <line x1="84" y1="120" x2="96" y2="120" stroke="rgba(77,244,255,0.65)" stroke-width="1.2"></line>
          <circle cx="90" cy="90" r="3" fill="#4df4ff"></circle>
          <path d="M 32 128 A 68 68 0 0 1 32 52" fill="none" stroke="rgba(77,244,255,0.22)" stroke-width="6" stroke-linecap="round"></path>
          <path data-ref="visor-arc" d="M 32 128 A 68 68 0 0 1 32 52" fill="none" stroke="#4df4ff" stroke-width="6" stroke-linecap="round" stroke-dasharray="86" stroke-dashoffset="86"></path>
        </svg>
        <span class="cs-visor-pct" data-ref="visor-pct"></span>
      </div>
    `;
    this.root.appendChild(this.visorOverlay);
    this.visorChargeArcEl = this.visorOverlay.querySelector(
      '[data-ref="visor-arc"]',
    ) as SVGPathElement;
    this.visorChargePctEl = this.visorOverlay.querySelector(
      '[data-ref="visor-pct"]',
    ) as HTMLSpanElement;

    // 4. Tactical Drone Recon / Spectator Drone Overlay
    this.droneOverlay = document.createElement("div");
    this.droneOverlay.className = "cs-drone-overlay cs-hidden";
    this.droneOverlay.innerHTML = `
      <div class="cs-drone-bracket cs-db-tl"></div>
      <div class="cs-drone-bracket cs-db-tr"></div>
      <div class="cs-drone-bracket cs-db-bl"></div>
      <div class="cs-drone-bracket cs-db-br"></div>
      <div class="cs-drone-badge cs-glass" data-ref="drone-badge">DRONE RECON · [TAB] EXIT</div>
      <div class="cs-drone-compass cs-glass" data-ref="drone-compass">WIND CALM</div>
    `;
    this.root.appendChild(this.droneOverlay);
    this.droneBadgeEl = this.droneOverlay.querySelector(
      '[data-ref="drone-badge"]',
    ) as HTMLDivElement;
    this.droneCompassEl = this.droneOverlay.querySelector(
      '[data-ref="drone-compass"]',
    ) as HTMLDivElement;

    // 5. Mutation Draft Modal
    this.draftModal = document.createElement("div");
    this.draftModal.className = "cs-modal-backdrop cs-hidden";
    this.root.appendChild(this.draftModal);

    // 6. Match Over Summary Modal
    this.matchOverModal = document.createElement("div");
    this.matchOverModal.className = "cs-modal-backdrop cs-hidden";
    this.root.appendChild(this.matchOverModal);

    // 7. Floating Toast Notification
    this.toastEl = document.createElement("div");
    this.toastEl.className = "cs-toast cs-hidden";
    this.root.appendChild(this.toastEl);
  }

  /** Display a short translucent toast notification (unlocks, invite link copied, errors). */
  public showToast(message: string, tone: "info" | "success" | "error" = "info"): void {
    this.toastEl.textContent = message;
    this.toastEl.className = `cs-toast cs-toast-${tone}`;
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => {
      this.toastEl.classList.add("cs-hidden");
      this.toastTimer = null;
    }, 3400);
  }

  /** Show the Lobby overlay over the live 3D sky-island backdrop and hide in-game HUD. */
  public showLobby(
    profile: PlayerProfile,
    selection: LobbySelectionState,
    onlineLobby: LobbyViewState | null,
  ): void {
    this.lobbyLayer.classList.remove("cs-hidden");
    this.gameLayer.classList.add("cs-hidden");
    this.visorOverlay.classList.add("cs-hidden");
    this.droneOverlay.classList.add("cs-hidden");
    this.draftModal.classList.add("cs-hidden");
    this.matchOverModal.classList.add("cs-hidden");

    const sig = JSON.stringify({
      profile,
      selection,
      onlineLobby,
    });
    if (sig === this.lastLobbySig) {
      return;
    }
    this.lastLobbySig = sig;
    this.renderLobbyDom(profile, selection, onlineLobby);
  }

  /** Update the live in-game HUD, camera overlays, Mutation Draft modal, and Match Over modal. */
  public updateGameHud(frame: HudFrameState): void {
    this.lobbyLayer.classList.add("cs-hidden");
    this.gameLayer.classList.remove("cs-hidden");
    this.lastLobbySig = "";

    const { matchState, localPlayerId, cameraMode, selectedGadget } = frame;
    const activeCritter = matchState.critters.find(
      (c) => c.id === matchState.activePlayerId,
    );
    const localCritter =
      matchState.critters.find((c) => c.id === localPlayerId) ??
      matchState.critters[0] ??
      null;

    // Top bar telemetry
    this.topRoundEl.textContent = `R${matchState.round}/${matchState.maxRounds}`;
    const isMyTurn =
      localPlayerId !== null && matchState.activePlayerId === localPlayerId;
    const phaseLabel =
      matchState.phase === "RETREAT"
        ? isMyTurn
          ? "RETREAT!"
          : "RIVAL RETREAT"
        : matchState.phase === "RESOLVING"
          ? "IN FLIGHT"
          : matchState.phase === "ROUND_DRAFT" ||
              matchState.phase === "DRAFT_IF_READY"
            ? "EVO DRAFT"
            : matchState.phase === "MATCH_OVER"
              ? "MATCH OVER"
              : isMyTurn
                ? "YOUR TURN"
                : "RIVAL TURN";
    this.topPhaseEl.textContent = phaseLabel;
    this.topPhaseEl.dataset.tone =
      matchState.phase === "RETREAT"
        ? "retreat"
        : isMyTurn && matchState.phase === "ACTIVE"
          ? "mine"
          : "neutral";

    const secs = Math.max(0, Math.ceil(matchState.phaseTimeRemainingSec));
    this.topTimerEl.textContent = `${secs}s`;
    this.topTimerEl.classList.toggle(
      "cs-timer-urgent",
      secs <= 4 &&
        (matchState.phase === "ACTIVE" || matchState.phase === "RETREAT"),
    );

    this.topActiveEl.textContent = activeCritter ? activeCritter.name : "—";

    const windSpeed = Math.hypot(matchState.wind.x, matchState.wind.z);
    const windAngleDeg = (Math.atan2(matchState.wind.x, -matchState.wind.z) * 180) / Math.PI;
    this.windArrowEl.style.transform = `rotate(${windAngleDeg.toFixed(1)}deg)`;
    this.windArrowEl.style.opacity = windSpeed < 0.15 ? "0.35" : "1";
    this.windSpeedEl.textContent = `${windSpeed.toFixed(1)} m/s`;

    this.muteBtnEl.textContent = frame.muted ? "Audio OFF" : "Audio ON";

    // Power charge bar
    const showCharge = frame.charging && cameraMode !== "first_person";
    this.chargeBarWrapEl.classList.toggle("cs-hidden", !showCharge);
    if (showCharge) {
      const pct = Math.round(Math.max(0, Math.min(1, frame.chargePower)) * 100);
      this.chargeBarFillEl.style.width = `${pct}%`;
      this.chargeBarPctEl.textContent = `${pct}%`;
    }

    // Bottom-left critter panel
    if (localCritter) {
      const speciesDef = SPECIES_CATALOG[localCritter.species];
      this.blSpeciesEl.textContent = `${localCritter.name} · ${speciesDef.name}`;

      if (matchState.mode === "2v2" && localCritter.team) {
        this.blTeamEl.textContent = `TEAM ${localCritter.team}`;
        this.blTeamEl.classList.remove("cs-hidden");
      } else {
        this.blTeamEl.classList.add("cs-hidden");
      }

      this.blShieldEl.classList.toggle(
        "cs-hidden",
        localCritter.roundShieldRemaining <= 0,
      );

      const hpPct = Math.max(
        0,
        Math.min(100, (localCritter.hp / Math.max(1, localCritter.maxHp)) * 100),
      );
      this.blHpFillEl.style.width = `${hpPct.toFixed(1)}%`;
      this.blHpFillEl.dataset.tier =
        hpPct > 55 ? "high" : hpPct > 25 ? "mid" : "low";
      this.blHpTextEl.textContent = `${Math.ceil(localCritter.hp)} / ${localCritter.maxHp}`;

      const evoPct = Math.max(0, Math.min(100, Math.round(localCritter.evoCharge)));
      this.blEvoFillEl.style.width = `${evoPct}%`;
      this.blEvoTextEl.textContent = localCritter.pendingEvoDraft
        ? "READY!"
        : `${evoPct}%`;

      this.syncHardpointsDom(localCritter);
      this.syncHotbarDom(localCritter, selectedGadget, frame.dronePingActive);
    }

    // First-Person Optic Visor overlay
    const isVisor = cameraMode === "first_person";
    this.visorOverlay.classList.toggle("cs-hidden", !isVisor);
    if (isVisor) {
      const arcLen = 86;
      const frac = frame.charging ? Math.max(0, Math.min(1, frame.chargePower)) : 0;
      this.visorChargeArcEl.style.strokeDashoffset = `${(arcLen * (1 - frac)).toFixed(1)}`;
      this.visorChargePctEl.textContent = frame.charging
        ? `${Math.round(frac * 100)}%`
        : "";
    }

    // Tactical Drone Recon / Spectator Drone overlay
    const isDrone =
      cameraMode === "drone_recon" || cameraMode === "spectator_drone";
    this.droneOverlay.classList.toggle("cs-hidden", !isDrone);
    if (isDrone) {
      if (cameraMode === "spectator_drone") {
        const canNudge = localCritter ? !localCritter.droneNudgeUsedThisTurn : false;
        this.droneBadgeEl.textContent = canNudge
          ? "SPECTATOR DRONE · [E] WIND NUDGE READY"
          : "SPECTATOR DRONE · WIND NUDGE USED THIS TURN";
      } else {
        this.droneBadgeEl.textContent =
          "DRONE RECON · [TAB] EXIT · CLICK ISLAND TO PING TARGET";
      }
      const compass = getWindCompassLabel(matchState.wind.x, matchState.wind.z);
      this.droneCompassEl.textContent = `WIND ${compass} · ${windSpeed.toFixed(1)} m/s`;
    }

    // Mutation Draft Modal
    this.syncDraftModal(matchState, localPlayerId);

    // Match Over Summary Modal
    this.syncMatchOverModal(matchState, localPlayerId, frame.essenceBreakdown);
  }

  /** Clean up timers and detach HUD DOM. */
  public dispose(): void {
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.root.innerHTML = "";
  }

  private renderLobbyDom(
    profile: PlayerProfile,
    selection: LobbySelectionState,
    onlineLobby: LobbyViewState | null,
  ): void {
    const activeTheme = onlineLobby ? onlineLobby.theme : selection.theme;
    const activeMode = onlineLobby ? onlineLobby.gameMode : selection.gameMode;
    const activeBots = onlineLobby ? onlineLobby.botCount : selection.botCount;
    const isOnlineRoom = onlineLobby !== null && onlineLobby.mode === "online" && onlineLobby.roomCode !== null;
    const isHost = !isOnlineRoom || onlineLobby.hostId === onlineLobby.playerId;

    const speciesCardsHtml = SPECIES_IDS.map((id) => {
      const def = SPECIES_CATALOG[id];
      const unlocked = profile.unlockedSpecies.includes(id);
      const selected = profile.selectedSpecies === id;
      const canAfford = profile.essence >= def.unlockCost;
      return `
        <div class="cs-species-card ${selected ? "cs-selected" : ""} ${unlocked ? "" : "cs-locked"}" data-species-card="${id}">
          <div class="cs-species-top">
            <strong>${escapeHtml(def.name)}</strong>
            <span class="cs-stat-pill">${def.baseHp} HP</span>
          </div>
          <p class="cs-species-trait">${escapeHtml(formatSpeciesTrait(id))}</p>
          ${
            unlocked
              ? `<span class="cs-species-status">${selected ? "Selected" : "Click to Select"}</span>`
              : `<button type="button" class="cs-unlock-btn" data-unlock-species="${id}" ${canAfford ? "" : "disabled"}>Unlock · ${def.unlockCost} ✦</button>`
          }
        </div>
      `;
    }).join("");

    const bonusCardsHtml = BONUS_GADGETS.map((id) => {
      const def = GADGET_CATALOG[id];
      const unlocked = profile.unlockedBonusGadgets.includes(id);
      const equipped = selection.bonusGadget === id;
      const canAfford = profile.essence >= def.unlockCost;
      return `
        <div class="cs-bonus-card ${equipped ? "cs-selected" : ""}" data-bonus-card="${id}">
          <div class="cs-bonus-head">
            <strong>${escapeHtml(def.name)}</strong>
            ${
              unlocked
                ? `<span class="cs-tag">${equipped ? "Equipped" : "Owned"}</span>`
                : `<button type="button" class="cs-unlock-btn cs-unlock-sm" data-unlock-gadget="${id}" ${canAfford ? "" : "disabled"}>${def.unlockCost} ✦</button>`
            }
          </div>
          <p>${escapeHtml(def.description)}</p>
        </div>
      `;
    }).join("");

    const themeButtonsHtml = THEME_META.map(
      (t) => `
        <button type="button" class="cs-seg-btn ${activeTheme === t.id ? "cs-active" : ""}" data-theme="${t.id}" ${isHost ? "" : "disabled"}>
          <span>${escapeHtml(t.label)}</span>
        </button>
      `,
    ).join("");

    const botCounts = isOnlineRoom ? [0, 1, 2, 3] : [1, 2, 3];
    const botButtonsHtml = botCounts
      .map(
        (n) => `
        <button type="button" class="cs-seg-btn ${activeBots === n ? "cs-active" : ""}" data-bots="${n}" ${isHost ? "" : "disabled"}>
          ${n} ${n === 1 ? "Bot" : "Bots"}
        </button>
      `,
      )
      .join("");

    const colorSwatchesHtml = COLOR_SWATCHES.map(
      (hex) => `
        <button type="button" class="cs-swatch ${profile.selectedColor === hex ? "cs-selected" : ""}" data-color="${hex}" style="background:${hex}" aria-label="Color ${hex}"></button>
      `,
    ).join("");

    const roomPanelHtml = isOnlineRoom
      ? `
        <div class="cs-room-box">
          <div class="cs-room-header">
            <div>
              <span class="cs-label-xs">ONLINE ROOM</span>
              <div class="cs-room-code">${escapeHtml(onlineLobby.roomCode ?? "")}</div>
            </div>
            <div class="cs-room-btns">
              <button type="button" class="cs-btn cs-btn-secondary" data-action="copy-invite">Copy Invite Link</button>
              <button type="button" class="cs-btn cs-btn-ghost" data-action="leave-room">Leave</button>
            </div>
          </div>
          <div class="cs-roster">
            ${onlineLobby.players
              .map(
                (p) => `
              <div class="cs-roster-row">
                <span class="cs-dot" style="background:${escapeHtml(p.color)}"></span>
                <span class="cs-roster-name">${escapeHtml(p.name)}${p.id === onlineLobby.hostId ? " ★" : ""}</span>
                <span class="cs-roster-species">${escapeHtml(SPECIES_CATALOG[p.species].name)}</span>
                ${activeMode === "2v2" ? `<span class="cs-team-chip">Team ${p.team === 0 ? "A" : "B"}</span>` : ""}
              </div>
            `,
              )
              .join("")}
          </div>
          ${
            isHost
              ? `<button type="button" class="cs-btn cs-btn-primary cs-btn-lg" data-action="start-online" ${onlineLobby.players.length < 2 ? "disabled" : ""}>Launch Island Siege (${onlineLobby.players.length} Critters)</button>`
              : `<div class="cs-wait-note">Waiting for room host to launch the match...</div>`
          }
        </div>
      `
      : `
        <div class="cs-cta-row">
          <button type="button" class="cs-btn cs-btn-primary cs-btn-lg" data-action="play-sandbox">
            Play vs Bots
          </button>
          <button type="button" class="cs-btn cs-btn-secondary" data-action="create-room">
            Create Room
          </button>
          <div class="cs-join-group">
            <input type="text" maxlength="4" class="cs-input cs-code-input" data-ref="join-code" placeholder="CODE" value="${escapeHtml(selection.joinCodeInput)}" />
            <button type="button" class="cs-btn cs-btn-secondary" data-action="join-room">Join</button>
          </div>
        </div>
      `;

    this.lobbyLayer.innerHTML = `
      <div class="cs-lobby-shell cs-glass">
        <header class="cs-lobby-header">
          <div>
            <div class="cs-kicker">3D ARTILLERY &amp; EVOLUTION</div>
            <h1 class="cs-title">${escapeHtml(GAME_TITLE)}</h1>
          </div>
          <div class="cs-profile-strip">
            <div class="cs-essence-pill" title="Earned from matches, KOs, and Evo Pods">
              <span>✦</span>
              <strong>${profile.essence}</strong>
              <span>Essence</span>
            </div>
            <input type="text" maxlength="20" class="cs-input cs-name-input" data-ref="player-name" value="${escapeHtml(profile.displayName)}" placeholder="Critter Name" />
            <div class="cs-swatches">${colorSwatchesHtml}</div>
          </div>
        </header>

        ${roomPanelHtml}

        <div class="cs-config-strip">
          <div class="cs-config-group">
            <span class="cs-label-xs">ISLAND BIOME</span>
            <div class="cs-seg-row">${themeButtonsHtml}</div>
          </div>
          <div class="cs-config-group">
            <span class="cs-label-xs">FORMAT</span>
            <div class="cs-seg-row">
              <button type="button" class="cs-seg-btn ${activeMode === "ffa" ? "cs-active" : ""}" data-mode="ffa" ${isHost ? "" : "disabled"}>Free-for-All</button>
              <button type="button" class="cs-seg-btn ${activeMode === "2v2" ? "cs-active" : ""}" data-mode="2v2" ${isHost ? "" : "disabled"}>2v2 Squads</button>
            </div>
          </div>
          <div class="cs-config-group">
            <span class="cs-label-xs">AI CRITTERS</span>
            <div class="cs-seg-row">${botButtonsHtml}</div>
          </div>
        </div>

        <section class="cs-lobby-section">
          <div class="cs-section-head">
            <h2>Choose Species</h2>
            <span class="cs-muted-note">Matches: ${profile.matchesPlayed} · Wins: ${profile.wins}</span>
          </div>
          <div class="cs-species-grid">${speciesCardsHtml}</div>
        </section>

        <section class="cs-lobby-section">
          <div class="cs-section-head">
            <h2>Essence Shop · Bonus Lobby Gadget (1 Charge/Round)</h2>
            <span class="cs-muted-note">Click an owned gadget to equip or unequip</span>
          </div>
          <div class="cs-bonus-grid">${bonusCardsHtml}</div>
        </section>
      </div>
    `;

    this.bindLobbyEvents(profile, selection);
  }

  private bindLobbyEvents(
    profile: PlayerProfile,
    selection: LobbySelectionState,
  ): void {
    const nameInput = this.lobbyLayer.querySelector(
      '[data-ref="player-name"]',
    ) as HTMLInputElement | null;
    if (nameInput) {
      nameInput.addEventListener("change", () => {
        this.callbacks.onNameChange(nameInput.value);
      });
    }

    const codeInput = this.lobbyLayer.querySelector(
      '[data-ref="join-code"]',
    ) as HTMLInputElement | null;
    if (codeInput) {
      codeInput.addEventListener("input", () => {
        codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, "");
        selection.joinCodeInput = codeInput.value;
      });
    }

    this.lobbyLayer.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const hex = btn.dataset.color;
        if (hex) this.callbacks.onColorChange(hex);
      });
    });

    this.lobbyLayer.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const theme = btn.dataset.theme as ThemeId | undefined;
        if (theme) this.callbacks.onThemeChange(theme);
      });
    });

    this.lobbyLayer.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.mode as GameMode | undefined;
        if (mode) this.callbacks.onGameModeChange(mode);
      });
    });

    this.lobbyLayer.querySelectorAll<HTMLButtonElement>("[data-bots]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const count = Number(btn.dataset.bots);
        if (Number.isInteger(count)) this.callbacks.onBotCountChange(count);
      });
    });

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-unlock-species]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const sp = btn.dataset.unlockSpecies as SpeciesId | undefined;
          if (sp) this.callbacks.onUnlockSpecies(sp);
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLDivElement>("[data-species-card]")
      .forEach((card) => {
        card.addEventListener("click", () => {
          const sp = card.dataset.speciesCard as SpeciesId | undefined;
          if (sp && profile.unlockedSpecies.includes(sp)) {
            this.callbacks.onSelectSpecies(sp);
          }
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLButtonElement>("[data-unlock-gadget]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const gid = btn.dataset.unlockGadget as GadgetId | undefined;
          if (gid) this.callbacks.onUnlockBonusGadget(gid);
        });
      });

    this.lobbyLayer
      .querySelectorAll<HTMLDivElement>("[data-bonus-card]")
      .forEach((card) => {
        card.addEventListener("click", () => {
          const gid = card.dataset.bonusCard as GadgetId | undefined;
          if (gid && profile.unlockedBonusGadgets.includes(gid)) {
            const next = selection.bonusGadget === gid ? null : gid;
            this.callbacks.onSelectBonusGadget(next);
          }
        });
      });

    const playBtn = this.lobbyLayer.querySelector('[data-action="play-sandbox"]');
    playBtn?.addEventListener("click", () => this.callbacks.onPlaySandbox());

    const createBtn = this.lobbyLayer.querySelector('[data-action="create-room"]');
    createBtn?.addEventListener("click", () => this.callbacks.onCreateRoom());

    const joinBtn = this.lobbyLayer.querySelector('[data-action="join-room"]');
    joinBtn?.addEventListener("click", () => {
      const code = codeInput?.value ?? selection.joinCodeInput;
      this.callbacks.onJoinRoom(code);
    });

    const startOnlineBtn = this.lobbyLayer.querySelector('[data-action="start-online"]');
    startOnlineBtn?.addEventListener("click", () => this.callbacks.onStartOnlineMatch());

    const leaveBtn = this.lobbyLayer.querySelector('[data-action="leave-room"]');
    leaveBtn?.addEventListener("click", () => this.callbacks.onLeaveRoom());

    const copyBtn = this.lobbyLayer.querySelector('[data-action="copy-invite"]');
    copyBtn?.addEventListener("click", () => this.callbacks.onCopyInviteLink());
  }

  private syncHardpointsDom(critter: CritterState): void {
    const sig = JSON.stringify({
      equipped: critter.equipped,
      apex: critter.apex,
    });
    if (sig === this.lastHardpointSig) {
      return;
    }
    this.lastHardpointSig = sig;

    this.blHardpointsEl.innerHTML = HARDPOINT_SLOTS.map((slot) => {
      const mutId = critter.equipped[slot];
      const mutName = mutId ? MUTATION_CATALOG[mutId].name : "Empty";
      return `
        <div class="cs-hp-pill ${mutId ? "cs-hp-filled" : ""}">
          <span class="cs-hp-slot">${SLOT_LABELS[slot]}</span>
          <span class="cs-hp-val">${escapeHtml(mutName)}</span>
        </div>
      `;
    }).join("");

    if (critter.apex) {
      const apexDef = APEX_CATALOG[critter.apex];
      this.blApexEl.textContent = `APEX SYNERGY · ${apexDef.name.toUpperCase()}`;
      this.blApexEl.classList.remove("cs-hidden");
    } else {
      this.blApexEl.classList.add("cs-hidden");
    }
  }

  private syncHotbarDom(
    critter: CritterState,
    selectedGadget: GadgetId,
    dronePingActive: boolean,
  ): void {
    const visibleGadgets: GadgetId[] = [...STANDARD_GADGETS];
    for (const bonusId of BONUS_GADGETS) {
      const count = critter.gadgetCharges[bonusId];
      if (count !== null && count > 0) {
        visibleGadgets.push(bonusId);
      }
    }

    const sig = JSON.stringify({
      visibleGadgets,
      charges: visibleGadgets.map((g) => critter.gadgetCharges[g]),
      selectedGadget,
      dronePingActive,
    });
    if (sig === this.lastHotbarSig) {
      return;
    }
    this.lastHotbarSig = sig;

    this.hotbarListEl.innerHTML = visibleGadgets
      .map((gid, idx) => {
        const def = GADGET_CATALOG[gid];
        const charges = critter.gadgetCharges[gid];
        const depleted = charges !== null && charges <= 0;
        const selected = gid === selectedGadget;
        const needsPing = Boolean(def.requiresDronePing) && !dronePingActive;
        const badgeText = charges === null ? "∞" : String(charges);
        return `
          <button
            type="button"
            class="cs-hotbar-slot cs-glass ${selected ? "cs-slot-active" : ""} ${depleted ? "cs-slot-empty" : ""}"
            data-gadget="${gid}"
            title="${escapeHtml(def.description)}"
            ${depleted ? "disabled" : ""}
          >
            <span class="cs-slot-key">${idx + 1}</span>
            <span class="cs-slot-name">${escapeHtml(def.name)}</span>
            <span class="cs-slot-charges">${needsPing ? "PING" : badgeText}</span>
          </button>
        `;
      })
      .join("");

    this.hotbarListEl
      .querySelectorAll<HTMLButtonElement>("[data-gadget]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const gid = btn.dataset.gadget as GadgetId | undefined;
          if (gid) {
            this.callbacks.onSelectGadget(gid);
          }
        });
      });
  }

  private syncDraftModal(
    state: MatchState,
    localPlayerId: string | null,
  ): void {
    const inDraftPhase =
      state.phase === "ROUND_DRAFT" || state.phase === "DRAFT_IF_READY";
    if (!inDraftPhase || !localPlayerId) {
      this.draftModal.classList.add("cs-hidden");
      this.lastDraftSig = "";
      return;
    }

    const myDraft: PendingDraftState | undefined = state.pendingDrafts.find(
      (d) => d.playerId === localPlayerId,
    );

    if (!myDraft) {
      // Local player already drafted; waiting for others
      const waitSig = `WAIT:${state.phase}:${state.pendingDrafts.length}`;
      if (waitSig !== this.lastDraftSig) {
        this.lastDraftSig = waitSig;
        this.draftModal.classList.remove("cs-hidden");
        this.draftModal.innerHTML = `
          <div class="cs-modal-card cs-glass cs-modal-sm">
            <div class="cs-kicker">EVOLUTION CHAMBER</div>
            <h2>Waiting for rivals to evolve...</h2>
            <p class="cs-muted-note">Next round launches automatically once all critters select their mutation.</p>
          </div>
        `;
      }
      return;
    }

    const sig = JSON.stringify(myDraft);
    if (sig === this.lastDraftSig) {
      return;
    }
    this.lastDraftSig = sig;
    this.draftModal.classList.remove("cs-hidden");

    const cardsHtml = myDraft.cards
      .map((card) => {
        const def = MUTATION_CATALOG[card.mutationId];
        const replacesDef = card.replacesMutationId
          ? MUTATION_CATALOG[card.replacesMutationId]
          : null;
        return `
          <button type="button" class="cs-draft-card" data-pick-mut="${card.mutationId}" data-pick-slot="${card.slot}">
            <span class="cs-draft-slot">${SLOT_LABELS[card.slot]} HARDPOINT</span>
            <h3>${escapeHtml(def.name)}</h3>
            <p>${escapeHtml(def.description)}</p>
            ${
              replacesDef
                ? `<div class="cs-swap-warning">Replaces ${escapeHtml(replacesDef.name)}</div>`
                : `<div class="cs-new-slot">Installs in open ${SLOT_LABELS[card.slot]} slot</div>`
            }
          </button>
        `;
      })
      .join("");

    this.draftModal.innerHTML = `
      <div class="cs-modal-card cs-glass">
        <div class="cs-kicker">${state.phase === "ROUND_DRAFT" ? "BETWEEN-ROUND EVOLUTION" : "EVO POD EVOLUTION"}</div>
        <h2>Choose 1 Hardpoint Mutation</h2>
        <p class="cs-muted-note">Mutations physically bolt onto your critter and unlock Apex Synergies!</p>
        <div class="cs-draft-grid">${cardsHtml}</div>
        ${
          myDraft.rerollsRemaining > 0
            ? `<div class="cs-draft-footer"><button type="button" class="cs-btn cs-btn-secondary" data-action="reroll-draft">Free Comeback Reroll (${myDraft.rerollsRemaining})</button></div>`
            : ""
        }
      </div>
    `;

    this.draftModal
      .querySelectorAll<HTMLButtonElement>("[data-pick-mut]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const mutId = btn.dataset.pickMut as MutationId | undefined;
          const slot = btn.dataset.pickSlot as HardpointSlot | undefined;
          if (mutId) {
            this.callbacks.onPickMutation(
              mutId,
              myDraft.requiresSlotSwap ? slot : undefined,
            );
          }
        });
      });

    const rerollBtn = this.draftModal.querySelector('[data-action="reroll-draft"]');
    rerollBtn?.addEventListener("click", () => this.callbacks.onRerollDraft());
  }

  private syncMatchOverModal(
    state: MatchState,
    localPlayerId: string | null,
    breakdown: MatchEssenceBreakdown | null,
  ): void {
    if (state.phase !== "MATCH_OVER") {
      this.matchOverModal.classList.add("cs-hidden");
      this.lastMatchOverSig = "";
      return;
    }

    const sig = JSON.stringify({
      winnerId: state.winnerId,
      winnerTeam: state.winnerTeam,
      scores: state.scores,
      breakdown,
    });
    if (sig === this.lastMatchOverSig) {
      return;
    }
    this.lastMatchOverSig = sig;
    this.matchOverModal.classList.remove("cs-hidden");

    const localCritter = state.critters.find((c) => c.id === localPlayerId);
    const localWon =
      localCritter !== undefined &&
      ((state.mode === "2v2" &&
        state.winnerTeam !== null &&
        localCritter.team === state.winnerTeam) ||
        (state.mode === "ffa" && state.winnerId === localCritter.id));

    const winnerCritter = state.critters.find((c) => c.id === state.winnerId);
    const headline = localWon
      ? "VICTORY!"
      : state.mode === "2v2" && state.winnerTeam
        ? `TEAM ${state.winnerTeam} WINS!`
        : winnerCritter
          ? `${winnerCritter.name} WINS!`
          : "MATCH COMPLETE";

    const sorted = [...state.critters].sort((a, b) => b.score - a.score);
    const rowsHtml = sorted
      .map(
        (c) => `
        <tr class="${c.id === localPlayerId ? "cs-row-local" : ""}">
          <td><span class="cs-dot" style="background:${escapeHtml(c.color)}"></span>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(SPECIES_CATALOG[c.species].name)}</td>
          <td>${c.kills}</td>
          <td>${c.podsCollected}</td>
          <td>${Math.round(c.damageDealt)}</td>
          <td><strong>${c.score}</strong></td>
        </tr>
      `,
      )
      .join("");

    const essenceHtml = breakdown
      ? `
        <div class="cs-essence-summary">
          <div class="cs-essence-title">SIEGE ESSENCE EARNED</div>
          <div class="cs-essence-rows">
            <span>Match Finished</span><strong>+${breakdown.finishedBonus} ✦</strong>
            <span>Knockouts (${breakdown.kos})</span><strong>+${breakdown.koBonus} ✦</strong>
            <span>Evo Pods (${breakdown.pods})</span><strong>+${breakdown.podBonus} ✦</strong>
            <span>Victory Bonus</span><strong>+${breakdown.winBonus} ✦</strong>
          </div>
          <div class="cs-essence-total">
            <span>Total Earned: <strong>+${breakdown.totalEarned} ✦</strong></span>
            <span>Balance: <strong>${breakdown.newBalance} ✦</strong></span>
          </div>
        </div>
      `
      : "";

    this.matchOverModal.innerHTML = `
      <div class="cs-modal-card cs-glass">
        <div class="cs-kicker">ISLAND SIEGE COMPLETE</div>
        <h2 class="cs-winner-title">${escapeHtml(headline)}</h2>
        <table class="cs-scoreboard">
          <thead>
            <tr>
              <th>Critter</th>
              <th>Species</th>
              <th>KOs</th>
              <th>Pods</th>
              <th>Dmg</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${essenceHtml}
        <div class="cs-modal-actions">
          <button type="button" class="cs-btn cs-btn-primary" data-action="play-again">Play Again</button>
          <button type="button" class="cs-btn cs-btn-secondary" data-action="back-lobby">Back to Lobby</button>
        </div>
      </div>
    `;

    this.matchOverModal
      .querySelector('[data-action="play-again"]')
      ?.addEventListener("click", () => this.callbacks.onPlayAgain());
    this.matchOverModal
      .querySelector('[data-action="back-lobby"]')
      ?.addEventListener("click", () => this.callbacks.onBackToLobby());
  }
}
