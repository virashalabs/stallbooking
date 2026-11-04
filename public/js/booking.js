import { $, api, esc, money, fmtRange, header, toast, statusBadge, rememberBooking, forgetBookings, GONE } from '/js/common.js';
header('mine');

const q = new URLSearchParams(location.search);
const id = q.get('id'), token = q.get('t');
const box = $('#ticket');
let timer = null, poll = null, lastStatus = null;

async function load() {
  let d;
  try {
    d = await api(`/api/bookings/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`);
  } catch (e) {
    box.innerHTML = `<h2>Booking not found</h2><p class="muted">This link is invalid. <a href="/">Browse events</a></p>`;
    return;
  }
  const { booking: b, event: ev } = d;
  if (GONE.includes(b.status)) forgetBookings([b.id]);
  else rememberBooking({ id: b.id, token, stall: b.stall_label, event: ev.title, business: b.business_name });
  if (b.status === lastStatus && b.status !== 'held') return; // nothing changed while polling
  lastStatus = b.status;
  clearInterval(timer);
  clearInterval(poll);
  if (b.status === 'held') renderPay(d);
  else renderStatus(d);
  if (b.status === 'pending') poll = setInterval(load, 10000);
}

const details = (b, ev) => `<dl class="kv">
  <dt>Booking ID</dt><dd>AESE-${b.id}</dd>
  <dt>Event</dt><dd>${esc(ev.title)}</dd>
  <dt>When</dt><dd>${esc(fmtRange(ev.start_at, ev.end_at))}</dd>
  ${ev.venue ? `<dt>Venue</dt><dd>${esc(ev.venue)}</dd>` : ''}
  <dt>Stall</dt><dd>${esc(b.stall_label)}${b.corner_amount ? ' <span class="badge red">★ Corner</span>' : ''}</dd>
  <dt>Business</dt><dd>${esc(b.business_name)}</dd>
  <dt>Products</dt><dd>${esc(b.products)}</dd>
  <dt>Contact</dt><dd>${esc(b.contact_name)} · +${esc(b.phone)}</dd>
  <dt>Amount</dt><dd>${money(b.amount)}${b.corner_amount ? ` <span class="muted small">(${money(b.base_amount)} + ${money(b.corner_amount)} corner)</span>` : ''}</dd>
  ${b.utr ? `<dt>UTR / Ref</dt><dd>${esc(b.utr)}</dd>` : ''}
</dl>`;

