import * as THREE from "three";

export type PerfStats = {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  activeNpcs: number;
  activeAnimals: number;
  visibleChunks: number;
  quality: string;
  resScale: number;
  geometries: number;
  textures: number;
  memoryMb: number | null;
};

export type HudState = {
  health: number;
  hunger: number;
  stamina: number;
  timeLabel: string;
  dayPhase: string;
  prompt: string | null;
  inventory: Record<string, number>;
  message: string | null;
  fps: number;
  objective: string;
  quality: string;
  perf: PerfStats | null;
};

export type GameHandle = {
  dispose: () => void;
  craft: (recipe: string) => void;
  requestPointerLock: () => void;
  setQuality: (q: string) => void;
  toggleStats: () => void;
};

type Cb = (s: HudState) => void;


const R = (a: number, b: number) => a + Math.random() * (b - a);
const WORLD = 460; // half-size

// deterministic-ish hash noise for terrain
function hash(x: number, z: number) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smoothNoise(x: number, z: number) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

// river runs along X, meandering in Z
const riverZ = (x: number) => Math.sin(x * 0.006) * 60 + Math.sin(x * 0.017) * 18 + 150;
const RIVER_W = 16;

export function terrainHeight(x: number, z: number) {
  let h = 0;
  h += smoothNoise(x * 0.006, z * 0.006) * 26;
  h += smoothNoise(x * 0.02, z * 0.02) * 5;
  h += smoothNoise(x * 0.05, z * 0.05) * 1.2;
  // distant hills ring
  const d = Math.hypot(x, z);
  h += Math.max(0, (d - 300) * 0.14);
  // flatten near village center
  const vd = Math.hypot(x, z + 20);
  if (vd < 70) h = h * (0.25 + 0.75 * (vd / 70)) + 6 * (1 - vd / 70);
  // river carve
  const rz = riverZ(x);
  const dr = Math.abs(z - rz);
  if (dr < RIVER_W * 2.4) {
    const t = 1 - dr / (RIVER_W * 2.4);
    h -= t * t * 9;
  }
  // road corridor flatten (road along z at x ~ -? ) handled by roads path
  return h;
}
const WATER_LEVEL = () => 0.6;

// ---------------- adaptive quality presets ----------------
type QualityPreset = {
  name: string;
  resScale: number;
  shadows: boolean;
  shadowMap: number;
  shadowSoft: boolean;
  drawDistance: number;
  grassCount: number;
  bushCount: number;
  dynLights: number;
  fireflies: number;
  antialias: boolean;
  waterSegments: number;
  detailDistance: number;
};

const PRESETS: Record<string, QualityPreset> = {
  Performance: { name: "Performance", resScale: 0.68, shadows: false, shadowMap: 512, shadowSoft: false, drawDistance: 170, grassCount: 1200, bushCount: 500, dynLights: 3, fireflies: 90, antialias: false, waterSegments: 40, detailDistance: 45 },
  Balanced: { name: "Balanced", resScale: 0.85, shadows: true, shadowMap: 1024, shadowSoft: false, drawDistance: 260, grassCount: 3000, bushCount: 900, dynLights: 5, fireflies: 180, antialias: false, waterSegments: 70, detailDistance: 70 },
  Quality: { name: "Quality", resScale: 1, shadows: true, shadowMap: 2048, shadowSoft: true, drawDistance: 360, grassCount: 6000, bushCount: 1400, dynLights: 7, fireflies: 300, antialias: true, waterSegments: 110, detailDistance: 100 },
  Ultra: { name: "Ultra", resScale: 1, shadows: true, shadowMap: 2048, shadowSoft: true, drawDistance: 460, grassCount: 9000, bushCount: 1800, dynLights: 8, fireflies: 420, antialias: true, waterSegments: 150, detailDistance: 140 },
};
const ORDER = ["Performance", "Balanced", "Quality", "Ultra"];

function detectQuality(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    let gpu = "";
    if (gl) {
      const ext = (gl as WebGLRenderingContext).getExtension("WEBGL_debug_renderer_info");
      if (ext) gpu = String((gl as WebGLRenderingContext).getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "").toLowerCase();
    }
    const cores = navigator.hardwareConcurrency ?? 4;
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
    const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
    if (mobile || cores <= 2 || mem <= 2) return "Performance";
    const weak = /intel|uhd|hd graphics|swiftshader|llvmpipe|mali|adreno|apple gpu/.test(gpu);
    if (weak) return cores >= 8 && mem >= 8 ? "Balanced" : "Performance";
    const strong = /rtx|radeon rx|geforce (gtx )?(1[6-9]|[2-4][0-9])|apple m[1-9]/.test(gpu);
    if (strong && cores >= 8 && mem >= 8) return "Quality";
    if (cores >= 8 && mem >= 8) return "Balanced";
    return "Balanced";
  } catch {
    return "Balanced";
  }
}

