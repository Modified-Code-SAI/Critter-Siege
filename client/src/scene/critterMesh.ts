import * as THREE from "three";
import type {
  ApexId,
  HardpointSlot,
  MutationId,
  SpeciesId,
} from "@critter/shared";
import { hasCustomGlbSpecies, loadSpeciesModel } from "./modelLoader.js";

/** Load a species' sculpted Hunyuan3D GLB model if available in browser runtime. */
export async function loadCritterGlbModel(
  species: SpeciesId,
): Promise<THREE.Group | null> {
  if (!hasCustomGlbSpecies(species)) {
    return null;
  }
  return loadSpeciesModel(species);
}

/** Physical 3D attachment anchors on every Critter Siege character rig. */
export interface HardpointAnchors {
  back: THREE.Group;
  legs: THREE.Group;
  offense: THREE.Group;
  crest: THREE.Group;
}

const HARDPOINT_SLOTS: readonly HardpointSlot[] = [
  "back",
  "legs",
  "offense",
  "crest",
];

const APEX_COLORS: Record<ApexId, number> = {
  sky_bomber: 0x38e8ff,
  bastion_tank: 0x52e07a,
  tunnel_sapper: 0xff9d38,
  siege_sniper: 0xb57cff,
  apex_hybrid: 0xffdf55,
};

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    for (const item of material) {
      item.dispose();
    }
    return;
  }
  material.dispose();
}

/** Recursively dispose all geometries and materials inside an Object3D subtree. */
function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    } else if (obj instanceof THREE.Line) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    } else if (obj instanceof THREE.Points) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    } else if (obj instanceof THREE.Sprite) {
      obj.geometry.dispose();
      disposeMaterial(obj.material);
    }
  });
}

function createMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  pos?: readonly [number, number, number],
  rot?: readonly [number, number, number],
  scale?: readonly [number, number, number],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (pos) {
    mesh.position.set(pos[0], pos[1], pos[2]);
  }
  if (rot) {
    mesh.rotation.set(rot[0], rot[1], rot[2]);
  }
  if (scale) {
    mesh.scale.set(scale[0], scale[1], scale[2]);
  }
  return mesh;
}

function makeStandard(
  color: THREE.ColorRepresentation,
  roughness = 0.68,
  metalness = 0.06,
  extra?: {
    emissive?: THREE.ColorRepresentation;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    depthWrite?: boolean;
    side?: THREE.Side;
  },
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    ...(extra?.emissive !== undefined ? { emissive: extra.emissive } : {}),
    ...(extra?.emissiveIntensity !== undefined
      ? { emissiveIntensity: extra.emissiveIntensity }
      : {}),
    ...(extra?.transparent !== undefined
      ? { transparent: extra.transparent }
      : {}),
    ...(extra?.opacity !== undefined ? { opacity: extra.opacity } : {}),
    ...(extra?.depthWrite !== undefined
      ? { depthWrite: extra.depthWrite }
      : {}),
    ...(extra?.side !== undefined ? { side: extra.side } : {}),
  });
}

function addEyes(
  parent: THREE.Group,
  xOffset: number,
  yPos: number,
  zPos: number,
  radius = 0.048,
): void {
  for (const side of [-1, 1] as const) {
    const eye = createMesh(
      new THREE.SphereGeometry(radius, 12, 10),
      makeStandard(0x161820, 0.15, 0.1),
      [side * xOffset, yPos, zPos],
    );
    const glint = createMesh(
      new THREE.SphereGeometry(radius * 0.34, 8, 8),
      makeStandard(0xffffff, 0.1, 0.0, {
        emissive: 0xffffff,
        emissiveIntensity: 0.4,
      }),
      [side * (xOffset - radius * 0.25), yPos + radius * 0.32, zPos + radius * 0.8],
    );
    glint.castShadow = false;
    parent.add(eye, glint);
  }
}

function buildTeamCollar(
  parent: THREE.Group,
  teamColor: string,
  yPos: number,
  radius: number,
  zOffset = 0.02,
): void {
  const collar = createMesh(
    new THREE.TorusGeometry(radius, 0.042, 10, 22),
    makeStandard(teamColor, 0.45, 0.1, {
      emissive: teamColor,
      emissiveIntensity: 0.15,
    }),
    [0, yPos, zOffset],
    [Math.PI * 0.52, 0, 0],
  );
  parent.add(collar);
}

function buildMoleBody(group: THREE.Group, teamColor: string): void {
  // Stout charcoal-velvet ovoid torso
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.36, 18, 14),
      makeStandard(0x3a373f, 0.82, 0.04),
      [0, 0.44, 0],
      undefined,
      [1.06, 0.98, 1.1],
    ),
  );
  // Soft warm gray belly
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.26, 14, 12),
      makeStandard(0x6c6670, 0.86, 0.02),
      [0, 0.38, 0.16],
      undefined,
      [0.95, 0.88, 0.72],
    ),
  );
  // Rounded head dome
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.27, 16, 14),
      makeStandard(0x3a373f, 0.8, 0.04),
      [0, 0.74, 0.08],
      undefined,
      [1.04, 0.92, 1.05],
    ),
  );
  // Cute pink snout cone + dark tip + nostrils
  group.add(
    createMesh(
      new THREE.ConeGeometry(0.115, 0.24, 14),
      makeStandard(0xf2a1b3, 0.55, 0.02),
      [0, 0.7, 0.36],
      [Math.PI * 0.48, 0, 0],
    ),
  );
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.042, 10, 8),
      makeStandard(0xd66b85, 0.4, 0.05),
      [0, 0.7, 0.48],
    ),
  );
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.015, 8, 6),
        makeStandard(0x3c1f29, 0.5, 0.0),
        [side * 0.022, 0.71, 0.49],
      ),
    );
  }
  // Brass forehead goggles (TorusGeometry rims + teal glass lenses + leather strap)
  group.add(
    createMesh(
      new THREE.TorusGeometry(0.245, 0.026, 8, 22),
      makeStandard(0x523624, 0.75, 0.05),
      [0, 0.84, 0.08],
      [Math.PI * 0.46, 0, 0],
    ),
  );
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.TorusGeometry(0.078, 0.02, 10, 18),
        makeStandard(0xc9963b, 0.32, 0.78),
        [side * 0.1, 0.84, 0.31],
        [-0.22, side * 0.24, 0],
      ),
    );
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.068, 12, 10),
        makeStandard(0x63d8e8, 0.15, 0.2, {
          emissive: 0x197080,
          emissiveIntensity: 0.3,
          transparent: true,
          opacity: 0.82,
        }),
        [side * 0.1, 0.84, 0.3],
        [-0.22, side * 0.24, 0],
        [1.0, 1.0, 0.36],
      ),
    );
  }
  // Wide pink digging paws with ivory claws
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.145, 14, 10),
        makeStandard(0xf09eb0, 0.62, 0.02),
        [side * 0.37, 0.4, 0.22],
        [0.25, side * -0.25, side * -0.35],
        [1.15, 0.48, 1.28],
      ),
    );
    for (let c = -1; c <= 1; c++) {
      group.add(
        createMesh(
          new THREE.ConeGeometry(0.026, 0.11, 8),
          makeStandard(0xf0e4cf, 0.45, 0.08),
          [side * (0.4 + c * 0.045), 0.37, 0.36],
          [Math.PI * 0.48, 0, 0],
        ),
      );
    }
    // Stubby hind feet
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.125, 12, 10),
        makeStandard(0xe691a4, 0.65, 0.02),
        [side * 0.2, 0.08, 0.06],
        undefined,
        [1.0, 0.62, 1.32],
      ),
    );
  }
  buildTeamCollar(group, teamColor, 0.61, 0.26, 0.06);
}

