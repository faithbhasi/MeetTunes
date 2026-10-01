import express from 'express';

/**
 * A tiny fake meeting site for tests/demos (enable with ALLOW_MOCK_MEETING=1).
 *   /dev/mock-meeting?room=abc&<scenario flags>
 *   POST /dev/mock/chat {room, who, text}   act as another participant
 *
 * Scenario flags (all optional):
 *   lobby=S    wait S seconds in a lobby       deny=S     ...then the host denies entry
 *   end=S      host ends the meeting S s after join       kick=S     bot is removed S s after join
 *   frame=1    chat lives in an iframe         muted=1    host starts the bot muted (shows an Unmute button)
 *   closechat=S  chat panel closes itself every S s        legacy=1   chat markup uses unfamiliar class names
 *   popup=1    window.open() on join           dialog=1   alert() on join
 *   steps=1    realistic pre-join: interstitial ("Continue in browser") -> cookie banner overlay -> name field,
 *              Join disabled until a name is typed, camera on / mic off toggles the bot must flip
 *   relobby=S  host moves the bot back to the lobby S s after join, readmits it 3 s later
 */
const rooms = new Map();
const room = (id) => {
  if (!rooms.has(id)) rooms.set(id, { seq: 0, msgs: [] });
  return rooms.get(id);
};

const CHAT_JS = `
const q = new URLSearchParams(location.search); const roomId = q.get('room') || 'default'; const legacy = q.get('legacy') === '1';
let last = 0; const $ = (s) => document.querySelector(s);
function render(m) {
  const d = document.createElement('div');
  if (legacy) { d.className = 'x-row'; d.innerHTML = '<b class="x-n"></b> <i class="x-t"></i>'; d.querySelector('.x-n').textContent = m.who; d.querySelector('.x-t').textContent = m.text; }
  else { d.className = 'msg'; d.dataset.id = m.id; d.innerHTML = '<span class="who"></span><span class="body"></span><span class="ts"></span>';
    d.querySelector('.who').textContent = m.who; d.querySelector('.body').textContent = m.text; d.querySelector('.ts').textContent = new Date(m.t).toLocaleTimeString(); }
  $('#msgs').appendChild(d);
}
async function load() { const r = await (await fetch('/dev/mock/chat?room=' + roomId + '&since=' + last)).json();
  for (const m of r.msgs) { last = Math.max(last, m.id); render(m); } $('#msgs').scrollTop = 1e9; }
async function send(me) { const t = $('#chat-input').value; if (!t.trim()) return; $('#chat-input').value = '';
  await fetch('/dev/mock/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomId, who: me, text: t }) }); }
`;

