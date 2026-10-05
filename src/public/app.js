// MeetTunes web UI - plain ES modules, no build step.
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

let S = { player: null, session: null, settings: {}, chat: [] };
let received = performance.now();
let dragging = false;

// ---- API helpers ------------------------------------------------------------------------------
function toast(msg, err = false) {
  const t = el('div', { className: 'toast' + (err ? ' err' : ''), textContent: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
async function api(path, body, { method } = {}) {
  try {
    const r = await fetch('/api' + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}
const act = (path, body = {}) => api(path, body).catch(() => {});

// ---- websocket --------------------------------------------------------------------------------
let ws, liveOn = false;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => liveOn && ws.send(JSON.stringify({ type: 'live', on: true }));
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'hello':
        S = { ...S, ...m };
        renderAll();
        break;
      case 'player':
        S.player = m.player; received = performance.now();
        renderPlayer(); renderQueue();
        break;
      case 'tick':
        if (S.player) { Object.assign(S.player, { status: m.status, position: m.position, duration: m.duration ?? S.player.duration, level: m.level }); received = performance.now(); renderPlayer(); }
        break;
      case 'session':
        S.session = m.session;
        if (m.audio) S.audio = m.audio;
        renderSession();
        break;
      case 'settings':
        S.settings = m.settings;
        renderSettingsFields();
        break;
      case 'chat':
        S.chat.push(m.entry);
        addChat(m.entry);
        break;
      case 'frame':
        $('#liveImg').src = 'data:image/jpeg;base64,' + m.data;
        $('#liveEmpty').hidden = true; $('#liveImg').hidden = false;
        break;
    }
  };
}

// ---- rendering --------------------------------------------------------------------------------
const STATUS_TEXT = { idle: 'Not in a meeting', starting: 'Starting browser…', joining: 'Joining…', lobby: 'In lobby - waiting for host', joined: 'In meeting', leaving: 'Leaving…', error: 'Join failed' };

function renderSession() {
  const s = S.session; if (!s) return;
  const aw = $('#audioWarn');
  aw.hidden = !S.audio || S.audio.ok !== false;
  aw.textContent = S.audio?.error ? 'Audio problem: ' + S.audio.error : '';
  const pill = $('#statusPill');
  pill.className = 'pill ' + s.state;
  $('#statusText').textContent = STATUS_TEXT[s.state] || s.state;
  const chip = $('#platformChip');
  chip.hidden = !s.platformLabel || s.state === 'idle';
  chip.textContent = s.platformLabel || '';
  const busy = ['starting', 'joining', 'lobby', 'joined', 'leaving'].includes(s.state);
  $('#btnJoin').hidden = busy; $('#btnLeave').hidden = !busy;
  $('#btnLeave').textContent = s.state === 'joined' ? 'Leave meeting' : 'Cancel';
  $('#meetingUrl').disabled = busy; $('#displayName').disabled = busy;
  const note = $('#meetingNote');
  note.className = 'note' + (s.state === 'error' ? ' err' : '');
  note.textContent = s.state === 'error' ? s.error || s.detail
    : s.state === 'joined' ? `Commands work in the meeting chat (try ${S.settings.prefix || '#'}help). ${s.chatArmed ? '' : 'Chat not detected - open Live View.'}`
    : s.detail || '';
  if (s.state === 'lobby') note.textContent += ' Admit the bot from the meeting.';
}

function renderPlayer() {
  const p = S.player; if (!p) return;
  const cur = p.current;
  $('#npLabel').textContent = { idle: 'Nothing playing', loading: 'Loading…', playing: 'Now playing', paused: 'Paused' }[p.status];
  $('#npTitle').textContent = cur ? cur.title : 'Queue something to get started';
  $('#npArtist').textContent = cur ? [cur.artist, cur.requestedBy && `requested by ${cur.requestedBy}`].filter(Boolean).join(' · ') : '';
  const art = $('#art');
  art.style.backgroundImage = cur?.thumbnail ? `url("${cur.thumbnail}")` : '';
  art.firstElementChild.style.display = cur?.thumbnail ? 'none' : '';
  $('#playIcon').setAttribute('href', p.status === 'playing' || p.status === 'loading' ? '#i-pause' : '#i-play');
  $('#btnShuffle').classList.toggle('on', p.shuffle);
  $('#btnLoop').classList.toggle('on', p.loop !== 'off');
  $('#loopIcon').setAttribute('href', p.loop === 'one' ? '#i-repeat-one' : '#i-repeat');
  $('#btnLoop').title = 'Loop: ' + p.loop;
  $('#muteIcon').setAttribute('href', p.muted || p.volume === 0 ? '#i-mute' : '#i-vol');
  $('#btnMute').classList.toggle('on', p.muted);
  const vb = $('#volBar'); vb.max = p.maxVolume;
  if (document.activeElement !== vb) { vb.value = p.volume; setFill(vb); }
  $('#volText').textContent = p.muted ? 'muted' : p.volume + '%';
  $('#tDur').textContent = p.duration ? fmt(p.duration) : cur ? 'live' : '--:--';
  $('#seekBar').disabled = !cur || !p.duration;
  const pe = $('#playerError'); pe.hidden = !p.error; pe.textContent = p.error || '';
  const bars = [...$('#vu').children];
  bars.forEach((b, i) => { const on = p.level * 8 > i; b.style.height = on ? 8 + i * 4 + 'px' : '4px'; b.style.opacity = on ? 1 : .35; });
}

function setFill(r) { r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min)) * 100 + '%'); }

