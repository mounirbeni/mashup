# Mashup

A phone-first music player in the style of modern music apps, with a **two-deck DJ mixer** and **automatic mixing** between songs. It runs entirely in the browser and can be installed to your home screen as an app (PWA).

## Features

**Player**
- Library by songs, albums and artists, with search and playlists
- Now Playing screen tinted from the album art, plus an audio-reactive visualizer
- Shuffle, repeat (all / one), and an Up Next queue with "Play Next"
- Lock-screen and headphone controls (Media Session)
- Reads MP3 tags (ID3): title, artist, album and cover art, including Arabic text stored as Windows-1256

**Mixing**
- **Auto-Mix:** the next song starts before the current one ends, overlapping for 0–12 seconds
- **Smart Mix:** detects tempo (BPM), matches speed, lines up the beats, and swaps the bass halfway through
- **Two decks (A / B):** tap-to-seek waveform, CUE, SYNC, 3-band EQ (HI / MID / LOW), low/high-pass filter, ±16% tempo with key lock, and per-deck volume
- **Equal-power crossfader** and a "Mix to the Other Deck Now" button
- Built-in demo tracks (122, 124 and 126 BPM) so you can try mixing without your own files

## Using it on your phone

1. Open the site in Safari (iPhone) or Chrome (Android).
2. Tap **+** and pick audio files from Files or your device storage.
3. To install it as an app: **Share → Add to Home Screen**.

> Your files are stored on your device only (IndexedDB); nothing is uploaded. Songs from Apple Music or Spotify can't be played, because a website can't access them. You need audio files you own.

## Deploying

It's a static site with no build step. On Vercel, import the repo with the framework preset **Other** and no build command. To run it locally:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Structure

```
index.html            App markup
css/style.css         Styles (dark/light)
js/app.js             Library, tag reading, BPM analysis, audio engine, UI
sw.js                 Offline support
manifest.webmanifest  Install-as-app settings
```

Signal path for each deck:

`<audio> → EQ (low-shelf / peaking / high-shelf) → filter → deck volume → crossfader → master → limiter → output`