function buildNorwayRatBody(group: THREE.Group, teamColor: string): void {
  // Agile russet-brown torso
  group.add(
    createMesh(
      new THREE.CapsuleGeometry(0.24, 0.28, 10, 16),
      makeStandard(0x8d5736, 0.76, 0.03),
      [0, 0.46, -0.02],
      [0.18, 0, 0],
    ),
  );
  // Warm cream belly
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.2, 14, 10),
      makeStandard(0xdcc6a8, 0.82, 0.02),
      [0, 0.42, 0.12],
      undefined,
      [0.88, 1.05, 0.62],
    ),
  );
  // Energetic rounded head + tapered snout
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      makeStandard(0x965e3b, 0.74, 0.03),
      [0, 0.78, 0.12],
      undefined,
      [0.98, 0.9, 1.12],
    ),
  );
  group.add(
    createMesh(
      new THREE.ConeGeometry(0.11, 0.26, 14),
      makeStandard(0xa36945, 0.74, 0.03),
      [0, 0.75, 0.36],
      [Math.PI * 0.52, 0, 0],
    ),
  );
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.036, 10, 8),
      makeStandard(0xea8ca0, 0.45, 0.02),
      [0, 0.75, 0.49],
    ),
  );
  // Tiny ivory buck teeth
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.CapsuleGeometry(0.015, 0.032, 6, 8),
        makeStandard(0xfffaf0, 0.3, 0.05),
        [side * 0.022, 0.68, 0.41],
        [0.15, 0, 0],
      ),
    );
  }
  addEyes(group, 0.11, 0.83, 0.29, 0.046);
  // Big rounded ears with pink inner cups
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.125, 14, 12),
        makeStandard(0x885232, 0.75, 0.02),
        [side * 0.19, 0.96, 0.06],
        [0.1, side * 0.28, side * -0.22],
        [1.0, 1.05, 0.36],
      ),
    );
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.09, 12, 10),
        makeStandard(0xf0a3b2, 0.65, 0.02),
        [side * 0.19, 0.96, 0.09],
        [0.1, side * 0.28, side * -0.22],
        [1.0, 1.05, 0.3],
      ),
    );
  }
  // Long curved smooth pink tail via TubeGeometry
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.24, -0.22),
    new THREE.Vector3(0.05, 0.18, -0.52),
    new THREE.Vector3(0.16, 0.28, -0.76),
    new THREE.Vector3(0.12, 0.46, -0.9),
  ]);
  group.add(
    createMesh(
      new THREE.TubeGeometry(tailCurve, 16, 0.032, 8, false),
      makeStandard(0xe697a8, 0.58, 0.02),
    ),
  );
  // Nimble limbs & feet
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.CapsuleGeometry(0.055, 0.14, 8, 10),
        makeStandard(0x855031, 0.76, 0.02),
        [side * 0.25, 0.45, 0.14],
        [0.55, 0, side * -0.25],
      ),
    );
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.095, 10, 8),
        makeStandard(0xe89cac, 0.62, 0.02),
        [side * 0.15, 0.07, 0.08],
        undefined,
        [0.85, 0.6, 1.4],
      ),
    );
  }
  buildTeamCollar(group, teamColor, 0.64, 0.2, 0.06);
}

function buildBadgerBody(group: THREE.Group, teamColor: string): void {
  // Broad-shouldered dark slate torso
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.39, 18, 14),
      makeStandard(0x3b3e46, 0.82, 0.04),
      [0, 0.44, -0.02],
      undefined,
      [1.14, 0.92, 1.12],
    ),
  );
  // Broad sturdy head
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.28, 16, 14),
      makeStandard(0x282b33, 0.8, 0.04),
      [0, 0.74, 0.12],
      undefined,
      [1.06, 0.9, 1.16],
    ),
  );
  // Iconic bold white head-to-back stripe
  group.add(
    createMesh(
      new THREE.CapsuleGeometry(0.082, 0.42, 8, 12),
      makeStandard(0xf4f6f8, 0.76, 0.02),
      [0, 0.85, 0.02],
      [Math.PI * 0.34, 0, 0],
    ),
  );
  group.add(
    createMesh(
      new THREE.CapsuleGeometry(0.095, 0.38, 8, 12),
      makeStandard(0xf0f2f5, 0.78, 0.02),
      [0, 0.62, -0.28],
      [-0.36, 0, 0],
    ),
  );
  // White cheek bands
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.11, 12, 10),
        makeStandard(0xf2f4f7, 0.78, 0.02),
        [side * 0.21, 0.71, 0.18],
        undefined,
        [0.65, 0.72, 1.1],
      ),
    );
  }
  // Tapered muzzle + shiny black nose
  group.add(
    createMesh(
      new THREE.ConeGeometry(0.12, 0.22, 14),
      makeStandard(0xf2f4f7, 0.75, 0.02),
      [0, 0.7, 0.4],
      [Math.PI * 0.5, 0, 0],
    ),
  );
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.048, 10, 8),
      makeStandard(0x16171c, 0.25, 0.08),
      [0, 0.71, 0.5],
    ),
  );
  addEyes(group, 0.125, 0.79, 0.34, 0.045);
  // Rounded ears with white rims
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.085, 12, 10),
        makeStandard(0x282b33, 0.8, 0.03),
        [side * 0.22, 0.94, 0.08],
        undefined,
        [0.9, 0.95, 0.45],
      ),
    );
    group.add(
      createMesh(
        new THREE.TorusGeometry(0.072, 0.018, 8, 14),
        makeStandard(0xf4f6f8, 0.75, 0.02),
        [side * 0.22, 0.94, 0.09],
      ),
    );
  }
  // Heavy stout paws & feet
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.CapsuleGeometry(0.1, 0.16, 8, 12),
        makeStandard(0x272a31, 0.8, 0.04),
        [side * 0.39, 0.42, 0.18],
        [0.45, 0, side * -0.3],
      ),
    );
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.135, 12, 10),
        makeStandard(0x25282f, 0.82, 0.04),
        [side * 0.22, 0.09, 0.06],
        undefined,
        [1.02, 0.65, 1.3],
      ),
    );
  }
  buildTeamCollar(group, teamColor, 0.61, 0.29, 0.08);
}

