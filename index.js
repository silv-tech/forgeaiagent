const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
// Persistent data directory, set DATA_DIR env var on Railway to your volume mount path (e.g. /data)
const DATA_ROOT = process.env.DATA_DIR || __dirname;
const leadsEnv = path.join(DATA_ROOT, 'leads', '.env');
const localEnv = path.join(__dirname, '.env');
require('dotenv').config({ path: fs.existsSync(leadsEnv) ? leadsEnv : localEnv });
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const session = require('express-session');

const { runScout }              = require('./agents/scout');
const { buildDemoSite }         = require('./agents/builder');
const { deployDemoSite: cfDeploy, isConfigured: cfConfigured } = require('./agents/cloudflare');
const { sendOutreach, generateEmailPreview, generateFollowUpEmail, hasValidDemoUrl } = require('./agents/outreach');

// Daily send counter (resets every 24h). Lives here because it used to be
// in agents/outreach.js and was accidentally dropped; restoring it as a
// local helper so /api/settings and /api/send-stats never throw.
const RESEND_DAILY_LIMIT = 100;
const BREVO_DAILY_LIMIT = 300;
const RESET_INTERVAL_MS = 24 * 60 * 60 * 1000;
function _counterFile() {
  return path.join(DATA_ROOT, 'leads', '.send-counter.json');
}
function loadCounter() {
  try {
    const d = JSON.parse(fs.readFileSync(_counterFile(), 'utf8'));
    const now = Date.now();
    if (d.startedAt && (now - d.startedAt) < RESET_INTERVAL_MS) {
      return { startedAt: d.startedAt, resend: d.resend||0, brevo: d.brevo||0, smtp: d.smtp||0 };
    }
  } catch {}
  return { startedAt: Date.now(), resend: 0, brevo: 0, smtp: 0 };
}
function saveCounter(c) {
  try { fs.writeFileSync(_counterFile(), JSON.stringify(c)); } catch {}
}
function getSendStats() {
  const c = loadCounter();
  const remainingMs = Math.max(0, RESET_INTERVAL_MS - (Date.now() - c.startedAt));
  const h = Math.floor(remainingMs / 3600000);
  const m = Math.floor((remainingMs % 3600000) / 60000);
  return {
    resend: c.resend,
    resendLimit: RESEND_DAILY_LIMIT,
    resendRemaining: Math.max(0, RESEND_DAILY_LIMIT - c.resend),
    brevo: c.brevo,
    brevoLimit: BREVO_DAILY_LIMIT,
    brevoRemaining: Math.max(0, BREVO_DAILY_LIMIT - c.brevo),
    smtp: c.smtp,
    total: c.resend + c.brevo + c.smtp,
    usingBrevo: c.resend >= RESEND_DAILY_LIMIT,
    resetsIn: `${h}h ${m}m`,
    resetsAtMs: c.startedAt + RESET_INTERVAL_MS
  };
}
const { handleReply }           = require('./agents/closer');
const { findEmail, hunterSearch, checkCredits } = require('./agents/emailfinder');
const { findSocialMedia }       = require('./agents/socialfinder');

const app = express();
const PORT = process.env.PORT || 3000;
const getBase = () => process.env.PUBLIC_URL || `http://localhost:${PORT}`;

app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});
app.use(cors());
// Gzip responses. Skip SSE stream so progress events flush immediately.
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/api/stream/')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'agentforge-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
}));

// ── AUTH ──────────────────────────────────────────────────────────────────
const LOGIN_USER = process.env.LOGIN_USER || 'leif';
const LOGIN_PASS = process.env.LOGIN_PASS || 'forgeai2026';

