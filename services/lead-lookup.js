import { db } from "../db/connection.js";
import { last10 } from "./fire-text.js";

// ─── INBOUND: WHICH LEAD IS THIS REPLY FOR? ─────────────────────────────────
// The same phone number can belong to several leads (a tint lead from an earlier test, an
// Integrity lead with many numbers, ...). The reply belongs to the conversation we texted
// MOST RECENTLY — otherwise an old lead can swallow a reply meant for a newer one and the
// wrong shop's AI answers. Fire leads are also matched on any of their other numbers.
export function findLeadForInbound(from, shopId = null) {
  const digits = last10(from);
  const byLeadPhone = db.prepare(`
    SELECT * FROM leads
    WHERE replace(replace(replace(lead_phone, '+', ''), '-', ''), ' ', '')
      LIKE '%' || replace(replace(replace(?, '+', ''), '-', ''), ' ', '') || '%'
    ORDER BY created_at DESC LIMIT 10
  `).all(from);
  const viaPhones = digits.length === 10
    ? db.prepare(`
        SELECT l.* FROM lead_phones p JOIN leads l ON l.id = p.lead_id
        WHERE p.phone LIKE '%' || ? || '%' LIMIT 10
      `).all(digits)
    : [];

  const candidates = new Map();
  for (const l of [...byLeadPhone, ...viaPhones]) if (!shopId || l.shop_id === shopId) candidates.set(l.id, l);
  if (candidates.size <= 1) return [...candidates.values()][0] ?? null;

  const lastOutbound = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM sms_messages WHERE lead_id = ? AND direction = 'outbound'`);
  return [...candidates.values()]
    .map(l => ({ l, out: lastOutbound.get(l.id).id }))
    .sort((a, b) => b.out - a.out || String(b.l.created_at).localeCompare(String(a.l.created_at)))[0].l;
}
