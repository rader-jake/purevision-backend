import express from "express";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import twilio from "twilio";
import { google } from "googleapis";
import cors from "cors";
import crypto from 'node:crypto';
import cron from "node-cron";
// import { runSocialPost, postToInstagram, postToFacebook } from './social-post.js';


dotenv.config();

const app = express();
const db = new Database(process.env.DB_PATH || "purevision.db");

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

// ─── SHOP CONFIG ──────────────────────────────────────────────────────────────
const SHOP_CONFIGS = {
  "pure-vision-tints": {
    shopId:        "pure-vision-tints",
    shopName:      "Pure Vision Tints",
    smsOnly:       true,
    webhookSecret: process.env.GHL_WEBHOOK_SECRET,
    retellAgentId: process.env.RETELL_AGENT_ID,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "Vehicle Information",
      leadSpecial: "lead_special_override",
    },
  },
  "southwest-epoxy": {
    shopId:     "southwest-epoxy",
    shopName:   "Southwest Epoxy",
    retellAgentId: null,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "project_type",
      leadSpecial: "lead_special_override",
    },
  },

  "backyard-fun-pools": {
    shopId:     "backyard-fun-pools",
    shopName:   "Backyard Fun Pools",
    smsOnly:    true,
    retellAgentId: null,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "interest",         // reuse field for "Pool + Spa", "Plunge Pool", etc.
      leadSpecial: "lead_special_override",
    },
  },

  "shopdesk-demo": {
    shopId:     "shopdesk-demo",
    shopName:   "ShopDesk AI",
    smsOnly:    true,
    retellAgentId: null,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "business_name",
      leadSpecial: "industry",
    },
  },
};

// ─── TWILIO CLIENT ────────────────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── GOOGLE CALENDAR CLIENT ───────────────────────────────────────────────────
const googleAuth = new google.auth.JWT({
  email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key:    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const gcal = google.calendar({ version: "v3", auth: googleAuth });

// ─── APPOINTMENT SLOTS ────────────────────────────────────────────────────────
const APPOINTMENT_SLOTS = [
  { label: "9AM",  hour: 9  },
  { label: "11AM", hour: 11 },
  { label: "1PM",  hour: 13 },
  { label: "3PM",  hour: 15 },
  { label: "5PM",  hour: 17 },
];

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function getCentralDateString(date) {
  return date.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function getCentralHour(date) {
  return parseInt(
    date.toLocaleString("en-US", {
      hour:     "numeric",
      hour12:   false,
      timeZone: "America/Chicago",
    })
  );
}

function isWithinSendingWindow() {
  const hour = getCentralHour(new Date());
  return hour >= 8 && hour < 20;
}

function minutesUntil8AM() {
  const now = new Date();
  const central = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const next8AM = new Date(central);
  next8AM.setHours(8, 0, 0, 0);
  if (central.getHours() >= 8 && central.getHours() < 20) return 0;
  if (central.getHours() >= 20) next8AM.setDate(next8AM.getDate() + 1);
  return Math.ceil((next8AM - central) / 60000);
}

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

async function bookGoogleCalendarEvent(lead) {
  const dateTimeStr = lead.booked_at.includes("T")
    ? lead.booked_at
    : lead.booked_at.replace(" ", "T") + ":00-05:00";

  const appointmentDate = new Date(dateTimeStr);

  if (isNaN(appointmentDate.getTime())) {
    throw new Error(`Could not parse appointment time: ${lead.booked_at}`);
  }
  const name    = lead.lead_name    || lead.name    || "Customer";
  const vehicle = lead.lead_vehicle || lead.vehicle || "Vehicle";
  const special = lead.lead_special || lead.special || "Tint Special";
  const phone   = lead.lead_phone   || lead.phone   || "";

  const endDate = new Date(appointmentDate.getTime() + 2 * 60 * 60 * 1000);

  const event = await gcal.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary:     `Tint Appointment — ${name}`,
      description: `Vehicle: ${vehicle}\nSpecial: ${special}\nPhone: ${phone}`,
      start: { dateTime: appointmentDate.toISOString(), timeZone: "America/Chicago" },
      end:   { dateTime: endDate.toISOString(),         timeZone: "America/Chicago" },
    },
  });

  console.log(`[Calendar] Event created: ${event.data.htmlLink}`);
  return event.data;
}

// No Square SDK import needed — delete the import { Client, Environment } line entirely

// ─── ROUTE: SEND DEPOSIT LINK ────────────────────────────────────────────────
app.post("/tools/send-deposit", async (req, res) => {
  console.log("\n[Deposit Tool] Called with:", JSON.stringify(req.body, null, 2));

  const raw = req.body;
  const args = raw.args || raw;
  const { lead_name, lead_phone } = args;

  if (!lead_phone) {
    return res.json({
      response: "I wasn't able to send the deposit link. Can you confirm your phone number?",
      success: false,
    });
  }

  try {
    // 1. Create Square payment link via REST API (no SDK)
    const squareRes = await fetch(
      "https://connect.squareup.com/v2/online-checkout/payment-links",
      // "https://connect.squareupsandbox.com/v2/online-checkout/payment-links",
      {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          "Square-Version": "2024-01-18",
        },
        body: JSON.stringify({
          idempotency_key: `deposit-${lead_phone}-${Date.now()}`,
          order: {
            location_id: process.env.SQUARE_LOCATION_ID,
            line_items: [
              {
                name:     "Appointment Deposit — Pure Vision Tints",
                quantity: "1",
                base_price_money: {
                  amount:   2000, // $20.00 in cents
                  currency: "USD",
                },
              },
            ],
          },
        }),
      }
    );

    const squareData = await squareRes.json();
    console.log("[Deposit Tool] Square response:", JSON.stringify(squareData, null, 2));

    if (!squareRes.ok) {
      throw new Error(squareData.errors?.[0]?.detail || "Square API error");
    }

    const depositUrl = squareData.payment_link.url;
    const orderId = squareData.payment_link.order_id || null;

    console.log(`[Deposit Tool] Square link created: ${depositUrl}, orderId: ${orderId}`);

    // 2. Send deposit link via Blooio
    const msg = `Here's your $20 deposit link to lock in your spot and qualify for the special at Pure Vision Tints — it goes toward your final price: ${depositUrl}`;
    await sendSMS(lead_phone, msg);

    // 3. Update lead record with order ID for webhook matching
    const lead = db.prepare(`SELECT id FROM leads WHERE lead_phone = ? ORDER BY created_at DESC LIMIT 1`).get(lead_phone);
    if (lead) {
      db.prepare(`UPDATE leads SET deposit_sent = 1, square_order_id = ? WHERE id = ?`)
        .run(orderId, lead.id);
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead.id, 'outbound', msg);
    }

    return res.json({
      response: "I just sent the $20 deposit link to your phone! Once you complete it you're officially locked in at the special price. It only takes a minute 👍",
      deposit_url: depositUrl,
      success: true,
    });

  } catch (err) {
    console.error("[Deposit Tool] Error:", err.message);
    return res.json({
      response: "I just sent the deposit link to your phone — complete it within 24 hours to lock in your spot!",
      success: false,
    });
  }
});

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

    // Match by order_id first (most reliable)
    let lead = null;
    if (orderId) {
      lead = db.prepare(`SELECT * FROM leads WHERE square_order_id = ?`).get(orderId);
    }

    // Fallback: most recent lead with deposit sent but not paid
    if (!lead) {
      lead = db.prepare(`
        SELECT * FROM leads
        WHERE deposit_sent = 1 AND deposit_paid = 0
        ORDER BY created_at DESC LIMIT 1
      `).get();
    }

    if (!lead) {
      console.warn("[Square Webhook] No matching lead found");
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

// ─── ROUTE: CHECK DEPOSIT STATUS ─────────────────────────────────────────────
app.post("/tools/check-deposit-status", async (req, res) => {
  const raw = req.body;
  const args = raw.args || raw;
  const lead_phone = args.lead_phone;

  if (!lead_phone) {
    return res.json({
      status: "unknown",
      response: "No worries — just complete the deposit link I sent and you'll get an automatic confirmation!",
    });
  }

  const lead = db.prepare(`
    SELECT * FROM leads WHERE lead_phone = ? ORDER BY created_at DESC LIMIT 1
  `).get(lead_phone);

  if (!lead) {
    return res.json({ status: "unknown", response: "Complete the deposit link within 24 hours to lock in your spot!" });
  }

  if (lead.deposit_paid === 1) {
    return res.json({
      status: "paid",
      response: `Your deposit is confirmed! You're officially locked in for your appointment. We'll take great care of your ${lead.lead_vehicle} 🙌`,
    });
  }

  if (lead.deposit_sent === 1) {
    return res.json({
      status: "pending",
      response: "The deposit link was sent but hasn't been completed yet. No rush — you have 24 hours. Once paid you'll get an automatic confirmation 👍",
    });
  }

  return res.json({ status: "not_sent", response: "Let me send you the deposit link now!" });
});

// ─── ROUTE: BOOK APPOINTMENT DIRECTLY ────────────────────────────────────────
app.post("/tools/book-appointment", async (req, res) => {
  console.log("\n[Book Tool] Called with:", JSON.stringify(req.body, null, 2));

  const raw              = req.body;
  const args             = raw.args || raw;
  const lead_name        = args.lead_name;
  const lead_phone       = args.lead_phone;
  const lead_vehicle     = args.lead_vehicle;
  const lead_special     = args.lead_special;
  const appointment_time = args.appointment_time;

  if (!appointment_time) {
    return res.json({
      response: "I wasn't able to lock in that time. Can you confirm the day and time again?",
      success: false,
    });
  }

  try {
    db.prepare(`
      UPDATE leads
      SET booked_at = ?, call_status = 'booked'
      WHERE lead_phone = ?
    `).run(appointment_time, lead_phone);

    // Cancel any pending follow-up jobs for this lead
    const lead = db.prepare(`SELECT id FROM leads WHERE lead_phone = ?`).get(lead_phone);
    if (lead) {
      db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'`)
        .run(lead.id);
    }

    const leadObj = {
      lead_name:    lead_name    || "Customer",
      lead_phone:   lead_phone   || "",
      lead_vehicle: lead_vehicle || "your vehicle",
      lead_special: lead_special || "Ceramic Special",
      booked_at:    appointment_time,
    };

    await bookGoogleCalendarEvent(leadObj);

    const date = new Date(appointment_time.replace(" ", "T") + ":00-05:00");
    const friendlyTime = date.toLocaleString("en-US", {
      weekday: "long", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
    });
    return res.json({
      response: `You're officially locked in for ${friendlyTime}! We look forward to taking care of your ${lead_vehicle || "vehicle"}.`,
    });

  } catch (err) {
    console.error("[Book Tool] Error:", err.message);
    return res.json({
      response: `You're confirmed for ${appointment_time}. We look forward to seeing you!`,
      success: true,
    });
  }
});

async function triggerRetellCall(lead, shop) {
  const response = await fetch("https://api.retellai.com/v2/create-phone-call", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${process.env.RETELL_API_KEY}`,
    },
    body: JSON.stringify({
      from_number: process.env.TWILIO_PHONE_NUMBER,
      to_number:   lead.leadPhone,
      agent_id:    shop.retellAgentId,
      retell_llm_dynamic_variables: {
        lead_name:    lead.leadName,
        lead_vehicle: lead.leadVehicle,
        lead_special: lead.leadSpecial,
        shop_name:    shop.shopName,
        lead_phone:   lead.leadPhone,
        current_date: new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Chicago",
        }),
      },
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Retell API error: ${err}`);
  }
  return response.json();
}

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
async function sendSMS(to, message) {
  try {
    const encodedTo = encodeURIComponent(to);
    const resp = await fetch(`https://backend.blooio.com/v2/api/chats/${encodedTo}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BLOOIO_API_KEY}`
      },
      body: JSON.stringify({
        text: message,
        fromNumber: process.env.BLOOIO_NUMBER
      })
    });
    const data = await resp.json();
    console.log('[SMS] Sent via Blooio:', JSON.stringify(data));
    if (data.error || data.error_message) {
      console.error('[SMS] Blooio rejected:', data.error || data.error_message);
      return { success: false, error: data.error || data.error_message };
    }
    return { success: true, data };
  } catch(e) {
    console.error('[SMS] Failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function sendSMSWithPhoto(to, text, imageUrl) {
  try {
    const encodedTo = encodeURIComponent(to);
    const resp = await fetch(`https://backend.blooio.com/v2/api/chats/${encodedTo}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BLOOIO_API_KEY}`
      },
      body: JSON.stringify({
        text: text || '',
        fromNumber: process.env.BLOOIO_NUMBER,
        attachments: [imageUrl]
      })
    });
    const data = await resp.json();
    console.log('[SMS Photo] Sent:', JSON.stringify(data));
    return data;
  } catch(e) {
    console.error('[SMS Photo] Failed:', e.message);
  }
}

