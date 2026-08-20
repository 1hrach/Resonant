/* ============================================================
   Resonant — personal music player
   Sources: your own audio files (offline, background-capable)
            + YouTube via the official IFrame player.
   All data is local to this device. No accounts, no server.
   ============================================================ */
'use strict';

/* ------------------------------------------------------------------ utils */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

/** YouTube ISO-8601 duration (PT4M13S) -> seconds */
function parseISODur(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

/** Pull a video id out of any YouTube URL shape, or accept a bare 11-char id. */
function extractVideoId(input) {
  const t = (input || '').trim();
  if (/^[\w-]{11}$/.test(t)) return t;
  let u; try { u = new URL(t); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') return /^[\w-]{11}$/.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null;
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return null;
  const v = u.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname);
  return m ? m[1] : null;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 260);
  }, 2600);
}

/* ------------------------------------------------------- IndexedDB (blobs) */
const DB = {
  _p: null,
  open() {
    return this._p ||= new Promise((res, rej) => {
      const r = indexedDB.open('resonant', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
        if (!db.objectStoreNames.contains('art'))   db.createObjectStore('art');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async _tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, mode);
      const rq = fn(tx.objectStore(store));
      tx.oncomplete = () => res(rq?.result);
      tx.onerror = () => rej(tx.error);
    });
  },
  put(store, key, val) { return this._tx(store, 'readwrite', s => s.put(val, key)); },
  get(store, key)      { return this._tx(store, 'readonly',  s => s.get(key)); },
  del(store, key)      { return this._tx(store, 'readwrite', s => s.delete(key)); },
  async usage() {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  }
};

/* --------------------------------------------------------------- the store */
const DEFAULTS = {
  tracks: {},        // id -> track
  playlists: [],     // {id,name,trackIds,createdAt}
  liked: [],         // trackId[]
  history: [],       // {trackId, at}
  settings: {
    ytApiKey: '',
    shuffle: false,
    repeat: 'off',   // off | all | one
    volume: 100,
    rate: 1,
    saveHistory: true,
    autoplayRelated: false
  }
};

const Store = {
  data: null,
  load() {
    try {
      const raw = localStorage.getItem('resonant.v1');
      this.data = raw ? { ...structuredClone(DEFAULTS), ...JSON.parse(raw) } : structuredClone(DEFAULTS);
      this.data.settings = { ...DEFAULTS.settings, ...(this.data.settings || {}) };
    } catch {
      this.data = structuredClone(DEFAULTS);
    }
    return this.data;
  },
  save() {
    try { localStorage.setItem('resonant.v1', JSON.stringify(this.data)); }
    catch (e) { toast('Storage full — remove some imported files'); }
  },
  track(id) { return this.data.tracks[id]; },
  addTrack(t) {
    if (!this.data.tracks[t.id]) { this.data.tracks[t.id] = { ...t, addedAt: Date.now() }; this.save(); }
    return this.data.tracks[t.id];
  },
  isLiked(id) { return this.data.liked.includes(id); },
  toggleLike(id) {
    const i = this.data.liked.indexOf(id);
    if (i >= 0) this.data.liked.splice(i, 1); else this.data.liked.unshift(id);
    this.save();
    return i < 0;
  },
  pushHistory(id) {
    if (!this.data.settings.saveHistory) return;
    this.data.history = this.data.history.filter(h => h.trackId !== id);
    this.data.history.unshift({ trackId: id, at: Date.now() });
    if (this.data.history.length > 250) this.data.history.length = 250;
    this.save();
  },
  playlist(id) { return this.data.playlists.find(p => p.id === id); },
  createPlaylist(name) {
    const p = { id: uid(), name, trackIds: [], createdAt: Date.now() };
    this.data.playlists.unshift(p); this.save(); return p;
  },
  /** Delete a track everywhere, including its blobs. */
  async removeTrack(id) {
    const t = this.data.tracks[id];
    delete this.data.tracks[id];
    this.data.liked = this.data.liked.filter(x => x !== id);
    this.data.history = this.data.history.filter(h => h.trackId !== id);
    this.data.playlists.forEach(p => { p.trackIds = p.trackIds.filter(x => x !== id); });
    this.save();
    if (t?.source === 'local') {
      await DB.del('audio', id).catch(() => {});
      await DB.del('art', id).catch(() => {});
    }
  }
};

/* ----------------------------------------------------- ID3 tag extraction  */
/* Reads TIT2 / TPE1 / TALB / APIC out of an ID3v2.3-2.4 header so imported
   files show real titles and cover art instead of a filename.               */
async function readID3(file) {
  const out = { title: null, artist: null, album: null, art: null };
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (String.fromCharCode(head[0], head[1], head[2]) !== 'ID3') return out;
    const ver = head[3];
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    const dv = new DataView(buf.buffer);

    const decodeText = bytes => {
      if (!bytes.length) return '';
      const enc = bytes[0], body = bytes.subarray(1);
      try {
        if (enc === 0) return new TextDecoder('iso-8859-1').decode(body).replace(/\0+$/, '');
        if (enc === 1) return new TextDecoder('utf-16').decode(body).replace(/\0+$/, '');
        if (enc === 2) return new TextDecoder('utf-16be').decode(body).replace(/\0+$/, '');
        return new TextDecoder('utf-8').decode(body).replace(/\0+$/, '');
      } catch { return ''; }
    };

    let p = 0;
    while (p + 10 <= buf.length) {
      const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      let fsize = ver === 4
        ? ((buf[p + 4] << 21) | (buf[p + 5] << 14) | (buf[p + 6] << 7) | buf[p + 7])
        : dv.getUint32(p + 4);
      if (fsize <= 0 || p + 10 + fsize > buf.length) break;
      const body = buf.subarray(p + 10, p + 10 + fsize);

      if (id === 'TIT2') out.title = decodeText(body) || out.title;
      else if (id === 'TPE1') out.artist = decodeText(body) || out.artist;
      else if (id === 'TALB') out.album = decodeText(body) || out.album;
      else if (id === 'APIC' && !out.art) {
        let i = 1;                                    // skip encoding byte
        while (i < body.length && body[i] !== 0) i++; // MIME string
        const mime = new TextDecoder('iso-8859-1').decode(body.subarray(1, i)) || 'image/jpeg';
        i++;                                          // NUL
        i++;                                          // picture type
        while (i < body.length && body[i] !== 0) i++; // description
        i++;
        if (i < body.length) out.art = new Blob([body.subarray(i)], { type: mime });
      }
      p += 10 + fsize;
    }
  } catch { /* unreadable tags are fine — fall back to filename */ }
  return out;
}

