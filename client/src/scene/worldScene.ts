import * as THREE from "three";

const ISLAND_CENTER = new THREE.Vector3(12, 5, 12);
const DEFAULT_WATER_LEVEL = 2.0;

interface CloudCluster {
  group: THREE.Group;
  speed: number;
  baseY: number;
  bobPhase: number;
}

const SKY_VERTEX_SHADER = `
varying vec3 vWorldDir;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldDir = normalize(position);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const SKY_FRAGMENT_SHADER = `
uniform vec3 uZenithColor;
uniform vec3 uMidSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uOceanBounceColor;
uniform vec3 uSunDir;
varying vec3 vWorldDir;

void main() {
  vec3 dir = normalize(vWorldDir);
  float h = dir.y;

  vec3 col;
  if (h >= 0.0) {
    float lowMix = smoothstep(0.0, 0.22, h);
    float highMix = smoothstep(0.18, 0.85, h);
    col = mix(uHorizonColor, uMidSkyColor, lowMix);
    col = mix(col, uZenithColor, highMix);
  } else {
    float belowMix = smoothstep(0.0, -0.35, h);
    col = mix(uHorizonColor, uOceanBounceColor, belowMix);
  }

  float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
  float sunHalo = pow(sunDot, 12.0) * 0.28;
  float sunCore = smoothstep(0.996, 0.9992, sunDot) * 0.9;
  col += vec3(1.0, 0.95, 0.82) * (sunHalo + sunCore);

  gl_FragColor = vec4(col, 1.0);
}
`;

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    for (const item of material) {
      item.dispose();
    }
    return;
  }
  material.dispose();
}

/**
 * Sunlit floating sky-island Three.js scene, lighting rig, sky-gradient dome,
 * drifting low-poly sculpted cloud clusters, and animated turquoise ocean + foam ring.
 */
export class WorldScene {
  public readonly scene: THREE.Scene;
  public readonly renderer: THREE.WebGLRenderer;

  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly fillLight: THREE.DirectionalLight;
  private readonly skyDome: THREE.Mesh;
  private readonly cloudsRoot: THREE.Group;
  private readonly clouds: CloudCluster[] = [];
  private readonly waterGroup: THREE.Group;
  private readonly oceanMesh: THREE.Mesh;
  private readonly oceanBaseX: Float32Array;
  private readonly oceanBaseY: Float32Array;
  private readonly innerFoamRing: THREE.Mesh;
  private readonly outerFoamRing: THREE.Mesh;
  private readonly appendedToContainer: boolean;

  private waterLevel = DEFAULT_WATER_LEVEL;

  public constructor(container: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xbfe8ff, 0.0052);

    const isCanvas =
      typeof HTMLCanvasElement !== "undefined" &&
      container instanceof HTMLCanvasElement;

    this.renderer = new THREE.WebGLRenderer({
      ...(isCanvas ? { canvas: container } : {}),
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(
      Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2),
    );

    const width = Math.max(1, container.clientWidth || 1280);
    const height = Math.max(1, container.clientHeight || 720);
    this.renderer.setSize(width, height, true);

    if (!isCanvas) {
      this.renderer.domElement.style.display = "block";
      this.renderer.domElement.style.width = "100%";
      this.renderer.domElement.style.height = "100%";
      container.appendChild(this.renderer.domElement);
      this.appendedToContainer = true;
    } else {
      this.appendedToContainer = false;
    }

    // Daylight hemisphere + warm sun directional light casting soft shadows across 24x14x24 island
    this.hemiLight = new THREE.HemisphereLight(0x9be2ff, 0x6f7c4a, 0.95);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff1d4, 2.05);
    this.sunLight.position.set(28, 30, 24);
    this.sunLight.target.position.copy(ISLAND_CENTER);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 2;
    this.sunLight.shadow.camera.far = 84;
    this.sunLight.shadow.camera.left = -18;
    this.sunLight.shadow.camera.right = 18;
    this.sunLight.shadow.camera.top = 18;
    this.sunLight.shadow.camera.bottom = -18;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.03;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.fillLight = new THREE.DirectionalLight(0x88d4ff, 0.45);
    this.fillLight.position.set(-10, 14, -12);
    this.scene.add(this.fillLight);

    // Stylized sky-gradient dome
    const sunDir = new THREE.Vector3(28 - 12, 30 - 5, 24 - 12).normalize();
    const skyGeo = new THREE.SphereGeometry(140, 28, 20);
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uZenithColor: { value: new THREE.Color(0x1f7fd8) },
        uMidSkyColor: { value: new THREE.Color(0x6ec6f7) },
        uHorizonColor: { value: new THREE.Color(0xfff1cb) },
        uOceanBounceColor: { value: new THREE.Color(0x229eb3) },
        uSunDir: { value: sunDir },
      },
    });
    this.skyDome = new THREE.Mesh(skyGeo, skyMat);
    this.skyDome.name = "sky_gradient_dome";
    this.skyDome.position.copy(ISLAND_CENTER);
    this.scene.add(this.skyDome);

    // Drifting puffy sculpted low-poly cloud clusters
    this.cloudsRoot = new THREE.Group();
    this.cloudsRoot.name = "cloud_clusters";
    this.buildClouds();
    this.scene.add(this.cloudsRoot);

    // Animated turquoise ocean plane + translucent coastal foam rings
    this.waterGroup = new THREE.Group();
    this.waterGroup.name = "ocean_group";
    this.waterGroup.position.set(ISLAND_CENTER.x, this.waterLevel, ISLAND_CENTER.z);

    const oceanGeo = new THREE.PlaneGeometry(180, 180, 44, 44);
    const posAttr = oceanGeo.getAttribute("position");
    this.oceanBaseX = new Float32Array(posAttr.count);
    this.oceanBaseY = new Float32Array(posAttr.count);
    for (let i = 0; i < posAttr.count; i++) {
      this.oceanBaseX[i] = posAttr.getX(i);
      this.oceanBaseY[i] = posAttr.getY(i);
    }

    const oceanMat = new THREE.MeshStandardMaterial({
      color: 0x16b8c4,
      roughness: 0.24,
      metalness: 0.12,
      transparent: true,
      opacity: 0.88,
    });
    this.oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
    this.oceanMesh.name = "turquoise_ocean";
    this.oceanMesh.rotation.x = -Math.PI * 0.5;
    this.oceanMesh.receiveShadow = true;
    this.waterGroup.add(this.oceanMesh);

    const innerFoamGeo = new THREE.RingGeometry(6.8, 10.4, 56, 2);
    const innerFoamMat = new THREE.MeshBasicMaterial({
      color: 0xe6ffff,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.innerFoamRing = new THREE.Mesh(innerFoamGeo, innerFoamMat);
    this.innerFoamRing.name = "coastal_foam_inner";
    this.innerFoamRing.rotation.x = -Math.PI * 0.5;
    this.innerFoamRing.position.y = 0.04;
    this.waterGroup.add(this.innerFoamRing);

    const outerFoamGeo = new THREE.RingGeometry(10.6, 12.6, 56, 1);
    const outerFoamMat = new THREE.MeshBasicMaterial({
      color: 0xc9f9ff,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.outerFoamRing = new THREE.Mesh(outerFoamGeo, outerFoamMat);
    this.outerFoamRing.name = "coastal_foam_outer";
    this.outerFoamRing.rotation.x = -Math.PI * 0.5;
    this.outerFoamRing.position.y = 0.03;
    this.waterGroup.add(this.outerFoamRing);

    this.scene.add(this.waterGroup);
  }

  /** Set the vertical ocean height (for sudden-death rising tide). */
  public setWaterLevel(y: number): void {
    if (!Number.isFinite(y)) {
      return;
    }
    this.waterLevel = y;
    this.waterGroup.position.y = y;
  }

  /** Resize renderer viewport cleanly. */
  public resize(width: number, height: number): void {
    const safeW = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
    const safeH = Math.max(1, Math.floor(Number.isFinite(height) ? height : 1));
    this.renderer.setSize(safeW, safeH, true);
  }

  /** Animate ocean wave undulation, coastal foam pulse, and drifting cloud clusters. */
  public update(dtSec: number, elapsedSec: number): void {
    const safeDt = Number.isFinite(dtSec) ? Math.max(0, Math.min(dtSec, 0.1)) : 0;
    const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;

    // Gentle ocean surface undulation
    const posAttr = this.oceanMesh.geometry.getAttribute("position");
    if (posAttr instanceof THREE.BufferAttribute) {
      for (let i = 0; i < posAttr.count; i++) {
        const bx = this.oceanBaseX[i] ?? 0;
        const by = this.oceanBaseY[i] ?? 0;
        const wave =
          Math.sin(bx * 0.22 + t * 1.45) * 0.09 +
          Math.cos(by * 0.19 - t * 1.15) * 0.08 +
          Math.sin((bx + by) * 0.12 + t * 0.8) * 0.04;
        posAttr.setZ(i, wave);
      }
      posAttr.needsUpdate = true;
      this.oceanMesh.geometry.computeVertexNormals();
    }

    // Coastal foam ring gentle breathing pulse
    const innerScale = 1.0 + Math.sin(t * 1.35) * 0.035;
    this.innerFoamRing.scale.set(innerScale, innerScale, 1);
    if (this.innerFoamRing.material instanceof THREE.MeshBasicMaterial) {
      this.innerFoamRing.material.opacity = 0.32 + Math.sin(t * 1.35) * 0.08;
    }

    const outerScale = 1.0 + Math.cos(t * 1.05 + 1.1) * 0.045;
    this.outerFoamRing.scale.set(outerScale, outerScale, 1);
    if (this.outerFoamRing.material instanceof THREE.MeshBasicMaterial) {
      this.outerFoamRing.material.opacity = 0.18 + Math.cos(t * 1.05 + 1.1) * 0.06;
    }

    // Drifting clouds
    for (const cloud of this.clouds) {
      cloud.group.position.x += cloud.speed * safeDt;
      if (cloud.group.position.x > 74) {
        cloud.group.position.x = -50;
      }
      cloud.group.position.y =
        cloud.baseY + Math.sin(t * 0.45 + cloud.bobPhase) * 0.28;
    }
  }

  /** Render the scene with the active Three.js camera. */
  public render(camera: THREE.Camera): void {
    this.renderer.render(this.scene, camera);
  }

  /** Dispose all scene geometries, materials, shadow maps, and WebGL context resources. */
  public dispose(): void {
    this.skyDome.geometry.dispose();
    disposeMaterial(this.skyDome.material);
    this.scene.remove(this.skyDome);

    this.cloudsRoot.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        disposeMaterial(obj.material);
      }
    });
    this.scene.remove(this.cloudsRoot);
    this.clouds.length = 0;

    this.oceanMesh.geometry.dispose();
    disposeMaterial(this.oceanMesh.material);
    this.innerFoamRing.geometry.dispose();
    disposeMaterial(this.innerFoamRing.material);
    this.outerFoamRing.geometry.dispose();
    disposeMaterial(this.outerFoamRing.material);
    this.scene.remove(this.waterGroup);

    this.sunLight.shadow.map?.dispose();
    this.scene.remove(this.sunLight);
    this.scene.remove(this.sunLight.target);
    this.scene.remove(this.hemiLight);
    this.scene.remove(this.fillLight);

    this.renderer.dispose();
    if (this.appendedToContainer && this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(
        this.renderer.domElement,
      );
    }
  }

  private buildClouds(): void {
    const cloudSpecs: ReadonlyArray<{
      x: number;
      y: number;
      z: number;
      scale: number;
      speed: number;
      phase: number;
    }> = [
      { x: -26, y: 20, z: -24, scale: 1.2, speed: 0.72, phase: 0.2 },
      { x: 18, y: 23, z: -32, scale: 1.45, speed: 0.56, phase: 1.4 },
      { x: 48, y: 19, z: -12, scale: 1.05, speed: 0.85, phase: 2.3 },
      { x: -34, y: 22, z: 28, scale: 1.35, speed: 0.62, phase: 3.1 },
      { x: 6, y: 25, z: 46, scale: 1.5, speed: 0.5, phase: 4.0 },
      { x: 44, y: 21, z: 38, scale: 1.15, speed: 0.76, phase: 5.2 },
      { x: -12, y: 24, z: 4, scale: 1.1, speed: 0.68, phase: 1.9 },
      { x: 58, y: 26, z: 14, scale: 1.3, speed: 0.58, phase: 2.8 },
    ];

    const puffOffsets: ReadonlyArray<readonly [number, number, number, number]> = [
      [0, 0.35, 0, 2.2],
      [-2.1, -0.1, 0.3, 1.65],
      [2.2, -0.05, -0.2, 1.75],
      [-0.9, 0.45, -1.1, 1.45],
      [1.1, 0.25, 1.1, 1.4],
    ];

    for (const spec of cloudSpecs) {
      const cluster = new THREE.Group();
      const cloudMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.94,
        metalness: 0.0,
      });

      for (const puff of puffOffsets) {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(puff[3], 10, 8),
          cloudMat,
        );
        mesh.position.set(puff[0], puff[1], puff[2]);
        mesh.scale.set(1.15, 0.72, 1.0);
        cluster.add(mesh);
      }

      cluster.position.set(spec.x, spec.y, spec.z);
      cluster.scale.setScalar(spec.scale);
      this.cloudsRoot.add(cluster);

      this.clouds.push({
        group: cluster,
        speed: spec.speed,
        baseY: spec.y,
        bobPhase: spec.phase,
      });
    }
  }
}
