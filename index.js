import express from "express";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import twilio from "twilio";
import { google } from "googleapis";

dotenv.config();

const app = express();
const db = new Database("purevision.db");

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
    booked_at       TEXT,
    square_order_id TEXT,
    deposit_sent    INTEGER DEFAULT 0,
    deposit_paid    INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now'))
  )
`);

// ─── SHOP CONFIG ──────────────────────────────────────────────────────────────
const SHOP_CONFIGS = {
  "pure-vision-tints": {
    shopId:        "pure-vision-tints",
    shopName:      "Pure Vision Tints",
    webhookSecret: process.env.GHL_WEBHOOK_SECRET,
    retellAgentId: process.env.RETELL_AGENT_ID,
    fieldMapping: {
      leadName:    "contact_name",
      leadPhone:   "phone",
      leadVehicle: "vehicle",
      leadSpecial: "special",
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

// ─── YOUR ROOMMATE'S APPOINTMENT SLOTS ───────────────────────────────────────
// Update these if the schedule ever changes
const APPOINTMENT_SLOTS = [
  { label: "9AM",  hour: 9  },
  { label: "12PM", hour: 12 },
  { label: "3PM",  hour: 15 },
];

// ─── UTILITY: GET DATE STRING IN CENTRAL TIME ─────────────────────────────────
// Returns "2026-04-03" for any date, in Houston/Central timezone
function getCentralDateString(date) {
  return date.toLocaleDateString("en-CA", {
    timeZone: "America/Chicago",
  });
}

// ─── UTILITY: GET HOUR IN CENTRAL TIME FROM A DATE ───────────────────────────
function getCentralHour(date) {
  return parseInt(
    date.toLocaleString("en-US", {
      hour:     "numeric",
      hour12:   false,
      timeZone: "America/Chicago",
    })
  );
}

// ─── UTILITY: BOOK GOOGLE CALENDAR EVENT ─────────────────────────────────────
async function bookGoogleCalendarEvent(lead) {
  const appointmentDate = new Date(lead.booked_at);

  if (isNaN(appointmentDate.getTime())) {
    throw new Error(`Could not parse appointment time: ${lead.booked_at}`);
  }

  // Tint job = 2 hours
  const endDate = new Date(appointmentDate.getTime() + 2 * 60 * 60 * 1000);

  const event = await gcal.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary:     `Tint Appointment — ${lead.lead_name}`,
      description: `Vehicle: ${lead.lead_vehicle}\nSpecial: ${lead.lead_special}\nPhone: ${lead.lead_phone}\nDeposit: PAID`,
      start: {
        dateTime: appointmentDate.toISOString(),
        timeZone: "America/Chicago",
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: "America/Chicago",
      },
    },
  });

  console.log(`[Calendar] Event created: ${event.data.htmlLink}`);
  return event.data;
}


// ─── UTILITY: TRIGGER RETELL AI CALL ─────────────────────────────────────────
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
        current_date: new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Chicago"
        }), // gives "2026-04-01"
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Retell API error: ${err}`);
  }

  return response.json();
}

// ─── UTILITY: MAP GHL PAYLOAD → STANDARD LEAD ────────────────────────────────
function mapLead(payload, fieldMapping) {
  return {
    leadName:    payload[fieldMapping.leadName]    || "there",
    leadPhone:   payload[fieldMapping.leadPhone]   || null,
    leadVehicle: payload[fieldMapping.leadVehicle] || "your vehicle",
    leadSpecial: payload[fieldMapping.leadSpecial] || "Ceramic Special",
  };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());