app.get('/login', (req, res) => {
  if (req.session.auth) return res.redirect('/app');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>ForgeAI | Sign In</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%23060810'/><text x='50%25' y='54%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial Black,sans-serif' font-weight='900' font-size='13' fill='%2300e5ff'>AF</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060810;color:#f0f4ff;font-family:'Inter',sans-serif;height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,229,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,255,.025) 1px,transparent 1px);background-size:48px 48px;pointer-events:none}
body::after{content:'';position:fixed;top:50%;left:50%;width:800px;height:800px;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(0,229,255,.06) 0%,transparent 70%);pointer-events:none}
.wrap{position:relative;z-index:1}
.card{background:rgba(11,15,26,.85);backdrop-filter:blur(20px);border:1px solid rgba(30,42,69,.6);border-radius:20px;padding:52px 44px 44px;width:100%;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,.4),0 0 80px rgba(0,229,255,.03)}
.logo-wrap{text-align:center;margin-bottom:36px}
.logo-icon{display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#0a0e1a,#111830);border:1px solid rgba(0,229,255,.2);font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:#00e5ff;letter-spacing:.02em;margin-bottom:14px;box-shadow:0 0 20px rgba(0,229,255,.08)}
.logo-text{font-family:'Syne',sans-serif;font-size:24px;font-weight:800;letter-spacing:.04em}
.logo-text em{font-style:normal;color:#00e5ff}
.logo-sub{font-size:11px;color:#4a5d80;letter-spacing:.12em;text-transform:uppercase;margin-top:4px}
label{display:block;font-size:10.5px;color:#5a6d90;text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin-bottom:7px}
.field{position:relative;margin-bottom:22px}
.field svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);width:16px;height:16px;stroke:#3a4d70;stroke-width:1.8;fill:none}
input{width:100%;background:rgba(6,8,16,.7);border:1px solid rgba(30,42,69,.8);border-radius:10px;padding:13px 14px 13px 42px;color:#f0f4ff;font-size:14px;font-family:'Inter',sans-serif;outline:none;transition:border .25s,box-shadow .25s}
input:focus{border-color:rgba(0,229,255,.5);box-shadow:0 0 0 3px rgba(0,229,255,.08)}
input::placeholder{color:#2d3a55}
button{width:100%;background:linear-gradient(135deg,#00e5ff,#00b8d4);color:#060810;border:none;border-radius:10px;padding:14px;font-size:14px;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;letter-spacing:.03em;transition:all .2s;margin-top:6px;box-shadow:0 4px 16px rgba(0,229,255,.2)}
button:hover{background:linear-gradient(135deg,#00f0ff,#00c8e0);box-shadow:0 4px 24px rgba(0,229,255,.35);transform:translateY(-1px)}
button:active{transform:translateY(0)}
.err{color:#ff4d6d;font-size:12px;margin-bottom:18px;text-align:center;padding:10px 14px;background:rgba(255,77,109,.08);border:1px solid rgba(255,77,109,.2);border-radius:8px}
.footer{text-align:center;margin-top:24px;font-size:10px;color:#2d3a55;letter-spacing:.06em}
@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.card{animation:fadeIn .4s ease-out}
</style>
</head>
<body>
<div class="wrap">
<div class="card">
  <div class="logo-wrap">
    <div class="logo-icon">AF</div>
    <div class="logo-text">AGENT<em>FORGE</em></div>
    <div class="logo-sub">Command Center</div>
  </div>
  ${req.query.err ? '<div class="err">Invalid username or password.</div>' : ''}
  <form method="POST" action="/login">
    <label>Username</label>
    <div class="field">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>
      <input type="text" name="username" placeholder="Enter username" autofocus autocomplete="username">
    </div>
    <label>Password</label>
    <div class="field">
      <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      <input type="password" name="password" placeholder="Enter password" autocomplete="current-password">
    </div>
    <button type="submit">Sign In</button>
  </form>
  <div class="footer">SECURED ACCESS</div>
</div>
</div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === LOGIN_USER && password === LOGIN_PASS) {
    req.session.auth = true;
    return res.redirect('/app');
  }
  res.redirect('/login?err=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── DATA ──────────────────────────────────────────────────────────────────
const DATA = path.join(DATA_ROOT,'leads');
fs.mkdirSync(DATA,{recursive:true});

// Migrate: if volume was previously mounted at /app/leads, files are now at DATA_ROOT root
// Move them into the leads/ subdirectory
['leads.json','outreach.json','replies.json','sequences.json','scheduled.json','tracking.json','unsubscribed.json','.env','.send-counter.json'].forEach(f => {
  const oldPath = path.join(DATA_ROOT, f);
  const newPath = path.join(DATA, f);
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    console.log(`[migrate] Moving ${oldPath} → ${newPath}`);
    fs.renameSync(oldPath, newPath);
  } else if (fs.existsSync(oldPath) && fs.existsSync(newPath)) {
    // Both exist, keep the larger file (more data)
    const oldSize = fs.statSync(oldPath).size;
    const newSize = fs.statSync(newPath).size;
    if (oldSize > newSize) {
      console.log(`[migrate] Replacing ${newPath} with larger ${oldPath} (${oldSize} > ${newSize})`);
      fs.renameSync(oldPath, newPath);
    }
  }
});

const LF = path.join(DATA,'leads.json');
const OF = path.join(DATA,'outreach.json');
const RF = path.join(DATA,'replies.json');
const SEQ_F = path.join(DATA,'sequences.json');
const SCH_F = path.join(DATA,'scheduled.json');
const TF = path.join(DATA,'tracking.json');
const USF = path.join(DATA,'unsubscribed.json');
const load = f => { try { return fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):[] } catch { return [] } };
const save = (f,d) => {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d,null,2));
  fs.renameSync(tmp, f);
};
// Coalesce frequent writes (tracking pixel, click redirects), one disk write per ~2s per file.
const _saveTimers = new Map();
const saveDebounced = (f, d, ms = 2000) => {
  const existing = _saveTimers.get(f);
  if (existing) clearTimeout(existing);
  _saveTimers.set(f, setTimeout(() => {
    _saveTimers.delete(f);
    try { save(f, d); } catch (e) { console.error('[saveDebounced]', f, e.message); }
  }, ms));
};
// Flush pending writes on shutdown so nothing is lost.
const _flushPending = () => {
  for (const [f, t] of _saveTimers) {
    clearTimeout(t);
    _saveTimers.delete(f);
    try {
      if (f === TF) save(f, tracking);
    } catch (e) { console.error('[flush]', e.message); }
  }
};
process.on('SIGINT', () => { _flushPending(); process.exit(0); });
process.on('SIGTERM', () => { _flushPending(); process.exit(0); });
let leads = load(LF), outreach = load(OF), replies = load(RF);
let sequences = load(SEQ_F), scheduled = load(SCH_F), tracking = load(TF);
let unsubscribed = load(USF); // array of lowercase email strings
let unsubscribedSet = new Set(unsubscribed); // O(1) lookup
const isUnsubscribed = email => unsubscribedSet.has((email||'').toLowerCase());
const addUnsubscribed = email => {
  const lower = (email||'').toLowerCase();
  if (!unsubscribedSet.has(lower)) {
    unsubscribedSet.add(lower);
    unsubscribed.push(lower);
    save(USF, unsubscribed);
  }
};

// ── MIGRATION ────────────────────────────────────────────────────────────
let migrated = false;
leads.forEach(l => {
  if (!l.id) { l.id = randomUUID(); migrated = true; }
  if (l.previewUrl && l.previewUrl.includes('ngrok') && l.siteFile) {
    l.previewUrl = `${getBase()}/sites/${l.siteFile}`;
    migrated = true;
  }
});
if (migrated) save(LF, leads);

// Migrate outreach: leadIndex → leadId
let oMig = false;
outreach.forEach(o => {
  if (o.leadIndex !== undefined && !o.leadId) {
    const lead = leads[o.leadIndex];
    if (lead) { o.leadId = lead.id; oMig = true; }
  }
});
if (oMig) save(OF, outreach);

let rMig = false;
replies.forEach(r => {
  if (r.leadIndex !== undefined && !r.leadId) {
    const lead = leads[r.leadIndex];
    if (lead) { r.leadId = lead.id; rMig = true; }
  }
});
if (rMig) save(RF, replies);

// Reconcile: sync outreach records back to leads if outreachEmail/outreachSentAt is missing
let reconMig = false;
outreach.forEach(o => {
  if (!o.leadId || !o.sentTo || !o.sentAt) return;
  if (o.type === 'followup') return; // follow-ups don't set initial outreach fields
  const f = leads.find(l => l.id === o.leadId);
  if (!f) return;
  if (!f.outreachEmail) { f.outreachEmail = o.sentTo; reconMig = true; }
  if (!f.outreachSentAt) { f.outreachSentAt = o.sentAt; reconMig = true; }
  if (!f.status || f.status === 'New') { f.status = 'Outreach Sent'; reconMig = true; }
});
if (reconMig) { save(LF, leads); console.log('[migrate] Reconciled outreach data → leads.json'); }

// ── HELPERS ──────────────────────────────────────────────────────────────
function findLead(id) {
  const index = leads.findIndex(l => l.id === id);
  return index >= 0 ? { lead: leads[index], index } : null;
}

// Lock to prevent duplicate concurrent sends to the same lead
const sendingInProgress = new Set();

// Simple email format validation
function isValidEmail(email) {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email);
}

// ── TRACKING ROUTES (before auth, email clients need access) ────────────
const PIXEL_BUF = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

app.get('/t/:trackingId.png', (req, res) => {
  const rec = tracking.find(t => t.trackingId === req.params.trackingId);
  if (rec) { rec.opens.push({ at: new Date().toISOString() }); saveDebounced(TF, tracking); }
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store, no-cache');
  res.send(PIXEL_BUF);
});

app.get('/c/:trackingId', (req, res) => {
  const rec = tracking.find(t => t.trackingId === req.params.trackingId);
  if (rec) { rec.clicks.push({ at: new Date().toISOString() }); saveDebounced(TF, tracking); }
  res.redirect(rec?.targetUrl || '/');
});

const _handleUnsubscribe = (req, res) => {
  try {
    const raw = Array.isArray(req.query.e) ? req.query.e[0] : req.query.e;
    const email = raw ? Buffer.from(raw, 'base64url').toString() : null;
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) addUnsubscribed(email);
  } catch {}
  // RFC 8058: POST one-click must return 200 with no redirect
  if (req.method === 'POST') return res.sendStatus(200);
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Unsubscribed</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}div{text-align:center;padding:40px;max-width:400px}h2{color:#111;margin-bottom:8px}p{color:#6b7280;font-size:14px}</style></head><body><div><h2>You've been unsubscribed</h2><p>You won't receive any more emails from us.</p></div></body></html>`);
};
app.get('/unsubscribe', _handleUnsubscribe);
app.post('/unsubscribe', _handleUnsubscribe);

// ── PUBLIC ROUTES (no auth required, SEO-crawlable) ─────────────────────
app.use(express.static(path.join(__dirname,'public','seo'), {
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control','public, max-age=3600');
    }
    if (p.endsWith('.xml') || p.endsWith('.txt')) {
      res.setHeader('Cache-Control','public, max-age=3600');
    }
  }
}));
app.get('/how-it-works', (req, res) => res.sendFile(path.join(__dirname,'public','how-it-works.html')));
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname,'public','seo','blog','index.html')));
app.get('/blog/:slug', (req, res) => {
  const file = path.join(__dirname,'public','seo','blog', req.params.slug + '.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('Not found');
});

// Landing-page contact form (public, no auth).
const CF = path.join(DATA,'contacts.json');
let contacts = load(CF);

// In-memory rate limiter: max 5 submissions per IP per minute.
const _contactHits = new Map();
function contactRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const max = 5;
  const hits = (_contactHits.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  _contactHits.set(ip, hits);
  // Opportunistic cleanup so the map doesn't grow forever.
  if (_contactHits.size > 1000) {
    for (const [k, v] of _contactHits) {
      if (!v.length || now - v[v.length - 1] > windowMs) _contactHits.delete(k);
    }
  }
  return hits.length > max;
}

async function sendContactNotification(record) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  const notifyTo = process.env.CONTACT_NOTIFY_EMAIL || 'leif@forgeaiagent.com';
  if (!RESEND_API_KEY || !RESEND_FROM) return;
  try {
    const { Resend } = require('resend');
    const resend = new Resend(RESEND_API_KEY);
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    await resend.emails.send({
      from: `Forge AI Leads <${RESEND_FROM}>`,
      to: notifyTo,
      replyTo: record.email,
      subject: `New lead: ${record.business || record.name}`,
      text: `Name: ${record.name}\nBusiness: ${record.business}\nType: ${record.type}\nEmail: ${record.email}\nSubmitted: ${record.submittedAt}\nIP: ${record.ip}`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#0f172a;padding:20px 24px;border-radius:10px 10px 0 0">
            <span style="font-size:16px;font-weight:700;color:#fff;letter-spacing:.04em">FORGE <span style="color:#60a5fa">AI</span></span>
            <span style="margin-left:10px;font-size:11px;color:#94a3b8">NEW LEAD</span>
          </div>
          <div style="background:#fff;padding:28px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
            <h2 style="margin:0 0 18px;font-size:18px;color:#0f172a">${esc(record.business || record.name)}</h2>
            <table style="width:100%;border-collapse:collapse;font-size:14px;color:#334155">
              <tr><td style="padding:6px 0;color:#64748b;width:120px">Contact</td><td style="padding:6px 0"><strong>${esc(record.name)}</strong></td></tr>
              <tr><td style="padding:6px 0;color:#64748b">Business</td><td style="padding:6px 0">${esc(record.business) || '<em>not provided</em>'}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b">Type</td><td style="padding:6px 0">${esc(record.type) || '<em>not provided</em>'}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b">Email</td><td style="padding:6px 0"><a href="mailto:${esc(record.email)}" style="color:#2563eb;text-decoration:none">${esc(record.email)}</a></td></tr>
              <tr><td style="padding:6px 0;color:#64748b">Submitted</td><td style="padding:6px 0">${esc(record.submittedAt)}</td></tr>
            </table>
            <p style="margin:22px 0 0;font-size:12px;color:#94a3b8">Reply directly to this email to get in touch with the lead.</p>
          </div>
        </div>`
    });
  } catch (e) {
    console.error('[contact-notify]', e.message);
  }
}

app.post('/api/contact', async (req, res) => {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim();
  if (contactRateLimited(ip)) return res.status(429).json({ error: 'Too many submissions. Try again in a minute.' });
  const body = req.body || {};
  // Honeypot: bots fill every field. If 'website' is non-empty, silently accept and drop.
  if (body.website) return res.json({ ok: true });
  const { name, business, type, email } = body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
  const record = {
    id: randomUUID(),
    name: String(name).slice(0,200),
    business: String(business||'').slice(0,200),
    type: String(type||'').slice(0,200),
    email: String(email).slice(0,200),
    submittedAt: new Date().toISOString(),
    ip
  };
  contacts.push(record);
  save(CF, contacts);
  console.log(`[contact] ${record.name} | ${record.business} | ${record.type} | ${record.email}`);
  res.json({ ok: true });
  // Fire-and-forget notification so the response isn't blocked on SMTP.
  sendContactNotification(record);
});

// ── LANDING PAGE (public, always) ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname,'public','seo','landing.html'));
});

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Public: auth/logout routes, static assets (so landing page CSS/JS/images load), tracking pixel
  if (req.path === '/login' || req.path === '/logout') return next();
  if (/\.(css|js|jpg|jpeg|png|webp|svg|ico|xml|txt|woff|woff2|gif|mp4|webm|ogg)$/.test(req.path)) return next();
  if (req.session.auth) return next();
  // Unauthenticated API calls get JSON error instead of redirect
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
});
app.use(express.static(path.join(__dirname,'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
      res.setHeader('Pragma','no-cache');
    } else if (/\.(?:js|css|woff2?|ttf|otf|svg|png|jpg|jpeg|gif|webp|ico)$/i.test(p)) {
      res.setHeader('Cache-Control','public, max-age=86400, stale-while-revalidate=604800');
    }
  }
}));

// ── APP (protected tool) ───────────────────────────────────────────────────
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname,'public','index.html'));
});
const SITES_DIR = path.join(DATA_ROOT,'sites');
fs.mkdirSync(SITES_DIR,{recursive:true});
app.use('/sites', express.static(SITES_DIR, {
  etag: true,
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) res.setHeader('Cache-Control','public, max-age=300');
  }
}));

// ── SSE ───────────────────────────────────────────────────────────────────
const sessions = {};
app.get('/api/stream/:id', (req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  sessions[req.params.id] = send;
  send({ type:'connected' });
  req.on('close', () => delete sessions[req.params.id]);
});
const emit = (sid,d) => { if(sid&&sessions[sid]) sessions[sid](d) };

// ── SCOUT ─────────────────────────────────────────────────────────────────
app.post('/api/scout/run', async (req,res) => {
  const { location, businessTypes, businessType, maxLeads, filter, sessionId } = req.body;
  if (!location) return res.status(400).json({ error:'Location required' });
  res.json({ status:'started' });
  try {
    await runScout({ location, businessTypes, businessType, maxLeads:parseInt(maxLeads)||20, filter:filter||'no_website' }, p => {
      if (p.lead) {
        if (!leads.find(l=>l.name===p.lead.name&&l.address===p.lead.address)) {
          p.lead.id = randomUUID();
          leads.push(p.lead); save(LF,leads);
        }
      }
      emit(sessionId, { type:'scout', ...p });
    });
    emit(sessionId, { type:'scout_done', total: leads.length });
  } catch(e) { emit(sessionId, { type:'error', agent:'scout', message:e.message }); }
});

// ── EMAIL FINDER ──────────────────────────────────────────────────────────
app.post('/api/emailfinder/find', async (req,res) => {
  const { id, sessionId } = req.body;
  const f = findLead(id);
  if (!f) return res.status(404).json({ error:'Lead not found' });
  const { lead, index } = f;
  res.json({ status:'started' });
  try {
    emit(sessionId, { type:'emailfinder', status:'searching', message:`🔍 Searching email for ${lead.name}...` });
    const result = await findEmail(lead, p => emit(sessionId,{ type:'emailfinder',...p }));
    if (lead.socials) { leads[index].socials=lead.socials; }
    if (result) {
      leads[index].foundEmail=result.email;
      leads[index].emailConfidence=result.confidence;
      save(LF,leads);
      emit(sessionId, { type:'emailfinder', status:'found', message:`✅ Found: ${result.email} (${result.confidence}% confidence)` });
    } else {
      save(LF,leads);
      emit(sessionId, { type:'emailfinder', status:'not_found', message:`❌ No email found for ${lead.name}` });
    }
    emit(sessionId, { type:'emailfinder_done', leadId:id, email:result?.email||null, confidence:result?.confidence||null });
  } catch(e) { emit(sessionId, { type:'error', agent:'emailfinder', message:e.message }); }
});

app.post('/api/emailfinder/find-batch', async (req,res) => {
  const { ids, sessionId } = req.body;
  if (!ids?.length) return res.status(400).json({ error:'No leads' });
  res.json({ status:'started' });
  let found = 0;
  emit(sessionId, { type:'emailfinder', status:'start', message:`🚀 Starting batch search for ${ids.length} leads...` });
  for (let i = 0; i < ids.length; i++) {
    const f = findLead(ids[i]);
    if (!f) continue;
    const { lead, index } = f;
    try {
      emit(sessionId, { type:'emailfinder', status:'searching', message:`[${i+1}/${ids.length}] Searching: ${lead.name}` });
      const result = await findEmail(lead, p => emit(sessionId,{ type:'emailfinder',...p }));
      if (lead.socials) { leads[index].socials=lead.socials; }
      if (result) {
        leads[index].foundEmail=result.email;
        leads[index].emailConfidence=result.confidence;
        found++;
        save(LF,leads);
        emit(sessionId, { type:'emailfinder', status:'found', message:`✅ [${i+1}/${ids.length}] ${lead.name} → ${result.email}` });
      } else {
        save(LF,leads);
        emit(sessionId, { type:'emailfinder', status:'not_found', message:`❌ [${i+1}/${ids.length}] No email for ${lead.name}` });
      }
      emit(sessionId, { type:'emailfinder_done', leadId:ids[i], email:result?.email||null });
    } catch(e) {
      emit(sessionId, { type:'emailfinder', status:'error', message:`⚠ ${lead.name}: ${e.message}` });
    }
    await new Promise(r=>setTimeout(r,600));
  }
  emit(sessionId, { type:'emailfinder_batch_done', found, total:ids.length });
  emit(sessionId, { type:'emailfinder', status:'complete', message:`🏁 Done, ${found}/${ids.length} emails found` });
});

app.post('/api/emailfinder/hunter', async (req,res) => {
  const { id, sessionId } = req.body;
  const f = findLead(id);
  if (!f) return res.status(404).json({ error:'Lead not found' });
  const { lead, index } = f;
  res.json({ status:'started' });
  try {
    emit(sessionId, { type:'emailfinder', status:'searching', message:`🔍 Hunter.io search for ${lead.name}...` });
    const result = await hunterSearch(lead, p => emit(sessionId,{ type:'emailfinder',...p }));
    if (result) {
      leads[index].foundEmail=result.email;
      leads[index].emailConfidence=result.confidence;
      save(LF,leads);
      emit(sessionId, { type:'emailfinder', status:'found', message:`✅ Hunter.io: ${result.email} (${result.confidence}%)` });
    }
    emit(sessionId, { type:'emailfinder_done', leadId:id, email:result?.email||null, confidence:result?.confidence||null });
  } catch(e) { emit(sessionId, { type:'error', agent:'emailfinder', message:e.message }); }
});

let hunterCreditsCache = null;
let hunterCreditsCacheTime = 0;
app.get('/api/emailfinder/credits', async (req,res) => {
  try {
    const now = Date.now();
    if (hunterCreditsCache && now - hunterCreditsCacheTime < 5 * 60 * 1000) {
      return res.json({ credits: hunterCreditsCache });
    }
    const credits = await checkCredits();
    hunterCreditsCache = credits;
    hunterCreditsCacheTime = now;
    res.json({ credits });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── BUILDER ───────────────────────────────────────────────────────────────
app.post('/api/builder/build', async (req,res) => {
  const { id, sessionId } = req.body;
  const f = findLead(id);
  if (!f) return res.status(404).json({ error:'Lead not found' });
  const { lead, index } = f;
  res.json({ status:'started' });
  emit(sessionId, { type:'builder', status:'start', message:`🚀 Starting build for ${lead.name}...` });
  try {
    const { filename, html } = await buildDemoSite(lead, p => emit(sessionId,{ type:'builder',...p }));
    let previewUrl = `${getBase()}/sites/${filename}`;
    if (cfConfigured()) {
      try {
        previewUrl = await cfDeploy(lead.name, html, p => emit(sessionId,{ type:'builder',...p }));
      } catch(cfErr) {
        emit(sessionId, { type:'builder', status:'warn', message:`⚠️  Cloudflare deploy failed: ${cfErr.message}, using local URL` });
      }
    }
    leads[index] = { ...leads[index], siteFile:filename, previewUrl, status:'Site Built' };
    save(LF,leads);
    emit(sessionId, { type:'builder', status:'done', message:`✅ ${lead.name}, site live! ${previewUrl}` });
    emit(sessionId, { type:'builder_done', leadId:id, filename, previewUrl });
  } catch(e) {
    emit(sessionId, { type:'builder', status:'error', message:`❌ Failed: ${e.message}` });
    emit(sessionId, { type:'error', agent:'builder', message:e.message });
  }
});

app.post('/api/builder/build-batch', async (req,res) => {
  const { ids, sessionId } = req.body;
  if (!ids?.length) return res.status(400).json({ error:'No leads' });
  res.json({ status:'started' });
  emit(sessionId, { type:'builder', status:'start', message:`🚀 Building ${ids.length} site(s)...` });
  let built = 0;
  for (let i = 0; i < ids.length; i++) {
    const f = findLead(ids[i]);
    if (!f) continue;
    const { lead, index } = f;
    emit(sessionId, { type:'builder', status:'building', message:`[${i+1}/${ids.length}] Building: ${lead.name}...` });
    try {
      const { filename, html } = await buildDemoSite(lead, p => emit(sessionId,{ type:'builder',...p }));
      let previewUrl = `${getBase()}/sites/${filename}`;
      if (cfConfigured()) {
        try {
          previewUrl = await cfDeploy(lead.name, html, p => emit(sessionId,{ type:'builder',...p }));
        } catch(cfErr) {
          emit(sessionId, { type:'builder', status:'warn', message:`⚠️  Cloudflare deploy failed: ${cfErr.message}, using local URL` });
        }
      }
      leads[index] = { ...leads[index], siteFile:filename, previewUrl, status:'Site Built' };
      save(LF,leads);
      built++;
      emit(sessionId, { type:'builder', status:'done', message:`✅ [${built}/${ids.length}] ${lead.name} live!` });
      emit(sessionId, { type:'builder_done', leadId:ids[i], filename, previewUrl });
    } catch(e) {
      emit(sessionId, { type:'builder', status:'error', message:`❌ ${lead.name}: ${e.message}` });
    }
    await new Promise(r=>setTimeout(r,800));
  }
  emit(sessionId, { type:'builder_batch_done', built, total:ids.length });
  emit(sessionId, { type:'builder', status:'complete', message:`🏁 Done, ${built}/${ids.length} sites built` });
});

// ── OUTREACH ──────────────────────────────────────────────────────────────
app.post('/api/outreach/preview', async (req,res) => {
  const { id, outreachType } = req.body;
  const f = findLead(id);
  if (!f) return res.status(404).json({ error:'Lead not found' });
  try {
    const copy = await generateEmailPreview(f.lead, f.lead.previewUrl||getBase(), outreachType);
    res.json({ ok:true, copy });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/outreach/send', async (req,res) => {
  const { id, emailAddress, sessionId, subject, body, force, outreachType } = req.body;
  const f = findLead(id);
  if (!f) return res.status(404).json({ error:'Lead not found' });
  const { lead, index } = f;
  if (!emailAddress) return res.status(400).json({ error:'Email required' });
  if (!isValidEmail(emailAddress)) return res.status(400).json({ error:'Invalid email format' });
  if (!force && outreach.find(o=>o.leadId===id&&o.sentTo===emailAddress))
    return res.status(400).json({ error:'Already sent to this address for this lead.' });
  // Only no-website leads need a demo URL. Has-website leads pitch a
  // redesign of the existing site, no CTA button, no demo to build first.
  if (isUnsubscribed(emailAddress))
    return res.status(400).json({ error:`⚠️ ${emailAddress} has unsubscribed. Remove them from your list before sending.`, unsubscribed: true });
  const needsDemo = !((outreachType === 'has_website') || (outreachType === 'agency') || (!outreachType && lead.website));
  if (needsDemo && !hasValidDemoUrl(lead.previewUrl))
    return res.status(400).json({ error:`No demo site built for ${lead.name}. Build the site first so the email has something to link to.` });
  // Prevent duplicate concurrent sends
  const lockKey = `${id}:${emailAddress}`;
  if (sendingInProgress.has(lockKey))
    return res.status(409).json({ error:'Email is already being sent to this lead. Please wait.' });
  sendingInProgress.add(lockKey);
  res.json({ status:'started' });
  emit(sessionId, { type:'outreach', status:'start', message:`📧 Preparing email for ${lead.name}...` });
  try {
    const previewUrl = lead.previewUrl;
    const trackingId = randomUUID();
    const trackingOpts = {
      pixelHtml: `<img src="${getBase()}/t/${trackingId}.png" width="1" height="1" style="display:block;opacity:0" alt="" />`,
      clickUrl: `${getBase()}/c/${trackingId}`,
      unsubscribeUrl: `${getBase()}/unsubscribe?e=${Buffer.from(emailAddress).toString('base64url')}`
    };

    const result = await sendOutreach(lead, previewUrl, emailAddress, p => emit(sessionId,{ type:'outreach',...p }), subject, body, trackingOpts, outreachType);
    // Only create tracking record AFTER successful send
    tracking.push({ trackingId, leadId:id, type:'outreach', opens:[], clicks:[], targetUrl:previewUrl, abVariant:null, createdAt:new Date().toISOString() });
    save(TF, tracking);
    outreach.push({ leadId:id, lead:lead.name, ...result });
    save(OF,outreach);
    leads[index].status='Outreach Sent';
    leads[index].outreachEmail=emailAddress;
    leads[index].outreachSentAt=result.sentAt;
    save(LF,leads);
    emit(sessionId, { type:'outreach', status:'sent', message:`✅ Email sent to ${emailAddress}!` });
    emit(sessionId, { type:'outreach_done', leadId:id, result });
  } catch(e) {
    emit(sessionId, { type:'outreach', status:'error', message:`❌ Failed: ${e.message}` });
    emit(sessionId, { type:'error', agent:'outreach', message:e.message });
  } finally {
    sendingInProgress.delete(lockKey);
  }
});

// ── BATCH OUTREACH ────────────────────────────────────────────────────────
let batchOutreachRunning = false;
app.post('/api/outreach/batch', async (req,res) => {
  if (batchOutreachRunning) return res.status(409).json({ error:'Batch outreach already in progress' });
  const { ids, sessionId } = req.body;
  // Has-website leads skip the demo requirement (the pitch is a redesign,
  // no CTA). No-website leads still need a real .pages.dev demo built.
  const targets = (ids && ids.length ? ids : leads.map(l=>l.id))
    .map(id => findLead(id))
    .filter(f => {
      if (!f || !f.lead.foundEmail) return false;
      const alreadySent = outreach.find(o => o.leadId === f.lead.id && o.sentTo === f.lead.foundEmail);
      if (alreadySent) return false;
      const hasWebsite = !!f.lead.website;
      if (!hasWebsite && !hasValidDemoUrl(f.lead.previewUrl)) return false;
      return true;
    });
  if (!targets.length) return res.status(400).json({ error:'No eligible leads (need email, built demo for no-website leads, not already sent)' });
  batchOutreachRunning = true;
  res.json({ status:'started', count:targets.length });
  emit(sessionId, { type:'outreach_batch', status:'start', message:`🚀 Batch sending to ${targets.length} leads...` });
  let sent = 0, failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const { lead, index } = targets[i];
    const email = lead.foundEmail;
    emit(sessionId, { type:'outreach_batch', status:'sending', message:`[${i+1}/${targets.length}] Sending to ${lead.name} (${email})...`, progress: Math.round((i/targets.length)*100) });
    const lockKey = `${lead.id}:${email}`;
    if (sendingInProgress.has(lockKey)) {
      emit(sessionId, { type:'outreach_batch', status:'error', message:`⏭ ${lead.name}: Already sending, skipped` });
      failed++;
      continue;
    }
    sendingInProgress.add(lockKey);
    try {
      if (!isValidEmail(email)) {
        emit(sessionId, { type:'outreach_batch', status:'error', message:`❌ ${lead.name}: Invalid email format (${email})` });
        failed++;
        continue;
      }
      if (isUnsubscribed(email)) {
        emit(sessionId, { type:'outreach_batch', status:'error', message:`⚠️ ${lead.name}: Unsubscribed, skipped` });
        failed++;
        continue;
      }
      const previewUrl = lead.previewUrl;
      const trackingId = randomUUID();
      const trackingOpts = {
        pixelHtml: `<img src="${getBase()}/t/${trackingId}.png" width="1" height="1" style="display:block;opacity:0" alt="" />`,
        clickUrl: `${getBase()}/c/${trackingId}`,
        unsubscribeUrl: `${getBase()}/unsubscribe?e=${Buffer.from(email).toString('base64url')}`
      };
      const autoType = lead.website ? 'has_website' : 'no_website';
      const result = await sendOutreach(lead, previewUrl, email, () => {}, null, null, trackingOpts, autoType);
      // Only create tracking record AFTER successful send
      tracking.push({ trackingId, leadId:lead.id, type:'outreach', opens:[], clicks:[], targetUrl:previewUrl, abVariant:null, createdAt:new Date().toISOString() });
      save(TF, tracking);
      outreach.push({ leadId:lead.id, lead:lead.name, ...result });
      save(OF, outreach);
      leads[index].status='Outreach Sent';
      leads[index].outreachEmail=email;
      leads[index].outreachSentAt=result.sentAt;
      save(LF, leads);
      sent++;
      emit(sessionId, { type:'outreach_batch', status:'sent', message:`✅ [${sent}/${targets.length}] ${lead.name} → ${email}` });
    } catch(e) {
      failed++;
      emit(sessionId, { type:'outreach_batch', status:'error', message:`❌ ${lead.name}: ${e.message}` });
      if (e.dailyLimitReached) {
        const remaining = targets.length - i - 1;
        emit(sessionId, { type:'outreach_batch', status:'error', message:`⛔ Daily email limit reached. Stopping batch. ${remaining} leads skipped.` });
        sendingInProgress.delete(lockKey);
        break;
      }
    } finally {
      sendingInProgress.delete(lockKey);
    }
    // Random delay 3-8 seconds
    const delay = 3000 + Math.random() * 5000;
    await new Promise(r=>setTimeout(r,delay));
  }
  batchOutreachRunning = false;
  emit(sessionId, { type:'outreach_batch_done', sent, failed, total:targets.length });
  emit(sessionId, { type:'outreach_batch', status:'complete', message:`🏁 Batch done, ${sent} sent, ${failed} failed` });
});

// ── BATCH FOLLOW-UP ──────────────────────────────────────────────────────
app.post('/api/outreach/followup-batch', async (req,res) => {
  const { ids, sessionId } = req.body;
  if (!ids?.length) return res.status(400).json({ error:'No leads selected' });
  const targets = ids.map(id => findLead(id)).filter(f => f && f.lead.outreachEmail);
  if (!targets.length) return res.status(400).json({ error:'No eligible leads (need outreach email)' });
  res.json({ status:'started', count:targets.length });
  emit(sessionId, { type:'followup_batch', status:'start', message:`🚀 Sending follow-ups to ${targets.length} leads...` });
  let sent = 0, failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const { lead, index } = targets[i];
    const email = lead.outreachEmail;
    emit(sessionId, { type:'followup_batch', status:'sending', message:`[${i+1}/${targets.length}] Following up with ${lead.name}...`, progress: Math.round((i/targets.length)*100) });
    try {
      const prevOutreach = outreach.find(o => o.leadId === lead.id);
      const prevFollowUps = outreach.filter(o => o.leadId === lead.id && o.type === 'followup').length;
      if (prevFollowUps >= 3) {
        emit(sessionId, { type:'followup_batch', status:'skipped', message:`⏭ ${lead.name}: Already sent 3 follow-ups` });
        continue;
      }
      if (isUnsubscribed(email)) {
        emit(sessionId, { type:'followup_batch', status:'skipped', message:`⚠️ ${lead.name}: Unsubscribed, skipped` });
        continue;
      }
      const step = Math.min(prevFollowUps + 1, 3);
      const followUp = await generateFollowUpEmail(lead, step, prevOutreach?.subject || 'Your demo website');
      const trackingId = randomUUID();
      const previewUrl = lead.previewUrl;
      const trackingOpts = {
        pixelHtml: `<img src="${getBase()}/t/${trackingId}.png" width="1" height="1" style="display:block;opacity:0" alt="" />`,
        clickUrl: `${getBase()}/c/${trackingId}`,
        unsubscribeUrl: `${getBase()}/unsubscribe?e=${Buffer.from(email).toString('base64url')}`
      };
      const autoType = lead.website ? 'has_website' : 'no_website';
      const result = await sendOutreach(lead, previewUrl, email, ()=>{}, followUp.subject, followUp.body, trackingOpts, autoType);
      // Only create tracking record AFTER successful send
      tracking.push({ trackingId, leadId:lead.id, type:'followup', opens:[], clicks:[], targetUrl:previewUrl, abVariant:null, createdAt:new Date().toISOString() });
      save(TF, tracking);
      outreach.push({ leadId:lead.id, lead:lead.name, type:'followup', ...result });
      save(OF, outreach);
      leads[index].followupCount = (leads[index].followupCount || 0) + 1;
      save(LF, leads);
      sent++;
      emit(sessionId, { type:'followup_batch', status:'sent', message:`✅ [${sent}/${targets.length}] Follow-up sent to ${lead.name}` });
    } catch(e) {
      failed++;
      emit(sessionId, { type:'followup_batch', status:'error', message:`❌ ${lead.name}: ${e.message}` });
      if (e.dailyLimitReached) {
        const remaining = targets.length - i - 1;
        emit(sessionId, { type:'followup_batch', status:'error', message:`⛔ Daily email limit reached. Stopping batch. ${remaining} leads skipped.` });
        break;
      }
    }
    const delay = 3000 + Math.random() * 5000;
    await new Promise(r=>setTimeout(r,delay));
  }
  emit(sessionId, { type:'followup_batch_done', sent, failed, total:targets.length });
  emit(sessionId, { type:'followup_batch', status:'complete', message:`🏁 Follow-ups done, ${sent} sent, ${failed} failed` });
});

// ── SEND SCHEDULING ───────────────────────────────────────────────────────
app.post('/api/outreach/schedule', (req,res) => {
  const { id, emailAddress, subject, body, sendAt } = req.body;
  const f = findLead(id);
  if (!f) return res.status(404).json({ error:'Lead not found' });
  if (!emailAddress || !sendAt) return res.status(400).json({ error:'Email and sendAt required' });
  if (!isValidEmail(emailAddress)) return res.status(400).json({ error:'Invalid email format' });
  const rec = { id:randomUUID(), leadId:id, emailAddress, subject:subject||'', body:body||'', sendAt, status:'pending', createdAt:new Date().toISOString() };
  scheduled.push(rec); save(SCH_F, scheduled);
  res.json({ ok:true, scheduled:rec });
});

app.get('/api/scheduled', (req,res) => {
  const enriched = scheduled.map(s => {
    const f = findLead(s.leadId);
    return { ...s, leadName: f?.lead?.name || 'Unknown' };
  });
  res.json({ scheduled:enriched });
});

app.post('/api/scheduled/process', async (req,res) => {
  const { sessionId } = req.body;
  const now = new Date().toISOString();
  const due = scheduled.filter(s => s.status === 'pending' && s.sendAt <= now);
  if (!due.length) return res.json({ processed:0 });
  let sent = 0;
  for (const s of due) {
    const f = findLead(s.leadId);
    if (!f) { s.status='cancelled'; continue; }
    if (isUnsubscribed(s.emailAddress)) { s.status='cancelled'; continue; }
    try {
      const previewUrl = f.lead.previewUrl;
      const trackingId = randomUUID();
      const trackingOpts = {
        pixelHtml: `<img src="${getBase()}/t/${trackingId}.png" width="1" height="1" style="display:block;opacity:0" alt="" />`,
        clickUrl: `${getBase()}/c/${trackingId}`,
        unsubscribeUrl: `${getBase()}/unsubscribe?e=${Buffer.from(s.emailAddress).toString('base64url')}`
      };
      const autoType = f.lead.website ? 'has_website' : 'no_website';
      const result = await sendOutreach(f.lead, previewUrl, s.emailAddress, ()=>{}, s.subject||null, s.body||null, trackingOpts, autoType);
      // Only create tracking record AFTER successful send
      tracking.push({ trackingId, leadId:s.leadId, type:'outreach', opens:[], clicks:[], targetUrl:previewUrl, abVariant:null, createdAt:new Date().toISOString() });
      outreach.push({ leadId:s.leadId, lead:f.lead.name, ...result });
      save(OF, outreach);
      leads[f.index].status='Outreach Sent';
      leads[f.index].outreachEmail=s.emailAddress;
      leads[f.index].outreachSentAt=result.sentAt;
      save(LF, leads);
      s.status='sent'; s.sentAt=result.sentAt;
      sent++;
      emit(sessionId, { type:'scheduled_sent', leadId:s.leadId, message:`✅ Scheduled email sent to ${s.emailAddress}` });
    } catch(e) {
      s.status='failed'; s.error=e.message;
      emit(sessionId, { type:'scheduled_error', leadId:s.leadId, message:`❌ ${e.message}` });
    }
  }
  save(SCH_F, scheduled);
  save(TF, tracking);
  res.json({ processed:sent });
});

app.delete('/api/scheduled/:id', (req,res) => {
  const idx = scheduled.findIndex(s => s.id === req.params.id);
  if (idx >= 0) { scheduled[idx].status='cancelled'; save(SCH_F, scheduled); }
  res.json({ ok:true });
});

// ── FOLLOW-UP SEQUENCES ──────────────────────────────────────────────────
app.post('/api/sequences/start', (req,res) => {
  const { id } = req.body;
  const f = findLead(id);
  if (!f) return res.status(404).json({ error:'Lead not found' });
  if (sequences.find(s => s.leadId===id && s.status==='active'))
    return res.status(400).json({ error:'Sequence already active for this lead' });
  const now = new Date();
  const seq = {
    id: randomUUID(), leadId: id, status: 'active', createdAt: now.toISOString(),
    steps: [
      { step:1, sendAt: new Date(now.getTime()+3*86400000).toISOString(), status:'pending', sentAt:null },
      { step:2, sendAt: new Date(now.getTime()+7*86400000).toISOString(), status:'pending', sentAt:null },
      { step:3, sendAt: new Date(now.getTime()+14*86400000).toISOString(), status:'pending', sentAt:null },
    ]
  };
  sequences.push(seq); save(SEQ_F, sequences);
  res.json({ ok:true, sequence:seq });
});

app.get('/api/sequences', (req,res) => {
  const enriched = sequences.map(s => {
    const f = findLead(s.leadId);
    return { ...s, leadName: f?.lead?.name || 'Unknown' };
  });
  res.json({ sequences:enriched });
});

app.post('/api/sequences/process', async (req,res) => {
  const { sessionId } = req.body;
  const now = new Date().toISOString();
  let sent = 0;
  for (const seq of sequences) {
    if (seq.status !== 'active') continue;
    // Check if lead has replied, auto-cancel
    const hasReply = replies.find(r => r.leadId === seq.leadId);
    if (hasReply) { seq.status = 'cancelled'; continue; }
    const f = findLead(seq.leadId);
    if (!f) { seq.status = 'cancelled'; continue; }
    for (const step of seq.steps) {
      if (step.status !== 'pending' || step.sendAt > now) continue;
      try {
        const emailAddr = f.lead.outreachEmail || f.lead.foundEmail;
        if (!emailAddr) { step.status='skipped'; continue; }
        if (isUnsubscribed(emailAddr)) { step.status='skipped'; seq.status='cancelled'; continue; }
        const prevOutreach = outreach.find(o => o.leadId === seq.leadId);
        const followUp = await generateFollowUpEmail(f.lead, step.step, prevOutreach?.subject || 'Your demo website');
        const trackingId = randomUUID();
        const previewUrl = f.lead.previewUrl;
        const trackingOpts = {
          pixelHtml: `<img src="${getBase()}/t/${trackingId}.png" width="1" height="1" style="display:block;opacity:0" alt="" />`,
          clickUrl: `${getBase()}/c/${trackingId}`,
          unsubscribeUrl: `${getBase()}/unsubscribe?e=${Buffer.from(emailAddr).toString('base64url')}`
        };
        const autoType = f.lead.website ? 'has_website' : 'no_website';
        await sendOutreach(f.lead, previewUrl, emailAddr, ()=>{}, followUp.subject, followUp.body, trackingOpts, autoType);
        // Only create tracking record AFTER successful send
        tracking.push({ trackingId, leadId:seq.leadId, type:'followup', opens:[], clicks:[], targetUrl:previewUrl, abVariant:null, createdAt:now });
        step.status='sent'; step.sentAt=new Date().toISOString();
        leads[f.index].followupCount = (leads[f.index].followupCount || 0) + 1;
        save(LF, leads);
        sent++;
        emit(sessionId, { type:'sequence_sent', leadId:seq.leadId, step:step.step, message:`✅ Follow-up ${step.step}/3 sent to ${f.lead.name}` });
      } catch(e) {
        step.status='failed'; step.error=e.message;
        emit(sessionId, { type:'sequence_error', leadId:seq.leadId, message:`❌ Follow-up failed: ${e.message}` });
      }
    }
    if (seq.steps.every(s => s.status !== 'pending')) seq.status = 'completed';
  }
  save(SEQ_F, sequences);
  save(TF, tracking);
  res.json({ processed:sent });
});

// ── CLOSER ────────────────────────────────────────────────────────────────
app.post('/api/closer/handle', async (req,res) => {
  const { id, replyText, sessionId } = req.body;
  const f = findLead(id);
  if (!f) return res.status(404).json({ error:'Lead not found' });
  const { lead, index } = f;
  res.json({ status:'started' });
  emit(sessionId, { type:'closer', status:'start', message:`🧠 Analyzing reply from ${lead.name}...` });
  const orig = outreach.find(o=>o.leadId===id) || { subject:'Your free demo website' };
  try {
    const response = await handleReply(lead, orig, replyText, p => emit(sessionId,{ type:'closer',...p }));
    replies.push({ leadId:id, lead:lead.name, replyText, response, at:new Date().toISOString() });
    save(RF,replies);
    leads[index].status=response.sentiment==='positive'?'Hot Lead 🔥':'Replied';
    leads[index].lastReply=replyText;
    save(LF,leads);
    // Auto-cancel any active sequence for this lead
    sequences.forEach(s => { if (s.leadId===id && s.status==='active') s.status='cancelled'; });
    save(SEQ_F, sequences);
    emit(sessionId, { type:'closer', status:'done', message:`✅ Response ready, ${response.objectionType} (${response.sentiment})` });
    emit(sessionId, { type:'closer_done', leadId:id, response });
  } catch(e) {
    emit(sessionId, { type:'closer', status:'error', message:`❌ Failed: ${e.message}` });
    emit(sessionId, { type:'error', agent:'closer', message:e.message });
  }
});

// ── LEADS ─────────────────────────────────────────────────────────────────
app.get('/api/leads', (req,res) => res.json({ leads, total:leads.length }));

app.delete('/api/leads/:id', (req,res) => {
  const idx = leads.findIndex(l => l.id === req.params.id);
  if (idx >= 0) { leads.splice(idx,1); save(LF,leads); }
  res.json({ ok:true });
});

app.delete('/api/leads', (req,res) => { leads=[];save(LF,leads);res.json({ok:true}); });

app.post('/api/leads/delete-batch', (req,res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error:'No ids' });
  const before = leads.length;
  leads = leads.filter(l => !ids.includes(l.id));
  save(LF,leads);
  res.json({ ok:true, removed:before-leads.length, remaining:leads.length });
});

app.get('/api/leads/export/csv', (req,res) => {
  const h=['name','address','phone','rating','reviews','type','location','status','foundEmail','emailConfidence','previewUrl','outreachEmail','found_at','score','notes'];
  const rows=leads.map(l=>h.map(k=>`"${(l[k]||'').toString().replace(/"/g,'""')}"`).join(','));
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="agentforge-leads.csv"');
  res.send([h.join(','),...rows].join('\n'));
});

