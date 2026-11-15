const $ = s => document.querySelector(s);
const ic = (n, c = '') => `<svg class="${c}"><use href="#i-${n}"/></svg>`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => (isFinite(s) && s > 0) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const paint = (el, p) => el.style.setProperty('--p', p + '%');

const S = {
  all: [], by: new Map(), shown: [], view: 'library', q: '', loading: true,
  queue: [], i: -1, shuffle: false, repeat: 0, // repeat: 0 uit, 1 alles, 2 één
  favs: new Set(load('favs', [])), pls: load('pls', {}),
  lyr: null, lyrOn: false, now: -1, settings: {}
};
const save = () => {
  localStorage.setItem('favs', JSON.stringify([...S.favs]));
  localStorage.setItem('pls', JSON.stringify(S.pls));
};
const NA = window.vibe.native || null;
const au = NA ? NA.audio : new Audio();
au.volume = load('vol', 0.8);

// ---------- uiterlijk ----------
const FONTS = [
  ['Segoe UI', '"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif'],
  ['Bahnschrift', 'Bahnschrift,"Segoe UI",sans-serif'],
  ['Trebuchet', '"Trebuchet MS",sans-serif'],
  ['Verdana', 'Verdana,sans-serif'],
  ['Georgia (serif)', 'Georgia,serif'],
  ['Consolas (mono)', 'Consolas,monospace']
];
const PRESETS = {
  Zonsondergang: { bg: '#14101c', panel: '#1b1626', text: '#f5efe4', a1: '#ff7a45', a2: '#ffc15a' },
  Middernacht: { bg: '#0b1220', panel: '#111a2e', text: '#e8f0ff', a1: '#38bdf8', a2: '#818cf8' },
  Bos: { bg: '#0e1a14', panel: '#14241c', text: '#eaf5ec', a1: '#34d399', a2: '#d9f99d' },
  Neon: { bg: '#120a1c', panel: '#1c1030', text: '#fdf2ff', a1: '#f0abfc', a2: '#22d3ee' },
  Zwart: { bg: '#000000', panel: '#0b0b0b', text: '#ffffff', a1: '#ffffff', a2: '#a3a3a3' },
  Licht: { bg: '#f6f1e9', panel: '#ffffff', text: '#1d1826', a1: '#e8590c', a2: '#f59f00' }
};
const DEF = { ...PRESETS.Zonsondergang, preset: 'Zonsondergang', radius: 10, zoom: 100, font: FONTS[0][1], compact: false, opacity: 100, glass: false, glassA: 55, css: '', splash: true };
let look = { ...DEF, ...load('look', {}) };
const saveLook = () => localStorage.setItem('look', JSON.stringify(look));
const rp = el => paint(el, (el.value - el.min) / (el.max - el.min) * 100);

function lum(h) {
  const n = parseInt(h.slice(1), 16);
  const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
}

function applyLook() {
  const L = look, r = document.documentElement.style;
  for (const k of ['bg', 'panel', 'text']) r.setProperty('--' + k, L[k]);
  r.setProperty('--sun', L.a1);
  r.setProperty('--gold', L.a2);
  r.setProperty('--ink', (lum(L.a1) + lum(L.a2)) / 2 > .3 ? '#1a1320' : '#ffffff');
  r.setProperty('--r', L.radius + 'px');
  r.setProperty('--font', L.font);
  r.colorScheme = lum(L.bg) > .4 ? 'light' : 'dark';
  if (L.glass) {
    r.setProperty('--bgfill', `color-mix(in srgb, ${L.bg} ${L.glassA}%, transparent)`);
    r.setProperty('--panelfill', `color-mix(in srgb, ${L.panel} ${Math.min(100, L.glassA + 10)}%, transparent)`);
  } else { r.removeProperty('--bgfill'); r.removeProperty('--panelfill'); }
  document.body.classList.toggle('compact', !!L.compact);
  $('#userCss').textContent = L.css;
  window.vibe.zoom(L.zoom / 100);
  window.vibe.setLook({ opacity: L.opacity / 100, glass: L.glass, bg: L.bg });
}

function renderPresets() {
  $('#presets').innerHTML = Object.entries(PRESETS).map(([n, p]) =>
    `<button class="pre ${look.preset === n ? 'on' : ''}" data-pre="${esc(n)}"><i style="background:linear-gradient(135deg,${p.bg} 50%,${p.a1} 50%)"></i>${esc(n)}</button>`).join('');
}
function fillLook() {
  document.querySelectorAll('#settings [data-k]').forEach(el => {
    const v = look[el.dataset.k];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    if (el.type === 'range') rp(el);
  });
  renderPresets();
}
function applySettings() {
  document.documentElement.style.setProperty('--sub', S.settings.subSize + 'px');
  showSub();
}
applyLook();

