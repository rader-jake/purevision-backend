import { buildSouthwestEpoxyPrompt } from "./southwest-epoxy.js";
import { buildBackyardPoolsPrompt } from "./backyard-pools.js";
import { buildShopdeskDemoPrompt } from "./shopdesk-demo.js";
import { buildApexTintingPrompt } from "./apex-tinting.js";
import { buildPureVisionPrompt } from "./pure-vision.js";

// ─── SMS SYSTEM PROMPT ────────────────────────────────────────────────────────
export function buildSMSSystemPrompt(lead) {
  if (lead.shop_id === 'southwest-epoxy') {
    return buildSouthwestEpoxyPrompt(lead);
  }

  if (lead.shop_id === 'backyard-fun-pools') {
    return buildBackyardPoolsPrompt(lead);
  }

  if (lead.shop_id === 'shopdesk-demo') {
    return buildShopdeskDemoPrompt(lead);
  }

  if (lead.shop_id === 'apex-window-tinting') {
    return buildApexTintingPrompt(lead);
  }

  return buildPureVisionPrompt(lead);
}