// ── CRM NOTES ─────────────────────────────────────────────────────────────
app.post('/api/leads/:id/notes', (req,res) => {
  const f = findLead(req.params.id);
  if (!f) return res.status(404).json({ error:'Lead not found' });
  leads[f.index].notes = req.body.notes || '';
  save(LF, leads);
  res.json({ ok:true });
});

// ── LEAD SCORING ──────────────────────────────────────────────────────────
app.post('/api/leads/score', (req,res) => {
  // Pre-build Sets for O(1) lookups instead of O(n) tracking.find() per lead
  const openedLeads = new Set(tracking.filter(t => t.opens.length > 0).map(t => t.leadId));
  const clickedLeads = new Set(tracking.filter(t => t.clicks.length > 0).map(t => t.leadId));
  leads.forEach(l => {
    let score = 0;
    // Rating: 0-20pts (5.0 = 20pts)
    if (l.rating && l.rating !== 'N/A') score += Math.min(20, Math.round((parseFloat(l.rating)/5)*20));
    // Reviews: 0-20pts (100+ reviews = 20pts)
    if (l.reviews && l.reviews !== 'N/A') score += Math.min(20, Math.round((parseInt(l.reviews)/100)*20));
    // Has website/site built: 10pts
    if (l.siteFile) score += 10;
    // Has email: 15pts
    if (l.foundEmail) score += 15;
    // Email confidence: 0-15pts
    if (l.emailConfidence) score += Math.round((l.emailConfidence/100)*15);
    // Opened email: 10pts
    if (openedLeads.has(l.id)) score += 10;
    // Clicked: 10pts
    if (clickedLeads.has(l.id)) score += 10;
    l.score = Math.min(100, score);
  });
  save(LF, leads);
  res.json({ ok:true, leads });
});


