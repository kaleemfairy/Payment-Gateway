const sqlite3 = require('sqlite3').verbose();
const path    = require('path');

const DB_PATH = path.join(__dirname, 'payments.db');
const db = new sqlite3.Database(DB_PATH);

// Promisified helpers
const run  = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { err ? rej(err) : res(this); }));
const get  = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
const all  = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
const exec = (sql) => new Promise((res, rej) => db.exec(sql, err => err ? rej(err) : res()));

async function init() {
  await exec('PRAGMA journal_mode = WAL;');
  await exec('PRAGMA foreign_keys = ON;');

  await exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id                TEXT PRIMARY KEY,
      order_id          TEXT UNIQUE NOT NULL,
      amount            REAL NOT NULL,
      description       TEXT NOT NULL,
      customer_name     TEXT,
      customer_email    TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      utr_id            TEXT,
      utr_submitted_at  DATETIME,
      verified_at       DATETIME,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      notes             TEXT
    );
  `);

  // Seed default settings
  const defaults = [
    ['upi_id',              'merchant@upi'],
    ['merchant_name',       'My Store'],
    ['merchant_logo',       ''],
    ['support_phone',       ''],
    ['support_email',       ''],
    ['auto_verify_minutes', '0'],
    ['webhook_url',         ''],
  ];
  for (const [k, v] of defaults) {
    await run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v]);
  }
}

module.exports = { db, run, get, all, exec, init };
