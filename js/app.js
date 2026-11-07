/* Mashup: a local-first music player with a two-deck mixing engine.
 * Everything runs in the browser: tracks are stored in IndexedDB on the device,
 * audio goes through the Web Audio API (two decks → EQ → filter → crossfader → master). */
(() => {
'use strict';

/* =========================================================================
 * Utilities
 * ========================================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (sec) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const hashHue = (str) => { let h = 0; for (const c of String(str)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; };
const collator = new Intl.Collator(['ar', 'en'], { sensitivity: 'base', numeric: true });
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const songsLabel = (n) => n === 0 ? 'No songs' : n === 1 ? '1 song' : `${n} songs`;

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('mazj.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mazj.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const settings = Object.assign({
  crossfade: 10,     // seconds of overlap between songs
  autoMix: true,     // crossfade into the next song automatically
  smartMix: true,    // beat-match tempo + phase and swap bass during the mix
  keyLock: true,     // keep pitch when tempo changes
  volume: 1,
}, store.get('settings', {}));
// v2: longer, Apple-Music-style blends by default
if (!settings.v) { settings.crossfade = Math.max(settings.crossfade, 10); settings.v = 2; }
const saveSettings = () => store.set('settings', settings);

/* =========================================================================
 * IndexedDB
 * ========================================================================= */
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('mazj', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('tracks', { keyPath: 'id' });
        db.createObjectStore('audio');
        db.createObjectStore('art');
        db.createObjectStore('playlists', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(storeName, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(storeName, mode);
      const s = t.objectStore(storeName);
      let out;
      Promise.resolve(fn(s)).then((v) => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    all: (s) => tx(s, 'readonly', (st) => req(st.getAll())),
    get: (s, k) => tx(s, 'readonly', (st) => req(st.get(k))),
    put: (s, v, k) => tx(s, 'readwrite', (st) => { k === undefined ? st.put(v) : st.put(v, k); }),
    del: (s, k) => tx(s, 'readwrite', (st) => { st.delete(k); }),
    clear: (s) => tx(s, 'readwrite', (st) => { st.clear(); }),
  };
})();

/* =========================================================================
 * Tag reading (ID3v2.2/2.3/2.4) — title, artist, album, cover art
 * ========================================================================= */
const Tags = (() => {
  const dec = (label) => { try { return new TextDecoder(label); } catch { return null; } };
  const d8 = dec('utf-8'), dLatin = dec('iso-8859-1'), dAr = dec('windows-1256'), d16le = dec('utf-16le'), d16be = dec('utf-16be');
  const synch = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);
  const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

  function text(bytes, enc) {
    let s = '';
    if (enc === 0) {
      // Many Arabic MP3s store Windows-1256 text in the "Latin-1" slot.
      const high = bytes.some((x) => x >= 0x80);
      if (high && dAr) { const a = dAr.decode(bytes); s = /[؀-ۿ]/.test(a) ? a : dLatin.decode(bytes); }
      else s = dLatin.decode(bytes);
    } else if (enc === 1) {
      if (bytes[0] === 0xfe && bytes[1] === 0xff) s = d16be.decode(bytes.subarray(2));
      else if (bytes[0] === 0xff && bytes[1] === 0xfe) s = d16le.decode(bytes.subarray(2));
      else s = d16le.decode(bytes);
    } else if (enc === 2) s = d16be.decode(bytes);
    else s = d8.decode(bytes);
    return s.replace(/\u0000+$/g, '').split('\u0000')[0].trim();
  }
  function termEnd(b, p, enc) {
    if (enc === 1 || enc === 2) { for (let i = p; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i; return b.length; }
    for (let i = p; i < b.length; i++) if (b[i] === 0) return i; return b.length;
  }

  async function read(file) {
    const out = {};
    try {
      const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
      if (!(head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)) return out;
      const ver = head[3], flags = head[5], size = synch(head, 6);
      const b = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
      let p = 0;
      if (flags & 0x40 && ver >= 3) p = ver === 4 ? synch(b, 0) : u32(b, 0) + 4;
      const idLen = ver === 2 ? 3 : 4, hLen = ver === 2 ? 6 : 10;
      while (p + hLen < b.length) {
        const id = String.fromCharCode(...b.subarray(p, p + idLen));
        if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
        const fsz = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : ver === 4 ? synch(b, p + 4) : u32(b, p + 4);
        if (fsz <= 0 || p + hLen + fsz > b.length) break;
        const f = b.subarray(p + hLen, p + hLen + fsz);
        p += hLen + fsz;
        const enc = f[0];
        if (id === 'TIT2' || id === 'TT2') out.title = text(f.subarray(1), enc);
        else if (id === 'TPE1' || id === 'TP1') out.artist = text(f.subarray(1), enc);
        else if ((id === 'TPE2' || id === 'TP2') && !out.artist) out.artist = text(f.subarray(1), enc);
        else if (id === 'TALB' || id === 'TAL') out.album = text(f.subarray(1), enc);
        else if (id === 'TBPM' || id === 'TBP') { const v = parseFloat(text(f.subarray(1), enc)); if (v > 40 && v < 250) out.bpm = v; }
        else if ((id === 'APIC' || id === 'PIC') && !out.art) {
          let q = 1, mime;
          if (id === 'PIC') { const fmt3 = String.fromCharCode(f[1], f[2], f[3]).toLowerCase(); mime = fmt3 === 'png' ? 'image/png' : 'image/jpeg'; q = 4; }
          else { const e = termEnd(f, 1, 0); mime = dLatin.decode(f.subarray(1, e)) || 'image/jpeg'; q = e + 1; if (!mime.includes('/')) mime = 'image/' + mime.toLowerCase(); }
          q += 1; // picture type
          const e2 = termEnd(f, q, enc);
          q = e2 + (enc === 1 || enc === 2 ? 2 : 1);
          if (q < f.length) out.art = new Blob([f.slice(q)], { type: mime });
        }
      }
    } catch (e) { console.warn('tag read failed', e); }
    return out;
  }
  return { read };
})();

/* =========================================================================
 * Analysis — waveform peaks, BPM and first-beat offset
 * ========================================================================= */
const Analysis = (() => {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const SR = 22050;
  function decode(ab) {
    const ctx = new OAC(1, 2, SR);
    return new Promise((res, rej) => {
      const p = ctx.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }
  function peaks(ch, bins = 480) {
    const out = new Uint8Array(bins), step = ch.length / bins;
    let max = 0;
    const raw = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      let m = 0;
      const a = Math.floor(i * step), b = Math.min(ch.length, Math.floor((i + 1) * step));
      for (let j = a; j < b; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
      raw[i] = m; if (m > max) max = m;
    }
    for (let i = 0; i < bins; i++) out[i] = Math.round((raw[i] / (max || 1)) * 255);
    return out;
  }
  // Onset envelope (low-passed + full band energy flux), autocorrelation, tempo prior around 120.
  function tempo(ch, sr) {
    const hop = 256, win = 512;
    const start = ch.length > sr * 90 ? Math.floor(ch.length / 2 - sr * 30) : 0;
    const end = Math.min(ch.length, start + sr * 60);
    const n = Math.floor((end - start - win) / hop);
    if (n < 200) return null;
    const a = 1 - Math.exp(-2 * Math.PI * 150 / sr);
    let lp = 0;
    const low = new Float32Array(end - start);
    for (let i = start; i < end; i++) { lp += a * (ch[i] - lp); low[i - start] = lp; }
    const env = new Float32Array(n);
    let pl = 0, pf = 0;
    for (let f = 0; f < n; f++) {
      let el = 0, ef = 0;
      const o = f * hop;
      for (let j = 0; j < win; j += 2) { const x = low[o + j]; el += x * x; const y = ch[start + o + j]; ef += y * y; }
      el = Math.log(1e-9 + el); ef = Math.log(1e-9 + ef);
      env[f] = Math.max(0, el - pl) * 1.5 + Math.max(0, ef - pf);
      pl = el; pf = ef;
    }
    // remove local mean
    const m = env.reduce((s, v) => s + v, 0) / n;
    for (let i = 0; i < n; i++) env[i] = Math.max(0, env[i] - m);
    const fps = sr / hop;
    const minLag = Math.floor(fps * 60 / 190), maxLag = Math.ceil(fps * 60 / 65);
    const ac = new Float32Array(maxLag + 2);
    for (let L = minLag; L <= maxLag + 1; L++) {
      let s = 0;
      for (let i = 0; i + L < n; i++) s += env[i] * env[i + L];
      ac[L] = s / (n - L);
    }
    let best = 0, bestL = 0;
    for (let L = minLag + 1; L <= maxLag; L++) {
      const bpm = 60 * fps / L;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 122) / 0.9, 2));
      const score = (ac[L] + 0.5 * (ac[L * 2] || 0)) * w;
      if (score > best && ac[L] >= ac[L - 1] && ac[L] >= ac[L + 1]) { best = score; bestL = L; }
    }
    if (!bestL) return null;
    const y0 = ac[bestL - 1], y1 = ac[bestL], y2 = ac[bestL + 1];
    const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
    let bpm = 60 * fps / (bestL + clamp(d, -0.5, 0.5));
    while (bpm < 78) bpm *= 2;
    while (bpm > 165) bpm /= 2;
    bpm = Math.round(bpm * 10) / 10;
    if (Math.abs(bpm - Math.round(bpm)) < 0.25) bpm = Math.round(bpm);
    // beat phase: offset that best lines up with onsets
    const period = 60 / bpm * fps;
    let bestP = 0, bestS = -1;
    for (let ph = 0; ph < period; ph += 0.5) {
      let s = 0;
      for (let k = ph; k < n; k += period) s += env[Math.round(k)] || 0;
      if (s > bestS) { bestS = s; bestP = ph; }
    }
    let offset = (start / sr) + bestP / fps;
    const per = 60 / bpm;
    offset = offset % per;
    return { bpm, beatOffset: offset };
  }
  async function run(blob) {
    const buf = await decode(await blob.arrayBuffer());
    const ch = buf.getChannelData(0);
    const t = tempo(ch, buf.sampleRate);
    return { peaks: peaks(ch), duration: buf.duration, bpm: t?.bpm, beatOffset: t?.beatOffset };
  }
  return { run };
})();

/* =========================================================================
 * Library state
 * ========================================================================= */
const Lib = {
  tracks: new Map(),
  playlists: [],
  artUrls: new Map(),
  colors: new Map(),
  sorted() { return [...this.tracks.values()].sort((a, b) => collator.compare(a.title, b.title)); },
  async load() {
    const [ts, pls] = await Promise.all([DB.all('tracks'), DB.all('playlists')]);
    ts.forEach((t) => this.tracks.set(t.id, t));
    this.playlists = pls.sort((a, b) => a.createdAt - b.createdAt);
  },
  async artUrl(id) {
    if (this.artUrls.has(id)) return this.artUrls.get(id);
    const t = this.tracks.get(id);
    let url = null;
    if (t?.hasArt) { const b = await DB.get('art', id); if (b) url = URL.createObjectURL(b); }
    this.artUrls.set(id, url);
    return url;
  },
  async savePlaylist(pl) { await DB.put('playlists', pl); },
};

const analysisQueue = [];
let analysing = false;
async function runAnalysis() {
  if (analysing) return;
  analysing = true;
  while (analysisQueue.length) {
    const id = analysisQueue.shift();
    const t = Lib.tracks.get(id);
    if (!t || t.peaks) continue;
    try {
      const blob = await DB.get('audio', id);
      const r = await Analysis.run(blob);
      t.peaks = r.peaks;
      if (!t.duration) t.duration = r.duration;
      if (!t.bpm && r.bpm) t.bpm = r.bpm;
      if (r.beatOffset != null) t.beatOffset = r.beatOffset;
      await DB.put('tracks', t);
      UI.trackUpdated(id);
    } catch (e) {
      console.warn('analysis failed', t.title, e);
      t.peaks = new Uint8Array(0);
      await DB.put('tracks', t).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  analysing = false;
}
function queueAnalysis(ids) { analysisQueue.push(...ids); runAnalysis(); }

function probeDuration(blob) {
  return new Promise((res) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(url); res(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(-1);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}

async function addFiles(files) {
  files = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|opus|alac|aiff?)$/i.test(f.name));
  if (!files.length) { toast('No audio files found'); return; }
  const added = [];
  let i = 0, failed = 0;
  for (const f of files) {
    i++;
    toast(`Adding ${i} of ${files.length}…`, 0);
    const dur = await probeDuration(f);
    if (dur < 0) { failed++; continue; }
    const tags = await Tags.read(f);
    let name = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    let artist = tags.artist, title = tags.title;
    if (!title) {
      const m = name.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (m) { artist = artist || m[1].trim(); title = m[2].trim(); } else title = name;
    }
    const t = {
      id: uid(), title, artist: artist || 'Unknown Artist', album: tags.album || '',
      duration: dur, bpm: tags.bpm || null, beatOffset: null, peaks: null,
      hasArt: !!tags.art, addedAt: Date.now(), size: f.size,
    };
    try {
      await DB.put('audio', f, t.id);
      if (tags.art) await DB.put('art', tags.art, t.id);
      await DB.put('tracks', t);
      Lib.tracks.set(t.id, t);
      added.push(t.id);
    } catch (e) {
      console.error(e); failed++;
      if (e && e.name === 'QuotaExceededError') { toast('Storage is full for this site'); break; }
    }
  }
  UI.render();
  toast(added.length ? `Added ${songsLabel(added.length)}${failed ? ` · ${failed} failed` : ''}` : 'Couldn’t add these files');
  queueAnalysis(added);
}

async function deleteTrack(id) {
  if (Engine.decks.A.track?.id === id || Engine.decks.B.track?.id === id) {
    for (const d of Object.values(Engine.decks)) if (d.track?.id === id) d.unload();
  }
  await Promise.all([DB.del('tracks', id), DB.del('audio', id), DB.del('art', id)]);
  Lib.tracks.delete(id);
  const u = Lib.artUrls.get(id); if (u) URL.revokeObjectURL(u);
  Lib.artUrls.delete(id);
  for (const pl of Lib.playlists) {
    if (pl.trackIds.includes(id)) { pl.trackIds = pl.trackIds.filter((x) => x !== id); await Lib.savePlaylist(pl); }
  }
  Player.removeFromQueue(id);
  UI.render();
}

/* =========================================================================
 * Audio engine — two decks, 3-band EQ + filter each, equal-power crossfader
 * ========================================================================= */
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
const EQ_MIN = -26, EQ_MAX = 6;

class Deck {
  constructor(id) {
    this.id = id;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.playsInline = true;
    this.audio.setAttribute('playsinline', '');
    this.track = null; this.url = null;
    this.eq = { high: 0, mid: 0, low: 0 };
    this.filterVal = 0; this.trimVal = 1; this.rate = 1; this.cue = 0;
    this.glide = null;
    this.audio.addEventListener('ended', () => Player.onDeckEnded(this));
    this.audio.addEventListener('play', () => UI.deckState());
    this.audio.addEventListener('pause', () => UI.deckState());
  }
  connect(ctx, dest) {
    this.ctx = ctx;
    this.src = ctx.createMediaElementSource(this.audio);
    const bq = (type, f, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q) n.Q.value = q; return n; };
    this.low = bq('lowshelf', 220); this.mid = bq('peaking', 1200, 0.8); this.high = bq('highshelf', 3800);
    this.flt = bq('lowpass', 22000, 0.9);
    this.trim = ctx.createGain(); this.xf = ctx.createGain();
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 256;
    this.src.connect(this.low); this.low.connect(this.mid); this.mid.connect(this.high); this.high.connect(this.flt);
    this.flt.connect(this.trim); this.trim.connect(this.xf); this.trim.connect(this.meter); this.xf.connect(dest);
  }
  get playing() { return !this.audio.paused && !this.audio.ended; }
  get time() { return this.audio.currentTime || 0; }
  get duration() { return isFinite(this.audio.duration) ? this.audio.duration : (this.track?.duration || 0); }
  get bpmNow() { return this.track?.bpm ? this.track.bpm * this.rate : null; }
  async load(track) {
    const blob = await DB.get('audio', track.id);
    if (!blob) throw new Error('missing audio');
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.track = track;
    this.cue = track.beatOffset || 0;
    this.setRate(1);
    this.audio.src = this.url;
    await new Promise((res) => {
      const ok = () => { this.audio.removeEventListener('loadedmetadata', ok); this.audio.removeEventListener('error', ok); res(); };
      this.audio.addEventListener('loadedmetadata', ok); this.audio.addEventListener('error', ok);
      setTimeout(ok, 6000);
    });
    UI.deckLoaded(this);
  }
  unload() {
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null; this.track = null; UI.deckLoaded(this);
  }
  play() { const p = this.audio.play(); if (p && p.catch) p.catch((e) => { console.warn(e); UI.deckState(); }); }
  pause() { this.audio.pause(); }
  seek(t) { try { this.audio.currentTime = clamp(t, 0, Math.max(0, this.duration - 0.05)); } catch { /* not seekable yet */ } }
  setEq(band, db) {
    this.eq[band] = db;
    if (!this.ctx) return;
    const p = this[band].gain;
    p.cancelScheduledValues(this.ctx.currentTime);
    p.setTargetAtTime(db, this.ctx.currentTime, 0.02);
  }
  setFilter(v) {
    this.filterVal = v;
    if (!this.ctx) return;
    const f = this.flt, now = this.ctx.currentTime;
    if (Math.abs(v) < 0.02) { f.type = 'lowpass'; f.frequency.setTargetAtTime(22000, now, 0.02); f.Q.value = 0.7; return; }
    if (v < 0) { f.type = 'lowpass'; f.frequency.setTargetAtTime(20000 * Math.pow(60 / 20000, -v), now, 0.02); }
    else { f.type = 'highpass'; f.frequency.setTargetAtTime(20 * Math.pow(8000 / 20, v), now, 0.02); }
    f.Q.value = 1.2 + Math.abs(v) * 4;
  }
  setTrim(v) { this.trimVal = v; if (this.ctx) this.trim.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setRate(r, fromGlide) {
    if (!fromGlide) this.stopGlide();
    this.rate = clamp(r, 0.84, 1.16);
    this.audio.playbackRate = this.rate;
    this.audio.preservesPitch = settings.keyLock;
    this.audio.webkitPreservesPitch = settings.keyLock;
    this.audio.mozPreservesPitch = settings.keyLock;
    UI.deckRate(this);
  }
  glideRate(to, seconds) {
    this.stopGlide();
    const from = this.rate, t0 = performance.now();
    this.glide = setInterval(() => {
      const k = clamp((performance.now() - t0) / (seconds * 1000), 0, 1);
      this.setRate(from + (to - from) * k, true);
      if (k >= 1) this.stopGlide();
    }, 120);
  }
  stopGlide() { if (this.glide) { clearInterval(this.glide); this.glide = null; } }
  /* beat phase (0..1) of the current position */
  phase(at = this.time) {
    if (!this.track?.bpm) return null;
    const per = 60 / this.track.bpm;
    const x = (at - (this.track.beatOffset || 0)) / per;
    return x - Math.floor(x);
  }
}

const Engine = {
  ctx: null, decks: { A: new Deck('A'), B: new Deck('B') }, x: 0, anim: null,
  ensure() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return this.ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC({ latencyHint: 'playback' });
    this.master = ctx.createGain();
    this.master.gain.value = settings.volume;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3; this.limiter.knee.value = 6; this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003; this.limiter.release.value = 0.2;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.78;
    this.master.connect(this.limiter); this.limiter.connect(this.analyser); this.analyser.connect(ctx.destination);
    for (const d of Object.values(this.decks)) {
      // unlock each media element inside the user gesture so later automatic plays are allowed (iOS)
      if (!d.audio.src) { d.audio.src = SILENT; d.audio.play().then(() => d.audio.pause()).catch(() => {}); }
      d.connect(ctx, this.master);
      d.setEq('low', d.eq.low); d.setEq('mid', d.eq.mid); d.setEq('high', d.eq.high); d.setFilter(d.filterVal); d.setTrim(d.trimVal);
    }
    this.applyX(this.x, true);
    if (ctx.state !== 'running') ctx.resume();
    return ctx;
  },
  gains(x) { return [Math.cos(x * Math.PI / 2), Math.sin(x * Math.PI / 2)]; },
  applyX(x, instant) {
    this.x = x;
    if (!this.ctx) return;
    const [ga, gb] = this.gains(x), now = this.ctx.currentTime;
    for (const [d, g] of [[this.decks.A, ga], [this.decks.B, gb]]) {
      const p = d.xf.gain;
      p.cancelScheduledValues(now);
      if (instant) p.setValueAtTime(g, now); else p.setTargetAtTime(g, now, 0.015);
    }
  },
  /* user moved the crossfader */
  setX(x) {
    this.cancelAnim();
    this.applyX(clamp(x, 0, 1));
  },
  cancelAnim() {
    if (!this.anim) return;
    const x = this.xNow();
    clearTimeout(this.anim.timer);
    this.anim = null;
    this.applyX(x, true);
    for (const d of Object.values(this.decks)) d.setEq('low', d.eq.low);
    Player.mixAborted();
  },
  xNow() {
    if (!this.anim) return this.x;
    const k = clamp((this.ctx.currentTime - this.anim.t0) / this.anim.dur, 0, 1);
    return this.anim.from + (this.anim.to - this.anim.from) * k;
  },
  /* schedule an equal-power crossfade in the audio thread (keeps working in the background) */
  fadeTo(to, dur, onDone) {
    const ctx = this.ensure();
    if (this.anim) { clearTimeout(this.anim.timer); this.anim = null; }
    const from = this.x, now = ctx.currentTime + 0.02, steps = 24;
    for (const [d, idx] of [[this.decks.A, 0], [this.decks.B, 1]]) {
      const p = d.xf.gain;
      p.cancelScheduledValues(0);
      p.setValueAtTime(this.gains(from)[idx], now);
      for (let i = 1; i <= steps; i++) {
        const xi = from + (to - from) * (i / steps);
        p.linearRampToValueAtTime(this.gains(xi)[idx], now + dur * (i / steps));
      }
    }
    this.anim = { from, to, t0: now, dur, timer: setTimeout(() => { this.anim = null; this.x = to; onDone && onDone(); }, dur * 1000 + 60) };
  },
  setVolume(v) { settings.volume = v; saveSettings(); if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); },
  other(d) { return d === this.decks.A ? this.decks.B : this.decks.A; },
  sideOf(d) { return d === this.decks.A ? 0 : 1; },
};

/* =========================================================================
 * Player — queue, transport and automatic mixing
 * ========================================================================= */
const Player = {
  queue: [], original: [], qi: -1, shuffle: false, repeat: 'off',
  live: Engine.decks.A, mixing: null,
  get current() { return this.live.track; },
  get playing() { return this.live.playing; },
  setQueue(ids, start = 0, { shuffle = false } = {}) {
    this.original = ids.slice();
    if (shuffle) {
      const rest = ids.slice(); const first = rest.splice(Math.floor(Math.random() * rest.length), 1)[0];
      this.queue = [first, ...shuffleArr(rest)]; this.qi = 0; this.shuffle = true;
    } else { this.queue = ids.slice(); this.qi = start; this.shuffle = false; }
    UI.transport();
  },
  async playIndex(i, { mix = false } = {}) {
    const id = this.queue[i];
    const t = Lib.tracks.get(id);
    if (!t) return;
    Engine.ensure();
    const canMix = mix && settings.crossfade > 0 && this.live.playing && this.live.track;
    if (canMix) return this.mixTo(i, Math.min(settings.crossfade, 4));
    this.cancelMix();
    const deck = this.live, other = Engine.other(deck);
    other.pause();
    this.qi = i;
    try { await deck.load(t); } catch { toast('Couldn’t load this song'); return; }
    deck.seek(0);
    Engine.cancelAnim(); Engine.applyX(Engine.sideOf(deck), true);
    deck.play();
    UI.nowPlaying();
  },
  toggle() {
    Engine.ensure();
    if (!this.live.track) { if (this.queue.length) this.playIndex(Math.max(0, this.qi)); return; }
    if (this.live.playing) { this.live.pause(); if (this.mixing) Engine.other(this.live).pause(); }
    else { this.live.play(); if (this.mixing) Engine.other(this.live).play(); }
  },
  hasNext() { return this.queue.length > 0 && (this.qi + 1 < this.queue.length || this.repeat === 'all'); },
  nextIndex() { return this.qi + 1 < this.queue.length ? this.qi + 1 : 0; },
  next(fromUser = true) {
    if (!this.queue.length) return;
    if (!this.hasNext()) { if (fromUser) { this.live.pause(); this.live.seek(0); } return; }
    this.playIndex(this.nextIndex(), { mix: fromUser && settings.autoMix });
  },
  prev() {
    if (this.live.time > 3 || this.qi <= 0) { this.live.seek(0); if (!this.live.playing) this.live.play(); return; }
    this.playIndex(this.qi - 1);
  },
  playNext(id) {
    if (!this.queue.length) { this.setQueue([id]); this.playIndex(0); return; }
    this.queue.splice(this.qi + 1, 0, id); this.original.push(id); toast('Playing next');
  },
  addToQueue(id) {
    if (!this.queue.length) { this.setQueue([id]); this.playIndex(0); return; }
    this.queue.push(id); this.original.push(id); toast('Added to queue');
  },
  removeFromQueue(id) {
    const cur = this.queue[this.qi];
    this.queue = this.queue.filter((x) => x !== id); this.original = this.original.filter((x) => x !== id);
    this.qi = Math.max(-1, this.queue.indexOf(cur));
  },
  setShuffle(on) {
    const cur = this.queue[this.qi];
    if (on) { const rest = this.queue.filter((_, i) => i !== this.qi); this.queue = cur ? [cur, ...shuffleArr(rest)] : shuffleArr(rest); this.qi = cur ? 0 : -1; }
    else { this.queue = this.original.slice(); this.qi = this.queue.indexOf(cur); }
    this.shuffle = on; UI.transport();
  },
  cycleRepeat() { this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat]; UI.transport(); },

  /* ---- mixing ---- */
  async mixTo(i, dur, { targetDeck } = {}) {
    const id = this.queue[i];
    const t = Lib.tracks.get(id);
    if (!t || this.mixing) return;
    const from = this.live, to = targetDeck || Engine.other(from);
    this.mixing = { from, to, i };
    try { if (to.track?.id !== id || !targetDeck) await to.load(t); } catch { this.mixing = null; toast('Couldn’t load the next song'); return; }
    if (!this.mixing) return; // aborted while loading
    this.qi = i;
    this.startMix(from, to, dur);
  },
  /* mix whatever is loaded on deck `to` in, over `dur` seconds */
  startMix(from, to, dur) {
    Engine.ensure();
    this.mixing = this.mixing || { from, to, i: this.qi };
    const smart = settings.smartMix && from.track?.bpm && to.track?.bpm;
    if (smart) {
      const ratio = (from.track.bpm * from.rate) / to.track.bpm;
      if (Math.abs(ratio - 1) <= 0.1) to.setRate(ratio);
    }
    if (!to.playing) {
      let start = to.time > 0.5 && to.time < to.duration - dur - 2 ? to.time : (to.track?.beatOffset || 0);
      if (smart && from.playing) {
        const per = 60 / to.track.bpm, phOut = from.phase();
        const base = Math.floor((start - (to.track.beatOffset || 0)) / per);
        start = (to.track.beatOffset || 0) + (base + phOut) * per + 0.04 * to.rate;
      }
      to.seek(Math.max(0, start));
      to.play();
    }
    if (smart) {
      // nudge phase once playback has settled
      setTimeout(() => {
        if (!this.mixing || !from.playing || !to.playing) return;
        let diff = to.phase() - from.phase();
        diff -= Math.round(diff);
        if (Math.abs(diff) > 0.025) to.seek(to.time - diff * 60 / to.track.bpm);
      }, 450);
      // bass swap: incoming low cut until the midpoint, then swap
      const ctx = Engine.ctx, now = ctx.currentTime, mid = now + dur * 0.5;
      const lowIn = to.low.gain, lowOut = from.low.gain;
      lowIn.cancelScheduledValues(0); lowIn.setValueAtTime(EQ_MIN, now); lowIn.setValueAtTime(EQ_MIN, mid - 0.05); lowIn.linearRampToValueAtTime(to.eq.low, mid + 0.25);
      lowOut.cancelScheduledValues(0); lowOut.setValueAtTime(from.eq.low, now); lowOut.setValueAtTime(from.eq.low, mid - 0.05); lowOut.linearRampToValueAtTime(EQ_MIN, mid + 0.25);
    }
    this.live = to;
    UI.nowPlaying(); UI.mixState(true);
    Engine.fadeTo(Engine.sideOf(to), dur, () => {
      from.pause();
      from.setEq('low', from.eq.low);
      this.mixing = null;
      if (smart && Math.abs(to.rate - 1) > 0.002) to.glideRate(1, 10);
      UI.mixState(false); UI.deckState();
    });
  },
  cancelMix() { if (this.mixing) Engine.cancelAnim(); },
  mixAborted() {
    if (!this.mixing) return;
    this.mixing = null;
    // whichever side the fader favours becomes the live deck
    this.live = Engine.x < 0.5 ? Engine.decks.A : Engine.decks.B;
    UI.mixState(false); UI.nowPlaying();
  },
  onDeckEnded(deck) {
    if (deck !== this.live || this.mixing) return;
    if (this.repeat === 'one') { deck.seek(0); deck.play(); return; }
    if (this.hasNext()) this.playIndex(this.nextIndex());
    else UI.transport();
  },
  tick() {
    const d = this.live;
    if (!settings.autoMix || this.mixing || !d.playing || this.repeat === 'one' || settings.crossfade <= 0) return;
    const dur = d.duration, left = (dur - d.time) / (d.rate || 1);
    if (!dur || dur < settings.crossfade * 2.5) return;
    if (left <= settings.crossfade + 0.1 && this.hasNext()) {
      const ni = this.nextIndex();
      if (Lib.tracks.has(this.queue[ni])) this.mixTo(ni, Math.max(1, left - 0.15));
    }
  },
};
function shuffleArr(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* =========================================================================
 * UI
 * ========================================================================= */
const UI = {
  tab: 'library', seg: 'songs', filter: null, plId: null, seeking: false,

  /* ---------- artwork ---------- */
  artHTML(t, cls = 'sm') {
    const h = hashHue((t?.album || t?.title || '') + (t?.artist || ''));
    const letter = esc((t?.title || '♪').trim().charAt(0));
    return `<div class="art ${cls}" data-art="${t ? esc(t.id) : ''}" style="background:linear-gradient(135deg,hsl(${h} 62% 46%),hsl(${(h + 48) % 360} 70% 26%))"><span class="art-gen">${letter}</span></div>`;
  },
  hydrateArt(root = document) {
    $$('[data-art]', root).forEach(async (el) => {
      const id = el.dataset.art;
      if (!id || el.dataset.hyd) return;
      el.dataset.hyd = '1';
      const url = await Lib.artUrl(id);
      if (url) el.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
    });
  },

  /* ---------- rows ---------- */
  rowHTML(t, { ctx = '' } = {}) {
    const isCur = Player.current?.id === t.id;
    const bpm = t.bpm ? `<span class="bpm-tag">${Math.round(t.bpm)} BPM</span>` : '';
    const eq = isCur ? `<span class="eq-anim"><i></i><i></i><i></i></span>` : '';
    return `<div class="row ${isCur ? 'playing' : ''} ${isCur && !Player.playing ? 'paused' : ''}" data-id="${esc(t.id)}">
      <button class="row-main" data-act="play" data-ctx="${ctx}">${this.artHTML(t)}
        <span class="row-text"><span class="t1">${esc(t.title)}</span><span class="t2">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</span></span>
      </button>
      <span class="row-meta">${eq}${bpm}<button class="icon-btn" data-act="menu" aria-label="More">${icon('more')}</button></span>
    </div>`;
  },
  listFor(tracks, ctx) { return `<div class="rows">${tracks.map((t) => this.rowHTML(t, { ctx })).join('')}</div>`; },

  /* ---------- views ---------- */
  render() {
    this.renderLibrary();
    if (this.tab === 'playlists') this.plId ? this.renderPlaylist() : this.renderPlaylists();
    if (this.tab === 'search') this.renderSearch();
  },
  currentListIds: [],
  renderLibrary() {
    const all = Lib.sorted();
    const empty = all.length === 0;
    $('#lib-empty').hidden = !empty;
    $('#lib-seg').hidden = empty; $('#lib-tools').hidden = empty;
    const c = $('#lib-content');
    if (empty) { c.innerHTML = ''; return; }
    let tracks = all, head = '';
    if (this.filter) {
      tracks = all.filter((t) => this.filter.type === 'album' ? (t.album || 'Unknown Album') === this.filter.value : t.artist === this.filter.value);
      head = `<div class="sub-head"><button class="back-btn" data-act="clear-filter">${icon('back')}${this.filter.type === 'album' ? 'Albums' : 'Artists'}</button></div><h2 class="section-label">${esc(this.filter.value)}</h2>`;
    }
    $('#lib-tools').hidden = !(this.seg === 'songs' || this.filter);
    if (this.seg === 'songs' || this.filter) {
      this.currentListIds = tracks.map((t) => t.id);
      c.innerHTML = head + this.listFor(tracks, 'lib') + `<p class="count-note">${songsLabel(tracks.length)}</p>`;
    } else {
      const key = this.seg === 'albums' ? (t) => t.album || 'Unknown Album' : (t) => t.artist;
      const groups = new Map();
      for (const t of all) { const k = key(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
      const names = [...groups.keys()].sort(collator.compare);
      if (this.seg === 'albums') {
        c.innerHTML = `<div class="grid">${names.map((n) => { const ts = groups.get(n); return `<button class="tile" data-act="filter" data-type="album" data-value="${esc(n)}">${this.artHTML(ts.find((x) => x.hasArt) || ts[0], '')}<span class="t1">${esc(n)}</span><span class="t2">${esc(ts[0].artist)}</span></button>`; }).join('')}</div>`;
      } else {
        c.innerHTML = `<div class="rows">${names.map((n) => { const ts = groups.get(n); return `<div class="row"><button class="row-main" data-act="filter" data-type="artist" data-value="${esc(n)}">${this.artHTML(ts.find((x) => x.hasArt) || ts[0])}<span class="row-text"><span class="t1">${esc(n)}</span><span class="t2">${songsLabel(ts.length)}</span></span></button><span class="row-meta chev">${icon('back')}</span></div>`; }).join('')}</div>`;
      }
    }
    this.hydrateArt(c);
  },
  favIds() { return Lib.sorted().filter((t) => t.fav).map((t) => t.id); },
  getPl(id) {
    if (id === '__fav') return { id, name: 'Favorites', trackIds: this.favIds(), virtual: true };
    return Lib.playlists.find((p) => p.id === id);
  },
  renderPlaylists() {
    const c = $('#pl-content');
    const all = this.favIds().length ? [this.getPl('__fav'), ...Lib.playlists] : Lib.playlists;
    if (!all.length) {
      c.innerHTML = `<div class="empty"><div class="empty-art">${icon('list')}</div><h2>No playlists yet</h2><p>Create a playlist and AutoMix will blend its songs back to back.</p><button class="primary-btn" data-act="new-pl">${icon('plus')}New Playlist</button></div>`;
      return;
    }
    c.innerHTML = `<div class="grid">${all.map((pl) => `<button class="tile" data-act="open-pl" data-pl="${esc(pl.id)}">${this.coverHTML(pl)}<span class="t1">${esc(pl.name)}</span><span class="t2">${songsLabel(pl.trackIds.length)}</span></button>`).join('')}</div>`;
    this.hydrateArt(c);
  },
  coverHTML(pl, big) {
    const ts = pl.trackIds.map((id) => Lib.tracks.get(id)).filter(Boolean);
    if (ts.length < 4) return big ? this.artHTML(ts[0] || { title: pl.name, id: '' }, '') : `<div class="pl-cover single" style="width:100%;box-shadow:none">${this.artHTML(ts[0] || { title: pl.name, id: '' }, '')}</div>`;
    const four = ts.slice(0, 4).map((t) => this.artHTML(t, '')).join('');
    return big ? four : `<div class="pl-cover" style="width:100%;box-shadow:none">${four}</div>`;
  },
  renderPlaylist() {
    const pl = this.getPl(this.plId);
    if (!pl) { this.plId = null; this.showView('playlists'); return; }
    const ts = pl.trackIds.map((id) => Lib.tracks.get(id)).filter(Boolean);
    const cover = $('#pl-cover');
    cover.className = 'pl-cover' + (ts.length < 4 ? ' single' : '');
    cover.innerHTML = this.coverHTML(pl, true);
    $('#pl-name').textContent = pl.name;
    $('#pl-more').hidden = !!pl.virtual; $('#pl-add-songs').hidden = !!pl.virtual;
    const total = ts.reduce((s, t) => s + (t.duration || 0), 0);
    $('#pl-meta').textContent = `${songsLabel(ts.length)} · ${Math.round(total / 60)} min`;
    this.currentListIds = ts.map((t) => t.id);
    $('#pl-tracks').innerHTML = ts.length ? this.listFor(ts, 'pl') : '';
    this.hydrateArt($('#view-playlist'));
  },
  renderSearch() {
    const q = $('#search-input').value.trim().toLowerCase();
    const c = $('#search-results');
    if (!q) { c.innerHTML = Lib.tracks.size ? `<p class="count-note">Search ${songsLabel(Lib.tracks.size)}</p>` : ''; return; }
    const ts = Lib.sorted().filter((t) => [t.title, t.artist, t.album].some((s) => (s || '').toLowerCase().includes(q)));
    this.currentListIds = ts.map((t) => t.id);
    c.innerHTML = ts.length ? this.listFor(ts, 'search') : `<p class="count-note">No results for "${esc(q)}"</p>`;
    this.hydrateArt(c);
  },
  showView(name) {
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
    $('#views').scrollTop = 0;
  },
  setTab(tab) {
    this.tab = tab;
    $$('#tabbar button').forEach((b) => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (tab === 'playlists') { this.plId = null; this.showView('playlists'); this.renderPlaylists(); }
    else this.showView(tab);
    if (tab === 'library') this.renderLibrary();
    if (tab === 'search') { this.renderSearch(); }
    store.set('tab', tab);
  },
  trackUpdated(id) {
    $$(`.row[data-id="${CSS.escape(id)}"] .row-meta`).forEach((m) => {
      const t = Lib.tracks.get(id);
      if (t?.bpm && !m.querySelector('.bpm-tag')) m.insertAdjacentHTML('afterbegin', `<span class="bpm-tag">${Math.round(t.bpm)} BPM</span>`);
    });
  },
  markPlaying() {
    const id = Player.current?.id;
    $$('.row[data-id]').forEach((r) => {
      const on = r.dataset.id === id;
      r.classList.toggle('playing', on);
      r.classList.toggle('paused', on && !Player.playing);
      const meta = r.querySelector('.row-meta');
      const eq = meta?.querySelector('.eq-anim');
      if (on && !eq) meta.insertAdjacentHTML('afterbegin', '<span class="eq-anim"><i></i><i></i><i></i></span>');
      if (!on && eq) eq.remove();
    });
  },

  /* ---------- now playing ---------- */
  async nowPlaying() {
    const t = Player.current;
    $('#mini').hidden = !t;
    this.markPlaying();
    if (!t) return;
    $('#mini-title').textContent = t.title; $('#mini-artist').textContent = t.artist;
    $('#np-title').textContent = t.title; $('#np-artist').textContent = t.artist + (t.album ? ' — ' + t.album : '');
    $('#mini-art').outerHTML = this.artHTML(t).replace('class="art sm"', 'class="art sm" id="mini-art"');
    $('#np-art').outerHTML = this.artHTML(t, 'xl').replace('class="art xl"', 'class="art xl" id="np-art"');
    $('#np-art').hidden = !$('#np-viz').hidden;
    this.hydrateArt($('#mini')); this.hydrateArt($('#np'));
    this.transport();
    const url = await Lib.artUrl(t.id);
    this.tint(t, url);
    MediaSessionCtl.update(t, url);
  },
  async tint(t, url) {
    const h = hashHue((t.album || t.title) + t.artist);
    let col = `hsl(${h} 55% 28%)`, col2 = `hsl(${(h + 40) % 360} 60% 16%)`;
    if (url) {
      try {
        const img = new Image(); img.src = url; await img.decode();
        const c = document.createElement('canvas'); c.width = c.height = 12;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 12, 12);
        const d = g.getImageData(0, 0, 12, 12).data;
        let r = 0, gg = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
        r /= n; gg /= n; b /= n;
        const k = 0.55;
        col = `rgb(${r * k | 0},${gg * k | 0},${b * k | 0})`; col2 = `rgb(${r * 0.25 | 0},${gg * 0.25 | 0},${b * 0.25 | 0})`;
      } catch { /* keep hue tint */ }
    }
    $('#np-bg').style.background = `radial-gradient(120% 80% at 50% 20%, ${col}, ${col2})`;
    this.vizColor = col;
  },
  transport() {
    const playing = Player.playing;
    const ic = playing ? 'pause' : 'play';
    $('#np-play use').setAttribute('href', '#i-' + ic);
    $('#mini-play use').setAttribute('href', '#i-' + ic);
    $('#np').classList.toggle('paused', !playing);
    const fav = !!Player.current?.fav;
    $('#np-fav use').setAttribute('href', fav ? '#i-star-fill' : '#i-star');
    $('#np-fav').setAttribute('aria-pressed', fav);
    const qs = $('#q-shuffle'), qr = $('#q-repeat');
    if (qs) qs.setAttribute('aria-pressed', Player.shuffle);
    if (qr) { qr.setAttribute('aria-pressed', Player.repeat !== 'off'); $('b', qr).hidden = Player.repeat !== 'one'; }
    $('#np-xf-btn').setAttribute('aria-pressed', settings.autoMix && settings.crossfade > 0);
    this.markPlaying();
  },
  mixState(on) {
    $('#np-mixbadge').hidden = !on;
    this.deckState();
  },
  openNP() { $('#np').classList.add('open'); $('#np').setAttribute('aria-hidden', 'false'); },
  closeNP() { const np = $('#np'); np.classList.remove('open'); np.style.transform = ''; np.setAttribute('aria-hidden', 'true'); },

  /* the two decks run behind the scenes; these keep the player UI in sync */
  deckState() { this.transport(); },
  deckLoaded() {},
  deckRate() {},
  drawWave() {},

  /* ---------- sheets ---------- */
  openSheet(html, mount) {
    $('#sheet-body').innerHTML = html;
    $('#sheet').hidden = false; $('#scrim').hidden = false;
    this.hydrateArt($('#sheet'));
    mount && mount($('#sheet-body'));
  },
  closeSheet() { $('#sheet').hidden = true; $('#scrim').hidden = true; $('#sheet-body').innerHTML = ''; },
  trackMenu(id, ctx) {
    const t = Lib.tracks.get(id); if (!t) return;
    const inPl = ctx === 'pl' && this.plId && this.plId !== '__fav';
    this.openSheet(`
      <div class="sheet-head">${this.artHTML(t)}<span class="row-text"><span class="t1">${esc(t.title)}</span><span class="t2">${esc(t.artist)}${t.bpm ? ` · ${Math.round(t.bpm)} BPM` : ''}</span></span></div>
      <div class="menu">
        <button data-m="next">${icon('queue')}Play Next</button>
        <button data-m="queue">${icon('list')}Add to Queue</button>
        <button data-m="fav">${icon(t.fav ? 'star-fill' : 'star')}${t.fav ? 'Remove from Favorites' : 'Add to Favorites'}</button>
        <button data-m="pl">${icon('plus')}Add to Playlist…</button>
        ${inPl ? `<button data-m="unpl">${icon('trash')}Remove from this Playlist</button>` : ''}
        <button data-m="del" class="danger">${icon('trash')}Delete from Library</button>
      </div>`, (b) => {
      b.addEventListener('click', async (e) => {
        const m = e.target.closest('[data-m]')?.dataset.m; if (!m) return;
        if (m === 'next') { this.closeSheet(); Player.playNext(id); }
        if (m === 'queue') { this.closeSheet(); Player.addToQueue(id); }
        if (m === 'fav') { this.closeSheet(); toggleFav(id); }
        if (m === 'pl') this.pickPlaylist(id);
        if (m === 'unpl') {
          const pl = Lib.playlists.find((p) => p.id === this.plId);
          pl.trackIds = pl.trackIds.filter((x) => x !== id); await Lib.savePlaylist(pl); this.closeSheet(); this.renderPlaylist();
        }
        if (m === 'del') {
          const btn = e.target.closest('[data-m]');
          if (btn.dataset.armed) { this.closeSheet(); await deleteTrack(id); toast('Song deleted'); }
          else { btn.dataset.armed = '1'; btn.lastChild.textContent = 'Tap again to confirm'; }
        }
      });
    });
  },
  pickPlaylist(id) {
    const rows = Lib.playlists.map((p) => `<button data-pl="${esc(p.id)}">${icon('list')}${esc(p.name)}<span class="tag" style="color:var(--muted)">${p.trackIds.length}</span></button>`).join('');
    this.openSheet(`<h3>Add to Playlist</h3><div class="menu"><button data-pl="__new">${icon('plus')}New Playlist…</button>${rows}</div>`, (b) => {
      b.addEventListener('click', async (e) => {
        const p = e.target.closest('[data-pl]')?.dataset.pl; if (!p) return;
        if (p === '__new') { this.newPlaylist([id]); return; }
        const pl = Lib.playlists.find((x) => x.id === p);
        if (!pl.trackIds.includes(id)) pl.trackIds.push(id);
        await Lib.savePlaylist(pl); this.closeSheet(); toast(`Added to "${pl.name}"`);
      });
    });
  },
  newPlaylist(seed = []) {
    this.openSheet(`<h3>New Playlist</h3>
      <form id="pl-form"><input class="text-input" id="pl-name-input" placeholder="Playlist name" maxlength="60" autocomplete="off" required>
      <div class="sheet-actions"><button type="button" class="ghost-btn" data-close>Cancel</button><button class="primary-btn" type="submit">Create</button></div></form>`, (b) => {
      const inp = $('#pl-name-input', b); setTimeout(() => inp.focus(), 50);
      $('[data-close]', b).onclick = () => this.closeSheet();
      $('#pl-form', b).addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = inp.value.trim(); if (!name) return;
        const pl = { id: uid(), name, trackIds: seed.slice(), createdAt: Date.now() };
        Lib.playlists.push(pl); await Lib.savePlaylist(pl);
        this.closeSheet();
        if (seed.length) toast(`Created "${name}"`);
        else { this.setTab('playlists'); this.openPlaylist(pl.id); this.pickSongs(pl); }
      });
    });
  },
  openPlaylist(id) { this.plId = id; this.showView('playlist'); this.renderPlaylist(); },
  pickSongs(pl) {
    const sel = new Set(pl.trackIds);
    const all = Lib.sorted();
    if (!all.length) { toast('Add music to your library first'); return; }
    this.openSheet(`<h3>Add Songs to "${esc(pl.name)}"</h3>
      <div>${all.map((t) => `<button class="pick-row" data-id="${esc(t.id)}" aria-pressed="${sel.has(t.id)}">${this.artHTML(t)}<span class="row-text"><span class="t1">${esc(t.title)}</span><span class="t2">${esc(t.artist)}</span></span><span class="check"></span></button>`).join('')}</div>
      <div class="sheet-actions"><button class="primary-btn" data-done>Done</button></div>`, (b) => {
      b.addEventListener('click', async (e) => {
        const r = e.target.closest('.pick-row');
        if (r) { const id = r.dataset.id; sel.has(id) ? sel.delete(id) : sel.add(id); r.setAttribute('aria-pressed', sel.has(id)); return; }
        if (e.target.closest('[data-done]')) {
          pl.trackIds = [...pl.trackIds.filter((id) => sel.has(id)), ...all.map((t) => t.id).filter((id) => sel.has(id) && !pl.trackIds.includes(id))];
          await Lib.savePlaylist(pl); this.closeSheet(); this.renderPlaylist();
        }
      });
    });
  },
  playlistMenu() {
    const pl = Lib.playlists.find((p) => p.id === this.plId); if (!pl) return;
    this.openSheet(`<h3>${esc(pl.name)}</h3><div class="menu">
      <button data-m="rename">${icon('note')}Rename</button>
      <button data-m="shuffle">${icon('shuffle')}Shuffle</button>
      <button data-m="del" class="danger">${icon('trash')}Delete Playlist</button></div>`, (b) => {
      b.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-m]'); if (!btn) return;
        const m = btn.dataset.m;
        if (m === 'shuffle') { this.closeSheet(); playList(pl.trackIds.filter((id) => Lib.tracks.has(id)), 0, true); }
        if (m === 'rename') {
          this.openSheet(`<h3>Rename</h3><form id="rn"><input class="text-input" id="rn-in" value="${esc(pl.name)}" maxlength="60" required><div class="sheet-actions"><button class="primary-btn" type="submit">Save</button></div></form>`, (b2) => {
            $('#rn', b2).addEventListener('submit', async (ev) => { ev.preventDefault(); pl.name = $('#rn-in', b2).value.trim() || pl.name; await Lib.savePlaylist(pl); this.closeSheet(); this.renderPlaylist(); });
          });
        }
        if (m === 'del') {
          if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.lastChild.textContent = 'Tap again to confirm'; return; }
          Lib.playlists = Lib.playlists.filter((p) => p.id !== pl.id); await DB.del('playlists', pl.id);
          this.closeSheet(); this.plId = null; this.showView('playlists'); this.renderPlaylists();
        }
      });
    });
  },
  queueSheet() {
    const cur = Player.current;
    const up = [];
    for (let i = Player.qi + 1; i < Player.queue.length; i++) { const t = Lib.tracks.get(Player.queue[i]); if (t) up.push([i, t]); }
    if (Player.repeat === 'all') for (let i = 0; i < Player.qi; i++) { const t = Lib.tracks.get(Player.queue[i]); if (t) up.push([i, t]); }
    this.openSheet(`
      ${cur ? `<h3>Now Playing</h3><div class="sheet-head queue-now">${this.artHTML(cur)}<span class="row-text"><span class="t1">${esc(cur.title)}</span><span class="t2">${esc(cur.artist)}</span></span></div>` : ''}
      <div class="q-head"><h3>Up Next</h3><span class="q-sub">${settings.autoMix && settings.crossfade ? 'Songs blend into each other' : 'Songs play back to back'}</span></div>
      <div class="q-toggles">
        <button class="q-tog" id="q-shuffle" aria-pressed="${Player.shuffle}" aria-label="Shuffle">${icon('shuffle')}</button>
        <button class="q-tog" id="q-repeat" aria-pressed="${Player.repeat !== 'off'}" aria-label="Repeat">${icon('repeat')}<b ${Player.repeat === 'one' ? '' : 'hidden'}>1</b></button>
        <button class="q-tog wide" id="q-automix" aria-pressed="${!!(settings.autoMix && settings.crossfade)}">${icon('inf')}AutoMix</button>
      </div>
      ${up.length ? `<div class="rows">${up.map(([i, t]) => `<div class="row" data-qi="${i}"><button class="row-main" data-q="jump">${this.artHTML(t)}<span class="row-text"><span class="t1">${esc(t.title)}</span><span class="t2">${esc(t.artist)}${t.bpm ? ' · ' + Math.round(t.bpm) + ' BPM' : ''}</span></span></button><span class="row-meta"><button class="icon-btn" data-q="rm" aria-label="Remove">${icon('trash')}</button></span></div>`).join('')}</div>` : '<p class="count-note">Nothing queued</p>'}`, (b) => {
      $('#q-shuffle', b).onclick = () => { Player.setShuffle(!Player.shuffle); this.queueSheet(); };
      $('#q-repeat', b).onclick = () => Player.cycleRepeat();
      $('#q-automix', b).onclick = () => { setAutoMix(!(settings.autoMix && settings.crossfade > 0)); this.queueSheet(); };
      b.addEventListener('click', (e) => {
        const r = e.target.closest('[data-qi]'); const a = e.target.closest('[data-q]')?.dataset.q; if (!r || !a) return;
        const i = +r.dataset.qi;
        if (a === 'jump') { this.closeSheet(); Player.playIndex(i, { mix: settings.autoMix }); }
        if (a === 'rm') { const id = Player.queue[i]; Player.queue.splice(i, 1); if (i < Player.qi) Player.qi--; Player.original.splice(Player.original.indexOf(id), 1); r.remove(); }
      });
    });
  },
  settingsSheet(compact) {
    this.openSheet(`<h3>${compact ? 'Mixing' : 'Settings'}</h3>
      <div class="setting"><div class="setting-row"><strong>Auto-Mix</strong><label class="switch"><input type="checkbox" id="s-auto" ${settings.autoMix ? 'checked' : ''}><i></i></label></div>
        <small>Blends the next song in before the current one ends, like a DJ.</small></div>
      <div class="setting"><div class="setting-row"><strong>Crossfade length</strong><output id="s-xf-out">${settings.crossfade}s</output></div>
        <input type="range" id="s-xf" min="0" max="20" step="1" value="${settings.crossfade}" aria-label="Crossfade length"></div>
      <div class="setting"><div class="setting-row"><strong>Smart Mix</strong><label class="switch"><input type="checkbox" id="s-smart" ${settings.smartMix ? 'checked' : ''}><i></i></label></div>
        <small>Matches tempo (BPM), lines up the beats, and swaps the bass halfway through.</small></div>
      <div class="setting"><div class="setting-row"><strong>Key Lock</strong><label class="switch"><input type="checkbox" id="s-key" ${settings.keyLock ? 'checked' : ''}><i></i></label></div>
        <small>Keeps the pitch the same when tempo changes.</small></div>
      ${compact ? '' : `<div class="setting"><div class="menu">
        <button data-s="add">${icon('plus')}Add Music from Device</button>
        <button data-s="demo">${icon('wave')}Add Demo Tracks for Mixing</button>
        <button data-s="theme">${icon('gear')}Appearance: <span id="s-theme-name"></span></button>
        <button data-s="wipe" class="danger">${icon('trash')}Delete Entire Library</button></div>
        <small id="s-usage"></small></div>`}`, (b) => {
      const xf = $('#s-xf', b);
      const paint = () => xf.style.setProperty('--p', (xf.value / 20 * 100) + '%');
      paint();
      xf.addEventListener('input', () => { settings.crossfade = +xf.value; $('#s-xf-out', b).textContent = xf.value + 's'; paint(); saveSettings(); this.transport(); });
      $('#s-auto', b).addEventListener('change', (e) => { settings.autoMix = e.target.checked; saveSettings(); this.transport(); });
      $('#s-smart', b).addEventListener('change', (e) => { settings.smartMix = e.target.checked; saveSettings(); });
      $('#s-key', b).addEventListener('change', (e) => { settings.keyLock = e.target.checked; saveSettings(); for (const d of Object.values(Engine.decks)) d.setRate(d.rate); });
      if (compact) return;
      const themes = { auto: 'Automatic', dark: 'Dark', light: 'Light' };
      $('#s-theme-name', b).textContent = themes[store.get('theme', 'auto')];
      if (navigator.storage?.estimate) navigator.storage.estimate().then((e) => { $('#s-usage', b).textContent = `Using ${(e.usage / 1048576).toFixed(0)} MB of ${(e.quota / 1048576 / 1024).toFixed(1)} GB available. Your music is stored on this device only.`; });
      b.querySelector('.menu').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-s]'); if (!btn) return;
        const s = btn.dataset.s;
        if (s === 'add') { this.closeSheet(); $('#file-input').click(); }
        if (s === 'demo') { this.closeSheet(); Demo.add(); }
        if (s === 'theme') {
          const order = ['auto', 'dark', 'light']; const cur = store.get('theme', 'auto');
          const nx = order[(order.indexOf(cur) + 1) % 3]; store.set('theme', nx); applyTheme(); $('#s-theme-name', b).textContent = themes[nx];
        }
        if (s === 'wipe') {
          if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.lastChild.textContent = 'Tap again to delete every song'; return; }
          Engine.decks.A.unload(); Engine.decks.B.unload();
          await Promise.all(['tracks', 'audio', 'art', 'playlists'].map((s2) => DB.clear(s2)));
          Lib.tracks.clear(); Lib.playlists = []; Player.queue = []; Player.original = []; Player.qi = -1;
          this.closeSheet(); this.render(); this.nowPlaying(); toast('Library deleted');
        }
      });
    });
  },
};

