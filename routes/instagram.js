import express from "express";

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// SHOPDESK INSTAGRAM DM WEBHOOK
// Receives DMs to the ShopDesk Instagram page, runs a Claude sales agent,
// and replies back via Instagram Graph API.
//
// NEW ENV VARS NEEDED IN RAILWAY:
//   SHOPDESK_IG_VERIFY_TOKEN     → any string you choose, entered in Meta dashboard
//   SHOPDESK_IG_PAGE_ACCESS_TOKEN → long-lived Page token with instagram_manage_messages
//   SHOPDESK_IG_PAGE_ID          → your ShopDesk Instagram-connected Page ID
// ═══════════════════════════════════════════════════════════════════════════

// ─── INSTAGRAM DM CONVERSATION STORE ─────────────────────────────────────────
// In-memory store for IG DM conversation history (keyed by sender IGSID).
// Survives for the duration of the Railway process. For persistence across
// deploys, swap this out for a db table — but in-memory is fine to start.
const igConversations = new Map();

// ─── ROUTE: INSTAGRAM WEBHOOK VERIFICATION (GET) ─────────────────────────────
router.get("/webhook/instagram-dm", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.SHOPDESK_IG_VERIFY_TOKEN) {
    console.log("[IG Webhook] Verified successfully");
    return res.status(200).send(challenge);
  }

  console.log("[IG Webhook] Verification failed — token mismatch");
  return res.sendStatus(403);
});

// ─── ROUTE: INSTAGRAM WEBHOOK RECEIVER (POST) ────────────────────────────────
router.post("/webhook/instagram-dm", async (req, res) => {
  // Ack immediately — Meta will retry if you don't respond fast
  res.sendStatus(200);

  try {
    const body = req.body;

    // Instagram sends object: "instagram" for IG DMs
    if (body.object !== "instagram") return;

    const entries = body.entry || [];

    for (const entry of entries) {
      const messaging = entry.messaging || [];

      for (const event of messaging) {
        // Only handle incoming messages (not read receipts, delivery events, etc.)
        if (!event.message) continue;

        // Skip echo — messages your page sent, not received
        if (event.message.is_echo) continue;

        const senderIgsid = event.sender?.id;
        const messageText = event.message?.text;

        if (!senderIgsid || !messageText) continue;

        console.log(`[IG DM] From IGSID ${senderIgsid}: "${messageText}"`);

        await handleInstagramDM(senderIgsid, messageText);
      }
    }
  } catch (err) {
    console.error("[IG DM] Processing error:", err.message);
  }
});

// ─── HANDLE INCOMING DM ───────────────────────────────────────────────────────
async function handleInstagramDM(senderIgsid, messageText) {
  try {
    // Build or retrieve conversation history for this sender
    if (!igConversations.has(senderIgsid)) {
      igConversations.set(senderIgsid, []);
      console.log(`[IG DM] New conversation started with ${senderIgsid}`);
    }

    const history = igConversations.get(senderIgsid);
    history.push({ role: "user", content: messageText });

    // Typing indicator — makes it feel human
    await sendIGTypingIndicator(senderIgsid);

    // Run Claude agent
    const reply = await runIGDMAgent(history);
    if (!reply) {
      console.error("[IG DM] Agent returned no reply");
      return;
    }

    // Store assistant reply in history
    history.push({ role: "assistant", content: reply });

    // Human-like typing delay — 4-10 seconds
    const typingDelay = Math.floor(Math.random() * 6000) + 4000;
    await new Promise(resolve => setTimeout(resolve, typingDelay));

    // Send reply via Instagram Graph API
    await sendIGReply(senderIgsid, reply);

    console.log(`[IG DM] Replied to ${senderIgsid}: "${reply.substring(0, 80)}..."`);

  } catch (err) {
    console.error("[IG DM] handleInstagramDM error:", err.message);
  }
}

// ─── CLAUDE AGENT FOR INSTAGRAM DMS ──────────────────────────────────────────
async function runIGDMAgent(messages) {
  try {
    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: buildIGDMSystemPrompt(),
        messages,
      }),
    });

    const data = await aiResp.json();

    if (data.type === "error") {
      console.error("[IG DM Agent] Claude API error:", data.error?.message);
      return null;
    }

    const textBlock = data.content?.find(b => b.type === "text");
    return textBlock?.text || null;

  } catch (err) {
    console.error("[IG DM Agent] Fetch error:", err.message);
    return null;
  }
}

