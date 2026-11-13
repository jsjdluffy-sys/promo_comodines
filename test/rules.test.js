process.env.TIMEZONE = 'America/Santiago'; // Chile: UTC-3 en verano (nov), UTC-4 en invierno
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeClaim, splitDestination, ticketsForTotal } = require('../src/rules');
const time = require('../src/time');
const { openDb } = require('../src/db');
const { createService, seedFirstDraw, hashPassword } = require('../src/service');

// Hora local de Chile en noviembre (horario de verano, UTC-3) -> Date
const cl = (s) => new Date(s + '-03:00');

test('conversión: 1 ticket por cada 20.000, tope 10', () => {
  assert.equal(ticketsForTotal(19999), 0);
  assert.equal(ticketsForTotal(20000), 1);
  assert.equal(ticketsForTotal(100000), 5);
  assert.equal(ticketsForTotal(200000), 10);
  assert.equal(ticketsForTotal(999999), 10);
});

test('cálculo por diferencia sobre el acumulado del día', () => {
  assert.equal(computeClaim({ total: 45000, prevTotal: null, alreadyGiven: 0 }).toDeliver, 2);
  assert.equal(computeClaim({ total: 100000, prevTotal: 45000, alreadyGiven: 2 }).toDeliver, 3);
  assert.equal(computeClaim({ total: 250000, prevTotal: 100000, alreadyGiven: 5 }).toDeliver, 5);
  const capped = computeClaim({ total: 300000, prevTotal: 250000, alreadyGiven: 10 });
  assert.equal(capped.toDeliver, 0);
  assert.equal(capped.status, 'CAP_REACHED');
  assert.equal(computeClaim({ total: 45000, prevTotal: 45000, alreadyGiven: 2 }).status, 'NO_CHANGE');
  assert.equal(computeClaim({ total: 55000, prevTotal: 45000, alreadyGiven: 2 }).status, 'BELOW_NEXT_TICKET');
  assert.equal(computeClaim({ total: 55000, prevTotal: 45000, alreadyGiven: 2 }).missingForNext, 5000);
  // ejemplo: 60.000 en la mañana y +240.000 en la tarde = total 300.000
  const morning = computeClaim({ total: 60000, prevTotal: null, alreadyGiven: 0 });
  assert.equal(morning.toDeliver, 3);
  assert.equal(morning.increase, null);
  const afternoon = computeClaim({ total: 300000, prevTotal: 60000, alreadyGiven: 3 });
  assert.equal(afternoon.toDeliver, 7);
  assert.equal(afternoon.increase, 240000);
});

test('el total no puede bajar', () => {
  assert.throws(() => computeClaim({ total: 40000, prevTotal: 45000, alreadyGiven: 2 }), { code: 'AMOUNT_DECREASED' });
});

test('división de urnas: cualquier jugador puede ir a Comodín', () => {
  assert.deepEqual(splitDestination({ destination: 'premios', toDeliver: 3 }), { a: 0, b: 3 });
  assert.deepEqual(splitDestination({ destination: 'comodin', toDeliver: 3 }), { a: 3, b: 0 });
  assert.deepEqual(splitDestination({ destination: 'dividir', toDeliver: 3, aCount: 1 }), { a: 1, b: 2 });
  assert.throws(() => splitDestination({ destination: 'dividir', toDeliver: 3, aCount: 4 }), { code: 'INVALID_SPLIT' });
});

test('sugerencia de cierre: próximo sábado 19:00; el día cambia a medianoche de Chile', () => {
  assert.equal(time.drawKey(cl('2026-11-11T10:00:00')), '2026-11-14'); // miércoles -> sábado
  assert.equal(time.drawKey(cl('2026-11-14T18:59:59')), '2026-11-14');
  assert.equal(time.drawKey(cl('2026-11-14T19:00:00')), '2026-11-21');
  assert.equal(time.dayKey(cl('2026-11-10T23:30:00')), '2026-11-10');
  assert.equal(time.dayKey(cl('2026-11-11T00:10:00')), '2026-11-11');
});

test('hora de Chile con horario de verano e invierno', () => {
  assert.equal(time.zonedToUtc('2026-11-13T19:00').toISOString(), '2026-11-13T22:00:00.000Z'); // UTC-3
  assert.equal(time.zonedToUtc('2026-07-10T19:00').toISOString(), '2026-07-10T23:00:00.000Z'); // UTC-4
  assert.equal(time.formatLocal(new Date('2026-11-13T22:00:00Z')), '13/11/2026 19:00');
});

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO agents (username,name,pass_hash,role) VALUES ('ana','Ana',?, 'agente')").run(hashPassword('x'));
  const svc = createService(db);
  const p = svc.createPlayer('juan_perez23', 1);
  // Sorteo de esta semana: abre el lunes 09/11, cierra sábado 14/11 19:00, con Comodines
  seedFirstDraw(svc, db, cl('2026-11-09T09:00:00'));
  return { db, svc, p };
}

