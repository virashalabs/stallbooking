import { $, $$, api, esc, money, fmtRange, header, renderStage, toast, rememberBooking, VENUE_TYPES } from '/js/common.js';
import { refundDeadline } from '/js/site-data.js';
header('events');

const id = new URLSearchParams(location.search).get('id');
const DRAFT_KEY = 'bms_vendor_details';
let data = null;          // { event, stalls, site }
let selected = null;      // stall object
let details = null;       // vendor form values
let busy = false;

function setStep(n) {
  $$('#steps li').forEach(li => {
    const s = Number(li.dataset.step);
    li.classList.toggle('on', s === n);
    li.classList.toggle('done', s < n);
  });
}

async function load() {
  try {
    data = await api(`/api/events/${encodeURIComponent(id)}`);
  } catch (e) {
    $('#ev-title').textContent = 'Event not found';
    $('#details-form').classList.add('hidden');
    $('#about').classList.add('hidden');
    return;
  }
  const ev = data.event;
  document.title = `${ev.title} — Auto Expo Suburban Events`;
  $('#ev-title').textContent = ev.title;
  $('#ev-type').textContent = VENUE_TYPES[ev.venue_type] || 'Event';
  $('#ev-date').textContent = '📅 ' + fmtRange(ev.start_at, ev.end_at);
  $('#ev-venue').textContent = ev.venue ? '📍 ' + ev.venue : '';
  $('#ev-desc').textContent = ev.description || 'Details coming soon.';
  if (ev.banner) {
    $('#hero-bg').style.backgroundImage = `url('${ev.banner}')`;
    $('#poster').src = ev.banner;
    $('#poster-link').href = ev.banner;
    $('#poster-link').classList.remove('hidden');
  } else {
    $('#about-grid').style.gridTemplateColumns = '1fr';
  }
  $('#pricing').innerHTML = `<h3>Pricing</h3>
    <div class="summary-row"><span>Stall rent</span><b>from ${money(Math.min(...data.stalls.map(s => s.base), ev.base_rent))}</b></div>
    ${ev.corner_charge ? `<div class="summary-row"><span>★ Corner stall extra</span><b>+ ${money(ev.corner_charge)}</b></div>` : ''}
    <p class="muted" style="margin:8px 0 0">Your stall is held for ${data.site.hold_minutes} minutes while you pay. Final allotment happens after the organizer verifies your payment.</p>`;

  if (ev.status !== 'published') {
    $('#details-form').innerHTML = `<h2>Bookings closed</h2><p class="muted">The organizer is no longer accepting bookings for this event.</p>`;
    return;
  }
  // restore saved vendor details
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (saved) for (const [k, v] of Object.entries(saved)) if ($('#' + k)) $('#' + k).value = v;
  } catch { /* ignore */ }
  setStep(1);
  setInterval(refreshStalls, 6000);
}

function drawMap() {
  const ev = data.event;
  renderStage($('#stage'), ev, data.stalls, { selectedId: selected?.id, onPick: pick });
  $('#seats').innerHTML = data.stalls.map(s => {
    const avail = s.state === 'available';
    const sel = selected?.id === s.id;
    const note = avail ? money(s.total) : { held: 'Being booked', reserved: 'Reserved', booked: 'Booked', blocked: 'N/A' }[s.state];
    return `<button type="button" class="seat${s.is_corner ? ' corner' : ''}${sel ? ' selected' : ''}" data-id="${s.id}" ${avail ? '' : 'disabled'}
      aria-pressed="${sel}"><img class="sicon" src="/img/stall-icon-t.png" alt="" aria-hidden="true"><b>${s.is_corner ? '★ ' : ''}${esc(s.label)}</b><small>${esc(note)}</small></button>`;
  }).join('');
  $$('#seats .seat').forEach(b => b.addEventListener('click', () => pick(data.stalls.find(s => s.id === Number(b.dataset.id)))));
  if (!data.stalls.length) $('#seats').innerHTML = '<p class="muted">The organizer has not published the stalls yet.</p>';
}

function pick(stall) {
  selected = selected?.id === stall.id ? null : stall;
  drawMap();
  drawSummary();
}

let agreed = false;
function deadlineText(ev) {
  const d = refundDeadline(ev.start_at);
  if (!d) return 'Full refund if you cancel at least 7 days before the event. No refund after that.';
  const day = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return d.getTime() >= Date.now()
    ? `Full refund if you cancel on or before ${day} (7 days before the event). No refund after that.`
    : `The event is less than 7 days away, so this booking is non-refundable once paid.`;
}