/* ------------------------------------------------------------ YouTube data */
const YT = {
  ready: false,
  player: null,
  _readyWaiters: [],

  loadIframeAPI() {
    if (window.YT?.Player) { this.ready = true; return Promise.resolve(); }
    return new Promise(res => {
      window.onYouTubeIframeAPIReady = () => { this.ready = true; res(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { toast('Could not reach YouTube'); res(); };
      document.head.appendChild(s);
    });
  },

  get key() { return Store.data.settings.ytApiKey.trim(); },

  /** search.list -> videos.list (for durations). Returns {items, nextPageToken}. */
  async search(q, pageToken = '') {
    if (!this.key) throw new Error('NO_KEY');
    const su = new URL('https://www.googleapis.com/youtube/v3/search');
    su.search = new URLSearchParams({
      part: 'snippet', q, type: 'video', videoCategoryId: '10',
      maxResults: '25', key: this.key, ...(pageToken ? { pageToken } : {})
    });
    let r = await fetch(su);
    // Category 10 (Music) is strict; retry unfiltered so odd uploads still surface.
    if (r.ok) {
      const probe = await r.clone().json();
      if (!probe.items?.length && !pageToken) {
        su.searchParams.delete('videoCategoryId');
        r = await fetch(su);
      }
    }
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error?.message || `HTTP ${r.status}`);
    const j = await r.json();
    const ids = (j.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (!ids.length) return { items: [], nextPageToken: null };

    const vu = new URL('https://www.googleapis.com/youtube/v3/videos');
    vu.search = new URLSearchParams({ part: 'contentDetails,snippet', id: ids.join(','), key: this.key });
    const vr = await fetch(vu);
    const vj = vr.ok ? await vr.json() : { items: [] };
    const meta = Object.fromEntries((vj.items || []).map(v => [v.id, v]));

    return {
      nextPageToken: j.nextPageToken || null,
      items: ids.map(id => {
        const v = meta[id], sn = v?.snippet || (j.items.find(i => i.id?.videoId === id)?.snippet) || {};
        return {
          id: 'yt:' + id, source: 'youtube', videoId: id,
          title: sn.title || 'Untitled',
          artist: sn.channelTitle || 'YouTube',
          thumb: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '',
          duration: parseISODur(v?.contentDetails?.duration)
        };
      })
    };
  },

  /** Key-free single-video lookup via the public oEmbed endpoint. */
  async lookup(videoId) {
    const u = 'https://www.youtube.com/oembed?format=json&url=' +
              encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
    const r = await fetch(u);
    if (!r.ok) throw new Error('Video not found, or it is private / embedding-disabled.');
    const j = await r.json();
    return {
      id: 'yt:' + videoId, source: 'youtube', videoId,
      title: j.title || 'Untitled',
      artist: j.author_name || 'YouTube',
      thumb: j.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      duration: 0
    };
  }
};

/* ---------------------------------------------------------------- Player   */
const Player = {
  queue: [],          // track ids
  index: -1,
  order: [],          // shuffle order (indices into queue)
  orderPos: -1,
  current: null,      // track object
  playing: false,
  mode: null,         // 'youtube' | 'local'
  audio: null,
  _tick: null,
  _sleepAt: null,
  _sleepEnd: false,
  _objUrl: null,
  _misses: 0,
  contextLabel: '',

  init() {
    this.audio = $('#localAudio');
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('timeupdate', () => this.renderProgress());
    this.audio.addEventListener('loadedmetadata', () => {
      if (this.current?.source === 'local' && this.audio.duration) {
        this.current.duration = this.audio.duration;
        Store.save();
      }
      this.renderProgress();
    });
    this.audio.addEventListener('play',  () => { this.playing = true;  this.renderTransport(); });
    this.audio.addEventListener('pause', () => { this.playing = false; this.renderTransport(); });
    this.audio.addEventListener('error', () => {
      if (this.current?.source === 'local') toast('Could not play that file');
    });
    this._tick = setInterval(() => { if (this.mode === 'youtube') this.renderProgress(); }, 500);
    this.setVolume(Store.data.settings.volume);
    this.setRate(Store.data.settings.rate);
  },

  /* ---------- queue construction ---------- */
  play(trackIds, startIndex = 0, contextLabel = '') {
    this.queue = [...trackIds];
    this.contextLabel = contextLabel;
    this.buildOrder(startIndex);
    this.loadAt(startIndex, true);
  },

  buildOrder(current = this.index) {
    const n = this.queue.length;
    this.order = [...Array(n).keys()];
    if (Store.data.settings.shuffle) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
      }
      // keep whatever is playing at the head of the shuffled order
      const at = this.order.indexOf(current);
      if (at > 0) { this.order.splice(at, 1); this.order.unshift(current); }
    }
    this.orderPos = Math.max(0, this.order.indexOf(current));
  },

  async loadAt(i, autoplay) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.orderPos = Math.max(0, this.order.indexOf(i));
    const t = Store.track(this.queue[i]);
    if (!t) {
      // Skip past a dangling id, but never spin forever on an all-dead queue
      // (repeat:'all' would otherwise recurse without end).
      if (++this._misses > this.queue.length) {
        this._misses = 0; this.stopBoth(); this.renderTransport();
        return toast('Nothing in the queue is playable');
      }
      return this.next();
    }
    this._misses = 0;
    this.current = t;
    Store.pushHistory(t.id);

    this.stopBoth();

    if (t.source === 'youtube') {
      this.mode = 'youtube';
      await this.playYouTube(t, autoplay);
    } else {
      this.mode = 'local';
      await this.playLocal(t, autoplay);
    }

    UI.renderNowPlaying();
    UI.refreshLists();
    this.updateMediaSession();
    if (this._sleepEnd) { /* stop after this track — handled in onEnded */ }
  },

  stopBoth() {
    try { this.audio.pause(); } catch {}
    if (this._objUrl) { URL.revokeObjectURL(this._objUrl); this._objUrl = null; }
    this.audio.removeAttribute('src');
    try { YT.player?.stopVideo?.(); } catch {}
    this.playing = false;
  },

  async playYouTube(t, autoplay) {
    $('#ytStage').classList.add('on');
    $('#artStage').classList.add('off');
    await YT.loadIframeAPI();
    if (!window.YT?.Player) { toast('YouTube player unavailable'); return; }

    if (!YT.player) {
      YT.player = new window.YT.Player('ytPlayer', {
        host: 'https://www.youtube-nocookie.com',
        videoId: t.videoId,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: e => {
            e.target.setVolume(Store.data.settings.volume);
            try { e.target.setPlaybackRate(Store.data.settings.rate); } catch {}
            if (autoplay) e.target.playVideo();
          },
          onStateChange: e => {
            const S = window.YT.PlayerState;
            if (e.data === S.ENDED)        this.onEnded();
            else if (e.data === S.PLAYING) { this.playing = true;  this.captureYTDuration(); this.renderTransport(); }
            else if (e.data === S.PAUSED)  { this.playing = false; this.renderTransport(); }
          },
          onError: e => {
            const why = { 2: 'Bad video id', 5: 'Playback blocked', 100: 'Video removed or private',
                          101: 'Owner disabled embedding', 150: 'Owner disabled embedding' }[e.data]
                        || 'Playback error';
            toast(`${why} — skipping`);
            setTimeout(() => this.next(), 900);
          }
        }
      });
    } else {
      autoplay ? YT.player.loadVideoById(t.videoId) : YT.player.cueVideoById(t.videoId);
      try { YT.player.setPlaybackRate(Store.data.settings.rate); } catch {}
    }
  },

  captureYTDuration() {
    try {
      const d = YT.player?.getDuration?.();
      if (d && this.current && Math.abs((this.current.duration || 0) - d) > 1) {
        this.current.duration = d; Store.save(); UI.refreshLists();
      }
    } catch {}
  },

  async playLocal(t, autoplay) {
    $('#ytStage').classList.remove('on');
    $('#artStage').classList.remove('off');
    const blob = await DB.get('audio', t.id);
    if (!blob) { toast('File missing from storage'); return this.next(); }
    this._objUrl = URL.createObjectURL(blob);
    this.audio.src = this._objUrl;
    this.audio.playbackRate = Store.data.settings.rate;
    this.audio.volume = Store.data.settings.volume / 100;
    if (autoplay) this.audio.play().catch(() => toast('Tap play to start'));
  },

  toggle() {
    if (!this.current) return;
    if (this.mode === 'youtube') {
      if (!YT.player) return;
      this.playing ? YT.player.pauseVideo() : YT.player.playVideo();
    } else {
      this.playing ? this.audio.pause() : this.audio.play().catch(() => {});
    }
  },

  next(userInitiated = true) {
    if (!this.queue.length) return;
    const rep = Store.data.settings.repeat;
    if (!userInitiated && rep === 'one') return this.loadAt(this.index, true);
    if (this.orderPos + 1 < this.order.length) return this.loadAt(this.order[this.orderPos + 1], true);
    if (rep === 'all') { this.buildOrder(this.order[0]); return this.loadAt(this.order[0], true); }
    // end of queue
    this.stopBoth(); this.renderTransport();
  },

  prev() {
    if (!this.queue.length) return;
    if (this.position() > 3) return this.seekTo(0);
    if (this.orderPos - 1 >= 0) return this.loadAt(this.order[this.orderPos - 1], true);
    this.seekTo(0);
  },

  onEnded() {
    if (this._sleepEnd) { this._sleepEnd = false; $('#sleepSel').value = '0'; this.stopBoth(); this.renderTransport(); return toast('Sleep timer — stopped'); }
    this.next(false);
  },

  /* ---------- transport state ---------- */
  position() {
    if (this.mode === 'youtube') { try { return YT.player?.getCurrentTime?.() || 0; } catch { return 0; } }
    return this.audio.currentTime || 0;
  },
  duration() {
    if (this.mode === 'youtube') {
      try { const d = YT.player?.getDuration?.(); if (d) return d; } catch {}
      return this.current?.duration || 0;
    }
    return isFinite(this.audio.duration) ? this.audio.duration : (this.current?.duration || 0);
  },
  seekTo(sec) {
    if (this.mode === 'youtube') { try { YT.player?.seekTo(sec, true); } catch {} }
    else { try { this.audio.currentTime = sec; } catch {} }
    this.renderProgress();
  },
  setVolume(v) {
    Store.data.settings.volume = v; Store.save();
    this.audio.volume = v / 100;
    try { YT.player?.setVolume?.(v); } catch {}
    $('#volume').style.setProperty('--pv', v + '%');
  },
  setRate(r) {
    Store.data.settings.rate = r; Store.save();
    this.audio.playbackRate = r;
    try { YT.player?.setPlaybackRate?.(r); } catch {}
  },
  setSleep(val) {
    clearTimeout(this._sleepAt); this._sleepEnd = false;
    if (val === 'end') { this._sleepEnd = true; return toast('Will stop after this track'); }
    const secs = +val;
    if (!secs) return;
    this._sleepAt = setTimeout(() => {
      this.stopBoth(); this.renderTransport(); $('#sleepSel').value = '0'; toast('Sleep timer — stopped');
    }, secs * 1000);
    toast(`Sleeping in ${secs / 60} min`);
  },

  /* ---------- queue editing ---------- */
  enqueueNext(id) {
    if (!this.queue.length) return this.play([id], 0, 'Queue');
    this.queue.splice(this.index + 1, 0, id);
    this.buildOrder(this.index);
    UI.renderQueue(); toast('Playing next');
  },
  enqueueLast(id) {
    if (!this.queue.length) return this.play([id], 0, 'Queue');
    this.queue.push(id);
    this.buildOrder(this.index);
    UI.renderQueue(); toast('Added to queue');
  },
  removeFromQueue(i) {
    if (i === this.index) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    this.buildOrder(this.index);
    UI.renderQueue();
  },
  moveInQueue(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    if (this.index === i) this.index = j; else if (this.index === j) this.index = i;
    this.buildOrder(this.index);
    UI.renderQueue();
  },

  /* ---------- rendering hooks ---------- */
  renderProgress() {
    const pos = this.position(), dur = this.duration();
    const pct = dur ? (pos / dur) * 100 : 0;
    if (!UI.seeking) {
      $('#seek').value = Math.round(pct * 10);
      $('#seek').style.setProperty('--p', pct + '%');
    }
    $('#curTime').textContent = fmtTime(pos);
    $('#durTime').textContent = fmtTime(dur);
    $('#miniProgFill').style.width = pct + '%';
    if ('mediaSession' in navigator && this.mode === 'local' && dur) {
      try { navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(pos, dur), playbackRate: this.audio.playbackRate }); } catch {}
    }
  },

  renderTransport() {
    const icon = this.playing
      ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1.2" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1.2" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>';
    $('#playBtn').innerHTML = icon;
    $('#miniPlay').innerHTML = icon;
    $('#playBtn').setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
  },

  updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const t = this.current;
    const artwork = t.thumb ? [{ src: t.thumb, sizes: '320x180', type: 'image/jpeg' }] : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist, album: t.album || 'Resonant', artwork
      });
      navigator.mediaSession.setActionHandler('play',  () => this.toggle());
      navigator.mediaSession.setActionHandler('pause', () => this.toggle());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
      navigator.mediaSession.setActionHandler('seekto', d => { if (d.seekTime != null) this.seekTo(d.seekTime); });
    } catch {}
  }
};

