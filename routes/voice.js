import express from "express";
import crypto from "node:crypto";
import twilio from "twilio";
import { db } from "../db/connection.js";
import { SHOP_CONFIGS } from "../config/shops.js";
import { isValidTwilioSignature } from "../services/twilio-signature.js";
import { findLeadForInbound } from "../services/lead-lookup.js";
import { normalizePhone } from "../services/fire-text.js";
import { sendSMS, fromNumberFor, isDemoNumber, DEMO_SHOP_ID } from "../services/sms.js";
import { isWithinSendingWindow } from "../services/calendar.js";
import { DEFAULT_VOICE_SHOP, logCall, publicBase, twilioClient, voiceConfig } from "../services/voice.js";

const router = express.Router();
const { VoiceResponse } = twilio.twiml;

const VOICE = "Polly.Joanna";
const form = express.urlencoded({ extended: false });

/** Twilio webhooks only: reject anything without a valid X-Twilio-Signature. */
function twilioOnly(req, res, next) {
  if (isValidTwilioSignature(req)) return next();
  console.error(`[Voice] Rejected ${req.path} — bad or missing Twilio signature`);
  res.status(403).type("text/plain").send("Invalid signature");
}

/** Dashboard-initiated routes: same admin secret as the rest of /admin. */
function adminOnly(req, res, next) {
  const secret = req.body?.secret ?? req.query.secret;
  if (secret && secret === process.env.MANUAL_ENTRY_SECRET) return next();
  res.status(403).json({ error: "Unauthorized" });
}

const xml = (res, vr) => res.type("text/xml").send(vr.toString());
const hangup = () => new VoiceResponse().hangup();

// Leads we never ring or text back
const DO_NOT_CALL = ["opted_out", "dead", "booked", "confirmed", "claimed"];

// ═══════════════════════════════════════════════════════════════════════════
// INBOUND CALLS — ring the owner's cell; if nobody picks up: voicemail + text-back
// Point the Twilio number's "A call comes in" webhook at POST /webhook/voice/inbound.
// ═══════════════════════════════════════════════════════════════════════════

router.post("/webhook/voice/inbound", form, twilioOnly, (req, res) => {
  const { From, To, CallSid } = req.body;
  const caller = normalizePhone(From);
  const onDemoNumber = isDemoNumber(To);

  const lead = caller ? findLeadForInbound(caller, onDemoNumber ? DEMO_SHOP_ID : null) : null;
  const shopId = onDemoNumber ? DEMO_SHOP_ID : lead?.shop_id || DEFAULT_VOICE_SHOP;
  // A lead from a shop that has no voice setup yet (they share the main number) rings the default shop's owner
  const cfg = voiceConfig(shopId) || voiceConfig(DEFAULT_VOICE_SHOP);
  const logShop = voiceConfig(shopId) ? shopId : DEFAULT_VOICE_SHOP;

  const row = db.prepare(`
    INSERT INTO voice_calls (call_sid, direction, shop_id, lead_id, phone, status)
    VALUES (?, 'inbound', ?, ?, ?, 'ringing')
  `).run(CallSid, logShop, lead?.id ?? null, caller || From || null).lastInsertRowid;
  console.log(`[Voice] Inbound call from ${From} → ${logShop} (row ${row})`);

  const base = publicBase(req);
  const vr = new VoiceResponse();
  if (!cfg) {
    // No cell number configured: go straight to voicemail
    voicemailTwiml(vr, { base, row, business: "us", textBack: false });
    return xml(res, vr);
  }

  // answerOnBridge keeps the caller hearing ringing; the screening step stops the owner's carrier
  // voicemail from "answering", so a missed call is really detected.
  const dial = vr.dial({ timeout: 20, answerOnBridge: true, action: `${base}/webhook/voice/dial-done?row=${row}` });
  dial.number({ url: `${base}/webhook/voice/screen?b=${encodeURIComponent(cfg.business)}`, method: "POST" }, cfg.phone);
  xml(res, vr);
});

// Plays to the owner when they pick up: press any key to take the call (otherwise it counts as missed)
router.post("/webhook/voice/screen", form, twilioOnly, (req, res) => {
  const base = publicBase(req);
  const vr = new VoiceResponse();
  const gather = vr.gather({ numDigits: 1, timeout: 6, action: `${base}/webhook/voice/screen-ok` });
  gather.say({ voice: VOICE }, `Call for ${String(req.query.b || "your business").slice(0, 60)}. Press any key to answer.`);
  vr.hangup();
  xml(res, vr);
});

