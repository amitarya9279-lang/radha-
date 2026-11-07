'use strict';
/* =====================================================================
   FAST PRINT PORTAL v2 - Master Admin screens
   Uses helpers from app.js (S, H, CH, api, esc, rupee, showModal ...)
   ===================================================================== */
const AV = (window.ADMIN_VIEWS = {});
const PLACE_LABEL = { quick: 'Top Quick Bar', accordion: 'Multi-Server Accordion', grid: 'Main Services Grid' };
const FIELD_TYPES = ['text', 'password', 'date', 'dropdown', 'file', 'number', 'textarea'];
const switchHtml = (id, on, label) => '<label class="switch-row"><input type="checkbox" id="' + id + '" ' + (on ? 'checked' : '') + '><span class="switch"></span><span>' + label + '</span></label>';
const sec = (title, sub) => '<h3 class="h3">' + title + '</h3>' + (sub ? '<p class="muted" style="margin:-8px 0 12px">' + sub + '</p>' : '');

async function saveSection(section, values, msg) {
  await api('PUT', '/api/admin/settings', { section, values });
  toast(msg || 'Settings save ho gayi!');
  await refreshAll();
}

/* ------------------------------ DASHBOARD ------------------------------ */
AV.dash = () => {
  const st = S.stats || {}, pend = ((S.d.orders || {}).items) || [], pays = (S.d.pays || []).filter(p => p.status === 'Pending').slice(0, 6);
  return '<div class="stat-grid">' + stat('ok', 'Revenue (Completed)', rupee(st.revenue)) + stat('inf', 'Orders Today', st.today || 0) + stat('warn', 'Pending Orders', st.pending || 0) +
    stat('inf', 'Customers', st.customers || 0) + stat('warn', 'Payments to Verify', st.pays || 0) + stat('bad', 'Open Complaints', st.tickets || 0) + stat('ok', 'Total Customer Wallets', rupee(st.wallets)) + '</div>' +
    '<div class="help-row"><button class="btn" data-act="go" data-v="services">\u2699\uFE0F Services & Layout</button><button class="btn o" data-act="go" data-v="pays">\uD83D\uDCB0 UTR Queue</button><button class="btn g" data-act="go" data-v="notify">\uD83D\uDD14 Alerts</button><button class="btn" style="background:#6366f1" data-act="go" data-v="announce">\uD83D\uDCE2 Ticker & Popup</button></div>' +
    '<div class="card"><h3 class="h3">\u23F3 Pending Orders</h3>' + ordersTable(pend) + '</div>' +
    '<div class="card"><h3 class="h3">\uD83D\uDCB0 UTR Payments Waiting</h3>' + (pays.length ? payTable(pays) : '<p class="muted">Koi payment pending nahi</p>') + '</div>';
};

