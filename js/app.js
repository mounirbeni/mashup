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
const hslToRgb = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
};
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
  autoplay: true,    // when the queue ends, keep going with similar songs from the library
  smartMix: true,    // beat-match tempo + phase and swap bass during the mix
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
      if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return await readMp4(file); // "ftyp"
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
        else if ((id === 'USLT' || id === 'ULT') && !out.lyrics) {
          const e = termEnd(f, 4, enc); // skip language + description
          const txt = (enc === 1 || enc === 2) ? f.subarray(e + 2) : f.subarray(e + 1);
          const dec = enc === 0 ? dLatin : enc === 3 ? d8 : enc === 2 ? d16be : (txt[0] === 0xfe ? d16be : d16le);
          out.lyrics = dec.decode(txt).replace(/^\uFEFF/, '').replace(/\u0000+$/, '').trim() || undefined;
        }
        else if ((id === 'TXXX' || id === 'TXX') && !out.lyrics) {
          // some taggers keep lyrics in a custom text field ("LYRICS", "UNSYNCEDLYRICS", …)
          const e = termEnd(f, 1, enc);
          if (/lyric|uslt/i.test(text(f.subarray(1, e), enc))) out.lyrics = text(f.subarray(e + (enc === 1 || enc === 2 ? 2 : 1)), enc) || undefined;
        }
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
  /* M4A / MP4: walk moov → udta → meta → ilst for title, artist, album, tempo, lyrics and cover */
  async function readMp4(file) {
    const out = {};
    let pos = 0;
    while (pos + 8 <= file.size) {
      const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
      let len = h.getUint32(0), hdr = 8;
      const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      if (len === 1) { len = Number(h.getBigUint64(8)); hdr = 16; } else if (len === 0) len = file.size - pos;
      if (len < 8) break;
      if (type === 'moov') {
        if (len > 64 * 1024 * 1024) break;
        const b = new Uint8Array(await file.slice(pos + hdr, pos + len).arrayBuffer());
        walk(b, 0, b.length, false, out);
        break;
      }
      pos += len;
    }
    return out;
  }
  function walk(b, start, end, inIlst, out) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = start;
    while (p + 8 <= end) {
      const len = dv.getUint32(p);
      if (len < 8 || p + len > end) break;
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      const cs = p + 8, ce = p + len;
      if (type === 'udta') walk(b, cs, ce, false, out);
      else if (type === 'meta') walk(b, cs + 4, ce, false, out); // meta has 4 bytes of version/flags
      else if (type === 'ilst') walk(b, cs, ce, true, out);
      else if (inIlst && ce - cs > 16 && String.fromCharCode(b[cs + 4], b[cs + 5], b[cs + 6], b[cs + 7]) === 'data') {
        const dlen = Math.min(dv.getUint32(cs), ce - cs), kind = dv.getUint32(cs + 8) & 0xffffff;
        const data = b.subarray(cs + 16, cs + dlen);
        const txt = () => d8.decode(data).trim();
        if (type === '\u00a9nam') out.title = txt();
        else if (type === '\u00a9ART') out.artist = txt();
        else if (type === 'aART' && !out.artist) out.artist = txt();
        else if (type === '\u00a9alb') out.album = txt();
        else if (type === '\u00a9lyr') out.lyrics = txt();
        else if (type === 'tmpo' && data.length >= 2) { const v = (data[0] << 8) | data[1]; if (v > 40 && v < 250) out.bpm = v; }
        else if (type === 'covr' && !out.art) out.art = new Blob([data.slice()], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
      }
      p = ce;
    }
  }
  return { read };
})();

/* =========================================================================
 * Analysis — waveform peaks, BPM and first-beat offset
 * ========================================================================= */
const GRID_V = 4; // 4: adds the musical key
const KEY_MIN = 0.03; // below this margin the key is a guess and is ignored
/* Distance between two keys on the Camelot wheel, as DJs use it for harmonic mixing:
 * 0 same key · 1 neighbour (±1 on the wheel, or relative major/minor) · 2 two steps · 3 clash · null unknown */
function keyDistance(a, b) {
  if (!a?.key || !b?.key || (a.keyConf ?? 0) < KEY_MIN || (b.keyConf ?? 0) < KEY_MIN) return null;
  const pa = /^(\d+)([AB])$/.exec(a.key), pb = /^(\d+)([AB])$/.exec(b.key);
  if (!pa || !pb) return null;
  const na = +pa[1], nb = +pb[1], d = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (na === nb && pa[2] === pb[2]) return 0;
  if (na === nb) return 1;
  if (pa[2] === pb[2] && d === 1) return 1;
  if (pa[2] === pb[2] && d === 2) return 2;
  return 3;
}
const FIT_MIN = 2; // songs whose beats stand out less than this are never beat-matched
const ONSET_LAG = 0; // seconds between a beat and where its onset shows in the envelope (calibrated by test)
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
  /* Precise beat grid over the whole song.
   * 1. onset envelope (kick-weighted energy rises) for every ~5.8 ms of audio
   * 2. coarse tempo from tempo() above
   * 3. refine: for tempos within ±1.5 BPM (0.01 steps) measure how strongly the onsets repeat at
   *    that period across the WHOLE song (a single Fourier bin); the strongest wins, and the
   *    phase of that bin is where the beats fall. Confidence = how much of the onset energy lines up. */
  function onsets(ch, sr) {
    const hop = Math.max(64, Math.round(sr / 172)), n = Math.floor(ch.length / hop);
    const a = 1 - Math.exp(-2 * Math.PI * 160 / sr);
    const lowE = new Float32Array(n), fullE = new Float32Array(n);
    let lp = 0;
    for (let f = 0; f < n; f++) {
      let el = 0, ef = 0;
      const o = f * hop;
      for (let j = 0; j < hop; j++) { const x = ch[o + j]; lp += a * (x - lp); el += lp * lp; ef += x * x; }
      lowE[f] = el; fullE[f] = ef;
    }
    const env = new Float32Array(n), kick = new Float32Array(n);
    for (let f = 2; f < n; f++) {
      const l1 = Math.log(1e-7 + lowE[f] + lowE[f - 1]), l0 = Math.log(1e-7 + lowE[f - 1] + lowE[f - 2]);
      const f1 = Math.log(1e-7 + fullE[f] + fullE[f - 1]), f0 = Math.log(1e-7 + fullE[f - 1] + fullE[f - 2]);
      kick[f] = Math.max(0, l1 - l0);
      env[f] = kick[f] * 1.6 + Math.max(0, f1 - f0);
    }
    // subtract a moving average so only the peaks remain
    const w = 32, out = new Float32Array(n);
    let s = 0;
    for (let f = 0; f < n; f++) {
      s += env[f]; if (f >= w) s -= env[f - w];
      out[f] = Math.max(0, env[f] - s / Math.min(f + 1, w));
    }
    return { env: out, kick, fps: sr / hop, hop };
  }
  function bin(env, fps, bpm) {
    const w = 2 * Math.PI * bpm / 60 / fps;
    // rotate a unit phasor instead of calling cos/sin per sample
    const cw = Math.cos(w), sw = Math.sin(w);
    let c = 1, s = 0, re = 0, im = 0;
    for (let n = 0; n < env.length; n++) {
      const v = env[n];
      if (v) { re += v * c; im -= v * s; }
      const c2 = c * cw - s * sw; s = s * cw + c * sw; c = c2;
      if ((n & 1023) === 0) { const m = Math.hypot(c, s); c /= m; s /= m; }
    }
    return { mag: Math.hypot(re, im), ang: Math.atan2(im, re) };
  }
  function grid(ch, sr, hint) {
    const { env, kick, fps, hop } = onsets(ch, sr);
    let total = 0; for (let i = 0; i < env.length; i++) total += env[i];
    if (!total) return null;
    // 1. scan 70–180 BPM over the whole song, gently preferring the usual dance range
    let best = null;
    const consider = (bpm, weight) => { const r = bin(env, fps, bpm); const sc = r.mag * weight; if (!best || sc > best.sc) best = { ...r, bpm, sc }; };
    for (let bpm = 70; bpm <= 180; bpm += 0.5) consider(bpm, 0.7 + 0.3 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.7, 2)));
    if (hint) for (let bpm = hint - 1; bpm <= hint + 1; bpm += 0.25) consider(bpm, 1.05); // a tag's tempo is a strong hint
    // 2. refine around the winner: ±0.6 BPM in 0.02 steps, then ±0.03 in 0.002 steps
    const refine = (span, step) => { const c = best.bpm; for (let bpm = c - span; bpm <= c + span; bpm += step) { const r = bin(env, fps, bpm); if (r.mag > best.mag) best = { ...r, bpm, sc: best.sc }; } };
    refine(0.6, 0.02);
    // 3. the scan can lock onto a related tempo (×3/2 with off-beat-heavy grooves, ×2, ×½):
    //    keep the candidate whose grid lands on the most real hits, measured directly
    const atE = (x) => { const i = Math.floor(x); if (i < 0 || i + 1 >= env.length) return 0; return env[i] + (env[i + 1] - env[i]) * (x - i); };
    const comb = (bpm) => {
      const perF = fps * 60 / bpm; let bestAvg = 0;
      for (let ph = 0; ph < perF; ph += 0.5) { let s = 0, c = 0; for (let x = ph; x < env.length; x += perF) { s += atE(x); c++; } if (s / c > bestAvg) bestAvg = s / c; }
      return bestAvg;
    };
    const base = best.bpm, prior = (b) => 0.85 + 0.15 * Math.exp(-0.5 * Math.pow(Math.log2(b / 120) / 0.7, 2));
    let pick = base, pickScore = comb(base) * prior(base);
    for (const m of [2 / 3, 3 / 2, 1 / 2, 2]) {
      const b = base * m; if (b < 70 || b > 180) continue;
      const sc = comb(b) * prior(b);
      if (sc > pickScore * 1.05) { pick = b; pickScore = sc; }
    }
    if (pick !== base) { const r = bin(env, fps, pick); best = { ...r, bpm: pick, sc: best.sc }; refine(0.6, 0.02); }
    refine(0.03, 0.002);
    const bpm = Math.round(best.bpm * 100) / 100;
    const perF = fps * 60 / bpm;
    // phase → first beat; the onset of a frame shows up about one hop late
    let n0 = (-best.ang / (2 * Math.PI)) * perF;
    n0 = ((n0 % perF) + perF) % perF;
    const per = 60 / bpm;
    // the Fourier phase follows the centre of each onset bump; sharpen it to the bump peaks
    const at = (x) => { const i = Math.floor(x); if (i < 0 || i + 1 >= env.length) return 0; return env[i] + (env[i + 1] - env[i]) * (x - i); };
    let bestD = 0, bestS = -1;
    for (let d = -0.06 * fps; d <= 0.06 * fps; d += 0.25) {
      let sc = 0; for (let x = n0 + d; x < env.length; x += perF) sc += at(x);
      if (sc > bestS) { bestS = sc; bestD = d; }
    }
    n0 += bestD;
    // the beat is where the kick lands: in afrobeats, amapiano, reggaeton… off-beat claps and
    // shakers can be louder than the kick and pull the grid half a beat off
    const kat = (x) => { const c = Math.round(x); let m = 0; for (let i = c - 2; i <= c + 2; i++) if (i >= 0 && i < kick.length && kick[i] > m) m = kick[i]; return m; };
    const kickAvg = (s0) => { let sum = 0, c = 0; for (let x = s0; x < kick.length; x += perF) { sum += kat(x); c++; } return sum / Math.max(1, c); };
    const kOn = kickAvg(n0), kHalf = kickAvg(n0 + perF / 2);
    if (kHalf > kOn * 1.25) n0 = (n0 + perF / 2) % perF;
    // downbeat: the beat of the bar where the kick hits hardest (beat 1), when it's clear
    const bars = [0, 0, 0, 0];
    for (let x = n0, k = 0; x < kick.length; x += perF, k++) bars[k % 4] += kat(x);
    const order = bars.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    const db = order[0][0] > order[1][0] * 1.08 ? order[0][1] : 0;
    // confidence: how far the onsets on this grid stand out from the song's average onset
    let gs = 0, gc = 0;
    for (let x = n0; x < env.length; x += perF) { gs += at(x); gc++; }
    const fit = (gs / Math.max(1, gc)) / (total / env.length);
    const bar = per * 4;
    let beatOffset = ((n0 + db * perF) * hop + ONSET_LAG * sr) / sr; // a downbeat: bars count from here
    beatOffset = ((beatOffset % bar) + bar) % bar;
    return { bpm, beatOffset, conf: Math.round(fit * 100) / 100, kickShift: kHalf > kOn * 1.25, downbeat: db };
  }
  /* ---- musical key ----
   * chromagram (how strongly each of the 12 notes sounds through the song), compared with the
   * Krumhansl–Kessler profiles of the 24 major / minor keys; the best match is the key. */
  function fft(re, im) { // in-place radix-2
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }
  // Albrecht & Shanahan (2013) key profiles, derived from a corpus of real music
  const MAJ = [0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.080, 0.008, 0.081];
  const MIN = [0.220, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052];
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  function corr(a, b) {
    const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
    let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db + 1e-12);
  }
  function camelot(pc, minor) {
    const majorPc = minor ? (pc + 3) % 12 : pc;          // a minor key shares its number with its relative major
    return `${((majorPc * 7) % 12 + 7) % 12 + 1}${minor ? 'A' : 'B'}`;
  }
  function key(buf) {
    const nch = buf.numberOfChannels, len = buf.length, D = Math.max(1, Math.round(buf.sampleRate / 11025));
    const sr = buf.sampleRate / D, N = 4096, chs = []; for (let c = 0; c < nch; c++) chs.push(buf.getChannelData(c));
    // mono, decimated to ~11 kHz (simple averaging is enough below 2 kHz, where the notes are read)
    const m = new Float32Array(Math.floor(len / D));
    for (let i = 0; i < m.length; i++) { let s = 0; const o = i * D; for (const x of chs) for (let j = 0; j < D; j++) s += x[o + j]; m[i] = s / (D * nch); }
    // which note each FFT bin belongs to, for 55 Hz – 2 kHz
    const pcOf = new Int8Array(N / 2).fill(-1);
    for (let k = 1; k < N / 2; k++) { const f = k * sr / N; if (f >= 55 && f <= 2000) pcOf[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12; }
    const win = new Float32Array(N); for (let j = 0; j < N; j++) win[j] = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / N);
    const chroma = new Float64Array(12), re = new Float32Array(N), im = new Float32Array(N);
    let frames = 0;
    for (let o = 0; o + N <= m.length; o += N) {
      for (let j = 0; j < N; j++) { re[j] = m[o + j] * win[j]; im[j] = 0; }
      fft(re, im);
      const c = new Float64Array(12); let mx = 0;
      for (let k = 1; k < N / 2; k++) {
        const p = pcOf[k]; if (p < 0) continue;
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        c[p] += mag;
      }
      for (let i = 0; i < 12; i++) mx = Math.max(mx, c[i]);
      if (mx < 1e-4) continue;                                 // skip silence
      for (let i = 0; i < 12; i++) chroma[i] += c[i] / mx;     // every moment counts equally, loud or quiet
      frames++;
    }
    if (frames < 8) return null;
    const scores = [];
    for (let pc = 0; pc < 12; pc++) {
      const rot = (p) => Array.from({ length: 12 }, (_, i) => p[(i - pc + 12) % 12]);
      scores.push({ pc, minor: false, r: corr(chroma, rot(MAJ)) }, { pc, minor: true, r: corr(chroma, rot(MIN)) });
    }
    scores.sort((a, b) => b.r - a.r);
    const best = scores[0];
    return { key: camelot(best.pc, best.minor), keyName: NAMES[best.pc] + (best.minor ? 'm' : ''), keyConf: Math.round((best.r - scores[1].r) * 1000) / 1000, keyR: Math.round(best.r * 100) / 100 };
  }
  async function run(blob, hint) {
    const buf = await decode(await blob.arrayBuffer());
    const ch = buf.getChannelData(0);
    const g = grid(ch, buf.sampleRate, hint), k = key(buf);
    return { duration: buf.duration, bpm: g?.bpm, beatOffset: g?.beatOffset, beatConf: g?.conf ?? 0, gridV: GRID_V, key: k?.key, keyName: k?.keyName, keyConf: k?.keyConf };
  }
  function fromBuffer(buf, hint) {
    const g = grid(buf.getChannelData(0), buf.sampleRate, hint), k = key(buf);
    return { bpm: g?.bpm, beatOffset: g?.beatOffset, beatConf: g?.conf ?? 0, gridV: GRID_V, key: k?.key, keyName: k?.keyName, keyConf: k?.keyConf };
  }
  return { run, fromBuffer, grid, key };
})();

