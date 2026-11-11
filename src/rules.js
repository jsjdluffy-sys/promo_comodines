// Reglas puras de cálculo (sin base de datos), fáciles de probar.
const config = require('./config');

function ticketsForTotal(total) {
  return Math.min(config.DAILY_CAP, Math.floor(total / config.TICKET_UNIT));
}

class RuleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Calcula cuántos tickets entregar ahora.
 * total:        total recargado HOY según el backoffice (acumulado, no el último depósito)
 * prevTotal:    último total registrado hoy (null si es la primera vez)
 * alreadyGiven: tickets ya entregados hoy
 */
function computeClaim({ total, prevTotal, alreadyGiven }) {
  if (!Number.isInteger(total) || total < 0) {
    throw new RuleError('INVALID_AMOUNT', 'El monto debe ser un número entero positivo.');
  }
  if (prevTotal !== null && total < prevTotal) {
    throw new RuleError(
      'AMOUNT_DECREASED',
      `El total ingresado (${fmt(total)}) es menor al último registrado hoy (${fmt(prevTotal)}). Revisa el backoffice.`,
    );
  }
  const ticketsForDay = ticketsForTotal(total);
  const toDeliver = Math.max(0, ticketsForDay - alreadyGiven);
  let status = 'OK';
  if (toDeliver === 0) {
    if (alreadyGiven >= config.DAILY_CAP) status = 'CAP_REACHED';
    else if (prevTotal !== null && total === prevTotal) status = 'NO_CHANGE';
    else status = 'BELOW_NEXT_TICKET';
  }
  const nextTicketAt = ticketsForDay < config.DAILY_CAP ? (ticketsForDay + 1) * config.TICKET_UNIT : null;
  return {
    ticketsForDay,
    alreadyGiven,
    toDeliver,
    status,
    missingForNext: nextTicketAt === null ? null : nextTicketAt - total,
    // Cuánto subió el total desde la última entrega de hoy (para que el agente lo compare con lo que dice el usuario).
    increase: prevTotal === null ? null : total - prevTotal,
    needsDoubleCheck: total >= config.BIG_AMOUNT,
  };
}

/** Divide los tickets entre Urna A (Bombo Comodines) y Urna B (Bombo Premios). */
// Cualquier jugador puede participar por el Comodín (no hace falta que le falte un día específico).
function splitDestination({ destination, toDeliver, aCount }) {
  if (destination === 'premios' || toDeliver === 0) return { a: 0, b: toDeliver };
  if (destination === 'comodin') return { a: toDeliver, b: 0 };
  if (destination === 'dividir') {
    if (!Number.isInteger(aCount) || aCount < 0 || aCount > toDeliver) {
      throw new RuleError('INVALID_SPLIT', `Para dividir, los tickets a Comodín deben estar entre 0 y ${toDeliver}.`);
    }
    return { a: aCount, b: toDeliver - aCount };
  }
  throw new RuleError('INVALID_DESTINATION', 'Destino inválido.');
}

function fmt(n) {
  return Number(n).toLocaleString('es-CO');
}

module.exports = { ticketsForTotal, computeClaim, splitDestination, RuleError, fmt };
