// FAST PRINT PORTAL v2 - secure backend (zero npm dependencies)
// Run:  node server.js      then open  http://localhost:3000
//
// What changed vs v1:
//  * Database lives ONLY on the server. The browser never receives password hashes,
//    Telegram tokens or other users' wallets any more (v1 sent the whole DB to every visitor).
//  * Login uses server sessions (HttpOnly cookie). Existing SHA-256("pp:"+password) hashes keep working.
//  * Every wallet movement is written to a ledger. Orders / refunds / UTR approvals are atomic.
//  * Telegram + WhatsApp admin notifications are fire-and-forget and can never break a customer request.
//  * data.json keeps the same { rev, data } format - all old keys are preserved, new keys are only added.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;          // on hosting: point to the persistent disk folder
const FILE = path.join(DATA_DIR, 'data.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';           // set to 1 when behind nginx / Render / Railway etc.
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const LIMIT_JSON = 1 * 1024 * 1024;
const LIMIT_UPLOAD = 30 * 1024 * 1024;
const LIMIT_RESTORE = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/* ============================== HELPERS ============================== */
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg, code = 400) => { throw new HttpError(code, msg); };
const IST = { timeZone: 'Asia/Kolkata' };
const now = () => new Date().toLocaleString('en-IN', IST);
const today = () => new Date().toLocaleDateString('en-IN', IST);
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = p => sha256('pp:' + p);                          // identical to the v1 browser hash -> old logins still work
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const clone = x => JSON.parse(JSON.stringify(x));
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rupee = n => '\u20B9' + r2(n).toFixed(2);

/* ============================== DATABASE ============================== */
const DEFAULT_SETTINGS = {
  title: 'PDF PRINT PORTAL',
  sub: 'India ka sabse tez Print Portal \u2014 Fast, safe aur sasti document delivery.',
  notice: 'Password bhul gaye hain? Forgot Password par click karein. Naye updates aur link ke liye Telegram se zaroor judein.',
  upi: 'merchant@upi', qr: '', tgBotToken: '', tgChatId: '', waLink: '',
  // --- new in v2 ---
  waWebhook: '', waApiKey: '',
  notifyOrder: true, notifyDeposit: true, notifyComplaint: true,
  tickerOn: false, tickerText: '', tickerSpeed: 40,
  popupOn: false, popupTitle: '', popupMsg: '', popupBtnText: '', popupBtnLink: '', popupDismiss: 'session', popupVer: 1,
  customCss: '', customHtml: '', customJs: ''
};
const SEQ_DEFAULT = { CUS: 1, STF: 1, SRV: 1, ORD: 1, PAY: 1, TKT: 1, LED: 1 };
const CHIPS = ['aadhaar', 'voter', 'pan', 'vehicle', 'farmer', 'ration', 'exam', 'lookup', 'manual'];
const PLACEMENTS = ['quick', 'accordion', 'grid'];
const BADGES = ['', 'FAST', 'NEW', 'PRO', 'LIVE'];
const FIELD_TYPES = ['text', 'password', 'date', 'dropdown', 'file', 'number', 'textarea'];

let state = null, rev = 0, lastBackup = 0;

function inferChip(n) {
  n = String(n || '').toLowerCase();
  if (/aadhaar|aadhar/.test(n)) return 'aadhaar';
  if (/voter|epic/.test(n)) return 'voter';
  if (/\bpan\b/.test(n)) return 'pan';
  if (/\brc\b|\bdl\b|vehicle|driving|puc/.test(n)) return 'vehicle';
  if (/farmer|kisan|dbt|scheme/.test(n)) return 'farmer';
  if (/ration/.test(n)) return 'ration';
  if (/learning|exam|birth|certificate|cert/.test(n)) return 'exam';
  if (/lookup|search|status/.test(n)) return 'lookup';
  return 'manual';
}
function inferLayout(n) {
  n = String(n || '').toLowerCase();
  if (/learning|voter pdf|voter mobile|puc|birth/.test(n)) return { placement: 'quick', group: '' };
  if (/\brc pdf/.test(n)) return { placement: 'accordion', group: 'RC PDF' };
  if (/\bdl pdf/.test(n)) return { placement: 'accordion', group: 'DL PDF' };
  if (/aadhaar|aadhar/.test(n)) return { placement: 'accordion', group: 'Aadhaar PDF' };
  if (/farmer|dbt/.test(n)) return { placement: 'accordion', group: 'Farmer DBT' };
  return { placement: 'grid', group: '' };
}

// Adds missing keys only. Never removes or rewrites existing customer / wallet / order data.
function normalize(d) {
  d.users = Array.isArray(d.users) ? d.users : [];
  d.services = Array.isArray(d.services) ? d.services : [];
  d.orders = Array.isArray(d.orders) ? d.orders : [];
  d.pays = Array.isArray(d.pays) ? d.pays : [];
  d.complaints = Array.isArray(d.complaints) ? d.complaints : [];
  d.ledger = Array.isArray(d.ledger) ? d.ledger : [];
  d.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
  d.seq = Object.assign({}, SEQ_DEFAULT, d.seq || {});
  d.users.forEach(u => { delete u.plainPw; if (typeof u.wallet !== 'number') u.wallet = r2(u.wallet); });
  if (!d.users.some(u => u.role === 'admin' && u.u === 'admin')) {
    d.users.unshift({ id: 'ADM0001', u: 'admin', name: 'Super Admin', role: 'admin', hash: hashPw('Admin@12345'), wallet: 0, services: ['ALL'], loginCount: 0, lastLogin: now() });
  }
  d.services.forEach((s, i) => {
    const lay = inferLayout(s.name);
    if (!PLACEMENTS.includes(s.placement)) s.placement = lay.placement;
    if (typeof s.group !== 'string') s.group = lay.group;
    if (!CHIPS.includes(s.chip)) s.chip = inferChip(s.name);
    if (typeof s.serverLabel !== 'string') s.serverLabel = s.group ? 'Server 1' : '';
    if (!BADGES.includes(s.badge)) s.badge = '';
    if (typeof s.iconUrl !== 'string') s.iconUrl = '';
    if (typeof s.sort !== 'number') s.sort = (i + 1) * 10;
    if (!Array.isArray(s.endpoints)) s.endpoints = [];
    if (!Array.isArray(s.fields)) s.fields = [];
    if (!Array.isArray(s.instructions)) s.instructions = [];
  });
  // v1 bug fix: its counters could be lower than ids already in use (e.g. SRV counter 1 while SRV0007 exists)
  const bump = (prefix, list) => list.forEach(x => {
    const m = String(x && x.id || '').match(/^([A-Z]+)(\d+)$/);
    if (m && m[1] === prefix) d.seq[prefix] = Math.max(d.seq[prefix], Number(m[2]) + 1);
  });
  bump('CUS', d.users); bump('STF', d.users); bump('SRV', d.services); bump('ORD', d.orders);
  bump('PAY', d.pays); bump('TKT', d.complaints); bump('LED', d.ledger);
  return d;
}

