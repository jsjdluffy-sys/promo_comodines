/* Pantalla de OBS: escucha al panel de control en tiempo real y anima los bombos. */
(() => {
  const { Drum, Sfx, Confetti, Backdrop, drawBall, THEMES, W, H, R, lerp, ease, clamp } = Bombo;
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const transparent = params.get('transparent') === '1';
  if (transparent) document.body.classList.add('transparent');

  const stage = $('#stage'), canvas = $('#c'), ctx = canvas.getContext('2d');
  function fit() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
    stage.style.transformOrigin = 'center center';
  }
  addEventListener('resize', fit); fit();

  const sfx = new Sfx();
  sfx.enabled = params.get('muted') !== '1';
  sfx.init();
  const backdrop = new Backdrop(), confetti = new Confetti();
  const drums = { A: new Drum('A', sfx), B: new Drum('B', sfx) };

  // Punto donde se presenta la pelotita ganadora (dentro del panel derecho)
  const PRES = { x: 1535, y: 420, r: 105 };
  let data = null, state = null, flying = null, presented = null, busy = false;

  // ---------- Layouts por escena ----------
  function layoutFor(scene) {
    const comodines = data?.draw?.comodines !== false && (data?.tickets?.A?.length || data?.prizes?.some((p) => p.urn === 'A'));
    if (scene === 'A') return { A: { x: 640, y: 545, s: 0.9, a: 1 }, B: { x: 2500, y: 545, s: 0.9, a: 0 } };
    if (scene === 'B') return { A: { x: -600, y: 545, s: 0.9, a: 0 }, B: { x: 640, y: 545, s: 0.9, a: 1 } };
    if (scene === 'results') return { A: { x: 560, y: 1500, s: 0.6, a: 0 }, B: { x: 1360, y: 1500, s: 0.6, a: 0 } };
    if (!comodines) return { A: { x: -600, y: 600, s: 0.7, a: 0 }, B: { x: 960, y: 600, s: 0.78, a: 1 } };
    return { A: { x: 540, y: 600, s: 0.7, a: 1 }, B: { x: 1380, y: 600, s: 0.7, a: 1 } };
  }

  function applyScene(animate) {
    const sc = state.scene;
    const L = layoutFor(sc);
    for (const u of ['A', 'B']) {
      if (animate) drums[u].animateTo(L[u], 1000); else Object.assign(drums[u].layout, L[u]);
      drums[u].audible = L[u].a > 0.5;
    }
    stage.classList.toggle('focus', sc === 'A' || sc === 'B');
    stage.classList.toggle('results', sc === 'results');
    $('#panel').classList.toggle('hidden', !(sc === 'A' || sc === 'B'));
    $('#panel').className = (sc === 'A' || sc === 'B') ? (sc === 'A' ? 'a' : 'b') : 'hidden';
    $('#results').classList.toggle('hidden', sc !== 'results');
    $('#introLabels').style.display = sc === 'intro' ? '' : 'none';
    $('#labA').style.left = L.A.x + 'px'; $('#labB').style.left = L.B.x + 'px';
    $('#labA').style.display = L.A.a > 0.5 ? '' : 'none';
    if (sc === 'A' || sc === 'B') $('#pTitle').textContent = `${THEMES[sc].emoji} ${THEMES[sc].label}`;
    if (sc !== 'A' && sc !== 'B') { presented = null; $('#winnerCard').classList.add('hidden'); }
    applyMix();
    renderPrize();
    renderWinners();
  }

  function applyMix() {
    for (const u of ['A', 'B']) {
      const active = state.scene === u;
      drums[u].setMix(state.mixing && active ? 0.9 : active ? 0.22 : 0.14);
    }
    const anyMix = state.mixing && (state.scene === 'A' || state.scene === 'B');
    sfx.setMix(anyMix ? 0.9 : 0.15);
  }

  function renderPrize() {
    const sc = state.scene;
    if (sc !== 'A' && sc !== 'B') return;
    const list = data.prizes.filter((p) => p.urn === sc);
    let p = list.find((x) => x.id === state.prizeId);
    if (!p && sc === 'A') p = list.find((x) => x.remaining > 0) || list[0];
    const label = p ? p.label : 'Elige el premio';
    $('#prizeLabel').textContent = label;
    // los nombres largos se achican para caber en una línea
    $('#prizeLabel').style.fontSize = label.length > 16 ? '50px' : label.length > 11 ? '60px' : '76px';
    $('#prizeLeft').textContent = p ? `Quedan ${p.remaining} de ${p.qty}` : '';
    const card = $('#prizeCard');
    card.classList.remove('pulse'); void card.offsetWidth; card.classList.add('pulse');
  }

  function renderWinners(newId) {
    const sc = state.scene;
    if (sc === 'A' || sc === 'B') {
      const list = data.winners.filter((w) => w.urn === sc).slice().reverse();
      $('#wl').innerHTML = list.slice(0, 14).map((w) =>
        `<li class="${w.id === newId ? 'new' : ''}"><span>${esc(w.user)}</span><b>${esc(sc === 'A' ? w.code : w.prize)}</b></li>`).join('');
    }
    for (const u of ['A', 'B']) {
      const list = data.winners.filter((w) => w.urn === u);
      $(`#res${u} ol`).innerHTML = list.map((w) => `<li><span>${esc(w.user)} <small style="opacity:.6">${esc(w.code)}</small></span><b>${esc(w.prize)}</b></li>`).join('')
        || '<li style="opacity:.6">Aún sin ganadores</li>';
    }
  }

  function renderIntro() {
    const name = data.draw.name || '';
    $('#drawName').textContent = name;
    const lab = (u) => {
      const t = data.tickets[u];
      const players = new Set(t.map((x) => x.p)).size;
      return `${THEMES[u].emoji} ${t.length} tickets <span>· ${players} jugadores</span>`;
    };
    $('#labA').innerHTML = lab('A'); $('#labB').innerHTML = lab('B');
    $('#badge').classList.toggle('hidden', !data.rehearsal);
  }

  function loadDrums() {
    for (const u of ['A', 'B']) {
      const winnersHere = new Set(data.winners.filter((w) => w.urn === u).map((w) => w.p));
      (data.discarded || []).filter((d) => d.urn === u).forEach((d) => winnersHere.add(d.p)); // los "al agua" ya no participan
      drums[u].setTickets(data.tickets[u], winnersHere);
    }
  }

  async function reload() {
    const r = await fetch('/api/live/snapshot');
    if (!r.ok) return;
    data = await r.json();
    state = data.state;
    loadDrums();
    renderIntro();
    applyScene(false);
  }

  // ---------- Extracción ----------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runExtraction(result) {
    busy = true;
    const drum = drums[result.urn];
    $('#winnerCard').classList.add('hidden');
    presented = null;
    // mostrar el premio que se está sorteando
    state.prizeId = result.prize.id; renderPrize();
    // 1) suspenso: mezcla fuerte + redoble
    drum.setMix(1); sfx.setMix(1);
    sfx.drumroll(2.8);
    await wait(2800);
    // 2) la pelotita ganadora sube por la boca del bombo
    const ball = await new Promise((resolve) => drum.startCapture(result.code, resolve));
    sfx.whoosh();
    drum.setMix(0.35); sfx.setMix(0.3);
    // 3) viaja por el tubo hasta el panel
    const color = ball ? ball.color : THEMES[result.urn].balls[0];
    const mouth = drum.toScreen(0, -R - 50);
    const startR = drum.ballR * drum.layout.s;
    flying = { color, text: Bombo.shortCode(result.code), t: 0, dur: 1.35, path: tubePath(mouth), r0: startR, angle: 0 };
    await wait(1350);
    flying = null;
    // 4) revelación
    presented = { color, code: result.code, t: 0, angle: Math.PI * 1.5 };
    sfx.ding();
    sfx.fanfare(result.urn);
    confetti.burst(PRES.x, PRES.y, result.urn === 'A' ? ['#ff7a1a', '#a855f7', '#ffd23f', '#ffffff'] : ['#22b8ff', '#2ee59d', '#ffd23f', '#ffffff']);
    setTimeout(() => confetti.burst(PRES.x, PRES.y, ['#ffd23f', '#ffffff', '#ff7a1a', '#22b8ff'], 140), 450);
    $('#wUser').textContent = result.user;
    $('#wCode').textContent = `Ticket ${result.code}`;
    $('#wPrize').textContent = result.prize.label;
    $('#winnerCard').classList.remove('hidden');
    // actualizar datos locales
    data.winners.push({ id: result.id, urn: result.urn, code: result.code, user: result.user, p: result.p, prize: result.prize.label });
    const pz = data.prizes.find((p) => p.id === result.prize.id); if (pz) pz.remaining = Math.max(0, pz.remaining - 1);
    renderPrize(); renderWinners(result.id);
    // 5) las demás pelotitas del ganador salen del bombo (1 premio por persona)
    setTimeout(() => drum.removePlayer(result.p), 1600);
    await wait(1500);
    applyMix();
    busy = false;
  }

  // ---------- "Al agua": el ganador no estaba en el vivo ----------
  let splash = [];
  async function runDiscard(d) {
    while (busy) await wait(200);
    data.winners = data.winners.filter((w) => w.id !== d.id);
    (data.discarded = data.discarded || []).push({ urn: d.urn, p: d.p, code: d.code });
    const pz = data.prizes.find((p) => p.id === d.prizeId); if (pz) pz.remaining += 1;
    state.prizeId = d.prizeId;
    sfx.splash();
    if (presented && presented.code === d.code) presented.falling = { vy: -6, t: 0 };
    const card = $('#winnerCard');
    if (!card.classList.contains('hidden')) {
      $('#wPrize').textContent = '💧 ¡AL AGUA!';
      card.classList.add('water');
    }
    drums[d.urn].removePlayer(d.p);
    renderWinners();
    await wait(2600);
    card.classList.add('hidden'); card.classList.remove('water');
    presented = null;
    renderPrize();
  }

  function tubePath(mouth) {
    // curva cúbica: sube desde la boca del bombo y baja al punto de presentación
    // entra al punto de presentación por la izquierda, sin cruzar la tarjeta del premio
    return { p0: mouth, p1: { x: mouth.x + 30, y: -60 }, p2: { x: PRES.x - 520, y: PRES.y + 10 }, p3: { x: PRES.x, y: PRES.y } };
  }
  function bez(p, t) {
    const u = 1 - t;
    return {
      x: u * u * u * p.p0.x + 3 * u * u * t * p.p1.x + 3 * u * t * t * p.p2.x + t * t * t * p.p3.x,
      y: u * u * u * p.p0.y + 3 * u * u * t * p.p1.y + 3 * u * t * t * p.p2.y + t * t * t * p.p3.y,
    };
  }

  // ---------- Tiempo real ----------
  function connect() {
    const es = new EventSource('/api/live/stream');
    es.addEventListener('hello', () => reload());
    es.addEventListener('reload', () => reload());
    es.addEventListener('scene', (e) => { state = JSON.parse(e.data).state; applyScene(true); });
    es.addEventListener('mix', (e) => { state = JSON.parse(e.data).state; applyMix(); });
    es.addEventListener('prize', (e) => { state = JSON.parse(e.data).state; renderPrize(); });
    es.addEventListener('clear', (e) => { state = JSON.parse(e.data).state; presented = null; $('#winnerCard').classList.add('hidden'); });
    es.addEventListener('discard', (e) => { const msg = JSON.parse(e.data); state = msg.state; runDiscard(msg.discard); });
    es.addEventListener('extract', (e) => {
      const msg = JSON.parse(e.data);
      state = msg.state;
      if (state.scene !== msg.result.urn) { state.scene = msg.result.urn; applyScene(true); }
      runExtraction(msg.result);
    });
    es.onerror = () => { es.close(); setTimeout(connect, 2000); };
  }

  // ---------- Bucle de dibujo ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    drums.A.step(dt); drums.B.step(dt); confetti.step(dt);
    ctx.clearRect(0, 0, W, H);
    const accent = state?.scene === 'A' ? '#ff8a1f' : '#22b8ff';
    if (!transparent) backdrop.draw(ctx, now / 1000, accent);
    drums.A.draw(ctx, { showHidden: true }); drums.B.draw(ctx, { showHidden: true });
    if (state && (state.scene === 'A' || state.scene === 'B')) drawTube(state.scene);
    if (flying) {
      flying.t += dt / flying.dur;
      const t = ease(clamp(flying.t, 0, 1)), p = bez(flying.path, t);
      flying.angle += dt * 14;
      drawBall(ctx, p.x, p.y, lerp(flying.r0, 46, t), flying.color, flying.angle, flying.text, 1, '#ffffff');
    }
    if (presented) {
      presented.t += dt;
      const g = clamp(presented.t / 0.6, 0, 1), sc = 0.45 + 0.55 * (1 - Math.pow(1 - g, 3));
      // gira hasta quedar de frente mostrando el número completo
      presented.angle = lerp(presented.angle, 0, 1 - Math.pow(0.04, dt));
      const bob = Math.sin(presented.t * 2.2) * 6;
      ctx.save();
      const halo = ctx.createRadialGradient(PRES.x, PRES.y, 10, PRES.x, PRES.y, PRES.r * 2.1);
      halo.addColorStop(0, 'rgba(255,220,90,0.55)'); halo.addColorStop(1, 'rgba(255,220,90,0)');
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(PRES.x, PRES.y, PRES.r * 2.1, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      let py = PRES.y + bob, alpha = 1;
      if (presented.falling) { // cae al agua
        const f = presented.falling;
        f.t += dt; f.vy += 60 * dt; f.y = (f.y || 0) + f.vy * dt * 60;
        py = PRES.y + f.y; alpha = clamp(1 - (py - 700) / 300, 0, 1);
        if (!f.splashed && py > 980) { f.splashed = true; makeSplash(PRES.x, 1000); }
      }
      if (alpha > 0) drawBall(ctx, PRES.x, py, PRES.r * sc, presented.color, presented.angle, presented.code, alpha, presented.falling ? null : '#ffd23f');
    }
    drawSplash(dt);
    confetti.draw(ctx);
    requestAnimationFrame(frame);
  }

  function makeSplash(x, y) {
    for (let i = 0; i < 90; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6, v = 6 + Math.random() * 14;
      splash.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 3 + Math.random() * 6, life: 1.2 + Math.random() * 0.6 });
    }
    splash.push({ ring: true, x, y, t: 0 });
  }
  function drawSplash(dt) {
    if (!splash.length) return;
    ctx.save();
    for (const s of splash) {
      if (s.ring) {
        s.t += dt;
        ctx.strokeStyle = `rgba(120,200,255,${Math.max(0, 0.8 - s.t * 0.6)})`; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.ellipse(s.x, s.y, 40 + s.t * 260, 10 + s.t * 50, 0, 0, Math.PI * 2); ctx.stroke();
        s.life = 1.4 - s.t;
        continue;
      }
      s.vy += 0.5 * dt * 60; s.x += s.vx * dt * 60; s.y += s.vy * dt * 60; s.life -= dt;
      ctx.fillStyle = `rgba(140,210,255,${clamp(s.life, 0, 1) * 0.9})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    splash = splash.filter((s) => s.life > 0);
  }

  function drawTube(scene) {
    const drum = drums[scene];
    if (drum.layout.a < 0.6) return;
    const path = tubePath(drum.toScreen(0, -R - 50));
    ctx.save();
    ctx.globalAlpha = drum.layout.a * 0.9;
    ctx.lineCap = 'round';
    const steps = 40;
    const trace = () => { ctx.beginPath(); for (let i = 0; i <= steps; i++) { const p = bez(path, i / steps); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); } };
    trace(); ctx.strokeStyle = 'rgba(160,210,255,0.16)'; ctx.lineWidth = 104; ctx.stroke();
    trace(); ctx.strokeStyle = 'rgba(8,18,46,0.55)'; ctx.lineWidth = 90; ctx.stroke();
    trace(); ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 6; ctx.setLineDash([]); ctx.stroke();
    ctx.translate(-30, -30);
    trace(); ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 8; ctx.stroke();
    ctx.restore();
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // Aviso de sonido (solo en navegador normal; en OBS el audio arranca solo)
  setInterval(() => {
    const hint = $('#soundHint');
    // OBS reproduce el audio solo; el aviso nunca debe salir en la transmisión.
    hint.classList.toggle('hidden', !!window.obsstudio || !sfx.ctx || sfx.ctx.state === 'running' || !sfx.enabled);
  }, 800);
  $('#soundHint').addEventListener('click', () => sfx.ctx && sfx.ctx.resume());

  requestAnimationFrame(frame);
  connect();
})();