function buildGliderSquirrelBody(group: THREE.Group, teamColor: string): void {
  // Cinnamon rounded body + cream belly
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.3, 16, 14),
      makeStandard(0xc86a32, 0.74, 0.03),
      [0, 0.44, 0],
      undefined,
      [0.96, 1.08, 0.96],
    ),
  );
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.22, 14, 10),
      makeStandard(0xf5e5cc, 0.8, 0.02),
      [0, 0.42, 0.15],
      undefined,
      [0.92, 1.0, 0.65],
    ),
  );
  // Subtle folded glider flank ribbons
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.16, 12, 10),
        makeStandard(0xe6ba8a, 0.72, 0.02),
        [side * 0.29, 0.45, 0.02],
        [0, 0, side * 0.18],
        [0.32, 1.25, 0.9],
      ),
    );
  }
  // Expressive head + bright eyes
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.23, 16, 14),
      makeStandard(0xd47338, 0.72, 0.03),
      [0, 0.78, 0.08],
      undefined,
      [1.02, 0.94, 1.04],
    ),
  );
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.034, 10, 8),
      makeStandard(0x3a241b, 0.3, 0.05),
      [0, 0.76, 0.32],
    ),
  );
  addEyes(group, 0.11, 0.82, 0.25, 0.052);
  // Alert tufted ears
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.ConeGeometry(0.078, 0.2, 12),
        makeStandard(0xc2612b, 0.72, 0.02),
        [side * 0.15, 1.0, 0.06],
        [0.06, 0, side * -0.18],
      ),
    );
    group.add(
      createMesh(
        new THREE.ConeGeometry(0.044, 0.12, 10),
        makeStandard(0xf6dec1, 0.74, 0.02),
        [side * 0.15, 0.99, 0.09],
        [0.06, 0, side * -0.18],
      ),
    );
  }
  // Large fluffy curled bushy tail (graduated SphereGeometry chain)
  const tailPuffs: ReadonlyArray<{
    pos: readonly [number, number, number];
    r: number;
    color: number;
  }> = [
    { pos: [0, 0.3, -0.28], r: 0.13, color: 0xb85a26 },
    { pos: [0, 0.44, -0.44], r: 0.17, color: 0xc96930 },
    { pos: [0, 0.66, -0.52], r: 0.2, color: 0xd8793e },
    { pos: [0, 0.9, -0.48], r: 0.21, color: 0xe38a4e },
    { pos: [0, 1.06, -0.34], r: 0.16, color: 0xf4dfc2 },
  ];
  for (const puff of tailPuffs) {
    group.add(
      createMesh(
        new THREE.SphereGeometry(puff.r, 14, 12),
        makeStandard(puff.color, 0.84, 0.02),
        puff.pos,
      ),
    );
  }
  // Agile paws & feet
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.CapsuleGeometry(0.055, 0.13, 8, 10),
        makeStandard(0xc86a32, 0.74, 0.02),
        [side * 0.24, 0.48, 0.16],
        [0.6, 0, side * -0.25],
      ),
    );
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.1, 10, 8),
        makeStandard(0xb85b28, 0.74, 0.02),
        [side * 0.16, 0.07, 0.07],
        undefined,
        [0.9, 0.6, 1.35],
      ),
    );
  }
  buildTeamCollar(group, teamColor, 0.63, 0.21, 0.06);
}

function buildHedgehogBody(group: THREE.Group, teamColor: string): void {
  // Plump warm-brown rounded body
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.36, 18, 14),
      makeStandard(0x7c563a, 0.82, 0.03),
      [0, 0.44, -0.04],
      undefined,
      [1.04, 0.96, 1.08],
    ),
  );
  // Soft sandy-cream face & tummy
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.26, 16, 12),
      makeStandard(0xe6cca8, 0.82, 0.02),
      [0, 0.58, 0.16],
      undefined,
      [0.96, 0.92, 0.96],
    ),
  );
  // Cute snout + button nose
  group.add(
    createMesh(
      new THREE.ConeGeometry(0.11, 0.24, 14),
      makeStandard(0xe6cca8, 0.78, 0.02),
      [0, 0.64, 0.4],
      [Math.PI * 0.5, 0, 0],
    ),
  );
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.04, 10, 8),
      makeStandard(0x1f1916, 0.22, 0.08),
      [0, 0.64, 0.52],
    ),
  );
  addEyes(group, 0.12, 0.71, 0.34, 0.046);
  // Small round ears
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.072, 10, 8),
        makeStandard(0xd6b58f, 0.8, 0.02),
        [side * 0.21, 0.8, 0.18],
        undefined,
        [0.9, 1.0, 0.45],
      ),
    );
  }
  // Fanned conical quill cluster across crown & back
  const quillRings: ReadonlyArray<{
    elevation: number;
    count: number;
    length: number;
  }> = [
    { elevation: 0.35, count: 7, length: 0.24 },
    { elevation: 0.85, count: 9, length: 0.28 },
    { elevation: 1.35, count: 7, length: 0.24 },
  ];
  for (const ring of quillRings) {
    for (let i = 0; i < ring.count; i++) {
      const frac = ring.count > 1 ? i / (ring.count - 1) - 0.5 : 0;
      const azimuth = frac * 2.1;
      const dir = new THREE.Vector3(
        Math.sin(azimuth) * Math.sin(ring.elevation),
        Math.cos(ring.elevation),
        -Math.cos(azimuth) * Math.sin(ring.elevation) - 0.28,
      ).normalize();
      const basePos = new THREE.Vector3(0, 0.52, -0.06).addScaledVector(dir, 0.34);
      const quill = new THREE.Mesh(
        new THREE.ConeGeometry(0.048, ring.length, 8),
        makeStandard(i % 2 === 0 ? 0x5c3e2a : 0x745036, 0.72, 0.05),
      );
      quill.position.copy(basePos);
      quill.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      quill.castShadow = true;
      quill.receiveShadow = true;
      group.add(quill);
    }
  }
  // Rounded paws & feet
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.088, 10, 8),
        makeStandard(0xd8b691, 0.78, 0.02),
        [side * 0.28, 0.38, 0.22],
      ),
    );
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.11, 10, 8),
        makeStandard(0xc9a47e, 0.78, 0.02),
        [side * 0.18, 0.07, 0.08],
        undefined,
        [0.95, 0.62, 1.3],
      ),
    );
  }
  buildTeamCollar(group, teamColor, 0.5, 0.29, 0.1);
}

