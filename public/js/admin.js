import { $, $$, api, esc, money, fmtRange, ago, toast, statusBadge, BRAND_SVG, VENUE_TYPES, wireThemeToggle } from '/js/common.js';
wireThemeToggle(document.getElementById('theme-btn'));

$('#brand-mark').innerHTML = BRAND_SVG;
let events = [];
let currentTab = 'dash';
let lastUnread = -1;

// ------------------------------------------------------------------ auth
async function boot() {
  const { admin } = await api('/api/admin/me');
  $('#login').classList.toggle('hidden', admin);
  $('#app').classList.toggle('hidden', !admin);
  $('#admin-nav').classList.toggle('hidden', !admin);
  if (admin) {
    showTab(location.hash.slice(1) || 'dash');
    pollNotifications();
    setInterval(pollNotifications, 10000);
  }
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/admin/login', { method: 'POST', body: { username: $('#user').value, password: $('#pw').value } }); location.reload(); }
  catch (err) { toast(err.message, 'error'); }
});
$('#logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); location.reload(); });

// ------------------------------------------------------------------ tabs
function showTab(tab) {
  if (!['dash', 'events', 'bookings', 'settings'].includes(tab)) tab = 'dash';
  currentTab = tab;
  history.replaceState(null, '', '#' + tab);
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tab));
  if (tab === 'dash') loadDash();
  if (tab === 'events') { closeEditor(); loadEvents(); }
  if (tab === 'bookings') loadBookings();
  if (tab === 'settings') loadSettings();
}
$$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ------------------------------------------------------------------ notifications
async function pollNotifications() {
  try {
    const n = await api('/api/admin/notifications');
    const dot = $('#bell-dot');
    dot.textContent = n.unread; dot.classList.toggle('hidden', !n.unread);
    const pc = $('#pending-count');
    pc.textContent = n.pending; pc.classList.toggle('hidden', !n.pending);
    if (lastUnread >= 0 && n.unread > lastUnread && n.items[0]) {
      toast('🔔 ' + n.items[0].message.slice(0, 120), 'ok');
      if (currentTab === 'dash') loadDash();
      if (currentTab === 'bookings') loadBookings();
    }
    lastUnread = n.unread;
    $('#notif-panel').innerHTML = n.items.length
      ? n.items.map(i => `<div class="n ${i.is_read ? '' : 'unread'}">${esc(i.message)}<time>${ago(i.created_at)}${i.whatsapp_sent ? ' · sent to WhatsApp ✓' : ''}</time></div>`).join('')
      : '<div class="n muted">No notifications yet.</div>';
  } catch (e) { if (e.status === 401) location.reload(); }
}
$('#bell').addEventListener('click', async e => {
  e.stopPropagation();
  const p = $('#notif-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden') && lastUnread > 0) {
    await api('/api/admin/notifications/read', { method: 'POST' });
    lastUnread = 0;
    $('#bell-dot').classList.add('hidden');
  }
});
document.addEventListener('click', e => { if (!e.target.closest('#notif-panel')) $('#notif-panel').classList.add('hidden'); });

