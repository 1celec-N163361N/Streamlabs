import { fmt, human } from './engine.js';

const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').trim().toUpperCase();
const isOverlay = document.body.classList.contains('ov');

const $ = (s) => document.querySelector(s);
let st = null;
let lastEvId = null;
let toastT = null;

const AV_COLORS = {
  sub: 'linear-gradient(135deg,#8b5cf6,#6d28d9)',
  resub: 'linear-gradient(135deg,#7c3aed,#4c1d95)',
  gift: 'linear-gradient(135deg,#a78bfa,#7c3aed)',
  bits: 'linear-gradient(135deg,#0891b2,#0e7490)',
  donation: 'linear-gradient(135deg,#db2777,#9d174d)',
  superchat: 'linear-gradient(135deg,#e11d48,#9f1239)',
  follow: 'linear-gradient(135deg,#0d9488,#115e59)',
  raid: 'linear-gradient(135deg,#ca8a04,#a16207)',
  other: 'linear-gradient(135deg,#4b5563,#374151)',
};

function setConn(ok, text) {
  const el = $('#wConn');
  if (!el) return;
  el.className = 'conn-pill ' + (ok ? 'live' : 'err');
  const s = el.querySelector('span:last-child');
  if (s) s.textContent = text;
}

function remaining() {
  if (!st) return 0;
  if (st.running) return Math.max(0, (st.endsAt - Date.now()) / 1000);
  return Math.max(0, (st.remainingMs || 0) / 1000);
}

function renderClock() {
  const txt = st ? fmt(remaining()) : '--:--:--';
  const ov = $('#ovDigits');
  if (ov) ov.textContent = txt;
  const w = $('#watchTimer');
  if (w) w.textContent = txt;

  const cap = (st?.settings?.maxHours || 24) * 3600;
  const pct = st ? Math.min(100, (remaining() / cap) * 100) : 0;
  const bar = $('#watchBar');
  if (bar) bar.style.width = pct.toFixed(2) + '%';
}

function renderStats() {
  if (!st) return;
  const s = st.stats || {};
  const set = (sel, v) => { const el = $(sel); if (el) el.textContent = Number(v || 0).toLocaleString('en-US'); };
  set('#wSubs', s.subs);
  set('#wBits', s.bits);
  set('#wDon', s.don);
  set('#wMin', Math.round(s.min || 0));

  const sub = $('#watchSub');
  if (sub) {
    sub.textContent = st.running ? 'السابثون شغّال الآن — كل دعم يزيد الوقت' : 'العدّاد متوقف مؤقتًا';
  }
  const lab = $('#ovLabel');
  if (lab) lab.textContent = st.running ? 'الوقت المتبقي' : 'متوقف';
}

function renderFeed() {
  const feed = $('#wFeed');
  if (!feed || !st) return;
  const evs = Array.isArray(st.events) ? st.events : [];
  feed.innerHTML = '';
  const cnt = $('#wCount');
  if (cnt) cnt.textContent = String(evs.length);
  if (!evs.length) {
    const li = document.createElement('li');
    li.className = 'feed-empty';
    li.textContent = 'بانتظار أول دعم…';
    feed.appendChild(li);
    return;
  }
  evs.slice(0, 12).forEach((ev) => {
    const li = document.createElement('li');
    li.className = 'feed-item';

    const av = document.createElement('span');
    av.className = 'av';
    av.style.background = AV_COLORS[ev.kind] || AV_COLORS.other;
    av.textContent = (ev.name || '?').trim().charAt(0).toUpperCase();

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = ev.name || 'داعم';
    const sb = document.createElement('div');
    sb.className = 'sub';
    sb.textContent = ev.detail || '';
    meta.append(nm, sb);

    const plus = document.createElement('span');
    plus.className = 'plus';
    plus.textContent = ev.seconds > 0 ? '+' + fmt(ev.seconds).replace(/^00:/, '') : '—';

    li.append(av, meta, plus);
    feed.appendChild(li);
  });
}

function showToast(ev) {
  const el = $('#ovToast');
  if (!el || !ev) return;
  el.textContent = '';
  const name = document.createElement('span');
  name.textContent = `${ev.name} · `;
  const b = document.createElement('b');
  b.textContent = human(ev.seconds);
  const tail = document.createElement('span');
  tail.textContent = ' إضافية';
  el.append(name, b, tail);

  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), 3400);
}

function apply(next) {
  if (!next || next.empty || !next.room) return;
  st = next;

  const card = $('#ovCard');
  if (card) card.classList.add('in');

  renderClock();
  renderStats();
  renderFeed();

  const ev = st.lastEvent;
  if (ev && ev.id !== lastEvId) {
    const first = lastEvId === null;
    lastEvId = ev.id;
    if (!first && st.settings?.alert !== false && ev.seconds > 0) showToast(ev);
  }
}

function boot() {
  if (!room) {
    const lab = $('#ovLabel');
    if (lab) lab.textContent = 'أضف ?room=XXXX';
    return;
  }
  const wr = $('#wRoom');
  if (wr) wr.textContent = room;

  const es = new EventSource(`/api/live?room=${encodeURIComponent(room)}`);
  es.onopen = () => setConn(true, 'متصل');
  es.onerror = () => setConn(false, 'انقطع الاتصال');
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      apply(data);
    } catch (_) {}
  };

  setInterval(renderClock, 250);
}

boot();
