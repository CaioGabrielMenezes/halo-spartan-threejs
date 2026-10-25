import * as THREE from 'three';

// Cenário inspirado em Halo: plataforma Forerunner no meio de colinas verdes,
// com o anel Halo e um planeta gasoso no céu. Tudo gerado no código.

export const SKY_HORIZON = 0x9fc4d8;
const SKY_ZENITH = 0x1d3f6e;
const FORERUNNER_GLOW = 0x35e0ff;

// ---------------------------------------------------------------------------
// Ruído (value noise) para o relevo e as texturas
// ---------------------------------------------------------------------------

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, octaves = 5) {
  let sum = 0;
  let amp = 0.5;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y);
    x *= 2;
    y *= 2;
    amp *= 0.5;
  }
  return sum;
}

const smoothstep = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Altura do terreno: plano perto da plataforma, colinas em volta e montanhas ao longe
export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  const hills = smoothstep(14, 45, r) * 9;
  const mountains = smoothstep(120, 450, r) * 90;
  return -0.4 + (fbm(x * 0.012 + 7, z * 0.012 + 3) - 0.35) * (hills + mountains) + mountains * 0.3;
}

// ---------------------------------------------------------------------------
// Céu
// ---------------------------------------------------------------------------

function buildSky(scene) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(4500, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        horizon: { value: new THREE.Color(SKY_HORIZON) },
        zenith: { value: new THREE.Color(SKY_ZENITH) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 horizon;
        uniform vec3 zenith;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          gl_FragColor = vec4(mix(horizon, zenith, pow(h, 0.6)), 1.0);
          #include <colorspace_fragment>
        }`,
    })
  );
  sky.renderOrder = -1; // desenha primeiro, assim o anel e o planeta ficam por cima
  scene.add(sky);

  // Estrelas fracas no alto do céu
  const count = 1500;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 0.9 + 0.25, Math.random() * 2 - 1).normalize();
    dir.multiplyScalar(4300).toArray(positions, i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.6, depthWrite: false,
  })));
}

// Textura da superfície interna do anel: terra, mar e nuvens
function ringLandTexture() {
  const w = 2048;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  // Mistura o ruído com ele mesmo deslocado de uma largura, para a textura
  // se repetir em volta do anel sem emenda
  const tiled = (fn, x, y) => fn(x, y) * (1 - x / w) + fn(x - w, y) * (x / w);
  const haze = [175, 200, 215]; // a atmosfera esmaece as cores à distância
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const land = tiled((px, py) => fbm(px * 0.01, py * 0.08), x, y);
      const cloud = tiled((px, py) => fbm(px * 0.02 + 50, py * 0.15 + 20, 4), x, y);
      let c = land > 0.5 ? [80 + land * 50, 120 + land * 40, 70] : [35, 80 + land * 50, 130 + land * 40];
      if (land > 0.68) c = [150, 140, 110];
      const k = smoothstep(0.55, 0.75, cloud);
      c = c.map((v, j) => (v * (1 - k) + 245 * k) * 0.75 + haze[j] * 0.25);
      const i = (y * w + x) * 4;
      img.data.set([c[0], c[1], c[2], 255], i);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(6, 1);
  return tex;
}

// Textura em faixas do planeta gasoso
function planetTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < 512; y++) {
    const band = fbm(0, y * 0.03, 4);
    const r = 170 + band * 80;
    const g = 120 + band * 70;
    const b = 80 + band * 50;
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(0, y, 64, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildHaloRing(scene) {
  // Largura exagerada (≈ 7% do raio) para a faixa de terra aparecer de longe
  const radius = 3000;
  const width = 220;
  const group = new THREE.Group();

  const inner = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, width, 360, 1, true),
    new THREE.MeshBasicMaterial({ map: ringLandTexture(), side: THREE.BackSide, fog: false, color: 0xdde6ee })
  );
  const outer = new THREE.Mesh(
    new THREE.CylinderGeometry(radius + 4, radius + 4, width, 360, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x6f7a86, side: THREE.FrontSide, fog: false })
  );
  // Paredes nas bordas que seguram a atmosfera do anel
  const wallMat = new THREE.MeshBasicMaterial({ color: 0x8994a0, side: THREE.DoubleSide, fog: false });
  for (const y of [-width / 2, width / 2]) {
    const wall = new THREE.Mesh(new THREE.RingGeometry(radius - 10, radius + 4, 360, 1), wallMat);
    wall.rotation.x = Math.PI / 2;
    wall.position.y = y;
    group.add(wall);
  }
  group.add(inner, outer);

  // Arco subindo do horizonte, como um arco-íris, cruzando a tela de ponta a ponta.
  // O anel fica de frente para a câmera e levemente inclinado para mostrar a faixa de terra.
  group.position.set(0, -2100, -1500);
  group.rotation.set(Math.PI / 2 - 0.35, 0, 0.06); // topo inclinado para longe, mostrando a faixa de terra
  scene.add(group);
}

function buildPlanet(scene) {
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(140, 64, 32),
    new THREE.MeshLambertMaterial({ map: planetTexture(), fog: false })
  );
  planet.position.set(-760, 330, -1700);
  planet.rotation.z = 0.35;
  scene.add(planet);
}

// ---------------------------------------------------------------------------
// Terreno, rochas e árvores
// ---------------------------------------------------------------------------

function buildTerrain(scene) {
  const size = 3000;
  const geo = new THREE.PlaneGeometry(size, size, 300, 300);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const grass = new THREE.Color(0x4f7a3a);
  const grassDark = new THREE.Color(0x355a2a);
  const rock = new THREE.Color(0x7d7a70);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    c.copy(grassDark).lerp(grass, noise(x * 0.08, z * 0.08));
    c.lerp(rock, smoothstep(25, 70, y));
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  terrain.receiveShadow = true;
  scene.add(terrain);
}

// Distribui objetos num anel em volta da plataforma
function scatter(count, minR, maxR, seed) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = hash(i, seed) * Math.PI * 2;
    const r = minR + (maxR - minR) * Math.sqrt(hash(seed, i + 0.5));
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    out.push({ x, z, y: terrainHeight(x, z), s: 0.6 + hash(i + 3, seed) * 0.9, rot: hash(i, i + seed) * Math.PI * 2 });
  }
  return out;
}

function buildTrees(scene) {
  const spots = scatter(220, 22, 160, 11);
  const leaves = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.6, 6, 7),
    new THREE.MeshStandardMaterial({ color: 0x2f5a2c, roughness: 0.9, flatShading: true }),
    spots.length
  );
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.2, 0.3, 2, 6),
    new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 }),
    spots.length
  );
  const m = new THREE.Matrix4();
  spots.forEach((p, i) => {
    const s = p.s * 1.3;
    m.compose(new THREE.Vector3(p.x, p.y + 1 * s, p.z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(p.x, p.y + 4.5 * s, p.z), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    leaves.setMatrixAt(i, m);
  });
  leaves.castShadow = trunks.castShadow = true;
  scene.add(leaves, trunks);
}

function buildRocks(scene) {
  const spots = scatter(70, 11, 90, 23);
  const rocks = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ color: 0x8a877d, roughness: 0.95, flatShading: true }),
    spots.length
  );
  const m = new THREE.Matrix4();
  spots.forEach((p, i) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rot, p.rot * 2, 0));
    m.compose(new THREE.Vector3(p.x, p.y + 0.2, p.z), q, new THREE.Vector3(p.s * 1.4, p.s, p.s * 1.2));
    rocks.setMatrixAt(i, m);
  });
  rocks.castShadow = rocks.receiveShadow = true;
  scene.add(rocks);
}

// ---------------------------------------------------------------------------
// Estruturas Forerunner
// ---------------------------------------------------------------------------

const metal = new THREE.MeshStandardMaterial({ color: 0x5d646e, metalness: 0.6, roughness: 0.35 });
const metalDark = new THREE.MeshStandardMaterial({ color: 0x343940, metalness: 0.6, roughness: 0.4 });
const glow = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: FORERUNNER_GLOW, emissiveIntensity: 3 });

function buildPlatform(scene) {
  const group = new THREE.Group();
  // Base hexagonal em dois níveis; o topo fica em y = 0, onde o Spartan pisa
  const base = new THREE.Mesh(new THREE.CylinderGeometry(7.6, 8.4, 1.2, 6), metalDark);
  base.position.y = -0.75;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 7.0, 0.3, 6), metal);
  top.position.y = -0.15;
  base.receiveShadow = top.receiveShadow = true;
  group.add(base, top);

  // Linhas de luz no piso
  const line = (inner, outer, segments) => {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, segments), glow);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.005;
    return mesh;
  };
  const hexLine = line(5.7, 5.85, 6);
  hexLine.rotation.z = Math.PI / 2;
  group.add(hexLine, line(1.7, 1.8, 48));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const ray = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.01, 3.8), glow);
    ray.position.set(Math.sin(a) * 3.75, 0.005, Math.cos(a) * 3.75);
    ray.rotation.y = a;
    group.add(ray);
  }
  // Faixa de luz em volta da borda
  const edge = new THREE.Mesh(new THREE.CylinderGeometry(7.65, 7.65, 0.08, 6, 1, true), glow);
  edge.position.y = -0.35;
  group.add(edge);
  scene.add(group);
}

// Pilar Forerunner: blocos empilhados afinando para cima, com frestas de luz
function pillar(height) {
  const group = new THREE.Group();
  let y = 0;
  let w = 1.4;
  for (const part of [0.45, 0.35, 0.2]) {
    const h = height * part;
    const block = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.7), metal);
    block.position.y = y + h / 2;
    block.castShadow = block.receiveShadow = true;
    const slit = new THREE.Mesh(new THREE.BoxGeometry(w * 0.86, 0.12, w * 0.7 + 0.02), glow);
    slit.position.y = y + h + 0.06;
    group.add(block, slit);
    y += h + 0.12;
    w *= 0.72;
  }
  return group;
}

function buildPillars(scene) {
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2; // nenhum pilar fica bem atrás do Spartan na vista inicial
    const r = 11;
    const p = pillar(5 + (i % 2) * 2.5);
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    p.position.set(x, terrainHeight(x, z) - 0.3, z);
    p.rotation.y = a;
    p.rotation.x = -0.08; // levemente inclinado para dentro
    scene.add(p);
  }
}

// Torre ao longe com o feixe de luz subindo para o céu
function buildTower(scene, viewYaw) {
  const group = new THREE.Group();
  const core = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 9, 70, 4), metal);
  core.position.y = 35;
  core.rotation.y = Math.PI / 4;
  group.add(core);
  // Asas em "V", típicas da arquitetura Forerunner
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(5, 60, 3), metalDark);
    wing.position.set(side * 12, 30, 0);
    wing.rotation.z = side * 0.35;
    group.add(wing);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.6, 50, 3.1), glow);
    strip.position.copy(wing.position);
    strip.rotation.z = wing.rotation.z;
    group.add(strip);
  }
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.6, 1.6, 2000, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: FORERUNNER_GLOW, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  );
  beam.position.y = 70 + 1000;
  group.add(beam);

  // Um pouco à direita da direção da câmera
  const spot = new THREE.Vector3(68, 0, -209).applyAxisAngle(new THREE.Vector3(0, 1, 0), viewYaw);
  group.position.set(spot.x, terrainHeight(spot.x, spot.z) - 2, spot.z);
  group.rotation.y = viewYaw;
  scene.add(group);
  return beam;
}

// viewYaw: para onde a câmera inicial olha. Anel, planeta e torre são posicionados
// como se a câmera olhasse para -Z e depois girados para ficarem na frente dela.
export function buildScenery(scene, viewYaw = 0) {
  scene.background = new THREE.Color(SKY_HORIZON);
  scene.fog = new THREE.Fog(SKY_HORIZON, 60, 700);
  buildSky(scene);
  const farSky = new THREE.Group();
  farSky.rotation.y = viewYaw;
  scene.add(farSky);
  buildHaloRing(farSky);
  buildPlanet(farSky);
  buildTerrain(scene);
  buildTrees(scene);
  buildRocks(scene);
  buildPlatform(scene);
  buildPillars(scene);
  const beam = buildTower(scene, viewYaw);

  // As luzes Forerunner "respiram" devagar
  return {
    update(time) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 1.5);
      glow.emissiveIntensity = 1.6 + pulse * 0.8;
      beam.material.opacity = 0.4 + pulse * 0.25;
    },
  };
}
