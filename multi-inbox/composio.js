// Thin Composio REST client + the ONLY place Gmail tool slugs and argument names live.
// If Composio changes a schema, edit TOOLS below (use /api/diagnostics to compare).
const BASE = process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev/api/v3.1';
const VERSION = process.env.COMPOSIO_TOOLKIT_VERSION || 'latest';

// Strip whitespace/newlines and wrapping quotes that sneak in when a key is pasted into env settings.
const cleanKey = (k) => String(k || '').trim().replace(/^(["'`])(.*)\1$/s, '$2').trim();
const apiKey = () => cleanKey(process.env.COMPOSIO_API_KEY);

async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: { 'x-api-key': apiKey(), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || json?.raw || res.statusText;
    const err = `Composio ${res.status}: ${String(msg).slice(0, 300)}`;
    // Log the real failure (never the key itself, only its length) so it shows in deploy logs.
    console.error(`[composio] ${method} ${url.pathname} -> ${err} (key length ${apiKey().length})`);
    throw new Error(err);
  }
  return json;
}

async function listGmailAccounts() {
  const out = [];
  let cursor;
  do {
    const r = await api('/connected_accounts', {
      query: { toolkit_slugs: ['gmail'], limit: 100, cursor }, // all statuses, so broken connections are visible
    });
    out.push(...(r.items || []));
    cursor = r.next_cursor;
  } while (cursor);
  return out;
}

async function execute(slug, account, args = {}) {
  const r = await api(`/tools/execute/${slug}`, {
    method: 'POST',
    body: {
      connected_account_id: account.id,
      user_id: account.user_id,
      arguments: args,
      version: VERSION,
    },
  });
  if (r.successful === false || r.error) throw new Error(`${slug}: ${r.error?.message || r.error || 'failed'}`);
  const d = r.data || {};
  return d.response_data || d; // some toolkit versions nest the payload
}

const TOOLS = {
  profile: { slug: 'GMAIL_GET_PROFILE', args: () => ({ user_id: 'me' }) },
  sendAs: { slug: 'GMAIL_LIST_SEND_AS', args: () => ({ user_id: 'me' }) },
  fetch: {
    slug: 'GMAIL_FETCH_EMAILS',
    args: ({ labels, limit, pageToken, spam }) => ({
      user_id: 'me', label_ids: labels, max_results: limit, page_token: pageToken || undefined,
      include_spam_trash: !!spam, verbose: true,
    }),
  },
  drafts: {
    slug: 'GMAIL_LIST_DRAFTS',
    args: ({ limit, pageToken }) => ({ user_id: 'me', max_results: limit, page_token: pageToken || undefined, verbose: true }),
  },
  modify: {
    slug: 'GMAIL_ADD_LABEL_TO_EMAIL',
    args: ({ id, add = [], remove = [] }) => ({ user_id: 'me', message_id: id, add_label_ids: add, remove_label_ids: remove }),
  },
  trash: { slug: 'GMAIL_MOVE_TO_TRASH', args: ({ id }) => ({ user_id: 'me', message_id: id }) },
  deleteMsg: { slug: 'GMAIL_DELETE_MESSAGE', args: ({ id }) => ({ user_id: 'me', message_id: id }) },
  deleteDraft: { slug: 'GMAIL_DELETE_DRAFT', args: ({ id }) => ({ user_id: 'me', draft_id: id }) },
  send: {
    slug: 'GMAIL_SEND_EMAIL',
    args: ({ from, to, cc, bcc, subject, body, isHtml }) => ({
      user_id: 'me', recipient_email: to[0], extra_recipients: to.slice(1) || undefined,
      cc: cc?.length ? cc : undefined, bcc: bcc?.length ? bcc : undefined,
      subject, body, is_html: !!isHtml, from_email: from || undefined,
    }),
  },
  reply: {
    slug: 'GMAIL_REPLY_TO_THREAD',
    args: ({ threadId, to, cc, bcc, body, isHtml, from }) => ({
      user_id: 'me', thread_id: threadId, recipient_email: to[0],
      cc: cc?.length ? cc : undefined, bcc: bcc?.length ? bcc : undefined,
      message_body: body, is_html: !!isHtml, from_email: from || undefined,
    }),
  },
  draft: {
    slug: 'GMAIL_CREATE_EMAIL_DRAFT',
    args: ({ to, cc, bcc, subject, body, isHtml, threadId }) => ({
      user_id: 'me', recipient_email: to[0], cc: cc?.length ? cc : undefined, bcc: bcc?.length ? bcc : undefined,
      subject, body, is_html: !!isHtml, thread_id: threadId || undefined,
    }),
  },
};

const run = (tool, account, params = {}) => execute(TOOLS[tool].slug, account, TOOLS[tool].args(params));

async function toolSchema(slug) {
  const r = await api(`/tools/${slug}`, { query: { version: VERSION } });
  return Object.keys(r.input_parameters?.properties || {});
}

module.exports = { listGmailAccounts, run, toolSchema, TOOLS };