// Empty response = connect the call
router.post("/webhook/voice/screen-ok", form, twilioOnly, (req, res) => xml(res, new VoiceResponse()));

router.post("/webhook/voice/dial-done", form, twilioOnly, async (req, res) => {
  const base = publicBase(req);
  const row = db.prepare(`SELECT * FROM voice_calls WHERE id = ?`).get(Number(req.query.row));
  const status = req.body.DialCallStatus;
  const duration = Number(req.body.DialCallDuration) || 0;
  if (!row) return xml(res, hangup());

  const lead = row.lead_id ? db.prepare(`SELECT * FROM leads WHERE id = ?`).get(row.lead_id) : null;
  const name = lead?.lead_name && lead.lead_name !== "there" ? lead.lead_name : null;

  if (status === "completed" || status === "answered") {
    db.prepare(`UPDATE voice_calls SET status = 'answered', duration = ? WHERE id = ?`).run(duration, row.id);
    logCall({ leadId: row.lead_id, shopId: row.shop_id, name: name || "Caller", phone: row.phone, outcome: "connected", notes: `Inbound call · ${duration}s` });
    return xml(res, hangup());
  }

  // Nobody answered (no-answer, busy, failed, or the owner didn't press a key)
  db.prepare(`UPDATE voice_calls SET status = 'missed' WHERE id = ?`).run(row.id);
  logCall({ leadId: row.lead_id, shopId: row.shop_id, name: name || "Unknown caller", phone: row.phone, outcome: "missed_call", notes: "Inbound call · missed" });
  const cfg = voiceConfig(row.shop_id);

  const textedBack = await sendTextBack(row, lead, cfg);
  if (cfg) {
    await sendSMS(
      cfg.phone,
      `📞 Missed call from ${name || "a new caller"} (${row.phone}).${textedBack ? " I texted them back." : ""} Voicemail, if they leave one, is in your dashboard's Call History.`,
    );
  }

  const vr = new VoiceResponse();
  voicemailTwiml(vr, { base, row: row.id, business: cfg?.business || "us", textBack: textedBack });
  xml(res, vr);
});

function voicemailTwiml(vr, { base, row, business, textBack }) {
  vr.say(
    { voice: VOICE },
    `Thanks for calling ${business}. We can't pick up right now. Leave a message after the beep${textBack ? ", and we're also texting you right now" : ""}.`,
  );
  vr.record({
    maxLength: 120,
    playBeep: true,
    finishOnKey: "#",
    action: `${base}/webhook/voice/voicemail-done`,
    recordingStatusCallback: `${base}/webhook/voice/recording?row=${row}`,
    recordingStatusCallbackEvent: "completed",
  });
  vr.say({ voice: VOICE }, "Goodbye.");
  vr.hangup();
}

router.post("/webhook/voice/voicemail-done", form, twilioOnly, (req, res) => {
  const vr = new VoiceResponse();
  vr.say({ voice: VOICE }, "Thanks. Goodbye.");
  vr.hangup();
  xml(res, vr);
});

router.post("/webhook/voice/recording", form, twilioOnly, (req, res) => {
  res.sendStatus(204);
  const row = db.prepare(`SELECT * FROM voice_calls WHERE id = ?`).get(Number(req.query.row));
  const { RecordingUrl, RecordingDuration } = req.body;
  if (!row || !RecordingUrl) return;
  const seconds = Number(RecordingDuration) || 0;
  if (seconds < 2) return; // a hang-up after the beep isn't a message

  db.prepare(`UPDATE voice_calls SET voicemail_url = ?, voicemail_seconds = ? WHERE id = ?`).run(RecordingUrl, seconds, row.id);
  const lead = row.lead_id ? db.prepare(`SELECT lead_name FROM leads WHERE id = ?`).get(row.lead_id) : null;
  logCall({
    leadId: row.lead_id,
    shopId: row.shop_id,
    name: lead?.lead_name && lead.lead_name !== "there" ? lead.lead_name : "Unknown caller",
    phone: row.phone,
    outcome: "voicemail",
    notes: `Voicemail · ${seconds}s [VOICEMAIL: ${row.id}]`,
  });
});

/**
 * Texts a caller who got no answer so the AI can start the conversation. Skips unknown callers on the
 * demo line, opted-out leads, anyone already texted back in the last hour, and numbers we can't text.
 */
