import express from "express";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import twilio from "twilio";
import { google } from "googleapis";
import cors from "cors";
import crypto from 'node:crypto';

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


try {
  db.exec(`ALTER TABLE leads ADD COLUMN call_attempts INTEGER DEFAULT 0`);
} catch(e) { /* already exists */ }

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

app.use('/webhook/sms/inbound', express.raw({ type: 'application/json' }));



// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());

app.use(cors({
  origin: ["https://shopdesk.ai", "https://www.shopdesk.ai", "http://localhost:3000"],
  methods: ["GET", "POST"],
}));

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
  // Parse as Central time explicitly by appending the offset
  // "2026-04-12 11:00" becomes "2026-04-12T11:00:00-05:00"
  const dateTimeStr = lead.booked_at.includes("T") 
    ? lead.booked_at 
    : lead.booked_at.replace(" ", "T") + ":00-05:00";
  
  const appointmentDate = new Date(dateTimeStr);
  
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

      const date = new Date(appointment_time.replace(" ", "T") + ":00-05:00");
      const friendlyTime = date.toLocaleString("en-US", {
        weekday: "long",
        month:   "long", 
        day:     "numeric",
        hour:    "numeric",
        minute:  "2-digit",
        timeZone: "America/Chicago",
      });
      return res.json({
      response: `You're officially locked in for ${friendlyTime}! We look forward to taking care of your ${lead_vehicle || "vehicle"}.`,      });

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
        lead_name: { type: "string" },
        lead_phone: { type: "string" },
        lead_vehicle: { type: "string" },
        lead_special: { type: "string" },
        appointment_time: { type: "string", description: "Format: YYYY-MM-DD HH:mm" }
      },
      required: ["lead_name", "lead_phone", "lead_vehicle", "lead_special", "appointment_time"]
    }
  }
];

// ─── SMS SYSTEM PROMPT ────────────────────────────────────────────────────────
function buildSMSSystemPrompt(lead) {
  return `You are Marissa, Pure Vision Tints' AI receptionist texting with a lead.

IDENTITY
You are an AI texting on behalf of Pure Vision Tints. Your name is Marissa.
You are warm, efficient, and focused on getting the customer booked.
This is SMS — keep every message SHORT (1-3 sentences max).

LEAD INFO
- Name: ${lead.lead_name}
- Vehicle: ${lead.lead_vehicle}
- Special: ${lead.lead_special || 'Ceramic Special'}
- Phone: ${lead.lead_phone}

PRICING & SERVICES
Carbon Special — $199: all side windows + rear windshield, GeoShield carbon film
Ceramic Special — $395: all side windows + rear windshield, Xpel XR Black ceramic, blocks 85% IR heat and 99% UV
Tint Removal — $50 extra if they have existing tint
Visor: $40 | 2 Carbon doors: $40 | 2 Ceramic doors: $80
Carbon windshield: $125 | Ceramic windshield: $150
Shades: 5%, 15%, 20%, 30%, 50%, 70% — shade does NOT affect price
Lifetime warranty on all work

SHOP DETAILS
Location: Hockley TX, off I two ninety where it meets Highway 99, about 10 min from Cypress
Address: 33619 Falcon Spring Street, Hockley TX 77447
Owner: Jordy Chen, 5+ years experience, does all work himself
Waiting room with WiFi, drop-off available same day or next day

CONVERSATION FLOW
1. Confirm they are still interested in tinting their ${lead.lead_vehicle}
2. Ask if there is existing tint — adds $50 removal fee if yes
3. Confirm their special and give total price
4. Mention location — "We're in Hockley off I two ninety, about 10 min from Cypress"
5. Ask what day works
6. Call get_availability with that date in YYYY-MM-DD format
7. Offer only slots the tool returns — never invent availability
8. When they pick a time confirm: "Perfect — I have you down for [TIME] on [DAY] for your ${lead.lead_vehicle}, that's the [SPECIAL] at [PRICE]. Any questions before I lock you in?"
9. Only after they confirm no more questions call book_appointment
10. Confirm booking and close warmly

OBJECTION HANDLING
"Too far" → "Totally understand! If you're ever in the area we'd love to take care of you 🙏"
"Need to think" → "Of course! Just so you know spots fill up fast — want me to pencil something in and we can always adjust?"
"How long?" → "About 1-2 hours. Drop off or hang out in our waiting room with WiFi!"
"Carbon vs ceramic?" → "Ceramic is premium — Xpel XR Black blocks 85% of heat. In Texas heat most people go ceramic!"
"Is this a real person?" → "I'm Marissa, Pure Vision's AI receptionist! I handle scheduling so Jordy can focus on the work. How can I help?"
"Already tinted" → "No worries! If you ever need a re-tint or know someone who does, keep us in mind 🙏"
"Legal shades?" → "Texas allows 25% on front windows, any darkness on rear. We have all options!"

RULES
- Always use the customer's first name
- Never make up availability — always call get_availability first
- Never confirm a booking without calling book_appointment
- Never mention Claude, Anthropic, or any AI platform
- If they say STOP or not interested → "No problem! Feel free to reach out anytime 🙏" then stop
- Keep every reply to 1-3 sentences — this is SMS not email
- Today's date is ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}`;
}