/* ------------------------------ SERVICES & LAYOUT BUILDER ------------------------------ */
AV.services = () => {
  const order = { quick: 0, accordion: 1, grid: 2 };
  const list = S.svc.slice().sort((a, b) => order[a.placement] - order[b.placement] || a.sort - b.sort);
  return '<div class="card"><h3 class="h3">\u2699\uFE0F Services & Dynamic Layout Builder</h3><p class="muted" style="margin-bottom:12px">Har service ki <b>placement</b> chunein: Top Quick Bar, Multi-Server Accordion (same <b>Group</b> naam wali services ek card me servers ban jati hain) ya Main Grid. <b>Sort</b> number chhota = pehle dikhega.</p>' +
    '<div class="help-row"><button class="btn g" data-act="svcEdit" data-id="">+ Nayi Service</button><button class="btn o" data-act="seedSvc">\u2728 Starter Multi-Server Services Jodein</button></div>' +
    '<div class="tw"><table><tr><th>Sort</th><th>Service</th><th>Placement / Group</th><th>Category</th><th>Price</th><th>Badge</th><th>Status</th><th>Actions</th></tr>' +
    list.map(s => '<tr><td>' + s.sort + '</td><td>' + iconHtml(s, 'mini') + ' <b>' + esc(s.name) + '</b>' + (s.serverLabel ? '<br><small class="muted">' + esc(s.serverLabel) + '</small>' : '') + '<br><small class="muted">' + esc(s.id) + '</small></td>' +
      '<td><span class="tag Processing">' + PLACE_LABEL[s.placement] + '</span>' + (s.group ? '<br><small>' + esc(s.group) + '</small>' : '') + '</td><td>' + esc(CHIP_LABEL[s.chip] || s.chip) + '</td><td><b>' + rupee(s.price) + '</b></td><td>' + badgeHtml(s) + '</td>' +
      '<td><button class="btn s ' + (s.on !== false ? 'g' : 'r') + '" data-act="svcToggle" data-id="' + esc(s.id) + '">' + (s.on !== false ? 'ON' : 'OFF') + '</button></td>' +
      '<td class="tbl-actions"><button class="btn s" data-act="svcEdit" data-id="' + esc(s.id) + '">Edit</button> <button class="btn s o" data-act="svcDup" data-id="' + esc(s.id) + '" title="Naya server banayein">+Server</button> <button class="btn s r" data-act="svcDel" data-id="' + esc(s.id) + '">Delete</button></td></tr>').join('') + '</table></div></div>';
};
const opt = (arr, cur, lab) => arr.map(v => '<option value="' + esc(v) + '" ' + (v === cur ? 'selected' : '') + '>' + esc(lab ? lab[v] : (v || '(none)')) + '</option>').join('');
function fbRow(f = {}) {
  return '<div class="fb-row"><input class="fb-label" placeholder="Field label" value="' + esc(f.label || '') + '"><select class="fb-type">' + opt(FIELD_TYPES, f.type || 'text') + '</select><input class="fb-ph" placeholder="Placeholder" value="' + esc(f.placeholder || '') + '"><input class="fb-hint" placeholder="Hint" value="' + esc(f.hint || '') + '"><input class="fb-opts" placeholder="Dropdown: a,b,c" value="' + esc(f.opts || '') + '"><label class="fb-req"><input type="checkbox" class="fb-reqc" ' + (f.req ? 'checked' : '') + '> Req</label><button class="btn s r" data-act="fbDel" type="button">\u2715</button></div>';
}
H.svcEdit = el => {
  const s = svcById(el.dataset.id) || { on: true, price: 0, placement: 'grid', chip: 'manual', sort: 100, fields: [], instructions: [], endpoints: [], group: '', serverLabel: '', badge: '', icon: '\uD83D\uDCC4', iconUrl: '' };
  showModal('<h3 class="h3">' + (s.id ? 'Edit: ' + esc(s.name) : 'Nayi Service Banayein') + '</h3><div class="grid2">' +
    '<div><label>Service Name</label><input id="as_name" value="' + esc(s.name || '') + '"></div><div><label>Price / Cost (\u20B9)</label><input id="as_price" type="number" min="0" step="0.5" value="' + s.price + '"></div>' +
    '<div><label>Placement</label><select id="as_place">' + opt(['quick', 'accordion', 'grid'], s.placement, PLACE_LABEL) + '</select></div><div><label>Filter Category (chip)</label><select id="as_chip">' + opt(CHIPS_LIST(), s.chip, CHIP_LABEL) + '</select></div>' +
    '<div><label>Accordion Group (same naam = ek card)</label><input id="as_group" value="' + esc(s.group) + '" placeholder="e.g. RC PDF"></div><div><label>Server Label</label><input id="as_label" value="' + esc(s.serverLabel) + '" placeholder="e.g. Server 2 / HD / OTP"></div>' +
    '<div><label>Badge</label><select id="as_badge">' + opt(['', 'FAST', 'NEW', 'PRO', 'LIVE'], s.badge) + '</select></div><div><label>Sort Order</label><input id="as_sort" type="number" value="' + s.sort + '"></div>' +
    '<div><label>Emoji Icon</label><input id="as_icon" value="' + esc(s.icon) + '" maxlength="8"></div><div><label>3D Icon URL (https://... ya upload)</label><input id="as_iconUrl" value="' + (String(s.iconUrl).startsWith('data:') ? '' : esc(s.iconUrl)) + '" placeholder="https://.../icon.png"><input type="file" accept="image/*" data-change="iconUpload" style="margin-top:6px"><input type="hidden" id="as_iconData" value="' + (String(s.iconUrl).startsWith('data:') ? esc(s.iconUrl) : '') + '"></div></div>' +
    '<label>Fallback Server Endpoints (ek line me ek https URL \u2014 pehla fail ho to agla try hota hai; khali = off)</label><textarea id="as_endpoints" rows="2" placeholder="https://server1.example.com/api/order&#10;https://backup.example.com/api/order">' + esc((s.endpoints || []).join('\n')) + '</textarea>' +
    '<label>Instructions (ek line = ek point)</label><textarea id="as_instr" rows="3">' + esc((s.instructions || []).join('\n')) + '</textarea>' +
    '<label>Customer Form Fields</label><div id="fbRows">' + (s.fields || []).map(fbRow).join('') + '</div><button class="btn s" type="button" data-act="fbAdd" style="margin-top:6px">+ Field Jodein</button>' +
    '<div style="margin-top:14px">' + switchHtml('as_on', s.on !== false, 'Service ON (customers ko dikhegi)') + '</div>' +
    '<div style="text-align:right;margin-top:14px"><button class="btn s" style="background:#334155" data-act="closeModal">Cancel</button> <button class="btn g" data-act="svcSave" data-id="' + esc(s.id || '') + '">\uD83D\uDCBE Save Service</button></div>', true);
};
const CHIPS_LIST = () => ['aadhaar', 'voter', 'pan', 'vehicle', 'farmer', 'ration', 'exam', 'lookup', 'manual'];
H.fbAdd = () => $('#fbRows').insertAdjacentHTML('beforeend', fbRow());
H.fbDel = el => el.closest('.fb-row').remove();
CH.iconUpload = async el => {
  const f = el.files[0]; if (!f) return;
  if (f.size > 300 * 1024) { el.value = ''; throw new Error('Icon 300 KB se chhota hona chahiye'); }
  $('#as_iconData').value = await readFile(f); $('#as_iconUrl').value = ''; toast('Icon ready - Save dabayein');
};
H.svcSave = async el => {
  const g = id => val(id).trim();
  const body = {
    name: g('as_name'), price: Number(val('as_price')) || 0, placement: val('as_place'), chip: val('as_chip'), group: g('as_group'), serverLabel: g('as_label'), badge: val('as_badge'),
    sort: Number(val('as_sort')) || 0, icon: g('as_icon'), iconUrl: val('as_iconData') || g('as_iconUrl'), endpoints: val('as_endpoints'), instructions: val('as_instr'), on: chk('as_on'),
    fields: $$('.fb-row').map(r => ({ label: $('.fb-label', r).value, type: $('.fb-type', r).value, placeholder: $('.fb-ph', r).value, hint: $('.fb-hint', r).value, opts: $('.fb-opts', r).value, req: $('.fb-reqc', r).checked }))
  };
  if (body.on && body.price === 0 && !confirm('Price \u20B90 hai - service free me chalegi. Phir bhi ON karein?')) return;
  el.dataset.id ? await api('PUT', '/api/admin/services/' + el.dataset.id, body) : await api('POST', '/api/admin/services', body);
  closeModal(); toast('Service save ho gayi'); await refreshAll();
};
H.svcToggle = async el => { await api('POST', '/api/admin/services/' + el.dataset.id + '/toggle'); await refreshAll(); };
H.svcDup = async el => { const r = await api('POST', '/api/admin/services/' + el.dataset.id + '/duplicate'); toast('Naya server ban gaya (OFF) - price set karke ON karein'); await refreshAll(); H.svcEdit({ dataset: { id: r.id } }); };
H.svcDel = async el => {
  const s = svcById(el.dataset.id);
  if (!confirm('"' + (s ? s.name : '') + '" delete karein? Purane orders safe rahenge.')) return;
  await api('DELETE', '/api/admin/services/' + el.dataset.id); toast('Service delete ho gayi'); await refreshAll();
};
H.seedSvc = async () => {
  if (!confirm('Starter services (Voter Mobile Link, LL Exam, PUC, RC Server 2-5, DL HD, Aadhaar Biometric/OTP, Farmer DBT) jodein? Ye sab OFF aur \u20B90 price par aayengi - price set karke ON karein.')) return;
  const r = await api('POST', '/api/admin/services/seed'); toast(r.added + ' services joddi gayi'); await refreshAll();
};

