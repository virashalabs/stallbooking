// Auto Expo Suburban Events (BookMyStall) — stall slot booking for event organizers & vendors.
// Stack: Express + Node's built-in SQLite (node:sqlite) + multer (uploads) + qrcode.
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Fresh install (e.g. Render's free plan, whose disk is wiped on every restart):
// start from the snapshot in seed/ — events, layout, poster, payment QR and settings, no bookings.
const DB_FILE = path.join(DATA_DIR, 'bookmystall.db');
const SEED_DIR = path.join(__dirname, 'seed');
if (!fs.existsSync(DB_FILE) && fs.existsSync(path.join(SEED_DIR, 'bookmystall.db'))) {
  fs.copyFileSync(path.join(SEED_DIR, 'bookmystall.db'), DB_FILE);
  const seedUploads = path.join(SEED_DIR, 'uploads');
  if (fs.existsSync(seedUploads)) {
    for (const f of fs.readdirSync(seedUploads)) fs.copyFileSync(path.join(seedUploads, f), path.join(UPLOAD_DIR, f));
  }
  console.log('Started from seed data (seed/bookmystall.db).');
}

// ---------------------------------------------------------------- database
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT '',
  venue_type TEXT NOT NULL DEFAULT 'corporate',
  start_at TEXT, end_at TEXT,
  banner TEXT, layout TEXT,
  base_rent INTEGER NOT NULL DEFAULT 0,
  corner_charge INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stalls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  is_corner INTEGER NOT NULL DEFAULT 0,
  price INTEGER,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  stall_id INTEGER REFERENCES stalls(id) ON DELETE SET NULL,
  stall_label TEXT NOT NULL,
  token TEXT NOT NULL,
  business_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  products TEXT NOT NULL,
  base_amount INTEGER NOT NULL,
  corner_amount INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,               -- held | pending | approved | rejected | expired | cancelled
  utr TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  hold_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  paid_at INTEGER, decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bookings_stall ON bookings(stall_id, status);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  whatsapp_sent INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL DEFAULT 'promo',           -- promo: any vendor | coupon: one vendor, stacks on top of a promo
  discount_type TEXT NOT NULL DEFAULT 'flat',   -- flat (₹) | percent
  value INTEGER NOT NULL,
  max_discount INTEGER,                         -- cap for percent discounts
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,  -- NULL = all events
  vendor_name TEXT NOT NULL DEFAULT '',
  vendor_phone TEXT NOT NULL DEFAULT '',
  usage_limit INTEGER,                          -- NULL = unlimited
  valid_until TEXT,                             -- YYYY-MM-DD (IST), inclusive
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_no TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,
  name TEXT NOT NULL,
  business_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  issued_on TEXT NOT NULL,                      -- YYYY-MM-DD
  expires_on TEXT NOT NULL,                     -- issued_on + 1 year
  status TEXT NOT NULL DEFAULT 'active',        -- active | revoked
  booking_id INTEGER,
  created_at INTEGER NOT NULL
);
`);
// Columns added after the first release (existing databases are upgraded in place).
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('bookings', 'gross_amount', 'INTEGER');
addColumn('bookings', 'promo_code', "TEXT NOT NULL DEFAULT ''");
addColumn('bookings', 'promo_discount', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bookings', 'coupon_code', "TEXT NOT NULL DEFAULT ''");
addColumn('bookings', 'coupon_discount', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bookings', 'policy_accepted_at', 'INTEGER');
addColumn('bookings', 'cancel_requested_at', 'INTEGER');
addColumn('bookings', 'cancel_reason', "TEXT NOT NULL DEFAULT ''");
addColumn('bookings', 'refund_eligible', 'INTEGER');
addColumn('bookings', 'refund_amount', 'INTEGER');
addColumn('bookings', 'refunded_at', 'INTEGER');
db.exec('UPDATE bookings SET gross_amount = base_amount + corner_amount WHERE gross_amount IS NULL');

const ACTIVE = `('held','pending','approved')`;
const getSetting = (k, d = '') => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? d;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v ?? ''));

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------- auth helpers
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
if (!getSetting('secret')) setSetting('secret', crypto.randomBytes(32).toString('hex'));
if (!getSetting('admin_pw')) {
  setSetting('admin_pw', hashPassword(process.env.ADMIN_PASSWORD || 'admin.123'));
  setSetting('admin_pw_default', '0');
}
const SECRET = getSetting('secret');
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAdmin(req) {
  const c = parseCookies(req).bms_admin;
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Please log in to the admin portal.' });
  next();
}

// ---------------------------------------------------------------- domain helpers
const now = () => Date.now();
const intOr = (v, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : d; };
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d; // default India country code
  return d;
}

function sweepExpiredHolds() {
  db.prepare(`UPDATE bookings SET status='expired' WHERE status='held' AND hold_expires_at < ?`).run(now());
}

function priceFor(stall, ev) {
  const base = stall.price ?? ev.base_rent;
  const corner = stall.is_corner ? ev.corner_charge : 0;
  return { base, corner, total: base + corner };
}

function stallsWithState(ev, { admin = false } = {}) {
  sweepExpiredHolds();
  const stalls = db.prepare('SELECT * FROM stalls WHERE event_id=? ORDER BY sort, id').all(ev.id);
  const active = db.prepare(`SELECT * FROM bookings WHERE event_id=? AND status IN ${ACTIVE}`).all(ev.id);
  const byStall = new Map(active.map(b => [b.stall_id, b]));
  return stalls.map(s => {
    const b = byStall.get(s.id);
    let state = 'available';
    if (s.blocked) state = 'blocked';
    else if (b?.status === 'approved') state = 'booked';
    else if (b?.status === 'pending') state = 'reserved';
    else if (b?.status === 'held') state = 'held';
    const p = priceFor(s, ev);
    const out = {
      id: s.id, label: s.label, is_corner: !!s.is_corner, custom_price: s.price,
      x: s.x, y: s.y, w: s.w, h: s.h, blocked: !!s.blocked,
      state, base: p.base, corner: p.corner, total: p.total,
    };
    if (admin && b) out.booking = { id: b.id, business_name: b.business_name, products: b.products, status: b.status };
    return out;
  });
}

function eventSummary(ev) {
  const st = stallsWithState(ev);
  return {
    ...ev,
    stall_count: st.length,
    available_count: st.filter(s => s.state === 'available').length,
    min_price: st.length ? Math.min(...st.map(s => s.total)) : ev.base_rent,
  };
}

function discountText(b) {
  const parts = [];
  if (b.promo_discount) parts.push(`promo ${b.promo_code} −${rupees(b.promo_discount)}`);
  if (b.coupon_discount) parts.push(`coupon ${b.coupon_code} −${rupees(b.coupon_discount)}`);
  return parts.join(', ');
}
function bookingMessage(b, ev, kind) {
  const amt = rupees(b.amount);
  const disc = discountText(b);
  if (kind === 'payment') {
    return `Stall ${b.stall_label} was booked by ${b.business_name} for the product(s) "${b.products}" and made a payment of ${amt} for the event titled "${ev.title}".` +
      (disc ? ` (Stall price ${rupees(b.gross_amount)}; ${disc}.)` : '') +
      (b.utr ? ` UTR/Ref: ${b.utr}.` : '') + ` Please verify and approve in the admin portal.`;
  }
  if (kind === 'cancel') {
    const days = ev.start_at ? Math.floor((eventStartMs(ev) - (b.cancel_requested_at || now())) / 864e5) : null;
    return `Cancellation requested by ${b.business_name} for stall ${b.stall_label}, "${ev.title}" (AESE-${b.id}). Amount paid: ${amt}.` +
      (days !== null ? ` Requested ${days} day(s) before the event —` : '') +
      (b.refund_eligible ? ' eligible for a full refund under the 7-day policy.' : ' NOT eligible for a refund under the 7-day policy.') +
      (b.cancel_reason ? ` Reason: ${b.cancel_reason}` : '');
  }
  return `✅ Stall ${b.stall_label} confirmed for "${ev.title}"\n` +
    `Vendor: ${b.business_name}\nContact: ${b.contact_name}\nPhone: +${b.phone}\n` +
    (b.email ? `Email: ${b.email}\n` : '') +
    `Products: ${b.products}\nAmount paid: ${amt}` + (disc ? ` (${disc})` : '') + (b.utr ? `\nUTR/Ref: ${b.utr}` : '') + `\nBooking ID: AESE-${b.id}`;
}

// Optional: WhatsApp Cloud API (Meta). Without credentials the portal shows click-to-chat links instead.
const waConfigured = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
async function sendWhatsApp(to, text) {
  if (!waConfigured() || !to) return false;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
    if (!r.ok) console.warn('WhatsApp send failed:', r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.warn('WhatsApp send error:', e.message);
    return false;
  }
}

function notify(booking, kind, message) {
  const info = db.prepare('INSERT INTO notifications(booking_id,kind,message,created_at) VALUES(?,?,?,?)')
    .run(booking.id, kind, message, now());
  const orgPhone = normalizePhone(getSetting('organizer_whatsapp'));
  sendWhatsApp(orgPhone, message).then(ok => {
    if (ok) db.prepare('UPDATE notifications SET whatsapp_sent=1 WHERE id=?').run(info.lastInsertRowid);
  });
}

const waLink = (phone, text) => phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null;
const rupees = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------- dates (event times are IST)
const IST_MS = 5.5 * 3600e3;
const istToday = () => new Date(now() + IST_MS).toISOString().slice(0, 10);
function eventStartMs(ev) {
  if (!ev?.start_at) return null;
  const t = Date.parse(`${ev.start_at.slice(0, 16)}:00+05:30`);
  return Number.isFinite(t) ? t : null;
}
// Cancellation & refund policy: full refund only if cancellation is requested at least 7 days before the event.
const REFUND_DAYS = 7;
const refundDeadline = ev => { const s = eventStartMs(ev); return s ? s - REFUND_DAYS * 864e5 : null; };

// ---------------------------------------------------------------- promo codes & vendor coupons
function discountFor(p, amount) {
  if (!p || amount <= 0) return 0;
  let d = p.discount_type === 'percent' ? Math.round(amount * p.value / 100) : p.value;
  if (p.discount_type === 'percent' && p.max_discount) d = Math.min(d, p.max_discount);
  return Math.max(0, Math.min(d, amount));
}
const codeUses = (code, excludeBookingId = 0) => db.prepare(
  `SELECT COUNT(*) c FROM bookings WHERE id<>? AND status IN ${ACTIVE} AND (promo_code=? COLLATE NOCASE OR coupon_code=? COLLATE NOCASE)`,
).get(excludeBookingId, code, code).c;
const describeDiscount = p => p.discount_type === 'percent'
  ? `${p.value}% off${p.max_discount ? ` (up to ${rupees(p.max_discount)})` : ''}` : `${rupees(p.value)} off`;

function findValidCode(code, booking) {
  const p = db.prepare('SELECT * FROM promo_codes WHERE code=? COLLATE NOCASE').get(str(code, 40));
  if (!p || !p.active) throw httpError(400, 'This code is not valid.');
  if (p.valid_until && p.valid_until < istToday()) throw httpError(400, 'This code has expired.');
  if (p.event_id && p.event_id !== booking.event_id) throw httpError(400, 'This code is not valid for this event.');
  if (p.kind === 'coupon' && normalizePhone(p.vendor_phone) !== booking.phone)
    throw httpError(400, 'This coupon was issued to another vendor. It only works with the WhatsApp number it was sent to.');
  if (p.usage_limit && codeUses(p.code, booking.id) >= p.usage_limit) throw httpError(400, 'This code has already been used the maximum number of times.');
  return p;
}
// Promo discount applies to the stall price first; the vendor coupon then applies on top of what remains.
function priceBooking(b, promo, coupon) {
  const gross = b.gross_amount ?? (b.base_amount + b.corner_amount);
  const promo_discount = discountFor(promo, gross);
  const coupon_discount = discountFor(coupon, gross - promo_discount);
  return {
    gross_amount: gross, promo_code: promo?.code || '', promo_discount,
    coupon_code: coupon?.code || '', coupon_discount, amount: gross - promo_discount - coupon_discount,
  };
}
const codeRow = code => code ? db.prepare('SELECT * FROM promo_codes WHERE code=? COLLATE NOCASE').get(code) : null;

// ---------------------------------------------------------------- membership cards
const MEMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreading
function newMemberNo() {
  for (;;) {
    const pick = n => Array.from(crypto.randomBytes(n), x => MEMBER_ALPHABET[x % MEMBER_ALPHABET.length]).join('');
    const no = `AES-${pick(4)}-${pick(4)}`;
    if (!db.prepare('SELECT 1 FROM members WHERE member_no=?').get(no)) return no;
  }
}
function plusOneYear(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
}
const memberStatus = m => m.status === 'revoked' ? 'revoked' : (m.expires_on < istToday() ? 'expired' : 'active');

// ---------------------------------------------------------------- uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype];
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    /^image\/(png|jpeg|webp|gif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Only PNG, JPG, WEBP or GIF images are allowed.')),
});
function removeUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(url)), { force: true }, () => {});
}

// ---------------------------------------------------------------- seed demo data
if (!db.prepare('SELECT COUNT(*) c FROM events').get().c) {
  const src = path.join(__dirname, 'public', 'sample', 'layout.png');
  let layout = null;
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(UPLOAD_DIR, 'demo-layout.png'));
    layout = '/uploads/demo-layout.png';
  }
  let banner = null;
  const poster = path.join(__dirname, 'public', 'sample', 'diwali-poster.png');
  if (fs.existsSync(poster)) {
    fs.copyFileSync(poster, path.join(UPLOAD_DIR, 'demo-poster.png'));
    banner = '/uploads/demo-poster.png';
  }
  const ev = db.prepare(`INSERT INTO events(title,description,venue,venue_type,start_at,end_at,banner,layout,base_rent,corner_charge,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'L&T Innovation Campus – Diwali Celebration',
    'Celebrate the Festival of Lights at L&T Innovation Campus! A one-day Diwali market on the campus driveway for employees and visitors. Showcase diyas, rangoli, sweets, apparel, gifts, home décor and more. Each stall includes a table, 2 chairs and a power point.',
    'L&T Innovation Campus – Main Driveway', 'corporate', '2026-11-10T10:00', '2026-11-10T19:00', banner, layout, 1500, 500, 'published', now());
  const xs = [1.9, 8.7, 15.4, 22.1, 28.8, 35.5, 57.6, 64.5, 71.2, 77.9, 84.6, 91.3];
  const ins = db.prepare('INSERT INTO stalls(event_id,label,is_corner,x,y,w,h,sort) VALUES(?,?,?,?,?,?,?,?)');
  xs.forEach((x, i) => ins.run(ev.lastInsertRowid, String(i + 1), [0, 5, 6, 11].includes(i) ? 1 : 0, x, 66.7, 6.7, 21.4, i));
  if (!getSetting('organizer_name')) setSetting('organizer_name', 'Auto Expo Suburban Events');
  if (!getSetting('hold_minutes')) setSetting('hold_minutes', '10');
}

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render's HTTPS proxy
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

