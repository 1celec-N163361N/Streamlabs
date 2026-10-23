// محرّك الوقت + تطبيع أحداث Streamlabs

export const DEFAULTS = {
  startMin: 60,     // وقت البداية بالدقائق
  maxHours: 24,     // السقف الأعلى
  perSub: 300,      // ثواني لكل سبسكريب
  perGift: 300,     // ثواني لكل جفت سب
  perBits: 100,     // ثواني لكل 100 بتس
  perDonation: 60,  // ثواني لكل وحدة عملة
  perFollow: 60,    // ثواني لكل متابعة (تيك توك وغيرها)
  perShare: 30,     // ثواني لكل مشاركة
  perLike: 0,       // ثواني لكل لايك
  perDiamond: 1,    // ثواني لكل ماسة (هدايا تيك توك)
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

/** يعرض المبلغ مع عملته — Streamlabs أحيانًا ما يرسل formatted_amount */
const CUR_SYMBOL = {
  USD: '$', SAR: 'ريال', AED: 'درهم', KWD: 'دينار', QAR: 'ريال', BHD: 'دينار',
  OMR: 'ريال', EGP: 'ج.م', JOD: 'دينار', EUR: '€', GBP: '£', TRY: '₺',
};

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/**
 * يقرأ أي صيغة مبلغ بشكل صحيح:
 * "1,000.00" · "$1,234.56" · "100.00 SAR" · "١٠٠" · "1.234,56" · "100,5" · 100
 * parseFloat المباشر يقرأ "1,000.00" كـ 1 — وهذا كان يخسّرنا ٩٩٪ من المبلغ.
 */
export function parseAmount(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : 0;
  if (raw == null) return 0;

  let s = String(raw).trim();
  if (!s) return 0;

  // أرقام عربية وفارسية → لاتينية
  s = s.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  s = s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));

  // نُبقي الأرقام والفواصل فقط
  s = s.replace(/[^\d.,-]/g, '');
  if (!s) return 0;

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    // الأخير هو العشري، والآخر فاصل آلاف
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    const parts = s.split(',');
    // "1,234" آلاف · "12,50" عشري
    const last = parts[parts.length - 1];
    if (parts.length === 2 && last.length === 3 && parts[0].length > 0 && parts[0].length <= 3) {
      s = parts.join('');
    } else if (parts.length > 2) {
      s = parts.join('');
    } else {
      s = parts.join('.');
    }
  } else if (hasDot) {
    // "1.234.567" آلاف أوروبية
    if (s.split('.').length > 2) s = s.replace(/\./g, '');
  }

  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

