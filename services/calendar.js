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

// ─── DST-AWARE CENTRAL TIME HELPERS ───────────────────────────────────────────
// Turns a Central wall-clock date + hour into a real Date. The older routes
// hardcode "-05:00" (CDT), which is an hour off once DST ends — use this for
// anything new.
export function centralToDate(dateStr, hour = 0) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(guess)).reduce((o, p) => (o[p.type] = Number(p.value), o), {});
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += wanted - shown;
  }
  return new Date(guess);
}

// ─── APPOINTMENT DESCRIPTION FORMAT ───────────────────────────────────────────
// "Vehicle: …\nService: …\nPrice: …\nPhone: …\nNotes: …" (Notes is last, may span lines).
// Events made by the AI booking flow use "Special:" instead of "Service:".
export function buildAppointmentDescription({ vehicle, service, price, phone, notes }) {
  return `Vehicle: ${vehicle || ""}\nService: ${service || ""}\nPrice: ${price || ""}\nPhone: ${phone || ""}\nNotes: ${notes || ""}`;
}

export function parseAppointmentDescription(description) {
  const out = { vehicle: "", service: "", price: "", phone: "", notes: "" };
  const lines = String(description || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(Vehicle|Service|Special|Price|Phone|Notes):\s?(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "notes") {
      out.notes = [m[2], ...lines.slice(i + 1)].join("\n").trim();
      break;
    }
    out[key === "special" ? "service" : key] = m[2].trim();
  }
  return out;
}
