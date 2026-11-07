// Shared helpers for the API routes (files starting with "_" are not deployed as routes).
import crypto from 'node:crypto';

const COOKIE = 'mashup_s';
const DAYS = 180;

const secret = () => process.env.SESSION_SECRET || process.env.APP_PASSWORD || '';
const sign = (exp) => crypto.createHmac('sha256', secret()).update('mashup-session:' + exp).digest('base64url');

export function sessionCookie() {
  const exp = Date.now() + DAYS * 86400e3;
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function authed(req) {
  if (!secret()) return false;
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || !(+exp > Date.now())) return false;
  const good = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  return good.length === got.length && crypto.timingSafeEqual(good, got);
}

export function passwordMatches(pw) {
  const real = process.env.APP_PASSWORD;
  if (!real) return false;
  const a = crypto.createHash('sha256').update(String(pw ?? '')).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
export const unauthorized = () => json({ error: 'unauthorized' }, 401);

// Only these blob paths are ever read or written through the API.
export const FILE_PATH = /^(audio|art)\/[A-Za-z0-9_-]{6,64}\.[a-z0-9]{2,5}$/;
