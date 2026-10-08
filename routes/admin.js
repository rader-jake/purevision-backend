import express from "express";
import { db } from "../db/connection.js";
import { SHOP_CONFIGS } from "../config/shops.js";
import { sendSMS } from "../services/sms.js";
import {
  gcal, getCentralHour, getCentralDateString,
  centralToDate, buildAppointmentDescription, parseAppointmentDescription,
} from "../services/calendar.js";
import { cancelAllJobsForLead } from "../workers/follow-ups.js";
import { triggerRetellCall } from "./retell.js";

const router = express.Router();

// ─── ROUTE: LOG A CALL ───────────────────────────────────────────────────────
router.post('/admin/log-call', (req, res) => {
  const { secret, lead_id, shop_id, lead_name, lead_phone, outcome, notes } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  db.prepare(`
    INSERT INTO call_logs (lead_id, shop_id, lead_name, lead_phone, outcome, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(lead_id, shop_id, lead_name, lead_phone, outcome, notes || '');

  console.log(`[Call Log] ${lead_name} — ${outcome}`);
  res.json({ success: true });
});

router.post('/admin/delete-call-logs', (req, res) => {
  const { secret, phone } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  if (phone) {
    const result = db.prepare(`DELETE FROM call_logs WHERE lead_phone = ?`).run(phone);
    return res.json({ success: true, deleted: result.changes });
  } else {
    return res.status(400).json({ error: 'Provide phone number' });
  }
});

// ─── ROUTE: TRIGGER ALL PENDING LEADS ────────────────────────────────────────
router.post("/admin/trigger-pending", async (req, res) => {
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
router.post('/admin/toggle-manual-mode', (req, res) => {
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



// CALENDAR INTEGRATION FOR JORDY vvv

// ─── ROUTE: BLOCK CALENDAR SLOT ──────────────────────────────────────────────
router.post('/admin/block-slot', async (req, res) => {
  const { secret, date, hour } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  try {
    const startDate = centralToDate(date, Number(hour));
    const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

    const event = await gcal.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: '🚫 Blocked — Personal',
        description: 'Manually blocked by Jordy via dashboard',
        start: { dateTime: startDate.toISOString(), timeZone: 'America/Chicago' },
        end:   { dateTime: endDate.toISOString(),   timeZone: 'America/Chicago' },
      }
    });

    console.log(`[Calendar] Slot blocked: ${date} ${hour}:00`);
    res.json({ success: true, eventId: event.data.id });
  } catch(e) {
    console.error('[Block Slot] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTE: UNBLOCK CALENDAR SLOT ────────────────────────────────────────────
router.post('/admin/unblock-slot', async (req, res) => {
  const { secret, eventId } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  try {
    await gcal.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId: eventId,
    });
    console.log(`[Calendar] Slot unblocked: ${eventId}`);
    res.json({ success: true });
  } catch(e) {
    console.error('[Unblock Slot] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── CALENDAR HELPERS (Jordy's appointment calendar) ─────────────────────────
const JORDY_SHOP = 'pure-vision-tints';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Normalise a typed phone number to +1XXXXXXXXXX (the format the webhooks store).
function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

// Pulls the appointment fields out of a Google event. lead_id comes from the
// private extended property we set at creation; older (AI-booked) events fall
// back to matching the phone number in the description.
function shapeEvent(e) {
  const startIso = e.start.dateTime || e.start.date;
  const startDate = new Date(startIso);
  const parsed = parseAppointmentDescription(e.description);
  let leadId = e.extendedProperties?.private?.lead_id ? Number(e.extendedProperties.private.lead_id) : null;
  if (!leadId && parsed.phone) {
    leadId = db.prepare(`SELECT id FROM leads WHERE shop_id = ? AND lead_phone = ? ORDER BY id DESC LIMIT 1`)
      .get(JORDY_SHOP, parsed.phone)?.id ?? null;
  }
  return {
    id: e.id,
    summary: e.summary || '',
    start: startIso,
    end: e.end?.dateTime || e.end?.date || null,
    hour: getCentralHour(startDate),
    date: getCentralDateString(startDate),
    isBlocked: (e.summary || '').includes('Blocked'),
    lead_id: leadId,
    vehicle: parsed.vehicle,
    service: parsed.service,
    price: parsed.price,
    phone: parsed.phone,
    notes: parsed.notes,
  };
}

// ─── ROUTE: GET WEEK CALENDAR ────────────────────────────────────────────────
router.get('/admin/calendar-week', async (req, res) => {
  const { secret, start } = req.query;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!DATE_RE.test(start || '')) return res.status(400).json({ error: 'start must be YYYY-MM-DD' });

  try {
    const startDate = centralToDate(start, 0);
    const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    const response = await gcal.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    res.json({ events: (response.data.items || []).map(shapeEvent) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTE: SEARCH LEADS (customer picker) ───────────────────────────────────
router.get('/admin/search-leads', (req, res) => {
  const { secret, q } = req.query;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  const term = String(q || '').trim();
  if (!term) return res.json({ leads: [] });

  // Escape LIKE wildcards so "50%" or "_" in a search behaves literally.
  const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
  const digits = term.replace(/\D/g, '');
  const phoneLike = digits.length >= 3 ? `%${digits}%` : like;

  const leads = db.prepare(`
    SELECT id, lead_name, lead_phone, lead_vehicle, lead_special, call_status, booked_at, created_at
    FROM leads
    WHERE shop_id = ?
      AND (lead_name LIKE ? ESCAPE '\\' OR lead_phone LIKE ? ESCAPE '\\')
    ORDER BY created_at DESC
    LIMIT 10
  `).all(JORDY_SHOP, like, phoneLike);

  res.json({ leads });
});

// ─── ROUTE: CREATE APPOINTMENT ───────────────────────────────────────────────
// Books a Google Calendar event and links it to a lead. Pass lead_id for an
// existing customer, or new_customer { name, phone, vehicle? } to create one.
router.post('/admin/create-appointment', async (req, res) => {
  const { secret, lead_id, new_customer, date, hour, title, notes, service, price, vehicle, force } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  const h = Number(hour);
  if (!DATE_RE.test(date || '') || !Number.isInteger(h) || h < 0 || h > 23) {
    return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) and hour (0-23) are required' });
  }

  try {
    // 1. Resolve the lead
    let lead;
    if (lead_id) {
      lead = db.prepare(`SELECT * FROM leads WHERE id = ? AND shop_id = ?`).get(lead_id, JORDY_SHOP);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
    } else if (new_customer) {
      const name = String(new_customer.name || '').trim();
      const phone = toE164(new_customer.phone);
      if (!name) return res.status(400).json({ error: 'Customer name is required' });
      if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
      // Reuse an existing lead with that number rather than creating a duplicate
      lead = db.prepare(`SELECT * FROM leads WHERE shop_id = ? AND lead_phone = ? ORDER BY id DESC LIMIT 1`).get(JORDY_SHOP, phone);
      if (!lead) {
        const info = db.prepare(`
          INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special)
          VALUES (?, ?, ?, ?, ?)
        `).run(JORDY_SHOP, name, phone, vehicle || new_customer.vehicle || 'your vehicle', service || 'Walk-in');
        lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(info.lastInsertRowid);
      }
    } else {
      return res.status(400).json({ error: 'lead_id or new_customer is required' });
    }

    const vehicleText = (vehicle || '').trim() || (lead.lead_vehicle && lead.lead_vehicle !== 'your vehicle' ? lead.lead_vehicle : '');
    const startDate = centralToDate(date, h);
    const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

    // 2. Don't silently double-book (a Quick Add at e.g. 10 AM overlaps the 9 and 11 slots)
    if (!force) {
      const clash = await gcal.events.list({
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,
      });
      const clashes = (clash.data.items || []).filter(e => e.status !== 'cancelled');
      if (clashes.length) {
        return res.status(409).json({
          error: `That time overlaps: ${clashes.map(e => e.summary || 'another event').join(', ')}`,
          conflicts: clashes.map(e => ({ id: e.id, summary: e.summary || '' })),
        });
      }
    }

    // 3. Create the event
    const summary = (title || '').trim() || `${lead.lead_name || 'Customer'} - ${service || 'Tint'}${price ? ` $${String(price).replace(/^\$/, '')}` : ''}`;
    const event = await gcal.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary,
        description: buildAppointmentDescription({ vehicle: vehicleText, service, price, phone: lead.lead_phone, notes }),
        start: { dateTime: startDate.toISOString(), timeZone: 'America/Chicago' },
        end:   { dateTime: endDate.toISOString(),   timeZone: 'America/Chicago' },
        extendedProperties: { private: { lead_id: String(lead.id) } },
      },
    });

    // 4. Update the lead and stop any follow-ups
    const bookedAt = `${date} ${String(h).padStart(2, '0')}:00`;
    db.prepare(`UPDATE leads SET booked_at = ?, call_status = 'booked', lead_vehicle = COALESCE(NULLIF(?, ''), lead_vehicle) WHERE id = ?`)
      .run(bookedAt, vehicleText, lead.id);
    cancelAllJobsForLead(lead.id);

    console.log(`[Calendar] Appointment created for ${lead.lead_name}: ${bookedAt} (${event.data.id})`);
    res.json({ success: true, eventId: event.data.id, lead_id: lead.id });
  } catch(e) {
    console.error('[Create Appointment] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTE: APPOINTMENT DETAILS ──────────────────────────────────────────────
router.get('/admin/appointment-details', async (req, res) => {
  const { secret, eventId } = req.query;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  try {
    const { data } = await gcal.events.get({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId });
    const appt = shapeEvent(data);
    const lead = appt.lead_id
      ? db.prepare(`SELECT id, lead_name, lead_phone, lead_vehicle, call_status, booked_at, deposit_sent, deposit_paid FROM leads WHERE id = ?`).get(appt.lead_id)
      : null;
    res.json({ success: true, appointment: { ...appt, description: data.description || '' }, lead });
  } catch(e) {
    const notFound = e.code === 404 || e.status === 404;
    res.status(notFound ? 404 : 500).json({ error: notFound ? 'Appointment not found' : e.message });
  }
});

// ─── ROUTE: UPDATE APPOINTMENT ───────────────────────────────────────────────
// Only the fields you send are changed. Keeps the 2-hour duration when moving.
router.post('/admin/update-appointment', async (req, res) => {
  const { secret, eventId, title, notes, date, hour, service, price, vehicle, force } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  try {
    const { data: existing } = await gcal.events.get({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId });
    if ((existing.summary || '').includes('Blocked')) return res.status(400).json({ error: 'Blocked slots cannot be edited' });
    const current = shapeEvent(existing);

    const requestBody = {};
    if (typeof title === 'string' && title.trim()) requestBody.summary = title.trim();

    // Rebuild the description from current values + whatever changed
    const has = (v) => v !== undefined && v !== null;
    requestBody.description = buildAppointmentDescription({
      vehicle: has(vehicle) ? vehicle : current.vehicle,
      service: has(service) ? service : current.service,
      price:   has(price)   ? price   : current.price,
      phone:   current.phone,
      notes:   has(notes)   ? notes   : current.notes,
    });

    let newBookedAt = null;
    if (has(date) || has(hour)) {
      const newDate = has(date) ? date : current.date;
      const newHour = has(hour) ? Number(hour) : current.hour;
      if (!DATE_RE.test(newDate) || !Number.isInteger(newHour) || newHour < 0 || newHour > 23) {
        return res.status(400).json({ error: 'Invalid date or hour' });
      }
      const startDate = centralToDate(newDate, newHour);
      const durationMs = existing.end?.dateTime
        ? new Date(existing.end.dateTime) - new Date(existing.start.dateTime)
        : 2 * 60 * 60 * 1000;
      const endDate = new Date(startDate.getTime() + durationMs);

      if (!force && (newDate !== current.date || newHour !== current.hour)) {
        const clash = await gcal.events.list({
          calendarId: process.env.GOOGLE_CALENDAR_ID,
          timeMin: startDate.toISOString(), timeMax: endDate.toISOString(), singleEvents: true,
        });
        const clashes = (clash.data.items || []).filter(e => e.id !== eventId && e.status !== 'cancelled');
        if (clashes.length) {
          return res.status(409).json({
            error: `That time overlaps: ${clashes.map(e => e.summary || 'another event').join(', ')}`,
            conflicts: clashes.map(e => ({ id: e.id, summary: e.summary || '' })),
          });
        }
      }
      requestBody.start = { dateTime: startDate.toISOString(), timeZone: 'America/Chicago' };
      requestBody.end   = { dateTime: endDate.toISOString(),   timeZone: 'America/Chicago' };
      newBookedAt = `${newDate} ${String(newHour).padStart(2, '0')}:00`;
    }

    await gcal.events.patch({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId, requestBody });

    if (newBookedAt && current.lead_id) {
      db.prepare(`UPDATE leads SET booked_at = ? WHERE id = ?`).run(newBookedAt, current.lead_id);
    }
    if (has(vehicle) && vehicle.trim() && current.lead_id) {
      db.prepare(`UPDATE leads SET lead_vehicle = ? WHERE id = ?`).run(vehicle.trim(), current.lead_id);
    }

    console.log(`[Calendar] Appointment updated: ${eventId}`);
    res.json({ success: true });
  } catch(e) {
    console.error('[Update Appointment] Error:', e.message);
    const notFound = e.code === 404 || e.status === 404;
    res.status(notFound ? 404 : 500).json({ error: notFound ? 'Appointment not found' : e.message });
  }
});

// ─── ROUTE: CANCEL APPOINTMENT ───────────────────────────────────────────────
router.post('/admin/cancel-appointment', async (req, res) => {
  const { secret, eventId, lead_id } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  try {
    // Look up the linked lead first (the event is gone after the delete)
    let leadId = lead_id ? Number(lead_id) : null;
    try {
      const { data } = await gcal.events.get({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId });
      if (!leadId) leadId = shapeEvent(data).lead_id;
    } catch (_) { /* already deleted — still reset the lead below */ }

    try {
      await gcal.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId });
    } catch (e) {
      if (!(e.code === 404 || e.code === 410 || e.status === 404 || e.status === 410)) throw e;
    }

    if (leadId) {
      db.prepare(`UPDATE leads SET call_status = 'pending', booked_at = NULL WHERE id = ? AND shop_id = ? AND call_status IN ('booked', 'confirmed')`).run(leadId, JORDY_SHOP);
    }
    console.log(`[Calendar] Appointment cancelled: ${eventId} (lead ${leadId ?? 'n/a'})`);
    res.json({ success: true, lead_id: leadId });
  } catch(e) {
    console.error('[Cancel Appointment] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// CALENDAR INTEGRATION FOR JORDY ^^^

// ─── ROUTE: SEND MANUAL MESSAGE ───────────────────────────────────────────────
router.post('/admin/send-message', async (req, res) => {
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
router.post('/admin/update-lead-status', (req, res) => {
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
router.post('/admin/delete-test-leads', (req, res) => {
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
router.post('/admin/deduplicate-leads', (req, res) => {
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

// DELETE ALL PENDING JOBS (ADMIN) vvv 

router.post('/admin/cancel-all-pending', (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  const result = db.prepare(`
    UPDATE scheduled_jobs SET status = 'cancelled' 
    WHERE status = 'pending'
  `).run();

  console.log(`[Admin] Cancelled ALL ${result.changes} pending jobs`);
  res.json({ success: true, cancelled: result.changes });
});

// ─── ROUTE: SEND MESSAGE WITH CLICKABLE LINK ATTACHMENT ──────────────────────
router.post('/admin/send-message-with-link', async (req, res) => {
  const { secret, lead_id, message, attachment_url } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  try {
    const encodedTo = encodeURIComponent(lead.lead_phone);
    const body = {
      text: message,
      fromNumber: process.env.BLOOIO_NUMBER,
    };

    // Use Blooio's attachment feature to make the URL clickable
    if (attachment_url) {
      body.attachments = [attachment_url];
    }

    const resp = await fetch(`https://backend.blooio.com/v2/api/chats/${encodedTo}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BLOOIO_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    console.log('[SMS Link] Sent:', JSON.stringify(data));

    if (!data.error) {
      db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
        .run(lead_id, 'outbound', `${message}\n${attachment_url}`);
      return res.json({ success: true });
    }

    res.status(500).json({ error: data.error });
  } catch(e) {
    console.error('[SMS Link] Failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTE: DELETE OUTREACH LEAD ─────────────────────────────────────────────
router.post('/admin/delete-outreach-lead', (req, res) => {
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
router.post('/admin/reset-sms', (req, res) => {
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
router.get('/admin/jobs', (req, res) => {
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

// ─── ROUTE: GET REVIVABLE LEADS ──────────────────────────────────────────────
router.get('/admin/revivable-leads', (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  const leads = db.prepare(`
    SELECT l.*, 
      (SELECT body FROM sms_messages WHERE lead_id = l.id AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1) as last_inbound,
      (SELECT body FROM sms_messages WHERE lead_id = l.id AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1) as last_outbound,
      (SELECT COUNT(*) FROM sms_messages WHERE lead_id = l.id) as msg_count
    FROM leads l
    WHERE l.shop_id = 'pure-vision-tints'
    AND l.call_status IN ('dead', 'mia')
    AND l.created_at > datetime('now', '-30 days')
    ORDER BY l.created_at DESC
  `).all();

  res.json(leads);
});

// ─── ROUTE: SEND DISCOUNT TO SPECIFIC LEAD ───────────────────────────────────
router.post('/admin/send-discount', async (req, res) => {
  const { secret, lead_id, message } = req.body;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  await sendSMS(lead.lead_phone, message);

  db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
    .run(lead.id, 'outbound', message);

  // Reactivate so AI handles their reply
  db.prepare(`UPDATE leads SET call_status = 'pending' WHERE id = ?`)
    .run(lead.id);

  console.log(`[Revive] Discount sent to ${lead.lead_name} (${lead.lead_phone})`);
  res.json({ success: true });
});

export default router;
