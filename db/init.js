import { db } from "./connection.js";

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id         TEXT NOT NULL,
    lead_name       TEXT,
    lead_phone      TEXT,
    lead_vehicle    TEXT,
    lead_special    TEXT,
    call_status     TEXT DEFAULT 'pending',
    call_id         TEXT,
    call_attempts   INTEGER DEFAULT 0,
    booked_at       TEXT,
    square_order_id TEXT,
    deposit_sent    INTEGER DEFAULT 0,
    deposit_paid    INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sms_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    direction TEXT,
    body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS outreach_leads (
    id TEXT PRIMARY KEY,
    name TEXT,
    biz TEXT,
    phone TEXT,
    vertical TEXT,
    city TEXT,
    notes TEXT,
    status TEXT DEFAULT 'new',
    touch INTEGER DEFAULT 1,
    added TEXT
  )
`);

db.prepare(`CREATE TABLE IF NOT EXISTS call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  shop_id TEXT,
  lead_name TEXT,
  lead_phone TEXT,
  outcome TEXT,
  notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

// ─── SCHEDULED JOBS TABLE ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL,
    shop_id     TEXT NOT NULL,
    job_type    TEXT NOT NULL,
    attempt     INTEGER DEFAULT 1,
    send_at     TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now'))
  )
`);

try {
  db.exec(`ALTER TABLE leads ADD COLUMN call_attempts INTEGER DEFAULT 0`);
} catch(e) { /* already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN manual_mode INTEGER DEFAULT 0`);
} catch(e) { /* already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN form_id TEXT`);
} catch(e) { /* already exists */ }
try {
  db.exec(`ALTER TABLE scheduled_jobs ADD COLUMN custom_message TEXT`);
} catch(e) { /* already exists */ }
