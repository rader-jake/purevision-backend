import express from "express";
import { db } from "../db/connection.js";
import { SHOP_CONFIGS } from "../config/shops.js";
import { sendSMS } from "../services/sms.js";
import { gcal, getCentralHour, getCentralDateString } from "../services/calendar.js";
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
    const startDate = new Date(`${date}T${String(hour).padStart(2,'0')}:00:00-05:00`);
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

// ─── ROUTE: GET WEEK CALENDAR ────────────────────────────────────────────────
router.get('/admin/calendar-week', async (req, res) => {
  const { secret, start } = req.query;
  if (secret !== process.env.MANUAL_ENTRY_SECRET) return res.status(403).json({ error: 'Unauthorized' });

  try {
    const startDate = new Date(start + 'T00:00:00-05:00');
    const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    const response = await gcal.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = (response.data.items || []).map(e => ({
      id: e.id,
      summary: e.summary || '',
      start: e.start.dateTime || e.start.date,
      hour: getCentralHour(new Date(e.start.dateTime || e.start.date)),
      date: getCentralDateString(new Date(e.start.dateTime || e.start.date)),
      isBlocked: (e.summary || '').includes('Blocked'),
    }));

    res.json({ events });
  } catch(e) {
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

export default router;