// startanimatie
{
  const sp = $('#splash');
  if (look.splash === false) sp.remove();
  else {
    sp.addEventListener('animationend', e => { if (e.animationName === 'sp-out' || e.animationName === 'sp-skip') sp.remove(); });
    sp.onclick = () => { sp.style.animation = 'sp-skip .3s ease forwards'; };
    addEventListener('keydown', () => { sp.style.animation = 'sp-skip .3s ease forwards'; }, { once: true });
  }
}

// ---------- zijbalk ----------
function renderSide() {
  $('#pls').innerHTML = Object.keys(S.pls).map(n =>
    `<div class="nav pl" data-view="pl:${esc(n)}" tabindex="0">${ic('note')}<span>${esc(n)}</span><button class="del" data-del="${esc(n)}" title="Verwijder afspeellijst">${ic('close')}</button></div>`
  ).join('');
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === S.view || (b.dataset.view === 'pls' && S.view.startsWith('pl:'))));
  document.body.dataset.view = S.view;
}

// ---------- lijst ----------
const titleOf = () => S.view === 'library' ? 'Bibliotheek' : S.view === 'favs' ? 'Favorieten' : S.view === 'pls' ? 'Afspeellijsten' : S.view.slice(3);

function visible() {
  let l = S.all;
  if (S.view === 'favs') l = l.filter(t => S.favs.has(t.path));
  else if (S.view.startsWith('pl:')) l = (S.pls[S.view.slice(3)] || []).map(p => S.by.get(p)).filter(Boolean);
  const q = S.q.trim().toLowerCase();
  return q ? l.filter(t => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)) : l;
}

function emptyHtml() {
  if (S.loading) return `<div class="empty"><p>Bibliotheek laden…</p></div>`;
  if (S.q) return `<div class="empty"><h2>Niets gevonden</h2><p>Geen nummers die passen bij "${esc(S.q)}".</p></div>`;
  if (S.view === 'favs') return `<div class="empty"><h2>Nog geen favorieten</h2><p>Klik op het hartje bij een nummer om het hier te bewaren.</p></div>`;
  if (S.view.startsWith('pl:')) return `<div class="empty"><h2>Deze afspeellijst is leeg</h2><p>Gebruik de plusknop bij een nummer om het toe te voegen.</p></div>`;
  return `<div class="empty"><h2>Je bibliotheek is leeg</h2><p>Zet muziekbestanden op je telefoon (<b>${esc(S.settings.folder || '')}</b>) en ze verschijnen hier vanzelf. Geef Vibe ook toegang bij Instellingen.</p><div class="acts"><button class="btn pri" data-go="audio">Vind je liedjes op audio.com</button><button class="btn" data-go="folder">Open muziekmap</button></div></div>`;
}

function renderList() {
  const list = $('#list'), st = list.scrollTop;
  if (S.view === 'pls') {
    S.shown = [];
    $('#vtitle').textContent = titleOf();
    $('#count').textContent = '';
    list.innerHTML = plsHtml();
    return;
  }
  S.shown = visible();
  $('#vtitle').textContent = titleOf();
  $('#count').textContent = S.loading ? '' : (S.shown.length === 1 ? '1 nummer' : `${S.shown.length} nummers`);
  const cur = S.queue[S.i]?.path;
  list.innerHTML = S.shown.length ? S.shown.map((t, n) => `
    <div class="row ${t.path === cur ? 'cur' : ''}" data-n="${n}">
      <span class="n">${n + 1}</span>
      <div class="ti"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist || 'Onbekende artiest')}</div></div>
      <div class="al">${esc(t.album)}</div>
      <button class="ic heart ${S.favs.has(t.path) ? 'on' : ''}" data-act="fav" title="Favoriet">${ic('heart')}</button>
      <button class="ic" data-act="add" title="Aan afspeellijst toevoegen">${ic('plus')}</button>
      <span class="d">${fmt(t.duration)}</span>
    </div>`).join('') : emptyHtml();
  list.scrollTop = st;
  $('#thead').hidden = S.lyrOn || !S.shown.length;
}

function plsHtml() {
  const rows = Object.keys(S.pls).map(n => `<div class="plrow" data-openpl="${esc(n)}">${ic('note')}<div class="ti"><div class="t">${esc(n)}</div><div class="a">${S.pls[n].length} nummers</div></div><button class="ic" data-delpl="${esc(n)}" title="Verwijder">${ic('close')}</button></div>`).join('');
  return `<div class="plrows">${rows}<button class="btn pri newpl" data-newpl="1">Nieuwe afspeellijst</button></div>`;
}

