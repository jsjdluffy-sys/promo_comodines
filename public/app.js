(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n).toLocaleString('es-CO');
  const digits = (s) => String(s || '').replace(/\D/g, '');
  // Fechas siempre en la zona horaria del negocio, aunque el PC del agente tenga otra.
  const fmtDate = (iso) => new Date(iso).toLocaleString('es-CO', {
    dateStyle: 'short', timeStyle: 'short', timeZone: status?.timezone || undefined,
  });
  const fmtDay = (k) => k.split('-').reverse().join('/');

  let me = null;
  let status = null;
  let current = null; // resumen del jugador seleccionado

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.body ? 'POST' : 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Sesión expirada'); }
    if (!res.ok) { const e = new Error(data.error || 'Error'); e.code = data.code; throw e; }
    return data;
  }

  function toast(text, err = false) {
    const t = $('#toast');
    t.textContent = text;
    t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.className = 'toast'), 3200);
  }

  // ---------- Login ----------
  function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/login', { body: { username: f.get('username'), password: f.get('password') } });
      start();
    } catch (err) { $('#loginError').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('/api/logout', { body: {} }).catch(() => {}); showLogin(); });

  async function start() {
    try { me = await api('/api/me'); } catch { return showLogin(); }
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#agentName').textContent = `${me.name} · ${me.role}`;
    document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', me.role !== 'admin'));
    await refreshStatus();
    setInterval(refreshStatus, 30000);
    $('#searchInput').focus();
  }

  function timeLeft(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'cerrado';
    const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d ? `faltan ${d} d ${h} h` : h ? `faltan ${h} h ${m % 60} min` : `faltan ${m % 60} min`;
  }

  async function refreshStatus() {
    const wasOpen = status?.draw?.key;
    status = await api('/api/status');
    const bar = $('#statusBar');
    const d = status.draw;
    bar.classList.toggle('blocked', !d);
    bar.innerHTML = d
      ? `🎟️ <b>${esc(d.name)}</b> · tickets hasta el <b>${esc(d.cutoff_label)}</b> (${timeLeft(d.cutoff_at)})${d.comodines_enabled ? ' · 🎃 con Comodines' : ''} · hora Chile ${esc(status.localTime)}`
      : `⛔ <b>Entregas de tickets bloqueadas.</b> No hay sorteo abierto${status.lastDraw ? ` (el último, "${esc(status.lastDraw.name)}", cerró el ${esc(status.lastDraw.cutoff_label)})` : ''}. Se reactivan cuando el admin anuncie un nuevo sorteo.`;
    // Si el sorteo se abrió o cerró mientras el agente trabajaba, refrescar la ficha abierta.
    if (current && (status.draw?.key || null) !== (wasOpen || null) && wasOpen !== undefined) openPlayer(current.player.id);
  }

  // ---------- Tabs ----------
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
    ({ draw: loadDraw, draws: loadDraws, audit: loadAudit, agents: loadAgents, stream: loadStream }[b.dataset.tab] || (() => {}))();
  }));

  // ---------- Búsqueda ----------
  let searchTimer;
  $('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 200); });
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('#searchResults li'); if (first) first.click(); }
  });

  async function doSearch() {
    const qtext = $('#searchInput').value.trim();
    const ul = $('#searchResults');
    if (!qtext) { ul.innerHTML = ''; $('#createBox').classList.add('hidden'); return; }
    const list = await api('/api/players?q=' + encodeURIComponent(qtext));
    ul.innerHTML = list.map((p) =>
      `<li data-id="${p.id}"><span>${esc(p.username)}</span></li>`).join('');
    ul.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => openPlayer(Number(li.dataset.id))));
    const exact = list.some((p) => p.username.toLowerCase() === qtext.toLowerCase());
    $('#createBox').classList.toggle('hidden', exact);
    $('#createName').textContent = qtext;
  }

  $('#createBtn').addEventListener('click', async () => {
    try {
      const p = await api('/api/players', { body: { username: $('#searchInput').value.trim() } });
      toast(`Usuario ${p.username} registrado`);
      await doSearch();
      openPlayer(p.id);
    } catch (e) { toast(e.message, true); }
  });

  // ---------- Jugador ----------
  async function openPlayer(id) {
    current = await api('/api/players/' + id);
    document.querySelectorAll('#searchResults li').forEach((li) => li.classList.toggle('sel', Number(li.dataset.id) === id));
    renderPlayer();
  }

  function renderPlayer(lastResult) {
    const s = current;
    const p = s.player;
    const elig = !!p.halloween_eligible;
    const open = status.draw;
    const comodinesOn = !!open?.comodines_enabled;
    const canA = comodinesOn;
    $('#playerPane').innerHTML = `
      <div class="card">
        <div class="player-head">
          <div class="player-name">${esc(p.username)}</div>

        </div>
        <div class="stats">
          <div class="stat"><div class="k">Último total registrado hoy</div><div class="v">${s.today.lastTotal == null ? '—' : fmt(s.today.lastTotal)}</div></div>
          <div class="stat"><div class="k">Entregados hoy</div><div class="v">${s.today.given} / ${s.today.cap}</div></div>
          <div class="stat"><div class="k">🎃 Comodín (este sorteo)</div><div class="v">${s.week.A.length}</div></div>
          <div class="stat"><div class="k">🎁 Premios (este sorteo)</div><div class="v">${s.week.B.length}</div></div>
        </div>
      </div>

      ${open ? `      <div class="card">
        <h3>Entregar tickets</h3>
        <label class="lbl">Total recargado HOY según el backoffice (acumulado del día)</label>
        <input id="amount" class="amount" inputmode="numeric" placeholder="0" autocomplete="off">
        <div id="confirmWrap" class="hidden">
          <label class="lbl" style="margin-top:10px">⚠️ Monto alto: vuelve a escribirlo para confirmar</label>
          <input id="amount2" class="amount" inputmode="numeric" placeholder="Repite el monto" autocomplete="off">
        </div>
        <div id="calc" class="calc muted">Escribe el total para ver el cálculo.</div>

        <div class="lbl">Destino de los tickets</div>
        <div class="dest ${comodinesOn ? '' : 'hidden'}">
          <label><input type="radio" name="dest" value="premios" checked><span>🎁 Premios</span></label>
          <label><input type="radio" name="dest" value="comodin" ${canA ? '' : 'disabled'}><span>🎃 Comodín</span></label>
          <label><input type="radio" name="dest" value="dividir" ${canA ? '' : 'disabled'}><span>⚖️ Dividir</span></label>
        </div>
        ${!comodinesOn ? '<div class="muted" style="margin-bottom:12px">🎁 Este sorteo no tiene Comodines: todos los tickets van al Bombo Premios.</div>'
          : '<div class="muted" style="font-size:.85rem;margin-bottom:10px">El jugador elige: 🎃 Comodín (recuperar un bono de Halloween), 🎁 Premios, o Dividir entre ambos.</div>'}
        <div id="splitWrap" class="split hidden">
          <label class="splitbox a">🎃 Comodín<input id="aCount" type="number" min="0" value="0" inputmode="numeric"></label>
          <label class="splitbox b">🎁 Premios<input id="bCount" type="number" min="0" value="0" inputmode="numeric"></label>
          <button type="button" id="halfBtn" class="btn small">½ Mitad y mitad</button>
          <span id="splitRest" class="muted"></span>
        </div>
        <button id="confirmBtn" class="btn primary big" disabled>✅ Confirmar entrega</button>
      </div>` : `      <div class="card blocked-card">
        <h3>⛔ Entregas bloqueadas</h3>
        <p class="muted">No hay sorteo abierto. Puedes responder al usuario:<br>
        <i>"La recepción de tickets ya cerró. Te avisaremos cuando abramos el próximo sorteo 🍀"</i></p>
      </div>
`}

      ${lastResult ? `
      <div class="card">
        <div class="row between"><h3>Mensaje para el usuario</h3><button id="copyBtn" class="btn">📋 Copiar</button></div>
        <div class="msg" id="msgText">${esc(lastResult.message)}</div>
      </div>` : ''}

      <div class="card">
        <h3>Tickets ${s.draw ? `· ${esc(s.draw.name)} (${fmtDay(s.draw.key)})` : ''}</h3>
        ${me.role === 'admin' && (s.week.A.length || s.week.B.length) ? '<div class="muted" style="font-size:.85rem">Para anular tickets sueltos (por ej. entregados de más), haz clic en ellos y luego en "Anular seleccionados".</div>' : ''}
        <div class="chips">${s.week.A.map((t) => `<span class="chip a ${me.role === 'admin' ? 'clickable' : ''}" data-code="${esc(t.code)}">${esc(t.code)}</span>`).join('')}${s.week.B.map((t) => `<span class="chip b ${me.role === 'admin' ? 'clickable' : ''}" data-code="${esc(t.code)}">${esc(t.code)}</span>`).join('') || (s.week.A.length ? '' : '<span class="muted">Aún no tiene tickets en este sorteo.</span>')}${(s.voidedTickets || []).map((t) => `<span class="chip voided" title="Anulado">${esc(t.code)}</span>`).join('')}</div>
        ${me.role === 'admin' ? '<button id="voidSelBtn" class="btn small hidden" style="margin-top:8px">🗑️ Anular seleccionados</button>' : ''}
        <div class="row between wrap" style="margin-top:18px">
          <h3 style="margin:0">Historial de entregas</h3>
          ${me.role === 'admin' && s.history.some((h) => !h.voided_at) ? '<button id="voidAllBtn" class="btn small">🗑️ Anular todas sus entregas</button>' : ''}
        </div>
        <div class="tablewrap"><table class="table"><thead><tr><th>Fecha</th><th>Total reportado</th><th>Tickets</th><th>A / B</th><th>Agente</th>${me.role === 'admin' ? '<th></th>' : ''}</tr></thead>
        <tbody>${s.history.map((h) => `<tr class="${h.voided_at ? 'voided' : ''}"><td>${fmtDate(h.created_at)}</td><td>${fmt(h.total_reported)}</td>
          <td>${h.delivered === 0 && !h.voided_at ? '<span class="pill">Corrección de total</span>' : h.delivered}${h.codes ? `<div class="muted" style="font-size:.8rem">${esc(h.codes)}</div>` : ''}</td><td>${h.to_a} / ${h.to_b}</td><td>${esc(h.agent_name)}</td>
          ${me.role === 'admin' ? (h.voided_at
            ? `<td class="void-info">Anulada por ${esc(h.voided_by_name)}: ${esc(h.void_reason)}</td>`
            : h.delivered === 0 ? '<td></td>' : `<td><button class="btn small" data-void="${h.id}">Anular</button></td>`) : ''}</tr>`).join('')
          || `<tr><td colspan="6" class="muted">Sin entregas todavía.</td></tr>`}</tbody></table></div>
      </div>`;

    bindPlayerForm();
    if (lastResult) {
      $('#copyBtn').addEventListener('click', () => {
        navigator.clipboard.writeText(lastResult.message).then(() => toast('Mensaje copiado'), () => toast('No se pudo copiar', true));
      });
    }
  }

  function bindPlayerForm() {
    if ($('#hwBtn')) bindHalloween();
    bindVoid();
    if (!$('#amount')) return;
    const amount = $('#amount');
    const amount2 = $('#amount2');
    let preview = null;
    let pvTimer;

    const formatInput = (el) => {
      const d = digits(el.value);
      el.value = d ? fmt(Number(d)) : '';
    };

    const dest = () => document.querySelector('input[name="dest"]:checked').value;

    // Dividir: dos casillas enlazadas (Comodín + Premios = total a entregar).
    let lastTotal = null;
    function setSplit(a) {
      const t = preview.toDeliver;
      const n = Math.min(Math.max(0, Math.round(Number(a) || 0)), t);
      $('#aCount').value = n;
      $('#bCount').value = t - n;
      $('#aCount').max = t; $('#bCount').max = t;
      $('#splitRest').textContent = `Total: ${t} ticket${t === 1 ? '' : 's'}`;
    }
    function updateSplit(e) {
      const show = dest() === 'dividir' && preview && preview.toDeliver > 0;
      $('#splitWrap').classList.toggle('hidden', !show);
      if (show) {
        const t = preview.toDeliver;
        if (e?.target?.id === 'bCount') setSplit(t - (Number($('#bCount').value) || 0));
        else if (e?.target?.name === 'dest' || lastTotal !== t) setSplit(Math.floor(t / 2)); // por defecto: mitad
        else setSplit($('#aCount').value);
        lastTotal = t;
      }
      updateButton();
    }

    function updateButton() {
      let ok = preview && preview.toDeliver > 0;
      if (ok && preview.needsDoubleCheck) ok = digits(amount2.value) === digits(amount.value);
      $('#confirmBtn').disabled = !ok;
    }

    async function runPreview() {
      const total = digits(amount.value);
      const box = $('#calc');
      preview = null;
      if (!total) { box.className = 'calc muted'; box.textContent = 'Escribe el total para ver el cálculo.'; updateSplit(); return; }
      try {
        preview = await api(`/api/players/${current.player.id}/preview`, { body: { total: Number(total) } });
        $('#confirmWrap').classList.toggle('hidden', !preview.needsDoubleCheck);
        const check = preview.prevTotal === null
          ? `<div class="check">🆕 Primera entrega de hoy: el monto debe ser <b>todo lo recargado hoy</b> según el backoffice.</div>`
          : `<div class="check">🔎 Último total de hoy: <b>${fmt(preview.prevTotal)}</b> → ahora <b>${fmt(Number(total))}</b> =
             <b class="inc">+${fmt(preview.increase)}</b> desde la última entrega.<br>
             <span class="muted">¿Coincide con lo que el usuario dice que recargó? Si dijo otro monto, revisa: debes escribir el TOTAL del día, no solo el último depósito.</span></div>`;
        const base = `${check}<div class="line"><span>Corresponden hoy: <b>${preview.ticketsForDay}</b></span><span>Ya tenía: <b>${preview.alreadyGiven}</b></span></div>`;
        if (preview.toDeliver > 0) {
          box.className = 'calc ok';
          box.innerHTML = `${base}<div class="deliver-n">ENTREGAR ${preview.toDeliver} ticket${preview.toDeliver === 1 ? '' : 's'}</div>
            ${preview.missingForNext ? `<div class="muted">Le faltan ${fmt(preview.missingForNext)} para el siguiente ticket.</div>` : '<div class="muted">Con esto llega al tope diario.</div>'}`;
        } else {
          box.className = 'calc warn';
          const why = {
            CAP_REACHED: `Ya alcanzó el tope de ${status.dailyCap} tickets de hoy.`,
            NO_CHANGE: 'El total no cambió: su recarga aún no se refleja. Sugiere: "Tu recarga aún no se refleja, escríbenos en unos minutos".',
            BELOW_NEXT_TICKET: `No hay tickets nuevos. Le faltan ${fmt(preview.missingForNext || 0)} para el siguiente.`,
          }[preview.status];
          box.innerHTML = `${base}<div><b>0 tickets.</b> ${esc(why)}</div>`;
        }
      } catch (e) {
        box.className = 'calc bad';
        box.innerHTML = `⛔ ${esc(e.message)}`;
        $('#confirmWrap').classList.add('hidden');
      }
      updateSplit();
    }

    amount.addEventListener('input', () => { formatInput(amount); clearTimeout(pvTimer); pvTimer = setTimeout(runPreview, 250); });
    amount2.addEventListener('input', () => { formatInput(amount2); updateButton(); });
    document.querySelectorAll('input[name="dest"]').forEach((r) => r.addEventListener('change', updateSplit));
    $('#aCount').addEventListener('input', updateSplit);
    $('#bCount').addEventListener('input', updateSplit);
    $('#halfBtn').addEventListener('click', () => { setSplit(Math.floor(preview.toDeliver / 2)); updateButton(); });
    amount.focus();

    $('#confirmBtn').addEventListener('click', async () => {
      const btn = $('#confirmBtn');
      btn.disabled = true;
      const body = {
        total: Number(digits(amount.value)),
        confirmTotal: preview?.needsDoubleCheck ? Number(digits(amount2.value)) : null,
        destination: dest(),
        aCount: dest() === 'dividir' ? Number($('#aCount').value) || 0 : undefined,
      };
      try {
        const r = await api(`/api/players/${current.player.id}/claim`, { body });
        toast(`Entregados ${r.calc.toDeliver} tickets`);
        current = await api('/api/players/' + current.player.id);
        renderPlayer(r);
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
        runPreview();
      }
    });
  }

  function bindVoid() {
    const sel = new Set();
    const btn = $('#voidSelBtn');
    document.querySelectorAll('.chip.clickable').forEach((c) => c.addEventListener('click', () => {
      const code = c.dataset.code;
      if (sel.has(code)) sel.delete(code); else sel.add(code);
      c.classList.toggle('sel', sel.has(code));
      if (btn) { btn.classList.toggle('hidden', !sel.size); btn.textContent = `🗑️ Anular seleccionados (${sel.size})`; }
    }));
    if (btn) btn.addEventListener('click', async () => {
      const totalTxt = prompt(`Vas a anular ${sel.size} ticket(s): ${[...sel].join(', ')}.\n\n¿Cuál es el TOTAL REAL recargado ese día según el backoffice?\n(el sistema lo usará como último total del día)`);
      if (totalTxt === null) return;
      const correctedTotal = Number(String(totalTxt).replace(/\D/g, ''));
      if (!String(totalTxt).replace(/\D/g, '')) return toast('Escribe el total del día', true);
      const reason = prompt('Motivo de la anulación:', 'Tickets entregados de más');
      if (!reason) return;
      try {
        const r = await api('/api/tickets/void', { body: { codes: [...sel], draw: current.draw.key, reason, correctedTotal } });
        toast(`Anulados ${r.voidedTickets} tickets`);
        await openPlayer(current.player.id);
      } catch (e) { toast(e.message, true); }
    });
    const run = async (url, question) => {
      const reason = prompt(question + '\n\nEscribe el motivo (queda en la auditoría):', 'Ticket de prueba');
      if (!reason) return;
      try {
        const r = await api(url, { body: { reason } });
        toast(`Anulados ${r.voidedTickets} tickets`);
        await openPlayer(current.player.id);
      } catch (e) { toast(e.message, true); }
    };
    document.querySelectorAll('[data-void]').forEach((b) => b.addEventListener('click', () =>
      run(`/api/claims/${b.dataset.void}/void`, '¿Anular esta entrega? Sus tickets salen del sorteo.')));
    const all = $('#voidAllBtn');
    if (all) all.addEventListener('click', () =>
      run(`/api/players/${current.player.id}/void-all`, `¿Anular TODAS las entregas de ${current.player.username}? Todos sus tickets salen del sorteo.`));
  }

  function bindHalloween() {
    $('#hwBtn').addEventListener('click', async () => {
      const elig = !current.player.halloween_eligible;
      if (!elig && !confirm('¿Quitar la marca del Reto Halloween? Los tickets que ya tiene en la Urna A se mantienen.')) return;
      try {
        await api(`/api/players/${current.player.id}/halloween`, { body: { eligible: elig } });
        await openPlayer(current.player.id);
        doSearch();
      } catch (e) { toast(e.message, true); }
    });
  }

  // ---------- Sorteo ----------
  let selectedDraw = null;
  $('#drawSelect').addEventListener('change', (e) => { selectedDraw = e.target.value; loadDraw(); });

  async function loadDraw() {
    const draws = await api('/api/draws');
    if (!draws.length) { $('#drawLabel').textContent = 'Aún no hay sorteos'; return; }
    if (!selectedDraw || !draws.some((d) => d.key === selectedDraw)) {
      selectedDraw = (status.draw || status.lastDraw || draws[0]).key;
    }
    $('#drawSelect').innerHTML = draws.map((d) =>
      `<option value="${esc(d.key)}" ${d.key === selectedDraw ? 'selected' : ''}>${esc(d.name)} · ${fmtDay(d.key)}</option>`).join('');
    const d = await api('/api/draws/' + encodeURIComponent(selectedDraw));
    $('#drawLabel').textContent = d.draw.name;
    $('#drawMeta').innerHTML = `Sorteo ${fmtDay(d.draw.key)} · tickets hasta el ${esc(d.draw.cutoff_label)} · <span class="pill ${d.draw.state}">${d.draw.state}</span>`;
    $('#csvLink').href = `/api/draws/${encodeURIComponent(d.draw.key)}/tickets.csv`;
    document.querySelector('.urn-a').classList.toggle('hidden', !d.draw.comodines_enabled);
    $('#urnA').textContent = d.A.tickets; $('#urnAp').textContent = `${d.A.players} jugadores`;
    $('#urnB').textContent = d.B.tickets; $('#urnBp').textContent = `${d.B.players} jugadores`;
    $('#drawPlayers').innerHTML = d.byPlayer.map((r) => {
      const tot = r.urn === 'A' ? d.A.tickets : d.B.tickets;
      return `<tr><td>${esc(r.username)}</td><td>${r.urn === 'A' ? '🎃 Comodines' : '🎁 Premios'}</td><td>${r.n}</td><td>${(100 * r.n / tot).toFixed(2)} %</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="muted">Sin tickets todavía.</td></tr>';
  }

  // ---------- Sorteos (admin) ----------
  async function loadDraws() {
    const f = $('#drawForm');
    if (!f.cutoffLocal.value) {
      f.cutoffLocal.value = status.defaultCutoff;
      f.drawDate.value = status.defaultCutoff.slice(0, 10);
    }
    const rows = await api('/api/draws');
    $('#drawRows').innerHTML = rows.map((d) => `<tr>
      <td>${esc(d.name)}</td><td>${fmtDay(d.key)}</td><td>${esc(d.opens_label)}</td>
      <td>${esc(d.cutoff_label)}${d.closed_early_at ? ' <span class="muted">(cerrado a mano)</span>' : ''}</td>
      <td>${d.comodines_enabled ? '🎃 Sí' : 'No'}</td><td><span class="pill ${d.state}">${d.state}</span></td>
      <td><button class="btn small" data-act="edit" data-key="${esc(d.key)}">Editar</button>
        ${d.state === 'cerrado' ? '' : `<button class="btn small" data-act="close" data-key="${esc(d.key)}">Cerrar ahora</button>`}</td></tr>
      <tr class="hidden" data-edit="${esc(d.key)}"><td colspan="7">
        <div class="drawform">
          <label>Nombre<input data-f="name" value="${esc(d.name)}"></label>
          <label>Fecha del sorteo<input data-f="drawDate" type="date" value="${esc(d.key)}"></label>
          <label>Cierre de tickets (hora de Chile)<input data-f="cutoffLocal" type="datetime-local" value="${esc(d.cutoff_local)}"></label>
          <div class="row"><button class="btn primary" data-act="save" data-key="${esc(d.key)}">Guardar</button>
            <button class="btn" data-act="cancel" data-key="${esc(d.key)}">Cancelar</button></div>
        </div>
      </td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">Sin sorteos.</td></tr>';
    $('#drawRows').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
      try {
        const editRow = document.querySelector(`[data-edit="${b.dataset.key}"]`);
        if (b.dataset.act === 'edit' || b.dataset.act === 'cancel') { editRow.classList.toggle('hidden'); return; }
        if (b.dataset.act === 'close') {
          if (!confirm('¿Cerrar la entrega de tickets de este sorteo ahora?')) return;
          await api(`/api/draws/${b.dataset.key}/close`, { body: {} });
        } else if (b.dataset.act === 'save') {
          const val = (f) => editRow.querySelector(`[data-f="${f}"]`).value;
          const d = await api(`/api/draws/${b.dataset.key}/edit`, { body: { name: val('name'), drawDate: val('drawDate'), cutoffLocal: val('cutoffLocal') } });
          toast(`Guardado. Tickets hasta el ${d.cutoff_label}`);
          selectedDraw = d.key;
        }
        await refreshStatus();
        loadDraws();
      } catch (e) { toast(e.message, true); }
    }));
  }

  $('#drawForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const d = await api('/api/draws', { body: {
        name: f.name.value, drawDate: f.drawDate.value, cutoffLocal: f.cutoffLocal.value, comodines: f.comodines.checked,
      } });
      $('#drawMsg').textContent = `✅ Sorteo "${d.name}" abierto. Tickets hasta el ${d.cutoff_label}.`;
      f.reset();
      await refreshStatus();
      f.cutoffLocal.value = '';
      loadDraws();
    } catch (err) { $('#drawMsg').textContent = '⛔ ' + err.message; }
  });

  // ---------- Auditoría ----------
  const actionNames = {
    'tickets.deliver': '🎟️ Entrega', 'player.create': '👤 Usuario creado', 'halloween.mark': '🎃 Marca Halloween',
    'halloween.unmark': '🎃 Quita marca', 'agent.login': '🔑 Inicio de sesión', 'agent.create': '🧑‍💼 Agente creado',
    'agent.disable': '⛔ Agente desactivado', 'agent.enable': '✅ Agente activado',
    'draw.create': '📣 Sorteo abierto', 'draw.close': '⛔ Sorteo cerrado', 'draw.cutoff': '⏰ Cambio de cierre',
    'draw.edit': '✏️ Sorteo editado', 'tickets.void': '🗑️ Entrega anulada',
  };
  async function loadAudit() {
    const rows = await api('/api/audit');
    $('#auditRows').innerHTML = rows.map((r) => `<tr><td>${fmtDate(r.created_at)}</td><td>${esc(r.agent_name)}</td>
      <td>${esc(actionNames[r.action] || r.action)}</td><td>${esc(r.username || '')}</td><td class="mono">${esc(r.details || '')}</td></tr>`).join('');
  }

  // ---------- Agentes ----------
  async function loadAgents() {
    const rows = await api('/api/agents');
    $('#agentRows').innerHTML = rows.map((a) => `<tr><td>${esc(a.username)}</td><td>${esc(a.name)}</td><td>${esc(a.role)}</td>
      <td>${a.active ? 'Activo' : 'Inactivo'}</td><td>${a.id === me.id ? '' : `<button class="btn small" data-id="${a.id}" data-active="${a.active ? 0 : 1}">${a.active ? 'Desactivar' : 'Activar'}</button>`}</td></tr>`).join('');
    $('#agentRows').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/agents/${b.dataset.id}/active`, { body: { active: b.dataset.active === '1' } });
      loadAgents();
    }));
  }
  $('#agentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/agents', { body: f });
      e.target.reset();
      $('#agentMsg').textContent = `Agente ${f.username} creado.`;
      loadAgents();
    } catch (err) { $('#agentMsg').textContent = err.message; }
  });

  // ================= STREAM (control del sorteo en vivo) =================
  let st = null, stTimer = null, stSelected = null;
  const urnName = { A: '🎃 Comodines', B: '🎁 Premios' };
  const kindName = { cash: 'Efectivo', boost: 'Boost', comodin: 'Comodín' };

  async function loadStream() {
    st = await api('/api/live/control');
    renderStream();
    clearInterval(stTimer);
    stTimer = setInterval(async () => {
      if ($('#tab-stream').classList.contains('hidden')) return clearInterval(stTimer);
      st = await api('/api/live/control').catch(() => st);
      renderStream(true);
    }, 4000);
  }

  async function act(body) {
    try {
      const r = await api('/api/live/action', { body });
      st = await api('/api/live/control');
      renderStream();
      return r;
    } catch (e) { toast(e.message, true); throw e; }
  }

  function renderStream(soft) {
    const S = st.state, d = st.draw;
    const url = `${location.origin}/overlay.html`;
    $('#stUrl').textContent = url; $('#stOpen').href = url;
    $('#stClients').textContent = st.overlayClients ? `🟢 ${st.overlayClients} pantalla(s) conectada(s)` : '⚪ Pantalla OBS no conectada';
    if (!soft) {
      $('#stDraw').innerHTML = st.draws.map((x) => `<option value="${esc(x.key)}" ${x.key === S.drawKey ? 'selected' : ''}>${esc(x.name)} · ${fmtDay(x.key)}</option>`).join('');
    }
    document.querySelectorAll('#stMode button').forEach((b) => b.classList.toggle('on', (b.dataset.mode === '1') === S.rehearsal));
    const closed = d && d.state === 'cerrado';
    $('#stModeInfo').innerHTML = S.rehearsal
      ? '🧪 <b>Modo ensayo:</b> puedes practicar las veces que quieras; los resultados no cuentan y en pantalla aparece "MODO ENSAYO".'
      : closed ? '🔴 <b>Modo real:</b> cada pelotita que saques es un ganador oficial.'
        : `⚠️ <b>Modo real:</b> la entrega de tickets sigue abierta hasta el ${esc(d?.cutoff_label || '')}. Podrás sacar pelotitas reales después del cierre.`;
    $('#stResMode').textContent = S.rehearsal ? 'ensayo' : 'oficiales';
    document.querySelectorAll('#stScenes button').forEach((b) => b.classList.toggle('on', b.dataset.scene === S.scene));
    $('#stCntA').textContent = `${st.counts.A} tickets participando`;
    $('#stCntB').textContent = `${st.counts.B} tickets participando`;

    const urn = S.scene === 'A' || S.scene === 'B' ? S.scene : null;
    $('#stHint').classList.toggle('hidden', !!urn);
    const list = urn ? st.prizes.filter((p) => p.urn === urn) : [];
    let selected = S.prizeId;
    if (urn && !list.some((p) => p.id === selected && p.remaining > 0)) selected = null;
    // Si queda un solo tipo de premio en el bombo (ej. Comodines), se elige solo.
    const avail = list.filter((p) => p.remaining > 0);
    if (urn && !selected && avail.length === 1) selected = avail[0].id;
    stSelected = selected;
    $('#stPrizes').innerHTML = list.map((p) => `<button data-prize="${p.id}" class="${p.id === selected ? 'on' : ''}" ${p.remaining <= 0 ? 'disabled' : ''}>
        ${esc(p.label)}<small>quedan ${p.remaining} de ${p.qty}</small></button>`).join('');
    $('#stPrizes').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => act({ action: 'prize', prizeId: Number(b.dataset.prize) })));
    $('#stMix').disabled = !urn; $('#stExtract').disabled = !urn || !selected;
    $('#stMix').classList.toggle('mixing', S.mixing);
    $('#stMix').textContent = S.mixing ? '⏸️ Detener mezcla' : '🌀 Mezclar';
    $('#stExtract').title = !selected ? 'Primero elige el premio' : '';

    const last = S.last;
    $('#stLast').classList.toggle('hidden', !last);
    if (last) {
      $('#stLast').innerHTML = `🏆 <b>${esc(last.prize.label)}</b> → ticket <b>${esc(last.code)}</b> · ${esc(last.user)} ${S.rehearsal ? '<span class="pill">ensayo</span>' : ''}
        <div class="row wrap" style="margin-top:10px"><button class="btn water" data-discard="${last.id}">💧 Al agua (no está en el vivo)</button>
        <span class="muted" style="font-size:.85rem">Sale del bombo y el premio "${esc(last.prize.label)}" se vuelve a sortear.</span></div>`;
      $('#stLast [data-discard]').addEventListener('click', () => discard(last.id, last.code));
    }

    $('#stResults').innerHTML = st.results.map((r, i) => `<tr class="${r.voided_at ? 'voided' : ''}">
        <td>${i + 1}</td><td>${urnName[r.urn]}</td><td><b>${esc(r.prize_label)}</b></td><td>${esc(r.username)}</td><td>${esc(r.code)}</td>
        <td>${fmtDate(r.created_at)}</td>
        <td>${r.discarded ? '<span class="void-info">💧 Al agua</span>' : r.voided_at ? `<span class="void-info">Anulada: ${esc(r.void_reason)}</span>`
          : `<button class="btn small water" data-discard="${r.id}" data-code="${esc(r.code)}">💧 Al agua</button> <button class="btn small" data-xvoid="${r.id}">Anular</button>`}</td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">Aún no hay ganadores.</td></tr>';
    $('#stResults').querySelectorAll('[data-discard]').forEach((b) => b.addEventListener('click', () => discard(Number(b.dataset.discard), b.dataset.code)));
    $('#stResults').querySelectorAll('[data-xvoid]').forEach((b) => b.addEventListener('click', async () => {
      const reason = prompt('¿Anular esta extracción por un ERROR? El premio vuelve a estar disponible y el jugador VUELVE a participar.\n(Si no estaba en el vivo, usa "Al agua").\n\nMotivo:');
      if (!reason) return;
      try { await api(`/api/extractions/${b.dataset.xvoid}/void`, { body: { reason } }); loadStream(); } catch (e) { toast(e.message, true); }
    }));

    if (!soft) {
      const realPrizes = st.prizes;
      $('#stPrizeRows').innerHTML = realPrizes.map((p) => `<tr><td>${urnName[p.urn]}</td><td>${esc(p.label)}</td><td>${kindName[p.kind]}</td>
        <td><input type="number" min="0" value="${p.qty}" data-qty="${p.id}" style="width:80px"></td><td>${p.used}</td>
        <td><button class="btn small" data-pdel="${p.id}">Quitar</button></td></tr>`).join('');
      $('#stPrizeRows').querySelectorAll('[data-qty]').forEach((inp) => inp.addEventListener('change', async () => {
        const p = realPrizes.find((x) => x.id === Number(inp.dataset.qty));
        try { await api(`/api/draws/${S.drawKey}/prizes`, { body: { ...p, qty: Number(inp.value) } }); toast('Cantidad guardada'); loadStream(); } catch (e) { toast(e.message, true); loadStream(); }
      }));
      $('#stPrizeRows').querySelectorAll('[data-pdel]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('¿Quitar este premio?')) return;
        try { await api(`/api/draws/${S.drawKey}/prizes/${b.dataset.pdel}/delete`, { body: {} }); loadStream(); } catch (e) { toast(e.message, true); }
      }));
    }
  }

  async function discard(id, code) {
    if (!confirm(`💧 ¿Mandar AL AGUA el ticket ${code || ''}?\n\nEse jugador sale de este bombo (no vuelve a participar en él) y el premio se vuelve a sortear.`)) return;
    try {
      const r = await api(`/api/extractions/${id}/discard`, { body: {} });
      toast(`💧 ${r.code} al agua. Saca otra pelotita para "${r.prize}"`);
      st = await api('/api/live/control'); renderStream();
    } catch (e) { toast(e.message, true); }
  }

  $('#stDraw').addEventListener('change', (e) => act({ action: 'draw', drawKey: e.target.value }));
  document.querySelectorAll('#stMode button').forEach((b) => b.addEventListener('click', () => {
    const rehearsal = b.dataset.mode === '1';
    if (!rehearsal && !confirm('¿Pasar a MODO REAL? Cada pelotita que saques será un ganador oficial.')) return;
    act({ action: 'mode', rehearsal });
  }));
  document.querySelectorAll('#stScenes button').forEach((b) => b.addEventListener('click', () => act({ action: 'scene', scene: b.dataset.scene })));
  $('#stMix').addEventListener('click', () => act({ action: 'mix', on: !st.state.mixing }));
  $('#stExtract').addEventListener('click', async () => {
    const btn = $('#stExtract');
    btn.disabled = true;
    try {
      const r = await act({ action: 'extract', prizeId: stSelected });
      toast(`Salió ${r.code} · ${r.username} → ${r.prize.label}`);
    } catch { /* toast ya mostrado */ }
    setTimeout(() => renderStream(true), 9000);
  });
  $('#stCopy').addEventListener('click', () => navigator.clipboard.writeText($('#stUrl').textContent).then(() => toast('Enlace copiado')));
  $('#stClearRehearsal').addEventListener('click', async () => {
    if (!confirm('¿Borrar todos los resultados de ensayo de este sorteo?')) return;
    try { const r = await api(`/api/draws/${st.state.drawKey}/rehearsal/clear`, { body: {} }); toast(`Borrados ${r.removed} resultados de ensayo`); loadStream(); } catch (e) { toast(e.message, true); }
  });
  $('#stPrizeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api(`/api/draws/${st.state.drawKey}/prizes`, { body: { ...f, qty: Number(f.qty), value: Number(f.value || 0) } }); e.target.reset(); loadStream(); } catch (err) { toast(err.message, true); }
  });
  $('#stExport').addEventListener('click', async () => {
    try {
      const r = await api(`/api/draws/${st.state.drawKey}/export`, { body: {} });
      $('#stExportMsg').innerHTML = `✅ Página generada con ${r.tickets} tickets${r.winners ? ` y ${r.winners} ganadores` : ''}.<br>
        Carpeta: <code>${esc(r.dir)}</code><br>Para publicarla: entra a <b>app.netlify.com</b> → tu sitio → <b>Deploys</b> → arrastra la carpeta <b>sitio-publico</b> al recuadro.`;
    } catch (e) { toast(e.message, true); }
  });

  start();
})();
