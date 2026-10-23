import { StreamlabsSocket } from './socket.js';
import { DEFAULTS, normalize, fmt, human, Timer } from './engine.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const LS_KEY = 'saba.v1';

/* ─────────────── الحالة ─────────────── */
function makeRoom() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function loadStore() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) { return {}; }
}

const saved = loadStore();
const savedSettings = saved.settings || {};

const state = {
  token: saved.token || '',
  room: saved.room || makeRoom(),
  pin: saved.pin || '',
  settings: {
    ...DEFAULTS,
    ...savedSettings,
    overlay: { ...DEFAULTS.overlay, ...(savedSettings.overlay || {}) },
    donationRules: Array.isArray(savedSettings.donationRules) ? savedSettings.donationRules : [],
  },
  timer: new Timer(saved.timer || {}),
  events: Array.isArray(saved.events) ? saved.events : [],
  seen: new Set(Array.isArray(saved.seen) ? saved.seen : []),
  stats: { subs: 0, bits: 0, don: 0, min: 0, money: 0, ...(saved.stats || {}) },
  conn: 'idle',
  demo: false,
  lastSeen: Number(saved.lastSeen) || 0,
  resumeGap: 0,
  raw: [],       // آخر الحزم الخام من Streamlabs (للجلسة الحالية فقط)
  rawCount: 0,   // كم حزمة وصلت
  evCount: 0,    // كم حدث تحوّل لوقت
};

if (!state.timer.base) state.timer.reset(state.settings.startMin * 60);

// ── استئناف من حيث توقف: لو التبويب انسدّ وهو شغّال، ما نحسب وقت الغياب
const endedAt = Number((() => { try { return localStorage.getItem('saba.ended') || 0; } catch (_) { return 0; } })());
if (state.timer.running && endedAt) {
  const gap = Date.now() - endedAt;
  if (gap > 3000) {
    state.timer.endsAt += gap;
    state.resumeGap = gap;
  }
  try { localStorage.removeItem('saba.ended'); } catch (_) {}
}

const sock = new StreamlabsSocket();

/* ─────────────── أدوات ─────────────── */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 2800);
}

async function copy(text, okMsg = 'تم النسخ') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, 'ok');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(okMsg, 'ok'); } catch (e) { toast('تعذّر النسخ', 'err'); }
    ta.remove();
  }
}

let audioCtx = null;
function blip(seconds) {
  if (!state.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(seconds > 240 ? 620 : 480, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.42);
  } catch (_) {}
}

/* ─────────────── المزامنة مع السيرفر ─────────────── */
let saveTimer = null;

function snapshot() {
  state.lastSeen = Date.now();
  return {
    token: state.token,
    room: state.room,
    pin: state.pin,
    settings: state.settings,
    timer: {
      running: state.timer.running,
      endsAt: state.timer.endsAt,
      remainingMs: state.timer.remainingMs,
      added: state.timer.added,
      base: state.timer.base,
    },
    events: state.events.slice(0, 20),
    seen: Array.from(state.seen).slice(-400),
    stats: state.stats,
    lastSeen: state.lastSeen,
  };
}

function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot())); } catch (_) {}
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveLocal();
    syncServer();
  }, 200);
}

function publicState() {
  return {
    room: state.room,
    running: state.timer.running,
    endsAt: state.timer.endsAt,
    remainingMs: state.timer.remainingMs,
    added: state.timer.added,
    base: state.timer.base,
    settings: {
      alert: state.settings.alert,
      maxHours: state.settings.maxHours,
      overlay: state.settings.overlay,
    },
    stats: state.stats,
    events: state.events.slice(0, 12),
    lastEvent: state.events[0] || null,
    updatedAt: Date.now(),
  };
}