// ── ANALYTICS (enhanced) ─────────────────────────────────────────────────
app.get('/api/analytics', (req,res) => {
  // Single-pass over leads instead of 4 separate .filter() calls
  let withEmail=0,withSite=0,contacted=0,hot=0;
  for(const l of leads){ if(l.foundEmail)withEmail++; if(l.siteFile)withSite++; if(l.outreachEmail)contacted++; if(l.status==='Hot Lead 🔥')hot++; }
  const total=leads.length, replied=replies.length;
  // Tracking stats
  const outreachRecs = tracking.filter(t=>t.type==='outreach'||t.type==='ab_test');
  const followUpRecs = tracking.filter(t=>t.type==='followup');
  const totalOpens = outreachRecs.filter(t=>t.opens.length>0).length;
  const totalClicks = outreachRecs.filter(t=>t.clicks.length>0).length;
  const outreachTracked = outreachRecs.length;
  const openRate = outreachTracked ? Math.round((totalOpens/outreachTracked)*100) : 0;
  const clickRate = outreachTracked ? Math.round((totalClicks/outreachTracked)*100) : 0;
  const replyRate = contacted ? Math.round((replied/contacted)*100) : 0;
  // Follow-up stats
  const followUpsSent = followUpRecs.length;
  const followUpOpens = followUpRecs.filter(t=>t.opens.length>0).length;
  const followUpClicks = followUpRecs.filter(t=>t.clicks.length>0).length;
  const followUpOpenRate = followUpsSent ? Math.round((followUpOpens/followUpsSent)*100) : 0;
  const followUpClickRate = followUpsSent ? Math.round((followUpClicks/followUpsSent)*100) : 0;
  // Unique leads that received follow-ups
  const followUpLeads = new Set(followUpRecs.map(t=>t.leadId)).size;
  // Per-city breakdown
  const cities = {};
  leads.forEach(l => {
    const city = l.location || 'Unknown';
    if (!cities[city]) cities[city] = { total:0, withEmail:0, contacted:0, replied:0, hot:0 };
    cities[city].total++;
    if (l.foundEmail) cities[city].withEmail++;
    if (l.outreachEmail) cities[city].contacted++;
    if (l.status==='Hot Lead 🔥') cities[city].hot++;
  });
  // Build Map once for O(1) lookups instead of O(n) findLead per reply
  const leadById = new Map(leads.map(l => [l.id, l]));
  replies.forEach(r => {
    const lead = leadById.get(r.leadId);
    if (lead) {
      const city = lead.location || 'Unknown';
      if (cities[city]) cities[city].replied++;
    }
  });
  // Per business type breakdown
  const types = {};
  leads.forEach(l => {
    const t = l.type || 'unknown';
    if (!types[t]) types[t] = { total:0, withEmail:0, contacted:0 };
    types[t].total++;
    if (l.foundEmail) types[t].withEmail++;
    if (l.outreachEmail) types[t].contacted++;
  });
  // Per-day trends
  const dailyLeads = {}, dailyEmails = {};
  leads.forEach(l => {
    if (l.found_at) { const d=l.found_at.slice(0,10); dailyLeads[d]=(dailyLeads[d]||0)+1; }
  });
  outreach.forEach(o => {
    if (o.sentAt) { const d=o.sentAt.slice(0,10); dailyEmails[d]=(dailyEmails[d]||0)+1; }
  });
  // Per-day cohort: for each day emails were sent, how many got opened/clicked
  const dailyOutreach = {};
  const outreachByLead = new Map(outreach.map(o => [o.leadId, o]));
  outreachRecs.forEach(t => {
    const o = outreachByLead.get(t.leadId);
    const d = (o?.sentAt || t.createdAt || '').slice(0, 10);
    if (!d) return;
    if (!dailyOutreach[d]) dailyOutreach[d] = { sent: 0, opens: 0, clicks: 0 };
    dailyOutreach[d].sent++;
    if (t.opens.length > 0) dailyOutreach[d].opens++;
    if (t.clicks.length > 0) dailyOutreach[d].clicks++;
  });
  res.json({
    total, withEmail, withSite, contacted, replied, hotLeads:hot,
    convRate: contacted>0?((hot/contacted)*100).toFixed(1):0,
    openRate, clickRate, replyRate, totalOpens, totalClicks, outreachTracked,
    followUpsSent, followUpLeads, followUpOpens, followUpClicks, followUpOpenRate, followUpClickRate,
    cities, types, dailyLeads, dailyEmails, dailyOutreach,
    activeSequences: sequences.filter(s=>s.status==='active').length,
    scheduledPending: scheduled.filter(s=>s.status==='pending').length,
  });
});