const CHAT_HTML = `<div id="msgs" style="height:260px;overflow:auto"></div><textarea id="chat-input" rows="2" placeholder="Type a message" style="width:70%"></textarea><button id="chat-send">Send</button>`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Mock Meeting</title>
<style>body{font:15px system-ui;margin:0;background:#1b1b1f;color:#eee}main{padding:24px;max-width:720px;margin:auto}
input,button,textarea{font:inherit;padding:8px 12px;margin:4px 0}#chat{border:1px solid #444;padding:8px;margin-top:12px}
.msg,.x-row{padding:2px 0;white-space:pre-wrap}.who,.x-n{font-weight:600;margin-right:6px}.ts{opacity:.5;font-size:12px;margin-left:6px}</style></head>
<body><main>
<section id="interstitial" hidden><h2>Open the app?</h2><button id="continue">Continue on this browser</button></section>
<div id="cookie" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9;padding:40px"><button id="cookie-ok">Accept cookies</button></div>
<section id="prejoin"><h2>Mock Meeting</h2><label>Your name <input id="name" placeholder="Your name"></label><br>
  <button id="cam" data-on="true" hidden>Camera on</button> <button id="mic" data-on="false" hidden>Mic off</button><br>
  <button id="join">Join now</button></section>
<section id="lobby" hidden>Please wait, the host will let you in soon...</section>
<section id="meeting" hidden>
  <p>In meeting <b id="room"></b> as <b id="me"></b> &middot; mic level: <span id="mic-level">0</span> peak: <span id="mic-peak">0</span> &middot; track: <span id="mic-info"></span> <span id="mute-state"></span></p>
  <button id="unmute" hidden>Unmute</button>
  <button id="open-chat">Chat</button> <button id="leave" aria-label="Leave call">Leave</button>
  <div id="chat" hidden></div>
</section>
<section id="ended" hidden><span id="ended-text">You left the meeting.</span></section>
<script>
${CHAT_JS}
let me = '', poll = null;
const num = (k) => +q.get(k) || 0;
window.__cam = true; window.__mic = false;
if (q.get('steps')) {
  $('#prejoin').hidden = true; $('#interstitial').hidden = false; $('#cookie').hidden = false;
  $('#join').disabled = true; $('#cam').hidden = false; $('#mic').hidden = false;
  $('#cookie-ok').onclick = () => { $('#cookie').hidden = true; };
  $('#continue').onclick = () => { $('#interstitial').hidden = true; $('#prejoin').hidden = false; };
  $('#name').addEventListener('input', () => { $('#join').disabled = !$('#name').value.trim(); });
  $('#cam').onclick = () => { const on = $('#cam').dataset.on !== 'true'; $('#cam').dataset.on = on; $('#cam').textContent = on ? 'Camera on' : 'Camera off'; window.__cam = on; };
  $('#mic').onclick = () => { const on = $('#mic').dataset.on !== 'true'; $('#mic').dataset.on = on; $('#mic').textContent = on ? 'Mic on' : 'Mic off'; window.__mic = on; };
}
const end = (text) => { clearInterval(poll); $('#meeting').hidden = true; $('#lobby').hidden = true; $('#ended').hidden = false; $('#ended-text').textContent = text; };
$('#join').onclick = async () => {
  me = $('#name').value.trim(); if (!me) return;
  $('#prejoin').hidden = true;
  if (num('lobby')) { $('#lobby').hidden = false; await new Promise(r => setTimeout(r, num('lobby') * 1000)); $('#lobby').hidden = true;
    if (num('deny')) return end('The host denied your request to join.'); }
  $('#meeting').hidden = false; $('#room').textContent = roomId; $('#me').textContent = me;
  if (q.get('popup')) window.open('about:blank', '_blank');
  if (q.get('dialog')) alert('Welcome to the meeting');
  if (q.get('muted')) { $('#unmute').hidden = false; $('#mute-state').textContent = 'MUTED'; window.__muted = true; }
  if (num('end')) setTimeout(() => end('The meeting has ended.'), num('end') * 1000);
  if (num('kick')) setTimeout(() => end('You were removed from the meeting.'), num('kick') * 1000);
  if (num('relobby')) setTimeout(async () => { $('#meeting').hidden = true; $('#lobby').hidden = false; await new Promise(r => setTimeout(r, 3000)); $('#lobby').hidden = true; $('#meeting').hidden = false; }, num('relobby') * 1000);
  if (num('closechat')) setInterval(() => { $('#chat').hidden = true; }, num('closechat') * 1000);
  if (q.get('frame')) { $('#chat').innerHTML = '<iframe id="chatframe" style="width:100%;height:340px;border:0" src="/dev/mock-chat-frame?room=' + roomId + '&me=' + encodeURIComponent(me) + '&legacy=' + (legacy ? 1 : 0) + '"></iframe>'; }
  else { $('#chat').innerHTML = ${JSON.stringify(CHAT_HTML)}; $('#chat-send').onclick = () => send(me);
    $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(me); } }); poll = setInterval(load, 300); load(); }
  try {
    // Same call a real meeting client makes. MeetTunes' init script strips AEC/NS/AGC from it.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    const t = stream.getAudioTracks()[0]; const s = t.getSettings();
    $('#mic-info').textContent = (t.label || 'mic') + ' aec=' + s.echoCancellation + ' ns=' + s.noiseSuppression + ' agc=' + s.autoGainControl;
    const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize); let peak = 0;
    setInterval(() => { an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v));
      $('#mic-level').textContent = m.toFixed(3); if (m > peak) { peak = m; $('#mic-peak').textContent = peak.toFixed(3); } }, 100);
  } catch (e) { $('#mic-info').textContent = 'mic error: ' + e.message; }
};
$('#unmute').onclick = () => { $('#unmute').hidden = true; $('#mute-state').textContent = 'live'; window.__muted = false; };
$('#open-chat').onclick = () => { $('#chat').hidden = !$('#chat').hidden; };
$('#leave').onclick = () => end('You left the meeting.');
</script></main></body></html>`;

const FRAME = `<!doctype html><html><body style="font:15px system-ui">${CHAT_HTML}<script>${CHAT_JS}
const me = q.get('me'); $('#chat-send').onclick = () => send(me);
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(me); } }); setInterval(load, 300); load();
</script></body></html>`;

export function mockMeetingRouter() {
  const r = express.Router();
  r.get('/mock-meeting', (req, res) => res.type('html').send(PAGE));
  r.get('/mock-chat-frame', (req, res) => res.type('html').send(FRAME));
  r.get('/mock/chat', (req, res) => {
    const since = +req.query.since || 0;
    res.json({ msgs: room(String(req.query.room || 'default')).msgs.filter((m) => m.id > since) });
  });
  r.post('/mock/chat', express.json(), (req, res) => {
    const rm = room(String(req.body.room || 'default'));
    const msg = { id: ++rm.seq, who: String(req.body.who || 'someone'), text: String(req.body.text || ''), t: Date.now() };
    rm.msgs.push(msg);
    res.json(msg);
  });
  r.get('/mock/messages', (req, res) => res.json(room(String(req.query.room || 'default')).msgs));
  return r;
}