function buildArmadilloBody(group: THREE.Group, teamColor: string): void {
  // Warm underbody
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.32, 16, 12),
      makeStandard(0xd6aa82, 0.78, 0.04),
      [0, 0.4, 0],
      undefined,
      [1.04, 0.88, 1.12],
    ),
  );
  // Banded curved sandstone-terracotta carapace plates
  const plateOffsets = [-0.22, -0.08, 0.06, 0.2];
  for (let i = 0; i < plateOffsets.length; i++) {
    const zOff = plateOffsets[i] ?? 0;
    const bandRadius = 0.33 - Math.abs(zOff) * 0.28;
    const plate = createMesh(
      new THREE.TorusGeometry(bandRadius, 0.085, 10, 20, Math.PI * 1.15),
      makeStandard(i % 2 === 0 ? 0xc47247 : 0xd68958, 0.54, 0.16),
      [0, 0.46, zOff],
      [0, 0, -Math.PI * 0.075],
    );
    group.add(plate);
  }
  // Armored head shield + rounded snout
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.22, 14, 12),
      makeStandard(0xc9784b, 0.52, 0.14),
      [0, 0.68, 0.22],
      undefined,
      [0.95, 0.85, 1.14],
    ),
  );
  group.add(
    createMesh(
      new THREE.ConeGeometry(0.098, 0.28, 12),
      makeStandard(0xd8ae86, 0.68, 0.04),
      [0, 0.64, 0.46],
      [Math.PI * 0.52, 0, 0],
    ),
  );
  group.add(
    createMesh(
      new THREE.SphereGeometry(0.036, 10, 8),
      makeStandard(0x523426, 0.4, 0.06),
      [0, 0.64, 0.6],
    ),
  );
  addEyes(group, 0.11, 0.72, 0.37, 0.042);
  // Pointed alert ears
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.ConeGeometry(0.062, 0.2, 10),
        makeStandard(0xc47348, 0.6, 0.1),
        [side * 0.14, 0.89, 0.18],
        [-0.12, 0, side * -0.22],
      ),
    );
  }
  // Segmented armored tail
  for (let i = 0; i < 4; i++) {
    const r = 0.088 - i * 0.016;
    group.add(
      createMesh(
        new THREE.SphereGeometry(r, 10, 8),
        makeStandard(i % 2 === 0 ? 0xb8663d : 0xd28556, 0.55, 0.14),
        [0, 0.24 - i * 0.025, -0.34 - i * 0.13],
        undefined,
        [1.0, 0.9, 1.2],
      ),
    );
  }
  // Sturdy digging paws & feet
  for (const side of [-1, 1] as const) {
    group.add(
      createMesh(
        new THREE.CapsuleGeometry(0.072, 0.12, 8, 10),
        makeStandard(0xb66a42, 0.62, 0.1),
        [side * 0.31, 0.36, 0.22],
        [0.4, 0, side * -0.25],
      ),
    );
    group.add(
      createMesh(
        new THREE.SphereGeometry(0.115, 10, 8),
        makeStandard(0xa9603b, 0.65, 0.1),
        [side * 0.19, 0.08, 0.06],
        undefined,
        [0.95, 0.65, 1.32],
      ),
    );
  }
  buildTeamCollar(group, teamColor, 0.56, 0.25, 0.16);
}

function buildSpeciesGeometry(
  species: SpeciesId,
  teamColor: string,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `species_${species}`;

  switch (species) {
    case "mole":
      buildMoleBody(group, teamColor);
      break;
    case "norway_rat":
      buildNorwayRatBody(group, teamColor);
      break;
    case "badger":
      buildBadgerBody(group, teamColor);
      break;
    case "glider_squirrel":
      buildGliderSquirrelBody(group, teamColor);
      break;
    case "hedgehog":
      buildHedgehogBody(group, teamColor);
      break;
    case "armadillo":
      buildArmadilloBody(group, teamColor);
      break;
  }

  return group;
}

