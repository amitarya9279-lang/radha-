'use strict';
/* =====================================================================
   FAST PRINT PORTAL v2 - browser app (core + customer side)
   Admin screens live in admin.js. No data is kept in the browser:
   everything comes from / goes to the server API (cookie session).
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupee = n => '\u20B9' + Number(n || 0).toFixed(2);
const safeHref = u => /^(https?:\/\/|mailto:|tel:|\/)/i.test(String(u || '').trim()) ? String(u).trim() : '';
const CHIP_LABEL = { all: 'All', aadhaar: 'Aadhaar', voter: 'Voter', pan: 'PAN', vehicle: 'Vehicle / RC / DL', farmer: 'Farmer & Schemes', ration: 'Ration', exam: 'Exam & Certificate', lookup: 'Lookup', manual: 'Manual' };
const CHIP_ICON = { all: '\u2728', aadhaar: '\uD83C\uDD94', voter: '\uD83D\uDDF3\uFE0F', pan: '\uD83D\uDCB3', vehicle: '\uD83D\uDE97', farmer: '\uD83C\uDF3E', ration: '\uD83C\uDF3D', exam: '\uD83D\uDCDC', lookup: '\uD83D\uDD0D', manual: '\u270D\uFE0F' };

const S = {
  me: null, cfg: {}, svc: [], counts: {}, stats: {}, pay: {}, rev: 0, staffSvc: [],
  view: 'dash', chip: 'all', kw: '', open: new Set(), sel: null, tab: 'in', cap: null,
  deskRole: 'admin', d: {}, of: { status: '', q: '' }, popupShown: false
};
const H = {};      // click actions   (data-act="name")
const CH = {};     // change actions  (data-change="name")

/* ------------------------------ helpers ------------------------------ */
let toastTimer;
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3500);
}
async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pp' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) { throw new Error('Network error - server se connection nahi ho paya'); }
  let d = {}; try { d = await r.json(); } catch (e) { /* non-json */ }
  if (r.status === 401 && S.me) { S.me = null; stopPoll(); closeModal(); loadCaptcha(); render(); toast(d.error || 'Session khatam. Dobara login karein.'); throw new Error(d.error || 'Session expired'); }
  if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
  return d;
}
const readFile = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('File padh nahi paye')); fr.readAsDataURL(f); });
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const val = id => { const el = $('#' + id); return el ? el.value : ''; };
const chk = id => { const el = $('#' + id); return !!(el && el.checked); };
const isCust = () => S.me && S.me.role === 'customer';
const isAdmin = () => S.me && S.me.role === 'admin';
const isDesk = () => S.me && (S.me.role === 'admin' || S.me.role === 'staff');
const svcById = id => S.svc.find(s => s.id === id);

function showModal(html, wide) {
  $('#appModal').innerHTML = '<div class="dark-overlay" data-bg="1"><div class="modal-box' + (wide ? ' wide' : '') + '">' + html + '</div></div>';
}
function closeModal() { $('#appModal').innerHTML = ''; }
const modalOpen = () => !!$('#appModal').firstChild;
function iconHtml(s, cls = '') {
  return s.iconUrl ? '<img class="ico3d ' + cls + '" src="' + esc(s.iconUrl) + '" alt="" loading="lazy">' : '<span class="ico-emoji ' + cls + '">' + esc(s.icon || '\uD83D\uDCC4') + '</span>';
}
const badgeHtml = s => s.badge ? '<span class="sbadge ' + esc(s.badge) + '">' + esc(s.badge) + '</span>' : '';

/* ------------------------------ custom code / ticker / popup ------------------------------ */
const SAFE_MODE = /[?&]safe=1\b/.test(location.search);       // open /?safe=1 to load the portal WITHOUT custom CSS/HTML/JS
let customJsDone = false;
function applyCustom() {
  const C = S.cfg || {};
  document.title = C.title || 'Print Portal';
  if (SAFE_MODE) return;
  $('#customCss').textContent = C.customCss || '';
  $('#customBanner').innerHTML = C.customHtml || '';
  if (C.customJs && !customJsDone) {
    customJsDone = true;
    const sc = document.createElement('script');
    sc.textContent = 'try{\n' + C.customJs + '\n}catch(e){console.error("Custom JS error:",e)}';
    document.body.appendChild(sc);
  }
}
let tickerSig = '';
function renderTicker() {
  const C = S.cfg || {}, host = $('#tickerHost');
  const items = C.tickerOn ? (C.ticker || []) : [];
  const sig = JSON.stringify([items, C.tickerSpeed]);
  if (sig === tickerSig) return;
  tickerSig = sig;
  if (!items.length) { host.innerHTML = ''; return; }
  const line = items.map(t => '<span>' + esc(t) + '</span>').join('<i>\u2726</i>');
  host.innerHTML = '<div class="news-ticker"><b class="nt-label">\uD83D\uDCE2 LIVE</b><div class="nt-track"><div class="nt-move" style="animation-duration:' + (Number(C.tickerSpeed) || 40) + 's">' + line + '</div></div></div>';
}
function popupKey(p) { return 'pp_pop_' + p.ver; }
function popupDismissed(p) {
  try {
    if (p.dismiss === 'always') return false;
    if (p.dismiss === 'session') return !!sessionStorage.getItem(popupKey(p));
    const v = localStorage.getItem(popupKey(p));
    if (!v) return false;
    return p.dismiss === 'once' ? true : Date.now() - Number(v) < 86400000;
  } catch (e) { return false; }
}
function maybePopup() {
  const p = S.cfg && S.cfg.popup;
  if (!p || !S.me || S.popupShown || popupDismissed(p) || modalOpen()) return;
  S.popupShown = true;
  const href = safeHref(p.btnLink);
  showModal('<button class="x-close" data-act="popupClose" aria-label="Close">\u2715</button><div class="ann-icon">\uD83D\uDCE2</div><h2 class="ann-title">' + esc(p.title || 'Announcement') + '</h2><p class="ann-msg">' + esc(p.msg) + '</p><div class="ann-actions">' +
    (href && p.btnText ? '<a class="btn" href="' + esc(href) + '" target="_blank" rel="noopener" data-act="popupClose">' + esc(p.btnText) + '</a>' : '') +
    '<button class="btn s" style="background:#334155" data-act="popupClose">Dismiss</button></div>');
}
H.popupClose = el => {
  const p = S.cfg && S.cfg.popup;
  if (p) { try { if (p.dismiss === 'session') sessionStorage.setItem(popupKey(p), '1'); else if (p.dismiss !== 'always') localStorage.setItem(popupKey(p), String(Date.now())); } catch (e) { /* private mode */ } }
  if (el.tagName !== 'A') closeModal(); else setTimeout(closeModal, 50);
};