async function refresh(force) {
  S.loading = true; renderList();
  S.all = await window.vibe.library(force);
  S.by = new Map(S.all.map(t => [t.path, t]));
  S.loading = false; renderList();
}

// ---------- afspelen ----------
function markCur() {
  const cur = S.queue[S.i]?.path;
  document.querySelectorAll('#list .row').forEach(r => r.classList.toggle('cur', S.shown[r.dataset.n]?.path === cur));
}
const syncHeart = () => $('#npHeart').classList.toggle('on', S.favs.has(S.queue[S.i]?.path));

function play(list, i) {
  S.queue = list.slice();
  S.i = i;
  if (NA) { NA.setQueue(S.queue, i, S.shuffle, S.repeat); showTrack(S.queue[i]); } else start();
}

function start() {
  const t = S.queue[S.i];
  if (!t) return;
  au.src = t.url;
  au.play().catch(() => {});
  showTrack(t);
}

function showTrack(t) {
  $('#np-t').textContent = t.title;
  $('#np-a').textContent = t.artist || 'Onbekende artiest';
  const cv = $('#cover');
  cv.style.backgroundImage = '';
  cv.textContent = (t.title[0] || '♪').toUpperCase();
  window.vibe.cover(t.path).then(c => {
    if (c && S.queue[S.i] === t) { cv.style.backgroundImage = `url("${c}")`; cv.textContent = ''; }
  });
  fetchLyrics(t);
  syncHeart(); markCur();
  document.title = `${t.title} – Vibe`;
}

function step(d, auto) {
  const n = S.queue.length;
  if (!n) return;
  if (NA) return NA.step(d);
  if (S.shuffle && n > 1) {
    let j;
    do j = Math.floor(Math.random() * n); while (j === S.i);
    S.i = j;
  } else {
    const j = S.i + d;
    if (j < 0 || j >= n) {
      if (auto && S.repeat === 0) return;
      S.i = (j + n) % n;
    } else S.i = j;
  }
  start();
}

function toggle() {
  if (S.i < 0) { if (S.shown.length) play(S.shown, 0); return; }
  au.paused ? au.play() : au.pause();
}
const prev = () => au.currentTime > 3 ? (au.currentTime = 0) : step(-1);

au.onplay = au.onpause = () => {
  $('#pp').innerHTML = ic(au.paused ? 'play' : 'pause', 'f');
  $('#pp').title = au.paused ? 'Afspelen' : 'Pauzeren';
};
au.onended = () => { if (S.repeat === 2) { au.currentTime = 0; au.play(); } else step(1, true); };
au.onerror = () => { if (S.repeat !== 1) step(1, true); };

const seek = $('#seek');
let dragging = false;
au.ontimeupdate = () => {
  if (!dragging && au.duration) { seek.value = au.currentTime / au.duration * 1000; paint(seek, seek.value / 10); }
  $('#cur').textContent = fmt(au.currentTime);
  $('#dur').textContent = fmt(au.duration);
  tickLyrics();
};
seek.oninput = () => { dragging = true; paint(seek, seek.value / 10); $('#cur').textContent = fmt(seek.value / 1000 * au.duration); };
seek.onchange = () => { if (au.duration) au.currentTime = seek.value / 1000 * au.duration; dragging = false; };

const vol = $('#vol');
vol.value = au.volume * 100; paint(vol, vol.value);
vol.oninput = () => { au.volume = vol.value / 100; paint(vol, vol.value); localStorage.setItem('vol', au.volume); };

$('#pp').onclick = toggle;
$('#next').onclick = () => step(1);
$('#prev').onclick = prev;
$('#shuf').onclick = e => { S.shuffle = !S.shuffle; e.currentTarget.classList.toggle('on', S.shuffle); NA?.setShuffle(S.shuffle); };
$('#rep').onclick = e => {
  S.repeat = (S.repeat + 1) % 3;
  e.currentTarget.classList.toggle('on', S.repeat > 0);
  e.currentTarget.dataset.m = S.repeat;
  e.currentTarget.title = ['Herhalen uit', 'Alles herhalen', 'Dit nummer herhalen'][S.repeat];
  NA?.setRepeat(S.repeat);
};
addEventListener('keydown', e => {
  if (e.code === 'Space' && !/INPUT|BUTTON|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); toggle(); }
});
if (navigator.mediaSession && !NA) {
  for (const [a, f] of [['play', toggle], ['pause', toggle], ['previoustrack', prev], ['nexttrack', () => step(1)]])
    navigator.mediaSession.setActionHandler(a, f);
}

