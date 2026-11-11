/* Página pública: bombos girando con los tickets reales, búsqueda de tus pelotitas y lista completa. */
(async () => {
  const { Drum, Sfx, Backdrop, W, H } = Bombo;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Mismo enmascarado que el servidor: así el jugador puede buscar con su usuario completo.
  const mask = (u) => { u = String(u || ''); if (u.length <= 4) return u.slice(0, 1) + '***'; if (u.length <= 6) return u.slice(0, 2) + '***' + u.slice(-1); return u.slice(0, 3) + '***' + u.slice(-2); };

  const data = await (await fetch('data.json', { cache: 'no-store' })).json();
  const hasA = data.tickets.A.length > 0 || data.prizes.some((p) => p.urn === 'A');
  $('#drawName').textContent = data.draw.name;
  const closed = new Date(data.draw.cutoff_at) <= new Date();
  $('#status').textContent = data.winners.length ? '✅ Sorteo realizado' : closed ? '🔒 Tickets cerrados · ¡nos vemos en el stream!' : '🎟️ Recibiendo tickets';

  // ---------- Bombos ----------
  const canvas = $('#c'), ctx = canvas.getContext('2d');
  const sfx = new Sfx(); sfx.enabled = false;
  const backdrop = new Backdrop();
  const small = innerWidth < 700;
  const drums = {};
  const winnersBy = (u) => new Set(data.winners.filter((w) => w.urn === u).map((w) => w.p));
  if (hasA) {
    drums.A = new Drum('A', sfx); drums.A.maxBalls = small ? 120 : 230;
    drums.A.setTickets(data.tickets.A, winnersBy('A'));
    Object.assign(drums.A.layout, { x: 540, y: 590, s: 0.7, a: 1 });
  }
  drums.B = new Drum('B', sfx); drums.B.maxBalls = small ? 120 : 230;
  drums.B.setTickets(data.tickets.B, winnersBy('B'));
  Object.assign(drums.B.layout, hasA ? { x: 1380, y: 590, s: 0.7, a: 1 } : { x: 960, y: 590, s: 0.78, a: 1 });
  Object.values(drums).forEach((d) => d.setMix(0.3));

  // Mezcla fuerte por momentos, como en el stream
  setInterval(() => {
    Object.values(drums).forEach((d) => d.setMix(0.85));
    sfx.setMix(0.8);
    setTimeout(() => { Object.values(drums).forEach((d) => d.setMix(0.3)); sfx.setMix(0.2); }, 2600);
  }, 9000);

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    Object.values(drums).forEach((d) => d.step(dt));
    ctx.clearRect(0, 0, W, H);
    backdrop.draw(ctx, now / 1000);
    Object.values(drums).forEach((d) => d.draw(ctx, { showHidden: true }));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  $('#soundBtn').addEventListener('click', () => {
    sfx.init(); sfx.enabled = !sfx.enabled;
    if (sfx.ctx) sfx.ctx.resume();
    sfx.setMix(0.3);
    $('#soundBtn').textContent = sfx.enabled ? '🔊 Sonido' : '🔇 Sonido';
  });

  // ---------- Premios y ganadores ----------
  for (const u of ['A', 'B']) {
    const list = data.prizes.filter((p) => p.urn === u);
    $(`#pr${u} ul`).innerHTML = list.map((p) => `<li><b>${esc(p.label)}</b> × ${p.qty}</li>`).join('') || '<li class="muted">—</li>';
    $(`#pr${u}`).classList.toggle('hidden', u === 'A' && !hasA);
  }
  if (data.winners.length) {
    $('#winnersBox').classList.remove('hidden');
    for (const u of ['A', 'B']) {
      $(`#win${u}`).innerHTML = data.winners.filter((w) => w.urn === u)
        .map((w) => `<li>${esc(w.user)} <code>${esc(w.code)}</code> · <b>${esc(w.prize)}</b></li>`).join('') || '<li class="muted">—</li>';
    }
  }

  // ---------- Lista ----------
  let tab = hasA ? 'A' : 'B';
  if (!hasA) { $('#tabA').classList.add('hidden'); }
  let mineCodes = new Set();
  function renderList() {
    const t = data.tickets[tab];
    const players = new Set(t.map((x) => x.p)).size;
    $('#listInfo').textContent = `${t.length} tickets · ${players} jugadores`;
    $('#list').innerHTML = t.map((x) => `<div class="row ${mineCodes.has(x.code) ? 'me' : ''}"><code>${esc(x.code)}</code><span>${esc(x.user)}</span></div>`).join('')
      || '<p class="muted">Sin tickets en este bombo.</p>';
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.u === tab));
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.u; renderList(); }));
  renderList();

  // ---------- Búsqueda ----------
  const all = [...data.tickets.A.map((t) => ({ ...t, urn: 'A' })), ...data.tickets.B.map((t) => ({ ...t, urn: 'B' }))];
  function search() {
    const q = $('#q').value.trim();
    if (!q) { mineCodes = new Set(); Object.values(drums).forEach((d) => (d.highlightFn = null)); $('#mine').innerHTML = ''; renderList(); return; }
    const qc = q.toUpperCase();
    let hits = all.filter((t) => t.code === qc);
    if (hits.length) hits = all.filter((t) => t.p === hits[0].p);
    else { const m = mask(q); hits = all.filter((t) => t.user === m || t.user.toLowerCase() === q.toLowerCase()); }
    mineCodes = new Set(hits.map((h) => h.code));
    const pset = new Set(hits.map((h) => h.p));
    Object.values(drums).forEach((d) => (d.highlightFn = hits.length ? (t) => pset.has(t.p) : null));
    if (!hits.length) { $('#mine').innerHTML = '<p class="muted">No encontramos tickets con ese dato. Revisa que esté bien escrito.</p>'; renderList(); return; }
    const won = new Set(data.winners.map((w) => w.code));
    const box = (u) => {
      const mine = hits.filter((h) => h.urn === u);
      if (!mine.length) return '';
      const total = data.tickets[u].length;
      const pct = ((100 * mine.length) / total).toFixed(2);
      return `<div class="mineBox"><div class="who">${u === 'A' ? '🎃 Comodines' : '🎁 Premios'}: ${mine.length} ticket${mine.length === 1 ? '' : 's'} de ${total} (${pct} %)</div>
        <div class="chips">${mine.map((h) => `<span class="chip ${u.toLowerCase()} ${won.has(h.code) ? 'win' : ''}">${esc(h.code)}${won.has(h.code) ? ' 🏆' : ''}</span>`).join('')}</div></div>`;
    };
    $('#mine').innerHTML = `<p>Usuario <b>${esc(hits[0].user)}</b> · tus pelotitas brillan en el bombo ✨</p>${box('A')}${box('B')}`;
    renderList();
  }
  let timer;
  $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
})();