/* ------------------------------ boot / auth ------------------------------ */
async function loadCaptcha() { try { S.cap = await api('GET', '/api/captcha'); const q = $('#capQ'); if (q) q.textContent = S.cap.q + ' = ?'; const i = $('#u_cap'); if (i) i.value = ''; } catch (e) { /* ignore */ } }
async function boot() {
  const d = await api('GET', '/api/bootstrap');
  Object.assign(S, { me: d.me, svc: d.services, counts: d.counts, stats: d.stats, rev: d.rev, pay: d.pay || {}, staffSvc: d.staffServices || [], cfg: d.settings });
  applyCustom();
}
async function init() {
  $('#root').innerHTML = '<div style="padding:60px 16px;text-align:center;color:#94a3b8;font-weight:700">Loading...</div>';
  try { S.cfg = (await api('GET', '/api/public')).settings; applyCustom(); } catch (e) { /* ignore */ }
  try { await boot(); await loadView(S.view); startPoll(); } catch (e) { S.me = null; await loadCaptcha(); }
  render();
  maybePopup();
}
async function afterLogin() {
  await boot(); S.view = 'dash'; S.popupShown = false; S.kw = ''; S.chip = 'all';
  await loadView('dash'); startPoll(); render(); maybePopup();
}
async function authCall(fn) {
  try { await fn(); } catch (e) { toast(e.message); loadCaptcha(); }
}
H.login = () => authCall(async () => {
  await api('POST', '/api/login', { mode: 'customer', u: val('u_name').trim(), p: val('u_pass'), capId: S.cap && S.cap.id, cap: val('u_cap') });
  await afterLogin();
});
H.register = () => authCall(async () => {
  await api('POST', '/api/register', { name: val('reg_n'), mobile: val('reg_m'), u: val('reg_u'), p: val('reg_p'), capId: S.cap && S.cap.id, cap: val('u_cap') });
  toast('Account ban gaya! Welcome.'); await afterLogin();
});
H.deskLogin = async () => {
  try {
    await api('POST', '/api/login', { mode: 'desk', role: S.deskRole, u: val('sec_u').trim(), p: val('sec_p') });
    closeModal(); await afterLogin(); toast('Welcome ' + S.me.name);
  } catch (e) { toast(e.message); }
};
H.logout = async () => { try { await api('POST', '/api/logout'); } catch (e) { /* ignore */ } S.me = null; S.tab = 'in'; stopPoll(); S.d = {}; closeModal(); await loadCaptcha(); render(); };
H.tab = el => { S.tab = el.dataset.v; render(); };
H.refreshCap = () => loadCaptcha();
H.deskOpen = () => showDeskLogin();
H.deskRole = el => { S.deskRole = el.dataset.v; showDeskLogin(); };
function showDeskLogin() {
  const adm = S.deskRole === 'admin';
  showModal('<div class="dark-check">\u2714</div><h2>DataWork Pro</h2><div class="sub">Master Staff & Admin Terminal</div>' +
    '<div class="dark-tabs"><button class="' + (!adm ? 'on' : '') + '" data-act="deskRole" data-v="operator">\uD83D\uDC64 Operator / Staff</button><button class="' + (adm ? 'on' : '') + '" data-act="deskRole" data-v="admin">\uD83D\uDC51 Super Admin</button></div>' +
    '<label>USERNAME</label><input id="sec_u" autocomplete="username" value="' + (adm ? 'admin' : '') + '" placeholder="' + (adm ? 'admin' : 'staff user') + '">' +
    '<label>PASSWORD</label><input id="sec_p" type="password" autocomplete="current-password" placeholder="Password daalein" data-enter="deskLogin">' +
    '<button class="btn" style="width:100%;background:#6366f1;padding:12px;margin-top:14px" data-act="deskLogin">\u2794 Login Master Desk</button>' +
    '<div style="text-align:center;margin-top:14px"><a data-act="closeModal" style="color:#64748b;font-size:11px">\u2715 Close Desk</a></div>');
  const f = $('#sec_p'); if (f) f.focus();
}
H.closeModal = closeModal;