/* -------------------------------------------------------------------- UI   */
const UI = {
  route: 'home',
  routeArg: null,
  stack: [],
  seeking: false,
  search: { q: '', src: 'youtube', items: [], nextPageToken: null, loading: false, seq: 0 },

  /* ---------- rendering helpers ---------- */
  trackRow(t, opts = {}) {
    const row = el('div', 'track' + (Player.current?.id === t.id ? ' playing' : ''));
    row.dataset.id = t.id;

    const img = el('img', 't-thumb');
    img.loading = 'lazy'; img.alt = '';
    img.src = t.thumb || 'icons/icon-180.png';
    row.append(img);

    const body = el('div', 't-body');
    body.append(el('div', 't-title', t.title));
    const sub = el('div', 't-sub');
    const yt = t.source === 'youtube';
    sub.append(el('span', 't-badge ' + (yt ? 'yt' : 'local'), yt ? 'YT' : 'File'));
    sub.append(document.createTextNode(t.artist || ''));
    body.append(sub);
    row.append(body);

    if (t.duration) row.append(el('div', 't-dur', fmtTime(t.duration)));

    const more = el('button', 't-more');
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>';
    more.onclick = e => { e.stopPropagation(); Sheets.track(t, opts); };
    row.append(more);

    row.onclick = () => opts.onPlay ? opts.onPlay(t) : Player.play([t.id], 0, opts.context || '');
    return row;
  },

  /* opts.onPlay, when given, wins — search results need to register themselves
     in the store before they can be queued by id. */
  trackList(tracks, opts = {}) {
    const wrap = el('div', 'track-list');
    const custom = opts.onPlay;
    tracks.forEach((t, i) => wrap.append(this.trackRow(t, {
      ...opts,
      onPlay: () => custom ? custom(t, i, tracks)
                           : Player.play(tracks.map(x => x.id), i, opts.context || '')
    })));
    return wrap;
  },

  emptyState(title, body) {
    const d = el('div', 'empty');
    d.innerHTML = `<strong>${esc(title)}</strong><div class="hint">${body}</div>`;
    return d;
  },

  /* ---------- routing ---------- */
  go(route, arg, push = true) {
    if (push && this.route) this.stack.push({ route: this.route, arg: this.routeArg });
    this.route = route; this.routeArg = arg;
    this.render();
  },
  back() {
    const prev = this.stack.pop();
    if (prev) { this.route = prev.route; this.routeArg = prev.arg; this.render(); }
    else this.go('home', null, false);
  },

  render() {
    const v = $('#view');
    v.innerHTML = '';
    v.scrollTop = 0;
    $('#backBtn').classList.toggle('on', this.stack.length > 0);
    $$('[data-route]').forEach(n => n.classList.toggle('active', n.dataset.route === this.route));

    const titles = { home: 'Home', search: 'Search', library: 'Library', liked: 'Liked', history: 'History', settings: 'Settings' };
    $('#viewTitle').textContent = titles[this.route] || '';

    ({
      home: () => this.viewHome(v),
      search: () => this.viewSearch(v),
      library: () => this.viewLibrary(v),
      liked: () => this.viewLiked(v),
      history: () => this.viewHistory(v),
      settings: () => this.viewSettings(v),
      playlist: () => this.viewPlaylist(v, this.routeArg)
    }[this.route] || (() => this.viewHome(v)))();

    this.renderSidebarPlaylists();
  },

  /* ---------- views ---------- */
  viewHome(v) {
    const d = Store.data;
    const recent = d.history.slice(0, 6).map(h => Store.track(h.trackId)).filter(Boolean);

    if (!Object.keys(d.tracks).length) {
      v.append(this.emptyState('Nothing here yet',
        'Head to <b>Search</b> to find music on YouTube, or open <b>Library → Import files</b> to add audio from this device.'));
      const b = el('button', 'load-more', 'Go to Search');
      b.onclick = () => this.go('search');
      v.append(b);
      return;
    }

    if (recent.length) {
      const s = el('div', 'section');
      s.innerHTML = '<div class="section-head"><h2>Jump back in</h2></div>';
      const q = el('div', 'quick');
      recent.forEach(t => {
        const tile = el('a', 'quick-tile');
        const img = el('img', 'qt-art'); img.src = t.thumb || 'icons/icon-180.png'; img.alt = '';
        tile.append(img, el('span', null, t.title));
        tile.onclick = () => Player.play(recent.map(x => x.id), recent.indexOf(t), 'Recent');
        q.append(tile);
      });
      s.append(q); v.append(s);
    }

    if (d.liked.length) {
      const s = el('div', 'section');
      s.innerHTML = '<div class="section-head"><h2>Liked</h2></div>';
      const liked = d.liked.map(id => Store.track(id)).filter(Boolean).slice(0, 20);
      s.append(this.trackList(liked, { context: 'Liked' }));
      v.append(s);
    }

    if (d.playlists.length) {
      const s = el('div', 'section');
      s.innerHTML = '<div class="section-head"><h2>Your playlists</h2></div>';
      s.append(this.playlistGrid(d.playlists.slice(0, 8)));
      v.append(s);
    }
  },

  playlistGrid(playlists) {
    const g = el('div', 'grid');
    playlists.forEach(p => {
      const c = el('a', 'card');
      const first = p.trackIds.map(id => Store.track(id)).find(t => t?.thumb);
      if (first) { const i = el('img', 'card-art'); i.src = first.thumb; i.alt = ''; c.append(i); }
      else {
        const ph = el('div', 'card-art gen');
        ph.innerHTML = '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 3v10.6A4 4 0 1014 17V7h4V3z"/></svg>';
        c.append(ph);
      }
      c.append(el('div', 'card-title', p.name), el('div', 'card-sub', `${p.trackIds.length} track${p.trackIds.length === 1 ? '' : 's'}`));
      c.onclick = () => this.go('playlist', p.id);
      g.append(c);
    });
    return g;
  },

  viewSearch(v) {
    const wrap = el('div', 'search-wrap');
    wrap.innerHTML = `
      <div class="search-box">
        <svg viewBox="0 0 24 24"><path d="M10 2a8 8 0 105.3 14l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0010 2zm0 2a6 6 0 110 12 6 6 0 010-12z" fill="currentColor"/></svg>
        <input id="q" type="search" placeholder="Songs, artists, or a YouTube link" autocomplete="off"
               autocorrect="off" spellcheck="false" value="${esc(this.search.q)}">
        <span id="qBusy" hidden><span class="spinner"></span></span>
        <button class="search-clear" id="qClear" ${this.search.q ? '' : 'hidden'} aria-label="Clear">&times;</button>
      </div>
      <div class="src-tabs">
        <button class="pill ${this.search.src === 'youtube' ? 'active' : ''}" data-src="youtube">YouTube</button>
        <button class="pill ${this.search.src === 'library' ? 'active' : ''}" data-src="library">My library</button>
      </div>`;
    v.append(wrap);

    const results = el('div', 'section');
    results.id = 'results';
    v.append(results);

    const input = $('#q', wrap);
    let debounce;
    input.addEventListener('input', () => {
      this.search.q = input.value;
      $('#qClear').hidden = !input.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => this.runSearch(true), 420);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(debounce); input.blur(); this.runSearch(true); } });
    $('#qClear', wrap).onclick = () => {
      input.value = ''; this.search.q = ''; this.search.items = [];
      $('#qClear').hidden = true; input.focus(); this.renderResults();
    };
    $$('.pill', wrap).forEach(p => p.onclick = () => {
      this.search.src = p.dataset.src;
      $$('.pill', wrap).forEach(x => x.classList.toggle('active', x === p));
      this.runSearch(true);
    });

    this.renderResults();
    if (this.search.q && !this.search.items.length) this.runSearch(true);
  },

  async runSearch(reset) {
    const q = this.search.q.trim();
    const box = $('#results');
    if (!box) return;
    if (reset) { this.search.items = []; this.search.nextPageToken = null; }
    if (!q) return this.renderResults();

    /* A pasted link resolves directly — no API key needed. */
    const vid = extractVideoId(q);
    if (vid && this.search.src === 'youtube') {
      this.setBusy(true);
      try {
        const t = await YT.lookup(vid);
        this.search.items = [t]; this.search.nextPageToken = null;
      } catch (e) { this.search.error = e.message; this.search.items = []; }
      this.setBusy(false);
      return this.renderResults();
    }

    if (this.search.src === 'library') {
      const needle = q.toLowerCase();
      this.search.items = Object.values(Store.data.tracks)
        .filter(t => (t.title + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase().includes(needle))
        .sort((a, b) => b.addedAt - a.addedAt);
      this.search.error = null;
      return this.renderResults();
    }

    const seq = ++this.search.seq;
    this.setBusy(true);
    this.search.error = null;
    try {
      const { items, nextPageToken } = await YT.search(q, reset ? '' : (this.search.nextPageToken || ''));
      if (seq !== this.search.seq) return;             // a newer search won
      this.search.items = reset ? items : [...this.search.items, ...items];
      this.search.nextPageToken = nextPageToken;
    } catch (e) {
      if (seq !== this.search.seq) return;
      this.search.error = e.message === 'NO_KEY' ? 'NO_KEY' : e.message;
      if (reset) this.search.items = [];
    } finally {
      if (seq === this.search.seq) this.setBusy(false);
    }
    this.renderResults();
  },

  setBusy(on) { const b = $('#qBusy'); if (b) b.hidden = !on; this.search.loading = on; },

  renderResults() {
    const box = $('#results');
    if (!box) return;
    box.innerHTML = '';

    if (this.search.error === 'NO_KEY') {
      box.append(this.emptyState('YouTube search needs a free API key',
        'Add one in <b>Settings → YouTube API key</b> (takes about 3 minutes, no cost).<br><br>' +
        'You don\'t have to: <b>paste any YouTube link</b> into the box above and it will resolve and play without a key.'));
      const b = el('button', 'load-more', 'Open Settings');
      b.onclick = () => this.go('settings');
      box.append(b);
      return;
    }
    if (this.search.error) return box.append(this.emptyState('Search failed', esc(this.search.error)));
    if (!this.search.q.trim()) {
      return box.append(this.emptyState('Search',
        'Find anything on YouTube — including the tracks that never made it to Spotify or Apple Music.<br><br>' +
        'You can also paste a YouTube link straight in.'));
    }
    if (this.search.loading && !this.search.items.length) return;
    if (!this.search.items.length) return box.append(this.emptyState('No results', 'Try different wording.'));

    box.append(this.trackList(this.search.items, {
      context: 'Search',
      fromSearch: true,
      onPlay: (t, i, list) => {
        list.forEach(x => Store.addTrack(x));   // must exist in the store to be queued by id
        Player.play(list.map(x => x.id), i, 'Search');
      }
    }));

    if (this.search.nextPageToken) {
      const more = el('button', 'load-more', this.search.loading ? 'Loading…' : 'Load more');
      more.onclick = () => { this.runSearch(false); more.textContent = 'Loading…'; };
      box.append(more);
    }
  },

  viewLibrary(v) {
    const actions = el('div', 'section');
    const imp = el('button', 'load-more', '＋  Import audio files from this device');
    imp.onclick = () => $('#fileInput').click();
    actions.append(imp);
    v.append(actions);

    const pls = el('div', 'section');
    pls.innerHTML = '<div class="section-head"><h2>Playlists</h2></div>';
    const np = el('button', 'load-more', '＋  New playlist');
    np.onclick = () => Dialogs.newPlaylist();
    if (Store.data.playlists.length) pls.append(this.playlistGrid(Store.data.playlists));
    pls.append(np);
    v.append(pls);

    const all = Object.values(Store.data.tracks).sort((a, b) => b.addedAt - a.addedAt);
    const s = el('div', 'section');
    s.innerHTML = `<div class="section-head"><h2>All tracks</h2><span class="hint">${all.length}</span></div>`;
    s.append(all.length ? this.trackList(all, { context: 'Library' })
                        : this.emptyState('No tracks yet', 'Import files above, or add things from Search.'));
    v.append(s);
  },

  viewLiked(v) {
    const tracks = Store.data.liked.map(id => Store.track(id)).filter(Boolean);
    if (!tracks.length) return v.append(this.emptyState('No liked tracks', 'Tap the heart on anything you want to keep.'));
    const s = el('div', 'section');
    s.append(this.playAllBar(tracks, 'Liked'));
    s.append(this.trackList(tracks, { context: 'Liked' }));
    v.append(s);
  },

  viewHistory(v) {
    const tracks = Store.data.history.map(h => Store.track(h.trackId)).filter(Boolean);
    if (!tracks.length) return v.append(this.emptyState('No history yet', 'Tracks you play show up here.'));
    const s = el('div', 'section');
    const clear = el('button', 'text-btn', 'Clear history');
    clear.onclick = () => Dialogs.confirm('Clear history?', 'This only removes the play log. Your tracks and playlists stay.', () => {
      Store.data.history = []; Store.save(); this.render(); toast('History cleared');
    });
    const head = el('div', 'section-head');
    head.append(el('h2', null, 'Recently played'), clear);
    s.append(head, this.trackList(tracks, { context: 'History' }));
    v.append(s);
  },

  playAllBar(tracks, label) {
    const bar = el('div', 'section-head');
    const play = el('button', 'btn primary', '▶  Play all');
    play.onclick = () => { Store.data.settings.shuffle = false; Store.save(); this.syncToggles(); Player.play(tracks.map(t => t.id), 0, label); };
    const shuf = el('button', 'btn', '⤨  Shuffle');
    shuf.onclick = () => {
      Store.data.settings.shuffle = true; Store.save(); this.syncToggles();
      const start = Math.floor(Math.random() * tracks.length);
      Player.play(tracks.map(t => t.id), start, label);
    };
    const g = el('div'); g.style.display = 'flex'; g.style.gap = '9px';
    g.append(play, shuf);
    bar.append(g);
    return bar;
  },

  viewPlaylist(v, id) {
    const p = Store.playlist(id);
    if (!p) return v.append(this.emptyState('Playlist not found', ''));
    $('#viewTitle').textContent = p.name;
    const tracks = p.trackIds.map(t => Store.track(t)).filter(Boolean);

    const head = el('div', 'section');
    const row = el('div', 'section-head');
    const left = el('div');
    left.append(el('h2', null, p.name));
    left.append(el('div', 'hint', `${tracks.length} track${tracks.length === 1 ? '' : 's'}`));
    const menu = el('button', 'text-btn', 'Edit');
    menu.onclick = () => Sheets.playlist(p);
    row.append(left, menu);
    head.append(row);
    if (tracks.length) head.append(this.playAllBar(tracks, p.name));
    v.append(head);

    const s = el('div', 'section');
    s.append(tracks.length
      ? this.trackList(tracks, { context: p.name, playlistId: p.id })
      : this.emptyState('Empty playlist', 'Use the ⋮ menu on any track to add it here.'));
    v.append(s);
  },

  viewSettings(v) {
    const d = Store.data.settings;

    const g1 = el('div', 'set-group');
    const keyRow = el('div', 'set-row');
    keyRow.innerHTML = `
      <div class="sr-body">
        <div class="sr-t">YouTube API key</div>
        <div class="sr-d">Enables searching YouTube by name. Free from Google Cloud → enable
          <b>YouTube Data API v3</b> → create an API key. Stored only on this device.<br>
          Without a key you can still paste YouTube links directly.</div>
        <input type="text" id="ytKey" placeholder="AIza…" value="${esc(d.ytApiKey)}" spellcheck="false">
      </div>`;
    g1.append(keyRow);
    v.append(g1);

    const g2 = el('div', 'set-group');
    g2.append(
      this.toggleRow('Save play history', 'Keep a local log of what you played.', d.saveHistory,
        on => { Store.data.settings.saveHistory = on; Store.save(); })
    );
    v.append(g2);

    const g3 = el('div', 'set-group');
    const exp = el('div', 'set-row');
    exp.innerHTML = `<div class="sr-body"><div class="sr-t">Export library</div>
      <div class="sr-d">Download your playlists, likes and track list as JSON. It's your data — no lock-in.</div></div>`;
    const expBtn = el('button', 'btn', 'Export');
    expBtn.onclick = () => Data.export();
    exp.append(expBtn);

    const impRow = el('div', 'set-row');
    impRow.innerHTML = `<div class="sr-body"><div class="sr-t">Import library</div>
      <div class="sr-d">Restore from an exported JSON file. Merges with what's already here.</div></div>`;
    const impBtn = el('button', 'btn', 'Import');
    impBtn.onclick = () => Data.import();
    impRow.append(impBtn);

    const wipe = el('div', 'set-row');
    wipe.innerHTML = `<div class="sr-body"><div class="sr-t">Reset everything</div>
      <div class="sr-d">Deletes all tracks, playlists, imported files and settings on this device.</div></div>`;
    const wipeBtn = el('button', 'btn danger', 'Reset');
    wipeBtn.onclick = () => Dialogs.confirm('Reset everything?', 'This cannot be undone.', async () => {
      localStorage.removeItem('resonant.v1');
      indexedDB.deleteDatabase('resonant');
      location.reload();
    });
    wipe.append(wipeBtn);
    g3.append(exp, impRow, wipe);
    v.append(g3);

    const info = el('div', 'set-group');
    const st = el('div', 'set-row');
    st.innerHTML = `<div class="sr-body"><div class="sr-t">Storage</div><div class="sr-d" id="usageLine">Checking…</div></div>`;
    info.append(st);
    const about = el('div', 'set-row');
    about.innerHTML = `<div class="sr-body"><div class="sr-t">About</div><div class="sr-d">
      Resonant plays your own audio files and streams YouTube through YouTube's official embedded player.<br><br>
      <b>Background audio:</b> imported files keep playing with the screen locked. YouTube tracks stop when you
      leave the app — Apple and YouTube both block background playback for embedded players.</div></div>`;
    info.append(about);
    v.append(info);

    DB.usage().then(u => {
      const line = $('#usageLine');
      if (line) line.textContent = u
        ? `${(u.used / 1048576).toFixed(1)} MB used of ~${(u.quota / 1048576).toFixed(0)} MB available`
        : 'Not reported by this browser';
    });

    $('#ytKey', v).addEventListener('change', e => {
      Store.data.settings.ytApiKey = e.target.value.trim();
      Store.save(); toast('API key saved');
    });
  },

  toggleRow(title, desc, val, onChange) {
    const r = el('div', 'set-row');
    r.innerHTML = `<div class="sr-body"><div class="sr-t">${esc(title)}</div><div class="sr-d">${desc}</div></div>`;
    const sw = el('button', 'switch' + (val ? ' on' : ''));
    sw.onclick = () => { const on = !sw.classList.contains('on'); sw.classList.toggle('on', on); onChange(on); };
    r.append(sw);
    return r;
  },

  renderSidebarPlaylists() {
    const box = $('#sidebarPlaylists');
    if (!box) return;
    box.innerHTML = '';
    Store.data.playlists.forEach(p => {
      const a = el('a', 'side-pl' + (this.route === 'playlist' && this.routeArg === p.id ? ' active' : ''), p.name);
      a.onclick = () => this.go('playlist', p.id);
      box.append(a);
    });
  },

  /* ---------- now playing / mini ---------- */
  renderNowPlaying() {
    const t = Player.current;
    const mini = $('#miniPlayer');
    if (!t) { mini.hidden = true; return; }
    mini.hidden = false;

    $('#miniArt').src = t.thumb || 'icons/icon-180.png';
    $('#miniTitle').textContent = t.title;
    $('#miniArtist').textContent = t.artist || '';

    $('#npTitle').textContent = t.title;
    $('#npArtist').textContent = t.artist || '';
    $('#npContext').textContent = Player.contextLabel || 'Now playing';

    const art = $('#npArt'), fb = $('#npArtFallback');
    if (t.thumb) { art.src = t.thumb; art.hidden = false; fb.style.display = 'none'; }
    else { art.hidden = true; fb.style.display = 'grid'; fb.textContent = (t.title || '?')[0].toUpperCase(); }

    $('#npWarn').hidden = t.source !== 'youtube';
    $('#npWarn').textContent = 'YouTube tracks pause when you leave the app or lock the screen — that limit is on Apple and YouTube\'s side. Imported files play in the background.';

    $('#npLike').innerHTML = Store.isLiked(t.id)
      ? '<svg viewBox="0 0 24 24"><path d="M12 21S3 14.6 3 8.9A5 5 0 0112 6a5 5 0 019 2.9C21 14.6 12 21 12 21z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M12 21S3 14.6 3 8.9A5 5 0 0112 6a5 5 0 019 2.9C21 14.6 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    $('#npLike').classList.toggle('on', Store.isLiked(t.id));

    this.syncToggles();
    Player.renderTransport();
    Player.renderProgress();
    this.renderQueue();
  },

  syncToggles() {
    const s = Store.data.settings;
    $('#shuffleBtn').classList.toggle('on', s.shuffle);
    $('#repeatBtn').classList.toggle('on', s.repeat !== 'off');
    $('#repeatBtn').classList.toggle('one', s.repeat === 'one');
    $('#rateSel').value = String(s.rate);
    $('#volume').value = s.volume;
    $('#volume').style.setProperty('--pv', s.volume + '%');
  },

  renderQueue() {
    const box = $('#queueList');
    if (!box) return;
    box.innerHTML = '';
    if (!Player.queue.length) return box.append(this.emptyState('Queue is empty', 'Play something to get started.'));

    const add = (label, idxs) => {
      if (!idxs.length) return;
      box.append(el('div', 'q-head', label));
      idxs.forEach(i => {
        const t = Store.track(Player.queue[i]);
        if (!t) return;
        const row = this.trackRow(t, { onPlay: () => Player.loadAt(i, true) });
        if (i !== Player.index) {
          const mv = el('div', 'q-move');
          const up = el('button'); up.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
          const dn = el('button'); dn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
          up.onclick = e => { e.stopPropagation(); Player.moveInQueue(i, -1); };
          dn.onclick = e => { e.stopPropagation(); Player.moveInQueue(i, 1); };
          mv.append(up, dn);
          row.insertBefore(mv, row.querySelector('.t-more'));
        }
        box.append(row);
      });
    };

    const orderIdx = Player.order.length ? Player.order : [...Player.queue.keys()];
    const pos = Math.max(0, orderIdx.indexOf(Player.index));
    add('Now playing', [Player.index]);
    add('Next up', orderIdx.slice(pos + 1));
  },

  refreshLists() {
    $$('.track').forEach(r => r.classList.toggle('playing', r.dataset.id === Player.current?.id));
  }
};