function buildMutationMesh(mutationId: MutationId): THREE.Group {
  const group = new THREE.Group();
  group.name = `mutation_${mutationId}`;

  switch (mutationId) {
    case "glider_wings": {
      // Glowing translucent aqua curved wing panels + brass harness struts
      group.add(
        createMesh(
          new THREE.CapsuleGeometry(0.08, 0.16, 8, 12),
          makeStandard(0x465260, 0.42, 0.65),
          [0, 0, 0],
        ),
      );
      for (const side of [-1, 1] as const) {
        group.add(
          createMesh(
            new THREE.CylinderGeometry(0.022, 0.028, 0.62, 10),
            makeStandard(0xc99c42, 0.3, 0.78),
            [side * 0.34, 0.14, -0.05],
            [0.14, 0, side * -1.16],
          ),
        );
        group.add(
          createMesh(
            new THREE.SphereGeometry(0.32, 16, 12),
            makeStandard(0x38f0e8, 0.22, 0.12, {
              emissive: 0x10a8b8,
              emissiveIntensity: 0.55,
              transparent: true,
              opacity: 0.76,
              side: THREE.DoubleSide,
            }),
            [side * 0.42, 0.06, -0.08],
            [0.2, side * 0.24, side * -0.32],
            [1.45, 0.55, 0.12],
          ),
        );
      }
      break;
    }

    case "bramble_shell": {
      // Domed green-brown armored pack studded with protruding spikes
      group.add(
        createMesh(
          new THREE.SphereGeometry(
            0.34,
            16,
            12,
            0,
            Math.PI * 2,
            0,
            Math.PI * 0.62,
          ),
          makeStandard(0x486e36, 0.72, 0.12),
          [0, -0.02, -0.04],
          [-Math.PI * 0.5, 0, 0],
        ),
      );
      group.add(
        createMesh(
          new THREE.TorusGeometry(0.31, 0.045, 8, 18),
          makeStandard(0x6b4b2f, 0.78, 0.08),
          [0, -0.02, -0.04],
        ),
      );
      const spikePositions: ReadonlyArray<readonly [number, number, number]> = [
        [0, 0.08, -0.34],
        [-0.2, 0.16, -0.26],
        [0.2, 0.16, -0.26],
        [-0.22, -0.1, -0.24],
        [0.22, -0.1, -0.24],
        [0, -0.18, -0.28],
      ];
      for (const sp of spikePositions) {
        const dir = new THREE.Vector3(sp[0], sp[1], sp[2]).normalize();
        const spike = new THREE.Mesh(
          new THREE.ConeGeometry(0.052, 0.22, 8),
          makeStandard(0xb8a374, 0.5, 0.14),
        );
        spike.position.set(sp[0], sp[1], sp[2]);
        spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        spike.castShadow = true;
        group.add(spike);
      }
      break;
    }

    case "spring_paws": {
      // Metallic helical coiled spring boots on left & right legs
      for (const side of [-1, 1] as const) {
        for (let coil = 0; coil < 3; coil++) {
          group.add(
            createMesh(
              new THREE.TorusGeometry(0.09, 0.02, 8, 16),
              makeStandard(0xd6dee8, 0.25, 0.85),
              [side * 0.19, -0.04 + coil * 0.055, 0.04],
              [Math.PI * 0.5, 0, 0],
            ),
          );
        }
        group.add(
          createMesh(
            new THREE.CylinderGeometry(0.11, 0.125, 0.045, 14),
            makeStandard(0xf59e0b, 0.42, 0.35),
            [side * 0.19, -0.085, 0.04],
          ),
        );
      }
      break;
    }

    case "anchor_talons": {
      // Heavy metallic anchor claws gripping the terrain
      for (const side of [-1, 1] as const) {
        group.add(
          createMesh(
            new THREE.CylinderGeometry(0.11, 0.12, 0.12, 12),
            makeStandard(0x3a434e, 0.36, 0.82),
            [side * 0.2, -0.02, 0.04],
          ),
        );
        for (let c = -1; c <= 1; c++) {
          group.add(
            createMesh(
              new THREE.ConeGeometry(0.036, 0.18, 8),
              makeStandard(0x637282, 0.3, 0.86),
              [side * 0.2 + c * 0.055, -0.06, 0.15],
              [Math.PI * 0.65, c * 0.22, 0],
            ),
          );
        }
      }
      break;
    }

    case "twin_pod": {
      // Curved dual-barrel glowing cyan shoulder mortar pod
      group.add(
        createMesh(
          new THREE.CapsuleGeometry(0.055, 0.54, 8, 12),
          makeStandard(0x3b4858, 0.38, 0.72),
          [0, 0.12, -0.08],
          [0, 0, Math.PI * 0.5],
        ),
      );
      for (const side of [-1, 1] as const) {
        group.add(
          createMesh(
            new THREE.CylinderGeometry(0.072, 0.088, 0.34, 14),
            makeStandard(0x2e3b4c, 0.34, 0.78),
            [side * 0.34, 0.24, 0.04],
            [Math.PI * 0.34, 0, 0],
          ),
        );
        group.add(
          createMesh(
            new THREE.TorusGeometry(0.076, 0.02, 8, 16),
            makeStandard(0x38f0ff, 0.2, 0.2, {
              emissive: 0x00d8ff,
              emissiveIntensity: 0.9,
            }),
            [side * 0.34, 0.32, 0.18],
            [-0.45, 0, 0],
          ),
        );
      }
      break;
    }

    case "burrow_claws": {
      // Oversized brass/steel triple-claw drill gauntlets
      for (const side of [-1, 1] as const) {
        group.add(
          createMesh(
            new THREE.CylinderGeometry(0.105, 0.12, 0.2, 12),
            makeStandard(0xc48b36, 0.32, 0.8),
            [side * 0.42, -0.06, 0.2],
            [Math.PI * 0.44, 0, side * -0.2],
          ),
        );
        for (let c = -1; c <= 1; c++) {
          group.add(
            createMesh(
              new THREE.ConeGeometry(0.036, 0.24, 8),
              makeStandard(0xd8e0e8, 0.24, 0.88),
              [side * 0.44 + c * 0.048, -0.09, 0.38],
              [Math.PI * 0.46, c * 0.14, 0],
            ),
          );
        }
      }
      break;
    }

    case "optic_visor": {
      // Glowing translucent cyan holographic eye-visor + ear mounts
      group.add(
        createMesh(
          new THREE.CylinderGeometry(
            0.25,
            0.25,
            0.12,
            20,
            1,
            true,
            -Math.PI * 0.42,
            Math.PI * 0.84,
          ),
          makeStandard(0x38f5ff, 0.14, 0.15, {
            emissive: 0x16d2f0,
            emissiveIntensity: 0.85,
            transparent: true,
            opacity: 0.72,
            side: THREE.DoubleSide,
          }),
          [0, -0.02, -0.04],
        ),
      );
      for (const side of [-1, 1] as const) {
        group.add(
          createMesh(
            new THREE.CylinderGeometry(0.045, 0.045, 0.05, 10),
            makeStandard(0xc9963b, 0.3, 0.82),
            [side * 0.24, -0.02, -0.02],
            [0, 0, Math.PI * 0.5],
          ),
        );
      }
      break;
    }

    case "aegis_crest": {
      // Glowing crystalline forehead crest + faint translucent prism bubble
      group.add(
        createMesh(
          new THREE.OctahedronGeometry(0.11, 0),
          makeStandard(0x63f5ff, 0.15, 0.25, {
            emissive: 0x26d8f8,
            emissiveIntensity: 0.9,
          }),
          [0, 0.14, 0.06],
          [0, Math.PI * 0.25, 0],
          [0.75, 1.35, 0.75],
        ),
      );
      for (const side of [-1, 1] as const) {
        group.add(
          createMesh(
            new THREE.ConeGeometry(0.042, 0.16, 6),
            makeStandard(0xffe073, 0.25, 0.65, {
              emissive: 0xd89f28,
              emissiveIntensity: 0.35,
            }),
            [side * 0.12, 0.1, 0.02],
            [0, 0, side * -0.45],
          ),
        );
      }
      const bubble = createMesh(
        new THREE.IcosahedronGeometry(0.68, 2),
        makeStandard(0x6ef7ff, 0.1, 0.1, {
          emissive: 0x22c8e8,
          emissiveIntensity: 0.35,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
        }),
        [0, -0.34, -0.18],
      );
      bubble.castShadow = false;
      bubble.receiveShadow = false;
      group.add(bubble);
      break;
    }
  }

  return group;
}

