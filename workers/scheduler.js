import { db } from "../db/connection.js";
import { sendSMS, sendSMSWithPhoto } from "../services/sms.js";
import { photoMap } from "../services/photo-map.js";
import { isWithinSendingWindow, minutesUntil8AM } from "../services/calendar.js";
import { buildFollowUpMessage } from "./follow-ups.js";

// ─── BACKGROUND JOB WORKER ───────────────────────────────────────────────────
export async function processScheduledJobs() {
  const jobs = db.prepare(`
    SELECT * FROM scheduled_jobs
    WHERE status = 'pending'
    AND send_at <= datetime('now')
    ORDER BY send_at ASC
    LIMIT 10
  `).all();

  if (!jobs.length) return;

  console.log(`[Worker] Processing ${jobs.length} scheduled jobs`);

  for (const job of jobs) {
    try {
      // Mark as processing to prevent double-fire
      db.prepare(`UPDATE scheduled_jobs SET status = 'processing' WHERE id = ?`).run(job.id);

      const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(job.lead_id);

      if (!lead) {
        db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
        continue;
      }

      // Skip if lead is in a terminal state
      const skipStatuses = ['booked', 'dead', 'mia', 'opted_out'];
      if (skipStatuses.includes(lead.call_status)) {
        db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
        console.log(`[Worker] Skipping job ${job.id} — lead ${lead.lead_name} is ${lead.call_status}`);
        continue;
      }

      if (job.job_type === 'follow_up') {
        // Check if lead has ever replied
        const hasReplied = db.prepare(`
          SELECT id FROM sms_messages
          WHERE lead_id = ? AND direction = 'inbound' LIMIT 1
        `).get(job.lead_id);

        if (hasReplied) {
          db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
          console.log(`[Worker] Skipping follow_up for ${lead.lead_name} — they replied`);
          continue;
        }
      }

      if (job.job_type === 'cold_nudge') {
        // Check last inbound message — if they replied recently skip
        const lastInbound = db.prepare(`
          SELECT created_at FROM sms_messages
          WHERE lead_id = ? AND direction = 'inbound'
          ORDER BY created_at DESC LIMIT 1
        `).get(job.lead_id);

        if (lastInbound) {
          const hoursSince = (Date.now() - new Date(lastInbound.created_at)) / (1000 * 60 * 60);
          if (hoursSince < 20) {
            db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
            console.log(`[Worker] Skipping cold_nudge for ${lead.lead_name} — replied ${Math.round(hoursSince)}h ago`);
            continue;
          }
        } else {
          // No reply ever — this should be a follow_up not cold_nudge, cancel
          db.prepare(`UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
          continue;
        }
      }

      // custom_followup: no reply-based skip — the lead was explicitly promised
      // a follow-up at this time, so always send it (unless in a terminal state,
      // already handled above).

      // Check sending window — if outside, reschedule for 8AM
      if (!isWithinSendingWindow()) {
        const minsUntil8 = minutesUntil8AM();
        db.prepare(`
          UPDATE scheduled_jobs
          SET send_at = datetime('now', '+' || ? || ' minutes'), status = 'pending'
          WHERE id = ?
        `).run(minsUntil8, job.id);
        console.log(`[Worker] Job ${job.id} rescheduled for 8AM (${minsUntil8} mins)`);
        continue;
      }

      // Build and send the message
      const msg = job.job_type === 'custom_followup'
        ? (job.custom_message || buildFollowUpMessage(lead, job.job_type, job.attempt))
        : buildFollowUpMessage(lead, job.job_type, job.attempt);

      // Extract and send photos first
      const photoMatches = msg.match(/\[SEND_PHOTO: (\w+)\]/g) || [];
      for (const match of photoMatches) {
        const key = match.match(/\[SEND_PHOTO: (\w+)\]/)[1];
        if (photoMap[key]) {
          await sendSMSWithPhoto(lead.lead_phone, '', photoMap[key]);
        }
      }

      // Send clean text (strip photo tags for SMS)
      const cleanMsg = msg.replace(/\[SEND_PHOTO: \w+\]/g, '').trim();
      const smsResult = cleanMsg ? await sendSMS(lead.lead_phone, cleanMsg) : { success: true };

      if (smsResult?.success !== false) {
        db.prepare(`INSERT INTO sms_messages (lead_id, direction, body) VALUES (?, ?, ?)`)
          .run(lead.id, 'outbound', msg);
        db.prepare(`UPDATE scheduled_jobs SET status = 'sent' WHERE id = ?`).run(job.id);

        // Mark MIA after final attempt (not for custom_followup — that's a
        // one-off promised follow-up, not part of the non-response sequence)
        if (job.job_type !== 'custom_followup' && job.attempt >= 2) {
          db.prepare(`UPDATE leads SET call_status = 'mia' WHERE id = ?`).run(lead.id);
          console.log(`[Worker] Lead ${lead.lead_name} marked MIA after final ${job.job_type} attempt`);
        }

        console.log(`[Worker] Sent ${job.job_type} attempt ${job.attempt} to ${lead.lead_name}`);
      } else {
        db.prepare(`UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?`).run(job.id);
        console.error(`[Worker] SMS failed for job ${job.id}`);
      }

    } catch(e) {
      console.error(`[Worker] Error processing job ${job.id}:`, e.message);
      db.prepare(`UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?`).run(job.id);
    }
  }
}

export function startScheduler() {
  // Run worker every 5 minutes
  setInterval(processScheduledJobs, 5 * 60 * 1000);
  console.log('[Worker] Background job processor started — runs every 5 minutes');
}