async function toggleFav(id) {
  const t = Lib.tracks.get(id); if (!t) return;
  t.fav = !t.fav;
  await DB.put('tracks', t);
  UI.transport();
  if (UI.tab === 'playlists') UI.plId ? UI.renderPlaylist() : UI.renderPlaylists();
  toast(t.fav ? 'Added to Favorites' : 'Removed from Favorites', 1400);
}

function setAutoMix(on) {
  settings.autoMix = on;
  if (on && !settings.crossfade) settings.crossfade = 10;
  saveSettings(); UI.transport();
  toast(on ? 'AutoMix on: songs will blend into each other' : 'AutoMix off', 1800);
}

function playList(ids, start, shuffle) {
  if (!ids.length) return;
  Engine.ensure();
  Player.setQueue(ids, start, { shuffle });
  Player.playIndex(Player.qi);
}

/* =========================================================================
 * Media Session (lock screen / headphones controls)
 * ========================================================================= */
const MediaSessionCtl = {
  init() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession, h = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported */ } };
    h('play', () => { if (!Player.playing) Player.toggle(); });
    h('pause', () => { if (Player.playing) Player.toggle(); });
    h('nexttrack', () => Player.next(true));
    h('previoustrack', () => Player.prev());
    h('seekto', (e) => Player.live.seek(e.seekTime));
  },
  update(t, art) {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || 'Mashup', artwork: art ? [{ src: art, sizes: '512x512' }] : [] });
  },
  tick() {
    if (!('mediaSession' in navigator)) return;
    const d = Player.live;
    navigator.mediaSession.playbackState = d.playing ? 'playing' : 'paused';
    try { if (d.duration) navigator.mediaSession.setPositionState({ duration: d.duration, position: Math.min(d.time, d.duration), playbackRate: d.rate }); } catch { /* ignore */ }
  },
};

