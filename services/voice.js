import twilio from "twilio";
import { db } from "../db/connection.js";
import { normalizePhone } from "./fire-text.js";

// Which cell rings for each shop's calls. Add a shop here (and its env var in Railway) to turn voice on for it.
const OWNERS = {
  "pure-vision-tints": () => ({ name: "Jordy", phone: process.env.JORDY_PHONE, business: "Pure Vision Tints" }),
  "shopdesk-demo": () => ({ name: "Jake", phone: process.env.JAKE_PHONE, business: "ShopDesk" }),
};

/** { name, phone (E.164), business } for a voice-enabled shop whose cell number is set, else null. */
export function voiceConfig(shopId) {
  const make = OWNERS[shopId];
  if (!make) return null;
  const cfg = make();
  const phone = normalizePhone(cfg.phone);
  return phone ? { ...cfg, phone } : null;
}

/** The shop whose owner takes calls to the main number when the caller isn't a known lead. */
export const DEFAULT_VOICE_SHOP = "pure-vision-tints";

let client;
export function twilioClient() {
  client ??= twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

/** Tests swap in a fake Twilio REST client so no real calls are placed. */
export function setTwilioClientForTests(fake) {
  client = fake;
}

/** The public https origin Twilio should call back (set TWILIO_WEBHOOK_BASE_URL if auto-detection ever disagrees). */
export function publicBase(req) {
  if (process.env.TWILIO_WEBHOOK_BASE_URL) return process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, "");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host).split(",")[0].trim();
  return `https://${host}`;
}

/** Adds a row to the call history the dashboard's Call History page shows. */
export function logCall({ leadId = null, shopId, name = null, phone = null, outcome, notes = "" }) {
  db.prepare(`
    INSERT INTO call_logs (lead_id, shop_id, lead_name, lead_phone, outcome, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(leadId, shopId, name, phone, outcome, notes);
}
