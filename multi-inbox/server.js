const express = require('express');
const crypto = require('crypto');
const path = require('path');
const composio = require('./composio');

if (!process.env.COMPOSIO_API_KEY || !process.env.APP_PASSWORD) {
  console.error('Set COMPOSIO_API_KEY and APP_PASSWORD before starting.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));
const LIMIT = Number(process.env.PER_ACCOUNT_LIMIT || 20);
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(process.env.APP_PASSWORD).digest('hex');

/* ---------- auth: one shared password, signed cookie ---------- */
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
function authed(req) {
  const [exp, sig] = (cookies(req).session || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip, rec = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > 15 * 60e3) { rec.n = 0; rec.t = Date.now(); }
  if (rec.n >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(process.env.APP_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { rec.n++; attempts.set(ip, rec); return res.status(401).json({ error: 'Wrong password.' }); }
  const exp = String(Date.now() + 14 * 864e5);
  res.setHeader('Set-Cookie', `session=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${14 * 86400}${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'session=; Max-Age=0; Path=/'); res.json({ ok: true }); });
app.get('/api/session', (req, res) => res.json({ authed: authed(req) }));
app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Not signed in.' })));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

const AUTH_ERR = /401|403|auth|expired|invalid_grant|revoked|refresh token|not connected|inactive/i;

/* ---------- accounts (auto-discovered from Composio, cached) ---------- */
let acctCache = { at: 0, list: [] };
async function accounts(force) {
  if (!force && Date.now() - acctCache.at < 5 * 60e3 && acctCache.list.length) return acctCache.list;
  const raw = await composio.listGmailAccounts();
  const list = await Promise.all(raw.map(async (a) => {
    const acct = { id: a.id, user_id: a.user_id, email: '', name: '', sendAs: [], error: null, status: a.status || 'ACTIVE', disconnected: false };
    if (acct.status !== 'ACTIVE') {
      acct.disconnected = true;
      acct.error = `Disconnected (${acct.status.toLowerCase()}). Reconnect it in Composio.`;
      acct.label = `Account ${String(a.id).slice(-6)}`;
      return acct;
    }
    try {
      const p = await composio.run('profile', acct);
      acct.email = p.emailAddress || p.email || p.response_data?.emailAddress || '';
    } catch (e) { acct.error = e.message; acct.disconnected = AUTH_ERR.test(e.message); }
    try {
      const s = await composio.run('sendAs', acct);
      acct.sendAs = (s.sendAs || s.send_as || []).map((x) => ({
        email: x.sendAsEmail || x.email, displayName: x.displayName || '', signature: x.signature || '',
        isDefault: !!x.isDefault, isPrimary: !!x.isPrimary, replyTo: x.replyToAddress || '',
      }));
      const def = acct.sendAs.find((x) => x.isDefault) || acct.sendAs.find((x) => x.isPrimary) || acct.sendAs[0];
      acct.name = def?.displayName || '';
      if (!acct.email && def) acct.email = def.email;
    } catch (e) { /* alias list is optional */ }
    if (!acct.sendAs.length && acct.email) acct.sendAs = [{ email: acct.email, displayName: '', signature: '', isDefault: true, isPrimary: true }];
    acct.label = acct.email || a.id;
    return acct;
  }));
  list.sort((x, y) => x.label.localeCompare(y.label));
  acctCache = { at: Date.now(), list };
  return list;
}
const pub = (a) => ({ id: a.id, email: a.email, name: a.name, sendAs: a.sendAs, error: a.error, status: a.status, disconnected: a.disconnected });
const pick = async (id) => { const a = (await accounts()).find((x) => x.id === id); if (!a) throw new Error('Unknown account'); return a; };

app.get('/api/accounts', async (req, res) => {
  try { res.json({ accounts: (await accounts(req.query.refresh === '1')).map(pub) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- normalising messages ---------- */
const stripHtml = (s) => String(s || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function normalize(m, acct, draftId) {
  const labels = m.labelIds || m.label_ids || [];
  const prev = typeof m.preview === 'object' && m.preview ? m.preview.body || '' : m.preview || '';
  const body = m.messageText || m.body || prev || '';
  const ts = m.messageTimestamp || m.date || m.internalDate;
  const when = ts ? (isNaN(ts) ? Date.parse(ts) : Number(ts)) : 0;
  const id = m.messageId || m.id;
  return {
    key: `${acct.id}:${draftId || id}`, accountId: acct.id, accountEmail: acct.email,
    id, draftId: draftId || null, threadId: m.threadId || m.thread_id || null,
    from: m.sender || m.from || '', to: m.to || '', cc: m.cc || '', subject: m.subject || '(no subject)',
    date: when || 0, snippet: stripHtml(prev || body).slice(0, 180), body,
    unread: labels.includes('UNREAD'), labels,
  };
}

/* ---------- combined list ---------- */
app.get('/api/messages', async (req, res) => {
  try {
    const view = req.query.view || 'inbox';
    const want = (req.query.accounts || '').split(',').filter(Boolean);
    const tokens = req.query.tokens ? JSON.parse(req.query.tokens) : {};
    const all = (await accounts()).filter((a) => !want.length || want.includes(a.id));
    const nextTokens = {}, errors = {}, disconnected = [];
    const batches = await Promise.all(all.map(async (acct) => {
      if (acct.disconnected) { errors[acct.id] = acct.error; disconnected.push(acct.id); return []; }
      if (req.query.tokens && !tokens[acct.id]) return [];
      try {
        const pageToken = tokens[acct.id];
        if (view === 'drafts') {
          const r = await composio.run('drafts', acct, { limit: LIMIT, pageToken });
          nextTokens[acct.id] = r.nextPageToken || r.next_page_token || null;
          return (r.drafts || []).map((d) => normalize({ ...(d.message || {}), ...d.message_details }, acct, d.id));
        }
        const spam = view === 'spam';
        const r = await composio.run('fetch', acct, { labels: [spam ? 'SPAM' : 'INBOX'], limit: LIMIT, pageToken, spam });
        nextTokens[acct.id] = r.nextPageToken || r.next_page_token || null;
        return (r.messages || []).map((m) => normalize(m, acct));
      } catch (e) {
        errors[acct.id] = e.message;
        if (AUTH_ERR.test(e.message)) { acct.disconnected = true; acct.error = 'Disconnected. Reconnect it in Composio.'; disconnected.push(acct.id); }
        return [];
      }
    }));
    const messages = batches.flat().sort((a, b) => b.date - a.date);
    res.json({ messages, nextTokens, errors, disconnected });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- bulk actions ---------- */
app.post('/api/action', async (req, res) => {
  const { items = [], action } = req.body;
  const ops = {
    read: (a, i) => composio.run('modify', a, { id: i.id, remove: ['UNREAD'] }),
    unread: (a, i) => composio.run('modify', a, { id: i.id, add: ['UNREAD'] }),
    notspam: (a, i) => composio.run('modify', a, { id: i.id, add: ['INBOX'], remove: ['SPAM'] }),
    trash: (a, i) => composio.run('trash', a, { id: i.id }),
    delete: (a, i) => (i.draftId ? composio.run('deleteDraft', a, { id: i.draftId }) : composio.run('deleteMsg', a, { id: i.id })),
  };
  if (!ops[action]) return res.status(400).json({ error: 'Unknown action' });
  const results = await Promise.all(items.map(async (i) => {
    try { await ops[action](await pick(i.accountId), i); return { key: i.key, ok: true }; }
    catch (e) { return { key: i.key, ok: false, error: e.message }; }
  }));
  res.json({ results });
});

/* ---------- compose / send / save draft ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map((x) => x.trim()).filter(Boolean);
function prepare(p, acct) {
  const alias = acct.sendAs.find((x) => x.email === p.from) || acct.sendAs.find((x) => x.isDefault) || acct.sendAs[0] || {};
  const to = list(p.to);
  if (!to.length) throw new Error('Add at least one recipient.');
  let body = p.body || '', isHtml = false;
  if (p.useSignature !== false && alias.signature) {
    // Gmail stores signatures as HTML, so send as HTML with the body escaped to match plain text.
    body = `<div>${esc(body).replace(/\n/g, '<br>')}</div><br><div>-- <br>${alias.signature}</div>`;
    isHtml = true;
  }
  const primary = acct.sendAs.find((x) => x.isPrimary)?.email || acct.email;
  return { alias, to, cc: list(p.cc), bcc: list(p.bcc), subject: p.subject || '', body, isHtml,
    from: alias.email && alias.email !== primary ? alias.email : undefined, threadId: p.threadId };
}
app.post('/api/send', async (req, res) => {
  try {
    const acct = await pick(req.body.accountId);
    const m = prepare(req.body, acct);
    const out = m.threadId ? await composio.run('reply', acct, m) : await composio.run('send', acct, m);
    if (req.body.draftId) { try { await composio.run('deleteDraft', acct, { id: req.body.draftId }); } catch {} }
    res.json({ ok: true, sentAs: m.alias.displayName ? `${m.alias.displayName} <${m.alias.email}>` : m.alias.email, result: out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/draft', async (req, res) => {
  try {
    const acct = await pick(req.body.accountId);
    const m = prepare({ ...req.body, to: req.body.to || acct.email }, acct);
    await composio.run('draft', acct, m);
    if (req.body.draftId) { try { await composio.run('deleteDraft', acct, { id: req.body.draftId }); } catch {} }
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- diagnostics: compare our argument names against Composio's live schemas ---------- */
app.get('/api/diagnostics', async (req, res) => {
  const out = {};
  await Promise.all(Object.entries(composio.TOOLS).map(async ([k, t]) => {
    try {
      const live = await composio.toolSchema(t.slug);
      const sample = composio.TOOLS[k].args({ id: 'x', labels: [], to: ['a@b.c'], cc: ['x'], bcc: ['x'], threadId: 't', from: 'f', add: ['x'], remove: ['x'], limit: 1, pageToken: 'p', spam: true, subject: 's', body: 'b' });
      const used = Object.keys(sample);
      out[k] = { slug: t.slug, unknownArgs: used.filter((u) => !live.includes(u)), available: live };
    } catch (e) { out[k] = { slug: t.slug, error: e.message }; }
  }));
  res.json(out);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Multi-inbox running on :${port}`));
