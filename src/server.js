const crypto = require('crypto');
const path = require('path');
const express = require('express');
const config = require('./config');
const time = require('./time');
const { openDb } = require('./db');
const { createService, seedFirstDraw, hashPassword, verifyPassword } = require('./service');
const { RuleError } = require('./rules');

function createApp(db) {
  const svc = createService(db);
  const app = express();
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

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
    destination: req.body?.destination || 'ruleta',
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
      [r.code, r.urn === 'A' ? 'Comodin' : 'Ruleta', esc(r.username), r.created_at].join(','))).join('\n');
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
