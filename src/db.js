const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','agente')),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id),
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id                    INTEGER PRIMARY KEY,
  username              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  halloween_eligible    INTEGER NOT NULL DEFAULT 0,
  halloween_marked_by   INTEGER REFERENCES agents(id),
  halloween_marked_at   TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Cada sorteo lo abre el admin. Solo se entregan tickets entre opens_at y cutoff_at.
CREATE TABLE IF NOT EXISTS draws (
  id                 INTEGER PRIMARY KEY,
  key                TEXT NOT NULL UNIQUE,   -- fecha del sorteo YYYY-MM-DD (prefijo de los tickets)
  name               TEXT NOT NULL,
  opens_at           TEXT NOT NULL,          -- ISO UTC
  cutoff_at          TEXT NOT NULL,          -- ISO UTC
  comodines_enabled  INTEGER NOT NULL DEFAULT 0,
  closed_early_at    TEXT,
  created_by         INTEGER REFERENCES agents(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Cada vez que un agente registra el total del backoffice y entrega tickets.
CREATE TABLE IF NOT EXISTS claims (
  id               INTEGER PRIMARY KEY,
  player_id        INTEGER NOT NULL REFERENCES players(id),
  agent_id         INTEGER NOT NULL REFERENCES agents(id),
  day_key          TEXT NOT NULL,      -- día local (contador diario / tope de 10)
  draw_key         TEXT NOT NULL,      -- viernes del sorteo al que cuentan
  total_reported   INTEGER NOT NULL,   -- total del día según backoffice
  prev_total       INTEGER,            -- total registrado antes (NULL si era el primero)
  tickets_for_day  INTEGER NOT NULL,
  delivered        INTEGER NOT NULL,
  to_a             INTEGER NOT NULL,
  to_b             INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_player_day ON claims(player_id, day_key);

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY,
  draw_key    TEXT NOT NULL,
  urn         TEXT NOT NULL CHECK (urn IN ('A','B')),
  seq         INTEGER NOT NULL,
  code        TEXT NOT NULL,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  claim_id    INTEGER NOT NULL REFERENCES claims(id),
  created_at  TEXT NOT NULL,
  UNIQUE (draw_key, urn, seq),
  UNIQUE (draw_key, code)
);
CREATE INDEX IF NOT EXISTS idx_tickets_player_draw ON tickets(player_id, draw_key);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  agent_id    INTEGER REFERENCES agents(id),
  action      TEXT NOT NULL,
  player_id   INTEGER REFERENCES players(id),
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