/* ---------------------------------------------------------------- sheets   */
const Sheets = {
  close() { const h = $('#modalHost'); h.hidden = true; h.innerHTML = ''; h.classList.remove('center'); },
  open(node, center) {
    const h = $('#modalHost');
    h.innerHTML = ''; h.hidden = false;
    h.classList.toggle('center', !!center);
    h.append(node);
    h.onclick = e => { if (e.target === h) this.close(); };
  },

  item(label, svg, fn, cls = '') {
    const b = el('button', 'sheet-item ' + cls);
    b.innerHTML = svg + `<span>${esc(label)}</span>`;
    b.onclick = () => { this.close(); fn(); };
    return b;
  },

  track(t, opts = {}) {
    const s = el('div', 'sheet');
    const head = el('div', 'sheet-head');
    const img = el('img'); img.src = t.thumb || 'icons/icon-180.png'; img.alt = '';
    const meta = el('div');
    meta.append(el('div', 'st', t.title), el('div', 'ss', t.artist || ''));
    head.append(img, meta);
    s.append(head);

    const I = {
      next: '<svg viewBox="0 0 24 24"><path d="M4 6h11M4 12h9M4 18h9M17 8v8l5-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      queue: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10M18 15v6M15 18h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      heart: '<svg viewBox="0 0 24 24"><path d="M12 21S3 14.6 3 8.9A5 5 0 0112 6a5 5 0 019 2.9C21 14.6 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
      plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.5.5l2-2A5 5 0 0012.5 4L11 5.5M14 11a5 5 0 00-7.5-.5l-2 2A5 5 0 0011.5 20l1.5-1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    };

    s.append(this.item('Play next', I.next, () => { Store.addTrack(t); Player.enqueueNext(t.id); }));
    s.append(this.item('Add to queue', I.queue, () => { Store.addTrack(t); Player.enqueueLast(t.id); }));
    s.append(this.item(Store.isLiked(t.id) ? 'Remove from Liked' : 'Add to Liked', I.heart, () => {
      Store.addTrack(t);
      toast(Store.toggleLike(t.id) ? 'Added to Liked' : 'Removed from Liked');
      UI.render(); UI.renderNowPlaying();
    }));
    s.append(this.item('Add to playlist…', I.plus, () => { Store.addTrack(t); Dialogs.addToPlaylist(t.id); }));

    if (opts.playlistId) {
      s.append(this.item('Remove from this playlist', I.minus, () => {
        const p = Store.playlist(opts.playlistId);
        p.trackIds = p.trackIds.filter(x => x !== t.id);
        Store.save(); UI.render(); toast('Removed');
      }));
    }
    if (t.source === 'youtube') {
      s.append(this.item('Open on YouTube', I.link, () => window.open('https://www.youtube.com/watch?v=' + t.videoId, '_blank', 'noopener')));
    }
    if (Store.track(t.id)) {
      s.append(this.item('Delete from library', I.trash, () => {
        Dialogs.confirm('Delete this track?', t.source === 'local'
          ? 'The imported audio file will be removed from this device.'
          : 'It will be removed from your library, playlists and likes.', async () => {
          await Store.removeTrack(t.id); UI.render(); toast('Deleted');
        });
      }, 'danger'));
    }
    this.open(s);
  },

  playlist(p) {
    const s = el('div', 'sheet');
    const head = el('div', 'sheet-head');
    head.append(el('div', 'st', p.name));
    s.append(head);
    s.append(this.item('Rename', '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      () => Dialogs.rename(p)));
    s.append(this.item('Delete playlist', '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      () => Dialogs.confirm('Delete playlist?', `"${esc(p.name)}" will be removed. The tracks stay in your library.`, () => {
        Store.data.playlists = Store.data.playlists.filter(x => x.id !== p.id);
        Store.save(); UI.go('library', null, false); toast('Playlist deleted');
      }), 'danger'));
    this.open(s);
  }
};

