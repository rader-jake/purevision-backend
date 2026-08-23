import { buildSMSSystemPrompt } from "./prompts/index.js";

// ─── SMS TOOLS ────────────────────────────────────────────────────────────────
const smsTools = [
  {
    name: "get_availability",
    description: "Check available appointment slots for a given date",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" }
      },
      required: ["date"]
    }
  },
  {
    name: "book_appointment",
    description: "Book an appointment for the lead",
    input_schema: {
      type: "object",
      properties: {
        lead_name:        { type: "string" },
        lead_phone:       { type: "string" },
        lead_vehicle:     { type: "string" },
        lead_special:     { type: "string" },
        appointment_time: { type: "string", description: "Format: YYYY-MM-DD HH:mm" }
      },
      required: ["lead_name", "lead_phone", "lead_vehicle", "lead_special", "appointment_time"]
    }
  }
];

// ─── SMS TOOL ─────────────────────────────────────────────────────────────────
export function getSMSTools(lead) {
  if (lead.shop_id === 'southwest-epoxy') {
    return [
      {
        name: "get_epoxy_availability",
        description: "Check available estimate slots for a given date",
        input_schema: {
          type: "object",
          properties: {
            date: { type: "string", description: "Date in YYYY-MM-DD format" }
          },
          required: ["date"]
        }
      },
      {
        name: "book_estimate",
        description: "Book a free in-home estimate for the lead",
        input_schema: {
          type: "object",
          properties: {
            lead_name:        { type: "string" },
            lead_phone:       { type: "string" },
            lead_address:     { type: "string", description: "Full address where estimate will take place" },
            project_type:     { type: "string" },
            appointment_time: { type: "string", description: "Format: YYYY-MM-DD HH:mm" }
          },
          required: ["lead_name", "lead_phone", "lead_address", "appointment_time"]
        }
      }
    ];
  }
  if (lead.shop_id === 'backyard-fun-pools') {
    return []; // No calendar tools for demo — just conversation
  }

  if (lead.shop_id === 'shopdesk-demo') {
    return []; // No tools for demo agent
  }
    return [
      ...smsTools,
      {
        name: "send_deposit",
        description: "Send a $20 Square deposit link to the customer to lock in their appointment and qualify for the special",
        input_schema: {
          type: "object",
          properties: {
            lead_name:  { type: "string" },
            lead_phone: { type: "string" },
          },
          required: ["lead_name", "lead_phone"]
        }
      },
      {
        name: "check_deposit_status",
        description: "Check if the customer has completed their deposit payment",
        input_schema: {
          type: "object",
          properties: {
            lead_phone: { type: "string" },
          },
          required: ["lead_phone"]
        }
      },
      {
        name: "schedule_followup",
        description: "Schedule a custom follow-up text to be sent at a specific future time, for when the lead asks to be followed up with later (e.g. 'text me next week', 'check back in a few days')",
        input_schema: {
          type: "object",
          properties: {
            lead_phone: { type: "string" },
            send_at:    { type: "string", description: "Format: YYYY-MM-DD HH:mm — when to send the follow-up" },
            message:    { type: "string", description: "The custom follow-up message to send" }
          },
          required: ["lead_phone", "send_at"]
        }
      }
    ];
}

// ─── SMS AGENT LOOP ───────────────────────────────────────────────────────────
function sanitizeMessages(messages) {
  const cleaned = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some(b => b.type === 'tool_use');
      if (hasToolUse) {
        const next = messages[i + 1];
        const nextHasToolResult = next?.role === 'user' &&
          Array.isArray(next?.content) &&
          next.content.some(b => b.type === 'tool_result');
        if (!nextHasToolResult) {
          console.log('[SMS Agent] Skipping orphaned tool_use block');
          i++;
          continue;
        }
      }
    }
    cleaned.push(msg);
  }
  return cleaned;
}

export async function runSMSAgent(messages, lead) {
  let currentMessages = sanitizeMessages([...messages]);
  const tools = getSMSTools(lead);

  while (true) {
    const requestBody = {
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: buildSMSSystemPrompt(lead),
      messages: currentMessages
    };
    if (tools.length > 0) requestBody.tools = tools;

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    const aiData = await aiResp.json();
    console.log('[SMS Agent] Claude response:', JSON.stringify(aiData, null, 2));

    if (aiData.type === 'error') {
      console.error('[SMS Agent] Claude API error:', aiData.error?.message);
      return null;
    }

    const { content, stop_reason } = aiData;

    if (stop_reason === 'tool_use') {
      const endpointMap = {
        'get_availability':       'get-availability',
        'book_appointment':       'book-appointment',
        'get_epoxy_availability': 'get-epoxy-availability',
        'book_estimate':          'book-estimate',
        'send_deposit':           'send-deposit',
        'check_deposit_status':   'check-deposit-status',
        'schedule_followup':      'schedule-followup',
      };

      // Handle ALL tool_use blocks in this response (Claude can return multiple)
      const toolUses = content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        let toolResult;
        try {
          const endpoint = endpointMap[toolUse.name];
          if (!endpoint) {
            toolResult = { error: `Unknown tool: ${toolUse.name}` };
          } else {
            const toolResp = await fetch(
              `https://purevision-backend-production.up.railway.app/tools/${endpoint}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(toolUse.input)
              }
            );
            toolResult = await toolResp.json();
          }
        } catch(e) {
          toolResult = { error: 'Tool call failed: ' + e.message };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult)
        });
      }

      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content },
        { role: 'user', content: toolResults }
      ];
      continue;
    }

    const textBlock = content.find(b => b.type === 'text');
    return textBlock?.text || null;
  }
}
