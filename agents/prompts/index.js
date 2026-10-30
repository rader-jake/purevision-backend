import { buildSouthwestEpoxyPrompt } from "./southwest-epoxy.js";
import { buildBackyardPoolsPrompt } from "./backyard-pools.js";
import { buildShopdeskDemoPrompt } from "./shopdesk-demo.js";
import { buildApexTintingPrompt } from "./apex-tinting.js";
import { buildPureVisionPrompt } from "./pure-vision.js";
import { buildProAutoDesignsPrompt } from "./pro-auto-designs.js";
import { buildIntegrityClaimsPrompt } from "./integrity-claims.js";

// Separates individual text messages inside one AI reply (see splitReply in routes/webhooks.js).
export const SPLIT_TAG = '[SPLIT]';

// Added to every shop's prompt.
const TEXTING_STYLE = `

MULTIPLE MESSAGES
- Customers often send several short texts in a row. Read every message they sent since your last reply as one thought and answer all of their questions and comments.
- You may reply with up to 3 separate texts, the way people actually text. Put ${SPLIT_TAG} on its own line between them. Use it when you're answering separate questions or when a thought naturally breaks in two. For a simple reply, send one text with no ${SPLIT_TAG}.
- Keep each text short. Never split in the middle of a sentence, a list, or an address.
- Example: customer sends "You guys offer a lifetime warranty?" then "Also, where you guys located?". Reply:
Yes, lifetime warranty on all our work
${SPLIT_TAG}
We're located at [the shop's address]`;

// ─── SMS SYSTEM PROMPT ────────────────────────────────────────────────────────
export function buildSMSSystemPrompt(lead) {
  return buildShopPrompt(lead) + TEXTING_STYLE;
}

function buildShopPrompt(lead) {
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

  if (lead.shop_id === 'pro-auto-designs') {
    return buildProAutoDesignsPrompt(lead);
  }

  if (lead.shop_id === 'integrity-claims') {
    return buildIntegrityClaimsPrompt(lead);
  }

  return buildPureVisionPrompt(lead);
}
