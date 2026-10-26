// Pure helpers for Integrity Claims (public-adjuster fire leads). No DB / network here,
// so prompts, follow-ups and routes can all import it safely.

export const INTEGRITY_SHOP = "integrity-claims";
export const INTEGRITY_TZ   = "America/New_York";

/** "(305) 555-1234" / "305-555-1234" / "13055551234" → "+13055551234", or null if it isn't a US number. */
export function normalizePhone(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export const last10 = (p) => String(p ?? "").replace(/\D/g, "").slice(-10);

const BUSINESS_WORDS = /\b(llc|l\.l\.c|inc|corp|corporation|co|company|trust|trustee|estate|holdings|properties|property|association|assoc|condo|condominium|ltd|lp|llp|partners|church|ministries|enterprises|investments|realty|management|apartments?|hoa)\b/i;

/**
 * "JOHN & JANE SMITH" → "John", "smith, john" → "Smith" (public records are inconsistent, so we
 * just take the first word), businesses/trusts → "there".
 */
export function leadFirstName(fullName) {
  const first = String(fullName ?? "").split(/[+&,]/)[0].trim();
  if (!first || BUSINESS_WORDS.test(first)) return "there";
  const word = first.split(/\s+/)[0].replace(/[^A-Za-z'’-]/g, "");
  if (!word || word.toLowerCase() === "there") return "there";
  return word.toLowerCase().replace(/(^|[-'’])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** The first text we send to a homeowner. */
export function buildOpener(fullName, address) {
  const first = leadFirstName(fullName);
  const where = address && address !== "your vehicle" ? address : "your property";
  return `Hi ${first}, I hope you and your family are safe. This is Integrity Claims — we're licensed public adjusters here in South Florida. I saw there was a fire at ${where} and wanted to reach out in case you need help with your insurance claim. Can I answer any questions for you?`;
}

/**
 * What an inbound text means for outreach:
 *  - "stop":         an opt-out → never text again, and don't even reply
 *  - "wrong_number": not the homeowner → mark the number, try another
 *  - "not_interested": the AI answers kindly once, then we stop for good
 */
export function detectInboundIntent(text) {
  const t = String(text ?? "").trim();
  if (/^\W*(stop|stopall|unsubscribe|cancel|end|quit|opt[\s-]?out)\W*$/i.test(t)) return "stop";
  if (/\b(stop (texting|messaging|contacting|calling|sending)|do not (text|contact|call)|don'?t (text|contact|call)|remove (me|my number)|take me off|leave me alone)\b/i.test(t)) return "stop";
  if (/\bwrong (number|person)\b|\bhave the wrong\b|\b(doesn'?t|does not|no longer|don'?t) live(s)? here\b|\bnot (his|her|their|the owner'?s?) (number|phone)\b|\bnever (heard of|owned)\b/i.test(t)) return "wrong_number";
  if (/\bnot interested\b|\bno,? thanks?\b|\bno thank you\b|\bnot (looking|needed)\b/i.test(t)) return "not_interested";
  return null;
}