function authView() {
  const C = S.cfg;
  return '<div class="portal-header"><div class="portal-brand"><b>' + esc(C.title) + '</b><br><small>All Documents & Print Services Hub</small></div></div>' +
  '<div class="login-stage"><div class="stage-left"><div><div class="hero-tag">INDIA - PNO 1 PRINT PORTAL</div>' +
  '<h3 style="color:#cbd5e1;font-size:16px;margin-bottom:6px">Welcome back to</h3><h1>' + esc(C.title) + '</h1><p>' + esc(C.sub) + '</p>' +
  '<div class="pill-list"><div class="feature-pill">\u26A1 Instant Download & Order Tracking</div><div class="feature-pill">\u20B9 Wholesale & Lowest Price Guarantee</div><div class="feature-pill">\uD83D\uDEE1\uFE0F 100% Encrypted Customer Data & Wallet</div><div class="feature-pill">\u21A9 Rejected Order par Instant Auto Refund</div></div>' +
  '<div class="trust-scene" style="margin-top:18px"><div class="cube-wrap"><div class="cube"><div class="face f1">\uD83D\uDD12<small>Secure</small></div><div class="face f2">\u26A1<small>Fast</small></div><div class="face f3">\u2714<small>Tracked</small></div><div class="face f4">\u21A9<small>Refund</small></div><div class="face f5">\uD83D\uDEE1\uFE0F</div><div class="face f6">\u20B9</div></div><div class="cube-shadow"></div></div>' +
  '<div class="trust-text"><b>Aapka paisa aur data surakshit</b><span>Har order ka live status dikhta hai, aur reject hone par paisa wallet me wapas aa jata hai.</span></div></div></div>' +
  '<div class="stats-bar"><div><b>24x7</b><small>Live Support</small></div><div><b>Instant</b><small>Auto Refund</small></div><div><b>Secure</b><small>Wallet</small></div></div></div>' +
  '<div class="stage-right"><div style="font-size:20px;font-weight:800;color:#0f172a;margin-bottom:2px">\uD83D\uDC64 Member Login</div><p style="color:#64748b;font-size:12px;margin-bottom:12px">Apne Customer Account me Login Karein</p>' +
  '<div class="alert-yellow"><b>\uD83D\uDCE2 \u091C\u093C\u0930\u0942\u0930\u0940 \u0938\u0942\u091A\u0928\u093E \u2014 \u091C\u093C\u0930\u0942\u0930 \u092A\u0922\u0947\u0902:</b><br>' + esc(C.notice) + '</div>' +
  '<div class="sub-tabs"><button class="' + (S.tab === 'in' ? 'on' : '') + '" data-act="tab" data-v="in">\u2794 Login</button><button class="' + (S.tab === 'up' ? 'on' : '') + '" data-act="tab" data-v="up">\uD83D\uDC64+ Naya Account (FREE)</button></div>' +
  (S.tab === 'in'
    ? '<label>Mobile / Username</label><input id="u_name" autocomplete="username" placeholder="Mobile Number ya Username daalein"><label>Password</label><input id="u_pass" type="password" autocomplete="current-password" placeholder="Password darj karein" data-enter="login">'
    : '<label>Full Name</label><input id="reg_n" placeholder="Apna Poora Naam"><label>Mobile Number (10 Digit)</label><input id="reg_m" inputmode="numeric" maxlength="13" placeholder="Mobile Number"><label>Username</label><input id="reg_u" autocomplete="username" placeholder="Unique username"><label>Password (min 8 akshar)</label><input id="reg_p" type="password" autocomplete="new-password" placeholder="Password" data-enter="register">') +
  '<div class="captcha-container"><span id="capQ">' + (S.cap ? esc(S.cap.q) + ' = ?' : '...') + '</span><input id="u_cap" inputmode="numeric" placeholder="Answer" data-enter="' + (S.tab === 'in' ? 'login' : 'register') + '"><button data-act="refreshCap" aria-label="New captcha">\u21BB</button></div>' +
  (S.tab === 'in' ? '<button class="btn" style="width:100%;padding:11px" data-act="login">\uD83D\uDD12 Captcha Verify & Login</button>' : '<button class="btn g" style="width:100%;padding:11px" data-act="register">Naya Account Banayein</button>') +
  '<div class="secret-link"><a data-act="deskOpen">\u26A1 System Gateway</a></div></div></div>';
}

/* ------------------------------ shell / navigation ------------------------------ */
const NAV_ADMIN = [
  ['services', '\u2699\uFE0F Services & Layout Builder'], ['staff', '\uD83E\uDEAA Staff & Permissions'], ['users', '\uD83D\uDC65 Customers & Wallets'], ['pays', '\uD83D\uDCB0 UTR Verification Queue', 'pays'],
  ['settings', '\uD83D\uDCB3 Portal & Payment Settings'], ['announce', '\uD83D\uDCE2 Ticker & Popup Notice'], ['notify', '\uD83D\uDD14 Telegram / WhatsApp Alerts'], ['custom', '\uD83D\uDCBB Live Code & CSS Customizer'], ['reports', '\uD83D\uDCCA Reports & Backup']
];
function navLink(v, label, count) {
  return '<a class="side-menu-link ' + (S.view === v || (v === 'dash' && S.view === 'service') ? 'on' : '') + '" data-act="go" data-v="' + v + '">' + label + (count ? '<span class="nav-count">' + count + '</span>' : '') + '</a>';
}
function shell(body) {
  const me = S.me, c = S.counts || {};
  const wa = safeHref(S.cfg.waLink);
  return '<div class="portal-top-strip"><div class="portal-brand"><b>' + esc(S.cfg.title) + '</b></div>' +
    (isCust() ? '<div class="hdr-search"><input id="hdrSearch" placeholder="\uD83D\uDD0D Service search  (Ctrl + K)" value="' + esc(S.kw) + '" autocomplete="off"></div>' : '') +
    '<div style="display:flex;align-items:center;gap:10px">' + (isCust() ? '<span class="hdr-wallet">\uD83D\uDCB3 ' + rupee(me.wallet) + '</span>' : '') +
    '<div class="user-head-tag">\uD83D\uDC64 ' + esc(me.name) + ' (' + esc(me.id) + ')</div></div></div>' +
  '<div class="main-layout"><div class="left-bar"><button class="dash-btn-sq" data-act="go" data-v="dash">\u229E Dashboard</button>' +
  (isCust() ? '<div class="wallet-box-side" data-act="go" data-v="wallet"><div><small style="opacity:.9">Balance</small><br><b style="font-size:16px">' + rupee(me.wallet) + '</b></div><span class="btn s" style="background:#fff;color:#059669">+ Add</span></div>' : '') +
  '<div class="nav-list" style="margin-top:12px">' + navLink('dash', '\uD83C\uDFE0 Dashboard') + navLink('orders', '\uD83D\uDCCB Orders Queue', c.pending) +
  (isCust() ? navLink('wallet', '\uD83D\uDCB3 Wallet / Add Money') : '') +
  (isAdmin() ? '<div class="nav-sec">MASTER CONTROL</div>' + NAV_ADMIN.map(n => navLink(n[0], n[1], n[2] ? c[n[2]] : 0)).join('') : '') +
  (isAdmin() || isCust() ? navLink('complaints', '\uD83C\uDFA7 ' + (isAdmin() ? 'Complaints Desk' : 'Complaint / Support'), c.openTickets) : '') +
  (isCust() && wa ? '<a class="side-menu-link" href="' + esc(wa) + '" target="_blank" rel="noopener">\uD83D\uDCAC WhatsApp Group Join</a>' : '') +
  navLink('profile', '\uD83D\uDD11 Profile / Password') + '<a class="side-menu-link" data-act="logout" style="color:#f87171;margin-top:24px">\uD83D\uDEAA Logout</a></div></div>' +
  '<div class="content-area">' + body + '</div></div>';
}
H.go = el => go(el.dataset.v);
async function go(v) {
  S.view = v; closeModal();
  try { await loadView(v); } catch (e) { toast(e.message); }
  render(); window.scrollTo(0, 0);
}
async function loadView(v) {
  const q = new URLSearchParams();
  if (v === 'dash') {
    if (isCust()) S.d.orders = await api('GET', '/api/orders?limit=5');
    else if (isDesk()) S.d.orders = await api('GET', '/api/orders?status=Pending&limit=8');
    if (isAdmin()) S.d.pays = (await api('GET', '/api/admin/pays')).items;
  } else if (v === 'orders') {
    if (S.of.status) q.set('status', S.of.status); if (S.of.q) q.set('q', S.of.q); q.set('limit', '300');
    S.d.orders = await api('GET', '/api/orders?' + q);
  } else if (v === 'wallet') S.d.wallet = await api('GET', '/api/wallet');
  else if (v === 'complaints') { S.d.tickets = (await api('GET', '/api/complaints')).items; if (isCust()) S.d.myOrders = (await api('GET', '/api/orders?limit=100')).items; }
  else if (v === 'users') S.d.users = (await api('GET', '/api/admin/users')).items;
  else if (v === 'staff') S.d.users = (await api('GET', '/api/admin/users')).items;
  else if (v === 'pays') S.d.pays = (await api('GET', '/api/admin/pays')).items;
  else if (['settings', 'announce', 'notify', 'custom'].includes(v)) S.d.adm = await api('GET', '/api/admin/settings');
  else if (v === 'reports') S.d.orders = await api('GET', '/api/orders?limit=1000');
}
function viewBody() {
  const V = { dash: dashView, service: serviceView, orders: ordersView, wallet: walletView, complaints: complaintsView, profile: profileView };
  const A = window.ADMIN_VIEWS || {};
  const f = V[S.view] || A[S.view] || dashView;
  return f();
}
function render() {
  const root = $('#root');
  root.innerHTML = S.me ? shell(viewBody()) : authView();
  renderTicker();
}
async function refreshAll() {          // re-fetch current screen from server
  await boot(); await loadView(S.view); render();
}