/* ------------------------------ STAFF ------------------------------ */
const svcChecks = (sel = []) => '<div class="chk-grid"><label class="chk"><input type="checkbox" class="stf_chk" value="ALL" ' + (sel.includes('ALL') ? 'checked' : '') + '> <b>ALL services</b></label>' +
  S.staffSvc.map(s => '<label class="chk"><input type="checkbox" class="stf_chk" value="' + esc(s.id) + '" ' + (sel.includes(s.id) ? 'checked' : '') + '> ' + esc(s.name) + '</label>').join('') + '</div>';
const checked = () => $$('.stf_chk:checked').map(c => c.value);
AV.staff = () => {
  const staff = (S.d.users || []).filter(u => u.role === 'staff');
  return '<div class="card" style="max-width:720px"><h3 class="h3">\uD83E\uDEAA Naya Staff / Operator Banayein</h3><div class="grid2"><div><label>Full Name</label><input id="stf_n"></div><div><label>Username</label><input id="stf_u" autocomplete="off"></div></div><label>Password (min 8)</label><input id="stf_p" type="password" autocomplete="new-password">' +
    '<label>Kin services ka kaam dekh sakta hai?</label>' + svcChecks() + '<button class="btn g" style="margin-top:12px" data-act="staffAdd">Create Staff</button></div>' +
    '<div class="card"><h3 class="h3">Staff List (' + staff.length + ')</h3>' + (staff.length ? '<div class="tw"><table><tr><th>ID</th><th>Name</th><th>User</th><th>Access</th><th>Last Login</th><th>Status</th><th>Actions</th></tr>' + staff.map(u =>
      '<tr><td>' + esc(u.id) + '</td><td>' + esc(u.name) + '</td><td>' + esc(u.u) + '</td><td>' + ((u.services || []).includes('ALL') ? 'ALL' : (u.services || []).length + ' services') + '</td><td>' + esc(u.lastLogin || '-') + '</td><td><span class="tag ' + (u.locked ? 'Rejected' : 'Completed') + '">' + (u.locked ? 'Banned' : 'Active') + '</span></td>' +
      '<td class="tbl-actions"><button class="btn s" data-act="staffEdit" data-id="' + esc(u.id) + '">Access</button> <button class="btn s o" data-act="resetPw" data-id="' + esc(u.id) + '">Reset PW</button> <button class="btn s ' + (u.locked ? 'g' : 'r') + '" data-act="lockUser" data-id="' + esc(u.id) + '" data-v="' + (u.locked ? '' : '1') + '">' + (u.locked ? 'Unban' : 'Ban') + '</button> <button class="btn s r" data-act="staffDel" data-id="' + esc(u.id) + '">Delete</button></td></tr>').join('') + '</table></div>' : '<p class="muted">Abhi koi staff nahi</p>') + '</div>';
};
H.staffAdd = async () => {
  await api('POST', '/api/admin/staff', { name: val('stf_n'), u: val('stf_u'), p: val('stf_p'), services: checked() });
  toast('Staff create ho gaya'); await refreshAll();
};
H.staffEdit = el => {
  const u = S.d.users.find(x => x.id === el.dataset.id);
  showModal('<h3 class="h3">Access: ' + esc(u.name) + '</h3>' + svcChecks(u.services || []) + '<div style="text-align:right;margin-top:14px"><button class="btn s" style="background:#334155" data-act="closeModal">Cancel</button> <button class="btn g" data-act="staffSave" data-id="' + esc(u.id) + '">Save</button></div>', true);
};
H.staffSave = async el => { await api('PUT', '/api/admin/staff/' + el.dataset.id, { services: checked() }); closeModal(); toast('Access update ho gaya'); await refreshAll(); };
H.staffDel = async el => { if (!confirm('Staff delete karein?')) return; await api('DELETE', '/api/admin/staff/' + el.dataset.id); toast('Staff delete ho gaya'); await refreshAll(); };

