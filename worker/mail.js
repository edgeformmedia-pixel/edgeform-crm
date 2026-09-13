import { json, HttpError, clean, now, readJson, randomToken, isEmail, timingSafeEqual } from './lib.js';
import { requireUser } from './auth.js';

// Shared mailboxes. Everyone gets team@ and inquiries@; admin@ is the master admin's alone.
const BOXES = {
  team: { key: 'team', local: 'team', label: 'Team Inbox', ownerOnly: false },
  inquiries: { key: 'inquiries', local: 'inquiries', label: 'Inquiries Inbox', ownerOnly: false },
  admin: { key: 'admin', local: 'admin', label: 'Admin Inbox', ownerOnly: true }
};
// Mail to any other @domain address (typos, old aliases) lands here.
const CATCH_ALL_BOX = 'admin';

const FOLDERS = ['inbox', 'archive', 'spam', 'trash'];
const MAX_RECIPIENTS = 50;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_SEND_BYTES = 30 * 1024 * 1024;
const MAX_INLINE_BODY = 900000;
const TRASH_DAYS = 30;
const PAGE_SIZE = 50;

const RESEND_API = 'https://api.resend.com';

// ─── Access ───────────────────────────────────────────────────

const ownerEmail = (env) => (env.MAIL_OWNER_EMAIL || 'edgeformmedia@gmail.com').toLowerCase();
const canAccess = (env, user, box) => !box.ownerOnly || String(user.email).toLowerCase() === ownerEmail(env);
const boxAddress = (env, box) => `${box.local}@${env.MAIL_DOMAIN}`;

async function requireBox(request, env, key) {
  const user = await requireUser(request, env);
  const box = BOXES[key];
  if (!box) throw new HttpError(404, 'Unknown mailbox.');
  if (!canAccess(env, user, box)) throw new HttpError(403, "You don't have access to this mailbox.");
  return { user, box };
}

async function loadThread(env, box, id) {
  const thread = await env.DB.prepare('SELECT * FROM mail_threads WHERE id = ? AND mailbox = ?').bind(clean(id, 64), box.key).first();
  if (!thread) throw new HttpError(404, 'Conversation not found.');
  return thread;
}

// ─── Address + text helpers ───────────────────────────────────

export function parseAddress(value) {
  const raw = String(value || '').trim();
  const angle = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (angle) return { name: angle[1].trim(), email: angle[2].trim().toLowerCase() };
  return { name: '', email: raw.replace(/^mailto:/i, '').toLowerCase() };
}

// Accepts an array or a comma/semicolon separated string; commas inside quotes are kept.
function parseList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/);
  return items.map(v => parseAddress(typeof v === 'object' && v ? `${v.name || ''} <${v.email}>` : v)).filter(a => a.email);
}

const formatAddress = (a) => a.name ? `"${a.name.replace(/["\\]/g, '')}" <${a.email}>` : a.email;
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseJson = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

