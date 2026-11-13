/* Bombo de lotería con física 2D (Matter.js), render en canvas y sonido sintetizado (WebAudio).
 * Lo usan la pantalla de OBS (overlay.html) y la página pública (publico.html).
 * El resultado de cada extracción lo decide el servidor; aquí solo se anima. */
(function () {
  const { Engine, Bodies, Body, Composite, Events } = Matter;

  const W = 1920, H = 1080;
  const R = 400; // radio interior del bombo en coordenadas locales

  const THEMES = {
    A: { // Comodines Halloween
      balls: ['#ff7a1a', '#8b3dff', '#ff5a00', '#b45cff', '#ff9a2e', '#6d28d9'],
      glow: '#ff8a1f', glow2: '#a855f7', label: 'BOMBO COMODINES', emoji: '🎃',
    },
    B: { // Premios
      balls: ['#1e7bff', '#19d3ff', '#22e39a', '#3b5bff', '#0ea5e9', '#10b981'],
      glow: '#22b8ff', glow2: '#2ee59d', label: 'BOMBO PREMIOS', emoji: '🎁',
    },
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const shortCode = (code) => String(Number(String(code).split('-')[1] || code));

  // ---------- Sprites pre-renderizados (rendimiento) ----------
  const spriteCache = new Map();
  function sphereSprite(color, r) {
    const key = color + '|' + Math.round(r);
    if (spriteCache.has(key)) return spriteCache.get(key);
    const s = Math.ceil(r * 2 + 4), c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d'), m = s / 2;
    const grad = g.createRadialGradient(m - r * 0.35, m - r * 0.4, r * 0.05, m, m, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.18, shade(color, 0.35));
    grad.addColorStop(0.6, color);
    grad.addColorStop(1, shade(color, -0.55));
    g.fillStyle = grad;
    g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.fill();
    spriteCache.set(key, c);
    return c;
  }
  function gloss(r) {
    const key = 'gloss|' + Math.round(r);
    if (spriteCache.has(key)) return spriteCache.get(key);
    const s = Math.ceil(r * 2 + 4), c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d'), m = s / 2;
    // sombra en el borde para que la etiqueta se vea "pegada" a la esfera
    let grad = g.createRadialGradient(m, m, r * 0.55, m, m, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,20,0.55)');
    g.fillStyle = grad; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.fill();
    // brillo especular (la luz viene de arriba a la izquierda)
    grad = g.createRadialGradient(m - r * 0.38, m - r * 0.45, 0, m - r * 0.38, m - r * 0.45, r * 0.45);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.fill();
    grad = g.createRadialGradient(m + r * 0.45, m + r * 0.5, 0, m + r * 0.45, m + r * 0.5, r * 0.3);
    grad.addColorStop(0, 'rgba(255,255,255,0.25)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.fill();
    spriteCache.set(key, c);
    return c;
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
    r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
    return `rgb(${r},${g},${b})`;
  }

  // Dibuja una pelotita de lotería: esfera + etiqueta blanca que gira con la física + brillo.
  function drawBall(ctx, x, y, r, color, angle, text, alpha = 1, glowColor = null) {
    ctx.save();
    ctx.globalAlpha = alpha;
    if (glowColor) { ctx.shadowColor = glowColor; ctx.shadowBlur = r * 1.2; }
    const sp = sphereSprite(color, r);
    ctx.drawImage(sp, x - sp.width / 2, y - sp.height / 2);
    ctx.shadowBlur = 0;
    // La etiqueta se mueve sobre la esfera según el giro: de frente es un círculo, de lado se achata.
    const face = Math.cos(angle);
    if (face > -0.15 && r >= 9) {
      const lx = x + Math.sin(angle) * r * 0.42, ly = y + Math.sin(angle * 0.6) * r * 0.12;
      const sx = clamp(Math.abs(face), 0.12, 1);
      ctx.save();
      ctx.translate(lx, ly);
      ctx.scale(sx, 1);
      ctx.globalAlpha = alpha * clamp((face + 0.15) * 2.5, 0, 1);
      ctx.fillStyle = '#fbfdff';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.56, 0, Math.PI * 2); ctx.fill();
      if (r >= 13 && text) {
        ctx.fillStyle = '#0b1530';
        let fs = text.length > 3 ? r * 0.5 : r * 0.62;
        ctx.font = `900 ${fs}px "Segoe UI", Roboto, Arial, sans-serif`;
        const maxW = r * 0.98, w = ctx.measureText(text).width;
        if (w > maxW) { fs *= maxW / w; ctx.font = `900 ${fs}px "Segoe UI", Roboto, Arial, sans-serif`; }
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, 0, r * 0.03);
      }
      ctx.restore();
    }
    const gl = gloss(r);
    ctx.globalAlpha = alpha;
    ctx.drawImage(gl, x - gl.width / 2, y - gl.height / 2);
    ctx.restore();
  }

  // ================= Sonido =================
  class Sfx {
    constructor() {
      this.ctx = null; this.enabled = true; this.lastClick = 0; this.clicksThisSec = 0;
    }
    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx = new AC();
      this.master = ctx.createGain(); this.master.gain.value = 0.85;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      // Soplador de aire (ruido filtrado continuo)
      const air = ctx.createBufferSource(); air.buffer = buf; air.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 350; bp.gain.value = 8;
      this.airGain = ctx.createGain(); this.airGain.gain.value = 0;
      air.connect(lp).connect(bp).connect(this.airGain).connect(this.master); air.start();
      this.airFilter = lp;
      // Motor (zumbido grave)
      this.motorGain = ctx.createGain(); this.motorGain.gain.value = 0;
      const mlp = ctx.createBiquadFilter(); mlp.type = 'lowpass'; mlp.frequency.value = 260;
      this.motors = [55, 110.7, 82.4].map((f, i) => {
        const o = ctx.createOscillator(); o.type = i === 1 ? 'square' : 'sawtooth'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = i === 1 ? 0.25 : 0.5;
        o.connect(g).connect(mlp); o.start(); return o;
      });
      mlp.connect(this.motorGain).connect(this.master);
      const unlock = () => { if (ctx.state !== 'running') ctx.resume(); };
      ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, unlock, { passive: true }));
    }
    get ok() { return this.enabled && this.ctx && this.ctx.state === 'running'; }
    setMix(level) { // 0 = quieto, 1 = mezcla fuerte
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const on = this.enabled ? 1 : 0;
      this.airGain.gain.setTargetAtTime(on * (0.015 + 0.13 * level), t, 0.35);
      this.airFilter.frequency.setTargetAtTime(600 + 1800 * level, t, 0.4);
      this.motorGain.gain.setTargetAtTime(on * (0.012 + 0.05 * level), t, 0.4);
      this.motors.forEach((o, i) => o.frequency.setTargetAtTime([55, 110.7, 82.4][i] * (1 + 0.45 * level), t, 0.6));
    }
    click(intensity) { // choque entre pelotitas
      if (!this.ok || intensity < 0.04) return;
      const now = performance.now();
      if (now - this.lastClick > 1000) { this.lastClick = now; this.clicksThisSec = 0; }
      if (++this.clicksThisSec > 45) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200 + Math.random() * 2600; bp.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.32 * intensity, t + 0.002); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      src.connect(bp).connect(g).connect(this.master);
      src.start(t, Math.random() * 1.5, 0.06);
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2800 + Math.random() * 2400;
      const og = ctx.createGain(); og.gain.setValueAtTime(0.06 * intensity, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
      o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.04);
    }
    drumroll(duration) {
      if (!this.ok) return;
      const ctx = this.ctx, t0 = ctx.currentTime;
      let t = 0;
      while (t < duration) {
        const p = t / duration, rate = lerp(9, 26, p);
        const src = ctx.createBufferSource(); src.buffer = this.noise;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
        const g = ctx.createGain(), at = t0 + t;
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(lerp(0.05, 0.22, p), at + 0.004); g.gain.exponentialRampToValueAtTime(0.001, at + 0.09);
        src.connect(hp).connect(g).connect(this.master); src.start(at, Math.random(), 0.1);
        t += 1 / rate;
      }
    }
    whoosh() {
      if (!this.ok) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(3200, t + 0.9);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.3, t + 0.25); g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
      src.connect(bp).connect(g).connect(this.master); src.start(t, 0, 1.2);
      // "tic-tic-tic" de la pelotita rodando por el tubo
      for (let i = 0; i < 9; i++) setTimeout(() => this.click(0.5 + Math.random() * 0.3), 80 + i * 95);
    }
    ding() {
      if (!this.ok) return;
      const ctx = this.ctx, t = ctx.currentTime;
      [1, 2.76, 5.4].forEach((m, i) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 1046.5 * m;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.16 / (i + 1), t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.6 / (i + 1));
        o.connect(g).connect(this.master); o.start(t); o.stop(t + 1.7);
      });
    }
    brass(freq, at, dur, vol = 0.12) {
      const ctx = this.ctx;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 2;
      f.frequency.setValueAtTime(400, at); f.frequency.linearRampToValueAtTime(3200, at + 0.06); f.frequency.exponentialRampToValueAtTime(1400, at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.04); g.gain.setValueAtTime(vol * 0.8, at + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.001, at + dur + 0.25);
      f.connect(g).connect(this.master);
      [-6, 0, 7].forEach((det) => {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
        o.connect(f); o.start(at); o.stop(at + dur + 0.3);
      });
    }
    cymbal(at, vol = 0.18) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000;
      const g = ctx.createGain(); g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.001, at + 1.8);
      src.connect(hp).connect(g).connect(this.master); src.start(at, 0, 2);
    }
    fanfare(theme) {
      if (!this.ok) return;
      const t = this.ctx.currentTime + 0.05;
      const n = (s) => 440 * Math.pow(2, s / 12);
      if (theme === 'A') { // toque misterioso de Halloween antes de la fanfarria
        [[0, -3], [0.16, 0], [0.32, 4], [0.48, 9]].forEach(([d, s]) => this.brass(n(s), t + d, 0.22, 0.07));
      }
      const o = theme === 'A' ? 0.7 : 0;
      [[0, 3], [0.13, 7], [0.26, 10], [0.39, 15]].forEach(([d, s]) => this.brass(n(s), t + o + d, 0.16));
      [3, 7, 10, 15].forEach((s) => this.brass(n(s), t + o + 0.6, 1.3, 0.09));
      this.cymbal(t + o + 0.6);
    }
    splash() { // "al agua": tono que baja + chapuzón
      if (!this.ok) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(620, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.9);
      const og = ctx.createGain(); og.gain.setValueAtTime(0.14, t); og.gain.exponentialRampToValueAtTime(0.001, t + 1);
      o.connect(og).connect(this.master); o.start(t); o.stop(t + 1.05);
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2500, t + 0.7); lp.frequency.exponentialRampToValueAtTime(300, t + 1.6);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t + 0.7); g.gain.linearRampToValueAtTime(0.35, t + 0.75); g.gain.exponentialRampToValueAtTime(0.001, t + 1.7);
      src.connect(lp).connect(g).connect(this.master); src.start(t + 0.7, 0, 1.1);
    }
    pop() {
      if (!this.ok) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.12);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.16);
    }
  }

  // ================= Bombo =================
  class Drum {
    constructor(urn, sfx) {
      this.urn = urn; this.theme = THEMES[urn]; this.sfx = sfx;
      this.engine = Engine.create({ enableSleeping: false });
      this.engine.gravity.y = 1;
      this.engine.positionIterations = 8; this.engine.velocityIterations = 6;
      this.balls = []; this.mix = 0.12; this.mixTarget = 0.12; this.time = 0;
      this.layout = { x: W / 2, y: H / 2, s: 0.7, a: 1 }; this.from = null; this.to = null;
      this.gateOpen = false; this.capture = null; this.highlightFn = null;
      this.fanAngle = 0; this.audible = true; this.hiddenCount = 0; this.allTickets = [];
      this.buildWalls();
      this.buildFan();
      Events.on(this.engine, 'collisionStart', (ev) => {
        if (!this.sfx || this.layout.a < 0.2) return;
        for (const p of ev.pairs) {
          const a = p.bodyA, b = p.bodyB;
          const dv = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y);
          this.sfx.click(clamp((dv - 1.2) / 14, 0, 1) * this.layout.s * (this.audible ? 1 : 0));
        }
      });
    }
    buildWalls() {
      const n = 72, th = 70;
      this.walls = []; this.gate = [];
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2; // empieza arriba
        const x = Math.cos(ang) * (R + th / 2), y = Math.sin(ang) * (R + th / 2);
        const seg = Bodies.rectangle(x, y, th, (2 * Math.PI * (R + th)) / n + 6, { isStatic: true, angle: ang, restitution: 0.55, friction: 0.02 });
        const isGate = i === 0 || i === 1 || i === n - 1;
        (isGate ? this.gate : this.walls).push(seg);
      }
      Composite.add(this.engine.world, [...this.walls, ...this.gate]);
    }
    buildFan() { // ventilador en la parte de abajo: empuja las pelotitas
      this.fanCenter = { x: 0, y: R * 0.62 };
      this.blades = [0, 1, 2].map(() => Bodies.rectangle(this.fanCenter.x, this.fanCenter.y, R * 0.5, 16, { isStatic: true, restitution: 0.9, friction: 0 }));
      Composite.add(this.engine.world, this.blades);
    }
    setGate(open) {
      if (open === this.gateOpen) return;
      this.gateOpen = open;
      if (open) Composite.remove(this.engine.world, this.gate); else Composite.add(this.engine.world, this.gate);
    }
    // Carga los tickets. Si hay demasiados, se muestra una muestra al azar (el sorteo usa todos).
    setTickets(list, excludePlayers = new Set()) {
      for (const b of this.balls) Composite.remove(this.engine.world, b.body);
      this.balls = [];
      this.allTickets = list.filter((t) => !excludePlayers.has(t.p));
      const MAX = this.maxBalls || 230;
      const shown = this.allTickets.length > MAX ? shuffle(this.allTickets.slice()).slice(0, MAX) : this.allTickets.slice();
      const n = Math.max(shown.length, 1);
      this.ballR = clamp(Math.sqrt((0.36 * R * R) / n), 15, 40);
      const cols = this.theme.balls;
      shown.forEach((t, i) => {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (R - this.ballR * 1.5);
        const body = Bodies.circle(Math.cos(a) * d, Math.sin(a) * d * 0.6 + R * 0.25, this.ballR, {
          restitution: 0.72, friction: 0.005, frictionAir: 0.004, density: 0.0012,
        });
        Body.setAngle(body, Math.random() * Math.PI * 2);
        this.balls.push({ t, body, color: cols[hash(t.code) % cols.length], text: shortCode(t.code), alpha: 1, fading: false });
      });
      Composite.add(this.engine.world, this.balls.map((b) => b.body));
      this.hiddenCount = this.allTickets.length - shown.length;
    }
    removePlayer(p) { // al ganar, sus demás pelotitas salen del bombo
      let n = 0;
      for (const b of this.balls) if (b.t.p === p && !b.fading) { b.fading = true; n++; }
      this.allTickets = (this.allTickets || []).filter((t) => t.p !== p);
      if (n && this.sfx) for (let i = 0; i < Math.min(n, 6); i++) setTimeout(() => this.sfx.pop(), 300 + i * 120);
    }
    setMix(level) { this.mixTarget = level; }
    animateTo(layout, ms = 900) {
      this.from = { ...this.layout }; this.to = { ...this.layout, ...layout }; this.animStart = performance.now(); this.animMs = ms;
    }
    // Inicia la captura de la pelotita ganadora: sube por la boca del bombo y la entrega a onExit.
    startCapture(code, onExit) {
      let ball = this.balls.find((b) => b.t.code === code && !b.fading);
      if (!ball) { // estaba fuera de la muestra visible: una pelotita toma su lugar
        const free = this.balls.filter((b) => !b.fading);
        ball = free[Math.floor(Math.random() * free.length)];
        if (!ball) return onExit(null);
        const t = (this.allTickets || []).find((x) => x.code === code) || { code, p: -1 };
        ball.t = t; ball.text = shortCode(code);
      }
      ball.body.collisionFilter.mask = 0; // atraviesa a las demás mientras sube
      this.setGate(true);
      this.capture = { ball, onExit, t0: this.time };
    }
    step(dt) {
      this.time += dt;
      if (this.to) {
        const p = clamp((performance.now() - this.animStart) / this.animMs, 0, 1), e = ease(p);
        for (const k of ['x', 'y', 's', 'a']) this.layout[k] = lerp(this.from[k], this.to[k], e);
        if (p >= 1) this.to = null;
      }
      this.mix = lerp(this.mix, this.mixTarget, 1 - Math.pow(0.02, dt));
      // ventilador
      this.fanAngle += dt * (1.2 + this.mix * 11);
      this.blades.forEach((b, i) => {
        const a = this.fanAngle + (i * Math.PI) / 3;
        Body.setPosition(b, this.fanCenter, false);
        Body.setAngle(b, a, true);
      });
      // aire: empuje hacia arriba desde abajo, más fuerte al mezclar
      const m = this.mix;
      for (const b of this.balls) {
        const body = b.body;
        if (this.capture && this.capture.ball === b) continue;
        const y = body.position.y;
        // Aire turbulento: chorros que cambian con el tiempo y la posición, como una máquina de aire real.
        const x = body.position.x;
        const gust = 0.5 + 0.5 * Math.sin(this.time * 5.3 + x * 0.018) * Math.sin(this.time * 2.1 - x * 0.011);
        if (y > -R * 0.3) {
          const k = (y + R * 0.3) / (R * 1.3);
          const f = body.mass * 0.0011 * (0.22 + 2.9 * m * (0.35 + gust)) * k * (0.4 + Math.random() * 1.2);
          Body.applyForce(body, body.position, { x: (Math.random() - 0.5) * f * 1.6 - x * 0.0000012 * body.mass * m, y: -f });
        }
        // golpes de aire al azar: hacen saltar pelotitas por todo el bombo
        if (Math.random() < 0.05 * m) {
          const s = body.mass * (0.006 + Math.random() * 0.016) * m;
          Body.applyForce(body, body.position, { x: (Math.random() - 0.5) * s * 1.4, y: -s });
        }
        // seguridad: si alguna se escapa, vuelve al centro
        if (Math.hypot(body.position.x, body.position.y) > R + 40 && !(this.capture && this.capture.ball === b)) {
          Body.setPosition(body, { x: 0, y: 0 }); Body.setVelocity(body, { x: 0, y: 0 });
        }
      }
      // pelotita ganadora subiendo hacia la boca
      if (this.capture) {
        const { ball } = this.capture, body = ball.body;
        const target = { x: Math.sin(this.time * 9) * 6, y: -R - this.ballR * 1.4 };
        const dx = target.x - body.position.x, dy = target.y - body.position.y, d = Math.hypot(dx, dy);
        const sp = clamp(d * 0.09, 6, 22);
        Body.setVelocity(body, { x: (dx / d) * sp, y: (dy / d) * sp });
        Body.setAngularVelocity(body, 0.35);
        if (d < 18 || this.time - this.capture.t0 > 3) {
          const cb = this.capture.onExit;
          Composite.remove(this.engine.world, body);
          this.balls = this.balls.filter((b) => b !== ball);
          this.capture = null;
          setTimeout(() => this.setGate(false), 250);
          cb(ball);
        }
      }
      // pelotitas que se retiran (ganador ya tiene premio)
      for (const b of this.balls) if (b.fading) b.alpha -= dt * 1.6;
      const gone = this.balls.filter((b) => b.alpha <= 0);
      if (gone.length) {
        gone.forEach((b) => Composite.remove(this.engine.world, b.body));
        this.balls = this.balls.filter((b) => b.alpha > 0);
      }
      Engine.update(this.engine, Math.min(dt, 1 / 30) * 1000);
    }
    // Coordenadas locales -> pantalla
    toScreen(x, y) { return { x: this.layout.x + x * this.layout.s, y: this.layout.y + y * this.layout.s }; }

    draw(ctx, opts = {}) {
      const L = this.layout;
      if (L.a <= 0.01) return;
      const th = this.theme;
      ctx.save();
      ctx.globalAlpha = L.a;
      ctx.translate(L.x, L.y);
      ctx.scale(L.s, L.s);

      // --- base / soporte ---
      ctx.save();
      const baseG = ctx.createLinearGradient(0, R, 0, R + 230);
      baseG.addColorStop(0, '#2b3d66'); baseG.addColorStop(0.5, '#141f3d'); baseG.addColorStop(1, '#0a1128');
      ctx.fillStyle = baseG;
      ctx.beginPath();
      ctx.moveTo(-150, R + 10); ctx.lineTo(150, R + 10); ctx.lineTo(270, R + 210); ctx.lineTo(-270, R + 210); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = th.glow; ctx.lineWidth = 4; ctx.shadowColor = th.glow; ctx.shadowBlur = 18; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '900 40px "Segoe UI", Roboto, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(th.label, 0, R + 120);
      ctx.restore();

      // --- interior del vidrio ---
      const inner = ctx.createRadialGradient(-R * 0.2, -R * 0.3, R * 0.1, 0, 0, R + 10);
      inner.addColorStop(0, 'rgba(40,70,140,0.35)'); inner.addColorStop(0.7, 'rgba(10,20,55,0.55)'); inner.addColorStop(1, 'rgba(4,8,24,0.85)');
      ctx.fillStyle = inner;
      ctx.beginPath(); ctx.arc(0, 0, R + 8, 0, Math.PI * 2); ctx.fill();
      // halo de color
      ctx.save();
      const halo = ctx.createRadialGradient(0, R * 0.6, 0, 0, R * 0.6, R * 0.9);
      halo.addColorStop(0, hexA(th.glow, 0.25 + this.mix * 0.25)); halo.addColorStop(1, hexA(th.glow, 0));
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // --- ventilador ---
      ctx.save();
      ctx.translate(this.fanCenter.x, this.fanCenter.y);
      for (let i = 0; i < 3; i++) {
        ctx.save(); ctx.rotate(this.fanAngle + (i * Math.PI) / 3);
        const bg = ctx.createLinearGradient(0, -8, 0, 8); bg.addColorStop(0, '#9fb3d9'); bg.addColorStop(1, '#3a4a70');
        ctx.fillStyle = bg; roundRect(ctx, -R * 0.25, -8, R * 0.5, 16, 8); ctx.fill();
        ctx.restore();
      }
      const hub = ctx.createRadialGradient(-6, -6, 2, 0, 0, 26); hub.addColorStop(0, '#e6eefc'); hub.addColorStop(1, '#4a5b85');
      ctx.fillStyle = hub; ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // --- pelotitas ---
      ctx.save();
      ctx.beginPath(); ctx.arc(0, 0, R + 4, 0, Math.PI * 2);
      if (!this.capture) ctx.clip();
      for (const b of this.balls) {
        const p = b.body.position;
        const hl = this.highlightFn && this.highlightFn(b.t);
        drawBall(ctx, p.x, p.y, this.ballR, b.color, b.body.angle, b.text, clamp(b.alpha, 0, 1) * (this.highlightFn && !hl ? 0.35 : 1), hl ? '#ffe066' : null);
      }
      ctx.restore();

      // --- vidrio frontal ---
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 22;
      ctx.beginPath(); ctx.arc(0, 0, R - 26, Math.PI * 1.08, Math.PI * 1.42); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 10;
      ctx.beginPath(); ctx.arc(0, 0, R - 60, Math.PI * 1.12, Math.PI * 1.3); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 14;
      ctx.beginPath(); ctx.arc(0, 0, R - 30, Math.PI * 0.1, Math.PI * 0.32); ctx.stroke();
      // reflejo que recorre el vidrio
      const sweep = (this.time * 0.25) % 2;
      if (sweep < 1) {
        const sx = lerp(-R * 1.4, R * 1.4, sweep);
        const rg = ctx.createLinearGradient(sx - 120, -R, sx + 120, R);
        rg.addColorStop(0, 'rgba(255,255,255,0)'); rg.addColorStop(0.5, 'rgba(255,255,255,0.10)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = rg; ctx.fillRect(-R, -R, R * 2, R * 2);
      }
      ctx.restore();

      // --- aro metálico con brillo de color ---
      ctx.save();
      ctx.shadowColor = th.glow; ctx.shadowBlur = 30 + this.mix * 40;
      const rim = ctx.createLinearGradient(-R, -R, R, R);
      rim.addColorStop(0, '#e9f1ff'); rim.addColorStop(0.3, '#7d8fb8'); rim.addColorStop(0.55, '#dfe8fb'); rim.addColorStop(1, '#3a4870');
      ctx.strokeStyle = rim; ctx.lineWidth = 30;
      ctx.beginPath(); ctx.arc(0, 0, R + 18, -Math.PI / 2 + 0.11, Math.PI * 1.5 - 0.11); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexA(th.glow, 0.9); ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, R + 2, -Math.PI / 2 + 0.11, Math.PI * 1.5 - 0.11); ctx.stroke();
      // tornillos
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + Math.PI / 16;
        const x = Math.cos(a) * (R + 18), y = Math.sin(a) * (R + 18);
        const bg = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, 7); bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#55648c');
        ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fill();
      }
      // boca de salida arriba
      const mouthG = ctx.createLinearGradient(-60, 0, 60, 0); mouthG.addColorStop(0, '#5d6d96'); mouthG.addColorStop(0.5, '#f1f6ff'); mouthG.addColorStop(1, '#5d6d96');
      ctx.fillStyle = mouthG;
      roundRect(ctx, -64, -R - 58, 128, 36, 10); ctx.fill();
      ctx.fillStyle = this.gateOpen ? hexA(th.glow, 0.95) : 'rgba(10,16,40,0.9)';
      roundRect(ctx, -46, -R - 30, 92, 26, 6); ctx.fill();
      ctx.restore();

      if (this.hiddenCount > 0 && opts.showHidden) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '700 30px "Segoe UI", Roboto, Arial'; ctx.textAlign = 'center';
        ctx.fillText(`+${this.hiddenCount} tickets más participando`, 0, R + 175);
      }
      ctx.restore();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ================= Confeti y fondo =================
  class Confetti {
    constructor() { this.p = []; }
    burst(x, y, colors, n = 260) {
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3, v = 9 + Math.random() * 17;
        this.p.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
          w: 8 + Math.random() * 10, h: 5 + Math.random() * 7, c: colors[i % colors.length], life: 3.2 + Math.random() * 1.5 });
      }
    }
    step(dt) {
      const k = dt * 60;
      for (const q of this.p) { q.vy += 0.42 * k; q.vx *= Math.pow(0.985, k); q.vy *= Math.pow(0.985, k); q.x += q.vx * k; q.y += q.vy * k; q.r += q.vr * k; q.life -= dt; }
      this.p = this.p.filter((q) => q.life > 0 && q.y < H + 50);
    }
    draw(ctx) {
      for (const q of this.p) {
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.r); ctx.globalAlpha = clamp(q.life, 0, 1);
        ctx.fillStyle = q.c; ctx.fillRect(-q.w / 2, -q.h / 2 * Math.abs(Math.cos(q.r * 2)), q.w, q.h * Math.abs(Math.cos(q.r * 2)) + 1);
        ctx.restore();
      }
    }
  }

  class Backdrop {
    constructor() {
      this.stars = Array.from({ length: 110 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 2.2 + 0.4, t: Math.random() * 6 }));
      this.base = document.createElement('canvas'); this.base.width = W; this.base.height = H;
      const g = this.base.getContext('2d');
      let gr = g.createRadialGradient(W / 2, H * 0.45, 50, W / 2, H * 0.55, W * 0.75);
      gr.addColorStop(0, '#11285c'); gr.addColorStop(0.5, '#0a1638'); gr.addColorStop(1, '#03060f');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      gr = g.createLinearGradient(0, H * 0.75, 0, H);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(34,184,255,0.12)');
      g.fillStyle = gr; g.fillRect(0, H * 0.75, W, H * 0.25);
    }
    draw(ctx, time, accent = '#22b8ff') {
      ctx.drawImage(this.base, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // haces de luz de escenario
      for (let i = 0; i < 5; i++) {
        const ox = W * (0.1 + i * 0.2), sw = Math.sin(time * 0.35 + i * 1.7) * 260;
        const gr = ctx.createLinearGradient(ox, 0, ox + sw, H);
        gr.addColorStop(0, hexA(i % 2 ? '#2ee59d' : accent, 0.10)); gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.moveTo(ox - 30, -10); ctx.lineTo(ox + 30, -10); ctx.lineTo(ox + sw + 230, H); ctx.lineTo(ox + sw - 230, H); ctx.closePath(); ctx.fill();
      }
      for (const s of this.stars) {
        const a = 0.25 + 0.75 * Math.abs(Math.sin(time * 1.3 + s.t));
        ctx.fillStyle = `rgba(170,220,255,${a * 0.8})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  window.Bombo = { Drum, Sfx, Confetti, Backdrop, drawBall, THEMES, W, H, R, shortCode, clamp, lerp, ease, hexA, roundRect };
})();
