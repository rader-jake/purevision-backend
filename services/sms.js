// ─── SENDER NUMBERS ───────────────────────────────────────────────────────────
// ShopDesk's own demos go out from the verified toll-free number; every other shop uses the main number.
export const DEMO_SHOP_ID = 'shopdesk-demo';

export function fromNumberFor(shopId) {
  return (shopId === DEMO_SHOP_ID && process.env.TWILIO_DEMO_PHONE_NUMBER) || process.env.TWILIO_PHONE_NUMBER;
}

/** True when Twilio's `To` is the demo number (i.e. someone texted the toll-free line). */
export function isDemoNumber(to) {
  const demo = process.env.TWILIO_DEMO_PHONE_NUMBER;
  return !!demo && !!to && String(to).replace(/\D/g, '').slice(-10) === demo.replace(/\D/g, '').slice(-10);
}

// ─── SEND SMS HELPER ──────────────────────────────────────────────────────────
export async function sendSMS(to, message, shopId) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = fromNumberFor(shopId);

    const params = new URLSearchParams();
    params.append('To', to);
    params.append('From', from);
    params.append('Body', message);

    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params
      }
    );

    const data = await resp.json();

    if (data.status === 'queued' || data.sid) {
      console.log('[SMS] Sent via Twilio:', data.sid);
      return { success: true, data };
    }
    console.error(`[SMS] Twilio send FAILED to ${to}:`, data.message);
    return { success: false, error: data.message };
  } catch(e) {
    console.error('[SMS] Failed:', e.message);
    return { success: false, error: e.message };
  }
}

export async function sendSMSWithPhoto(to, text, mediaUrl, shopId) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = fromNumberFor(shopId);

    const params = new URLSearchParams();
    params.append('To', to);
    params.append('From', from);
    if (text) params.append('Body', text);
    params.append('MediaUrl', mediaUrl);

    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params
      }
    );

    const data = await resp.json();

    if (data.sid) {
      console.log('[SMS Photo] Sent via Twilio:', data.sid);
      return { success: true, data };
    }
    console.error(`[SMS Photo] Twilio send FAILED to ${to}:`, data.message);
    return { success: false, error: data.message };
  } catch(e) {
    console.error('[SMS Photo] Failed:', e.message);
    return { success: false, error: e.message };
  }
}

export async function handleOwnerPingTag(reply, lead) {
  if (!reply.includes("[TRIGGER_OWNER_PING]")) return;
 
  if (!process.env.JAKE_PHONE) {
    console.error("[Owner Ping] JAKE_PHONE not set in Railway env vars — cannot notify");
    return;
  }
 
  const pingMsg = `🔥 ShopDesk lead wants a call!\n${lead.lead_name} — ${lead.lead_phone}\nIndustry: ${lead.lead_vehicle}\nChallenge: ${lead.lead_special}\n\nReply or call them directly: ${lead.lead_phone}`;
 
  const result = await sendSMS(process.env.JAKE_PHONE, pingMsg);
 
  if (result?.success !== false) {
    console.log(`[Owner Ping] Notified Jake about lead ${lead.lead_name} (${lead.lead_phone})`);
  } else {
    console.error(`[Owner Ping] Failed to notify Jake about ${lead.lead_name}`);
  }
}