const getEvent = id => db.prepare('SELECT * FROM events WHERE id=?').get(Number(id));
const publicSettings = () => ({
  organizer_name: getSetting('organizer_name', 'Auto Expo Suburban Events'),
  hold_minutes: intOr(getSetting('hold_minutes', '10'), 10) || 10,
});

// ----- public API
app.get('/api/site', (req, res) => res.json(publicSettings()));

app.get('/api/events', (req, res) => {
  const evs = db.prepare(`SELECT * FROM events WHERE status IN ('published','closed') ORDER BY COALESCE(start_at,'9999'), id`).all();
  res.json(evs.map(eventSummary));
});

app.get('/api/events/:id', (req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev || ev.status === 'draft') return res.status(404).json({ error: 'Event not found.' });
  res.json({ event: ev, stalls: stallsWithState(ev), site: publicSettings() });
});

app.post('/api/events/:id/hold', (req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev || ev.status === 'draft') return res.status(404).json({ error: 'Event not found.' });
  if (ev.status !== 'published') return res.status(400).json({ error: 'Bookings for this event are closed.' });
  const b = req.body || {};
  const v = {
    business_name: str(b.business_name, 120), contact_name: str(b.contact_name, 120),
    phone: normalizePhone(b.phone), email: str(b.email, 160), products: str(b.products, 500),
  };
  if (!v.business_name || !v.contact_name || !v.products) return res.status(400).json({ error: 'Business name, contact name and products are required.' });
  if (v.phone.length < 11 || v.phone.length > 15) return res.status(400).json({ error: 'Please enter a valid WhatsApp number.' });
  if (b.accept_policy !== true) return res.status(400).json({ error: 'Please read and accept the Cancellation & Refund Policy to continue.' });

  try {
    const result = tx(() => {
      sweepExpiredHolds();
      const stall = db.prepare('SELECT * FROM stalls WHERE id=? AND event_id=?').get(Number(b.stall_id), ev.id);
      if (!stall) throw Object.assign(new Error('Stall not found.'), { status: 404 });
      if (stall.blocked) throw Object.assign(new Error('This stall is not available for booking.'), { status: 409 });
      const taken = db.prepare(`SELECT 1 FROM bookings WHERE stall_id=? AND status IN ${ACTIVE}`).get(stall.id);
      if (taken) throw Object.assign(new Error(`Sorry, stall ${stall.label} was just taken by another vendor. Please pick another one.`), { status: 409 });
      const p = priceFor(stall, ev);
      const token = crypto.randomBytes(18).toString('base64url');
      const holdMs = publicSettings().hold_minutes * 60e3;
      const info = db.prepare(`INSERT INTO bookings(event_id,stall_id,stall_label,token,business_name,contact_name,phone,email,products,base_amount,corner_amount,gross_amount,amount,status,hold_expires_at,created_at,policy_accepted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'held',?,?,?)`).run(
        ev.id, stall.id, stall.label, token, v.business_name, v.contact_name, v.phone, v.email, v.products,
        p.base, p.corner, p.total, p.total, now() + holdMs, now(), now());
      return { booking_id: Number(info.lastInsertRowid), token };
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not reserve the stall.' });
    if (!e.status) console.error(e);
  }
});

function loadOwnBooking(req, res) {
  sweepExpiredHolds();
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(req.params.id));
  const token = String(req.query.t || req.body?.token || '');
  if (!b || !token || token.length !== b.token.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(b.token))) {
    res.status(404).json({ error: 'Booking not found.' });
    return null;
  }
  return b;
}