/* =========================================================================
 * Cloud library — songs and playlists live in private cloud storage,
 * so the same library opens on any phone or computer after signing in.
 * ========================================================================= */
const Api = {
  async call(path, opts = {}) {
    const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 401) { Auth.show(); throw new Error('unauthorized'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
  op(op, data = {}) { return this.call('/api/library', { method: 'POST', body: JSON.stringify({ op, ...data }) }); },
  fileUrl(p) { return '/api/file?p=' + encodeURIComponent(p); },
};

const AUDIO_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff' };
const extOf = (name, type) => {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name || '');
  if (m) return m[1].toLowerCase();
  const hit = Object.entries(AUDIO_TYPES).find(([, t]) => t === type);
  return hit ? hit[0] : 'mp3';
};

let uploader;
async function uploadFile(pathname, body, contentType, onProgress) {
  uploader = uploader || await import('/js/vendor/blob-upload.js');
  return uploader.upload(pathname, body, {
    access: 'private', handleUploadUrl: '/api/upload', contentType,
    multipart: body.size > 8 * 1024 * 1024, onUploadProgress: onProgress,
  });
}

const Lib = {
  tracks: new Map(),
  playlists: [],
  sorted() { return [...this.tracks.values()].sort((a, b) => collator.compare(a.title, b.title)); },
  /* merge a library from the server, keeping existing track objects (the player holds references) */
  apply(lib) {
    const seen = new Set();
    for (const t of lib.tracks || []) {
      seen.add(t.id);
      const cur = this.tracks.get(t.id);
      if (cur) Object.assign(cur, t); else this.tracks.set(t.id, t);
    }
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.tracks.delete(id);
    this.playlists = (lib.playlists || []).sort((a, b) => a.createdAt - b.createdAt);
  },
  async load() { this.apply(await Api.call('/api/library')); },
  async artUrl(id) { const t = this.tracks.get(id); return t?.art ? Api.fileUrl(t.art) : null; },
  async savePlaylist(pl) { this.apply(await Api.op('savePlaylist', { playlist: pl })); },
  async deletePlaylist(id) { this.apply(await Api.op('deletePlaylist', { id })); },
  async updateTrack(id, patch) { this.apply(await Api.op('updateTrack', { id, patch })); },
};

function probeDuration(blob) {
  return new Promise((res) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    let done = (v) => { done = () => {}; URL.revokeObjectURL(url); res(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(-1);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}

/* Upload one song (and its cover) to the cloud, then register it in the library. */
async function uploadTrack(meta, audioBlob, artBlob, label) {
  const ext = extOf(meta.fileName, audioBlob.type);
  const type = audioBlob.type || AUDIO_TYPES[ext] || 'application/octet-stream';
  const t = { ...meta, audio: `audio/${meta.id}.${ext}`, art: null, size: audioBlob.size };
  delete t.fileName;
  await uploadFile(t.audio, audioBlob, type, (p) => toast(`${label} · ${Math.round(p.percentage)}%`, 0));
  if (artBlob) {
    const aext = /png/.test(artBlob.type) ? 'png' : 'jpg';
    try { t.art = `art/${meta.id}.${aext}`; await uploadFile(t.art, artBlob, artBlob.type || 'image/jpeg'); } catch { t.art = null; }
  }
  Lib.apply(await Api.op('addTrack', { track: t }));
}

async function addFiles(files) {
  files = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|opus|alac|aiff?)$/i.test(f.name));
  if (!files.length) { toast('No audio files found'); return; }
  let i = 0, ok = 0, failed = 0;
  for (const f of files) {
    i++;
    const label = `Uploading ${i} of ${files.length}`;
    toast(label + '…', 0);
    const dur = await probeDuration(f);
    if (dur < 0) { failed++; continue; }
    const tags = await Tags.read(f);
    let name = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    let artist = tags.artist, title = tags.title;
    if (!title) {
      const m = name.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (m) { artist = artist || m[1].trim(); title = m[2].trim(); } else title = name;
    }
    // tempo analysis runs on this device once, before upload, so AutoMix can beat-match anywhere
    let a = null;
    try { toast(`Analyzing ${i} of ${files.length}…`, 0); a = await Analysis.run(f, tags.bpm); } catch (e) { console.warn('analysis failed', e); }
    try {
      const id = uid();
      await uploadTrack({
        id, fileName: f.name, title, artist: artist || 'Unknown Artist', album: tags.album || '',
        duration: dur || a?.duration || 0, bpm: a?.bpm || tags.bpm || null, beatOffset: a?.beatOffset ?? null,
        beatConf: a?.beatConf ?? null, gridV: a ? GRID_V : null, key: a?.key || null, keyName: a?.keyName || null, keyConf: a?.keyConf ?? null, analyzed: !!a, addedAt: Date.now(),
      }, f, tags.art, label);
      // lyrics stored inside the file are kept, so they show without a search
      if (tags.lyrics) await Api.call('/api/lyrics?id=' + id, { method: 'POST', body: JSON.stringify({ text: tags.lyrics, source: 'file' }) }).catch(() => {});
      ok++;
      UI.render();
    } catch (e) {
      console.error(e); failed++;
      if (/unauthorized/.test(e.message)) break;
    }
  }
  UI.render();
  toast(ok ? `Added ${songsLabel(ok)} to your cloud library${failed ? ` · ${failed} failed` : ''}` : 'Couldn’t upload these files');
}

async function deleteTrack(id) {
  for (const d of Object.values(Engine.decks)) if (d.track?.id === id) d.unload();
  Lib.apply(await Api.op('deleteTrack', { id }));
  Player.removeFromQueue(id);
  UI.render();
}

/* Songs added before the cloud library existed were kept in this browser only. */
const Local = {
  count: 0,
  async check() {
    try { this.count = (await DB.all('tracks')).length; } catch { this.count = 0; }
    return this.count;
  },
  async migrate() {
    let tracks, playlists;
    try { [tracks, playlists] = await Promise.all([DB.all('tracks'), DB.all('playlists')]); } catch { toast('Couldn’t read the songs saved on this device'); return; }
    let i = 0, ok = 0;
    for (const t of tracks) {
      i++;
      if (Lib.tracks.has(t.id)) { await Promise.all([DB.del('tracks', t.id), DB.del('audio', t.id), DB.del('art', t.id)]); ok++; continue; }
      try {
        const [audio, art] = await Promise.all([DB.get('audio', t.id), DB.get('art', t.id)]);
        if (!audio) continue;
        await uploadTrack({
          id: t.id, fileName: audio.name || '', title: t.title, artist: t.artist, album: t.album,
          duration: t.duration, bpm: t.bpm, beatOffset: t.beatOffset, analyzed: !!t.peaks, fav: !!t.fav, demo: !!t.demo, addedAt: t.addedAt,
        }, audio, art, `Moving ${i} of ${tracks.length} to the cloud`);
        await Promise.all([DB.del('tracks', t.id), DB.del('audio', t.id), DB.del('art', t.id)]);
        ok++; UI.render();
      } catch (e) { console.error(e); if (/unauthorized/.test(e.message)) return; }
    }
    for (const p of playlists) {
      try { await Lib.savePlaylist(p); await DB.del('playlists', p.id); } catch (e) { console.error(e); }
    }
    await this.check();
    UI.render();
    toast(this.count ? `Moved ${songsLabel(ok)}. ${songsLabel(this.count)} couldn’t be moved.` : `Moved ${songsLabel(ok)} to your cloud library`);
  },
};

/* Sign-in screen */
const Auth = {
  show() { $('#login').hidden = false; setTimeout(() => $('#login-pw').focus(), 50); },
  hide() { $('#login').hidden = true; },
  async status() {
    try { const r = await fetch('/api/login', { credentials: 'same-origin' }); return r.ok ? r.json() : { authed: false, offline: true }; }
    catch { return { authed: false, offline: true }; }
  },
  bind(onIn) {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#login-err'), btn = $('#login-btn');
      err.hidden = true; btn.disabled = true;
      try {
        const r = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#login-pw').value }) });
        if (!r.ok) {
          err.textContent = r.status === 401 ? 'That password isn’t right. Try again.' : 'The library isn’t set up yet. Add APP_PASSWORD in Vercel.';
          err.hidden = false; return;
        }
        $('#login-pw').value = '';
        this.hide(); onIn();
      } catch { err.textContent = 'Couldn’t reach the server. Check your connection.'; err.hidden = false; }
      finally { btn.disabled = false; }
    });
  },
  async signOut() {
    await fetch('/api/login', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    location.reload();
  },
};

/* =========================================================================
 * Audio engine — two decks, 3-band EQ + filter each, equal-power crossfader
 * ========================================================================= */
const EQ_MIN = -26, EQ_MAX = 6;

/* Decoded songs, held in memory only (nothing is written to the device).
 * Only the songs on the two players plus the most recent few are kept. */
const Buffers = {
  cache: new Map(),
  get(track) {
    let p = this.cache.get(track.id);
    if (p) { this.cache.delete(track.id); this.cache.set(track.id, p); return p; }
    p = (async () => {
      const r = await fetch(Api.fileUrl(track.audio), { credentials: 'same-origin' });
      if (r.status === 401) { Auth.show(); throw new Error('unauthorized'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.arrayBuffer();
      const ctx = Engine.ensure();
      return new Promise((res, rej) => { const q = ctx.decodeAudioData(data, res, rej); if (q && q.then) q.then(res, rej); });
    })();
    p.catch(() => this.cache.delete(track.id));
    this.cache.set(track.id, p);
    this.trim();
    return p;
  },
  trim() {
    const keep = new Set(Object.values(Engine.decks).map((d) => d.track?.id).filter(Boolean));
    const ids = [...this.cache.keys()];
    for (const id of ids.slice(0, Math.max(0, ids.length - 3))) if (!keep.has(id)) this.cache.delete(id);
  },
};

/* One player. Songs play through the Web Audio engine (not <audio> elements), so two songs
 * can sound at the same time on iPhone and a blend starts on the exact sample. */
/* Time-stretching (WSOLA): plays part of a song at another tempo WITHOUT changing its pitch,
 * the way DJ software and Apple Music's AutoMix do.
 * map: the song plays r0 source-seconds per second for tc seconds (locked to the outgoing
 * tempo during the blend), then eases back linearly to its own tempo over tr seconds. */
const Stretch = {
  srcAt(m, tau) {
    const { s0, r0, tc, tr } = m;
    if (tau <= tc) return s0 + r0 * tau;
    const u = Math.min(tau - tc, tr);
    let s = s0 + r0 * tc + r0 * u + (1 - r0) * u * u / (2 * tr);
    if (tau > tc + tr) s += tau - tc - tr;
    return s;
  },
  /* decimated mono copy of a song for the similarity search (cached on the buffer) */
  mono(buf) {
    if (buf._mono4) return buf._mono4;
    const nch = buf.numberOfChannels, chs = []; for (let c = 0; c < nch; c++) chs.push(buf.getChannelData(c));
    const md = new Float32Array(Math.floor(buf.length / 4));
    for (let i = 0; i < md.length; i++) { let s = 0; const o = i * 4; for (const x of chs) s += x[o] + x[o + 1] + x[o + 2] + x[o + 3]; md[i] = s / (4 * nch); }
    return (buf._mono4 = md);
  },
  render(buf, m) {
    const sr = buf.sampleRate, N = sr > 60000 ? 4096 : 2048, Hs = N / 4;
    const outLen = Math.round((m.tc + m.tr) * sr);
    const nch = buf.numberOfChannels, chs = []; for (let c = 0; c < nch; c++) chs.push(buf.getChannelData(c));
    const len = buf.length, md = this.mono(buf);
    const L = N / 8, R = Hs / 8;            // compare N/2 samples; search ±Hs/2 (in 4x-decimated steps)
    const out = chs.map(() => new Float32Array(outLen + N)), wsum = new Float32Array(outLen + N);
    const win = new Float32Array(N); for (let j = 0; j < N; j++) win[j] = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / N);
    const full = (i) => { let s = 0; for (const x of chs) s += x[i]; return s; };
    let prev = -1;
    for (let o = 0; o < outLen; o += Hs) {
      let p = Math.round(this.srcAt(m, (o + N / 2) / sr) * sr - N / 2);
      if (prev >= 0) {
        // choose the source segment that best continues the previous one (keeps waveforms in phase)
        const target = (prev + Hs) >> 2, base = p >> 2;
        let best = -Infinity, bd = 0;
        for (let d = -R; d <= R; d++) {
          const q = base + d;
          if (q < 0 || q + L >= md.length || target + L >= md.length) continue;
          let dot = 0, en = 0;
          for (let j = 0; j < L; j++) { const a = md[q + j]; dot += a * md[target + j]; en += a * a; }
          const sc = dot / Math.sqrt(en + 1e-9);
          if (sc > best) { best = sc; bd = d; }
        }
        p = (base + bd) * 4;
        // refine to the exact sample
        const t2 = prev + Hs; let bf = -Infinity, bo = 0;
        for (let d = -3; d <= 3; d++) {
          const q = p + d; if (q < 0 || q + 512 >= len || t2 + 512 >= len) continue;
          let dot = 0, en = 0; for (let j = 0; j < 512; j += 2) { const a = full(q + j); dot += a * full(t2 + j); en += a * a; }
          const sc = dot / Math.sqrt(en + 1e-9); if (sc > bf) { bf = sc; bo = d; }
        }
        p += bo;
      }
      if (p + N > len) p = len - N;
      if (p < 0) p = 0;
      for (let c = 0; c < nch; c++) { const x = chs[c], y = out[c]; for (let j = 0; j < N; j++) y[o + j] += x[p + j] * win[j]; }
      for (let j = 0; j < N; j++) wsum[o + j] += win[j];
      prev = p;
    }
    const ab = Engine.ctx.createBuffer(nch, outLen, sr);
    for (let c = 0; c < nch; c++) {
      const y = out[c];
      for (let i = 0; i < outLen; i++) y[i] /= Math.max(wsum[i], 0.05);
      ab.copyToChannel(y.subarray(0, outLen), c);
    }
    return { buffer: ab, map: m, outDur: outLen / sr };
  },
};

class Deck {
  constructor(id) {
    this.id = id;
    this.track = null; this.buffer = null; this.node = null;
    this._playing = false; this.offset = 0; this.t0 = 0; this.loadToken = 0;
    this.eq = { high: 0, mid: 0, low: 0 };
    this.filterVal = 0; this.trimVal = 1; this.rate = 1; this.cue = 0;
    this.glide = null;
  }
  connect(ctx, dest) {
    this.ctx = ctx;
    this.in = ctx.createGain();
    const bq = (type, f, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q) n.Q.value = q; return n; };
    this.low = bq('lowshelf', 220); this.mid = bq('peaking', 1200, 0.8); this.high = bq('highshelf', 3800);
    this.flt = bq('lowpass', 22000, 0.9);
    this.trim = ctx.createGain(); this.xf = ctx.createGain();
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 256;
    this.in.connect(this.low); this.low.connect(this.mid); this.mid.connect(this.high); this.high.connect(this.flt);
    this.flt.connect(this.trim); this.trim.connect(this.xf); this.trim.connect(this.meter); this.xf.connect(dest);
    // echo-out: a tempo-synced, filtered echo used when two songs' tempos are too far apart to blend
    this.echoSend = ctx.createGain(); this.echoSend.gain.value = 0;
    this.echoDelay = ctx.createDelay(2); this.echoFb = ctx.createGain(); this.echoFb.gain.value = 0.42;
    const ehp = bq('highpass', 320), elp = bq('lowpass', 4200);
    this.trim.connect(this.echoSend); this.echoSend.connect(ehp); ehp.connect(elp); elp.connect(this.echoDelay);
    this.echoDelay.connect(this.echoFb); this.echoFb.connect(this.echoDelay); this.echoDelay.connect(dest);
  }
  get playing() { return this._playing; }
  get time() {
    if (!this._playing || !this.ctx) return this.offset;
    if (this.stretch && this.ctx.currentTime < this.stretch.tSwitch) return Stretch.srcAt(this.stretch.map, Math.max(0, this.ctx.currentTime - this.stretch.at));
    return Math.min(this.duration, this.offset + Math.max(0, this.ctx.currentTime - this.t0) * this.rate);
  }
  get duration() { return this.buffer ? this.buffer.duration : (this.track?.duration || 0); }
  get bpmNow() { return this.track?.bpm ? this.track.bpm * this.rate : null; }
  async load(track) {
    this.stopNode(); this._playing = false;
    this.track = track; this.buffer = null; this.offset = 0;
    this.preloadedFor = null; this.prepared = null;
    this.cue = track.beatOffset || 0;
    this.setRate(1);
    const token = ++this.loadToken;
    const buf = await Buffers.get(track);
    if (token !== this.loadToken) throw new Error('superseded');
    this.buffer = buf;
    this.points = buf._points || (buf._points = mixPoints(buf));
    Buffers.trim();
    UI.deckLoaded(this);
    analyzeIfNeeded(track, buf);
  }
  unload() {
    this.loadToken++; this.stopNode(); this._playing = false;
    this.track = null; this.buffer = null; this.offset = 0; this.preloadedFor = null;
    UI.deckLoaded(this); UI.deckState();
  }
  play(when) {
    if (!this.buffer || this._playing || !this.ctx) return;
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    const n = this.ctx.createBufferSource();
    n.buffer = this.buffer;
    n.playbackRate.value = this.rate;
    n.connect(this.in);
    n.onended = () => {
      if (n !== this.node) return;
      this.node = null; this._playing = false; this.offset = this.duration;
      UI.deckState(); Player.onDeckEnded(this);
    };
    this.t0 = Math.max(this.ctx.currentTime, when || 0);
    n.start(this.t0, this.offset);
    this.node = n; this._playing = true;
    UI.deckState();
  }
  playStretched(when, st) {
    if (!this.buffer || !this.ctx) return;
    this.stopNode(); this._playing = false;
    const ctx = this.ctx, at = Math.max(ctx.currentTime, when || 0), xfade = 0.03;
    const tSwitch = at + st.outDur - xfade, sSwitch = Stretch.srcAt(st.map, st.outDur - xfade);
    const n1 = ctx.createBufferSource(), g1 = ctx.createGain();
    n1.buffer = st.buffer; n1.connect(g1); g1.connect(this.in);
    g1.gain.setValueAtTime(1, ctx.currentTime); g1.gain.setValueAtTime(1, tSwitch); g1.gain.linearRampToValueAtTime(0, tSwitch + xfade);
    n1.start(at); n1.stop(tSwitch + xfade + 0.05);
    const n2 = ctx.createBufferSource(), g2 = ctx.createGain();
    n2.buffer = this.buffer; n2.connect(g2); g2.connect(this.in);
    g2.gain.setValueAtTime(0, ctx.currentTime); g2.gain.setValueAtTime(0, tSwitch); g2.gain.linearRampToValueAtTime(1, tSwitch + xfade);
    n2.onended = () => {
      if (n2 !== this.node) return;
      this.node = null; this._playing = false; this.offset = this.duration; this.stopNode();
      UI.deckState(); Player.onDeckEnded(this);
    };
    n2.start(tSwitch, sSwitch);
    this.rate = 1;
    this.node = n2; this.extra = [n1, g1, g2]; this.stretch = { at, map: st.map, tSwitch };
    this.t0 = tSwitch; this.offset = sSwitch; this._playing = true;
    UI.deckState();
  }
  pause() {
    if (!this._playing) return;
    this.offset = this.time; this.stopNode(); this._playing = false;
    UI.deckState();
  }
  stopNode() {
    const n = this.node; this.node = null;
    if (n) { n.onended = null; try { n.stop(); } catch { /* already stopped */ } try { n.disconnect(); } catch { /* ignore */ } }
    if (this.extra) { for (const x of this.extra) { try { x.stop && x.stop(); } catch { /* ignore */ } try { x.disconnect(); } catch { /* ignore */ } } this.extra = null; }
    this.stretch = null;
  }
  seek(t) {
    const was = this._playing;
    if (was) { this.stopNode(); this._playing = false; }
    this.offset = clamp(t, 0, Math.max(0, this.duration - 0.05));
    if (was) this.play();
  }
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
    if (this._playing && this.ctx) { this.offset = this.time; this.t0 = this.ctx.currentTime; }
    this.rate = clamp(r, 0.84, 1.16);
    if (this.node) this.node.playbackRate.setValueAtTime(this.rate, this.ctx.currentTime);
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

/* Loudness map of a song: where the sound really starts (after silence or a near-silent intro)
 * and where the fade-out begins, so blends skip silence and finish before the song dies away. */
function mixPoints(buf) {
  const ch = buf.getChannelData(0), sr = buf.sampleRate, win = Math.floor(sr * 0.1), n = Math.floor(ch.length / win);
  if (n < 50) return { mixIn: 0, mixOut: buf.duration };
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const o = i * win; for (let j = 0; j < win; j += 16) { const v = ch[o + j]; s += v * v; } env[i] = Math.sqrt(s / (win / 16)); }
  const sm = new Float32Array(n); // ~1 s moving average so single hits don't count
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = Math.max(0, i - 5); k <= Math.min(n - 1, i + 5); k++) { s += env[k]; c++; } sm[i] = s / c; }
  const med = Array.from(sm).sort((a, b) => a - b)[Math.floor(n / 2)] || 0;
  let a = 0; while (a < n && sm[a] < med * 0.3) a++;
  let b = n - 1; while (b > a && sm[b] < med * 0.8) b--;
  return { mixIn: Math.min(a * 0.1, buf.duration * 0.25), mixOut: Math.max((b + 1) * 0.1, buf.duration * 0.6) };
}