export function subjectKey(subject) {
  return String(subject || '').replace(/^\s*((re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
const isReplySubject = (subject) => /^\s*(re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:/i.test(String(subject || ''));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const makeSnippet = (text) => String(text || '').replace(/^>.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 200);

// Defense in depth: the CRM renders email HTML in a script-less sandbox, but strip the obvious
// active content before it is stored or sent.
export function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<(script|iframe|object|applet|frameset)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|applet|frameset|frame|form|meta|link|base|input|button|textarea|select)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'>\s]*\2/gi, '$1="#"');
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// ─── Signature ────────────────────────────────────────────────

function brand(env) {
  const digits = String(env.MAIL_PHONE || '5862246692').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return {
    company: env.MAIL_COMPANY || 'Edgeform Marketing Group',
    address: env.MAIL_ADDRESS || '55 NE 2nd St, Miami, FL 33132',
    phoneDigits: digits,
    phoneDisplay: digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : digits,
    website: env.MAIL_WEBSITE || `https://${env.MAIL_DOMAIN}`,
    logo: env.MAIL_LOGO_URL || `${env.APP_URL}/assets/efmg-logo.png`,
    instagram: env.MAIL_INSTAGRAM_URL || '',
    instagramIcon: `${env.APP_URL}/assets/instagram-black.png`
  };
}

export function signatureHtml(env, { name, title, box }) {
  const b = brand(env);
  const address = boxAddress(env, box);
  const link = 'color:#0e1a3b;text-decoration:none;font-weight:bold;';
  const maps = `https://maps.google.com/?q=${encodeURIComponent(b.address)}`;
  return `<table class="edgeform-signature" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:22px;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">
<tr>
<td style="padding:0 0 10px 0;">
<div style="font-size:15px;line-height:20px;font-weight:bold;color:#0e1a3b;">${escapeHtml(name)}</div>
${title ? `<div style="font-size:12px;line-height:17px;color:#55605b;">${escapeHtml(title)}</div>` : ''}
</td>
</tr>
<tr>
<td style="padding:0 0 10px 0;"><img src="${escapeHtml(b.logo)}" width="260" height="35" alt="${escapeHtml(b.company)}" style="display:block;width:260px;max-width:260px;height:auto;border:0;"></td>
</tr>
<tr>
<td style="font-size:12px;line-height:19px;color:#43504b;border-top:1px solid #d7dbe3;padding-top:8px;">
Call or text: <a href="tel:+1${b.phoneDigits}" style="${link}">${escapeHtml(b.phoneDisplay)}</a><br>
<a href="mailto:${address}" style="${link}">${address}</a> &nbsp;|&nbsp; <a href="${escapeHtml(b.website)}" style="${link}">${escapeHtml(b.website.replace(/^https?:\/\//, ''))}</a><br>
<a href="${maps}" style="color:#43504b;text-decoration:none;">${escapeHtml(b.address)}</a>
</td>
</tr>
${b.instagram ? `<tr>
<td style="padding-top:10px;"><a href="${escapeHtml(b.instagram)}" style="text-decoration:none;display:inline-block;"><img src="${escapeHtml(b.instagramIcon)}" width="22" height="22" alt="Instagram" style="display:block;width:22px;height:22px;border:0;"></a></td>
</tr>` : ''}
</table>`;
}

// Signature goes above the quoted conversation when there is one.
function withSignature(html, signature) {
  const marker = html.search(/<(div|blockquote)[^>]*class="edgeform-quote"/i);
  if (marker === -1) return `${html}${signature}`;
  return `${html.slice(0, marker)}${signature}<br>${html.slice(marker)}`;
}

async function userTitle(env, userId) {
  const row = await env.DB.prepare('SELECT title FROM mail_settings WHERE user_id = ?').bind(userId).first();
  return row?.title || '';
}

// ─── Resend ───────────────────────────────────────────────────

async function resend(env, path, init = {}) {
  if (!env.RESEND_API_KEY) throw new HttpError(503, 'Email is not connected yet. Add the RESEND_API_KEY secret.');
  const res = await fetch((env.RESEND_API_BASE || RESEND_API) + path, {
    ...init,
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', ...(init.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new HttpError(502, `Email provider error: ${data.message || data.error || res.status}`);
    error.providerStatus = res.status;
    throw error;
  }
  return data;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (Array.isArray(headers)) {
    const hit = headers.find(h => String(h.name || h.key || '').toLowerCase() === name);
    return hit ? String(hit.value ?? '') : '';
  }
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  const value = key ? headers[key] : '';
  return Array.isArray(value) ? value.join(' ') : String(value ?? '');
}

// ─── Threads: list / read / update ────────────────────────────

function folderClause(folder, userId) {
  switch (folder) {
    case 'inbox': return ["t.folder = 'inbox' AND t.has_inbound = 1", []];
    case 'unread': return ["t.folder = 'inbox' AND t.unread = 1", []];
    case 'sent': return ["t.has_outbound = 1 AND t.folder NOT IN ('trash','spam')", []];
    case 'starred': return ["t.starred = 1 AND t.folder NOT IN ('trash','spam')", []];
    case 'assigned': return ["t.assigned_to = ? AND t.folder NOT IN ('trash','spam')", [userId]];
    case 'scheduled': return ["EXISTS (SELECT 1 FROM mail_messages s WHERE s.thread_id = t.id AND s.status = 'scheduled')", []];
    case 'archive': case 'spam': case 'trash': return ['t.folder = ?', [folder]];
    case 'all': return ["t.folder NOT IN ('trash','spam')", []];
    default: throw new HttpError(400, 'Unknown folder.');
  }
}

async function listThreads(request, env, headers, [boxKey]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const url = new URL(request.url);
  const folder = url.searchParams.get('folder') || 'inbox';
  const q = clean(url.searchParams.get('q'), 200);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const [where, binds] = folderClause(folder, user.id);
  let search = '';
  const searchBinds = [];
  if (q) {
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
    search = ` AND (t.subject LIKE ? ESCAPE '\\' OR t.participants LIKE ? ESCAPE '\\' OR t.display_from LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id AND (m.text LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')))`;
    searchBinds.push(like, like, like, like, like);
  }
  const rows = await env.DB.prepare(
    `SELECT t.*, u.name AS assigned_name FROM mail_threads t LEFT JOIN users u ON u.id = t.assigned_to
     WHERE t.mailbox = ? AND ${where}${search} ORDER BY t.last_message_at DESC LIMIT ? OFFSET ?`
  ).bind(box.key, ...binds, ...searchBinds, PAGE_SIZE + 1, offset).all();
  const threads = rows.results.slice(0, PAGE_SIZE);
  return json({ ok: true, threads, hasMore: rows.results.length > PAGE_SIZE, offset }, 200, headers);
}

async function counts(request, env, headers, [boxKey]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const [folders, drafts, scheduled] = await env.DB.batch([
    env.DB.prepare(`SELECT
        SUM(CASE WHEN folder = 'inbox' AND has_inbound = 1 AND unread = 1 THEN 1 ELSE 0 END) inbox,
        SUM(CASE WHEN folder = 'spam' AND unread = 1 THEN 1 ELSE 0 END) spam,
        SUM(CASE WHEN assigned_to = ? AND unread = 1 AND folder NOT IN ('trash','spam') THEN 1 ELSE 0 END) assigned,
        SUM(CASE WHEN starred = 1 AND folder NOT IN ('trash','spam') THEN 1 ELSE 0 END) starred
      FROM mail_threads WHERE mailbox = ?`).bind(user.id, box.key),
    env.DB.prepare('SELECT COUNT(*) n FROM mail_drafts WHERE mailbox = ? AND user_id = ?').bind(box.key, user.id),
    env.DB.prepare("SELECT COUNT(*) n FROM mail_messages WHERE mailbox = ? AND status = 'scheduled'").bind(box.key)
  ]);
  const f = folders.results[0] || {};
  return json({
    ok: true,
    counts: { inbox: f.inbox || 0, spam: f.spam || 0, assigned: f.assigned || 0, starred: f.starred || 0, drafts: drafts.results[0].n, scheduled: scheduled.results[0].n }
  }, 200, headers);
}

const attachmentView = (a) => ({
  id: a.id, filename: a.filename, contentType: a.content_type, size: a.size, inline: !!a.inline, contentId: a.content_id,
  url: `/api/mail/files/${a.id}?t=${a.access_token}`
});

async function messageBody(env, m) {
  if (!m.body_key) return m.html;
  const object = await env.MAIL_FILES.get(m.body_key);
  return object ? await object.text() : '';
}

async function getThread(request, env, headers, [boxKey, id]) {
  const { box } = await requireBox(request, env, boxKey);
  const thread = await loadThread(env, box, id);
  const [messages, attachments, notes] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM mail_messages WHERE thread_id = ? AND status != 'canceled' ORDER BY created_at ASC").bind(thread.id),
    env.DB.prepare('SELECT a.* FROM mail_attachments a JOIN mail_messages m ON m.id = a.message_id WHERE m.thread_id = ? ORDER BY a.created_at').bind(thread.id),
    env.DB.prepare('SELECT * FROM mail_notes WHERE thread_id = ? ORDER BY created_at ASC').bind(thread.id)
  ]);
  const byMessage = {};
  for (const a of attachments.results) (byMessage[a.message_id] ||= []).push(attachmentView(a));
  const list = await Promise.all(messages.results.map(async m => ({
    id: m.id, direction: m.direction, status: m.status, error: m.error,
    from: { name: m.from_name, email: m.from_addr }, to: parseJson(m.to_json, []), cc: parseJson(m.cc_json, []), bcc: parseJson(m.bcc_json, []),
    replyTo: m.reply_to, subject: m.subject, html: await messageBody(env, m), text: m.text, messageId: m.message_id,
    sentBy: m.sent_by_name, scheduledAt: m.scheduled_at, createdAt: m.created_at, attachments: byMessage[m.id] || []
  })));

  if (thread.unread && request.method === 'GET' && new URL(request.url).searchParams.get('peek') !== '1') {
    await env.DB.prepare('UPDATE mail_threads SET unread = 0 WHERE id = ?').bind(thread.id).run();
    thread.unread = 0;
  }

  // Match the counterparties against CRM inquiries so staff see who they're talking to.
  const emails = thread.participants.split(',').filter(Boolean).slice(0, 10);
  let crm = [];
  if (emails.length) {
    const marks = emails.map(() => '?').join(',');
    crm = (await env.DB.prepare(
      `SELECT id, name, email, phone, company, inquiry_label, inquiry_type, stage, created_at FROM submissions
       WHERE lower(email) IN (${marks}) ORDER BY created_at DESC LIMIT 5`
    ).bind(...emails).all().catch(() => ({ results: [] }))).results;
  }
  const assigned = thread.assigned_to ? await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(thread.assigned_to).first() : null;
  return json({ ok: true, thread: { ...thread, assigned_name: assigned?.name || null }, messages: list, notes: notes.results, crm }, 200, headers);
}

async function blockSenders(env, box, threadIds, block) {
  if (!threadIds.length) return;
  const marks = threadIds.map(() => '?').join(',');
  const senders = await env.DB.prepare(
    `SELECT DISTINCT from_addr FROM mail_messages WHERE mailbox = ? AND direction = 'in' AND thread_id IN (${marks})`
  ).bind(box.key, ...threadIds).all();
  const stmts = senders.results.filter(r => r.from_addr).map(r => block
    ? env.DB.prepare('INSERT OR IGNORE INTO mail_blocked (mailbox, address, created_at) VALUES (?, ?, ?)').bind(box.key, r.from_addr, now())
    : env.DB.prepare('DELETE FROM mail_blocked WHERE mailbox = ? AND address = ?').bind(box.key, r.from_addr));
  if (stmts.length) await env.DB.batch(stmts);
}

async function deleteThreadsForever(env, box, ids) {
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(',');
  const [files, bodies] = await env.DB.batch([
    env.DB.prepare(`SELECT a.r2_key FROM mail_attachments a JOIN mail_messages m ON m.id = a.message_id WHERE m.mailbox = ? AND m.thread_id IN (${marks})`).bind(box.key, ...ids),
    env.DB.prepare(`SELECT body_key FROM mail_messages WHERE mailbox = ? AND body_key IS NOT NULL AND thread_id IN (${marks})`).bind(box.key, ...ids)
  ]);
  const keys = [...files.results.map(r => r.r2_key), ...bodies.results.map(r => r.body_key)];
  for (let i = 0; i < keys.length; i += 500) await env.MAIL_FILES.delete(keys.slice(i, i + 500));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM mail_attachments WHERE message_id IN (SELECT id FROM mail_messages WHERE mailbox = ? AND thread_id IN (${marks}))`).bind(box.key, ...ids),
    env.DB.prepare(`DELETE FROM mail_notes WHERE thread_id IN (${marks})`).bind(...ids),
    env.DB.prepare(`DELETE FROM mail_messages WHERE mailbox = ? AND thread_id IN (${marks})`).bind(box.key, ...ids),
    env.DB.prepare(`DELETE FROM mail_threads WHERE mailbox = ? AND id IN (${marks})`).bind(box.key, ...ids)
  ]);
}

const BULK_ACTIONS = {
  read: ['unread = 0'], unread: ['unread = 1'], star: ['starred = 1'], unstar: ['starred = 0'],
  archive: ["folder = 'archive'"], inbox: ["folder = 'inbox'"], trash: ["folder = 'trash'"],
  spam: ["folder = 'spam'"], notspam: ["folder = 'inbox'"]
};

async function bulkUpdate(request, env, headers, [boxKey]) {
  const { box } = await requireBox(request, env, boxKey);
  const body = await readJson(request);
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(id => clean(id, 64)).filter(Boolean))].slice(0, 500);
  const action = String(body.action || '');
  if (!ids.length) throw new HttpError(400, 'Select at least one conversation.');
  if (action === 'delete') {
    // Only conversations already in Trash or Spam can be deleted for good.
    const marks = ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT id FROM mail_threads WHERE mailbox = ? AND folder IN ('trash','spam') AND id IN (${marks})`).bind(box.key, ...ids).all();
    await deleteThreadsForever(env, box, rows.results.map(r => r.id));
    return json({ ok: true, deleted: rows.results.length }, 200, headers);
  }
  const set = BULK_ACTIONS[action];
  if (!set) throw new HttpError(400, 'Unknown action.');
  if (action === 'spam' || action === 'notspam') await blockSenders(env, box, ids, action === 'spam');
  const stmts = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    stmts.push(env.DB.prepare(`UPDATE mail_threads SET ${set.join(', ')} WHERE mailbox = ? AND id IN (${chunk.map(() => '?').join(',')})`).bind(box.key, ...chunk));
  }
  await env.DB.batch(stmts);
  return json({ ok: true }, 200, headers);
}

