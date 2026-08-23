// ─── SEND SMS HELPER ──────────────────────────────────────────────────────────
export async function sendSMS(to, message) {
  try {
    const encodedTo = encodeURIComponent(to);
    const resp = await fetch(`https://backend.blooio.com/v2/api/chats/${encodedTo}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BLOOIO_API_KEY}`
      },
      body: JSON.stringify({
        text: message,
        fromNumber: process.env.BLOOIO_NUMBER
      })
    });
    const data = await resp.json();
    console.log('[SMS] Sent via Blooio:', JSON.stringify(data));
    if (data.error || data.error_message) {
      console.error('[SMS] Blooio rejected:', data.error || data.error_message);
      return { success: false, error: data.error || data.error_message };
    }
    return { success: true, data };
  } catch(e) {
    console.error('[SMS] Failed:', e.message);
    return { success: false, error: e.message };
  }
}

export async function sendSMSWithPhoto(to, text, imageUrl) {
  try {
    const encodedTo = encodeURIComponent(to);
    const resp = await fetch(`https://backend.blooio.com/v2/api/chats/${encodedTo}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BLOOIO_API_KEY}`
      },
      body: JSON.stringify({
        text: text || '',
        fromNumber: process.env.BLOOIO_NUMBER,
        attachments: [imageUrl]
      })
    });
    const data = await resp.json();
    console.log('[SMS Photo] Sent:', JSON.stringify(data));
    return data;
  } catch(e) {
    console.error('[SMS Photo] Failed:', e.message);
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