async function sendTextBack(row, lead, cfg) {
  const phone = normalizePhone(row.phone);
  if (!phone || !cfg) return false;
  if (lead && ["opted_out"].includes(lead.call_status)) return false;
  if (row.shop_id === DEMO_SHOP_ID && !lead) return false;

  const recent = db.prepare(`
    SELECT id FROM voice_calls
    WHERE phone = ? AND textback_sent = 1 AND created_at > datetime('now', '-1 hour') LIMIT 1
  `).get(row.phone);
  if (recent) return false;

  let target = lead;
  if (!target) {
    // New caller: they become a lead on the main shop, exactly like an unknown inbound text
    const id = db.prepare(`
      INSERT INTO leads (shop_id, lead_name, lead_phone, lead_vehicle, lead_special, call_status)
      VALUES (?, 'there', ?, 'your vehicle', 'Ceramic Special', 'pending')
    `).run(row.shop_id, phone).lastInsertRowid;
    target = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
    db.prepare(`UPDATE voice_calls SET lead_id = ? WHERE id = ?`).run(id, row.id);
  }

  const known = target.lead_name && target.lead_name !== "there";
  const greeting = known ? `Hey ${target.lead_name}!` : "Hey!";
  const message =
    row.shop_id === DEMO_SHOP_ID
      ? `${greeting} Sorry we missed your call. This is ShopDesk — what can I help you with?`
      : `${greeting} Sorry we missed your call. This is ${cfg.business} — what can we help you with today?`;

  const result = await sendSMS(phone, message, target.shop_id);
  if (result?.success === false) {
    console.error(`[Voice] Text-back to ${phone} failed`);
    return false;
  }
  db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, 'outbound', ?)`).run(target.id, message);
  db.prepare(`UPDATE voice_calls SET textback_sent = 1 WHERE id = ?`).run(row.id);
  return true;
}

// Voicemail audio for the dashboard's player. Twilio keeps recordings private, so we fetch with our credentials.
router.get("/admin/voice/recording/:row", adminOnly, async (req, res) => {
  const row = db.prepare(`SELECT voicemail_url FROM voice_calls WHERE id = ?`).get(Number(req.params.row));
  if (!row?.voicemail_url) return res.status(404).end();
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const audio = await fetch(`${row.voicemail_url}.mp3`, { headers: { Authorization: `Basic ${auth}` } });
  if (!audio.ok) return res.status(502).end();
  res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" });
  res.send(Buffer.from(await audio.arrayBuffer()));
});

// ═══════════════════════════════════════════════════════════════════════════
// CLICK-TO-CALL — ring the owner's cell first, then dial the lead and bridge the two
// ═══════════════════════════════════════════════════════════════════════════

router.post("/admin/voice/call", adminOnly, async (req, res) => {
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(Number(req.body.lead_id));
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const cfg = voiceConfig(lead.shop_id);
  if (!cfg) return res.status(400).json({ error: "Calling isn't set up for this shop yet" });
  const phone = normalizePhone(lead.lead_phone);
  if (!phone) return res.status(400).json({ error: "This lead doesn't have a valid phone number" });
  if (lead.call_status === "opted_out") return res.status(400).json({ error: "This lead opted out" });

  const row = db.prepare(`
    INSERT INTO voice_calls (direction, shop_id, lead_id, phone, status)
    VALUES ('outbound', ?, ?, ?, 'ringing_owner')
  `).run(lead.shop_id, lead.id, phone).lastInsertRowid;

  const base = publicBase(req);
  try {
    const call = await twilioClient().calls.create({
      to: cfg.phone,
      from: fromNumberFor(lead.shop_id),
      url: `${base}/webhook/voice/bridge?row=${row}`,
      statusCallback: `${base}/webhook/voice/owner-status?row=${row}`,
      statusCallbackEvent: ["completed"],
      timeout: 30,
    });
    db.prepare(`UPDATE voice_calls SET call_sid = ? WHERE id = ?`).run(call.sid, row);
    console.log(`[Voice] Click-to-call: ringing ${cfg.name}'s cell to reach ${lead.lead_name} (row ${row})`);
    res.json({ success: true, call_id: row });
  } catch (e) {
    console.error("[Voice] Click-to-call failed:", e.message);
    db.prepare(`UPDATE voice_calls SET status = 'failed' WHERE id = ?`).run(row);
    res.status(502).json({ error: "Couldn't place the call — check Twilio" });
  }
});