function publicBooking(b) {
  const { token, ...rest } = b;
  return rest;
}

app.get('/api/bookings/:id', async (req, res) => {
  const b = loadOwnBooking(req, res);
  if (!b) return;
  const ev = getEvent(b.event_id);
  const upiId = getSetting('upi_id');
  const payee = getSetting('payee_name') || getSetting('organizer_name');
  let payment = null;
  if (b.status === 'held' && b.amount > 0) {
    const note = `Stall ${b.stall_label} AESE-${b.id}`.slice(0, 50);
    const upiLink = upiId
      ? `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee)}&am=${b.amount}&cu=INR&tn=${encodeURIComponent(note)}`
      : null;
    payment = {
      upi_id: upiId, payee, upi_link: upiLink, note,
      qr: upiLink ? await QRCode.toDataURL(upiLink, { width: 320, margin: 1 }) : null,
      static_qr: getSetting('payment_qr') || null,
      instructions: getSetting('payment_note'),
    };
  }
  const orgPhone = normalizePhone(getSetting('organizer_whatsapp'));
  const deadline = refundDeadline(ev);
  let orgMsg = null;
  if (b.cancel_requested_at && ['pending', 'approved'].includes(b.status)) orgMsg = bookingMessage(b, ev, 'cancel');
  else if (b.status === 'pending') orgMsg = bookingMessage(b, ev, 'payment');
  res.json({
    booking: publicBooking(b),
    event: { id: ev.id, title: ev.title, venue: ev.venue, start_at: ev.start_at, end_at: ev.end_at, banner: ev.banner },
    payment,
    server_time: now(),
    policy: { refund_days: REFUND_DAYS, refund_deadline: deadline, full_refund_now: deadline ? now() <= deadline : false },
    organizer: {
      name: getSetting('organizer_name'),
      whatsapp_link: orgMsg ? waLink(orgPhone, orgMsg) : null,
    },
  });
});