// smooth progress bar between server ticks
function raf() {
  const p = S.player;
  if (p && !dragging) {
    const pos = p.status === 'playing' && p.duration ? Math.min(p.duration, p.position + (performance.now() - received) / 1000) : p.position;
    $('#tCur').textContent = fmt(pos);
    const bar = $('#seekBar');
    bar.value = p.duration ? Math.round((pos / p.duration) * 1000) : 0;
    setFill(bar);
  }
  requestAnimationFrame(raf);
}

function trackRow(t, { index, current, results } = {}) {
  const thumb = el('div', { className: 'thumb' });
  if (t.thumbnail) thumb.style.backgroundImage = `url("${t.thumbnail}")`; else thumb.append(index != null ? String(index + 1) : '♪');
  const info = el('div', { className: 'info' }, el('div', { className: 't', textContent: t.title }), el('div', { className: 'a', textContent: [t.artist, t.requestedBy && `req. ${t.requestedBy}`].filter(Boolean).join(' · ') }));
  const acts = el('div', { className: 'acts' });
  return { row: el('li', { className: 'item' + (current ? ' current' : '') }, thumb, info, el('div', { className: 'd', textContent: t.duration ? fmt(t.duration) : '' }), acts), info, acts };
}
const iconBtn = (icon, title, fn) => {
  const b = el('button', { className: 'icon-btn sm', title, type: 'button' });
  b.innerHTML = `<svg class="ic"><use href="#i-${icon}"/></svg>`;
  b.onclick = (e) => { e.stopPropagation(); fn(); };
  return b;
};

function renderQueue() {
  const p = S.player; if (!p) return;
  const q = $('#queue');
  const sig = JSON.stringify([p.queue.map((t) => t.id), p.index, p.status === 'idle']);
  $('#queueCount').textContent = p.queue.length ? `(${p.queue.length})` : '';
  $('#queueEmpty').hidden = p.queue.length > 0;
  if (q.dataset.sig === sig) return;
  q.dataset.sig = sig;
  q.replaceChildren(...p.queue.map((t, i) => {
    const { row, info, acts } = trackRow(t, { index: i, current: i === p.index && p.status !== 'idle' });
    info.onclick = () => act('/player/play', { index: i });
    acts.append(
      iconBtn('up', 'Move up', () => i > 0 && act('/queue/move', { from: i, to: i - 1 })),
      iconBtn('down', 'Move down', () => i < p.queue.length - 1 && act('/queue/move', { from: i, to: i + 1 })),
      iconBtn('x', 'Remove', () => act('/queue/remove', { index: i })),
    );
    return row;
  }));
}

