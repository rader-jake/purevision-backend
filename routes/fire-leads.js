import express from "express";
import { db } from "../db/connection.js";
import { cancelAllJobsForLead } from "../workers/follow-ups.js";
import { INTEGRITY_SHOP, normalizePhone } from "../services/fire-text.js";
import {
  getPhones, sendOutreach, markDeadIfExhausted, insideSendingHours, OUTSIDE_HOURS_MESSAGE,
} from "../services/fire-leads.js";

// Integrity Claims — public-adjuster fire leads, several phone numbers per lead.
const router = express.Router();

const authorized = (secret) => secret === process.env.MANUAL_ENTRY_SECRET;
const PHONE_STATUSES = ["untried", "sent", "replied", "wrong_number", "no_response"];
const MAX_IMPORT_BATCH = 500;
const iso = (ts) => (ts ? String(ts).replace(" ", "T") + "Z" : null);
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

// ─── ROUTE: IMPORT FIRE LEADS ────────────────────────────────────────────────
// { secret, leads: [{ incident, date, type, address, city, county, name, phones: [...], email, notes }] }
router.post("/admin/import-fire-leads", (req, res) => {
  const { secret, leads } = req.body;
  if (!authorized(secret)) return res.status(403).json({ error: "Unauthorized" });
  if (!Array.isArray(leads)) return res.status(400).json({ error: "leads must be an array" });
  if (leads.length > MAX_IMPORT_BATCH) {
    return res.status(400).json({ error: `Send at most ${MAX_IMPORT_BATCH} leads per request` });
  }

  const incidentExists = db.prepare(`
    SELECT 1 FROM fire_leads f JOIN leads l ON l.id = f.lead_id
    WHERE l.shop_id = ? AND UPPER(f.incident) = UPPER(?) LIMIT 1
  `);
  const phoneTaken = db.prepare(`
    SELECT 1 FROM lead_phones p JOIN leads l ON l.id = p.lead_id
    WHERE l.shop_id = ? AND p.phone = ? LIMIT 1
  `);
  const insertLead = db.prepare(`
    INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special, call_status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  const insertFire = db.prepare(`
    INSERT INTO fire_leads (lead_id, incident, incident_date, property_type, address, city, county, email, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPhone = db.prepare(`INSERT INTO lead_phones (lead_id, phone) VALUES (?, ?)`);

  const out = { imported: 0, skipped: 0, no_contact: 0, duplicate_phones: 0 };

  db.transaction(() => {
    for (const raw of leads) {
      const incident = clip(raw?.incident, 60);

      // Phones may arrive as an array or a delimited string; keep valid, unique US numbers
      const rawPhones = Array.isArray(raw?.phones) ? raw.phones : String(raw?.phones ?? raw?.phone ?? "").split(/[,;\n]+/);
      const phones = [...new Set(rawPhones.map(normalizePhone).filter(Boolean))].slice(0, 20);
      if (!phones.length) { out.no_contact++; continue; }

      if (incident && incidentExists.get(INTEGRITY_SHOP, incident)) { out.skipped++; continue; }

      // A number already on another Integrity lead would make replies ambiguous — drop it
      const fresh = phones.filter(p => !phoneTaken.get(INTEGRITY_SHOP, p));
      out.duplicate_phones += phones.length - fresh.length;
      if (!fresh.length) { out.skipped++; continue; }

      const address = clip(raw?.address, 200);
      const city = clip(raw?.city, 80);
      const date = clip(raw?.date, 30);
      const type = clip(raw?.type, 40);
      const info = `${titleCase(type) || "Property"} fire${date ? ` — ${date}` : ""}`;

      const leadId = insertLead.run(
        INTEGRITY_SHOP,
        clip(raw?.name, 120) || "there",
        fresh[0],
        [address, city].filter(Boolean).join(", ") || "your property",
        info,
      ).lastInsertRowid;
      insertFire.run(leadId, incident || null, date || null, type || null, address || null, city || null,
        clip(raw?.county, 60) || null, clip(raw?.email, 120) || null, clip(raw?.notes, 2000) || null);
      for (const p of fresh) insertPhone.run(leadId, p);
      out.imported++;
    }
  })();

  console.log(`[Fire Import] imported ${out.imported}, skipped ${out.skipped}, no contact ${out.no_contact}`);
  res.json({ success: true, ...out });
});

// ─── ROUTE: FIRE NEXT NUMBER ─────────────────────────────────────────────────
// { secret, lead_id, phone_id? } — texts the next untried number (or the specific one asked for).
router.post("/admin/fire-next-number", async (req, res) => {
  const { secret, lead_id, phone_id } = req.body;
  if (!authorized(secret)) return res.status(403).json({ error: "Unauthorized" });

  const lead = db.prepare(`SELECT * FROM leads WHERE id = ? AND shop_id = ?`).get(lead_id, INTEGRITY_SHOP);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (["dead", "opted_out", "claimed"].includes(lead.call_status)) {
    return res.status(409).json({ error: `This lead is ${lead.call_status.replace("_", " ")} — no more outreach` });
  }

  const phones = getPhones(lead.id);
  if (phones.some(p => p.status === "replied")) {
    return res.status(409).json({ error: "A number already replied — continue that conversation instead" });
  }

  let target;
  if (phone_id) {
    target = phones.find(p => p.id === Number(phone_id));
    if (!target) return res.status(404).json({ error: "Phone not found for this lead" });
    if (target.status === "sent") return res.status(409).json({ error: "That number was already texted — wait for a reply or mark it no response" });
    if (target.status === "wrong_number") return res.status(409).json({ error: "That number is marked wrong" });
  } else {
    target = phones.find(p => p.status === "untried");
    if (!target) return res.status(409).json({ error: "No untried numbers left for this lead", remaining_numbers: 0 });
  }

  if (!insideSendingHours()) return res.status(409).json({ error: OUTSIDE_HOURS_MESSAGE, outside_hours: true });

  const result = await sendOutreach(lead, target);
  if (!result.success) return res.status(result.conflict ? 409 : 502).json({ error: result.error });

  const remaining = getPhones(lead.id).filter(p => p.status === "untried").length;
  res.json({ success: true, phone: target.phone, phone_id: target.id, remaining_numbers: remaining });
});

// ─── ROUTE: FIRE BLAST ───────────────────────────────────────────────────────
// Opener to the first untried number of every never-contacted lead, 10–30 s apart.
// Runs in the background (a 200-lead blast takes over an hour), so this returns at once —
// poll /admin/fire-blast-status. Anything unsent when the server restarts is simply still
// "pending", so firing again is safe.
const blast = { running: false, total: 0, sent: 0, failed: 0, skipped: 0, stopped: null, startedAt: null, finishedAt: null };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runBlast(leadIds) {
  const min = Number(process.env.FIRE_BLAST_MIN_MS) || 10_000;
  const max = Number(process.env.FIRE_BLAST_MAX_MS) || 30_000;
  try {
    for (let i = 0; i < leadIds.length; i++) {
      if (!insideSendingHours()) { blast.stopped = "Stopped at the 8 PM Eastern cutoff — fire again tomorrow to continue"; break; }

      const lead = db.prepare(`SELECT * FROM leads WHERE id = ? AND shop_id = ?`).get(leadIds[i], INTEGRITY_SHOP);
      const phone = lead && lead.call_status === "pending"
        ? getPhones(lead.id).find(p => p.status === "untried")
        : null;
      if (!phone) { blast.skipped++; continue; } // handled by hand since the blast started

      const result = await sendOutreach(lead, phone);
      if (result.success) blast.sent++; else blast.failed++;

      if (i < leadIds.length - 1) await sleep(min + Math.random() * (max - min));
    }
  } catch (e) {
    console.error("[Fire Blast] Error:", e.message);
    blast.stopped = `Stopped on an error: ${e.message}`;
  } finally {
    blast.running = false;
    blast.finishedAt = new Date().toISOString();
    console.log(`[Fire Blast] Done — sent ${blast.sent}/${blast.total}, failed ${blast.failed}, skipped ${blast.skipped}`);
  }
}

router.post("/admin/fire-blast", (req, res) => {
  const { secret, limit } = req.body;
  if (!authorized(secret)) return res.status(403).json({ error: "Unauthorized" });
  if (blast.running) return res.status(409).json({ error: "A blast is already running", ...blast });
  if (!insideSendingHours()) return res.status(409).json({ error: OUTSIDE_HOURS_MESSAGE, outside_hours: true });

  let ready = db.prepare(`
    SELECT l.id FROM leads l
    WHERE l.shop_id = ? AND l.call_status = 'pending'
      AND EXISTS (SELECT 1 FROM lead_phones p WHERE p.lead_id = l.id AND p.status = 'untried')
      AND NOT EXISTS (SELECT 1 FROM lead_phones p WHERE p.lead_id = l.id AND p.status IN ('sent', 'replied'))
    ORDER BY l.id
  `).all(INTEGRITY_SHOP).map(r => r.id);
  if (Number(limit) > 0) ready = ready.slice(0, Number(limit));

  Object.assign(blast, { running: ready.length > 0, total: ready.length, sent: 0, failed: 0, skipped: 0, stopped: null, startedAt: new Date().toISOString(), finishedAt: null });
  if (!ready.length) return res.json({ success: true, sent: 0, total: 0, queued: 0 });

  void runBlast(ready);
  const avgSeconds = (((Number(process.env.FIRE_BLAST_MIN_MS) || 10_000) + (Number(process.env.FIRE_BLAST_MAX_MS) || 30_000)) / 2) / 1000;
  res.json({ success: true, sent: 0, total: ready.length, queued: ready.length, estimated_minutes: Math.ceil((ready.length * avgSeconds) / 60) });
});

router.get("/admin/fire-blast-status", (req, res) => {
  if (!authorized(req.query.secret)) return res.status(403).json({ error: "Unauthorized" });
  res.json({ success: true, ...blast });
});

// ─── ROUTE: MARK PHONE STATUS ────────────────────────────────────────────────
router.post("/admin/mark-phone-status", (req, res) => {
  const { secret, phone_id, status } = req.body;
  if (!authorized(secret)) return res.status(403).json({ error: "Unauthorized" });
  if (!PHONE_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${PHONE_STATUSES.join(", ")}` });

  const phone = db.prepare(`
    SELECT p.* FROM lead_phones p JOIN leads l ON l.id = p.lead_id WHERE p.id = ? AND l.shop_id = ?
  `).get(phone_id, INTEGRITY_SHOP);
  if (!phone) return res.status(404).json({ error: "Phone not found" });

  db.prepare(`UPDATE lead_phones SET status = ? WHERE id = ?`).run(status, phone.id);
  if (status === "replied") db.prepare(`UPDATE leads SET lead_phone = ? WHERE id = ?`).run(phone.phone, phone.lead_id);

  const leadDead = (status === "wrong_number" || status === "no_response") && markDeadIfExhausted(phone.lead_id);
  res.json({ success: true, lead_dead: leadDead, remaining_numbers: getPhones(phone.lead_id).filter(p => p.status === "untried").length });
});

// ─── ROUTE: LEAD PHONES ──────────────────────────────────────────────────────
router.get("/admin/lead-phones/:leadId", (req, res) => {
  if (!authorized(req.query.secret)) return res.status(403).json({ error: "Unauthorized" });
  const lead = db.prepare(`SELECT id, lead_name, lead_phone FROM leads WHERE id = ? AND shop_id = ?`).get(req.params.leadId, INTEGRITY_SHOP);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  res.json({ success: true, lead, phones: getPhones(lead.id) });
});

// ─── ROUTE: ALL FIRE LEADS (dashboard list) ──────────────────────────────────
// One call for the Leads tab: lead + spreadsheet details + every phone + last message.
router.get("/admin/fire-leads", (req, res) => {
  if (!authorized(req.query.secret)) return res.status(403).json({ error: "Unauthorized" });

  const leads = db.prepare(`
    SELECT l.id, l.lead_name, l.lead_phone, l.lead_vehicle, l.lead_special, l.call_status, l.manual_mode, l.created_at,
           f.incident, f.incident_date, f.property_type, f.address, f.city, f.county, f.email, f.notes
    FROM leads l LEFT JOIN fire_leads f ON f.lead_id = l.id
    WHERE l.shop_id = ?
    ORDER BY l.id DESC
  `).all(INTEGRITY_SHOP);

  const phonesBy = new Map();
  for (const p of db.prepare(`
    SELECT p.id, p.lead_id, p.phone, p.status FROM lead_phones p
    JOIN leads l ON l.id = p.lead_id WHERE l.shop_id = ? ORDER BY p.id
  `).all(INTEGRITY_SHOP)) {
    if (!phonesBy.has(p.lead_id)) phonesBy.set(p.lead_id, []);
    phonesBy.get(p.lead_id).push(p);
  }

  const lastBy = new Map(db.prepare(`
    SELECT lead_id, direction, body, created_at FROM sms_messages
    WHERE id IN (
      SELECT MAX(m.id) FROM sms_messages m JOIN leads l ON l.id = m.lead_id WHERE l.shop_id = ? GROUP BY m.lead_id
    )
  `).all(INTEGRITY_SHOP).map(m => [m.lead_id, { direction: m.direction, body: m.body, created_at: iso(m.created_at) }]));

  const inbound = new Set(db.prepare(`
    SELECT DISTINCT m.lead_id FROM sms_messages m JOIN leads l ON l.id = m.lead_id
    WHERE l.shop_id = ? AND m.direction = 'inbound'
  `).all(INTEGRITY_SHOP).map(r => r.lead_id));

  res.json({
    success: true,
    leads: leads.map(l => ({
      ...l,
      created_at: iso(l.created_at),
      phones: phonesBy.get(l.id) ?? [],
      last_message: lastBy.get(l.id) ?? null,
      has_inbound: inbound.has(l.id),
    })),
  });
});

export default router;
