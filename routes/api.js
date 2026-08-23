import express from "express";
import { google } from "googleapis";
import { db } from "../db/connection.js";

const router = express.Router();

// ─── ROUTE: HEALTH CHECK ──────────────────────────────────────────────────────
router.get("/health", (_, res) => res.json({ status: "ok" }));

// ─── ROUTE: GET CALL LOGS ────────────────────────────────────────────────────
router.get('/api/call-logs/:shopId', (req, res) => {
  const { password } = req.query;
  if (password !== 'purevision2026') return res.status(401).json({ error: 'Unauthorized' });

  const logs = db.prepare(`
    SELECT * FROM call_logs WHERE shop_id = ? ORDER BY created_at DESC
  `).all(req.params.shopId);

  res.json(logs);
});

// ─── JORDY SMS CONVERSATIONS ──────────────────────────────────────────────────
router.get('/api/conversations/pure-vision-tints', async (req, res) => {
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
router.get('/api/conversations/apex-window-tinting', async (req, res) => {
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
router.get('/dashboard/data/:shopId', async (req, res) => {
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
router.get('/api/conversations/shopdesk-demo', async (req, res) => {
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

router.get('/api/conversations/backyard-fun-pools', async (req, res) => {
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
router.get('/api/conversations/:shopId', async (req, res) => {
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
router.get("/api/leads/:shopId", (req, res) => {
  const leads = db.prepare(`SELECT * FROM leads WHERE shop_id = ? ORDER BY created_at DESC`).all(req.params.shopId);
  res.json(leads);
});

// ─── OUTREACH CRM ROUTES ──────────────────────────────────────────────────────
router.get('/leads', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM outreach_leads ORDER BY added DESC').all());
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/leads', (req, res) => {
  try {
    const { id, name, biz, phone, vertical, city, notes, status, touch, added } = req.body;
    db.prepare(`
      INSERT INTO outreach_leads (id, name, biz, phone, vertical, city, notes, status, touch, added)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, biz, phone, vertical, city, notes, status || 'new', touch || 1, added);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.patch('/leads/:id', (req, res) => {
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

router.delete('/leads/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM outreach_leads WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTE: WEBSITE CHAT ──────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
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

export default router;