// Apply a promo code / vendor coupon at checkout (while the stall is held).
app.post('/api/bookings/:id/code', (req, res) => {
  const b = loadOwnBooking(req, res);
  if (!b) return;
  if (b.status !== 'held') return res.status(400).json({ error: 'Codes can only be applied before you submit the payment.' });
  try {
    const p = findValidCode(req.body?.code, b);
    let promo = codeRow(b.promo_code), coupon = codeRow(b.coupon_code);
    if (p.kind === 'coupon') coupon = p; else promo = p;
    const priced = priceBooking(b, promo, coupon);
    const saved = (p.kind === 'coupon' ? priced.coupon_discount : priced.promo_discount);
    if (!saved) throw httpError(400, 'This code gives no further discount on this booking.');
    db.prepare('UPDATE bookings SET promo_code=?, promo_discount=?, coupon_code=?, coupon_discount=?, amount=? WHERE id=?')
      .run(priced.promo_code, priced.promo_discount, priced.coupon_code, priced.coupon_discount, priced.amount, b.id);
    res.json({ ok: true, message: `${p.code} applied — you save ${rupees(saved)}.` });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not apply the code.' });
  }
});
app.post('/api/bookings/:id/code/remove', (req, res) => {
  const b = loadOwnBooking(req, res);
  if (!b) return;
  if (b.status !== 'held') return res.status(400).json({ error: 'Codes can only be changed before you submit the payment.' });
  const kind = req.body?.kind === 'coupon' ? 'coupon' : 'promo';
  const priced = priceBooking(b, kind === 'promo' ? null : codeRow(b.promo_code), kind === 'coupon' ? null : codeRow(b.coupon_code));
  db.prepare('UPDATE bookings SET promo_code=?, promo_discount=?, coupon_code=?, coupon_discount=?, amount=? WHERE id=?')
    .run(priced.promo_code, priced.promo_discount, priced.coupon_code, priced.coupon_discount, priced.amount, b.id);
  res.json({ ok: true });
});

