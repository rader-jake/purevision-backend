export const SHOP_CONFIGS = {
  "pure-vision-tints": {
    shopId:        "pure-vision-tints",
    shopName:      "Pure Vision Tints",
    smsOnly:       true,
    webhookSecret: process.env.GHL_WEBHOOK_SECRET,
    retellAgentId: process.env.RETELL_AGENT_ID,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "Vehicle Information",
      leadSpecial: "lead_special_override",
    },
  },
  "southwest-epoxy": {
    shopId:     "southwest-epoxy",
    shopName:   "Southwest Epoxy",
    retellAgentId: null,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "project_type",
      leadSpecial: "lead_special_override",
    },
  },

  "backyard-fun-pools": {
    shopId:     "backyard-fun-pools",
    shopName:   "Backyard Fun Pools",
    smsOnly:    true,
    retellAgentId: null,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "interest",         // reuse field for "Pool + Spa", "Plunge Pool", etc.
      leadSpecial: "lead_special_override",
    },
  },

  "apex-window-tinting": {
    shopId:     "apex-window-tinting",
    shopName:   "Apex Window Tinting",
    smsOnly:    true,
    retellAgentId: null,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "Vehicle Information",
      leadSpecial: "lead_special_override",
    },
  },

    "pro-auto-designs": {
    shopId:     "pro-auto-designs",
    shopName:   "Pro Auto Design",
    smsOnly:    true,
    retellAgentId: null,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "Vehicle Information",
      leadSpecial: "lead_special_override",
    },
  },

  // Public insurance adjuster — leads come from a purchased fire-incident list (not ads),
  // each with several phone numbers (see routes/fire-leads.js + lead_phones table).
  "integrity-claims": {
    shopId:     "integrity-claims",
    shopName:   "Integrity Claims",
    smsOnly:    true,
    retellAgentId: null,
    timezone:   "America/New_York",   // sending window + date table; other shops default to Central
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "address",         // property address
      leadSpecial: "incident_info",   // e.g. "House fire — 10-20-26"
    },
  },

  "shopdesk-demo": {
    shopId:     "shopdesk-demo",
    shopName:   "ShopDesk AI",
    smsOnly:    true,
    retellAgentId: null,
    fieldMapping: {
      leadName:    "first_name",
      leadPhone:   "phone",
      leadVehicle: "business_name",
      leadSpecial: "industry",
    },
  },
};

// ─── FORM ID → INDUSTRY MAPPING ──────────────────────────────────────────────
// Maps your two Meta lead form IDs to a human-readable industry label.
// Get the real form_id values from your Railway logs — look for the
// "form_id" field in the [ShopDesk Meta] Webhook received log line.
export const SHOPDESK_FORM_INDUSTRY = {
  "2150195912490394": "tint shop",        // ← replace with your real automotive/tint form_id
  "2417887732065256": "epoxy flooring business",
};

export function getShopdeskIndustryLabel(formId) {
  return SHOPDESK_FORM_INDUSTRY[formId] || "business";
}
