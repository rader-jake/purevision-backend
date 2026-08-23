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