test('flujo completo: varias entregas en el día, números únicos y tope', () => {
  const { svc, p } = setup();
  const now = cl('2026-11-11T10:00:00');
  const r1 = svc.confirm({ playerId: p.id, total: 45000, destination: 'premios', agentId: 1, now });
  assert.deepEqual(r1.codes.B, ['B-0001', 'B-0002']);
  const r2 = svc.confirm({ playerId: p.id, total: 100000, destination: 'premios', agentId: 1, now: cl('2026-11-11T15:30:00') });
  assert.deepEqual(r2.codes.B, ['B-0003', 'B-0004', 'B-0005']);
  assert.match(r2.message, /Recibiste 3 tickets/);
  assert.match(r2.message, /Para este sorteo llevas 5 para Premios/);
  assert.match(r2.message, /tickets hasta el 14\/11\/2026 19:00/);
  assert.throws(() => svc.confirm({ playerId: p.id, total: 100000, destination: 'premios', agentId: 1, now }), { code: 'NO_CHANGE' });
  assert.throws(() => svc.confirm({ playerId: p.id, total: 90000, destination: 'premios', agentId: 1, now }), { code: 'AMOUNT_DECREASED' });
  // monto alto exige confirmación
  assert.throws(() => svc.confirm({ playerId: p.id, total: 1500000, destination: 'premios', agentId: 1, now }), { code: 'CONFIRM_REQUIRED' });
  const r3 = svc.confirm({ playerId: p.id, total: 1500000, confirmTotal: 1500000, destination: 'premios', agentId: 1, now });
  assert.equal(r3.calc.toDeliver, 5);
  assert.throws(() => svc.confirm({ playerId: p.id, total: 1600000, confirmTotal: 1600000, destination: 'premios', agentId: 1, now }), { code: 'CAP_REACHED' });
  // día siguiente: contador nuevo, misma semana
  const r4 = svc.confirm({ playerId: p.id, total: 20000, destination: 'premios', agentId: 1, now: cl('2026-11-12T09:00:00') });
  assert.deepEqual(r4.codes.B, ['B-0011']);
  assert.equal(r4.week.B, 11);
});

test('Comodín sin marca previa: dividir entre urnas con numeración separada', () => {
  const { svc, p } = setup();
  const now = cl('2026-11-11T10:00:00');
  const r = svc.confirm({ playerId: p.id, total: 60000, destination: 'dividir', aCount: 1, agentId: 1, now });
  assert.deepEqual(r.codes, { A: ['A-0001'], B: ['B-0001', 'B-0002'] });
  assert.match(r.message, /Comodín: A-0001/);
});

test('después del cierre del sábado 19:00 las entregas se bloquean', () => {
  const { svc, p } = setup();
  const r1 = svc.confirm({ playerId: p.id, total: 120000, destination: 'premios', agentId: 1, now: cl('2026-11-14T18:59:00') });
  assert.equal(r1.draw, '2026-11-14');
  assert.throws(() => svc.preview(p.id, 300000, cl('2026-11-14T19:00:00')), { code: 'CLOSED' });
  assert.throws(() => svc.confirm({ playerId: p.id, total: 300000, destination: 'premios', agentId: 1, now: cl('2026-11-15T10:00:00') }), { code: 'CLOSED' });
  assert.equal(svc.activeDraw(cl('2026-11-14T19:00:00')), null);
  assert.equal(svc.currentOrLastDraw(cl('2026-11-15T10:00:00')).key, '2026-11-14');
});