try {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  state = normalize(j.data || j); rev = j.rev || 0;
  console.log('Data loaded: rev', rev, '| users:', state.users.length, '| orders:', state.orders.length);
} catch (e) {
  if (fs.existsSync(FILE)) { console.error('data.json is unreadable - refusing to start so nothing gets overwritten.\n', e.message); process.exit(1); }
  state = normalize({}); console.log('Fresh database created (admin / Admin@12345 - change it after login!)');
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ rev, data: state }));
  if (fs.existsSync(FILE) && Date.now() - lastBackup > 60000) {      // max 1 rolling backup per minute
    try { fs.copyFileSync(FILE, FILE + '.bak'); lastBackup = Date.now(); } catch (e) { /* ignore */ }
  }
  fs.renameSync(tmp, FILE);                                           // atomic write
}
function commit() {
  rev++;
  try { persist(); } catch (e) { console.error('SAVE ERROR', e); throw new HttpError(500, 'Server disk write failed'); }
}
// one-time safety copy of your original v1 file before it gets upgraded in place
try { const pre = path.join(DATA_DIR, 'data.pre-v2.json'); if (fs.existsSync(FILE) && !fs.existsSync(pre)) fs.copyFileSync(FILE, pre); } catch (e) { /* ignore */ }
persistSafe();
function persistSafe() { try { persist(); } catch (e) { console.error('Initial save failed', e.message); } }

function nextId(prefix, pad = 4) {
  const n = state.seq[prefix] || 1;
  state.seq[prefix] = n + 1;
  return prefix + String(n).padStart(pad, '0');
}
const findUser = id => state.users.find(u => u.id === id);

function walletMove(user, amt, type, note, by, ref) {
  amt = r2(amt);
  user.wallet = r2((user.wallet || 0) + amt);
  const e = { id: nextId('LED', 6), uid: user.id, uname: user.u, type, amt, bal: user.wallet, note: str(note, 200), by: by || 'system', ref: ref || '', t: now() };
  state.ledger.unshift(e);
  return e;
}

/* ============================== SESSIONS / SECURITY ============================== */
const sessions = new Map();                      // sha256(token) -> { uid, exp }
try {
  const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  Object.entries(s).forEach(([k, v]) => { if (v.exp > Date.now()) sessions.set(k, v); });
} catch (e) { /* no sessions yet */ }
let sessTimer = null;
function saveSessions() {
  clearTimeout(sessTimer);
  sessTimer = setTimeout(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions))); } catch (e) { /* ignore */ }
  }, 500);
}
function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(sha256(token), { uid, exp: Date.now() + SESSION_TTL });
  saveSessions();
  return token;
}
function dropUserSessions(uid, exceptKey) {
  for (const [k, v] of sessions) if (v.uid === uid && k !== exceptKey) sessions.delete(k);
  saveSessions();
}
const parseCookies = h => Object.fromEntries(String(h || '').split(';').map(c => c.trim().split(/=(.*)/s)).filter(a => a[0]).map(a => [a[0], decodeURIComponent(a[1] || '')]));

const hits = new Map();                          // simple in-memory rate limiter
const tooMany = (key, max, win) => { const a = (hits.get(key) || []).filter(t => Date.now() - t < win); hits.set(key, a); return a.length >= max; };
const hit = key => { const a = hits.get(key) || []; a.push(Date.now()); hits.set(key, a); };
setInterval(() => { for (const [k, a] of hits) { const f = a.filter(t => Date.now() - t < 3600000); f.length ? hits.set(k, f) : hits.delete(k); } for (const [k, v] of captchas) if (v.exp < Date.now()) captchas.delete(k); }, 600000).unref();

const captchas = new Map();
function newCaptcha() {
  const a = 1 + Math.floor(Math.random() * 9), b = 1 + Math.floor(Math.random() * 9), id = crypto.randomBytes(8).toString('hex');
  captchas.set(id, { ans: a + b, exp: Date.now() + 10 * 60000 });
  return { id, q: a + ' + ' + b };
}
function checkCaptcha(id, ans) {
  const c = captchas.get(String(id)); captchas.delete(String(id));
  if (!c || c.exp < Date.now() || Number(ans) !== c.ans) bad('Captcha galat hai');
}

const publicUser = u => u && ({
  id: u.id, u: u.u, name: u.name, mobile: u.mobile || '', role: u.role, wallet: r2(u.wallet), services: u.services || [],
  loginCount: u.loginCount || 0, lastLogin: u.lastLogin || '', created: u.created || '', locked: !!u.locked
});

/* ============================== NOTIFICATIONS (Telegram + WhatsApp) ============================== */
const notifyLog = [];                            // last 25 attempts, shown to admin for debugging
const logNotify = (ch, ok, info) => { notifyLog.unshift({ t: now(), ch, ok, info: String(info).slice(0, 200) }); notifyLog.length = Math.min(notifyLog.length, 25); };

function httpRequest(urlStr, opt = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Invalid URL')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Only http/https URLs allowed'));
    const body = opt.body == null ? null : (typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body));
    const headers = Object.assign({}, opt.headers || {});
    if (body != null) { headers['Content-Type'] = headers['Content-Type'] || 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: opt.method || 'GET', headers, timeout: opt.timeout || 8000 }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size < 20000) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function sendTelegram(msg) {
  const S = state.settings;
  const token = str(S.tgBotToken, 200), chats = str(S.tgChatId, 200).split(/[,\s]+/).filter(Boolean);
  if (!token || !chats.length) return { skipped: true };
  if (!/^\d+:[\w-]+$/.test(token)) throw new Error('Telegram bot token format is wrong');
  const html = '<b>' + escHtml(msg.title) + '</b>\n' + msg.lines.map(([k, v]) => escHtml(k) + ': <b>' + escHtml(v) + '</b>').join('\n');
  for (const chat of chats) {
    const r = await httpRequest('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', body: { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true } });
    if (r.status !== 200) throw new Error('Telegram HTTP ' + r.status + ' ' + r.body.slice(0, 120));
  }
  return { ok: true };
}
async function sendWhatsApp(msg) {
  const S = state.settings, url = str(S.waWebhook, 1000), key = str(S.waApiKey, 300);
  if (!url) return { skipped: true };
  const plain = msg.title + '\n' + msg.lines.map(([k, v]) => k + ': ' + v).join('\n');
  let r;
  if (/\{message\}|\{apikey\}/.test(url)) {      // GET gateway style, e.g. https://api.callmebot.com/whatsapp.php?phone=91XXXXXXXXXX&text={message}&apikey={apikey}
    r = await httpRequest(url.replace(/\{message\}/g, encodeURIComponent(plain)).replace(/\{apikey\}/g, encodeURIComponent(key)));
  } else {                                        // generic JSON webhook
    const headers = key ? { Authorization: 'Bearer ' + key, 'x-api-key': key } : {};
    r = await httpRequest(url, { method: 'POST', headers, body: { event: msg.event, title: msg.title, message: plain, text: plain, data: Object.fromEntries(msg.lines), apiKey: key || undefined } });
  }
  if (r.status < 200 || r.status >= 300) throw new Error('WhatsApp HTTP ' + r.status + ' ' + r.body.slice(0, 120));
  return { ok: true };
}
// Non-blocking: caller never waits and can never fail because of this.
function notify(event, title, lines) {
  const S = state.settings;
  const on = { order: S.notifyOrder, deposit: S.notifyDeposit, complaint: S.notifyComplaint }[event];
  if (!on) return;
  const msg = { event, title, lines: lines.map(([k, v]) => [k, String(v)]).concat([['Time', now()]]) };
  setImmediate(() => {
    for (const [name, fn] of [['Telegram', sendTelegram], ['WhatsApp', sendWhatsApp]]) {
      Promise.resolve().then(() => fn(msg)).then(r => { if (!r.skipped) logNotify(name, true, event + ' sent'); }).catch(e => logNotify(name, false, e.message));
    }
  });
}

