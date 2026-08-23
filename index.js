import "dotenv/config";
import express from "express";
import cors from "cors";
// import { runSocialPost, postToInstagram, postToFacebook } from './social-post.js';


const app = express();
import "./db/init.js";
import {
  gcal,
  getCentralDateString,
  getCentralHour,
} from "./services/calendar.js";
import { startScheduler } from "./workers/scheduler.js";
startScheduler();

app.use('/webhook/sms/inbound', express.raw({ type: 'application/json' }));

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());

app.use(cors({
  origin: ["https://shopdesk.ai", "https://www.shopdesk.ai", "http://localhost:3000", "null"],
  methods: ["GET", "POST", "PATCH", "DELETE"],
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

import apiRouter from "./routes/api.js";
app.use(apiRouter);

import toolsRouter from "./routes/tools.js";
app.use(toolsRouter);

import retellRouter from "./routes/retell.js";
app.use(retellRouter);

import adminRouter from "./routes/admin.js";
app.use(adminRouter);

// routes/social.js is built but not mounted — social-post.js's import stays
// commented out above until it's verified working (bug fix #2).
// import socialRouter from "./routes/social.js";
// app.use(socialRouter);

import instagramRouter from "./routes/instagram.js";
app.use(instagramRouter);

import webhooksRouter from "./routes/webhooks.js";
app.use(webhooksRouter);

// ─── ROUTE: DEBUG CALENDAR ────────────────────────────────────────────────────
app.get("/debug/calendar", async (req, res) => {
  try {
    const now      = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const dayStart = new Date(`${getCentralDateString(now)}T00:00:00-05:00`);
    const dayEnd   = new Date(`${getCentralDateString(tomorrow)}T23:59:59-05:00`);
    const response = await gcal.events.list({
      calendarId:   process.env.GOOGLE_CALENDAR_ID,
      timeMin:      dayStart.toISOString(),
      timeMax:      dayEnd.toISOString(),
      singleEvents: true,
      orderBy:      "startTime",
    });
    const events = response.data.items || [];
    res.json({
      total_events_found: events.length,
      calendar_id_used:   process.env.GOOGLE_CALENDAR_ID,
      events: events.map(e => ({
        summary:      e.summary,
        start:        e.start,
        central_hour: getCentralHour(new Date(e.start.dateTime || e.start.date)),
      })),
    });
  } catch (err) {
    console.error("[Debug] Calendar error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nShopDesk backend running on port ${PORT}`);
  console.log(`Webhook:  http://localhost:${PORT}/webhook/ghl/pure-vision-tints`);
  console.log(`Worker:   Background job processor active\n`);
});