/* ------------------------------ CUSTOMERS & WALLETS ------------------------------ */
let userKw = '';
AV.users = () => {
  const all = (S.d.users || []).filter(u => u.role === 'customer');
  return '<div class="card"><h3 class="h3">\uD83D\uDC65 Customers & Wallets (' + all.length + ')</h3><div class="tools-row"><input id="u_kw" placeholder="Name / username / mobile / ID search" value="' + esc(userKw) + '"></div><div id="usersTbl">' + usersTable() + '</div></div>';
};
function usersTable() {
  const k = userKw.toLowerCase().trim();
  const list = (S.d.users || []).filter(u => u.role === 'customer' && (!k || [u.id, u.name, u.u, u.mobile].some(x => String(x || '').toLowerCase().includes(k))));
  return list.length ? '<div class="tw"><table><tr><th>ID</th><th>Name</th><th>User / Mobile</th><th>Wallet</th><th>Logins</th><th>Last Login</th><th>Status</th><th>Actions</th></tr>' + list.map(u =>
    '<tr><td>' + esc(u.id) + '</td><td>' + esc(u.name) + '</td><td>' + esc(u.u) + '<br><small class="muted">' + esc(u.mobile) + '</small></td><td><b>' + rupee(u.wallet) + '</b></td><td>' + u.loginCount + '</td><td>' + esc(u.lastLogin || '-') + '</td>' +
    '<td><span class="tag ' + (u.locked ? 'Rejected' : 'Completed') + '">' + (u.locked ? 'Banned' : 'Active') + '</span></td><td class="tbl-actions"><button class="btn s g" data-act="walletEdit" data-id="' + esc(u.id) + '">\u00B1 Wallet</button> <button class="btn s" data-act="ledger" data-id="' + esc(u.id) + '">Ledger</button> <button class="btn s o" data-act="resetPw" data-id="' + esc(u.id) + '">Reset PW</button> <button class="btn s ' + (u.locked ? 'g' : 'r') + '" data-act="lockUser" data-id="' + esc(u.id) + '" data-v="' + (u.locked ? '' : '1') + '">' + (u.locked ? 'Unban' : 'Ban') + '</button></td></tr>').join('') + '</table></div>' : '<p class="muted">Koi customer nahi mila</p>';
}
document.addEventListener('input', e => { if (e.target.id === 'u_kw') { userKw = e.target.value; $('#usersTbl').innerHTML = usersTable(); } });
H.walletEdit = el => {
  const u = S.d.users.find(x => x.id === el.dataset.id);
  showModal('<h3 class="h3">Wallet: ' + esc(u.name) + ' (' + rupee(u.wallet) + ')</h3><label>Action</label><select id="w_type"><option value="credit">\u2795 Credit (balance badhayein)</option><option value="debit">\u2796 Debit (balance ghatayein)</option></select>' +
    '<label>Amount (\u20B9)</label><input id="w_amt" type="number" min="1" step="0.5"><label>Note / Reason (ledger me dikhega)</label><input id="w_note" maxlength="150" placeholder="e.g. Cash received / correction">' +
    '<div style="text-align:right;margin-top:14px"><button class="btn s" style="background:#334155" data-act="closeModal">Cancel</button> <button class="btn g" data-act="walletSave" data-id="' + esc(u.id) + '">Apply</button></div>');
};
H.walletSave = async el => {
  const r = await api('POST', '/api/admin/users/' + el.dataset.id + '/wallet', { type: val('w_type'), amt: Number(val('w_amt')), note: val('w_note') });
  closeModal(); toast('Wallet update: ' + rupee(r.wallet)); await refreshAll();
};
H.ledger = async el => {
  const u = S.d.users.find(x => x.id === el.dataset.id), r = await api('GET', '/api/admin/ledger?uid=' + encodeURIComponent(el.dataset.id));
  showModal('<h3 class="h3">Ledger: ' + esc(u.name) + '</h3>' + ledgerTable(r.items) + '<div style="text-align:right;margin-top:12px"><button class="btn s" data-act="closeModal">Close</button></div>', true);
};
H.resetPw = async el => {
  const n = prompt('Naya password likhein (min 8 akshar):'); if (n === null) return;
  await api('POST', '/api/admin/users/' + el.dataset.id + '/password', { password: n }); toast('Password reset ho gaya. User ko bata dein.');
};
H.lockUser = async el => { await api('POST', '/api/admin/users/' + el.dataset.id + '/lock', { locked: !!el.dataset.v }); toast(el.dataset.v ? 'User ban ho gaya' : 'User unban ho gaya'); await refreshAll(); };

