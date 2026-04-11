import express from "express";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import twilio from "twilio";
import { google } from "googleapis";

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
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "Vehicle Information",
      leadSpecial: "lead_special_override",
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
  { label: "1PM", hour: 13 },
  { label: "3PM",  hour: 15 },
  { label: "5PM", hour: 17 },
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

async function bookGoogleCalendarEvent(lead) {
  const appointmentDate = new Date(lead.booked_at);
  if (isNaN(appointmentDate.getTime())) {
    throw new Error(`Could not parse appointment time: ${lead.booked_at}`);
  }
  // Handle both lead.lead_name and lead.name formats
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

// ─── ROUTE: BOOK APPOINTMENT DIRECTLY ────────────────────────────────────────
// Called by Retell when customer confirms appointment time
// Replaces deposit-triggered booking while SMS/Square is disabled
app.post("/tools/book-appointment", async (req, res) => {
  console.log("\n[Book Tool] Called with:", JSON.stringify(req.body, null, 2));

  const raw              = req.body;
  const args             = raw.args || raw;
  const lead_name        = args.lead_name;
  const lead_phone       = args.lead_phone;
  const lead_vehicle     = args.lead_vehicle;
  const lead_special     = args.lead_special;
  const appointment_time = args.appointment_time;

  console.log("[Book Tool] Resolved:", { lead_name, lead_phone, appointment_time });

  if (!appointment_time) {
    return res.json({
      response: "I wasn't able to lock in that time. Can you confirm the day and time again?",
      success: false,
    });
  }

  try {
    // Update lead in DB with appointment time
    db.prepare(`
      UPDATE leads
      SET booked_at = ?, call_status = 'booked'
      WHERE lead_phone = ?
    `).run(appointment_time, lead_phone);

    // Build a fake lead object for calendar booking
    const lead = {
      lead_name:    lead_name    || "Customer",
      lead_phone:   lead_phone   || "",
      lead_vehicle: lead_vehicle || "your vehicle",
      lead_special: lead_special || "Ceramic Special",
      booked_at:    appointment_time,
    };

    // Book Google Calendar
    await bookGoogleCalendarEvent(lead);

    console.log(`[Book Tool] Appointment booked — ${lead_name} at ${appointment_time}`);

    return res.json({
      response: `Perfect, you're all set! I've got you down for ${appointment_time}. We look forward to taking care of your ${lead_vehicle || "vehicle"} — see you then!`,
      success: true,
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

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());

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

  if (process.env.CALLS_ENABLED === "true") {
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
  } else {
    console.log(`[${shopId}] Calls disabled — lead stored, no call triggered`);
  }
});

// ─── ROUTE: META WEBHOOK VERIFICATION ────────────────────────────────────────
app.get("/webhook/meta", (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const mode         = req.query["hub.mode"];
  const token        = req.query["hub.verify_token"];
  const challenge    = req.query["hub.challenge"];
  console.log("[Meta] Verification request received");
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[Meta] Webhook verified successfully");
    return res.status(200).send(challenge);
  }
  console.error("[Meta] Verification failed — token mismatch");
  res.sendStatus(403);
});

// ─── ROUTE: META WEBHOOK ─────────────────────────────────────────────────────
app.post("/webhook/meta", async (req, res) => {
  console.log("\n[Meta] Webhook received:", JSON.stringify(req.body, null, 2));
  res.status(200).send("EVENT_RECEIVED");
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "leadgen") continue;
        const leadgenId = change.value?.leadgen_id;
        console.log(`[Meta] New lead — leadgen_id: ${leadgenId}`);
        const leadData = await fetchMetaLead(leadgenId);
        if (!leadData) {
          console.error("[Meta] Could not fetch lead data");
          continue;
        }
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
        console.log(`[Meta] Lead stored — id: ${leadId}, name: ${leadData.name}`);
        if (process.env.CALLS_ENABLED === "true" && leadData.phone) {
          const shop = SHOP_CONFIGS["pure-vision-tints"];
          try {
            const callResult = await triggerRetellCall({
              leadName:    leadData.name,
              leadPhone:   leadData.phone,
              leadVehicle: leadData.vehicle || "your vehicle",
              leadSpecial: leadData.special || "Ceramic Special",
            }, shop);
            db.prepare(`UPDATE leads SET call_id = ?, call_status = 'calling' WHERE id = ?`)
              .run(callResult.call_id, leadId);
            console.log(`[Meta] Call triggered for ${leadData.name}`);
          } catch (err) {
            console.error(`[Meta] Call failed:`, err.message);
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
      `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${process.env.META_PAGE_ACCESS_TOKEN}`
    );
    const data = await response.json();
    console.log("[Meta] Raw lead data:", JSON.stringify(data, null, 2));
    if (!data.field_data) return null;
    const fields = {};
    data.field_data.forEach(field => {
      fields[field.name.toLowerCase()] = field.values?.[0];
    });
    console.log("[Meta] Parsed fields:", fields);
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

// ─── ROUTE: RETELL CALL OUTCOME ───────────────────────────────────────────────
app.post("/webhook/retell/call-ended", async (req, res) => {
  console.log("\n[Retell] Raw payload:", JSON.stringify(req.body, null, 2));
  const isV2        = req.body.event !== undefined;
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
  db.prepare(`UPDATE leads SET call_status = ? WHERE id = ?`).run(newStatus, lead.id);
  console.log(`[Retell] Lead ${lead.id} updated → status: ${newStatus}`);
  res.status(200).json({ ok: true });
});

// ─── ROUTE: GET AVAILABILITY ──────────────────────────────────────────────────
app.post("/tools/get-availability", async (req, res) => {
  const raw  = req.body;
  const args = raw.args || raw;
  const date = args.date;
  console.log("\n[Availability Tool] Raw body:", JSON.stringify(raw, null, 2));
  console.log("[Availability Tool] Resolved date:", date);
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
    console.log(`[Availability Tool] Checking: ${dateStr}`);
    const response = await gcal.events.list({
      calendarId:   process.env.GOOGLE_CALENDAR_ID,
      timeMin:      dayStart.toISOString(),
      timeMax:      dayEnd.toISOString(),
      singleEvents: true,
      orderBy:      "startTime",
    });
    const existingEvents = response.data.items || [];
    const bookedHours = existingEvents.map(event => {
      const start       = new Date(event.start.dateTime || event.start.date);
      const centralHour = getCentralHour(start);
      console.log(`[Availability Tool] Booked: "${event.summary}" at hour ${centralHour}`);
      return centralHour;
    });
    console.log(`[Availability Tool] All booked hours: ${bookedHours}`);
    const availableSlots = APPOINTMENT_SLOTS.filter(
      slot => !bookedHours.includes(slot.hour)
    );
    console.log(`[Availability Tool] Available: ${availableSlots.map(s => s.label)}`);
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
    const slotList = availableSlots.map(s => s.label).join(", ");
    return res.json({
      response:        `We have ${slotList} available on ${friendlyDate}. Which works best for you?`,
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

// ─── ROUTE: SEND DEPOSIT LINK — DISABLED UNTIL TWILIO A2P APPROVED ───────────
// Uncomment this entire block when Twilio SMS is approved
// app.post("/tools/send-deposit", async (req, res) => { ... });

// ─── ROUTE: SQUARE PAYMENT WEBHOOK — DISABLED UNTIL DEPOSIT LINK RE-ENABLED ──
// Uncomment this entire block when deposit flow is re-enabled
// app.post("/webhooks/square", async (req, res) => { ... });

// ─── ROUTE: CHECK DEPOSIT STATUS — DISABLED UNTIL DEPOSIT LINK RE-ENABLED ────
// app.post("/tools/check-deposit-status", async (req, res) => { ... });

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

// ─── ROUTE: MANUAL LEAD ENTRY ─────────────────────────────────────────────────
app.post("/leads/manual", async (req, res) => {
  const { name, phone, vehicle, special, secret } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  if (!phone) {
    return res.status(400).json({ error: "Phone required" });
  }
  const result = db.prepare(`
    INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special)
    VALUES (?, ?, ?, ?, ?)
  `).run("pure-vision-tints", name || "there", phone, vehicle || "your vehicle", special || "Ceramic Special");
  const leadId = result.lastInsertRowid;
  console.log(`[Manual] Lead stored — id: ${leadId}, name: ${name}, phone: ${phone}`);
  if (process.env.CALLS_ENABLED === "true") {
    const shop = SHOP_CONFIGS["pure-vision-tints"];
    try {
      const callResult = await triggerRetellCall({
        leadName:    name || "there",
        leadPhone:   phone,
        leadVehicle: vehicle || "your vehicle",
        leadSpecial: special || "Ceramic Special",
      }, shop);
      db.prepare(`UPDATE leads SET call_id = ?, call_status = 'calling' WHERE id = ?`)
        .run(callResult.call_id, leadId);
      console.log(`[Manual] Call triggered for ${name}`);
    } catch (err) {
      console.error(`[Manual] Call failed:`, err.message);
    }
  }
  res.status(200).json({ success: true, leadId });
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