import express from "express";
import { db } from "../db/connection.js";
import { SHOP_CONFIGS } from "../config/shops.js";
import { sendSMS } from "../services/sms.js";
import { scheduleFollowUpJobs, cancelAllJobsForLead } from "../workers/follow-ups.js";

const router = express.Router();

// Legacy Retell voice-call integration, kept for reference.
export async function triggerRetellCall(lead, shop) {
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

// ─── ROUTE: RETELL CALL OUTCOME ───────────────────────────────────────────────
router.post("/webhook/retell/call-ended", async (req, res) => {
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
      const msg = `Hey ${lead.lead_name}! This is Jake from Pure Vision Tints. We tried reaching you about tinting your ${lead.lead_vehicle} but couldn't connect. Were you still interested?`;
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

// Proxy Retell call list
router.get('/dashboard/calls', async (req, res) => {
  const { agentId } = req.query;
  const resp = await fetch(`https://api.retellai.com/v2/list-calls`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, limit: 50 })
  });
  const data = await resp.json();
  res.json({ calls: data.calls || [] });
});

router.get('/dashboard/call/:callId', async (req, res) => {
  const resp = await fetch(`https://api.retellai.com/v2/get-call/${req.params.callId}`, {
    headers: { 'Authorization': `Bearer ${process.env.RETELL_API_KEY}` }
  });
  res.json(await resp.json());
});

// ─── ROUTE: SHOPDESK DEMO CALL ────────────────────────────────────────────────
router.post("/demo/call", async (req, res) => {
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

export default router;