// ── SOCIAL FINDER ─────────────────────────────────────────────────────────
app.post('/api/social/find', async (req, res) => {
  const { id, sessionId } = req.body;
  const f = findLead(id);
  if (!f) return res.status(404).json({ error: 'Lead not found' });
  res.json({ status: 'started' });
  try {
    const result = await findSocialMedia(f.lead, p => emit(sessionId, { type: 'social', ...p }));
    leads[f.index].socials = result;
    save(LF, leads);
    emit(sessionId, { type: 'social_done', leadId: id, result });
  } catch(e) {
    emit(sessionId, { type: 'error', agent: 'social', message: e.message });
  }
});

app.post('/api/social/find-batch', async (req, res) => {
  const { ids, sessionId } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'No leads selected' });
  res.json({ status: 'started' });
  emit(sessionId, { type: 'social', status: 'start', message: `🚀 Searching social media for ${ids.length} leads...` });
  let found = 0;
  for (let i = 0; i < ids.length; i++) {
    const f = findLead(ids[i]);
    if (!f) continue;
    const { lead, index } = f;
    try {
      emit(sessionId, { type: 'social', status: 'searching', message: `[${i+1}/${ids.length}] Searching: ${lead.name}` });
      const result = await findSocialMedia(lead, p => emit(sessionId, { type: 'social', ...p }));
      leads[index].socials = result;
      save(LF, leads);
      if (result.foundCount > 0) found++;
      emit(sessionId, { type: 'social_done', leadId: ids[i], result });
    } catch(e) {
      emit(sessionId, { type: 'social', status: 'error', message: `❌ ${lead.name}: ${e.message}` });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  emit(sessionId, { type: 'social_batch_done', found, total: ids.length });
  emit(sessionId, { type: 'social', status: 'complete', message: `🏁 Done, ${found}/${ids.length} leads have social profiles` });
});

