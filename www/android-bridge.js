// Vibe voor Android: verbindt de pagina met de Android-kant (afspelen, bibliotheek, rechten).
(() => {
  const Cap = window.Capacitor;
  const P = Cap.registerPlugin('Vibe');
  const AppP = Cap.registerPlugin('App');
  const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

  const DEFAULTS = { onlineLyrics: true, subs: true, autoLyrics: false, subSize: 24 };
  let cfg = { ...DEFAULTS, ...ls('cfg', {}) };
  const saveCfg = () => localStorage.setItem('cfg', JSON.stringify(cfg));
  const label = () => cfg.label || 'Alle muziek op je telefoon';
  const uriBy = new Map();
  let asked = false, lastRefresh = 0;

  // ---------- afspelen gebeurt in de Android-service ----------
  let qid = 0, lastIndex = -2;
  const audio = {
    paused: true, duration: NaN, _pos: 0, _vol: 1, onplay: null, onpause: null, ontimeupdate: null,
    get currentTime() { return this._pos; },
    set currentTime(t) { this._pos = t; P.seek({ position: t }); },
    get volume() { return this._vol; },
    set volume(v) { this._vol = v; }, // volume regel je met de knoppen van je telefoon
    play() { P.play(); return Promise.resolve(); },
    pause() { P.pause(); }
  };

  function apply(s) {
    const was = audio.paused;
    audio.paused = !s.playing;
    audio.duration = s.duration > 0 ? s.duration : NaN;
    audio._pos = s.position || 0;
    if (was !== audio.paused) (audio.paused ? audio.onpause : audio.onplay)?.();
    audio.ontimeupdate?.();
  }

  P.addListener('state', s => {
    if (s.qid !== qid) return;
    apply(s);
    if (s.index !== lastIndex) {
      lastIndex = s.index;
      window.dispatchEvent(new CustomEvent('native-track', { detail: s.index }));
    }
  });

  const native = {
    audio,
    setQueue(list, index, shuffle, repeat) {
      qid = Date.now();
      lastIndex = index;
      P.setQueue({ paths: list.map(t => t.path), index, shuffle, repeat, qid });
    },
    step: d => (d > 0 ? P.next() : P.back()),
    setShuffle: on => P.setShuffle({ on }),
    setRepeat: mode => P.setRepeat({ mode }),
    useAll() { cfg.abs = ''; cfg.rel = ''; cfg.label = ''; saveCfg(); },
    access: () => P.access(),
    accessStatus: () => P.accessStatus(),
    requestFiles: () => P.requestFiles(),
    async restore() {
      const st = await P.getState();
      if (!st.has) return null;
      qid = st.qid;
      lastIndex = st.index;
      apply(st);
      return st;
    }
  };

  // ---------- songteksten en ondertitels ----------
  function parseLrc(txt) {
    const out = [];
    for (const line of txt.split(/\r?\n/)) {
      const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      if (!tags.length) continue;
      const text = line.replace(/\[[^\]]*\]/g, '').trim();
      for (const t of tags) out.push({ t: +t[1] * 60 + parseFloat(t[2]), text });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  function parseSrt(txt) {
    const out = [];
    for (const blk of txt.replace(/\r/g, '').split(/\n\n+/)) {
      const ls2 = blk.split('\n');
      const i = ls2.findIndex(l => l.includes('-->'));
      const m = i >= 0 && ls2[i].match(/(\d+):(\d+):(\d+)[,.](\d+)/);
      if (!m) continue;
      const text = ls2.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
      out.push({ t: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, text });
    }
    return out;
  }

  const fromText = txt => /\[\d+:\d+/.test(txt)
    ? { synced: true, lines: parseLrc(txt) }
    : { synced: false, lines: txt.split(/\r?\n/).map(text => ({ t: null, text })) };

  const clean = s => (s || '')
    .replace(/\s*[(\[][^)\]]*(feat|ft\.|remaster|live|version|radio|edit|official|lyric|video)[^)\]]*[)\]]/gi, '')
    .replace(/\s*-\s*(remaster(ed)?|live|radio edit|single version).*$/i, '').trim();

  async function online(tr, force) {
    const key = 'lyr:' + tr.path;
    if (!force) {
      const c = ls(key, null);
      if (c) {
        if (!c.none) return c;
        if (Date.now() - (c.at || 0) < 7 * 864e5) return null;
      }
    }
    const get = async p => {
      const r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams(p));
      if (!r.ok) throw new Error(r.status);
      return r.json();
    };
    try {
      const title = clean(tr.title), artist = clean(tr.artist);
      let arr = artist ? await get({ track_name: title, artist_name: artist }) : [];
      if (!arr.length) arr = await get({ q: `${artist} ${title}`.trim() });
      const close = arr.filter(x => !tr.duration || Math.abs(x.duration - tr.duration) < 6);
      const pick = close.find(x => x.syncedLyrics) || close.find(x => x.plainLyrics) || arr.find(x => x.plainLyrics);
      const res = pick ? fromText(pick.syncedLyrics || pick.plainLyrics) : { none: true, at: Date.now() };
      try { localStorage.setItem(key, JSON.stringify(res)); } catch {}
      return res.none ? null : res;
    } catch { return null; }
  }

  async function lyrics(tr, force) {
    const base = tr.path.replace(/\.[^./]+$/, '');
    for (const ext of ['.lrc', '.srt']) {
      try {
        const r = await P.readText({ path: base + ext });
        if (r.text) {
          const txt = r.text.replace(/^\uFEFF/, '');
          if (ext === '.srt') {
            const lines = parseSrt(txt);
            if (lines.length) return { synced: true, lines };
          } else return fromText(txt);
        }
      } catch {}
    }
    return cfg.onlineLyrics ? online(tr, force) : null;
  }

  const isLight = c => {
    const n = parseInt(String(c).slice(1), 16);
    return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255 > 0.6;
  };

  window.vibe = {
    native,
    lyrics,
    async library(force) {
      if (!asked) { asked = true; try { await P.access(); } catch {} }
      const rel = cfg.rel || '';
      let r = await P.scan({ rel });
      if (cfg.abs && (force || Date.now() - lastRefresh > 60000)) {
        lastRefresh = Date.now();
        try {
          const m = await P.refreshMedia({ abs: cfg.abs });
          if (m.added) r = await P.scan({ rel });
        } catch {}
      }
      const tracks = r.tracks || [];
      tracks.forEach(t => uriBy.set(t.path, t.url));
      return tracks.sort((a, b) => a.title.localeCompare(b.title));
    },
    async cover(path) {
      const uri = uriBy.get(path);
      if (!uri) return null;
      try { return (await P.cover({ uri })).data || null; } catch { return null; }
    },
    getSettings: async () => ({ ...cfg, folder: label() }),
    setSettings: async patch => { cfg = { ...cfg, ...patch }; saveCfg(); return { ...cfg, folder: label() }; },
    async pickFolder() {
      const r = await P.pickFolder();
      if (!r || !r.abs) return null;
      cfg.abs = r.abs; cfg.rel = r.rel; cfg.label = r.label;
      saveCfg();
      return label();
    },
    openFolder: () => {},
    openAudio: () => P.openUrl({ url: 'https://audio.com' }),
    setLook: o => { try { P.setBars({ color: o.bg, light: isLight(o.bg) }); } catch {} },
    zoom: f => { document.documentElement.style.zoom = f === 1 ? '' : String(f); },
    onLibraryChanged: cb => AppP.addListener('appStateChange', s => { if (s.isActive) cb(); })
  };
})();
