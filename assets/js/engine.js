// محرّك الوقت + تطبيع أحداث Streamlabs

export const DEFAULTS = {
  startMin: 60,     // وقت البداية بالدقائق
  maxHours: 24,     // السقف الأعلى
  perSub: 300,      // ثواني لكل سبسكريب
  perGift: 300,     // ثواني لكل جفت سب
  perBits: 100,     // ثواني لكل 100 بتس
  perDonation: 60,  // ثواني لكل وحدة عملة
  sound: true,
  alert: true,
  donationRules: [], // [{ amount: 5, seconds: 120 }]
  overlay: {
    accent: '#8b5cf6',
    pos: 'bottom-center',
    scale: 1,
    opacity: 0.72,
    radius: 20,
    label: true,
    live: true,
    toast: true,
  },
};

export function fmt(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

export function human(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} ثانية`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} دقيقة`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} ساعة و${rm} دقيقة` : `${h} ساعة`;
}

/** يحوّل رسالة Streamlabs إلى أحداث موحّدة */
export function normalize(payload, st) {
  const out = [];
  if (!payload || !payload.type) return out;
  const list = Array.isArray(payload.message)
    ? payload.message
    : payload.message
      ? [payload.message]
      : [];

  const platform = String(payload.for || 'streamlabs').replace('_account', '');
  const type = payload.type;

  list.forEach((m, i) => {
    if (!m) return;
    const id =
      m._id ||
      m.id ||
      `${payload.event_id || ''}-${type}-${m.name || ''}-${m.amount || ''}-${i}`;

    let kind = 'other';
    let seconds = 0;
    let detail = '';

    if (type === 'subscription') {
      const isGift = m.sub_type === 'subgift' || Boolean(m.gifter);
      const isResub = m.sub_type === 'resub' || Number(m.months) > 1;
      kind = isGift ? 'gift' : isResub ? 'resub' : 'sub';
      seconds = isGift ? st.perGift : st.perSub;
      detail = isGift
        ? m.gifter
          ? `جفت سب من ${m.gifter}`
          : 'جفت سب'
        : isResub
          ? `تجديد ${m.months || 1} شهر`
          : 'سبسكريب جديد';
    } else if (type === 'bits') {
      const bits = parseFloat(m.amount) || 0;
      kind = 'bits';
      seconds = Math.round((bits / 100) * st.perBits);
      detail = `${bits.toLocaleString('en-US')} بتس`;
    } else if (type === 'donation') {
      const amt = parseFloat(m.amount) || 0;
      const rule = (st.donationRules || []).find((r) => Math.abs(Number(r.amount) - amt) < 0.01);
      kind = 'donation';
      seconds = rule ? Number(rule.seconds) : Math.round(amt * st.perDonation);
      detail = `${m.formatted_amount || amt} دونيشن${rule ? ' · قاعدة مخصصة' : ''}`;
    } else if (type === 'superchat') {
      const amt = (parseFloat(m.amount) || 0) / 1e6;
      const rule = (st.donationRules || []).find((r) => Math.abs(Number(r.amount) - amt) < 0.01);
      kind = 'superchat';
      seconds = rule ? Number(rule.seconds) : Math.round(amt * st.perDonation);
      detail = `${m.displayString || amt} سوبر شات${rule ? ' · قاعدة مخصصة' : ''}`;
    } else if (type === 'follow') {
      kind = 'follow';
      detail = 'متابعة جديدة';
    } else if (type === 'raid') {
      kind = 'raid';
      detail = `ريد ${m.raiders || ''}`.trim();
    } else {
      detail = type;
    }

    out.push({
      id: String(id),
      platform,
      kind,
      name: m.name || m.from || 'داعم',
      detail,
      seconds,
      amount: parseFloat(m.amount) || 0,
      ts: Date.now(),
    });
  });

  return out;
}

export class Timer {
  constructor(state = {}) {
    this.running = Boolean(state.running);
    this.endsAt = Number(state.endsAt) || 0;
    this.remainingMs = Number(state.remainingMs) || 0;
    this.added = Number(state.added) || 0;
    this.base = Number(state.base) || 0;
  }

  get remaining() {
    if (this.running) return Math.max(0, (this.endsAt - Date.now()) / 1000);
    return Math.max(0, this.remainingMs / 1000);
  }

  start() {
    if (this.running) return;
    this.endsAt = Date.now() + Math.max(0, this.remainingMs);
    this.running = true;
  }

  pause() {
    if (!this.running) return;
    this.remainingMs = this.remaining;
    this.running = false;
  }

  reset(baseSeconds) {
    this.running = false;
    this.added = 0;
    this.base = baseSeconds;
    this.remainingMs = baseSeconds * 1000;
    this.endsAt = 0;
  }

  /** يضيف ثواني مع مراعاة السقف */
  add(seconds, capSeconds) {
    if (!seconds) return 0;
    const cap = Math.max(0, capSeconds || 0);
    const current = this.remaining;
    const allowed = cap ? Math.min(seconds, Math.max(0, cap - current)) : seconds;
    if (allowed <= 0) return 0;

    if (this.running) this.endsAt += allowed * 1000;
    else this.remainingMs += allowed * 1000;

    this.added += allowed;
    return allowed;
  }
}