// ─── PHOTO MAP ────────────────────────────────────────────────────────────────
const photoMap = {
  'completed_garage':   'https://shopdesk.ai/epoxy/completed-garage-1.jpg',
  'completed_garage_2': 'https://shopdesk.ai/epoxy/completed-garage-2.jpg',
  'completed_garage_3': 'https://shopdesk.ai/epoxy/completed-garage-3.jpg',
  'color_chart':        'https://shopdesk.ai/epoxy/color-chart.jpg',
  'recent_job':         'https://shopdesk.ai/epoxy/completed-garage-1.jpg',
  // Pools
  'classic_layout':      'https://shopdesk.ai/pools/classic-layout.png',
  'cloud_layout':        'https://shopdesk.ai/pools/cloud-layout.png',
  'pool_color_chart':    'https://shopdesk.ai/pools/color-chart.png',
  'completed_pool':      'https://shopdesk.ai/pools/completed-pool.png',
  'cool_breeze_layout':  'https://shopdesk.ai/pools/cool-breeze-layout.png',
  'plunge_pool':         'https://shopdesk.ai/pools/plunge-pool.png',
  'roman_layout':        'https://shopdesk.ai/pools/roman-layout.png',
  'tuscany_layout':      'https://shopdesk.ai/pools/tuscany-layout.png',
  // Tints
  'ceramic_special_video': 'https://shopdesk.ai/tints/ceramic-special.gif',
  'shade_levels':        'https://shopdesk.ai/tints/shade-levels.png',
};

