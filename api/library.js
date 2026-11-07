// The music library (song info + playlists) lives in one private JSON file in Blob storage,
// so every device sees the same songs. Changes are sent as small operations and applied
// to the latest copy on the server, so two devices don't overwrite each other's changes.
import { get, put, del, list } from '@vercel/blob';
import { authed, json, unauthorized, FILE_PATH } from './_lib.js';

const LIB = 'library.json';
const TEXT = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const NUM = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

async function load() {
  const r = await get(LIB, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return { tracks: [], playlists: [] };
  const lib = JSON.parse(await new Response(r.stream).text());
  return { tracks: lib.tracks || [], playlists: lib.playlists || [] };
}
const save = (lib) => put(LIB, JSON.stringify(lib), {
  access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60,
});

function cleanTrack(t) {
  if (!t || typeof t.id !== 'string' || !/^[\w-]{6,64}$/.test(t.id)) throw new Error('bad track id');
  if (!FILE_PATH.test(t.audio || '') || !t.audio.startsWith('audio/')) throw new Error('bad audio path');
  if (t.art && (!FILE_PATH.test(t.art) || !t.art.startsWith('art/'))) throw new Error('bad art path');
  return {
    id: t.id, audio: t.audio, art: t.art || null,
    title: TEXT(t.title) || 'Untitled', artist: TEXT(t.artist) || 'Unknown Artist', album: TEXT(t.album),
    duration: NUM(t.duration) || 0, bpm: NUM(t.bpm), beatOffset: NUM(t.beatOffset),
    analyzed: !!t.analyzed, beatConf: NUM(t.beatConf), gridV: NUM(t.gridV), fav: !!t.fav, demo: !!t.demo, size: NUM(t.size) || 0,
    addedAt: NUM(t.addedAt) || Date.now(),
  };
}
const PATCHABLE = { title: TEXT, artist: TEXT, album: TEXT, fav: (v) => !!v, bpm: NUM, beatOffset: NUM, beatConf: NUM, gridV: NUM, analyzed: (v) => !!v, duration: NUM };

function cleanPlaylist(p, tracks) {
  if (!p || typeof p.id !== 'string' || !/^[\w-]{6,64}$/.test(p.id)) throw new Error('bad playlist id');
  const ids = new Set(tracks.map((t) => t.id));
  return {
    id: p.id, name: TEXT(p.name, 80) || 'Playlist', createdAt: NUM(p.createdAt) || Date.now(),
    trackIds: Array.isArray(p.trackIds) ? p.trackIds.filter((id) => ids.has(id)).slice(0, 5000) : [],
  };
}

export async function GET(req) {
  if (!authed(req)) return unauthorized();
  return json(await load());
}

export async function POST(req) {
  if (!authed(req)) return unauthorized();
  const body = await req.json().catch(() => null);
  if (!body?.op) return json({ error: 'missing op' }, 400);
  try {
    const lib = await load();
    const { op } = body;
    if (op === 'addTrack') {
      const t = cleanTrack(body.track);
      lib.tracks = lib.tracks.filter((x) => x.id !== t.id).concat(t);
    } else if (op === 'updateTrack') {
      const t = lib.tracks.find((x) => x.id === body.id);
      if (!t) return json({ error: 'not found' }, 404);
      for (const [k, v] of Object.entries(body.patch || {})) if (PATCHABLE[k]) t[k] = PATCHABLE[k](v);
    } else if (op === 'deleteTrack') {
      const t = lib.tracks.find((x) => x.id === body.id);
      if (t) {
        await del([t.audio, t.art, `lyrics/${t.id}.json`].filter(Boolean)).catch(() => {});
        lib.tracks = lib.tracks.filter((x) => x.id !== t.id);
        lib.playlists.forEach((p) => { p.trackIds = p.trackIds.filter((id) => id !== t.id); });
      }
    } else if (op === 'savePlaylist') {
      const p = cleanPlaylist(body.playlist, lib.tracks);
      lib.playlists = lib.playlists.filter((x) => x.id !== p.id).concat(p);
    } else if (op === 'deletePlaylist') {
      lib.playlists = lib.playlists.filter((x) => x.id !== body.id);
    } else if (op === 'wipe') {
      let cursor;
      do {
        const page = await list({ cursor, limit: 1000 });
        const paths = page.blobs.map((b) => b.pathname).filter((p) => p !== LIB);
        if (paths.length) await del(paths);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      lib.tracks = []; lib.playlists = [];
    } else {
      return json({ error: 'unknown op' }, 400);
    }
    await save(lib);
    return json({ ok: true, ...lib });
  } catch (e) {
    return json({ error: e.message || 'failed' }, 400);
  }
}