/* =========================================================================
 * Demo tracks — synthesized loops at different tempos, so AutoMix can be tried without files
 * ========================================================================= */
const Demo = {
  defs: [
    { title: 'Neon Souk', artist: 'Mashup Demo', bpm: 122, root: 57, prog: [0, -4, -7, -2], seed: 1 },
    { title: 'Desert Drive', artist: 'Mashup Demo', bpm: 124, root: 50, prog: [0, 3, -2, -4], seed: 2 },
    { title: 'Midnight Corniche', artist: 'Mashup Demo', bpm: 126, root: 54, prog: [0, -5, -3, -7], seed: 3 },
  ],
  async render(def) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const sr = 22050, beat = 60 / def.bpm, bars = 32, len = Math.ceil(bars * 4 * beat * sr) + sr;
    const ctx = new OAC(1, len, sr);
    const out = ctx.createDynamicsCompressor(); out.threshold.value = -10; out.ratio.value = 4; out.connect(ctx.destination);
    const noise = ctx.createBuffer(1, sr, sr); const nd = noise.getChannelData(0);
    let s = def.seed * 9301; for (let i = 0; i < nd.length; i++) { s = (s * 9301 + 49297) % 233280; nd[i] = s / 116640 - 1; }
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const kick = (t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
      g.gain.setValueAtTime(0.95, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.4);
    };
    const hit = (t, f, type, dur, vol) => {
      const n = ctx.createBufferSource(); n.buffer = noise;
      const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = type === 'bandpass' ? 0.8 : 0.5;
      const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      n.connect(fl); fl.connect(g); g.connect(out); n.start(t, Math.random() * 0.5); n.stop(t + dur + 0.02);
    };
    const tone = (t, m, dur, type, cutoff, vol) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz(m);
      const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.setValueAtTime(cutoff, t); fl.frequency.exponentialRampToValueAtTime(cutoff * 0.35, t + dur);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + Math.min(0.02, dur / 4)); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(fl); fl.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
    };
    const pad = (t, m, dur) => {
      for (const iv of [0, 3, 7, 10]) for (const det of [-6, 6]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m + 12 + iv); o.detune.value = det;
        const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 1100;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.022, t + dur * 0.35); g.gain.linearRampToValueAtTime(0.0001, t + dur);
        o.connect(fl); fl.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
      }
    };
    const melody = [0, 3, 7, 10, 12, 10, 7, 3];
    for (let bar = 0; bar < bars; bar++) {
      const t0 = 0.05 + bar * 4 * beat;
      const full = bar >= 8 && bar < 24, bassOn = bar >= 4 && bar < 28;
      const root = def.root + def.prog[Math.floor(bar / 2) % 4];
      for (let b = 0; b < 4; b++) {
        const t = t0 + b * beat;
        kick(t);
        hit(t + beat / 2, 8000, 'highpass', 0.05, 0.22);
        if (bar >= 2) hit(t + beat / 4 * 3, 9000, 'highpass', 0.03, 0.08);
        if (full && (b === 1 || b === 3)) hit(t, 1700, 'bandpass', 0.2, 0.5);
        if (bassOn) { tone(t + beat / 2, root - 12, beat * 0.45, 'sawtooth', 520, 0.32); if (b === 3) tone(t + beat * 0.75, root - 12 + 7, beat * 0.2, 'sawtooth', 600, 0.2); }
        if (full && bar % 4 >= 2) tone(t + (b % 2) * beat / 2, root + 12 + melody[(bar * 4 + b + def.seed) % 8], beat * 0.4, 'square', 2600, 0.05);
      }
      if (full && bar % 2 === 0) pad(t0, root, 8 * beat);
    }
    const buf = await new Promise((res, rej) => { const p = ctx.startRendering(); if (p && p.then) p.then(res, rej); else ctx.oncomplete = (e) => res(e.renderedBuffer); });
    return { blob: wav(buf), duration: buf.duration };
  },
  async add() {
    toast('Generating demo tracks…', 0);
    const ids = [];
    try {
      for (const def of this.defs) {
        const { blob, duration } = await this.render(def);
        const t = { id: uid(), title: def.title, artist: def.artist, album: 'Demo Tracks', duration, bpm: def.bpm, beatOffset: 0.05, peaks: null, hasArt: false, addedAt: Date.now(), size: blob.size, demo: true };
        await DB.put('audio', blob, t.id); await DB.put('tracks', t);
        Lib.tracks.set(t.id, t); ids.push(t.id);
      }
    } catch (e) { console.error(e); toast('Couldn’t generate the demo tracks'); return; }
    UI.render(); toast('Added 3 demo tracks. Play one to hear AutoMix.');
    queueAnalysis(ids);
  },
};
function wav(buf) {
  const ch = buf.getChannelData(0), n = ch.length, sr = buf.sampleRate;
  const ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]));
  const k = peak > 0.98 ? 0.98 / peak : 1;
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, clamp(ch[i] * k, -1, 1) * 0x7fff, true);
  return new Blob([ab], { type: 'audio/wav' });
}

