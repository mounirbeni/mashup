# Mashup

A phone-first music player in the style of modern music apps, with **AutoMix**: songs blend into each other automatically, like a DJ set. It runs entirely in the browser and can be installed to your home screen as an app (PWA).

## Features

**Player**
- Library by songs, albums and artists, with search and playlists
- Now Playing screen tinted from the album art, plus an audio-reactive visualizer
- Shuffle, repeat (all / one), and an Up Next queue with "Play Next"
- Lock-screen and headphone controls (Media Session)
- Reads MP3 tags (ID3): title, artist, album and cover art, including Arabic text stored as Windows-1256

**AutoMix**
- Built into playback like Apple Music: as a song ends, the next one blends in automatically. There is no separate mixer screen.
- Turn it on or off with the **AutoMix** button in Now Playing or the switch at the top of **Up Next**
- Behind the scenes it detects each song's tempo (BPM), matches speeds, lines up the beats, and swaps the bass halfway through the blend
- Blend length (0–20 s, default 10 s), smart beat-matching and key lock are in **Settings** (the gear icon in Library)
- Built-in demo tracks (122, 124 and 126 BPM) let you hear it without your own files

## Using it on your phone

1. Open the site in Safari (iPhone) or Chrome (Android).
2. Tap **+** and pick audio files from Files or your device storage.
3. To install it as an app: **Share → Add to Home Screen**.

> Your songs are uploaded to a **private cloud library** (Vercel Blob), so they play on any phone or computer where you sign in. Nothing is public: every song and cover is served only to a signed-in browser. Songs from Apple Music or Spotify can't be played, because a website can't access them. You need audio files you own.

## Cloud library and sign-in

- **Storage:** a private Vercel Blob store (`mashup-music`) holds the songs, covers and `library.json` (song info, favorites, playlists).
- **Sign-in:** one password, set as the `APP_PASSWORD` environment variable. Sessions last 180 days and are signed with `SESSION_SECRET`.
- **Change the password:** Vercel → project **mashup** → Settings → Environment Variables → edit `APP_PASSWORD`, then redeploy. To sign every device out as well, change `SESSION_SECRET` too.
- **Songs from older versions:** songs added before the cloud library were kept in that browser only. The app shows an **Upload** banner on that device to move them to the cloud.

| Route | What it does |
|---|---|
| `POST /api/login` | Checks the password and sets the session cookie (`GET` = status, `DELETE` = sign out) |
| `GET /api/library` | Returns songs and playlists |
| `POST /api/library` | Applies one change: `addTrack`, `updateTrack`, `deleteTrack`, `savePlaylist`, `deletePlaylist`, `wipe` |
| `POST /api/upload` | Issues a short-lived token so the browser uploads a file straight to Blob storage |
| `GET /api/file?p=…` | Streams a song or cover, with `Range` support for seeking |

## Deploying

Static front end plus Node functions in `api/`; Vercel installs `@vercel/blob` from `package.json`. Functions run in Paris (`cdg1`, see `vercel.json`), next to the Blob store. `js/vendor/blob-upload.js` is the browser upload helper from `@vercel/blob/client`, bundled with esbuild.

## Structure

```
index.html            App markup
css/style.css         Styles (dark/light)
js/app.js             Cloud library, sign-in, tag reading, BPM analysis, audio engine, UI
api/                  Sign-in, library, upload and streaming routes
sw.js                 Offline support
manifest.webmanifest  Install-as-app settings
```

Audio path (two players run in the background so one song can fade into the next):

`<audio> → EQ (low-shelf / peaking / high-shelf) → filter → deck volume → crossfader → master → limiter → output`
