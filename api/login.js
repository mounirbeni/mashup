import { authed, passwordMatches, sessionCookie, clearCookie, json } from './_lib.js';

// GET: am I logged in?  POST {password}: log in.  DELETE: log out.
export function GET(req) {
  return json({ authed: authed(req), configured: !!process.env.APP_PASSWORD });
}

export async function POST(req) {
  if (!process.env.APP_PASSWORD) return json({ error: 'not-configured' }, 503);
  const { password } = await req.json().catch(() => ({}));
  if (!passwordMatches(password)) {
    await new Promise((r) => setTimeout(r, 700)); // slow down guessing
    return json({ error: 'wrong-password' }, 401);
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie() });
}

export function DELETE() {
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}
