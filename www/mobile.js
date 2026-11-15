// Vibe voor Android: bediening voor een telefoonscherm.
(() => {
  const bar = $('#bar');
  const App = window.Capacitor.registerPlugin('App');
  const openFull = () => { if (S.i >= 0) bar.classList.add('open'); };
  const closeFull = () => bar.classList.remove('open');

  // kleine speler openklappen naar een groot scherm
  bar.addEventListener('click', e => {
    if (!bar.classList.contains('open') && !e.target.closest('button, input')) openFull();
  });
  $('#collapse').onclick = closeFull;
  $('#lyrBtn').addEventListener('click', closeFull);

  // knoppen onderin
  $('#tabbar').addEventListener('click', e => {
    const v = e.target.closest('[data-view]');
    if (!v) return;
    S.view = v.dataset.view;
    setLyr(false);
    closeFull();
    renderSide();
    renderList();
  });

  // instellingen en toegang
  async function updateAccess() {
    try {
      const a = await NA.accessStatus();
      $('#aMedia').textContent = 'Muziek lezen: ' + (a.media ? 'aan' : 'uit');
      $('#aFiles').textContent = 'Alle bestanden (voor .lrc- en .srt-ondertitels): ' + (a.files ? 'aan' : 'uit');
    } catch {}
  }
  $('#tabSettings').onclick = async () => { await $('#settingsBtn').onclick(); updateAccess(); };
  $('#aAsk').onclick = async () => { await NA.access(); updateAccess(); refresh(true); };
  $('#aFiles2').onclick = () => NA.requestFiles();
  $('#aRefresh').onclick = () => refresh(true);
  $('#sAll').onclick = () => {
    NA.useAll();
    S.settings.folder = 'Alle muziek op je telefoon';
    $('#sFolder').textContent = S.settings.folder;
    refresh(true);
  };
  App.addListener('appStateChange', s => { if (s.isActive && $('#settings').open) updateAccess(); });

  // terugknop van Android
  App.addListener('backButton', () => {
    const dlg = [...document.querySelectorAll('dialog')].find(d => d.open);
    if (dlg) return dlg.close();
    if (!$('#menu').hidden) { $('#menu').hidden = true; return; }
    if (bar.classList.contains('open')) return closeFull();
    if (S.lyrOn) return setLyr(false);
    if (S.q) { S.q = ''; $('#q').value = ''; renderList(); return; }
    if (S.view !== 'library') {
      S.view = S.view.startsWith('pl:') ? 'pls' : 'library';
      renderSide();
      renderList();
      return;
    }
    App.minimizeApp();
  });

  // de service springt zelf naar het volgende nummer, ook met een vergrendeld scherm
  window.addEventListener('native-track', e => {
    const i = e.detail;
    if (i !== S.i && S.queue[i]) { S.i = i; showTrack(S.queue[i]); }
  });

  // app opnieuw geopend terwijl de muziek doorspeelde
  window.addEventListener('vibe-ready', async () => {
    try {
      const st = await NA.restore();
      if (!st) return;
      const list = st.paths.map(p => S.by.get(p)).filter(Boolean);
      if (list.length !== st.paths.length || st.index >= list.length) return;
      S.queue = list;
      S.i = st.index;
      showTrack(list[st.index]);
    } catch {}
  });
})();
