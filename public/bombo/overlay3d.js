/* Pantalla 3D para OBS: bombos de vidrio con física 3D (cannon-es) renderizados con three.js.
 * Mismo control en tiempo real que overlay.html; el resultado lo decide el servidor. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as CANNON from '/vendor/cannon-es.js';

const { Sfx, Confetti } = window.Bombo;
const W = 1920, H = 1080;
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const transparent = params.get('transparent') === '1';
const LOW = params.get('quality') === 'low';
if (transparent) document.body.classList.add('transparent');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const shortCode = (c) => String(Number(String(c).split('-')[1] || c));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Escalado del escenario ----------
const stage = $('#stage');
function fit() { stage.style.transform = `translate(-50%, -50%) scale(${Math.min(innerWidth / W, innerHeight / H)})`; }
addEventListener('resize', fit); fit();

// ---------- Renderer ----------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: transparent, powerPreference: 'high-performance' });
} catch (e) {
  $('#err').textContent = 'Este navegador no tiene WebGL. Usa /overlay.html (versión 2D) o activa la aceleración por hardware en OBS.';
  $('#err').classList.remove('hidden');
  throw e;
}
const PR = clamp(Number(params.get('pr')) || 1, 0.25, 2); // resolución interna (1 = 1080p)
renderer.setPixelRatio(PR);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
$('#gl').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.75;
if (!transparent) {
  // fondo de estudio: degradado oscuro con un leve foco al centro
  const c = document.createElement('canvas'); c.width = 16; c.height = 512;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, '#0a1222'); gr.addColorStop(0.55, '#060a14'); gr.addColorStop(1, '#020409');
  g.fillStyle = gr; g.fillRect(0, 0, 16, 512);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
}

const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
camera.position.set(0, 0.4, 10.5);
const camBase = new THREE.Vector3(0, 1.0, 12.2); // posición "de riel"; el balanceo y el acercamiento se suman cada cuadro
const camTarget = new THREE.Vector3(0, -0.25, 0);

// ---------- Luces ----------
const key = new THREE.SpotLight(0xffffff, 55, 0, Math.PI / 9, 0.8, 2);
key.position.set(1.5, 7, 5.5); key.target.position.set(0, -0.5, 0);
key.castShadow = true; key.shadow.mapSize.set(LOW ? 1024 : 2048, LOW ? 1024 : 2048); key.shadow.bias = -0.0004; key.shadow.radius = 4;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0x9db8ff, 0.5); fill.position.set(-6, 3, 4); scene.add(fill);
scene.add(new THREE.HemisphereLight(0x8fa6d6, 0x020306, 0.25));

// piso con reflejo suave
// Piso: oscuro con una zona de luz suave bajo los bombos (no depende de las luces) + capa que solo recibe sombras.
const floorTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d');
  let gr = g.createRadialGradient(512, 512, 0, 512, 512, 512);
  gr.addColorStop(0, '#1a2233'); gr.addColorStop(0.35, '#0c111c'); gr.addColorStop(0.75, '#05080f'); gr.addColorStop(1, '#04070e');
  g.fillStyle = gr; g.fillRect(0, 0, 1024, 1024);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const floor = new THREE.Mesh(new THREE.CircleGeometry(16, 64), new THREE.MeshBasicMaterial({ map: floorTex }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -1.78;
const shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(8, 64), new THREE.ShadowMaterial({ opacity: 0.55 }));
shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.y = -1.775; shadowCatcher.receiveShadow = true;
if (!transparent) { scene.add(floor, shadowCatcher); scene.fog = new THREE.Fog(0x04070e, 13, 24); }

// ---------- Materiales ----------
const chrome = new THREE.MeshPhysicalMaterial({ color: 0xb9c1cd, metalness: 1, roughness: 0.24, clearcoat: 0.4, envMapIntensity: 0.8 });
const blackGloss = new THREE.MeshPhysicalMaterial({ color: 0x0b0e15, metalness: 0.3, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 });
// Vidrio: solo se SUMAN los reflejos del estudio y un brillo de borde (efecto Fresnel), como el vidrio real
// sobre fondo oscuro. Así no queda velo blanco y los números de adentro se leen nítidos.
const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0x000000, metalness: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.4,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
});
const fresnelMat = new THREE.ShaderMaterial({
  uniforms: { tint: { value: new THREE.Color(0xcfe0ff) }, power: { value: 2.6 }, strength: { value: 0.55 } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal);
      vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: `uniform vec3 tint; uniform float power; uniform float strength; varying vec3 vN; varying vec3 vV;
    void main() { float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), power); gl_FragColor = vec4(tint * f * strength, 1.0); }`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});

const PALETTES = {
  A: ['#f2711c', '#6d28d9', '#e85d04', '#8b2fd6', '#f59e0b', '#5b21b6'],
  B: ['#1d63d6', '#0891b2', '#059669', '#2453c9', '#0ea5e9', '#0f9f6e'],
};
const ACCENT = { A: 0xf08a24, B: 0x3aa0e6 };
const R_IN = 1.0;

// textura de pelotita: color de plástico + círculo blanco con número en ambos lados
const texCache = new Map();
function ballTexture(color, text) {
  const k = color + '|' + text;
  if (texCache.has(k)) return texCache.get(k);
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 512, 256);
  for (const cx of [128, 384]) {
    g.fillStyle = '#fbfbf7';
    g.beginPath(); g.ellipse(cx, 128, 74, 74, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#111';
    let fs = text.length > 3 ? 64 : 84;
    g.font = `800 ${fs}px "Segoe UI", Arial, sans-serif`;
    const w = g.measureText(text).width; if (w > 120) { fs *= 120 / w; g.font = `800 ${fs}px "Segoe UI", Arial, sans-serif`; }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, cx, 132);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  texCache.set(k, t);
  return t;
}
const ballGeo = new THREE.SphereGeometry(1, LOW ? 20 : 32, LOW ? 14 : 24);

function plate(text, accent) { // placa frontal de la base
  const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#0b0e15'; g.fillRect(0, 0, 1024, 160);
  g.fillStyle = accent; g.fillRect(0, 150, 1024, 10);
  g.fillStyle = '#f1f3f7'; g.font = '700 74px "Segoe UI", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 512, 78);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.17), new THREE.MeshStandardMaterial({ map: t, roughness: 0.4, metalness: 0.2 }));
}

// ================= Bombo 3D =================
class Drum3D {
  constructor(urn, x, sfx) {
    this.urn = urn; this.sfx = sfx; this.x = x;
    this.group = new THREE.Group(); this.group.position.set(x, 0, 0); scene.add(this.group);
    this.mix = 0.12; this.mixTarget = 0.12; this.t = 0; this.balls = []; this.capture = null; this.audible = true;
    this.buildModel();
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.solver.iterations = LOW ? 6 : 10;
    this.world.defaultContactMaterial.restitution = 0.55;
    this.world.defaultContactMaterial.friction = 0.03;
    this.world.addEventListener('beginContact', (e) => {
      if (!this.audible) return;
      const a = e.bodyA.velocity, b = e.bodyB.velocity;
      const dv = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      this.sfx.click(clamp((dv - 0.6) / 5, 0, 1) * 0.8);
    });
  }
  buildModel() {
    const g = this.group;
    // esfera de vidrio con abertura arriba
    const sphereGeo = new THREE.SphereGeometry(R_IN + 0.02, 96, 64, 0, Math.PI * 2, 0.13, Math.PI - 0.13);
    const glass = new THREE.Mesh(sphereGeo, glassMat); glass.renderOrder = 2; g.add(glass);
    const rimGlow = new THREE.Mesh(sphereGeo, fresnelMat); rimGlow.renderOrder = 3; g.add(rimGlow);
    // cuna metálica donde se apoya la esfera
    const cradleY = -0.86, cradleR = Math.sqrt(1 - cradleY * cradleY) * (R_IN + 0.03);
    const cradle = new THREE.Mesh(new THREE.TorusGeometry(cradleR, 0.03, 16, 96), chrome);
    cradle.rotation.x = Math.PI / 2; cradle.position.y = cradleY * R_IN; cradle.castShadow = true; g.add(cradle);
    for (let i = 0; i < 3; i++) { // tres brazos de la cuna
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.3, 12), chrome);
      arm.position.set(Math.cos(a) * cradleR * 0.75, cradleY * R_IN - 0.14, Math.sin(a) * cradleR * 0.75);
      arm.rotation.z = Math.cos(a) * 0.5; arm.rotation.x = -Math.sin(a) * 0.5; g.add(arm);
    }
    // boca superior y tubo de salida
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.12, 48, 1, true), chrome);
    collar.position.y = R_IN - 0.01; g.add(collar);
    this.tubeCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, R_IN - 0.05, 0), new THREE.Vector3(0, R_IN + 0.35, 0),
      new THREE.Vector3(0.18, R_IN + 0.62, 0.12), new THREE.Vector3(0.62, R_IN + 0.72, 0.4), new THREE.Vector3(1.05, R_IN + 0.62, 0.75),
    ]);
    const tubeGeo = new THREE.TubeGeometry(this.tubeCurve, 80, 0.13, 32, false);
    const tube = new THREE.Mesh(tubeGeo, glassMat); tube.renderOrder = 3; g.add(tube);
    const tubeRim = new THREE.Mesh(tubeGeo, fresnelMat); tubeRim.renderOrder = 4; g.add(tubeRim);
    const tubeEnd = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.02, 12, 48), chrome);
    tubeEnd.position.copy(this.tubeCurve.getPoint(1)); tubeEnd.lookAt(this.tubeCurve.getPoint(1).clone().add(this.tubeCurve.getTangent(1)).add(this.group.position));
    g.add(tubeEnd);
    // cuello y base
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.32, 48), chrome);
    neck.position.y = -R_IN - 0.12; neck.castShadow = true; g.add(neck);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 0.5, 64), blackGloss);
    base.position.y = -R_IN - 0.5; base.castShadow = true; base.receiveShadow = true; g.add(base);
    const trim = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.018, 12, 96), chrome);
    trim.rotation.x = Math.PI / 2; trim.position.y = -R_IN - 0.25; g.add(trim);
    const trim2 = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.02, 12, 96), chrome);
    trim2.rotation.x = Math.PI / 2; trim2.position.y = -R_IN - 0.75; g.add(trim2);
    const accentHex = '#' + ACCENT[this.urn].toString(16).padStart(6, '0');
    const p = plate(this.urn === 'A' ? 'COMODINES' : 'PREMIOS', accentHex);
    p.position.set(0, -R_IN - 0.5, 0.69); p.rotation.x = -0.1; g.add(p);
    // luz de acento suave detrás (marca)
    const rim = new THREE.PointLight(ACCENT[this.urn], 6, 4, 2); rim.position.set(0, 0.2, -1.4); g.add(rim);
    this.rimLight = rim;
    // luz de "aire" dentro de la base, se intensifica al mezclar
    this.airLight = new THREE.PointLight(0xcfe6ff, 0.6, 2.2, 2); this.airLight.position.set(0, -0.75, 0.2); g.add(this.airLight);
  }
  clearBalls() {
    for (const b of this.balls) { this.group.remove(b.mesh); this.world.removeBody(b.body); }
    this.balls = [];
  }
  setTickets(list, exclude = new Set()) {
    this.clearBalls();
    this.allTickets = list.filter((t) => !exclude.has(t.p));
    const MAX = LOW ? 80 : 150;
    const shown = this.allTickets.length > MAX ? shuffle(this.allTickets.slice()).slice(0, MAX) : this.allTickets.slice();
    this.hidden = this.allTickets.length - shown.length;
    const n = Math.max(shown.length, 1);
    this.r = clamp(Math.cbrt(0.2 / n) * R_IN, 0.075, 0.17);
    const pal = PALETTES[this.urn];
    shown.forEach((t) => this.addBall(t, pal[hash(t.code) % pal.length]));
  }
  addBall(t, color) {
    const r = this.r;
    const mat = new THREE.MeshPhysicalMaterial({ map: ballTexture(color, shortCode(t.code)), roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1 });
    const mesh = new THREE.Mesh(ballGeo, mat);
    mesh.scale.setScalar(r); mesh.castShadow = true;
    // posición inicial al azar en la mitad inferior
    let p;
    do { p = new THREE.Vector3((Math.random() * 2 - 1) * 0.8, -Math.random() * 0.8, (Math.random() * 2 - 1) * 0.8); } while (p.length() > R_IN - r * 1.2);
    const body = new CANNON.Body({ mass: 0.012, shape: new CANNON.Sphere(r), linearDamping: 0.04, angularDamping: 0.08 });
    body.position.set(p.x, p.y, p.z);
    body.quaternion.setFromEuler(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    this.world.addBody(body);
    this.group.add(mesh);
    const ball = { t, body, mesh, color, fade: 1, fading: false };
    this.balls.push(ball);
    return ball;
  }
  removePlayer(p) {
    let n = 0;
    for (const b of this.balls) if (b.t.p === p && !b.fading) { b.fading = true; n++; }
    this.allTickets = (this.allTickets || []).filter((t) => t.p !== p);
    for (let i = 0; i < Math.min(n, 6); i++) setTimeout(() => this.sfx.pop(), 250 + i * 110);
  }
  startCapture(code) {
    return new Promise((resolve) => {
      let ball = this.balls.find((b) => b.t.code === code && !b.fading);
      if (!ball) {
        const free = this.balls.filter((b) => !b.fading);
        ball = free[Math.floor(Math.random() * free.length)];
        if (!ball) return resolve(null);
        const t = (this.allTickets || []).find((x) => x.code === code) || { code, p: -1 };
        ball.t = t;
        ball.mesh.material.map = ballTexture(ball.color, shortCode(code)); ball.mesh.material.needsUpdate = true;
      }
      ball.body.collisionResponse = false;
      this.capture = { ball, resolve, t0: this.t };
    });
  }
  step(dt) {
    this.t += dt;
    this.mix = lerp(this.mix, this.mixTarget, 1 - Math.pow(0.03, dt));
    const m = this.mix, g = 9.82, t = this.t;
    this.airLight.intensity = 0.4 + m * 2.2;
    for (const b of this.balls) {
      if (this.capture && this.capture.ball === b) continue;
      const body = b.body, p = body.position;
      // aire desde abajo con turbulencia
      // valores ajustados con simulación: al mezclar ~2/3 de las pelotitas vuelan sobre la mitad del bombo
      if (p.y < 0.45) {
        const k = (0.45 - p.y) / 1.45;
        const gust = 0.5 + 0.5 * Math.sin(t * 5.3 + p.x * 9) * Math.sin(t * 2.3 - p.z * 7);
        const f = body.mass * g * (0.25 + 3.4 * m * (0.35 + gust)) * k * (0.5 + Math.random());
        body.applyForce(new CANNON.Vec3((Math.random() - 0.5) * f * 1.3, f, (Math.random() - 0.5) * f * 1.3));
      }
      if (Math.random() < 0.06 * m) {
        const s = body.mass * (1 + Math.random() * 3.5) * m;
        body.applyImpulse(new CANNON.Vec3((Math.random() - 0.5) * s, s, (Math.random() - 0.5) * s));
      }
    }
    // pelotita ganadora: sube hacia la boca
    if (this.capture) {
      const { ball } = this.capture, body = ball.body;
      const target = new CANNON.Vec3(0, R_IN + 0.05, 0);
      const d = target.vsub(body.position), len = d.length();
      const sp = clamp(len * 3.2, 0.9, 3.4);
      body.velocity.set(d.x / len * sp, d.y / len * sp, d.z / len * sp);
      body.angularVelocity.set(2, 4, 1);
      if (len < 0.05 || this.t - this.capture.t0 > 3) {
        const { resolve } = this.capture;
        this.world.removeBody(body);
        this.balls = this.balls.filter((b) => b !== ball);
        this.capture = null;
        resolve(ball);
      }
    }
    this.world.step(1 / 120, Math.min(dt, 1 / 20), 6);
    // paredes de la esfera (contenedor)
    const lim = R_IN - this.r;
    for (const b of this.balls) {
      const body = b.body, p = body.position;
      if (this.capture && this.capture.ball === b) continue;
      const d = p.length();
      if (d > lim) {
        const n = p.scale(1 / d);
        p.copy(n.scale(lim));
        const vn = body.velocity.dot(n);
        if (vn > 0) {
          body.velocity.vsub(n.scale(vn * 1.6), body.velocity);
          body.velocity.scale(0.985, body.velocity);
          if (this.audible && vn > 0.9) this.sfx.click(clamp(vn / 7, 0, 1) * 0.5);
        }
      }
    }
    // sincronizar mallas
    for (const b of this.balls) {
      b.mesh.position.set(b.body.position.x, b.body.position.y, b.body.position.z);
      b.mesh.quaternion.set(b.body.quaternion.x, b.body.quaternion.y, b.body.quaternion.z, b.body.quaternion.w);
      if (b.fading) { b.fade -= dt * 1.8; b.mesh.scale.setScalar(this.r * Math.max(b.fade, 0)); }
    }
    const gone = this.balls.filter((b) => b.fade <= 0);
    for (const b of gone) { this.group.remove(b.mesh); this.world.removeBody(b.body); }
    if (gone.length) this.balls = this.balls.filter((b) => b.fade > 0);
  }
}

// ================= Escena =================
const sfx = new Sfx(); sfx.enabled = params.get('muted') !== '1'; sfx.init();
const drums = { A: new Drum3D('A', -1.75, sfx), B: new Drum3D('B', 1.75, sfx) };

let composer = null;
if (!transparent && !LOW) {
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(PR); composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.12, 0.4, 0.96));
  composer.addPass(new OutputPass());
}

// efectos 2D encima (destellos dorados, salpicadura)
const fx = $('#fx'), fctx = fx.getContext('2d');
const confetti = new Confetti();

// ---------- Cámara ----------
const cam = { from: null, to: null, start: 0, ms: 1400, push: 0, pushTarget: 0 };
function camFor(scene_) {
  const both = hasA();
  if (scene_ === 'A' || scene_ === 'B') {
    const x = drums[scene_].x + 0.98;
    return { pos: new THREE.Vector3(x, 0.25, 6.2), tgt: new THREE.Vector3(x, 0.1, 0) };
  }
  if (scene_ === 'results') return { pos: new THREE.Vector3(0, 2.4, 12.5), tgt: new THREE.Vector3(0, -0.4, 0) };
  if (!both) return { pos: new THREE.Vector3(1.75, 0.35, 7.6), tgt: new THREE.Vector3(1.75, -0.25, 0) };
  return { pos: new THREE.Vector3(0, 1.0, 12.2), tgt: new THREE.Vector3(0, 0.3, 0) };
}
function moveCamera(scene_, animate) {
  const to = camFor(scene_);
  if (!animate) { camBase.copy(to.pos); camTarget.copy(to.tgt); cam.to = null; return; }
  cam.from = { pos: camBase.clone(), tgt: camTarget.clone() }; cam.to = to; cam.start = performance.now();
}

// ---------- Estado / datos ----------
let data = null, state = null, busy = false, presented = null, flying = null;
const hasA = () => !!data && (data.tickets.A.length > 0 || data.prizes.some((p) => p.urn === 'A')) && data.draw.comodines !== false;

function applyScene(animate) {
  const sc = state.scene;
  const focus = sc === 'A' || sc === 'B';
  drums.A.group.visible = sc === 'A' || ((sc === 'intro' || sc === 'results') && hasA());
  drums.B.group.visible = sc !== 'A';
  for (const u of ['A', 'B']) drums[u].audible = focus ? sc === u : sc === 'intro';
  moveCamera(sc, animate);
  stage.classList.toggle('focus', focus);
  stage.classList.toggle('results', sc === 'results');
  $('#panel').className = focus ? (sc === 'A' ? 'a' : 'b') : 'hidden';
  $('#results').classList.toggle('hidden', sc !== 'results');
  $('#introLabels').style.display = sc === 'intro' ? '' : 'none';
  // rótulos bajo cada bombo
  const both = hasA();
  $('#labA').style.display = both ? '' : 'none';
  $('#labA').style.left = '560px'; $('#labB').style.left = both ? '1360px' : '960px';
  if (focus) $('#pTitle').textContent = sc === 'A' ? 'BOMBO COMODINES' : 'BOMBO PREMIOS';
  if (!focus) { presented = null; removePresented(); $('#winnerCard').classList.add('hidden'); }
  applyMix(); renderPrize(); renderWinners();
}
function applyMix() {
  for (const u of ['A', 'B']) {
    const active = state.scene === u;
    drums[u].mixTarget = state.mixing && active ? 0.9 : active ? 0.2 : 0.12;
  }
  sfx.setMix(state.mixing && (state.scene === 'A' || state.scene === 'B') ? 0.9 : 0.12);
}
function renderPrize() {
  const sc = state.scene;
  if (sc !== 'A' && sc !== 'B') return;
  const list = data.prizes.filter((p) => p.urn === sc);
  let p = list.find((x) => x.id === state.prizeId);
  if (!p && sc === 'A') p = list.find((x) => x.remaining > 0) || list[0];
  const label = p ? p.label : 'Elige el premio';
  $('#prizeLabel').textContent = label;
  $('#prizeLabel').style.fontSize = label.length > 16 ? '44px' : label.length > 11 ? '54px' : '64px';
  $('#prizeLeft').textContent = p ? `Quedan ${p.remaining} de ${p.qty}` : '';
  const c = $('#prizeCard'); c.classList.remove('pulse'); void c.offsetWidth; c.classList.add('pulse');
}
function renderWinners(newId) {
  const sc = state.scene;
  if (sc === 'A' || sc === 'B') {
    $('#wl').innerHTML = data.winners.filter((w) => w.urn === sc).slice().reverse().slice(0, 14)
      .map((w) => `<li class="${w.id === newId ? 'new' : ''}"><span>${esc(w.user)}</span><b>${esc(sc === 'A' ? w.code : w.prize)}</b></li>`).join('');
  }
  for (const u of ['A', 'B']) {
    $(`#res${u} ol`).innerHTML = data.winners.filter((w) => w.urn === u)
      .map((w) => `<li><span>${esc(w.user)} <small style="opacity:.55">${esc(w.code)}</small></span><b>${esc(w.prize)}</b></li>`).join('')
      || '<li style="opacity:.6">Aún sin ganadores</li>';
  }
}
function renderIntro() {
  $('#drawName').textContent = data.draw.name || '';
  const lab = (u) => {
    const t = data.tickets[u], players = new Set(t.map((x) => x.p)).size;
    return `<div class="n">${u === 'A' ? 'BOMBO COMODINES' : 'BOMBO PREMIOS'}</div><div class="s">${t.length} tickets · ${players} jugadores</div>`;
  };
  $('#labA').innerHTML = lab('A'); $('#labB').innerHTML = lab('B');
  $('#badge').classList.toggle('hidden', !data.rehearsal);
}
function loadDrums() {
  for (const u of ['A', 'B']) {
    const out = new Set(data.winners.filter((w) => w.urn === u).map((w) => w.p));
    (data.discarded || []).filter((d) => d.urn === u).forEach((d) => out.add(d.p));
    drums[u].setTickets(data.tickets[u], out);
  }
}
async function reload() {
  const r = await fetch('/api/live/snapshot');
  if (!r.ok) return;
  data = await r.json(); state = data.state;
  loadDrums(); renderIntro(); applyScene(false);
}

// ---------- Presentación de la pelotita ganadora ----------
const PRES_SCREEN = { x: 1535, y: 410, px: 118 }; // centro y radio en pantalla
const presGroup = new THREE.Group(); scene.add(presGroup);
const presLight = new THREE.PointLight(0xfff1d0, 0, 3, 2); presGroup.add(presLight);
function presPoint(dist = 2.6) {
  const ndc = new THREE.Vector2(PRES_SCREEN.x / W * 2 - 1, 1 - PRES_SCREEN.y / H * 2);
  const halfH = dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), halfW = halfH * camera.aspect;
  const local = new THREE.Vector3(ndc.x * halfW, ndc.y * halfH, -dist);
  return { world: camera.localToWorld(local.clone()), radius: PRES_SCREEN.px * (2 * halfH) / H };
}
function removePresented() { if (presented?.mesh) presGroup.remove(presented.mesh); presented = null; presLight.intensity = 0; }

async function runExtraction(result) {
  busy = true;
  const drum = drums[result.urn];
  $('#winnerCard').classList.add('hidden');
  removePresented();
  state.prizeId = result.prize.id; renderPrize();
  // 1) suspenso: mezcla fuerte, redoble y la cámara se acerca
  drum.mixTarget = 1; sfx.setMix(1); sfx.drumroll(2.8); cam.pushTarget = 0.55;
  await wait(2800);
  // 2) la ganadora sube por la boca
  const ball = await drum.startCapture(result.code);
  drum.mixTarget = 0.35; sfx.setMix(0.3); cam.pushTarget = 0;
  sfx.whoosh();
  const color = ball ? ball.color : PALETTES[result.urn][0];
  const mesh = ball ? ball.mesh : new THREE.Mesh(ballGeo, new THREE.MeshPhysicalMaterial({ map: ballTexture(color, shortCode(result.code)), roughness: 0.3, clearcoat: 1 }));
  if (!ball) { mesh.scale.setScalar(drum.r); drum.group.add(mesh); }
  // 3) recorre el tubo de vidrio y vuela al frente
  flying = { mesh, drum, t: 0, dur: 1.25, stage: 'tube', r0: drum.r };
  await wait(1250);
  flying.stage = 'fly'; flying.t = 0; flying.dur = 0.7;
  const start = new THREE.Vector3(); mesh.getWorldPosition(start);
  drum.group.remove(mesh); presGroup.add(mesh); mesh.position.copy(start);
  flying.start = start; flying.q0 = mesh.quaternion.clone();
  await wait(700);
  flying = null;
  // 4) revelación: gira de frente mostrando el número completo
  mesh.material.map = ballTexture(color, result.code); mesh.material.needsUpdate = true;
  presented = { mesh, t: 0 };
  presLight.intensity = 3;
  sfx.ding(); sfx.fanfare(result.urn);
  confetti.burst(PRES_SCREEN.x, PRES_SCREEN.y, ['#e9c46a', '#ffffff', '#d4af37', '#f5e6b8'], 150);
  $('#wUser').textContent = result.user;
  $('#wCode').textContent = `TICKET ${result.code}`;
  $('#wPrize').textContent = result.prize.label;
  $('#winnerCard').classList.remove('hidden');
  data.winners.push({ id: result.id, urn: result.urn, code: result.code, user: result.user, p: result.p, prize: result.prize.label });
  const pz = data.prizes.find((p) => p.id === result.prize.id); if (pz) pz.remaining = Math.max(0, pz.remaining - 1);
  renderPrize(); renderWinners(result.id);
  setTimeout(() => drum.removePlayer(result.p), 1600);
  await wait(1500);
  applyMix();
  busy = false;
}

let splash = [];
async function runDiscard(d) {
  while (busy) await wait(200);
  data.winners = data.winners.filter((w) => w.id !== d.id);
  (data.discarded = data.discarded || []).push({ urn: d.urn, p: d.p, code: d.code });
  const pz = data.prizes.find((p) => p.id === d.prizeId); if (pz) pz.remaining += 1;
  state.prizeId = d.prizeId;
  sfx.splash();
  if (presented) presented.falling = { v: 0 };
  const card = $('#winnerCard');
  if (!card.classList.contains('hidden')) { $('#wPrize').textContent = '💧 AL AGUA'; card.classList.add('water'); }
  drums[d.urn].removePlayer(d.p);
  renderWinners();
  await wait(2600);
  card.classList.add('hidden'); card.classList.remove('water');
  removePresented();
  renderPrize();
}
function makeSplash(x, y) {
  for (let i = 0; i < 80; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6, v = 5 + Math.random() * 12;
    splash.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 2 + Math.random() * 5, life: 1.1 + Math.random() * 0.6 });
  }
  splash.push({ ring: true, x, y, t: 0, life: 1.4 });
}
function drawSplash(dt) {
  for (const s of splash) {
    if (s.ring) {
      s.t += dt; s.life = 1.4 - s.t;
      fctx.strokeStyle = `rgba(150,210,255,${Math.max(0, 0.7 - s.t * 0.5)})`; fctx.lineWidth = 4;
      fctx.beginPath(); fctx.ellipse(s.x, s.y, 40 + s.t * 240, 8 + s.t * 40, 0, 0, Math.PI * 2); fctx.stroke();
      continue;
    }
    s.vy += 30 * dt; s.x += s.vx * dt * 60; s.y += s.vy * dt * 60; s.life -= dt;
    fctx.fillStyle = `rgba(160,215,255,${clamp(s.life, 0, 1) * 0.85})`;
    fctx.beginPath(); fctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); fctx.fill();
  }
  splash = splash.filter((s) => s.life > 0);
}

// ---------- Tiempo real ----------
function connect() {
  const es = new EventSource('/api/live/stream');
  es.addEventListener('hello', reload);
  es.addEventListener('reload', reload);
  es.addEventListener('scene', (e) => { state = JSON.parse(e.data).state; applyScene(true); });
  es.addEventListener('mix', (e) => { state = JSON.parse(e.data).state; applyMix(); });
  es.addEventListener('prize', (e) => { state = JSON.parse(e.data).state; renderPrize(); });
  es.addEventListener('clear', (e) => { state = JSON.parse(e.data).state; removePresented(); $('#winnerCard').classList.add('hidden'); });
  es.addEventListener('discard', (e) => { const m = JSON.parse(e.data); state = m.state; runDiscard(m.discard); });
  es.addEventListener('extract', (e) => {
    const m = JSON.parse(e.data); state = m.state;
    if (state.scene !== m.result.urn) { state.scene = m.result.urn; applyScene(true); }
    runExtraction(m.result);
  });
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}

// ---------- Bucle ----------
let last = performance.now();
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), lookM = new THREE.Matrix4();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  const tsec = now / 1000;
  for (const u of ['A', 'B']) if (drums[u].group.visible) drums[u].step(dt);

  // cámara: transición + acercamiento en suspenso + leve movimiento de cámara en mano
  if (cam.to) {
    const p = clamp((now - cam.start) / cam.ms, 0, 1), e = ease(p);
    camBase.lerpVectors(cam.from.pos, cam.to.pos, e); camTarget.lerpVectors(cam.from.tgt, cam.to.tgt, e);
    if (p >= 1) cam.to = null;
  }
  cam.push = lerp(cam.push, cam.pushTarget, 1 - Math.pow(0.2, dt));
  const dir = camTarget.clone().sub(camBase).normalize();
  camera.position.copy(camBase).addScaledVector(dir, cam.push);
  camera.position.x += Math.sin(tsec * 0.6) * 0.012; camera.position.y += Math.sin(tsec * 0.83) * 0.008;
  camera.lookAt(camTarget);

  // pelotita ganadora por el tubo y hacia el frente
  if (flying) {
    flying.t += dt / flying.dur;
    const t = clamp(flying.t, 0, 1);
    if (flying.stage === 'tube') {
      const e = ease(t);
      flying.mesh.position.copy(flying.drum.tubeCurve.getPoint(e));
      flying.mesh.rotation.x += dt * 9; flying.mesh.rotation.z += dt * 5;
    } else {
      const pp = presPoint(), e = ease(t);
      flying.mesh.position.lerpVectors(flying.start, pp.world, e);
      flying.mesh.scale.setScalar(lerp(flying.r0, pp.radius, e));
      flying.mesh.rotation.x += dt * 6;
    }
  }
  if (presented) {
    presented.t += dt;
    const pp = presPoint();
    const m = presented.mesh;
    if (presented.falling) {
      presented.falling.v += 9 * dt;
      m.position.y -= presented.falling.v * dt; m.rotation.x += dt * 4;
      if (!presented.falling.splashed && presented.t > 0 && m.position.y < pp.world.y - 2.2) { presented.falling.splashed = true; makeSplash(PRES_SCREEN.x, 1010); }
    } else {
      m.position.copy(pp.world); m.position.y += Math.sin(presented.t * 2) * pp.radius * 0.05;
      m.scale.setScalar(pp.radius);
      // girar suavemente hasta que el número mire a la cámara
      lookM.lookAt(camera.position, m.position, camera.up); tmpQ.setFromRotationMatrix(lookM);
      m.quaternion.slerp(tmpQ, 1 - Math.pow(0.02, dt));
    }
    presLight.position.copy(m.position).add(tmpV.set(0.3, 0.4, 0.6));
  }

  if (composer) composer.render(); else renderer.render(scene, camera);
  autoQuality();
  fctx.clearRect(0, 0, W, H);
  confetti.step(dt); confetti.draw(fctx); drawSplash(dt);
  requestAnimationFrame(frame);
}

// Si el PC no alcanza ~40 cuadros por segundo, baja la calidad sola (primero resolución, luego destellos).
let perfStart = performance.now(), perfFrames = 0, perfLevel = 0;
function autoQuality() {
  if (params.get('pr') || perfLevel >= 2) return;
  perfFrames++;
  const elapsed = (performance.now() - perfStart) / 1000; // tiempo real, no el de la física
  if (elapsed < 3) return;
  const fps = perfFrames / elapsed; perfStart = performance.now(); perfFrames = 0;
  if (fps >= 40) return;
  perfLevel++;
  if (perfLevel === 1) { renderer.setPixelRatio(0.75); composer?.setPixelRatio(0.75); }
  if (perfLevel === 2) { composer = null; renderer.shadowMap.enabled = false; }
  console.warn(`Calidad reducida automáticamente (nivel ${perfLevel}, ${fps.toFixed(0)} fps)`);
}

setInterval(() => {
  $('#soundHint').classList.toggle('hidden', !!window.obsstudio || !sfx.ctx || sfx.ctx.state === 'running' || !sfx.enabled);
}, 800);
$('#soundHint').addEventListener('click', () => sfx.ctx && sfx.ctx.resume());

window.__dbg = { THREE, camera, get presented() { return presented; } };
requestAnimationFrame(frame);
connect();
