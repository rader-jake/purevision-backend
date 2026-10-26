import { db } from "../db/connection.js";
import { sendSMS } from "./sms.js";
import { isWithinSendingWindow } from "./calendar.js";
import { cancelAllJobsForLead } from "../workers/follow-ups.js";
import { INTEGRITY_SHOP, INTEGRITY_TZ, buildOpener } from "./fire-text.js";

// Fire-lead outreach is only allowed 8 AM – 8 PM Eastern. FIRE_DISABLE_HOURS_CHECK=1 turns the
// guard off for local testing only — never set it in production.
export function insideSendingHours() {
  return process.env.FIRE_DISABLE_HOURS_CHECK === "1" || isWithinSendingWindow(INTEGRITY_TZ);
}

export const OUTSIDE_HOURS_MESSAGE =
  "Outside the 8 AM – 8 PM Eastern sending window — try again during business hours.";

export function getPhones(leadId) {
  return db.prepare(`SELECT id, lead_id, phone, status, created_at FROM lead_phones WHERE lead_id = ? ORDER BY id`).all(leadId);
}

/**
 * Texts the opener to one of a lead's numbers and records it. The number is claimed
 * (set to 'sent') *before* the network call so a double-click or overlapping blast can't
 * text the same number twice; if the send fails the claim is rolled back.
 */
const inFlight = new Set(); // lead ids mid-send: a double-click must not text two numbers at once

export async function sendOutreach(lead, phoneRow) {
  if (inFlight.has(lead.id)) return { success: false, conflict: true, error: "A text to this lead is already being sent" };
  inFlight.add(lead.id);
  try {
    return await sendOutreachNow(lead, phoneRow);
  } finally {
    inFlight.delete(lead.id);
  }
}

async function sendOutreachNow(lead, phoneRow) {
  const claimed = db.prepare(`
    UPDATE lead_phones SET status = 'sent' WHERE id = ? AND status IN ('untried', 'no_response')
  `).run(phoneRow.id);
  if (claimed.changes !== 1) return { success: false, conflict: true, error: "That number was already tried" };

  const fire = db.prepare(`SELECT address, city FROM fire_leads WHERE lead_id = ?`).get(lead.id);
  const address = lead.lead_vehicle || [fire?.address, fire?.city].filter(Boolean).join(", ");
  const message = buildOpener(lead.lead_name, address);

  const result = await sendSMS(phoneRow.phone, message);
  if (result?.success === false) {
    db.prepare(`UPDATE lead_phones SET status = ? WHERE id = ?`).run(phoneRow.status, phoneRow.id);
    return { success: false, error: result.error || "SMS failed" };
  }

  db.transaction(() => {
    // Moving on from earlier numbers that never answered
    db.prepare(`UPDATE lead_phones SET status = 'no_response' WHERE lead_id = ? AND status = 'sent' AND id != ?`).run(lead.id, phoneRow.id);
    db.prepare(`
      UPDATE leads
      SET lead_phone = ?, call_status = CASE WHEN call_status = 'pending' THEN 'sms_fallback' ELSE call_status END
      WHERE id = ?
    `).run(phoneRow.phone, lead.id);
    db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, 'outbound', ?)`).run(lead.id, message);
  })();

  console.log(`[Fire] Opener sent to ${lead.lead_name} on ${phoneRow.phone}`);
  return { success: true, message };
}

/** True when the lead has numbers and every one is a dead end (wrong number / no response). */
export function allPhonesExhausted(leadId) {
  const phones = getPhones(leadId);
  return phones.length > 0 && phones.every(p => p.status === "wrong_number" || p.status === "no_response");
}

/** Marks the lead dead (and stops its follow-ups) once no number is left to try. */
export function markDeadIfExhausted(leadId) {
  if (!allPhonesExhausted(leadId)) return false;
  db.prepare(`UPDATE leads SET call_status = 'dead' WHERE id = ? AND shop_id = ? AND call_status NOT IN ('claimed', 'opted_out')`).run(leadId, INTEGRITY_SHOP);
  cancelAllJobsForLead(leadId);
  console.log(`[Fire] Lead ${leadId} — every number exhausted, marked dead`);
  return true;
}

/**
 * After a number turns out to be wrong, move the lead's "current" number onto one that might still work
 * (a number we've texted, else one we haven't tried yet).
 */
export function repointLeadPhone(leadId) {
  const phones = getPhones(leadId);
  const lead = db.prepare(`SELECT lead_phone FROM leads WHERE id = ?`).get(leadId);
  const current = phones.find(p => p.phone === lead?.lead_phone);
  if (current && current.status !== "wrong_number") return;
  const next = phones.find(p => p.status === "replied") || phones.find(p => p.status === "sent") || phones.find(p => p.status === "untried");
  if (next) db.prepare(`UPDATE leads SET lead_phone = ? WHERE id = ?`).run(next.phone, leadId);
}
