# Resonant — a personal music player

A Spotify-shaped music app that runs on your iPhone from the home screen, plays
**your own audio files** and **anything on YouTube**, and keeps all its data on
your device. No account, no server, no subscription.

Built because plenty of music never makes it to Spotify or Apple Music — live
sets, demos, uploads, regional releases — but is sitting on YouTube.

<br>

## What it does

| | |
|---|---|
| **Search** | YouTube by name, or your own library. Paste a YouTube link and it resolves instantly. |
| **Play** | YouTube via the official embedded player; imported files via native audio. |
| **Playlists** | Create, rename, reorder, delete. Mix YouTube and local tracks in one playlist. |
| **Liked** | One-tap heart, with its own view. |
| **History** | Everything you played, most recent first. Clearable, or switch it off entirely. |
| **Queue** | See what's next, reorder it, play-next / add-to-queue from any track's ⋮ menu. |
| **Shuffle & repeat** | Off / all / one. |
| **Sleep timer** | 5–60 minutes, or "stop at end of track". |
| **Speed** | 0.75× to 2×, on both sources. |
| **Offline** | The app shell is cached. Imported files play with no connection at all. |
| **Your data** | Export the whole library to JSON any time. Nothing is locked in. |

### Things Spotify doesn't do

- Plays music that isn't on Spotify.
- No ads, no algorithmic feed, no "made for you" — just your library.
- Speed control and a sleep timer on every track.
- Export your library and take it with you.
- Reads ID3 tags off imported files, so titles and cover art come through.

<br>

## Install it on your iPhone

The app is a PWA — it installs from Safari, no App Store, no computer, no
7-day resigning.

**1. Put it online.** In this repo on GitHub: **Settings → Pages → Source:
Deploy from a branch**, pick `main` and `/ (root)`, save. After a minute
you'll have:

```
https://<your-username>.github.io/resonant/
```

(Any HTTPS host works. It must be HTTPS — the service worker and audio APIs
require it.)

**2. Open that URL in Safari** on your iPhone. It has to be Safari; Chrome on
iOS can't install PWAs.

**3. Share button → Add to Home Screen → Add.**

You now have a Resonant icon on your home screen that opens fullscreen with no
browser chrome.

<br>

## Optional: YouTube search by name

Pasting YouTube links works immediately with no setup. To search *by name* from
inside the app you need a free YouTube Data API key.

1. <https://console.cloud.google.com> → create a project.
2. **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Copy it into the app: **Settings → YouTube API key**.

The key is stored only on your device and is stripped out of library exports.

**Free quota is 10,000 units/day.** A search costs ~100 units, so roughly
**100 searches a day**, which resets at midnight Pacific. Playback costs
nothing, and pasted links cost nothing — only name searches draw down quota.

> Worth restricting the key in Google Cloud (**API restrictions → YouTube Data
> API v3**) so it can't be used for anything else if it ever leaks.

<br>

## The one real limitation

**YouTube tracks stop when you leave the app or lock your screen.**

This isn't a bug and it isn't fixable from here. Apple doesn't allow embedded
web players to hold an audio session in the background, and YouTube's terms
reserve background playback for YouTube Premium in YouTube's own app. Every
third-party YouTube player hits the same wall. The app tells you this on the
Now Playing screen rather than letting it surprise you.

**Imported files do not have this limitation.** They play with the screen
locked, show up in Control Center and on the lock screen, and respond to your
headphone and car controls.

So: for music you'll listen to on the go with the screen off, import the file.
For everything else, YouTube playback works fine while the app is open.

<br>

## Why the official player, and not a downloader

Ripping audio out of YouTube (`yt-dlp` and friends) breaks YouTube's Terms of
Service, and would get an API key banned. The embedded player is the sanctioned
route: it needs no backend, keeps creators credited and paid, and can't be
switched off underneath you. The cost is the background-audio limit above.

<br>

## Importing your own files

**Library → Import audio files.** Multi-select works. Supported: MP3, M4A, AAC,
WAV, FLAC, OGG, Opus — whatever Safari can decode.

Files are stored in IndexedDB on your device. Browsers cap this; iOS Safari
typically allows a few hundred MB to a couple of GB. **Settings → Storage**
shows where you stand. If you want an entire library offline, this is a phone
browser, not a hard drive — be selective.

ID3 tags (title, artist, album, embedded cover art) are read on import.

<br>

## Files

```
├── index.html      markup and app chrome
├── app.css         all styling — mobile-first, dark
├── app.js          store, player, YouTube glue, views, routing
├── sw.js           service worker (offline app shell)
├── manifest.json   PWA manifest
└── icons/          generated app icons
```

No build step, no dependencies, no bundler. Edit a file, reload.

Run it locally:

```bash
python3 -m http.server 8765
# then open http://localhost:8765
```

`localhost` counts as a secure origin, so the service worker works there too.

<br>

## Keyboard shortcuts (desktop)

`space` play/pause · `←`/`→` seek 10s · `shift+←`/`shift+→` prev/next · `/` search · `esc` close

<br>

## Backup

**Settings → Export library** writes a JSON file with your tracks, playlists and
likes. **Import** merges it back.

One caveat worth knowing: the export references your imported audio files but
can't contain them — they live in this device's storage. Restoring on a
different device brings back YouTube tracks and playlist structure, and skips
local files that aren't there. Keep the original audio files somewhere if they
matter to you.

<br>

## Troubleshooting

**"Owner disabled embedding"** — some uploaders block off-site playback. The app
skips the track and tells you. Use the ⋮ menu → *Open on YouTube* for those.

**Search says it needs an API key** — either add one (above) or paste links
instead.

**Search stops working partway through the day** — you've hit the 10,000-unit
quota. It resets at midnight Pacific. Pasted links still work.

**Nothing plays after adding to the home screen** — make sure you opened the
HTTPS URL, not a local file. iOS is strict about secure origins.

**Playback won't start on first tap** — iOS requires a user gesture before audio
can begin. Tap play once more.