// Vendor asks to cancel a paid booking. Eligibility for a full refund is fixed at the moment of the request.
app.post('/api/bookings/:id/cancel-request', (req, res) => {
  const b = loadOwnBooking(req, res);
  if (!b) return;
  if (!['pending', 'approved'].includes(b.status)) return res.status(400).json({ error: 'This booking cannot be cancelled.' });
  if (b.cancel_requested_at) return res.json({ ok: true });
  const ev = getEvent(b.event_id);
  const deadline = refundDeadline(ev);
  const eligible = deadline ? now() <= deadline : 0;
  db.prepare('UPDATE bookings SET cancel_requested_at=?, cancel_reason=?, refund_eligible=? WHERE id=?')
    .run(now(), str(req.body?.reason, 300), eligible ? 1 : 0, b.id);
  const fresh = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  notify(fresh, 'cancel', bookingMessage(fresh, ev, 'cancel'));
  res.json({ ok: true, refund_eligible: !!eligible });
});

app.post('/api/bookings/:id/paid', (req, res) => {
  const b = loadOwnBooking(req, res);
  if (!b) return;
  const utr = str(req.body?.utr, 60);
  try {
    tx(() => {
      const cur = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
      if (cur.status === 'pending') return;
      if (cur.status === 'expired') {
        // Grace: accept if nobody else grabbed the stall meanwhile.
        const taken = db.prepare(`SELECT 1 FROM bookings WHERE stall_id=? AND id<>? AND status IN ${ACTIVE}`).get(cur.stall_id, cur.id);
        if (taken || !cur.stall_id) throw Object.assign(new Error('Your hold expired and the stall was taken by someone else. If you already paid, please contact the organizer.'), { status: 410 });
      } else if (cur.status !== 'held') {
        throw Object.assign(new Error(`This booking is ${cur.status}.`), { status: 400 });
      }
      db.prepare(`UPDATE bookings SET status='pending', utr=?, paid_at=? WHERE id=?`).run(utr, now(), b.id);
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' });
  }
  const fresh = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  const ev = getEvent(fresh.event_id);
  if (b.status !== 'pending') notify(fresh, 'payment', bookingMessage(fresh, ev, 'payment'));
  res.json({ ok: true });
});

app.post('/api/bookings/:id/cancel', (req, res) => {
  const b = loadOwnBooking(req, res);
  if (!b) return;
  if (b.status !== 'held') return res.status(400).json({ error: 'Only an unpaid hold can be cancelled here.' });
  db.prepare(`UPDATE bookings SET status='cancelled', decided_at=? WHERE id=?`).run(now(), b.id);
  res.json({ ok: true });
});

// Public membership card (link shared with the vendor). The QR on the card opens this same page to verify it.
app.get('/api/members/:no', async (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE member_no=?').get(str(req.params.no, 20).toUpperCase());
  const t = String(req.query.t || '');
  if (!m || t.length !== m.token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(m.token))) {
    return res.status(404).json({ error: 'Membership card not found.' });
  }
  const url = `${req.protocol}://${req.get('host')}/card.html?n=${encodeURIComponent(m.member_no)}&t=${encodeURIComponent(m.token)}`;
  res.json({
    member: { member_no: m.member_no, name: m.name, business_name: m.business_name, issued_on: m.issued_on, expires_on: m.expires_on, state: memberStatus(m) },
    qr: await QRCode.toDataURL(url, { width: 240, margin: 1, color: { dark: '#000000', light: '#ffffff' } }),
    url,
  });
});

// ----- admin API
app.post('/api/admin/login', (req, res) => {
  const user = String(req.body?.username || '').trim().toLowerCase();
  if (user !== getSetting('admin_user', 'admin').toLowerCase() || !checkPassword(String(req.body?.password || ''), getSetting('admin_pw'))) {
    return setTimeout(() => res.status(401).json({ error: 'Incorrect username or password.' }), 600);
  }
  const exp = String(now() + 7 * 864e5);
  res.setHeader('Set-Cookie', `bms_admin=${exp}.${sign(exp)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${7 * 86400}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'bms_admin=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

app.use('/api/admin', requireAdmin);

app.post('/api/admin/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(String(current || ''), getSetting('admin_pw'))) return res.status(400).json({ error: 'Current password is incorrect.' });
  if (String(next || '').length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  setSetting('admin_pw', hashPassword(String(next)));
  setSetting('admin_pw_default', '0');
  res.json({ ok: true });
});

const SETTING_KEYS = ['organizer_name', 'organizer_whatsapp', 'upi_id', 'payee_name', 'hold_minutes', 'payment_note'];
app.get('/api/admin/settings', (req, res) => {
  const out = Object.fromEntries(SETTING_KEYS.map(k => [k, getSetting(k)]));
  out.payment_qr = getSetting('payment_qr');
  out.whatsapp_api = waConfigured();
  out.default_password = getSetting('admin_pw_default') === '1';
  res.json(out);
});
app.put('/api/admin/settings', upload.single('payment_qr'), (req, res) => {
  const b = req.body || {};
  for (const k of SETTING_KEYS) if (k in b) setSetting(k, str(b[k], 500));
  if (b.hold_minutes !== undefined) setSetting('hold_minutes', Math.min(60, Math.max(2, intOr(b.hold_minutes, 10))));
  if (req.file) { removeUpload(getSetting('payment_qr')); setSetting('payment_qr', `/uploads/${req.file.filename}`); }
  else if (b.remove_payment_qr === '1') { removeUpload(getSetting('payment_qr')); setSetting('payment_qr', ''); }
  res.json({ ok: true });
});

app.get('/api/admin/events', (req, res) => {
  const evs = db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  const counts = db.prepare(`SELECT event_id, status, COUNT(*) c FROM bookings GROUP BY event_id, status`).all();
  res.json(evs.map(ev => {
    const s = eventSummary(ev);
    s.bookings = Object.fromEntries(counts.filter(c => c.event_id === ev.id).map(c => [c.status, c.c]));
    return s;
  }));
});

app.get('/api/admin/events/:id', (req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  res.json({ event: ev, stalls: stallsWithState(ev, { admin: true }) });
});

const eventUpload = upload.fields([{ name: 'banner', maxCount: 1 }, { name: 'layout', maxCount: 1 }]);
function eventFields(b, prev = {}) {
  const status = ['draft', 'published', 'closed'].includes(b.status) ? b.status : (prev.status || 'published');
  const venue_type = ['corporate', 'public', 'apartment', 'other'].includes(b.venue_type) ? b.venue_type : (prev.venue_type || 'corporate');
  return {
    title: str(b.title ?? prev.title, 150), description: str(b.description ?? prev.description, 4000),
    venue: str(b.venue ?? prev.venue, 200), venue_type,
    start_at: str(b.start_at ?? prev.start_at, 20) || null, end_at: str(b.end_at ?? prev.end_at, 20) || null,
    base_rent: intOr(b.base_rent, prev.base_rent ?? 0), corner_charge: intOr(b.corner_charge, prev.corner_charge ?? 0), status,
  };
}
app.post('/api/admin/events', eventUpload, (req, res) => {
  const f = eventFields(req.body || {});
  if (!f.title) return res.status(400).json({ error: 'Event title is required.' });
  const banner = req.files?.banner?.[0] ? `/uploads/${req.files.banner[0].filename}` : null;
  const layout = req.files?.layout?.[0] ? `/uploads/${req.files.layout[0].filename}` : null;
  const info = db.prepare(`INSERT INTO events(title,description,venue,venue_type,start_at,end_at,banner,layout,base_rent,corner_charge,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.title, f.description, f.venue, f.venue_type, f.start_at, f.end_at, banner, layout, f.base_rent, f.corner_charge, f.status, now());
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put('/api/admin/events/:id', eventUpload, (req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  const f = eventFields(req.body || {}, ev);
  if (!f.title) return res.status(400).json({ error: 'Event title is required.' });
  let { banner, layout } = ev;
  if (req.files?.banner?.[0]) { removeUpload(banner); banner = `/uploads/${req.files.banner[0].filename}`; }
  else if (req.body.remove_banner === '1') { removeUpload(banner); banner = null; }
  if (req.files?.layout?.[0]) { removeUpload(layout); layout = `/uploads/${req.files.layout[0].filename}`; }
  else if (req.body.remove_layout === '1') { removeUpload(layout); layout = null; }
  db.prepare(`UPDATE events SET title=?,description=?,venue=?,venue_type=?,start_at=?,end_at=?,banner=?,layout=?,base_rent=?,corner_charge=?,status=? WHERE id=?`)
    .run(f.title, f.description, f.venue, f.venue_type, f.start_at, f.end_at, banner, layout, f.base_rent, f.corner_charge, f.status, ev.id);
  res.json({ ok: true });
});
app.delete('/api/admin/events/:id', (req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  db.prepare('DELETE FROM events WHERE id=?').run(ev.id);
  removeUpload(ev.banner); removeUpload(ev.layout);
  res.json({ ok: true });
});

app.put('/api/admin/events/:id/stalls', (req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  const list = Array.isArray(req.body?.stalls) ? req.body.stalls : null;
  if (!list) return res.status(400).json({ error: 'Invalid stall list.' });
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
  const labels = new Set();
  for (const s of list) {
    const l = str(s.label, 20);
    if (!l) return res.status(400).json({ error: 'Every stall needs a label.' });
    if (labels.has(l.toLowerCase())) return res.status(400).json({ error: `Duplicate stall label "${l}".` });
    labels.add(l.toLowerCase());
  }
  try {
    tx(() => {
      sweepExpiredHolds();
      const existing = db.prepare('SELECT id, label FROM stalls WHERE event_id=?').all(ev.id);
      const keep = new Set(list.filter(s => s.id).map(s => Number(s.id)));
      for (const s of existing) {
        if (keep.has(s.id)) continue;
        if (db.prepare(`SELECT 1 FROM bookings WHERE stall_id=? AND status IN ${ACTIVE}`).get(s.id))
          throw Object.assign(new Error(`Stall ${s.label} has an active booking and can't be deleted. Reject/release the booking first.`), { status: 409 });
        db.prepare('DELETE FROM stalls WHERE id=?').run(s.id);
      }
      const upd = db.prepare('UPDATE stalls SET label=?,is_corner=?,price=?,x=?,y=?,w=?,h=?,blocked=?,sort=? WHERE id=? AND event_id=?');
      const ins = db.prepare('INSERT INTO stalls(event_id,label,is_corner,price,x,y,w,h,blocked,sort) VALUES(?,?,?,?,?,?,?,?,?,?)');
      list.forEach((s, i) => {
        const price = s.custom_price === '' || s.custom_price == null ? null : intOr(s.custom_price, null);
        const vals = [str(s.label, 20), s.is_corner ? 1 : 0, price, clamp(s.x, 0, 99), clamp(s.y, 0, 99), clamp(s.w, 1, 100), clamp(s.h, 1, 100), s.blocked ? 1 : 0, i];
        if (s.id && existing.some(e => e.id === Number(s.id))) upd.run(...vals, Number(s.id), ev.id);
        else ins.run(ev.id, ...vals);
      });
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save stalls.' });
  }
  res.json({ stalls: stallsWithState(ev, { admin: true }) });
});

app.get('/api/admin/bookings', (req, res) => {
  sweepExpiredHolds();
  const where = [], args = [];
  if (req.query.event) { where.push('b.event_id=?'); args.push(Number(req.query.event)); }
  if (req.query.status === 'cancel_requested') where.push("b.cancel_requested_at IS NOT NULL AND b.status IN ('pending','approved')");
  else if (req.query.status) { where.push('b.status=?'); args.push(String(req.query.status)); }
  const rows = db.prepare(`SELECT b.*, e.title event_title, e.start_at event_start FROM bookings b JOIN events e ON e.id=b.event_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE WHEN b.cancel_requested_at IS NOT NULL AND b.status IN ('pending','approved') THEN 0 WHEN b.status='pending' THEN 1 WHEN b.status='held' THEN 2 ELSE 3 END, b.created_at DESC LIMIT 500`).all(...args);
  res.json(rows.map(r => {
    const { token, ...rest } = r;
    const msg = bookingMessage(r, { title: r.event_title }, 'details');
    return {
      ...rest,
      details_text: msg,
      refund_deadline: refundDeadline({ start_at: r.event_start }),
      wa_vendor: waLink(r.phone, r.status === 'approved'
        ? `Hi ${r.contact_name}, your stall ${r.stall_label} for "${r.event_title}" is confirmed. Booking ID: AESE-${r.id}. See you there!`
        : `Hi ${r.contact_name}, regarding your stall booking ${r.stall_label} for "${r.event_title}" (AESE-${r.id}).`),
      wa_organizer: waLink(normalizePhone(getSetting('organizer_whatsapp')), msg),
    };
  }));
});

function decide(req, res, from, to, kind) {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (!from.includes(b.status)) return res.status(400).json({ error: `Booking is already ${b.status}.` });
  db.prepare('UPDATE bookings SET status=?, decided_at=?, admin_note=? WHERE id=?').run(to, now(), str(req.body?.note, 300), b.id);
  const fresh = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  const ev = getEvent(b.event_id);
  if (kind === 'approved') notify(fresh, 'approved', bookingMessage(fresh, ev, 'details'));
  res.json({ ok: true });
}
app.post('/api/admin/bookings/:id/approve', (req, res) => decide(req, res, ['pending', 'held'], 'approved', 'approved'));
app.post('/api/admin/bookings/:id/reject', (req, res) => decide(req, res, ['pending', 'held', 'approved'], 'rejected', 'rejected'));
// Confirm a cancellation (the vendor's request, or the organizer's own decision): releases the stall.
app.post('/api/admin/bookings/:id/cancel', (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (!['pending', 'approved', 'held'].includes(b.status)) return res.status(400).json({ error: `Booking is already ${b.status}.` });
  const ev = getEvent(b.event_id);
  const deadline = refundDeadline(ev);
  const eligible = b.refund_eligible ?? (deadline ? (now() <= deadline ? 1 : 0) : 0);
  db.prepare(`UPDATE bookings SET status='cancelled', decided_at=?, admin_note=?, refund_eligible=?,
    cancel_requested_at=COALESCE(cancel_requested_at, ?) WHERE id=?`).run(now(), str(req.body?.note, 300), eligible, now(), b.id);
  res.json({ ok: true });
});
app.post('/api/admin/bookings/:id/refund', (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (!['cancelled', 'rejected'].includes(b.status) || !b.paid_at) return res.status(400).json({ error: 'Only paid bookings that are cancelled or rejected can be refunded.' });
  const amount = Math.min(intOr(req.body?.amount, b.amount), b.amount);
  db.prepare('UPDATE bookings SET refund_amount=?, refunded_at=? WHERE id=?').run(amount, now(), b.id);
  res.json({ ok: true });
});

// ----- promo codes & vendor coupons
app.get('/api/admin/promos', (req, res) => {
  const rows = db.prepare(`SELECT p.*, e.title event_title FROM promo_codes p LEFT JOIN events e ON e.id=p.event_id ORDER BY p.active DESC, p.created_at DESC`).all();
  res.json(rows.map(p => ({ ...p, uses: codeUses(p.code), describe: describeDiscount(p), expired: !!(p.valid_until && p.valid_until < istToday()) })));
});
function promoFields(b) {
  const kind = b.kind === 'coupon' ? 'coupon' : 'promo';
  const discount_type = b.discount_type === 'percent' ? 'percent' : 'flat';
  const value = intOr(b.value, 0);
  if (!value) throw httpError(400, 'Enter the discount amount.');
  if (discount_type === 'percent' && value > 100) throw httpError(400, 'A percentage discount cannot be more than 100%.');
  const vendor_phone = kind === 'coupon' ? normalizePhone(b.vendor_phone) : '';
  if (kind === 'coupon' && (vendor_phone.length < 11 || vendor_phone.length > 15)) throw httpError(400, "Enter the vendor's WhatsApp number for this coupon.");
  const valid_until = /^\d{4}-\d{2}-\d{2}$/.test(String(b.valid_until || '')) ? b.valid_until : null;
  const event_id = b.event_id ? Number(b.event_id) : null;
  if (event_id && !getEvent(event_id)) throw httpError(400, 'Event not found.');
  return {
    kind, discount_type, value, event_id, vendor_phone, valid_until,
    max_discount: discount_type === 'percent' && b.max_discount ? intOr(b.max_discount, null) : null,
    vendor_name: kind === 'coupon' ? str(b.vendor_name, 120) : '',
    usage_limit: b.usage_limit === '' || b.usage_limit == null ? (kind === 'coupon' ? 1 : null) : (intOr(b.usage_limit, 0) || null),
    note: str(b.note, 200),
  };
}
app.post('/api/admin/promos', (req, res) => {
  try {
    const f = promoFields(req.body || {});
    let code = str(req.body?.code, 20).toUpperCase().replace(/\s+/g, '');
    if (!code) code = (f.kind === 'coupon' ? 'VIP-' : 'AES') + crypto.randomBytes(3).toString('hex').toUpperCase();
    if (!/^[A-Z0-9-]{3,20}$/.test(code)) throw httpError(400, 'Codes can use letters, numbers and dashes (3–20 characters).');
    if (db.prepare('SELECT 1 FROM promo_codes WHERE code=? COLLATE NOCASE').get(code)) throw httpError(409, `The code ${code} already exists.`);
    const info = db.prepare(`INSERT INTO promo_codes(code,kind,discount_type,value,max_discount,event_id,vendor_name,vendor_phone,usage_limit,valid_until,note,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, f.kind, f.discount_type, f.value, f.max_discount, f.event_id, f.vendor_name, f.vendor_phone, f.usage_limit, f.valid_until, f.note, now());
    res.json({ id: Number(info.lastInsertRowid), code });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save the code.' });
  }
});
app.post('/api/admin/promos/:id/toggle', (req, res) => {
  const r = db.prepare('UPDATE promo_codes SET active = 1 - active WHERE id=?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Code not found.' });
  res.json({ ok: true });
});
app.delete('/api/admin/promos/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM promo_codes WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Code not found.' });
  if (codeUses(p.code)) return res.status(409).json({ error: 'This code is on an active booking. Disable it instead.' });
  db.prepare('DELETE FROM promo_codes WHERE id=?').run(p.id);
  res.json({ ok: true });
});

// ----- membership cards
app.get('/api/admin/members', (req, res) => {
  res.json(db.prepare('SELECT * FROM members ORDER BY created_at DESC').all().map(m => ({ ...m, state: memberStatus(m) })));
});
app.post('/api/admin/members', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80), business_name = str(b.business_name, 120), phone = normalizePhone(b.phone);
  if (!name) return res.status(400).json({ error: "Enter the vendor's name for the card." });
  if (phone && (phone.length < 11 || phone.length > 15)) return res.status(400).json({ error: 'Enter a valid WhatsApp number (or leave it blank).' });
  if (phone) {
    const dup = db.prepare(`SELECT * FROM members WHERE phone=? AND status='active' AND expires_on >= ?`).get(phone, istToday());
    if (dup) return res.status(409).json({ error: `${dup.name} already has an active membership card (${dup.member_no}).` });
  }
  const issued = istToday();
  const m = { member_no: newMemberNo(), token: crypto.randomBytes(12).toString('base64url'), issued_on: issued, expires_on: plusOneYear(issued) };
  const info = db.prepare(`INSERT INTO members(member_no,token,name,business_name,phone,issued_on,expires_on,booking_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(m.member_no, m.token, name, business_name, phone, m.issued_on, m.expires_on, b.booking_id ? Number(b.booking_id) : null, now());
  res.json({ id: Number(info.lastInsertRowid), ...m });
});
app.post('/api/admin/members/:id/:action(revoke|restore|renew)', (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Member not found.' });
  if (req.params.action === 'revoke') db.prepare(`UPDATE members SET status='revoked' WHERE id=?`).run(m.id);
  if (req.params.action === 'restore') db.prepare(`UPDATE members SET status='active' WHERE id=?`).run(m.id);
  if (req.params.action === 'renew') {
    const issued = istToday();
    db.prepare(`UPDATE members SET status='active', issued_on=?, expires_on=? WHERE id=?`).run(issued, plusOneYear(issued), m.id);
  }
  res.json({ ok: true });
});

app.get('/api/admin/notifications', (req, res) => {
  const items = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all();
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE is_read=0').get().c;
  const pending = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='pending' OR (status='approved' AND cancel_requested_at IS NOT NULL)`).get().c;
  res.json({ items, unread, pending });
});
app.post('/api/admin/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE is_read=0').run();
  res.json({ ok: true });
});

// ----- errors
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  const msg = err instanceof multer.MulterError || /images are allowed/.test(err.message) ? err.message : 'Server error.';
  if (msg === 'Server error.') console.error(err);
  res.status(msg === 'Server error.' ? 500 : 400).json({ error: msg });
});

setInterval(sweepExpiredHolds, 30e3).unref();
app.listen(PORT, () => {
  console.log(`Auto Expo Suburban Events running at http://localhost:${PORT}`);
  console.log(`Admin portal:          http://localhost:${PORT}/admin.html`);
  if (getSetting('admin_pw_default') === '1') console.log('Admin login: username admin, password admin.123');
}).on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Start on another port, e.g.  PORT=3100 npm start  (PowerShell: $env:PORT=3100; npm start)`);
  else console.error(e);
  process.exit(1);
});