// ─── ROUTE: HEALTH CHECK ──────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ─── ROUTE: DEBUG CALENDAR ────────────────────────────────────────────────────
// Hit this anytime to see what Google Calendar returns
// GET /debug/calendar
app.get("/debug/calendar", async (req, res) => {
  try {
    const now       = new Date();
    const tomorrow  = new Date(now.getTime() + 86400000);
    const dateStr   = getCentralDateString(now);
    const tDateStr  = getCentralDateString(tomorrow);

    const dayStart  = new Date(`${dateStr}T00:00:00-05:00`);
    const dayEnd    = new Date(`${tDateStr}T23:59:59-05:00`);

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

  const result = db.prepare(`
    INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special)
    VALUES (?, ?, ?, ?, ?)
  `).run(shopId, lead.leadName, lead.leadPhone, lead.leadVehicle, lead.leadSpecial);

  const leadId = result.lastInsertRowid;
  console.log(`[${shopId}] Lead stored — DB id: ${leadId}`);

  res.status(200).json({ received: true, leadId });

  try {
    const callResult = await triggerRetellCall(lead, shop);
    console.log(`[${shopId}] Retell call triggered:`, callResult.call_id);
    db.prepare(`UPDATE leads SET call_id = ?, call_status = 'calling' WHERE id = ?`)
      .run(callResult.call_id, leadId);
  } catch (err) {
    console.error(`[${shopId}] Failed to trigger Retell call:`, err.message);
    db.prepare(`UPDATE leads SET call_status = 'call_failed' WHERE id = ?`)
      .run(leadId);
  }
});

// ─── ROUTE: RETELL CALL OUTCOME WEBHOOK ──────────────────────────────────────
app.post("/webhook/retell/call-ended", async (req, res) => {
  console.log("\n[Retell] Raw payload:", JSON.stringify(req.body, null, 2));

  const isV2 = req.body.event !== undefined;

  const call_id     = isV2 ? req.body.call?.call_id     : req.body.call_id;
  const call_status = isV2 ? req.body.call?.call_status : req.body.call_status;

  console.log(`[Retell] Parsed — id: ${call_id}, status: ${call_status}`);

  if (!call_id) {
    console.warn("[Retell] No call_id found in payload");
    return res.status(200).json({ ok: true });
  }

  const lead = db.prepare(`SELECT * FROM leads WHERE call_id = ?`).get(call_id);

  if (!lead) {
    console.warn(`[Retell] No lead found for call_id: ${call_id}`);
    return res.status(200).json({ ok: true });
  }

  const statusMap = {
    ended:      "completed",
    error:      "call_failed",
    busy:       "no_answer",
    no_answer:  "no_answer",
    registered: "completed",
  };

  const newStatus = statusMap[call_status] || "completed";

  db.prepare(`UPDATE leads SET call_status = ? WHERE id = ?`)
    .run(newStatus, lead.id);

  console.log(`[Retell] Lead ${lead.id} updated → status: ${newStatus}`);

  res.status(200).json({ ok: true });
});

// ─── ROUTE: GET AVAILABLE SLOTS ───────────────────────────────────────────────
// Called by Retell mid-conversation before offering times.
// Retell passes the date the customer mentions.
// Works for today, tomorrow, or any future date weeks ahead.
//
// Example Retell tool call:
//   { "date": "tomorrow" }
//   { "date": "2026-04-15" }
//   { "date": "next Friday" } ← AI should normalize to YYYY-MM-DD before calling
app.post("/tools/get-availability", async (req, res) => {

    const raw  = req.body;
    const args = raw.args || raw;
    const date = args.date;

    console.log("\n[Availability Tool] Raw body:", JSON.stringify(raw, null, 2));
    console.log("[Availability Tool] Resolved date:", date);

  
    if (!date) {
      return res.json({
        response: "We have 9AM, 12PM, and 3PM available tomorrow. Which works best for you?",
        available_slots: ["9AM", "12PM", "3PM"],
      });
    }

  try {
    // Build day boundaries in Central time
    const checkDate = new Date(date + "T12:00:00-05:00");
    const dateStr  = getCentralDateString(checkDate);
    const dayStart = new Date(`${dateStr}T00:00:00-05:00`);
    const dayEnd   = new Date(`${dateStr}T23:59:59-05:00`);

    console.log(`[Availability Tool] Checking: ${dateStr} (${dayStart.toISOString()} → ${dayEnd.toISOString()})`);

    // Fetch events from Google Calendar for that day
    const response = await gcal.events.list({
      calendarId:   process.env.GOOGLE_CALENDAR_ID,
      timeMin:      dayStart.toISOString(),
      timeMax:      dayEnd.toISOString(),
      singleEvents: true,
      orderBy:      "startTime",
    });

    const existingEvents = response.data.items || [];

    // Extract booked hours in Central time
    const bookedHours = existingEvents.map(event => {
      const start       = new Date(event.start.dateTime || event.start.date);
      const centralHour = getCentralHour(start);
      console.log(`[Availability Tool] Booked: "${event.summary}" at central hour ${centralHour}`);
      return centralHour;
    });

    console.log(`[Availability Tool] All booked hours: ${bookedHours}`);

    // Filter to only open slots
    const availableSlots = APPOINTMENT_SLOTS.filter(
      slot => !bookedHours.includes(slot.hour)
    );

    console.log(`[Availability Tool] Available: ${availableSlots.map(s => s.label)}`);

    // Format the date nicely for the AI to speak
    const friendlyDate = checkDate.toLocaleDateString("en-US", {
      weekday:  "long",
      month:    "long",
      day:      "numeric",
      timeZone: "America/Chicago",
    });

    if (availableSlots.length === 0) {
      return res.json({
        response:        `Unfortunately we're fully booked on ${friendlyDate}. Would you like me to check another day?`,
        available_slots: [],
        date:            dateStr,
        friendly_date:   friendlyDate,
      });
    }

    const slotList = availableSlots.map(s => s.label).join(", ");

    return res.json({
      response:        `We have ${slotList} available on ${friendlyDate}. Which works best for you?`,
      available_slots: availableSlots.map(s => s.label),
      date:            dateStr,
      friendly_date:   friendlyDate,
    });

  } catch (err) {
    console.error("[Availability Tool] Error:", err.message);
    // Safe fallback — never leave AI hanging
    return res.json({
      response:        "We have 9AM, 12PM, and 3PM available. Which works best for you?",
      available_slots: ["9AM", "12PM", "3PM"],
    });
  }
});

// ─── ROUTE: SEND DEPOSIT LINK ─────────────────────────────────────────────────
// Called by Retell when customer agrees to pay deposit.
// Generates Square payment link, sends SMS, stores order ID.

app.post("/tools/send-deposit", async (req, res) => {
    console.log("\n[Deposit Tool] RAW BODY:", JSON.stringify(req.body, null, 2));
    const raw            = req.body;
    const args           = raw.args || raw;
    const lead_name      = args.lead_name;
    const lead_phone     = args.lead_phone;
    const appointment_time = args.appointment_time;

    console.log("[Deposit Tool] Resolved args:", { lead_name, lead_phone, appointment_time });

    // After resolving args, find or create the lead
    let lead = db.prepare(`
      SELECT * FROM leads WHERE lead_phone = ? AND deposit_sent = 0
      ORDER BY created_at DESC LIMIT 1
    `).get(lead_phone);

    // Safety net — create lead if it doesn't exist (handles Retell test calls)
    if (!lead) {
      console.warn("[Deposit Tool] No existing lead found — creating on the fly");
      const result = db.prepare(`
        INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special)
        VALUES (?, ?, ?, ?, ?)
      `).run("pure-vision-tints", lead_name, lead_phone, "Unknown vehicle", "Unknown special");
      
      lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(result.lastInsertRowid);
    }

  if (!lead_phone) {
    return res.status(400).json({
      response: "I'm sorry, I wasn't able to send the deposit link. Please call us back."
    });
  }

  try {
    const squareRes = await fetch(
      "https://connect.squareupsandbox.com/v2/online-checkout/payment-links",
      // Switch to https://connect.squareup.com for production
      {
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          "Authorization":  `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
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
                  amount:   2000,
                  currency: "USD",
                },
              },
            ],
          },
          checkout_options: {
            allow_tipping:          false,
            redirect_url:           "https://purevisiontints.com/thank-you",
            merchant_support_email: "hello@purevisiontints.com",
          },
        }),
      }
    );

    const squareData = await squareRes.json();

    if (!squareRes.ok) {
      throw new Error(squareData.errors?.[0]?.detail || "Square API error");
    }

    const depositUrl    = squareData.payment_link.url;
    const squareOrderId = squareData.payment_link.order_id;
    const shortPhone    = lead_phone.slice(-4);

    console.log(`[Deposit Tool] Square link created: ${depositUrl}`);
    console.log(`[Deposit Tool] Square order ID: ${squareOrderId}`);

    // Send SMS
    await twilioClient.messages.create({
      body: `Hi ${lead_name}! Here's your $20 deposit link to confirm your tint appointment at Pure Vision Tints: ${depositUrl} — Valid for 24 hours.`,
      from: process.env.TWILIO_SMS_FROM,
      to:   lead_phone,
    });

    console.log(`[Deposit Tool] SMS sent to ${lead_phone}`);

    // Store order ID and appointment time — used for exact matching + calendar booking
    db.prepare(`
      UPDATE leads
      SET deposit_sent = 1, square_order_id = ?, booked_at = ?
      WHERE lead_phone = ? AND deposit_sent = 0
    `).run(squareOrderId, appointment_time || null, lead_phone);

    return res.json({
      response: `I just sent the deposit link to the number ending in ${shortPhone}. Are you able to take care of that while we're on the phone so I can confirm you're locked in?`,
      deposit_url: depositUrl,
      success: true,
    });

  } catch (err) {
    console.error("[Deposit Tool] Error:", err.message);
    return res.json({
      response: "I just sent the deposit link to your phone. Please complete it within 24 hours to hold your spot.",
      success: false,
    });
  }
});

// ─── ROUTE: SQUARE PAYMENT WEBHOOK ───────────────────────────────────────────
app.post("/webhooks/square", async (req, res) => {
  const eventType = req.body.type;
  console.log(`\n[Square Webhook] Received type: ${eventType}`);

  if (eventType === "payment.updated") {
    const payment = req.body.data?.object?.payment;
    const status  = payment?.status;
    const orderId = payment?.order_id;

    console.log(`[Square Webhook] Payment status: ${status}, order: ${orderId}`);

    if (status !== "COMPLETED") {
      console.log("[Square Webhook] Not completed yet — ignoring");
      return res.status(200).json({ ok: true });
    }

    // Match exactly by Square order ID — no ambiguity ever
    const lead = db.prepare(`
      SELECT * FROM leads
      WHERE square_order_id = ? AND deposit_paid = 0
    `).get(orderId);

    if (!lead) {
      console.warn(`[Square Webhook] No lead found for order: ${orderId}`);
      return res.status(200).json({ ok: true });
    }

    // Mark deposit paid
    db.prepare(`
      UPDATE leads
      SET deposit_paid = 1, call_status = 'confirmed'
      WHERE id = ?
    `).run(lead.id);

    console.log(`[Square Webhook] Lead ${lead.id} — ${lead.lead_name} CONFIRMED! Deposit paid.`);

    // Book calendar if we have an appointment time
    if (lead.booked_at) {
      try {
        await bookGoogleCalendarEvent(lead);

        db.prepare(`UPDATE leads SET call_status = 'booked' WHERE id = ?`)
          .run(lead.id);

        console.log(`[Calendar] Booked — ${lead.lead_name} at ${lead.booked_at}`);

        // Send confirmation SMS
        await twilioClient.messages.create({
          body: `Hi ${lead.lead_name}! Your tint appointment at Pure Vision Tints is confirmed for ${lead.booked_at}. See you then!`,
          from: process.env.TWILIO_SMS_FROM,
          to:   lead.lead_phone,
        });

        console.log(`[Calendar] Confirmation SMS sent to ${lead.lead_phone}`);

      } catch (err) {
        console.error("[Calendar] Booking failed:", err.message);
      }
    } else {
      console.warn(`[Calendar] No appointment time for lead ${lead.id} — manual booking needed`);
    }
  }

  res.status(200).json({ ok: true });
});

app.post("/tools/check-deposit-status", async (req, res) => {
  console.log("\n[Deposit Check] Called with:", JSON.stringify(req.body, null, 2));

  const raw        = req.body;
  const args       = raw.args || raw;
  const lead_phone = args.lead_phone;

  if (!lead_phone) {
    return res.json({
      status:   "unknown",
      response: "I wasn't able to check your payment status. Please complete the deposit link within 24 hours.",
    });
  }

  const lead = db.prepare(`
    SELECT * FROM leads
    WHERE lead_phone = ? 
    ORDER BY created_at DESC LIMIT 1
  `).get(lead_phone);

  if (!lead) {
    return res.json({
      status:   "unknown",
      response: "Please complete the deposit link within 24 hours to secure your appointment.",
    });
  }

  if (lead.deposit_paid === 1) {
    return res.json({
      status:   "paid",
      response: `Your deposit is confirmed! You are officially locked into our schedule for ${lead.booked_at}. We look forward to taking care of your ${lead.lead_vehicle} — see you then!`,
    });
  }

  if (lead.deposit_sent === 1) {
    return res.json({
      status:   "pending",
      response: "I can see the link was sent but the deposit hasn't come through yet. No worries — you have 24 hours to complete it. Once paid you'll automatically receive a confirmation text locking you in.",
    });
  }

  return res.json({
    status:   "not_sent",
    response: "Please complete the deposit link within 24 hours to secure your appointment.",
  });
});

// ─── ROUTE: DASHBOARD API ─────────────────────────────────────────────────────
app.get("/api/leads/:shopId", (req, res) => {
  const { shopId } = req.params;
  const leads = db.prepare(`
    SELECT * FROM leads WHERE shop_id = ? ORDER BY created_at DESC
  `).all(shopId);
  res.json(leads);
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nPure Vision backend running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook/ghl/pure-vision-tints`);
  console.log(`Leads API:   http://localhost:${PORT}/api/leads/pure-vision-tints\n`);
});