// ─── FOLLOW-UP MESSAGE BUILDER ────────────────────────────────────────────────
function buildFollowUpMessage(lead, jobType, attempt) {
  const name = lead.lead_name;
  const shopId = lead.shop_id;

  if (jobType === 'follow_up') {
    // Never replied at all
    if (shopId === 'pure-vision-tints') {
      const msgs = [
        `Hey ${name}! Marissa here from Pure Vision Tints — just checking if you're still thinking about tinting your ${lead.lead_vehicle}? We're currently running that Ceramic Special you asked about 👇\n[SEND_PHOTO: ceramic_special_video]`,
        `Hey ${name}, last follow-up from me — if the timing isn't right no worries at all. Reach back out whenever you're ready and we'll take care of you 🙏`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    } else if (shopId === 'southwest-epoxy') {
      const msgs = [
        `Hey ${name}! Jake from Southwest Epoxy — still interested in the Spring Special? $1,499 flat for a 2-car garage, we have openings this week 👋`,
        `Hey ${name}, just one last check-in — if the timing isn't right that's totally fine. Reach back out whenever you're ready 🙏`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    }
  } else if (jobType === 'cold_nudge') {
    // Was replying but went quiet
    if (shopId === 'pure-vision-tints') {
      const msgs = [
        `Hey ${name}! Just checking back in — still thinking about the tint? Happy to answer any questions 😊`,
        `Hey ${name}, no worries if the timing isn't right! Reach back out whenever you're ready 🙏`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    } else if (shopId === 'southwest-epoxy') {
      const msgs = [
        `Hey ${name}! Just checking back — still interested in the epoxy? Happy to lock in a time 😊`,
        `Hey ${name}, no pressure at all! Whenever you're ready just reach back out 🙏`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    }
  }

  return `Hey ${name}! Just checking back in — still interested? Happy to help whenever you're ready 🙏`;
}

// ─── SCHEDULE JOBS HELPER ─────────────────────────────────────────────────────
function scheduleFollowUpJobs(leadId, shopId) {
  // Non-responsive follow-ups: 24h and 72h after first message
  db.prepare(`
    INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
    VALUES (?, ?, 'follow_up', 1, datetime('now', '+24 hours'))
  `).run(leadId, shopId);

  db.prepare(`
    INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
    VALUES (?, ?, 'follow_up', 2, datetime('now', '+72 hours'))
  `).run(leadId, shopId);

  console.log(`[Jobs] Scheduled 2 follow-up jobs for lead ${leadId}`);
}

function scheduleColdNudgeJobs(leadId, shopId) {
  // Cancel any existing cold nudge jobs first to avoid stacking
  db.prepare(`
    UPDATE scheduled_jobs SET status = 'cancelled'
    WHERE lead_id = ? AND job_type = 'cold_nudge' AND status = 'pending'
  `).run(leadId);

  // Schedule fresh cold nudges: 24h and 48h from now
  db.prepare(`
    INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
    VALUES (?, ?, 'cold_nudge', 1, datetime('now', '+24 hours'))
  `).run(leadId, shopId);

  db.prepare(`
    INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
    VALUES (?, ?, 'cold_nudge', 2, datetime('now', '+48 hours'))
  `).run(leadId, shopId);

  console.log(`[Jobs] Scheduled 2 cold nudge jobs for lead ${leadId}`);
}

function cancelAllJobsForLead(leadId) {
  const result = db.prepare(`
    UPDATE scheduled_jobs SET status = 'cancelled'
    WHERE lead_id = ? AND status = 'pending'
  `).run(leadId);
  console.log(`[Jobs] Cancelled ${result.changes} pending jobs for lead ${leadId}`);
}

// ─── BACKGROUND JOB WORKER ───────────────────────────────────────────────────
async function processScheduledJobs() {
  const jobs = db.prepare(`
    SELECT * FROM scheduled_jobs
    WHERE status = 'pending'
    AND send_at <= datetime('now')
    ORDER BY send_at ASC
    LIMIT 10
  `).all();

  if (!jobs.length) return;

  console.log(`[Worker] Processing ${jobs.length} scheduled jobs`);

  for (const job of jobs) {
    try {
      // Mark as processing to prevent double-fire
      db.prepare(`UPDATE scheduled_jobs SET status = 'processing' WHERE id = ?`).run(job.id);

      const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(job.lead_id);

      if (!lead) {
        db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
        continue;
      }

      // Skip if lead is in a terminal state
      const skipStatuses = ['booked', 'dead', 'mia', 'opted_out'];
      if (skipStatuses.includes(lead.call_status)) {
        db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
        console.log(`[Worker] Skipping job ${job.id} — lead ${lead.lead_name} is ${lead.call_status}`);
        continue;
      }

      if (job.job_type === 'follow_up') {
        // Check if lead has ever replied
        const hasReplied = db.prepare(`
          SELECT id FROM sms_messages
          WHERE lead_id = ? AND direction = 'inbound' LIMIT 1
        `).get(job.lead_id);

        if (hasReplied) {
          db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
          console.log(`[Worker] Skipping follow_up for ${lead.lead_name} — they replied`);
          continue;
        }
      }

      if (job.job_type === 'cold_nudge') {
        // Check last inbound message — if they replied recently skip
        const lastInbound = db.prepare(`
          SELECT created_at FROM sms_messages
          WHERE lead_id = ? AND direction = 'inbound'
          ORDER BY created_at DESC LIMIT 1
        `).get(job.lead_id);

        if (lastInbound) {
          const hoursSince = (Date.now() - new Date(lastInbound.created_at)) / (1000 * 60 * 60);
          if (hoursSince < 20) {
            db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
            console.log(`[Worker] Skipping cold_nudge for ${lead.lead_name} — replied ${Math.round(hoursSince)}h ago`);
            continue;
          }
        } else {
          // No reply ever — this should be a follow_up not cold_nudge, cancel
          db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
          continue;
        }
      }

      // Check sending window — if outside, reschedule for 8AM
      if (!isWithinSendingWindow()) {
        const minsUntil8 = minutesUntil8AM();
        db.prepare(`
          UPDATE scheduled_jobs
          SET send_at = datetime('now', '+' || ? || ' minutes'), status = 'pending'
          WHERE id = ?
        `).run(minsUntil8, job.id);
        console.log(`[Worker] Job ${job.id} rescheduled for 8AM (${minsUntil8} mins)`);
        continue;
      }

      // Build and send the message
      const msg = buildFollowUpMessage(lead, job.job_type, job.attempt);
      const smsResult = await sendSMS(lead.lead_phone, msg);

      if (smsResult?.success !== false) {
        db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
          .run(lead.id, 'outbound', msg);
        db.prepare(`UPDATE scheduled_jobs SET status = 'sent' WHERE id = ?`).run(job.id);

        // Mark MIA after final attempt
        if (job.attempt >= 2) {
          db.prepare(`UPDATE leads SET call_status = 'mia' WHERE id = ?`).run(lead.id);
          console.log(`[Worker] Lead ${lead.lead_name} marked MIA after final ${job.job_type} attempt`);
        }

        console.log(`[Worker] Sent ${job.job_type} attempt ${job.attempt} to ${lead.lead_name}`);
      } else {
        db.prepare(`UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?`).run(job.id);
        console.error(`[Worker] SMS failed for job ${job.id}`);
      }

    } catch(e) {
      console.error(`[Worker] Error processing job ${job.id}:`, e.message);
      db.prepare(`UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?`).run(job.id);
    }
  }
}

// Run worker every 5 minutes
setInterval(processScheduledJobs, 5 * 60 * 1000);
console.log('[Worker] Background job processor started — runs every 5 minutes');

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

// ─── SMS TOOLS ────────────────────────────────────────────────────────────────
const smsTools = [
  {
    name: "get_availability",
    description: "Check available appointment slots for a given date",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" }
      },
      required: ["date"]
    }
  },
  {
    name: "book_appointment",
    description: "Book an appointment for the lead",
    input_schema: {
      type: "object",
      properties: {
        lead_name:        { type: "string" },
        lead_phone:       { type: "string" },
        lead_vehicle:     { type: "string" },
        lead_special:     { type: "string" },
        appointment_time: { type: "string", description: "Format: YYYY-MM-DD HH:mm" }
      },
      required: ["lead_name", "lead_phone", "lead_vehicle", "lead_special", "appointment_time"]
    }
  }
];

// ─── SMS SYSTEM PROMPT ────────────────────────────────────────────────────────
function buildSMSSystemPrompt(lead) {
  if (lead.shop_id === 'southwest-epoxy') {
    return `You are Jake, Southwest Epoxy Flooring's AI sales assistant texting with a lead.

    IDENTITY
    You are an AI texting on behalf of Southwest Epoxy Flooring Houston.
    You are warm, knowledgeable, and focused on booking a free estimate or closing the Spring Special.
    This is SMS — keep every message SHORT (1-3 sentences max).
    Never be pushy — be genuinely helpful and let the work sell itself.

    LEAD INFO
    - Name: ${lead.lead_name}
    - Project: ${lead.lead_vehicle || 'garage epoxy'}
    - Phone: ${lead.lead_phone}

    THE SPRING SPECIAL (PRIMARY OFFER)
    - 1-car garage: $1,000 flat (not advertised, only quote if they ask or have a smaller garage)
    - 2-car garage: $1,499 flat — this is our most popular package
    - 3-car garage: $1,800 flat
    - Includes: pigmented base coat, decorative flakes (customer picks color), clear topcoat
    - Professional prep and installation by Ling and his crew
    - Flake colors available — customer can choose their style
    - This is a limited spring promotion — creates natural urgency

    WHAT'S INCLUDED IN THE INSTALL (know this cold)
    The system has 4 layers:
    1. Concrete base (their existing floor)
    2. Pigmented basecoat — bonds to concrete
    3. Decorative flakes — customer picks color and style
    4. Clear topcoat — seals everything, makes it durable and glossy

    CONCRETE PREP — IMPORTANT KNOWLEDGE
    - New/clean concrete with no stains: no grinding needed, ready to coat
    - Older concrete with oil, paint, or stains: needs diamond grinding first
    - Grinding uses industrial diamond blades to remove contaminants so basecoat adheres properly
    - Residential garages rarely need heavy grinding unless heavily soiled
    - If grinding is needed: add approximately $1 per sq ft to the quote
    - Always honest — "We'll assess the floor when we come out for the free estimate"

    WHAT WE DO AND DON'T DO
    - We DO: garage floors, basement floors, cement floors, commercial floors, diamond grinding, flake systems
    - We DON'T do: concrete hardening or other specialty concrete work — we specialize in epoxy coating systems
    - When asked about process: "Yes we do diamond grinding and use industrial-grade materials — same process the other guys use, just better pricing and quality"

    PHOTO STRATEGY — THIS IS KEY
    When a lead first engages or asks about the work, send them a photo of a completed garage.
    When they ask about colors or flakes, send them the color chart photo.
    When they pick a color, send them a photo of a completed garage to show the quality and finish.
    Note: the photo may not be the exact color they chose — that's fine, it shows the quality of work
    and what the final result looks and feels like. Never claim the photo matches their color exactly.
    When they ask for references or proof of work, send multiple completed job photos:
    [SEND_PHOTO: completed_garage]
    [SEND_PHOTO: completed_garage_2]
    [SEND_PHOTO: completed_garage_3]
    Photos close deals — use them proactively.

    To send a photo use this exact format on a new line:
    [SEND_PHOTO: completed_garage]
    [SEND_PHOTO: color_chart]
    [SEND_PHOTO: recent_job]

    PRICING KNOWLEDGE
    2-car garage Spring Special: $1,499 flat
    3-car garage: $1,800 flat
    If grinding needed: add ~$1/sq ft
    Commercial: custom quote after estimate
    Never volunteer the cost breakdown — just quote the flat rate confidently

    CONVERSATION FLOW
    1. Open warm — reference the Spring Special they inquired about
    2. Send a completed garage photo immediately to show quality
    [SEND_PHOTO: completed_garage]
    3. Ask: "Do you have a 2-car or 3-car garage?"
    4. Quote the flat rate for their garage size confidently
    5. Ask about the floor condition — any oil, paint, or stains?
    6. If they ask about colors, send the color chart
    [SEND_PHOTO: color_chart]
    7. If they pick a color, send a completed job photo to show quality of finish
    [SEND_PHOTO: recent_job]
    8. Get their address for the free estimate
    9. Call get_epoxy_availability for their preferred day
    10. Book the estimate with book_estimate
    11. If they're not ready — acknowledge it warmly and note to follow up

    OBJECTION HANDLING
    "How much does it cost?" → "We're running our Spring Special right now — $1,499 flat for a 2-car garage, $1,800 for a 3-car. That includes everything — base coat, flakes, and topcoat. Want to see some of our recent work?"
    "Do you do diamond grinding?" → "Yes, we use diamond grinding and industrial-grade materials — same process as the other guys. Want me to send you some photos of our recent jobs and customer feedback?"
    "Do you do hardening or other concrete work?" → "We specialize in epoxy coating systems for garage and cement floors — that's our craft and we do it really well. Happy to show you our work!"
    "What if my floor has oil stains?" → "Great question — if there's oil or stains we'll do a prep grind to make sure the base coat adheres perfectly. We assess that when we come out for the free estimate, no surprises."
    "I just bought the house / not ready yet" → "Totally understand! No rush at all — the Spring Special runs through the season so whenever you're ready just reach back out and we'll take care of you 🙏"
    "Can I see your work / references?" → "Absolutely! Here's our website with more of our work: southwestepoxy.com — and here are some photos from recent jobs we did in Houston!" then send completed_garage photos
    "I want flakes" → "Great choice — flakes look amazing and are super durable. Here's our color chart, pick what catches your eye!" then send color chart photo
    "How long does it take?" → "Most 2-car garages are done in 1 day. We handle everything — you just come home to a brand new floor."
    "Is this a real person?" → "I'm Jake, Southwest Epoxy's AI assistant! I handle the initial scheduling so Ling and the crew can focus on doing great work. How can I help?"
    "I need to think about it" → "Of course! Just keep in mind the Spring Special pricing is limited. Want me to at least pencil in a free estimate — zero obligation, Ling just comes out and takes a look?"
    "I want to see more" → "Check out southwestepoxy.com for our full portfolio! Here are a few of our recent Houston garages 👆" then send photos

    FOLLOW-UP STRATEGY
    If a lead says they're not ready or need to think:
    - Acknowledge warmly, never pressure
    - Note their timeline if they mention one
    - End with an open door: "Just reach back out whenever you're ready — we'd love to take care of you 🙏"

    RULES
    - Always use the customer's first name
    - Keep replies to 1-3 sentences — this is SMS not email
    - Send photos proactively — they close deals
    - Never make up availability — always call get_epoxy_availability first
    - Never confirm a booking without calling book_estimate
    - Never mention Claude, Anthropic, or any AI platform
    - Never reveal cost breakdowns or profit margins
    - You CAN send photos — always use [SEND_PHOTO: key] tags, never tell the customer you cannot send photos
    - If they say STOP → "No problem! Feel free to reach out anytime 🙏" then stop
    - Our website: southwestepoxy.com — THIS IS THE ONLY CORRECT URL, never use any other domain
    - NEVER say southwestepoxyflooring.com or any variation — only southwestepoxy.com
    - Always mention the website when leads ask for references, more photos, or want to do research
    - Today's date is ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}`;
  }

  if (lead.shop_id === 'backyard-fun-pools') {
    return `You are the AI assistant for Backyard Fun Pools, a family-owned pool construction company in Katy, TX.
 
    IDENTITY
    You text on behalf of Backyard Fun Pools. You are warm, knowledgeable, and focused on getting the lead excited about their dream backyard and booking a free in-home consultation.
    This is SMS — keep every message SHORT (2-3 sentences max). Be conversational, not salesy.
    
    LEAD INFO
    - Name: ${lead.lead_name}
    - Interest: ${lead.lead_vehicle || 'Pool construction'}
    - Phone: ${lead.lead_phone}
    
    POOL LAYOUTS (know these cold)
    - Tuscany — most popular, great for families, classic shape with built-in bench
    - Classic — timeless rectangular design, clean lines
    - Cool Breeze — modern feel, our trending pick for compact yards
    - Cloud — freeform organic shape, very unique
    - Roman — most elegant, classic lines, timeless feel
    - Bahama — wide open design, perfect for entertaining, great tanning ledge

    PHOTO STRATEGY — THIS IS KEY
    Send photos to bring layouts to life. Use this exact format on a new line:
    [SEND_PHOTO: tuscany_layout]
    [SEND_PHOTO: classic_layout]
    [SEND_PHOTO: cloud_layout]
    [SEND_PHOTO: cool_breeze_layout]
    [SEND_PHOTO: roman_layout]
    [SEND_PHOTO: plunge_pool]
    [SEND_PHOTO: completed_pool]
    [SEND_PHOTO: pool_color_chart]

    WHEN TO SEND PHOTOS:
    - When you recommend a layout, send that layout's photo immediately
    - When they ask about colors/tiles, send the color chart
    - When they ask to see your work, send completed_pool
    - When discussing the plunge pool, send plunge_pool
    - Photos close deals — use them proactively, don't wait to be asked
    - Never tell the customer you can't send photos — you CAN and SHOULD
    
    PLUNGE POOL
    - 22' × 13' compact pool — our most popular option for smaller yards
    - Starting at $47,495
    - Perfect for relaxation, exercise, and small gatherings
    
    FULL-SIZE POOLS
    - Starting at $59,995 with spa included
    - Gunite construction, mini-pebble interior, Hayward equipment
    - Over 20 standard features included
    
    POPULAR WATERLINE TILE SELECTIONS
    - Blue Seas Royal Blue — deep lagoon look (most popular)
    - Islands Ocean Breeze — tropical vibe (trending right now)
    - Barclay Blue Gray — sophisticated modern look
    - Newstone Pietra Azul — gorgeous blue-gray
    - Newstone White Gray — clean contemporary feel
    - Veracruz Cream — warm and elegant
    
    IMPORTANT — DO NOT OVERWHELM
    Never list all 6 layouts or all tiles at once. Instead:
    - Recommend ONE layout based on what they tell you ("Our most popular is the Tuscany" or "For a compact yard, the Cool Breeze is trending right now")
    - Mention ONE tile as the trending pick
    - Always say: "We bring physical samples of all colors and materials to your free in-home consultation so you can see and feel everything in person"
    
    OTHER SERVICES
    - Outdoor kitchens (fully custom — grill, countertops, fridge)
    - Patio covers (solid roof, pergolas, lattice)
    - Outdoor living spaces (fire pits, seating areas)
    - Hardscapes (stone patios, walkways, retaining walls)
    If they mention any of these, acknowledge and include in consultation scope
    
    COMPANY INFO
    - Family-owned, locally operated in Katy, TX
    - 25+ years of pool construction experience
    - Serving: Katy, West Houston, Cypress, Sugar Land, Fulshear, Richmond, Spring, Magnolia
    - 2-year general warranty, 3-year equipment warranty
    - Financing available
    - Free consultations — build time guaranteed
    - Website: backyardfunpools.com
    
    CONVERSATION FLOW
    1. The opening message already includes a completed pool photo — don't re-send it
    2. Based on their answer, recommend ONE popular/trending layout AND send its photo
    [SEND_PHOTO: tuscany_layout]
    3. If they're interested, mention the trending tile and send the color chart
    [SEND_PHOTO: pool_color_chart]
    4. ALWAYS mention "we bring physical samples to your free in-home consultation"
    5. Drive toward booking the free consultation
    6. If they're not ready — acknowledge warmly, mention financing, leave the door open
    
    OBJECTION HANDLING
    "How much?" → Give the starting price confidently. "Pools with spa start at $59,995, plunge pools at $47,495 — everything included. We also offer financing to make it work for any budget."
    "That's expensive" → "Totally understand — it's a big investment. That's why the consultation is free and no obligation. We come out, design something custom, and show you financing options. Most families are surprised how affordable the payments are."
    "I need to think about it" → "Of course! No rush at all. Whenever you're ready just text back and I'll get you on the calendar. We'd love to help you create something special 🙏"
    "How long does it take?" → "We guarantee our build time — most pools are completed in weeks, not months. We'll give you an exact timeline at your consultation."
    "Is this a real person?" → "I'm the AI assistant for Backyard Fun Pools! I handle initial inquiries so the team can focus on building amazing pools. How can I help you today?"
    "What about permits?" → "We handle everything — from design to permits to construction. You just enjoy the process and your new pool!"
    
    RULES
    - Always use the customer's first name
    - Keep replies to 2-3 sentences — this is SMS not email
    - Never list all layouts or tiles at once — recommend the popular/trending one
    - Never mention Claude, Anthropic, or any AI platform
    - If they say STOP → "No problem! Reach out anytime 🙏" then stop
    - Always drive toward the free in-home consultation
    - Always mention physical samples when discussing colors/materials
    - Today's date is ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}`;
  }

  if (lead.shop_id === 'shopdesk-demo') {
    return `You are Shoppy, an AI sales assistant for ShopDesk AI.
Your job is to demonstrate ShopDesk AI's capabilities to a potential client by having a real conversation with them over SMS — and in doing so, proving the product works.

LEAD INFO
- Name: ${lead.lead_name}
- Business: ${lead.lead_vehicle}
- Industry: ${lead.lead_special}
- Phone: ${lead.lead_phone}

YOUR GOAL
Have a natural, impressive conversation that makes them think:
"Wow, if this AI can sell me this well over text, imagine what it could do for my business."

CONVERSATION FLOW
1. Open with a warm, confident intro — confirm who you're talking to
2. Wait for their response before pitching anything
3. Once they engage, introduce yourself and ShopDesk naturally
4. Share one compelling statistic to anchor the value
5. Ask about their biggest pain point with leads or follow-up
6. Tailor the pitch to their specific industry
7. Close by offering a free pilot — no commitment

OPENING MESSAGE (send this first):
"Hey ${lead.lead_name}! Is this the owner of ${lead.lead_vehicle}? 👋"

AFTER THEY CONFIRM:
"My name is Shoppy — I'm an AI assistant built by ShopDesk AI. I'm actually reaching out to show you firsthand what we can do. Mind if I take 2 minutes of your time? I think this could be valuable for your business."

AFTER THEY AGREE:
"Quick stat that might surprise you — businesses that follow up with a lead within 5 minutes are 9x more likely to convert them. Most service businesses follow up in hours, if at all. ShopDesk makes sure every lead gets a response in under 60 seconds, 24/7.

Here's what I can do for ${lead.lead_vehicle}:
💬 Text your leads instantly the moment they come in
📅 Check your calendar and book appointments automatically
📸 Send photos of your work to close deals faster
🔁 Follow up automatically if they don't respond
📊 Give you a dashboard to track every lead and conversation

And you're literally experiencing it right now — I reached out, I'm having this conversation, and I could be doing this for every single lead that comes into your business while you're out on a job."

INDUSTRY-SPECIFIC ANGLES
Power washing: "For a power washing business, most of your leads come from Facebook or Google and they're shopping multiple companies at once. The first one to respond wins. ShopDesk makes sure that's always you."
Tinting: "Tint leads are impulse decisions — they see a special, they fill out a form, and if nobody texts them back within minutes they move on. ShopDesk fixes that."
Epoxy: "Epoxy leads need nurturing — they're not always ready to book immediately. ShopDesk follows up automatically over days so no lead goes cold."
HVAC / Home services: "Home service leads are high ticket and competitive. ShopDesk qualifies them, answers questions, and gets them on your calendar before your competitors even call back."
Med spa: "Aesthetic leads are sensitive — they want to feel heard and informed before booking. ShopDesk handles that conversation at scale so your staff can focus on clients already in the chair."
Default: "For any service business, the #1 reason leads don't convert is slow follow-up. ShopDesk solves that completely."

CLOSING
"The best part — we're running a founding client special right now. $297/month, locked in for life. You'd be one of our first clients so you get white-glove setup and direct access to our team.

Want me to set up a quick demo specific to ${lead.lead_vehicle}? I can show you exactly how it would look for your business."

IF THEY SAY YES:
"Perfect! Jake (our founder) will reach out to get you set up. What's the best way to connect — call, text, or email?"

IF THEY HAVE OBJECTIONS:
"Too expensive" → "At $297/month, if ShopDesk books you even one extra job a month it's already paid for itself. Most of our clients see that in the first week."
"I already have someone doing this" → "That's great — ShopDesk doesn't replace your team, it handles the after-hours and overflow so nothing slips through. Your person focuses on the important stuff, Shoppy handles the rest."
"I need to think about it" → "Totally fair. I'll follow up in a couple days — and if you want to see it in action for your specific business just say the word. No pressure at all 🙏"
"Not interested" → "No worries at all! If anything changes or you know another business owner who could use this, keep us in mind. Have a great day 🙏"

RULES
- Keep every message SHORT — 2-4 sentences max, this is SMS
- Be confident but never pushy — let the product speak for itself
- The fact that they're talking to an AI right now IS the demo — lean into it
- Never mention Claude, Anthropic, or any underlying AI platform
- Always use their first name
- Today's date is ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}`;
  }

  // Default — Pure Vision Tints
  return `You are Marissa, Pure Vision Tints' AI receptionist texting with a lead.

  IDENTITY
  You are an AI texting on behalf of Pure Vision Tints. Your name is Marissa.
  You are warm, efficient, and focused on getting the customer booked and locked in with a deposit.
  This is SMS — keep every message SHORT (1-3 sentences max).

  LEAD INFO
  - Name: ${lead.lead_name}
  - Vehicle: ${lead.lead_vehicle}
  - Special: ${lead.lead_special || 'Ceramic Special'}
  - Phone: ${lead.lead_phone}

  PRICING & SERVICES
  Carbon Special — $199: all side windows + rear windshield, GeoShield carbon film
  Ceramic Special — $395: all side windows + rear windshield + visor, Xpel XR Black ceramic, blocks 85% IR heat and 99% UV
  Tint Removal — included FREE with both specials
  Visor: $40 | 2 Carbon doors: $40 | 2 Ceramic doors: $80
  Carbon windshield: $125 | Ceramic windshield: $150
  Shades available: 5%, 15%, 20%, 30%, 50%, 70% — shade does NOT affect price
  Lifetime warranty on all work
  Deposit: $20 required to lock in your spot and qualify for the special — goes toward your final price

  THE SPECIAL — URGENCY IS KEY
  ${(() => {
    const now = new Date();
    const central = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const dayOfWeek = central.getDay(); // 0=Sun, 1=Mon...6=Sat
    if (dayOfWeek === 0) return '- The special runs through NEXT Sunday — creates a full week of urgency';
    return '- The special ends THIS Sunday — use this to create urgency naturally';
  })()}
  - Always frame the special as limited time: "We're running this special through Sunday"
  - If they hesitate: "The special ends Sunday but if you put down the deposit now you can schedule any day and still get the special price"
  - The deposit locks them into the special pricing even if they book weeks out
  - Never say the special is permanent or ongoing — it always ends Sunday

  SHADE KNOWLEDGE
  - We offer ALL shades from 5% (limo dark) to 70% (barely visible)
  - ANY shade the customer wants is fine — we do it all, no questions asked
  - Most popular: 15% and 20% — the sweet spot for Texas
  - If they're unsure, recommend 20%: "Most of our customers go 20%, perfect balance of privacy and visibility"
  - When they ask about shades → send the shade chart
  [SEND_PHOTO: shade_levels]

  TEXAS TINT LAW (know this but don't lecture)
  - Front side windows: legal limit is 25% — but we can do whatever shade you want
  - Rear side windows and back windshield: any darkness is legal, go as dark as you want
  - Full windshield tint: not legal in Texas — BUT we offer 70% ceramic on the windshield which is barely visible but blocks serious heat
  - Visor strip: legal as long as it doesn't go past the AS1 marking (about 5-6 inches from the top edge)
  - NEVER refuse a shade or try to talk someone out of going dark — just inform them of the law casually if they ask and say "most of our customers go [shade] and don't have any issues"
  - If they ask "is 5% legal?" → "Front windows the legal limit is 25%, but rear you can go as dark as you want. Most of our customers go 15-20% all around and don't have any problems. What shade are you feeling?"

  QUALITY & PROCESS
  - All film is precision cut with a machine plotter — not hand cut
  - Perfect fit every time, clean edges, no guesswork
  - Xpel XR Black ceramic — premium brand, blocks 85% infrared heat and 99% UV
  - GeoShield carbon — great quality at a lower price point
  - Jordy does all work himself — 5+ years experience, no handoffs

  SHOP DETAILS
  Location: Hockley TX, off 290 where it meets Highway 99, about 10 min from Cypress
  Address: 33619 Falcon Spring Street, Hockley TX 77447
  Owner: Jordy Chen — does all work himself
  Waiting room with WiFi, or drop off and pick up same day
  Mon-Sat by appointment

  PHOTO STRATEGY
  [SEND_PHOTO: shade_levels] — when they ask about shades/darkness/percentages
  [SEND_PHOTO: ceramic_special_video] — when discussing pricing or the special
  Never tell the customer you can't send photos — you CAN and SHOULD

  CONVERSATION FLOW
  1. Confirm they're still interested in tinting their ${lead.lead_vehicle}
  2. Ask what shade they're thinking — if unsure, send the shade chart and recommend 20%
  [SEND_PHOTO: shade_levels]
  3. Ask if there is existing tint — removal is FREE with the special
  4. Confirm their special and total price
  5. Mention the special ends Sunday to create urgency
  6. BE PROACTIVE WITH SCHEDULING — don't ask "what day works?" Instead, call get_availability for the next 1-2 days and OFFER a specific slot:
    "We have a 9AM and 1PM open this Thursday — which one works better for you?"
    This reduces decision fatigue and makes it easy to say yes
  7. Call get_availability first, then offer the best slots
  8. When they pick a time: "Perfect — I have you down for [TIME] on [DAY] for your ${lead.lead_vehicle}, the ${lead.lead_special || 'Ceramic Special'} at [PRICE]."
  9. IMMEDIATELY mention the deposit: "We do require a small $20 deposit to lock in your spot and qualify for the special — it goes toward your final price. Can I send the deposit link here?"
  10. When they say yes → send the deposit link
  11. After deposit is confirmed → "You're all locked in! See you [DAY] at [TIME]. Jordy will take great care of your ${lead.lead_vehicle} 🙌"

  DEPOSIT FLOW — THIS IS CRITICAL
  - The deposit is $20 and goes toward the final price — it's not extra
  - Frame it as protecting THEIR spot: "Since the special ends Sunday, the deposit locks you in so you don't miss out"
  - If they push back on the deposit: "Totally understand — it's just $20 and it goes toward your total. It reserves your spot so nobody else takes it. We've had a lot of demand for the special this week!"
  - If they refuse the deposit entirely: book them anyway but mention "Just so you know, deposit customers get priority if the schedule fills up"
  - NEVER let the deposit be a dealbreaker — if they won't do it, still book them

  OBJECTION HANDLING
  "Too far" → "Totally understand! If you're ever in the area we'd love to take care of you 🙏"
  "Need to think" → "Of course! Just keep in mind the special ends Sunday. If you want to lock in the price, the $20 deposit holds your spot and you can schedule any day that works 👍"
  "How long?" → "About 1-2 hours depending on the vehicle. Drop off or hang out in our waiting room with WiFi!"
  "Carbon vs ceramic?" → "Ceramic is premium — Xpel XR Black blocks 85% of heat and 99% UV. In Texas heat most people go ceramic and love it!"
  "Is this a real person?" → "I'm Marissa, Pure Vision's AI receptionist! I handle scheduling so Jordy can focus on the work. How can I help?"
  "Already tinted" → "No worries! Removal is included free with both specials. We'll strip the old tint and put on fresh film."
  "What shade should I get?" → "Most of our customers go with 20% — great balance of privacy and visibility. Here's our shade chart 👇" then [SEND_PHOTO: shade_levels]
  "Is it hand cut?" → "Nope — we use a machine plotter for precision cuts. Perfect fit every time. Jordy's been doing this 5+ years."
  "Do you do windshields?" → "Yes! Carbon windshield is $125, ceramic is $150. We do a 70% ceramic which is barely visible but blocks serious heat — huge difference in Texas."
  "Is 5% legal?" → "Front windows the legal limit is 25%, but rear you can go as dark as you want. Most of our customers go 15-20% all around and don't have any issues. What shade are you thinking?"
  "Why do I need a deposit?" → "It's just $20 and goes toward your total — it locks in your spot and qualifies you for the special pricing. We've had a lot of demand so it makes sure your time slot is reserved 👍"

  RULES
  - Always use the customer's first name
  - Never make up availability — always call get_availability first
  - Never confirm a booking without calling book_appointment
  - Never mention Claude, Anthropic, or any AI platform
  - Never refuse a shade or warn about legality — we do all shades, inform casually only if asked
  - Be PROACTIVE — offer specific dates/times instead of asking open-ended questions
  - Always mention the special ends Sunday to create urgency
  - Always push for the deposit after confirming the appointment
  - You CAN send photos — always use [SEND_PHOTO: key] tags
  - If they say STOP or not interested → "No problem! Feel free to reach out anytime 🙏" then stop
  - Keep every reply to 1-3 sentences — this is SMS not email
  - Today's date is ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}`;
}

// ─── SMS TOOL ─────────────────────────────────────────────────────────────────
function getSMSTools(lead) {
  if (lead.shop_id === 'southwest-epoxy') {
    return [
      {
        name: "get_epoxy_availability",
        description: "Check available estimate slots for a given date",
        input_schema: {
          type: "object",
          properties: {
            date: { type: "string", description: "Date in YYYY-MM-DD format" }
          },
          required: ["date"]
        }
      },
      {
        name: "book_estimate",
        description: "Book a free in-home estimate for the lead",
        input_schema: {
          type: "object",
          properties: {
            lead_name:        { type: "string" },
            lead_phone:       { type: "string" },
            lead_address:     { type: "string", description: "Full address where estimate will take place" },
            project_type:     { type: "string" },
            appointment_time: { type: "string", description: "Format: YYYY-MM-DD HH:mm" }
          },
          required: ["lead_name", "lead_phone", "lead_address", "appointment_time"]
        }
      }
    ];
  }
  if (lead.shop_id === 'backyard-fun-pools') {
    return []; // No calendar tools for demo — just conversation
  }

  if (lead.shop_id === 'shopdesk-demo') {
    return []; // No tools for demo agent
  }
    return [
      ...smsTools,
      {
        name: "send_deposit",
        description: "Send a $20 Square deposit link to the customer to lock in their appointment and qualify for the special",
        input_schema: {
          type: "object",
          properties: {
            lead_name:  { type: "string" },
            lead_phone: { type: "string" },
          },
          required: ["lead_name", "lead_phone"]
        }
      },
      {
        name: "check_deposit_status",
        description: "Check if the customer has completed their deposit payment",
        input_schema: {
          type: "object",
          properties: {
            lead_phone: { type: "string" },
          },
          required: ["lead_phone"]
        }
      }
    ];
}

// ─── SMS AGENT LOOP ───────────────────────────────────────────────────────────
function sanitizeMessages(messages) {
  const cleaned = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some(b => b.type === 'tool_use');
      if (hasToolUse) {
        const next = messages[i + 1];
        const nextHasToolResult = next?.role === 'user' &&
          Array.isArray(next?.content) &&
          next.content.some(b => b.type === 'tool_result');
        if (!nextHasToolResult) {
          console.log('[SMS Agent] Skipping orphaned tool_use block');
          i++;
          continue;
        }
      }
    }
    cleaned.push(msg);
  }
  return cleaned;
}