function syncServer() {
  return fetch(`/api/state?room=${encodeURIComponent(state.room)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: state.pin, state: publicState() }),
  }).catch(() => null);
}

/* ─────────────── واجهة العدّاد ─────────────── */
let lastTimerText = '';
let lastStateKey = '';

function renderTimer() {
  const t = state.timer;
  const remaining = t.remaining;
  const text = fmt(remaining);
  const big = $('#bigTimer');
  if (big && text !== lastTimerText) {
    big.textContent = text;
    lastTimerText = text;
  }
  if (big) {
    big.classList.toggle('warn', remaining > 0 && remaining < 300);
    big.classList.toggle('dead', remaining <= 0);
  }

  const cap = state.settings.maxHours * 3600;
  const pct = cap ? Math.min(100, (remaining / cap) * 100) : 0;
  const fill = $('#progressFill');
  if (fill) fill.style.width = pct.toFixed(2) + '%';

  const key = `${t.running}|${Math.floor(remaining)}`;
  if (key !== lastStateKey) {
    lastStateKey = key;
    const badge = $('#stateBadge');
    if (badge) {
      badge.textContent = t.running ? 'شغّال' : remaining > 0 ? 'متوقف' : 'انتهى';
      badge.className = 'badge ' + (t.running ? 'on' : remaining > 0 ? 'paused' : '');
    }
    const btn = $('#btnToggle');
    if (btn) btn.textContent = t.running ? 'إيقاف مؤقت' : remaining > 0 ? 'استمرار' : 'ابدأ العدّاد';
  }

  const addedEl = $('#addedTotal');
  if (addedEl) addedEl.textContent = human(t.added);
  const goalEl = $('#goalText');
  if (goalEl) goalEl.textContent = `السقف ${state.settings.maxHours} ساعة`;
}

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

function feedNode(ev) {
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
  nm.textContent = ev.name;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${ev.detail}${ev.platform && ev.platform !== 'streamlabs' ? ' · ' + ev.platform : ''}`;
  meta.append(nm, sub);

  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = ev.seconds > 0 ? '+' + fmt(ev.seconds).replace(/^00:/, '') : '—';
  if (ev.capped) {
    plus.classList.add('is-capped');
    plus.title = `المطلوب ${human(ev.requested)} — الحد الأعلى سمح بـ ${human(ev.seconds)}`;
    const badge = document.createElement('i');
    badge.className = 'cap-badge';
    badge.textContent = 'سقف';
    plus.append(badge);
  }

  li.append(av, meta, plus);
  return li;
}

function renderFeed() {
  const feed = $('#feed');
  if (!feed) return;
  feed.innerHTML = '';
  if (!state.events.length) {
    const li = document.createElement('li');
    li.className = 'feed-empty';
    li.textContent = 'لا يوجد دعم بعد — جرّب زر «+5د» أو شغّل الوضع التجريبي';
    feed.appendChild(li);
  } else {
    state.events.slice(0, 40).forEach((ev) => feed.appendChild(feedNode(ev)));
  }
  const c = $('#feedCount');
  if (c) c.textContent = String(state.events.length);
}

function renderStats() {
  const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  set('#statSubs', state.stats.subs.toLocaleString('en-US'));
  set('#statBits', state.stats.bits.toLocaleString('en-US'));
  set('#statDon', state.stats.don.toLocaleString('en-US'));
  set('#statMin', Math.round(state.stats.min).toLocaleString('en-US'));
  const mny = Number(state.stats.money) || 0;
  set('#statMoney', mny > 0 ? (Number.isInteger(mny) ? mny : mny.toFixed(2)) : '٠');
}

/* ─────────────── تطبيق الأحداث ─────────────── */
function applyEvent(ev) {
  if (!ev || state.seen.has(ev.id)) return;
  state.seen.add(ev.id);

  const cap = state.settings.maxHours * 3600;
  const requested = Math.max(0, Number(ev.seconds) || 0);
  const added = state.timer.add(requested, cap);

  // نحفظ المطلوب والمضاف — عشان ما نقص الوقت بصمت
  ev.requested = requested;
  ev.seconds = added;
  ev.capped = requested > added + 0.5;
  ev.capSeconds = cap;

  if (ev.capped) {
    ev.detail += ` · وصل للسقف (${human(cap)})`;
    toast(
      `الحد الأعلى منع ${human(requested - added)} — ارفع «الحد الأعلى» في الإعدادات`,
      'err'
    );
  }

  if (ev.kind === 'sub' || ev.kind === 'resub' || ev.kind === 'gift') state.stats.subs += 1;
  if (ev.kind === 'bits') state.stats.bits += Math.round(ev.amount || 0);
  if (ev.kind === 'donation' || ev.kind === 'superchat') {
    state.stats.don += 1;
    state.stats.money = (Number(state.stats.money) || 0) + (Number(ev.amount) || 0);
  }
  state.stats.min += added / 60;

  state.events.unshift(ev);
  if (state.events.length > 60) state.events.length = 60;

  renderFeed();
  renderStats();
  renderTimer();
  if (added > 0) blip(added);
  persist();
}

function handlePayload(payload) {
  const events = normalize(payload, state.settings);
  events.forEach(applyEvent);

  state.evCount += events.length;
  logRaw(
    `${payload.for || 'streamlabs'} · ${payload.type}`,
    JSON.stringify(payload).slice(0, 900),
    events.length ? 'ok' : 'warn'
  );
  renderIncoming();
}

/* ─────────────── مراقب الحزم الخام ─────────────── */
function logRaw(label, body, kind = '') {
  state.rawCount += 1;
  state.raw.unshift({ label, body, kind, ts: Date.now() });
  if (state.raw.length > 40) state.raw.length = 40;
}

function renderIncoming() {
  const box = $('#rawLog');
  const count = $('#rawCount');
  const evc = $('#evCount');
  if (count) count.textContent = String(state.rawCount);
  if (evc) evc.textContent = String(state.evCount);
  if (!box) return;

  if (!state.raw.length) {
    box.innerHTML =
      '<div class="raw-empty">ما وصلت أي حزمة بعد. إذا كنت لايف الآن وأرسلت هدية/متابعة وما ظهر شي هنا — يعني Streamlabs ما يرسل أحداث هالمنصة عبر Socket API.</div>';
    return;
  }

  box.innerHTML = state.raw
    .map((r) => {
      const t = new Date(r.ts).toLocaleTimeString('en-GB', { hour12: false });
      const tag = r.kind === 'ok' ? '<i class="raw-tag ok">محسوب</i>' : r.kind === 'warn' ? '<i class="raw-tag warn">غير معروف</i>' : '';
      return `<div class="raw-row"><div class="raw-h"><span class="raw-t">${t}</span><b>${esc(r.label)}</b>${tag}</div><code>${esc(r.body)}</code></div>`;
    })
    .join('');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** إضافة يدوية — الحل المضمون لأي منصة */
function manualAdd(seconds, label) {
  const cap = state.settings.maxHours * 3600;
  const added = state.timer.add(seconds, cap);
  if (added > 0) {
    state.stats.min += added / 60;
    const ev = {
      id: 'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      platform: 'manual',
      kind: 'manual',
      name: label || 'إضافة يدوية',
      detail: label || 'إضافة يدوية',
      seconds: added,
      amount: 0,
      ts: Date.now(),
    };
    state.events.unshift(ev);
    if (state.events.length > 60) state.events.length = 60;
    renderFeed();
    renderStats();
    renderTimer();
    blip(added);
    persist();
  }
  if (added < seconds) toast('وصلت للسقف الأعلى للوقت', 'err');
  return added;
}

/** حدث تجريبي يمر بنفس المسار الحقيقي */
function fireTest(kind) {
  const name = DEMO_NAMES[Math.floor(Math.random() * DEMO_NAMES.length)];
  const payloads = {
    follow: { type: 'follow', for: 'tiktok_account', message: [{ name, _id: 'test-' + Date.now() }] },
    gift: {
      type: 'gift',
      for: 'tiktok_account',
      message: [{ name, gift_name: 'Rose', diamond_count: 1, repeat_count: 5, _id: 'test-' + Date.now() }],
    },
    donation: { type: 'donation', for: 'streamlabs', message: [{ name, amount: '5', formatted_amount: '5 ريال', _id: 'test-' + Date.now() }] },
  };
  handlePayload(payloads[kind] || payloads.follow);
  toast('وصل حدث تجريبي — شوف الأوفرلاي', 'ok');
}

/* ─────────────── الاتصال ─────────────── */
function setConn(kind, text) {
  state.conn = kind;
  const pill = $('#connPill');
  const label = $('#connText');
  if (pill) pill.className = 'conn-pill ' + (kind === 'live' ? 'live' : kind === 'demo' ? 'demo' : kind === 'err' ? 'err' : '');
  if (label) label.textContent = text;
}

function enterStudio() {
  $('#studio').classList.add('on');
  document.body.style.overflow = 'hidden';
  renderTimer();
  renderFeed();
  renderStats();
  const rc = $('#roomCode');
  if (rc) rc.textContent = state.room;
  updateUrls();
}

function exitStudio() {
  stopDemo();
  $('#studio').classList.remove('on');
  document.body.style.overflow = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (state.conn === 'live') {
    toast('العدّاد يستمر بالعمل — الأحداث تُسجّل في الخلفية');
  }
}

async function connect(token, { demo = false } = {}) {
  const err = $('#formError');
  if (err) { err.classList.remove('on'); err.textContent = ''; }

  if (demo) {
    state.token = state.token || '';
    enterStudio();
    startDemo();
    return;
  }

  if (!token || token.length < 20) {
    if (err) { err.textContent = 'التوكن قصير جدًا — تأكد أنك نسخت الـ Socket API Token كامل.'; err.classList.add('on'); }
    return;
  }

  const btn = $('#btnConnect');
  if (btn) { btn.disabled = true; btn.textContent = 'جارٍ الاتصال…'; }
  setConn('idle', 'جارٍ الاتصال…');

  try {
    await sock.connect(token);
    state.token = token;
    stopDemo();
    clearTimeout(reconnectTimer);
    reconnectAttempts = 0;
    setConn('live', 'متصل بـ Streamlabs');
    enterStudio();
    persist();
    toast('تم الربط بنجاح — العدّاد جاهز', 'ok');
  } catch (e) {
    setConn('err', 'فشل الاتصال');
    if (err) { err.textContent = e.message || 'تعذّر الاتصال'; err.classList.add('on'); }
    toast(e.message || 'تعذّر الاتصال', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'ربط وتشغيل العدّاد'; }
  }
}

sock.on('event', handlePayload);

// كل حزمة تصل من Streamlabs تُسجَّل — حتى لو ما فهمناها
sock.on('raw', (data) => {
  if (data === '2' || data === '3' || data === '40' || data.startsWith('0')) return; // نبضات/فتح
  logRaw('حزمة خام', data.slice(0, 600), '');
  renderIncoming();
});

let reconnectAttempts = 0;
let reconnectTimer = null;

function scheduleReconnect() {
  if (state.demo || !state.token) return;
  if (reconnectAttempts >= 8) {
    setConn('err', 'انقطع الاتصال');
    toast('تعذّر إعادة الاتصال — افتح الإعدادات واضغط «إعادة الاتصال»', 'err');
    return;
  }
  clearTimeout(reconnectTimer);
  const delay = Math.min(15000, 1500 * Math.pow(1.7, reconnectAttempts));
  reconnectAttempts += 1;
  setConn('idle', `إعادة الاتصال… (${reconnectAttempts})`);
  reconnectTimer = setTimeout(async () => {
    try {
      await sock.connect(state.token);
      reconnectAttempts = 0;
      setConn('live', 'متصل بـ Streamlabs');
      toast('رجع الاتصال بـ Streamlabs', 'ok');
    } catch (_) {
      scheduleReconnect();
    }
  }, delay);
}

sock.on('close', () => {
  if (state.demo) return;
  if (state.conn === 'live' || state.conn === 'idle') {
    scheduleReconnect();
  }
});

/* ─────────────── الوضع التجريبي ─────────────── */
const DEMO_NAMES = ['نورة', 'خالد', 'سارة', 'عبدالله', 'ريم', 'فهد', 'لمى', 'ماجد', 'هند', 'طلال', 'جواهر', 'يوسف'];
let demoTimer = null;

function startDemo() {
  if (state.demo) return;
  state.demo = true;
  setConn('demo', 'وضع تجريبي');
  const btn = $('#btnDemoToggle');
  if (btn) btn.textContent = 'إيقاف الوضع التجريبي';
  if (!state.timer.running) state.timer.start();

  const tick = () => {
    const roll = Math.random();
    const name = DEMO_NAMES[Math.floor(Math.random() * DEMO_NAMES.length)];
    const id = 'demo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    let ev;

    if (roll < 0.34) {
      ev = { id, platform: 'twitch', kind: 'sub', name, detail: 'سبسكريب جديد', seconds: state.settings.perSub, amount: 0, ts: Date.now() };
    } else if (roll < 0.5) {
      const n = [2, 3, 5, 10][Math.floor(Math.random() * 4)];
      ev = { id, platform: 'twitch', kind: 'gift', name, detail: `جفت سب × ${n}`, seconds: state.settings.perGift * n, amount: 0, ts: Date.now() };
    } else if (roll < 0.72) {
      const bits = [100, 200, 500, 1000][Math.floor(Math.random() * 4)];
      ev = { id, platform: 'twitch', kind: 'bits', name, detail: `${bits} بتس`, seconds: Math.round((bits / 100) * state.settings.perBits), amount: bits, ts: Date.now() };
    } else if (roll < 0.92) {
      const amt = [5, 10, 25, 50][Math.floor(Math.random() * 4)];
      ev = { id, platform: 'streamlabs', kind: 'donation', name, detail: `${amt} ريال دونيشن`, seconds: amt * state.settings.perDonation, amount: amt, ts: Date.now() };
    } else {
      ev = { id, platform: 'twitch', kind: 'follow', name, detail: 'متابعة جديدة', seconds: 0, amount: 0, ts: Date.now() };
    }

    applyEvent(ev);
    demoTimer = setTimeout(tick, 4200 + Math.random() * 5200);
  };

  demoTimer = setTimeout(tick, 1800);
}

function stopDemo() {
  state.demo = false;
  clearTimeout(demoTimer);
  demoTimer = null;
  const btn = $('#btnDemoToggle');
  if (btn) btn.textContent = 'تشغيل الوضع التجريبي';
}

/* ─────────────── شاشة القفل ─────────────── */
let lockMode = 'enter';

function shakeLock() {
  const lock = $('#lock');
  if (!lock) return;
  lock.classList.remove('shake');
  void lock.offsetWidth;
  lock.classList.add('shake');
}

function showLock(mode = 'enter') {
  lockMode = mode;
  const lock = $('#lock');
  if (!lock) return;
  const title = $('#lockTitle');
  const desc = $('#lockDesc');
  const btn = $('#btnUnlock');
  const alt = $('#lockAlt');
  const err = $('#lockErr');
  const input = $('#lockPin');

  err.textContent = '';
  input.value = '';

  if (mode === 'create') {
    title.textContent = 'أنشئ رمز الدخول';
    desc.textContent = '٤ أرقام على الأقل. احفظه — تحتاجه لو فتحت الاستوديو من جهاز ثاني.';
    btn.textContent = 'حفظ وبدء';
    alt.style.display = 'none';
  } else {
    title.textContent = 'هذه النسخة محمية';
    desc.textContent = 'أدخل رمز الدخول عشان تفتح الاستوديو وتتحكم بالعدّاد.';
    btn.textContent = 'دخول';
    alt.style.display = '';
  }

  lock.classList.add('on');
  setTimeout(() => input.focus(), 180);
}

function hideLock() {
  $('#lock')?.classList.remove('on');
}

async function submitLock() {
  const input = $('#lockPin');
  const err = $('#lockErr');
  const pin = (input.value || '').trim();

  if (!/^\d{4,6}$/.test(pin)) {
    err.textContent = 'الرمز لازم يكون من ٤ إلى ٦ أرقام';
    shakeLock();
    return;
  }

  if (lockMode === 'create') {
    state.pin = pin;
    saveLocal();
    hideLock();
    syncServer();
    toast('تم إنشاء رمز الدخول', 'ok');
    return;
  }

  const prev = state.pin;
  state.pin = pin;
  const res = await syncServer();
  if (res && res.status === 403) {
    state.pin = prev;
    err.textContent = 'الرمز غير صحيح';
    shakeLock();
    return;
  }
  saveLocal();
  hideLock();
}

/* ─────────────── قواعد الدونيشن ─────────────── */
/* ─────────────── المعدلات والوحدات ─────────────── */
const RATES = [
  { key: 'perDonation', input: '#setDon', unit: '#unitDon' },
  { key: 'perFollow', input: '#setFollow', unit: '#unitFollow' },
  { key: 'perShare', input: '#setShare', unit: '#unitShare' },
  { key: 'perDiamond', input: '#setDiamond', unit: '#unitDiamond' },
  { key: 'perLike', input: '#setLike', unit: '#unitLike' },
  { key: 'perSub', input: '#setSub', unit: '#unitSub' },
  { key: 'perGift', input: '#setGift', unit: '#unitGift' },
  { key: 'perBits', input: '#setBits', unit: '#unitBits' },
];

/** ثواني → رقم بالوحدة المختارة */
function toUnit(sec, u) {
  const n = (Number(sec) || 0) / (u || 1);
  return String(Math.round(n * 100) / 100);
}

/** اختيار وحدة مناسبة تلقائيًا */
function autoUnit(sec) {
  const s = Number(sec) || 0;
  if (s >= 3600 && s % 3600 === 0) return 3600;
  if (s >= 60 && s % 60 === 0) return 60;
  return 1;
}

function curLabel() {
  return state.settings.currencyLabel || 'دولار';
}

function curCode() {
  return (
    { دولار: 'USD', ريال: 'SAR', درهم: 'AED', دينار: 'KWD' }[curLabel()] || 'SAR'
  );
}

function renderRateExample() {
  const box = $('#rateExample');
  if (!box) return;
  const rate = Number(state.settings.perDonation) || 0;
  const cur = curLabel();

  const sample = (v) => {
    const sec = Math.round(v * rate);
    return `<span class="rh-s"><i>${v}</i> ${cur}</span><span class="rh-arrow">=</span><b>${sec > 0 ? '+' + human(sec) : 'ما يزيد'}</b>`;
  };

  box.innerHTML = [sample(5), '<span class="rh-sep">·</span>', sample(20)].join('');
}

/** تحذير واضح إذا كان السقف يمنع الزيادة */
function updateCapHint() {
  const el = $('#capHint');
  if (!el) return;
  const cap = state.settings.maxHours * 3600;
  const start = state.settings.startMin * 60;

  if (cap <= start) {
    el.className = 'hint warn';
    el.textContent = `الحد الأعلى (${human(cap)}) أصغر من وقت البداية (${human(start)}) — العدّاد ما يقدر يزيد إطلاقًا. ارفعه.`;
  } else if (cap < start * 3) {
    el.className = 'hint warn';
    el.textContent = `الحد الأعلى ${human(cap)} فقط — أي دعم يوصلك لهذا الرقم يتوقف عنده والباقي يُلغى.`;
  } else {
    el.className = 'hint';
    el.textContent = `أي دعم يوصل الوقت إلى ${human(cap)} يتوقف عنده.`;
  }
}

/** حاسبة تحقق: تمرّر المبلغ بنفس مسار الأحداث الحقيقي */
function runCalc() {
  const out = $('#calcOut');
  if (!out) return;
  const amt = Number($('#calcAmt')?.value);
  if (!(amt > 0)) {
    out.innerHTML = '<div class="co-empty">اكتب مبلغًا عشان تشوف كم يعطي بالضبط.</div>';
    return;
  }

  const ev = normalize(
    {
      type: 'donation',
      for: 'streamlabs',
      message: [{ name: 'اختبار', amount: String(amt), currency: curCode(), _id: 'calc' }],
    },
    state.settings
  )[0];

  const cap = state.settings.maxHours * 3600;
  const current = state.timer.remaining;
  const room = Math.max(0, cap - current);
  const actual = Math.min(ev.seconds, room);
  const rule = (state.settings.donationRules || []).find(
    (r) => Math.abs(Number(r.amount) - amt) < 0.01
  );

  out.innerHTML = `
    <div class="co-line"><span>المبلغ المقروء</span><b>${ev.amountLabel}</b></div>
    <div class="co-line"><span>يُحسب بـ</span><b>${rule ? 'قاعدة مخصصة' : 'المعدل العام'}</b></div>
    <div class="co-line"><span>الوقت المستحق</span><b>+${human(ev.seconds)}</b></div>
    <div class="co-line${actual < ev.seconds ? ' bad' : ''}"><span>سيُضاف فعليًا</span><b>+${human(actual)}</b></div>
    ${
      actual < ev.seconds
        ? `<div class="co-warn">السقف ${human(cap)} يمنع ${human(ev.seconds - actual)} — الوقت الحالي ${human(current)}</div>`
        : ''
    }
  `;
}

/** يقرأ رسالة Streamlabs ملصوقة ويعرض كيف فهمها التطبيق */
function parsePasted() {
  const out = $('#pasteOut');
  if (!out) return;
  const raw = ($('#pasteBox')?.value || '').trim();

  if (!raw) {
    out.innerHTML = '<div class="co-empty">الصق الرسالة كاملة (JSON) من Streamlabs.</div>';
    return;
  }

  let j;
  try {
    j = JSON.parse(raw);
  } catch (_) {
    out.innerHTML = '<div class="co-warn">مو JSON صحيح — انسخ الرسالة كاملة من المرقاب فوق.</div>';
    return;
  }

  // رسالة alertPlaying تحمل الحدث داخل message
  let p = j;
  if (j && j.type === 'alertPlaying' && j.message && typeof j.message === 'object') {
    p = { type: j.message.type || 'donation', for: 'streamlabs', message: [j.message] };
  }

  if (!p || !p.type) {
    out.innerHTML = '<div class="co-warn">الرسالة ما فيها نوع الحدث (type).</div>';
    return;
  }

  const evs = normalize(p, state.settings);
  if (!evs.length) {
    out.innerHTML = '<div class="co-warn">ما قدرنا نستخرج حدثًا من هذه الرسالة.</div>';
    return;
  }

  const ev = evs[0];
  out.innerHTML = `
    <div class="co-line"><span>النوع</span><b>${esc(ev.platform)} · ${esc(p.type)}</b></div>
    <div class="co-line"><span>الداعم</span><b>${esc(ev.name)}</b></div>
    <div class="co-line"><span>المبلغ المقروء</span><b>${esc(ev.amountLabel || '—')}</b></div>
    <div class="co-line"><span>الوقت المستحق</span><b>+${human(ev.seconds)}</b></div>
    ${evs.length > 1 ? `<div class="co-line"><span>رسائل داخل الحزمة</span><b>${evs.length}</b></div>` : ''}
  `;
}

function bindRates() {
  // وقت البداية والحد الأعلى
  $('#setStart')?.addEventListener('change', (e) => {
    const v = Math.max(1, Number(e.target.value) || 1);
    e.target.value = v;
    state.settings.startMin = v;
    if (!state.timer.running && state.timer.added === 0) state.timer.reset(v * 60);
    updateCapHint();
    renderTimer();
    persist();
  });
  $('#setMax')?.addEventListener('change', (e) => {
    const v = Math.max(1, Number(e.target.value) || 1);
    e.target.value = v;
    state.settings.maxHours = v;
    updateCapHint();
    persist();
  });

  RATES.forEach(({ key, input, unit }) => {
    const el = $(input);
    const ue = $(unit);
    if (!el) return;

    const commit = () => {
      const u = Number(ue?.value) || 1;
      const v = Math.max(0, Number(el.value) || 0);
      state.settings[key] = Math.round(v * u);
      if (ue) state.settings.units = { ...(state.settings.units || {}), [key]: u };
      el.closest('.rate-row')?.classList.toggle('is-zero', state.settings[key] === 0);
      renderRateExample();
      renderTimer();
      persist();
    };

    el.addEventListener('change', commit);
    el.addEventListener('input', () => { if (key === 'perDonation') renderRateExample(); });

    ue?.addEventListener('change', () => {
      // نحوّل الرقم المكتوب حاليًا للوحدة الجديدة بدون ما نضيّع قيمة المستخدم
      const prevUnit = Number((state.settings.units || {})[key]) || autoUnit(Number(state.settings[key]) || 0);
      const typed = Number(el.value) || 0;
      const u = Number(ue.value) || 1;
      const secs = Math.round(typed * prevUnit);

      state.settings[key] = secs;
      state.settings.units = { ...(state.settings.units || {}), [key]: u };
      el.value = toUnit(secs, u);
      el.closest('.rate-row')?.classList.toggle('is-zero', secs === 0);
      renderRateExample();
      persist();
    });
  });
}

function renderRules() {
  const list = $('#rulesList');
  if (!list) return;
  list.innerHTML = '';
  const rules = [...state.settings.donationRules].sort((a, b) => a.amount - b.amount);

  rules.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'rule-row';

    const amt = document.createElement('span');
    amt.className = 'r-amt';
    amt.textContent = `${r.amount} ${curLabel()}`;

    const eq = document.createElement('span');
    eq.textContent = '=';
    eq.style.color = '#4f4f63';

    const sec = document.createElement('span');
    sec.className = 'r-sec';
    sec.textContent = human(r.seconds);

    // تحذير لو القاعدة تعطي أقل من المعدل العام — مصدر شائع للأرقام "الغلط"
    const general = Math.round(Number(r.amount) * (Number(state.settings.perDonation) || 0));
    if (general > 0 && r.seconds < general - 0.5) {
      const warn = document.createElement('i');
      warn.className = 'r-warn';
      warn.textContent = 'أقل من العام';
      warn.title = `المعدل العام يعطي ${human(general)} لهذا المبلغ`;
      sec.append(warn);
    }

    const del = document.createElement('button');
    del.className = 'r-del';
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'حذف';
    del.addEventListener('click', () => {
      state.settings.donationRules = state.settings.donationRules.filter((x) => x !== r);
      renderRules();
      persist();
    });

    row.append(amt, eq, sec, del);
    list.appendChild(row);
  });
}

