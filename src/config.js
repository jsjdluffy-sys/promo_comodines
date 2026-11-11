// Configuración del negocio. Cambia estos valores con variables de entorno o aquí mismo.
module.exports = {
  PORT: Number(process.env.PORT || 3000),
  DB_PATH: process.env.DB_PATH || 'data/sorteo.db',

  // Zona horaria del negocio (Chile continental, con horario de verano automático).
  TIMEZONE: process.env.TIMEZONE || 'America/Santiago',

  TICKET_UNIT: 20000, // 1 ticket por cada 20.000 recargados en el día
  DAILY_CAP: 10, // máximo de tickets por usuario por día

  // Valores por defecto al crear un sorteo: sábado (6) a las 18:00 hora de Chile.
  // Cada sorteo guarda su propio cierre; después del cierre las entregas quedan bloqueadas.
  CUTOFF_WEEKDAY: 6,
  CUTOFF_HOUR: 18,

  // Por encima de este total diario el agente debe escribir el monto dos veces.
  BIG_AMOUNT: Number(process.env.BIG_AMOUNT || 1000000),

  SESSION_HOURS: 12,
};