async function runSMSAgent(messages, lead) {
  let currentMessages = sanitizeMessages([...messages]);
  const tools = getSMSTools(lead);

  while (true) {
    const requestBody = {
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: buildSMSSystemPrompt(lead),
      messages: currentMessages
    };
    if (tools.length > 0) requestBody.tools = tools;

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    const aiData = await aiResp.json();
    console.log('[SMS Agent] Claude response:', JSON.stringify(aiData, null, 2));

    if (aiData.type === 'error') {
      console.error('[SMS Agent] Claude API error:', aiData.error?.message);
      return null;
    }

    const { content, stop_reason } = aiData;

    if (stop_reason === 'tool_use') {
      const endpointMap = {
        'get_availability':       'get-availability',
        'book_appointment':       'book-appointment',
        'get_epoxy_availability': 'get-epoxy-availability',
        'book_estimate':          'book-estimate',
        'send_deposit':           'send-deposit',
        'check_deposit_status':   'check-deposit-status',
      };

      // Handle ALL tool_use blocks in this response (Claude can return multiple)
      const toolUses = content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        let toolResult;
        try {
          const endpoint = endpointMap[toolUse.name];
          if (!endpoint) {
            toolResult = { error: `Unknown tool: ${toolUse.name}` };
          } else {
            const toolResp = await fetch(
              `https://purevision-backend-production.up.railway.app/tools/${endpoint}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(toolUse.input)
              }
            );
            toolResult = await toolResp.json();
          }
        } catch(e) {
          toolResult = { error: 'Tool call failed: ' + e.message };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult)
        });
      }

      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content },
        { role: 'user', content: toolResults }
      ];
      continue;
    }

    const textBlock = content.find(b => b.type === 'text');
    return textBlock?.text || null;
  }
}

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
    } else {
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

      // Store inbound message immediately
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead.id, 'inbound', content);

      // Random typing delay 8-25 seconds
      const typingDelay = Math.floor(Math.random() * 17000) + 8000;
      console.log(`[SMS] Replying to ${lead.lead_name} in ${Math.round(typingDelay/1000)}s`);

      setTimeout(async () => {
        // Extract and send photos first
        const photoMatches = reply.match(/\[SEND_PHOTO: (\w+)\]/g) || [];
        for (const match of photoMatches) {
          const key = match.match(/\[SEND_PHOTO: (\w+)\]/)[1];
          if (photoMap[key]) {
            await sendSMSWithPhoto(from, '', photoMap[key]);
          }
        }

        // Send clean text reply (strip photo tags for SMS)
        const cleanReply = reply.replace(/\[SEND_PHOTO: \w+\]/g, '').trim();
        if (cleanReply) await sendSMS(from, cleanReply);

        // Store original reply WITH photo tags so dashboard can render them
        db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
          .run(lead.id, 'outbound', reply.trim());

        // Schedule cold nudge — if they go quiet we'll follow up
        if (lead.shop_id !== 'shopdesk-demo') {
          scheduleColdNudgeJobs(lead.id, lead.shop_id);
        }

        console.log(`[SMS] Replied to ${lead.lead_name}: "${cleanReply}"`);
      }, typingDelay);

    } catch(e) {
      console.error('[SMS Inbound] Error:', e.message);
    }
  }
);

// ─── ROUTE: RETELL CALL OUTCOME ───────────────────────────────────────────────
app.post("/webhook/retell/call-ended", async (req, res) => {
  const event   = req.body.event;
  const call    = req.body.call;
  const call_id = call?.call_id;
  const status  = call?.call_status;
  if (event !== "call_ended" && status !== "ended" && status !== "error" &&
      status !== "no_answer" && status !== "busy") {
    return res.status(200).json({ ok: true });
  }

  if (!call_id) return res.status(200).json({ ok: true });

  const lead = db.prepare(`SELECT * FROM leads WHERE call_id = ?`).get(call_id);
  if (!lead) return res.status(200).json({ ok: true });

  const statusMap = {
    ended:      "completed",
    error:      "call_failed",
    busy:       "no_answer",
    no_answer:  "no_answer",
    registered: "completed",
  };

  const newStatus = statusMap[status] || "completed";

  if (newStatus === 'no_answer' || newStatus === 'call_failed') {
    const attempts = (lead.call_attempts || 0) + 1;
    db.prepare(`UPDATE leads SET call_attempts = ?, call_status = ? WHERE id = ?`)
      .run(attempts, newStatus, lead.id);

    if (attempts === 1) {
      setTimeout(async () => {
        try {
          const shop = SHOP_CONFIGS[lead.shop_id];
          const callResult = await triggerRetellCall({
            leadName:    lead.lead_name,
            leadPhone:   lead.lead_phone,
            leadVehicle: lead.lead_vehicle,
            leadSpecial: lead.lead_special,
          }, shop);
          db.prepare(`UPDATE leads SET call_id = ?, call_status = 'calling' WHERE id = ?`)
            .run(callResult.call_id, lead.id);
        } catch(e) {
          console.error(`[Retry] Double dial failed:`, e.message);
        }
      }, 2 * 60 * 1000);
    } else if (attempts >= 2) {
      const msg = `Hey ${lead.lead_name}! This is Marissa from Pure Vision Tints. We tried reaching you about tinting your ${lead.lead_vehicle} but couldn't connect. Were you still interested?`;
      await sendSMS(lead.lead_phone, msg);
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead.id, 'outbound', msg);
      db.prepare(`UPDATE leads SET call_status = 'sms_fallback' WHERE id = ?`).run(lead.id);
      scheduleFollowUpJobs(lead.id, lead.shop_id);
    }
  } else {
    db.prepare(`UPDATE leads SET call_status = ? WHERE id = ?`).run(newStatus, lead.id);
    if (newStatus === 'completed' || newStatus === 'booked') {
      cancelAllJobsForLead(lead.id);
    }
  }

  return res.status(200).json({ ok: true });
});

// ─── ROUTE: GET AVAILABILITY ──────────────────────────────────────────────────
app.post("/tools/get-availability", async (req, res) => {
  const raw  = req.body;
  const args = raw.args || raw;
  const date = args.date;
  if (!date) {
    return res.json({
      response:        "We have 9AM, 12PM, and 3PM available tomorrow. Which works best for you?",
      available_slots: ["9AM", "12PM", "3PM"],
    });
  }
  try {
    const checkDate = new Date(date + "T12:00:00-05:00");
    const dateStr   = getCentralDateString(checkDate);
    const dayStart  = new Date(`${dateStr}T00:00:00-05:00`);
    const dayEnd    = new Date(`${dateStr}T23:59:59-05:00`);
    const response = await gcal.events.list({
      calendarId:   process.env.GOOGLE_CALENDAR_ID,
      timeMin:      dayStart.toISOString(),
      timeMax:      dayEnd.toISOString(),
      singleEvents: true,
      orderBy:      "startTime",
    });
    const existingEvents = response.data.items || [];
    const bookedHours = existingEvents.map(event => {
      const start = new Date(event.start.dateTime || event.start.date);
      return getCentralHour(start);
    });
    const availableSlots = APPOINTMENT_SLOTS.filter(slot => !bookedHours.includes(slot.hour));
    const friendlyDate = checkDate.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago",
    });
    if (availableSlots.length === 0) {
      return res.json({
        response:        `Unfortunately we're fully booked on ${friendlyDate}. Would you like me to check another day?`,
        available_slots: [],
        date:            dateStr,
        friendly_date:   friendlyDate,
      });
    }
    return res.json({
      response:        `We have ${availableSlots.map(s => s.label).join(", ")} available on ${friendlyDate}. Which works best for you?`,
      available_slots: availableSlots.map(s => s.label),
      date:            dateStr,
      friendly_date:   friendlyDate,
    });
  } catch (err) {
    console.error("[Availability Tool] Error:", err.message);
    return res.json({
      response:        "We have 9AM, 12PM, and 3PM available. Which works best for you?",
      available_slots: ["9AM", "12PM", "3PM"],
    });
  }
});

