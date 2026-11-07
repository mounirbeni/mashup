// Lyrics for a song. Looked up once (lyrics embedded in the file, or LRCLIB, a free open lyrics
// database), then saved privately next to the song so later plays and other devices load instantly.
//   GET    ?id=…            → { lrc, plain, scale, source } or { none: true }
//   POST   ?id=… {text}     → save lyrics typed or pasted by the user (or read from the file)
//   DELETE ?id=…            → forget saved lyrics so the next GET searches again
import { get, put, del } from '@vercel/blob';
import { authed, json, unauthorized } from './_lib.js';

const UA = 'Mashup music player (https://mashup-nu.vercel.app)';
const ID = /^[\w-]{6,64}$/;
const RETRY_AFTER = 7 * 86400e3; // look again a week after finding nothing

const path = (id) => `lyrics/${id}.json`;
async function readJson(p) {
  const r = await get(p, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}
const save = (id, data) => put(path(id), JSON.stringify(data), {
  access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60,
});

/* "TURAN 2 (Slowed)(M4A 128K)" → "turan 2"; remembers whether it's a slowed / sped-up edit */
const EDIT = /\b(slowed|reverb|sped\s*up|speed\s*up|nightcore|8d|bass\s*boost(ed)?)\b/i;
const JUNK = /\b(m4a|mp3|wav|flac|aac|\d{2,3}\s*k(bps)?|official|video|audio|lyrics?|hd|hq|visuali[sz]er|remaster(ed)?)\b/i;
function cleanTitle(t) {
  let s = String(t || '');
  const edited = EDIT.test(s);
  s = s.replace(/\s+-\s+.*$/, (m) => (JUNK.test(m) || EDIT.test(m) ? '' : m)); // "Song - Remastered 2011"
  s = s.replace(/[([{][^)\]}]*[)\]}]/g, (m) => (EDIT.test(m) || JUNK.test(m) ? ' ' : m));
  s = s.replace(new RegExp(EDIT.source, 'gi'), ' ').replace(new RegExp(JUNK.source, 'gi'), ' ');
  return { title: s.replace(/[_|]+/g, ' ').replace(/\s+/g, ' ').trim(), edited };
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter(Boolean));
function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

async function lrclib(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('lyrics service ' + r.status);
  return r.json();
}

async function search(track) {
  const { title, edited } = cleanTitle(track.title);
  const artist = track.artist && !/unknown artist/i.test(track.artist) ? track.artist : '';
  if (!title) return null;
  const q = new URLSearchParams(artist ? { track_name: title, artist_name: artist } : { q: title });
  let results = (await lrclib('https://lrclib.net/api/search?' + q)) || [];
  if (!results.length && artist) results = (await lrclib('https://lrclib.net/api/search?' + new URLSearchParams({ q: `${artist} ${title}` }))) || [];
  let best = null, bestScore = Infinity;
  for (const r of results) {
    if (r.instrumental || !(r.syncedLyrics || r.plainLyrics)) continue;
    // the title must really match; the artist too when we know it (no wrong-song lyrics)
    const ts = Math.max(similar(title, r.trackName), norm(r.trackName) === norm(title) ? 1 : 0);
    if (ts < 0.75) continue;
    if (artist && similar(artist, r.artistName) < 0.5) continue;
    const ratio = track.duration && r.duration ? track.duration / r.duration : 1;
    const score = (r.syncedLyrics ? 0 : 4) + Math.abs(Math.log(ratio)) * 20 + (1 - ts) * 5;
    if (score < bestScore) { bestScore = score; best = { r, ratio }; }
  }
  if (!best) return null;
  const { r, ratio } = best;
  // a slowed / sped-up edit is the same song stretched in time: scale the timestamps to match
  const close = Math.abs(ratio - 1) < 0.03;
  const stretchable = (edited || !close) && ratio > 0.65 && ratio < 1.5;
  const synced = r.syncedLyrics && (close || stretchable) ? r.syncedLyrics : null;
  return { lrc: synced, plain: r.plainLyrics || null, scale: synced && !close ? ratio : 1, source: 'lrclib', match: { track: r.trackName, artist: r.artistName } };
}

async function trackById(id) {
  const lib = await readJson('library.json');
  return lib?.tracks?.find((t) => t.id === id) || null;
}

export async function GET(req) {
  if (!authed(req)) return unauthorized();
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!ID.test(id)) return json({ error: 'bad id' }, 400);
  const saved = await readJson(path(id)).catch(() => null);
  if (saved && !(saved.none && Date.now() - saved.checkedAt > RETRY_AFTER)) return json(saved);
  const track = await trackById(id);
  if (!track) return json({ error: 'not found' }, 404);
  let found = null;
  try { found = await search(track); } catch (e) { return json({ none: true, error: 'The lyrics service didn’t answer. Try again later.' }); }
  const data = found ? { ...found, checkedAt: Date.now() } : { none: true, checkedAt: Date.now() };
  await save(id, data);
  return json(data);
}

export async function POST(req) {
  if (!authed(req)) return unauthorized();
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!ID.test(id)) return json({ error: 'bad id' }, 400);
  const body = await req.json().catch(() => ({}));
  const text = String(body.text || '').replace(/\r\n?/g, '\n').slice(0, 60000).trim();
  if (!text) { await del(path(id)).catch(() => {}); return json({ none: true }); }
  const isLrc = /^\s*\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/m.test(text);
  const data = { lrc: isLrc ? text : null, plain: isLrc ? null : text, scale: 1, source: body.source === 'file' ? 'file' : 'manual', checkedAt: Date.now() };
  await save(id, data);
  return json(data);
}

export async function DELETE(req) {
  if (!authed(req)) return unauthorized();
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!ID.test(id)) return json({ error: 'bad id' }, 400);
  await del(path(id)).catch(() => {});
  return json({ ok: true });
}
