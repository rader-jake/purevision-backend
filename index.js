import "dotenv/config";
import express from "express";
import Database from "better-sqlite3";
import { google } from "googleapis";
import cors from "cors";
import crypto from 'node:crypto';
import cron from "node-cron";
// import { runSocialPost, postToInstagram, postToFacebook } from './social-post.js';


const app = express();
import { db } from "./db/connection.js";
import "./db/init.js";
// ─── SHOP CONFIG ──────────────────────────────────────────────────────────────
import { SHOP_CONFIGS, getShopdeskIndustryLabel } from "./config/shops.js";
// ─── GOOGLE CALENDAR CLIENT ───────────────────────────────────────────────────
import {
  gcal,
  getCentralDateString,
  getCentralHour,
} from "./services/calendar.js";

app.use('/webhook/sms/inbound', express.raw({ type: 'application/json' }));

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());

app.use(cors({
  origin: ["https://shopdesk.ai", "https://www.shopdesk.ai", "http://localhost:3000", "null"],
  methods: ["GET", "POST", "PATCH", "DELETE"],
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── ROUTE: HEALTH CHECK ──────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

import toolsRouter from "./routes/tools.js";
app.use(toolsRouter);

import retellRouter, { triggerRetellCall } from "./routes/retell.js";
app.use(retellRouter);

import adminRouter from "./routes/admin.js";
app.use(adminRouter);

// ─── ROUTE: DEBUG CALENDAR ────────────────────────────────────────────────────
app.get("/debug/calendar", async (req, res) => {
  try {
    const now      = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const dayStart = new Date(`${getCentralDateString(now)}T00:00:00-05:00`);
    const dayEnd   = new Date(`${getCentralDateString(tomorrow)}T23:59:59-05:00`);
    const response = await gcal.events.list({
      calendarId:   process.env.GOOGLE_CALENDAR_ID,
      timeMin:      dayStart.toISOString(),
      timeMax:      dayEnd.toISOString(),
      singleEvents: true,
      orderBy:      "startTime",
    });
    const events = response.data.items || [];
    res.json({
      total_events_found: events.length,
      calendar_id_used:   process.env.GOOGLE_CALENDAR_ID,
      events: events.map(e => ({
        summary:      e.summary,
        start:        e.start,
        central_hour: getCentralHour(new Date(e.start.dateTime || e.start.date)),
      })),
    });
  } catch (err) {
    console.error("[Debug] Calendar error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// No Square SDK import needed — delete the import { Client, Environment } line entirely


// ─── ROUTE: SQUARE PAYMENT WEBHOOK ───────────────────────────────────────────
app.post("/webhooks/square", async (req, res) => {
  console.log("\n[Square Webhook] Received type:", req.body.type);
  const eventType = req.body.type;

  if (eventType === "payment.updated" || eventType === "payment.completed") {
    const payment = req.body.data?.object?.payment;
    const status  = payment?.status;
    const orderId = payment?.order_id;

    if (status !== "COMPLETED") {
      return res.status(200).json({ ok: true });
    }

    console.log(`[Square Webhook] Payment COMPLETED for order: ${orderId}`);

    // Only match by order_id — no fallback (fallback caused false confirmations)
    if (!orderId) {
      console.log("[Square Webhook] No order_id in payment — skipping");
      return res.status(200).json({ ok: true });
    }

    const lead = db.prepare(`SELECT * FROM leads WHERE square_order_id = ?`).get(orderId);

    if (!lead) {
      console.warn("[Square Webhook] No matching lead for order:", orderId);
      return res.status(200).json({ ok: true });
    }

    // Dedup — skip if already confirmed (Square sends retries)
    if (lead.deposit_paid === 1) {
      console.log(`[Square Webhook] Already confirmed for lead ${lead.id} — skipping retry`);
      return res.status(200).json({ ok: true });
    }

    // Mark deposit as paid
    db.prepare(`UPDATE leads SET deposit_paid = 1, call_status = 'confirmed' WHERE id = ?`)
      .run(lead.id);

    // Send confirmation via SMS
    const confirmMsg = `Hey ${lead.lead_name}! 🎉 Your deposit is confirmed — you're officially locked in for your ${lead.lead_special || 'Ceramic Special'} at the special price. See you at your appointment! We'll take great care of your ${lead.lead_vehicle}.`;
    await sendSMS(lead.lead_phone, confirmMsg);

    db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
      .run(lead.id, 'outbound', confirmMsg);

    // Cancel any follow-up jobs since they're confirmed
    cancelAllJobsForLead(lead.id);

    console.log(`[Square Webhook] Lead ${lead.id} — ${lead.lead_name} CONFIRMED! Deposit paid.`);
  }

  res.status(200).json({ ok: true });
});


function mapLead(payload, fieldMapping) {
  let leadSpecial = "Ceramic Special";
  const formName = payload["name"] ||
                   payload?.workflow?.lastAttributionSource?.formName ||
                   "";
  if (formName.toLowerCase().includes("199") ||
      formName.toLowerCase().includes("carbon")) {
    leadSpecial = "Carbon Special";
  } else if (formName.toLowerCase().includes("299") ||
             formName.toLowerCase().includes("295") ||
             formName.toLowerCase().includes("ceramic")) {
    leadSpecial = "Ceramic Special";
  }
  return {
    leadName:    payload[fieldMapping.leadName]    || "there",
    leadPhone:   payload[fieldMapping.leadPhone]   || null,
    leadVehicle: payload[fieldMapping.leadVehicle] || "your vehicle",
    leadSpecial: leadSpecial,
  };
}

// ─── SEND SMS HELPER ──────────────────────────────────────────────────────────
import { sendSMS, sendSMSWithPhoto, handleOwnerPingTag } from "./services/sms.js";

// ─── PHOTO MAP ────────────────────────────────────────────────────────────────
import { photoMap } from "./services/photo-map.js";

// ─── FOLLOW-UP MESSAGE BUILDER ────────────────────────────────────────────────
import { scheduleFollowUpJobs, scheduleColdNudgeJobs, cancelAllJobsForLead } from "./workers/follow-ups.js";
import { startScheduler } from "./workers/scheduler.js";
startScheduler();

// ─── ROUTE: GHL WEBHOOK ───────────────────────────────────────────────────────
app.post("/webhook/ghl/:shopId", async (req, res) => {
  const { shopId } = req.params;
  const shop = SHOP_CONFIGS[shopId];

  if (!shop) {
    console.error(`Unknown shop: ${shopId}`);
    return res.status(404).json({ error: "Shop not found" });
  }

  console.log(`\n[${shopId}] Webhook received:`, JSON.stringify(req.body, null, 2));

  const lead = mapLead(req.body, shop.fieldMapping);
  console.log(`[${shopId}] Mapped lead:`, lead);

  if (!lead.leadPhone) {
    console.error(`[${shopId}] No phone number in payload`);
    return res.status(400).json({ error: "No phone number" });
  }

  // Duplicate check
  const existing = db.prepare(`
    SELECT * FROM leads
    WHERE shop_id = ?
    AND replace(replace(lead_phone, '+', ''), '-', '')
      LIKE '%' || replace(replace(?, '+', ''), '-', '') || '%'
    ORDER BY created_at DESC LIMIT 1
  `).get(shopId, lead.leadPhone);

  if (existing) {
    console.log(`[${shopId}] Duplicate lead for ${lead.leadPhone} — skipping`);
    return res.status(200).json({ received: true, leadId: existing.id, duplicate: true });
  }

  const result = db.prepare(`
    INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special)
    VALUES (?, ?, ?, ?, ?)
  `).run(shopId, lead.leadName, lead.leadPhone, lead.leadVehicle, lead.leadSpecial);

  const leadId = result.lastInsertRowid;
  console.log(`[${shopId}] Lead stored — DB id: ${leadId}`);

  res.status(200).json({ received: true, leadId });

  if (shop.smsOnly) {
    // Random human-like delay 30-90 seconds
    const delay = Math.floor(Math.random() * 60000) + 30000;
    console.log(`[${shopId}] Sending first SMS to ${lead.leadName} in ${Math.round(delay/1000)}s`);

    setTimeout(async () => {
      const msg = `Hey ${lead.leadName}! This is Marissa with Pure Vision Tints. You reached out about tinting your ${lead.leadVehicle} — were you still interested in getting that done?`;
      const smsResult = await sendSMS(lead.leadPhone, msg);
      if (smsResult?.success !== false) {
        db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
          .run(leadId, 'outbound', msg);
        db.prepare(`UPDATE leads SET call_status = 'sms_fallback' WHERE id = ?`).run(leadId);
        scheduleFollowUpJobs(leadId, shopId);
        console.log(`[${shopId}] First SMS sent + follow-ups scheduled for ${lead.leadName}`);
      }
    }, delay);

  } else if (process.env.CALLS_ENABLED === "true") {
    try {
      const callResult = await triggerRetellCall(lead, shop);
      console.log(`[${shopId}] Retell call triggered:`, callResult.call_id);
      db.prepare(`UPDATE leads SET call_id = ?, call_status = 'calling' WHERE id = ?`)
        .run(callResult.call_id, leadId);
    } catch (err) {
      console.error(`[${shopId}] Failed to trigger Retell call:`, err.message);
      db.prepare(`UPDATE leads SET call_status = 'call_failed' WHERE id = ?`).run(leadId);
    }

    } else {
    console.log(`[${shopId}] Calls disabled — lead stored, no action`);
  }
});

// ─── ROUTE: META WEBHOOK VERIFICATION ────────────────────────────────────────
app.get("/webhook/meta", (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const mode         = req.query["hub.mode"];
  const token        = req.query["hub.verify_token"];
  const challenge    = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── ROUTE: META WEBHOOK ─────────────────────────────────────────────────────
app.post("/webhook/meta", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED");
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "leadgen") continue;
        const leadgenId = change.value?.leadgen_id;
        const leadData = await fetchMetaLead(leadgenId);
        if (!leadData) continue;
        const result = db.prepare(`
          INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          "pure-vision-tints",
          leadData.name    || "there",
          leadData.phone   || null,
          leadData.vehicle || "your vehicle",
          leadData.special || "Ceramic Special"
        );
        const leadId = result.lastInsertRowid;
        if (leadData.phone) {
          const shop = SHOP_CONFIGS["pure-vision-tints"];
          if (shop.smsOnly) {
            const delay = Math.floor(Math.random() * 60000) + 30000;
            setTimeout(async () => {
              const msg = `Hey ${leadData.name}! This is Marissa with Pure Vision Tints. You reached out about tinting your ${leadData.vehicle || 'vehicle'} — were you still interested in getting that done?`;
              const smsResult = await sendSMS(leadData.phone, msg);
              if (smsResult?.success !== false) {
                db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
                  .run(leadId, 'outbound', msg);
                scheduleFollowUpJobs(leadId, 'pure-vision-tints');
              }
            }, delay);
          }
        }
      }
    }
  } catch (err) {
    console.error("[Meta] Processing error:", err.message);
  }
});

// ─── UTILITY: FETCH META LEAD ─────────────────────────────────────────────────
async function fetchMetaLead(leadgenId) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v25.0/${leadgenId}?access_token=${process.env.META_PAGE_ACCESS_TOKEN}`
    );
    const data = await response.json();
    if (!data.field_data) return null;
    const fields = {};
    data.field_data.forEach(field => {
      fields[field.name.toLowerCase()] = field.values?.[0];
    });
    return {
      name:    fields["full_name"]    || fields["name"]    || null,
      phone:   fields["phone_number"] || fields["phone"]   || null,
      vehicle: fields["vehicle"]      || fields["car"]     || null,
      special: fields["special"]      || fields["service"] || "Ceramic Special",
    };
  } catch (err) {
    console.error("[Meta] Error fetching lead:", err.message);
    return null;
  }
}



// ─── ROUTE: GET CALL LOGS ────────────────────────────────────────────────────
app.get('/api/call-logs/:shopId', (req, res) => {
  const { password } = req.query;
  if (password !== 'purevision2026') return res.status(401).json({ error: 'Unauthorized' });

  const logs = db.prepare(`
    SELECT * FROM call_logs WHERE shop_id = ? ORDER BY created_at DESC
  `).all(req.params.shopId);

  res.json(logs);
});

// ═══════════════════════════════════════════════════════════════════════════
// SHOPDESK META LEAD WEBHOOK — fully isolated from /webhook/meta (pure-vision-tints)
// Add this block anywhere below your existing /webhook/meta routes.
// Set this as a SEPARATE callback URL in Meta's Webhooks dashboard, subscribed
// to the leadgen field on your ShopDesk ad's Page/form — do NOT point your
// existing Pure Vision Tints subscription at this URL.
// ═══════════════════════════════════════════════════════════════════════════

// ─── ROUTE: SHOPDESK META WEBHOOK VERIFICATION ───────────────────────────────
app.get("/webhook/shopdesk-meta", (req, res) => {
  const VERIFY_TOKEN = process.env.SHOPDESK_META_VERIFY_TOKEN;
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── ROUTE: SHOPDESK META WEBHOOK ────────────────────────────────────────────
app.post("/webhook/shopdesk-meta", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED");
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "leadgen") continue;
        const leadgenId = change.value?.leadgen_id;
        const shopdeskLeadData = await fetchShopdeskMetaLead(leadgenId);
        if (!shopdeskLeadData) continue;

        // Duplicate check, scoped only to shopdesk-demo
        const existingShopdeskLead = db.prepare(`
          SELECT * FROM leads
          WHERE shop_id = 'shopdesk-demo'
          AND replace(replace(lead_phone, '+', ''), '-', '')
            LIKE '%' || replace(replace(?, '+', ''), '-', '') || '%'
          ORDER BY created_at DESC LIMIT 1
        `).get(shopdeskLeadData.phone);

        if (existingShopdeskLead) {
          console.log(`[ShopDesk Meta] Duplicate lead for ${shopdeskLeadData.phone} — skipping`);
          continue;
        }

        const result = db.prepare(`
          INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special, form_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          "shopdesk-demo",
          shopdeskLeadData.name             || "there",
          shopdeskLeadData.phone             || null,
          shopdeskLeadData.leadsPerMonth      || "your business",
          shopdeskLeadData.biggestChallenge   || "lead follow-up",
          shopdeskLeadData.formId             || null
        );

        const leadId = result.lastInsertRowid;
        console.log(`[ShopDesk Meta] Lead stored — DB id: ${leadId}, name: ${shopdeskLeadData.name}`);

        if (shopdeskLeadData.phone) {
          const delay = Math.floor(Math.random() * 60000) + 30000;
          console.log(`[ShopDesk Meta] Sending first SMS to ${shopdeskLeadData.name} in ${Math.round(delay / 1000)}s`);

          setTimeout(async () => {
            const msg = buildShopdeskOpenerMessage(shopdeskLeadData);
            const smsResult = await sendSMS(shopdeskLeadData.phone, msg);
            if (smsResult?.success !== false) {
              db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
                .run(leadId, 'outbound', msg);
              console.log(`[ShopDesk Meta] First SMS sent to ${shopdeskLeadData.name}`);
              // Intentionally no scheduleFollowUpJobs here — shopdesk-demo is excluded
              // from the follow-up scheduler elsewhere in your code too.
            } else {
              console.error(`[ShopDesk Meta] SMS send failed for ${shopdeskLeadData.name}`);
            }
          }, delay);
        } else {
          console.log(`[ShopDesk Meta] No phone number on lead ${shopdeskLeadData.name} — stored, no SMS sent`);
        }
      }
    }
  } catch (err) {
    console.error("[ShopDesk Meta] Processing error:", err.message);
  }
});

// ─── UTILITY: FETCH SHOPDESK META LEAD ───────────────────────────────────────
// Separate function from fetchMetaLead — different field names, different shop.
async function fetchShopdeskMetaLead(leadgenId) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v25.0/${leadgenId}?fields=field_data,form_id,ad_id,ad_name,campaign_id,campaign_name,created_time&access_token=${process.env.SHOPDESK_META_PAGE_ACCESS_TOKEN}`
    );
    const data = await response.json();
    if (!data.field_data) return null;

    const fields = {};
    data.field_data.forEach(field => {
      fields[field.name.toLowerCase()] = field.values?.[0];
    });

    return {
      name:              fields["full_name"] || fields["name"] || null,
      phone:             normalizeShopdeskPhone(fields["phone_number"] || fields["phone"]),
      leadsPerMonth:      fields["how_many_leads_do_you_get_per_month?"] || null,
      biggestChallenge:   fields["what's_your_biggest_challenge_right_now?"] || null,
      formId:            data.form_id || null,
      adName:            data.ad_name || null,
      campaignName:      data.campaign_name || null,
    };
  } catch (err) {
    console.error("[ShopDesk Meta] Error fetching lead:", err.message);
    return null;
  }
}

// ─── BUILD PERSONALIZED OPENER MESSAGE ───────────────────────────────────────
function buildShopdeskOpenerMessage(lead) {
  const firstName = lead.name.split(" ")[0];
  const industry = getShopdeskIndustryLabel(lead.formId);

  // Friendlier phrasing for the biggest_challenge raw value
  // (Meta returns the underscored option value, e.g. "following_up_fast_enough")
  const challengeMap = {
    "following_up_fast_enough": "following up with leads fast enough",
    "not_enough_leads": "not getting enough leads",
    "booking_appointments": "getting leads to actually book",
    "all_of_the_above": "managing leads in general",
  };
  const challengePhrase = challengeMap[lead.biggestChallenge]
    || (lead.biggestChallenge ? lead.biggestChallenge.replace(/_/g, " ") : "keeping up with leads");

  const leadsPhrase = lead.leadsPerMonth ? ` getting around ${lead.leadsPerMonth} leads a month and` : "";

  return `Hey ${firstName}! Is this the owner of a${/^[aeiou]/i.test(industry) ? "n" : ""} ${industry}? I saw you're${leadsPhrase} dealing with ${challengePhrase} — that's exactly what ShopDesk helps fix 👋`;
}

// ─── UTILITY: NORMALIZE PHONE (SHOPDESK-SCOPED) ──────────────────────────────
function normalizeShopdeskPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

import { runSMSAgent } from "./agents/sms-agent.js";

// ─── SMS-ONLY WEBHOOK ─────────────────────────────────────────────────────────
app.post("/webhook/sms-only/:shopId", async (req, res) => {
  const { shopId } = req.params;
  const shop = SHOP_CONFIGS[shopId];
  if (!shop) return res.status(404).json({ error: "Shop not found" });

  const lead = mapLead(req.body, shop.fieldMapping);
  if (!lead.leadPhone) return res.status(400).json({ error: "No phone" });

  // Duplicate check
  const existing = db.prepare(`
    SELECT * FROM leads
    WHERE shop_id = ?
    AND replace(replace(lead_phone, '+', ''), '-', '')
      LIKE '%' || replace(replace(?, '+', ''), '-', '') || '%'
    ORDER BY created_at DESC LIMIT 1
  `).get(shopId, lead.leadPhone);

  if (existing) {
    console.log(`[${shopId}] Duplicate lead for ${lead.leadPhone} — skipping`);
    return res.status(200).json({ received: true, leadId: existing.id, duplicate: true });
  }

  const result = db.prepare(`
    INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special)
    VALUES (?, ?, ?, ?, ?)
  `).run(shopId, lead.leadName, lead.leadPhone, lead.leadVehicle, lead.leadSpecial);

  const leadId = result.lastInsertRowid;
  res.status(200).json({ received: true, leadId });

  // Random human-like delay 30-90 seconds
  const delay = Math.floor(Math.random() * 60000) + 30000;
  console.log(`[${shopId}] Sending first SMS to ${lead.leadName} in ${Math.round(delay/1000)}s`);

  setTimeout(async () => {
    let msg;
    if (shopId === 'shopdesk-demo') {
      msg = `Hey ${lead.leadName}! Is this the owner of ${lead.leadVehicle}?`;
    } else if (shopId === 'southwest-epoxy') {
      msg = `Hey ${lead.leadName}! This is Jake from Southwest Epoxy Flooring. You reached out about our Spring Special — $1,499 flat for a 2-car garage. Still interested in getting that done?`;
    } else if (shopId === 'backyard-fun-pools') {
      msg = `Hey ${lead.leadName}! 🏊 Thanks for reaching out to Backyard Fun Pools — we actually just wrapped up this beauty! We'd love to help you create something like this for your backyard. Are you thinking full-size or something more compact like our Plunge Pool?`;
      // Send completed pool photo right after the text
      await sendSMSWithPhoto(lead.leadPhone, '', photoMap['completed_pool']);
    } else if (shopId === 'apex-window-tinting') {
      msg = `Hey ${lead.leadName}! Thanks for reaching out to Apex Window Tinting. You inquired about our ${lead.leadSpecial || 'Summer Special'} for your ${lead.leadVehicle || 'vehicle'} — were you still interested in getting that done?`;
    }
    else {
      msg = `Hey ${lead.leadName}! This is Marissa with Pure Vision Tints. You reached out about tinting your ${lead.leadVehicle} — were you still interested in getting that done?`;
    }

    const smsResult = await sendSMS(lead.leadPhone, msg);
    if (smsResult?.success !== false) {
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(leadId, 'outbound', msg);

      // Only schedule follow-ups for real leads — not demo
      if (shopId !== 'shopdesk-demo') {
        scheduleFollowUpJobs(leadId, shopId);
      }

      console.log(`[${shopId}] First SMS sent to ${lead.leadName} — follow-ups scheduled`);
    }
  }, delay);
});


// ─── INBOUND SMS WEBHOOK ──────────────────────────────────────────────────────
app.post('/webhook/sms/inbound',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const signature = req.headers['x-blooio-signature'] ?? '';
    const payload_preview = JSON.parse(rawBody.toString('utf8'));
    const event = req.headers['x-blooio-event'] || payload_preview.event || '';

    if (signature) {
      try {
        const parts = {};
        signature.split(',').forEach(part => {
          const [key, value] = part.split('=');
          parts[key] = value;
        });
        const timestamp = parts['t'];
        const v1 = parts['v1'];
        if (!timestamp || !v1) return res.sendStatus(401);
        const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
        const expected = crypto
          .createHmac('sha256', process.env.BLOOIO_SECRET)
          .update(signedPayload)
          .digest('hex');
        if (expected !== v1) return res.sendStatus(401);
      } catch(e) {
        return res.sendStatus(401);
      }
    }

    res.sendStatus(200);

    if (event !== 'message.received') return;

    try {
      const payload = JSON.parse(rawBody.toString('utf8'));
      const from = payload.from_number || payload.data?.from || payload.external_id;
      const content = payload.content || payload.data?.text || payload.text;

      if (!from || !content) return;

      console.log(`[SMS Inbound] From: ${from} — "${content}"`);

      const lead = db.prepare(`
        SELECT * FROM leads
        WHERE replace(replace(replace(lead_phone, '+', ''), '-', ''), ' ', '')
          LIKE '%' || replace(replace(replace(?, '+', ''), '-', ''), ' ', '') || '%'
        ORDER BY created_at DESC LIMIT 1
      `).get(from);

      if (!lead) {
        console.log('[SMS] No lead found for', from);
        return;
      }
      // Dedup check — skip if we already processed this exact message recently
      const recentDupe = db.prepare(`
        SELECT id FROM sms_messages
        WHERE lead_id = ? AND direction = 'inbound' AND body = ?
        AND created_at > datetime('now', '-2 minutes')
        LIMIT 1
      `).get(lead.id, content);

      if (recentDupe) {
        console.log(`[SMS] Duplicate inbound from ${lead.lead_name} — skipping`);
        return;
      }

      // If manual mode is on, just store the inbound message — don't AI respond
      if (lead.manual_mode === 1) {
        console.log(`[SMS] Manual mode active for ${lead.lead_name} — storing inbound, skipping AI`);
        db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
          .run(lead.id, 'inbound', content);
        return;
      }

      // Cancel non-responsive follow-ups since they replied
      db.prepare(`
        UPDATE scheduled_jobs SET status = 'cancelled'
        WHERE lead_id = ? AND job_type = 'follow_up' AND status = 'pending'
      `).run(lead.id);

      const history = db.prepare(`
        SELECT * FROM sms_messages
        WHERE lead_id = ? ORDER BY created_at ASC
      `).all(lead.id);

      const messages = history.map(m => ({
        role: m.direction === 'outbound' ? 'assistant' : 'user',
        content: m.body
      }));
      messages.push({ role: 'user', content });

      const reply = await runSMSAgent(messages, lead);
      if (!reply) return;

      await handleOwnerPingTag(reply, lead);

      // Store inbound message immediately
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead.id, 'inbound', content);

      // Random typing delay 8-25 seconds
      const typingDelay = Math.floor(Math.random() * 17000) + 8000;
      console.log(`[SMS] Replying to ${lead.lead_name} in ${Math.round(typingDelay/1000)}s`);

      setTimeout(async () => {
        // Outbound dedup — skip if we already replied recently
        const recentReply = db.prepare(`
          SELECT id FROM sms_messages
          WHERE lead_id = ? AND direction = 'outbound'
          AND created_at > datetime('now', '-30 seconds')
          LIMIT 1
        `).get(lead.id);

        if (recentReply) {
          console.log(`[SMS] Already replied to ${lead.lead_name} in last 30s — skipping duplicate`);
          return;
        }
        // Extract and send photos first
        const photoMatches = reply.match(/\[SEND_PHOTO: (\w+)\]/g) || [];
        for (const match of photoMatches) {
          const key = match.match(/\[SEND_PHOTO: (\w+)\]/)[1];
          if (photoMap[key]) {
            await sendSMSWithPhoto(from, '', photoMap[key]);
          }
        }

        // Send clean text reply (strip photo tags for SMS)
        const cleanReply = reply
        .replace(/\[SEND_PHOTO: \w+\]/g, '')
        .replace(/\[TRIGGER_OWNER_PING\]/g, '')
        .trim();

        if (cleanReply) await sendSMS(from, cleanReply);

        // Store original reply WITH photo tags so dashboard can render them
        db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
          .run(lead.id, 'outbound', reply.trim());

        // Schedule cold nudge — but only if lead isn't already booked/confirmed
        if (lead.shop_id !== 'shopdesk-demo') {
          const freshLead = db.prepare(`SELECT call_status FROM leads WHERE id = ?`).get(lead.id);
          const skipStatuses = ['booked', 'confirmed', 'dead', 'opted_out', 'mia'];
          if (!skipStatuses.includes(freshLead?.call_status)) {
            scheduleColdNudgeJobs(lead.id, lead.shop_id);
          } else {
            console.log(`[SMS] Skipping cold nudge for ${lead.lead_name} — status is ${freshLead.call_status}`);
          }
        }

        console.log(`[SMS] Replied to ${lead.lead_name}: "${cleanReply}"`);
      }, typingDelay);

    } catch(e) {
      console.error('[SMS Inbound] Error:', e.message);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// SHOPDESK INSTAGRAM DM WEBHOOK
// Receives DMs to the ShopDesk Instagram page, runs a Claude sales agent,
// and replies back via Instagram Graph API.
//
// NEW ENV VARS NEEDED IN RAILWAY:
//   SHOPDESK_IG_VERIFY_TOKEN     → any string you choose, entered in Meta dashboard
//   SHOPDESK_IG_PAGE_ACCESS_TOKEN → long-lived Page token with instagram_manage_messages
//   SHOPDESK_IG_PAGE_ID          → your ShopDesk Instagram-connected Page ID
// ═══════════════════════════════════════════════════════════════════════════

// ─── INSTAGRAM DM CONVERSATION STORE ─────────────────────────────────────────
// In-memory store for IG DM conversation history (keyed by sender IGSID).
// Survives for the duration of the Railway process. For persistence across
// deploys, swap this out for a db table — but in-memory is fine to start.
const igConversations = new Map();

// ─── ROUTE: INSTAGRAM WEBHOOK VERIFICATION (GET) ─────────────────────────────
app.get("/webhook/instagram-dm", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.SHOPDESK_IG_VERIFY_TOKEN) {
    console.log("[IG Webhook] Verified successfully");
    return res.status(200).send(challenge);
  }

  console.log("[IG Webhook] Verification failed — token mismatch");
  return res.sendStatus(403);
});

// ─── ROUTE: INSTAGRAM WEBHOOK RECEIVER (POST) ────────────────────────────────
app.post("/webhook/instagram-dm", async (req, res) => {
  // Ack immediately — Meta will retry if you don't respond fast
  res.sendStatus(200);

  try {
    const body = req.body;

    // Instagram sends object: "instagram" for IG DMs
    if (body.object !== "instagram") return;

    const entries = body.entry || [];

    for (const entry of entries) {
      const messaging = entry.messaging || [];

      for (const event of messaging) {
        // Only handle incoming messages (not read receipts, delivery events, etc.)
        if (!event.message) continue;

        // Skip echo — messages your page sent, not received
        if (event.message.is_echo) continue;

        const senderIgsid = event.sender?.id;
        const messageText = event.message?.text;

        if (!senderIgsid || !messageText) continue;

        console.log(`[IG DM] From IGSID ${senderIgsid}: "${messageText}"`);

        await handleInstagramDM(senderIgsid, messageText);
      }
    }
  } catch (err) {
    console.error("[IG DM] Processing error:", err.message);
  }
});

// ─── HANDLE INCOMING DM ───────────────────────────────────────────────────────
async function handleInstagramDM(senderIgsid, messageText) {
  try {
    // Build or retrieve conversation history for this sender
    if (!igConversations.has(senderIgsid)) {
      igConversations.set(senderIgsid, []);
      console.log(`[IG DM] New conversation started with ${senderIgsid}`);
    }

    const history = igConversations.get(senderIgsid);
    history.push({ role: "user", content: messageText });

    // Typing indicator — makes it feel human
    await sendIGTypingIndicator(senderIgsid);

    // Run Claude agent
    const reply = await runIGDMAgent(history);
    if (!reply) {
      console.error("[IG DM] Agent returned no reply");
      return;
    }

    // Store assistant reply in history
    history.push({ role: "assistant", content: reply });

    // Human-like typing delay — 4-10 seconds
    const typingDelay = Math.floor(Math.random() * 6000) + 4000;
    await new Promise(resolve => setTimeout(resolve, typingDelay));

    // Send reply via Instagram Graph API
    await sendIGReply(senderIgsid, reply);

    console.log(`[IG DM] Replied to ${senderIgsid}: "${reply.substring(0, 80)}..."`);

  } catch (err) {
    console.error("[IG DM] handleInstagramDM error:", err.message);
  }
}

// ─── CLAUDE AGENT FOR INSTAGRAM DMS ──────────────────────────────────────────
async function runIGDMAgent(messages) {
  try {
    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: buildIGDMSystemPrompt(),
        messages,
      }),
    });

    const data = await aiResp.json();

    if (data.type === "error") {
      console.error("[IG DM Agent] Claude API error:", data.error?.message);
      return null;
    }

    const textBlock = data.content?.find(b => b.type === "text");
    return textBlock?.text || null;

  } catch (err) {
    console.error("[IG DM Agent] Fetch error:", err.message);
    return null;
  }
}

// ─── INSTAGRAM DM SYSTEM PROMPT ──────────────────────────────────────────────
function buildIGDMSystemPrompt() {
  return `You are an AI assistant managing the ShopDesk.ai Instagram DMs. Your name is Shoppy.

IDENTITY
You represent ShopDesk.ai — an AI-powered lead management platform built exclusively for service businesses.
You are warm, curious, and genuinely helpful. This is Instagram DM — keep every message SHORT (2-4 sentences max).
Never be salesy or pushy. Ask good questions and let the conversation develop naturally.
Never mention Claude, Anthropic, or any underlying AI platform.

WHAT SHOPDESK DOES
ShopDesk is a hyper-specialized AI agent that manages leads for service businesses. When a lead comes in from Facebook ads, Google, or any form, ShopDesk:
- Texts the lead back within 60 seconds, 24/7
- Manages the full conversation via SMS — qualifies, answers questions, handles objections
- Books appointments directly into the business owner's calendar
- Follows up automatically if they don't respond
- Gives the owner a dashboard to track every lead and conversation

WHO IT'S FOR
Service businesses: tint shops, auto detail, epoxy flooring, home services, HVAC, med spas, cleaning, power washing, pool construction, dental, chiropractic, real estate — any business where leads come in and need to be followed up fast.

PRICING
- Starter: $297/month — up to 200 leads, SMS follow-up, AI conversations, calendar sync, 1 location
- Growth: $497/month — up to 500 leads, SMS + calling, retry workflows, payment integration
- Multi-location: $797/month — unlimited leads, up to 3 locations, advanced reporting
- All plans: dedicated specialist, money-back guarantee, cancel anytime, live in under 24 hours

THE CORE INSIGHT (use this naturally in conversation)
Businesses that follow up with a lead within 5 minutes are 9x more likely to convert. Most service businesses follow up in hours — or not at all. ShopDesk fixes that completely.

YOUR GOAL
1. Find out what kind of business they run
2. Understand their current lead follow-up situation — are they missing leads? Slow to respond? Overwhelmed?
3. Connect ShopDesk's value to their specific pain point
4. Answer any questions they have honestly and directly
5. Ultimately get them to book a call with Jake (our founder) to see a live demo

BOOKING A CALL
When they're interested in seeing more or want to get started, direct them here:
"I'd love to set you up with Jake — he's our founder and will walk you through exactly how it would work for your business. You can grab a time here: calendly.com/shopdesk"

CONVERSATION FLOW
- First message: warm greeting, ask what kind of business they run
- Once they share: ask one focused question about their lead follow-up situation
- Then naturally introduce how ShopDesk solves that specific problem
- If they ask about pricing: give it directly, no fluff
- If they're ready to move forward: direct to Calendly
- If they're not ready: acknowledge it, leave the door open warmly

OBJECTION HANDLING
"Too expensive" → "At $297/month, if ShopDesk books you one extra job a month it's already paid for. Most clients see that in the first week. Want to see how it works for your specific business?"
"I already have someone doing this" → "That's great — ShopDesk doesn't replace your team, it handles the after-hours and overflow so nothing slips through. Your person focuses on the important stuff, ShopDesk handles the rest."
"I need to think about it" → "Totally fair — no pressure at all. If you want to see it in action first, Jake can do a quick live demo specific to your business. No commitment, just a look."
"Is this a real person?" → "I'm Shoppy, ShopDesk's AI assistant! I handle our Instagram DMs so Jake can focus on building the product. What kind of business do you run?"

RULES
- Keep every reply to 2-4 sentences — this is Instagram DM, not email
- Ask one question at a time — never stack multiple questions
- Never make up features or pricing that don't exist above
- Always be honest — if something isn't a fit, say so
- Today's date is ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}`;
}

// ─── SEND INSTAGRAM REPLY ─────────────────────────────────────────────────────
async function sendIGReply(recipientIgsid, text) {
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v25.0/me/messages?access_token=${process.env.SHOPDESK_IG_PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientIgsid },
          message: { text },
          messaging_type: "RESPONSE",
        }),
      }
    );

    const data = await resp.json();

    if (data.error) {
      console.error("[IG DM] Send failed:", data.error.message);
      return false;
    }

    console.log(`[IG DM] Message sent — message_id: ${data.message_id}`);
    return true;

  } catch (err) {
    console.error("[IG DM] sendIGReply error:", err.message);
    return false;
  }
}