// ── SETTINGS ─────────────────────────────────────────────────────────────
// Live connectivity probes. We actually call each service with its env-var
// key and treat a 2xx as "Connected". Cached for 10 min so repeated Settings
// page loads don't pile on API calls. Also flips to "Connected" the moment
// any agent successfully uses the service, so a working agent never shows
// as "Not Set" in the UI.
const axios = require('axios');
const _probe = {
  ts: 0,
  data: {},
  verified: new Set(),
  TTL: 10 * 60 * 1000
};
function markVerified(name) { _probe.verified.add(name); }
async function probeAnthropic() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k || k === 'your_anthropic_key_here') return false;
  try {
    // Use a tiny prompt-cache-friendly ping; 1 output token, negligible cost.
    await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }]
    }, {
      headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 10000, validateStatus: () => true
    }).then(r => { if (r.status >= 200 && r.status < 300) markVerified('anthropic'); });
  } catch {}
  return _probe.verified.has('anthropic');
}
async function probeHunter() {
  const k = process.env.HUNTER_API_KEY;
  if (!k) return false;
  try {
    const r = await axios.get('https://api.hunter.io/v2/account', { params: { api_key: k }, timeout: 8000, validateStatus: () => true });
    if (r.status === 200) markVerified('hunter');
  } catch {}
  return _probe.verified.has('hunter');
}
async function probeCloudflare() {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID, t = process.env.CLOUDFLARE_API_TOKEN;
  if (!id || !t) return false;
  try {
    const r = await axios.get(`https://api.cloudflare.com/client/v4/accounts/${id}`, {
      headers: { Authorization: `Bearer ${t}` }, timeout: 8000, validateStatus: () => true
    });
    if (r.status === 200) markVerified('cloudflare');
  } catch {}
  return _probe.verified.has('cloudflare');
}
async function probeResend() {
  const k = process.env.RESEND_API_KEY, from = process.env.RESEND_FROM;
  if (!k || !from) return false;
  try {
    const r = await axios.get('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${k}` }, timeout: 8000, validateStatus: () => true
    });
    if (r.status >= 200 && r.status < 300) markVerified('resend');
  } catch {}
  return _probe.verified.has('resend');
}
async function probeBrevo() {
  const k = process.env.BREVO_API_KEY;
  if (!k) return false;
  try {
    const r = await axios.get('https://api.brevo.com/v3/account', {
      headers: { 'api-key': k }, timeout: 8000, validateStatus: () => true
    });
    if (r.status === 200) markVerified('brevo');
  } catch {}
  return _probe.verified.has('brevo');
}
async function probeGoogle() {
  const k = process.env.GOOGLE_PLACES_API_KEY;
  if (!k) return false;
  // Env presence is enough. The Scout agent will surface any quota/auth
  // errors at run time, and we don't want to burn Places calls just to ping.
  markVerified('google');
  return true;
}
async function runProbes() {
  const now = Date.now();
  if (now - _probe.ts < _probe.TTL && _probe.data && Object.keys(_probe.data).length) return _probe.data;
  const [anthropic, hunter, cloudflare, resend, brevo, google] = await Promise.all([
    probeAnthropic(), probeHunter(), probeCloudflare(), probeResend(), probeBrevo(), probeGoogle()
  ]);
  // env presence fallback: if no probe could be made (no key at all), keep false.
  // OR if an agent previously used the service successfully, keep that true.
  const merge = (probed, name) => probed || _probe.verified.has(name);
  _probe.data = {
    anthropic: merge(anthropic, 'anthropic'),
    hunter: merge(hunter, 'hunter'),
    cloudflare: merge(cloudflare, 'cloudflare'),
    resend: merge(resend, 'resend'),
    brevo: merge(brevo, 'brevo'),
    google: merge(google, 'google'),
  };
  _probe.ts = now;
  return _probe.data;
}