function buildApexVisual(apex: ApexId): THREE.Group {
  const color = APEX_COLORS[apex];
  const group = new THREE.Group();
  group.name = `apex_${apex}`;

  const halo = createMesh(
    new THREE.TorusGeometry(0.32, 0.022, 10, 28),
    makeStandard(color, 0.2, 0.3, {
      emissive: color,
      emissiveIntensity: 0.95,
      transparent: true,
      opacity: 0.86,
    }),
    [0, 1.24, 0],
    [Math.PI * 0.5, 0, 0],
  );
  halo.castShadow = false;
  group.add(halo);

  for (let i = 0; i < 3; i++) {
    const angle = (i * Math.PI * 2) / 3;
    const pip = createMesh(
      new THREE.OctahedronGeometry(0.045, 0),
      makeStandard(color, 0.15, 0.3, {
        emissive: color,
        emissiveIntensity: 1.0,
      }),
      [Math.cos(angle) * 0.42, 1.24, Math.sin(angle) * 0.42],
    );
    pip.castShadow = false;
    group.add(pip);
  }

  return group;
}

interface AnchorLayout {
  back: readonly [number, number, number];
  legs: readonly [number, number, number];
  offense: readonly [number, number, number];
  crest: readonly [number, number, number];
  hpSpriteY: number;
  apexOffsetY: number;
  aimY: number;
  aimZ: number;
  ringScale: number;
}

const GLB_ANCHOR_LAYOUTS: Record<SpeciesId, AnchorLayout> = {
  mole: {
    back: [0, 0.72, -0.34],
    legs: [0, 0.14, 0.02],
    offense: [0, 0.68, 0.14],
    crest: [0, 1.06, 0.24],
    hpSpriteY: 1.82,
    apexOffsetY: 0.22,
    aimY: 0.68,
    aimZ: 0.44,
    ringScale: 1.24,
  },
  norway_rat: {
    back: [0, 0.78, -0.3],
    legs: [0, 0.14, 0.02],
    offense: [0, 0.72, 0.14],
    crest: [0, 1.14, 0.24],
    hpSpriteY: 1.92,
    apexOffsetY: 0.3,
    aimY: 0.74,
    aimZ: 0.44,
    ringScale: 1.18,
  },
  badger: {
    back: [0, 0.82, -0.28],
    legs: [0, 0.14, 0.02],
    offense: [0, 0.78, 0.12],
    crest: [0, 1.2, 0.2],
    hpSpriteY: 1.98,
    apexOffsetY: 0.34,
    aimY: 0.78,
    aimZ: 0.36,
    ringScale: 1.32,
  },
  glider_squirrel: {
    back: [0, 0.74, -0.32],
    legs: [0, 0.14, 0.02],
    offense: [0, 0.68, 0.14],
    crest: [0, 1.08, 0.22],
    hpSpriteY: 1.86,
    apexOffsetY: 0.24,
    aimY: 0.7,
    aimZ: 0.44,
    ringScale: 1.18,
  },
  hedgehog: {
    back: [0, 0.56, -0.32],
    legs: [0, 0.14, 0.0],
    offense: [0, 0.54, 0.1],
    crest: [0, 0.86, 0.2],
    hpSpriteY: 1.56,
    apexOffsetY: 0,
    aimY: 0.54,
    aimZ: 0.38,
    ringScale: 1.0,
  },
  armadillo: {
    back: [0, 0.56, -0.32],
    legs: [0, 0.14, 0.0],
    offense: [0, 0.54, 0.1],
    crest: [0, 0.86, 0.2],
    hpSpriteY: 1.56,
    apexOffsetY: 0,
    aimY: 0.54,
    aimZ: 0.4,
    ringScale: 1.0,
  },
};

function buildAimIndicator(teamColor: string): THREE.Group {
  const group = new THREE.Group();
  group.name = "aim_indicator";

  const barrelMat = makeStandard(0x283546, 0.35, 0.72);
  const barrel = createMesh(
    new THREE.CylinderGeometry(0.036, 0.052, 0.44, 12),
    barrelMat,
    [0.24, 0, 0.22],
    [Math.PI * 0.5, 0, 0],
  );
  barrel.castShadow = false;

  const glowMat = makeStandard(0x4df4ff, 0.18, 0.15, {
    emissive: 0x38f5ff,
    emissiveIntensity: 1.2,
    transparent: true,
    opacity: 0.92,
  });
  const muzzleRing = createMesh(
    new THREE.TorusGeometry(0.056, 0.015, 8, 18),
    glowMat,
    [0.24, 0, 0.44],
  );
  muzzleRing.castShadow = false;

  const laserTip = createMesh(
    new THREE.ConeGeometry(0.038, 0.14, 10),
    makeStandard(teamColor, 0.2, 0.2, {
      emissive: teamColor,
      emissiveIntensity: 0.95,
      transparent: true,
      opacity: 0.88,
    }),
    [0.24, 0, 0.55],
    [Math.PI * 0.5, 0, 0],
  );
  laserTip.castShadow = false;

  group.add(barrel, muzzleRing, laserTip);
  group.visible = false;
  return group;
}

/**
 * Smooth 3D character rig for Critter Siege with automatic Hunyuan3D GLB hero model
 * loading, procedural fallback, 4 calibrated hardpoint anchors, active aiming barrel,
 * squash-stretch animation, clean GPU disposal, and floating HP bar sprite.
 */
export class CritterRig {
  public readonly root: THREE.Group;
  public readonly anchors: HardpointAnchors;
  public readonly species: SpeciesId;