// ---------- favorieten en afspeellijsten ----------
function toggleFav(p) {
  S.favs.has(p) ? S.favs.delete(p) : S.favs.add(p);
  save(); syncHeart(); renderList();
}
$('#npHeart').onclick = () => { const t = S.queue[S.i]; if (t) toggleFav(t.path); };

function toggleIn(n, p) {
  const l = (S.pls[n] ||= []), i = l.indexOf(p);
  i < 0 ? l.push(p) : l.splice(i, 1);
  save(); renderList();
}

function askName(cb) {
  const d = $('#nameDlg'), inp = $('#nameIn');
  inp.value = ''; d.returnValue = '';
  d.showModal(); inp.focus();
  d.onclose = () => { const n = inp.value.trim(); if (d.returnValue === 'ok' && n) cb(n); };
}

function openMenu(btn, p) {
  const m = $('#menu');
  m.innerHTML = Object.keys(S.pls).map(n =>
    `<button class="mi" data-pl="${esc(n)}">${S.pls[n].includes(p) ? ic('check') : '<span class="sp"></span>'}<span>${esc(n)}</span></button>`
  ).join('') + `<button class="mi new" data-new="1">${ic('plus')}<span>Nieuwe afspeellijst</span></button>`;
  m.dataset.path = p; m.hidden = false;
  const r = btn.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 12)) + 'px';
  m.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 100)) + 'px';
}
$('#menu').onclick = e => {
  const b = e.target.closest('button'), p = $('#menu').dataset.path;
  if (!b) return;
  $('#menu').hidden = true;
  if (b.dataset.new) askName(n => { const l = (S.pls[n] ||= []); if (!l.includes(p)) l.push(p); save(); renderSide(); renderList(); });
  else toggleIn(b.dataset.pl, p);
};
document.addEventListener('click', e => {
  if (!e.target.closest('#menu') && !e.target.closest('[data-act="add"]')) $('#menu').hidden = true;
});

$('#newpl').onclick = () => askName(n => { S.pls[n] ||= []; save(); renderSide(); });

// ---------- navigatie ----------
$('aside').onclick = e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    const n = del.dataset.del;
    if (confirm(`Afspeellijst "${n}" verwijderen?`)) {
      delete S.pls[n]; save();
      if (S.view === 'pl:' + n) S.view = 'library';
      renderSide(); renderList();
    }
    return;
  }
  const v = e.target.closest('[data-view]');
  if (v) { S.view = v.dataset.view; setLyr(false); renderSide(); renderList(); }
};
$('#audio').onclick = () => window.vibe.openAudio();
$('#q').oninput = e => { S.q = e.target.value; setLyr(false); renderList(); };

$('#list').onclick = e => {
  const dp = e.target.closest('[data-delpl]');
  if (dp) {
    const n = dp.dataset.delpl;
    if (confirm(`Afspeellijst "${n}" verwijderen?`)) { delete S.pls[n]; save(); renderSide(); renderList(); }
    return;
  }
  const op = e.target.closest('[data-openpl]');
  if (op) { S.view = 'pl:' + op.dataset.openpl; renderSide(); renderList(); return; }
  if (e.target.closest('[data-newpl]')) { askName(n => { S.pls[n] ||= []; save(); renderSide(); renderList(); }); return; }
  const go = e.target.closest('[data-go]');
  if (go) return go.dataset.go === 'audio' ? window.vibe.openAudio() : window.vibe.openFolder();
  const row = e.target.closest('.row');
  if (!row) return;
  const n = +row.dataset.n, t = S.shown[n];
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'fav') toggleFav(t.path);
  else if (act === 'add') openMenu(e.target.closest('button'), t.path);
  else play(S.shown, n);
};

// ---------- songtekst ----------
function setLyr(on) {
  S.lyrOn = on;
  $('#list').hidden = on;
  $('#lyr').hidden = !on;
  $('#thead').hidden = on || !S.shown.length;
  $('#lyrBtn').classList.toggle('on', on);
  if (on) $('#lyr').querySelector('p.now')?.scrollIntoView({ block: 'center' });
  showSub();
}
$('#lyrBtn').onclick = () => setLyr(!S.lyrOn);