test('nuevo sorteo anunciado por el admin, sin Comodines', () => {
  const { svc, p } = setup();
  const admin = { id: 1, role: 'admin' };
  svc.setHalloween(p.id, true, admin);
  const now = cl('2026-11-16T12:00:00');
  // no se puede crear uno que se cruce con el actual
  assert.throws(() => svc.createDraw({ name: 'Choque', drawDate: '2026-11-13', cutoffLocal: '2026-11-13T19:00', opensLocal: '2026-11-12T10:00' }, admin, cl('2026-11-11T10:00:00')), { code: 'OVERLAP' });
  const d = svc.createDraw({ name: 'Sorteo semanal 21/11', drawDate: '2026-11-21', cutoffLocal: '2026-11-21T18:00', comodines: false }, admin, now);
  assert.equal(d.comodines_enabled, false);
  assert.equal(svc.preview(p.id, 40000, now).comodinesAllowed, false);
  assert.throws(() => svc.confirm({ playerId: p.id, total: 40000, destination: 'comodin', agentId: 1, now }), { code: 'NO_COMODINES' });
  const r = svc.confirm({ playerId: p.id, total: 40000, destination: 'premios', agentId: 1, now });
  assert.deepEqual(r.codes.B, ['B-0001', 'B-0002']); // numeración nueva por sorteo
  assert.equal(r.draw, '2026-11-21');
  // cerrar antes de tiempo
  svc.closeNow('2026-11-21', admin, cl('2026-11-18T12:00:00'));
  assert.throws(() => svc.preview(p.id, 60000, cl('2026-11-18T12:01:00')), { code: 'CLOSED' });
});

