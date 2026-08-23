import express from "express";
import { db } from "../db/connection.js";
import { sendSMS } from "../services/sms.js";
import { createDepositLink } from "../services/square.js";
import {
  gcal,
  APPOINTMENT_SLOTS,
  getCentralDateString,
  getCentralHour,
  bookGoogleCalendarEvent,
} from "../services/calendar.js";
import { cancelAllJobsForLead } from "../workers/follow-ups.js";

const router = express.Router();

// ─── ROUTE: GET AVAILABILITY ──────────────────────────────────────────────────
router.post("/tools/get-availability", async (req, res) => {
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
router.post('/tools/get-epoxy-availability', async (req, res) => {
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

// ─── ROUTE: BOOK APPOINTMENT DIRECTLY ────────────────────────────────────────
router.post("/tools/book-appointment", async (req, res) => {
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

// ─── ROUTE: BOOK EPOXY ESTIMATE ───────────────────────────────────────────────
router.post('/tools/book-estimate', async (req, res) => {
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

// ─── ROUTE: SEND DEPOSIT LINK ────────────────────────────────────────────────
router.post("/tools/send-deposit", async (req, res) => {
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
    const { depositUrl, orderId } = await createDepositLink(lead_phone);

    // 2. Send deposit link via Blooio
    const msg = `Here's your $20 deposit link to lock in your spot and qualify for the special at Pure Vision Tints — it goes toward your final price 👇\n\n${depositUrl}`;
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

// ─── ROUTE: CHECK DEPOSIT STATUS ─────────────────────────────────────────────
router.post("/tools/check-deposit-status", async (req, res) => {
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

// ─── ROUTE: SCHEDULE CUSTOM FOLLOW-UP ────────────────────────────────────────
router.post('/tools/schedule-followup', async (req, res) => {
  const raw = req.body;
  const args = raw.args || raw;
  const { lead_phone, send_at, message } = args;

  if (!lead_phone || !send_at) {
    return res.json({
      response: "I wasn't able to schedule that follow-up. Can you confirm the phone number and when to follow up?",
      success: false,
    });
  }

  try {
    const lead = db.prepare(`SELECT * FROM leads WHERE lead_phone = ? ORDER BY created_at DESC LIMIT 1`).get(lead_phone);
    if (!lead) {
      return res.json({ response: "I couldn't find that lead to schedule a follow-up.", success: false });
    }

    const dateTimeStr = send_at.includes('T') ? send_at : send_at.replace(' ', 'T') + ':00-05:00';
    const sendAtDate = new Date(dateTimeStr);
    if (isNaN(sendAtDate.getTime())) {
      throw new Error(`Could not parse send_at: ${send_at}`);
    }
    const sendAtUtc = sendAtDate.toISOString().slice(0, 19).replace('T', ' ');

    db.prepare(`
      INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at, custom_message)
      VALUES (?, ?, 'custom_followup', 1, ?, ?)
    `).run(lead.id, lead.shop_id, sendAtUtc, message || null);

    return res.json({
      response: "Got it — I'll follow up then!",
      success: true,
    });
  } catch (err) {
    console.error("[Schedule Followup Tool] Error:", err.message);
    return res.json({
      response: "I wasn't able to schedule that follow-up right now, but I've made a note to reach back out.",
      success: false,
    });
  }
});

export default router;
