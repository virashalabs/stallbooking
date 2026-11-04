import { $, api, esc, money, fmtRange, header, toast, statusBadge, rememberBooking, forgetBookings, isGone } from '/js/common.js';
header('mine');

const q = new URLSearchParams(location.search);
const id = q.get('id'), token = q.get('t');
const box = $('#ticket');
let timer = null, poll = null, lastKey = null;

const fmtDay = ms => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

async function load(force = false) {
  let d;
  try {
    d = await api(`/api/bookings/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`);
  } catch (e) {
    box.innerHTML = `<h2>Booking not found</h2><p class="muted">This link is invalid. <a href="/">Browse events</a></p>`;
    return;
  }
  const { booking: b, event: ev } = d;
  if (isGone(b)) forgetBookings([b.id]);
  else rememberBooking({ id: b.id, token, stall: b.stall_label, event: ev.title, business: b.business_name });
  const key = [b.status, b.amount, b.cancel_requested_at, b.refunded_at].join('|');
  if (!force && key === lastKey && b.status !== 'held') return; // nothing changed while polling
  lastKey = key;
  clearInterval(timer);
  clearInterval(poll);
  if (b.status === 'held') renderPay(d);
  else renderStatus(d);
  if (b.status === 'pending' || b.cancel_requested_at) poll = setInterval(load, 15000);
}

const priceRows = b => `
  <dt>Stall price</dt><dd>${money(b.gross_amount)}${b.corner_amount ? ` <span class="muted small">(${money(b.base_amount)} + ${money(b.corner_amount)} corner)</span>` : ''}</dd>
  ${b.promo_discount ? `<dt>Promo ${esc(b.promo_code)}</dt><dd class="discount">− ${money(b.promo_discount)}</dd>` : ''}
  ${b.coupon_discount ? `<dt>Coupon ${esc(b.coupon_code)}</dt><dd class="discount">− ${money(b.coupon_discount)}</dd>` : ''}
  <dt>${b.status === 'held' ? 'To pay' : 'Amount paid'}</dt><dd><b>${money(b.amount)}</b></dd>`;

const details = (b, ev) => `<dl class="kv">
  <dt>Booking ID</dt><dd>AESE-${b.id}</dd>
  <dt>Event</dt><dd>${esc(ev.title)}</dd>
  <dt>When</dt><dd>${esc(fmtRange(ev.start_at, ev.end_at))}</dd>
  ${ev.venue ? `<dt>Venue</dt><dd>${esc(ev.venue)}</dd>` : ''}
  <dt>Stall</dt><dd>${esc(b.stall_label)}${b.corner_amount ? ' <span class="badge red">★ Corner</span>' : ''}</dd>
  <dt>Business</dt><dd>${esc(b.business_name)}</dd>
  <dt>Products</dt><dd>${esc(b.products)}</dd>
  <dt>Contact</dt><dd>${esc(b.contact_name)} · +${esc(b.phone)}</dd>
  ${priceRows(b)}
  ${b.utr ? `<dt>UTR / Ref</dt><dd>${esc(b.utr)}</dd>` : ''}
</dl>`;

function policyNote(d) {
  const { policy } = d;
  if (!policy.refund_deadline) return 'Full refund if you cancel at least 7 days before the event. No refund after that.';
  return policy.full_refund_now
    ? `Full refund if you cancel on or before <b>${fmtDay(policy.refund_deadline)}</b>. No refund after that.`
    : 'The event is less than 7 days away, so this booking is <b>non-refundable</b>.';
}

