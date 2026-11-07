// Streams a song or cover from private Blob storage to a logged-in browser.
// Range requests are passed through so the player can seek and stream without downloading everything first.
import { get } from '@vercel/blob';
import { authed, json, unauthorized, FILE_PATH } from './_lib.js';

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

export async function GET(req) {
  if (!authed(req)) return unauthorized();
  const p = new URL(req.url).searchParams.get('p') || '';
  if (!FILE_PATH.test(p)) return json({ error: 'bad path' }, 400);
  const headers = {};
  const range = req.headers.get('range');
  if (range) headers.range = range;
  const r = await get(p, { access: 'private', headers });
  if (!r || !r.stream) return new Response('Not found', { status: 404 });
  const out = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  for (const h of PASS) { const v = r.headers.get(h); if (v) out.set(h, v); }
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  return new Response(r.stream, { status: out.has('content-range') ? 206 : 200, headers: out });
}