function addChat(m) {
  const log = $('#chatLog');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  const isCmd = m.kind === 'chat' && S.settings.prefix && m.text.trim().startsWith(S.settings.prefix);
  const d = el('div', { className: `msg ${m.kind}${isCmd ? ' cmd' : ''}` },
    el('span', { className: 'tm', textContent: new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
    m.kind === 'system' ? null : el('span', { className: 'who', textContent: (m.sender || 'someone') + ':' }),
    el('span', { className: 'body', textContent: m.text }));
  log.append(d);
  while (log.children.length > 200) log.firstChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
}

const COMMANDS = [
  ['play <song|url>', 'search & queue'], ['search <q>', 'top 5 results'], ['pick <n>', 'choose a result'], ['local <name>', 'play a local file'],
  ['pause / resume', ''], ['stop', ''], ['next / previous', ''], ['seek 1:30 | +30', ''],
  ['volume 30 | +10', ''], ['mute / unmute', ''], ['queue', 'show queue'], ['nowplaying', ''],
  ['remove <n> · jump <n>', ''], ['shuffle · loop', ''], ['clear', ''], ['leave', 'bot leaves'],
];
function renderCmds() {
  const p = S.settings.prefix || '#';
  $('#cmdList').replaceChildren(...COMMANDS.map(([c, d]) => el('div', {}, el('code', { textContent: p + c }), el('span', { textContent: d }))));
}

async function renderLibrary() {
  try {
    const { files } = await fetch('/api/library').then((r) => r.json());
    $('#libraryEmpty').hidden = files.length > 0;
    $('#library').replaceChildren(...files.map((f) => {
      const { row, info, acts } = trackRow({ title: f.title, artist: f.artist || f.name, duration: f.duration });
      info.onclick = () => act('/library/play', { name: f.name, now: true });
      acts.append(iconBtn('plus', 'Add to queue', () => act('/library/play', { name: f.name })), iconBtn('x', 'Delete file', async () => {
        if (confirm(`Delete ${f.name}?`)) { await api('/library/' + encodeURIComponent(f.name), undefined, { method: 'DELETE' }); renderLibrary(); }
      }));
      return row;
    }));
  } catch { /* ignore */ }
}

function renderSettingsFields() {
  const s = S.settings;
  $('#setPrefix').value = s.prefix || '#';
  $('#setAllow').value = (s.allowlist || []).join(', ');
  $('#setAnnounce').checked = s.announce !== false;
  if (document.activeElement !== $('#displayName') && !S.session?.state?.match(/joined|joining|lobby/)) $('#displayName').value = s.displayName || '';
  if (document.activeElement !== $('#meetingUrl') && !$('#meetingUrl').value) $('#meetingUrl').value = s.lastUrl || '';
  renderCmds();
}

function renderAll() {
  renderSettingsFields(); renderSession(); renderPlayer(); renderQueue();
  $('#chatLog').replaceChildren(); (S.chat || []).forEach(addChat);
  renderLibrary();
}

// ---- events -----------------------------------------------------------------------------------
$('#btnJoin').onclick = async () => {
  const url = $('#meetingUrl').value.trim();
  if (!url) return toast('Paste a meeting link first', true);
  await act('/join', { url, displayName: $('#displayName').value.trim() });
};
$('#btnLeave').onclick = () => act('/leave');
$('#meetingUrl').addEventListener('input', async (e) => {
  const url = e.target.value.trim();
  if (!/^https?:\/\//i.test(url)) return ($('#meetingNote').textContent = '');
  try {
    const r = await fetch('/api/detect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }).then((x) => x.json());
    if (r.label) $('#meetingNote').textContent = `Detected: ${r.label}${r.experimental ? ' (experimental)' : ''}`;
  } catch { /* ignore */ }
});

$('#btnPlay').onclick = () => act('/player/toggle');
$('#btnNext').onclick = () => act('/player/next');
$('#btnPrev').onclick = () => act('/player/previous');
$('#btnStop').onclick = () => act('/player/stop');
$('#btnShuffle').onclick = () => act('/player/shuffle');
$('#btnLoop').onclick = () => act('/player/loop');
$('#btnMute').onclick = () => act('/player/mute');
$('#btnVolUp').onclick = () => act('/player/volume', { delta: 5 });
$('#btnVolDown').onclick = () => act('/player/volume', { delta: -5 });
// Dragging fires ~60 input events a second: send at most one request per 80 ms (always ending on the final value).
let volTimer = null, volPending = null;
$('#volBar').addEventListener('input', (e) => {
  setFill(e.target); $('#volText').textContent = e.target.value + '%';
  volPending = +e.target.value;
  if (volTimer) return;
  volTimer = setTimeout(() => { volTimer = null; const v = volPending; volPending = null; if (v !== null) act('/player/volume', { volume: v }); }, 80);
});
$('#btnClear').onclick = () => act('/queue/clear', { keepCurrent: false });

const seek = $('#seekBar');
seek.addEventListener('input', () => { dragging = true; setFill(seek); if (S.player?.duration) $('#tCur').textContent = fmt((seek.value / 1000) * S.player.duration); });
seek.addEventListener('change', async () => {
  if (S.player?.duration) await act('/player/seek', { position: (seek.value / 1000) * S.player.duration });
  received = performance.now(); dragging = false;
});

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (/INPUT|TEXTAREA|BUTTON|SELECT/.test(tag) && document.activeElement.type !== 'range') return; // let focused controls keep Space/Enter
  if (e.code === 'Space') { e.preventDefault(); act('/player/toggle'); }
  else if (e.key === 'ArrowRight' && e.shiftKey) act('/player/next');
  else if (e.key === 'ArrowLeft' && e.shiftKey) act('/player/previous');
});

// search
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim(); if (!q) return;
  if (/^https?:\/\//i.test(q)) return quickAdd(true);
  const note = $('#searchNote'); note.textContent = 'Searching…'; $('#btnSearch').disabled = true;
  try {
    const { results } = await api('/search?q=' + encodeURIComponent(q));
    note.textContent = results.length ? '' : 'No results.';
    $('#results').replaceChildren(...results.map((t) => {
      const { row, info, acts } = trackRow(t);
      info.onclick = () => act('/queue/add-track', { track: t, now: true });
      acts.append(iconBtn('play', 'Play now', () => act('/queue/add-track', { track: t, now: true })), iconBtn('plus', 'Add to queue', () => act('/queue/add-track', { track: t }).then(() => toast('Added to queue'))));
      return row;
    }));
  } catch (err) { note.textContent = err.message; } finally { $('#btnSearch').disabled = false; }
});
async function quickAdd(now) {
  const q = $('#searchInput').value.trim(); if (!q) return;
  const note = $('#searchNote'); note.textContent = 'Adding…';
  try { const r = await api('/queue/add', { query: q, now }); note.textContent = r.message || ''; $('#searchInput').value = ''; } catch (err) { note.textContent = err.message; }
}
$('#btnQuick').onclick = () => quickAdd(false);

// chat
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim(); if (!text) return;
  await act('/chat/send', { text }); $('#chatInput').value = '';
});

