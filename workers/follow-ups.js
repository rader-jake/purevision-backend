import { db } from "../db/connection.js";

// ─── FOLLOW-UP MESSAGE BUILDER ────────────────────────────────────────────────
export function buildFollowUpMessage(lead, jobType, attempt) {
  const name = lead.lead_name;
  const shopId = lead.shop_id;

  if (jobType === 'follow_up') {
    // Never replied at all
    if (shopId === 'pure-vision-tints') {
      const msgs = [
        `Hey ${name}! Marissa here from Pure Vision Tints — just checking if you're still thinking about tinting your ${lead.lead_vehicle}? We're currently running that Ceramic Special you asked about 👇\n[SEND_PHOTO: ceramic_special_video]`,
        `Hey ${name}, last follow-up from me — if the timing isn't right no worries at all. Reach back out whenever you're ready and we'll take care of you 🙏`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    } else if (shopId === 'southwest-epoxy') {
      const msgs = [
        `Hey ${name}! Jake from Southwest Epoxy — still interested in the Spring Special? $1,499 flat for a 2-car garage, we have openings this week 👋`,
        `Hey ${name}, just one last check-in — if the timing isn't right that's totally fine. Reach back out whenever you're ready 🙏`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    }
  } else if (jobType === 'cold_nudge') {
    // Was replying but went quiet
    if (shopId === 'pure-vision-tints') {
      const msgs = [
        `Hey ${name}! Just checking back in — still thinking about the tint? Happy to answer any questions 😊`,
        `Hey ${name}, no worries if the timing isn't right! Reach back out whenever you're ready 🙏`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    } else if (shopId === 'southwest-epoxy') {
      const msgs = [
        `Hey ${name}! Just checking back — still interested in the epoxy? Happy to lock in a time 😊`,
        `Hey ${name}, no pressure at all! Whenever you're ready just reach back out 🙏`,
      ];
      return msgs[Math.min(attempt - 1, msgs.length - 1)];
    }
    } 

  return `Hey ${name}! Just checking back in — still interested? Happy to help whenever you're ready 🙏`;
}

// ─── SCHEDULE JOBS HELPER ─────────────────────────────────────────────────────
export function scheduleFollowUpJobs(leadId, shopId) {
  // Non-responsive follow-ups: 24h and 72h after first message
  db.prepare(`
    INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
    VALUES (?, ?, 'follow_up', 1, datetime('now', '+24 hours'))
  `).run(leadId, shopId);

  db.prepare(`
    INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
    VALUES (?, ?, 'follow_up', 2, datetime('now', '+72 hours'))
  `).run(leadId, shopId);

  console.log(`[Jobs] Scheduled 2 follow-up jobs for lead ${leadId}`);
}

export function scheduleColdNudgeJobs(leadId, shopId) {
  // Cancel any existing cold nudge jobs first to avoid stacking
  db.prepare(`
    UPDATE scheduled_jobs SET status = 'cancelled'
    WHERE lead_id = ? AND job_type = 'cold_nudge' AND status = 'pending'
  `).run(leadId);

  // Schedule fresh cold nudges: 24h and 48h from now
  db.prepare(`
    INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
    VALUES (?, ?, 'cold_nudge', 1, datetime('now', '+24 hours'))
  `).run(leadId, shopId);

  db.prepare(`
    INSERT INTO scheduled_jobs (lead_id, shop_id, job_type, attempt, send_at)
    VALUES (?, ?, 'cold_nudge', 2, datetime('now', '+48 hours'))
  `).run(leadId, shopId);

  console.log(`[Jobs] Scheduled 2 cold nudge jobs for lead ${leadId}`);
}

export function cancelAllJobsForLead(leadId) {
  const result = db.prepare(`
    UPDATE scheduled_jobs SET status = 'cancelled'
    WHERE lead_id = ? AND status = 'pending'
  `).run(leadId);
  console.log(`[Jobs] Cancelled ${result.changes} pending jobs for lead ${leadId}`);
}