/* --------------------------------------------------------------- dialogs   */
const Dialogs = {
  newPlaylist() {
    const d = el('div', 'dialog');
    d.innerHTML = `<h3>New playlist</h3><p>Give it a name.</p>
      <input type="text" id="plName" placeholder="Late night" maxlength="60">
      <div class="dialog-actions"><button class="btn" id="cancel">Cancel</button>
      <button class="btn primary" id="ok">Create</button></div>`;
    Sheets.open(d, true);
    const inp = $('#plName', d);
    setTimeout(() => inp.focus(), 60);
    const submit = () => {
      const name = inp.value.trim();
      if (!name) return inp.focus();
      const p = Store.createPlaylist(name);
      Sheets.close(); UI.go('playlist', p.id); toast('Playlist created');
    };
    $('#ok', d).onclick = submit;
    $('#cancel', d).onclick = () => Sheets.close();
    inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
  },

  rename(p) {
    const d = el('div', 'dialog');
    d.innerHTML = `<h3>Rename playlist</h3><p></p>
      <input type="text" id="plName" maxlength="60" value="${esc(p.name)}">
      <div class="dialog-actions"><button class="btn" id="cancel">Cancel</button>
      <button class="btn primary" id="ok">Save</button></div>`;
    Sheets.open(d, true);
    const inp = $('#plName', d);
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
    const submit = () => {
      const n = inp.value.trim(); if (!n) return;
      p.name = n; Store.save(); Sheets.close(); UI.render();
    };
    $('#ok', d).onclick = submit;
    $('#cancel', d).onclick = () => Sheets.close();
    inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
  },

  addToPlaylist(trackId) {
    const s = el('div', 'sheet');
    const head = el('div', 'sheet-head');
    head.append(el('div', 'st', 'Add to playlist'));
    s.append(head);

    s.append(Sheets.item('New playlist…',
      '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      () => {
        const d = el('div', 'dialog');
        d.innerHTML = `<h3>New playlist</h3><p>The track will be added to it.</p>
          <input type="text" id="plName" placeholder="Late night" maxlength="60">
          <div class="dialog-actions"><button class="btn" id="cancel">Cancel</button>
          <button class="btn primary" id="ok">Create</button></div>`;
        Sheets.open(d, true);
        const inp = $('#plName', d);
        setTimeout(() => inp.focus(), 60);
        const submit = () => {
          const name = inp.value.trim(); if (!name) return inp.focus();
          const p = Store.createPlaylist(name);
          p.trackIds.push(trackId); Store.save();
          Sheets.close(); UI.render(); toast(`Added to ${name}`);
        };
        $('#ok', d).onclick = submit;
        $('#cancel', d).onclick = () => Sheets.close();
        inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
      }));

    Store.data.playlists.forEach(p => {
      const has = p.trackIds.includes(trackId);
      s.append(Sheets.item(p.name + (has ? '  ✓' : ''),
        '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        () => {
          if (has) { p.trackIds = p.trackIds.filter(x => x !== trackId); toast(`Removed from ${p.name}`); }
          else { p.trackIds.push(trackId); toast(`Added to ${p.name}`); }
          Store.save(); UI.render();
        }));
    });
    Sheets.open(s);
  },

  confirm(title, body, onYes) {
    const d = el('div', 'dialog');
    d.innerHTML = `<h3>${esc(title)}</h3><p>${body}</p>
      <div class="dialog-actions"><button class="btn" id="cancel">Cancel</button>
      <button class="btn danger" id="ok">Confirm</button></div>`;
    Sheets.open(d, true);
    $('#ok', d).onclick = () => { Sheets.close(); onYes(); };
    $('#cancel', d).onclick = () => Sheets.close();
  }
};