// Optional per-service forwarding: tries endpoint 1, falls back to endpoint 2, 3 ... Result is stored on the order.
async function dispatchOrder(order, svc) {
  const eps = (svc.endpoints || []).filter(Boolean);
  if (!eps.length) return;
  const formData = {};
  Object.entries(order.formData || {}).forEach(([k, v]) => { if (typeof v === 'string' && !v.startsWith('data:')) formData[k] = v; });
  const payload = { orderId: order.id, service: svc.name, server: svc.serverLabel || '', price: order.price, customer: order.uname, formData };
  const out = [];
  for (const url of eps) {
    try {
      const r = await httpRequest(url, { method: 'POST', body: payload, timeout: 10000 });
      const ok = r.status >= 200 && r.status < 300;
      out.push({ url, ok, status: r.status, t: now() });
      if (ok) break;
    } catch (e) { out.push({ url, ok: false, status: 0, err: e.message.slice(0, 80), t: now() }); }
  }
  order.dispatch = out;
  try { commit(); } catch (e) { /* ignore */ }
}

/* ============================== FILES ============================== */
function saveDataUrl(dataUrl, origName) {
  const m = /^data:([\w.+/-]*);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) bad('File format sahi nahi hai');
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (buf.length > MAX_FILE_BYTES) bad('File 8 MB se badi hai');
  const ext = (String(origName || '').split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const name = 'UPL_' + crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { file: name, name: str(origName, 120) || name, mime: m[1] || 'application/octet-stream', size: buf.length };
}
const SAFE_MIME = /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/;
function sendFileRef(res, ref) {
  const p = path.join(UPLOAD_DIR, path.basename(ref.file));
  if (!fs.existsSync(p)) bad('File server par nahi mili', 404);
  res.writeHead(200, { 'Content-Type': SAFE_MIME.test(ref.mime) ? ref.mime : 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(ref.name || ref.file) + '"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  fs.createReadStream(p).pipe(res);
}
function sendLegacyDataUrl(res, dataUrl, name) {
  const m = /^data:([\w.+/-]*);base64,(.*)$/s.exec(dataUrl);
  if (!m) bad('File corrupt hai', 404);
  res.writeHead(200, { 'Content-Type': SAFE_MIME.test(m[1]) ? m[1] : 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name || 'result') + '"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.end(Buffer.from(m[2], 'base64'));
}

/* ============================== VIEW MODELS (what the browser may see) ============================== */
function svcPublic(s) {
  return { id: s.id, name: s.name, price: s.price, icon: s.icon, iconUrl: s.iconUrl, cat: s.cat, chip: s.chip, placement: s.placement, group: s.group, serverLabel: s.serverLabel, badge: s.badge, sort: s.sort, on: s.on !== false, fields: s.fields, instructions: s.instructions };
}
function orderView(o, admin) {
  const fd = {};
  Object.entries(o.formData || {}).forEach(([k, v]) => {
    if (v && typeof v === 'object' && v.file) fd[k] = { file: true, name: v.name, size: v.size };
    else if (typeof v === 'string' && v.startsWith('data:')) fd[k] = { file: true, name: k, legacy: true };
    else fd[k] = v;
  });
  const out = { id: o.id, sid: o.sid, sname: o.sname, uid: o.uid, uname: o.uname, price: o.price, status: o.status, t: o.t, formData: fd, hasFile: !!(o.file || o.fileRef), fname: o.fname || (o.fileRef && o.fileRef.name) || '', note: o.note || '' };
  if (admin) { out.dispatch = o.dispatch || []; out.serverLabel = o.serverLabel || ''; }
  return out;
}
const canSeeOrder = (u, o) => u.role === 'admin' || (u.role === 'customer' && o.uid === u.id) ||
  (u.role === 'staff' && ((u.services || []).includes('ALL') || (u.services || []).includes(o.sid)));
const isDesk = u => u.role === 'admin' || u.role === 'staff';

function counts(u) {
  const o = state.orders;
  if (u.role === 'customer') return { pending: o.filter(x => x.uid === u.id && x.status === 'Pending').length, openTickets: state.complaints.filter(t => t.uid === u.id && t.status === 'Open').length };
  const mine = o.filter(x => canSeeOrder(u, x));
  const c = { pending: mine.filter(x => x.status === 'Pending').length };
  if (u.role === 'admin') { c.pays = state.pays.filter(p => p.status === 'Pending').length; c.openTickets = state.complaints.filter(t => t.status === 'Open').length; }
  return c;
}
function stats(u) {
  const o = state.orders;
  if (u.role === 'customer') { const m = o.filter(x => x.uid === u.id); return { total: m.length, pending: m.filter(x => x.status === 'Pending').length, done: m.filter(x => x.status === 'Completed').length }; }
  const m = o.filter(x => canSeeOrder(u, x));
  const s = { total: m.length, pending: m.filter(x => x.status === 'Pending').length, done: m.filter(x => x.status === 'Completed').length };
  if (u.role === 'admin') {
    const td = today() + ',';
    Object.assign(s, {
      revenue: r2(o.filter(x => x.status === 'Completed').reduce((a, x) => a + (x.price || 0), 0)),
      today: o.filter(x => String(x.t).startsWith(td)).length,
      customers: state.users.filter(x => x.role === 'customer').length,
      pays: state.pays.filter(p => p.status === 'Pending').length,
      tickets: state.complaints.filter(t => t.status === 'Open').length,
      wallets: r2(state.users.filter(x => x.role === 'customer').reduce((a, x) => a + (x.wallet || 0), 0))
    });
  }
  return s;
}
function publicSettings() {
  const S = state.settings;
  return {
    title: S.title, sub: S.sub, notice: S.notice, waLink: S.waLink,
    tickerOn: !!S.tickerOn, ticker: String(S.tickerText || '').split('\n').map(x => x.trim()).filter(Boolean), tickerSpeed: S.tickerSpeed || 40,
    popup: S.popupOn ? { title: S.popupTitle, msg: S.popupMsg, btnText: S.popupBtnText, btnLink: S.popupBtnLink, dismiss: S.popupDismiss, ver: S.popupVer } : null,
    customCss: S.customCss || '', customHtml: S.customHtml || '', customJs: S.customJs || ''
  };
}
const mask = v => v ? (v.length > 8 ? v.slice(0, 4) + '\u2022\u2022\u2022\u2022' + v.slice(-3) : '\u2022\u2022\u2022\u2022') : '';
function adminSettings() {
  const S = Object.assign({}, state.settings);
  S.tgBotTokenSet = !!S.tgBotToken; S.tgBotTokenMasked = mask(S.tgBotToken); delete S.tgBotToken;
  S.waApiKeySet = !!S.waApiKey; S.waApiKeyMasked = mask(S.waApiKey); delete S.waApiKey;
  return S;
}

/* ============================== SERVICE / SETTINGS VALIDATION ============================== */
function cleanService(b, old) {
  const name = str(b.name, 100);
  if (!name) bad('Service ka naam zaroori hai');
  const price = r2(b.price);
  if (!(price >= 0) || price > 100000) bad('Price sahi nahi hai');
  const iconUrl = str(b.iconUrl, 400000);
  if (iconUrl && !/^(https?:\/\/|\/|data:image\/)/i.test(iconUrl)) bad('Icon URL https:// se shuru hona chahiye');
  const fields = (Array.isArray(b.fields) ? b.fields : []).slice(0, 30).map(f => ({
    label: str(f.label, 80), type: FIELD_TYPES.includes(f.type) ? f.type : 'text', placeholder: str(f.placeholder, 120),
    hint: str(f.hint, 200), opts: str(f.opts, 1000), req: !!f.req
  })).filter(f => f.label);
  const endpoints = (Array.isArray(b.endpoints) ? b.endpoints : String(b.endpoints || '').split('\n')).map(x => str(x, 500)).filter(Boolean).slice(0, 10);
  endpoints.forEach(e => { if (!/^https?:\/\//i.test(e)) bad('Endpoint https:// se shuru hona chahiye: ' + e); });
  const instr = (Array.isArray(b.instructions) ? b.instructions : String(b.instructions || '').split('\n')).map(x => str(x, 400)).filter(Boolean).slice(0, 20);
  return Object.assign({}, old || {}, {
    name, price, icon: str(b.icon, 16) || '\uD83D\uDCC4', iconUrl, cat: str(b.cat, 20) || (old && old.cat) || 'PRINT',
    chip: CHIPS.includes(b.chip) ? b.chip : 'manual', placement: PLACEMENTS.includes(b.placement) ? b.placement : 'grid',
    group: str(b.group, 60), serverLabel: str(b.serverLabel, 40), badge: BADGES.includes(b.badge) ? b.badge : '',
    sort: Number.isFinite(Number(b.sort)) ? Number(b.sort) : 100, on: b.on === undefined ? (old ? old.on !== false : true) : !!b.on,
    fields, instructions: instr, endpoints
  });
}
const SETTING_SECTIONS = {
  portal: { title: ['s', 100], sub: ['s', 300], notice: ['s', 1000], waLink: ['s', 300] },
  payment: { upi: ['s', 100], qr: ['s', 3000000] },
  ticker: { tickerOn: ['b'], tickerText: ['s', 4000], tickerSpeed: ['n', 10, 200] },
  popup: { popupOn: ['b'], popupTitle: ['s', 120], popupMsg: ['s', 3000], popupBtnText: ['s', 40], popupBtnLink: ['s', 500], popupDismiss: ['e', ['session', 'day', 'once', 'always']] },
  notify: { tgChatId: ['s', 200], waWebhook: ['s', 1000], notifyOrder: ['b'], notifyDeposit: ['b'], notifyComplaint: ['b'] },
  custom: { customCss: ['s', 200000], customHtml: ['s', 200000], customJs: ['s', 200000] }
};
function applySettings(section, v) {
  const spec = SETTING_SECTIONS[section];
  if (!spec) bad('Unknown settings section');
  const S = state.settings;
  for (const [k, t] of Object.entries(spec)) {
    if (v[k] === undefined) continue;
    if (t[0] === 'b') S[k] = !!v[k];
    else if (t[0] === 'n') S[k] = Math.min(t[2], Math.max(t[1], Number(v[k]) || t[1]));
    else if (t[0] === 'e') { if (!t[1].includes(v[k])) bad('Invalid value for ' + k); S[k] = v[k]; }
    else S[k] = String(v[k] == null ? '' : v[k]).slice(0, t[1]).replace(/\r\n/g, '\n');
  }
  if (section === 'payment' && S.qr && !/^data:image\//.test(S.qr)) bad('QR image sahi nahi hai');
  if (/^(javascript|data|vbscript):/i.test(S.waLink || '') || /^(javascript|vbscript):/i.test(S.popupBtnLink || '')) bad('Link https:// se shuru hona chahiye');
  if (section === 'portal' && !S.title.trim()) bad('Portal title khali nahi ho sakta');
  if (section === 'popup') S.popupVer = (Number(S.popupVer) || 1) + 1;      // resets everybody's "dismissed" flag
  if (section === 'notify') {
    if (v.clearTgToken) S.tgBotToken = '';
    else if (str(v.tgBotToken, 200) && !/\u2022/.test(v.tgBotToken)) S.tgBotToken = str(v.tgBotToken, 200);
    if (v.clearWaKey) S.waApiKey = '';
    else if (str(v.waApiKey, 300) && !/\u2022/.test(v.waApiKey)) S.waApiKey = str(v.waApiKey, 300);
    if (S.waWebhook && !/^https?:\/\//i.test(S.waWebhook)) bad('WhatsApp webhook URL https:// se shuru hona chahiye');
  }
}

const STARTER = [
  { name: 'Voter Mobile Link', chip: 'voter', placement: 'quick', group: '', fields: [['EPIC Number', 'text'], ['Mobile Number', 'text']], icon: '\uD83D\uDCF2' },
  { name: 'Learning License Exam', chip: 'exam', placement: 'quick', group: '', fields: [['Application Number', 'text'], ['Date Of Birth', 'date']], icon: '\uD83D\uDCDD' },
  { name: 'PUC Certificate', chip: 'vehicle', placement: 'quick', group: '', fields: [['Vehicle Number', 'text'], ['Mobile Number', 'text']], icon: '\uD83C\uDF3F' },
  { name: 'RC PDF Server 2', chip: 'vehicle', placement: 'accordion', group: 'RC PDF', serverLabel: 'Server 2', badge: 'FAST', fields: [['Vehicle Number', 'text']], icon: '\uD83C\uDFCD\uFE0F' },
  { name: 'RC PDF Server 3', chip: 'vehicle', placement: 'accordion', group: 'RC PDF', serverLabel: 'Server 3', badge: 'NEW', fields: [['Vehicle Number', 'text']], icon: '\uD83C\uDFCD\uFE0F' },
  { name: 'RC PDF Server 4', chip: 'vehicle', placement: 'accordion', group: 'RC PDF', serverLabel: 'Server 4', badge: 'PRO', fields: [['Vehicle Number', 'text']], icon: '\uD83C\uDFCD\uFE0F' },
  { name: 'RC PDF Server 5', chip: 'vehicle', placement: 'accordion', group: 'RC PDF', serverLabel: 'Server 5', badge: 'LIVE', fields: [['Vehicle Number', 'text']], icon: '\uD83C\uDFCD\uFE0F' },
  { name: 'DL PDF HD', chip: 'vehicle', placement: 'accordion', group: 'DL PDF', serverLabel: 'HD', badge: 'PRO', fields: [['DL Number', 'text'], ['DOB', 'date']], icon: '\uD83E\uDEAA' },
  { name: 'Aadhaar PDF Biometric', chip: 'aadhaar', placement: 'accordion', group: 'Aadhaar PDF', serverLabel: 'Biometric', badge: 'FAST', fields: [['Aadhaar Number', 'text']], icon: '\uD83C\uDD94' },
  { name: 'Aadhaar PDF OTP', chip: 'aadhaar', placement: 'accordion', group: 'Aadhaar PDF', serverLabel: 'OTP', badge: 'LIVE', fields: [['Aadhaar Number', 'text'], ['Mobile Number', 'text']], icon: '\uD83C\uDD94' },
  { name: 'Farmer DBT Status', chip: 'farmer', placement: 'accordion', group: 'Farmer DBT', serverLabel: 'Server 1', badge: 'NEW', fields: [['Registration / Aadhaar Number', 'text']], icon: '\uD83C\uDF3E' }
];

/* ============================== ROUTER ============================== */
const routes = [];
const route = (method, pattern, opt, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opt, fn });
};
const send = (res, code, obj, extra) => {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(JSON.stringify(obj));
};
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request bahut badi hai')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'ip';

/* ---------------------------- PUBLIC ---------------------------- */
route('GET', '/api/public', {}, c => c.json(200, { settings: publicSettings() }));
route('GET', '/api/captcha', {}, c => c.json(200, newCaptcha()));

route('POST', '/api/login', {}, c => {
  const ip = clientIp(c.req), b = c.body;
  if (tooMany('login:' + ip, 10, 10 * 60000)) bad('Bahut zyada galat koshish. 10 minute baad try karein.', 429);
  const u = str(b.u, 80), p = String(b.p || '');
  let user;
  try {
    if (b.mode === 'customer') {
      checkCaptcha(b.capId, b.cap);
      user = state.users.find(x => x.role === 'customer' && (x.u === u || (x.mobile && x.mobile === u)));
    } else {
      const target = b.role === 'operator' ? 'staff' : 'admin';
      user = state.users.find(x => x.role === target && x.u === u);
    }
    if (!user || !safeEq(user.hash, hashPw(p))) bad('Galat username ya password', 401);
    if (user.locked) bad('Account locked / banned hai. Admin se sampark karein.', 403);
  } catch (e) { hit('login:' + ip); throw e; }
  user.loginCount = (user.loginCount || 0) + 1; user.lastLogin = now();
  commit();
  const token = newSession(user.id);
  const secure = TRUST_PROXY && c.req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  c.json(200, { me: publicUser(user) }, { 'Set-Cookie': 'pp_sid=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + SESSION_TTL / 1000 + (secure ? '; Secure' : '') });
});

route('POST', '/api/register', {}, c => {
  const ip = clientIp(c.req), b = c.body;
  if (tooMany('reg:' + ip, 10, 3600000)) bad('Bahut zyada registrations. Baad me try karein.', 429);
  hit('reg:' + ip);
  checkCaptcha(b.capId, b.cap);
  const name = str(b.name, 80), u = str(b.u, 40), p = String(b.p || ''), m = str(b.mobile, 20).replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, '');
  if (!name || !u || !m || p.length < 8) bad('Sabhi field bharein (password min 8 akshar)');
  if (/\s/.test(u) || u.length < 3) bad('Username 3+ akshar ka ho, bina space ke');
  if (!/^[6-9]\d{9}$/.test(m)) bad('10 digit ka sahi mobile number dalein');
  if (state.users.some(x => x.u.toLowerCase() === u.toLowerCase() || x.mobile === m)) bad('Mobile ya Username pehle se registered hai');
  const user = { id: nextId('CUS', 4), u, name, mobile: m, role: 'customer', hash: hashPw(p), wallet: 0, loginCount: 1, lastLogin: now(), created: now() };
  state.users.push(user);
  commit();
  const token = newSession(user.id);
  c.json(200, { me: publicUser(user) }, { 'Set-Cookie': 'pp_sid=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + SESSION_TTL / 1000 });
});

/* ---------------------------- SESSION ---------------------------- */
route('POST', '/api/logout', {}, c => {
  const t = parseCookies(c.req.headers.cookie).pp_sid;
  if (t) { sessions.delete(sha256(t)); saveSessions(); }
  c.json(200, { ok: true }, { 'Set-Cookie': 'pp_sid=; HttpOnly; Path=/; Max-Age=0' });
});
route('GET', '/api/bootstrap', { auth: true }, c => {
  const u = c.user, admin = u.role === 'admin';
  let services = state.services;
  if (!admin) services = services.filter(s => s.on !== false);
  if (u.role === 'staff') services = services.filter(s => (u.services || []).includes('ALL') || (u.services || []).includes(s.id));
  const out = {
    me: publicUser(u), rev, counts: counts(u), stats: stats(u),
    services: services.slice().sort((a, b) => a.sort - b.sort).map(s => admin ? Object.assign(svcPublic(s), { endpoints: s.endpoints }) : svcPublic(s)),
    chips: CHIPS, settings: publicSettings()
  };
  if (u.role === 'customer') out.pay = { upi: state.settings.upi, qr: state.settings.qr };
  if (admin) out.staffServices = state.services.map(s => ({ id: s.id, name: s.name }));
  c.json(200, out);
});
route('GET', '/api/poll', { auth: true }, c => c.json(200, { rev, counts: counts(c.user), wallet: r2(c.user.wallet) }));
route('POST', '/api/me/password', { auth: true }, c => {
  const o = String(c.body.old || ''), n = String(c.body.new || '');
  if (n.length < 8) bad('Naya password kam se kam 8 akshar ka ho');
  if (!safeEq(c.user.hash, hashPw(o))) bad('Purana password galat hai');
  c.user.hash = hashPw(n); commit();
  dropUserSessions(c.user.id, c.sessKey);
  c.json(200, { ok: true });
});

/* ---------------------------- ORDERS ---------------------------- */
route('GET', '/api/orders', { auth: true }, c => {
  const q = c.query, st = q.get('status'), kw = (q.get('q') || '').toLowerCase().trim();
  const limit = Math.min(Number(q.get('limit')) || 200, 1000), offset = Number(q.get('offset')) || 0;
  let list = state.orders.filter(o => canSeeOrder(c.user, o));
  if (st && ['Pending', 'Completed', 'Rejected'].includes(st)) list = list.filter(o => o.status === st);
  if (kw) list = list.filter(o => [o.id, o.sname, o.uname, o.uid].some(x => String(x || '').toLowerCase().includes(kw)));
  c.json(200, { total: list.length, items: list.slice(offset, offset + limit).map(o => orderView(o, isDesk(c.user))) });
});

route('POST', '/api/orders', { auth: true, roles: ['customer'], limit: LIMIT_UPLOAD }, c => {
  const s = state.services.find(x => x.id === c.body.sid);
  if (!s || s.on === false) bad('Service uplabdh nahi hai');
  const user = c.user;
  if (user.wallet < s.price) bad('Wallet balance kam hai. Pehle Add Money karein.');
  const input = c.body.formData && typeof c.body.formData === 'object' ? c.body.formData : {};
  const formData = {}, saved = [];
  try {
    for (const f of s.fields) {
      const v = input[f.label];
      if (f.type === 'file') {
        if (v && v.data) { const ref = saveDataUrl(v.data, v.name); saved.push(ref.file); formData[f.label] = ref; }
        else if (f.req) bad(f.label + ' bharna anivarya hai');
        continue;
      }
      const val = str(v, f.type === 'textarea' ? 1500 : 300);
      if (f.req && !val) bad(f.label + ' bharna anivarya hai');
      if (f.type === 'dropdown' && val) {
        const opts = String(f.opts || '').split(',').map(x => x.trim()).filter(Boolean);
        if (opts.length && !opts.includes(val)) bad(f.label + ' ka option galat hai');
      }
      if (val || f.req) formData[f.label] = val;
    }
  } catch (e) { saved.forEach(n => { try { fs.unlinkSync(path.join(UPLOAD_DIR, n)); } catch (x) { /* ignore */ } }); throw e; }
  const id = nextId('ORD', 6);
  walletMove(user, -s.price, 'order', s.name + (s.serverLabel ? ' (' + s.serverLabel + ')' : ''), user.u, id);
  const order = { id, sid: s.id, sname: s.name, uid: user.id, uname: user.u, price: s.price, formData, status: 'Pending', t: now() };
  if (s.serverLabel) order.serverLabel = s.serverLabel;
  state.orders.unshift(order);
  commit();
  notify('order', '\uD83D\uDED2 New Order Placed', [['Service', s.name + (s.serverLabel ? ' - ' + s.serverLabel : '')], ['Customer', user.name + ' (' + user.u + ')'], ['Amount', rupee(s.price)], ['Reference ID', '#' + id]]);
  setImmediate(() => dispatchOrder(order, s).catch(() => { /* never surfaces to customer */ }));
  c.json(200, { id, wallet: user.wallet });
});

function deskOrder(c) {
  const o = state.orders.find(x => x.id === c.params.id);
  if (!o || !isDesk(c.user) || !canSeeOrder(c.user, o)) bad('Order nahi mila', 404);
  return o;
}
route('POST', '/api/orders/:id/complete', { auth: true, roles: ['admin', 'staff'], limit: LIMIT_UPLOAD }, c => {
  const o = deskOrder(c);
  if (o.status !== 'Pending') bad('Sirf Pending order complete ho sakta hai');
  const f = c.body.file;
  if (!f || !f.data) bad('Result file chunein');
  const ref = saveDataUrl(f.data, f.name);
  o.fileRef = ref; o.fname = ref.name; o.status = 'Completed'; o.doneBy = c.user.u; o.doneAt = now();
  commit();
  c.json(200, { ok: true });
});
route('POST', '/api/orders/:id/reject', { auth: true, roles: ['admin', 'staff'] }, c => {
  const o = deskOrder(c);
  if (o.status !== 'Pending') bad('Sirf Pending order reject ho sakta hai');
  const cust = findUser(o.uid);
  if (cust) walletMove(cust, o.price, 'refund', 'Order #' + o.id + ' rejected', c.user.u, o.id);
  o.status = 'Rejected'; o.note = str(c.body.reason, 200); o.doneBy = c.user.u; o.doneAt = now();
  commit();
  c.json(200, { ok: true, refunded: o.price });
});
route('GET', '/api/orders/:id/file', { auth: true }, c => {
  const o = state.orders.find(x => x.id === c.params.id);
  if (!o || !canSeeOrder(c.user, o)) bad('Order nahi mila', 404);
  if (o.fileRef) return sendFileRef(c.res, o.fileRef);
  if (o.file) return sendLegacyDataUrl(c.res, o.file, o.fname);
  bad('Abhi file upload nahi hui', 404);
});
route('GET', '/api/orders/:id/attachment', { auth: true }, c => {
  const o = state.orders.find(x => x.id === c.params.id);
  if (!o || !canSeeOrder(c.user, o)) bad('Order nahi mila', 404);
  const v = (o.formData || {})[c.query.get('k')];
  if (v && typeof v === 'object' && v.file) return sendFileRef(c.res, v);
  if (typeof v === 'string' && v.startsWith('data:')) return sendLegacyDataUrl(c.res, v, c.query.get('k'));
  bad('Attachment nahi mila', 404);
});

/* ---------------------------- WALLET / PAYMENTS ---------------------------- */
route('GET', '/api/wallet', { auth: true, roles: ['customer'] }, c => c.json(200, {
  balance: r2(c.user.wallet), pays: state.pays.filter(p => p.uid === c.user.id).slice(0, 100),
  ledger: state.ledger.filter(l => l.uid === c.user.id).slice(0, 100), pay: { upi: state.settings.upi, qr: state.settings.qr }
}));
route('POST', '/api/pays', { auth: true, roles: ['customer'] }, c => {
  const amt = r2(c.body.amt), utr = str(c.body.utr, 40).toUpperCase();
  if (!(amt > 0) || amt > 100000) bad('Sahi amount dalein (max \u20B91,00,000)');
  if (!/^[A-Z0-9]{6,30}$/.test(utr)) bad('Sahi UTR / Transaction ID dalein (12 digit)');
  if (state.pays.some(p => p.utr === utr && p.status !== 'Rejected')) bad('Ye UTR pehle se submit ho chuka hai');
  if (state.pays.filter(p => p.uid === c.user.id && p.status === 'Pending').length >= 5) bad('Aapke 5 payments verify hone baaki hain. Thoda wait karein.');
  const pay = { id: nextId('PAY', 4), uid: c.user.id, uname: c.user.u, amt, utr, status: 'Pending', t: now() };
  state.pays.unshift(pay);
  commit();
  notify('deposit', '\uD83D\uDCB0 New UTR / Add Money Submitted', [['Customer', c.user.name + ' (' + c.user.u + ')'], ['Amount', rupee(amt)], ['UTR', utr], ['Reference ID', pay.id]]);
  c.json(200, { id: pay.id });
});

/* ---------------------------- COMPLAINTS ---------------------------- */
route('GET', '/api/complaints', { auth: true, roles: ['customer', 'admin'] }, c =>
  c.json(200, { items: state.complaints.filter(t => c.user.role === 'admin' || t.uid === c.user.id) }));
route('POST', '/api/complaints', { auth: true, roles: ['customer'] }, c => {
  const subject = str(c.body.subject, 120), msg = str(c.body.msg, 2000), oid = str(c.body.oid, 20);
  if (!subject || !msg) bad('Subject aur problem dono likhein');
  if (oid && !state.orders.some(o => o.id === oid && o.uid === c.user.id)) bad('Order ID sahi nahi hai');
  if (state.complaints.filter(t => t.uid === c.user.id && t.status === 'Open').length >= 10) bad('Pehle purane tickets resolve hone dein');
  const t = { id: nextId('TKT', 4), uid: c.user.id, uname: c.user.u, oid, subject, msg, status: 'Open', t: now(), replies: [] };
  state.complaints.unshift(t);
  commit();
  notify('complaint', '\uD83C\uDFA7 New Complaint / Support Ticket', [['Ticket', t.id], ['Customer', c.user.name + ' (' + c.user.u + ')'], ['Order', oid ? '#' + oid : '-'], ['Subject', subject], ['Message', msg.slice(0, 300)]]);
  c.json(200, { id: t.id });
});
route('POST', '/api/complaints/:id/reply', { auth: true, roles: ['admin'] }, c => {
  const t = state.complaints.find(x => x.id === c.params.id), txt = str(c.body.text, 2000);
  if (!t || !txt) bad('Reply likhein');
  t.replies.push({ by: 'Support', text: txt, t: now() });
  t.status = c.body.status === 'Open' ? 'Open' : 'Resolved';
  commit();
  c.json(200, { ok: true });
});

/* ---------------------------- ADMIN: USERS & WALLETS ---------------------------- */
const A = { auth: true, roles: ['admin'] };
route('GET', '/api/admin/users', A, c => c.json(200, { items: state.users.map(publicUser) }));
route('POST', '/api/admin/users/:id/wallet', A, c => {
  const u = findUser(c.params.id);
  if (!u || u.role !== 'customer') bad('Customer nahi mila', 404);
  const amt = r2(c.body.amt), type = c.body.type === 'debit' ? 'debit' : 'credit';
  if (!(amt > 0) || amt > 1000000) bad('Sahi amount dalein');
  if (type === 'debit' && u.wallet < amt) bad('Customer ke wallet me itna balance nahi hai');
  walletMove(u, type === 'debit' ? -amt : amt, type === 'debit' ? 'admin-debit' : 'admin-credit', str(c.body.note, 150) || 'Manual adjustment', c.user.u);
  commit();
  c.json(200, { wallet: u.wallet });
});
route('POST', '/api/admin/users/:id/password', A, c => {
  const u = findUser(c.params.id), p = String(c.body.password || '');
  if (!u) bad('User nahi mila', 404);
  if (p.length < 8) bad('Password min 8 akshar ka ho');
  u.hash = hashPw(p); commit(); dropUserSessions(u.id);
  c.json(200, { ok: true });
});
route('POST', '/api/admin/users/:id/lock', A, c => {
  const u = findUser(c.params.id);
  if (!u) bad('User nahi mila', 404);
  if (u.role === 'admin') bad('Admin ko lock nahi kar sakte');
  u.locked = !!c.body.locked; commit();
  if (u.locked) dropUserSessions(u.id);
  c.json(200, { locked: u.locked });
});
route('POST', '/api/admin/staff', A, c => {
  const name = str(c.body.name, 80), u = str(c.body.u, 40), p = String(c.body.p || '');
  if (!name || u.length < 3 || /\s/.test(u) || p.length < 8) bad('Sabhi field bharein (username 3+, password min 8)');
  if (state.users.some(x => x.u.toLowerCase() === u.toLowerCase())) bad('Username pehle se hai');
  const valid = new Set(state.services.map(s => s.id));
  const svc = (Array.isArray(c.body.services) ? c.body.services : []).filter(x => x === 'ALL' || valid.has(x));
  const user = { id: nextId('STF', 4), u, name, role: 'staff', services: svc, hash: hashPw(p), wallet: 0, loginCount: 0, created: now() };
  state.users.push(user); commit();
  c.json(200, { id: user.id });
});
route('PUT', '/api/admin/staff/:id', A, c => {
  const u = findUser(c.params.id);
  if (!u || u.role !== 'staff') bad('Staff nahi mila', 404);
  const valid = new Set(state.services.map(s => s.id));
  u.services = (Array.isArray(c.body.services) ? c.body.services : []).filter(x => x === 'ALL' || valid.has(x));
  commit(); c.json(200, { ok: true });
});
route('DELETE', '/api/admin/staff/:id', A, c => {
  const i = state.users.findIndex(x => x.id === c.params.id && x.role === 'staff');
  if (i < 0) bad('Staff nahi mila', 404);
  dropUserSessions(state.users[i].id); state.users.splice(i, 1); commit();
  c.json(200, { ok: true });
});
route('GET', '/api/admin/ledger', A, c => {
  const uid = c.query.get('uid');
  c.json(200, { items: state.ledger.filter(l => !uid || l.uid === uid).slice(0, 500) });
});

/* ---------------------------- ADMIN: UTR QUEUE ---------------------------- */
route('GET', '/api/admin/pays', A, c => c.json(200, { items: state.pays.slice(0, 500) }));
route('POST', '/api/admin/pays/:id/verify', A, c => {
  const p = state.pays.find(x => x.id === c.params.id);
  if (!p) bad('Payment nahi mili', 404);
  if (p.status !== 'Pending') bad('Ye payment pehle hi process ho chuki hai');
  if (c.body.ok) {
    const u = findUser(p.uid);
    if (!u) bad('Customer nahi mila');
    walletMove(u, p.amt, 'deposit', 'UTR ' + p.utr + ' approved (' + p.id + ')', c.user.u, p.id);
    p.status = 'Completed';
  } else p.status = 'Rejected';
  p.doneBy = c.user.u; p.doneAt = now();
  commit();
  c.json(200, { status: p.status });
});

/* ---------------------------- ADMIN: SERVICES / LAYOUT ---------------------------- */
route('POST', '/api/admin/services', A, c => {
  const s = cleanService(c.body, null);
  s.id = nextId('SRV', 4);
  state.services.push(s); commit();
  c.json(200, { id: s.id });
});
route('PUT', '/api/admin/services/:id', A, c => {
  const i = state.services.findIndex(x => x.id === c.params.id);
  if (i < 0) bad('Service nahi mili', 404);
  state.services[i] = cleanService(c.body, state.services[i]); commit();
  c.json(200, { ok: true });
});
route('POST', '/api/admin/services/:id/toggle', A, c => {
  const s = state.services.find(x => x.id === c.params.id);
  if (!s) bad('Service nahi mili', 404);
  s.on = s.on === false; commit();
  c.json(200, { on: s.on });
});
route('POST', '/api/admin/services/:id/duplicate', A, c => {
  const s = state.services.find(x => x.id === c.params.id);
  if (!s) bad('Service nahi mili', 404);
  const copy = clone(s); copy.id = nextId('SRV', 4); copy.on = false; copy.sort = (s.sort || 0) + 1;
  const m = /^(.*?)(\d+)$/.exec(s.serverLabel || '');
  copy.serverLabel = m ? m[1] + (Number(m[2]) + 1) : (s.serverLabel ? s.serverLabel + ' 2' : '');
  copy.name = s.name.replace(/\d+$/, '').trim() + (copy.serverLabel ? ' ' + copy.serverLabel : ' (Copy)');
  state.services.push(copy); commit();
  c.json(200, { id: copy.id });
});
route('DELETE', '/api/admin/services/:id', A, c => {
  const i = state.services.findIndex(x => x.id === c.params.id);
  if (i < 0) bad('Service nahi mili', 404);
  const id = state.services[i].id;
  state.services.splice(i, 1);
  state.users.forEach(u => { if (u.role === 'staff' && Array.isArray(u.services)) u.services = u.services.filter(x => x !== id); });
  commit();
  c.json(200, { ok: true });
});
route('POST', '/api/admin/services/seed', A, c => {
  let added = 0;
  STARTER.forEach(t => {
    if (state.services.some(s => s.name.toLowerCase() === t.name.toLowerCase())) return;
    const s = cleanService({
      name: t.name, price: 0, icon: t.icon, chip: t.chip, placement: t.placement, group: t.group, serverLabel: t.serverLabel || '',
      badge: t.badge || '', sort: 100 + added, on: false, fields: t.fields.map(([label, type]) => ({ label, type, req: true })), instructions: []
    }, null);
    s.id = nextId('SRV', 4); state.services.push(s); added++;
  });
  if (added) commit();
  c.json(200, { added });
});

/* ---------------------------- ADMIN: SETTINGS / NOTIFICATIONS ---------------------------- */
route('GET', '/api/admin/settings', A, c => c.json(200, { settings: adminSettings(), log: notifyLog }));
route('PUT', '/api/admin/settings', A, c => {
  applySettings(String(c.body.section), c.body.values && typeof c.body.values === 'object' ? c.body.values : {});
  commit();
  c.json(200, { settings: adminSettings() });
});
route('POST', '/api/admin/notify/test', A, async c => {
  const msg = { event: 'test', title: '\u2705 Test Notification', lines: [['Portal', state.settings.title], ['Sent by', c.user.u], ['Time', now()]] };
  const out = {};
  for (const [name, fn] of [['telegram', sendTelegram], ['whatsapp', sendWhatsApp]]) {
    try { const r = await fn(msg); out[name] = r.skipped ? 'Not configured' : 'Sent OK'; logNotify(name, !r.skipped, 'test'); }
    catch (e) { out[name] = 'FAILED: ' + e.message; logNotify(name, false, e.message); }
  }
  c.json(200, out);
});

/* ---------------------------- ADMIN: REPORTS / BACKUP / RESTORE ---------------------------- */
route('GET', '/api/admin/csv', A, c => {
  const kind = c.query.get('kind');
  const rows = {
    orders: [['ID', 'Service', 'User', 'Price', 'Status', 'Time'], ...state.orders.map(o => [o.id, o.sname, o.uname, o.price, o.status, o.t])],
    customers: [['ID', 'Name', 'Username', 'Mobile', 'Wallet', 'Logins', 'Locked'], ...state.users.filter(u => u.role === 'customer').map(u => [u.id, u.name, u.u, u.mobile, u.wallet, u.loginCount, !!u.locked])],
    payments: [['ID', 'User', 'Amount', 'UTR', 'Status', 'Time'], ...state.pays.map(p => [p.id, p.uname, p.amt, p.utr, p.status, p.t])],
    ledger: [['ID', 'User', 'Type', 'Amount', 'Balance', 'Note', 'By', 'Time'], ...state.ledger.map(l => [l.id, l.uname, l.type, l.amt, l.bal, l.note, l.by, l.t])]
  }[kind];
  if (!rows) bad('Unknown report');
  const cell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  c.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + kind + '.csv"', 'Cache-Control': 'no-store' });
  c.res.end('\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n'));
});
route('GET', '/api/admin/backup', A, c => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  c.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="data-backup-' + stamp + '.json"', 'Cache-Control': 'no-store' });
  c.res.end(JSON.stringify({ rev, data: state }));
});
function validateDb(x) {
  if (!x || typeof x !== 'object') throw new Error('File ek JSON object nahi hai');
  const d = x.data && typeof x.data === 'object' && !Array.isArray(x.data) ? x.data : x;
  if (!Array.isArray(d.users) || !d.users.length) throw new Error('"users" list missing hai');
  if (!Array.isArray(d.services)) throw new Error('"services" list missing hai');
  ['orders', 'pays', 'complaints', 'ledger'].forEach(k => { if (d[k] !== undefined && !Array.isArray(d[k])) throw new Error('"' + k + '" list honi chahiye'); });
  const ids = new Set();
  d.users.forEach((u, i) => {
    if (!u || typeof u.id !== 'string' || typeof u.u !== 'string' || !['admin', 'staff', 'customer'].includes(u.role)) throw new Error('User #' + (i + 1) + ' invalid hai');
    if (!/^[a-f0-9]{64}$/.test(String(u.hash || ''))) throw new Error('User ' + u.u + ' ka password hash invalid hai');
    if (ids.has(u.id)) throw new Error('Duplicate user id: ' + u.id);
    ids.add(u.id);
  });
  if (!d.users.some(u => u.role === 'admin')) throw new Error('Backup me koi admin user nahi hai');
  d.services.forEach((s, i) => { if (!s || typeof s.id !== 'string' || typeof s.name !== 'string') throw new Error('Service #' + (i + 1) + ' invalid hai'); });
  return d;
}
route('POST', '/api/admin/restore', { auth: true, roles: ['admin'], limit: LIMIT_RESTORE }, c => {
  let parsed = c.body.content;
  try { if (typeof parsed === 'string') parsed = JSON.parse(parsed); } catch (e) { bad('JSON format galat hai: ' + e.message); }
  let d;
  try { d = validateDb(parsed); } catch (e) { bad('Restore rok diya gaya: ' + e.message); }
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, 'data.pre-restore-' + Date.now() + '.json'), JSON.stringify({ rev, data: state })); }
  catch (e) { bad('Safety copy nahi ban saki, restore cancel: ' + e.message, 500); }
  state = normalize(clone(d));
  commit();
  c.json(200, { ok: true, users: state.users.length, orders: state.orders.length, services: state.services.length });
});

/* ============================== STATIC FILES ============================== */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.json': 'application/json' };
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ============================== SERVER ============================== */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  const pathname = url.pathname;
  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    }
    const r = routes.find(x => x.method === req.method && x.re.test(pathname));
    if (!r) return send(res, 404, { error: 'API route nahi mila' });
    const m = r.re.exec(pathname), params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const ctx = { req, res, params, query: url.searchParams, body: {}, user: null, json: (code, obj, extra) => send(res, code, obj, extra) };
    if (r.opt.auth) {
      const tok = parseCookies(req.headers.cookie).pp_sid;
      const key = tok ? sha256(tok) : '', s = key && sessions.get(key);
      const user = s && s.exp > Date.now() ? findUser(s.uid) : null;
      if (!user || user.locked) { if (s) { sessions.delete(key); saveSessions(); } return send(res, 401, { error: 'Session khatam. Dobara login karein.' }); }
      if (r.opt.roles && !r.opt.roles.includes(user.role)) return send(res, 403, { error: 'Aapko is kaam ki permission nahi hai' });
      s.exp = Date.now() + SESSION_TTL;
      ctx.user = user; ctx.sessKey = key;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['x-requested-with'] !== 'pp') return send(res, 403, { error: 'Blocked (CSRF check)' });
      const raw = await readBody(req, r.opt.limit || LIMIT_JSON);
      if (raw.length) { try { ctx.body = JSON.parse(raw.toString('utf8')); } catch (e) { return send(res, 400, { error: 'JSON format galat hai' }); } }
      if (!ctx.body || typeof ctx.body !== 'object') ctx.body = {};
    }
    await r.fn(ctx);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch (x) { /* ignore */ } return; }
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error('Unhandled error on', req.method, pathname, e);
    send(res, 500, { error: 'Server error. Dobara try karein.' });
  }
});
server.listen(PORT, () => console.log('Portal running: http://localhost:' + PORT + '   (data: ' + FILE + ')'));

function shutdown() { try { persist(); fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions))); } catch (e) { /* ignore */ } process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