/* =========================================================================
 * Visuals — progress and spectrum
 * ========================================================================= */
let vizData;
function frame() {
  const d = Player.live;
  if (d.track) {
    const dur = d.duration, t = d.time;
    $('#mini-bar').style.width = (dur ? t / dur * 100 : 0) + '%';
    if ($('#np').classList.contains('open') && !UI.seeking) {
      const s = $('#np-seek');
      s.value = dur ? Math.round(t / dur * 1000) : 0; s.style.setProperty('--p', (s.value / 10) + '%');
      $('#np-cur').textContent = fmt(t); $('#np-rem').textContent = '-' + fmt((dur - t) / (d.rate || 1));
    }
  }
  if (!$('#np-viz').hidden && $('#np').classList.contains('open')) drawViz();
  requestAnimationFrame(frame);
}
function drawViz() {
  const c = $('#np-viz'); if (!Engine.analyser) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const a = Engine.analyser;
  vizData = vizData || new Uint8Array(a.frequencyBinCount);
  a.getByteFrequencyData(vizData);
  const bars = 48, cx = w / 2, cy = h / 2, r0 = w * 0.2;
  g.fillStyle = 'rgba(255,255,255,.9)';
  for (let i = 0; i < bars; i++) {
    const idx = Math.floor(Math.pow(i / bars, 1.8) * 380) + 2;
    const v = vizData[idx] / 255;
    const ang = (i / bars) * Math.PI * 2 - Math.PI / 2;
    const len = 6 + v * w * 0.26;
    g.save(); g.translate(cx, cy); g.rotate(ang);
    g.globalAlpha = 0.35 + v * 0.65;
    g.fillRect(r0, -2.5, len, 5);
    g.restore();
  }
  const lowE = (vizData[2] + vizData[3] + vizData[4]) / 765;
  g.globalAlpha = 0.18 + lowE * 0.4; g.beginPath(); g.arc(cx, cy, r0 * (0.8 + lowE * 0.3), 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
}

/* =========================================================================
 * Theme
 * ========================================================================= */
function applyTheme() {
  const t = store.get('theme', 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}

/* =========================================================================
 * Events
 * ========================================================================= */
function bind() {
  $('#tabbar').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) UI.setTab(b.dataset.tab); });
  const pick = () => $('#file-input').click();
  $('#btn-add').onclick = pick; $('#btn-add-empty').onclick = pick;
  $('#file-input').addEventListener('change', (e) => { const f = e.target.files; if (f?.length) addFiles(f); e.target.value = ''; });
  $('#btn-demo').onclick = () => Demo.add();
  $('#btn-settings').onclick = () => UI.settingsSheet(false);
  $('#lib-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg]'); if (!b) return;
    UI.seg = b.dataset.seg; UI.filter = null;
    $$('#lib-seg button').forEach((x) => x.setAttribute('aria-selected', x === b));
    UI.renderLibrary();
  });
  $('#btn-play-all').onclick = () => playList(UI.currentListIds, 0, false);
  $('#btn-shuffle-all').onclick = () => playList(UI.currentListIds, 0, true);

  // list interactions (delegated)
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act, row = a.closest('[data-id]');
    if (act === 'play' && row) {
      const ids = UI.currentListIds.length && UI.currentListIds.includes(row.dataset.id) ? UI.currentListIds : [row.dataset.id];
      playList(ids, ids.indexOf(row.dataset.id), false);
    }
    if (act === 'menu' && row) UI.trackMenu(row.dataset.id, $('[data-ctx]', row)?.dataset.ctx);
    if (act === 'filter') { UI.filter = { type: a.dataset.type, value: a.dataset.value }; UI.renderLibrary(); $('#views').scrollTop = 0; }
    if (act === 'clear-filter') { UI.filter = null; UI.renderLibrary(); }
    if (act === 'open-pl') UI.openPlaylist(a.dataset.pl);
    if (act === 'new-pl') UI.newPlaylist();
  });
  $('#btn-new-pl').onclick = () => UI.newPlaylist();
  $('#pl-back').onclick = () => { UI.plId = null; UI.showView('playlists'); UI.renderPlaylists(); };
  $('#pl-more').onclick = () => UI.playlistMenu();
  $('#pl-play').onclick = () => playList(UI.currentListIds, 0, false);
  $('#pl-shuffle').onclick = () => playList(UI.currentListIds, 0, true);
  $('#pl-add-songs').onclick = () => { const pl = Lib.playlists.find((p) => p.id === UI.plId); if (pl) UI.pickSongs(pl); };
  $('#search-input').addEventListener('input', () => UI.renderSearch());

  // mini / now playing
  $('#mini-open').onclick = () => UI.openNP();
  $('#mini-play').onclick = () => Player.toggle();
  $('#mini-next').onclick = () => Player.next(true);
  $('#np-close').onclick = () => UI.closeNP();
  $('#np-play').onclick = () => Player.toggle();
  $('#np-next').onclick = () => Player.next(true);
  $('#np-prev').onclick = () => Player.prev();
  $('#np-fav').onclick = () => { if (Player.current) toggleFav(Player.current.id); };
  $('#np-queue-btn').onclick = () => UI.queueSheet();
  $('#np-xf-btn').onclick = () => setAutoMix(!(settings.autoMix && settings.crossfade > 0));
  $('#np-more').onclick = () => { if (Player.current) UI.trackMenu(Player.current.id); };
  $('#np-viz-btn').onclick = (e) => {
    const on = $('#np-viz').hidden; $('#np-viz').hidden = !on; $('#np-art').hidden = on;
    e.currentTarget.setAttribute('aria-pressed', on);
  };
  const seek = $('#np-seek');
  seek.addEventListener('input', () => {
    UI.seeking = true; seek.style.setProperty('--p', (seek.value / 10) + '%');
    const d = Player.live; $('#np-cur').textContent = fmt(seek.value / 1000 * d.duration);
  });
  seek.addEventListener('change', () => { const d = Player.live; d.seek(seek.value / 1000 * d.duration); UI.seeking = false; });
  const vol = $('#np-vol');
  vol.value = Math.round(settings.volume * 100); vol.style.setProperty('--p', vol.value + '%');
  vol.addEventListener('input', () => { vol.style.setProperty('--p', vol.value + '%'); Engine.setVolume(vol.value / 100); });

  // swipe down to close now playing
  let sy = null;
  const np = $('#np');
  np.addEventListener('touchstart', (e) => {
    if (e.target.closest('input,canvas')) return;
    sy = e.touches[0].clientY;
  }, { passive: true });
  np.addEventListener('touchmove', (e) => {
    if (sy == null) return;
    const dy = Math.max(0, e.touches[0].clientY - sy);
    np.style.transition = 'none'; np.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  np.addEventListener('touchend', (e) => {
    if (sy == null) return;
    const dy = e.changedTouches[0].clientY - sy; sy = null;
    np.style.transition = ''; np.style.transform = '';
    if (dy > 110) UI.closeNP();
  });

  // sheets
  $('#scrim').onclick = () => UI.closeSheet();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#sheet').hidden) UI.closeSheet(); else UI.closeNP(); }
    if (e.key === ' ' && !e.target.closest('input,textarea,button')) { e.preventDefault(); Player.toggle(); }
  });


  // drag & drop files (desktop)
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

  // keep the audio context alive when returning to the app
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Engine.ctx?.state === 'suspended' && Player.playing) Engine.ctx.resume(); });

  setInterval(() => { Player.tick(); MediaSessionCtl.tick(); }, 250);
}

/* =========================================================================
 * Boot
 * ========================================================================= */
async function boot() {
  applyTheme();
  bind();
  MediaSessionCtl.init();
  try { await Lib.load(); } catch (e) { console.error(e); toast('Couldn’t open the library on this device. Private browsing may be on.'); }
  UI.render();
  const tab = store.get('tab', 'library');
  UI.setTab(['library', 'playlists', 'search'].includes(tab) ? tab : 'library');
  UI.transport();
  queueAnalysis([...Lib.tracks.values()].filter((t) => !t.peaks).map((t) => t.id));
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && /^https:|^http:\/\/localhost/.test(location.href) && !window.__NO_SW__) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  window.__mazj = { Engine, Player, Lib, UI, settings }; // for debugging
}
boot();
})();