// ─── SMS AGENT LOOP ───────────────────────────────────────────────────────────
async function runSMSAgent(messages, lead) {
  let currentMessages = [...messages];

  while (true) {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: buildSMSSystemPrompt(lead),
        tools: smsTools,
        messages: currentMessages
      })
    });

    const aiData = await aiResp.json();
    console.log('[SMS Agent] Claude response:', JSON.stringify(aiData, null, 2));
    const { content, stop_reason } = aiData;

    if (stop_reason === 'tool_use') {
      const toolUse = content.find(b => b.type === 'tool_use');
      const toolName = toolUse.name;
      const toolInput = toolUse.input;

      console.log(`[SMS Agent] Tool call: ${toolName}`, toolInput);

      let toolResult;
      try {
        const endpoint = toolName === 'get_availability' ? 'get-availability' : 'book-appointment';
        const toolResp = await fetch(
          `https://purevision-backend-production.up.railway.app/tools/${endpoint}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toolInput)
          }
        );
        toolResult = await toolResp.json();
      } catch(e) {
        toolResult = { error: 'Tool call failed: ' + e.message };
      }

      console.log(`[SMS Agent] Tool result:`, toolResult);

      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(toolResult)
          }]
        }
      ];

      continue;
    }

    const textBlock = content.find(b => b.type === 'text');
    return textBlock?.text || null;
  }
}

// ─── SEND SMS HELPER ──────────────────────────────────────────────────────────
async function sendSMS(to, message) {
  try {
    // Blooio requires phone number URL-encoded in the path
    const encodedTo = encodeURIComponent(to);
    const resp = await fetch(`https://backend.blooio.com/v2/api/chats/${encodedTo}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BLOOIO_API_KEY}`
      },
      body: JSON.stringify({
        text: message,
        from_number: process.env.BLOOIO_NUMBER
      })
    });
    const data = await resp.json();
    console.log('[SMS] Sent via Blooio:', JSON.stringify(data));
    return data;
  } catch(e) {
    console.error('[SMS] Failed:', e.message);
  }
}
// ─── INBOUND SMS WEBHOOK ──────────────────────────────────────────────────────
app.post('/webhook/sms/inbound',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    // const signature = req.headers['x-blooio-signature'] ?? '';
    // const event = req.headers['x-blooio-event'] ?? '';

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

    const signature = req.headers['x-blooio-signature'] ?? '';
    const event = req.headers['x-blooio-event'] ?? 'message.received';

    // Only verify signature if one was provided (skip for testing)
    if (signature) {
      const expected = crypto
        .createHmac('sha256', process.env.BLOOIO_SECRET)
        .update(rawBody)
        .digest('hex');

      try {
        if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
          console.log('[SMS] Invalid Blooio signature — rejected');
          return res.sendStatus(401);
        }
      } catch(e) {
        console.log('[SMS] Signature check failed:', e.message);
        return res.sendStatus(401);
      }
    }

    res.sendStatus(200);

    if (event !== 'message.received') return;

    try {
      const payload = JSON.parse(rawBody.toString('utf8'));
      const from = payload.data?.from;
      const content = payload.data?.text;

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

      await sendSMS(from, reply);

      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead.id, 'inbound', content);
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead.id, 'outbound', reply);

      console.log(`[SMS] Replied to ${lead.lead_name}: "${reply}"`);

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

  console.log(`[Retell] Call ended — id: ${call_id}, status: ${status}`);

  if (!call_id) return res.status(200).json({ ok: true });

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

  const newStatus = statusMap[status] || "completed";

  if (newStatus === 'no_answer' || newStatus === 'call_failed') {
    const attempts = (lead.call_attempts || 0) + 1;

    db.prepare(`UPDATE leads SET call_attempts = ?, call_status = ? WHERE id = ?`)
      .run(attempts, newStatus, lead.id);

    if (attempts === 1) {
      // First no answer — double dial after 2 minutes
      console.log(`[Retry] Double dial for ${lead.lead_name} in 2 min`);
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
          console.log(`[Retry] Double dial triggered for ${lead.lead_name}`);
        } catch(e) {
          console.error(`[Retry] Double dial failed:`, e.message);
        }
      }, 2 * 60 * 1000);

    } else if (attempts >= 2) {
      // Two failed calls — send SMS fallback
      console.log(`[SMS Fallback] Sending to ${lead.lead_name} after ${attempts} failed calls`);
      const msg = `Hey ${lead.lead_name}! This is Marissa from Pure Vision Tints 🚗 We tried reaching you about tinting your ${lead.lead_vehicle} but couldn't connect. Still interested? Just reply here and I'll get you taken care of real quick 👍`;
      await sendSMS(lead.lead_phone, msg);
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead.id, 'outbound', msg);
      db.prepare(`UPDATE leads SET call_status = 'sms_fallback' WHERE id = ?`)
        .run(lead.id);
    }

  } else {
    // Completed or other status — just update normally
    db.prepare(`UPDATE leads SET call_status = ? WHERE id = ?`)
      .run(newStatus, lead.id);
  }

  console.log(`[Retell] Lead ${lead.lead_name} updated to: ${newStatus}`);
  return res.status(200).json({ ok: true });
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