/* Songs added without tempo info get analysed the first time they're played. */
function analyzeIfNeeded(track, buf) {
  if (track.demo || track.gridV >= GRID_V || track._analysing) return;
  track._analysing = true;
  setTimeout(() => {
    try {
      const r = Analysis.fromBuffer(buf, track.bpm);
      const patch = { analyzed: true, gridV: GRID_V, beatConf: r.beatConf, key: r.key || null, keyName: r.keyName || null, keyConf: r.keyConf ?? null };
      if (r.bpm) patch.bpm = r.bpm;
      if (r.beatOffset != null) patch.beatOffset = r.beatOffset;
      Object.assign(track, patch);
      Lib.updateTrack(track.id, patch).catch(() => {});
    } catch (e) { console.warn('analysis failed', e); }
  }, 1500);
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
      d.connect(ctx, this.master);
      d.setEq('low', d.eq.low); d.setEq('mid', d.eq.mid); d.setEq('high', d.eq.high); d.setFilter(d.filterVal); d.setTrim(d.trimVal);
    }
    this.applyX(this.x, true);
    if (ctx.state !== 'running') ctx.resume();
    // iPhone: declare music playback so sound isn't muted by the silent switch,
    // and keep a silent media element running so the audio session stays active
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }
    try {
      const a = this.keepAlive = new Audio();
      a.loop = true; a.setAttribute('playsinline', '');
      a.src = URL.createObjectURL(wav(ctx.createBuffer(1, 8000, 8000)));
      a.play().catch(() => {});
    } catch { /* ignore */ }
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
  fadeTo(to, dur, onDone, when, separated = false) {
    const ctx = this.ensure();
    if (this.anim) { clearTimeout(this.anim.timer); this.anim = null; }
    const from = this.x, now = Math.max(ctx.currentTime + 0.02, when || 0), steps = 24;
    for (const [d, idx] of [[this.decks.A, 0], [this.decks.B, 1]]) {
      const p = d.xf.gain;
      p.cancelScheduledValues(0);
      p.setValueAtTime(this.gains(from)[idx], now);
      for (let i = 1; i <= steps; i++) {
        const xi = from + (to - from) * (i / steps);
        const k = i / steps;
        // Incompatible rhythms must not play together: fade out, then fade in.
        const g = separated
          ? (idx === to ? Math.sin(Math.max(0, (k - 0.5) * 2) * Math.PI / 2)
            : Math.cos(Math.min(1, k * 2) * Math.PI / 2))
          : this.gains(xi)[idx];
        p.linearRampToValueAtTime(g, now + dur * k);
      }
    }
    this.anim = { from, to, t0: now, dur, timer: setTimeout(() => { this.anim = null; this.x = to; onDone && onDone(); }, (now - ctx.currentTime + dur) * 1000 + 60) };
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
  setQueue(ids, start = 0, { shuffle = false, album = false } = {}) {
    this.original = ids.slice();
    this.albumMode = !!album && !shuffle;
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
    const canMix = mix && !this.albumMode && settings.crossfade > 0 && this.live.playing && this.live.track;
    if (canMix) return this.mixTo(i, { quick: true });
    this.cancelMix();
    const deck = this.live, other = Engine.other(deck);
    other.pause();
    this.qi = i;
    const loading = deck.load(t);
    UI.nowPlaying();
    const slow = setTimeout(() => toast('Loading…', 0), 500);
    try { await loading; } catch (e) {
      clearTimeout(slow);
      if (e.message !== 'superseded' && e.message !== 'unauthorized') toast('Couldn’t load this song. Check your connection.');
      return;
    }
    clearTimeout(slow);
    if ($('#toast').textContent === 'Loading…') $('#toast').hidden = true;
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
  hasNext() {
    if (!this.queue.length) return false;
    if (this.qi + 1 < this.queue.length || this.repeat === 'all') return true;
    return this.autoplayNext();
  },
  /* Autoplay: the queue ran out, so add the library song with the closest tempo that hasn't played recently. */
  autoplayNext() {
    if (!settings.autoplay || this.repeat !== 'off') return false;
    const cur = Lib.tracks.get(this.queue[this.qi]);
    const recent = new Set(this.queue.slice(-Math.max(1, Math.floor(Lib.tracks.size * 0.6))));
    let pool = [...Lib.tracks.values()].filter((t) => t.id !== cur?.id && !recent.has(t.id));
    if (!pool.length) pool = [...Lib.tracks.values()].filter((t) => t.id !== cur?.id);
    if (!pool.length) return false;
    const dist = (t) => {
      let d = 1;
      if (cur?.bpm && t.bpm) {
        const r = t.bpm / cur.bpm;
        d = Math.min(...[r, r * 2, r / 2].map((x) => Math.abs(Math.log2(x)))); // half/double time count as close
        if (d > Math.log2(1.22)) d += 0.3;                                     // too far apart to beat-match
      }
      const kd = keyDistance(cur, t);                                          // harmonic fit (Camelot wheel)
      return d + [0, 0.015, 0.04, 0.09][kd ?? 1];
    };
    pool.sort((a, b) => dist(a) - dist(b) || Math.random() - 0.5);
    const pick = pool[Math.floor(Math.random() * Math.min(2, pool.length))]; // a little variety among the closest
    this.queue.push(pick.id); this.original.push(pick.id);
    return true;
  },
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
    if (on) this.albumMode = false; // a shuffled album isn't heard in order any more, so it can mix
    const cur = this.queue[this.qi];
    if (on) { const rest = this.queue.filter((_, i) => i !== this.qi); this.queue = cur ? [cur, ...shuffleArr(rest)] : shuffleArr(rest); this.qi = cur ? 0 : -1; }
    else { this.queue = this.original.slice(); this.qi = this.queue.indexOf(cur); }
    this.shuffle = on; UI.transport();
  },
  cycleRepeat() { this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat]; UI.transport(); },

  /* ---- mixing ---- */
  /* the song AutoMix should blend into: the same song again when repeating one */
  upcomingIndex() {
    if (this.repeat === 'one') return this.qi;
    return this.hasNext() ? this.nextIndex() : -1;
  },
  /* Can these two songs be beat-matched? The incoming song is time-stretched (pitch kept) to the
   * outgoing tempo, which sounds clean up to about ±22 %; double / half time count too.
   * Returns the source-seconds-per-second rate for the incoming song, or null. */
  tempoMatch(from, toTrack) {
    if (!settings.smartMix) return null;
    const a = from.track, b = toTrack;
    if (!this.beatReliable(a) || !this.beatReliable(b)) return null; // never align songs on a doubtful grid
    const out = a.bpm * from.rate;
    let best = null;
    for (const mult of [1, 2, 0.5]) {
      const rate = out / (b.bpm * mult), d = Math.abs(Math.log(rate));
      if (d <= Math.log(1.22) && (!best || d < best.d)) best = { rate, mult, d };
    }
    return best;
  },
  /* A song's beat grid can be trusted when its beats clearly stand out (and it was analysed
   * with the current method). Slowed, ambient or loosely played songs fail this. */
  beatReliable(t) {
    if (!t?.bpm) return false;
    if (t.demo) return true;
    return (t.gridV || 0) >= GRID_V && (t.beatConf ?? 0) >= FIT_MIN;
  },
  /* When and how to leave a song.
   * blend: tempos match → a long, beat-matched blend, a whole number of bars, starting on a bar line.
   * echo:  tempos too far apart → the old song echoes out on its last beat while the new one
   *        drops in on its first beat, so two rhythms never play against each other.
   * fade:  one of the songs has no reliable beat → a smooth crossfade with a bass swap, no
   *        stretching and no alignment (nothing to align to). */
  plan(from, toTrack) {
    if (this.albumMode && toTrack && from.track?.album && toTrack.album === from.track.album && toTrack.id !== from.track.id) {
      return { start: Math.max(0, from.duration - 0.03), len: 0.03, style: 'gapless' };
    }
    const out = from.points?.mixOut || from.duration;
    const t = from.track, beat = t?.bpm ? 60 / t.bpm : 0, bar = beat * 4;
    const match = this.tempoMatch(from, toTrack);
    let len, style;
    if (match || !settings.smartMix) { // with Smart Mix off: a plain crossfade of the chosen length
      style = 'blend'; len = settings.crossfade;
      if (bar) len = Math.max(2, Math.round(len / bar)) * bar;
      // keys that clash: keep the overlap short (2 bars) so the two melodies are heard together only briefly
      if (settings.smartMix && keyDistance(t, toTrack) === 3) len = Math.min(len, bar ? bar * 2 : 4);
    } else if (!this.beatReliable(t) || !this.beatReliable(toTrack)) {
      style = 'fade';
      len = Math.min(settings.crossfade, 8);
    } else {
      style = 'echo';
      len = beat ? clamp(beat * 2, 0.8, 1.6) : 1.2;
    }
    len = Math.min(len, out * 0.4);
    let start = out - len;
    const step = style === 'blend' ? bar : style === 'echo' ? beat : 0;
    if (step) { const off = t.beatOffset || 0; start = off + Math.floor((start - off) / step) * step; }
    return { start: Math.max(0, start), len, style };
  },
  /* Where the incoming song enters: after its silence or quiet intro, on a bar line. */
  entryPoint(d) {
    const t = d.track, mi = d.points?.mixIn || 0;
    if (!t?.bpm) return mi;
    const bar = 240 / t.bpm, off = t.beatOffset || 0;
    let x = off + Math.ceil((mi - off - 0.05) / bar) * bar;
    while (x < 0) x += bar;
    return x;
  },
  async mixTo(i, { quick = false } = {}) {
    const id = this.queue[i];
    const t = Lib.tracks.get(id);
    if (!t || this.mixing) return;
    const from = this.live, to = Engine.other(from);
    this.mixing = { from, to, i };
    try { if (to.preloadedFor !== id || to.track?.id !== id) await to.load(t); }
    catch (e) { this.mixing = null; if (e.message !== 'superseded') toast('Couldn’t load the next song'); return; }
    to.preloadedFor = null;
    if (!this.mixing) return; // cancelled while loading
    this.qi = i;
    const ctx = Engine.ensure(), now = ctx.currentTime + 0.05;
    let when = now, len, style;
    if (quick) {
      style = this.tempoMatch(from, t) ? 'blend' : (this.beatReliable(from.track) && this.beatReliable(t)) ? 'echo' : 'fade';
      len = (style === 'echo' ? 1.2 : Math.min(settings.crossfade || 4, 4)) * from.rate;
    } else {
      const p = this.plan(from, t);
      len = p.len; style = p.style;
      if (from.time < p.start) when = now + (p.start - from.time) / from.rate;
      else len = Math.max(1, Math.min(len, from.duration - from.time - 0.1));
    }
    this.startMix(from, to, len / from.rate, when, style);
  },
  /* blend deck `to` in over `dur` seconds, starting at audio-clock time `when` */
  startMix(from, to, dur, when, style = 'blend') {
    const ctx = Engine.ensure();
    when = Math.max(when || 0, ctx.currentTime + 0.02);
    this.mixing = this.mixing || { from, to, i: this.qi };
    const smart = settings.smartMix;
    // Freeze any post-mix tempo recovery before calculating the next beat grid.
    from.stopGlide(); to.stopGlide();
    const match = style === 'blend' ? this.tempoMatch(from, to.track) : null;
    // Incompatible rhythms must not play together: the old song echoes out, then the new one comes in.
    const separated = smart && style === 'echo';
    if (separated) dur = Math.min(dur, 1.6);
    const remaining = (from.duration - from.time) / from.rate - (when - ctx.currentTime);
    dur = Math.max(0.02, Math.min(dur, remaining - 0.02));
    to.pause();
    to.setRate(1);
    let start = this.entryPoint(to);
    if (match && from.playing) {
      // land the incoming beat exactly on the outgoing beat (counting in the incoming song's beats)
      const at = from.time + (when - ctx.currentTime) * from.rate;
      const beats = (at - (from.track.beatOffset || 0)) / (60 / from.track.bpm) / match.mult;
      start += (beats - Math.floor(beats)) * 60 / to.track.bpm;
    }
    start = Math.min(start, Math.max(0, to.duration - dur * 1.3 - 1));
    if (style === 'gapless') start = 0;
    if (style === 'gapless') {
      to.seek(0); to.play(when);
    } else if (separated) {
      // echo-out: the old song's last beat repeats as a filtered, tempo-synced echo and rings out,
      // while it fades; the new song starts as its fade-in begins, so its first beat is heard
      const beat = from.track?.bpm ? 60 / from.track.bpm / from.rate : 0.5;
      from.echoDelay.delayTime.setValueAtTime(Math.min(1.9, beat * 0.75), ctx.currentTime);
      const es = from.echoSend.gain;
      es.cancelScheduledValues(0); es.setValueAtTime(0, ctx.currentTime); es.setValueAtTime(0, when);
      es.linearRampToValueAtTime(0.9, when + 0.04); es.setValueAtTime(0.9, when + dur * 0.5); es.linearRampToValueAtTime(0, when + dur * 0.5 + 0.06);
      to.seek(start); to.play(when + dur * 0.5);
      if (Math.abs(from.filterVal) < 0.02) {
        const f = from.flt.frequency;
        f.cancelScheduledValues(0); f.setValueAtTime(22000, ctx.currentTime); f.setValueAtTime(22000, when); f.exponentialRampToValueAtTime(400, when + dur * 0.5);
      }
    } else if (match && Math.abs(match.rate - 1) > 0.003) {
      // the incoming song enters at the outgoing tempo (time-stretched, pitch unchanged) and
      // eases back to its own tempo over the next bars after the blend
      const st = this.stretchFor(to, start, match.rate, dur);
      if (st) to.playStretched(when, st);
      else { to.seek(start); to.setRate(match.rate); to.play(when); } // fallback: plain rate change
    } else { to.seek(start); to.play(when); }
    if (smart && (style === 'blend' || style === 'fade')) {
      // bass swap halfway through, and the outgoing song is gently filtered as it leaves
      const mid = when + dur * 0.5;
      const lowIn = to.low.gain, lowOut = from.low.gain;
      lowIn.cancelScheduledValues(0); lowIn.setValueAtTime(EQ_MIN, ctx.currentTime); lowIn.setValueAtTime(EQ_MIN, mid - 0.05); lowIn.linearRampToValueAtTime(to.eq.low, mid + 0.3);
      lowOut.cancelScheduledValues(0); lowOut.setValueAtTime(from.eq.low, ctx.currentTime); lowOut.setValueAtTime(from.eq.low, mid - 0.05); lowOut.linearRampToValueAtTime(EQ_MIN, mid + 0.3);
      if (Math.abs(from.filterVal) < 0.02) {
        const f = from.flt.frequency;
        f.cancelScheduledValues(0); f.setValueAtTime(22000, ctx.currentTime); f.setValueAtTime(22000, mid); f.exponentialRampToValueAtTime(700, when + dur);
      }
    }
    const handover = () => { if (this.mixing?.to !== to) return; this.live = to; UI.nowPlaying(); if (style !== 'gapless') UI.mixState(true); };
    if (when - ctx.currentTime > 0.1) setTimeout(handover, (when - ctx.currentTime) * 1000); else handover();
    Engine.fadeTo(Engine.sideOf(to), dur, () => {
      from.pause();
      from.setEq('low', from.eq.low);
      from.setFilter(from.filterVal);
      this.mixing = null;
      if (Math.abs(to.rate - 1) > 0.002) to.glideRate(1, 16);
      UI.mixState(false); UI.deckState();
    }, when, separated);
  },
  /* the stretched intro for deck `to`, reusing one prepared ahead of time when it matches */
  stretchFor(to, start, rate, dur) {
    const tr = clamp(16 * 60 / to.track.bpm, 6, 14); // ease back to its own tempo over ~16 beats
    const key = `${to.track.id}|${start.toFixed(2)}|${rate.toFixed(4)}|${dur.toFixed(1)}`;
    if (to.prepared?.key === key) return to.prepared.st;
    try {
      const st = Stretch.render(to.buffer, { s0: start, r0: rate, tc: dur, tr });
      to.prepared = { key, st };
      return st;
    } catch (e) { console.warn('stretch failed', e); return null; }
  },
  cancelMix() { if (this.mixing) Engine.cancelAnim(); },
  mixAborted() {
    if (!this.mixing) return;
    const { from } = this.mixing;
    this.mixing = null;
    from.setEq('low', from.eq.low); from.setFilter(from.filterVal);
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
    if (!settings.autoMix || this.mixing || !d.playing || !d.buffer || settings.crossfade <= 0) return;
    if (d.duration < settings.crossfade * 2.5) return;
    const ni = this.upcomingIndex();
    if (ni < 0) return;
    const p = this.plan(d, Lib.tracks.get(this.queue[ni]));
    const until = (p.start - d.time) / (d.rate || 1); // seconds until the transition should begin
    if (until > 30) return;
    const nid = this.queue[ni], other = Engine.other(d);
    // load the next song ~30 s ahead so the blend starts exactly on time
    if ((other.preloadedFor !== nid || other.track?.id !== nid) && !other.loading && Lib.tracks.has(nid)) {
      other.loading = true;
      other.load(Lib.tracks.get(nid)).then(() => { other.preloadedFor = nid; }).catch(() => {}).finally(() => { other.loading = false; });
    }
    if (until <= 20 && until > 3 && p.style === 'blend' && other.preloadedFor === nid && other.buffer && !other.preparing) {
      const m = this.tempoMatch(d, other.track);
      if (m && Math.abs(m.rate - 1) > 0.003) {
        other.preparing = true;
        setTimeout(() => { try { this.stretchFor(other, this.entryPoint(other), m.rate, p.len / d.rate); } finally { other.preparing = false; } }, 0);
      }
    }
    if (until <= 1.5) this.mixTo(ni);
  },
};
function shuffleArr(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* =========================================================================
 * UI
 * ========================================================================= */
const SKELETON = '<div class="skeleton" aria-label="Loading your library">' + '<div class="sk-row"><i class="sk-art"></i><span><i class="sk-l1"></i><i class="sk-l2"></i></span></div>'.repeat(7) + '</div>';
const UI = {
  loading: true,
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
    const c = $('#lib-content');
    if (this.loading) { // shimmer until the cloud library arrives, instead of a misleading "empty"
      $('#lib-empty').hidden = true; $('#lib-seg').hidden = true; $('#lib-tools').hidden = true;
      if (!c.querySelector('.skeleton')) c.innerHTML = SKELETON;
      return;
    }
    const empty = all.length === 0;
    $('#lib-empty').hidden = !empty;
    $('#lib-seg').hidden = empty; $('#lib-tools').hidden = empty;
    const banner = Local.count ? `<div class="local-banner"><span><strong>${songsLabel(Local.count)} saved only on this device</strong><small>Upload them so they play on all your devices.</small></span><button class="primary-btn small" data-act="migrate">Upload</button></div>` : '';
    if (empty && Local.count) { $('#lib-empty').hidden = true; c.innerHTML = banner; return; }
    if (empty) { c.innerHTML = ''; return; }
    let tracks = all, head = '';
    if (this.filter) {
      tracks = all.filter((t) => this.filter.type === 'album' ? (t.album || 'Unknown Album') === this.filter.value : t.artist === this.filter.value);
      head = `<div class="sub-head"><button class="back-btn" data-act="clear-filter">${icon('back')}${this.filter.type === 'album' ? 'Albums' : 'Artists'}</button></div><h2 class="section-label">${esc(this.filter.value)}</h2>`;
    }
    $('#lib-tools').hidden = !(this.seg === 'songs' || this.filter);
    if (this.seg === 'songs' || this.filter) {
      this.currentListIds = tracks.map((t) => t.id);
      c.innerHTML = (this.filter ? '' : banner + this.shelvesHTML(all)) + head + this.listFor(tracks, 'lib') + `<p class="count-note">${songsLabel(tracks.length)}</p>`;
    } else {
      const key = this.seg === 'albums' ? (t) => t.album || 'Unknown Album' : (t) => t.artist;
      const groups = new Map();
      for (const t of all) { const k = key(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
      const names = [...groups.keys()].sort(collator.compare);
      if (this.seg === 'albums') {
        c.innerHTML = `<div class="grid">${names.map((n) => { const ts = groups.get(n); return `<button class="tile" data-act="filter" data-type="album" data-value="${esc(n)}">${this.artHTML(ts.find((x) => x.art) || ts[0], '')}<span class="t1">${esc(n)}</span><span class="t2">${esc(ts[0].artist)}</span></button>`; }).join('')}</div>`;
      } else {
        c.innerHTML = `<div class="rows">${names.map((n) => { const ts = groups.get(n); return `<div class="row"><button class="row-main" data-act="filter" data-type="artist" data-value="${esc(n)}">${this.artHTML(ts.find((x) => x.art) || ts[0])}<span class="row-text"><span class="t1">${esc(n)}</span><span class="t2">${songsLabel(ts.length)}</span></span></button><span class="row-meta chev">${icon('back')}</span></div>`; }).join('')}</div>`;
      }
    }
    this.hydrateArt(c);
    Motion.enter(c);
  },
  /* "Recently Added" and "Favorites" carousels at the top of the song list */
  shelves: {},
  shelvesHTML(all) {
    if (all.length < 4) return '';
    const recent = all.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 10);
    const favs = all.filter((t) => t.fav).slice(0, 10);
    this.shelves = { recent: recent.map((t) => t.id), fav: favs.map((t) => t.id) };
    const cur = Player.current?.id;
    const shelf = (key, title, ts) => !ts.length ? '' : `<section class="shelf"><h2 class="section-label">${title}</h2><div class="carousel">${ts.map((t) => `<button class="card${t.id === cur ? ' playing' : ''}" data-act="play-shelf" data-shelf="${key}" data-id="${esc(t.id)}">${this.artHTML(t, '')}<span class="t1">${esc(t.title)}</span><span class="t2">${esc(t.artist)}</span></button>`).join('')}</div></section>`;
    return shelf('recent', 'Recently Added', recent) + shelf('fav', 'Favorites', favs) + '<h2 class="section-label">Songs</h2>';
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
    Motion.enter(c);
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
    $('#pl-cover').style.transform = ''; $('#pl-cover').style.opacity = '';
    this.hydrateArt($('#view-playlist'));
    Motion.enter($('#pl-tracks'));
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
  showView(name, kind = 'enter', keepScroll = false) {
    const prev = $('.view:not([hidden])');
    if (prev) Motion.rememberScroll(prev.dataset.view);
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
    if (keepScroll) Motion.restoreScroll(name); else { $('#views').scrollTop = 0; Motion.onScroll(); }
    Motion.playIn($(`.view[data-view="${name}"]`), kind);
  },
  setTab(tab) {
    if (tab === this.tab && this.tabReady) {
      if (tab === 'playlists' && this.plId) { this.plId = null; this.showView('playlists', 'enter-pop', true); this.renderPlaylists(); return; }
      $('#views').scrollTo({ top: 0, behavior: Motion.reduce.matches ? 'auto' : 'smooth' });
      return;
    }
    this.tabReady = true;
    this.tab = tab;
    $$('#tabbar button').forEach((b) => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (tab === 'playlists') { this.plId = null; this.showView('playlists', 'enter', true); this.renderPlaylists(); }
    else this.showView(tab, 'enter', true);
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
    $$('.card[data-id]').forEach((c) => c.classList.toggle('playing', c.dataset.id === id));
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
    const mini = $('#mini');
    if (t && mini.hidden) { mini.classList.remove('enter'); void mini.offsetWidth; mini.classList.add('enter'); }
    if (t && this.miniId && this.miniId !== t.id && !Motion.reduce.matches) {
      const m = $('#mini-open'); m.classList.remove('swap', 'from-left'); void m.offsetWidth;
      m.classList.add('swap'); if (Motion.swapDir === 'left') m.classList.add('from-left');
      setTimeout(() => m.classList.remove('swap', 'from-left'), 450);
    }
    Motion.swapDir = null; this.miniId = t?.id;
    mini.hidden = !t;
    this.markPlaying();
    if (!t) return;
    $('#mini-title').textContent = t.title; $('#mini-artist').textContent = t.artist;
    $('#np-title').textContent = t.title; $('#np-artist').textContent = t.artist + (t.album ? ' — ' + t.album : '');
    $('#mini-art').outerHTML = this.artHTML(t).replace('class="art sm"', 'class="art sm" id="mini-art"');
    $('#np-art').outerHTML = this.artHTML(t, 'xl').replace('class="art xl"', 'class="art xl" id="np-art"');
    this.setNpMode(this.npMode || 'art');
    this.hydrateArt($('#mini')); this.hydrateArt($('#np'));
    this.transport();
    const url = await Lib.artUrl(t.id);
    this.tint(t, url);
    MediaSessionCtl.update(t, url);
  },
  async tint(t, url) {
    const h = hashHue((t.album || t.title) + t.artist);
    let col = `hsl(${h} 55% 28%)`, col2 = `hsl(${(h + 40) % 360} 60% 16%)`;
    this.vizImg = null;
    this.vizRGB = hslToRgb(h, 0.62, 0.46);
    if (url) {
      try {
        const img = new Image(); img.src = url; await img.decode();
        const c = document.createElement('canvas'); c.width = c.height = 12;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 12, 12);
        const d = g.getImageData(0, 0, 12, 12).data;
        let r = 0, gg = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
        r /= n; gg /= n; b /= n;
        this.vizImg = img; this.vizRGB = [r | 0, gg | 0, b | 0];
        const k = 0.55;
        col = `rgb(${r * k | 0},${gg * k | 0},${b * k | 0})`; col2 = `rgb(${r * 0.25 | 0},${gg * 0.25 | 0},${b * 0.25 | 0})`;
      } catch { /* keep hue tint */ }
    }
    $('#np-bg').style.background = `radial-gradient(120% 80% at 50% 20%, ${col}, ${col2})`;
    this.vizColor = col;
    this.npEdge = col2;
    if ($('#np').classList.contains('open')) this.paintEdges(true);
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
  /* while the player is open, paint the page edges (behind Safari's bars) in the player's colour */
  paintEdges(on) {
    const c = on && this.npEdge ? `color-mix(in srgb, ${this.npEdge} 62%, black)` : '';
    document.documentElement.style.background = c;
    document.body.style.background = c;
  },
  /* what fills the Now Playing stage: the cover, the visualizer, or the lyrics */
  setNpMode(mode) {
    this.npMode = mode;
    $('#np-art').hidden = mode !== 'art';
    $('#np-viz').hidden = mode !== 'viz';
    $('#np-lyrics').hidden = mode !== 'lyrics';
    $('#np').classList.toggle('lyrics-mode', mode === 'lyrics');
    $('#np-viz-btn').setAttribute('aria-pressed', mode === 'viz');
    $('#np-lyr-btn').setAttribute('aria-pressed', mode === 'lyrics');
    if (mode === 'lyrics') Lyrics.show(Player.current);
    store.set('npMode', mode);
  },
  openNP() { Motion.openNP(); $('#np').setAttribute('aria-hidden', 'false'); this.paintEdges(true); },
  closeNP() {
    const np = $('#np'); Motion.closeNP(); np.setAttribute('aria-hidden', 'true');
    setTimeout(() => { if (!np.classList.contains('open')) this.paintEdges(false); }, 420);
  },

  /* the two decks run behind the scenes; these keep the player UI in sync */
  deckState() { this.transport(); },
  deckLoaded() {},
  deckRate() {},
  drawWave() {},

  /* ---------- sheets ---------- */
  openSheet(html, mount) {
    this._sheetTok = (this._sheetTok || 0) + 1;
    $('#sheet').classList.remove('closing'); $('#scrim').classList.remove('closing'); $('#sheet').style.transform = '';
    $('#sheet-body').innerHTML = html;
    $('#sheet').hidden = false; $('#scrim').hidden = false;
    this.hydrateArt($('#sheet'));
    mount && mount($('#sheet-body'));
  },
  closeSheet() {
    const tok = this._sheetTok;
    Motion.closeSheet(() => { if (tok !== this._sheetTok) return; $('#sheet').hidden = true; $('#scrim').hidden = true; $('#sheet-body').innerHTML = ''; });
  },
  trackMenu(id, ctx) {
    const t = Lib.tracks.get(id); if (!t) return;
    const inPl = ctx === 'pl' && this.plId && this.plId !== '__fav';
    this.openSheet(`
      <div class="sheet-head">${this.artHTML(t)}<span class="row-text"><span class="t1">${esc(t.title)}</span><span class="t2">${esc(t.artist)}${t.bpm ? ` · ${Math.round(t.bpm)} BPM` : ''}${t.key && (t.keyConf ?? 0) >= KEY_MIN ? ` · ${t.key} (${esc(t.keyName || '')})` : ''}</span></span></div>
      <div class="menu">
        <button data-m="next">${icon('queue')}Play Next</button>
        <button data-m="queue">${icon('list')}Add to Queue</button>
        <button data-m="lyrics">${icon('lyrics')}Lyrics…</button>
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
        if (m === 'lyrics') { this.closeSheet(); Lyrics.editor(t); }
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
  openPlaylist(id) { this.plId = id; this.renderPlaylist(); this.showView('playlist', 'enter-push'); },
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
          await Lib.deletePlaylist(pl.id);
          this.closeSheet(); this.plId = null; this.showView('playlists'); this.renderPlaylists();
        }
      });
    });
  },
  queueSheet() {
    const cur = Player.current;
    if (cur) Player.hasNext(); // lets Autoplay line up the next song so it shows here
    const up = [];
    for (let i = Player.qi + 1; i < Player.queue.length; i++) { const t = Lib.tracks.get(Player.queue[i]); if (t) up.push([i, t]); }
    if (Player.repeat === 'all') for (let i = 0; i < Player.qi; i++) { const t = Lib.tracks.get(Player.queue[i]); if (t) up.push([i, t]); }
    this.openSheet(`
      ${cur ? `<h3>Now Playing</h3><div class="sheet-head queue-now">${this.artHTML(cur)}<span class="row-text"><span class="t1">${esc(cur.title)}</span><span class="t2">${esc(cur.artist)}</span></span></div>` : ''}
      <div class="q-head"><h3>Up Next</h3><span class="q-sub">${Player.albumMode ? 'Album · plays in order without transitions' : settings.autoMix && settings.crossfade ? 'Songs blend into each other' : 'Songs play back to back'}${settings.autoplay ? ' · Autoplay on' : ''}</span></div>
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
      <div class="setting"><div class="setting-row"><strong>Autoplay</strong><label class="switch"><input type="checkbox" id="s-autoplay" ${settings.autoplay ? 'checked' : ''}><i></i></label></div>
        <small>When your songs run out, keep playing songs from your library with a similar tempo.</small></div>
      <div class="setting"><div class="setting-row"><strong>Smart Mix</strong><label class="switch"><input type="checkbox" id="s-smart" ${settings.smartMix ? 'checked' : ''}><i></i></label></div>
        <small>Matches tempo (BPM), lines up the beats, and swaps the bass halfway through.</small></div>
      ${compact ? '' : `<div class="setting"><div class="menu">
        <button data-s="add">${icon('plus')}Add Music from Device</button>
        <button data-s="demo">${icon('wave')}Add Demo Tracks for Mixing</button>
        ${Local.count ? `<button data-s="migrate">${icon('plus')}Upload ${songsLabel(Local.count)} saved on this device</button>` : ''}
        <button data-s="theme">${icon('gear')}Appearance: <span id="s-theme-name"></span></button>
        <button data-s="signout">${icon('back')}Sign Out</button>
        <button data-s="wipe" class="danger">${icon('trash')}Delete Entire Library</button></div>
        <small id="s-usage"></small></div>`}`, (b) => {
      const xf = $('#s-xf', b);
      const paint = () => xf.style.setProperty('--p', (xf.value / 20 * 100) + '%');
      paint();
      xf.addEventListener('input', () => { settings.crossfade = +xf.value; $('#s-xf-out', b).textContent = xf.value + 's'; paint(); saveSettings(); this.transport(); });
      $('#s-auto', b).addEventListener('change', (e) => { settings.autoMix = e.target.checked; saveSettings(); this.transport(); });
      $('#s-autoplay', b).addEventListener('change', (e) => { settings.autoplay = e.target.checked; saveSettings(); });
      $('#s-smart', b).addEventListener('change', (e) => { settings.smartMix = e.target.checked; saveSettings(); });
      if (compact) return;
      const themes = { auto: 'Automatic', dark: 'Dark', light: 'Light' };
      $('#s-theme-name', b).textContent = themes[store.get('theme', 'auto')];
      const mb = [...Lib.tracks.values()].reduce((n, t) => n + (t.size || 0), 0) / 1048576;
      $('#s-usage', b).textContent = `${songsLabel(Lib.tracks.size)} · ${mb.toFixed(0)} MB in your private cloud library. Sign in with the same password on any device to play them.`;
      b.querySelector('.menu').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-s]'); if (!btn) return;
        const s = btn.dataset.s;
        if (s === 'add') { this.closeSheet(); $('#file-input').click(); }
        if (s === 'demo') { this.closeSheet(); Demo.add(); }
        if (s === 'migrate') { this.closeSheet(); Local.migrate(); }
        if (s === 'signout') { Auth.signOut(); }
        if (s === 'theme') {
          const order = ['auto', 'dark', 'light']; const cur = store.get('theme', 'auto');
          const nx = order[(order.indexOf(cur) + 1) % 3]; store.set('theme', nx); applyTheme(); $('#s-theme-name', b).textContent = themes[nx];
        }
        if (s === 'wipe') {
          if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.lastChild.textContent = 'Tap again to delete every song'; return; }
          Engine.decks.A.unload(); Engine.decks.B.unload();
          toast('Deleting your library…', 0);
          Lib.apply(await Api.op('wipe')); Player.queue = []; Player.original = []; Player.qi = -1;
          this.closeSheet(); this.render(); this.nowPlaying(); toast('Library deleted');
        }
      });
    });
  },
};

async function toggleFav(id) {
  const t = Lib.tracks.get(id); if (!t) return;
  const fav = !t.fav;
  t.fav = fav; UI.transport();
  try { await Lib.updateTrack(id, { fav }); } catch { t.fav = !fav; UI.transport(); toast('Couldn’t save. Check your connection.'); return; }
  if (UI.tab === 'playlists') UI.plId ? UI.renderPlaylist() : UI.renderPlaylists();
  Motion.pop($('#np-fav'));
  if (UI.tab === 'library') UI.renderLibrary();
  toast(t.fav ? 'Added to Favorites' : 'Removed from Favorites', 1400);
}

function setAutoMix(on) {
  settings.autoMix = on;
  if (on && !settings.crossfade) settings.crossfade = 10;
  saveSettings(); UI.transport();
  toast(on ? 'AutoMix on: songs will blend into each other' : 'AutoMix off', 1800);
}

function playList(ids, start, shuffle, opts = {}) {
  if (!ids.length) return;
  Engine.ensure();
  Player.setQueue(ids, start, { shuffle, album: opts.album });
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
        const id = uid();
        await uploadTrack({ id, fileName: id + '.wav', title: def.title, artist: def.artist, album: 'Demo Tracks', duration, bpm: def.bpm, beatOffset: 0.05, beatConf: 99, gridV: GRID_V, analyzed: true, demo: true, addedAt: Date.now() }, blob, null, `Uploading demo ${ids.length + 1} of 3`);
        ids.push(id);
      }
    } catch (e) { console.error(e); toast('Couldn’t generate the demo tracks'); return; }
    UI.render(); toast('Added 3 demo tracks. Play one to hear AutoMix.');
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
  if (UI.npMode === 'lyrics' && $('#np').classList.contains('open') && Player.current) Lyrics.sync(Player.live.time);
  requestAnimationFrame(frame);
}
/* Now Playing visualizer: mirrored, log-spaced spectrum ring with auto-levelling per band,
 * fast-attack / slow-release motion, falling peak caps, a beat-reactive centre that spins the
 * cover like a record, and ripples on each kick. Colours come from the song's artwork. */
const Viz = {
  BANDS: 36,
  level: null, peak: null, peakHold: null, ceil: null,
  bassAvg: 0, lastBeat: 0, pulse: 0, spin: 0, idle: 0, rings: [], t: 0,
  freq: null, edges: null,
  reduce: matchMedia('(prefers-reduced-motion: reduce)'),
  setup(a) {
    const n = this.BANDS;
    this.level = new Float32Array(n); this.peak = new Float32Array(n); this.peakHold = new Float32Array(n);
    this.ceil = new Float32Array(n).fill(0.35);
    this.freq = new Uint8Array(a.frequencyBinCount);
    // log-spaced band edges from 35 Hz to 15 kHz, in FFT bins
    const hz = a.context.sampleRate / a.fftSize, lo = 35, hi = Math.min(15000, a.context.sampleRate / 2.2);
    this.edges = Array.from({ length: n + 1 }, (_, i) => Math.max(1, Math.round(lo * Math.pow(hi / lo, i / n) / hz)));
    for (let i = 1; i <= n; i++) if (this.edges[i] <= this.edges[i - 1]) this.edges[i] = this.edges[i - 1] + 1;
    a.minDecibels = -90; a.maxDecibels = -18; a.smoothingTimeConstant = 0.55;
    this.analyser = a;
  },
  color() {
    // the song's tint, lifted so it reads on the dark background
    const [r, g, b] = UI.vizRGB || [190, 70, 80];
    const lift = (v) => Math.round(v + (255 - v) * 0.55);
    return { base: `rgb(${r},${g},${b})`, light: `rgb(${lift(r)},${lift(g)},${lift(b)})`, rgb: [lift(r), lift(g), lift(b)] };
  },
  draw(dt) {
    const c = $('#np-viz'), a = Engine.analyser;
    if (!a) return;
    if (this.analyser !== a) this.setup(a);
    const dpr = Math.min(3, window.devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const playing = Player.playing, calm = this.reduce.matches;
    this.t += dt;

    // ---- analyse ----
    a.getByteFrequencyData(this.freq);
    const n = this.BANDS, f = this.freq, E = this.edges;
    let bass = 0;
    for (let i = 0; i < n; i++) {
      let s = 0, m = 0;
      for (let k = E[i]; k < E[i + 1]; k++) { s += f[k]; if (f[k] > m) m = f[k]; }
      let v = (0.6 * m + 0.4 * s / (E[i + 1] - E[i])) / 255;
      v *= 1 + i / n * 0.6;                                // lift the highs a little (spectral tilt)
      this.ceil[i] = Math.max(v, this.ceil[i] * 0.997, 0.25); // per-band auto-level
      v = Math.min(1, v / this.ceil[i]);
      v = playing ? Math.pow(v, 1.6) : 0;
      // fast attack, slow release
      const L = this.level[i];
      this.level[i] = v > L ? L + (v - L) * Math.min(1, dt * 28) : L + (v - L) * Math.min(1, dt * 5);
      if (this.level[i] >= this.peak[i]) { this.peak[i] = this.level[i]; this.peakHold[i] = 0.35; }
      else if ((this.peakHold[i] -= dt) <= 0) this.peak[i] = Math.max(this.level[i], this.peak[i] - dt * 0.55);
      if (i < 5) bass += this.level[i] / 5;
    }

    // ---- beat ----
    this.bassAvg += (bass - this.bassAvg) * Math.min(1, dt * 2.5);
    const now = this.t;
    if (playing && bass > 0.32 && bass > this.bassAvg * 1.28 && now - this.lastBeat > 0.28) {
      this.lastBeat = now; this.pulse = 1;
      if (!calm) this.rings.push({ r: 0, a: 0.55 });
    }
    this.pulse = Math.max(0, this.pulse - dt * 3.2);
    this.idle += ((playing ? 0 : 1) - this.idle) * Math.min(1, dt * 2);
    if (playing && !calm) this.spin += dt * 0.35;

    // ---- geometry ----
    const cx = w / 2, cy = h / 2, S = Math.min(w, h);
    const R = S * 0.215 * (1 + this.pulse * 0.045 + Math.sin(now * 1.6) * 0.012 * this.idle);
    const maxLen = S * 0.25;
    const col = this.color();

    // soft glow behind everything
    const glow = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 2.4);
    glow.addColorStop(0, `rgba(${col.rgb.join(',')},${0.22 + bass * 0.25 + this.pulse * 0.12})`);
    glow.addColorStop(1, `rgba(${col.rgb.join(',')},0)`);
    g.fillStyle = glow; g.fillRect(0, 0, w, h);

    // ripples on each kick
    g.lineWidth = 1.5;
    this.rings = this.rings.filter((ring) => {
      ring.r += dt * S * 0.32; ring.a -= dt * 0.55;
      if (ring.a <= 0) return false;
      g.strokeStyle = `rgba(255,255,255,${ring.a * 0.5})`;
      g.beginPath(); g.arc(cx, cy, R + 6 + ring.r, 0, Math.PI * 2); g.stroke();
      return true;
    });

    // mirrored spectrum: bass at the bottom, highs meeting at the top
    const bars = n * 2, step = (Math.PI * 2) / bars;
    const thick = Math.max(2.5, (2 * Math.PI * (R + 7) / bars) * 0.5);
    g.lineCap = 'round';
    for (let j = 0; j < bars; j++) {
      const i = j < n ? j : bars - 1 - j;                       // mirror
      const v = this.level[i];
      const breathe = this.idle * (0.05 + 0.04 * Math.sin(now * 2 + i * 0.35));
      const len = 3 + (v + breathe) * maxLen;
      const ang = Math.PI / 2 + (j + 0.5) * step;               // start at the bottom
      const cos = Math.cos(ang), sin = Math.sin(ang), r0 = R + 7;
      g.strokeStyle = `rgba(${col.rgb.join(',')},${0.45 + v * 0.55})`;
      g.lineWidth = thick;
      g.beginPath(); g.moveTo(cx + cos * r0, cy + sin * r0); g.lineTo(cx + cos * (r0 + len), cy + sin * (r0 + len)); g.stroke();
      // bright core on loud bands
      if (v > 0.35) {
        g.strokeStyle = `rgba(255,255,255,${(v - 0.35) * 0.9})`;
        g.lineWidth = thick * 0.45;
        g.beginPath(); g.moveTo(cx + cos * r0, cy + sin * r0); g.lineTo(cx + cos * (r0 + len * 0.85), cy + sin * (r0 + len * 0.85)); g.stroke();
      }
      // falling peak cap
      const pk = this.peak[i];
      if (pk > 0.04) {
        const pr = r0 + 3 + pk * maxLen + thick;
        g.fillStyle = `rgba(255,255,255,${0.35 + pk * 0.5})`;
        g.beginPath(); g.arc(cx + cos * pr, cy + sin * pr, thick * 0.38, 0, Math.PI * 2); g.fill();
      }
    }

    // centre: the cover, spinning like a record, with a light ring that thumps on the beat
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.closePath();
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 24;
    g.fillStyle = col.base; g.fill();
    g.shadowBlur = 0;
    g.clip();
    g.translate(cx, cy); g.rotate(this.spin);
    const img = UI.vizImg;
    if (img && img.complete && img.naturalWidth) g.drawImage(img, -R, -R, R * 2, R * 2);
    else {
      const gr = g.createLinearGradient(-R, -R, R, R);
      gr.addColorStop(0, col.light); gr.addColorStop(1, col.base);
      g.fillStyle = gr; g.fillRect(-R, -R, R * 2, R * 2);
      // record label
      const lab = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.42);
      lab.addColorStop(0, 'rgba(255,255,255,.55)'); lab.addColorStop(1, 'rgba(255,255,255,.22)');
      g.fillStyle = lab; g.beginPath(); g.arc(0, 0, R * 0.38, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.7)'; g.fillRect(-R * 0.2, -R * 0.2, R * 0.14, R * 0.035); // a tick on the label shows the spin
    }
    // vinyl grooves + sheen
    g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1;
    for (let k = 0.45; k < 1; k += 0.11) { g.beginPath(); g.arc(0, 0, R * k, 0, Math.PI * 2); g.stroke(); }
    const sheen = g.createLinearGradient(-R, -R, R, R);
    sheen.addColorStop(0, 'rgba(255,255,255,.18)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0)'); sheen.addColorStop(1, 'rgba(255,255,255,.08)');
    g.fillStyle = sheen; g.fillRect(-R, -R, R * 2, R * 2);
    g.restore();
    // spindle hole
    g.fillStyle = 'rgba(10,8,12,.85)';
    g.beginPath(); g.arc(cx, cy, R * 0.09, 0, Math.PI * 2); g.fill();
    // edge ring
    g.strokeStyle = `rgba(255,255,255,${0.25 + this.pulse * 0.55})`;
    g.lineWidth = 1.5 + this.pulse * 2;
    g.beginPath(); g.arc(cx, cy, R + 1, 0, Math.PI * 2); g.stroke();
  },
};
let vizLast = 0;
function drawViz() {
  const now = performance.now();
  const dt = Math.min(0.05, vizLast ? (now - vizLast) / 1000 : 0.016);
  vizLast = now;
  Viz.draw(dt);
}

/* =========================================================================
 * Lyrics — time-synced lines that light up and scroll with the song (tap a line to jump),
 * or plain text when only unsynced lyrics exist.
 * ========================================================================= */
const Lyrics = {
  cache: new Map(), shownId: null, lines: null, active: -2, userScrollUntil: 0,
  parse(data) {
    if (!data || data.none) return null;
    if (data.lrc) {
      const out = [], scale = data.scale || 1;
      let offset = 0;
      for (const raw of data.lrc.split('\n')) {
        const om = raw.match(/^\s*\[offset:\s*([+-]?\d+)\]/i);
        if (om) { offset = +om[1] / 1000; continue; }
        const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
        if (!stamps.length) continue;
        const text = raw.replace(/\[[^\]]*\]/g, '').trim();
        for (const m of stamps) {
          const t = (+m[1] * 60 + +m[2] + (m[3] ? +m[3] / Math.pow(10, m[3].length) : 0) - offset) * scale;
          out.push({ t: Math.max(0, t), text });
        }
      }
      out.sort((a, b) => a.t - b.t);
      if (out.length) return { synced: true, lines: out };
    }
    if (data.plain) return { synced: false, lines: data.plain.split('\n').map((text) => ({ t: null, text: text.trim() })) };
    return null;
  },
  async get(track, fresh) {
    if (!fresh && this.cache.has(track.id)) return this.cache.get(track.id);
    if (fresh) await Api.call('/api/lyrics?id=' + encodeURIComponent(track.id), { method: 'DELETE' }).catch(() => {});
    const p = Api.call('/api/lyrics?id=' + encodeURIComponent(track.id)).catch((e) => ({ none: true, error: e.message === 'unauthorized' ? '' : 'Couldn’t load lyrics. Check your connection.' }));
    this.cache.set(track.id, p);
    const data = await p;
    if (data.error) this.cache.delete(track.id); // try again next time
    return data;
  },
  async show(track, fresh) {
    const box = $('#np-lyrics');
    if (!track) { box.innerHTML = ''; this.shownId = null; return; }
    if (this.shownId === track.id && !fresh) return;
    this.shownId = track.id; this.lines = null; this.active = -2;
    box.innerHTML = `<div class="lyr-msg"><span class="lyr-dots"><i></i><i></i><i></i></span></div>`;
    const data = await this.get(track, fresh);
    if (this.shownId !== track.id) return; // song changed meanwhile
    const parsed = this.parse(data);
    if (!parsed) {
      box.innerHTML = `<div class="lyr-msg"><p>${esc(data.error || 'No lyrics found for this song.')}</p>
        <button class="lyr-add" data-lyr="edit">${data.error ? 'Try Again' : 'Add Lyrics'}</button></div>`;
      if (data.error) box.querySelector('[data-lyr]').dataset.lyr = 'retry';
      return;
    }
    this.lines = parsed;
    const credit = data.source === 'lrclib' ? 'Lyrics from LRCLIB' : data.source === 'file' ? 'Lyrics from the song file' : 'Lyrics added by you';
    box.innerHTML = `<div class="lyr-pad"></div>${parsed.lines.map((l, i) => l.text
      ? `<p class="lyr-line" dir="auto" data-i="${i}"${parsed.synced ? ` data-t="${l.t.toFixed(2)}"` : ''}>${esc(l.text)}</p>`
      : parsed.synced ? `<p class="lyr-line lyr-gap" data-i="${i}" data-t="${l.t.toFixed(2)}"><span class="lyr-dots"><i></i><i></i><i></i></span></p>` : `<p class="lyr-line" data-i="${i}"></p>`).join('')}
      <p class="lyr-credit">${parsed.synced ? '' : 'These lyrics aren’t time-synced. '}${credit} · <button data-lyr="edit">Edit</button></p><div class="lyr-pad"></div>`;
    box.classList.toggle('synced', parsed.synced);
    box.scrollTop = 0;
  },
  /* called every frame while lyrics are on screen */
  sync(time) {
    const L = this.lines;
    if (!L || !L.synced) return;
    const t = time + 0.25; // light the line a moment early, like a singer's breath
    let lo = 0, hi = L.lines.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (L.lines[m].t <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
    if (idx === this.active) return;
    this.active = idx;
    const box = $('#np-lyrics');
    $$('.lyr-line', box).forEach((p) => { const i = +p.dataset.i; p.classList.toggle('on', i === idx); p.classList.toggle('past', i < idx); });
    const el = box.querySelector(`.lyr-line[data-i="${idx}"]`);
    if (el && performance.now() > this.userScrollUntil) {
      box.scrollTo({ top: el.offsetTop - box.clientHeight * 0.3, behavior: Viz.reduce.matches ? 'auto' : 'smooth' });
    }
  },
  editor(track) {
    const cached = this.cache.get(track.id);
    Promise.resolve(cached || this.get(track)).then((data) => {
      const text = data?.lrc || data?.plain || '';
      UI.openSheet(`<h3>Lyrics · ${esc(track.title)}</h3>
        <form id="lyr-form">
          <textarea class="text-input lyr-text" id="lyr-text" dir="auto" rows="12" placeholder="Paste the lyrics here">${esc(text)}</textarea>
          <small class="lyr-hint">To sync lines with the music, start each line with its time, like <b>[01:23.45]</b>. Lines without times show as plain lyrics.</small>
          <div class="sheet-actions">
            <button type="button" class="ghost-btn" data-lyr-search>Search Again</button>
            <button class="primary-btn" type="submit">Save</button>
          </div>
        </form>`, (b) => {
        $('[data-lyr-search]', b).onclick = async () => { UI.closeSheet(); toast('Searching for lyrics…', 1500); await this.show(track, true); };
        $('#lyr-form', b).addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            const data2 = await Api.call('/api/lyrics?id=' + encodeURIComponent(track.id), { method: 'POST', body: JSON.stringify({ text: $('#lyr-text', b).value }) });
            this.cache.set(track.id, Promise.resolve(data2));
            UI.closeSheet(); toast('Lyrics saved', 1400);
            if (this.shownId === track.id || UI.npMode === 'lyrics') { this.shownId = null; this.show(track); }
          } catch { toast('Couldn’t save the lyrics. Check your connection.'); }
        });
      });
    });
  },
  bind() {
    const box = $('#np-lyrics');
    box.addEventListener('click', (e) => {
      const act = e.target.closest('[data-lyr]')?.dataset.lyr;
      const t = Player.current;
      if (act === 'edit' && t) return this.editor(t);
      if (act === 'retry' && t) { this.cache.delete(t.id); this.shownId = null; return this.show(t); }
      const line = e.target.closest('.lyr-line[data-t]');
      if (line) { Player.live.seek(+line.dataset.t); this.userScrollUntil = 0; this.active = -2; }
    });
    // let the reader scroll freely for a few seconds before following the song again
    const hold = () => { this.userScrollUntil = performance.now() + 4000; };
    box.addEventListener('touchmove', hold, { passive: true });
    box.addEventListener('wheel', hold, { passive: true });
  },
};

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
  $('#tabbar').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; b.classList.remove('bounce'); void b.offsetWidth; b.classList.add('bounce'); UI.setTab(b.dataset.tab); });
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
      // playing from an album: its songs follow each other gaplessly, in order, like the record
      const album = ids === UI.currentListIds && UI.tab === 'library' && UI.filter?.type === 'album';
      playList(ids, ids.indexOf(row.dataset.id), false, { album });
    }
    if (act === 'menu' && row) UI.trackMenu(row.dataset.id, $('[data-ctx]', row)?.dataset.ctx);
    if (act === 'filter') { UI.filter = { type: a.dataset.type, value: a.dataset.value }; UI.renderLibrary(); $('#views').scrollTop = 0; }
    if (act === 'clear-filter') { UI.filter = null; UI.renderLibrary(); }
    if (act === 'open-pl') UI.openPlaylist(a.dataset.pl);
    if (act === 'play-shelf') { const ids = UI.shelves[a.dataset.shelf] || [a.dataset.id]; playList(ids, Math.max(0, ids.indexOf(a.dataset.id)), false); }
    if (act === 'new-pl') UI.newPlaylist();
    if (act === 'migrate') Local.migrate();
  });
  $('#btn-new-pl').onclick = () => UI.newPlaylist();
  $('#pl-back').onclick = () => { UI.plId = null; UI.showView('playlists', 'enter-pop', true); UI.renderPlaylists(); };
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
  $('#np-play').onclick = (e) => { const b = e.currentTarget; b.classList.remove('tap'); void b.offsetWidth; b.classList.add('tap'); Player.toggle(); };
  $('#np-next').onclick = () => Player.next(true);
  $('#np-prev').onclick = () => Player.prev();
  $('#np-fav').onclick = () => { if (Player.current) toggleFav(Player.current.id); };
  $('#np-queue-btn').onclick = () => UI.queueSheet();
  $('#np-xf-btn').onclick = () => setAutoMix(!(settings.autoMix && settings.crossfade > 0));
  $('#np-more').onclick = () => { if (Player.current) UI.trackMenu(Player.current.id); };
  $('#np-viz-btn').onclick = () => UI.setNpMode(UI.npMode === 'viz' ? 'art' : 'viz');
  $('#np-lyr-btn').onclick = () => UI.setNpMode(UI.npMode === 'lyrics' ? 'art' : 'lyrics');
  UI.npMode = ['art', 'viz', 'lyrics'].includes(store.get('npMode', 'art')) ? store.get('npMode', 'art') : 'art';
  Lyrics.bind();
  const seek = $('#np-seek');
  seek.addEventListener('input', () => {
    UI.seeking = true; seek.style.setProperty('--p', (seek.value / 10) + '%');
    const d = Player.live; $('#np-cur').textContent = fmt(seek.value / 1000 * d.duration);
  });
  seek.addEventListener('change', () => { const d = Player.live; d.seek(seek.value / 1000 * d.duration); UI.seeking = false; });
  const vol = $('#np-vol');
  vol.value = Math.round(settings.volume * 100); vol.style.setProperty('--p', vol.value + '%');
  vol.addEventListener('input', () => { vol.style.setProperty('--p', vol.value + '%'); Engine.setVolume(vol.value / 100); });

  Motion.bind();

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
 * Motion — scroll-linked titles, view transitions, the Now Playing flight,
 * and touch gestures (long-press, swipe to skip, drag to dismiss).
 * ========================================================================= */
const Motion = {
  reduce: matchMedia('(prefers-reduced-motion: reduce)'),
  scrollPos: {},
  haptic(ms = 8) { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* unsupported */ } },
  /* (re)play the entrance on a list, but only when its contents actually changed */
  enter(container) {
    if (!container) return;
    const key = $$('[data-id],[data-value],[data-pl]', container).slice(0, 40).map((e) => e.dataset.id || e.dataset.value || e.dataset.pl).join('|');
    const fresh = key !== container._enterKey;
    container._enterKey = key;
    $$('.rows, .grid, .carousel', container).forEach((list) => {
      if (!fresh) return;
      [...list.children].forEach((el, i) => { if (i < 16) el.style.setProperty('--i', i); });
      list.classList.remove('anim'); void list.offsetWidth; list.classList.add('anim');
    });
  },
  /* ---- collapsing large title, playlist parallax ---- */
  onScroll() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const views = $('#views'), y = views.scrollTop;
      const view = $('.view:not([hidden])');
      if (!view) return;
      const title = view.querySelector('.big-title');
      const isPl = view.dataset.view === 'playlist';
      const p = isPl ? clamp((y - 180) / 60, 0, 1) : clamp((y - 10) / 40, 0, 1);
      $('#app').style.setProperty('--nav-p', p.toFixed(3));
      $('#nav-title').textContent = isPl ? $('#pl-name').textContent : (title?.textContent || '');
      if (title) {
        const pull = Math.max(0, -y); // iOS rubber-band: the title grows a little when pulled down
        title.style.transform = `scale(${1 + Math.min(pull, 120) / 900})`;
        title.style.opacity = String(1 - clamp((y - 6) / 34, 0, 1));
      }
      if (isPl && !this.reduce.matches) {
        // the cover lags behind the scroll a little and shrinks from its top edge, so it never covers the title
        const k = clamp(y / 220, 0, 1);
        $('#pl-cover').style.transform = `translateY(${Math.max(0, y) * 0.18}px) scale(${1 - k * 0.2})`;
        $('#pl-cover').style.opacity = String(1 - clamp(y / 190, 0, 1));
      }
    });
  },
  rememberScroll(key) { this.scrollPos[key] = $('#views').scrollTop; },
  restoreScroll(key) { $('#views').scrollTop = this.scrollPos[key] || 0; this.onScroll(); },
  playIn(view, kind = 'enter') {
    if (this.reduce.matches || !view) return;
    view.classList.remove('enter', 'enter-push', 'enter-pop'); void view.offsetWidth; view.classList.add(kind);
    setTimeout(() => view.classList.remove(kind), 450);
  },
  pop(el) { if (!el) return; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); },

  /* ---- Now Playing: the cover flies between the mini player and full screen ---- */
  fly(fromEl, toEl, back) {
    if (this.reduce.matches || !fromEl || !toEl) return null;
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    if (!a.width || !b.width) return null;
    const clone = (back ? toEl : fromEl).cloneNode(true);
    clone.removeAttribute('id'); clone.className = 'art art-flight';
    Object.assign(clone.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
    document.body.appendChild(clone);
    const sx = b.width / a.width, dx = b.left - a.left, dy = b.top - a.top;
    const anim = clone.animate([
      { transform: 'translate(0,0) scale(1)', borderRadius: back ? '14px' : '6px' },
      { transform: `translate(${dx}px,${dy}px) scale(${sx})`, borderRadius: back ? `${6 / sx}px` : `${14 / sx}px` },
    ], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    anim.onfinish = () => clone.remove();
    return anim;
  },
  /* where the Now Playing cover will be once the sheet is fully open */
  npArtTarget() {
    const art = $('#np-art');
    if (!art || art.hidden) return null;
    const np = $('#np'), r = art.getBoundingClientRect();
    const m = new DOMMatrixReadOnly(getComputedStyle(np).transform);
    return { getBoundingClientRect: () => ({ left: r.left, top: r.top - m.m42, width: r.width, height: r.height }) };
  },
  openNP() {
    const np = $('#np'), mini = $('#mini-art');
    document.body.classList.add('np-open'); document.body.style.setProperty('--np-k', 1);
    const target = UI.npMode === 'art' && !$('#mini').hidden ? this.npArtTarget() : null;
    if (target) {
      const art = $('#np-art'); art.style.visibility = 'hidden'; mini.style.visibility = 'hidden';
      const anim = this.fly(mini, target, false);
      const done = () => { art.style.visibility = ''; mini.style.visibility = ''; };
      if (anim) anim.finished.then(done, done); else done();
    }
    np.classList.add('open');
  },
  closeNP() {
    const np = $('#np');
    if (UI.npMode === 'art' && !$('#mini').hidden && np.classList.contains('open')) {
      const art = $('#np-art'), mini = $('#mini-art');
      const anim = this.fly(art, mini, true);
      if (anim) { art.style.visibility = 'hidden'; mini.style.visibility = 'hidden'; const done = () => { art.style.visibility = ''; mini.style.visibility = ''; }; anim.finished.then(done, done); }
    }
    np.classList.remove('open'); np.style.transform = '';
    document.body.classList.remove('np-open'); document.body.style.removeProperty('--np-k');
  },
  /* drag the Now Playing sheet down; the library behind it follows */
  bindNpDrag() {
    const np = $('#np');
    let y0 = null, x0 = 0, dy = 0, t0 = 0, active = false;
    np.addEventListener('touchstart', (e) => {
      if (e.target.closest('input,canvas,.np-lyrics,button:not(#np-close)')) { y0 = null; return; }
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; t0 = performance.now(); active = false;
    }, { passive: true });
    np.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const ty = e.touches[0].clientY - y0, tx = e.touches[0].clientX - x0;
      if (!active) { if (ty > 8 && ty > Math.abs(tx)) { active = true; document.body.classList.add('np-dragging'); } else if (Math.abs(tx) > 8 || ty < -8) { y0 = null; return; } else return; }
      dy = Math.max(0, ty);
      np.style.transform = `translateY(${dy}px)`;
      document.body.style.setProperty('--np-k', String(1 - clamp(dy / innerHeight, 0, 1)));
    }, { passive: true });
    const end = () => {
      if (y0 == null) return;
      y0 = null;
      if (!active) return;
      document.body.classList.remove('np-dragging');
      const v = dy / Math.max(1, performance.now() - t0); // px per ms
      if (dy > innerHeight * 0.22 || v > 0.6) UI.closeNP();
      else { np.style.transform = ''; document.body.style.setProperty('--np-k', 1); }
    };
    np.addEventListener('touchend', end); np.addEventListener('touchcancel', end);
  },

  /* ---- long-press a song for its menu ---- */
  bindLongPress() {
    let timer = null, start = null, row = null;
    const cancel = () => { clearTimeout(timer); timer = null; if (row) row.classList.remove('held'); row = null; };
    document.addEventListener('pointerdown', (e) => {
      const r = e.target.closest('.row[data-id]');
      if (!r || e.target.closest('[data-act="menu"]') || e.button > 0) return;
      cancel(); row = r; start = [e.clientX, e.clientY];
      timer = setTimeout(() => {
        timer = null; this.suppressClick = Date.now() + 600;
        r.classList.add('held'); this.haptic(10);
        setTimeout(() => r.classList.remove('held'), 260);
        UI.trackMenu(r.dataset.id, r.querySelector('[data-ctx]')?.dataset.ctx);
        row = null;
      }, 480);
    });
    document.addEventListener('pointermove', (e) => { if (timer && start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 8) cancel(); });
    document.addEventListener('pointerup', () => { if (timer) cancel(); });
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('scroll', cancel, true);
    document.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.row[data-id]'); if (!r) return;
      e.preventDefault(); UI.trackMenu(r.dataset.id, r.querySelector('[data-ctx]')?.dataset.ctx);
    });
    // a long-press must not also play the song
    document.addEventListener('click', (e) => { if (this.suppressClick && Date.now() < this.suppressClick && e.target.closest('.row')) { e.stopPropagation(); e.preventDefault(); this.suppressClick = 0; } }, true);
  },

  /* ---- swipe the mini player left / right to skip ---- */
  bindMiniSwipe() {
    const main = $('#mini-open');
    let x0 = null, y0 = 0, dx = 0, dragging = false;
    main.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; dx = 0; dragging = false; });
    main.addEventListener('pointermove', (e) => {
      if (x0 == null) return;
      const tx = e.clientX - x0, ty = e.clientY - y0;
      if (!dragging) { if (Math.abs(tx) > 10 && Math.abs(tx) > Math.abs(ty)) { dragging = true; main.setPointerCapture(e.pointerId); } else return; }
      dx = tx; main.style.transition = 'none';
      main.style.transform = `translateX(${dx * 0.6}px)`; main.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 300));
    });
    const end = () => {
      if (x0 == null) return;
      x0 = null; main.style.transition = ''; main.style.transform = ''; main.style.opacity = '';
      if (!dragging) return;
      this.suppressMiniClick = Date.now() + 400;
      if (dx < -70) { this.haptic(); this.swapDir = 'right'; Player.next(true); }
      else if (dx > 70) { this.haptic(); this.swapDir = 'left'; Player.prev(); }
    };
    main.addEventListener('pointerup', end); main.addEventListener('pointercancel', end);
  },

  /* ---- sheets: animate out, drag down to dismiss ---- */
  closeSheet(done) {
    const sheet = $('#sheet'), scrim = $('#scrim');
    if (sheet.hidden) { done && done(); return; }
    if (this.reduce.matches) { done(); return; }
    sheet.classList.add('closing'); scrim.classList.add('closing');
    setTimeout(() => { sheet.classList.remove('closing'); scrim.classList.remove('closing'); sheet.style.transform = ''; done && done(); }, 240);
  },
  bindSheetDrag() {
    const sheet = $('#sheet'), body = $('#sheet-body');
    let y0 = null, dy = 0, active = false;
    sheet.addEventListener('touchstart', (e) => {
      const onGrab = e.target.closest('.sheet-grab');
      if (!onGrab && (body.scrollTop > 0 || e.target.closest('input,textarea,select'))) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0; active = false;
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const ty = e.touches[0].clientY - y0;
      if (!active) { if (ty > 8) active = true; else if (ty < -4) { y0 = null; return; } else return; }
      dy = Math.max(0, ty); sheet.style.animation = 'none'; sheet.style.transition = 'none'; sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', () => {
      if (y0 == null) return;
      y0 = null; sheet.style.transition = 'transform .3s cubic-bezier(.2,.8,.2,1)';
      if (active && dy > 110) UI.closeSheet();
      else sheet.style.transform = '';
      setTimeout(() => { sheet.style.transition = ''; sheet.style.animation = ''; }, 320);
    });
  },
  bind() {
    $('#views').addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.bindNpDrag(); this.bindLongPress(); this.bindMiniSwipe(); this.bindSheetDrag();
    $('#mini-open').addEventListener('click', (e) => { if (this.suppressMiniClick && Date.now() < this.suppressMiniClick) { e.stopImmediatePropagation(); } }, true);
  },
};

/* =========================================================================
 * Boot
 * ========================================================================= */
async function boot() {
  applyTheme();
  bind();
  MediaSessionCtl.init();
  const tab = store.get('tab', 'library');
  UI.setTab(['library', 'playlists', 'search'].includes(tab) ? tab : 'library');
  UI.transport();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && /^https:|^http:\/\/localhost/.test(location.href) && !window.__NO_SW__) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__mazj = { Engine, Player, Lib, UI, settings, Local, Tags, Lyrics, Analysis, Stretch }; // for debugging
  const open = async () => {
    try { await Lib.load(); $('#toast').hidden = true; }
    catch (e) { UI.loading = false; UI.renderLibrary(); if (!/unauthorized/.test(e.message)) toast('Couldn’t load your library. Check your connection.'); return; }
    UI.loading = false;
    await Local.check();
    UI.render();
    if (Local.count) toast(`${songsLabel(Local.count)} on this device can be uploaded to your cloud library`, 3500);
  };
  Auth.bind(open);
  const st = await Auth.status();
  if (st.authed) open();
  else if (st.offline) toast('Couldn’t reach the server. Check your connection.', 0);
  else Auth.show();
  // pick up changes made on other devices when coming back to the app
  document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#login').hidden) Lib.load().then(() => UI.render()).catch(() => {}); });
}
boot();
})();