// ─── ROUTE: GET EPOXY AVAILABILITY ───────────────────────────────────────────
app.post('/tools/get-epoxy-availability', async (req, res) => {
  const raw  = req.body;
  const args = raw.args || raw;
  const date = args.date;

  if (!date) {
    return res.json({
      response:        'We have morning and afternoon slots available. What day works for you?',
      available_slots: ['9AM', '12PM', '3PM', '6PM']
    });
  }

  try {
    const checkDate = new Date(date + 'T12:00:00-05:00');
    const dateStr   = getCentralDateString(checkDate);
    const dayStart  = new Date(`${dateStr}T00:00:00-05:00`);
    const dayEnd    = new Date(`${dateStr}T23:59:59-05:00`);

    const response = await gcal.events.list({
      calendarId:   process.env.EPOXY_CALENDAR_ID,
      timeMin:      dayStart.toISOString(),
      timeMax:      dayEnd.toISOString(),
      singleEvents: true,
      orderBy:      'startTime',
    });

    const bookedHours = (response.data.items || []).map(e => {
      return getCentralHour(new Date(e.start.dateTime || e.start.date));
    });

    const ESTIMATE_SLOTS = [
      { label: '9AM',  hour: 9  },
      { label: '12PM', hour: 12 },
      { label: '3PM',  hour: 15 },
      { label: '6PM',  hour: 18 },
    ];

    const available = ESTIMATE_SLOTS.filter(s => !bookedHours.includes(s.hour));
    const friendlyDate = checkDate.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago'
    });

    if (!available.length) {
      return res.json({ response: `We're fully booked on ${friendlyDate}. Would another day work for you?`, available_slots: [] });
    }

    return res.json({
      response:        `We have ${available.map(s => s.label).join(', ')} available on ${friendlyDate}. Which works best for you?`,
      available_slots: available.map(s => s.label),
      date:            dateStr,
      friendly_date:   friendlyDate
    });
  } catch(e) {
    console.error('[Epoxy Availability] Error:', e.message);
    return res.json({
      response:        'We have 9AM, 12PM, 3PM, and 6PM available. Which works for you?',
      available_slots: ['9AM', '12PM', '3PM', '6PM']
    });
  }
});