// ------------------------------------------------------------------ booking cards
function bookingCard(b) {
  const acts = [];
  if (['pending', 'held'].includes(b.status)) acts.push(`<button class="btn green sm" data-act="approve" data-id="${b.id}">✓ Approve</button>`);
  if (['pending', 'held'].includes(b.status)) acts.push(`<button class="btn danger sm" data-act="reject" data-id="${b.id}">Reject</button>`);
  if (b.status === 'approved') acts.push(`<button class="btn danger sm" data-act="reject" data-id="${b.id}">Release stall</button>`);
  acts.push(`<a class="btn wa sm" href="${esc(b.wa_vendor)}" target="_blank" rel="noopener">WhatsApp vendor</a>`);
  if (b.wa_organizer) acts.push(`<a class="btn ghost sm" href="${esc(b.wa_organizer)}" target="_blank" rel="noopener" title="Send these vendor details to your own WhatsApp">Send details to my WhatsApp</a>`);
  acts.push(`<button class="btn ghost sm" data-act="copy" data-id="${b.id}">Copy details</button>`);
  return `<div class="bk ${b.status}">
    <div>
      <div class="row" style="gap:8px;margin-bottom:4px"><h3>Stall ${esc(b.stall_label)} · ${esc(b.business_name)}</h3>${statusBadge(b.status)}${b.corner_amount ? '<span class="badge red">★ Corner</span>' : ''}</div>
      <div class="small"><b>${esc(b.event_title)}</b> · AESE-${b.id}</div>
      <div class="small" style="margin-top:6px">🛍️ ${esc(b.products)}</div>
      <div class="small muted" style="margin-top:4px">👤 ${esc(b.contact_name)} · 📱 +${esc(b.phone)}${b.email ? ' · ✉️ ' + esc(b.email) : ''}</div>
      <div class="small" style="margin-top:6px"><b>${money(b.amount)}</b>${b.corner_amount ? ` <span class="muted">(${money(b.base_amount)} + ${money(b.corner_amount)} corner)</span>` : ''}
        ${b.utr ? ` · UTR <b>${esc(b.utr)}</b>` : ''}
        <span class="muted"> · ${b.paid_at ? 'paid ' + ago(b.paid_at) : 'requested ' + ago(b.created_at)}</span></div>
      ${b.admin_note ? `<div class="small muted">Note: ${esc(b.admin_note)}</div>` : ''}
    </div>
    <div class="acts">${acts.join('')}</div>
  </div>`;
}
let bookingCache = new Map();
function wireBookingActions(root, reload) {
  root.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', async () => {
    const b = bookingCache.get(Number(btn.dataset.id));
    if (btn.dataset.act === 'copy') {
      try { await navigator.clipboard.writeText(b.details_text); toast('Vendor details copied', 'ok'); }
      catch { prompt('Copy the details:', b.details_text); }
      return;
    }
    if (btn.dataset.act === 'approve') {
      if (!confirm(`Approve stall ${b.stall_label} for ${b.business_name}?\nConfirm you have received ${money(b.amount)}${b.utr ? ` (UTR ${b.utr})` : ''}.`)) return;
      try {
        await api(`/api/admin/bookings/${b.id}/approve`, { method: 'POST' });
        toast(`Stall ${b.stall_label} assigned to ${b.business_name}`, 'ok');
      } catch (e) { toast(e.message, 'error'); }
    }
    if (btn.dataset.act === 'reject') {
      const note = prompt(`${b.status === 'approved' ? 'Release' : 'Reject'} stall ${b.stall_label} for ${b.business_name}? The stall becomes available again.\n\nReason (shown to vendor, optional):`, '');
      if (note === null) return;
      try { await api(`/api/admin/bookings/${b.id}/reject`, { method: 'POST', body: { note } }); toast('Booking rejected — stall released'); }
      catch (e) { toast(e.message, 'error'); }
    }
    reload();
    pollNotifications();
  }));
}

