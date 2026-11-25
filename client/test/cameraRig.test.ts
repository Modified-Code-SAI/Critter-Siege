import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { SdfWorld, type TurnPhase, type Vec3 } from "@critter/shared";
import { CameraRig, type CameraUpdateContext } from "../src/game/cameraRig.js";
import {
  InputController,
  type InputCallbacks,
  type InputCanvasTarget,
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

    const center = new THREE.Vector3(12, 5, 12);
    const distFromCenter = afterPos.distanceTo(center);
    expect(distFromCenter).toBeGreaterThanOrEqual(13.5);
    expect(distFromCenter).toBeLessThanOrEqual(32.5);

    rig.toggleDroneRecon();
    rig.update(makeContext(world));
    expect(rig.getMode()).toBe("over_shoulder");
  });

  it("forces shot_cam during RESOLVING with shotPos and returns cleanly to over_shoulder in RETREAT", () => {
    const world = new SdfWorld(303, "canyon_arch");
    const rig = new CameraRig(16 / 9);

    rig.toggleDroneRecon();
    rig.update(makeContext(world, { phase: "ACTIVE" }));
    expect(rig.getMode()).toBe("drone_recon");

    const shotPos: Vec3 = { x: 14, y: 11, z: 10 };
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
        shotPos: { x: 10, y: 9, z: 12 },
      }),
    );
    expect(rig.getMode()).toBe("shot_cam");

    rig.update(makeContext(world, { localAlive: false, phase: "RETREAT", shotPos: null }));
    expect(rig.getMode()).toBe("spectator_drone");
  });

  it("pulls over_shoulder camera closer when solid SDF terrain blocks directly behind targetPos", () => {
    const world = new SdfWorld(505, "emerald_spire");

    // Find a solid hill/plateau wall where facing away puts solid rock directly behind the critter
    // West plateau is centered at (7.2, y<=8.3, 12.0). Stand just outside its east/south cliff flank
    // facing away from the cliff so -forward enters solid rock!
    let targetPos: Vec3 | null = null;
    let aimYaw = 0;
    const probeY = 6.0;

    // Scan outward from (7.2, 6.0, 12.0) along +Z until we exit solid rock into air
    for (let z = 12.0; z <= 21.0; z += 0.25) {
      if (!world.isSolid(7.2, probeY, z) && !world.isSolid(7.2, probeY + 1.1, z)) {
        // Verify solid rock exists directly behind (at z - 1.5 .. z - 3.5) when facing +Z (yaw = 0)
        if (world.isSolid(7.2, probeY + 1.1, z - 2.0)) {
          targetPos = { x: 7.2, y: probeY, z: z + 0.35 };
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

  it("handles InputController charge fire, hotkeys, drone ping, and detaches all listeners on dispose", () => {
    const canvasListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

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

    const mockCanvas: InputCanvasTarget = {
      addEventListener: (t, l) => canvasBus.addEventListener(t, l),
      removeEventListener: (t, l) => canvasBus.removeEventListener(t, l),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    };
    const mockWindow: InputGlobalTarget = {
      addEventListener: (t, l) => windowBus.addEventListener(t, l),
      removeEventListener: (t, l) => windowBus.removeEventListener(t, l),
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
      onDronePing: (pt) => dronePings.push(pt),
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
    );
    controller.setCanAct(true, true, false);

    // Hold LMB for 0.7s (7 x 0.1s frames) -> power ramps from 0.15 halfway toward 1.0, then release fires
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

    // Keyboard shortcuts: Tab (preventDefault), V, 1..6, F, E, G
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
    windowBus.dispatch("keydown", { code: "KeyE", repeat: false } as unknown as Event);
    windowBus.dispatch("keydown", { code: "KeyG", repeat: false } as unknown as Event);
    expect(fpStates).toEqual([true]);
    expect(selectedIndices).toEqual([2]);
    expect(burrowCalls).toBe(1);
    expect(nudgeCalls).toBe(1);
    expect(utilityCalls).toBe(1);

    // Drone click-to-ping raycasts against target mesh
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

    // Dispose must detach EVERY listener cleanly
    controller.dispose();
    for (const set of canvasListeners.values()) {
      expect(set.size).toBe(0);
    }
    for (const set of windowListeners.values()) {
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
});