// Fetched by Twilio once the owner picks up
router.post("/webhook/voice/bridge", form, twilioOnly, (req, res) => {
  const row = db.prepare(`SELECT * FROM voice_calls WHERE id = ?`).get(Number(req.query.row));
  if (!row) return xml(res, hangup());
  const lead = db.prepare(`SELECT lead_name FROM leads WHERE id = ?`).get(row.lead_id);
  db.prepare(`UPDATE voice_calls SET status = 'dialing_lead' WHERE id = ?`).run(row.id);

  const vr = new VoiceResponse();
  vr.say({ voice: VOICE }, `Calling ${lead?.lead_name && lead.lead_name !== "there" ? lead.lead_name : "your lead"}.`);
  const dial = vr.dial({
    callerId: fromNumberFor(row.shop_id),
    answerOnBridge: true,
    timeout: 30,
    action: `${publicBase(req)}/webhook/voice/bridge-done?row=${row.id}`,
  });
  dial.number(row.phone);
  xml(res, vr);
});

router.post("/webhook/voice/bridge-done", form, twilioOnly, (req, res) => {
  const row = db.prepare(`SELECT * FROM voice_calls WHERE id = ?`).get(Number(req.query.row));
  xml(res, hangup());
  if (!row) return;
  const status = req.body.DialCallStatus;
  const duration = Number(req.body.DialCallDuration) || 0;
  const lead = db.prepare(`SELECT lead_name FROM leads WHERE id = ?`).get(row.lead_id);
  const connected = status === "completed" || status === "answered";

  db.prepare(`UPDATE voice_calls SET status = ?, duration = ? WHERE id = ?`).run(connected ? "answered" : status, duration, row.id);
  logCall({
    leadId: row.lead_id,
    shopId: row.shop_id,
    name: lead?.lead_name,
    phone: row.phone,
    outcome: connected ? "connected" : "no_answer",
    notes: connected ? `Click-to-call · ${duration}s` : `Click-to-call · ${status}`,
  });
});

// The owner leg's final status: tells us if they never picked up
router.post("/webhook/voice/owner-status", form, twilioOnly, (req, res) => {
  res.sendStatus(204);
  const status = req.body.CallStatus;
  if (status === "completed") return;
  db.prepare(`UPDATE voice_calls SET status = ? WHERE id = ? AND status = 'ringing_owner'`).run(`owner_${status}`, Number(req.query.row));
});

// ═══════════════════════════════════════════════════════════════════════════
// POWER DIALER — the owner joins a conference; leads are dialed one at a time and dropped into it
// when a human answers. Answering machines are hung up on. After a real conversation it waits for
// "Next lead" so there's time to log notes; after no-answer/voicemail it moves on by itself.
// Sessions live in memory (one Railway instance); a restart ends them.
// ═══════════════════════════════════════════════════════════════════════════

const sessions = new Map();
const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const MAX_QUEUE = 200;
const AUTO_ADVANCE_MS = 3000;

const confName = (s) => `dialer-${s.id}`;

function snapshot(s) {
  return {
    id: s.id,
    shop_id: s.shopId,
    state: s.state, // starting | dialing | connected | between | wrapup | paused | finished
    paused: s.paused,
    message: s.message,
    index: s.index,
    total: s.queue.length,
    current: s.current,
    results: s.results,
  };
}

function activeSession(shopId) {
  return [...sessions.values()].find((s) => s.shopId === shopId && s.state !== "finished");
}

async function hangUpCall(sid) {
  if (!sid) return;
  for (const status of ["completed", "canceled"]) {
    try {
      await twilioClient().calls(sid).update({ status });
      return;
    } catch {
      /* wrong status for the call's current state, try the other */
    }
  }
}

async function finish(s, message) {
  if (s.state === "finished") return;
  s.state = "finished";
  s.message = message;
  s.current = null;
  await Promise.all([hangUpCall(s.leadCallSid), hangUpCall(s.ownerCallSid)]);
  console.log(`[Dialer ${s.id}] Finished — ${message}`);
}

