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

const state = {
  token: saved.token || '',
  room: saved.room || makeRoom(),
  settings: { ...DEFAULTS, ...(saved.settings || {}) },
  timer: new Timer(saved.timer || {}),
  events: Array.isArray(saved.events) ? saved.events : [],
  seen: new Set(Array.isArray(saved.seen) ? saved.seen : []),
  stats: saved.stats || { subs: 0, bits: 0, don: 0, min: 0 },
  conn: 'idle',
  demo: false,
  demoHit: 0,
};

if (!state.timer.base) state.timer.reset(state.settings.startMin * 60);

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
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const payload = {
      token: state.token,
      room: state.room,
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
    };
    try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); } catch (_) {}
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
    settings: { alert: state.settings.alert, maxHours: state.settings.maxHours },
    stats: state.stats,
    events: state.events.slice(0, 12),
    lastEvent: state.events[0] || null,
    updatedAt: Date.now(),
  };
}

function syncServer() {
  fetch(`/api/state?room=${encodeURIComponent(state.room)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: publicState() }),
  }).catch(() => {});
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
}

/* ─────────────── تطبيق الأحداث ─────────────── */
function applyEvent(ev) {
  if (!ev || state.seen.has(ev.id)) return;
  state.seen.add(ev.id);

  const cap = state.settings.maxHours * 3600;
  const added = state.timer.add(ev.seconds, cap);
  ev.seconds = added;

  if (ev.kind === 'sub' || ev.kind === 'resub' || ev.kind === 'gift') state.stats.subs += 1;
  if (ev.kind === 'bits') state.stats.bits += Math.round(ev.amount || 0);
  if (ev.kind === 'donation' || ev.kind === 'superchat') state.stats.don += 1;
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
  normalize(payload, state.settings).forEach(applyEvent);
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
    state.stats = { subs: 0, bits: 0, don: 0, min: 0 };
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

  // الإعدادات
  const map = [
    ['#setStart', 'startMin', 1],
    ['#setMax', 'maxHours', 1],
    ['#setSub', 'perSub', 0],
    ['#setGift', 'perGift', 0],
    ['#setBits', 'perBits', 0],
    ['#setDon', 'perDonation', 0],
  ];
  map.forEach(([sel, key, min]) => {
    const el = $(sel);
    el?.addEventListener('change', () => {
      const v = Math.max(min, Number(el.value) || 0);
      el.value = v;
      state.settings[key] = v;
      if (key === 'startMin' && !state.timer.running && state.timer.added === 0) {
        state.timer.reset(v * 60);
      }
      renderTimer();
      persist();
      toast('تم حفظ الإعدادات', 'ok');
    });
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
  set('#setSub', s.perSub);
  set('#setGift', s.perGift);
  set('#setBits', s.perBits);
  set('#setDon', s.perDonation);
  set('#setToken', '');
  $('#swSound')?.classList.toggle('on', s.sound);
  $('#swAlert')?.classList.toggle('on', s.alert);
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

/* ─────────────── التشغيل ─────────────── */
function boot() {
  bind();
  updateUrls();
  const rc = $('#roomCode');
  if (rc) rc.textContent = state.room;

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
}

boot();