async function updateThread(request, env, headers, [boxKey, id]) {
  const { box } = await requireBox(request, env, boxKey);
  const thread = await loadThread(env, box, id);
  const body = await readJson(request);
  const sets = [];
  const binds = [];
  if ('unread' in body) { sets.push('unread = ?'); binds.push(body.unread ? 1 : 0); }
  if ('starred' in body) { sets.push('starred = ?'); binds.push(body.starred ? 1 : 0); }
  if ('folder' in body) {
    if (!FOLDERS.includes(body.folder)) throw new HttpError(400, 'Unknown folder.');
    if (body.folder === 'spam' || (thread.folder === 'spam' && body.folder !== 'spam')) await blockSenders(env, box, [thread.id], body.folder === 'spam');
    sets.push('folder = ?'); binds.push(body.folder);
  }
  if ('assignedTo' in body) {
    const assignee = body.assignedTo ? await env.DB.prepare('SELECT id FROM users WHERE id = ? AND verified = 1').bind(clean(body.assignedTo, 64)).first() : null;
    if (body.assignedTo && !assignee) throw new HttpError(400, 'That teammate was not found.');
    sets.push('assigned_to = ?'); binds.push(assignee?.id || null);
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  await env.DB.prepare(`UPDATE mail_threads SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, thread.id).run();
  return json({ ok: true }, 200, headers);
}

async function emptyFolder(request, env, headers, [boxKey, folder]) {
  const { box } = await requireBox(request, env, boxKey);
  if (!['trash', 'spam'].includes(folder)) throw new HttpError(400, 'Only Trash and Spam can be emptied.');
  const rows = await env.DB.prepare('SELECT id FROM mail_threads WHERE mailbox = ? AND folder = ? LIMIT 2000').bind(box.key, folder).all();
  const ids = rows.results.map(r => r.id);
  for (let i = 0; i < ids.length; i += 90) await deleteThreadsForever(env, box, ids.slice(i, i + 90));
  return json({ ok: true, deleted: ids.length }, 200, headers);
}

async function addNote(request, env, headers, [boxKey, id]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const thread = await loadThread(env, box, id);
  const text = clean((await readJson(request)).body, 5000);
  if (!text) throw new HttpError(400, 'Write a note first.');
  const note = { id: crypto.randomUUID(), thread_id: thread.id, user_id: user.id, user_name: user.name, body: text, created_at: now() };
  await env.DB.prepare('INSERT INTO mail_notes (id, thread_id, user_id, user_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(note.id, note.thread_id, note.user_id, note.user_name, note.body, note.created_at).run();
  return json({ ok: true, note }, 201, headers);
}

async function deleteNote(request, env, headers, [boxKey, id, noteId]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const thread = await loadThread(env, box, id);
  const result = await env.DB.prepare('DELETE FROM mail_notes WHERE id = ? AND thread_id = ? AND user_id = ?').bind(clean(noteId, 64), thread.id, user.id).run();
  if (!result.meta.changes) throw new HttpError(404, 'You can only delete your own notes.');
  return json({ ok: true }, 200, headers);
}

// ─── Compose: drafts, uploads, send ───────────────────────────

function recipientsFrom(body) {
  const to = parseList(body.to);
  const cc = parseList(body.cc);
  const bcc = parseList(body.bcc);
  for (const a of [...to, ...cc, ...bcc]) if (!isEmail(a.email)) throw new HttpError(400, `"${a.email}" isn't a valid email address.`);
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new HttpError(400, `You can send to at most ${MAX_RECIPIENTS} people at once.`);
  return { to, cc, bcc };
}

const draftView = (d, attachments = []) => ({
  id: d.id, mailbox: d.mailbox, threadId: d.thread_id, mode: d.mode, to: parseJson(d.to_json, []), cc: parseJson(d.cc_json, []),
  bcc: parseJson(d.bcc_json, []), subject: d.subject, html: d.html, updatedAt: d.updated_at, attachments
});

async function listDrafts(request, env, headers, [boxKey]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const [drafts, files] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM mail_drafts WHERE mailbox = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 200').bind(box.key, user.id),
    env.DB.prepare('SELECT a.* FROM mail_attachments a JOIN mail_drafts d ON d.id = a.draft_id WHERE d.mailbox = ? AND d.user_id = ? AND a.message_id IS NULL').bind(box.key, user.id)
  ]);
  const byDraft = {};
  for (const a of files.results) (byDraft[a.draft_id] ||= []).push(attachmentView(a));
  return json({ ok: true, drafts: drafts.results.map(d => draftView(d, byDraft[d.id] || [])) }, 200, headers);
}