// ─── SEND TYPING INDICATOR ────────────────────────────────────────────────────
async function sendIGTypingIndicator(recipientIgsid) {
  try {
    await fetch(
      `https://graph.facebook.com/v25.0/me/messages?access_token=${process.env.SHOPDESK_IG_PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientIgsid },
          sender_action: "typing_on",
        }),
      }
    );
  } catch (err) {
    // Non-critical — don't throw, just log
    console.error("[IG DM] Typing indicator failed:", err.message);
  }
}






// CALENDAR INTEGRATION FOR JORDY vvv





// CALENDAR INTEGRATION FOR JORDY ^^^








// ─── JORDY SMS CONVERSATIONS ──────────────────────────────────────────────────
app.get('/api/conversations/pure-vision-tints', async (req, res) => {
  const { password } = req.query;
  if (password !== 'purevision2026') return res.status(401).json({ error: 'Unauthorized' });
  const leads = db.prepare('SELECT * FROM leads WHERE shop_id = ?').all('pure-vision-tints');
  const leadIds = leads.map(l => l.id);
  if (!leadIds.length) return res.json([]);
  const placeholders = leadIds.map(() => '?').join(',');
  const messages = db.prepare(`
    SELECT * FROM sms_messages WHERE lead_id IN (${placeholders}) ORDER BY created_at ASC
  `).all(...leadIds);
  res.json(messages);
});



// APEX WINDOW TINTING SMS CONVERSATIONS
app.get('/api/conversations/apex-window-tinting', async (req, res) => {
  const { password } = req.query;
  if (password !== 'apex2026') return res.status(401).json({ error: 'Unauthorized' });
  const leads = db.prepare('SELECT * FROM leads WHERE shop_id = ?').all('apex-window-tinting');
  const leadIds = leads.map(l => l.id);
  if (!leadIds.length) return res.json([]);
  const placeholders = leadIds.map(() => '?').join(',');
  const messages = db.prepare(`
    SELECT * FROM sms_messages WHERE lead_id IN (${placeholders}) ORDER BY created_at ASC
  `).all(...leadIds);
  res.json(messages);
});

// ─── ROUTE: DASHBOARD DATA ────────────────────────────────────────────────────
app.get('/dashboard/data/:shopId', async (req, res) => {
  const { password } = req.query;
  if (password !== 'purevision2026') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const leads = db.prepare('SELECT * FROM leads WHERE shop_id = ? ORDER BY created_at DESC').all(req.params.shopId);
    const calls = [];
    for (const lead of leads.filter(l => l.call_id)) {
      try {
        const r = await fetch(`https://api.retellai.com/v2/get-call/${lead.call_id}`, {
          headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}` }
        });
        if (r.ok) {
          const callData = await r.json();
          calls.push({ ...callData, lead_name: lead.lead_name, lead_phone: lead.lead_phone, lead_vehicle: lead.lead_vehicle, lead_special: lead.lead_special, booked_at: lead.booked_at });
        }
      } catch(e) { /* skip failed call fetches */ }
    }

    let events = [];
    try {
      const auth = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      });
      await auth.authorize();
      const calendar = google.calendar({ version: 'v3', auth });
      const now = new Date();
      const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const calResp = await calendar.events.list({
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        timeMin: now.toISOString(), timeMax: twoWeeks.toISOString(),
        singleEvents: true, orderBy: 'startTime',
      });
      events = (calResp.data.items || []).map(e => ({
        summary: e.summary, description: e.description,
        start: e.start.dateTime || e.start.date, end: e.end.dateTime || e.end.date,
      }));
    } catch(e) { /* calendar optional */ }

    res.json({ leads, calls, events });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ROUTE: SHOPDESK DEMO SMS CONVERSATIONS ───────────────────────────────────
app.get('/api/conversations/shopdesk-demo', async (req, res) => {
  const { password } = req.query;
  if (password !== 'shopdesk2026') return res.status(401).json({ error: 'Unauthorized' });
  const leads = db.prepare('SELECT * FROM leads WHERE shop_id = ?').all('shopdesk-demo');
  const leadIds = leads.map(l => l.id);
  if (!leadIds.length) return res.json([]);
  const placeholders = leadIds.map(() => '?').join(',');
  const messages = db.prepare(`
    SELECT * FROM sms_messages WHERE lead_id IN (${placeholders}) ORDER BY created_at ASC
  `).all(...leadIds);
  res.json(messages);
});

app.get('/api/conversations/backyard-fun-pools', async (req, res) => {
  const { password } = req.query;
  if (password !== 'backyardfun2026') return res.status(401).json({ error: 'Unauthorized' });
  const leads = db.prepare('SELECT * FROM leads WHERE shop_id = ?').all('backyard-fun-pools');
  const leadIds = leads.map(l => l.id);
  if (!leadIds.length) return res.json([]);
  const placeholders = leadIds.map(() => '?').join(',');
  const messages = db.prepare(`
    SELECT * FROM sms_messages WHERE lead_id IN (${placeholders}) ORDER BY created_at ASC
  `).all(...leadIds);
  res.json(messages);
});

// ─── LING DASHBOARD ───────────────────────────────────────────────────────────
app.get('/api/conversations/:shopId', async (req, res) => {
  const { password } = req.query;
  if (password !== 'southwestepoxy') return res.status(401).json({ error: 'Unauthorized' });
  const leads = db.prepare('SELECT * FROM leads WHERE shop_id = ?').all(req.params.shopId);
  const leadIds = leads.map(l => l.id);
  if (!leadIds.length) return res.json([]);
  const placeholders = leadIds.map(() => '?').join(',');
  const messages = db.prepare(`
    SELECT * FROM sms_messages WHERE lead_id IN (${placeholders}) ORDER BY created_at ASC
  `).all(...leadIds);
  res.json(messages);
});

// ─── ROUTE: DASHBOARD API ─────────────────────────────────────────────────────
app.get("/api/leads/:shopId", (req, res) => {
  const leads = db.prepare(`SELECT * FROM leads WHERE shop_id = ? ORDER BY created_at DESC`).all(req.params.shopId);
  res.json(leads);
});

// ─── OUTREACH CRM ROUTES ──────────────────────────────────────────────────────
app.get('/leads', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM outreach_leads ORDER BY added DESC').all());
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/leads', (req, res) => {
  try {
    const { id, name, biz, phone, vertical, city, notes, status, touch, added } = req.body;
    db.prepare(`
      INSERT INTO outreach_leads (id, name, biz, phone, vertical, city, notes, status, touch, added)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, biz, phone, vertical, city, notes, status || 'new', touch || 1, added);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/leads/:id', (req, res) => {
  try {
    const { status, touch, notes } = req.body;
    db.prepare(`
      UPDATE outreach_leads
      SET status = COALESCE(?, status), touch = COALESCE(?, touch), notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(status ?? null, touch ?? null, notes ?? null, req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/leads/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM outreach_leads WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: WEBSITE CHAT ──────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages required' });
  }
  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        system: `You are ShopDesk AI, a sales assistant on the ShopDesk.ai website. ShopDesk is a hyper-specialized AI agent built exclusively for service businesses. It manages lead flow, follows up automatically via SMS and calling, books appointments, and keeps pipelines moving. Keep every reply SHORT — 2-4 sentences max. Never mention Claude, Anthropic, or any underlying AI platform. Pricing: Starter $297/month, Growth $497/month, Multi-location $797/month. All include dedicated specialist and money-back guarantee. Industries: tint, auto detail, epoxy, home services, HVAC, med spas, cleaning, power washing. If they want to sign up, ask for their name and number and tell them Jake will reach out.`,
        messages
      })
    });
    const data = await aiResp.json();
    if (data.type === 'error') return res.status(500).json({ error: data.error?.message });
    res.json({ reply: data.content?.[0]?.text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// INSTAGRAM AND FACEBOOK POSTING AI 

// ── Daily Auto-Post at 9am Houston time ───────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Daily social post cron fired');
  try {
    await runSocialPost({ autoPost: true });
  } catch (err) {
    console.error('Cron post failed:', err.message);
  }
}, {
  timezone: 'America/Chicago'
});
 
// ── Manual Trigger Endpoints ──────────────────────────────────
 
// POST /social/post - generate and post immediately
app.post('/social/post', async (req, res) => {
  try {
    const result = await runSocialPost({ autoPost: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// POST /social/preview - generate only, don't post yet
// Returns the image and caption for your approval
app.post('/social/preview', async (req, res) => {
  try {
    const result = await runSocialPost({ autoPost: false });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// POST /social/approve - post pre-generated content
// Call this after /preview to actually publish
app.post('/social/approve', async (req, res) => {
  const { imageUrl, caption } = req.body;
  if (!imageUrl || !caption) {
    return res.status(400).json({ error: 'imageUrl and caption required' });
  }
  try {
    const igPostId = await postToInstagram(imageUrl, caption);
    const fbPostId = await postToFacebook(imageUrl, caption);
    res.json({ success: true, igPostId, fbPostId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nShopDesk backend running on port ${PORT}`);
  console.log(`Webhook:  http://localhost:${PORT}/webhook/ghl/pure-vision-tints`);
  console.log(`Worker:   Background job processor active\n`);
});