function drawSummary() {
  const btn = $('#reserve'), bar = $('#bar');
  if (!selected) {
    $('#summary-body').innerHTML = details ? 'Select an available stall on the layout.' : 'Fill in your details, then select a stall on the layout.';
    btn.classList.add('hidden'); $('#hold-note').classList.add('hidden');
    bar.classList.remove('show'); document.body.classList.remove('has-bar');
    return;
  }
  const s = selected, ev = data.event;
  $('#summary-body').innerHTML = `
    <div class="summary-row"><span class="muted">Event</span><b style="text-align:right">${esc(ev.title)}</b></div>
    <div class="summary-row"><span class="muted">Business</span><b style="text-align:right">${esc(details.business_name)}</b></div>
    <div class="summary-row"><span class="muted">Stall</span><b>${esc(s.label)}${s.is_corner ? ' <span class="badge red">★ Corner</span>' : ''}</b></div>
    <div class="summary-row"><span class="muted">Stall rent</span><span>${money(s.base)}</span></div>
    ${s.corner ? `<div class="summary-row"><span class="muted">Corner charge</span><span>+ ${money(s.corner)}</span></div>` : ''}
    <div class="summary-row total"><span>Total</span><span>${money(s.total)}</span></div>
    <p class="muted small" style="margin:8px 0 0">🏷️ Have a promo code or coupon? Apply it on the payment step.</p>
    <div class="policy-box">
      <b>Cancellation &amp; refund</b>
      <span>${deadlineText(ev)}</span>
      <label class="check"><input type="checkbox" id="agree" ${agreed ? 'checked' : ''}> I agree to the <a href="/policy.html" target="_blank" rel="noopener">Cancellation &amp; Refund Policy</a></label>
    </div>`;
  $('#agree').addEventListener('change', e => { agreed = e.target.checked; $('#reserve').disabled = !agreed; });
  btn.disabled = !agreed;
  btn.classList.remove('hidden');
  $('#hold-note').textContent = `We'll hold stall ${s.label} for you for ${data.site.hold_minutes} minutes while you complete the payment.`;
  $('#hold-note').classList.remove('hidden');
  $('#bar-label').textContent = `Stall ${s.label}${s.is_corner ? ' ★' : ''} · ${money(s.total)}`;
  $('#bar-sub').textContent = s.corner ? `Includes ${money(s.corner)} corner charge` : 'Tap to reserve and pay';
  bar.classList.add('show'); document.body.classList.add('has-bar');
}

async function refreshStalls() {
  if (busy || !details) return;
  try {
    const fresh = await api(`/api/events/${encodeURIComponent(id)}`);
    data.stalls = fresh.stalls;
    if (selected) {
      const now = data.stalls.find(s => s.id === selected.id);
      if (!now || now.state !== 'available') {
        toast(`Stall ${selected.label} was just taken. Please choose another.`, 'error');
        selected = null;
        drawSummary();
      } else selected = now;
    }
    drawMap();
  } catch { /* transient */ }
}

$('#details-form').addEventListener('submit', e => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target).entries());
  for (const k in fd) fd[k] = String(fd[k]).trim();
  if (fd.phone.replace(/\D/g, '').length < 10) return toast('Please enter a valid WhatsApp number.', 'error');
  details = fd;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(fd)); } catch { /* ignore */ }
  e.target.classList.add('hidden');
  $('#map-card').classList.remove('hidden');
  setStep(2);
  drawMap(); drawSummary();
  refreshStalls();
  $('#map-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#edit-details').addEventListener('click', () => {
  $('#details-form').classList.remove('hidden');
  $('#map-card').classList.add('hidden');
  setStep(1);
});

async function reserve() {
  if (!selected || busy) return;
  if (!agreed) {
    toast('Please accept the Cancellation & Refund Policy to continue.', 'error');
    $('#summary').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  busy = true;
  $('#reserve').disabled = $('#bar-btn').disabled = true;
  try {
    const r = await api(`/api/events/${encodeURIComponent(id)}/hold`, { method: 'POST', body: { ...details, stall_id: selected.id, accept_policy: true } });
    rememberBooking({ id: r.booking_id, token: r.token, stall: selected.label, event: data.event.title, business: details.business_name });
    location.href = `/booking.html?id=${r.booking_id}&t=${encodeURIComponent(r.token)}`;
  } catch (e) {
    toast(e.message, 'error');
    busy = false;
    $('#reserve').disabled = $('#bar-btn').disabled = false;
    selected = null;
    await refreshStalls();
    drawSummary();
  }
}
$('#reserve').addEventListener('click', reserve);
$('#bar-btn').addEventListener('click', reserve);

load();
