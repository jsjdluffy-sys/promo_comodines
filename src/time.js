const config = require('./config');

const pad = (n) => String(n).padStart(2, '0');

// Fecha y hora "de pared" en la zona horaria del negocio.
function localParts(date, tz = config.TIMEZONE) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
    weekday: weekdays[p.weekday],
  };
}

function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// "YYYY-MM-DD" del día local. Es la clave del contador diario de tickets.
function dayKey(date = new Date()) {
  const p = localParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Próximo viernes de cierre a partir de `date` (sugerencia por defecto al crear un sorteo).
function drawKey(date = new Date()) {
  const p = localParts(date);
  const today = dayKey(date);
  if (p.weekday === config.CUTOFF_WEEKDAY) {
    return p.hour < config.CUTOFF_HOUR ? today : addDays(today, 7);
  }
  const daysUntil = (config.CUTOFF_WEEKDAY - p.weekday + 7) % 7;
  return addDays(today, daysUntil);
}

function formatDayKey(key) {
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}

module.exports = { localParts, dayKey, drawKey, addDays, formatDayKey };

// Diferencia (ms) entre la hora local de `tz` y UTC en el instante `date`.
function tzOffsetMs(date, tz = config.TIMEZONE) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// "YYYY-MM-DDTHH:mm" en hora local del negocio -> Date (instante real). Maneja el horario de verano.
function zonedToUtc(local, tz = config.TIMEZONE) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = wall - tzOffsetMs(new Date(wall), tz);
  guess = wall - tzOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

// Date -> "YYYY-MM-DDTHH:mm" en hora local del negocio (para inputs datetime-local).
function toLocalInput(date) {
  const p = localParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// Date -> "13/11/2026 19:00" en hora local del negocio.
function formatLocal(date) {
  const p = localParts(date);
  return `${pad(p.day)}/${pad(p.month)}/${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

module.exports.zonedToUtc = zonedToUtc;
module.exports.toLocalInput = toLocalInput;
module.exports.formatLocal = formatLocal;
