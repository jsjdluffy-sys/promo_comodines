const crypto = require('crypto');
const config = require('./config');
const time = require('./time');
const { computeClaim, splitDestination, RuleError, fmt } = require('./rules');

function createService(db) {
  const q = {
    playerById: db.prepare('SELECT * FROM players WHERE id = ?'),
    playerByName: db.prepare('SELECT * FROM players WHERE username = ?'),
    searchPlayers: db.prepare("SELECT * FROM players WHERE username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 20"),
    insertPlayer: db.prepare('INSERT INTO players (username) VALUES (?)'),
    dayGiven: db.prepare(`SELECT COALESCE(SUM(delivered),0) AS given FROM claims
                          WHERE player_id = ? AND day_key = ? AND voided_at IS NULL`),
    lastClaimToday: db.prepare(`SELECT total_reported FROM claims WHERE player_id = ? AND day_key = ?
                                AND voided_at IS NULL ORDER BY id DESC LIMIT 1`),
    maxSeq: db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM tickets WHERE draw_key = ? AND urn = ?'),
    insertClaim: db.prepare(`INSERT INTO claims (player_id, agent_id, day_key, draw_key, total_reported, prev_total,
                             tickets_for_day, delivered, to_a, to_b, created_at)
                             VALUES (@player_id,@agent_id,@day_key,@draw_key,@total_reported,@prev_total,
                             @tickets_for_day,@delivered,@to_a,@to_b,@created_at)`),
    insertTicket: db.prepare(`INSERT INTO tickets (draw_key, urn, seq, code, player_id, claim_id, created_at)
                              VALUES (?,?,?,?,?,?,?)`),
    playerTickets: db.prepare(`SELECT urn, code, created_at FROM tickets WHERE player_id = ? AND draw_key = ?
                               AND voided_at IS NULL ORDER BY urn, seq`),
    playerClaims: db.prepare(`SELECT c.*, a.name AS agent_name, v.name AS voided_by_name,
                              (SELECT GROUP_CONCAT(code, ', ') FROM tickets t WHERE t.claim_id = c.id) AS codes
                              FROM claims c JOIN agents a ON a.id = c.agent_id LEFT JOIN agents v ON v.id = c.voided_by
                              WHERE c.player_id = ? ORDER BY c.id DESC LIMIT 50`),
    audit: db.prepare('INSERT INTO audit_log (agent_id, action, player_id, details) VALUES (?,?,?,?)'),
    setHalloween: db.prepare(`UPDATE players SET halloween_eligible = ?, halloween_marked_by = ?, halloween_marked_at = ?
                              WHERE id = ?`),
    agentName: db.prepare('SELECT name FROM agents WHERE id = ?'),
    activeDraw: db.prepare(`SELECT * FROM draws WHERE opens_at <= ? AND cutoff_at > ?
                            ORDER BY opens_at DESC LIMIT 1`),
    latestDraw: db.prepare('SELECT * FROM draws WHERE opens_at <= ? ORDER BY cutoff_at DESC LIMIT 1'),
    drawByKey: db.prepare('SELECT * FROM draws WHERE key = ?'),
    allDraws: db.prepare('SELECT * FROM draws ORDER BY cutoff_at DESC'),
    overlapping: db.prepare('SELECT * FROM draws WHERE opens_at < ? AND cutoff_at > ? AND id != ?'),
  };

  const audit = (agentId, action, playerId, details) =>
    q.audit.run(agentId, action, playerId ?? null, details ? JSON.stringify(details) : null);

  // ---------- Sorteos ----------
  function decorateDraw(d, now = new Date()) {
    if (!d) return null;
    const nowIso = now.toISOString();
    const open = d.opens_at <= nowIso && d.cutoff_at > nowIso;
    return {
      ...d,
      comodines_enabled: !!d.comodines_enabled,
      is_open: open,
      state: open ? 'abierto' : d.cutoff_at <= nowIso ? 'cerrado' : 'programado',
      cutoff_label: time.formatLocal(new Date(d.cutoff_at)),
      opens_label: time.formatLocal(new Date(d.opens_at)),
      cutoff_local: time.toLocalInput(new Date(d.cutoff_at)),
    };
  }

  function activeDraw(now = new Date()) {
    const iso = now.toISOString();
    return decorateDraw(q.activeDraw.get(iso, iso), now);
  }

  function currentOrLastDraw(now = new Date()) {
    return activeDraw(now) || decorateDraw(q.latestDraw.get(now.toISOString()), now);
  }

  function listDraws(now = new Date()) {
    return q.allDraws.all().map((d) => decorateDraw(d, now));
  }

  function requireOpenDraw(now) {
    const d = activeDraw(now);
    if (!d) {
      throw new RuleError('CLOSED', 'No hay sorteo abierto: la entrega de tickets está bloqueada hasta que se anuncie un nuevo sorteo.');
    }
    return d;
  }

  function checkOverlap(opensAt, cutoffAt, ignoreId = 0) {
    const clash = q.overlapping.get(cutoffAt.toISOString(), opensAt.toISOString(), ignoreId);
    if (clash) throw new RuleError('OVERLAP', `Las fechas se cruzan con el sorteo "${clash.name}".`);
  }

  function createDraw({ name, drawDate, opensLocal, cutoffLocal, comodines }, agent, now = new Date()) {
    const nm = String(name || '').trim();
    if (nm.length < 3 || nm.length > 80) throw new RuleError('INVALID', 'El nombre del sorteo debe tener entre 3 y 80 caracteres.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate || '')) throw new RuleError('INVALID', 'Fecha del sorteo inválida.');
    if (q.drawByKey.get(drawDate)) throw new RuleError('DUPLICATE', 'Ya existe un sorteo para esa fecha.');
    const opensAt = opensLocal ? time.zonedToUtc(opensLocal) : now;
    const cutoffAt = time.zonedToUtc(cutoffLocal);
    if (!opensAt || !cutoffAt) throw new RuleError('INVALID', 'Fecha u hora inválida.');
    if (cutoffAt <= now) throw new RuleError('INVALID', 'El cierre debe ser en el futuro.');
    if (cutoffAt <= opensAt) throw new RuleError('INVALID', 'El cierre debe ser después de la apertura.');
    checkOverlap(opensAt, cutoffAt);
    const r = db.prepare(`INSERT INTO draws (key, name, opens_at, cutoff_at, comodines_enabled, created_by)
                          VALUES (?,?,?,?,?,?)`)
      .run(drawDate, nm, opensAt.toISOString(), cutoffAt.toISOString(), comodines ? 1 : 0, agent?.id ?? null);
    audit(agent?.id ?? null, 'draw.create', null, {
      key: drawDate, name: nm, opens: opensAt.toISOString(), cutoff: cutoffAt.toISOString(), comodines: !!comodines,
    });
    return decorateDraw(db.prepare('SELECT * FROM draws WHERE id = ?').get(r.lastInsertRowid), now);
  }

  // Editar nombre, fecha y/o cierre. Cambiar la fecha mueve también sus tickets y entregas.
  const editDrawTx = db.transaction((key, changes, agent, now) => {
    const d = q.drawByKey.get(key);
    if (!d) throw new RuleError('NOT_FOUND', 'Sorteo no encontrado.');
    const name = changes.name == null ? d.name : String(changes.name).trim();
    if (name.length < 3 || name.length > 80) throw new RuleError('INVALID', 'El nombre del sorteo debe tener entre 3 y 80 caracteres.');
    const newKey = changes.drawDate || d.key;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newKey)) throw new RuleError('INVALID', 'Fecha del sorteo inválida.');
    if (newKey !== d.key && q.drawByKey.get(newKey)) throw new RuleError('DUPLICATE', 'Ya existe un sorteo para esa fecha.');
    let cutoffIso = d.cutoff_at;
    if (changes.cutoffLocal) {
      const cutoffAt = time.zonedToUtc(changes.cutoffLocal);
      if (!cutoffAt) throw new RuleError('INVALID', 'Fecha u hora de cierre inválida.');
      cutoffIso = cutoffAt.toISOString();
      if (cutoffIso !== d.cutoff_at) {
        if (cutoffAt <= now) throw new RuleError('INVALID', 'El nuevo cierre debe ser en el futuro. Para cerrar ya, usa "Cerrar ahora".');
        if (cutoffIso <= d.opens_at) throw new RuleError('INVALID', 'El cierre debe ser después de la apertura.');
        checkOverlap(new Date(d.opens_at), cutoffAt, d.id);
      }
    }
    db.prepare('UPDATE draws SET key = ?, name = ?, cutoff_at = ?, closed_early_at = CASE WHEN ? = cutoff_at THEN closed_early_at ELSE NULL END WHERE id = ?')
      .run(newKey, name, cutoffIso, cutoffIso, d.id);
    if (newKey !== d.key) {
      db.prepare('UPDATE tickets SET draw_key = ? WHERE draw_key = ?').run(newKey, d.key);
      db.prepare('UPDATE claims SET draw_key = ? WHERE draw_key = ?').run(newKey, d.key);
    }
    audit(agent.id, 'draw.edit', null, {
      from: { key: d.key, name: d.name, cutoff: d.cutoff_at }, to: { key: newKey, name, cutoff: cutoffIso },
    });
    return decorateDraw(q.drawByKey.get(newKey), now);
  });

  function editDraw(key, changes, agent, now = new Date()) {
    return editDrawTx(key, changes || {}, agent, now);
  }

  function setCutoff(key, cutoffLocal, agent, now = new Date()) {
    return editDraw(key, { cutoffLocal }, agent, now);
  }

  function closeNow(key, agent, now = new Date()) {
    const d = q.drawByKey.get(key);
    if (!d) throw new RuleError('NOT_FOUND', 'Sorteo no encontrado.');
    if (d.cutoff_at <= now.toISOString()) throw new RuleError('INVALID', 'Ese sorteo ya está cerrado.');
    const iso = now.toISOString();
    db.prepare('UPDATE draws SET cutoff_at = ?, closed_early_at = ?, opens_at = MIN(opens_at, ?) WHERE id = ?')
      .run(iso, iso, iso, d.id);
    audit(agent.id, 'draw.close', null, { key, plannedCutoff: d.cutoff_at });
    return decorateDraw(q.drawByKey.get(key), now);
  }

  // ---------- Jugadores ----------
  function normalizeUsername(raw) {
    const u = String(raw || '').trim();
    if (!/^[\p{L}\p{N}_.\-@]{2,40}$/u.test(u)) {
      throw new RuleError('INVALID_USERNAME', 'Usuario inválido (2 a 40 caracteres, sin espacios).');
    }
    return u;
  }

  function getPlayer(id) {
    const p = q.playerById.get(id);
    if (!p) throw new RuleError('NOT_FOUND', 'Usuario no encontrado.');
    return p;
  }

  function searchPlayers(text) {
    const like = `%${String(text || '').trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    return q.searchPlayers.all(like);
  }

  function createPlayer(username, agentId) {
    const u = normalizeUsername(username);
    if (q.playerByName.get(u)) throw new RuleError('DUPLICATE', 'Ese usuario ya existe.');
    const { lastInsertRowid } = q.insertPlayer.run(u);
    audit(agentId, 'player.create', lastInsertRowid, { username: u });
    return q.playerById.get(lastInsertRowid);
  }

  function setHalloween(playerId, eligible, agent) {
    const p = getPlayer(playerId);
    if (!eligible && p.halloween_eligible && agent.role !== 'admin') {
      throw new RuleError('FORBIDDEN', 'Solo un admin puede quitar la marca del Reto Halloween.');
    }
    q.setHalloween.run(eligible ? 1 : 0, agent.id, new Date().toISOString(), playerId);
    audit(agent.id, eligible ? 'halloween.mark' : 'halloween.unmark', playerId, null);
    return q.playerById.get(playerId);
  }

  // ---------- Entrega de tickets ----------
  function dayState(playerId, now) {
    const day = time.dayKey(now);
    const last = q.lastClaimToday.get(playerId, day);
    return { day, prevTotal: last ? last.total_reported : null, alreadyGiven: q.dayGiven.get(playerId, day).given };
  }

  function preview(playerId, total, now = new Date()) {
    const player = getPlayer(playerId);
    const draw = requireOpenDraw(now);
    const st = dayState(playerId, now);
    const calc = computeClaim({ total, prevTotal: st.prevTotal, alreadyGiven: st.alreadyGiven });
    return {
      ...calc, prevTotal: st.prevTotal, drawKey: draw.key,
      comodinesAllowed: draw.comodines_enabled,
    };
  }

  // Todo dentro de una transacción: dos agentes atendiendo al mismo usuario no pueden duplicar tickets.
  const confirmTx = db.transaction((args) => {
    const { playerId, total, confirmTotal, destination, aCount, agentId, now } = args;
    const player = getPlayer(playerId);
    const draw = requireOpenDraw(now);
    const st = dayState(playerId, now);
    const calc = computeClaim({ total, prevTotal: st.prevTotal, alreadyGiven: st.alreadyGiven });
    if (calc.needsDoubleCheck && confirmTotal !== total) {
      throw new RuleError('CONFIRM_REQUIRED', `Monto alto: escribe ${fmt(total)} otra vez para confirmar.`);
    }
    if (calc.toDeliver === 0) throw new RuleError(calc.status, messageForZero(calc));
    if (!draw.comodines_enabled && destination !== 'premios') {
      throw new RuleError('NO_COMODINES', 'Este sorteo no tiene Comodines: todos los tickets van al Bombo Premios.');
    }
    const split = splitDestination({
      destination, toDeliver: calc.toDeliver, aCount,
    });
    const createdAt = now.toISOString();
    const claimId = q.insertClaim.run({
      player_id: playerId, agent_id: agentId, day_key: st.day, draw_key: draw.key,
      total_reported: total, prev_total: st.prevTotal, tickets_for_day: calc.ticketsForDay,
      delivered: calc.toDeliver, to_a: split.a, to_b: split.b, created_at: createdAt,
    }).lastInsertRowid;

    const codes = { A: [], B: [] };
    for (const [urn, n] of [['A', split.a], ['B', split.b]]) {
      let seq = q.maxSeq.get(draw.key, urn).s;
      for (let i = 0; i < n; i++) {
        seq += 1;
        const code = `${urn}-${String(seq).padStart(4, '0')}`;
        q.insertTicket.run(draw.key, urn, seq, code, playerId, claimId, createdAt);
        codes[urn].push(code);
      }
    }
    audit(agentId, 'tickets.deliver', playerId, {
      claimId, total, prevTotal: st.prevTotal, delivered: calc.toDeliver, codes, draw: draw.key,
    });
    const week = weekCounts(playerId, draw.key);
    return { claimId, draw: draw.key, codes, calc, week, message: buildMessage({ codes, week, draw }) };
  });

  // Anular entrega (solo admin): sus tickets salen del sorteo; queda registro con el motivo.
  const voidTx = db.transaction((claimIds, reason, agent, now) => {
    const r = String(reason || '').trim();
    if (r.length < 3) throw new RuleError('INVALID', 'Escribe el motivo de la anulación.');
    const iso = now.toISOString();
    let voidedTickets = 0;
    const done = [];
    for (const id of claimIds) {
      const c = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
      if (!c) throw new RuleError('NOT_FOUND', 'Entrega no encontrada.');
      if (c.voided_at) continue;
      db.prepare('UPDATE claims SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?').run(iso, agent.id, r, id);
      voidedTickets += db.prepare('UPDATE tickets SET voided_at = ? WHERE claim_id = ?').run(iso, id).changes;
      const codes = db.prepare('SELECT code FROM tickets WHERE claim_id = ? ORDER BY urn, seq').all(id).map((t) => t.code);
      audit(agent.id, 'tickets.void', c.player_id, { claimId: id, reason: r, codes, draw: c.draw_key });
      done.push(id);
    }
    return { voidedClaims: done.length, voidedTickets };
  });

  function voidClaim(claimId, reason, agent, now = new Date()) {
    if (agent.role !== 'admin') throw new RuleError('FORBIDDEN', 'Solo un admin puede anular entregas.');
    return voidTx([claimId], reason, agent, now);
  }

  function voidAllForPlayer(playerId, reason, agent, now = new Date()) {
    if (agent.role !== 'admin') throw new RuleError('FORBIDDEN', 'Solo un admin puede anular entregas.');
    getPlayer(playerId);
    const ids = db.prepare('SELECT id FROM claims WHERE player_id = ? AND voided_at IS NULL').all(playerId).map((c) => c.id);
    return voidTx(ids, reason, agent, now);
  }

  function confirm(args) {
    return confirmTx({ ...args, now: args.now || new Date() });
  }

  function weekCounts(playerId, drawKey) {
    const t = q.playerTickets.all(playerId, drawKey);
    return { A: t.filter((x) => x.urn === 'A').length, B: t.filter((x) => x.urn === 'B').length };
  }

  function summary(playerId, now = new Date()) {
    const player = getPlayer(playerId);
    const st = dayState(playerId, now);
    const draw = currentOrLastDraw(now);
    const tickets = draw ? q.playerTickets.all(playerId, draw.key) : [];
    return {
      player: {
        ...player,
        halloween_marked_by_name: player.halloween_marked_by ? q.agentName.get(player.halloween_marked_by)?.name : null,
      },
      today: { day: st.day, lastTotal: st.prevTotal, given: st.alreadyGiven, cap: config.DAILY_CAP },
      draw,
      week: { A: tickets.filter((x) => x.urn === 'A'), B: tickets.filter((x) => x.urn === 'B') },
      history: q.playerClaims.all(playerId),
    };
  }

  function drawSummary(key, now = new Date()) {
    const d = q.drawByKey.get(key);
    if (!d) throw new RuleError('NOT_FOUND', 'Sorteo no encontrado.');
    const urns = db.prepare(`SELECT urn, COUNT(*) AS tickets, COUNT(DISTINCT player_id) AS players
                             FROM tickets WHERE draw_key = ? AND voided_at IS NULL GROUP BY urn`).all(key);
    const byPlayer = db.prepare(`SELECT p.username, t.urn, COUNT(*) AS n FROM tickets t JOIN players p ON p.id = t.player_id
                                 WHERE t.draw_key = ? AND t.voided_at IS NULL GROUP BY p.id, t.urn ORDER BY t.urn, n DESC, p.username`).all(key);
    const empty = { tickets: 0, players: 0 };
    return {
      draw: decorateDraw(d, now),
      A: urns.find((u) => u.urn === 'A') || empty,
      B: urns.find((u) => u.urn === 'B') || empty,
      byPlayer,
    };
  }

  function drawTickets(key) {
    return db.prepare(`SELECT t.code, t.urn, p.username, t.created_at FROM tickets t JOIN players p ON p.id = t.player_id
                       WHERE t.draw_key = ? AND t.voided_at IS NULL ORDER BY t.urn, t.seq`).all(key);
  }

  function auditLog(limit = 200) {
    return db.prepare(`SELECT l.*, a.name AS agent_name, p.username FROM audit_log l
                       LEFT JOIN agents a ON a.id = l.agent_id LEFT JOIN players p ON p.id = l.player_id
                       ORDER BY l.id DESC LIMIT ?`).all(limit);
  }

  return {
    searchPlayers, createPlayer, getPlayer, setHalloween, preview, confirm, summary,
    drawSummary, drawTickets, auditLog, audit,
    activeDraw, currentOrLastDraw, listDraws, createDraw, editDraw, setCutoff, closeNow,
    voidClaim, voidAllForPlayer,
  };
}

function messageForZero(calc) {
  if (calc.status === 'CAP_REACHED') return `Ya alcanzó el tope de ${config.DAILY_CAP} tickets de hoy.`;
  if (calc.status === 'NO_CHANGE') return 'El total no cambió desde la última entrega: la recarga aún no se refleja.';
  return `Aún no completa el siguiente ticket: le faltan ${fmt(calc.missingForNext)}.`;
}

function buildMessage({ codes, week, draw }) {
  const n = codes.A.length + codes.B.length;
  const lines = [`✅ ¡Listo! Recibiste ${n} ticket${n === 1 ? '' : 's'}:`];
  if (codes.A.length) lines.push(`🎃 Comodín: ${codes.A.join(', ')}`);
  if (codes.B.length) lines.push(`🎁 Premios: ${codes.B.join(', ')}`);
  const parts = [];
  if (week.A) parts.push(`${week.A} para Comodín`);
  parts.push(`${week.B} para Premios`);
  lines.push(`Para este sorteo llevas ${parts.join(' y ')}.`);
  lines.push(`🎟️ ${draw.name} · tickets hasta el ${draw.cutoff_label} 🍀`);
  return lines.join('\n');
}

// Primer inicio: abre el sorteo de esta semana (con Comodines) hasta el próximo sábado 19:00.
function seedFirstDraw(svc, db, now = new Date()) {
  if (db.prepare('SELECT COUNT(*) AS n FROM draws').get().n > 0) return null;
  const key = time.drawKey(now);
  return svc.createDraw({
    name: 'Sorteo semanal + Comodines Halloween',
    drawDate: key,
    cutoffLocal: `${key}T${String(config.CUTOFF_HOUR).padStart(2, '0')}:00`,
    comodines: true,
  }, null, now);
}

// ---- Contraseñas ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

module.exports = { createService, seedFirstDraw, hashPassword, verifyPassword, buildMessage };
