import express from "express";
import crypto from "node:crypto";
import { db } from "../db/connection.js";
import { SHOP_CONFIGS, getShopdeskIndustryLabel } from "../config/shops.js";
import { sendSMS, sendSMSWithPhoto, handleOwnerPingTag } from "../services/sms.js";
import { photoMap } from "../services/photo-map.js";
import { scheduleFollowUpJobs, scheduleColdNudgeJobs, cancelAllJobsForLead } from "../workers/follow-ups.js";
import { bookGoogleCalendarEvent, parseCentral } from "../services/calendar.js";
import { sendMetaDepositPurchase } from "../services/meta.js";
import { runSMSAgent } from "../agents/sms-agent.js";
import { SPLIT_TAG } from "../agents/prompts/index.js";
import { triggerRetellCall } from "./retell.js";
import { INTEGRITY_SHOP, buildOpener, detectInboundIntent, last10, normalizePhone } from "../services/fire-text.js";
import { markDeadIfExhausted, repointLeadPhone } from "../services/fire-leads.js";

const router = express.Router();

function mapLead(payload, fieldMapping) {
  // Prefer an explicit special sent in the payload (e.g. the booking page's
  // lead_special_override, mapped via fieldMapping.leadSpecial) over guessing
  // from the form name — it's exact instead of a substring match.
  let leadSpecial = fieldMapping.leadSpecial ? payload[fieldMapping.leadSpecial] : null;

  // Fire leads: never fall back to a tint special
  if (!leadSpecial && fieldMapping.leadSpecial === "incident_info") leadSpecial = "Fire incident";

  if (!leadSpecial) {
    leadSpecial = "Ceramic Special";
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

    // Book the calendar appointment now that payment is confirmed. Leads booked
    // through the AI-conversation flow already have booked_at set at this point
    // (they book before the deposit) — only book here if there's a pending
    // booking-page time still waiting on payment.
    let calendarFailed = false;
    if (!lead.booked_at && lead.pending_appointment_time) {
      try {
        await bookGoogleCalendarEvent({
          lead_name:    lead.lead_name,
          lead_phone:   lead.lead_phone,
          lead_vehicle: lead.lead_vehicle,
          lead_special: lead.lead_special,
          booked_at:    lead.pending_appointment_time,
        });
        db.prepare(`UPDATE leads SET booked_at = ? WHERE id = ?`)
          .run(lead.pending_appointment_time, lead.id);
        lead.booked_at = lead.pending_appointment_time; // so the message below picks it up
      } catch (err) {
        calendarFailed = true;
        console.error(`[Square Webhook] Calendar booking FAILED after payment for lead ${lead.id} (${lead.lead_name}):`, err.message);
        if (process.env.JAKE_PHONE) {
          await sendSMS(process.env.JAKE_PHONE, `⚠️ ${lead.lead_name} (${lead.lead_phone}) paid their $20 deposit but the calendar booking failed for ${lead.pending_appointment_time}. Add it manually — customer already paid.`);
        }
      }
    }

    // Mark deposit as paid
    db.prepare(`UPDATE leads SET deposit_paid = 1, call_status = 'confirmed' WHERE id = ?`)
      .run(lead.id);

    // Send confirmation via SMS — plain text, no links/attachments
    let confirmMsg;
    if (lead.booked_at && !calendarFailed) {
      const date = parseCentral(lead.booked_at);
      const friendlyTime = date.toLocaleString("en-US", {
        weekday: "long", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
      });
      confirmMsg = `Hey ${lead.lead_name}! Your deposit is confirmed and your appointment is locked in for ${friendlyTime}. See you at 33619 Falcon Spring Street, Hockley TX 77447!`;
    } else {
      confirmMsg = `Hey ${lead.lead_name}! Your deposit is confirmed — we'll text you shortly to lock in your appointment time. See you soon at Pure Vision Tints!`;
    }
    await sendSMS(lead.lead_phone, confirmMsg);

    db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
      .run(lead.id, 'outbound', confirmMsg);

    // Cancel any follow-up jobs since they're confirmed
    cancelAllJobsForLead(lead.id);

    // Tell Meta a real deposit was paid (booking-page leads only — they carry the ad click data).
    // Fire-and-forget: never let this delay or break the confirmation.
    if (lead.meta_source_url) {
      sendMetaDepositPurchase(lead).catch(e => console.error("[Meta CAPI] Unexpected:", e.message));
    }

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
    // First text goes out immediately — speed to lead
    const delay = 0;
    console.log(`[${shopId}] Sending first SMS to ${lead.leadName} now`);

    setTimeout(async () => {
            const openers = [
        `Hey ${lead.leadName}! Saw you inquired about tinting your ${lead.leadVehicle} — how can I help?`,
        `Hi ${lead.leadName}! You reached out about tinting your ${lead.leadVehicle} — what questions can I answer for you?`,
        `Hello ${lead.leadName}! Got your inquiry about your ${lead.leadVehicle} — are you still looking to get it tinted?`,
        `Hi ${lead.leadName}! Thanks for reaching out about your ${lead.leadVehicle} — what are you looking for?`,
        `Hey ${lead.leadName}, Saw your interest in tinting your ${lead.leadVehicle} — want me to walk you through our options?`,
        `Hi ${lead.leadName}, You inquired about tinting for your ${lead.leadVehicle} — happy to help! What are you looking for?`,
        `${lead.leadName}! Got your request about your ${lead.leadVehicle} — still thinking about getting it tinted?`,
        `${lead.leadName}! Thanks for your interest in tinting your ${lead.leadVehicle} — how can I help you out?`,
      ];
      let msg = shopId === INTEGRITY_SHOP
        ? buildOpener(lead.leadName, lead.leadVehicle)
        : openers[Math.floor(Math.random() * openers.length)];
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
            const delay = 0;
            setTimeout(async () => {
              const msg = `Hey ${leadData.name}! This is Jake with Pure Vision Tints. You reached out about tinting your ${leadData.vehicle || 'vehicle'} — were you still interested in getting that done?`;
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
          const delay = 0;
          console.log(`[ShopDesk Meta] Sending first SMS to ${shopdeskLeadData.name} now`);

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

  return `Hey ${firstName}! How can I show you how shopdesk AI can help your service business?`;
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

  // Fire leads track every number they could be reached on
  if (shopId === INTEGRITY_SHOP && normalizePhone(lead.leadPhone)) {
    db.prepare(`INSERT INTO lead_phones (lead_id, phone) VALUES (?, ?)`).run(leadId, normalizePhone(lead.leadPhone));
  }

  // If lead came from booking page, skip the opening message — they're already booking
    if (req.body.source === 'booking_page') {
    console.log(`[${shopId}] Lead from booking page — skipping opening message`);
    
    // Store a system note so this lead appears in the dashboard
    const apptDetails = req.body.appointment_time 
      ? `Requested: ${req.body.appointment_time}` 
      : 'Browsing available slots';
    
    db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
      .run(leadId, 'outbound', `[BOOKING PAGE] ${lead.leadName} started booking via website. Vehicle: ${lead.leadVehicle || 'N/A'}. Special: ${lead.leadSpecial || 'N/A'}. ${apptDetails}. Deposit: pending.`);
    
    return;
  }

  // First text goes out immediately — speed to lead
  const delay = 0;
  console.log(`[${shopId}] Sending first SMS to ${lead.leadName} now`);

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
    } else if (shopId === INTEGRITY_SHOP) {
      msg = buildOpener(lead.leadName, lead.leadVehicle);
    } else if (shopId === 'pro-auto-designs') {
      const veh = lead.leadVehicle && lead.leadVehicle !== 'your vehicle' ? `your ${lead.leadVehicle}` : 'your vehicle';
      const svc = {
        'Nano-Ceramic Tint':     'Nano-Ceramic window tint',
        'Nano-Carbon Tint':      'Nano-Carbon window tint',
        'Ceramic Coating':       'a ceramic coating',
        'Paintless Dent Repair': 'paintless dent repair',
      }[lead.leadSpecial];
      msg = svc
        ? `Hey ${lead.leadName}! Thanks for reaching out to Pro Auto Design — I see you're interested in ${svc} for ${veh}. Want me to get you a price?`
        : `Hey ${lead.leadName}! Thanks for reaching out to Pro Auto Design — what can we help you with today?`;
    }
    else {
      msg = `Hey ${lead.leadName}! This is Jake with Pure Vision Tints. You reached out about tinting your ${lead.leadVehicle} — were you still interested in getting that done?`;
    }

    const smsResult = await sendSMS(lead.leadPhone, msg);
    if (smsResult?.success !== false) {
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(leadId, 'outbound', msg);
      if (shopId === INTEGRITY_SHOP) {
        db.prepare(`UPDATE lead_phones SET status = 'sent' WHERE lead_id = ?`).run(leadId);
        db.prepare(`UPDATE leads SET call_status = 'sms_fallback' WHERE id = ?`).run(leadId);
      }

      // Only schedule follow-ups for real leads — not demo
      if (shopId !== 'shopdesk-demo') {
        scheduleFollowUpJobs(leadId, shopId);
      }

      console.log(`[${shopId}] First SMS sent to ${lead.leadName} — follow-ups scheduled`);
    }
  }, delay);
});

// ─── INBOUND: WHICH LEAD IS THIS REPLY FOR? ─────────────────────────────────
// The same phone number can belong to several leads (a tint lead from an earlier test, an
// Integrity lead with many numbers, ...). The reply belongs to the conversation we texted
// MOST RECENTLY — otherwise an old lead can swallow a reply meant for a newer one and the
// wrong shop's AI answers. Fire leads are also matched on any of their other numbers.
function findLeadForInbound(from) {
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
  for (const l of [...byLeadPhone, ...viaPhones]) candidates.set(l.id, l);
  if (candidates.size <= 1) return [...candidates.values()][0] ?? null;

  const lastOutbound = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM sms_messages WHERE lead_id = ? AND direction = 'outbound'`);
  return [...candidates.values()]
    .map(l => ({ l, out: lastOutbound.get(l.id).id }))
    .sort((a, b) => b.out - a.out || String(b.l.created_at).localeCompare(String(a.l.created_at)))[0].l;
}

// ─── INBOUND SMS WEBHOOK ──────────────────────────────────────────────────────
// Twilio posts application/x-www-form-urlencoded (From, Body, ...) signed with X-Twilio-Signature.

/** True when X-Twilio-Signature matches HMAC-SHA1(authToken, url + sorted form params). */
function isValidTwilioSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  if (!token || !signature) return false;

  // Twilio signs the exact public URL it called. Behind Railway's proxy that's https + the public host;
  // set TWILIO_WEBHOOK_BASE_URL (e.g. https://your-app.up.railway.app) if auto-detection ever disagrees.
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim();
  const base = (process.env.TWILIO_WEBHOOK_BASE_URL || `${proto}://${host}`).replace(/\/$/, '');
  const url = base + req.originalUrl;

  const params = req.body || {};
  const data = url + Object.keys(params).sort().map(k => k + [].concat(params[k]).join('')).join('');
  const expected = crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');

  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const seenMessageSids = new Set();

// Latest inbound text per lead. Each new text supersedes the reply still waiting to go out for the
// previous one, so the customer gets one answer that has seen everything they said.
const pendingReplies = new Map(); // leadId -> { gen, timer }

// People text in bursts ("lifetime warranty?" … "also where are you located?"). Wait this long after the
// latest text before spending an AI call, so one reply covers the whole burst. Each new text restarts it.
const REPLY_SETTLE_MS = Number(process.env.REPLY_SETTLE_MS) || 6000;
const MAX_TEXTS_PER_REPLY = 3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The AI separates texts with [SPLIT]; returns the individual texts (at most MAX_TEXTS_PER_REPLY). */
function splitReply(reply) {
  const parts = reply.split(SPLIT_TAG).map(p => p.trim()).filter(p => p.replace(/\[TRIGGER_OWNER_PING\]/g, '').trim());
  if (parts.length <= MAX_TEXTS_PER_REPLY) return parts;
  return [...parts.slice(0, MAX_TEXTS_PER_REPLY - 1), parts.slice(MAX_TEXTS_PER_REPLY - 1).join('\n\n')];
}

/** Verifies the Twilio signature, acknowledges with empty TwiML, then hands the text to the shared handler. */
async function handleTwilioRequest(req, res) {
  if (!isValidTwilioSignature(req)) {
    console.error('[SMS Inbound] Rejected Twilio request — bad or missing signature');
    return res.status(403).type('text/plain').send('Invalid signature');
  }
  // Empty TwiML: we reply later through the API, not in this response
  res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  // Twilio retries a webhook it thinks failed; the same MessageSid must never be handled twice
  const sid = req.body.MessageSid;
  if (sid) {
    if (seenMessageSids.has(sid)) {
      console.log(`[SMS Inbound] Duplicate delivery of ${sid} — ignoring`);
      return;
    }
    seenMessageSids.add(sid);
    if (seenMessageSids.size > 500) seenMessageSids.delete(seenMessageSids.values().next().value);
  }

  const from = req.body.From;
  // A photo with no caption (e.g. fire damage) shouldn't be silently dropped
  const content = (req.body.Body || '').trim() || (Number(req.body.NumMedia) > 0 ? '[Sent a photo or attachment]' : '');
  if (!from || !content) return;
  return handleInboundText({ from, content, contactName: null });
}

router.post('/webhook/sms/inbound', express.urlencoded({ extended: false }), handleTwilioRequest);

// Everything that happens once we know who texted and what they said (provider-agnostic).
async function handleInboundText({ from, content, contactName: providedName }) {
  try {
    console.log(`[SMS Inbound] From: ${from} — "${content}"`);

    let lead = findLeadForInbound(from);

    if (!lead) {
      console.log('[SMS] New inbound from unknown number:', from);

      // Auto-create a lead from the inbound text
      const contactName = providedName || 'there';
      const result = db.prepare(`
        INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special, call_status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('pure-vision-tints', contactName, from, 'your vehicle', 'Ceramic Special', 'pending');

      lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(result.lastInsertRowid);
      console.log(`[SMS] Auto-created lead ${lead.id} for ${contactName} (${from})`);
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

    const matchedPhone = db.prepare(`
      SELECT * FROM lead_phones
      WHERE lead_id = ? AND phone LIKE '%' || ? || '%'
      LIMIT 1
    `).get(lead.id, last10(from));
    const intent = lead.shop_id === INTEGRITY_SHOP ? detectInboundIntent(content) : null;

    // ── "Wrong number": that number is NOT the homeowner — it didn't "reply", try another ──
    if (intent === 'wrong_number') {
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead.id, 'inbound', content);
      if (matchedPhone) db.prepare('UPDATE lead_phones SET status = ? WHERE id = ?').run('wrong_number', matchedPhone.id);
      repointLeadPhone(lead.id);
      markDeadIfExhausted(lead.id);
      console.log(`[SMS] ${lead.lead_name} — wrong number (${from}), no reply sent`);
      return;
    }

    // ── Multi-number leads: this number works, so stop trying the others ──
    if (matchedPhone) {
      if (matchedPhone.status !== 'replied') {
        db.prepare('UPDATE lead_phones SET status = ? WHERE id = ?').run('replied', matchedPhone.id);
      }
      // Keep the conversation (and any follow-ups) on the number that answered
      db.prepare('UPDATE leads SET lead_phone = ? WHERE id = ?').run(matchedPhone.phone, lead.id);
      cancelAllJobsForLead(lead.id);
    }

    // ── Fire-damage homeowners: honor opt-outs immediately; "not interested" gets one kind reply ──
    if (intent === 'stop') {
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead.id, 'inbound', content);
      db.prepare(`UPDATE leads SET call_status = 'opted_out' WHERE id = ?`).run(lead.id);
      cancelAllJobsForLead(lead.id);
      console.log(`[SMS] ${lead.lead_name} opted out — no reply sent, lead closed`);
      return;
    }
    if (intent === 'not_interested') {
      // The AI answers kindly once below; marking the lead dead stops every follow-up
      db.prepare(`UPDATE leads SET call_status = 'dead' WHERE id = ?`).run(lead.id);
      cancelAllJobsForLead(lead.id);
      lead = { ...lead, call_status: 'dead' };
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

    // Baseline for the manual-text guard below: the newest outbound message that already
    // exists. Anything with a higher id was sent while this message was being handled
    // (e.g. a manual text from the dashboard), so the AI shouldn't talk over it.
    const lastOutboundId = db.prepare(`
      SELECT COALESCE(MAX(id), 0) AS id FROM sms_messages
      WHERE lead_id = ? AND direction = 'outbound'
    `).get(lead.id).id;

    // Store the inbound text right away so it's on the dashboard even if the AI call fails or is superseded,
    // and so a following message's history already includes it.
    db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
      .run(lead.id, 'inbound', content);

    // This message now owns the reply: cancel whatever was waiting on an earlier one.
    const prior = pendingReplies.get(lead.id);
    if (prior) clearTimeout(prior.timer);
    const gen = (prior?.gen || 0) + 1;
    const settleTimer = setTimeout(() => {
      respondToLead({ lead, from, lastOutboundId, gen })
        .catch(e => console.error('[SMS Reply] Error:', e.message));
    }, REPLY_SETTLE_MS);
    pendingReplies.set(lead.id, { gen, timer: settleTimer });

  } catch(e) {
    console.error('[SMS Inbound] Error:', e.message);
  }
}

/**
 * Writes and sends the AI's reply once the lead has stopped texting for a moment.
 * `gen` identifies which inbound text this reply belongs to; if a newer text arrives at any point
 * before the send, this reply is dropped and the newer one answers everything instead.
 */
async function respondToLead({ lead, from, lastOutboundId, gen }) {
  const isCurrent = () => pendingReplies.get(lead.id)?.gen === gen;

  const history = db.prepare(`
    SELECT * FROM sms_messages
    WHERE lead_id = ? ORDER BY created_at ASC, id ASC
  `).all(lead.id);

  const messages = history.map(m => ({
    role: m.direction === 'outbound' ? 'assistant' : 'user',
    content: m.body
  }));

  const reply = await runSMSAgent(messages, lead);
  if (!isCurrent()) {
    console.log(`[SMS] ${lead.lead_name} sent another message while this reply was being written — dropping it`);
    return;
  }
  if (!reply) {
    pendingReplies.delete(lead.id);
    return;
  }

  // Random typing delay 8-25 seconds
  const typingDelay = Math.floor(Math.random() * 17000) + 8000;
  console.log(`[SMS] Replying to ${lead.lead_name} in ${Math.round(typingDelay/1000)}s`);

  const timer = setTimeout(async () => {
    try {
      if (!isCurrent()) return;
      pendingReplies.delete(lead.id);

      // Skip if a human (or anything else) already texted this lead since their message arrived
      const alreadyReplied = db.prepare(`
        SELECT id FROM sms_messages
        WHERE lead_id = ? AND direction = 'outbound' AND id > ?
        LIMIT 1
      `).get(lead.id, lastOutboundId);

      if (alreadyReplied) {
        console.log(`[SMS] Something else was already sent to ${lead.lead_name} since this message arrived — skipping the AI reply`);
        return;
      }

      // Manual mode may have been switched on while the reply was waiting
      if (db.prepare(`SELECT manual_mode FROM leads WHERE id = ?`).get(lead.id)?.manual_mode === 1) {
        console.log(`[SMS] Manual mode turned on for ${lead.lead_name} — skipping the AI reply`);
        return;
      }

      await handleOwnerPingTag(reply, lead);

      // Send each text on its own, a beat apart, like a person typing
      const texts = splitReply(reply);
      let delivered = 0;
      for (let i = 0; i < texts.length; i++) {
        if (i > 0) await sleep(1500 + Math.random() * 2000);
        const text = texts[i];

        let photoSent = false;
        const photoMatches = text.match(/\[SEND_PHOTO: (\w+)\]/g) || [];
        for (const match of photoMatches) {
          const key = match.match(/\[SEND_PHOTO: (\w+)\]/)[1];
          if (photoMap[key]) {
            const photoResult = await sendSMSWithPhoto(from, '', photoMap[key]);
            if (photoResult?.success) photoSent = true;
          }
        }

        // Strip the tags for the SMS itself
        const cleanText = text
          .replace(/\[SEND_PHOTO: \w+\]/g, '')
          .replace(/\[TRIGGER_OWNER_PING\]/g, '')
          .trim();

        let ok = photoSent;
        if (cleanText) {
          const smsResult = await sendSMS(from, cleanText);
          ok = smsResult?.success !== false;
        }

        // Never record a message the customer didn't get
        if (!ok) {
          console.error(`[SMS] TEXT NOT DELIVERED to ${lead.lead_name} (${from}) — not saved. Check Twilio.`);
          break;
        }

        // Store the text WITH its photo tags so the dashboard can render them
        db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
          .run(lead.id, 'outbound', text);
        delivered++;
        console.log(`[SMS] Replied to ${lead.lead_name}: "${cleanText}"`);
      }

      if (!delivered) return;

      // Schedule cold nudge — but only if lead isn't already booked/confirmed
      if (lead.shop_id !== 'shopdesk-demo') {
        const freshLead = db.prepare(`SELECT call_status FROM leads WHERE id = ?`).get(lead.id);
        const skipStatuses = ['booked', 'confirmed', 'dead', 'opted_out', 'mia', 'claimed'];
        if (!skipStatuses.includes(freshLead?.call_status)) {
          scheduleColdNudgeJobs(lead.id, lead.shop_id);
        } else {
          console.log(`[SMS] Skipping cold nudge for ${lead.lead_name} — status is ${freshLead.call_status}`);
        }
      }
    } catch (e) {
      console.error('[SMS Reply] Error:', e.message);
    }
  }, typingDelay);
  pendingReplies.set(lead.id, { gen, timer });
}

// ─── ROUTE: TWILIO INBOUND SMS ───────────────────────────────────────────────
// Same handler as /webhook/sms/inbound — point Twilio's "A message comes in" webhook at either URL.
router.post('/webhook/twilio/inbound', express.urlencoded({ extended: false }), handleTwilioRequest);

export default router;