/* ------------------------------ UTR QUEUE ------------------------------ */
let payFilter = 'Pending';
function payTable(list) {
  return '<div class="tw"><table><tr><th>ID</th><th>User</th><th>Amount</th><th>UTR</th><th>Time</th><th>Status</th><th>Action</th></tr>' + list.map(p =>
    '<tr><td>' + esc(p.id) + '</td><td>' + esc(p.uname) + '</td><td><b>' + rupee(p.amt) + '</b></td><td><span class="copyable">' + esc(p.utr) + '</span></td><td>' + esc(p.t) + '</td><td><span class="tag ' + esc(p.status) + '">' + esc(p.status) + '</span></td><td>' +
    (p.status === 'Pending' ? '<button class="btn s g" data-act="payOk" data-id="' + esc(p.id) + '">\u2714 Approve</button> <button class="btn s r" data-act="payNo" data-id="' + esc(p.id) + '">\u2716 Reject</button>' : '<small class="muted">' + esc(p.doneBy || '') + '</small>') + '</td></tr>').join('') + '</table></div>';
}
AV.pays = () => {
  const all = S.d.pays || [], list = payFilter ? all.filter(p => p.status === payFilter) : all;
  return '<div class="card"><h3 class="h3">\uD83D\uDCB0 UTR / Add Money Verification Queue</h3><div class="tools-row"><select id="pay_f" data-change="payFilter">' + ['Pending', 'Completed', 'Rejected', ''].map(x => '<option value="' + x + '" ' + (payFilter === x ? 'selected' : '') + '>' + (x || 'All') + '</option>').join('') + '</select></div>' + (list.length ? payTable(list) : '<p class="muted">Koi record nahi</p>') + '</div>';
};
CH.payFilter = () => { payFilter = val('pay_f'); render(); };
const verify = async (id, ok) => { await api('POST', '/api/admin/pays/' + id + '/verify', { ok }); toast(ok ? 'Approved & balance add ho gaya' : 'Payment reject ho gayi'); await refreshAll(); };
H.payOk = el => verify(el.dataset.id, true);
H.payNo = el => verify(el.dataset.id, false);

