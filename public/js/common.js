// Shared helpers for all pages.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const money = n => '₹' + Number(n || 0).toLocaleString('en-IN');

export function fmtDate(s, opts = {}) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', ...opts });
}
export function fmtRange(a, b) {
  if (!a) return 'Date to be announced';
  if (!b) return fmtDate(a);
  const da = new Date(a), dbb = new Date(b);
  if (da.toDateString() === dbb.toDateString())
    return `${fmtDate(a)} – ${dbb.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}
export const ago = ms => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

export const VENUE_TYPES = { corporate: 'Corporate', public: 'Public place', apartment: 'Apartment', other: 'Other' };

export async function api(url, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error(data?.error || `Request failed (${r.status})`), { status: r.status });
  return data;
}

export function toast(msg, kind = '') {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 5000 : 3000);
}

// My bookings (kept in this browser so vendors can come back to their tickets).
const KEY = 'bms_my_bookings';
export function myBookings() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
export function rememberBooking(b) {
  try {
    const list = myBookings().filter(x => x.id !== b.id);
    list.unshift(b);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
  } catch { /* storage unavailable */ }
}
export function forgetBookings(ids) {
  try {
    const drop = new Set(ids);
    localStorage.setItem(KEY, JSON.stringify(myBookings().filter(x => !drop.has(x.id))));
  } catch { /* storage unavailable */ }
}
// Bookings that no longer hold a stall — hidden from "My bookings".
// A paid booking that was cancelled stays visible so the vendor can follow the refund.
export const GONE = ['expired', 'cancelled'];
export const isGone = b => b.status === 'expired' || (b.status === 'cancelled' && !b.paid_at);

export const STATUS = {
  held: ['Awaiting payment', 'amber'],
  pending: ['Pending approval', 'blue'],
  approved: ['Confirmed', 'green'],
  rejected: ['Rejected', 'red'],
  expired: ['Expired', 'grey'],
  cancelled: ['Cancelled', 'grey'],
};
export const statusBadge = s => `<span class="badge ${STATUS[s]?.[1] || ''}">${esc(STATUS[s]?.[0] || s)}</span>`;

export const STALL_ICON = `<img class="sicon" src="/img/stall-icon-t.png" alt="" aria-hidden="true">`;
export const BRAND_SVG = `<img src="/img/aes-logo-96.png" alt="" width="44" height="44">`;

export const BRAND_TEXT = `<span class="brand-text"><span class="brand-name">AUTO EXPO SUBURBAN EVENTS</span><span class="brand-sub">Since 2009</span></span>`;

// ---- light / dark theme (follows the device until the visitor picks one)
const THEME_KEY = 'bms_theme';
const SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
export function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function wireThemeToggle(btn) {
  if (!btn) return;
  const paint = () => {
    const dark = currentTheme() === 'dark';
    btn.innerHTML = dark ? SUN : MOON;
    btn.title = btn.ariaLabel = dark ? 'Switch to light theme' : 'Switch to dark theme';
  };
  btn.classList.add('theme-btn');
  btn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    paint();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', paint);
  paint();
}

export function header(active = '') {
  const el = document.getElementById('topbar');
  if (!el) return;
  const hero = el.classList.contains('hero-top');
  const brand = hero
    ? `<a class="brand hero-brand" href="/"><img class="hero-logo" src="/img/aes-logo.png" alt="Auto Expo Suburban Events (AES) logo" width="170" height="170">
        <span class="hero-text"><span class="hero-name">AUTO EXPO SUBURBAN EVENTS</span><span class="since">SINCE 2009</span>
        <span class="hero-tag">Chennai's Premier Corporate Event Planner — expertise in automotive events and corporate functions.</span></span></a>`
    : `<a class="brand" href="/"><span class="brand-mark">${BRAND_SVG}</span>${BRAND_TEXT}</a>`;
  el.innerHTML = `<div class="container">
    ${brand}
    <nav id="main-nav">
      <a class="nav-link ${active === 'events' ? 'active' : ''}" href="/#events">Events</a>
      <a class="nav-link ${active === 'about' ? 'active' : ''}" href="/about.html">About Us</a>
      <a class="nav-link ${active === 'mine' ? 'active' : ''}" href="/#my-bookings">My bookings</a>
      <a class="nav-link" href="/about.html#contact">Contact</a>
      <button type="button" id="theme-btn"></button>
      <button type="button" class="menu-btn theme-btn" id="menu-btn" aria-label="Menu">☰</button>
    </nav></div>`;
  wireThemeToggle(document.getElementById('theme-btn'));
  const nav = document.getElementById('main-nav');
  document.getElementById('menu-btn').addEventListener('click', () => nav.classList.toggle('open'));
  footer();
}