app.get('/api/settings', async (req, res) => {
  let probes = {};
  try { probes = await runProbes(); } catch {}
  const or = (name, envOk) => probes[name] || envOk;
  res.json({
    hasAnthropicKey: or('anthropic', !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_key_here')),
    hasGoogleKey:    or('google',    !!process.env.GOOGLE_PLACES_API_KEY),
    hasSmtp:         or('resend',    !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM)),
    hasBrevo:        or('brevo',     !!process.env.BREVO_API_KEY),
    hasSmtpFallback: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    sendStats: getSendStats(),
    hasHunter:       or('hunter',    !!process.env.HUNTER_API_KEY),
    hasCloudflare:   or('cloudflare',!!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN)),
    hasFacebook:     !!(process.env.FB_EMAIL && process.env.FB_PASSWORD),
    resendFrom:      process.env.RESEND_FROM || '',
    probes
  });
});

app.post('/api/settings', (req,res) => {
  const { anthropicKey, resendApiKey, resendFrom, hunterKey, cloudflareAccountId, cloudflareApiToken, fbEmail, fbPassword, brevoApiKey } = req.body;
  const ep = fs.existsSync(path.join(DATA_ROOT,'leads')) ? path.join(DATA_ROOT,'leads','.env') : path.join(__dirname,'.env');
  let env = fs.existsSync(ep)?fs.readFileSync(ep,'utf8'):'';
  const set = (k,v) => {
    if (!v) return;
    v = v.toString().replace(/[\r\n]/g,'').trim();
    env = env.match(new RegExp(`^${k}=`,'m')) ? env.replace(new RegExp(`^${k}=.*`,'m'),`${k}=${v}`) : env+`\n${k}=${v}`;
    process.env[k]=v;
  };
  set('ANTHROPIC_API_KEY',anthropicKey);
  set('RESEND_API_KEY',resendApiKey);
  set('RESEND_FROM',resendFrom);
  set('HUNTER_API_KEY',hunterKey);
  set('CLOUDFLARE_ACCOUNT_ID',cloudflareAccountId);
  set('CLOUDFLARE_API_TOKEN',cloudflareApiToken);
  set('FB_EMAIL',fbEmail);
  set('FB_PASSWORD',fbPassword);
  set('BREVO_API_KEY',brevoApiKey);
  fs.writeFileSync(ep,env.trim());
  res.json({ok:true});
});