/* ------------------------------ PORTAL & PAYMENT SETTINGS ------------------------------ */
let qrDraft = null;                                    // null = unchanged
AV.settings = () => {
  const A = (S.d.adm || {}).settings || {}, qr = qrDraft === null ? A.qr : qrDraft;
  return '<div class="two" style="align-items:start"><div class="card"><h3 class="h3">\uD83D\uDEE0\uFE0F Portal Branding</h3><label>Portal Title / Brand Name</label><input id="set_t" value="' + esc(A.title) + '"><label>Portal Subtitle</label><input id="set_sub" value="' + esc(A.sub) + '">' +
    '<label>Login Page Notice Banner</label><textarea id="set_not" rows="3">' + esc(A.notice) + '</textarea><label>WhatsApp Group Link (https://chat.whatsapp.com/... ya https://wa.me/...)</label><input id="set_wa" value="' + esc(A.waLink) + '"><button class="btn g" style="margin-top:12px" data-act="savePortal">Save Branding</button></div>' +
    '<div class="card"><h3 class="h3">\uD83D\uDCB3 UPI & QR</h3><label>UPI ID</label><input id="set_upi" value="' + esc(A.upi) + '"><label>QR Code Image</label>' + (qr ? '<img class="qr-code-img" style="width:140px;height:140px;display:block;margin:6px 0" src="' + esc(qr) + '" alt="QR">' : '<p class="muted">QR set nahi hai</p>') +
    '<input type="file" accept="image/*" data-change="qrUpload"> ' + (qr ? '<button class="btn s r" style="margin-top:6px" data-act="qrRemove">Remove QR</button>' : '') + '<br><button class="btn g" style="margin-top:12px" data-act="savePay">Save Payment Settings</button></div></div>';
};
H.savePortal = () => saveSection('portal', { title: val('set_t'), sub: val('set_sub'), notice: val('set_not'), waLink: val('set_wa') });
H.savePay = async () => { const v = { upi: val('set_upi') }; if (qrDraft !== null) v.qr = qrDraft; await saveSection('payment', v, 'Payment settings save ho gayi!'); qrDraft = null; render(); };
CH.qrUpload = async el => { const f = el.files[0]; if (!f) return; if (f.size > 1.5 * 1048576) throw new Error('QR image 1.5 MB se chhoti ho'); qrDraft = await readFile(f); render(); };
H.qrRemove = () => { qrDraft = ''; render(); };

