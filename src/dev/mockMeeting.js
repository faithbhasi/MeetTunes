import express from 'express';

/**
 * A tiny fake meeting site for tests/demos (enable with ALLOW_MOCK_MEETING=1):
 *   /dev/mock-meeting?room=abc&lobby=2     pre-join screen, optional lobby delay, chat panel, mic level meter
 *   POST /dev/mock/chat {room, who, text}  act as another participant
 */
const rooms = new Map();
const room = (id) => {
  if (!rooms.has(id)) rooms.set(id, { seq: 0, msgs: [] });
  return rooms.get(id);
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Mock Meeting</title>
<style>body{font:15px system-ui;margin:0;background:#1b1b1f;color:#eee}main{padding:24px;max-width:720px;margin:auto}
input,button{font:inherit;padding:8px 12px;margin:4px 0}#chat{border:1px solid #444;padding:8px;margin-top:12px}
#msgs{height:260px;overflow:auto}.msg{padding:2px 0;white-space:pre-wrap}.who{font-weight:600;margin-right:6px}.ts{opacity:.5;font-size:12px;margin-left:6px}</style></head>
<body><main>
<section id="prejoin"><h2>Mock Meeting</h2><label>Your name <input id="name" placeholder="Your name"></label><br><button id="join">Join now</button></section>
<section id="lobby" hidden>Please wait, the host will let you in soon...</section>
<section id="meeting" hidden>
  <p>In meeting <b id="room"></b> as <b id="me"></b> &middot; mic level: <span id="mic-level">0</span> peak: <span id="mic-peak">0</span> &middot; track: <span id="mic-info"></span></p>
  <button id="open-chat">Chat</button> <button id="leave" aria-label="Leave call">Leave</button>
  <div id="chat" hidden><div id="msgs"></div><textarea id="chat-input" rows="2" placeholder="Type a message" style="width:70%"></textarea><button id="chat-send">Send</button></div>
</section>
<section id="ended" hidden>You left the meeting.</section>
<script>
const q = new URLSearchParams(location.search); const roomId = q.get('room') || 'default'; const lobby = +q.get('lobby') || 0;
const $ = (s) => document.querySelector(s); let me = '', poll = null, last = 0;
$('#join').onclick = async () => {
  me = $('#name').value.trim(); if (!me) return;
  $('#prejoin').hidden = true;
  if (lobby) { $('#lobby').hidden = false; await new Promise(r => setTimeout(r, lobby * 1000)); $('#lobby').hidden = true; }
  $('#meeting').hidden = false; $('#room').textContent = roomId; $('#me').textContent = me;
  try {
    // Same call a real meeting client makes. The init script in MeetTunes strips AEC/NS/AGC from it.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    const t = stream.getAudioTracks()[0]; const s = t.getSettings();
    $('#mic-info').textContent = (t.label || 'mic') + ' aec=' + s.echoCancellation + ' ns=' + s.noiseSuppression + ' agc=' + s.autoGainControl;
    const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize); let peak = 0;
    setInterval(() => { an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v));
      $('#mic-level').textContent = m.toFixed(3); if (m > peak) { peak = m; $('#mic-peak').textContent = peak.toFixed(3); } }, 100);
  } catch (e) { $('#mic-info').textContent = 'mic error: ' + e.message; }
  poll = setInterval(load, 300); load();
};
$('#open-chat').onclick = () => { $('#chat').hidden = !$('#chat').hidden; };
$('#leave').onclick = () => { clearInterval(poll); $('#meeting').hidden = true; $('#ended').hidden = false; };
async function load() {
  const r = await (await fetch('/dev/mock/chat?room=' + roomId + '&since=' + last)).json();
  for (const m of r.msgs) { last = Math.max(last, m.id);
    const d = document.createElement('div'); d.className = 'msg'; d.dataset.id = m.id;
    d.innerHTML = '<span class="who"></span><span class="body"></span><span class="ts"></span>';
    d.querySelector('.who').textContent = m.who; d.querySelector('.body').textContent = m.text;
    d.querySelector('.ts').textContent = new Date(m.t).toLocaleTimeString(); $('#msgs').appendChild(d); }
  $('#msgs').scrollTop = 1e9;
}
async function send() { const t = $('#chat-input').value; if (!t.trim()) return; $('#chat-input').value = '';
  await fetch('/dev/mock/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomId, who: me, text: t }) }); }
$('#chat-send').onclick = send;
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
</script></main></body></html>`;

export function mockMeetingRouter() {
  const r = express.Router();
  r.get('/mock-meeting', (req, res) => res.type('html').send(PAGE));
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