export function createGame(container: HTMLElement, onHud: Cb): GameHandle {
  let qName = detectQuality();
  let Q: QualityPreset = PRESETS[qName]!;
  let resScale = Q.resScale;

  const renderer = new THREE.WebGLRenderer({ antialias: Q.antialias, powerPreference: "high-performance", stencil: false });
  const basePR = Math.min(window.devicePixelRatio, 1.5);
  renderer.setPixelRatio(basePR * resScale);

  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = Q.shadows;
  renderer.shadowMap.type = Q.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = Q.shadows;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, container.clientWidth / container.clientHeight, 0.1, 1400);
  const fog = new THREE.FogExp2(0x0a1430, 0.0035);
  scene.fog = fog;


  // ---------- sky ----------
  const skyGeo = new THREE.SphereGeometry(900, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x0a1a44) },
      bottom: { value: new THREE.Color(0x1b2a52) },
      starAmt: { value: 1 },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `
      varying vec3 vP; uniform vec3 top; uniform vec3 bottom; uniform float starAmt;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
      void main(){
        vec3 d = normalize(vP);
        float t = clamp(d.y*1.15+0.15, 0.0, 1.0);
        vec3 col = mix(bottom, top, t);
        vec3 g = floor(d*260.0);
        float s = h(g);
        float star = smoothstep(0.9975, 1.0, s) * starAmt * clamp(d.y,0.0,1.0);
        // milky way band
        float band = exp(-pow((d.y*2.2 - d.x*1.1 - 0.1), 2.0)*6.0);
        float milky = band * (h(g*1.7)*0.5) * starAmt * 0.55 * clamp(d.y,0.0,1.0);
        col += vec3(star) * 1.6 + vec3(0.55,0.6,0.9) * milky;
        gl_FragColor = vec4(col,1.0);
      }`,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  // moon + sun
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(14, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0xdfe6ff, fog: false })
  );
  scene.add(moon);
  const sunSprite = new THREE.Mesh(
    new THREE.SphereGeometry(18, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff0c4, fog: false })
  );
  scene.add(sunSprite);

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0x8fb2ff, 0x2c3a25, 0.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d6, 1.0);
  sun.castShadow = Q.shadows;
  sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  sun.shadow.bias = -0.0006;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70;

  scene.add(sun, sun.target);
  const ambient = new THREE.AmbientLight(0x334466, 0.35);
  scene.add(ambient);

  // ---------- terrain ----------
  const SEG = 190;
  const tGeo = new THREE.PlaneGeometry(WORLD * 2, WORLD * 2, SEG, SEG);
  tGeo.rotateX(-Math.PI / 2);
  const pos = tGeo.attributes['position']! as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const cGrass = new THREE.Color(0x3f6b34);
  const cField = new THREE.Color(0x6f8a35);
  const cDirt = new THREE.Color(0x6b5638);
  const cRock = new THREE.Color(0x565a56);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    const c = new THREE.Color();
    const fieldN = smoothNoise(x * 0.012 + 40, z * 0.012 - 20);
    c.copy(fieldN > 0.62 ? cField : cGrass);
    const dr = Math.abs(z - riverZ(x));
    if (dr < RIVER_W + 4) c.lerp(cDirt, 0.7);
    if (y > 26) c.lerp(cRock, Math.min(1, (y - 26) / 18));
    c.offsetHSL(0, 0, (smoothNoise(x * 0.3, z * 0.3) - 0.5) * 0.06);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  tGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  tGeo.computeVertexNormals();
  const ground = new THREE.Mesh(tGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- water ----------
  const wGeo = new THREE.PlaneGeometry(WORLD * 2, 260, Q.waterSegments, 6);
  wGeo.rotateX(-Math.PI / 2);

  const wPos = wGeo.attributes['position']! as THREE.BufferAttribute;
  const wBase: number[] = [];
  for (let i = 0; i < wPos.count; i++) {
    const x = wPos.getX(i);
    wPos.setZ(i, wPos.getZ(i) + riverZ(x));
    wBase.push(wPos.getZ(i));
  }
  const waterUniforms = { uTime: { value: 0 } };
  const waterMat = new THREE.MeshPhongMaterial({
    color: 0x1d3f5c, transparent: true, opacity: 0.82, shininess: 120, specular: 0x9fd8ff,
  });
  // GPU-side ripples: no per-frame CPU vertex work
  waterMat.onBeforeCompile = (shader) => {
    shader.uniforms['uTime'] = waterUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         transformed.y += sin(uTime * 1.1 + position.x * 0.12) * 0.18
                        + sin(uTime * 0.7 + position.z * 0.21) * 0.10;`
      );
  };
  const water = new THREE.Mesh(wGeo, waterMat);
  water.position.y = WATER_LEVEL();
  scene.add(water);


  // ---------- helpers to add objects ----------
  const solids: { x: number; z: number; r: number }[] = [];
  const interactables: {
    x: number; z: number; y: number; r: number; label: string; kind: string; obj?: THREE.Object3D; used?: boolean;
  }[] = [];

  const mat = (c: number, opts: THREE.MeshLambertMaterialParameters = {}) =>
    new THREE.MeshLambertMaterial({ color: c, ...opts });

  const M = {
    mud: mat(0xa9866a), plaster: mat(0xc7b299), roof: mat(0x8a4433), roof2: mat(0x6d5133),
    thatch: mat(0xbb9a4f), wood: mat(0x6b4a2c), darkWood: mat(0x4a3320), leaf: mat(0x27502a),
    leaf2: mat(0x2f6033), trunk: mat(0x5a4128), stone: mat(0x6d6d68), cloth: mat(0xcf6f4a),
    cow: mat(0xcfc6ba), cow2: mat(0x3a3229), goat: mat(0xa9a099), dog: mat(0x8a6338),
    chicken: mat(0xe8e2d8), skin: mat(0xa9744a), shirt: mat(0x4b6f8c), shirt2: mat(0xa64f4f),
    metal: mat(0x59606b), rail: mat(0x4a4a4f), gravel: mat(0x585049), road: mat(0x3d3a36),
    glassLit: new THREE.MeshBasicMaterial({ color: 0xffc773 }),
    glassDark: mat(0x1a1a20),
  };

  const grp = (parent: THREE.Object3D, ...meshes: THREE.Object3D[]) => {
    meshes.forEach((m) => parent.add(m));
  };
  function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    b.castShadow = true; b.receiveShadow = true;
    return b;
  }
  function cyl(rt: number, rb: number, h: number, m: THREE.Material, seg = 8) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
    c.castShadow = true; c.receiveShadow = true;
    return c;
  }

  // ---------- houses / villages ----------
  const lampLights: { light: THREE.PointLight; base: number }[] = [];
  const windowMats: THREE.MeshBasicMaterial[] = [];

  function buildHouse(x: number, z: number, rot: number, variant: number) {
    const g = new THREE.Group();
    const y = terrainHeight(x, z);
    g.position.set(x, y, z);
    g.rotation.y = rot;
    const w = R(5.5, 7.5), d = R(5, 7), h = R(3, 3.8);
    const wall = variant % 2 ? M.mud : M.plaster;
    grp(g, box(w, h, d, wall, 0, h / 2, 0));
    // roof
    if (variant % 3 === 0) {
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.82, 2.6, 4), M.thatch);
      roof.position.y = h + 1.3; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
      g.add(roof);
    } else {
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.86, 2.2, 4), variant % 2 ? M.roof : M.roof2);
      roof.position.y = h + 1.1; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
      g.add(roof);
    }
    // door + windows
    grp(g, box(1.1, 2, 0.15, M.darkWood, 0, 1, d / 2 + 0.02));
    const wm = M.glassLit.clone();
    windowMats.push(wm);
    grp(g,
      box(0.9, 0.8, 0.12, wm, w / 2 - 1.4, 2, d / 2 + 0.03),
      box(0.9, 0.8, 0.12, wm, -w / 2 + 1.4, 2, d / 2 + 0.03),
      box(0.12, 0.8, 0.9, wm, w / 2 + 0.03, 2, 0)
    );
    // interior warm light
    const pl = new THREE.PointLight(0xffb45e, 0, 12, 2);
    pl.position.set(0, 2.2, d / 2 + 1.2);
    g.add(pl);
    lampLights.push({ light: pl, base: 1.5 });
    // charpoy outside
    if (Math.random() < 0.6) {
      const cp = new THREE.Group();
      cp.position.set(R(-w, w), 0, d / 2 + R(1.5, 3));
      grp(cp, box(2.2, 0.15, 1.1, M.cloth, 0, 0.55, 0));
      [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => grp(cp, box(0.14, 0.55, 0.14, M.wood, sx * 1, 0.28, sz * 0.48))));
      g.add(cp);
    }
    // clothes line
    if (Math.random() < 0.5) {
      for (let i = 0; i < 3; i++) grp(g, box(0.7, 0.9, 0.05, i % 2 ? M.shirt : M.shirt2, -w / 2 + 0.8 + i * 1.1, 2.3, -d / 2 - 1.2));
    }
    // water pots
    for (let i = 0; i < 2; i++) {
      const p = cyl(0.22, 0.32, 0.55, M.mud);
      p.position.set(R(-w / 2, w / 2), 0.3, d / 2 + 0.9);
      g.add(p);
    }
    scene.add(g);
    solids.push({ x, z, r: Math.max(w, d) * 0.55 });
    interactables.push({ x, z: z + d / 2 + 1.5, y, r: 3, label: "Rest by the house (sleep)", kind: "sleep" });
  }

  function buildWell(x: number, z: number) {
    const y = terrainHeight(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.3, 1.1, 12, 1, true), M.stone);
    ring.position.y = 0.55; ring.castShadow = true;
    grp(g, ring, box(0.15, 2, 0.15, M.wood, -1, 1, 0), box(0.15, 2, 0.15, M.wood, 1, 1, 0), box(2.4, 0.2, 0.6, M.wood, 0, 2, 0));
    scene.add(g);
    solids.push({ x, z, r: 1.4 });
    interactables.push({ x, z, y, r: 3.2, label: "Draw water from the well", kind: "water" });
  }

  function buildLantern(x: number, z: number) {
    const y = terrainHeight(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    grp(g, cyl(0.08, 0.1, 3.2, M.darkWood), box(0.4, 0.5, 0.4, M.glassLit, 0, 3.2, 0));
    (g.children[0] as THREE.Mesh).position.y = 1.6;
    const l = new THREE.PointLight(0xffa94d, 0, 16, 2);
    l.position.set(0, 3.2, 0);
    g.add(l);
    lampLights.push({ light: l, base: 2.2 });
    scene.add(g);
  }

  function buildFence(x1: number, z1: number, x2: number, z2: number) {
    const n = Math.floor(Math.hypot(x2 - x1, z2 - z1) / 2);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x1 + (x2 - x1) * t, z = z1 + (z2 - z1) * t;
      const p = box(0.12, 1.3, 0.12, M.wood, x, terrainHeight(x, z) + 0.65, z);
      scene.add(p);
    }
    const mid = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(x2 - x1, z2 - z1), 0.09, 0.09), M.wood);
    mid.position.set((x1 + x2) / 2, terrainHeight((x1 + x2) / 2, (z1 + z2) / 2) + 0.95, (z1 + z2) / 2);
    mid.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
    scene.add(mid);
  }

  const villages: { x: number; z: number }[] = [];
  function buildVillage(cx: number, cz: number, count: number) {
    villages.push({ x: cx, z: cz });
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + R(-0.3, 0.3);
      const rad = R(12, 34);
      const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
      if (Math.abs(z - riverZ(x)) < RIVER_W + 8) continue;
      buildHouse(x, z, -a + Math.PI / 2 + R(-0.4, 0.4), i);
      if (i % 3 === 0) buildLantern(x + R(-6, 6), z + R(4, 8));
    }
    buildWell(cx + R(-6, 6), cz + R(-6, 6));
    // small farm plots + fences
    for (let f = 0; f < 3; f++) {
      const fx = cx + R(-55, 55), fz = cz + R(-55, 55);
      buildFence(fx - 10, fz - 8, fx + 10, fz - 8);
      buildFence(fx + 10, fz + 8, fx - 10, fz + 8);
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 10; c++) {
          const x = fx - 9 + c * 2, z = fz - 7 + r * 3;
          const crop = box(1.4, 0.5, 0.4, M.leaf2, x, terrainHeight(x, z) + 0.25, z);
          crop.castShadow = false;
          scene.add(crop);
        }
    }
  }

  // ---------- vegetation (instanced) ----------
  type TreeSpec = { pos: THREE.Vector3; scale: number; type: number };
  const trees: TreeSpec[] = [];
  for (let i = 0; i < 900; i++) {
    const x = R(-WORLD + 20, WORLD - 20), z = R(-WORLD + 20, WORLD - 20);
    const y = terrainHeight(x, z);
    if (y < 1.2 || y > 30) continue;
    if (Math.abs(z - riverZ(x)) < RIVER_W + 3) continue;
    if (Math.hypot(x, z + 20) < 18) continue;
    trees.push({ pos: new THREE.Vector3(x, y, z), scale: R(0.8, 1.4), type: Math.floor(Math.random() * 3) });
  }

  const dummy = new THREE.Object3D();
  // palm trunk + fronds
  const palm = trees.filter((t) => t.type === 0);
  const mango = trees.filter((t) => t.type === 1);
  const banana = trees.filter((t) => t.type === 2);

  function instance(geo: THREE.BufferGeometry, material: THREE.Material, list: TreeSpec[], place: (t: TreeSpec, i: number) => void) {
    const im = new THREE.InstancedMesh(geo, material, Math.max(1, list.length));
    im.castShadow = true; im.receiveShadow = true;
    list.forEach((t, i) => { place(t, i); im.setMatrixAt(i, dummy.matrix); });
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
    return im;
  }

  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.3, 8, 6);
  instance(trunkGeo, M.trunk, palm, (t) => {
    dummy.position.set(t.pos.x, t.pos.y + 4 * t.scale, t.pos.z);
    dummy.rotation.set(R(-0.06, 0.06), R(0, 6.28), R(-0.06, 0.06));
    dummy.scale.set(1, t.scale, 1); dummy.updateMatrix();
  });
  const frondGeo = new THREE.ConeGeometry(3.2, 1.4, 5);
  const palmTops = instance(frondGeo, M.leaf, palm, (t) => {
    dummy.position.set(t.pos.x, t.pos.y + 8 * t.scale, t.pos.z);
    dummy.rotation.set(0, R(0, 6.28), 0);
    dummy.scale.set(t.scale, t.scale, t.scale); dummy.updateMatrix();
  });
  instance(new THREE.CylinderGeometry(0.28, 0.45, 4.4, 6), M.trunk, mango, (t) => {
    dummy.position.set(t.pos.x, t.pos.y + 2.2 * t.scale, t.pos.z);
    dummy.rotation.set(0, R(0, 6.28), 0);
    dummy.scale.set(1, t.scale, 1); dummy.updateMatrix();
  });
  instance(new THREE.IcosahedronGeometry(3.2, 0), M.leaf2, mango, (t) => {
    dummy.position.set(t.pos.x, t.pos.y + 5.6 * t.scale, t.pos.z);
    dummy.rotation.set(R(0, 3), R(0, 6.28), 0);
    dummy.scale.set(t.scale * 1.1, t.scale * 0.85, t.scale * 1.1); dummy.updateMatrix();
  });
  instance(new THREE.CylinderGeometry(0.16, 0.22, 2.6, 5), M.leaf2, banana, (t) => {
    dummy.position.set(t.pos.x, t.pos.y + 1.3 * t.scale, t.pos.z);
    dummy.rotation.set(0, R(0, 6.28), 0); dummy.scale.setScalar(t.scale); dummy.updateMatrix();
  });
  instance(new THREE.ConeGeometry(1.8, 2.2, 4), M.leaf, banana, (t) => {
    dummy.position.set(t.pos.x, t.pos.y + 3.4 * t.scale, t.pos.z);
    dummy.rotation.set(0.15, R(0, 6.28), 0); dummy.scale.setScalar(t.scale); dummy.updateMatrix();
  });

  trees.forEach((t) => {
    solids.push({ x: t.pos.x, z: t.pos.z, r: 0.7 });
    interactables.push({
      x: t.pos.x, z: t.pos.z, y: t.pos.y, r: 2.6,
      label: t.type === 2 ? "Gather bananas & fiber" : t.type === 1 ? "Gather mangoes & wood" : "Gather coconut & wood",
      kind: t.type === 2 ? "banana" : t.type === 1 ? "mango" : "palm",
    });
  });

  // bushes + flowers + grass tufts (instanced)
  const bushCount = 1400;
  const bushGeo = new THREE.IcosahedronGeometry(0.9, 0);
  const bushes = new THREE.InstancedMesh(bushGeo, M.leaf2, bushCount);
  bushes.receiveShadow = true;
  const bushPts: THREE.Vector3[] = [];
  for (let i = 0; i < bushCount; i++) {
    const x = R(-WORLD, WORLD), z = R(-WORLD, WORLD);
    const y = terrainHeight(x, z);
    dummy.position.set(x, y + 0.3, z);
    dummy.rotation.set(R(0, 3), R(0, 6), 0);
    dummy.scale.setScalar(R(0.5, 1.1) * (y < 1 ? 0.01 : 1));
    dummy.updateMatrix();
    bushes.setMatrixAt(i, dummy.matrix);
    bushPts.push(new THREE.Vector3(x, y, z));
  }
  scene.add(bushes);
  bushPts.filter((_, i) => i % 7 === 0).forEach((p) =>
    interactables.push({ x: p.x, z: p.z, y: p.y, r: 2.2, label: "Gather grass & fiber", kind: "bush" })
  );

  // stones
  const stoneCount = 260;
  const stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.8, 0), M.stone, stoneCount);
  stones.castShadow = true; stones.receiveShadow = true;
  for (let i = 0; i < stoneCount; i++) {
    const x = R(-WORLD, WORLD), z = R(-WORLD, WORLD);
    const y = terrainHeight(x, z);
    dummy.position.set(x, y + 0.3, z);
    dummy.rotation.set(R(0, 3), R(0, 6), R(0, 3));
    dummy.scale.setScalar(R(0.5, 1.5));
    dummy.updateMatrix(); stones.setMatrixAt(i, dummy.matrix);
    interactables.push({ x, z, y, r: 2.4, label: "Mine stone", kind: "stone" });
  }
  scene.add(stones);

  // grass blades near spawn area (instanced, wind animated)
  const grassCount = 6000;
  const bladeGeo = new THREE.PlaneGeometry(0.22, 0.8);
  bladeGeo.translate(0, 0.4, 0);
  const grassMat = new THREE.MeshLambertMaterial({ color: 0x4d7a34, side: THREE.DoubleSide });
  const grass = new THREE.InstancedMesh(bladeGeo, grassMat, grassCount);
  for (let i = 0; i < grassCount; i++) {
    const a = R(0, 6.28), rr = Math.sqrt(Math.random()) * 150;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr - 20;
    const y = terrainHeight(x, z);
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, R(0, 6.28), 0);
    dummy.scale.setScalar(R(0.7, 1.4) * (y < 1 ? 0.01 : 1));
    dummy.updateMatrix(); grass.setMatrixAt(i, dummy.matrix);
  }
  scene.add(grass);

  // ---------- villages ----------
  buildVillage(0, -20, 12);
  buildVillage(-190, 40, 9);
  buildVillage(210, -150, 10);
  buildVillage(60, 300, 8);

  // player start house
  buildHouse(8, 6, Math.PI, 1);

  // ---------- road (winding) ----------
  const roadPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const z = -WORLD + t * WORLD * 2;
    const x = Math.sin(t * 6.0) * 90 + Math.cos(t * 2.3) * 40 - 40;
    roadPts.push(new THREE.Vector3(x, terrainHeight(x, z) + 0.12, z));
  }
  const roadCurve = new THREE.CatmullRomCurve3(roadPts);
  {
    const N = 400;
    const g = new THREE.BufferGeometry();
    const v: number[] = [], idx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const p = roadCurve.getPointAt(i / N);
      const tan = roadCurve.getTangentAt(i / N);
      const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize().multiplyScalar(4);
      const y = terrainHeight(p.x, p.z) + 0.14;
      v.push(p.x - side.x, y, p.z - side.z, p.x + side.x, y, p.z + side.z);
      if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const road = new THREE.Mesh(g, M.road);
    road.receiveShadow = true;
    scene.add(road);
  }

  // ---------- railway ----------
  const railZ = -230;
  const railPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 40; i++) {
    const x = -WORLD + (i / 40) * WORLD * 2;
    const z = railZ + Math.sin(i / 40 * 3.4) * 55;
    railPts.push(new THREE.Vector3(x, 0, z));
  }
  const railCurve = new THREE.CatmullRomCurve3(railPts);
  const railHeightAt = (t: number) => {
    const p = railCurve.getPointAt(t);
    return Math.max(terrainHeight(p.x, p.z), 2) + 1.2;
  };
  {
    // embankment + sleepers + rails
    const N = 300;
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const p = railCurve.getPointAt(t);
      const tan = railCurve.getTangentAt(t);
      const y = railHeightAt(t);
      const s = box(2.6, 0.24, 0.5, M.darkWood, p.x, y - 0.25, p.z);
      s.rotation.y = -Math.atan2(tan.z, tan.x);
      s.castShadow = false;
      scene.add(s);
      const bed = box(5.4, 1.6, 1.6, M.gravel, p.x, y - 1.1, p.z);
      bed.rotation.y = s.rotation.y; bed.receiveShadow = true;
      scene.add(bed);
    }
    for (const off of [-0.75, 0.75]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 300; i++) {
        const t = i / 300;
        const p = railCurve.getPointAt(t);
        const tan = railCurve.getTangentAt(t);
        const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize().multiplyScalar(off);
        pts.push(new THREE.Vector3(p.x + side.x, railHeightAt(t), p.z + side.z));
      }
      const rg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 300, 0.07, 4, false);
      scene.add(new THREE.Mesh(rg, M.rail));
    }
    // poles
    for (let i = 0; i < 40; i++) {
      const t = i / 40;
      const p = railCurve.getPointAt(t);
      const y = terrainHeight(p.x, p.z);
      const pole = box(0.2, 7, 0.2, M.darkWood, p.x + 5, y + 3.5, p.z + 5);
      scene.add(pole, box(1.6, 0.15, 0.15, M.darkWood, p.x + 5, y + 6.6, p.z + 5));
    }
    // small station
    const st = railCurve.getPointAt(0.5);
    const sy = terrainHeight(st.x, st.z);
    scene.add(box(16, 0.6, 6, M.stone, st.x, sy + 1.4, st.z + 6));
    scene.add(box(10, 3, 4, M.plaster, st.x, sy + 3.2, st.z + 8));
    const stRoof = box(12, 0.3, 6, M.roof, st.x, sy + 4.8, st.z + 8);
    scene.add(stRoof);
    const sl = new THREE.PointLight(0xffbb66, 0, 22, 2);
    sl.position.set(st.x, sy + 6, st.z + 6);
    scene.add(sl);
    lampLights.push({ light: sl, base: 3 });
  }

  // train
  const trainGroup = new THREE.Group();
  const trainWindowMats: THREE.MeshBasicMaterial[] = [];
  const trainHeadlight = new THREE.SpotLight(0xfff0c0, 0, 90, 0.4, 0.5, 1.5);
  const cars: THREE.Group[] = [];
  for (let c = 0; c < 6; c++) {
    const g = new THREE.Group();
    const body = box(9, 3, 3, c === 0 ? mat(0x2b3a4a) : mat(0x3d5060), 0, 1.9, 0);
    g.add(body);
    const wm = new THREE.MeshBasicMaterial({ color: 0xffcf85 });
    trainWindowMats.push(wm);
    for (let i = -3; i <= 3; i += 1.6) {
      g.add(box(1.1, 0.8, 0.08, wm, i, 2.3, 1.53), box(1.1, 0.8, 0.08, wm, i, 2.3, -1.53));
    }
    g.add(box(9.2, 0.4, 3.2, M.metal, 0, 3.5, 0));
    cars.push(g);
    trainGroup.add(g);
  }
  cars[0]!.add(trainHeadlight);
  trainHeadlight.position.set(4.6, 2, 0);
  const hlTarget = new THREE.Object3D();
  hlTarget.position.set(40, 0, 0);
  cars[0]!.add(hlTarget);
  trainHeadlight.target = hlTarget;
  scene.add(trainGroup);
  // steam
  const smokeGeo = new THREE.SphereGeometry(1.1, 6, 6);
  const smokeMat = new THREE.MeshLambertMaterial({ color: 0x9aa0a8, transparent: true, opacity: 0.35 });
  const smokes: THREE.Mesh[] = [];
  for (let i = 0; i < 14; i++) {
    const s = new THREE.Mesh(smokeGeo, smokeMat.clone());
    s.visible = false; scene.add(s); smokes.push(s);
  }

  // ---------- bridges ----------
  function buildBridge(x: number, isRail: boolean) {
    const z = riverZ(x);
    const y = isRail ? 5.5 : terrainHeight(x, z) + 3.4;
    const deck = box(isRail ? 8 : 9, 0.5, 46, isRail ? M.metal : M.wood, x, y, z);
    scene.add(deck);
    for (const dz of [-16, 0, 16]) scene.add(box(1, 8, 1, isRail ? M.metal : M.wood, x - 3, y - 4, z + dz), box(1, 8, 1, isRail ? M.metal : M.wood, x + 3, y - 4, z + dz));
    for (const sx of [-1, 1]) scene.add(box(0.2, 1.2, 46, M.wood, x + sx * 4.3, y + 0.8, z));
  }
  buildBridge(-40, false);
  buildBridge(120, false);

  // ---------- vehicles ----------
  type Vehicle = { g: THREE.Group; t: number; speed: number; lights: THREE.SpotLight[] };
  const vehicles: Vehicle[] = [];
  function makeVehicle(bus: boolean) {
    const g = new THREE.Group();
    const col = bus ? mat(0x2f6f5f) : mat(0x8a3f3f);
    g.add(box(bus ? 8 : 4.2, bus ? 2.8 : 1.4, 2.6, col, 0, bus ? 1.9 : 1.2, 0));
    if (!bus) g.add(box(2.2, 1, 2.3, col, -0.2, 2.1, 0));
    const wm = new THREE.MeshBasicMaterial({ color: 0xffe6b0 });
    for (let i = -2; i <= 2; i += 1.4) if (bus) g.add(box(1, 0.9, 0.06, wm, i, 2.3, 1.33), box(1, 0.9, 0.06, wm, i, 2.3, -1.33));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const w = cyl(0.55, 0.55, 0.4, mat(0x1c1c1c), 10);
      w.rotation.x = Math.PI / 2;
      w.position.set(sx * (bus ? 2.6 : 1.4), 0.55, sz * 1.2);
      g.add(w);
    }
    const lights: THREE.SpotLight[] = [];
    for (const sz of [-0.8, 0.8]) {
      const sp = new THREE.SpotLight(0xfff1c0, 0, 40, 0.5, 0.6, 1.5);
      sp.position.set(bus ? 4 : 2.2, 1.2, sz);
      const tgt = new THREE.Object3D(); tgt.position.set(30, -2, sz);
      g.add(sp, tgt); sp.target = tgt;
      lights.push(sp);
    }
    scene.add(g);
    vehicles.push({ g, t: Math.random(), speed: R(0.008, 0.016) * (bus ? 0.8 : 1), lights });
  }
  makeVehicle(true); makeVehicle(false); makeVehicle(false); makeVehicle(true);

  // ---------- NPCs ----------
  type Npc = { g: THREE.Group; home: THREE.Vector2; target: THREE.Vector2; speed: number; state: string; talkT: number; legs: THREE.Object3D[] };
  const npcs: Npc[] = [];
  function makeNpc(x: number, z: number) {
    const g = new THREE.Group();
    const shirt = Math.random() < 0.5 ? M.shirt : M.shirt2;
    g.add(box(0.6, 0.9, 0.35, shirt, 0, 1.25, 0));
    const head = box(0.36, 0.38, 0.34, M.skin, 0, 1.85, 0);
    g.add(head);
    const legs = [box(0.2, 0.8, 0.22, M.darkWood, -0.16, 0.4, 0), box(0.2, 0.8, 0.22, M.darkWood, 0.16, 0.4, 0)];
    legs.forEach((l) => g.add(l));
    g.add(box(0.16, 0.75, 0.2, M.skin, -0.4, 1.3, 0), box(0.16, 0.75, 0.2, M.skin, 0.4, 1.3, 0));
    g.position.set(x, terrainHeight(x, z), z);
    scene.add(g);
    npcs.push({ g, home: new THREE.Vector2(x, z), target: new THREE.Vector2(x, z), speed: R(1.1, 1.9), state: "walk", talkT: 0, legs });
    interactables.push({ x, z, y: 0, r: 3, label: "Talk to villager", kind: "npc", obj: g });
  }
  villages.forEach((v) => { for (let i = 0; i < 7; i++) makeNpc(v.x + R(-25, 25), v.z + R(-25, 25)); });

  // ---------- animals ----------
  type Animal = { g: THREE.Group; kind: string; home: THREE.Vector2; target: THREE.Vector2; speed: number; t: number };
  const animals: Animal[] = [];
  function makeAnimal(kind: string, x: number, z: number) {
    const g = new THREE.Group();
    const size = kind === "cow" ? 1 : kind === "goat" ? 0.62 : kind === "dog" ? 0.5 : 0.28;
    const bodyMat = kind === "cow" ? (Math.random() < 0.5 ? M.cow : M.cow2) : kind === "goat" ? M.goat : kind === "dog" ? M.dog : M.chicken;
    g.add(box(1.8 * size, 1 * size, 0.9 * size, bodyMat, 0, 1.1 * size, 0));
    g.add(box(0.6 * size, 0.6 * size, 0.6 * size, bodyMat, 1.1 * size, 1.4 * size, 0));
    for (const sx of [-1, 1]) for (const sz of [-1, 1])
      g.add(box(0.18 * size, 1.1 * size, 0.18 * size, bodyMat, sx * 0.6 * size, 0.55 * size, sz * 0.3 * size));
    if (kind === "cow" || kind === "goat")
      g.add(box(0.1, 0.3 * size, 0.1, M.plaster, 1.1 * size, 1.8 * size, 0.18 * size), box(0.1, 0.3 * size, 0.1, M.plaster, 1.1 * size, 1.8 * size, -0.18 * size));
    g.position.set(x, terrainHeight(x, z), z);
    g.rotation.y = R(0, 6.28);
    scene.add(g);
    animals.push({ g, kind, home: new THREE.Vector2(x, z), target: new THREE.Vector2(x, z), speed: kind === "dog" ? 2.4 : 0.8, t: Math.random() * 10 });
  }
  villages.forEach((v) => {
    for (let i = 0; i < 6; i++) makeAnimal("cow", v.x + R(-40, 40), v.z + R(-40, 40));
    for (let i = 0; i < 6; i++) makeAnimal("goat", v.x + R(-40, 40), v.z + R(-40, 40));
    for (let i = 0; i < 3; i++) makeAnimal("dog", v.x + R(-25, 25), v.z + R(-25, 25));
    for (let i = 0; i < 6; i++) makeAnimal("chicken", v.x + R(-20, 20), v.z + R(-20, 20));
  });

  // birds
  const birds: THREE.Mesh[] = [];
  for (let i = 0; i < 30; i++) {
    const b = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.2, 3), mat(0x222222));
    b.rotation.z = Math.PI / 2;
    scene.add(b); birds.push(b);
  }

  // fireflies
  const ffCount = 400;
  const ffGeo = new THREE.BufferGeometry();
  const ffPos = new Float32Array(ffCount * 3);
  const ffSeed: number[] = [];
  for (let i = 0; i < ffCount; i++) {
    const a = R(0, 6.28), rr = Math.sqrt(Math.random()) * 120;
    ffPos[i * 3] = Math.cos(a) * rr;
    ffPos[i * 3 + 1] = 1;
    ffPos[i * 3 + 2] = Math.sin(a) * rr - 20;
    ffSeed.push(R(0, 100));
  }
  ffGeo.setAttribute("position", new THREE.BufferAttribute(ffPos, 3));
  const ffMat = new THREE.PointsMaterial({ color: 0xd6ff8a, size: 0.35, transparent: true, opacity: 0 });
  const fireflies = new THREE.Points(ffGeo, ffMat);
  scene.add(fireflies);

  // chimney smoke over village
  const chimney: THREE.Mesh[] = [];
  for (let i = 0; i < 20; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.8, 5, 5), new THREE.MeshLambertMaterial({ color: 0xb9bcc0, transparent: true, opacity: 0.25 }));
    scene.add(s); chimney.push(s);
  }

  // ---------- audio ----------
  let audioCtx: AudioContext | null = null;
  let ambientGain: GainNode | null = null;
  function initAudio() {
    if (audioCtx) return;
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    audioCtx = new AC();
    ambientGain = audioCtx.createGain();
    ambientGain.gain.value = 0.08;
    ambientGain.connect(audioCtx.destination);
    // wind: filtered noise
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 3, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.4;
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const flt = audioCtx.createBiquadFilter();
    flt.type = "lowpass"; flt.frequency.value = 420;
    src.connect(flt).connect(ambientGain);
    src.start();
  }
  function beep(freq: number, dur: number, type: OscillatorType = "sine", vol = 0.06) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur + 0.05);
  }
  function cricket() { beep(R(2000, 2600), 0.05, "triangle", 0.015); }
  function trainHorn() { beep(210, 1.2, "sawtooth", 0.05); setTimeout(() => beep(160, 1.4, "sawtooth", 0.04), 200); }
  function cowMoo() { beep(R(120, 160), 0.9, "sawtooth", 0.035); }
  function dogBark() { beep(R(280, 340), 0.12, "square", 0.03); }

  // ---------- player ----------
  const player = {
    pos: new THREE.Vector3(14, 0, 16),
    vel: new THREE.Vector3(),
    yaw: Math.PI, pitch: -0.05,
    onGround: false,
    health: 100, hunger: 100, stamina: 100,
    third: false,
  };
  player.pos.y = terrainHeight(player.pos.x, player.pos.z) + 1.8;

  const inventory: Record<string, number> & { Wood: number; Stone: number; Fiber: number; Grass: number; Fruit: number; Water: number; Food: number; Coal: number } = { Wood: 0, Stone: 0, Fiber: 0, Grass: 0, Fruit: 0, Water: 0, Food: 0, Coal: 0 };
  let message: string | null = null;
  let messageT = 0;
  let objective = "Explore the village and gather resources.";
  const say = (m: string) => { message = m; messageT = 3.2; };

  const keys: Record<string, boolean> & { KeyW: boolean; KeyA: boolean; KeyS: boolean; KeyD: boolean; KeyQ: boolean; Space: boolean; ShiftLeft: boolean } = { KeyW: false, KeyA: false, KeyS: false, KeyD: false, KeyQ: false, Space: false, ShiftLeft: false };
  const onKeyDown = (e: KeyboardEvent) => {
    keys[e.code] = true;
    if (e.code === "KeyF") player.third = !player.third;
    if (e.code === "KeyE") tryInteract();
    if (e.code === "Space") e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => { keys[e.code] = false; };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    player.yaw -= e.movementX * 0.0022;
    player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * 0.0022, -1.4, 1.35);
  };
  document.addEventListener("mousemove", onMouseMove);
  const onClick = () => { renderer.domElement.requestPointerLock(); initAudio(); };
  renderer.domElement.addEventListener("click", onClick);

  // interaction
  let currentInteract: (typeof interactables)[number] | null = null;
  const npcLines = [
    "The night train passes soon — you can hear it across the fields.",
    "Take some fruit from the mango trees, there is plenty.",
    "My cows sleep early. The dogs keep watch.",
    "The river is good for fishing near the wooden bridge.",
    "Stay warm. The stars are bright tonight.",
  ];
  function tryInteract() {
    initAudio();
    if (!currentInteract) return;
    const it = currentInteract;
    switch (it.kind) {
      case "palm": inventory.Wood += 2; inventory.Fruit += 1; say("+2 Wood, +1 Coconut"); beep(330, 0.12, "triangle"); break;
      case "mango": inventory.Wood += 2; inventory.Fruit += 2; say("+2 Wood, +2 Mango"); beep(330, 0.12, "triangle"); break;
      case "banana": inventory.Fiber += 2; inventory.Fruit += 2; say("+2 Fiber, +2 Banana"); beep(330, 0.12, "triangle"); break;
      case "bush": inventory.Grass += 2; inventory.Fiber += 1; say("+2 Grass, +1 Fiber"); beep(300, 0.1, "triangle"); break;
      case "stone": inventory.Stone += 2; if (Math.random() < 0.3) inventory.Coal += 1; say("+2 Stone"); beep(190, 0.14, "square"); break;
      case "water": inventory.Water += 2; say("+2 Water"); beep(520, 0.15, "sine"); break;
      case "sleep":
        timeOfDay = 6.2; player.health = Math.min(100, player.health + 25); player.stamina = 100;
        say("You slept until dawn."); break;
      case "npc":
        say(npcLines[Math.floor(Math.random() * npcLines.length)]!);
        if (objective.startsWith("Explore")) objective = "Craft a campfire (3 Wood + 2 Grass).";
        break;
      case "river":
        inventory.Water += 3; say("+3 Water"); break;
    }
  }

  // crafting
  const recipes: Record<string, { cost: Record<string, number>; result: string; effect?: () => void }> = {
    "Campfire": { cost: { Wood: 3, Grass: 2 }, result: "Campfire" },
    "Torch": { cost: { Wood: 1, Fiber: 1 }, result: "Torch" },
    "Wooden Tools": { cost: { Wood: 4, Fiber: 2 }, result: "Wooden Tools" },
    "Cooked Food": { cost: { Fruit: 2, Wood: 1 }, result: "Food" },
    "Shelter": { cost: { Wood: 8, Grass: 6 }, result: "Shelter" },
    "Storage Box": { cost: { Wood: 5 }, result: "Storage Box" },
    "Bed": { cost: { Wood: 4, Grass: 4, Fiber: 2 }, result: "Bed" },
    "Fishing Rod": { cost: { Wood: 3, Fiber: 3 }, result: "Fishing Rod" },
  };
  function craft(name: string) {
    initAudio();
    const r = recipes[name];
    if (!r) return;
    for (const k in r.cost) if ((inventory[k] ?? 0) < (r.cost[k] ?? 0)) { say(`Not enough ${k}`); beep(140, 0.15, "square"); return; }
    for (const k in r.cost) inventory[k] = (inventory[k] ?? 0) - (r.cost[k] ?? 0);
    inventory[r.result] = (inventory[r.result] ?? 0) + 1;
    say(`Crafted ${name}`);
    beep(660, 0.12, "triangle"); setTimeout(() => beep(880, 0.14, "triangle"), 110);
    if (name === "Campfire") {
      placeCampfire();
      objective = "Survive the night. Explore further along the railway.";
    }
    
  }
  function placeCampfire() {
    const x = player.pos.x + Math.sin(player.yaw) * -2.5;
    const z = player.pos.z + Math.cos(player.yaw) * -2.5;
    const y = terrainHeight(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    for (let i = 0; i < 5; i++) {
      const l = box(0.16, 0.9, 0.16, M.wood, 0, 0.4, 0);
      l.rotation.set(0.5, (i / 5) * 6.28, 0);
      g.add(l);
    }
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1, 6), new THREE.MeshBasicMaterial({ color: 0xff9a3c }));
    flame.position.y = 0.9;
    g.add(flame);
    const pl = new THREE.PointLight(0xff8a33, 3, 20, 2);
    pl.position.y = 1.2;
    g.add(pl);
    campfires.push({ flame, light: pl });
    scene.add(g);
  }
  const campfires: { flame: THREE.Mesh; light: THREE.PointLight }[] = [];

  // ---------- time ----------
  let timeOfDay = 15.4; // start in warm late afternoon; dusk falls as you explore
  const DAY_SECONDS = 300;

  // ---------- collisions ----------
  function collide(nx: number, nz: number) {
    for (const s of solids) {
      const d = Math.hypot(nx - s.x, nz - s.z);
      if (d < s.r + 0.5) return true;
    }
    return false;
  }

  // ---------- loop ----------
  let last = performance.now();
  let raf = 0;
  let hudT = 0, fps = 60, frames = 0, fpsT = 0;
  let cricketT = 0, animalSoundT = 0, hornT = 12;
  let trainT = -0.35;
  let trainActive = true;

  const camOffset = new THREE.Vector3();

  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frames++; fpsT += dt;
    if (fpsT > 0.5) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }

    timeOfDay = (timeOfDay + (24 / DAY_SECONDS) * dt) % 24;

    // ----- sun / sky -----
    const sunAngle = ((timeOfDay - 6) / 24) * Math.PI * 2;
    const sunY = Math.sin(sunAngle), sunX = Math.cos(sunAngle);
    const dayness = THREE.MathUtils.clamp(sunY * 2 + 0.25, 0, 1);
    sun.position.set(player.pos.x + sunX * 120, player.pos.y + sunY * 120, player.pos.z + 40);
    sun.target.position.copy(player.pos);
    sun.intensity = dayness * 1.35;
    sun.color.setHSL(0.09, 0.5, 0.55 + dayness * 0.35);
    sunSprite.position.copy(sun.position);
    sunSprite.visible = sunY > -0.15;
    moon.position.set(player.pos.x - sunX * 400, player.pos.y - sunY * 400, player.pos.z - 120);
    moon.visible = sunY < 0.15;
    const nightness = 1 - dayness;
    hemi.intensity = 0.3 + dayness * 0.8;
    ambient.intensity = 0.28 + nightness * 0.22;
    ambient.color.setHex(nightness > 0.5 ? 0x2a3d6b : 0x556677);

    const dayTop = new THREE.Color(0x2f78c8), dayBot = new THREE.Color(0x9fc6e8);
    const nightTop = new THREE.Color(0x060f2c), nightBot = new THREE.Color(0x152344);
    const duskT = new THREE.Color(0x1e3f7a), duskB = new THREE.Color(0xd07a3c);
    const dusk = Math.max(0, 1 - Math.abs(sunY) * 6);
    const top = nightTop.clone().lerp(dayTop, dayness).lerp(duskT, dusk * 0.6);
    const bot = nightBot.clone().lerp(dayBot, dayness).lerp(duskB, dusk * 0.7);
    (skyMat.uniforms['top']!.value as THREE.Color).copy(top);
    (skyMat.uniforms['bottom']!.value as THREE.Color).copy(bot);
    skyMat.uniforms['starAmt']!.value = nightness;
    fog.color.copy(bot).multiplyScalar(0.75);
    fog.density = 0.0026 + nightness * 0.0016;
    renderer.setClearColor(fog.color);

    // village lights
    const lampOn = nightness;
    lampLights.forEach((l) => { l.light.intensity = l.base * lampOn * 1.2; });
    windowMats.forEach((m) => m.color.setRGB(1 * (0.25 + lampOn * 0.75), 0.72 * (0.25 + lampOn * 0.75), 0.35 * (0.3 + lampOn * 0.7)));
    ffMat.opacity = Math.max(0, nightness - 0.45) * 1.6;

    // ----- player movement -----
    const speedBase = keys.ShiftLeft && player.stamina > 1 ? 9.5 : 4.6;
    const forward = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const right = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    const move = new THREE.Vector3();
    if (keys.KeyW) move.add(forward);
    if (keys.KeyS) move.sub(forward);
    if (keys.KeyD) move.add(right);
    if (keys.KeyA) move.sub(right);
    const moving = move.lengthSq() > 0;
    if (moving) move.normalize().multiplyScalar(speedBase);

    if (keys.ShiftLeft && moving) player.stamina = Math.max(0, player.stamina - dt * 12);
    else player.stamina = Math.min(100, player.stamina + dt * 8);

    player.vel.y -= 22 * dt;
    if (keys.Space && player.onGround) { player.vel.y = 8.2; player.onGround = false; beep(180, 0.06, "sine", 0.02); }

    const nx = player.pos.x + move.x * dt;
    const nz = player.pos.z + move.z * dt;
    if (!collide(nx, player.pos.z)) player.pos.x = THREE.MathUtils.clamp(nx, -WORLD + 5, WORLD - 5);
    if (!collide(player.pos.x, nz)) player.pos.z = THREE.MathUtils.clamp(nz, -WORLD + 5, WORLD - 5);
    player.pos.y += player.vel.y * dt;

    const groundY = terrainHeight(player.pos.x, player.pos.z);
    const inWater = Math.abs(player.pos.z - riverZ(player.pos.x)) < RIVER_W && groundY < WATER_LEVEL();
    const feet = Math.max(groundY, inWater ? WATER_LEVEL() - 1.0 : groundY);
    if (player.pos.y < feet + 1.75) {
      player.pos.y = feet + 1.75;
      player.vel.y = 0;
      player.onGround = true;
    }

    // survival
    player.hunger = Math.max(0, player.hunger - dt * (moving ? 0.5 : 0.28));
    if (player.hunger <= 0) player.health = Math.max(0, player.health - dt * 2);
    else if (player.health < 100) player.health = Math.min(100, player.health + dt * 0.4);
    if (keys.KeyQ && (inventory.Fruit > 0 || inventory.Food > 0)) {
      keys.KeyQ = false;
      if (inventory.Food > 0) { inventory.Food--; player.hunger = Math.min(100, player.hunger + 30); }
      else { inventory.Fruit--; player.hunger = Math.min(100, player.hunger + 15); }
      say("You eat. Hunger restored."); beep(440, 0.1, "sine");
    }
    if (inWater && inventory.Water < 99) {
      // near-water interact prompt handled below
    }

    // ----- camera -----
    const eye = player.pos.clone();
    camera.rotation.set(0, 0, 0);
    camera.rotation.order = "YXZ";
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;
    if (player.third) {
      camOffset.set(Math.sin(player.yaw) * 6, 2.5 - player.pitch * 3, Math.cos(player.yaw) * 6);
      camera.position.copy(eye).add(camOffset);
    } else {
      camera.position.copy(eye);
    }
    sky.position.copy(camera.position);

    // ----- interactables -----
    currentInteract = null;
    let best = 1e9;
    for (const it of interactables) {
      const iy = it.kind === "npc" && it.obj ? it.obj.position.y : it.y;
      const ix = it.kind === "npc" && it.obj ? it.obj.position.x : it.x;
      const iz = it.kind === "npc" && it.obj ? it.obj.position.z : it.z;
      const d = Math.hypot(player.pos.x - ix, player.pos.z - iz);
      if (d < it.r && d < best && Math.abs(player.pos.y - iy) < 6) { best = d; currentInteract = it; }
    }
    if (!currentInteract) {
      const dr = Math.abs(player.pos.z - riverZ(player.pos.x));
      if (dr < RIVER_W + 4) currentInteract = { x: 0, z: 0, y: 0, r: 0, label: "Collect river water", kind: "river" };
    }

    // ----- water waves -----
    const wp = wGeo.attributes['position']! as THREE.BufferAttribute;
    for (let i = 0; i < wp.count; i++) {
      const x = wp.getX(i);
      wp.setY(i, Math.sin(now * 0.0011 + x * 0.12 + i * 0.3) * 0.18);
    }
    wp.needsUpdate = true;

    // ----- grass wind -----
    grassMat.color.setHSL(0.28, 0.35, 0.22 + dayness * 0.14);
    palmTops.rotation.y = Math.sin(now * 0.0004) * 0.02;

    // ----- npcs -----
    npcs.forEach((n, i) => {
      const p = n.g.position;
      const sleeping = nightness > 0.7;
      if (sleeping) {
        n.g.rotation.x = -Math.PI / 2.2;
        p.y = terrainHeight(p.x, p.z) + 0.5;
        return;
      }
      n.g.rotation.x = 0;
      const distToTarget = Math.hypot(p.x - n.target.x, p.z - n.target.y);
      if (distToTarget < 1.5) {
        n.target.set(n.home.x + R(-22, 22), n.home.y + R(-22, 22));
        n.talkT = Math.random() < 0.4 ? R(2, 5) : 0;
      }
      const pd = Math.hypot(p.x - player.pos.x, p.z - player.pos.z);
      if (pd < 7) {
        // face the player
        n.g.rotation.y = Math.atan2(player.pos.x - p.x, player.pos.z - p.z);
        n.talkT = 0.6;
      }
      if (n.talkT > 0) { n.talkT -= dt; n.g.position.y = terrainHeight(p.x, p.z); return; }
      const dx = n.target.x - p.x, dz = n.target.y - p.z;
      const len = Math.hypot(dx, dz) || 1;
      p.x += (dx / len) * n.speed * dt;
      p.z += (dz / len) * n.speed * dt;
      p.y = terrainHeight(p.x, p.z);
      n.g.rotation.y = Math.atan2(dx, dz);
      const sw = Math.sin(now * 0.008 + i) * 0.35;
      n.legs[0]!.rotation.x = sw; n.legs[1]!.rotation.x = -sw;
    });

    // ----- animals -----
    animals.forEach((a) => {
      const p = a.g.position;
      const sleeping = nightness > 0.75 && a.kind !== "dog";
      if (sleeping) { p.y = terrainHeight(p.x, p.z) + 0.05; a.g.rotation.z = 0.35; return; }
      a.g.rotation.z = 0;
      a.t -= dt;
      const pd = Math.hypot(p.x - player.pos.x, p.z - player.pos.z);
      if (pd < 6 && a.kind !== "dog") {
        a.target.set(p.x + (p.x - player.pos.x), p.z + (p.z - player.pos.z));
      } else if (a.kind === "dog" && pd < 18) {
        a.target.set(player.pos.x + R(-3, 3), player.pos.z + R(-3, 3));
      } else if (a.t <= 0) {
        a.t = R(3, 9);
        a.target.set(a.home.x + R(-18, 18), a.home.y + R(-18, 18));
      }
      const dx = a.target.x - p.x, dz = a.target.y - p.z;
      const len = Math.hypot(dx, dz);
      if (len > 1) {
        p.x += (dx / len) * a.speed * dt;
        p.z += (dz / len) * a.speed * dt;
        a.g.rotation.y = Math.atan2(dx, dz) - Math.PI / 2;
      }
      p.y = terrainHeight(p.x, p.z);
    });

    // ----- birds -----
    birds.forEach((b, i) => {
      const t = now * 0.00012 + i;
      const rr = 90 + (i % 5) * 25;
      b.position.set(Math.cos(t) * rr, 40 + Math.sin(t * 2 + i) * 8, Math.sin(t) * rr - 40);
      b.rotation.y = -t;
      b.visible = dayness > 0.25;
    });

    // ----- fireflies -----
    if (ffMat.opacity > 0.02) {
      const fp = ffGeo.attributes['position']! as THREE.BufferAttribute;
      for (let i = 0; i < ffCount; i++) {
        const s = ffSeed[i]!;
        fp.setY(i, terrainHeight(fp.getX(i), fp.getZ(i)) + 1.2 + Math.sin(now * 0.001 + s) * 0.8);
        fp.setX(i, fp.getX(i) + Math.sin(now * 0.0007 + s) * 0.01);
      }
      fp.needsUpdate = true;
    }

    // ----- chimney smoke -----
    chimney.forEach((s, i) => {
      const v = villages[i % villages.length]!;
      const t = ((now * 0.00012) + i * 0.13) % 1;
      s.position.set(v.x + (i * 7) % 30 - 15, terrainHeight(v.x, v.z) + 4 + t * 12, v.z + (i * 11) % 30 - 15);
      (s.material as THREE.Material).opacity = (1 - t) * 0.2;
      s.scale.setScalar(0.5 + t * 2);
    });

    // ----- train -----
    if (trainActive) {
      trainT += dt * 0.012;
      if (trainT > 1.15) { trainT = -0.4; trainActive = Math.random() < 0.85; }
      trainGroup.visible = trainT >= 0 && trainT <= 1;
      cars.forEach((c, i) => {
        const t = THREE.MathUtils.clamp(trainT - i * 0.016, 0.001, 0.999);
        const p = railCurve.getPointAt(t);
        const tan = railCurve.getTangentAt(t);
        c.position.set(p.x, railHeightAt(t), p.z);
        c.rotation.y = -Math.atan2(tan.z, tan.x);
      });
      trainHeadlight.intensity = nightness * 4;
      trainWindowMats.forEach((m) => m.color.setRGB(1, 0.78 * (0.3 + nightness * 0.7), 0.45 * (0.2 + nightness * 0.8)));
      // steam
      smokes.forEach((s, i) => {
        const age = ((now * 0.0004 + i * 0.07) % 1);
        const t = THREE.MathUtils.clamp(trainT - age * 0.05, 0.001, 0.999);
        const p = railCurve.getPointAt(t);
        s.visible = trainGroup.visible;
        s.position.set(p.x, railHeightAt(t) + 4 + age * 8, p.z + age * 2);
        (s.material as THREE.MeshLambertMaterial).opacity = (1 - age) * 0.3;
        s.scale.setScalar(0.6 + age * 2.5);
      });
      const distToTrain = cars[0]!.position.distanceTo(player.pos);
      hornT -= dt;
      if (hornT <= 0 && distToTrain < 260 && trainGroup.visible) { trainHorn(); hornT = R(14, 26); }
    } else {
      trainGroup.visible = false;
      if (Math.random() < dt * 0.05) { trainActive = true; trainT = -0.4; }
    }

    // ----- vehicles -----
    vehicles.forEach((v) => {
      v.t = (v.t + v.speed * dt) % 1;
      const p = roadCurve.getPointAt(v.t);
      const tan = roadCurve.getTangentAt(v.t);
      v.g.position.set(p.x, terrainHeight(p.x, p.z) + 0.1, p.z);
      v.g.rotation.y = -Math.atan2(tan.z, tan.x);
      v.lights.forEach((l) => (l.intensity = nightness * 3));
    });

    // ----- campfires -----
    campfires.forEach((c) => {
      c.flame.scale.y = 1 + Math.sin(now * 0.02) * 0.2;
      c.light.intensity = 2.6 + Math.sin(now * 0.017) * 0.6;
    });

    // ----- ambient sounds -----
    cricketT -= dt;
    if (cricketT <= 0 && nightness > 0.5) { cricket(); cricketT = R(0.25, 1.1); }
    animalSoundT -= dt;
    if (animalSoundT <= 0) {
      animalSoundT = R(6, 16);
      if (nightness > 0.6) { if (Math.random() < 0.5) dogBark(); }
      else if (Math.random() < 0.5) cowMoo();
    }
    if (ambientGain) ambientGain.gain.value = 0.05 + nightness * 0.03;

    renderer.render(scene, camera);

    // ----- HUD -----
    messageT -= dt;
    if (messageT <= 0) message = null;
    hudT -= dt;
    if (hudT <= 0) {
      hudT = 0.15;
      const hh = Math.floor(timeOfDay);
      const mm = Math.floor((timeOfDay % 1) * 60);
      const phase = timeOfDay < 5 || timeOfDay >= 20 ? "Night" : timeOfDay < 8 ? "Dawn" : timeOfDay < 12 ? "Morning" : timeOfDay < 17 ? "Afternoon" : timeOfDay < 19 ? "Evening" : "Dusk";
      const info = renderer.info;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      onHud({
        health: player.health, hunger: player.hunger, stamina: player.stamina,
        timeLabel: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
        dayPhase: phase,
        prompt: currentInteract ? `[E] ${currentInteract.label}` : null,
        inventory: { ...inventory },
        message, fps, objective,
        quality: qName,
        perf: showStats
          ? {
              fps,
              frameMs: Math.round((performance.now() - now) * 100) / 100,
              drawCalls: info.render.calls,
              triangles: info.render.triangles,
              programs: info.programs?.length ?? 0,
              activeNpcs,
              activeAnimals,
              visibleChunks: 0,
              quality: qName,
              resScale: Math.round(resScale * 100) / 100,
              geometries: info.memory.geometries,
              textures: info.memory.textures,
              memoryMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
            }
          : null,
      });
    }
  }
  frame();

  const onResize = () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  };
  window.addEventListener("resize", onResize);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousemove", onMouseMove);
      renderer.domElement.removeEventListener("click", onClick);
      audioCtx?.close();
      renderer.dispose();
      container.innerHTML = "";
    },
    craft,
    requestPointerLock: () => renderer.domElement.requestPointerLock(),
    setQuality: (q: string) => { if (PRESETS[q]) { autoQuality = false; applyQuality(q); } },
    toggleStats: () => { showStats = !showStats; },
  };
}
