import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  GALE_SCATTER_CONE_MIN_DOT,
  GALE_SCATTER_REACH,
  SdfWorld,
  type EvoPodState,
  type TurnPhase,
  type Vec3,
} from "@critter/shared";
import { CameraRig, type CameraUpdateContext } from "../src/game/cameraRig.js";
import {
  InputController,
  type InputCallbacks,
  type InputCanvasTarget,
  type InputDocumentTarget,
  type InputGlobalTarget,
} from "../src/game/inputController.js";
import { TrajectoryPreview } from "../src/game/trajectoryPreview.js";
import { SynthAudio } from "../src/audio/synthAudio.js";

function makeContext(
  world: SdfWorld,
  overrides: Partial<CameraUpdateContext> = {},
): CameraUpdateContext {
  return {
    targetPos: { x: 12, y: 10, z: 12 },
    yaw: 0,
    pitch: 0,
    phase: "ACTIVE" as TurnPhase,
    localAlive: true,
    shotPos: null,
    world,
    dtSec: 0.05,
    ...overrides,
  };
}

describe("CameraRig", () => {
  it("defaults to over_shoulder, switches to first_person with narrowed FOV, and returns cleanly", () => {
    const world = new SdfWorld(101, "emerald_spire");
    const rig = new CameraRig(16 / 9);

    expect(rig.getMode()).toBe("over_shoulder");
    const defaultFov = rig.camera.fov;
    expect(defaultFov).toBeGreaterThan(52);

    rig.setFirstPerson(true);
    expect(rig.getMode()).toBe("first_person");
    rig.update(makeContext(world, { targetPos: { x: 8, y: 8.5, z: 12 }, yaw: 0.4, pitch: 0.15 }));
    expect(rig.getMode()).toBe("first_person");
    expect(rig.camera.fov).toBeCloseTo(52, 1);
    expect(rig.camera.position.y).toBeCloseTo(8.5 + 0.85, 2);

    rig.setFirstPerson(false);
    rig.update(makeContext(world, { targetPos: { x: 8, y: 8.5, z: 12 }, yaw: 0.4, pitch: 0.15 }));
    expect(rig.getMode()).toBe("over_shoulder");
    expect(rig.camera.fov).toBeGreaterThan(52);
  });

  it("toggles drone_recon cleanly and orbits elevated around island center", () => {
    const world = new SdfWorld(202, "emerald_spire");
    const rig = new CameraRig(16 / 9);

    rig.toggleDroneRecon();
    expect(rig.getMode()).toBe("drone_recon");

    for (let i = 0; i < 20; i++) {
      rig.update(makeContext(world, { dtSec: 0.05 }));
    }
    const beforePos = rig.camera.position.clone();
    expect(beforePos.y).toBeGreaterThan(10);

    rig.orbitDrone(0.85, 0.15, -4.0);
    for (let i = 0; i < 15; i++) {
      rig.update(makeContext(world, { dtSec: 0.05 }));
    }
    const afterPos = rig.camera.position.clone();
    expect(afterPos.y).toBeGreaterThan(10);
    expect(afterPos.distanceTo(beforePos)).toBeGreaterThan(1.5);

    const center = new THREE.Vector3(30, 8, 30);
    const distFromCenter = afterPos.distanceTo(center);
    expect(distFromCenter).toBeGreaterThanOrEqual(19.5);
    expect(distFromCenter).toBeLessThanOrEqual(68.5);

    rig.toggleDroneRecon();
    rig.update(makeContext(world));
    expect(rig.getMode()).toBe("over_shoulder");
  });

  it("derives dynamic 144m Grand Drone Recon center and min/default/max zoom from world size", () => {
    const grandWorld = new SdfWorld(777, "emerald_spire", "grand");
    const rig = new CameraRig(16 / 9);
    const expectedCenter = new THREE.Vector3(
      grandWorld.centerX,
      grandWorld.worldHeight * 0.25,
      grandWorld.centerZ,
    );

    rig.toggleDroneRecon();
    for (let i = 0; i < 60; i++) {
      rig.update(makeContext(grandWorld, { dtSec: 0.1 }));
    }
    const defaultDist = rig.camera.position.distanceTo(expectedCenter);
    expect(defaultDist).toBeCloseTo(grandWorld.worldWidth * 0.72, 0);

    // Zoom all the way in -> clamps cleanly to worldWidth * 0.35
    rig.orbitDrone(0, 0, -500);
    for (let i = 0; i < 60; i++) {
      rig.update(makeContext(grandWorld, { dtSec: 0.1 }));
    }
    const minDist = rig.camera.position.distanceTo(expectedCenter);
    expect(minDist).toBeCloseTo(grandWorld.worldWidth * 0.35, 0);

    // Zoom all the way out -> clamps cleanly to worldWidth * 1.15
    rig.orbitDrone(0, 0, 500);
    for (let i = 0; i < 60; i++) {
      rig.update(makeContext(grandWorld, { dtSec: 0.1 }));
    }
    const maxDist = rig.camera.position.distanceTo(expectedCenter);
    expect(maxDist).toBeCloseTo(grandWorld.worldWidth * 1.15, 0);
  });

  it("forces shot_cam during RESOLVING with shotPos and returns cleanly to over_shoulder in RETREAT", () => {
    const world = new SdfWorld(303, "canyon_arch");
    const rig = new CameraRig(16 / 9);

    rig.toggleDroneRecon();
    rig.update(makeContext(world, { phase: "ACTIVE" }));
    expect(rig.getMode()).toBe("drone_recon");

    const shotPos: Vec3 = { x: 28, y: 15, z: 26 };
    for (let i = 0; i < 15; i++) {
      rig.update(
        makeContext(world, {
          phase: "RESOLVING",
          shotPos: { x: shotPos.x + i * 0.15, y: shotPos.y, z: shotPos.z },
        }),
      );
    }
    expect(rig.getMode()).toBe("shot_cam");
    expect(rig.camera.position.distanceTo(new THREE.Vector3(shotPos.x + 2.1, shotPos.y, shotPos.z))).toBeLessThan(12);

    rig.update(makeContext(world, { phase: "RETREAT", shotPos: null }));
    expect(rig.getMode()).toBe("over_shoulder");
  });

  it("switches to spectator_drone when localAlive is false outside RESOLVING", () => {
    const world = new SdfWorld(404, "twin_pillars");
    const rig = new CameraRig(16 / 9);

    rig.update(makeContext(world, { localAlive: false, phase: "ACTIVE" }));
    expect(rig.getMode()).toBe("spectator_drone");

    rig.update(
      makeContext(world, {
        localAlive: false,
        phase: "RESOLVING",
        shotPos: { x: 26, y: 14, z: 30 },
      }),
    );
    expect(rig.getMode()).toBe("shot_cam");

    rig.update(makeContext(world, { localAlive: false, phase: "RETREAT", shotPos: null }));
    expect(rig.getMode()).toBe("spectator_drone");
  });

  it("pulls over_shoulder camera closer when solid SDF terrain blocks directly behind targetPos", () => {
    const world = new SdfWorld(505, "emerald_spire");

    // Dynamically locate a solid plateau flank on the 60m island where facing +Z puts solid rock directly behind
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    const probeX = sp?.x ?? 14.0;
    const probeStartZ = sp?.z ?? 14.5;
    const probeY = Math.max(5.0, (sp?.y ?? 11.0) - 3.5);
    let targetPos: Vec3 | null = null;
    let aimYaw = 0;

    for (let z = probeStartZ; z <= probeStartZ + 18.0; z += 0.35) {
      if (!world.isSolid(probeX, probeY, z) && !world.isSolid(probeX, probeY + 1.1, z)) {
        if (world.isSolid(probeX, probeY + 1.1, z - 2.0)) {
          targetPos = { x: probeX, y: probeY, z: z + 0.35 };
          aimYaw = 0; // forward = +Z, so behind = -Z into the plateau cliff!
          break;
        }
      }
    }

    expect(targetPos).not.toBeNull();
    const obstructedTarget = targetPos as Vec3;

    const rig = new CameraRig(16 / 9);
    for (let i = 0; i < 10; i++) {
      rig.update(
        makeContext(world, {
          targetPos: obstructedTarget,
          yaw: aimYaw,
          pitch: 0,
          dtSec: 0.05,
        }),
      );
    }

    const camPos = rig.camera.position;
    const armDist = Math.hypot(
      camPos.x - obstructedTarget.x,
      camPos.z - obstructedTarget.z,
    );
    expect(armDist).toBeLessThan(4.6);
    expect(world.isSolid(camPos.x, camPos.y, camPos.z)).toBe(false);

    // TrajectoryPreview updates cleanly with SdfWorld, extends for Optic Visor, and disposes cleanly
    const preview = new TrajectoryPreview();
    expect(preview.group).toBeInstanceOf(THREE.Group);

    const origin: Vec3 = { x: 8, y: 10.5, z: 12 };
    const direction: Vec3 = { x: 0.65, y: 0.75, z: 0.05 };
    const wind: Vec3 = { x: 1.5, y: 0, z: -0.8 };

    preview.update(
      world,
      { gadgetId: "gale_mortar", origin, direction, power: 0.7 },
      wind,
      false,
      true,
    );
    expect(preview.group.visible).toBe(true);

    const instanced = preview.group.children.find(
      (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
    );
    expect(instanced).toBeDefined();
    const normalCount = instanced?.count ?? 0;
    expect(normalCount).toBeGreaterThan(2);
    expect(normalCount).toBeLessThanOrEqual(40);

    preview.update(
      world,
      { gadgetId: "gale_mortar", origin, direction, power: 0.9 },
      wind,
      true,
      true,
    );
    const extendedCount = instanced?.count ?? 0;
    expect(extendedCount).toBeGreaterThanOrEqual(normalCount);
    expect(extendedCount).toBeLessThanOrEqual(40);

    preview.update(
      world,
      { gadgetId: "gale_mortar", origin, direction, power: 0.7 },
      wind,
      false,
      false,
    );
    expect(preview.group.visible).toBe(false);

    const geoSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    preview.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        geoSpies.push(vi.spyOn(obj.geometry, "dispose"));
      }
    });
    expect(geoSpies.length).toBeGreaterThanOrEqual(2);

    preview.dispose();
    for (const spy of geoSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(preview.group.children.length).toBe(0);
  });

  it("handles Pointer Lock mouse-look, zero-misfire unlocked click/drag, Q/E turn, KeyX nudge, UI fire, double-tap Space backflip, and clean dispose", () => {
    const canvasListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const docListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

    const makeDispatcher = (
      store: Map<string, Set<EventListenerOrEventListenerObject>>,
    ) => ({
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        let set = store.get(type);
        if (!set) {
          set = new Set();
          store.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        store.get(type)?.delete(listener);
      },
      dispatch(type: string, event: Event): void {
        const set = store.get(type);
        if (!set) return;
        for (const fn of set) {
          if (typeof fn === "function") {
            fn(event);
          } else {
            fn.handleEvent(event);
          }
        }
      },
    });

    const canvasBus = makeDispatcher(canvasListeners);
    const windowBus = makeDispatcher(windowListeners);
    const docBus = makeDispatcher(docListeners);

    let pointerLockRequests = 0;
    let pointerLockExits = 0;
    let lockedEl: unknown = null;

    const mockCanvas: InputCanvasTarget = {
      addEventListener: (t, l) => canvasBus.addEventListener(t, l),
      removeEventListener: (t, l) => canvasBus.removeEventListener(t, l),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      requestPointerLock: () => {
        pointerLockRequests += 1;
      },
    };
    const mockWindow: InputGlobalTarget = {
      addEventListener: (t, l) => windowBus.addEventListener(t, l),
      removeEventListener: (t, l) => windowBus.removeEventListener(t, l),
    };
    const mockDoc: InputDocumentTarget = {
      get pointerLockElement() {
        return lockedEl;
      },
      exitPointerLock: () => {
        pointerLockExits += 1;
        lockedEl = null;
        docBus.dispatch("pointerlockchange", {} as Event);
      },
      addEventListener: (t, l) => docBus.addEventListener(t, l),
      removeEventListener: (t, l) => docBus.removeEventListener(t, l),
    };

    const firedPowers: number[] = [];
    const selectedIndices: number[] = [];
    const fpStates: boolean[] = [];
    const dronePings: Vec3[] = [];
    let utilityCalls = 0;
    let burrowCalls = 0;
    let nudgeCalls = 0;
    let toggleDroneCalls = 0;

    const callbacks: InputCallbacks = {
      onFire: (p) => firedPowers.push(p),
      onUtility: () => {
        utilityCalls += 1;
      },
      onRetreatBurrow: () => {
        burrowCalls += 1;
      },
      onDroneNudge: () => {
        nudgeCalls += 1;
      },
      onDronePing: (pt) => {
        if (pt) {
          dronePings.push(pt);
        }
      },
      onSelectGadgetIndex: (idx) => selectedIndices.push(idx),
      onToggleDrone: () => {
        toggleDroneCalls += 1;
      },
      onFirstPersonChange: (active) => fpStates.push(active),
    };

    const camera = new THREE.PerspectiveCamera(64, 800 / 600, 0.1, 200);
    camera.position.set(12, 16, 22);
    camera.lookAt(12, 5, 12);
    camera.updateMatrixWorld();

    const controller = new InputController(
      mockCanvas,
      camera,
      callbacks,
      undefined,
      mockWindow,
      mockDoc,
    );
    controller.setCanAct(true, true, false);
    controller.setAim(0, 0.18);
    expect(controller.isPointerLocked()).toBe(false);

    // 1. Unlocked first click requests pointer lock cleanly WITHOUT firing or charging
    canvasBus.dispatch("mousedown", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    expect(pointerLockRequests).toBe(1);
    const snap = controller.update(0.1);
    expect(snap.charging).toBe(false);
    windowBus.dispatch("mouseup", { button: 0, clientX: 401, clientY: 300 } as unknown as Event);
    expect(firedPowers.length).toBe(0);

    // 2. Unlocked LMB drag (>6px) smoothly orbits yaw/pitch with ZERO misfire on release
    const yawBeforeDrag = controller.update(0).yaw;
    canvasBus.dispatch("mousedown", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    windowBus.dispatch("mousemove", { clientX: 440, clientY: 280 } as unknown as Event);
    windowBus.dispatch("mouseup", { button: 0, clientX: 440, clientY: 280 } as unknown as Event);
    expect(controller.update(0).yaw).not.toBeCloseTo(yawBeforeDrag, 3);
    expect(firedPowers.length).toBe(0);

    // 3. Unlocked RMB drag (>6px) smoothly orbits without snapping into First-Person Visor
    const yawBeforeRmbDrag = controller.update(0).yaw;
    canvasBus.dispatch("mousedown", { button: 2, clientX: 400, clientY: 300 } as unknown as Event);
    windowBus.dispatch("mousemove", { clientX: 350, clientY: 310 } as unknown as Event);
    windowBus.dispatch("mouseup", { button: 2, clientX: 350, clientY: 310 } as unknown as Event);
    expect(controller.update(0).yaw).not.toBeCloseTo(yawBeforeRmbDrag, 3);
    expect(fpStates.length).toBe(0);

    // 4. Engage Pointer Lock -> free mouse-look with NO button held, hold LMB charges & releases to fire
    lockedEl = mockCanvas;
    docBus.dispatch("pointerlockchange", {} as Event);
    expect(controller.isPointerLocked()).toBe(true);

    const yawLockedBefore = controller.update(0).yaw;
    windowBus.dispatch("mousemove", { movementX: 25, movementY: -15 } as unknown as Event);
    const afterFreeLook = controller.update(0);
    expect(afterFreeLook.yaw).toBeLessThan(yawLockedBefore);
    expect(afterFreeLook.pitch).toBeGreaterThan(0.18);

    // Hold LMB while locked for 0.7s -> ramps charge power and fires on release
    canvasBus.dispatch("mousedown", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    let mid = controller.update(0.1);
    for (let i = 0; i < 6; i++) {
      mid = controller.update(0.1);
    }
    expect(mid.charging).toBe(true);
    expect(mid.chargePower).toBeGreaterThan(0.5);
    expect(mid.chargePower).toBeLessThan(0.7);
    windowBus.dispatch("mouseup", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    expect(firedPowers.length).toBe(1);
    expect(firedPowers[0]).toBeCloseTo(mid.chargePower, 2);

    // 5. Pressing RMB mid-charge while locked cancels charge cleanly AND enters First-Person Visor
    canvasBus.dispatch("mousedown", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    expect(controller.update(0.1).charging).toBe(true);
    canvasBus.dispatch("mousedown", { button: 2, clientX: 400, clientY: 300 } as unknown as Event);
    expect(controller.update(0).charging).toBe(false);
    expect(fpStates).toEqual([true]);
    // Releasing LMB after cancel must NOT fire!
    windowBus.dispatch("mouseup", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    expect(firedPowers.length).toBe(1);
    // Releasing RMB exits First-Person Visor
    windowBus.dispatch("mouseup", { button: 2, clientX: 400, clientY: 300 } as unknown as Event);
    expect(fpStates).toEqual([true, false]);

    // 6. Q / E smoothly rotate camera yaw (Q turns left +yaw, E turns right -yaw) and E never triggers wind nudge
    controller.setAim(0, 0.18);
    windowBus.dispatch("keydown", { code: "KeyQ", repeat: false } as unknown as Event);
    const afterQ = controller.update(0.2);
    windowBus.dispatch("keyup", { code: "KeyQ" } as unknown as Event);
    expect(afterQ.yaw).toBeGreaterThan(0.25);

    windowBus.dispatch("keydown", { code: "KeyE", repeat: false } as unknown as Event);
    const afterE = controller.update(0.2);
    windowBus.dispatch("keyup", { code: "KeyE" } as unknown as Event);
    expect(afterE.yaw).toBeCloseTo(0, 2);
    expect(nudgeCalls).toBe(0);

    // 7. Accessible HOLD TO FIRE UI API + cancelCharge() + Hold Enter
    controller.startUiFireCharge();
    controller.update(0.2);
    controller.update(0.2);
    controller.releaseUiFireCharge();
    expect(firedPowers.length).toBe(2);

    controller.startUiFireCharge();
    expect(controller.update(0.1).charging).toBe(true);
    controller.cancelCharge();
    expect(controller.update(0).charging).toBe(false);
    controller.releaseUiFireCharge();
    expect(firedPowers.length).toBe(2);

    // Hold Enter fires cleanly even when unlocked
    controller.exitPointerLock();
    expect(pointerLockExits).toBe(1);
    expect(controller.isPointerLocked()).toBe(false);
    windowBus.dispatch("keydown", { code: "Enter", repeat: false } as unknown as Event);
    controller.update(0.2);
    windowBus.dispatch("keyup", { code: "Enter" } as unknown as Event);
    expect(firedPowers.length).toBe(3);

    // 8. Double-tap Space within 280ms while stationary triggers backflipPressed; slow tap or walking does not
    windowBus.dispatch("keydown", { code: "Space", repeat: false } as unknown as Event);
    const firstTap = controller.update(0.08);
    windowBus.dispatch("keyup", { code: "Space" } as unknown as Event);
    expect(firstTap.jumpPressed).toBe(true);
    expect(firstTap.backflipPressed).toBe(false);

    controller.update(0.08); // total 160ms <= 280ms
    windowBus.dispatch("keydown", { code: "Space", repeat: false } as unknown as Event);
    const secondTap = controller.update(0.016);
    windowBus.dispatch("keyup", { code: "Space" } as unknown as Event);
    expect(secondTap.backflipPressed).toBe(true);
    expect(secondTap.jumpPressed).toBe(false);

    // Waiting > 280ms resets double-tap window
    windowBus.dispatch("keydown", { code: "Space", repeat: false } as unknown as Event);
    controller.update(0.05);
    windowBus.dispatch("keyup", { code: "Space" } as unknown as Event);
    controller.update(0.2);
    controller.update(0.2); // 450ms > 280ms
    windowBus.dispatch("keydown", { code: "Space", repeat: false } as unknown as Event);
    const slowTap = controller.update(0.016);
    windowBus.dispatch("keyup", { code: "Space" } as unknown as Event);
    expect(slowTap.backflipPressed).toBe(false);
    expect(slowTap.jumpPressed).toBe(true);

    // Walking forward (KeyW held) blocks backflip on double-tap Space
    controller.update(0.35);
    windowBus.dispatch("keydown", { code: "KeyW", repeat: false } as unknown as Event);
    windowBus.dispatch("keydown", { code: "Space", repeat: false } as unknown as Event);
    controller.update(0.05);
    windowBus.dispatch("keyup", { code: "Space" } as unknown as Event);
    windowBus.dispatch("keydown", { code: "Space", repeat: false } as unknown as Event);
    const walkTap = controller.update(0.016);
    windowBus.dispatch("keyup", { code: "Space" } as unknown as Event);
    windowBus.dispatch("keyup", { code: "KeyW" } as unknown as Event);
    expect(walkTap.backflipPressed).toBe(false);

    // 9. Keyboard shortcuts: Tab (preventDefault), V, 1..6, F, X (Spectator Drone Wind Nudge), G
    let tabPrevented = false;
    windowBus.dispatch("keydown", {
      code: "Tab",
      repeat: false,
      preventDefault: () => {
        tabPrevented = true;
      },
    } as unknown as Event);
    expect(tabPrevented).toBe(true);
    expect(toggleDroneCalls).toBe(1);

    windowBus.dispatch("keydown", { code: "KeyV", repeat: false } as unknown as Event);
    windowBus.dispatch("keydown", { code: "Digit3", repeat: false } as unknown as Event);
    windowBus.dispatch("keydown", { code: "KeyF", repeat: false } as unknown as Event);
    windowBus.dispatch("keydown", { code: "KeyX", repeat: false } as unknown as Event);
    windowBus.dispatch("keydown", { code: "KeyG", repeat: false } as unknown as Event);
    expect(fpStates).toEqual([true, false, true]);
    // External HUD switch to Shoulder via syncFirstPerson(false) -> next V press enters Visor in 1 keypress
    controller.syncFirstPerson(false);
    windowBus.dispatch("keydown", { code: "KeyV", repeat: false } as unknown as Event);
    expect(fpStates).toEqual([true, false, true, true]);
    // External HUD switch to Visor via syncFirstPerson(true) -> next V press exits Visor in 1 keypress
    controller.syncFirstPerson(true);
    windowBus.dispatch("keydown", { code: "KeyV", repeat: false } as unknown as Event);
    expect(fpStates).toEqual([true, false, true, true, false]);
    expect(selectedIndices).toEqual([2]);
    expect(burrowCalls).toBe(1);
    expect(nudgeCalls).toBe(1);
    expect(utilityCalls).toBe(1);

    // 10. Drone click-to-ping raycasts against target mesh
    const targetPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshBasicMaterial(),
    );
    targetPlane.rotation.x = -Math.PI * 0.5;
    targetPlane.position.set(12, 5, 12);
    targetPlane.updateMatrixWorld();
    controller.setRaycastTargets([targetPlane]);
    controller.setCanAct(true, true, true);

    canvasBus.dispatch("mousedown", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    windowBus.dispatch("mouseup", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    expect(dronePings.length).toBe(1);
    expect(dronePings[0]?.y).toBeCloseTo(5, 1);

    targetPlane.geometry.dispose();
    (targetPlane.material as THREE.Material).dispose();

    // 11. Dispose must detach EVERY listener cleanly
    controller.dispose();
    for (const set of canvasListeners.values()) {
      expect(set.size).toBe(0);
    }
    for (const set of windowListeners.values()) {
      expect(set.size).toBe(0);
    }
    for (const set of docListeners.values()) {
      expect(set.size).toBe(0);
    }
  });

  it("runs SynthAudio cleanly in headless Node without AudioContext and toggles mute safely", () => {
    const audio = new SynthAudio();
    expect(audio.isMuted()).toBe(false);

    expect(() => {
      audio.playChargeTick(0.65);
      audio.playLaunch("gale_mortar");
      audio.playLaunch("spore_burst");
      audio.playLaunch("quake_club");
      audio.playLaunch("burrow_bore");
      audio.playLaunch("vine_grapple");
      audio.playLaunch("seeker_firefly");
      audio.playExplosion(2.4);
      audio.playSplash();
      audio.playMutationChime();
      audio.playTurnTick(false);
      audio.playTurnTick(true);
      audio.playUiClick();
    }).not.toThrow();

    expect(audio.toggleMute()).toBe(true);
    expect(audio.isMuted()).toBe(true);
    audio.setMuted(false);
    expect(audio.isMuted()).toBe(false);
    audio.dispose();
    audio.playUiClick();
  });

  it("renders translucent gold ghost trajectory arc alongside active cyan arc and disposes all geometries/materials cleanly", () => {
    const world = new SdfWorld(606, "mountain_spine");
    const preview = new TrajectoryPreview();

    const origin: Vec3 = { x: 10, y: 11, z: 10 };
    const activeDir: Vec3 = { x: 0.65, y: 0.75, z: 0.1 };
    const ghostDir: Vec3 = { x: 0.55, y: 0.82, z: 0.15 };
    const wind: Vec3 = { x: 1.2, y: 0, z: -0.6 };

    // Without ghostParams -> ghost arc hidden
    preview.update(
      world,
      { gadgetId: "gale_mortar", origin, direction: activeDir, power: 0.7 },
      wind,
      false,
      true,
    );
    const ghostDots = preview.group.getObjectByName("trajectory_ghost_dots");
    const ghostRing = preview.group.getObjectByName("trajectory_ghost_landing_ring");
    expect(ghostDots).toBeInstanceOf(THREE.InstancedMesh);
    expect(ghostRing).toBeInstanceOf(THREE.Mesh);
    if (ghostDots instanceof THREE.InstancedMesh) {
      expect(ghostDots.count).toBe(0);
    }
    expect(ghostRing?.visible).toBe(false);

    // With ghostParams -> both active cyan arc and gold ghost arc + landing ring render
    preview.update(
      world,
      { gadgetId: "gale_mortar", origin, direction: activeDir, power: 0.7 },
      wind,
      false,
      true,
      { gadgetId: "gale_mortar", origin, direction: ghostDir, power: 0.62 },
    );
    if (ghostDots instanceof THREE.InstancedMesh) {
      expect(ghostDots.count).toBeGreaterThan(2);
      expect(ghostDots.count).toBeLessThanOrEqual(40);
      expect(ghostDots.material).toBeInstanceOf(THREE.MeshBasicMaterial);
      if (ghostDots.material instanceof THREE.MeshBasicMaterial) {
        expect(ghostDots.material.transparent).toBe(true);
        expect(ghostDots.material.opacity).toBeLessThan(0.65);
      }
    }
    expect(ghostRing?.visible).toBe(true);

    // Spy on every mesh geometry & material dispose
    const geoSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    const matSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    preview.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        geoSpies.push(vi.spyOn(obj.geometry, "dispose"));
        if (!Array.isArray(obj.material)) {
          matSpies.push(vi.spyOn(obj.material, "dispose"));
        }
      }
    });
    expect(geoSpies.length).toBeGreaterThanOrEqual(4);
    expect(matSpies.length).toBeGreaterThanOrEqual(4);

    preview.dispose();
    for (const spy of geoSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    for (const spy of matSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it("applies decaying camera screen-shake during Shot Cam and settles back cleanly", () => {
    const world = new SdfWorld(707, "emerald_spire");
    const rigA = new CameraRig(16 / 9);
    const rigB = new CameraRig(16 / 9);

    const shotCtx = makeContext(world, {
      phase: "RESOLVING",
      shotPos: { x: 25, y: 14, z: 25 },
      dtSec: 0.05,
    });
    for (let i = 0; i < 8; i++) {
      rigA.update(shotCtx);
      rigB.update(shotCtx);
    }

    rigB.triggerShake(0.9, 0.3);
    rigA.update(shotCtx);
    rigB.update(shotCtx);
    expect(rigA.camera.position.distanceTo(rigB.camera.position)).toBeGreaterThan(0.05);

    // After shake duration elapses, camera settles cleanly back to baseline
    for (let i = 0; i < 12; i++) {
      rigA.update(shotCtx);
      rigB.update(shotCtx);
    }
    expect(rigA.camera.position.distanceTo(rigB.camera.position)).toBeLessThan(0.001);
  });

  it("activates panoramic flood_cam during FINAL_FLOOD and stays cleanly above the rising waterLevel", () => {
    const world = new SdfWorld(808, "emerald_spire");
    const rig = new CameraRig(16 / 9);

    // Even if first-person or shot-cam was active beforehand, FINAL_FLOOD takes highest priority
    rig.setFirstPerson(true);
    rig.update(makeContext(world, { phase: "ACTIVE", waterLevel: 2.0 }));
    expect(rig.getMode()).toBe("first_person");

    rig.update(
      makeContext(world, {
        phase: "FINAL_FLOOD",
        shotPos: { x: 25, y: 12, z: 25 },
        localAlive: true,
        waterLevel: 6.0,
        dtSec: 0.05,
      }),
    );
    expect(rig.getMode()).toBe("flood_cam");
    expect(rig.camera.position.y).toBeGreaterThanOrEqual(6.0 + 8.0);

    const startPos = rig.camera.position.clone();

    // Advance across rising Final Deluge water levels -> smoothly orbits and never clips underwater
    for (let step = 1; step <= 40; step++) {
      const risingWater = 6.0 + step * 0.6; // rises up to 30.0m
      rig.update(
        makeContext(world, {
          phase: "FINAL_FLOOD",
          localAlive: step < 25,
          waterLevel: risingWater,
          dtSec: 0.08,
        }),
      );
      expect(rig.getMode()).toBe("flood_cam");
      expect(rig.camera.position.y).toBeGreaterThanOrEqual(risingWater + 8.0 - 1e-4);
    }

    // Confirm panoramic orbit moved around the island center at ~worldSpan * 0.72 radius
    const endPos = rig.camera.position.clone();
    expect(endPos.distanceTo(startPos)).toBeGreaterThan(5.0);
    const horizDist = Math.hypot(
      endPos.x - world.centerX,
      endPos.z - world.centerZ,
    );
    expect(horizDist).toBeCloseTo(world.worldWidth * 0.72, 0);
  });

  it("keeps shot_cam strictly outside solid SDF terrain when a Burrow Bore tunnels deep inside a cliff", () => {
    const world = new SdfWorld(909, "emerald_spire");

    // Locate a thick solid rock interior where both shotPos and default trailing offset (-5.2 behind, +2.8 up) are solid
    let rockOrigin: Vec3 | null = null;
    for (let x = 18; x <= 42 && !rockOrigin; x += 1.0) {
      for (let z = 18; z <= 42 && !rockOrigin; z += 1.0) {
        const surfY = world.getSurfaceY(x, z);
        if (surfY === null || surfY < 10.0) {
          continue;
        }
        const deepY = surfY - 6.0;
        if (
          deepY >= 2.0 &&
          world.isSolid(x, deepY, z) &&
          world.isSolid(x - 5.2, Math.max(3.2, deepY + 2.8), z + 1.6)
        ) {
          rockOrigin = { x, y: deepY, z };
        }
      }
    }

    expect(rockOrigin).not.toBeNull();
    const cliffCore = rockOrigin as Vec3;

    const rig = new CameraRig(16 / 9);
    // Start in open air approaching the cliff along +X, then bore straight through solid rock
    for (let step = 0; step < 24; step++) {
      const shotPos: Vec3 = {
        x: cliffCore.x - 10 + step * 0.65,
        y: cliffCore.y,
        z: cliffCore.z,
      };
      if (step === 16) {
        rig.triggerShake(0.8, 0.25);
      }
      rig.update(
        makeContext(world, {
          phase: "RESOLVING",
          shotPos,
          dtSec: 0.04,
        }),
      );
      expect(rig.getMode()).toBe("shot_cam");
      const pos = rig.camera.position;
      expect(world.isSolid(pos.x, pos.y, pos.z)).toBe(false);
    }

    // Fresh rig initialized directly on a deep solid rock coordinate must also stay strictly outside solid terrain
    const freshRig = new CameraRig(16 / 9);
    freshRig.update(
      makeContext(world, {
        phase: "RESOLVING",
        shotPos: cliffCore,
        dtSec: 0.05,
      }),
    );
    expect(freshRig.getMode()).toBe("shot_cam");
    expect(
      world.isSolid(
        freshRig.camera.position.x,
        freshRig.camera.position.y,
        freshRig.camera.position.z,
      ),
    ).toBe(false);
  });

  it("renders Gale Scatter spread cone and Vine Grapple latch previews with exact shared parity, switches cleanly, and disposes all resources", () => {
    const world = new SdfWorld(515, "emerald_spire");
    const preview = new TrajectoryPreview();

    const origin: Vec3 = { x: world.centerX, y: 14, z: world.centerZ };
    const forwardDir: Vec3 = { x: 1, y: 0, z: 0 };
    const wind: Vec3 = { x: 1.0, y: 0, z: -0.5 };

    // 1. Gale Scatter (quake_club) shows gale_scatter_cone and hides ballistic arc + grapple preview
    preview.update(
      world,
      { gadgetId: "quake_club", origin, direction: forwardDir, power: 1.0 },
      wind,
      false,
      true,
      { gadgetId: "gale_mortar", origin, direction: forwardDir, power: 0.7 },
    );
    expect(preview.group.visible).toBe(true);

    const scatterCone = preview.group.getObjectByName("gale_scatter_cone");
    const grapplePreview = preview.group.getObjectByName("grapple_latch_preview");
    const arcDots = preview.group.getObjectByName("trajectory_arc_dots");
    const ghostDots = preview.group.getObjectByName("trajectory_ghost_dots");

    expect(scatterCone).toBeInstanceOf(THREE.Group);
    expect(scatterCone?.visible).toBe(true);
    expect(grapplePreview).toBeInstanceOf(THREE.Group);
    expect(grapplePreview?.visible).toBe(false);
    if (arcDots instanceof THREE.InstancedMesh) {
      expect(arcDots.count).toBe(0);
    }
    if (ghostDots instanceof THREE.InstancedMesh) {
      expect(ghostDots.count).toBe(0);
    }

    // Verify exact shared cone dimensions: length === GALE_SCATTER_REACH (6.0), radius === reach * tan(acos(0.85))
    const expectedRadius =
      GALE_SCATTER_REACH * Math.tan(Math.acos(GALE_SCATTER_CONE_MIN_DOT));
    const mouthRing = scatterCone?.getObjectByName("gale_scatter_mouth_ring");
    expect(mouthRing).toBeInstanceOf(THREE.Mesh);
    expect(mouthRing?.position.z).toBeCloseTo(GALE_SCATTER_REACH, 3);
    if (mouthRing instanceof THREE.Mesh && mouthRing.geometry instanceof THREE.TorusGeometry) {
      expect(mouthRing.geometry.parameters.radius).toBeCloseTo(expectedRadius, 3);
    }
    const windRays = scatterCone?.getObjectByName("gale_scatter_wind_rays");
    expect(windRays).toBeInstanceOf(THREE.LineSegments);
    if (windRays instanceof THREE.LineSegments) {
      const posAttr = windRays.geometry.getAttribute("position");
      expect(posAttr?.count).toBe(10); // 5 diverging rays * 2 endpoints
    }

    // 2. Vine Grapple aimed down at island terrain shows emerald latch preview
    const sp = world.findSpawnPoints(1)[0];
    expect(sp).toBeDefined();
    const grappleOrigin: Vec3 = {
      x: sp?.x ?? world.centerX,
      y: (sp?.y ?? 10) + 5.0,
      z: sp?.z ?? world.centerZ,
    };
    preview.update(
      world,
      {
        gadgetId: "vine_grapple",
        origin: grappleOrigin,
        direction: { x: 0, y: -1, z: 0 },
        power: 1.0,
        grappleReach: 18,
        waterLevel: 1.8,
      },
      wind,
      false,
      true,
    );
    expect(preview.group.visible).toBe(true);
    expect(scatterCone?.visible).toBe(false);
    expect(grapplePreview?.visible).toBe(true);

    const latchRing = grapplePreview?.getObjectByName("grapple_latch_ring");
    expect(latchRing).toBeInstanceOf(THREE.Mesh);
    if (latchRing instanceof THREE.Mesh && latchRing.material instanceof THREE.MeshBasicMaterial) {
      expect(latchRing.material.color.getHex()).toBe(0x34d399);
    }

    // 3. Vine Grapple aimed at an uncollected Evo Pod turns latch ring gold (0xfacc15)
    const skyOrigin: Vec3 = { x: world.centerX, y: world.worldHeight - 2.0, z: world.centerZ };
    const podTarget: EvoPodState = {
      id: "pod-grapple-test",
      position: { x: skyOrigin.x + 8.0, y: skyOrigin.y, z: skyOrigin.z },
      collected: false,
      mutationChoices: ["glider_wings", "spring_paws", "optic_visor"],
    };
    preview.update(
      world,
      {
        gadgetId: "vine_grapple",
        origin: skyOrigin,
        direction: { x: 1, y: 0, z: 0 },
        power: 1.0,
        grappleReach: 18,
        waterLevel: 1.8,
        evoPods: [podTarget],
      },
      wind,
      false,
      true,
    );
    expect(preview.group.visible).toBe(true);
    expect(grapplePreview?.visible).toBe(true);
    if (latchRing instanceof THREE.Mesh && latchRing.material instanceof THREE.MeshBasicMaterial) {
      expect(latchRing.material.color.getHex()).toBe(0xfacc15);
    }

    // 4. Vine Grapple aimed into empty sky hides preview cleanly
    preview.update(
      world,
      {
        gadgetId: "vine_grapple",
        origin: skyOrigin,
        direction: { x: 0, y: 1, z: 0 },
        power: 1.0,
        grappleReach: 18,
        waterLevel: 1.8,
      },
      wind,
      false,
      true,
    );
    expect(grapplePreview?.visible).toBe(false);
    expect(preview.group.visible).toBe(false);

    // 5. Switching back to gale_mortar hides cone & grapple cleanly and restores ballistic dots
    preview.update(
      world,
      {
        gadgetId: "gale_mortar",
        origin: { x: 10, y: 11, z: 10 },
        direction: { x: 0.65, y: 0.75, z: 0.1 },
        power: 0.7,
      },
      wind,
      false,
      true,
    );
    expect(scatterCone?.visible).toBe(false);
    expect(grapplePreview?.visible).toBe(false);
    if (arcDots instanceof THREE.InstancedMesh) {
      expect(arcDots.count).toBeGreaterThan(2);
    }

    // 6. visible = false hides everything
    preview.update(
      world,
      { gadgetId: "quake_club", origin, direction: forwardDir, power: 1.0 },
      wind,
      false,
      false,
    );
    expect(preview.group.visible).toBe(false);
    expect(scatterCone?.visible).toBe(false);
    expect(grapplePreview?.visible).toBe(false);

    // 7. Dispose releases every mesh & line geometry and material cleanly
    const geoSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    const matSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    preview.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
        geoSpies.push(vi.spyOn(obj.geometry, "dispose"));
        if (!Array.isArray(obj.material)) {
          matSpies.push(vi.spyOn(obj.material, "dispose"));
        }
      }
    });
    expect(geoSpies.length).toBeGreaterThanOrEqual(9);
    expect(matSpies.length).toBeGreaterThanOrEqual(9);

    preview.dispose();
    for (const spy of geoSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    for (const spy of matSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(preview.group.children.length).toBe(0);
  });

  it("fires quake_club (Gale Scatter) instantly at power 1.0 without charging while preserving unlocked pointer-lock zero-misfire", () => {
    const canvasListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const docListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

    const makeBus = (store: Map<string, Set<EventListenerOrEventListenerObject>>) => ({
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        let set = store.get(type);
        if (!set) {
          set = new Set();
          store.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        store.get(type)?.delete(listener);
      },
      dispatch(type: string, event: Event): void {
        const set = store.get(type);
        if (!set) return;
        for (const fn of set) {
          if (typeof fn === "function") {
            fn(event);
          } else {
            fn.handleEvent(event);
          }
        }
      },
    });

    const canvasBus = makeBus(canvasListeners);
    const windowBus = makeBus(windowListeners);
    const docBus = makeBus(docListeners);

    let pointerLockRequests = 0;
    let lockedEl: unknown = null;

    const mockCanvas: InputCanvasTarget = {
      addEventListener: (t, l) => canvasBus.addEventListener(t, l),
      removeEventListener: (t, l) => canvasBus.removeEventListener(t, l),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      requestPointerLock: () => {
        pointerLockRequests += 1;
      },
    };
    const mockWindow: InputGlobalTarget = {
      addEventListener: (t, l) => windowBus.addEventListener(t, l),
      removeEventListener: (t, l) => windowBus.removeEventListener(t, l),
    };
    const mockDoc: InputDocumentTarget = {
      get pointerLockElement() {
        return lockedEl;
      },
      exitPointerLock: () => {
        lockedEl = null;
      },
      addEventListener: (t, l) => docBus.addEventListener(t, l),
      removeEventListener: (t, l) => docBus.removeEventListener(t, l),
    };

    const firedPowers: number[] = [];
    const callbacks: InputCallbacks = {
      onFire: (p) => firedPowers.push(p),
      onUtility: () => undefined,
      onRetreatBurrow: () => undefined,
      onDroneNudge: () => undefined,
      onDronePing: () => undefined,
      onSelectGadgetIndex: () => undefined,
      onToggleDrone: () => undefined,
      onFirstPersonChange: () => undefined,
    };

    const camera = new THREE.PerspectiveCamera(64, 800 / 600, 0.1, 200);
    const controller = new InputController(
      mockCanvas,
      camera,
      callbacks,
      undefined,
      mockWindow,
      mockDoc,
    );
    controller.setCanAct(true, true, false);
    controller.setSelectedGadget("quake_club");

    // 1. Unlocked canvas click MUST lock pointer first with ZERO misfire
    canvasBus.dispatch("mousedown", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    windowBus.dispatch("mouseup", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    expect(pointerLockRequests).toBe(1);
    expect(firedPowers).toEqual([]);
    expect(controller.update(0.05).charging).toBe(false);

    // 2. Pointer-locked LMB click fires immediately at power 1.0 without charging or double-firing on mouseup
    lockedEl = mockCanvas;
    docBus.dispatch("pointerlockchange", {} as Event);
    canvasBus.dispatch("mousedown", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    expect(firedPowers).toEqual([1.0]);
    expect(controller.update(0.05).charging).toBe(false);
    windowBus.dispatch("mouseup", { button: 0, clientX: 400, clientY: 300 } as unknown as Event);
    expect(firedPowers).toEqual([1.0]);

    // 3. Pressing Enter fires immediately at power 1.0 without charging or double-firing on keyup
    windowBus.dispatch("keydown", { code: "Enter", repeat: false } as unknown as Event);
    expect(firedPowers).toEqual([1.0, 1.0]);
    expect(controller.update(0.05).charging).toBe(false);
    windowBus.dispatch("keyup", { code: "Enter" } as unknown as Event);
    expect(firedPowers).toEqual([1.0, 1.0]);

    // 4. Tapping HUD fire button (startUiFireCharge) fires immediately at power 1.0 without charging
    controller.startUiFireCharge();
    expect(firedPowers).toEqual([1.0, 1.0, 1.0]);
    expect(controller.update(0.05).charging).toBe(false);
    controller.releaseUiFireCharge();
    expect(firedPowers).toEqual([1.0, 1.0, 1.0]);

    controller.dispose();
  });
});