// ─── ROUTE: BOOK EPOXY ESTIMATE ───────────────────────────────────────────────
app.post('/tools/book-estimate', async (req, res) => {
  const raw  = req.body;
  const args = raw.args || raw;
  const { lead_name, lead_phone, lead_address, project_type, appointment_time } = args;

  if (!appointment_time) {
    return res.json({ response: "I wasn't able to lock that in. Can you confirm the day and time again?", success: false });
  }

  try {
    const dateTimeStr = appointment_time.includes('T')
      ? appointment_time
      : appointment_time.replace(' ', 'T') + ':00-05:00';

    const appointmentDate = new Date(dateTimeStr);
    const endDate = new Date(appointmentDate.getTime() + 60 * 60 * 1000);

    await gcal.events.insert({
      calendarId: process.env.EPOXY_CALENDAR_ID,
      requestBody: {
        summary:     `Free Estimate — ${lead_name}`,
        description: `Project: ${project_type || 'Epoxy Flooring'}\nAddress: ${lead_address || 'TBD'}\nPhone: ${lead_phone}`,
        start: { dateTime: appointmentDate.toISOString(), timeZone: 'America/Chicago' },
        end:   { dateTime: endDate.toISOString(),         timeZone: 'America/Chicago' },
      }
    });

    const lead = db.prepare(`SELECT id FROM leads WHERE lead_phone = ?`).get(lead_phone);
    if (lead) {
      db.prepare(`UPDATE leads SET booked_at = ?, call_status = 'booked', lead_vehicle = ? WHERE id = ?`)
        .run(appointment_time, lead_address || 'Address TBD', lead.id);
      cancelAllJobsForLead(lead.id);
    }

    const friendlyTime = appointmentDate.toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago'
    });

    return res.json({
      response: `You're all set! Ling will come by ${lead_address} on ${friendlyTime} for your free estimate. See you then! 🙌`,
      success: true
    });
  } catch(e) {
    console.error('[Book Estimate] Error:', e.message);
    return res.json({
      response: `You're confirmed for ${appointment_time}. Ling will reach out to confirm the address. Looking forward to it!`,
      success: true
    });
  }
});