function renderPay(d) {
  const { booking: b, event: ev, payment: p } = d;
  const offset = d.server_time - Date.now();
  // The organizer's own uploaded QR takes priority; the UPI-ID link pre-fills the amount on phones.
  const upiBtn = p.upi_link ? `<a class="btn ghost sm" href="${esc(p.upi_link)}">Pay ${money(b.amount)} in UPI app (on phone)</a>` : '';
  const qr = p.static_qr
    ? `<img src="${esc(p.static_qr)}" alt="Payment QR code" style="image-rendering:auto;width:300px">
       <div class="alert" style="margin:0">Enter the amount <b>${money(b.amount)}</b> when you scan</div>
       ${p.upi_id ? `<div class="muted small">UPI ID: <b>${esc(p.upi_id)}</b></div>` : ''}
       ${upiBtn}`
    : p.qr
      ? `<img src="${p.qr}" alt="UPI payment QR code for ${money(b.amount)}">
         <div><b>${esc(p.payee)}</b><div class="muted small">UPI ID: ${esc(p.upi_id)}</div></div>
         ${upiBtn}`
      : `<p class="muted">The organizer hasn't set up a payment QR yet. Please contact them for payment details.</p>`;
  box.innerHTML = `
    <div class="timer"><span>⏳ Stall ${esc(b.stall_label)} is held for you</span><span class="t" id="t">--:--</span></div>
    <h2>Pay ${money(b.amount)} to confirm</h2>
    <p class="muted small" style="margin-top:0">Scan the QR with any UPI app (GPay, PhonePe, Paytm, BHIM). Add <b>${esc(p.note)}</b> as the note if asked.</p>
    <div class="qr-box">${qr}</div>
    ${p.instructions ? `<div class="alert info">${esc(p.instructions)}</div>` : ''}
    ${details(b, ev)}
    <form id="paid-form" style="margin-top:18px">
      <div class="field"><label for="utr">UPI transaction ID / UTR (recommended)</label>
        <input id="utr" type="text" maxlength="60" placeholder="12-digit UTR from your UPI app"><span class="hint">Helps the organizer verify your payment faster.</span></div>
      <button class="btn green block" type="submit">✓ I have made the payment</button>
    </form>
    <button class="btn danger block" id="cancel" style="margin-top:10px">Cancel &amp; choose another stall</button>`;

  const tick = () => {
    const left = Math.max(0, b.hold_expires_at - (Date.now() + offset));
    const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
    $('#t').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (left <= 0) {
      clearInterval(timer);
      $('.timer').innerHTML = `<span>Hold time is over. If you've already paid, submit anyway — we'll confirm if the stall is still free.</span>`;
    }
  };
  tick();
  timer = setInterval(tick, 1000);

  $('#paid-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api(`/api/bookings/${b.id}/paid`, { method: 'POST', body: { token, utr: $('#utr').value } });
      toast('Payment submitted. The organizer has been notified.', 'ok');
      lastStatus = null;
      load();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });
  $('#cancel').addEventListener('click', async () => {
    if (!confirm(`Release stall ${b.stall_label}? Only do this if you haven't paid.`)) return;
    try {
      await api(`/api/bookings/${b.id}/cancel`, { method: 'POST', body: { token } });
      location.href = `/event.html?id=${ev.id}`;
    } catch (err) { toast(err.message, 'error'); }
  });
}

function renderStatus(d) {
  const { booking: b, event: ev, organizer } = d;
  const views = {
    pending: ['⏳', 'var(--amber-soft)', 'Payment submitted', `Your request for stall <b>${esc(b.stall_label)}</b> has been sent to ${esc(organizer.name || 'the organizer')}. The stall is reserved for you while they verify the payment. This page updates automatically.`],
    approved: ['✓', 'var(--green-soft)', 'Stall confirmed!', `Stall <b>${esc(b.stall_label)}</b> is assigned to <b>${esc(b.business_name)}</b>. Show this ticket at the venue.`],
    rejected: ['✕', 'var(--red-soft)', 'Booking not approved', `The organizer could not approve this booking.${b.admin_note ? ` Reason: <b>${esc(b.admin_note)}</b>` : ''} If you have paid, please contact the organizer for a refund.`],
    expired: ['⌛', 'var(--grey-soft)', 'Hold expired', 'The payment window ended before the booking was submitted, so the stall was released.'],
    cancelled: ['↺', 'var(--grey-soft)', 'Hold cancelled', 'You released this stall.'],
  };
  const [icon, bg, title, text] = views[b.status] || ['•', 'var(--grey-soft)', b.status, ''];
  box.innerHTML = `
    <div class="status-hero">
      <div class="icon" style="background:${bg}">${icon}</div>
      <h2>${title}</h2>
      <p class="muted" style="margin:0 auto;max-width:420px">${text}</p>
    </div>
    <div class="ticket-stub">
      <div class="row between" style="margin-bottom:10px"><b>Booking details</b>${statusBadge(b.status)}</div>
      ${details(b, ev)}
    </div>
    <div class="row no-print" style="margin-top:20px">
      ${organizer.whatsapp_link ? `<a class="btn wa" href="${esc(organizer.whatsapp_link)}" target="_blank" rel="noopener">Notify organizer on WhatsApp</a>` : ''}
      ${b.status === 'approved' ? `<button class="btn ghost" onclick="print()">Print / save ticket</button>` : ''}
      ${['expired', 'cancelled', 'rejected'].includes(b.status) ? `<a class="btn primary" href="/event.html?id=${ev.id}">Choose a stall again</a>` : ''}
      <a class="btn ghost" href="/">All events</a>
    </div>`;
}

load();
