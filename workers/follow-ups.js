import { db } from "../db/connection.js";
import { INTEGRITY_SHOP, leadFirstName } from "../services/fire-text.js";

// ─── FOLLOW-UP MESSAGE BUILDER ────────────────────────────────────────────────
export function buildFollowUpMessage(lead, jobType, attempt) {
  const name = lead.lead_name;
  const shopId = lead.shop_id;

  // Fire-damage homeowners: one gentle follow-up at most (see scheduleColdNudgeJobs), never a sales nudge.
  if (shopId === INTEGRITY_SHOP) {
    const first = leadFirstName(name);
    return jobType === 'cold_nudge'
      ? `Hi ${first}, just checking in — no rush at all. If any questions come up about your claim, I'm happy to help whenever you're ready.`
      : `Hi ${first}, just a gentle follow-up — I know this is a difficult time. If you'd ever like help with your insurance claim, I'm here at no cost to start. Wishing you and your family all the best.`;
  }

  // Booking-page visitor who got to the deposit step but hasn't paid. Plain text, no link
  // (Blooio blocks links to contacts who haven't replied yet).
  if (jobType === 'deposit_nudge') {
    const first = leadFirstName(name);
    const vehicle = lead.lead_vehicle && lead.lead_vehicle !== 'your vehicle' ? `your ${lead.lead_vehicle}` : 'your vehicle';
    return `Hey ${first}, this is Jake with Pure Vision Tints. I saw you were looking to make an appointment for ${vehicle}. Let me know if you have any questions about anything!`;
  }

  if (jobType === 'follow_up') {
    // Never replied at all
          if (shopId === 'pure-vision-tints') {
      const followUps = [
        `Hey ${name}! Just checking in, were you still wanting to tint your ${lead.lead_vehicle}?`,
        `Hi ${name}! Wanted to follow up on your tint inquiry for your ${lead.lead_vehicle}, were you still interested in getting that done?`,
        `Hey ${name}! Still interested in getting your ${lead.lead_vehicle} tinted?`,
        `Hi ${name}! Following up on your ${lead.lead_vehicle} — let me know if you'd like to get on the schedule!`,
        `Hey ${name}! Just circling back about tinting your ${lead.lead_vehicle}`,
      ];
      return followUps[Math.floor(Math.random() * followUps.length)];
    } else if (shopId === 'southwest-epoxy') {
      const msgs = [
        `Hey ${name}! Jake from Southwest Epoxy — still interested in the Spring Special? $1,499 flat for a 2-car garage, we have openings this week `,
        `Hey ${name}, just one last check-in — if the timing isn't right that's totally fine. Reach back out whenever you're ready `,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    }
  } else if (jobType === 'cold_nudge') {
    // Was replying but went quiet
    if (shopId === 'pure-vision-tints') {
      const msgs = [
        `Hey ${name}, just following up, did you have any questions?`,
        `Hey ${name}, no worries if the timing isn't right! Reach back out whenever you're ready`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    } else if (shopId === 'southwest-epoxy') {
      const msgs = [
        `Hey ${name}! Just checking back — still interested in the epoxy? Happy to lock in a time`,
        `Hey ${name}, no pressure at all! Whenever you're ready just reach back out`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    }
    } 

  return `Hey ${name}! Just checking back in, still interested?`;
}

// ─── SCHEDULE JOBS HELPER ─────────────────────────────────────────────────────
export function scheduleFollowUpJobs(leadId, shopId) {
  db.prepare(`
    INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
    VALUES (?, ?, 'follow_up', 1, datetime('now', '+48 hours'))
  `).run(leadId, shopId);

  console.log(`[Jobs] Scheduled follow-up for lead ${leadId} in 48 hours`);
}

export function scheduleColdNudgeJobs(leadId, shopId) {
  // Cancel any existing cold nudge jobs first to avoid stacking
  db.prepare(`
    UPDATE scheduled_jobs SET status = 'cancelled'
    WHERE lead_id = ? AND job_type = 'cold_nudge' AND status = 'pending'
  `).run(leadId);

  // Schedule fresh cold nudges: 24h and 48h from now. Fire-damage leads get a single, later one.
  const nudges = shopId === INTEGRITY_SHOP ? [[1, '+48 hours']] : [[1, '+24 hours'], [2, '+48 hours']];
  for (const [attempt, offset] of nudges) {
    db.prepare(`
      INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
      VALUES (?, ?, 'cold_nudge', ?, datetime('now', ?))
    `).run(leadId, shopId, attempt, offset);
  }

  console.log(`[Jobs] Scheduled ${nudges.length} cold nudge job(s) for lead ${leadId}`);
}

export function cancelAllJobsForLead(leadId) {
  const result = db.prepare(`
    UPDATE scheduled_jobs SET status = 'cancelled'
    WHERE lead_id = ? AND status = 'pending'
  `).run(leadId);
  console.log(`[Jobs] Cancelled ${result.changes} pending jobs for lead ${leadId}`);
}
