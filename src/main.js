import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const MODEL_URL = import.meta.env.BASE_URL + 'models/halo_mk_v_model.glb';
// Se o personagem aparecer de costas, troque para Math.PI
const MODEL_ROTATION_Y = 0;
const FADE = 0.4;
const DEG = Math.PI / 180;

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Cena
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a4a5c);
scene.fog = new THREE.Fog(0x3a4a5c, 10, 35);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(2.5, 1.8, 4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.update();

// Luzes
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a6470, 2));

// Luz de preenchimento pela frente, para a armadura não ficar escura
const fill = new THREE.DirectionalLight(0xdde8ff, 1.2);
fill.position.set(-3, 3, 5);
scene.add(fill);

const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -5;
sun.shadow.camera.right = 5;
sun.shadow.camera.top = 5;
sun.shadow.camera.bottom = -5;
scene.add(sun);

// Chão
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(50, 50),
  new THREE.MeshStandardMaterial({ color: 0x4a5866, roughness: 0.9 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(50, 50, 0x6fcf7f, 0x5f7a66);
grid.material.opacity = 0.35;
grid.material.transparent = true;
scene.add(grid);

// ---------------------------------------------------------------------------
// Ossos
// Tudo é medido no espaço do "character": frente = +Z, cima = +Y,
// direita do personagem = -X. Assim as poses independem de como o rig foi feito.
// ---------------------------------------------------------------------------

// Rig estilo Rigify (Blender). O GLTFLoader remove os pontos dos nomes:
// "spine.001_51" vira "spine001_51". spine = quadril, spine.001-.003 = tronco,
// spine.004 = pescoço, spine.006 = cabeça.
function findBones(root) {
  const bones = [];
  root.traverse((o) => o.isBone && bones.push(o));
  const find = (re) => bones.find((b) => re.test(b.name));
  const arm = (side) => ({
    upper: find(new RegExp(`^upper_arm\\.?${side}_`)),
    fore: find(new RegExp(`^forearm\\.?${side}_`)),
    hand: find(new RegExp(`^hand\\.?${side}_`)),
  });
  const leg = (side) => ({
    thigh: find(new RegExp(`^thigh\\.?${side}_`)),
    shin: find(new RegExp(`^shin\\.?${side}_`)),
    foot: find(new RegExp(`^foot\\.?${side}_`)),
  });

  return {
    all: bones,
    hips: find(/^spine_/),
    spine: [/^spine\.?001_/, /^spine\.?002_/, /^spine\.?003_/].map(find).filter(Boolean),
    neck: find(/^spine\.?004_/),
    head: find(/^spine\.?006_/),
    armR: arm('R'),
    armL: arm('L'),
    legR: leg('R'),
    legL: leg('L'),
  };
}

// No arquivo o personagem está virado de lado; calcula o giro para ele olhar para +Z
function facingYaw(model) {
  model.updateMatrixWorld(true);
  const pos = (re) => {
    let bone;
    model.traverse((o) => { if (o.isBone && re.test(o.name)) bone = o; });
    return bone?.getWorldPosition(new THREE.Vector3());
  };
  const left = pos(/^upper_arm\.?L_/);
  const right = pos(/^upper_arm\.?R_/);
  if (!left || !right) return 0;
  const v = left.sub(right); // ombro direito -> ombro esquerdo
  return Math.atan2(-v.z, v.x); // frente = v × cima = (-v.z, 0, v.x)
}

// Guarda a pose de repouso de cada osso usado
function captureRest(bones) {
  const rest = new Map();
  const save = (b) => {
    if (b && !rest.has(b)) {
      rest.set(b, { local: b.quaternion.clone(), world: b.getWorldQuaternion(new THREE.Quaternion()) });
    }
  };
  const p = (b) => b.getWorldPosition(new THREE.Vector3());
  [...bones.spine, bones.neck, bones.head].forEach(save);
  for (const arm of [bones.armR, bones.armL]) {
    if (!arm?.upper) continue;
    save(arm.upper);
    save(arm.fore);
    rest.get(arm.upper).dir = p(arm.fore).sub(p(arm.upper)).normalize();
    rest.get(arm.fore).dir = p(arm.hand).sub(p(arm.fore)).normalize();
  }
  for (const leg of [bones.legR, bones.legL]) {
    if (!leg?.thigh) continue;
    [leg.thigh, leg.shin, leg.foot].forEach(save);
    const hip = p(leg.thigh);
    const knee = p(leg.shin);
    const ankle = p(leg.foot);
    Object.assign(rest.get(leg.thigh), { hip, ankle, len: knee.distanceTo(hip), dir: knee.clone().sub(hip).normalize() });
    Object.assign(rest.get(leg.shin), { len: ankle.distanceTo(knee), dir: ankle.clone().sub(knee).normalize() });
  }
  return rest;
}

// IK de 2 ossos: acha o joelho para o tornozelo chegar em "target" (joelho aponta para frente)
function solveLeg(hip, target, a, b) {
  const toTarget = target.clone().sub(hip);
  const d = THREE.MathUtils.clamp(toTarget.length(), Math.abs(a - b) + 1e-4, a + b - 1e-4);
  const u = toTarget.normalize();
  const pole = new THREE.Vector3(0, 0, 1);
  const w = pole.sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
  const cos = (a * a + d * d - b * b) / (2 * a * d);
  const knee = hip.clone()
    .add(u.clone().multiplyScalar(a * cos))
    .add(w.multiplyScalar(a * Math.sqrt(1 - cos * cos)));
  const ankle = hip.clone().add(u.multiplyScalar(d));
  return { thigh: knee.clone().sub(hip).normalize(), shin: ankle.sub(knee).normalize() };
}

// Aplica uma rotação "d" (no espaço do personagem) sobre a pose de repouso do osso
function localFromDelta(rest, d) {
  const wInv = rest.world.clone().invert();
  return rest.local.clone().multiply(wInv.multiply(d).multiply(rest.world));
}

const euler = ([x, y, z], scale = 1) =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(x * DEG * scale, y * DEG * scale, z * DEG * scale));

// Direção do braço: [para fora do corpo, para cima, para frente]
const armDir = ([out, up, fwd], side) => new THREE.Vector3(side === 'R' ? -out : out, up, fwd).normalize();

// ---------------------------------------------------------------------------
// Poses e animações
// ---------------------------------------------------------------------------

const RELAXED = { upper: [0.12, -1, 0.05], fore: [0.05, -1, 0.2] };
const READY_R = { upper: [0.2, -0.9, 0.35], fore: [-0.45, -0.15, 1] };
const READY_L = { upper: [0.15, -0.85, 0.45], fore: [-0.55, 0, 1] };
const GUARD = { upper: [0.25, -0.75, 0.45], fore: [-0.25, 0.7, 0.6] };
// Cotovelo aberto para o lado, pontas dos dedos na aba direita do capacete
const SALUTE = { upper: [0.9, 0.27, 0.36], fore: [-0.72, 0.64, 0.27] };
const PUNCH = { upper: [0.05, 0.05, 1], fore: [0, 0.05, 1] };
const PULL = { upper: [0.3, -0.8, 0.1], fore: [0.1, 0.2, 0.8] };
// Pés: deslocamento [x, y, z] do tornozelo em relação ao repouso
const STANCE = { L: [0, 0, 0.1], R: [0, 0, -0.1] };
const LUNGE = { L: [0, 0, 0.5], R: [0, 0, -0.1] };

// Caminhada de soldado no lugar (como uma esteira): cada pé fica 60% do ciclo no chão
// deslizando para trás e 40% no ar voltando para frente. Cadência de marcha
// (2 passos por segundo), tronco reto e pés embaixo dos quadris (footWidth).
const WALK = { period: 1, halfStride: 0.18, stance: 0.6, footWidth: 0.02 };

function walkKeys(samples = 20) {
  const { period, halfStride: L, stance } = WALK;
  const foot = (phase) => {
    const ph = phase % 1;
    if (ph < stance) return [0, 0, L - (2 * L * ph) / stance];
    const s = (ph - stance) / (1 - stance);
    return [0, 0.1 * Math.sin(Math.PI * s), -L + 2 * L * s * s * (3 - 2 * s)];
  };
  const keys = [];
  for (let i = 0; i <= samples; i++) {
    const ph = i / samples;
    const footL = foot(ph);
    const footR = foot(ph + 0.5);
    // Braço acompanha a perna oposta; o antebraço dobra mais quando vai para frente
    const arm = (z) => {
      const swing = 0.45 * (z / L);
      return { upper: [0.15, -1, swing], fore: [0.05, -1, 0.35 + Math.max(swing, 0) * 1.4] };
    };
    const twist = 5 * (footL[2] / L);
    keys.push({
      t: ph * period,
      // Pernas quase retas: o corpo só abaixa um pouco quando o calcanhar toca o chão
      root: [0, -0.006 - 0.008 * Math.cos(4 * Math.PI * ph), 0],
      feet: { L: footL, R: footR },
      torso: [-4, twist, 0], // o modelo já vem inclinado 4° para frente
      head: [0, -twist, 0],
      armR: arm(footL[2]),
      armL: arm(footR[2]),
    });
  }
  return keys;
}

const ANIMATIONS = {
  // Caminhada no lugar
  andar: { duration: WALK.period, footWidth: WALK.footWidth, keys: walkKeys() },

  // Postura de combate: respira e varre o campo de batalha com o olhar
  alerta: {
    duration: 6,
    keys: [
      { t: 0, torso: [0, 0, 0], head: [5, 0, 0], armR: READY_R, armL: READY_L },
      { t: 1.2, torso: [3, 8, 0], head: [5, 35, 0], armR: READY_R, armL: READY_L },
      { t: 2.2, torso: [1, 8, 0], head: [3, 35, 0], armR: READY_R, armL: READY_L },
      { t: 3.4, torso: [3, -8, 0], head: [5, -35, 0], armR: READY_R, armL: READY_L },
      { t: 4.4, torso: [1, -8, 0], head: [8, -30, 0], armR: READY_R, armL: READY_L },
      { t: 6, torso: [0, 0, 0], head: [5, 0, 0], armR: READY_R, armL: READY_L },
    ],
  },

  // Continência militar do Spartan
  saudacao: {
    duration: 4,
    keys: [
      { t: 0, armR: RELAXED, armL: RELAXED },
      { t: 0.25, torso: [-2, 0, 0], head: [-3, 0, 0], armR: RELAXED, armL: RELAXED },
      { t: 0.75, torso: [-3, 0, 0], head: [-6, 0, 0], armR: SALUTE, armL: RELAXED },
      { t: 2.4, torso: [-3, 0, 0], head: [-6, 0, 0], armR: SALUTE, armL: RELAXED },
      { t: 3.0, armR: RELAXED, armL: RELAXED },
      { t: 4, armR: RELAXED, armL: RELAXED },
    ],
  },

  // Golpe corpo a corpo (o famoso "melee" do Halo): passo à frente com a perna
  // esquerda, perna direita plantada atrás, corpo abaixa no impacto
  golpe: {
    duration: 1.8,
    keys: [
      { t: 0, torso: [5, 0, 0], root: [0, -0.04, 0], feet: STANCE, armR: GUARD, armL: GUARD },
      { t: 0.3, torso: [3, -28, 0], head: [0, 20, 0], root: [0, -0.06, -0.02], feet: { L: [0, 0.12, 0.2], R: STANCE.R }, armR: { upper: [0.45, -0.35, -0.6], fore: [-0.1, 0.25, 1] }, armL: GUARD },
      { t: 0.5, torso: [14, 22, 0], head: [-5, -15, 0], root: [0, -0.1, 0.28], feet: LUNGE, armR: PUNCH, armL: PULL },
      { t: 0.75, torso: [12, 18, 0], head: [-5, -12, 0], root: [0, -0.1, 0.28], feet: LUNGE, armR: PUNCH, armL: PULL },
      { t: 1.05, torso: [8, 8, 0], root: [0, -0.07, 0.14], feet: { L: [0, 0.1, 0.3], R: STANCE.R }, armR: GUARD, armL: GUARD },
      { t: 1.35, torso: [5, 0, 0], root: [0, -0.04, 0], feet: STANCE, armR: GUARD, armL: GUARD },
      { t: 1.8, torso: [5, 0, 0], root: [0, -0.04, 0], feet: STANCE, armR: GUARD, armL: GUARD },
    ],
  },
};

function buildClip(name, { duration, keys, footWidth }, bones, rest) {
  const times = keys.map((k) => k.t);
  const tracks = [];
  const quatTrack = (bone, fn) => {
    if (!bone || !rest.has(bone)) return;
    const values = keys.flatMap((k) => localFromDelta(rest.get(bone), fn(k)).toArray());
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
  };

  // Tronco: rotação dividida entre os ossos da coluna (o peito do rig estica fácil)
  const n = bones.spine.length || 1;
  bones.spine.forEach((b) => quatTrack(b, (k) => euler(k.torso ?? [0, 0, 0], 1 / n)));

  // Cabeça: metade no pescoço, metade na cabeça
  const headShare = bones.neck ? 0.5 : 1;
  quatTrack(bones.neck, (k) => euler(k.head ?? [0, 0, 0], 0.5));
  quatTrack(bones.head, (k) => euler(k.head ?? [0, 0, 0], headShare));

  // Braços: cada pose diz para onde o braço e o antebraço apontam
  for (const side of ['R', 'L']) {
    const arm = bones['arm' + side];
    if (!arm?.upper) continue;
    const upperRest = rest.get(arm.upper);
    const foreRest = rest.get(arm.fore);
    const upperDeltas = keys.map((k) =>
      new THREE.Quaternion().setFromUnitVectors(upperRest.dir, armDir((k['arm' + side] ?? RELAXED).upper, side))
    );
    quatTrack(arm.upper, (k) => upperDeltas[keys.indexOf(k)]);
    quatTrack(arm.fore, (k) => {
      const target = armDir((k['arm' + side] ?? RELAXED).fore, side);
      target.applyQuaternion(upperDeltas[keys.indexOf(k)].clone().invert());
      return new THREE.Quaternion().setFromUnitVectors(foreRest.dir, target);
    });
  }

  // Pernas: "feet" diz quanto cada tornozelo se desloca no mundo. Como o "root" move o
  // corpo todo, ele é descontado; assim um pé com [0, 0, 0] fica plantado no chão.
  for (const side of ['R', 'L']) {
    const leg = bones['leg' + side];
    if (!leg?.thigh || !keys.some((k) => k.feet)) continue;
    const thighRest = rest.get(leg.thigh);
    const shinRest = rest.get(leg.shin);
    const thighDeltas = [];
    const shinDeltas = [];
    for (const k of keys) {
      const target = thighRest.ankle.clone()
        .add(new THREE.Vector3(...(k.feet?.[side] ?? [0, 0, 0])))
        .sub(new THREE.Vector3(...(k.root ?? [0, 0, 0])));
      // O modelo fica de pernas abertas (e com o pé direito mais atrás) no repouso;
      // footWidth mede a posição do pé a partir do quadril em vez do repouso
      if (footWidth !== undefined) {
        target.x = thighRest.hip.x + (side === 'L' ? footWidth : -footWidth);
        target.z += thighRest.hip.z - thighRest.ankle.z;
      }
      const dirs = solveLeg(thighRest.hip, target, thighRest.len, shinRest.len);
      const qThigh = new THREE.Quaternion().setFromUnitVectors(thighRest.dir, dirs.thigh);
      const qShin = new THREE.Quaternion().setFromUnitVectors(shinRest.dir, dirs.shin.applyQuaternion(qThigh.clone().invert()));
      thighDeltas.push(qThigh);
      shinDeltas.push(qShin);
    }
    const i = (k) => keys.indexOf(k);
    quatTrack(leg.thigh, (k) => thighDeltas[i(k)]);
    quatTrack(leg.shin, (k) => shinDeltas[i(k)]);
    // Desfaz a rotação da perna no pé para ele continuar reto no chão
    quatTrack(leg.foot, (k) => thighDeltas[i(k)].clone().multiply(shinDeltas[i(k)]).invert());
  }

  // Deslocamento do personagem inteiro ("" = raiz do mixer)
  if (keys.some((k) => k.root)) {
    tracks.push(new THREE.VectorKeyframeTrack('.position', times, keys.flatMap((k) => k.root ?? [0, 0, 0])));
  }

  return new THREE.AnimationClip(name, duration, tracks);
}

// ---------------------------------------------------------------------------
// Carregamento
// ---------------------------------------------------------------------------

const loadingEl = document.getElementById('loading');
const buttons = document.querySelectorAll('#controls button');


let mixer;
const actions = {};
let current;

function play(name) {
  const next = actions[name];
  if (!next || next === current) return;
  next.reset().fadeIn(FADE).play();
  if (current) current.fadeOut(FADE);
  current = next;
  buttons.forEach((b) => b.classList.toggle('active', b.dataset.anim === name));
}

async function init() {
  try {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL, (e) => {
      if (e.total) loadingEl.textContent = `Carregando… ${Math.round((e.loaded / e.total) * 100)}%`;
    });
    const model = gltf.scene;
    model.rotation.y = -facingYaw(model) + MODEL_ROTATION_Y;

    // Escala para ~1.8 de altura e apoia no chão
    const box = new THREE.Box3().setFromObject(model);
    model.scale.multiplyScalar(1.8 / (box.max.y - box.min.y));
    box.setFromObject(model);
    model.position.y -= box.min.y;
    model.position.x -= (box.min.x + box.max.x) / 2;
    model.position.z -= (box.min.z + box.max.z) / 2;

    model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.frustumCulled = false;
      }
    });

    const character = new THREE.Group();
    character.add(model);
    scene.add(character);
    character.updateMatrixWorld(true);

    const bones = findBones(character);
    console.log('Ossos do modelo:', bones.all.map((b) => b.name));
    console.log('Ossos usados:', {
      hips: bones.hips?.name,
      spine: bones.spine.map((b) => b.name),
      neck: bones.neck?.name,
      head: bones.head?.name,
      armR: bones.armR && [bones.armR.upper?.name, bones.armR.fore?.name, bones.armR.hand?.name],
      armL: bones.armL && [bones.armL.upper?.name, bones.armL.fore?.name, bones.armL.hand?.name],
    });

    const rest = captureRest(bones);
    mixer = new THREE.AnimationMixer(character);
    for (const [name, def] of Object.entries(ANIMATIONS)) {
      actions[name] = mixer.clipAction(buildClip(name, def, bones, rest));
    }

    play('alerta');
    loadingEl.remove();
  } catch (err) {
    console.error(err);
    loadingEl.textContent = `Erro ao carregar o modelo. Coloque o arquivo em public/models/halo_mk_v_model.glb. (${err.message})`;
  }
}

buttons.forEach((b) => b.addEventListener('click', () => play(b.dataset.anim)));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Loop
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);
  controls.update();
  renderer.render(scene, camera);
});

init();
