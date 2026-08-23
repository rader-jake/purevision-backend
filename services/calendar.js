import { google } from "googleapis";
// ─── GOOGLE CALENDAR CLIENT ───────────────────────────────────────────────────
export const googleAuth = new google.auth.JWT({
  email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key:    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

export const gcal = google.calendar({ version: "v3", auth: googleAuth });

// ─── APPOINTMENT SLOTS ────────────────────────────────────────────────────────
export const APPOINTMENT_SLOTS = [
  { label: "9AM",  hour: 9  },
  { label: "11AM", hour: 11 },
  { label: "1PM",  hour: 13 },
  { label: "3PM",  hour: 15 },
  { label: "5PM",  hour: 17 },
];


// ─── UTILITIES ────────────────────────────────────────────────────────────────
export function getCentralDateString(date) {
  return date.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export function getCentralHour(date) {
  return parseInt(
    date.toLocaleString("en-US", {
      hour:     "numeric",
      hour12:   false,
      timeZone: "America/Chicago",
    })
  );
}

export function isWithinSendingWindow() {
  const hour = getCentralHour(new Date());
  return hour >= 8 && hour < 20;
}

export function minutesUntil8AM() {
  const now = new Date();
  const central = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const next8AM = new Date(central);
  next8AM.setHours(8, 0, 0, 0);
  if (central.getHours() >= 8 && central.getHours() < 20) return 0;
  if (central.getHours() >= 20) next8AM.setDate(next8AM.getDate() + 1);
  return Math.ceil((next8AM - central) / 60000);
}

export async function bookGoogleCalendarEvent(lead) {
  const dateTimeStr = lead.booked_at.includes("T")
    ? lead.booked_at
    : lead.booked_at.replace(" ", "T") + ":00-05:00";

  const appointmentDate = new Date(dateTimeStr);

  if (isNaN(appointmentDate.getTime())) {
    throw new Error(`Could not parse appointment time: ${lead.booked_at}`);
  }
  const name    = lead.lead_name    || lead.name    || "Customer";
  const vehicle = lead.lead_vehicle || lead.vehicle || "Vehicle";
  const special = lead.lead_special || lead.special || "Tint Special";
  const phone   = lead.lead_phone   || lead.phone   || "";

  const endDate = new Date(appointmentDate.getTime() + 2 * 60 * 60 * 1000);

  const event = await gcal.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary:     `Tint Appointment — ${name}`,
      description: `Vehicle: ${vehicle}\nSpecial: ${special}\nPhone: ${phone}`,
      start: { dateTime: appointmentDate.toISOString(), timeZone: "America/Chicago" },
      end:   { dateTime: endDate.toISOString(),         timeZone: "America/Chicago" },
    },
  });

  console.log(`[Calendar] Event created: ${event.data.htmlLink}`);
  return event.data;
}