/* ------------------------------------------------------------ import/export */
const Data = {
  export() {
    const payload = structuredClone({ version: 1, exportedAt: new Date().toISOString(), ...Store.data });
    delete payload.settings.ytApiKey;                 // never ship the key around
    // Local object URLs are meaningless on another device / next launch.
    Object.values(payload.tracks).forEach(t => { if (t.source === 'local') t.thumb = ''; });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `resonant-library-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Library exported');
  },

  import() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!j.tracks) throw new Error('Not a Resonant export');
        // Local-file tracks can't survive a transfer — their audio lives in this device's DB.
        let skipped = 0;
        for (const [id, t] of Object.entries(j.tracks)) {
          if (t.source === 'local' && !(await DB.get('audio', id))) { skipped++; continue; }
          if (!Store.data.tracks[id]) Store.data.tracks[id] = t;
        }
        (j.playlists || []).forEach(p => {
          const existing = Store.data.playlists.find(x => x.id === p.id);
          if (existing) existing.trackIds = [...new Set([...existing.trackIds, ...p.trackIds])].filter(id => Store.data.tracks[id]);
          else Store.data.playlists.push({ ...p, trackIds: p.trackIds.filter(id => Store.data.tracks[id]) });
        });
        Store.data.liked = [...new Set([...Store.data.liked, ...(j.liked || [])])].filter(id => Store.data.tracks[id]);
        Store.save(); UI.render();
        toast(skipped ? `Imported — ${skipped} local file(s) skipped` : 'Library imported');
      } catch (e) { toast('Import failed: ' + e.message); }
    };
    inp.click();
  },

  async importFiles(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(f.name));
    if (!files.length) return toast('No audio files found');
    toast(`Importing ${files.length} file${files.length === 1 ? '' : 's'}…`);
    let ok = 0;
    for (const f of files) {
      try {
        const id = 'local:' + uid();
        await DB.put('audio', id, f);
        const tags = await readID3(f);
        let thumb = '';
        if (tags.art) { await DB.put('art', id, tags.art); thumb = URL.createObjectURL(tags.art); }
        Store.addTrack({
          id, source: 'local',
          title: tags.title || f.name.replace(/\.[^.]+$/, ''),
          artist: tags.artist || 'Unknown artist',
          album: tags.album || '',
          thumb, duration: 0, fileName: f.name
        });
        ok++;
      } catch (e) { console.warn('import failed', f.name, e); }
    }
    UI.render();
    toast(`Imported ${ok} file${ok === 1 ? '' : 's'}`);
  },

  /** Cover art lives in IndexedDB as a blob; re-mint object URLs each launch. */
  async rehydrateArt() {
    for (const t of Object.values(Store.data.tracks)) {
      if (t.source !== 'local') continue;
      const blob = await DB.get('art', t.id).catch(() => null);
      t.thumb = blob ? URL.createObjectURL(blob) : '';
    }
  }
};

/* ------------------------------------------------------------------- wire  */
function wireChrome() {
  $$('[data-route]').forEach(n => n.onclick = () => {
    if (n.dataset.route === UI.route) return;
    UI.stack = []; UI.go(n.dataset.route, null, false);
  });
  $('#backBtn').onclick = () => UI.back();
  $('#topSettings').onclick = () => UI.go('settings');
  $('#newPlaylistBtn').onclick = () => Dialogs.newPlaylist();

  const np = $('#nowPlaying'), qs = $('#queueSheet');
  const openNP = () => { np.classList.add('open'); np.setAttribute('aria-hidden', 'false'); };
  const closeNP = () => { np.classList.remove('open'); np.setAttribute('aria-hidden', 'true'); };
  $('#miniPlayer').onclick = e => { if (!e.target.closest('button')) openNP(); };
  $('#npCollapse').onclick = closeNP;
  $('#npQueueBtn').onclick = () => { UI.renderQueue(); qs.classList.add('open'); qs.setAttribute('aria-hidden', 'false'); };
  $('#queueClose').onclick = () => { qs.classList.remove('open'); qs.setAttribute('aria-hidden', 'true'); };
  $('#queueClear').onclick = () => {
    Player.queue = Player.current ? [Player.current.id] : [];
    Player.index = Player.queue.length ? 0 : -1;
    Player.buildOrder(0); UI.renderQueue(); toast('Queue cleared');
  };

  $('#playBtn').onclick = () => Player.toggle();
  $('#miniPlay').onclick = e => { e.stopPropagation(); Player.toggle(); };
  $('#nextBtn').onclick = () => Player.next();
  $('#miniNext').onclick = e => { e.stopPropagation(); Player.next(); };
  $('#prevBtn').onclick = () => Player.prev();
  $('#miniPrev').onclick = e => { e.stopPropagation(); Player.prev(); };

  $('#npLike').onclick = () => {
    if (!Player.current) return;
    toast(Store.toggleLike(Player.current.id) ? 'Added to Liked' : 'Removed from Liked');
    UI.renderNowPlaying();
    if (UI.route === 'liked' || UI.route === 'home') UI.render();
  };

  $('#shuffleBtn').onclick = () => {
    Store.data.settings.shuffle = !Store.data.settings.shuffle; Store.save();
    Player.buildOrder(Player.index); UI.syncToggles(); UI.renderQueue();
    toast(Store.data.settings.shuffle ? 'Shuffle on' : 'Shuffle off');
  };
  $('#repeatBtn').onclick = () => {
    const order = ['off', 'all', 'one'];
    const s = Store.data.settings;
    s.repeat = order[(order.indexOf(s.repeat) + 1) % 3];
    Store.save(); UI.syncToggles();
    toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[s.repeat]);
  };

  const seek = $('#seek');
  const startSeek = () => { UI.seeking = true; };
  const endSeek = () => {
    const dur = Player.duration();
    if (dur) Player.seekTo((seek.value / 1000) * dur);
    UI.seeking = false;
  };
  seek.addEventListener('pointerdown', startSeek);
  seek.addEventListener('input', () => seek.style.setProperty('--p', (seek.value / 10) + '%'));
  seek.addEventListener('change', endSeek);
  seek.addEventListener('pointerup', endSeek);

  $('#volume').oninput = e => Player.setVolume(+e.target.value);
  $('#rateSel').onchange = e => Player.setRate(parseFloat(e.target.value));
  $('#sleepSel').onchange = e => Player.setSleep(e.target.value);

  $('#fileInput').onchange = e => { Data.importFiles(e.target.files); e.target.value = ''; };

  // Drag & drop audio anywhere (desktop convenience)
  ['dragover', 'drop'].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault();
    if (ev === 'drop' && e.dataTransfer?.files?.length) Data.importFiles(e.dataTransfer.files);
  }));

  document.addEventListener('keydown', e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); Player.toggle(); }
    else if (e.key === 'ArrowRight' && e.shiftKey) Player.next();
    else if (e.key === 'ArrowLeft' && e.shiftKey) Player.prev();
    else if (e.key === 'ArrowRight') Player.seekTo(Player.position() + 10);
    else if (e.key === 'ArrowLeft') Player.seekTo(Math.max(0, Player.position() - 10));
    else if (e.key === 'Escape') { closeNP(); qs.classList.remove('open'); Sheets.close(); }
    else if (e.key === '/') { e.preventDefault(); UI.go('search'); setTimeout(() => $('#q')?.focus(), 80); }
  });
}

/* ------------------------------------------------------------------- boot  */
(async function boot() {
  Store.load();
  await Data.rehydrateArt().catch(() => {});
  Player.init();
  wireChrome();
  UI.render();
  UI.renderNowPlaying();
  UI.syncToggles();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