// ─── INSTAGRAM DM SYSTEM PROMPT ──────────────────────────────────────────────
function buildIGDMSystemPrompt() {
  return `You are an AI assistant managing the ShopDesk.ai Instagram DMs. Your name is Shoppy.

IDENTITY
You represent ShopDesk.ai — an AI-powered lead management platform built exclusively for service businesses.
You are warm, curious, and genuinely helpful. This is Instagram DM — keep every message SHORT (2-4 sentences max).
Never be salesy or pushy. Ask good questions and let the conversation develop naturally.
Never mention Claude, Anthropic, or any underlying AI platform.

WHAT SHOPDESK DOES
ShopDesk is a hyper-specialized AI agent that manages leads for service businesses. When a lead comes in from Facebook ads, Google, or any form, ShopDesk:
- Texts the lead back within 60 seconds, 24/7
- Manages the full conversation via SMS — qualifies, answers questions, handles objections
- Books appointments directly into the business owner's calendar
- Follows up automatically if they don't respond
- Gives the owner a dashboard to track every lead and conversation

WHO IT'S FOR
Service businesses: tint shops, auto detail, epoxy flooring, home services, HVAC, med spas, cleaning, power washing, pool construction, dental, chiropractic, real estate — any business where leads come in and need to be followed up fast.

PRICING
- Starter: $297/month — up to 200 leads, SMS follow-up, AI conversations, calendar sync, 1 location
- Growth: $497/month — up to 500 leads, SMS + calling, retry workflows, payment integration
- Multi-location: $797/month — unlimited leads, up to 3 locations, advanced reporting
- All plans: dedicated specialist, money-back guarantee, cancel anytime, live in under 24 hours

THE CORE INSIGHT (use this naturally in conversation)
Businesses that follow up with a lead within 5 minutes are 9x more likely to convert. Most service businesses follow up in hours — or not at all. ShopDesk fixes that completely.

YOUR GOAL
1. Find out what kind of business they run
2. Understand their current lead follow-up situation — are they missing leads? Slow to respond? Overwhelmed?
3. Connect ShopDesk's value to their specific pain point
4. Answer any questions they have honestly and directly
5. Ultimately get them to book a call with Jake (our founder) to see a live demo

BOOKING A CALL
When they're interested in seeing more or want to get started, direct them here:
"I'd love to set you up with Jake — he's our founder and will walk you through exactly how it would work for your business. You can grab a time here: calendly.com/shopdesk"

CONVERSATION FLOW
- First message: warm greeting, ask what kind of business they run
- Once they share: ask one focused question about their lead follow-up situation
- Then naturally introduce how ShopDesk solves that specific problem
- If they ask about pricing: give it directly, no fluff
- If they're ready to move forward: direct to Calendly
- If they're not ready: acknowledge it, leave the door open warmly

OBJECTION HANDLING
"Too expensive" → "At $297/month, if ShopDesk books you one extra job a month it's already paid for. Most clients see that in the first week. Want to see how it works for your specific business?"
"I already have someone doing this" → "That's great — ShopDesk doesn't replace your team, it handles the after-hours and overflow so nothing slips through. Your person focuses on the important stuff, ShopDesk handles the rest."
"I need to think about it" → "Totally fair — no pressure at all. If you want to see it in action first, Jake can do a quick live demo specific to your business. No commitment, just a look."
"Is this a real person?" → "I'm Shoppy, ShopDesk's AI assistant! I handle our Instagram DMs so Jake can focus on building the product. What kind of business do you run?"

RULES
- Keep every reply to 2-4 sentences — this is Instagram DM, not email
- Ask one question at a time — never stack multiple questions
- Never make up features or pricing that don't exist above
- Always be honest — if something isn't a fit, say so
- Today's date is ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}`;
}

// ─── SEND INSTAGRAM REPLY ─────────────────────────────────────────────────────
async function sendIGReply(recipientIgsid, text) {
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v25.0/me/messages?access_token=${process.env.SHOPDESK_IG_PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientIgsid },
          message: { text },
          messaging_type: "RESPONSE",
        }),
      }
    );

    const data = await resp.json();

    if (data.error) {
      console.error("[IG DM] Send failed:", data.error.message);
      return false;
    }

    console.log(`[IG DM] Message sent — message_id: ${data.message_id}`);
    return true;

  } catch (err) {
    console.error("[IG DM] sendIGReply error:", err.message);
    return false;
  }
}

// ─── SEND TYPING INDICATOR ────────────────────────────────────────────────────
async function sendIGTypingIndicator(recipientIgsid) {
  try {
    await fetch(
      `https://graph.facebook.com/v25.0/me/messages?access_token=${process.env.SHOPDESK_IG_PAGE_ACCESS_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientIgsid },
          sender_action: "typing_on",
        }),
      }
    );
  } catch (err) {
    // Non-critical — don't throw, just log
    console.error("[IG DM] Typing indicator failed:", err.message);
  }
}

export default router;