function addRule() {
  const a = Number($('#ruleAmount').value);
  const raw = Number($('#ruleSeconds').value);
  const unit = Number($('#ruleUnit')?.value) || 60;
  const s = Math.round(raw * unit);

  if (!(a > 0) || !(raw > 0)) return toast('أدخل مبلغًا ووقتًا صحيحين', 'err');

  const exists = state.settings.donationRules.find((r) => Math.abs(r.amount - a) < 0.01);
  if (exists) exists.seconds = s;
  else state.settings.donationRules.push({ amount: a, seconds: s });

  $('#ruleAmount').value = '';
  $('#ruleSeconds').value = '';
  renderRules();
  persist();
  toast(`${a} ${curLabel()} = +${human(s)}`, 'ok');
}

/* ─────────────── شكل الأوفرلاي ─────────────── */
function hexToRgba(hex, alpha) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(139, 92, 246, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function updatePreview() {
  const o = state.settings.overlay;
  const card = $('#ovPvCard');
  if (!card) return;

  card.style.setProperty('--pv-accent', o.accent);
  card.style.setProperty('--pv-accent-soft', hexToRgba(o.accent, 0.5));
  card.style.setProperty('--pv-opacity', String(o.opacity));
  card.style.setProperty('--pv-radius', `${o.radius}px`);
  card.style.setProperty('--pv-scale', String(0.72 * o.scale));

  const live = $('#ovPvLive');
  if (live) live.style.display = o.live === false ? 'none' : '';
  const lab = $('#ovPvLab');
  if (lab) lab.style.display = o.label === false ? 'none' : '';

  const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  set('#valScale', Math.round(o.scale * 100) + '%');
  set('#valOpacity', Math.round(o.opacity * 100) + '%');
  set('#valRadius', String(o.radius));

  $$('#swatches button').forEach((b) => {
    b.classList.toggle('on', String(b.dataset.color).toLowerCase() === String(o.accent).toLowerCase());
  });
}

function applyOverlayInputs() {
  const o = state.settings.overlay;
  const set = (sel, v) => { const el = $(sel); if (el) el.value = v; };
  set('#ovPos', o.pos);
  set('#ovScale', o.scale);
  set('#ovOpacity', o.opacity);
  set('#ovRadius', o.radius);
  $('#swOvLive')?.classList.toggle('on', o.live !== false);
  $('#swOvLabel')?.classList.toggle('on', o.label !== false);
  updatePreview();
}

/* ─────────────── الروابط ─────────────── */
function updateUrls() {
  const base = location.origin;
  const ov = `${base}/overlay?room=${state.room}`;
  const wt = `${base}/watch?room=${state.room}`;
  const a = $('#overlayUrl');
  const b = $('#watchUrl');
  if (a) a.value = ov;
  if (b) b.value = wt;
}

/* ─────────────── ربط الواجهة ─────────────── */
function bind() {
  // تنقل
  const nav = $('#nav');
  const onScroll = () => nav && nav.classList.toggle('stuck', window.scrollY > 12);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  $$('[data-scroll]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const el = $(btn.dataset.scroll);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  $('#navStart')?.addEventListener('click', () => {
    $('#connect')?.scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => $('#tokenInput')?.focus(), 600);
  });

  $('#btnDemoHero')?.addEventListener('click', () => connect('', { demo: true }));
  $('#btnDemo')?.addEventListener('click', () => connect('', { demo: true }));

  // المودال
  const modal = $('#helpModal');
  $('#openHelp')?.addEventListener('click', () => modal.classList.add('on'));
  $('#helpClose')?.addEventListener('click', () => modal.classList.remove('on'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('on'); });

  // اللصق والربط
  $('#btnPaste')?.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) {
        $('#tokenInput').value = t.trim();
        toast('تم لصق التوكن', 'ok');
      } else toast('الحافظة فاضية', 'err');
    } catch (_) {
      toast('المتصفح ما سمح بالقراءة — الصق يدويًا', 'err');
      $('#tokenInput')?.focus();
    }
  });

  $('#tokenInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnConnect')?.click();
  });

  $('#btnConnect')?.addEventListener('click', () => {
    const val = ($('#tokenInput').value || '').trim();
    connect(val);
  });

  // الاستوديو
  $('#btnToggle')?.addEventListener('click', () => {
    if (state.timer.running) {
      state.timer.pause();
      toast('تم الإيقاف المؤقت');
    } else {
      if (state.timer.remaining <= 0) {
        toast('الوقت صفر — أضف وقتًا أولًا', 'err');
        return;
      }
      state.timer.start();
    }
    renderTimer();
    persist();
  });

  $('#btnReset')?.addEventListener('click', () => {
    state.timer.reset(state.settings.startMin * 60);
    state.stats = { subs: 0, bits: 0, don: 0, min: 0, money: 0 };
    state.events = [];
    state.seen.clear();
    renderTimer();
    renderFeed();
    renderStats();
    persist();
    toast('تم التصفير');
  });

  $$('.quick [data-add]').forEach((b) => {
    b.addEventListener('click', () => {
      applyEvent({
        id: 'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        platform: 'manual',
        kind: 'other',
        name: 'إضافة يدوية',
        detail: 'من لوحة التحكم',
        seconds: Number(b.dataset.add),
        amount: 0,
        ts: Date.now(),
      });
    });
  });

  $('#btnCustomAdd')?.addEventListener('click', () => {
    const v = Number($('#customAdd').value);
    if (!v || v <= 0) return toast('أدخل عدد ثواني صحيح', 'err');
    applyEvent({
      id: 'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      platform: 'manual',
      kind: 'other',
      name: 'إضافة يدوية',
      detail: `${v} ثانية`,
      seconds: v,
      amount: 0,
      ts: Date.now(),
    });
    $('#customAdd').value = '';
  });

  // الدرج
  const drawer = $('#drawer');
  $('#btnSettings')?.addEventListener('click', () => {
    fillSettings();
    drawer.classList.add('on');
  });
  $('#drawerClose')?.addEventListener('click', () => drawer.classList.remove('on'));

  $('#btnExit')?.addEventListener('click', exitStudio);

  $('#btnOverlayLink')?.addEventListener('click', () => {
    updateUrls();
    drawer.classList.add('on');
    setTimeout(() => $('#overlayUrl')?.select(), 400);
  });

  $('#btnCopyOverlay')?.addEventListener('click', () => copy($('#overlayUrl').value, 'تم نسخ رابط الأوفرلاي'));
  $('#btnCopyWatch')?.addEventListener('click', () => copy($('#watchUrl').value, 'تم نسخ رابط المشاهدين'));

  // الإعدادات — معدلات بوحدات واضحة
  bindRates();
  $('#donCur')?.addEventListener('change', () => {
    state.settings.currencyLabel = $('#donCur').value;
    renderRateExample();
    renderRules();
    runCalc();
    persist();
  });

  $('#swSound')?.addEventListener('click', (e) => {
    state.settings.sound = !state.settings.sound;
    e.currentTarget.classList.toggle('on', state.settings.sound);
    persist();
  });

  $('#swAlert')?.addEventListener('click', (e) => {
    state.settings.alert = !state.settings.alert;
    e.currentTarget.classList.toggle('on', state.settings.alert);
    persist();
  });

  $('#btnReconnect')?.addEventListener('click', () => {
    const t = ($('#setToken').value || '').trim() || state.token;
    if (!t) return toast('الصق التوكن أولًا', 'err');
    drawer.classList.remove('on');
    connect(t);
  });

  $('#btnDemoToggle')?.addEventListener('click', () => {
    if (state.demo) { stopDemo(); setConn('idle', 'غير متصل'); }
    else startDemo();
  });

  // ── القفل
  $('#btnUnlock')?.addEventListener('click', submitLock);
  $('#lockPin')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLock(); });
  $('#lockPin')?.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
  $('#btnCreatePin')?.addEventListener('click', () => showLock('create'));

  // ── قواعد الدونيشن
  $('#btnAddRule')?.addEventListener('click', addRule);
  $('#ruleAmount')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ruleSeconds')?.focus(); });
  $('#ruleSeconds')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addRule(); });

  // ── شكل الأوفرلاي
  $$('#swatches button').forEach((b) => {
    b.addEventListener('click', () => {
      state.settings.overlay.accent = b.dataset.color;
      updatePreview();
      persist();
    });
  });
  $('#ovPos')?.addEventListener('change', (e) => {
    state.settings.overlay.pos = e.target.value;
    persist();
  });
  const bindRange = (sel, key, fmtVal) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => {
      state.settings.overlay[key] = Number(el.value);
      const out = $(fmtVal);
      if (out) out.textContent = key === 'radius' ? el.value : Math.round(Number(el.value) * 100) + '%';
      updatePreview();
    });
    el.addEventListener('change', () => persist());
  };
  bindRange('#ovScale', 'scale', '#valScale');
  bindRange('#ovOpacity', 'opacity', '#valOpacity');
  bindRange('#ovRadius', 'radius', '#valRadius');

  $('#swOvLive')?.addEventListener('click', (e) => {
    const on = state.settings.overlay.live === false;
    state.settings.overlay.live = on;
    e.currentTarget.classList.toggle('on', on);
    updatePreview();
    persist();
  });
  $('#swOvLabel')?.addEventListener('click', (e) => {
    const on = state.settings.overlay.label === false;
    state.settings.overlay.label = on;
    e.currentTarget.classList.toggle('on', on);
    updatePreview();
    persist();
  });

  // ── الأمان
  $('#btnShowPin')?.addEventListener('click', (e) => {
    const pv = $('#pinView');
    if (!pv) return;
    const shown = pv.dataset.shown === '1';
    pv.value = shown ? '••••' : (pv.dataset.real || '—');
    pv.dataset.shown = shown ? '0' : '1';
    e.currentTarget.textContent = shown ? 'إظهار' : 'إخفاء';
  });

  $('#btnChangePin')?.addEventListener('click', async () => {
    const np = ($('#newPin').value || '').trim();
    if (!/^\d{4,6}$/.test(np)) return toast('الرمز لازم يكون ٤ إلى ٦ أرقام', 'err');
    const res = await fetch(`/api/state?room=${encodeURIComponent(state.room)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: state.pin, newPin: np, state: publicState() }),
    }).catch(() => null);
    if (res && res.status === 403) return toast('الرمز الحالي غير مطابق — أعد فتح الصفحة', 'err');
    state.pin = np;
    $('#newPin').value = '';
    saveLocal();
    fillSettings();
    toast('تم تغيير رمز الدخول', 'ok');
  });

  $('#btnNewRoom')?.addEventListener('click', () => {
    state.room = makeRoom();
    state.pin = String(Math.floor(1000 + Math.random() * 9000));
    state.seen.clear();
    state.events = [];
    state.stats = { subs: 0, bits: 0, don: 0, min: 0 };
    saveLocal();
    syncServer();
    const rc = $('#roomCode');
    if (rc) rc.textContent = state.room;
    fillSettings();
    renderFeed();
    renderStats();
    toast('غرفة جديدة: ' + state.room, 'ok');
  });

  // إضافة يدوية للوقت
  $$('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const secs = Number(btn.dataset.add) * 60;
      const added = manualAdd(secs, 'إضافة يدوية من الاستوديو');
      if (added > 0) toast(`+${human(added)}`, 'ok');
    });
  });

  // أحداث تجريبية
  $$('[data-test]').forEach((btn) => {
    btn.addEventListener('click', () => fireTest(btn.dataset.test));
  });

  $('#btnCalc')?.addEventListener('click', runCalc);
  $('#calcAmt')?.addEventListener('input', runCalc);
  $('#btnParsePaste')?.addEventListener('click', parsePasted);

  $('#btnClearRaw')?.addEventListener('click', () => {
    state.raw = [];
    state.rawCount = 0;
    state.evCount = 0;
    renderIncoming();
    toast('تم تفريغ السجل', 'ok');
  });

  // ظهور تدريجي
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    });
  }, { threshold: 0.12 });
  $$('.reveal').forEach((el) => io.observe(el));

  // حركة بطاقة المعاينة
  animateMock();
}

function fillSettings() {
  const s = state.settings;
  const set = (sel, v) => { const el = $(sel); if (el) el.value = v; };
  set('#setStart', s.startMin);
  set('#setMax', s.maxHours);

  // المعدلات: نعرضها بالوحدة المحفوظة أو نختار وحدة مناسبة
  RATES.forEach(({ key, input, unit }) => {
    const el = $(input);
    const ue = $(unit);
    if (!el) return;
    const secs = Number(s[key]) || 0;
    const u = Number((s.units || {})[key]) || autoUnit(secs);
    if (ue) ue.value = String(u);
    el.value = toUnit(secs, u);
    el.closest('.rate-row')?.classList.toggle('is-zero', secs === 0);
  });

  const dc = $('#donCur');
  if (dc) dc.value = s.currencyLabel || 'دولار';
  renderRateExample();
  updateCapHint();
  runCalc();
  set('#setToken', '');
  $('#swSound')?.classList.toggle('on', s.sound);
  $('#swAlert')?.classList.toggle('on', s.alert);

  const pv = $('#pinView');
  if (pv) {
    pv.value = '••••';
    pv.dataset.real = state.pin || '—';
    pv.dataset.shown = '0';
  }
  const showBtn = $('#btnShowPin');
  if (showBtn) showBtn.textContent = 'إظهار';

  renderRules();
  applyOverlayInputs();
  updateUrls();
}

/* بطاقة المعاينة في الهيرو */
function animateMock() {
  const el = $('#mockTimer');
  const bar = $('#mockBar');
  if (!el) return;
  let left = 2 * 3600 + 14 * 60 + 38;
  setInterval(() => {
    left = left > 0 ? left - 1 : 3 * 3600;
    el.textContent = fmt(left);
    if (bar) bar.style.width = Math.min(96, (left / (6 * 3600)) * 100 + 34) + '%';
  }, 1000);
}

function pauseBeacon() {
  if (!state.pin) return;
  const st = publicState();
  st.running = false;
  st.remainingMs = state.timer.remaining * 1000;
  st.endsAt = 0;
  try {
    const body = new Blob([JSON.stringify({ pin: state.pin, state: st })], { type: 'application/json' });
    navigator.sendBeacon(`/api/state?room=${encodeURIComponent(state.room)}`, body);
  } catch (_) {}
}

/* ─────────────── التشغيل ─────────────── */
function boot() {
  bind();
  updateUrls();
  renderIncoming();
  fillSettings();
  const rc = $('#roomCode');
  if (rc) rc.textContent = state.room;

  // القفل
  if (state.pin) hideLock();
  else showLock('enter');

  if (state.resumeGap > 3000) {
    setTimeout(() => {
      toast(`العدّاد كمّل من حيث توقف — ${human(state.resumeGap / 1000)} كانت موقوفة`, 'ok');
    }, 900);
  }

  // حلقة العرض
  setInterval(() => {
    if (state.timer.running && state.timer.remaining <= 0) {
      state.timer.pause();
      state.timer.remainingMs = 0;
      renderTimer();
      persist();
    } else {
      renderTimer();
    }
  }, 250);

  // مزامنة دورية مع السيرفر (لو الأوفرلاي مفتوح في OBS)
  setInterval(() => {
    if ($('#studio').classList.contains('on')) syncServer();
  }, 8000);

  // لو فيه توكن محفوظ، اعرض زر استئناف سريع
  if (state.token) {
    const btn = $('#btnConnect');
    if (btn) btn.textContent = 'إعادة الربط بالتوكن المحفوظ';
    const input = $('#tokenInput');
    if (input) input.value = state.token;
  }

  // معاينة سريعة: ?demo=1
  if (new URLSearchParams(location.search).get('demo') === '1') {
    setTimeout(() => connect('', { demo: true }), 500);
  }

  // نبضة الحفظ + التعامل مع إغلاق التبويب
  setInterval(saveLocal, 3000);

  window.addEventListener('pagehide', () => {
    saveLocal();
    try { localStorage.setItem('saba.ended', String(Date.now())); } catch (_) {}
    pauseBeacon();
  });

  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      try { localStorage.removeItem('saba.ended'); } catch (_) {}
    }
  });
}

boot();