// ------------------------------------------------------------------ dashboard
async function loadDash() {
  const [evs, bookings, settings] = await Promise.all([api('/api/admin/events'), api('/api/admin/bookings'), api('/api/admin/settings')]);
  events = evs;
  bookings.forEach(b => bookingCache.set(b.id, b));
  const approved = bookings.filter(b => b.status === 'approved');
  const pending = bookings.filter(b => b.status === 'pending');
  $('#stats').innerHTML = [
    ['Awaiting approval', pending.length],
    ['Stalls confirmed', approved.length],
    ['Confirmed revenue', money(approved.reduce((a, b) => a + b.amount, 0))],
    ['Live events', evs.filter(e => e.status === 'published').length],
  ].map(([k, v]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
  const alerts = [];
  if (settings.default_password) alerts.push('You are using the default password. Change it in <a href="#settings" data-go="settings">Settings</a>.');
  if (!settings.upi_id && !settings.payment_qr) alerts.push('Add your UPI ID in <a href="#settings" data-go="settings">Settings</a> so vendors see a payment QR.');
  if (!settings.organizer_whatsapp) alerts.push('Add your WhatsApp number in <a href="#settings" data-go="settings">Settings</a> to receive booking alerts.');
  $('#setup-alerts').innerHTML = alerts.map(a => `<div class="alert">${a}</div>`).join('');
  $$('#setup-alerts [data-go]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showTab(a.dataset.go); }));
  const list = $('#pending-list');
  list.innerHTML = pending.length ? pending.map(bookingCard).join('') : '<div class="card empty">No payments waiting for approval. 🎉</div>';
  wireBookingActions(list, loadDash);
}

// ------------------------------------------------------------------ bookings tab
async function loadBookings() {
  if (!events.length) events = await api('/api/admin/events');
  const sel = $('#bf-event');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All events</option>' + events.map(e => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  sel.value = keep;
  const qs = new URLSearchParams({ event: sel.value, status: $('#bf-status').value });
  const rows = await api('/api/admin/bookings?' + qs);
  rows.forEach(b => bookingCache.set(b.id, b));
  const list = $('#bookings-list');
  list.innerHTML = rows.length ? rows.map(bookingCard).join('') : '<div class="card empty">No bookings match.</div>';
  wireBookingActions(list, loadBookings);
}
$('#bf-event').addEventListener('change', loadBookings);
$('#bf-status').addEventListener('change', loadBookings);

// ------------------------------------------------------------------ events list
async function loadEvents() {
  events = await api('/api/admin/events');
  const box = $('#admin-events');
  box.innerHTML = events.length ? events.map(ev => {
    const st = { published: ['Published', 'green'], draft: ['Draft', 'grey'], closed: ['Closed', 'amber'] }[ev.status];
    return `<div class="event-card" data-id="${ev.id}" tabindex="0" role="button">
      <div class="banner ${ev.banner || ev.layout ? '' : 'banner-placeholder'}" ${ev.banner || ev.layout ? `style="background-image:url('${esc(ev.banner || ev.layout)}')"` : ''}>
        ${ev.banner || ev.layout ? '' : esc(ev.title.slice(0, 24))}<span class="badge ${st[1]}">${st[0]}</span></div>
      <div class="body">
        <h3>${esc(ev.title)}</h3>
        <div class="meta"><span>📅 ${esc(fmtRange(ev.start_at, ev.end_at))}</span><span>📍 ${esc(ev.venue || '—')} · ${esc(VENUE_TYPES[ev.venue_type])}</span></div>
        <div class="foot small">
          <span>${ev.stall_count} stalls · <b>${ev.available_count}</b> free</span>
          <span>${ev.bookings.pending ? `<span class="badge blue">${ev.bookings.pending} pending</span>` : ''} <span class="badge green">${ev.bookings.approved || 0} booked</span></span>
        </div>
      </div></div>`;
  }).join('') : '<div class="card empty" style="grid-column:1/-1">No events yet. Post your first one!</div>';
  $$('#admin-events .event-card').forEach(c => {
    const open = () => openEditor(Number(c.dataset.id));
    c.addEventListener('click', open);
    c.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  });
}

// ------------------------------------------------------------------ event editor
let editingId = null;
let edEvent = null, edStalls = [], selIdx = -1, adding = false, dirty = false;

function closeEditor() {
  $('#event-editor').classList.add('hidden');
  $('#events-list-view').classList.remove('hidden');
}
$('#back-events').addEventListener('click', () => {
  if (dirty && !confirm('You have unsaved stall changes. Leave anyway?')) return;
  dirty = false; closeEditor(); loadEvents();
});
$('#new-event').addEventListener('click', () => openEditor(null));

function setPreview(img, wrap, url) {
  img.classList.toggle('hidden', !url);
  if (url) img.src = url;
  wrap.classList.toggle('hidden', !url);
  wrap.querySelector('input').checked = false;
}
$('#f-banner').addEventListener('change', e => { const f = e.target.files[0]; if (f) { $('#banner-prev').src = URL.createObjectURL(f); $('#banner-prev').classList.remove('hidden'); } });
$('#f-layout').addEventListener('change', e => { const f = e.target.files[0]; if (f) { $('#layout-prev').src = URL.createObjectURL(f); $('#layout-prev').classList.remove('hidden'); } });

async function openEditor(id) {
  editingId = id; dirty = false; selIdx = -1; adding = false;
  $('#events-list-view').classList.add('hidden');
  $('#event-editor').classList.remove('hidden');
  const form = $('#event-form');
  form.reset();
  $('#f-banner').value = ''; $('#f-layout').value = '';
  if (!id) {
    $('#ef-title').textContent = 'Post a new event';
    $('#delete-event').classList.add('hidden');
    $('#stall-editor').classList.add('hidden');
    setPreview($('#banner-prev'), $('#rm-banner-wrap'), null);
    setPreview($('#layout-prev'), $('#rm-layout-wrap'), null);
    $('#f-corner').value = 0;
    return;
  }
  const d = await api(`/api/admin/events/${id}`);
  edEvent = d.event;
  const ev = d.event;
  $('#ef-title').textContent = 'Edit event';
  $('#f-title').value = ev.title; $('#f-venue').value = ev.venue; $('#f-type').value = ev.venue_type;
  $('#f-start').value = ev.start_at || ''; $('#f-end').value = ev.end_at || '';
  $('#f-rent').value = ev.base_rent; $('#f-corner').value = ev.corner_charge;
  $('#f-desc').value = ev.description; $('#f-status').value = ev.status;
  setPreview($('#banner-prev'), $('#rm-banner-wrap'), ev.banner);
  setPreview($('#layout-prev'), $('#rm-layout-wrap'), ev.layout);
  $('#delete-event').classList.remove('hidden');
  $('#stall-editor').classList.remove('hidden');
  edStalls = d.stalls;
  drawEditor();
}

$('#event-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (!fd.get('banner')?.size) fd.delete('banner');
  if (!fd.get('layout')?.size) fd.delete('layout');
  const btn = $('#save-event'); btn.disabled = true;
  try {
    if (editingId) {
      await api(`/api/admin/events/${editingId}`, { method: 'PUT', form: fd });
      toast('Event saved', 'ok');
      const keepStalls = dirty ? edStalls : null;
      await openEditor(editingId);
      if (keepStalls) { edStalls = keepStalls; dirty = true; drawEditor(); }
    } else {
      const r = await api('/api/admin/events', { method: 'POST', form: fd });
      toast('Event posted! Now add the stalls.', 'ok');
      await openEditor(r.id);
      $('#stall-editor').scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) { toast(err.message, 'error'); }
  btn.disabled = false;
});

$('#delete-event').addEventListener('click', async () => {
  if (!confirm(`Delete "${edEvent.title}" and ALL its stalls and bookings? This cannot be undone.`)) return;
  await api(`/api/admin/events/${editingId}`, { method: 'DELETE' });
  toast('Event deleted');
  dirty = false; closeEditor(); loadEvents();
});

// ----- stall layout editor
const stage = $('#ed-stage');
function nextLabel() {
  const nums = edStalls.map(s => parseInt(s.label, 10)).filter(n => !isNaN(n));
  return String(nums.length ? Math.max(...nums) + 1 : 1);
}
function priceOf(s) {
  const base = s.custom_price === '' || s.custom_price == null ? edEvent.base_rent : Number(s.custom_price);
  return base + (s.is_corner ? edEvent.corner_charge : 0);
}

function drawEditor() {
  stage.innerHTML = '';
  stage.classList.toggle('blank', !edEvent.layout);
  stage.classList.toggle('adding', adding);
  $('#add-stall').textContent = adding ? 'Click on layout… (Esc to stop)' : '+ Add stall';
  if (edEvent.layout) {
    const img = document.createElement('img');
    img.className = 'layout'; img.src = edEvent.layout; img.alt = 'Layout';
    stage.append(img);
  }
  edStalls.forEach((s, i) => {
    const el = document.createElement('div');
    const st = s.state && s.state !== 'available' ? s.state : '';
    el.className = `stall ${st || 'available'}${s.is_corner ? ' corner' : ''}${i === selIdx ? ' sel' : ''}${s.blocked ? ' blocked' : ''}`;
    Object.assign(el.style, { left: s.x + '%', top: s.y + '%', width: s.w + '%', height: s.h + '%' });
    el.innerHTML = `${edEvent.layout ? '' : '<img class="sicon" src="/img/stall-icon-t.png" alt="">'}<span class="lbl">${esc(s.label)}</span><span class="pr">${money(priceOf(s))}</span><span class="rz"></span>`;
    el.title = s.booking ? `${s.booking.business_name} — ${s.booking.status}` : `Stall ${s.label}`;
    el.addEventListener('pointerdown', ev => startDrag(ev, i, ev.target.classList.contains('rz')));
    stage.append(el);
  });
  const corners = edStalls.filter(s => s.is_corner).length;
  $('#stall-info').textContent = `${edStalls.length} stalls · ${corners} corner${dirty ? ' · unsaved changes' : ''}`;
  $('#save-stalls').textContent = dirty ? 'Save stalls •' : 'Save stalls';
  drawPanel();
}

function drawPanel() {
  const p = $('#ed-panel');
  const s = edStalls[selIdx];
  if (!s) {
    p.innerHTML = `<h3>Stall details</h3><p class="muted small">Select a stall to edit it.</p>
      <p class="small">Default rent: <b>${money(edEvent.base_rent)}</b><br>Corner extra: <b>${money(edEvent.corner_charge)}</b></p>
      <p class="muted small">Change these in the event form above.</p>`;
    return;
  }
  p.innerHTML = `<h3>Stall ${esc(s.label)}</h3>
    ${s.booking ? `<div class="alert info small">${statusBadge(s.booking.status)} ${esc(s.booking.business_name)}<br>${esc(s.booking.products)}</div>` : ''}
    <div class="field"><label for="p-label">Label</label><input id="p-label" type="text" maxlength="20" value="${esc(s.label)}"></div>
    <label class="check" style="margin-bottom:12px"><input type="checkbox" id="p-corner" ${s.is_corner ? 'checked' : ''}> ★ Corner stall (+${money(edEvent.corner_charge)})</label>
    <div class="field"><label for="p-price">Rent for this stall (₹)</label><input id="p-price" type="number" min="0" placeholder="Default ${edEvent.base_rent}" value="${s.custom_price ?? ''}"><span class="hint">Leave empty to use the event rent.</span></div>
    <div class="grid2" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="p-w">Width %</label><input id="p-w" type="number" step="0.1" min="1" max="100" value="${(+s.w).toFixed(1)}"></div>
      <div class="field"><label for="p-h">Height %</label><input id="p-h" type="number" step="0.1" min="1" max="100" value="${(+s.h).toFixed(1)}"></div>
    </div>
    <label class="check" style="margin-bottom:12px"><input type="checkbox" id="p-blocked" ${s.blocked ? 'checked' : ''}> Not for booking (reserved by organizer)</label>
    <div class="summary-row total"><span>Vendor pays</span><span>${money(priceOf(s))}</span></div>
    <button class="btn danger sm block" id="p-del" style="margin-top:10px">Delete stall</button>`;
  const upd = (k, v) => { s[k] = v; dirty = true; drawEditor(); };
  $('#p-label').addEventListener('change', e => upd('label', e.target.value.trim() || s.label));
  $('#p-corner').addEventListener('change', e => upd('is_corner', e.target.checked));
  $('#p-blocked').addEventListener('change', e => upd('blocked', e.target.checked));
  $('#p-price').addEventListener('change', e => upd('custom_price', e.target.value === '' ? null : Math.max(0, Math.round(+e.target.value))));
  $('#p-w').addEventListener('change', e => upd('w', Math.max(1, +e.target.value || s.w)));
  $('#p-h').addEventListener('change', e => upd('h', Math.max(1, +e.target.value || s.h)));
  $('#p-del').addEventListener('click', deleteSelected);
}

function deleteSelected() {
  const s = edStalls[selIdx];
  if (!s) return;
  if (s.booking && !confirm(`Stall ${s.label} has a booking (${s.booking.business_name}). Saving will fail unless you reject/release it first. Remove anyway?`)) return;
  edStalls.splice(selIdx, 1); selIdx = -1; dirty = true; drawEditor();
}

function startDrag(ev, i, resize) {
  if (adding) return;
  ev.preventDefault(); ev.stopPropagation();
  selIdx = i;
  const s = edStalls[i];
  const rect = stage.getBoundingClientRect();
  const start = { x: ev.clientX, y: ev.clientY, sx: s.x, sy: s.y, sw: s.w, sh: s.h };
  let moved = false;
  const el = stage.querySelectorAll('.stall')[i];
  $$('.stall.sel', stage).forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
  const move = e => {
    const dx = (e.clientX - start.x) / rect.width * 100, dy = (e.clientY - start.y) / rect.height * 100;
    if (Math.abs(dx) + Math.abs(dy) > 0.2) moved = true;
    if (resize) {
      s.w = Math.max(1, Math.min(100 - s.x, start.sw + dx)); s.h = Math.max(1, Math.min(100 - s.y, start.sh + dy));
      el.style.width = s.w + '%'; el.style.height = s.h + '%';
    } else {
      s.x = Math.max(0, Math.min(100 - s.w, start.sx + dx)); s.y = Math.max(0, Math.min(100 - s.h, start.sy + dy));
      el.style.left = s.x + '%'; el.style.top = s.y + '%';
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (moved) dirty = true;
    drawEditor();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

stage.addEventListener('pointerdown', e => {
  if (e.target.closest('.stall')) return;
  if (!adding) { selIdx = -1; drawEditor(); return; }
  const rect = stage.getBoundingClientRect();
  const last = edStalls[edStalls.length - 1];
  const w = last ? +last.w : 7, h = last ? +last.h : 18;
  const x = Math.max(0, Math.min(100 - w, (e.clientX - rect.left) / rect.width * 100 - w / 2));
  const y = Math.max(0, Math.min(100 - h, (e.clientY - rect.top) / rect.height * 100 - h / 2));
  edStalls.push({ label: nextLabel(), is_corner: false, custom_price: null, x, y, w, h, blocked: false, state: 'available' });
  selIdx = edStalls.length - 1; dirty = true;
  drawEditor();
});
$('#add-stall').addEventListener('click', () => { adding = !adding; drawEditor(); });
document.addEventListener('keydown', e => {
  if ($('#stall-editor').classList.contains('hidden') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (e.key === 'Escape' && adding) { adding = false; drawEditor(); }
  const s = edStalls[selIdx];
  if (!s) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  const step = e.shiftKey ? 2 : 0.3;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) { e.preventDefault(); s.x = Math.max(0, Math.min(100 - s.w, s.x + d[0])); s.y = Math.max(0, Math.min(100 - s.h, s.y + d[1])); dirty = true; drawEditor(); }
});

$('#gen-stalls').addEventListener('click', () => {
  const n = parseInt(prompt('How many stalls should be generated in a grid?' + (edStalls.length ? '\n(They will be added to the existing stalls.)' : ''), '12'), 10);
  if (!n || n < 1 || n > 300) return;
  const cols = Math.min(n, 10), rows = Math.ceil(n / cols);
  const gap = 1.2, cw = (96 - gap * (cols - 1)) / cols, rh = Math.min(26, (92 - gap * (rows - 1)) / rows);
  let lbl = Number(nextLabel()) || edStalls.length + 1;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const lastInRow = Math.min(cols, n - r * cols) - 1;
    edStalls.push({
      label: String(lbl++), is_corner: c === 0 || c === lastInRow, custom_price: null,
      x: 2 + c * (cw + gap), y: 4 + r * (rh + gap), w: cw, h: rh, blocked: false, state: 'available',
    });
  }
  dirty = true; drawEditor();
  toast(`${n} stalls added — row ends are marked as corner stalls. Adjust as needed.`);
});

$('#save-stalls').addEventListener('click', async () => {
  try {
    const r = await api(`/api/admin/events/${editingId}/stalls`, { method: 'PUT', body: { stalls: edStalls } });
    edStalls = r.stalls; dirty = false; adding = false;
    drawEditor();
    toast('Stalls saved — vendors can now book them', 'ok');
  } catch (e) { toast(e.message, 'error'); }
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ settings
async function loadSettings() {
  const s = await api('/api/admin/settings');
  $('#s-org').value = s.organizer_name; $('#s-wa').value = s.organizer_whatsapp; $('#s-upi').value = s.upi_id;
  $('#s-payee').value = s.payee_name; $('#s-hold').value = s.hold_minutes || 10; $('#s-note').value = s.payment_note;
  setPreview($('#qr-prev'), $('#rm-qr-wrap'), s.payment_qr);
  $('#settings-form input[type=file]').value = '';
  $('#wa-status').innerHTML = s.whatsapp_api
    ? '✅ WhatsApp Cloud API is connected — booking alerts and vendor details are sent to your WhatsApp automatically.'
    : 'WhatsApp: alerts appear in this portal (🔔). Use the <b>Send details to my WhatsApp</b> button on a booking to forward it in one tap. For fully automatic WhatsApp messages, set <code>WHATSAPP_TOKEN</code> and <code>WHATSAPP_PHONE_NUMBER_ID</code> on the server (see README).';
}
$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  if (!fd.get('payment_qr')?.size) fd.delete('payment_qr');
  try { await api('/api/admin/settings', { method: 'PUT', form: fd }); toast('Settings saved', 'ok'); loadSettings(); }
  catch (err) { toast(err.message, 'error'); }
});
$('#pw-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/admin/password', { method: 'POST', body: { current: $('#pw-cur').value, next: $('#pw-new').value } });
    toast('Password updated', 'ok'); e.target.reset();
  } catch (err) { toast(err.message, 'error'); }
});

boot();