  private readonly bodyGroup: THREE.Group;
  private readonly apexGroup: THREE.Group;
  private readonly aimIndicator: THREE.Group;
  private readonly selectionRing: THREE.Mesh;
  private readonly teamColor: string;
  private readonly label: string;

  private proceduralBody: THREE.Group | null;
  private customModel: THREE.Object3D | null = null;
  private readonly currentEquipped: Map<HardpointSlot, MutationId> = new Map();
  private currentApex: ApexId | null = null;

  private hpCanvas: HTMLCanvasElement | null = null;
  private hpTexture: THREE.CanvasTexture | null = null;
  private hpSprite: THREE.Sprite | null = null;
  private currentHp = 100;
  private currentMaxHp = 100;
  private lastHp = 100;
  private lastMaxHp = 100;
  private animTime = 0;
  private baseRingScale = 1.0;
  private disposed = false;

  public constructor(
    species: SpeciesId,
    teamColor: string,
    label: string,
    autoLoadGlb = true,
  ) {
    this.species = species;
    this.teamColor = teamColor;
    this.label = label;

    this.root = new THREE.Group();
    this.root.name = `critter_${species}_${label}`;

    this.bodyGroup = new THREE.Group();
    this.bodyGroup.name = "body_group";
    this.root.add(this.bodyGroup);

    this.proceduralBody = buildSpeciesGeometry(species, teamColor);
    this.bodyGroup.add(this.proceduralBody);

    this.anchors = {
      back: this.createAnchor("hardpoint_back", 0, 0.56, -0.32),
      legs: this.createAnchor("hardpoint_legs", 0, 0.14, 0.0),
      offense: this.createAnchor("hardpoint_offense", 0, 0.54, 0.1),
      crest: this.createAnchor("hardpoint_crest", 0, 0.86, 0.2),
    };

    this.apexGroup = new THREE.Group();
    this.apexGroup.name = "apex_aura";
    this.bodyGroup.add(this.apexGroup);

    this.aimIndicator = buildAimIndicator(teamColor);
    this.aimIndicator.position.set(0, 0.54, 0.24);
    this.bodyGroup.add(this.aimIndicator);

    const ringGeo = new THREE.TorusGeometry(0.56, 0.036, 10, 28);
    const ringMat = makeStandard(teamColor, 0.25, 0.2, {
      emissive: teamColor,
      emissiveIntensity: 0.85,
      transparent: true,
      opacity: 0.85,
    });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.name = "selection_ring";
    this.selectionRing.rotation.x = Math.PI * 0.5;
    this.selectionRing.position.y = 0.04;
    this.selectionRing.visible = false;
    this.root.add(this.selectionRing);

    this.initHpBarSprite();

    if (autoLoadGlb) {
      void this.tryLoadCustomModel();
    }
  }

  /** Return true when a custom sculpted GLB hero model is currently attached. */
  public isUsingCustomModel(): boolean {
    return this.customModel !== null;
  }

  /**
   * Drop in a custom external 3D model (e.g. a Blender/Hunyuan3D GLB) while keeping
   * the 4 physical hardpoint anchors calibrated, animations, and HP bar intact.
   */
  public attachCustomModel(model: THREE.Object3D): void {
    if (this.disposed) {
      if (model.userData.isCachedGlbClone !== true) {
        disposeObjectTree(model);
      }
      return;
    }

    if (this.proceduralBody) {
      this.bodyGroup.remove(this.proceduralBody);
      disposeObjectTree(this.proceduralBody);
      this.proceduralBody = null;
    }
    if (this.customModel) {
      this.bodyGroup.remove(this.customModel);
      if (this.customModel.userData.isCachedGlbClone !== true) {
        disposeObjectTree(this.customModel);
      }
      this.customModel = null;
    }

    model.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    this.customModel = model;
    this.bodyGroup.add(model);

    // Calibrate hardpoint anchors, aiming barrel, Apex halo, and HP bar to GLB proportions
    const layout = GLB_ANCHOR_LAYOUTS[this.species];
    this.anchors.back.position.set(
      layout.back[0],
      layout.back[1],
      layout.back[2],
    );
    this.anchors.legs.position.set(
      layout.legs[0],
      layout.legs[1],
      layout.legs[2],
    );
    this.anchors.offense.position.set(
      layout.offense[0],
      layout.offense[1],
      layout.offense[2],
    );
    this.anchors.crest.position.set(
      layout.crest[0],
      layout.crest[1],
      layout.crest[2],
    );
    this.apexGroup.position.y = layout.apexOffsetY;
    this.aimIndicator.position.set(0, layout.aimY, layout.aimZ);
    this.baseRingScale = layout.ringScale;
    if (this.hpSprite) {
      this.hpSprite.position.y = layout.hpSpriteY;
    }
  }

  /**
   * Equip or swap hardpoint mutations and Apex synergy aura with strict GPU disposal
   * of replaced geometries/materials so zero leaked meshes accumulate.
   */
  public applyMutations(
    equipped: Partial<Record<HardpointSlot, MutationId>>,
    apex: ApexId | null,
  ): void {
    for (const slot of HARDPOINT_SLOTS) {
      const nextMutation = equipped[slot];
      const prevMutation = this.currentEquipped.get(slot);
      const anchor = this.anchors[slot];

      if (nextMutation === prevMutation) {
        continue;
      }

      this.clearGroupChildren(anchor);

      if (nextMutation !== undefined) {
        const attachment = buildMutationMesh(nextMutation);
        anchor.add(attachment);
        this.currentEquipped.set(slot, nextMutation);
      } else {
        this.currentEquipped.delete(slot);
      }
    }

    if (apex !== this.currentApex) {
      this.clearGroupChildren(this.apexGroup);
      if (apex !== null) {
        this.apexGroup.add(buildApexVisual(apex));
      }
      this.currentApex = apex;
    }
  }

  /** Update displayed HP bar ratio and alive visibility state. */
  public setHp(hp: number, maxHp: number, alive: boolean): void {
    const nextHp = Math.max(0, hp);
    const nextMaxHp = Math.max(1, maxHp);
    this.root.visible = alive;
    if (nextHp !== this.lastHp || nextMaxHp !== this.lastMaxHp) {
      this.currentHp = nextHp;
      this.currentMaxHp = nextMaxHp;
      this.lastHp = nextHp;
      this.lastMaxHp = nextMaxHp;
      this.redrawHpBar();
    }
  }