/* ------------------------------ TICKER + POPUP ------------------------------ */
AV.announce = () => {
  const A = (S.d.adm || {}).settings || {};
  return '<div class="card"><h3 class="h3">\uD83D\uDCE2 Live Scrolling Notice Ticker</h3><p class="muted" style="margin-bottom:10px">Backup domain, maintenance ya koi bhi update \u2014 ek line = ek message. Sabhi pages par upar scroll hoga.</p>' + switchHtml('tk_on', A.tickerOn, 'Ticker ON') +
    '<label>Messages (ek line me ek)</label><textarea id="tk_text" rows="4" placeholder="\uD83D\uDD14 Backup domain: example.in&#10;\u26A0\uFE0F Aaj raat 11-12 baje maintenance">' + esc(A.tickerText) + '</textarea><label>Scroll Speed (seconds per round \u2014 bada number = dheema)</label><input id="tk_speed" type="number" min="10" max="200" value="' + (A.tickerSpeed || 40) + '"><button class="btn g" style="margin-top:12px" data-act="saveTicker">Save Ticker</button></div>' +
    '<div class="card"><h3 class="h3">\uD83D\uDEA8 Emergency Popup Announcement</h3><p class="muted" style="margin-bottom:10px">Login ke baad / page load par dashboard par popup aayega. Save karte hi sabke liye dobara dikhne lagta hai.</p>' + switchHtml('pp_on', A.popupOn, 'Popup ON') +
    '<div class="grid2"><div><label>Title</label><input id="pp_title" value="' + esc(A.popupTitle) + '"></div><div><label>Button Text (optional)</label><input id="pp_btn" value="' + esc(A.popupBtnText) + '" placeholder="Join Telegram"></div></div><label>Message</label><textarea id="pp_msg" rows="4">' + esc(A.popupMsg) + '</textarea>' +
    '<div class="grid2"><div><label>Button Link (https://...)</label><input id="pp_link" value="' + esc(A.popupBtnLink) + '"></div><div><label>Dismiss Rule</label><select id="pp_dis">' + [['session', 'Is session me ek baar (browser band hone tak)'], ['day', '24 ghante me ek baar'], ['once', 'Sirf ek baar (hamesha ke liye)'], ['always', 'Har page load par']].map(o => '<option value="' + o[0] + '" ' + (A.popupDismiss === o[0] ? 'selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div></div>' +
    '<div class="help-row" style="margin-top:12px"><button class="btn g" data-act="savePopup">Save Popup</button><button class="btn o" data-act="previewPopup">\uD83D\uDC41 Preview</button></div></div>';
};
H.saveTicker = () => saveSection('ticker', { tickerOn: chk('tk_on'), tickerText: val('tk_text'), tickerSpeed: Number(val('tk_speed')) || 40 }, 'Ticker save ho gaya!');
H.savePopup = () => saveSection('popup', { popupOn: chk('pp_on'), popupTitle: val('pp_title'), popupMsg: val('pp_msg'), popupBtnText: val('pp_btn'), popupBtnLink: val('pp_link'), popupDismiss: val('pp_dis') }, 'Popup save ho gaya!');
H.previewPopup = () => {
  const href = safeHref(val('pp_link'));
  showModal('<button class="x-close" data-act="closeModal">\u2715</button><div class="ann-icon">\uD83D\uDCE2</div><h2 class="ann-title">' + esc(val('pp_title') || 'Announcement') + '</h2><p class="ann-msg">' + esc(val('pp_msg')) + '</p><div class="ann-actions">' + (href && val('pp_btn') ? '<a class="btn" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(val('pp_btn')) + '</a>' : '') + '<button class="btn s" style="background:#334155" data-act="closeModal">Dismiss</button></div>');
};

/* ------------------------------ TELEGRAM / WHATSAPP ------------------------------ */
AV.notify = () => {
  const d = S.d.adm || {}, A = d.settings || {}, log = d.log || [];
  return '<div class="card"><h3 class="h3">\uD83D\uDD14 Instant Admin Notification Desk</h3><p class="muted" style="margin-bottom:10px">Ye settings sirf server par rehti hain \u2014 customers ko kabhi nahi dikhti. Alerts background me jaate hain, isliye API slow/down ho tab bhi customer ka order ya payment kabhi fail nahi hota.</p>' +
    '<div class="grid2"><div><h4 class="h4">\u2708\uFE0F Telegram</h4><label>Bot Token</label><input id="n_tg" type="password" autocomplete="off" placeholder="' + (A.tgBotTokenSet ? esc(A.tgBotTokenMasked) + '  (saved - naya daalne par badlega)' : '123456789:AA...') + '">' +
    (A.tgBotTokenSet ? '<label class="chk"><input type="checkbox" id="n_tgclr"> Saved token hatayein</label>' : '') + '<label>Admin Chat ID (comma se kai ID bhi chalengi)</label><input id="n_chat" value="' + esc(A.tgChatId) + '" placeholder="123456789"></div>' +
    '<div><h4 class="h4">\uD83D\uDCAC WhatsApp Webhook / Gateway</h4><label>Webhook URL</label><input id="n_wa" value="' + esc(A.waWebhook) + '" placeholder="https://gateway.example.com/send"><label>API Key</label><input id="n_wakey" type="password" autocomplete="off" placeholder="' + (A.waApiKeySet ? esc(A.waApiKeyMasked) + '  (saved)' : 'optional') + '">' +
    (A.waApiKeySet ? '<label class="chk"><input type="checkbox" id="n_wakclr"> Saved key hatayein</label>' : '') + '</div></div>' +
    '<p class="muted" style="margin-top:8px;font-size:11px">WhatsApp URL do tarah kaam karta hai: (1) normal URL \u2192 JSON POST bhejta hai ({message, text, event, data}) aur key ko <code>Authorization: Bearer</code> + <code>x-api-key</code> header me deta hai. (2) URL me <code>{message}</code> / <code>{apikey}</code> likha ho to GET request jaati hai, jaise <code>https://api.callmebot.com/whatsapp.php?phone=91XXXXXXXXXX&amp;text={message}&amp;apikey={apikey}</code></p>' +
    '<h4 class="h4" style="margin-top:14px">Kab alert bheje?</h4>' + switchHtml('n_order', A.notifyOrder, 'New Service Order (service, customer, amount, reference ID)') + switchHtml('n_dep', A.notifyDeposit, 'New UTR / Add Money deposit submitted') + switchHtml('n_cmp', A.notifyComplaint, 'New complaint / support ticket') +
    '<div class="help-row" style="margin-top:14px"><button class="btn g" data-act="saveNotify">Save Alert Settings</button><button class="btn o" data-act="testNotify">\uD83D\uDCE8 Send Test Alert</button></div></div>' +
    '<div class="card"><h3 class="h3">Recent Alert Attempts</h3>' + (log.length ? '<div class="tw"><table><tr><th>Time</th><th>Channel</th><th>Result</th><th>Info</th></tr>' + log.map(l => '<tr><td>' + esc(l.t) + '</td><td>' + esc(l.ch) + '</td><td><span class="tag ' + (l.ok ? 'Completed' : 'Rejected') + '">' + (l.ok ? 'OK' : 'FAILED') + '</span></td><td>' + esc(l.info) + '</td></tr>').join('') + '</table></div>' : '<p class="muted">Abhi koi attempt nahi (server restart par list reset hoti hai)</p>') + '</div>';
};
H.saveNotify = () => saveSection('notify', { tgBotToken: val('n_tg'), clearTgToken: chk('n_tgclr'), tgChatId: val('n_chat'), waWebhook: val('n_wa'), waApiKey: val('n_wakey'), clearWaKey: chk('n_wakclr'), notifyOrder: chk('n_order'), notifyDeposit: chk('n_dep'), notifyComplaint: chk('n_cmp') }, 'Alert settings save ho gayi!');
H.testNotify = async () => {
  const r = await api('POST', '/api/admin/notify/test');
  toast('Telegram: ' + r.telegram + '  |  WhatsApp: ' + r.whatsapp); await loadView('notify'); render();
};

/* ------------------------------ LIVE CODE & CSS CUSTOMIZER ------------------------------ */
AV.custom = () => {
  const A = (S.d.adm || {}).settings || {};
  return '<div class="card"><h3 class="h3">\uD83D\uDCBB Live Code & CSS Customizer</h3><p class="muted" style="margin-bottom:10px">Yahan likha code save karte hi sabhi pages par lagta hai \u2014 file edit ya server restart ki zaroorat nahi. Galti ho jaye to <code>' + esc(location.origin) + '/?safe=1</code> kholein (custom code ke bina portal khulta hai), phir yahan se theek karein.</p>' +
    '<label>Custom CSS</label><textarea id="cc_css" class="code-area" rows="9" spellcheck="false" placeholder=".mini-tile{border-radius:24px}">' + esc(A.customCss) + '</textarea>' +
    '<label>Custom Banner HTML (header ke upar dikhega)</label><textarea id="cc_html" class="code-area" rows="6" spellcheck="false" placeholder="<div style=&quot;background:#f59e0b;color:#000;padding:8px;text-align:center&quot;>Diwali Offer!</div>">' + esc(A.customHtml) + '</textarea>' +
    '<label>Custom JavaScript (page load par ek baar chalta hai)</label><textarea id="cc_js" class="code-area" rows="7" spellcheck="false" placeholder="console.log(\'hello\')">' + esc(A.customJs) + '</textarea>' +
    '<div class="alert-yellow" style="margin-top:10px">\u26A0\uFE0F Custom JavaScript har visitor ke browser me chalta hai. Sirf wahi code dalein jo aap khud samajhte hain (kisi anjaan ka code paste na karein).</div>' +
    '<div class="help-row" style="margin-top:6px"><button class="btn g" data-act="saveCustom">\uD83D\uDCBE Save & Apply CSS/HTML</button><button class="btn o" data-act="saveCustomReload">\u21BB Save & Reload (JS chalane ke liye)</button></div></div>';
};
const customVals = () => ({ customCss: val('cc_css'), customHtml: val('cc_html'), customJs: val('cc_js') });
H.saveCustom = () => saveSection('custom', customVals(), 'Custom code save ho gaya! (JS badlav ke liye Save & Reload dabayein)');
H.saveCustomReload = async () => { await api('PUT', '/api/admin/settings', { section: 'custom', values: customVals() }); location.reload(); };

/* ------------------------------ REPORTS & BACKUP ------------------------------ */
AV.reports = () => {
  const o = (S.d.orders || {}).items || [], total = (S.d.orders || {}).total || 0, done = o.filter(x => x.status === 'Completed').length, pct = total ? Math.round(done * 100 / total) : 0;
  return '<div class="card"><h3 class="h3">\uD83D\uDCCA Reports</h3><p style="margin-bottom:6px">Success rate: <b>' + pct + '%</b> (' + done + '/' + total + ' orders)</p><div class="pbar"><i style="width:' + pct + '%"></i></div>' +
    '<div class="help-row" style="margin-top:16px"><a class="btn s" href="/api/admin/csv?kind=orders">\u2B07 Orders CSV</a><a class="btn s" href="/api/admin/csv?kind=customers">\u2B07 Customers CSV</a><a class="btn s" href="/api/admin/csv?kind=payments">\u2B07 Payments CSV</a><a class="btn s" href="/api/admin/csv?kind=ledger">\u2B07 Wallet Ledger CSV</a></div></div>' +
    '<div class="card"><h3 class="h3">\uD83D\uDCBE Database Backup & Restore</h3><p class="muted" style="margin-bottom:12px">Backup = live <code>data.json</code> (users, wallets, orders, settings sab kuch). Roz ek backup download karke safe jagah rakhein. Customer ki uploaded files <code>uploads/</code> folder me hoti hain \u2014 us folder ki copy bhi rakhein.</p>' +
    '<div class="help-row"><a class="btn g" href="/api/admin/backup" style="text-decoration:none">\u2B07 Download data.json Backup</a><label class="btn o">\u2B06 Restore data.json<input type="file" accept=".json,application/json" hidden data-change="restoreFile"></label></div>' +
    '<p class="muted" style="font-size:11px">Restore se pehle file ka JSON format check hota hai, aur current data ki safety copy server par <code>data.pre-restore-*.json</code> naam se ban jaati hai.</p></div>';
};
CH.restoreFile = async el => {
  const f = el.files[0]; el.value = ''; if (!f) return;
  const text = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('File padh nahi paye')); fr.readAsText(f); });
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error('Ye valid JSON file nahi hai: ' + e.message); }
  const d = j && j.data && Array.isArray(j.data.users) ? j.data : j;
  if (!d || !Array.isArray(d.users) || !Array.isArray(d.services)) throw new Error('Backup file sahi nahi hai (users / services missing)');
  if (!confirm('Current database poora replace ho jayega.\nBackup me: ' + d.users.length + ' users, ' + (d.orders || []).length + ' orders, ' + d.services.length + ' services.\nAage badhein?')) return;
  const r = await api('POST', '/api/admin/restore', { content: text });
  toast('Restore ho gaya: ' + r.users + ' users, ' + r.orders + ' orders'); setTimeout(() => location.reload(), 900);
};
