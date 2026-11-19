import crypto from "node:crypto";

/** True when X-Twilio-Signature matches HMAC-SHA1(authToken, url + sorted form params). */
export function isValidTwilioSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  if (!token || !signature) return false;

  // Twilio signs the exact public URL it called. Behind Railway's proxy that's https + the public host;
  // set TWILIO_WEBHOOK_BASE_URL (e.g. https://your-app.up.railway.app) if auto-detection ever disagrees.
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim();
  const base = (process.env.TWILIO_WEBHOOK_BASE_URL || `${proto}://${host}`).replace(/\/$/, '');
  const url = base + req.originalUrl;

  const params = req.body || {};
  const data = url + Object.keys(params).sort().map(k => k + [].concat(params[k]).join('')).join('');
  const expected = crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');

  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