  /** Advance idle breathing, lively hop & squash-stretch, aiming barrel pitch, and active ring pulse. */
  public updateAnimation(
    dtSec: number,
    moving: boolean,
    velocityY: number,
    isActive: boolean,
    aimPitch = 0,
  ): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    this.animTime += safeDt;

    const bobSpeed = moving ? 12.5 : 3.2;
    const bobAmp = moving ? 0.085 : 0.022;
    const bobWave = Math.sin(this.animTime * bobSpeed);
    const bobY = Math.max(0, bobWave) * bobAmp;
    this.bodyGroup.position.y = bobY;

    const safeVy = Number.isFinite(velocityY) ? velocityY : 0;
    const airborneStretch = Math.max(-0.08, Math.min(0.11, safeVy * 0.015));
    const hopSquash = moving ? bobWave * 0.05 : Math.sin(this.animTime * 3.2) * 0.014;
    const scaleY = 1.0 + airborneStretch + hopSquash;
    const scaleXZ = 1.0 / Math.sqrt(Math.max(0.84, scaleY));
    const lerpK = Math.min(1, safeDt * 14);
    this.bodyGroup.scale.x += (scaleXZ - this.bodyGroup.scale.x) * lerpK;
    this.bodyGroup.scale.y += (scaleY - this.bodyGroup.scale.y) * lerpK;
    this.bodyGroup.scale.z += (scaleXZ - this.bodyGroup.scale.z) * lerpK;

    const targetPitch = Math.max(-0.26, Math.min(0.26, -safeVy * 0.036));
    const moveRoll = moving ? Math.sin(this.animTime * 12.5) * 0.085 : 0;
    this.bodyGroup.rotation.x += (targetPitch - this.bodyGroup.rotation.x) * Math.min(1, safeDt * 12);
    this.bodyGroup.rotation.z += (moveRoll - this.bodyGroup.rotation.z) * Math.min(1, safeDt * 12);

    if (this.apexGroup.children.length > 0) {
      this.apexGroup.rotation.y += safeDt * 1.4;
    }

    this.aimIndicator.visible = isActive;
    if (isActive) {
      const clampedAimPitch = Number.isFinite(aimPitch)
        ? Math.max(-0.85, Math.min(1.15, aimPitch))
        : 0;
      this.aimIndicator.rotation.x = -clampedAimPitch;
    }

    this.selectionRing.visible = isActive;
    if (isActive) {
      const pulse = this.baseRingScale * (1.0 + Math.sin(this.animTime * 5.0) * 0.09);
      this.selectionRing.scale.set(pulse, pulse, 1);
    }
  }

  /** Dispose all geometries, materials, and textures owned by this rig. */
  public dispose(): void {
    this.disposed = true;

    for (const slot of HARDPOINT_SLOTS) {
      this.clearGroupChildren(this.anchors[slot]);
    }
    this.currentEquipped.clear();

    this.clearGroupChildren(this.apexGroup);
    this.currentApex = null;

    this.bodyGroup.remove(this.aimIndicator);
    disposeObjectTree(this.aimIndicator);

    if (this.proceduralBody) {
      this.bodyGroup.remove(this.proceduralBody);
      disposeObjectTree(this.proceduralBody);
      this.proceduralBody = null;
    }
    if (this.customModel) {
      this.bodyGroup.remove(this.customModel);
      if (this.customModel.userData.isCachedGlbClone !== true) {
        disposeObjectTree(this.customModel);
      }
      this.customModel = null;
    }

    this.root.remove(this.selectionRing);
    this.selectionRing.geometry.dispose();
    disposeMaterial(this.selectionRing.material);

    if (this.hpSprite) {
      this.root.remove(this.hpSprite);
      this.hpSprite.geometry.dispose();
      disposeMaterial(this.hpSprite.material);
      this.hpSprite = null;
    }
    if (this.hpTexture) {
      this.hpTexture.dispose();
      this.hpTexture = null;
    }
    this.hpCanvas = null;
  }

  private async tryLoadCustomModel(): Promise<void> {
    const model = await loadCritterGlbModel(this.species);
    if (!model || this.disposed) {
      return;
    }
    this.attachCustomModel(model);
  }

  private createAnchor(
    name: string,
    x: number,
    y: number,
    z: number,
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    group.position.set(x, y, z);
    this.bodyGroup.add(group);
    return group;
  }

  private clearGroupChildren(group: THREE.Group): void {
    while (group.children.length > 0) {
      const child = group.children[group.children.length - 1];
      if (!child) {
        break;
      }
      group.remove(child);
      disposeObjectTree(child);
    }
  }

  private initHpBarSprite(): void {
    if (typeof document === "undefined") {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 72;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    this.hpCanvas = canvas;
    this.hpTexture = new THREE.CanvasTexture(canvas);
    this.hpTexture.colorSpace = THREE.SRGBColorSpace;
    const spriteMat = new THREE.SpriteMaterial({
      map: this.hpTexture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.name = "hp_bar_sprite";
    sprite.position.set(0, 1.56, 0);
    sprite.scale.set(1.55, 0.44, 1);
    this.hpSprite = sprite;
    this.root.add(sprite);
    this.redrawHpBar();
  }

  private redrawHpBar(): void {
    if (!this.hpCanvas || !this.hpTexture) {
      return;
    }
    const ctx = this.hpCanvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const w = this.hpCanvas.width;
    const h = this.hpCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // Rounded dark pill backing
    ctx.fillStyle = "rgba(15, 23, 38, 0.78)";
    ctx.beginPath();
    ctx.roundRect(8, 6, w - 16, h - 12, 14);
    ctx.fill();

    ctx.strokeStyle = this.teamColor;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Label text
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 20px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.label.slice(0, 14), w * 0.5, 24);

    // HP bar track & fill
    const ratio = Math.max(0, Math.min(1, this.currentHp / this.currentMaxHp));
    const barX = 24;
    const barY = 42;
    const barW = w - 48;
    const barH = 14;

    ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, 7);
    ctx.fill();

    const fillColor =
      ratio > 0.55 ? "#4ade80" : ratio > 0.25 ? "#fbbf24" : "#f87171";
    ctx.fillStyle = fillColor;
    if (ratio > 0) {
      ctx.beginPath();
      ctx.roundRect(barX, barY, Math.max(8, barW * ratio), barH, 7);
      ctx.fill();
    }

    this.hpTexture.needsUpdate = true;
  }
}