/* ------------------------------ polling (live updates) ------------------------------ */
let pollTimer = null;
function startPoll() { stopPoll(); pollTimer = setInterval(poll, 15000); }
function stopPoll() { clearInterval(pollTimer); pollTimer = null; }
async function poll() {
  if (!S.me || document.hidden) return;
  try {
    const p = await api('GET', '/api/poll');
    S.counts = p.counts; if (isCust()) S.me.wallet = p.wallet;
    if (p.rev !== S.rev) {
      S.rev = p.rev;
      const a = document.activeElement, typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      if (!typing && !modalOpen() && S.view !== 'service') { await boot(); await loadView(S.view); render(); }
    }
  } catch (e) { /* offline - try again next tick */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ------------------------------ global events ------------------------------ */
document.addEventListener('click', async e => {
  const bg = e.target.dataset && e.target.dataset.bg;
  if (bg && e.target.classList.contains('dark-overlay')) { closeModal(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || !H[el.dataset.act] || el.dataset.busy) return;
  el.dataset.busy = '1';
  try { await H[el.dataset.act](el, e); } catch (err) { toast(err.message || String(err)); }
  finally { delete el.dataset.busy; }
});
document.addEventListener('change', async e => {
  const el = e.target.closest('[data-change]');
  if (!el || !CH[el.dataset.change]) return;
  try { await CH[el.dataset.change](el, e); } catch (err) { toast(err.message || String(err)); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.enter && H[e.target.dataset.enter]) { e.preventDefault(); H[e.target.dataset.enter](e.target, e); return; }
  if (e.key === 'Escape' && modalOpen()) { closeModal(); return; }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a' && !S.me) { e.preventDefault(); showDeskLogin(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && isCust()) { e.preventDefault(); openSearchModal(); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'hdrSearch' || e.target.id === 'svcSearch') {
    S.kw = e.target.value;
    ['hdrSearch', 'svcSearch'].forEach(id => { const o = $('#' + id); if (o && o !== e.target) o.value = S.kw; });
    if (S.view !== 'dash') { go('dash').then(() => { const f = $('#hdrSearch'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }); return; }
    refreshServiceArea();
  } else if (e.target.id === 'kModal') renderKResults();
});
document.addEventListener('mousemove', e => {                    // 3D tilt effect
  const t = e.target.closest && e.target.closest('.feat-card,.mini-tile,.qb-btn');
  if (!t) return;
  const r = t.getBoundingClientRect();
  t.style.setProperty('--ry', ((e.clientX - r.left) / r.width - .5) * 14 + 'deg');
  t.style.setProperty('--rx', (.5 - (e.clientY - r.top) / r.height) * 14 + 'deg');
});
document.addEventListener('mouseout', e => {
  const t = e.target.closest && e.target.closest('.feat-card,.mini-tile,.qb-btn');
  if (t && !t.contains(e.relatedTarget)) { t.style.setProperty('--rx', '0deg'); t.style.setProperty('--ry', '0deg'); }
});

/* ------------------------------ customer dashboard ------------------------------ */
const stat = (c, l, v) => '<div class="stat ' + c + '"><small>' + l + '</small><b>' + v + '</b></div>';
const svcMatch = s => {
  if (S.chip !== 'all' && s.chip !== S.chip) return false;
  const k = S.kw.trim().toLowerCase();
  if (!k) return true;
  return [s.name, s.group, s.serverLabel, CHIP_LABEL[s.chip], s.badge].some(x => String(x || '').toLowerCase().includes(k));
};
function quickBar(list) {
  if (!list.length) return '';
  return '<div class="sec-title">\u26A1 Quick Services</div><div class="quick-bar">' + list.map(s =>
    '<button class="qb-btn" data-act="openSvc" data-id="' + esc(s.id) + '">' + (s.badge ? '<span class="sbadge corner ' + esc(s.badge) + '">' + esc(s.badge) + '</span>' : '') +
    iconHtml(s, 'qb-ico') + '<b>' + esc(s.name) + '</b><em>' + rupee(s.price) + '</em><span class="live-dot">\u25CF ACTIVE</span></button>').join('') + '</div>';
}
function accordion(list) {
  const groups = new Map();
  list.forEach(s => { const g = s.group || s.name; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); });
  if (!groups.size) return '';
  const searching = !!S.kw.trim();
  return '<div class="sec-title">\uD83D\uDDA5\uFE0F Multi-Server Services <small>(card par click karke servers dekhein)</small></div><div class="acc-list">' +
    [...groups.entries()].map(([g, arr]) => {
      const open = searching || S.open.has(g), min = Math.min(...arr.map(x => x.price));
      const badges = [...new Set(arr.map(x => x.badge).filter(Boolean))];
      return '<div class="acc-card ' + (open ? 'open' : '') + '"><div class="acc-head" data-act="toggleGroup" data-id="' + esc(g) + '">' + iconHtml(arr[0], 'acc-ico') +
        '<div class="acc-title"><b>' + esc(g) + '</b><small>' + arr.length + ' server' + (arr.length > 1 ? 's' : '') + ' \u2022 from ' + rupee(min) + '</small></div>' +
        '<div class="acc-badges">' + badges.map(b => '<span class="sbadge ' + b + '">' + b + '</span>').join('') + '</div><span class="acc-chev">\u25BE</span></div>' +
        (open ? '<div class="acc-body">' + arr.map(s => '<div class="srv-row"><div class="srv-name"><b>' + esc(s.serverLabel || s.name) + '</b> ' + badgeHtml(s) + '<small>' + esc(s.name) + '</small></div><div class="srv-price">' + rupee(s.price) + '</div><button class="btn s g" data-act="openSvc" data-id="' + esc(s.id) + '">Open \u2192</button></div>').join('') + '</div>' : '') + '</div>';
    }).join('') + '</div>';
}
function gridTiles(list) {
  return '<div class="sec-title">\uD83D\uDDC2\uFE0F Main Services Grid</div><div class="services-3d-grid">' + (list.map(s =>
    '<div class="mini-tile" data-act="openSvc" data-id="' + esc(s.id) + '">' + (s.badge ? '<span class="sbadge corner ' + esc(s.badge) + '">' + esc(s.badge) + '</span>' : '') + '<div class="m-ico">' + iconHtml(s) + '</div><b>' + esc(s.name) + '</b><div class="m-rate">' + rupee(s.price) + '</div></div>').join('') ||
    '<div class="card" style="grid-column:1/-1;text-align:center;color:var(--mut)">Is filter me koi service nahi mili</div>') + '</div>';
}
function serviceArea() {
  const vis = S.svc.filter(s => s.on !== false);
  const m = vis.filter(svcMatch);
  const quick = m.filter(s => s.placement === 'quick'), acc = m.filter(s => s.placement === 'accordion'), grid = m.filter(s => s.placement === 'grid');
  // everything is also reachable from the "All Services" grid when a search/filter is active
  const gridList = (S.kw.trim() || S.chip !== 'all') ? m : grid;
  return quickBar(quick) + accordion(acc) + gridTiles(gridList);
}
function refreshServiceArea() { const a = $('#svcArea'); if (a) a.innerHTML = serviceArea(); }
function chipsRow() {
  return '<div class="chips-wrap"><div class="sec-title" style="margin:0 0 8px">\uD83C\uDFAF All Services \u2014 Ek Jagah</div><div class="chips">' +
    ['all', 'aadhaar', 'voter', 'pan', 'vehicle', 'farmer', 'ration', 'exam', 'lookup', 'manual'].map(c =>
      '<button class="chipbtn ' + (S.chip === c ? 'on' : '') + '" data-act="chip" data-v="' + c + '">' + CHIP_ICON[c] + ' ' + CHIP_LABEL[c] + '</button>').join('') + '</div></div>';
}
H.chip = el => { S.chip = el.dataset.v; const c = $('.chips-wrap'); if (c) c.outerHTML = chipsRow(); refreshServiceArea(); };
H.toggleGroup = el => { const g = el.dataset.id; S.open.has(g) ? S.open.delete(g) : S.open.add(g); refreshServiceArea(); };
H.openSvc = el => { closeModal(); S.sel = el.dataset.id; S.view = 'service'; render(); window.scrollTo(0, 0); };

function dashView() {
  if (isAdmin()) return window.ADMIN_VIEWS.dash();
  const st = S.stats || {}, wa = safeHref(S.cfg.waLink);
  if (isDesk()) {
    return '<div class="stat-grid">' + stat('warn', 'Pending Orders', st.pending || 0) + stat('ok', 'Completed', st.done || 0) + stat('inf', 'Total Assigned', st.total || 0) + '</div>' +
      '<div class="card"><h3 class="h3">Pending Orders Queue</h3>' + ordersTable((S.d.orders || {}).items || []) + '</div>';
  }
  return '<div class="stat-grid">' + stat('ok', 'Wallet Balance', rupee(S.me.wallet)) + stat('inf', 'Total Orders', st.total || 0) + stat('warn', 'Pending', st.pending || 0) + stat('ok', 'Completed', st.done || 0) + '</div>' +
    '<div class="help-row"><button class="btn" data-act="go" data-v="wallet">\uD83D\uDCB3 Add Money</button><button class="btn o" data-act="go" data-v="complaints">\uD83C\uDFA7 Complaint Karein</button>' +
    (wa ? '<a class="btn wa" href="' + esc(wa) + '" target="_blank" rel="noopener" style="text-decoration:none">\uD83D\uDCAC WhatsApp Group Join Karein</a>' : '') + '</div>' +
    '<div class="search-banner"><small>\uD83D\uDD0D Services Search \u2014 naam type karein (PAN, Voter, License, RC...) &nbsp;<span class="kbd">Ctrl</span>+<span class="kbd">K</span></small>' +
    '<input id="svcSearch" placeholder="Yahan service ka naam type karein..." value="' + esc(S.kw) + '" autocomplete="off"></div>' +
    chipsRow() + '<div id="svcArea">' + serviceArea() + '</div>' +
    '<div class="card"><h3 class="h3">Recent Orders</h3>' + ordersTable(((S.d.orders || {}).items) || []) + '</div>';
}

/* Ctrl+K search modal */
function openSearchModal() {
  showModal('<h3 class="h3">\uD83D\uDD0D Quick Service Search</h3><input id="kModal" placeholder="Service ka naam likhein..." autocomplete="off" data-enter="kOpenFirst"><div id="kRes" class="k-res"></div><div style="text-align:center;margin-top:10px;font-size:11px;color:#64748b">Enter = pehla result kholein \u2022 Esc = band</div>');
  renderKResults(); const i = $('#kModal'); if (i) i.focus();
}
function kList() {
  const k = val('kModal').trim().toLowerCase();
  return S.svc.filter(s => s.on !== false && (!k || [s.name, s.group, s.serverLabel, CHIP_LABEL[s.chip]].some(x => String(x || '').toLowerCase().includes(k)))).slice(0, 30);
}
function renderKResults() {
  const l = kList();
  $('#kRes').innerHTML = l.map(s => '<div class="k-item" data-act="openSvc" data-id="' + esc(s.id) + '">' + iconHtml(s, 'k-ico') + '<div><b>' + esc(s.name) + '</b><small>' + esc(CHIP_LABEL[s.chip] || '') + (s.group ? ' \u2022 ' + esc(s.group) : '') + '</small></div>' + badgeHtml(s) + '<span class="k-price">' + rupee(s.price) + '</span></div>').join('') || '<p style="text-align:center;color:#64748b;padding:14px">Koi service nahi mili</p>';
}
H.kOpenFirst = () => { const l = kList(); if (l[0]) H.openSvc({ dataset: { id: l[0].id } }); };

/* ------------------------------ service detail + order ------------------------------ */
const DEFAULT_INSTR = ['Form ki sabhi jaankari dhyan se bharein.', 'Galat data par order reject ho sakta hai (paisa wallet me wapas aa jata hai).', 'Ek hi data baar-baar na lagayein.', 'Order ka status "Orders Queue" me live dikhega.'];
function fieldInput(f, i) {
  const id = 'sf_' + i, ph = esc(f.placeholder || ''), r = f.req ? ' <b style="color:#dc2626">*</b>' : '';
  let inp;
  if (f.type === 'dropdown') inp = '<select id="' + id + '">' + ['<option value="">-- Select --</option>'].concat(String(f.opts || '').split(',').map(x => x.trim()).filter(Boolean).map(o => '<option>' + esc(o) + '</option>')).join('') + '</select>';
  else if (f.type === 'textarea') inp = '<textarea id="' + id + '" rows="3" placeholder="' + ph + '"></textarea>';
  else if (f.type === 'file') inp = '<input id="' + id + '" type="file" accept="image/*,.pdf">';
  else inp = '<input id="' + id + '" type="' + (['password', 'date', 'number'].includes(f.type) ? f.type : 'text') + '" placeholder="' + ph + '" autocomplete="off">';
  return '<div><label>' + esc(f.label) + r + '</label>' + inp + (f.hint ? '<div class="field-hint">' + esc(f.hint) + '</div>' : '') + '</div>';
}
function serviceView() {
  const s = svcById(S.sel);
  if (!s) return '<div class="card">Service nahi mili. <a data-act="go" data-v="dash" style="color:var(--p)">Dashboard</a></div>';
  const bal = S.me.wallet, low = bal < s.price;
  const instr = (s.instructions && s.instructions.length) ? s.instructions : DEFAULT_INSTR;
  return '<button class="btn s" style="background:#334155;margin-bottom:12px" data-act="go" data-v="dash">\u2190 Back</button><div class="detail-layout"><div class="app-form-box"><div class="app-form-header">' + iconHtml(s, 'mini') + ' ' + esc(s.name) + (s.serverLabel ? ' \u2022 ' + esc(s.serverLabel) : '') + ' ' + badgeHtml(s) + '</div><div class="app-form-body">' +
    s.fields.map(fieldInput).join('') +
    '<div class="bar-row bar-bal"><span>Wallet Balance</span><span>' + rupee(bal) + '</span></div><div class="bar-row bar-chg"><span>Service Charge</span><span>' + rupee(s.price) + '</span></div>' +
    (low ? '<div class="alert-yellow" style="margin:0">Balance kam hai. <a data-act="go" data-v="wallet" style="color:#1d4ed8;font-weight:800">Add Money \u2192</a></div>' : '') +
    '<button class="btn g" style="padding:12px;width:100%" data-act="submitOrder" data-id="' + esc(s.id) + '" ' + (low ? 'disabled' : '') + '>\u2714 Submit Application (' + rupee(s.price) + ')</button></div></div>' +
    '<div class="instr-panel"><div class="instr-title">\uD83D\uDCCC Zaroori Instructions</div>' + instr.map(t => '<div class="instr-item"><span>\u25B6</span><span>' + esc(t) + '</span></div>').join('') + '</div></div>';
}
H.submitOrder = async el => {
  const s = svcById(el.dataset.id); if (!s) return;
  const formData = {};
  for (let i = 0; i < s.fields.length; i++) {
    const f = s.fields[i], inp = $('#sf_' + i);
    if (f.type === 'file') {
      const file = inp.files[0];
      if (!file) { if (f.req) throw new Error(f.label + ' bharna anivarya hai'); continue; }
      if (file.size > 5 * 1048576) throw new Error(f.label + ': file 5 MB se chhoti honi chahiye');
      formData[f.label] = { name: file.name, data: await readFile(file) };
    } else {
      const v = inp.value.trim();
      if (f.req && !v) throw new Error(f.label + ' bharna anivarya hai');
      formData[f.label] = v;
    }
  }
  const r = await api('POST', '/api/orders', { sid: s.id, formData });
  S.me.wallet = r.wallet; toast('Application submit ho gayi: #' + r.id);
  await boot(); await go('orders');
};

/* ------------------------------ orders ------------------------------ */
function ordersTable(list) {
  if (!list.length) return '<p style="text-align:center;padding:16px;color:var(--mut)">Koi order record nahi hai</p>';
  const desk = isDesk();
  return '<div class="tw"><table><tr><th>Order ID</th><th>Service</th>' + (desk ? '<th>User</th>' : '') + '<th>Price</th><th>Time</th><th>Data</th><th>Status</th><th>File / Action</th></tr>' + list.map(o =>
    '<tr><td><b>#' + esc(o.id) + '</b></td><td>' + esc(o.sname) + (o.serverLabel ? '<br><small style="color:var(--mut)">' + esc(o.serverLabel) + '</small>' : '') + '</td>' + (desk ? '<td>' + esc(o.uname) + '</td>' : '') +
    '<td><b>' + rupee(o.price) + '</b></td><td style="white-space:nowrap">' + esc(o.t) + '</td><td><button class="btn s" style="background:#4f46e5" data-act="viewData" data-id="' + esc(o.id) + '">\uD83D\uDD0D View</button></td>' +
    '<td><span class="tag ' + esc(o.status) + '">' + esc(o.status) + '</span>' + (o.note ? '<br><small style="color:var(--mut)">' + esc(o.note) + '</small>' : '') + '</td><td class="tbl-actions">' +
    (o.hasFile ? '<a class="btn s o" href="/api/orders/' + esc(o.id) + '/file" style="text-decoration:none">\u2B07 Download</a> ' : '') +
    (desk && o.status === 'Pending' ? '<label class="btn s g">Upload Result<input type="file" hidden data-change="uploadResult" data-id="' + esc(o.id) + '"></label> <button class="btn s r" data-act="rejectOrder" data-id="' + esc(o.id) + '">Reject & Refund</button>' : '') + '</td></tr>').join('') + '</table></div>';
}
function ordersView() {
  const items = (S.d.orders || {}).items || [], total = (S.d.orders || {}).total || 0;
  return '<div class="card"><h3 class="h3">Orders List (' + total + ')</h3><div class="tools-row"><select id="of_status" data-change="orderFilter"><option value="">All Status</option>' +
    ['Pending', 'Completed', 'Rejected'].map(x => '<option ' + (S.of.status === x ? 'selected' : '') + '>' + x + '</option>').join('') + '</select><input id="of_q" placeholder="Search order / service / user" value="' + esc(S.of.q) + '" data-enter="orderSearch"><button class="btn s" data-act="orderSearch">Search</button></div>' + ordersTable(items) + '</div>';
}
CH.orderFilter = async () => { S.of.status = val('of_status'); await loadView('orders'); render(); };
H.orderSearch = async () => { S.of.q = val('of_q').trim(); S.of.status = val('of_status'); await loadView('orders'); render(); const i = $('#of_q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } };
H.viewData = async el => {
  const list = ((S.d.orders || {}).items || []), o = list.find(x => x.id === el.dataset.id) || ((await api('GET', '/api/orders?q=' + encodeURIComponent(el.dataset.id))).items || [])[0];
  if (!o) return;
  const rows = Object.entries(o.formData || {}).map(([k, v]) => '<tr><th>' + esc(k) + '</th><td>' + (v && typeof v === 'object' ? '\uD83D\uDCCE <a style="color:var(--p)" href="/api/orders/' + esc(o.id) + '/attachment?k=' + encodeURIComponent(k) + '">' + esc(v.name || 'Download') + '</a>' + (v.size ? ' (' + fmtSize(v.size) + ')' : '') : '<span class="copyable">' + esc(v) + '</span>') + '</td></tr>').join('');
  const svc = isAdmin() ? S.svc.find(s => s.id === o.sid) : null, disp = (o.dispatch || []).map(d => '<div style="font-size:11px;color:' + (d.ok ? '#34d399' : '#f87171') + '">' + (d.ok ? '\u2714' : '\u2716') + ' ' + esc(d.url) + ' (' + (d.status || d.err || '-') + ')</div>').join('');
  showModal('<h3 class="h3">Order #' + esc(o.id) + ' \u2014 ' + esc(o.sname) + '</h3><div class="tw"><table>' + (rows || '<tr><td>Koi data nahi</td></tr>') + '</table></div>' +
    (disp ? '<h4 style="margin:12px 0 4px;color:#94a3b8;font-size:11px">SERVER DISPATCH LOG</h4>' + disp : '') +
    (svc && (svc.endpoints || []).length && !disp ? '<p style="margin-top:10px;font-size:11px;color:#94a3b8">Dispatch pending / not attempted.</p>' : '') +
    '<div style="text-align:right;margin-top:14px"><button class="btn s" data-act="closeModal">Close</button></div>', true);
};
CH.uploadResult = async el => {
  const f = el.files[0]; if (!f) return;
  if (f.size > 8 * 1048576) throw new Error('File 8 MB se chhoti honi chahiye');
  await api('POST', '/api/orders/' + el.dataset.id + '/complete', { file: { name: f.name, data: await readFile(f) } });
  toast('File upload ho gayi aur order Complete hua'); await refreshAll();
};
H.rejectOrder = async el => {
  const reason = prompt('Reject karne ka karan likhein (optional). Customer ko paisa wallet me wapas mil jayega.');
  if (reason === null) return;
  const r = await api('POST', '/api/orders/' + el.dataset.id + '/reject', { reason });
  toast('Order reject hua aur ' + rupee(r.refunded) + ' wallet me refund ho gaya'); await refreshAll();
};

/* ------------------------------ wallet ------------------------------ */
function walletView() {
  const w = S.d.wallet || { pays: [], ledger: [] }, P = w.pay || S.pay || {};
  return '<div class="two" style="align-items:start"><div class="card" style="background:#fff;color:#0f172a"><h3 style="margin-bottom:10px">\uD83D\uDCF1 UPI se Payment Karein</h3><div class="qr-container-3d">' +
    (P.qr ? '<img class="qr-code-img" src="' + esc(P.qr) + '" alt="QR">' : '<div style="padding:30px;color:#64748b">QR abhi set nahi hai</div>') + '<div style="margin-top:10px;font-weight:800">UPI ID: <span class="copyable">' + esc(P.upi) + '</span></div></div>' +
    '<p style="font-size:12px;color:#475569;margin-top:10px">Payment karne ke baad neeche amount aur UTR / Transaction ID bharein. Verify hote hi balance add ho jayega.</p></div>' +
    '<div class="card"><h3 class="h3">\uD83D\uDCB0 Add Money Request</h3><label>Amount (\u20B9)</label><input id="p_amt" type="number" min="1" placeholder="Jaise 100"><label>UTR / Transaction ID (12 digit)</label><input id="p_utr" placeholder="UTR number" data-enter="submitPay"><button class="btn g" style="width:100%;margin-top:14px;padding:11px" data-act="submitPay">Submit for Verification</button></div></div>' +
    '<div class="card"><h3 class="h3">Payment Requests</h3>' + (w.pays.length ? '<div class="tw"><table><tr><th>ID</th><th>Amount</th><th>UTR</th><th>Time</th><th>Status</th></tr>' + w.pays.map(p => '<tr><td>' + esc(p.id) + '</td><td>' + rupee(p.amt) + '</td><td>' + esc(p.utr) + '</td><td>' + esc(p.t) + '</td><td><span class="tag ' + esc(p.status) + '">' + esc(p.status) + '</span></td></tr>').join('') + '</table></div>' : '<p style="color:var(--mut)">Abhi koi request nahi</p>') + '</div>' +
    '<div class="card"><h3 class="h3">Wallet History</h3>' + ledgerTable(w.ledger) + '</div>';
}
function ledgerTable(l) {
  return l.length ? '<div class="tw"><table><tr><th>Time</th><th>Type</th><th>Amount</th><th>Balance</th><th>Note</th></tr>' + l.map(x => '<tr><td style="white-space:nowrap">' + esc(x.t) + '</td><td><span class="tag">' + esc(x.type) + '</span></td><td style="color:' + (x.amt < 0 ? '#f87171' : '#34d399') + ';font-weight:800">' + (x.amt < 0 ? '-' : '+') + rupee(Math.abs(x.amt)) + '</td><td>' + rupee(x.bal) + '</td><td>' + esc(x.note) + '</td></tr>').join('') + '</table></div>' : '<p style="color:var(--mut)">Koi entry nahi</p>';
}
H.submitPay = async () => {
  const amt = Number(val('p_amt')), utr = val('p_utr').trim();
  if (!(amt > 0) || utr.length < 6) throw new Error('Sahi amount aur UTR dalein');
  await api('POST', '/api/pays', { amt, utr });
  await loadView('wallet'); render();
  showModal('<div style="text-align:center;color:#0f172a"><div style="width:64px;height:64px;background:#10b981;border-radius:50%;color:#fff;display:grid;place-items:center;font-size:32px;margin:0 auto 12px">\u2714</div><h2>Request Submit Ho Gayi!</h2><p style="margin:10px 0;color:#475569">Aapka payment verify hone me 5\u201310 minute lag sakte hain. Verify hote hi balance add ho jayega.</p><button class="btn" data-act="closeModal">OK</button></div>');
};

/* ------------------------------ complaints ------------------------------ */
function ticketHtml(t) {
  return '<div class="ticket"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>' + esc(t.id) + ' \u2022 ' + esc(t.subject) + '</b><span class="tag ' + esc(t.status) + '">' + esc(t.status) + '</span></div>' +
    '<div style="color:var(--mut);font-size:11px;margin:4px 0">' + esc(t.uname) + ' \u2022 ' + esc(t.t) + (t.oid ? ' \u2022 Order #' + esc(t.oid) : '') + '</div><div style="white-space:pre-wrap">' + esc(t.msg) + '</div>' +
    t.replies.map(r => '<div class="reply"><b>' + esc(r.by) + '</b> <small>' + esc(r.t) + '</small><br>' + esc(r.text) + '</div>').join('') +
    (isAdmin() ? '<div style="display:flex;gap:8px;margin-top:10px"><input id="rp_' + esc(t.id) + '" placeholder="Reply likhein..."><button class="btn s g" data-act="replyTicket" data-id="' + esc(t.id) + '">Reply</button></div>' : '') + '</div>';
}
function complaintsView() {
  const t = S.d.tickets || [];
  const opts = ((S.d.myOrders) || []).map(o => '<option value="' + esc(o.id) + '">#' + esc(o.id) + ' - ' + esc(o.sname) + '</option>').join('');
  return (isCust() ? '<div class="card"><h3 class="h3">\uD83C\uDFA7 Nayi Complaint / Support Ticket</h3><label>Related Order (optional)</label><select id="cp_o"><option value="">-- Koi nahi --</option>' + opts + '</select><label>Subject</label><input id="cp_s" maxlength="120"><label>Problem</label><textarea id="cp_m" rows="3" maxlength="2000"></textarea><button class="btn g" style="margin-top:12px" data-act="submitTicket">Submit Complaint</button></div>' : '') +
    '<div class="card"><h3 class="h3">' + (isAdmin() ? 'All Tickets (' + t.length + ')' : 'Meri Complaints') + '</h3>' + (t.map(ticketHtml).join('') || '<p style="color:var(--mut)">Koi ticket nahi</p>') + '</div>';
}
H.submitTicket = async () => {
  await api('POST', '/api/complaints', { oid: val('cp_o'), subject: val('cp_s'), msg: val('cp_m') });
  toast('Complaint submit ho gayi. Jaldi reply milega.'); await refreshAll();
};
H.replyTicket = async el => {
  const text = val('rp_' + el.dataset.id).trim(); if (!text) throw new Error('Reply likhein');
  await api('POST', '/api/complaints/' + el.dataset.id + '/reply', { text }); toast('Reply bhej diya'); await refreshAll();
};

/* ------------------------------ profile ------------------------------ */
function profileView() {
  const m = S.me;
  return '<div class="card" style="max-width:520px"><h3 class="h3">\uD83D\uDD11 Profile</h3><p style="line-height:1.9"><b>Name:</b> ' + esc(m.name) + '<br><b>ID:</b> ' + esc(m.id) + '<br><b>Username:</b> ' + esc(m.u) + (m.mobile ? '<br><b>Mobile:</b> ' + esc(m.mobile) : '') + '<br><b>Role:</b> ' + esc(m.role) + '<br><b>Last login:</b> ' + esc(m.lastLogin) + '</p>' +
    '<h4 style="margin:16px 0 4px">Password Badlein</h4><label>Purana Password</label><input id="pw_o" type="password" autocomplete="current-password"><label>Naya Password (min 8 akshar)</label><input id="pw_n" type="password" autocomplete="new-password"><button class="btn g" style="margin-top:12px" data-act="changePw">Update Password</button></div>';
}
H.changePw = async () => {
  await api('POST', '/api/me/password', { old: val('pw_o'), new: val('pw_n') });
  toast('Password badal gaya'); $('#pw_o').value = ''; $('#pw_n').value = '';
};

init();
