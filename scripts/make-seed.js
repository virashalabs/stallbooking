// Snapshot the current local setup into seed/ for hosts with a wiped disk (Render free plan).
// Keeps events, stalls, settings and the images they use; drops bookings, notifications
// and the cookie-signing secret (a new one is generated on each fresh start).
// Usage: node scripts/make-seed.js
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
const SEED_DIR = path.join(root, 'seed');
const out = path.join(SEED_DIR, 'bookmystall.db');

fs.rmSync(SEED_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(SEED_DIR, 'uploads'), { recursive: true });

// VACUUM INTO gives a consistent copy even while the app is running (WAL mode).
const live = new DatabaseSync(path.join(DATA_DIR, 'bookmystall.db'));
live.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
live.close();

const db = new DatabaseSync(out);
db.exec(`
  PRAGMA journal_mode = DELETE;
  DELETE FROM notifications;
  DELETE FROM bookings;
  DELETE FROM sqlite_sequence WHERE name IN ('bookings', 'notifications');
  DELETE FROM settings WHERE key = 'secret';
`);
const used = new Set();
for (const r of db.prepare('SELECT banner, layout FROM events').all()) { if (r.banner) used.add(r.banner); if (r.layout) used.add(r.layout); }
const qr = db.prepare("SELECT value FROM settings WHERE key = 'payment_qr'").get()?.value;
if (qr) used.add(qr);
db.exec('VACUUM');
db.close();

for (const url of used) {
  const name = path.basename(url);
  fs.copyFileSync(path.join(DATA_DIR, 'uploads', name), path.join(SEED_DIR, 'uploads', name));
}
console.log(`Seed written: ${out}\nImages: ${[...used].map(u => path.basename(u)).join(', ')}`);
