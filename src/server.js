const crypto = require('crypto');
const path = require('path');
const express = require('express');
const config = require('./config');
const time = require('./time');
const { openDb } = require('./db');
const { createService, seedFirstDraw, hashPassword, verifyPassword } = require('./service');
const { RuleError } = require('./rules');
const { createDrawEngine } = require('./drawEngine');
const { exportPublicSite } = require('./publicSite');

function createApp(db) {
  const svc = createService(db);
  const app = express();
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Motor de físicas servido localmente (funciona sin internet en OBS).
  app.get('/vendor/matter.min.js', (req, res) =>
    res.sendFile(path.join(path.dirname(require.resolve('matter-js')), 'matter.min.js')));
  // three.js (3D) y cannon-es (física 3D) para la pantalla overlay3d.html
  const NM = path.join(__dirname, '..', 'node_modules');
  app.use('/vendor/three', express.static(path.join(NM, 'three')));
  app.get('/vendor/cannon-es.js', (req, res) => res.type('application/javascript').sendFile(path.join(NM, 'cannon-es', 'dist', 'cannon-es.js')));
  app.use('/sitio-publico', express.static(path.join(__dirname, '..', 'sitio-publico')));

  // ---- Autenticación ----
  const getCookie = (req, name) => {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  };

  function auth(req, res, next) {
    const token = getCookie(req, 'sid');
    const row = token && db.prepare(`SELECT a.* FROM sessions s JOIN agents a ON a.id = s.agent_id
                                     WHERE s.token = ? AND s.expires_at > ? AND a.active = 1`)
      .get(token, new Date().toISOString());
    if (!row) return res.status(401).json({ error: 'No autenticado' });
    req.agent = { id: row.id, name: row.name, username: row.username, role: row.role };
    next();
  }
  const adminOnly = (req, res, next) =>
    req.agent.role === 'admin' ? next() : res.status(403).json({ error: 'Solo admin' });

  const handle = (fn) => (req, res) => {
    try {
      res.json(fn(req, res));
    } catch (e) {
      if (e instanceof RuleError) return res.status(400).json({ error: e.message, code: e.code });
      console.error(e);
      res.status(500).json({ error: 'Error interno' });
    }
  };

  // Bloqueo por intentos fallidos: 8 por usuario o 20 por conexión cada 15 minutos.
  const failures = new Map();
  const WINDOW_MS = 15 * 60 * 1000;
  const recent = (key) => (failures.get(key) || []).filter((t) => Date.now() - t < WINDOW_MS);
  const addFailure = (key) => failures.set(key, [...recent(key), Date.now()]);

  app.post('/api/login', handle((req, res) => {
    const { username, password } = req.body || {};
    const userKey = 'u:' + String(username || '').toLowerCase();
    const ipKey = 'ip:' + (req.socket.remoteAddress || '');
    if (recent(userKey).length >= 8 || recent(ipKey).length >= 20) {
      throw new RuleError('LOCKED', 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.');
    }
    const a = db.prepare('SELECT * FROM agents WHERE username = ? AND active = 1').get(String(username || ''));
    if (!a || !verifyPassword(String(password || ''), a.pass_hash)) {
      addFailure(userKey);
      addFailure(ipKey);
      throw new RuleError('BAD_LOGIN', 'Usuario o contraseña incorrectos.');
    }
    failures.delete(userKey);
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + config.SESSION_HOURS * 3600e3);
    db.prepare('INSERT INTO sessions (token, agent_id, expires_at) VALUES (?,?,?)').run(token, a.id, expires.toISOString());
    svc.audit(a.id, 'agent.login', null, null);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.SESSION_HOURS * 3600}${secure}`);
    return { name: a.name, role: a.role };
  }));

  app.post('/api/logout', auth, handle((req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(getCookie(req, 'sid'));
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  }));

  app.get('/api/me', auth, handle((req) => req.agent));

  // ---- Estado general (sorteo abierto o bloqueo) ----
  app.get('/api/status', auth, handle(() => {
    const now = new Date();
    const p = time.localParts(now);
    const open = svc.activeDraw(now);
    // Sugerencia para el próximo sorteo: el viernes siguiente al último cierre programado.
    const lastCutoff = svc.listDraws(now)[0]?.cutoff_at;
    const nextBase = lastCutoff && new Date(lastCutoff) > now ? new Date(lastCutoff) : now;
    return {
      now: now.toISOString(),
      today: time.dayKey(now),
      draw: open,
      lastDraw: open ? null : svc.currentOrLastDraw(now),
      localTime: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
      timezone: config.TIMEZONE,
      ticketUnit: config.TICKET_UNIT,
      dailyCap: config.DAILY_CAP,
      bigAmount: config.BIG_AMOUNT,
      defaultCutoff: `${time.drawKey(nextBase)}T${String(config.CUTOFF_HOUR).padStart(2, '0')}:00`,
    };
  }));

  // ---- Jugadores ----
  app.get('/api/players', auth, handle((req) => svc.searchPlayers(req.query.q)));
  app.post('/api/players', auth, handle((req) => svc.createPlayer(req.body?.username, req.agent.id)));
  app.get('/api/players/:id', auth, handle((req) => svc.summary(Number(req.params.id))));
  app.post('/api/players/:id/halloween', auth, handle((req) =>
    svc.setHalloween(Number(req.params.id), !!req.body?.eligible, req.agent)));

  app.post('/api/tickets/void', auth, adminOnly, handle((req) =>
    svc.voidTickets(Array.isArray(req.body?.codes) ? req.body.codes.map(String) : [], String(req.body?.draw || ''), req.body?.reason,
      parseAmount(req.body?.correctedTotal), req.agent)));
  app.post('/api/claims/:id/void', auth, adminOnly, handle((req) =>
    svc.voidClaim(Number(req.params.id), req.body?.reason, req.agent)));
  app.post('/api/players/:id/void-all', auth, adminOnly, handle((req) =>
    svc.voidAllForPlayer(Number(req.params.id), req.body?.reason, req.agent)));

  const parseAmount = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/\D/g, '') || NaN));

  app.post('/api/players/:id/preview', auth, handle((req) =>
    svc.preview(Number(req.params.id), parseAmount(req.body?.total))));

  app.post('/api/players/:id/claim', auth, handle((req) => svc.confirm({
    playerId: Number(req.params.id),
    total: parseAmount(req.body?.total),
    confirmTotal: req.body?.confirmTotal == null ? null : parseAmount(req.body.confirmTotal),
    destination: req.body?.destination === 'ruleta' ? 'premios' : (req.body?.destination || 'premios'),
    aCount: req.body?.aCount == null ? undefined : Number(req.body.aCount),
    agentId: req.agent.id,
  })));

  // ---- Sorteos ----
  app.get('/api/draws', auth, handle(() => svc.listDraws()));
  app.post('/api/draws', auth, adminOnly, handle((req) => svc.createDraw({
    name: req.body?.name,
    drawDate: req.body?.drawDate,
    cutoffLocal: req.body?.cutoffLocal,
    comodines: !!req.body?.comodines,
  }, req.agent)));
  app.post('/api/draws/:key/cutoff', auth, adminOnly, handle((req) =>
    svc.setCutoff(req.params.key, req.body?.cutoffLocal, req.agent)));
  app.post('/api/draws/:key/edit', auth, adminOnly, handle((req) => svc.editDraw(req.params.key, {
    name: req.body?.name, drawDate: req.body?.drawDate, cutoffLocal: req.body?.cutoffLocal,
  }, req.agent)));
  app.post('/api/draws/:key/close', auth, adminOnly, handle((req) => svc.closeNow(req.params.key, req.agent)));
  app.get('/api/draws/:key', auth, handle((req) => svc.drawSummary(req.params.key)));
  app.get('/api/draws/:key/tickets.csv', auth, (req, res) => {
    const rows = svc.drawTickets(req.params.key);
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const csv = ['codigo,urna,usuario,entregado'].concat(rows.map((r) =>
      [r.code, r.urn === 'A' ? 'Comodines' : 'Premios', esc(r.username), r.created_at].join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tickets-${req.params.key}.csv"`);
    res.send('﻿' + csv);
  });

  // ---- Admin ----
  app.get('/api/audit', auth, adminOnly, handle(() => svc.auditLog()));
  app.get('/api/agents', auth, adminOnly, handle(() =>
    db.prepare('SELECT id, username, name, role, active, created_at FROM agents ORDER BY id').all()));
  app.post('/api/agents', auth, adminOnly, handle((req) => {
    const { username, name, password, role } = req.body || {};
    if (!/^[\w.\-]{3,30}$/.test(username || '')) throw new RuleError('INVALID', 'Usuario de agente inválido.');
    if (!name || String(password || '').length < 8) throw new RuleError('INVALID', 'Nombre requerido y contraseña de 8+ caracteres.');
    if (db.prepare('SELECT 1 FROM agents WHERE username = ?').get(username)) throw new RuleError('DUPLICATE', 'Ese agente ya existe.');
    const r = db.prepare('INSERT INTO agents (username, name, pass_hash, role) VALUES (?,?,?,?)')
      .run(username, name, hashPassword(password), role === 'admin' ? 'admin' : 'agente');
    svc.audit(req.agent.id, 'agent.create', null, { username, role });
    return { id: r.lastInsertRowid };
  }));
  app.post('/api/agents/:id/active', auth, adminOnly, handle((req) => {
    db.prepare('UPDATE agents SET active = ? WHERE id = ?').run(req.body?.active ? 1 : 0, Number(req.params.id));
    if (!req.body?.active) db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(Number(req.params.id));
    svc.audit(req.agent.id, req.body?.active ? 'agent.enable' : 'agent.disable', null, { agentId: Number(req.params.id) });
    return { ok: true };
  }));

  // ================= SORTEO EN VIVO =================
  const engine = createDrawEngine(db, svc);

  // Estado de la transmisión (en memoria). La pantalla de OBS lo recibe en tiempo real por SSE.
  const live = {
    drawKey: null, scene: 'intro', mixing: false, prizeId: null, rehearsal: true,
    last: null, busyUntil: 0, rev: 0,
  };
  const clients = new Set();
  const liveDraw = () => live.drawKey || svc.currentOrLastDraw()?.key || null;
  function publicState() {
    return {
      drawKey: liveDraw(), scene: live.scene, mixing: live.mixing, prizeId: live.prizeId,
      rehearsal: live.rehearsal, last: live.last, rev: live.rev,
    };
  }
  function broadcast(type, data) {
    live.rev += 1;
    const msg = `event: ${type}\ndata: ${JSON.stringify({ ...data, state: publicState() })}\n\n`;
    for (const res of clients) res.write(msg);
  }

  // Público (solo datos enmascarados): pantalla de OBS en este PC.
  app.get('/api/live/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ state: publicState() })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  });
  app.get('/api/live/snapshot', handle(() => {
    const key = liveDraw();
    if (!key) throw new RuleError('NOT_FOUND', 'No hay sorteos.');
    return { ...engine.snapshot(key, live.rehearsal), state: publicState() };
  }));

  // Control (solo admin).
  app.get('/api/live/control', auth, adminOnly, handle(() => {
    const key = liveDraw();
    const d = key ? svc.listDraws().find((x) => x.key === key) : null;
    return {
      state: publicState(), draw: d, draws: svc.listDraws(),
      prizes: key ? engine.prizes(key, live.rehearsal) : [],
      results: key ? engine.results(key, live.rehearsal) : [],
      counts: key ? { A: engine.pool(key, 'A', live.rehearsal).length, B: engine.pool(key, 'B', live.rehearsal).length } : { A: 0, B: 0 },
      overlayClients: clients.size,
    };
  }));

  app.post('/api/live/action', auth, adminOnly, handle((req) => {
    const b = req.body || {};
    switch (b.action) {
      case 'draw':
        live.drawKey = String(b.drawKey || '') || null; live.last = null; live.prizeId = null;
        broadcast('reload', {}); break;
      case 'mode':
        live.rehearsal = !!b.rehearsal; live.last = null; live.prizeId = null;
        svc.audit(req.agent.id, live.rehearsal ? 'live.mode.rehearsal' : 'live.mode.real', null, { draw: liveDraw() });
        broadcast('reload', {}); break;
      case 'scene':
        if (!['intro', 'A', 'B', 'results'].includes(b.scene)) throw new RuleError('INVALID', 'Escena inválida.');
        live.scene = b.scene; live.mixing = false; live.prizeId = null;
        broadcast('scene', {}); break;
      case 'mix':
        live.mixing = !!b.on; broadcast('mix', {}); break;
      case 'prize':
        live.prizeId = b.prizeId ? Number(b.prizeId) : null; broadcast('prize', {}); break;
      case 'extract': {
        if (Date.now() < live.busyUntil) throw new RuleError('BUSY', 'Espera a que termine la animación de la pelotita anterior.');
        if (live.scene !== 'A' && live.scene !== 'B') throw new RuleError('INVALID', 'Primero muestra el Bombo Comodines o el Bombo Premios.');
        const key = liveDraw();
        let prizeId = Number(b.prizeId || live.prizeId);
        if (!prizeId) { // un solo premio disponible en el bombo: se usa ese
          const avail = engine.prizes(key, live.rehearsal).filter((p) => p.urn === live.scene && p.remaining > 0);
          if (avail.length === 1) prizeId = avail[0].id;
        }
        const result = engine.extract({ drawKey: key, urn: live.scene, prizeId, rehearsal: live.rehearsal, agent: req.agent });
        live.last = result; live.mixing = true; live.busyUntil = Date.now() + 9000;
        broadcast('extract', { result: { ...result, username: undefined } }); // la pantalla solo recibe el usuario enmascarado
        return result;
      }
      case 'clear-last':
        live.last = null; broadcast('clear', {}); break;
      default:
        throw new RuleError('INVALID', 'Acción inválida.');
    }
    return publicState();
  }));

  app.get('/api/draws/:key/prizes', auth, handle((req) => engine.prizes(req.params.key, false)));
  app.post('/api/draws/:key/prizes', auth, adminOnly, handle((req) => {
    const r = engine.savePrize(req.params.key, req.body || {}, req.agent);
    broadcast('reload', {});
    return r;
  }));
  app.post('/api/draws/:key/prizes/:id/delete', auth, adminOnly, handle((req) => {
    const r = engine.deletePrize(req.params.key, Number(req.params.id), req.agent);
    broadcast('reload', {});
    return r;
  }));
  app.get('/api/draws/:key/results', auth, handle((req) => engine.results(req.params.key, req.query.rehearsal === '1')));
  app.post('/api/extractions/:id/discard', auth, adminOnly, handle((req) => {
    const r = engine.discardExtraction(Number(req.params.id), req.agent);
    live.last = null; live.prizeId = r.prizeId; live.busyUntil = Date.now() + 3500;
    broadcast('discard', { discard: r });
    return r;
  }));
  app.post('/api/extractions/:id/void', auth, adminOnly, handle((req) => {
    const r = engine.voidExtraction(Number(req.params.id), req.body?.reason, req.agent);
    live.last = null; broadcast('reload', {});
    return r;
  }));
  app.post('/api/draws/:key/rehearsal/clear', auth, adminOnly, handle((req) => {
    const r = engine.clearRehearsal(req.params.key, req.agent);
    live.last = null; broadcast('reload', {});
    return r;
  }));
  app.post('/api/draws/:key/export', auth, adminOnly, handle((req) => {
    const r = exportPublicSite(engine.snapshot(req.params.key, false), path.join(__dirname, '..', 'sitio-publico'));
    svc.audit(req.agent.id, 'public.export', null, { draw: req.params.key, tickets: r.tickets });
    return r;
  }));

  return app;
}

function ensureAdmin(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM agents').get().n > 0) return;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db.prepare("INSERT INTO agents (username, name, pass_hash, role) VALUES ('admin','Administrador',?,'admin')")
    .run(hashPassword(password));
  console.log('\n  Primer inicio: se creó el usuario "admin".');
  console.log(`  Contraseña: ${password}  (guárdala; puedes crear más agentes desde el panel)\n`);
}

if (require.main === module) {
  const db = openDb(config.DB_PATH);
  ensureAdmin(db);
  const first = seedFirstDraw(createService(db), db);
  if (first) console.log(`  Sorteo abierto: "${first.name}" · tickets hasta el ${first.cutoff_label}`);
  createApp(db).listen(config.PORT, () => {
    console.log(`Panel de tickets en http://localhost:${config.PORT}  (zona horaria: ${config.TIMEZONE})`);
  });
}

module.exports = { createApp, ensureAdmin };
