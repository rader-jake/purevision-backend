import crypto from "node:crypto";

const PIXEL_ID = process.env.META_PIXEL_ID || "3090696731262136";

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

// Meta wants lowercase/trimmed values, phone as digits incl. country code, then SHA-256
const hashPhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return undefined;
  return sha256(digits.length === 10 ? `1${digits}` : digits);
};
const hashName = (name) => {
  const n = String(name || "").trim().toLowerCase();
  return n && n !== "there" ? sha256(n) : undefined;
};

// Server-side "Purchase" for a PAID $20 deposit. The browser can't report this itself
// because payment happens on Square's hosted checkout, so the Square webhook calls this.
// Never throws — a Meta outage must not break booking confirmation.
export async function sendMetaDepositPurchase(lead) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) {
    console.warn("[Meta CAPI] META_CAPI_ACCESS_TOKEN not set — skipping Purchase event");
    return { skipped: true };
  }

  const user_data = {
    ph: hashPhone(lead.lead_phone) && [hashPhone(lead.lead_phone)],
    fn: hashName(lead.lead_name) && [hashName(lead.lead_name)],
    fbp: lead.meta_fbp || undefined,
    fbc: lead.meta_fbc || undefined,
    client_user_agent: lead.meta_user_agent || undefined,
    client_ip_address: lead.meta_ip || undefined,
    external_id: [sha256(String(lead.id))],
  };

  const body = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(Date.now() / 1000),
      event_id: `deposit-${lead.square_order_id}`,
      action_source: "website",
      event_source_url: lead.meta_source_url || undefined,
      user_data,
      custom_data: {
        currency: "USD",
        value: 20,
        content_name: lead.lead_special || "Deposit",
      },
    }],
  };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const resp = await fetch(
      `https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const data = await resp.json();
    if (!resp.ok) {
      console.error("[Meta CAPI] Rejected:", JSON.stringify(data));
      return { success: false, error: data };
    }
    console.log(`[Meta CAPI] Purchase sent for lead ${lead.id} — events_received: ${data.events_received}`);
    return { success: true, data };
  } catch (e) {
    console.error("[Meta CAPI] Failed:", e.message);
    return { success: false, error: e.message };
  }
}