/** يعرض المبلغ مع عملته — ويضمن أن المعروض = المحسوب */
export function money(amount, currency, formatted) {
  const n = parseAmount(amount);
  const f = formatted ? String(formatted).trim() : '';
  const fn = f ? parseAmount(f) : NaN;

  // نستخدم الصيغة الجاهزة فقط إذا كانت تطابق الرقم الحقيقي
  if (f && /\d/.test(f) && isFinite(fn) && Math.abs(fn - n) < 0.011) return f;

  // غير كذا نبني العرض من الرقم نفسه — عشان ما يقول ٦٠ وهو ١٠٠
  if (n !== 0) {
    const code = String(currency || '').toUpperCase();
    const sym = CUR_SYMBOL[code] || code;
    const num = Number.isInteger(n) ? String(n) : n.toFixed(2);
    return sym ? `${num} ${sym}` : num;
  }

  return f || '0';
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
  // تيك توك يرسل أحيانًا النوع مسبوقًا بـ tiktok_ — نوحّده
  const rawType = String(payload.type || '').toLowerCase();
  const type = rawType.startsWith('tiktok_') ? rawType.slice(7) : rawType;
  const isTikTok = platform === 'tiktok' || rawType.startsWith('tiktok_');

  list.forEach((m, i) => {
    if (!m) return;
    const id =
      m._id ||
      m.id ||
      m.event_id ||
      `${payload.event_id || ''}-${type}-${m.name || ''}-${m.amount || ''}-${i}`;

    let kind = 'other';
    let seconds = 0;
    let detail = '';
    let amountLabel = '';

    if (type === 'subscription' || type === 'subscribe' || type === 'member') {
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
      const bits = parseAmount(m.amount) || 0;
      kind = 'bits';
      seconds = Math.round((bits / 100) * st.perBits);
      amountLabel = `${bits.toLocaleString('en-US')} بتس`;
      detail = amountLabel;
    } else if (type === 'donation') {
      const amt = parseAmount(m.amount) || 0;
      const rule = (st.donationRules || []).find((r) => Math.abs(Number(r.amount) - amt) < 0.01);
      kind = 'donation';
      seconds = rule ? Number(rule.seconds) : Math.round(amt * st.perDonation);
      amountLabel = money(amt, m.currency, m.formatted_amount);
      detail = `${amountLabel} دونيشن${rule ? ' · قاعدة مخصصة' : ''}`;
    } else if (type === 'superchat') {
      const amt = (parseAmount(m.amount) || 0) / 1e6;
      const rule = (st.donationRules || []).find((r) => Math.abs(Number(r.amount) - amt) < 0.01);
      kind = 'superchat';
      seconds = rule ? Number(rule.seconds) : Math.round(amt * st.perDonation);
      amountLabel = money(amt, m.currency, m.displayString);
      detail = `${amountLabel} سوبر شات${rule ? ' · قاعدة مخصصة' : ''}`;
    } else if (type === 'gift') {
      // هدايا تيك توك: الماسات × عدد التكرار
      const diamonds = parseAmount(
        m.diamond_count ?? m.diamonds ?? m.diamondCount ?? m.diamond ?? 0
      );
      const repeat = parseAmount(m.repeat_count ?? m.repeatCount ?? 1) || 1;
      const total = diamonds * repeat;
      const amt = parseAmount(m.amount) || 0;
      const rule = (st.donationRules || []).find((r) => Math.abs(Number(r.amount) - amt) < 0.01);

      kind = 'gift';
      if (rule) seconds = Number(rule.seconds);
      else if (total > 0) seconds = Math.round(total * (st.perDiamond || 0));
      else if (amt > 0) seconds = Math.round(amt * st.perDonation);
      else seconds = st.perGift;

      const giftName = m.gift_name || m.giftName || m.gift_type || '';
      amountLabel = total > 0 ? `${total} ماسة` : money(amt, m.currency, m.formatted_amount);
      detail = [
        giftName || 'هدية',
        repeat > 1 ? `×${repeat}` : '',
        amountLabel,
      ].filter(Boolean).join(' · ');
      if (rule) detail += ' · قاعدة مخصصة';
    } else if (type === 'follow') {
      kind = 'follow';
      seconds = Number(st.perFollow) || 0;
      detail = 'متابعة جديدة';
    } else if (type === 'share') {
      kind = 'share';
      seconds = Number(st.perShare) || 0;
      detail = 'مشاركة للبث';
    } else if (type === 'like') {
      const n = Number(m.like_count ?? m.likeCount ?? m.count ?? 1) || 1;
      kind = 'like';
      seconds = Math.round(n * (Number(st.perLike) || 0));
      amountLabel = `${n.toLocaleString('en-US')} لايك`;
      detail = amountLabel;
    } else if (type === 'raid') {
      kind = 'raid';
      detail = `ريد ${m.raiders || ''}`.trim();
    } else {
      detail = isTikTok ? `${type} (تيك توك)` : type;
    }

    out.push({
      id: String(id),
      platform,
      kind,
      name: m.name || m.from || m.nickname || m.user || 'داعم',
      detail,
      amountLabel,
      seconds,
      amount: parseAmount(m.amount) || 0,
      currency: m.currency || '',
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