// Proxy single call detail
app.get('/dashboard/call/:callId', async (req, res) => {
  const resp = await fetch(`https://api.retellai.com/v2/get-call/${req.params.callId}`, {
    headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}` }
  });
  res.json(await resp.json());
});

// ─── ROUTE: SHOPDESK DEMO CALL ────────────────────────────────────────────────
// Powers the "Call me now" button on shopdesk.ai
app.post("/demo/call", async (req, res) => {
  console.log("[ShopDesk Demo] Route hit — body:", JSON.stringify(req.body));
  console.log("ShopDesk Demo")
  const { phone, name } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Phone number required" });
  }

  console.log(`[ShopDesk Demo] Calling ${name || "visitor"} at ${phone}`);

  try {
    const response = await fetch("https://api.retellai.com/v2/create-phone-call", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${process.env.RETELL_API_KEY}`,
      },
      body: JSON.stringify({
        from_number: process.env.SHOPDESK_DEMO_PHONE,
        to_number:   phone,
        agent_id:    process.env.SHOPDESK_DEMO_AGENT_ID,
        retell_llm_dynamic_variables: {
          visitor_name: name || "there",
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Retell error: ${err}`);
    }

    const data = await response.json();
    console.log(`[ShopDesk Demo] Call triggered: ${data.call_id}`);
    res.json({ success: true, call_id: data.call_id });

  } catch (err) {
    console.error(`[ShopDesk Demo] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/dashboard/data/:shopId', async (req, res) => {
  const { password } = req.query;
  if (password !== 'purevision2026') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const rawKey = process.env.GOOGLE_PRIVATE_KEY;
    // Leads from SQLite
    const leads = db.prepare(
      'SELECT * FROM leads WHERE shop_id = ? ORDER BY created_at DESC'
    ).all(req.params.shopId);

    // Fetch full call details from Retell using call_id on each lead
    const calls = [];
    const leadsWithCalls = leads.filter(l => l.call_id);
    for (const lead of leadsWithCalls) {
      try {
        const r = await fetch(`https://api.retellai.com/v2/get-call/${lead.call_id}`, {
          headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}` }
        });
        if (r.ok) {
          const callData = await r.json();
          // Merge lead info into the call object so dashboard has name/vehicle
          calls.push({
            ...callData,
            lead_name: lead.lead_name,
            lead_phone: lead.lead_phone,
            lead_vehicle: lead.lead_vehicle,
            lead_special: lead.lead_special,
            booked_at: lead.booked_at,
          });
        }
      } catch (e) {
        console.error(`Retell fetch failed for ${lead.call_id}:`, e.message);
      }
    }

    // Calendar events (next 14 days)
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
        timeMin: now.toISOString(),
        timeMax: twoWeeks.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      events = (calResp.data.items || []).map(e => ({
        summary: e.summary,
        description: e.description,
        start: e.start.dateTime || e.start.date,
        end: e.end.dateTime || e.end.date,
      }));
    } catch (e) {
      console.error('Calendar fetch failed:', e.message);
    }

    res.json({ leads, calls, events });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
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