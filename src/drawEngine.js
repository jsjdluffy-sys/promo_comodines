// Motor del sorteo en vivo: premios, extracción aleatoria y resultados.
const crypto = require('crypto');
const { RuleError } = require('./rules');
const { seedDefaultPrizes } = require('./service');

const URN_NAMES = { A: 'Bombo Comodines', B: 'Bombo Premios' };

// "User7287220552" -> "Use***52". Suficiente para que el jugador se reconozca sin exponerlo.
function maskUser(username) {
  const u = String(username || '');
  if (u.length <= 4) return u.slice(0, 1) + '***';
  if (u.length <= 6) return u.slice(0, 2) + '***' + u.slice(-1);
  return u.slice(0, 3) + '***' + u.slice(-2);
}

function createDrawEngine(db, svc) {
  const audit = svc.audit;

  // Sorteos creados antes de existir los premios: se les cargan los premios por defecto.
  for (const d of db.prepare('SELECT key, comodines_enabled FROM draws').all()) {
    seedDefaultPrizes(db, d.key, !!d.comodines_enabled);
  }

  function getDraw(key) {
    const d = db.prepare('SELECT * FROM draws WHERE key = ?').get(key);
    if (!d) throw new RuleError('NOT_FOUND', 'Sorteo no encontrado.');
    return d;
  }

  function prizes(drawKey, rehearsal = false) {
    const rows = db.prepare('SELECT * FROM prizes WHERE draw_key = ? ORDER BY urn, sort, id').all(drawKey);
    const used = db.prepare(`SELECT prize_id, COUNT(*) AS n FROM extractions
                             WHERE draw_key = ? AND rehearsal = ? AND voided_at IS NULL GROUP BY prize_id`)
      .all(drawKey, rehearsal ? 1 : 0);
    const usedBy = Object.fromEntries(used.map((u) => [u.prize_id, u.n]));
    return rows.map((p) => ({ ...p, used: usedBy[p.id] || 0, remaining: p.qty - (usedBy[p.id] || 0) }));
  }

  function savePrize(drawKey, data, agent) {
    getDraw(drawKey);
    const label = String(data.label || '').trim();
    const urn = data.urn === 'A' ? 'A' : 'B';
    const kind = ['comodin', 'cash', 'boost'].includes(data.kind) ? data.kind : 'cash';
    const qty = Number(data.qty);
    const value = Math.max(0, Math.round(Number(data.value) || 0));
    if (label.length < 2 || label.length > 40) throw new RuleError('INVALID', 'El nombre del premio debe tener entre 2 y 40 caracteres.');
    if (!Number.isInteger(qty) || qty < 0 || qty > 100) throw new RuleError('INVALID', 'Cantidad inválida (0 a 100).');
    if (data.id) {
      const p = db.prepare('SELECT * FROM prizes WHERE id = ? AND draw_key = ?').get(data.id, drawKey);
      if (!p) throw new RuleError('NOT_FOUND', 'Premio no encontrado.');
      const used = db.prepare('SELECT COUNT(*) AS n FROM extractions WHERE prize_id = ? AND rehearsal = 0 AND voided_at IS NULL').get(p.id).n;
      if (qty < used) throw new RuleError('INVALID', `Ya se sortearon ${used} de este premio: la cantidad no puede ser menor.`);
      db.prepare('UPDATE prizes SET label = ?, kind = ?, value = ?, qty = ? WHERE id = ?').run(label, kind, value, qty, p.id);
      audit(agent.id, 'prize.edit', null, { draw: drawKey, id: p.id, label, qty });
      return { id: p.id };
    }
    const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM prizes WHERE draw_key = ? AND urn = ?').get(drawKey, urn).s;
    const r = db.prepare('INSERT INTO prizes (draw_key, urn, label, kind, value, qty, sort) VALUES (?,?,?,?,?,?,?)')
      .run(drawKey, urn, label, kind, value, qty, sort);
    audit(agent.id, 'prize.create', null, { draw: drawKey, urn, label, qty });
    return { id: r.lastInsertRowid };
  }

  function deletePrize(drawKey, id, agent) {
    const p = db.prepare('SELECT * FROM prizes WHERE id = ? AND draw_key = ?').get(id, drawKey);
    if (!p) throw new RuleError('NOT_FOUND', 'Premio no encontrado.');
    if (db.prepare('SELECT 1 FROM extractions WHERE prize_id = ?').get(id)) {
      throw new RuleError('INVALID', 'Este premio ya tiene extracciones: pon la cantidad en 0 en vez de borrarlo.');
    }
    db.prepare('DELETE FROM prizes WHERE id = ?').run(id);
    audit(agent.id, 'prize.delete', null, { draw: drawKey, label: p.label });
    return { ok: true };
  }

  // Tickets vigentes del bombo, sin los de jugadores que ya ganaron en ese bombo (1 premio por persona).
  function pool(drawKey, urn, rehearsal) {
    return db.prepare(`SELECT t.id, t.code, t.player_id, p.username FROM tickets t JOIN players p ON p.id = t.player_id
                       WHERE t.draw_key = ? AND t.urn = ? AND t.voided_at IS NULL
                       AND t.player_id NOT IN (SELECT player_id FROM extractions
                         WHERE draw_key = ? AND urn = ? AND rehearsal = ? AND voided_at IS NULL)
                       ORDER BY t.seq`).all(drawKey, urn, drawKey, urn, rehearsal ? 1 : 0);
  }

  const extractTx = db.transaction(({ drawKey, urn, prizeId, rehearsal, agent, now }) => {
    const d = getDraw(drawKey);
    if (!rehearsal && d.cutoff_at > now.toISOString()) {
      throw new RuleError('NOT_CLOSED', 'La entrega de tickets sigue abierta. El sorteo real se puede hacer después del cierre; antes usa el modo Ensayo.');
    }
    if (urn !== 'A' && urn !== 'B') throw new RuleError('INVALID', 'Bombo inválido.');
    const prize = prizes(drawKey, rehearsal).find((p) => p.id === prizeId && p.urn === urn);
    if (!prize) throw new RuleError('INVALID', 'Elige un premio de este bombo.');
    if (prize.remaining <= 0) throw new RuleError('INVALID', `Ya se sortearon todos los "${prize.label}".`);
    const candidates = pool(drawKey, urn, rehearsal);
    if (!candidates.length) throw new RuleError('EMPTY', 'No quedan tickets participando en este bombo.');

    // Aleatoriedad criptográfica y uniforme: cada ticket tiene exactamente la misma probabilidad.
    const index = crypto.randomInt(candidates.length);
    const win = candidates[index];
    const createdAt = now.toISOString();
    const r = db.prepare(`INSERT INTO extractions (draw_key, urn, prize_id, ticket_id, player_id, code, rehearsal,
                          pool_size, pick_index, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(drawKey, urn, prize.id, win.id, win.player_id, win.code, rehearsal ? 1 : 0, candidates.length, index, agent.id, createdAt);
    // Tickets del ganador que salen del bombo (regla de 1 premio por persona).
    const removed = candidates.filter((c) => c.player_id === win.player_id && c.id !== win.id).map((c) => c.code);
    audit(agent.id, rehearsal ? 'draw.extract.rehearsal' : 'draw.extract', win.player_id, {
      draw: drawKey, urn, prize: prize.label, code: win.code, poolSize: candidates.length, index,
    });
    return {
      id: r.lastInsertRowid, urn, code: win.code, user: maskUser(win.username), username: win.username, p: win.player_id,
      prize: { id: prize.id, label: prize.label, kind: prize.kind, value: prize.value },
      poolSize: candidates.length, removedCodes: removed, rehearsal: !!rehearsal, created_at: createdAt,
    };
  });

  function extract(args) {
    return extractTx({ ...args, now: args.now || new Date() });
  }

  function results(drawKey, rehearsal = false) {
    return db.prepare(`SELECT e.*, p.username, z.label AS prize_label, z.kind AS prize_kind, z.value AS prize_value
                       FROM extractions e JOIN players p ON p.id = e.player_id JOIN prizes z ON z.id = e.prize_id
                       WHERE e.draw_key = ? AND e.rehearsal = ? ORDER BY e.id`).all(drawKey, rehearsal ? 1 : 0)
      .map((e) => ({ ...e, user: maskUser(e.username) }));
  }

  function voidExtraction(id, reason, agent) {
    const r = String(reason || '').trim();
    if (r.length < 3) throw new RuleError('INVALID', 'Escribe el motivo.');
    const e = db.prepare('SELECT * FROM extractions WHERE id = ?').get(id);
    if (!e || e.voided_at) throw new RuleError('NOT_FOUND', 'Extracción no encontrada.');
    db.prepare('UPDATE extractions SET voided_at = ?, void_reason = ? WHERE id = ?').run(new Date().toISOString(), r, id);
    audit(agent.id, 'draw.extract.void', e.player_id, { id, code: e.code, reason: r, rehearsal: !!e.rehearsal });
    return { ok: true };
  }

  function clearRehearsal(drawKey, agent) {
    const n = db.prepare('DELETE FROM extractions WHERE draw_key = ? AND rehearsal = 1').run(drawKey).changes;
    audit(agent.id, 'draw.rehearsal.clear', null, { draw: drawKey, removed: n });
    return { removed: n };
  }

  // Datos públicos (usuarios enmascarados) para la pantalla de OBS y la página pública.
  function snapshot(drawKey, rehearsal = false) {
    const d = getDraw(drawKey);
    const tickets = db.prepare(`SELECT t.code, t.urn, t.player_id, p.username FROM tickets t JOIN players p ON p.id = t.player_id
                                WHERE t.draw_key = ? AND t.voided_at IS NULL ORDER BY t.urn, t.seq`).all(drawKey);
    const winners = results(drawKey, rehearsal).filter((e) => !e.voided_at);
    const out = (urn) => tickets.filter((t) => t.urn === urn).map((t) => ({ code: t.code, user: maskUser(t.username), p: t.player_id }));
    return {
      draw: { key: d.key, name: d.name, cutoff_at: d.cutoff_at, comodines: !!d.comodines_enabled },
      tickets: { A: out('A'), B: out('B') },
      prizes: prizes(drawKey, rehearsal).map((p) => ({
        id: p.id, urn: p.urn, label: p.label, kind: p.kind, value: p.value, qty: p.qty, remaining: p.remaining,
      })),
      winners: winners.map((w) => ({
        id: w.id, urn: w.urn, code: w.code, user: w.user, p: w.player_id, prize: w.prize_label, kind: w.prize_kind, at: w.created_at,
      })),
      rehearsal: !!rehearsal,
    };
  }

  return { prizes, savePrize, deletePrize, pool, extract, results, voidExtraction, clearRehearsal, snapshot, URN_NAMES };
}

module.exports = { createDrawEngine, maskUser };