// ── DATA RESTORE (import local data to server) ─────────────────────────
app.post('/api/restore', (req,res) => {
  const { leads:ld, outreach:or, replies:rp, tracking:tr, sequences:sq, scheduled:sc } = req.body;
  if (ld && Array.isArray(ld)) { leads = ld; save(LF, leads); }
  if (or && Array.isArray(or)) { outreach = or; save(OF, outreach); }
  if (rp && Array.isArray(rp)) { replies = rp; save(RF, replies); }
  if (tr && Array.isArray(tr)) { tracking = tr; save(TF, tracking); }
  if (sq && Array.isArray(sq)) { sequences = sq; save(SEQ_F, sequences); }
  if (sc && Array.isArray(sc)) { scheduled = sc; save(SCH_F, scheduled); }
  res.json({ ok:true, counts:{ leads:leads.length, outreach:outreach.length, replies:replies.length, tracking:tracking.length } });
});

// ── VOLUME DIAGNOSTIC ───────────────────────────────────────────────────
app.get('/api/debug/volume', (req,res) => {
  const scan = dir => { try { return fs.readdirSync(dir).map(f => { const fp=path.join(dir,f); const s=fs.statSync(fp); return { name:f, size:s.size, isDir:s.isDirectory() }; }); } catch { return []; } };
  res.json({ DATA_ROOT, DATA, files_at_root: scan(DATA_ROOT), files_at_data: scan(DATA), leads_count: leads.length });
});

// ── SEND STATS ENDPOINT ──────────────────────────────────────────────────
app.get('/api/send-stats', (req,res) => {
  res.json(getSendStats());
});

// ── TRACKING DATA ENDPOINT ───────────────────────────────────────────────
app.get('/api/tracking', (req,res) => {
  res.json({ tracking });
});

// ── UNSUBSCRIBED LIST ────────────────────────────────────────────────────
app.get('/api/unsubscribed', (req,res) => {
  res.json({ unsubscribed, count: unsubscribed.length });
});
app.delete('/api/unsubscribed/:email', (req,res) => {
  const lower = decodeURIComponent(req.params.email).toLowerCase();
  unsubscribed = unsubscribed.filter(e => e !== lower);
  unsubscribedSet.delete(lower);
  save(USF, unsubscribed);
  res.json({ ok: true });
});

// ── CRASH SAFETY ─────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error) console.error(reason.stack);
});

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║   AgentForge → localhost:${PORT}   ║`);
  console.log(`  ╚══════════════════════════════════╝\n`);
  console.log(`  Google Places : ${process.env.GOOGLE_PLACES_API_KEY?'✓ Ready':'✗ Missing'}`);
  console.log(`  Anthropic     : ${process.env.ANTHROPIC_API_KEY&&process.env.ANTHROPIC_API_KEY!=='your_anthropic_key_here'?'✓ Ready':'✗ Add in Settings'}`);
  console.log(`  Hunter.io     : ${process.env.HUNTER_API_KEY?'✓ Ready':'✗ Add in Settings'}`);
  console.log(`  Resend Email  : ${process.env.RESEND_API_KEY&&process.env.RESEND_FROM?'✓ Ready ('+process.env.RESEND_FROM+'), 100/day':'✗ Add in Settings'}`);
  console.log(`  Brevo Fallback: ${process.env.BREVO_API_KEY?'✓ Ready, 300/day, kicks in after Resend limit':'✗ Not configured, add via Settings page'}`);
  console.log(`  SMTP Fallback : ${process.env.SMTP_HOST&&process.env.SMTP_USER?'✓ Ready ('+process.env.SMTP_USER+'), last resort':'✗ Not configured'}`);
  console.log(`  Cloudflare    : ${process.env.CLOUDFLARE_ACCOUNT_ID&&process.env.CLOUDFLARE_API_TOKEN?'✓ Ready, sites deploy to pages.dev':'✗ Add in Settings (required for permanent URLs)'}\n`);
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
    console.log(`  ⚠️  WARNING: Resend not configured, outreach emails will fail!`);
    console.log(`     Set RESEND_API_KEY and RESEND_FROM in .env or via Settings.\n`);
  }
});