// library upload
$('#uploadInput').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    try {
      const r = await fetch('/api/library/' + encodeURIComponent(f.name), { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: f });
      if (!r.ok) throw new Error((await r.json()).error);
      toast('Uploaded ' + f.name);
    } catch (err) { toast(`${f.name}: ${err.message}`, true); }
  }
  e.target.value = ''; renderLibrary();
});

// live view
const dlg = $('#liveDlg');
const setLive = (on) => { liveOn = on; ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'live', on })); };
$('#btnLive').onclick = () => { $('#liveEmpty').hidden = !!$('#liveImg').src; $('#liveImg').hidden = !$('#liveImg').src; dlg.showModal(); setLive(true); };
$('#liveClose').onclick = () => dlg.close();
dlg.addEventListener('close', () => setLive(false));
$('#liveImg').addEventListener('click', (e) => {
  const r = e.target.getBoundingClientRect();
  act('/remote', { type: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
});
$('#liveForm').addEventListener('submit', async (e) => { e.preventDefault(); const t = $('#liveText').value; if (t) { await act('/remote', { type: 'type', text: t }); $('#liveText').value = ''; } });
dlg.querySelectorAll('[data-key]').forEach((b) => (b.onclick = () => act('/remote', { type: 'key', key: b.dataset.key })));
dlg.querySelectorAll('[data-scroll]').forEach((b) => (b.onclick = () => act('/remote', { type: 'scroll', dy: +b.dataset.scroll })));

// settings
$('#btnSettings').onclick = () => $('#settingsDlg').showModal();
$('#settingsClose').onclick = () => $('#settingsDlg').close();
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await act('/settings', { prefix: $('#setPrefix').value, allowlist: $('#setAllow').value.split(',').map((s) => s.trim()).filter(Boolean), announce: $('#setAnnounce').checked });
  $('#settingsDlg').close(); toast('Settings saved');
});

connect();
requestAnimationFrame(raf);
