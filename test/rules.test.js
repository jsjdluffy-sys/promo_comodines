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
});

test('el total no puede bajar', () => {
  assert.throws(() => computeClaim({ total: 40000, prevTotal: 45000, alreadyGiven: 2 }), { code: 'AMOUNT_DECREASED' });
});

test('división de urnas solo para marcados en Halloween', () => {
  assert.deepEqual(splitDestination({ destination: 'ruleta', toDeliver: 3, halloweenEligible: false }), { a: 0, b: 3 });
  assert.throws(() => splitDestination({ destination: 'comodin', toDeliver: 3, halloweenEligible: false }), { code: 'NOT_ELIGIBLE' });
  assert.deepEqual(splitDestination({ destination: 'comodin', toDeliver: 3, halloweenEligible: true }), { a: 3, b: 0 });
  assert.deepEqual(splitDestination({ destination: 'dividir', toDeliver: 3, aCount: 1, halloweenEligible: true }), { a: 1, b: 2 });
  assert.throws(() => splitDestination({ destination: 'dividir', toDeliver: 3, aCount: 4, halloweenEligible: true }), { code: 'INVALID_SPLIT' });
});

test('sugerencia de cierre: próximo sábado 18:00; el día cambia a medianoche de Chile', () => {
  assert.equal(time.drawKey(cl('2026-11-11T10:00:00')), '2026-11-14'); // miércoles -> sábado
  assert.equal(time.drawKey(cl('2026-11-14T17:59:59')), '2026-11-14');
  assert.equal(time.drawKey(cl('2026-11-14T18:00:00')), '2026-11-21');
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
  // Sorteo de esta semana: abre el lunes 09/11, cierra sábado 14/11 18:00, con Comodines
  seedFirstDraw(svc, db, cl('2026-11-09T09:00:00'));
  return { db, svc, p };
}

test('flujo completo: varias entregas en el día, números únicos y tope', () => {
  const { svc, p } = setup();
  const now = cl('2026-11-11T10:00:00');
  const r1 = svc.confirm({ playerId: p.id, total: 45000, destination: 'ruleta', agentId: 1, now });
  assert.deepEqual(r1.codes.B, ['B-0001', 'B-0002']);
  const r2 = svc.confirm({ playerId: p.id, total: 100000, destination: 'ruleta', agentId: 1, now: cl('2026-11-11T15:30:00') });
  assert.deepEqual(r2.codes.B, ['B-0003', 'B-0004', 'B-0005']);
  assert.match(r2.message, /Recibiste 3 tickets/);
  assert.match(r2.message, /Para este sorteo llevas 5 para Ruleta/);
  assert.match(r2.message, /tickets hasta el 14\/11\/2026 18:00/);
  assert.throws(() => svc.confirm({ playerId: p.id, total: 100000, destination: 'ruleta', agentId: 1, now }), { code: 'NO_CHANGE' });
  assert.throws(() => svc.confirm({ playerId: p.id, total: 90000, destination: 'ruleta', agentId: 1, now }), { code: 'AMOUNT_DECREASED' });
  // monto alto exige confirmación
  assert.throws(() => svc.confirm({ playerId: p.id, total: 1500000, destination: 'ruleta', agentId: 1, now }), { code: 'CONFIRM_REQUIRED' });
  const r3 = svc.confirm({ playerId: p.id, total: 1500000, confirmTotal: 1500000, destination: 'ruleta', agentId: 1, now });
  assert.equal(r3.calc.toDeliver, 5);
  assert.throws(() => svc.confirm({ playerId: p.id, total: 1600000, confirmTotal: 1600000, destination: 'ruleta', agentId: 1, now }), { code: 'CAP_REACHED' });
  // día siguiente: contador nuevo, misma semana
  const r4 = svc.confirm({ playerId: p.id, total: 20000, destination: 'ruleta', agentId: 1, now: cl('2026-11-12T09:00:00') });
  assert.deepEqual(r4.codes.B, ['B-0011']);
  assert.equal(r4.week.B, 11);
});

test('Halloween: dividir entre urnas con numeración separada', () => {
  const { svc, p } = setup();
  const now = cl('2026-11-11T10:00:00');
  assert.throws(() => svc.confirm({ playerId: p.id, total: 60000, destination: 'comodin', agentId: 1, now }), { code: 'NOT_ELIGIBLE' });
  svc.setHalloween(p.id, true, { id: 1, role: 'agente' });
  const r = svc.confirm({ playerId: p.id, total: 60000, destination: 'dividir', aCount: 1, agentId: 1, now });
  assert.deepEqual(r.codes, { A: ['A-0001'], B: ['B-0001', 'B-0002'] });
  assert.match(r.message, /Comodín: A-0001/);
  assert.throws(() => svc.setHalloween(p.id, false, { id: 1, role: 'agente' }), { code: 'FORBIDDEN' });
});

test('después del cierre del sábado 18:00 las entregas se bloquean', () => {
  const { svc, p } = setup();
  const r1 = svc.confirm({ playerId: p.id, total: 120000, destination: 'ruleta', agentId: 1, now: cl('2026-11-14T17:59:00') });
  assert.equal(r1.draw, '2026-11-14');
  assert.throws(() => svc.preview(p.id, 300000, cl('2026-11-14T18:00:00')), { code: 'CLOSED' });
  assert.throws(() => svc.confirm({ playerId: p.id, total: 300000, destination: 'ruleta', agentId: 1, now: cl('2026-11-15T10:00:00') }), { code: 'CLOSED' });
  assert.equal(svc.activeDraw(cl('2026-11-14T18:00:00')), null);
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
  const r = svc.confirm({ playerId: p.id, total: 40000, destination: 'ruleta', agentId: 1, now });
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
  const r1 = svc.confirm({ playerId: p.id, total: 40000, destination: 'ruleta', agentId: 1, now });
  const r2 = svc.confirm({ playerId: p.id, total: 100000, destination: 'ruleta', agentId: 1, now });
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
  const r3 = svc.confirm({ playerId: p.id, total: 100000, destination: 'ruleta', agentId: 1, now });
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
  svc.confirm({ playerId: p.id, total: 40000, destination: 'ruleta', agentId: 1, now });
  const d = svc.editDraw('2026-11-13', { name: 'Sorteo sábado 14/11', drawDate: '2026-11-14', cutoffLocal: '2026-11-14T18:00' }, admin, now);
  assert.equal(d.key, '2026-11-14');
  assert.equal(d.cutoff_label, '14/11/2026 18:00');
  assert.equal(svc.drawSummary('2026-11-14').B.tickets, 2);
  assert.equal(svc.activeDraw(cl('2026-11-14T17:30:00')).key, '2026-11-14');
  assert.equal(svc.activeDraw(cl('2026-11-14T18:00:00')), null);
  assert.throws(() => svc.editDraw('2026-11-14', { cutoffLocal: '2026-11-10T18:00' }, admin, now), { code: 'INVALID' });
});
