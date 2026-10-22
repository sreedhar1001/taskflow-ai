/**
 * db.js — SQLite via sql.js (pure JS, no native compilation needed)
 *
 * sql.js keeps the database in memory; we persist it to disk manually
 * after every write so data survives restarts.
 *
 * Tables:
 *   runs  — one row per task submission
 *   steps — one row per AI step inside a run
 */

const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "taskflow.db");

let db = null; // will be set after init

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      goal        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'queued',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS steps (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      index_num   INTEGER NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'queued',
      attempts    INTEGER NOT NULL DEFAULT 0,
      output      TEXT,
      error       TEXT,
      started_at  TEXT,
      finished_at TEXT,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
  `);

  persist();
}

function persist() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (_) {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rowToObj(stmt) {
  const cols = stmt.getColumnNames();
  const rows = [];
  while (stmt.step()) {
    const vals = stmt.get();
    const obj = {};
    cols.forEach((c, i) => { obj[c] = vals[i]; });
    rows.push(obj);
  }
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  return rowToObj(stmt);
}

function queryOne(sql, params = []) {
  return query(sql, params)[0] || null;
}

// ─── Run helpers ──────────────────────────────────────────────────────────────

function createRun(id, goal) {
  run(
    `INSERT INTO runs (id, goal, status, created_at) VALUES (?, ?, 'queued', datetime('now'))`,
    [id, goal]
  );
}

function updateRun(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  run(`UPDATE runs SET ${sets} WHERE id = ?`, [...Object.values(fields), id]);
}

function getRun(id) {
  return queryOne(`SELECT * FROM runs WHERE id = ?`, [id]);
}

function listRuns() {
  return query(`SELECT * FROM runs ORDER BY created_at DESC LIMIT 50`);
}

// ─── Step helpers ─────────────────────────────────────────────────────────────

function createStep(id, runId, indexNum, name, description) {
  run(
    `INSERT INTO steps (id, run_id, index_num, name, description, status, attempts)
     VALUES (?, ?, ?, ?, ?, 'queued', 0)`,
    [id, runId, indexNum, name, description || ""]
  );
}

function updateStep(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  run(`UPDATE steps SET ${sets} WHERE id = ?`, [...Object.values(fields), id]);
}

function getStepsForRun(runId) {
  return query(
    `SELECT * FROM steps WHERE run_id = ? ORDER BY index_num`,
    [runId]
  );
}

module.exports = {
  init,
  createRun,
  updateRun,
  getRun,
  listRuns,
  createStep,
  updateStep,
  getStepsForRun,
};