export function footer() {
  const f = document.querySelector('footer');
  if (!f || f.dataset.done) return;
  f.dataset.done = '1';
  f.className = 'site-footer';
  f.innerHTML = `<div class="container">
    <div class="cols">
      <div><h4>AUTO EXPO SUBURBAN EVENTS</h4>
        <div class="muted small">Chennai's Premier Corporate Event Planner · Since 2009<br>Expertise in automotive events and corporate functions.</div></div>
      <div><h4>Contact</h4><div class="small" style="display:flex;flex-direction:column;gap:3px">
        <span class="muted">📍 Nanganallur, Chennai, TN 600061</span>
        <a href="tel:+919841517136">📞 98415 17136</a>
        <a href="https://wa.me/919840049879" target="_blank" rel="noopener">💬 98400 49879 (WhatsApp)</a>
        <span class="muted">🕘 Mon – Sun · 9 am – 5 pm</span></div></div>
      <div><h4>Explore</h4><div class="small" style="display:flex;flex-direction:column;gap:3px">
        <a href="/#events">Upcoming events</a><a href="/about.html">About us</a>
        <a href="/about.html#venues">Corporate venues</a><a href="/about.html#patrons">Our patrons</a>
        <a href="/policy.html">Cancellation &amp; refund policy</a>
        <a href="/admin.html">Organizer login</a></div></div>
    </div>
    <div class="copy small muted">© ${new Date().getFullYear()} AUTO EXPO SUBURBAN EVENTS · All rights reserved.</div>
  </div>`;
}

/**
 * Render the stall map. Stalls are positioned as % of the stage, so they line up
 * with the organizer's uploaded layout image at any screen width.
 */
export function renderStage(stage, event, stalls, { selectedId, onPick, showPrice = true } = {}) {
  stage.innerHTML = '';
  stage.classList.toggle('blank', !event.layout);
  if (event.layout) {
    const img = document.createElement('img');
    img.className = 'layout';
    img.src = event.layout;
    img.alt = `Stall layout for ${event.title}`;
    stage.append(img);
  }
  for (const s of stalls) {
    const b = document.createElement('button');
    b.type = 'button';
    const st = s.id === selectedId ? 'selected' : s.state;
    b.className = `stall ${st}${s.is_corner ? ' corner' : ''}`;
    Object.assign(b.style, { left: s.x + '%', top: s.y + '%', width: s.w + '%', height: s.h + '%' });
    const stateText = { available: 'Available', held: 'Being booked', reserved: 'Reserved', booked: 'Booked', blocked: 'Not available', selected: 'Selected' }[st];
    b.title = `Stall ${s.label}${s.is_corner ? ' (corner)' : ''} — ${money(s.total)} — ${stateText}`;
    b.setAttribute('aria-label', b.title);
    b.innerHTML = `${event.layout ? '' : STALL_ICON}<span class="lbl">${esc(s.label)}</span>${showPrice && (st === 'available' || st === 'selected') ? `<span class="pr">${money(s.total)}</span>` : ''}`;
    if (s.state !== 'available') b.disabled = true;
    else if (onPick) b.addEventListener('click', () => onPick(s));
    stage.append(b);
  }
}