async function saveDraft(request, env, headers, [boxKey]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const body = await readJson(request);
  const to = parseList(body.to).slice(0, MAX_RECIPIENTS);
  const cc = parseList(body.cc).slice(0, MAX_RECIPIENTS);
  const bcc = parseList(body.bcc).slice(0, MAX_RECIPIENTS);
  const html = sanitizeHtml(clean(body.html, 1500000));
  const subject = clean(body.subject, 300);
  const mode = ['new', 'reply', 'reply_all', 'forward'].includes(body.mode) ? body.mode : 'new';
  const threadId = body.threadId ? (await loadThread(env, box, body.threadId)).id : null;
  const id = clean(body.id, 64);
  if (id) {
    const result = await env.DB.prepare(
      `UPDATE mail_drafts SET to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, html = ?, mode = ?, thread_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND mailbox = ?`
    ).bind(JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, html, mode, threadId, now(), id, user.id, box.key).run();
    if (result.meta.changes) return json({ ok: true, id }, 200, headers);
  }
  const draftId = id && /^[\w-]{8,64}$/.test(id) ? id : crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO mail_drafts (id, mailbox, user_id, thread_id, mode, to_json, cc_json, bcc_json, subject, html, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(draftId, box.key, user.id, threadId, mode, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, html, now(), now()).run();
  return json({ ok: true, id: draftId }, 201, headers);
}

async function deleteDraft(request, env, headers, [boxKey, id]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const draft = await env.DB.prepare('SELECT id FROM mail_drafts WHERE id = ? AND user_id = ? AND mailbox = ?').bind(clean(id, 64), user.id, box.key).first();
  if (!draft) throw new HttpError(404, 'Draft not found.');
  await discardDraft(env, draft.id, true);
  return json({ ok: true }, 200, headers);
}

async function discardDraft(env, draftId, removeFiles) {
  if (removeFiles) {
    const files = await env.DB.prepare('SELECT r2_key FROM mail_attachments WHERE draft_id = ? AND message_id IS NULL').bind(draftId).all();
    if (files.results.length) await env.MAIL_FILES.delete(files.results.map(f => f.r2_key));
    await env.DB.prepare('DELETE FROM mail_attachments WHERE draft_id = ? AND message_id IS NULL').bind(draftId).run();
  }
  await env.DB.prepare('DELETE FROM mail_drafts WHERE id = ?').bind(draftId).run();
}

async function upload(request, env, headers, [boxKey]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const url = new URL(request.url);
  const filename = clean(url.searchParams.get('filename'), 200).replace(/[\\/\r\n"]/g, '_') || 'attachment';
  const draftId = clean(url.searchParams.get('draftId'), 64) || null;
  const inline = url.searchParams.get('inline') === '1';
  const type = clean((request.headers.get('content-type') || 'application/octet-stream').split(';')[0], 100);
  if (Number(request.headers.get('content-length') || 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Each file must be 20MB or smaller.');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new HttpError(400, 'That file is empty.');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Each file must be 20MB or smaller.');
  const row = {
    id: crypto.randomUUID(), mailbox: box.key, draft_id: draftId, filename, content_type: type, size: bytes.byteLength,
    content_id: inline ? `img-${randomToken(8)}` : null, inline: inline ? 1 : 0, access_token: randomToken(24), created_at: now()
  };
  row.r2_key = `mail/${box.key}/uploads/${row.id}`;
  await env.MAIL_FILES.put(row.r2_key, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare(
    `INSERT INTO mail_attachments (id, mailbox, draft_id, filename, content_type, size, content_id, inline, r2_key, access_token, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, row.mailbox, row.draft_id, row.filename, row.content_type, row.size, row.content_id, row.inline, row.r2_key, row.access_token, user.id, row.created_at).run();
  return json({ ok: true, attachment: attachmentView(row) }, 201, headers);
}

// Forwarding: copies a received or sent message's attachments into fresh draft uploads.
async function copyAttachments(request, env, headers, [boxKey]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const body = await readJson(request);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(v => clean(v, 64)).filter(Boolean).slice(0, 50);
  const draftId = clean(body.draftId, 64) || null;
  if (!ids.length) return json({ ok: true, attachments: [] }, 200, headers);
  const marks = ids.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT a.* FROM mail_attachments a JOIN mail_messages m ON m.id = a.message_id WHERE m.mailbox = ? AND a.id IN (${marks})`
  ).bind(box.key, ...ids).all()).results;
  const copies = [];
  for (const source of rows) {
    const object = await env.MAIL_FILES.get(source.r2_key);
    if (!object) continue;
    const row = {
      ...source, id: crypto.randomUUID(), draft_id: draftId, message_id: null, inline: 0, content_id: null,
      access_token: randomToken(24), created_at: now()
    };
    row.r2_key = `mail/${box.key}/uploads/${row.id}`;
    await env.MAIL_FILES.put(row.r2_key, await object.arrayBuffer(), { httpMetadata: { contentType: row.content_type } });
    await env.DB.prepare(
      `INSERT INTO mail_attachments (id, mailbox, draft_id, filename, content_type, size, content_id, inline, r2_key, access_token, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)`
    ).bind(row.id, box.key, row.draft_id, row.filename, row.content_type, row.size, row.r2_key, row.access_token, user.id, row.created_at).run();
    copies.push(attachmentView(row));
  }
  return json({ ok: true, attachments: copies }, 201, headers);
}

async function deleteUpload(request, env, headers, [boxKey, id]) {
  const { box } = await requireBox(request, env, boxKey);
  const row = await env.DB.prepare('SELECT * FROM mail_attachments WHERE id = ? AND mailbox = ? AND message_id IS NULL').bind(clean(id, 64), box.key).first();
  if (!row) throw new HttpError(404, 'Attachment not found.');
  await env.MAIL_FILES.delete(row.r2_key);
  await env.DB.prepare('DELETE FROM mail_attachments WHERE id = ?').bind(row.id).run();
  return json({ ok: true }, 200, headers);
}

// Serves attachments and inline images. The per-file token lets <img> tags load without a bearer header.
async function serveFile(request, env, headers, [id]) {
  const url = new URL(request.url);
  const row = await env.DB.prepare('SELECT * FROM mail_attachments WHERE id = ?').bind(clean(id, 64)).first();
  if (!row || !timingSafeEqual(String(url.searchParams.get('t') || ''), row.access_token)) return new Response('Not found', { status: 404, headers });
  const object = await env.MAIL_FILES.get(row.r2_key);
  if (!object) return new Response('Not found', { status: 404, headers });
  const risky = /html|svg|xml|javascript/i.test(row.content_type);
  const disposition = url.searchParams.get('download') === '1' || risky ? 'attachment' : 'inline';
  return new Response(object.body, {
    headers: {
      ...headers,
      'content-type': risky ? 'application/octet-stream' : row.content_type,
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'content-security-policy': 'sandbox; default-src none',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=86400'
    }
  });
}

function mergeParticipants(existing, addresses, env) {
  const set = new Set(String(existing || '').split(',').filter(Boolean));
  for (const a of addresses) {
    const email = String(a.email || '').toLowerCase();
    if (email && !email.endsWith(`@${env.MAIL_DOMAIN}`)) set.add(email);
  }
  return [...set].slice(0, 30).join(',');
}

async function sendMessage(request, env, headers, [boxKey]) {
  const { user, box } = await requireBox(request, env, boxKey);
  if (!env.RESEND_API_KEY) throw new HttpError(503, 'Email is not connected yet. Ask the admin to add the Resend API key.');
  const body = await readJson(request);
  const { to, cc, bcc } = recipientsFrom(body);
  if (!to.length && !cc.length && !bcc.length) throw new HttpError(400, 'Add at least one recipient.');
  const subject = clean(body.subject, 300);
  if (!subject) throw new HttpError(400, 'Add a subject.');
  const composeHtml = sanitizeHtml(clean(body.html, 1500000));
  if (!htmlToText(composeHtml) && !(body.attachmentIds || []).length && !/<img/i.test(composeHtml)) throw new HttpError(400, 'Write a message first.');

  let scheduledAt = null;
  if (body.scheduledAt) {
    const when = new Date(body.scheduledAt);
    if (Number.isNaN(when.getTime())) throw new HttpError(400, 'Pick a valid send time.');
    if (when.getTime() > Date.now() + 60000) scheduledAt = when.toISOString();
  }

  const thread = body.threadId ? await loadThread(env, box, body.threadId) : null;
  const attachmentIds = (Array.isArray(body.attachmentIds) ? body.attachmentIds : []).map(v => clean(v, 64)).filter(Boolean).slice(0, 50);
  let files = [];
  if (attachmentIds.length) {
    const marks = attachmentIds.map(() => '?').join(',');
    files = (await env.DB.prepare(`SELECT * FROM mail_attachments WHERE mailbox = ? AND message_id IS NULL AND id IN (${marks})`).bind(box.key, ...attachmentIds).all()).results;
  }
  if (files.reduce((n, f) => n + f.size, 0) > MAX_SEND_BYTES) throw new HttpError(413, 'Attachments add up to more than 30MB. Remove some or share a link instead.');

  const title = await userTitle(env, user.id);
  const html = withSignature(composeHtml, signatureHtml(env, { name: user.name, title, box }));
  const text = htmlToText(html);

  let parent = null;
  if (thread) {
    parent = await env.DB.prepare(
      `SELECT message_id, references_hdr FROM mail_messages WHERE thread_id = ? AND message_id IS NOT NULL AND message_id != ''
       ORDER BY created_at DESC LIMIT 1`
    ).bind(thread.id).first();
  }
  const references = parent ? [parent.references_hdr, parent.message_id].filter(Boolean).join(' ').split(/\s+/).slice(-20).join(' ') : null;

  const created = now();
  const messageRowId = crypto.randomUUID();
  const threadId = thread?.id || crypto.randomUUID();
  const allRecipients = [...to, ...cc, ...bcc];
  const displayTo = `To: ${to.concat(cc)[0]?.name || to.concat(cc)[0]?.email || bcc[0]?.email || ''}`;
  const snippet = makeSnippet(htmlToText(composeHtml));
  const bodyTooBig = html.length > MAX_INLINE_BODY;
  const bodyKey = bodyTooBig ? `mail/${box.key}/bodies/${messageRowId}.html` : null;
  if (bodyTooBig) await env.MAIL_FILES.put(bodyKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });

  const stmts = [];
  if (thread) {
    stmts.push(env.DB.prepare(
      `UPDATE mail_threads SET snippet = ?, participants = ?, has_outbound = 1, message_count = message_count + 1, last_message_at = ?,
         folder = CASE WHEN folder IN ('trash','spam') THEN 'inbox' ELSE folder END,
         display_from = CASE WHEN has_inbound = 1 THEN display_from ELSE ? END,
         has_attachments = CASE WHEN ? THEN 1 ELSE has_attachments END
       WHERE id = ?`
    ).bind(snippet, mergeParticipants(thread.participants, allRecipients, env), created, displayTo, files.length ? 1 : 0, thread.id));
  } else {
    stmts.push(env.DB.prepare(
      `INSERT INTO mail_threads (id, mailbox, subject, subject_key, snippet, participants, display_from, folder, unread, has_outbound, has_attachments, message_count, last_message_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'inbox', 0, 1, ?, 1, ?, ?)`
    ).bind(threadId, box.key, subject, subjectKey(subject), snippet, mergeParticipants('', allRecipients, env), displayTo, files.length ? 1 : 0, created, created));
  }
  stmts.push(env.DB.prepare(
    `INSERT INTO mail_messages (id, thread_id, mailbox, direction, status, in_reply_to, references_hdr, from_addr, from_name, to_json, cc_json, bcc_json,
       reply_to, subject, html, body_key, compose_html, text, snippet, sent_by, sent_by_name, scheduled_at, created_at)
     VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    messageRowId, threadId, box.key, scheduledAt ? 'scheduled' : 'sending', parent?.message_id || null, references,
    boxAddress(env, box), user.name, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), boxAddress(env, box), subject,
    bodyTooBig ? '' : html, bodyKey, composeHtml.length > MAX_INLINE_BODY ? '' : composeHtml, text.slice(0, 100000), snippet, user.id, user.name, scheduledAt, scheduledAt || created
  ));
  for (const f of files) stmts.push(env.DB.prepare('UPDATE mail_attachments SET message_id = ?, draft_id = NULL WHERE id = ?').bind(messageRowId, f.id));
  if (body.draftId) stmts.push(env.DB.prepare('DELETE FROM mail_drafts WHERE id = ? AND user_id = ?').bind(clean(body.draftId, 64), user.id));
  await env.DB.batch(stmts);

  if (scheduledAt) return json({ ok: true, id: messageRowId, threadId, status: 'scheduled', scheduledAt }, 201, headers);
  const result = await deliver(env, messageRowId);
  if (!result.ok) throw new HttpError(502, `Couldn't send: ${result.error}. It's saved in Sent as failed so you can retry.`);
  return json({ ok: true, id: messageRowId, threadId, status: 'sent' }, 201, headers);
}

// Sends a stored outbound message through Resend and records the outcome.
async function deliver(env, messageRowId) {
  const m = await env.DB.prepare('SELECT * FROM mail_messages WHERE id = ?').bind(messageRowId).first();
  if (!m || m.direction !== 'out') return { ok: false, error: 'Message not found' };
  try {
    const box = BOXES[m.mailbox];
    const files = (await env.DB.prepare('SELECT * FROM mail_attachments WHERE message_id = ?').bind(m.id).all()).results;
    let html = await messageBody(env, m);
    const attachments = [];
    for (const f of files) {
      const object = await env.MAIL_FILES.get(f.r2_key);
      if (!object) continue;
      const part = { filename: f.filename, content: toBase64(new Uint8Array(await object.arrayBuffer())), content_type: f.content_type };
      // Inline images point at our file URL in the CRM; recipients get them as cid: parts.
      const pattern = new RegExp(`src="[^"]*/api/mail/files/${f.id}[^"]*"`, 'g');
      if (f.inline && f.content_id && pattern.test(html)) {
        html = html.replace(pattern, `src="cid:${f.content_id}"`);
        part.content_id = f.content_id;
      }
      attachments.push(part);
    }
    const brandName = brand(env).company;
    const payload = {
      from: formatAddress({ name: `${m.from_name || m.sent_by_name} | ${brandName}`, email: boxAddress(env, box) }),
      to: parseJson(m.to_json, []).map(formatAddress),
      subject: m.subject,
      html,
      text: m.text,
      reply_to: [boxAddress(env, box)]
    };
    const cc = parseJson(m.cc_json, []).map(formatAddress);
    const bcc = parseJson(m.bcc_json, []).map(formatAddress);
    if (!payload.to.length) payload.to = cc.length ? cc.splice(0, cc.length) : bcc.splice(0, 1);
    if (cc.length) payload.cc = cc;
    if (bcc.length) payload.bcc = bcc;
    if (m.in_reply_to) payload.headers = { 'In-Reply-To': m.in_reply_to, References: m.references_hdr || m.in_reply_to };
    if (attachments.length) payload.attachments = attachments;
    const data = await resend(env, '/emails', { method: 'POST', body: JSON.stringify(payload), headers: { 'Idempotency-Key': m.id } });
    await env.DB.prepare("UPDATE mail_messages SET status = 'sent', resend_id = ?, error = NULL, created_at = ? WHERE id = ?").bind(data.id || null, now(), m.id).run();
    return { ok: true };
  } catch (error) {
    const message = error instanceof HttpError ? error.message.replace(/^Email provider error: /, '') : 'Email service unreachable';
    console.error('mail deliver failed', m.id, error);
    await env.DB.prepare("UPDATE mail_messages SET status = 'failed', error = ? WHERE id = ?").bind(message.slice(0, 500), m.id).run();
    return { ok: false, error: message };
  }
}

async function loadOwnOutbound(env, box, id) {
  const m = await env.DB.prepare("SELECT * FROM mail_messages WHERE id = ? AND mailbox = ? AND direction = 'out'").bind(clean(id, 64), box.key).first();
  if (!m) throw new HttpError(404, 'Message not found.');
  return m;
}

async function retryMessage(request, env, headers, [boxKey, id]) {
  const { box } = await requireBox(request, env, boxKey);
  const m = await loadOwnOutbound(env, box, id);
  if (m.status !== 'failed') throw new HttpError(400, 'Only failed messages can be retried.');
  await env.DB.prepare("UPDATE mail_messages SET status = 'sending' WHERE id = ?").bind(m.id).run();
  const result = await deliver(env, m.id);
  if (!result.ok) throw new HttpError(502, `Still couldn't send: ${result.error}`);
  return json({ ok: true }, 200, headers);
}

// Cancels a scheduled or failed send and turns it back into a draft for the person canceling.
async function unsendToDraft(request, env, headers, [boxKey, id]) {
  const { user, box } = await requireBox(request, env, boxKey);
  const m = await loadOwnOutbound(env, box, id);
  if (!['scheduled', 'failed'].includes(m.status)) throw new HttpError(400, 'That message was already sent.');
  const claim = await env.DB.prepare("UPDATE mail_messages SET status = 'canceled' WHERE id = ? AND status IN ('scheduled','failed')").bind(m.id).run();
  if (!claim.meta.changes) throw new HttpError(409, 'That message is already going out.');
  const draftId = crypto.randomUUID();
  const thread = await env.DB.prepare('SELECT message_count FROM mail_threads WHERE id = ?').bind(m.thread_id).first();
  const isOnly = thread?.message_count <= 1;
  const stmts = [
    env.DB.prepare(
      `INSERT INTO mail_drafts (id, mailbox, user_id, thread_id, mode, to_json, cc_json, bcc_json, subject, html, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(draftId, box.key, user.id, isOnly ? null : m.thread_id, isOnly ? 'new' : 'reply', m.to_json, m.cc_json, m.bcc_json, m.subject, m.compose_html, now(), now()),
    env.DB.prepare('UPDATE mail_attachments SET message_id = NULL, draft_id = ? WHERE message_id = ?').bind(draftId, m.id),
    env.DB.prepare('DELETE FROM mail_messages WHERE id = ?').bind(m.id)
  ];
  if (isOnly) stmts.push(env.DB.prepare('DELETE FROM mail_threads WHERE id = ?').bind(m.thread_id));
  else stmts.push(env.DB.prepare('UPDATE mail_threads SET message_count = MAX(message_count - 1, 0) WHERE id = ?').bind(m.thread_id));
  await env.DB.batch(stmts);
  if (m.body_key) await env.MAIL_FILES.delete(m.body_key);
  return json({ ok: true, draftId }, 200, headers);
}

// ─── Inbound ──────────────────────────────────────────────────

function boxesFor(env, addresses) {
  const domain = String(env.MAIL_DOMAIN).toLowerCase();
  const hits = new Set();
  let ours = false;
  for (const raw of addresses) {
    const { email } = parseAddress(raw);
    const [local, host] = email.split('@');
    if (!host || !(host === domain || host.endsWith(`.${domain}`))) continue;
    ours = true;
    const base = local.split('+')[0];
    const box = Object.values(BOXES).find(b => b.local === base || (b.key === 'inquiries' && base === 'inquiry'));
    if (box) hits.add(box.key);
  }
  if (!hits.size) hits.add(CATCH_ALL_BOX);
  return { boxes: [...hits], ours };
}

async function findThreadFor(env, boxKey, { inReplyTo, references, subject, counterpart }) {
  const ids = [inReplyTo, ...String(references || '').split(/\s+/)].map(v => String(v || '').trim()).filter(Boolean).slice(-20);
  if (ids.length) {
    const hit = await env.DB.prepare(
      `SELECT thread_id FROM mail_messages WHERE mailbox = ? AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`
    ).bind(boxKey, ...ids).first();
    if (hit) return hit.thread_id;
  }
  // Replies to our outbound mail don't carry a Message-ID we know, so fall back to subject + person.
  const key = subjectKey(subject);
  if (!key || !isReplySubject(subject) || !counterpart) return null;
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const hit = await env.DB.prepare(
    `SELECT id FROM mail_threads WHERE mailbox = ? AND subject_key = ? AND (',' || participants || ',') LIKE ? AND last_message_at > ?
     ORDER BY last_message_at DESC LIMIT 1`
  ).bind(boxKey, key, `%,${counterpart},%`, since).first();
  return hit?.id || null;
}

async function ingest(env, resendId) {
  const seenKey = `seen:${resendId}`;
  if (await env.DB.prepare('SELECT 1 FROM mail_state WHERE key = ?').bind(seenKey).first()) return { skipped: true };

  const email = await resend(env, `/emails/receiving/${encodeURIComponent(resendId)}`);
  const hdrs = email.headers || {};
  const from = parseAddress(headerValue(hdrs, 'from') || email.from);
  if (!from.email) from.email = String(email.from || '').toLowerCase();
  const to = parseList(email.to || []);
  const cc = parseList(email.cc || []);
  const routing = [
    ...(email.to || []), ...(email.cc || []), ...(email.bcc || []), ...(email.received_for || []),
    ...['delivered-to', 'x-original-to', 'x-forwarded-to', 'envelope-to'].map(h => headerValue(hdrs, h)).filter(Boolean)
  ];
  const { boxes } = boxesFor(env, routing);
  const subject = clean(email.subject, 300) || '(no subject)';
  const messageId = clean(email.message_id || headerValue(hdrs, 'message-id'), 500);
  const inReplyTo = clean(headerValue(hdrs, 'in-reply-to'), 500);
  const references = clean(headerValue(hdrs, 'references'), 4000);
  const createdAt = email.created_at ? new Date(email.created_at).toISOString() : now();
  const rawHtml = String(email.html || '');
  const text = String(email.text || '') || htmlToText(rawHtml);

  let attachmentMeta = [];
  if ((email.attachments || []).length) {
    const list = await resend(env, `/emails/receiving/${encodeURIComponent(resendId)}/attachments`);
    attachmentMeta = list.data || [];
  }
  const downloads = [];
  for (const a of attachmentMeta) {
    if (!a.download_url || (a.size && a.size > 40 * 1024 * 1024)) continue;
    const res = await fetch(a.download_url);
    if (!res.ok) continue;
    downloads.push({ meta: a, bytes: await res.arrayBuffer() });
  }

  for (const boxKey of boxes) {
    const box = BOXES[boxKey];
    const exists = await env.DB.prepare("SELECT 1 FROM mail_messages WHERE mailbox = ? AND resend_id = ? AND direction = 'in'").bind(box.key, resendId).first();
    if (exists) continue;
    const blocked = await env.DB.prepare('SELECT 1 FROM mail_blocked WHERE mailbox = ? AND address = ?').bind(box.key, from.email).first();
    const messageRowId = crypto.randomUUID();

    const files = [];
    for (const { meta, bytes } of downloads) {
      const row = {
        id: crypto.randomUUID(), filename: clean(meta.filename, 200) || 'attachment', content_type: clean(meta.content_type, 100) || 'application/octet-stream',
        size: bytes.byteLength, content_id: clean(meta.content_id, 200).replace(/^<|>$/g, '') || null,
        inline: meta.content_disposition === 'inline' ? 1 : 0, access_token: randomToken(24)
      };
      row.r2_key = `mail/${box.key}/in/${messageRowId}/${row.id}`;
      await env.MAIL_FILES.put(row.r2_key, bytes, { httpMetadata: { contentType: row.content_type } });
      files.push(row);
    }
    let html = rawHtml;
    for (const f of files) {
      if (!f.content_id) continue;
      const cid = f.content_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(`cid:${cid}`, 'gi'), `${env.API_URL || ''}/api/mail/files/${f.id}?t=${f.access_token}`);
    }
    html = sanitizeHtml(html);
    const bodyTooBig = html.length > MAX_INLINE_BODY;
    const bodyKey = bodyTooBig ? `mail/${box.key}/bodies/${messageRowId}.html` : null;
    if (bodyTooBig) await env.MAIL_FILES.put(bodyKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });

    const threadId = await findThreadFor(env, box.key, { inReplyTo, references, subject, counterpart: from.email });
    const thread = threadId ? await env.DB.prepare('SELECT * FROM mail_threads WHERE id = ?').bind(threadId).first() : null;
    const snippet = makeSnippet(text);
    const visibleFiles = files.filter(f => !f.inline).length;
    const folder = blocked ? 'spam' : 'inbox';
    const stmts = [];
    const newThreadId = thread?.id || crypto.randomUUID();
    if (thread) {
      stmts.push(env.DB.prepare(
        `UPDATE mail_threads SET snippet = ?, participants = ?, display_from = ?, has_inbound = 1, unread = 1, message_count = message_count + 1,
           last_message_at = MAX(last_message_at, ?), folder = ?, has_attachments = CASE WHEN ? THEN 1 ELSE has_attachments END
         WHERE id = ?`
      ).bind(snippet, mergeParticipants(thread.participants, [from, ...cc], env), from.name || from.email, createdAt,
        blocked ? 'spam' : (thread.folder === 'spam' ? 'spam' : 'inbox'), visibleFiles ? 1 : 0, thread.id));
    } else {
      stmts.push(env.DB.prepare(
        `INSERT INTO mail_threads (id, mailbox, subject, subject_key, snippet, participants, display_from, folder, unread, has_inbound, has_attachments, message_count, last_message_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 1, ?, ?)`
      ).bind(newThreadId, box.key, subject, subjectKey(subject), snippet, mergeParticipants('', [from, ...cc], env), from.name || from.email, folder,
        visibleFiles ? 1 : 0, createdAt, now()));
    }
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO mail_messages (id, thread_id, mailbox, direction, status, resend_id, message_id, in_reply_to, references_hdr, from_addr, from_name,
         to_json, cc_json, reply_to, subject, html, body_key, text, snippet, created_at)
       VALUES (?, ?, ?, 'in', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      messageRowId, newThreadId, box.key, resendId, messageId || null, inReplyTo || null, references || null, from.email, from.name,
      JSON.stringify(to), JSON.stringify(cc), (email.reply_to || [])[0] || '', subject, bodyTooBig ? '' : html, bodyKey, text.slice(0, 100000), snippet, createdAt
    ));
    for (const f of files) {
      stmts.push(env.DB.prepare(
        `INSERT INTO mail_attachments (id, mailbox, message_id, filename, content_type, size, content_id, inline, r2_key, access_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(f.id, box.key, messageRowId, f.filename, f.content_type, f.size, f.content_id, f.inline, f.r2_key, f.access_token, now()));
    }
    await env.DB.batch(stmts);
  }
  await env.DB.prepare('INSERT OR REPLACE INTO mail_state (key, value) VALUES (?, ?)').bind(seenKey, now()).run();
  return { stored: boxes };
}

// Pulls anything Resend received that we haven't stored yet. Runs on the cron and on demand,
// so mail still arrives if the webhook is missing or a delivery was dropped.
export async function syncInbound(env) {
  if (!env.RESEND_API_KEY) return { ok: false, reason: 'not-configured', imported: 0 };
  let imported = 0;
  let after = null;
  for (let page = 0; page < 5; page++) {
    const list = await resend(env, `/emails/receiving?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    const items = list.data || [];
    if (page === 0) console.log('mail sync', { listed: items.length, newest: items[0]?.id || null });
    if (!items.length) break;
    const marks = items.map(() => '?').join(',');
    const seen = new Set((await env.DB.prepare(`SELECT key FROM mail_state WHERE key IN (${marks})`).bind(...items.map(i => `seen:${i.id}`)).all()).results.map(r => r.key));
    const fresh = items.filter(i => !seen.has(`seen:${i.id}`));
    // Oldest first so threads build in order.
    for (const item of fresh.reverse()) {
      try {
        const result = await ingest(env, item.id);
        if (result.stored) imported++;
      } catch (error) {
        console.error('mail ingest failed', item.id, error);
      }
    }
    if (fresh.length < items.length || !list.has_more) break;
    after = items[items.length - 1].id;
  }
  return { ok: true, imported };
}

async function syncNow(request, env, headers) {
  await requireUser(request, env);
  return json(await syncInbound(env), 200, headers);
}

async function verifySvix(env, request, payload) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) return true;
  const id = request.headers.get('svix-id');
  const timestamp = request.headers.get('svix-timestamp');
  const signatures = request.headers.get('svix-signature') || '';
  if (!id || !timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`));
  const expected = toBase64(new Uint8Array(mac));
  return signatures.split(' ').some(part => timingSafeEqual(part.split(',')[1] || '', expected));
}

// Resend webhook. The payload is only used for the email id; content is always fetched from Resend's API.
async function webhook(request, env, headers) {
  const payload = await request.text();
  if (!await verifySvix(env, request, payload)) return json({ ok: false, error: 'Invalid signature' }, 401, headers);
  const event = parseJson(payload, {});
  const id = clean(event?.data?.email_id, 100);
  if (event.type === 'email.received' && /^[\w-]{8,100}$/.test(id)) {
    try {
      await ingest(env, id);
    } catch (error) {
      console.error('webhook ingest failed', id, error);
      return json({ ok: false }, 500, headers);
    }
  }
  return json({ ok: true }, 200, headers);
}

// ─── Cron ─────────────────────────────────────────────────────

export async function mailCron(env) {
  const due = await env.DB.prepare("SELECT id FROM mail_messages WHERE status = 'scheduled' AND scheduled_at <= ? LIMIT 25").bind(now()).all();
  for (const { id } of due.results) {
    const claim = await env.DB.prepare("UPDATE mail_messages SET status = 'sending' WHERE id = ? AND status = 'scheduled'").bind(id).run();
    if (claim.meta.changes) await deliver(env, id);
  }
  // Mail stuck in "sending" (worker died mid-request) is marked failed so it can be retried.
  await env.DB.prepare("UPDATE mail_messages SET status = 'failed', error = 'Send was interrupted' WHERE status = 'sending' AND created_at < ?")
    .bind(new Date(Date.now() - 15 * 60000).toISOString()).run();
  await syncInbound(env).catch(error => console.error('mail sync failed', error));

  const cutoff = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
  for (const box of Object.values(BOXES)) {
    const old = await env.DB.prepare("SELECT id FROM mail_threads WHERE mailbox = ? AND folder = 'trash' AND last_message_at < ? LIMIT 90").bind(box.key, cutoff).all();
    await deleteThreadsForever(env, box, old.results.map(r => r.id));
  }
  // Uploads abandoned for a day (removed from a draft without saving) are cleaned up.
  const orphans = await env.DB.prepare(
    `SELECT id, r2_key FROM mail_attachments WHERE message_id IS NULL AND created_at < ?
     AND (draft_id IS NULL OR draft_id NOT IN (SELECT id FROM mail_drafts)) LIMIT 200`
  ).bind(new Date(Date.now() - 86400000).toISOString()).all();
  if (orphans.results.length) {
    await env.MAIL_FILES.delete(orphans.results.map(o => o.r2_key));
    const marks = orphans.results.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM mail_attachments WHERE id IN (${marks})`).bind(...orphans.results.map(o => o.id)).run();
  }
  await env.DB.prepare("DELETE FROM mail_state WHERE key LIKE 'seen:%' AND value < ?").bind(new Date(Date.now() - 90 * 86400000).toISOString()).run();
}

// ─── Boxes, team, templates, settings, contacts ───────────────

async function listBoxes(request, env, headers) {
  const user = await requireUser(request, env);
  const boxes = Object.values(BOXES).filter(b => canAccess(env, user, b));
  const unread = await env.DB.prepare(
    `SELECT mailbox, COUNT(*) n FROM mail_threads WHERE folder = 'inbox' AND has_inbound = 1 AND unread = 1 GROUP BY mailbox`
  ).all();
  const byBox = Object.fromEntries(unread.results.map(r => [r.mailbox, r.n]));
  return json({
    ok: true,
    connected: !!env.RESEND_API_KEY,
    webhook: !!env.RESEND_WEBHOOK_SECRET,
    user: { id: user.id, name: user.name, email: user.email, title: await userTitle(env, user.id), isOwner: String(user.email).toLowerCase() === ownerEmail(env) },
    boxes: boxes.map(b => ({ key: b.key, label: b.label, address: boxAddress(env, b), unread: byBox[b.key] || 0 }))
  }, 200, headers);
}

async function signaturePreview(request, env, headers, [boxKey]) {
  const { user, box } = await requireBox(request, env, boxKey);
  return json({ ok: true, html: signatureHtml(env, { name: user.name, title: await userTitle(env, user.id), box }) }, 200, headers);
}

async function listTeam(request, env, headers) {
  await requireUser(request, env);
  const rows = await env.DB.prepare('SELECT id, name, email FROM users WHERE verified = 1 ORDER BY name').all();
  return json({ ok: true, users: rows.results }, 200, headers);
}

async function saveSettings(request, env, headers) {
  const user = await requireUser(request, env);
  const title = clean((await readJson(request)).title, 80);
  await env.DB.prepare('INSERT INTO mail_settings (user_id, title, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at')
    .bind(user.id, title, now()).run();
  return json({ ok: true, title }, 200, headers);
}

async function listTemplates(request, env, headers) {
  await requireUser(request, env);
  const rows = await env.DB.prepare('SELECT * FROM mail_templates ORDER BY name').all();
  return json({ ok: true, templates: rows.results }, 200, headers);
}

async function saveTemplate(request, env, headers) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const name = clean(body.name, 80);
  if (!name) throw new HttpError(400, 'Give the template a name.');
  const subject = clean(body.subject, 300);
  const html = sanitizeHtml(clean(body.html, 200000));
  const id = clean(body.id, 64);
  if (id) {
    const result = await env.DB.prepare('UPDATE mail_templates SET name = ?, subject = ?, html = ?, updated_at = ? WHERE id = ?').bind(name, subject, html, now(), id).run();
    if (!result.meta.changes) throw new HttpError(404, 'Template not found.');
    return json({ ok: true, id }, 200, headers);
  }
  const newId = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO mail_templates (id, name, subject, html, created_by, created_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId, name, subject, html, user.id, user.name, now(), now()).run();
  return json({ ok: true, id: newId }, 201, headers);
}

async function deleteTemplate(request, env, headers, [id]) {
  await requireUser(request, env);
  await env.DB.prepare('DELETE FROM mail_templates WHERE id = ?').bind(clean(id, 64)).run();
  return json({ ok: true }, 200, headers);
}

async function contacts(request, env, headers) {
  await requireUser(request, env);
  const q = clean(new URL(request.url).searchParams.get('q'), 100).toLowerCase();
  if (q.length < 2) return json({ ok: true, contacts: [] }, 200, headers);
  const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
  const rows = await env.DB.prepare(
    `SELECT name, email FROM (
       SELECT name, lower(email) email, updated_at ts FROM contacts WHERE email != ''
       UNION ALL SELECT name, lower(email), created_at FROM submissions WHERE email != ''
       UNION ALL SELECT from_name, from_addr, created_at FROM mail_messages WHERE direction = 'in' AND from_addr != ''
     ) WHERE lower(email) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\'
     GROUP BY email ORDER BY MAX(ts) DESC LIMIT 8`
  ).bind(like, like).all().catch(() => ({ results: [] }));
  return json({ ok: true, contacts: rows.results }, 200, headers);
}

export const mailRoutes = {
  'POST /api/mail/webhook': webhook,
  'GET /api/mail/files/:id': serveFile,
  'GET /api/mail/boxes': listBoxes,
  'GET /api/mail/team': listTeam,
  'GET /api/mail/contacts': contacts,
  'POST /api/mail/sync': syncNow,
  'POST /api/mail/settings': saveSettings,
  'GET /api/mail/templates': listTemplates,
  'POST /api/mail/templates': saveTemplate,
  'DELETE /api/mail/templates/:id': deleteTemplate,
  'GET /api/mail/:box/counts': counts,
  'GET /api/mail/:box/signature': signaturePreview,
  'GET /api/mail/:box/threads': listThreads,
  'POST /api/mail/:box/threads/bulk': bulkUpdate,
  'GET /api/mail/:box/threads/:id': getThread,
  'PATCH /api/mail/:box/threads/:id': updateThread,
  'POST /api/mail/:box/threads/:id/notes': addNote,
  'DELETE /api/mail/:box/threads/:id/notes/:note': deleteNote,
  'POST /api/mail/:box/empty/:folder': emptyFolder,
  'GET /api/mail/:box/drafts': listDrafts,
  'POST /api/mail/:box/drafts': saveDraft,
  'DELETE /api/mail/:box/drafts/:id': deleteDraft,
  'POST /api/mail/:box/uploads': upload,
  'POST /api/mail/:box/uploads/copy': copyAttachments,
  'DELETE /api/mail/:box/uploads/:id': deleteUpload,
  'POST /api/mail/:box/send': sendMessage,
  'POST /api/mail/:box/messages/:id/retry': retryMessage,
  'POST /api/mail/:box/messages/:id/unsend': unsendToDraft
};