async function dialNext(s) {
  if (s.state === "finished" || s.dialing) return;
  if (s.paused) {
    s.state = "paused";
    return;
  }
  const tz = SHOP_CONFIGS[s.shopId]?.timezone;
  if (!isWithinSendingWindow(tz)) {
    s.paused = true;
    s.state = "paused";
    s.message = "Paused: outside calling hours (8 AM–8 PM)";
    return;
  }

  s.index += 1;
  if (s.index >= s.queue.length) return finish(s, "Queue complete");
  const item = s.queue[s.index];

  // Things may have changed since the queue was built (they opted out, booked, ...)
  const fresh = db.prepare(`SELECT call_status FROM leads WHERE id = ?`).get(item.lead_id);
  if (!fresh || DO_NOT_CALL.includes(fresh.call_status)) {
    s.results.push({ ...item, outcome: "skipped" });
    return dialNext(s);
  }

  s.current = item;
  s.state = "dialing";
  s.message = `Calling ${item.name}…`;
  s.dialing = true;
  s.connected = false;
  s.machine = false;
  s.skipping = false;

  try {
    const q = `s=${s.id}&i=${s.index}`;
    const call = await twilioClient().calls.create({
      to: item.phone,
      from: fromNumberFor(s.shopId),
      url: `${s.base}/webhook/voice/dialer/lead?${q}`,
      statusCallback: `${s.base}/webhook/voice/dialer/lead-status?${q}`,
      statusCallbackEvent: ["completed"],
      machineDetection: "Enable",
      machineDetectionTimeout: 8,
      timeout: 25,
    });
    s.leadCallSid = call.sid;
  } catch (e) {
    console.error(`[Dialer ${s.id}] Couldn't dial ${item.phone}:`, e.message);
    s.dialing = false;
    s.results.push({ ...item, outcome: "failed" });
    setTimeout(() => dialNext(s), AUTO_ADVANCE_MS);
  }
}

router.post("/admin/voice/dialer/start", adminOnly, async (req, res) => {
  const { shop_id: shopId, lead_ids: leadIds } = req.body;
  const cfg = voiceConfig(shopId);
  if (!cfg) return res.status(400).json({ error: "Calling isn't set up for this shop yet" });
  const existing = activeSession(shopId);
  if (existing) return res.status(409).json({ error: "A dialer session is already running", session: snapshot(existing) });
  if (!isWithinSendingWindow(SHOP_CONFIGS[shopId]?.timezone)) {
    return res.status(400).json({ error: "Outside calling hours (8 AM–8 PM)" });
  }
  if (!Array.isArray(leadIds) || !leadIds.length) return res.status(400).json({ error: "Pick at least one lead" });

  // Build the queue in the order given: this shop's leads, with a valid number, not do-not-call, no repeats
  const seen = new Set();
  const queue = [];
  for (const id of leadIds.slice(0, MAX_QUEUE)) {
    const lead = db.prepare(`SELECT * FROM leads WHERE id = ? AND shop_id = ?`).get(Number(id), shopId);
    const phone = normalizePhone(lead?.lead_phone);
    if (!lead || !phone || seen.has(phone) || DO_NOT_CALL.includes(lead.call_status)) continue;
    seen.add(phone);
    queue.push({ lead_id: lead.id, name: lead.lead_name || "Lead", phone });
  }
  if (!queue.length) return res.status(400).json({ error: "None of those leads can be called" });

  // Forget old finished sessions
  for (const [id, s] of sessions) if (s.state === "finished" && Date.now() - s.startedAt > SESSION_MAX_AGE_MS) sessions.delete(id);

  const s = {
    id: crypto.randomBytes(6).toString("hex"),
    shopId,
    queue,
    index: -1,
    state: "starting",
    paused: false,
    message: `Calling ${cfg.name}'s cell — pick up to start`,
    current: null,
    results: [],
    base: publicBase(req),
    startedAt: Date.now(),
  };
  sessions.set(s.id, s);

  try {
    const call = await twilioClient().calls.create({
      to: cfg.phone,
      from: fromNumberFor(shopId),
      url: `${s.base}/webhook/voice/dialer/owner?s=${s.id}`,
      statusCallback: `${s.base}/webhook/voice/dialer/owner-status?s=${s.id}`,
      statusCallbackEvent: ["completed"],
      timeout: 30,
    });
    s.ownerCallSid = call.sid;
    console.log(`[Dialer ${s.id}] Started for ${shopId}: ${queue.length} leads`);
    res.json({ success: true, session: snapshot(s) });
  } catch (e) {
    console.error("[Dialer] Couldn't ring the owner:", e.message);
    s.state = "finished";
    res.status(502).json({ error: "Couldn't place the call — check Twilio" });
  }
});

router.get("/admin/voice/dialer/active", adminOnly, (req, res) => {
  const s = activeSession(String(req.query.shop_id));
  res.json({ session: s ? snapshot(s) : null });
});