test('anular entregas: tickets fuera del sorteo, tope y total del día se recalculan', () => {
  const { svc, p, db } = setup();
  const admin = { id: 1, role: 'admin' };
  const now = cl('2026-11-11T10:00:00');
  const r1 = svc.confirm({ playerId: p.id, total: 40000, destination: 'premios', agentId: 1, now });
  const r2 = svc.confirm({ playerId: p.id, total: 100000, destination: 'premios', agentId: 1, now });
  assert.throws(() => svc.voidClaim(r2.claimId, 'prueba', { id: 1, role: 'agente' }), { code: 'FORBIDDEN' });
  assert.throws(() => svc.voidClaim(r2.claimId, '', admin), { code: 'INVALID' });
  assert.deepEqual(svc.voidClaim(r2.claimId, 'Ticket de prueba', admin, now), { voidedClaims: 1, voidedTickets: 3 });
  // vuelve al estado de la primera entrega: total 40.000 y 2 tickets
  const pv = svc.preview(p.id, 100000, now);
  assert.equal(pv.prevTotal, 40000);
  assert.equal(pv.toDeliver, 3);
  assert.equal(svc.drawSummary('2026-11-14').B.tickets, 2);
  assert.deepEqual(svc.drawTickets('2026-11-14').map((t) => t.code), ['B-0001', 'B-0002']);
  // los números anulados no se reutilizan
  const r3 = svc.confirm({ playerId: p.id, total: 100000, destination: 'premios', agentId: 1, now });
  assert.deepEqual(r3.codes.B, ['B-0006', 'B-0007', 'B-0008']);
  // anular todo el usuario
  assert.deepEqual(svc.voidAllForPlayer(p.id, 'Usuario de prueba', admin, now), { voidedClaims: 2, voidedTickets: 5 });
  assert.equal(svc.drawSummary('2026-11-14').B.tickets, 0);
  assert.equal(svc.summary(p.id, now).week.B.length, 0);
  assert.equal(svc.preview(p.id, 20000, now).toDeliver, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'tickets.void'").get().n, 3);
});

test('editar sorteo: cambiar cierre al sábado 18:00 y la fecha mueve los tickets', () => {
  const { db } = setup();
  const svc = createService(db);
  const admin = { id: 1, role: 'admin' };
  const p = svc.getPlayer(1);
  // Sorteo creado con la versión anterior: viernes 13/11 19:00
  db.prepare("UPDATE draws SET key = '2026-11-13', cutoff_at = ? ").run(time.zonedToUtc('2026-11-13T19:00').toISOString());
  const now = cl('2026-11-11T10:00:00');
  svc.confirm({ playerId: p.id, total: 40000, destination: 'premios', agentId: 1, now });
  const d = svc.editDraw('2026-11-13', { name: 'Sorteo sábado 14/11', drawDate: '2026-11-14', cutoffLocal: '2026-11-14T18:00' }, admin, now);
  assert.equal(d.key, '2026-11-14');
  assert.equal(d.cutoff_label, '14/11/2026 18:00');
  assert.equal(svc.drawSummary('2026-11-14').B.tickets, 2);
  assert.equal(svc.activeDraw(cl('2026-11-14T17:30:00')).key, '2026-11-14');
  assert.equal(svc.activeDraw(cl('2026-11-14T18:00:00')), null);
  assert.throws(() => svc.editDraw('2026-11-14', { cutoffLocal: '2026-11-10T18:00' }, admin, now), { code: 'INVALID' });
});

// ================= Sorteo en vivo =================
const { createDrawEngine } = require('../src/drawEngine');

function setupDraw() {
  const ctx = setup();
  const engine = createDrawEngine(ctx.db, ctx.svc);
  const admin = { id: 1, role: 'admin' };
  return { ...ctx, engine, admin };
}

test('premios por defecto del sorteo', () => {
  const { engine } = setupDraw();
  const pr = engine.prizes('2026-11-14');
  assert.deepEqual(pr.filter((p) => p.urn === 'A').map((p) => [p.label, p.qty]), [['Comodín Halloween', 5]]);
  assert.deepEqual(pr.filter((p) => p.urn === 'B').map((p) => [p.label, p.qty]), [
    ['$25.000', 1], ['$15.000', 1], ['$10.000', 1], ['$5.000', 1],
    ['Boost x2', 2], ['Boost +20%', 5], ['Boost +30%', 3], ['Boost +40%', 2],
  ]);
});

test('extracción: real solo después del cierre, 1 premio por persona por bombo, ensayo aparte', () => {
  const { svc, engine, admin, db } = setupDraw();
  const now = cl('2026-11-11T10:00:00');
  const ids = ['ana', 'beto', 'carla'].map((u) => svc.createPlayer(u, 1).id);
  svc.confirm({ playerId: ids[0], total: 200000, destination: 'dividir', aCount: 5, agentId: 1, now }); // 5 A + 5 B
  svc.confirm({ playerId: ids[1], total: 20000, destination: 'premios', agentId: 1, now });
  svc.confirm({ playerId: ids[2], total: 20000, destination: 'comodin', agentId: 1, now });
  const pr = engine.prizes('2026-11-14');
  const p25 = pr.find((p) => p.label === '$25.000'), p20 = pr.find((p) => p.label === 'Boost +20%');
  // antes del cierre: solo ensayo
  assert.throws(() => engine.extract({ drawKey: '2026-11-14', urn: 'B', prizeId: p25.id, rehearsal: false, agent: admin, now }), { code: 'NOT_CLOSED' });
  const reh = engine.extract({ drawKey: '2026-11-14', urn: 'B', prizeId: p25.id, rehearsal: true, agent: admin, now });
  assert.ok(reh.rehearsal);
  // después del cierre: real. Bombo B tiene 2 jugadores -> 2 extracciones posibles, luego vacío
  const after = cl('2026-11-14T19:30:00');
  const w1 = engine.extract({ drawKey: '2026-11-14', urn: 'B', prizeId: p25.id, rehearsal: false, agent: admin, now: after });
  const w2 = engine.extract({ drawKey: '2026-11-14', urn: 'B', prizeId: p20.id, rehearsal: false, agent: admin, now: after });
  assert.notEqual(w1.p, w2.p);
  assert.throws(() => engine.extract({ drawKey: '2026-11-14', urn: 'B', prizeId: p20.id, rehearsal: false, agent: admin, now: after }), { code: 'EMPTY' });
  // premio agotado
  assert.equal(engine.prizes('2026-11-14').find((p) => p.id === p25.id).remaining, 0);
  // el ensayo no afecta lo real; ana puede ganar también en el bombo A
  const pa = pr.find((p) => p.urn === 'A');
  const a1 = engine.extract({ drawKey: '2026-11-14', urn: 'A', prizeId: pa.id, rehearsal: false, agent: admin, now: after });
  assert.ok([ids[0], ids[2]].includes(a1.p));
  // el ticket ganador no se puede anular
  assert.throws(() => svc.voidTickets([w1.code], '2026-11-14', 'x prueba', 0, admin), { code: 'WINNER' });
  // anular extracción: el jugador vuelve a participar
  engine.voidExtraction(w2.id, 'error de prueba', admin);
  assert.equal(engine.pool('2026-11-14', 'B', false).length > 0, true);
  engine.clearRehearsal('2026-11-14', admin);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM extractions WHERE rehearsal = 1').get().n, 0);
});

test('aleatoriedad: cada ticket tiene la misma probabilidad (simulación)', () => {
  const { svc, engine, admin, db } = setupDraw();
  const now = cl('2026-11-11T10:00:00');
  // ana 10 tickets, beto 5, carla 1 -> esperado 62,5 % / 31,25 % / 6,25 %
  const pl = [['ana', 200000], ['beto', 100000], ['carla', 20000]].map(([u, t]) => {
    const id = svc.createPlayer(u, 1).id;
    svc.confirm({ playerId: id, total: t, destination: 'premios', agentId: 1, now });
    return id;
  });
  const pz = svc;
  void pz;
  const p = db.prepare("INSERT INTO prizes (draw_key, urn, label, kind, value, qty) VALUES ('2026-11-14','B','Test','cash',1,100000)").run().lastInsertRowid;
  const counts = {};
  const N = 16000;
  for (let i = 0; i < N; i++) {
    const r = engine.extract({ drawKey: '2026-11-14', urn: 'B', prizeId: p, rehearsal: true, agent: admin, now });
    counts[r.p] = (counts[r.p] || 0) + 1;
    db.prepare('DELETE FROM extractions WHERE id = ?').run(r.id);
  }
  const share = pl.map((id) => counts[id] / N);
  assert.ok(Math.abs(share[0] - 10 / 16) < 0.02, `ana ${share[0]}`);
  assert.ok(Math.abs(share[1] - 5 / 16) < 0.02, `beto ${share[1]}`);
  assert.ok(Math.abs(share[2] - 1 / 16) < 0.012, `carla ${share[2]}`);
  assert.ok(counts[pl[2]] > 0, 'quien tiene 1 ticket también gana');
});

test('anular tickets sueltos devuelve el cupo del día', () => {
  const { svc, admin, p } = setupDraw();
  const now = cl('2026-11-11T10:00:00');
  const r = svc.confirm({ playerId: p.id, total: 200000, destination: 'premios', agentId: 1, now });
  assert.equal(r.calc.toDeliver, 10);
  assert.throws(() => svc.voidTickets([r.codes.B[0]], '2026-11-14', 'x', 0, admin), { code: 'INVALID' });
  // el agente escribió 200.000 pero el total real era 160.000 (8 tickets): se anulan 2
  assert.throws(() => svc.voidTickets([r.codes.B[9]], '2026-11-14', 'Entregados de más', 160000, admin, now), { code: 'INVALID' });
  svc.voidTickets([r.codes.B[8], r.codes.B[9]], '2026-11-14', 'Entregados de más', 160000, admin, now);
  const s = svc.summary(p.id, now);
  assert.equal(s.week.B.length, 8);
  assert.equal(s.today.given, 8);
  assert.equal(s.today.lastTotal, 160000);
  assert.deepEqual(s.voidedTickets.map((t) => t.code), ['B-0009', 'B-0010']);
  // con el mismo total no recibe nada; si recarga 40.000 más (total 200.000) recibe 2
  assert.equal(svc.preview(p.id, 160000, now).toDeliver, 0);
  assert.equal(svc.preview(p.id, 200000, now).toDeliver, 2);
  assert.equal(svc.preview(p.id, 200000, now).increase, 40000);
});

test('al agua: el ganador ausente sale del bombo y el premio se vuelve a sortear', () => {
  const { svc, engine, admin } = setupDraw();
  const now = cl('2026-11-11T10:00:00'), after = cl('2026-11-14T21:00:00');
  const ana = svc.createPlayer('ana', 1).id, beto = svc.createPlayer('beto', 1).id;
  svc.confirm({ playerId: ana, total: 200000, destination: 'dividir', aCount: 5, agentId: 1, now });
  svc.confirm({ playerId: beto, total: 20000, destination: 'premios', agentId: 1, now });
  const p25 = engine.prizes('2026-11-14').find((p) => p.label === '$25.000');
  const w = engine.extract({ drawKey: '2026-11-14', urn: 'B', prizeId: p25.id, rehearsal: false, agent: admin, now: after });
  assert.equal(engine.prizes('2026-11-14').find((p) => p.id === p25.id).remaining, 0);
  const d = engine.discardExtraction(w.id, admin);
  assert.equal(d.p, w.p);
  assert.equal(engine.prizes('2026-11-14').find((p) => p.id === p25.id).remaining, 1); // el premio vuelve
  assert.ok(engine.pool('2026-11-14', 'B', false).every((t) => t.player_id !== w.p)); // el ausente ya no participa en B
  const w2 = engine.extract({ drawKey: '2026-11-14', urn: 'B', prizeId: p25.id, rehearsal: false, agent: admin, now: after });
  assert.notEqual(w2.p, w.p);
  const snap = engine.snapshot('2026-11-14', false);
  assert.deepEqual(snap.winners.map((x) => x.code), [w2.code]);
  assert.equal(snap.discarded.length, 1);
  // si ana fue al agua en B, igual puede participar en el bombo A
  if (w.p === ana) assert.ok(engine.pool('2026-11-14', 'A', false).some((t) => t.player_id === ana));
});