// ------------------------------------------------------------------ checkout (stall held)
function renderPay(d) {
  const { booking: b, event: ev, payment: p } = d;
  const offset = d.server_time - Date.now();
  const free = b.amount <= 0;
  let qr = '';
  if (!free) {
    const upiBtn = p?.upi_link ? `<a class="btn ghost sm" href="${esc(p.upi_link)}">Pay ${money(b.amount)} in UPI app (on phone)</a>` : '';
    qr = p?.static_qr
      ? `<img src="${esc(p.static_qr)}" alt="Payment QR code" style="image-rendering:auto;width:300px">
         <div class="alert" style="margin:0">Enter the amount <b>${money(b.amount)}</b> when you scan</div>
         ${p.upi_id ? `<div class="muted small">UPI ID: <b>${esc(p.upi_id)}</b></div>` : ''}
         ${upiBtn}`
      : p?.qr
        ? `<img src="${p.qr}" alt="UPI payment QR code for ${money(b.amount)}">
           <div><b>${esc(p.payee)}</b><div class="muted small">UPI ID: ${esc(p.upi_id)}</div></div>
           ${upiBtn}`
        : `<p class="muted">The organizer hasn't set up a payment QR yet. Please contact them for payment details.</p>`;
  }
  const chip = (kind, code, amt) => code
    ? `<span class="code-chip">🏷️ <b>${esc(code)}</b> −${money(amt)} <button type="button" data-remove="${kind}" aria-label="Remove ${esc(code)}">✕</button></span>` : '';

  box.innerHTML = `
    <div class="timer"><span>⏳ Stall ${esc(b.stall_label)} is held for you</span><span class="t" id="t">--:--</span></div>
    <h2>${free ? 'No payment needed 🎉' : `Pay ${money(b.amount)} to confirm`}</h2>
    ${b.promo_discount || b.coupon_discount ? `<p class="saved">You save ${money(b.promo_discount + b.coupon_discount)} on this stall!</p>` : ''}

    <form class="code-box" id="code-form">
      <label for="code"><b>Promo code / coupon</b></label>
      <div class="row" style="flex-wrap:nowrap">
        <input id="code" type="text" maxlength="20" placeholder="Enter code" autocomplete="off" style="text-transform:uppercase">
        <button class="btn sm" type="submit">Apply</button>
      </div>
      <div class="row" style="gap:6px;margin-top:8px">${chip('promo', b.promo_code, b.promo_discount)}${chip('coupon', b.coupon_code, b.coupon_discount)}</div>
      <span class="hint">You can use one promo code plus one personal coupon from the organizer.</span>
    </form>

    ${free ? '' : `<p class="muted small" style="margin:14px 0 0">Scan the QR with any UPI app (GPay, PhonePe, Paytm, BHIM). Add <b>${esc(p?.note || '')}</b> as the note if asked.</p>
    <div class="qr-box">${qr}</div>`}
    ${p?.instructions ? `<div class="alert info">${esc(p.instructions)}</div>` : ''}
    ${details(b, ev)}
    <div class="policy-box"><b>Cancellation &amp; refund</b><span>${policyNote(d)} <a href="/policy.html" target="_blank" rel="noopener">Read the full policy</a></span></div>
    <form id="paid-form" style="margin-top:18px">
      ${free ? '' : `<div class="field"><label for="utr">UPI transaction ID / UTR (recommended)</label>
        <input id="utr" type="text" maxlength="60" placeholder="12-digit UTR from your UPI app"><span class="hint">Helps the organizer verify your payment faster.</span></div>`}
      <button class="btn green block" type="submit">${free ? '✓ Confirm my booking' : '✓ I have made the payment'}</button>
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

  $('#code-form').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('#code').value.trim();
    if (!code) return;
    try {
      const r = await api(`/api/bookings/${b.id}/code`, { method: 'POST', body: { token, code } });
      toast(r.message, 'ok');
      load(true);
    } catch (err) { toast(err.message, 'error'); }
  });
  box.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', async () => {
    try { await api(`/api/bookings/${b.id}/code/remove`, { method: 'POST', body: { token, kind: btn.dataset.remove } }); load(true); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $('#paid-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api(`/api/bookings/${b.id}/paid`, { method: 'POST', body: { token, utr: $('#utr')?.value || '' } });
      toast(free ? 'Booking submitted. The organizer has been notified.' : 'Payment submitted. The organizer has been notified.', 'ok');
      load(true);
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

// ------------------------------------------------------------------ after submission
function refundText(b) {
  if (b.refunded_at) return `A refund of <b>${money(b.refund_amount)}</b> was processed on ${fmtDay(b.refunded_at)}.`;
  if (!b.paid_at || !b.amount) return '';
  return b.refund_eligible
    ? `Your cancellation was requested in time, so you are eligible for a <b>full refund of ${money(b.amount)}</b>. It is normally processed within 7–10 working days.`
    : 'Your cancellation was requested less than 7 days before the event, so it is <b>not eligible for a refund</b> under the policy.';
}

function renderStatus(d) {
  const { booking: b, event: ev, organizer } = d;
  const paidCancel = b.status === 'cancelled' && b.paid_at;
  const views = {
    pending: ['⏳', 'var(--amber-soft)', 'Payment submitted', `Your request for stall <b>${esc(b.stall_label)}</b> has been sent to ${esc(organizer.name || 'the organizer')}. The stall is reserved for you while they verify the payment. This page updates automatically.`],
    approved: ['✓', 'var(--green-soft)', 'Stall confirmed!', `Stall <b>${esc(b.stall_label)}</b> is assigned to <b>${esc(b.business_name)}</b>. Show this stall booking at the venue.`],
    rejected: ['✕', 'var(--red-soft)', 'Booking not approved', `The organizer could not approve this booking.${b.admin_note ? ` Reason: <b>${esc(b.admin_note)}</b>` : ''} ${b.refunded_at ? refundText(b) : 'If you have paid, the full amount will be refunded.'}`],
    expired: ['⌛', 'var(--grey-soft)', 'Hold expired', 'The payment window ended before the booking was submitted, so the stall was released.'],
    cancelled: paidCancel
      ? ['↺', 'var(--grey-soft)', 'Booking cancelled', `${b.admin_note ? `Note from the organizer: <b>${esc(b.admin_note)}</b>. ` : ''}${refundText(b)}`]
      : ['↺', 'var(--grey-soft)', 'Hold cancelled', 'You released this stall.'],
  };
  let [icon, bg, title, text] = views[b.status] || ['•', 'var(--grey-soft)', b.status, ''];
  const requested = b.cancel_requested_at && ['pending', 'approved'].includes(b.status);
  if (requested) {
    [icon, bg, title] = ['↺', 'var(--amber-soft)', 'Cancellation requested'];
    text = `You asked to cancel stall <b>${esc(b.stall_label)}</b> on ${fmtDay(b.cancel_requested_at)}. The organizer will confirm it shortly. ` +
      (b.refund_eligible ? `You are eligible for a <b>full refund of ${money(b.amount)}</b>.` : 'This request was made less than 7 days before the event, so it is <b>not eligible for a refund</b>.');
  }
  const canCancel = ['pending', 'approved'].includes(b.status) && !b.cancel_requested_at;
  const waLabel = requested ? 'Send cancellation request on WhatsApp' : 'Notify organizer on WhatsApp';

  box.innerHTML = `
    <div class="status-hero">
      <div class="icon" style="background:${bg}">${icon}</div>
      <h2>${title}</h2>
      <p class="muted" style="margin:0 auto;max-width:440px">${text}</p>
    </div>
    <div class="ticket-stub">
      <div class="row between" style="margin-bottom:10px"><b>Booking details</b>${requested ? '<span class="badge amber">Cancellation requested</span>' : statusBadge(b.status)}</div>
      ${details(b, ev)}
      ${b.refunded_at ? `<div class="alert info" style="margin:12px 0 0">Refunded ${money(b.refund_amount)} on ${fmtDay(b.refunded_at)}</div>` : ''}
    </div>
    ${['pending', 'approved'].includes(b.status) && !requested ? `<div class="policy-box no-print"><b>Cancellation &amp; refund</b><span>${policyNote(d)} <a href="/policy.html" target="_blank" rel="noopener">Read the full policy</a></span></div>` : ''}
    <div class="row no-print" style="margin-top:20px">
      ${organizer.whatsapp_link ? `<a class="btn wa" href="${esc(organizer.whatsapp_link)}" target="_blank" rel="noopener">${waLabel}</a>` : ''}
      ${b.status === 'approved' ? `<button class="btn ghost" onclick="print()">Print / save stall booking</button>` : ''}
      ${['expired', 'rejected'].includes(b.status) || (b.status === 'cancelled' && !paidCancel) ? `<a class="btn primary" href="/event.html?id=${ev.id}">Choose a stall again</a>` : ''}
      ${canCancel ? `<button class="btn danger" id="req-cancel">Request cancellation</button>` : ''}
      <a class="btn ghost" href="/">All events</a>
    </div>`;

  $('#req-cancel')?.addEventListener('click', async () => {
    const warn = d.policy.full_refund_now
      ? `You are within the refund window, so you will be eligible for a FULL refund of ${money(b.amount)}.`
      : 'The event is less than 7 days away. Under the policy this cancellation will NOT be refunded.';
    const reason = prompt(`Cancel stall ${b.stall_label} for "${ev.title}"?\n\n${warn}\n\nReason for cancelling (optional):`, '');
    if (reason === null) return;
    try {
      await api(`/api/bookings/${b.id}/cancel-request`, { method: 'POST', body: { token, reason } });
      toast('Cancellation request sent to the organizer.', 'ok');
      load(true);
    } catch (err) { toast(err.message, 'error'); }
  });
}

load();