// ─── ROUTE: TRIGGER ALL PENDING LEADS ────────────────────────────────────────
app.post("/admin/trigger-pending", async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const pendingLeads = db.prepare(`
    SELECT * FROM leads
    WHERE call_status = 'pending'
    AND lead_phone NOT LIKE '%{%'
    AND length(lead_phone) >= 12
    ORDER BY created_at DESC
  `).all();
  console.log(`[Admin] Triggering ${pendingLeads.length} pending leads`);
  res.status(200).json({
    message: `Triggering ${pendingLeads.length} leads`,
    leads: pendingLeads.map(l => ({ id: l.id, name: l.lead_name, phone: l.lead_phone })),
  });
  const shop = SHOP_CONFIGS["pure-vision-tints"];
  for (let i = 0; i < pendingLeads.length; i++) {
    const lead = pendingLeads[i];
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 3 * 60 * 1000));
    try {
      const callResult = await triggerRetellCall({
        leadName:    lead.lead_name,
        leadPhone:   lead.lead_phone,
        leadVehicle: lead.lead_vehicle,
        leadSpecial: lead.lead_special,
      }, shop);
      db.prepare(`UPDATE leads SET call_id = ?, call_status = 'calling' WHERE id = ?`)
        .run(callResult.call_id, lead.id);
      console.log(`[Admin] Called ${lead.lead_name} (${lead.lead_phone}) — ${i + 1}/${pendingLeads.length}`);
    } catch (err) {
      console.error(`[Admin] Failed to call ${lead.lead_name}:`, err.message);
    }
  }
});

