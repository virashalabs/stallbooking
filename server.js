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
`);

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

function bookingMessage(b, ev, kind) {
  const amt = `₹${b.amount.toLocaleString('en-IN')}`;
  if (kind === 'payment') {
    return `Stall ${b.stall_label} was booked by ${b.business_name} for the product(s) "${b.products}" and made a payment of ${amt} for the event titled "${ev.title}".` +
      (b.utr ? ` UTR/Ref: ${b.utr}.` : '') + ` Please verify and approve in the admin portal.`;
  }
  return `✅ Stall ${b.stall_label} confirmed for "${ev.title}"\n` +
    `Vendor: ${b.business_name}\nContact: ${b.contact_name}\nPhone: +${b.phone}\n` +
    (b.email ? `Email: ${b.email}\n` : '') +
    `Products: ${b.products}\nAmount paid: ${amt}` + (b.utr ? `\nUTR/Ref: ${b.utr}` : '') + `\nBooking ID: AESE-${b.id}`;
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
      const info = db.prepare(`INSERT INTO bookings(event_id,stall_id,stall_label,token,business_name,contact_name,phone,email,products,base_amount,corner_amount,amount,status,hold_expires_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'held',?,?)`).run(
        ev.id, stall.id, stall.label, token, v.business_name, v.contact_name, v.phone, v.email, v.products,
        p.base, p.corner, p.total, now() + holdMs, now());
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
  if (b.status === 'held') {
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
  res.json({
    booking: publicBooking(b),
    event: { id: ev.id, title: ev.title, venue: ev.venue, start_at: ev.start_at, end_at: ev.end_at, banner: ev.banner },
    payment,
    server_time: now(),
    organizer: {
      name: getSetting('organizer_name'),
      whatsapp_link: b.status === 'pending' ? waLink(orgPhone, bookingMessage(b, ev, 'payment')) : null,
    },
  });
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
  if (req.query.status) { where.push('b.status=?'); args.push(String(req.query.status)); }
  const rows = db.prepare(`SELECT b.*, e.title event_title FROM bookings b JOIN events e ON e.id=b.event_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE b.status WHEN 'pending' THEN 0 WHEN 'held' THEN 1 ELSE 2 END, b.created_at DESC LIMIT 500`).all(...args);
  res.json(rows.map(r => {
    const { token, ...rest } = r;
    const msg = bookingMessage(r, { title: r.event_title }, 'details');
    return {
      ...rest,
      details_text: msg,
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

app.get('/api/admin/notifications', (req, res) => {
  const items = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all();
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE is_read=0').get().c;
  const pending = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='pending'`).get().c;
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