function renderLyrics() {
  const el = $('#lyr');
  if (S.i < 0) return void (el.innerHTML = `<div class="empty"><h2>Geen nummer actief</h2><p>Speel een nummer af om de songtekst te zien.</p></div>`);
  if (S.lyr === null) return void (el.innerHTML = `<div class="empty"><p>Songtekst zoeken…</p></div>`);
  if (!S.lyr) return void (el.innerHTML = `<div class="empty"><h2>Geen songtekst gevonden</h2><p>Zet een .lrc- of .srt-bestand met dezelfde naam naast het nummer, dan laadt Vibe die automatisch.</p><div class="acts"><button class="btn" data-retry>Opnieuw zoeken</button></div></div>`);
  el.innerHTML = `<div class="lines">${S.lyr.lines.map((l, n) =>
    l.text ? `<p data-n="${n}" class="${S.lyr.synced ? 's' : 'flat'}">${esc(l.text)}</p>` : `<p class="gap"></p>`).join('')}</div>`;
}

function tickLyrics() {
  if (!S.lyr || !S.lyr.synced) return;
  const L = S.lyr.lines;
  let n = -1;
  for (let k = 0; k < L.length && L[k].t <= au.currentTime + 0.25; k++) n = k;
  if (n === S.now) return;
  S.now = n;
  const el = $('#lyr');
  el.querySelector('p.now')?.classList.remove('now');
  const p = el.querySelector(`p[data-n="${n}"]`);
  if (p) { p.classList.add('now'); if (S.lyrOn) p.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  showSub();
}

function fetchLyrics(t, force) {
  S.lyr = null; S.now = -1; renderLyrics(); showSub();
  window.vibe.lyrics(t, force).then(l => {
    if (S.queue[S.i] !== t) return;
    S.lyr = l || false; S.now = -1; renderLyrics(); tickLyrics();
    if (l && S.settings.autoLyrics) setLyr(true);
  });
}

function showSub() {
  const L = S.lyr?.synced ? S.lyr.lines : null;
  const cur = L && S.now >= 0 ? L[S.now].text : '';
  const on = !!(S.settings.subs && cur && !S.lyrOn);
  $('#sub').hidden = !on;
  document.body.classList.toggle('has-sub', on);
  if (!on) return;
  let nx = '';
  for (let k = S.now + 1; k < L.length; k++) if (L[k].text) { nx = L[k].text; break; }
  $('#sub .cur').textContent = cur;
  $('#sub .nxt').textContent = nx;
}
$('#lyr').onclick = e => {
  if (e.target.closest('[data-retry]')) { const t = S.queue[S.i]; if (t) fetchLyrics(t, true); return; }
  const p = e.target.closest('p[data-n]');
  if (p && S.lyr?.synced) au.currentTime = S.lyr.lines[p.dataset.n].t;
};

// ---------- instellingen ----------
$('#settingsBtn').onclick = async () => {
  S.settings = await window.vibe.getSettings();
  $('#sFolder').textContent = S.settings.folder;
  document.querySelectorAll('#settings [data-s]').forEach(el => {
    const v = S.settings[el.dataset.s];
    if (el.type === 'checkbox') el.checked = !!v; else { el.value = v; rp(el); }
  });
  fillLook();
  $('#settings').showModal();
};
$('#sPick').onclick = async () => {
  const f = await window.vibe.pickFolder();
  if (f) { S.settings.folder = f; $('#sFolder').textContent = f; refresh(); }
};
$('#sOpen').onclick = () => window.vibe.openFolder();

document.querySelectorAll('#settings [data-s]').forEach(el => el.oninput = async () => {
  if (el.type === 'range') rp(el);
  S.settings = await window.vibe.setSettings({ [el.dataset.s]: el.type === 'checkbox' ? el.checked : +el.value });
  applySettings();
});

$('select[data-k="font"]').innerHTML = FONTS.map(([n, v]) => `<option value="${esc(v)}">${esc(n)}</option>`).join('');
document.querySelectorAll('#settings [data-k]').forEach(el => el.oninput = () => {
  const k = el.dataset.k;
  look[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
  if (['bg', 'panel', 'text', 'a1', 'a2'].includes(k)) { look.preset = ''; renderPresets(); }
  if (el.type === 'range') rp(el);
  saveLook(); applyLook();
});
$('#presets').onclick = e => {
  const n = e.target.closest('[data-pre]')?.dataset.pre;
  if (n) { look = { ...look, ...PRESETS[n], preset: n }; saveLook(); applyLook(); fillLook(); }
};
$('#resetLook').onclick = () => { look = { ...DEF }; saveLook(); applyLook(); fillLook(); };

// ---------- start ----------
window.vibe.onLibraryChanged(refresh);
(async () => {
  S.settings = await window.vibe.getSettings();
  applySettings();
  renderSide();
  renderLyrics();
  await refresh();
  window.dispatchEvent(new Event('vibe-ready'));
})();