// ─── ROUTE: TOGGLE MANUAL MODE ───────────────────────────────────────────────
app.post('/admin/toggle-manual-mode', (req, res) => {
  const { secret, lead_id, manual_mode } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  db.prepare(`UPDATE leads SET manual_mode = ? WHERE id = ?`).run(manual_mode ? 1 : 0, lead_id);
  console.log(`[Admin] Lead ${lead_id} manual_mode set to ${manual_mode}`);
  res.json({ success: true, manual_mode: manual_mode ? 1 : 0 });
});

// ─── ROUTE: SEND MANUAL MESSAGE ───────────────────────────────────────────────
app.post('/admin/send-message', async (req, res) => {
  const { secret, lead_id, message } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!message?.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const result = await sendSMS(lead.lead_phone, message);
  if (result?.success !== false) {
    db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
      .run(lead_id, 'outbound', message);
    console.log(`[Admin] Manual message sent to ${lead.lead_name}: "${message}"`);
    return res.json({ success: true });
  }
  res.status(500).json({ error: 'SMS send failed' });
});

// ─── ROUTE: UPDATE LEAD STATUS ────────────────────────────────────────────────
app.post('/admin/update-lead-status', (req, res) => {
  const { secret, lead_id, status } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const validStatuses = ['pending', 'booked', 'confirmed', 'dead', 'mia', 'opted_out', 'sms_fallback', 'completed', 'calling'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare(`UPDATE leads SET call_status = ? WHERE id = ?`).run(status, lead_id);
  // If killing a lead, cancel all their pending jobs
  if (status === 'dead' || status === 'opted_out') {
    cancelAllJobsForLead(lead_id);
  }
  console.log(`[Admin] Lead ${lead_id} status updated to ${status}`);
  res.json({ success: true });
});

// ─── ROUTE: DELETE TEST LEADS ─────────────────────────────────────────────────
app.post('/admin/delete-test-leads', (req, res) => {
  const { secret, phone } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (phone) {
    const lead = db.prepare(`SELECT id FROM leads WHERE lead_phone = ?`).get(phone);
    if (lead) {
      db.prepare(`DELETE FROM sms_messages WHERE lead_id = ?`).run(lead.id);
      db.prepare(`DELETE FROM scheduled_jobs WHERE lead_id = ?`).run(lead.id);
      db.prepare(`DELETE FROM leads WHERE id = ?`).run(lead.id);
      return res.json({ success: true, deleted: phone });
    }
    return res.json({ success: false, message: 'Lead not found' });
  }
  return res.status(400).json({ error: 'Phone number required' });
});

// ─── ROUTE: DEDUPLICATE LEADS ─────────────────────────────────────────────────
app.post('/admin/deduplicate-leads', (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const duplicates = db.prepare(`
    SELECT id FROM leads
    WHERE id NOT IN (
      SELECT MAX(id) FROM leads
      GROUP BY shop_id, replace(replace(replace(lead_phone, '+', ''), '-', ''), ' ', '')
    )
  `).all();
  let deleted = 0;
  for (const row of duplicates) {
    db.prepare(`DELETE FROM sms_messages WHERE lead_id = ?`).run(row.id);
    db.prepare(`DELETE FROM scheduled_jobs WHERE lead_id = ?`).run(row.id);
    db.prepare(`DELETE FROM leads WHERE id = ?`).run(row.id);
    deleted++;
  }
  res.json({ success: true, deleted });
});

// ─── ROUTE: DELETE OUTREACH LEAD ─────────────────────────────────────────────
app.post('/admin/delete-outreach-lead', (req, res) => {
  const { secret, id } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (id) {
    db.prepare('DELETE FROM outreach_leads WHERE id = ?').run(id);
    return res.json({ success: true, deleted: id });
  }
  db.prepare('DELETE FROM outreach_leads').run();
  return res.json({ success: true, deleted: 'all' });
});

// ─── ROUTE: RESET SMS ─────────────────────────────────────────────────────────
app.post('/admin/reset-sms', (req, res) => {
  const { secret, phone } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const lead = db.prepare(`SELECT id FROM leads WHERE lead_phone = ?`).get(phone);
  if (!lead) return res.json({ success: false, message: 'Lead not found' });
  db.prepare(`DELETE FROM sms_messages WHERE lead_id = ?`).run(lead.id);
  db.prepare(`DELETE FROM scheduled_jobs WHERE lead_id = ? AND status = 'pending'`).run(lead.id);
  res.json({ success: true });
});

// ─── ROUTE: VIEW SCHEDULED JOBS (debug) ──────────────────────────────────────
app.get('/admin/jobs', (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const jobs = db.prepare(`
    SELECT j.*, l.lead_name, l.lead_phone, l.call_status
    FROM scheduled_jobs j
    LEFT JOIN leads l ON j.lead_id = l.id
    WHERE j.status = 'pending'
    ORDER BY j.send_at ASC
    LIMIT 50
  `).all();
  res.json({ pending_jobs: jobs.length, jobs });
});

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

// Proxy Retell call list
app.get('/dashboard/calls', async (req, res) => {
  const { agentId } = req.query;
  const resp = await fetch(`https://api.retellai.com/v2/list-calls`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, limit: 50 })
  });
  const data = await resp.json();
  res.json({ calls: data.calls || [] });
});

app.get('/dashboard/call/:callId', async (req, res) => {
  const resp = await fetch(`https://api.retellai.com/v2/get-call/${req.params.callId}`, {
    headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}` }
  });
  res.json(await resp.json());
});

// ─── ROUTE: SHOPDESK DEMO CALL ────────────────────────────────────────────────
app.post("/demo/call", async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number required" });

  try {
    const response = await fetch("https://api.retellai.com/v2/create-phone-call", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RETELL_API_KEY}` },
      body: JSON.stringify({
        from_number: process.env.SHOPDESK_DEMO_PHONE,
        to_number:   phone,
        agent_id:    process.env.SHOPDESK_DEMO_AGENT_ID,
        retell_llm_dynamic_variables: { visitor_name: name || "there" },
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    res.json({ success: true, call_id: data.call_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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