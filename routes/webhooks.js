import express from "express";
import crypto from "node:crypto";
import { db } from "../db/connection.js";
import { SHOP_CONFIGS, getShopdeskIndustryLabel } from "../config/shops.js";
import { sendSMS, sendSMSWithPhoto, handleOwnerPingTag } from "../services/sms.js";
import { photoMap } from "../services/photo-map.js";
import { scheduleFollowUpJobs, scheduleColdNudgeJobs, cancelAllJobsForLead } from "../workers/follow-ups.js";
import { runSMSAgent } from "../agents/sms-agent.js";
import { triggerRetellCall } from "./retell.js";

const router = express.Router();

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

// ─── ROUTE: SQUARE PAYMENT WEBHOOK ───────────────────────────────────────────
router.post("/webhooks/square", async (req, res) => {
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

// ─── ROUTE: GHL WEBHOOK ───────────────────────────────────────────────────────
router.post("/webhook/ghl/:shopId", async (req, res) => {
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
router.get("/webhook/meta", (req, res) => {
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
router.post("/webhook/meta", async (req, res) => {
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

// ═══════════════════════════════════════════════════════════════════════════
// SHOPDESK META LEAD WEBHOOK — fully isolated from /webhook/meta (pure-vision-tints)
// Add this block anywhere below your existing /webhook/meta routes.
// Set this as a SEPARATE callback URL in Meta's Webhooks dashboard, subscribed
// to the leadgen field on your ShopDesk ad's Page/form — do NOT point your
// existing Pure Vision Tints subscription at this URL.
// ═══════════════════════════════════════════════════════════════════════════

// ─── ROUTE: SHOPDESK META WEBHOOK VERIFICATION ───────────────────────────────
router.get("/webhook/shopdesk-meta", (req, res) => {
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
router.post("/webhook/shopdesk-meta", async (req, res) => {
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

// ─── SMS-ONLY WEBHOOK ─────────────────────────────────────────────────────────
router.post("/webhook/sms-only/:shopId", async (req, res) => {
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
router.post('/webhook/sms/inbound',
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

export default router;