router.get("/admin/voice/dialer/:id", adminOnly, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json({ session: snapshot(s) });
});

router.post("/admin/voice/dialer/:id/action", adminOnly, async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  const action = req.body.action;
  if (s.state === "finished") return res.json({ session: snapshot(s) });

  if (action === "pause") {
    s.paused = true;
    if (s.state === "between" || s.state === "wrapup") s.state = "paused";
    if (s.state !== "dialing" && s.state !== "connected") s.message = "Paused";
  } else if (action === "resume" || action === "next") {
    s.paused = false;
    if (["between", "wrapup", "paused"].includes(s.state) && !s.dialing) dialNext(s);
  } else if (action === "skip") {
    if (s.dialing) {
      s.skipping = true; // the lead's status callback will dial the next one
      await hangUpCall(s.leadCallSid);
    } else if (["between", "wrapup", "paused"].includes(s.state)) {
      s.paused = false;
      dialNext(s);
    }
  } else if (action === "stop") {
    await finish(s, "Stopped");
  } else {
    return res.status(400).json({ error: "Unknown action" });
  }
  res.json({ session: snapshot(s) });
});

// Owner picked up: put them in the conference, then start dialing
router.post("/webhook/voice/dialer/owner", form, twilioOnly, (req, res) => {
  const s = sessions.get(String(req.query.s));
  if (!s || s.state === "finished") {
    const vr = new VoiceResponse();
    vr.say({ voice: VOICE }, "This dialer session has ended.");
    vr.hangup();
    return xml(res, vr);
  }
  s.state = "between";
  s.message = "Connected — dialing your first lead";

  const vr = new VoiceResponse();
  vr.say({ voice: VOICE }, "ShopDesk dialer. Dialing your first lead.");
  vr.dial().conference(
    { beep: "false", startConferenceOnEnter: true, endConferenceOnExit: true, waitUrl: "" },
    confName(s),
  );
  xml(res, vr);
  setTimeout(() => dialNext(s), 2500);
});

// The owner's call ended (they hung up, or it never connected): end the session
router.post("/webhook/voice/dialer/owner-status", form, twilioOnly, (req, res) => {
  res.sendStatus(204);
  const s = sessions.get(String(req.query.s));
  if (!s || s.state === "finished") return;
  const status = req.body.CallStatus;
  finish(s, status === "completed" ? "You hung up" : "Your phone didn't pick up");
});

// Fetched when a lead's phone is answered (after answering-machine detection)
router.post("/webhook/voice/dialer/lead", form, twilioOnly, (req, res) => {
  const s = sessions.get(String(req.query.s));
  if (!s || s.state === "finished" || Number(req.query.i) !== s.index) return xml(res, hangup());

  if (/^(machine|fax)/.test(req.body.AnsweredBy || "")) {
    s.machine = true;
    return xml(res, hangup());
  }
  s.connected = true;
  s.state = "connected";
  s.message = `On the line with ${s.current?.name}`;
  const vr = new VoiceResponse();
  vr.dial().conference({ beep: "false", startConferenceOnEnter: false, endConferenceOnExit: false }, confName(s));
  xml(res, vr);
});

// The lead's call ended, whatever happened
router.post("/webhook/voice/dialer/lead-status", form, twilioOnly, (req, res) => {
  res.sendStatus(204);
  const s = sessions.get(String(req.query.s));
  if (!s || Number(req.query.i) !== s.index || !s.dialing) return;
  const item = s.current;
  const seconds = Number(req.body.CallDuration) || 0;

  const outcome = s.connected ? "connected" : s.machine ? "voicemail" : "no_answer";
  s.results.push({ ...item, outcome, seconds });
  logCall({
    leadId: item.lead_id,
    shopId: s.shopId,
    name: item.name,
    phone: item.phone,
    outcome,
    notes: outcome === "connected" ? `Power dialer · ${seconds}s` : `Power dialer · ${outcome === "voicemail" ? "answering machine" : req.body.CallStatus}`,
  });
  s.dialing = false;
  s.leadCallSid = null;
  if (s.state === "finished") return;

  if (s.connected && !s.skipping) {
    // Time to log notes / book before the next call
    s.state = "wrapup";
    s.message = `Call with ${item.name} ended — tap Next lead when you're ready`;
  } else {
    s.state = "between";
    s.message = "Next lead in a moment…";
    setTimeout(() => dialNext(s), AUTO_ADVANCE_MS);
  }
});

export default router;
