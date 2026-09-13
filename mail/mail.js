'use strict';

const CRM_API = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://localhost:8787' : 'https://edgeform-crm-api.edgeformmedia.workers.dev';
const SESSION_KEY = 'edgeform_crm_session';
const LOGIN_URL = '/login/index.html';
const HANDOFF_KEY = 'edgeform_mail_compose';
const PREFS_KEY = 'edgeform_mail_prefs';
const MAIL_DOMAIN = 'edgeformmarketing.com';
const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 48];

const FOLDERS = [
  { key: 'inbox', label: 'Inbox', icon: '📥', count: 'inbox' },
  { key: 'unread', label: 'Unread', icon: '●' },
  { key: 'starred', label: 'Starred', icon: '★' },
  { key: 'assigned', label: 'Assigned to me', icon: '👤', count: 'assigned' },
  null,
  { key: 'sent', label: 'Sent', icon: '➤' },
  { key: 'scheduled', label: 'Scheduled', icon: '🕓', count: 'scheduled', always: true },
  { key: 'drafts', label: 'Drafts', icon: '✎', count: 'drafts', always: true },
  null,
  { key: 'all', label: 'All mail', icon: '☰' },
  { key: 'archive', label: 'Archive', icon: '🗄' },
  { key: 'spam', label: 'Spam', icon: '⚠', count: 'spam' },
  { key: 'trash', label: 'Trash', icon: '🗑' }
];

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isEmail = (v) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(v);
const initials = (name) => String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const typing = (el) => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

const S = {
  user: null, boxes: [], box: 'team', folder: 'inbox', q: '', threads: [], drafts: [], offset: 0, hasMore: false,
  selected: new Set(), openId: null, thread: null, counts: {}, team: [], templates: null, connected: true,
  unreadSeen: null, signatures: {}, lastSync: 0
};

let prefs = { font: 'Arial, Helvetica, sans-serif', size: 14, undoSeconds: 5, notify: false };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch {}
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };

// ─── API ──────────────────────────────────────────────────────

function getSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }

async function api(path, options = {}) {
  const isRaw = options.body instanceof Blob || options.body instanceof ArrayBuffer;
  const res = await fetch(CRM_API + path, {
    ...options,
    headers: {
      ...(isRaw ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${getSession()?.token || ''}`,
      ...(options.headers || {})
    }
  });
  if (res.status === 401) { localStorage.removeItem(SESSION_KEY); location.href = LOGIN_URL; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}

const boxInfo = (key = S.box) => S.boxes.find(b => b.key === key);
const fileUrl = (url) => url.startsWith('http') ? url : CRM_API + url;

// ─── Formatting helpers ───────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const nowD = new Date();
  if (d.toDateString() === nowD.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(nowD); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (d.getFullYear() === nowD.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtFull(ts) {
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  const rel = diff < 0 ? '' : diff < 60 ? 'just now' : diff < 3600 ? `${Math.floor(diff / 60)} min ago` : diff < 86400 ? `${Math.floor(diff / 3600)} hr ago` : diff < 604800 ? `${Math.floor(diff / 86400)} days ago` : '';
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + (rel ? ` (${rel})` : '');
}

const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const personLabel = (a) => a?.name || a?.email || '';
const formatAddr = (a) => a.name ? `${a.name} <${a.email}>` : a.email;

function parseAddress(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: text.replace(/^mailto:/i, '').toLowerCase() };
}

function splitAddresses(text) {
  return String(text || '').split(/[,;\n](?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => s.trim()).filter(Boolean).map(parseAddress);
}

const isOurs = (email) => String(email || '').toLowerCase().endsWith(`@${MAIL_DOMAIN}`);

// ─── HTML sanitizer (for anything placed into the live page) ──

const ALLOWED_TAGS = new Set('a abbr b bdi bdo big blockquote br caption center cite code col colgroup dd del dfn div dl dt em font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strike strong sub sup table tbody td tfoot th thead tr tt u ul wbr'.split(' '));
const DROP_TAGS = new Set('script style title head iframe object embed noscript template svg math select textarea button form input meta link base frame frameset audio video canvas applet dialog'.split(' '));
const ALLOWED_ATTRS = new Set('href src alt title style width height align valign colspan rowspan cellpadding cellspacing border color face size class dir bgcolor target start type'.split(' '));

function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (DROP_TAGS.has(tag)) { child.remove(); continue; }
      walk(child);
      if (!ALLOWED_TAGS.has(tag)) { child.replaceWith(...child.childNodes); continue; }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (!ALLOWED_ATTRS.has(name)) { child.removeAttribute(attr.name); continue; }
        if ((name === 'href' || name === 'src') && !/^(https?:|mailto:|tel:|sms:|cid:|#)/i.test(value)
          && !(name === 'src' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value))) child.removeAttribute(attr.name);
        if (name === 'style' && /expression|javascript:|behavior|-moz-binding|@import|position\s*:\s*(fixed|absolute|sticky)/i.test(value)) child.removeAttribute(attr.name);
        if (name === 'class') {
          const keep = value.split(/\s+/).filter(c => /^(edgeform-|gmail_)/.test(c)).join(' ');
          keep ? child.setAttribute('class', keep) : child.removeAttribute('class');
        }
      }
      if (tag === 'a') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

const htmlText = (html) => new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
const textToHtml = (text) => esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>').replace(/\n/g, '<br>');

// ─── Toasts & modals ──────────────────────────────────────────

function toast(message, { error = false, action, actionLabel, duration = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.innerHTML = `<span>${esc(message)}</span>`;
  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    btn.onclick = () => { close(); action(); };
    el.appendChild(btn);
  }
  $('toasts').appendChild(el);
  if (duration) timer = setTimeout(close, duration);
  return { el, close };
}

function openModal(title, bodyHtml, { wide } = {}) {
  const modal = $('modal');
  modal.style.width = wide ? 'min(900px, calc(100vw - 24px))' : '';
  modal.innerHTML = `<div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close>✕</button></div><div class="modal-body">${bodyHtml}</div>`;
  modal.hidden = false;
  $('modal-scrim').hidden = false;
  modal.querySelector('[data-close]').onclick = closeModal;
  return modal;
}

function closeModal() { $('modal').hidden = true; $('modal-scrim').hidden = true; $('modal').innerHTML = ''; }

// ─── Boot ─────────────────────────────────────────────────────

async function boot() {
  if (!getSession()?.token) { location.href = LOGIN_URL; return; }
  let data;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { data = await api('/api/mail/boxes'); break; } catch (error) {
      if (error.message === 'Signed out') return;
      if (attempt === 3) {
        $('guard-text').innerHTML = `COULD NOT REACH MAIL SERVER<br><span style="letter-spacing:0">${esc(error.message)}</span><br><button class="btn primary" onclick="location.reload()">Retry</button>`;
        return;
      }
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  S.user = data.user;
  S.boxes = data.boxes;
  S.connected = data.connected;
  S.unreadSeen = Object.fromEntries(data.boxes.map(b => [b.key, b.unread]));

  const params = new URLSearchParams(location.search);
  const wanted = params.get('box');
  S.box = boxInfo(wanted) ? wanted : (S.boxes[0]?.key || 'team');
  if (wanted && !boxInfo(wanted)) toast("You don't have access to that inbox.", { error: true });
  const folder = params.get('folder');
  if (FOLDERS.some(f => f && f.key === folder)) S.folder = folder;

  bindUi();
  renderTabs();
  renderRail();
  renderConn();
  $('guard').hidden = true;

  loadThreads();
  loadCounts();
  api('/api/mail/team').then(r => { S.team = r.users; }).catch(() => {});

  const handoff = sessionStorage.getItem(HANDOFF_KEY);
  if (handoff) {
    sessionStorage.removeItem(HANDOFF_KEY);
    try {
      const h = JSON.parse(handoff);
      if (h.box && boxInfo(h.box)) switchBox(h.box, { keepComposer: true });
      openComposer({ to: h.to || [], subject: h.subject || '', html: h.html || '' });
    } catch {}
  }

  syncNow(true);
  setInterval(poll, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}

function updateUrl() {
  const params = new URLSearchParams({ box: S.box });
  if (S.folder !== 'inbox') params.set('folder', S.folder);
  history.replaceState(null, '', `${location.pathname}?${params}`);
}

async function poll() {
  try {
    const data = await api('/api/mail/boxes');
    S.connected = data.connected;
    renderConn();
    let fresh = 0;
    for (const b of data.boxes) {
      const before = S.unreadSeen?.[b.key] ?? b.unread;
      if (b.unread > before) fresh += b.unread - before;
    }
    S.unreadSeen = Object.fromEntries(data.boxes.map(b => [b.key, b.unread]));
    S.boxes = data.boxes;
    renderTabs();
    if (fresh) {
      notify(fresh);
      if (!S.selected.size && $('thread-list').scrollTop < 40) loadThreads({ silent: true });
    }
    loadCounts();
  } catch {}
}

function notify(count) {
  if (!prefs.notify || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  const n = new Notification('Edgeform Mail', { body: `${count} new message${count > 1 ? 's' : ''}`, icon: '/assets/logo.png', tag: 'edgeform-mail' });
  n.onclick = () => { window.focus(); n.close(); };
}

async function syncNow(quiet) {
  if (!S.connected || Date.now() - S.lastSync < 10000) { if (!quiet) loadThreads({ silent: true }); return; }
  S.lastSync = Date.now();
  $('sync-btn').classList.add('spin');
  try {
    const r = await api('/api/mail/sync', { method: 'POST' });
    if (r.imported) { loadThreads({ silent: true }); loadCounts(); poll(); }
    else if (!quiet) loadThreads({ silent: true });
    if (!quiet) toast(r.imported ? `${r.imported} new message${r.imported > 1 ? 's' : ''}` : 'You’re up to date');
  } catch (error) {
    if (!quiet) toast(error.message, { error: true });
  } finally {
    $('sync-btn').classList.remove('spin');
  }
}

// ─── Chrome: tabs, rail, connection ───────────────────────────

function renderTabs() {
  $('box-tabs').innerHTML = S.boxes.map(b => `
    <button class="box-tab ${b.key === S.box ? 'active' : ''}" data-box="${b.key}" title="${esc(b.address)}">
      ${esc(b.label.replace(' Inbox', ''))}${b.unread ? `<span class="n">${b.unread}</span>` : ''}
    </button>`).join('');
  const total = S.boxes.reduce((n, b) => n + b.unread, 0);
  document.title = `${total ? `(${total}) ` : ''}${boxInfo()?.label || 'Mail'} · Edgeform Mail`;
}

function renderRail() {
  const box = boxInfo();
  $('rail-box').innerHTML = `<div class="label">${esc(box?.label || '')}</div><div class="addr">${esc(box?.address || '')}</div>`;
  $('folders').innerHTML = FOLDERS.map(f => {
    if (!f) return '<li class="folder-sep"></li>';
    const n = f.count ? S.counts[f.count] || 0 : 0;
    return `<li class="folder ${f.key === S.folder ? 'active' : ''}" data-folder="${f.key}">
      <span class="f-icon">${f.icon}</span>${f.label}${n ? `<span class="f-count">${n}</span>` : ''}</li>`;
  }).join('');
  $('rail-foot').innerHTML = `Signed in as <b>${esc(S.user.name)}</b><br>${esc(S.user.email)}`;
}

function renderConn() {
  const el = $('conn');
  el.className = 'conn ' + (S.connected ? 'ok' : 'off');
  el.querySelector('span').textContent = S.connected ? 'Connected' : 'Not connected';
  el.title = S.connected ? 'Sending and receiving through Resend' : 'Email is not connected yet';
  const notice = $('notice');
  if (S.connected) { notice.hidden = true; return; }
  notice.hidden = false;
  notice.innerHTML = S.user.isOwner
    ? `<b>Email isn't connected yet.</b> Nothing can be sent or received until setup is finished. <button class="text-btn sm" id="setup-link">Setup guide →</button>`
    : `<b>Email isn't connected yet.</b> You can write drafts; sending and receiving start once the admin finishes setup.`;
  $('setup-link')?.addEventListener('click', showSetup);
}

async function loadCounts() {
  try {
    const r = await api(`/api/mail/${S.box}/counts`);
    S.counts = r.counts;
    renderRail();
  } catch {}
}

function switchBox(key, { keepComposer } = {}) {
  if (key === S.box || !boxInfo(key)) return;
  S.box = key;
  S.folder = 'inbox';
  S.q = '';
  $('search').value = '';
  closeThread();
  renderTabs();
  renderRail();
  updateUrl();
  loadThreads();
  loadCounts();
  if (!keepComposer && C.open && !C.threadId && !C.attachments.length && !C.dirtyContent) setComposerBox(key);
}

function switchFolder(key) {
  S.folder = key;
  S.q = '';
  $('search').value = '';
  closeThread();
  renderRail();
  updateUrl();
  loadThreads();
  document.body.classList.remove('rail-open');
}

// ─── Thread list ──────────────────────────────────────────────

async function loadThreads({ append = false, silent = false } = {}) {
  const list = $('thread-list');
  if (!append) {
    S.selected.clear();
    renderBulk();
    if (!silent) list.innerHTML = '<div class="skeleton"></div>'.repeat(6);
  }
  const folderLabel = FOLDERS.find(f => f && f.key === S.folder)?.label || '';
  $('list-title').textContent = S.q ? `Search: ${S.q}` : folderLabel;
  $('empty-folder').hidden = !['trash', 'spam'].includes(S.folder) || !!S.q;
  $('empty-folder').textContent = S.folder === 'trash' ? 'Empty trash' : 'Delete all spam';
  const requestKey = `${S.box}|${S.folder}|${S.q}`;
  try {
    if (S.folder === 'drafts' && !S.q) {
      const r = await api(`/api/mail/${S.box}/drafts`);
      if (requestKey !== `${S.box}|${S.folder}|${S.q}`) return;
      S.drafts = r.drafts;
      renderDrafts();
      return;
    }
    const offset = append ? S.offset + 50 : 0;
    const folder = S.q && S.folder === 'inbox' ? 'all' : S.folder === 'drafts' ? 'all' : S.folder;
    const qs = new URLSearchParams({ folder, offset });
    if (S.q) qs.set('q', S.q);
    const r = await api(`/api/mail/${S.box}/threads?${qs}`);
    if (requestKey !== `${S.box}|${S.folder}|${S.q}`) return;
    S.threads = append ? S.threads.concat(r.threads) : r.threads;
    S.offset = offset;
    S.hasMore = r.hasMore;
    renderList();
  } catch (error) {
    if (!silent) list.innerHTML = `<div class="list-empty"><div class="big">⚠</div>${esc(error.message)}<div class="list-more"><button class="btn" onclick="loadThreads()">Try again</button></div></div>`;
  }
}

const EMPTY_TEXT = {
  inbox: 'Your inbox is empty. Nice work.', unread: 'No unread conversations.', starred: 'Star conversations to find them here.',
  assigned: 'Nothing is assigned to you.', sent: 'Nothing sent from this inbox yet.', scheduled: 'No scheduled messages.',
  all: 'No mail yet.', archive: 'Archive is empty.', spam: 'No spam. Hooray!', trash: 'Trash is empty. Conversations here are deleted after 30 days.'
};

function renderList() {
  const list = $('thread-list');
  if (!S.threads.length) {
    list.innerHTML = `<div class="list-empty"><div class="big">${S.q ? '⌕' : '✉'}</div>${S.q ? 'No conversations match your search.' : EMPTY_TEXT[S.folder] || 'Nothing here.'}</div>`;
    return;
  }
  const showFolder = S.q || S.folder === 'all' || S.folder === 'starred' || S.folder === 'assigned';
  list.innerHTML = S.threads.map(t => {
    const tags = [];
    if (showFolder && t.folder !== 'inbox') tags.push(`<span class="tag">${esc(t.folder)}</span>`);
    if (t.assigned_name) tags.push(`<span class="tag green" title="Assigned">${esc(t.assigned_name.split(' ')[0])}</span>`);
    const from = S.folder === 'sent' && !t.display_from.startsWith('To:') ? `To: ${t.participants.split(',')[0] || ''}` : t.display_from;
    return `<div class="t-row ${t.unread ? 'unread' : ''} ${S.selected.has(t.id) ? 'selected' : ''} ${S.openId === t.id ? 'open' : ''}" data-id="${esc(t.id)}" role="listitem">
      <label class="check" data-stop><input type="checkbox" data-select ${S.selected.has(t.id) ? 'checked' : ''}><span></span></label>
      <button class="t-star ${t.starred ? 'on' : ''}" data-star title="${t.starred ? 'Unstar' : 'Star'}">${t.starred ? '★' : '☆'}</button>
      <div class="t-from">${esc(from || '(unknown)')}${t.message_count > 1 ? `<span class="count">${t.message_count}</span>` : ''}</div>
      <div class="t-date">${t.has_attachments ? '📎 ' : ''}${fmtDate(t.last_message_at)}</div>
      <div class="t-subject">${tags.length ? `<span class="t-tags">${tags.join('')}</span>` : ''}${esc(t.subject || '(no subject)')}</div>
      <div class="t-snippet">${esc(t.snippet)}</div>
      <div class="t-hover">
        ${['archive', 'trash', 'spam'].includes(t.folder)
          ? `<button class="icon-btn sm" data-act="inbox" title="Move to inbox">📥</button>`
          : `<button class="icon-btn sm" data-act="archive" title="Archive (e)">🗄</button>`}
        ${t.folder !== 'trash' ? `<button class="icon-btn sm" data-act="trash" title="Delete (#)">🗑</button>` : ''}
        <button class="icon-btn sm" data-act="${t.unread ? 'read' : 'unread'}" title="Mark as ${t.unread ? 'read' : 'unread'}">${t.unread ? '✉' : '●'}</button>
      </div>
    </div>`;
  }).join('') + (S.hasMore ? '<div class="list-more"><button class="btn" id="load-more">Load more</button></div>' : '');
  $('load-more')?.addEventListener('click', () => loadThreads({ append: true }));
  syncSelectAll();
}

function renderDrafts() {
  const list = $('thread-list');
  if (!S.drafts.length) { list.innerHTML = '<div class="list-empty"><div class="big">✎</div>No drafts. Drafts save automatically while you write.</div>'; return; }
  list.innerHTML = S.drafts.map(d => `
    <div class="t-row" data-draft="${esc(d.id)}">
      <span></span><span></span>
      <div class="t-from"><span class="tag red" style="margin-right:6px">Draft</span>${esc(d.to.map(personLabel).join(', ') || '(no recipients)')}</div>
      <div class="t-date">${d.attachments.length ? '📎 ' : ''}${fmtDate(d.updatedAt)}</div>
      <div class="t-subject">${esc(d.subject || '(no subject)')}</div>
      <div class="t-snippet">${esc(htmlText(d.html).slice(0, 160))}</div>
      <div class="t-hover"><button class="icon-btn sm" data-discard title="Discard draft">🗑</button></div>
    </div>`).join('');
}

function syncSelectAll() {
  const all = $('select-all');
  const n = S.selected.size;
  all.checked = n > 0 && n === S.threads.length;
  all.indeterminate = n > 0 && n < S.threads.length;
}

function renderBulk() {
  const bulk = $('bulk');
  syncSelectAll();
  if (!S.selected.size) { bulk.hidden = true; bulk.innerHTML = ''; return; }
  const f = S.folder;
  const buttons = [];
  if (['archive', 'trash', 'spam'].includes(f)) buttons.push(['inbox', '📥', 'Move to inbox']);
  else buttons.push(['archive', '🗄', 'Archive']);
  if (f === 'spam') buttons.push(['notspam', '✓', 'Not spam']);
  else buttons.push(['spam', '⚠', 'Report spam']);
  if (f === 'trash' || f === 'spam') buttons.push(['delete', '✕', 'Delete forever']);
  else buttons.push(['trash', '🗑', 'Delete']);
  buttons.push(['read', '✉', 'Mark as read'], ['unread', '●', 'Mark as unread'], ['star', '★', 'Star']);
  bulk.hidden = false;
  bulk.innerHTML = buttons.map(([a, icon, label]) => `<button class="icon-btn" data-bulk="${a}" title="${label}">${icon}</button>`).join('') +
    `<span style="font:500 11px var(--mono);color:var(--text-muted);align-self:center;margin-left:6px">${S.selected.size} selected</span>`;
}

async function bulkAction(action, ids = [...S.selected]) {
  if (!ids.length) return;
  if (action === 'delete' && !confirm(`Delete ${ids.length} conversation${ids.length > 1 ? 's' : ''} forever? This can't be undone.`)) return;
  try {
    await api(`/api/mail/${S.box}/threads/bulk`, { method: 'POST', body: JSON.stringify({ ids, action }) });
    const moving = ['archive', 'inbox', 'trash', 'spam', 'notspam', 'delete'].includes(action);
    const labels = { archive: 'Archived', inbox: 'Moved to inbox', trash: 'Moved to trash', spam: 'Reported as spam, sender blocked', notspam: 'Moved to inbox, sender unblocked', delete: 'Deleted forever' };
    if (moving) {
      if (ids.includes(S.openId)) closeThread();
      const undo = { archive: 'inbox', trash: S.folder === 'all' ? 'inbox' : S.folder, inbox: S.folder, spam: 'notspam', notspam: 'spam' }[action];
      toast(`${labels[action]}${ids.length > 1 ? ` · ${ids.length}` : ''}`, undo && action !== 'delete' ? { actionLabel: 'Undo', action: () => bulkAction(undo === 'all' ? 'inbox' : undo, ids).then(() => loadThreads({ silent: true })) } : {});
    }
    await loadThreads({ silent: true });
    loadCounts();
    poll();
  } catch (error) {
    toast(error.message, { error: true });
  }
}

// ─── Thread view ──────────────────────────────────────────────

function closeThread() {
  S.openId = null;
  S.thread = null;
  $('thread-view').hidden = true;
  $('thread-view').innerHTML = '';
  $('empty-read').hidden = false;
  document.body.classList.remove('reading');
  document.querySelectorAll('.t-row.open').forEach(r => r.classList.remove('open'));
}

async function openThread(id, { keepScroll } = {}) {
  const row = S.threads.find(t => t.id === id);
  const wasUnread = row?.unread;
  S.openId = id;
  document.querySelectorAll('.t-row').forEach(r => r.classList.toggle('open', r.dataset.id === id));
  document.body.classList.add('reading');
  const view = $('thread-view');
  $('empty-read').hidden = true;
  view.hidden = false;
  if (!keepScroll) view.innerHTML = '<div class="skeleton" style="height:120px;border-radius:12px;margin-top:40px"></div>';
  try {
    const data = await api(`/api/mail/${S.box}/threads/${encodeURIComponent(id)}`);
    if (S.openId !== id) return;
    S.thread = data;
    renderThread(data, { wasUnread });
    if (row && row.unread) {
      row.unread = 0;
      document.querySelector(`.t-row[data-id="${CSS.escape(id)}"]`)?.classList.remove('unread');
      loadCounts();
      const b = boxInfo();
      if (b && b.unread) { b.unread--; S.unreadSeen[b.key] = b.unread; renderTabs(); }
    }
  } catch (error) {
    view.innerHTML = `<div class="list-empty"><div class="big">⚠</div>${esc(error.message)}</div>`;
  }
}

function renderThread(data, { wasUnread } = {}) {
  const { thread, messages, notes, crm } = data;
  const view = $('thread-view');
  const inFolder = thread.folder;
  const assignOptions = [`<option value="">Unassigned</option>`]
    .concat(S.team.map(u => `<option value="${esc(u.id)}" ${u.id === thread.assigned_to ? 'selected' : ''}>👤 ${esc(u.name)}</option>`)).join('');
  const lastIndex = messages.length - 1;

  view.innerHTML = `
    <div class="tv-actions">
      <button class="icon-btn only-mobile" data-tv="back" title="Back">←</button>
      ${['archive', 'trash', 'spam'].includes(inFolder)
        ? `<button class="icon-btn" data-tv="inbox" title="Move to inbox">📥</button>`
        : `<button class="icon-btn" data-tv="archive" title="Archive (e)">🗄</button>`}
      ${inFolder === 'spam' ? `<button class="icon-btn" data-tv="notspam" title="Not spam">✓</button>` : `<button class="icon-btn" data-tv="spam" title="Report spam (!)">⚠</button>`}
      ${inFolder === 'trash' || inFolder === 'spam'
        ? `<button class="icon-btn danger" data-tv="delete" title="Delete forever">✕</button>`
        : `<button class="icon-btn" data-tv="trash" title="Delete (#)">🗑</button>`}
      <button class="icon-btn" data-tv="unread" title="Mark as unread (Shift+U)">●</button>
      <button class="icon-btn ${thread.starred ? 'on' : ''}" data-tv="star" title="Star (s)">${thread.starred ? '★' : '☆'}</button>
      <span class="spacer"></span>
      <select data-tv-assign title="Assign to a teammate">${assignOptions}</select>
      <button class="icon-btn" data-tv="print" title="Print">⎙</button>
    </div>
    <h1 class="tv-subject">${esc(thread.subject || '(no subject)')}</h1>
    <div class="tv-meta">
      <span class="tag">${esc(boxInfo()?.label || '')}</span>
      ${inFolder !== 'inbox' ? `<span class="tag orange">${esc(inFolder)}</span>` : ''}
      ${thread.assigned_name ? `<span class="tag green">Assigned · ${esc(thread.assigned_name)}</span>` : ''}
      ${messages.length > 1 ? `<span class="tag">${messages.length} messages</span>` : ''}
    </div>
    ${crm?.length ? crm.map(c => `
      <div class="crm-card">
        <span class="muted">CRM</span><b>${esc(c.name)}</b>
        ${c.company ? `<span>${esc(c.company)}</span>` : ''}
        <span class="tag blue">${esc(c.inquiry_label || c.inquiry_type || 'Inquiry')}</span>
        <span class="tag">${esc(c.stage || 'new')}</span>
        ${c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>` : ''}
        <span class="muted">since ${fmtDate(c.created_at)}</span>
        <a href="/home/index.html" style="margin-left:auto">Open CRM →</a>
      </div>`).join('') : ''}
    <div id="messages"></div>
    <div class="reply-bar">
      <button class="btn" data-reply="reply">↩ Reply</button>
      <button class="btn" data-reply="reply_all">↩↩ Reply all</button>
      <button class="btn" data-reply="forward">↪ Forward</button>
    </div>
    <div class="notes">
      <h4>Internal notes · only visible to your team</h4>
      <div id="notes-list">${notes.map(renderNote).join('') || '<div class="note" style="color:#9b8a4f">No notes yet. Leave context for teammates here.</div>'}</div>
      <form class="note-form" id="note-form">
        <textarea id="note-input" placeholder="Add a note for the team…" maxlength="5000"></textarea>
        <button class="btn" type="submit">Add</button>
      </form>
    </div>`;

  const container = view.querySelector('#messages');
  messages.forEach((m, i) => {
    const expanded = i === lastIndex || m.status === 'failed' || m.status === 'scheduled' || (wasUnread && m.direction === 'in' && i >= lastIndex - 2);
    const el = renderMessage(m, !expanded);
    // A single message already has the reply bar right under it.
    if (messages.length === 1) el.querySelector('.msg-foot').remove();
    container.appendChild(el);
  });
  view.parentElement.scrollTop = 0;
}

function renderNote(n) {
  const mine = n.user_id === S.user.id;
  return `<div class="note" data-note="${esc(n.id)}">
    ${mine ? '<button class="del" data-del-note title="Delete note">✕</button>' : ''}
    <span class="who">${esc(n.user_name)}</span><span class="when">${fmtDate(n.created_at)}</span>
    <div class="note-body">${esc(n.body)}</div></div>`;
}

function recipientsLine(m) {
  const names = (list) => list.map(a => esc(a.name || a.email)).join(', ');
  const parts = [];
  if (m.to.length) parts.push(`to ${names(m.to)}`);
  if (m.cc.length) parts.push(`cc ${names(m.cc)}`);
  if (m.bcc.length) parts.push(`bcc ${names(m.bcc)}`);
  return parts.join(' · ');
}

function renderMessage(m, collapsed) {
  const el = document.createElement('article');
  el.className = 'msg' + (collapsed ? ' collapsed' : '');
  el.dataset.msg = m.id;
  const out = m.direction === 'out';
  const fromName = out ? `${m.sentBy || m.from.name}` : (m.from.name || m.from.email);
  const files = m.attachments.filter(a => !a.inline || !m.html.includes(a.id));
  const snippet = htmlText(m.html).slice(0, 180) || String(m.text || '').slice(0, 180);
  el.innerHTML = `
    <div class="msg-head" data-toggle>
      <div class="avatar ${out ? 'out' : ''}">${esc(initials(fromName))}</div>
      <div class="msg-who">
        <div class="msg-from">${esc(fromName)}<span class="addr">${out ? `via ${esc(m.from.email)}` : `&lt;${esc(m.from.email)}&gt;`}</span></div>
        <div class="msg-to">${recipientsLine(m)}</div>
        <div class="msg-snip">${esc(snippet)}</div>
      </div>
      <div class="msg-date">${m.attachments.length ? '📎' : ''}${m.status === 'scheduled' ? '<span class="tag blue">Scheduled</span>' : ''}${m.status === 'failed' ? '<span class="tag red">Failed</span>' : ''}<span title="${esc(fmtFull(m.createdAt))}">${esc(fmtFull(m.createdAt).replace(/ \(.*\)$/, ''))}</span></div>
    </div>
    ${m.status === 'failed' ? `<div class="msg-status failed">⚠ Not sent: ${esc(m.error || 'unknown error')}<button class="btn" data-retry>Retry</button><button class="btn" data-unsend>Edit as draft</button></div>` : ''}
    ${m.status === 'scheduled' ? `<div class="msg-status scheduled">🕓 Scheduled to send ${esc(fmtFull(m.scheduledAt).replace(/ \(.*\)$/, ''))}<button class="btn" data-unsend>Cancel &amp; edit</button></div>` : ''}
    <div class="msg-body"></div>
    <div class="msg-foot">
      <button class="btn" data-reply="reply">↩ Reply</button>
      <button class="btn" data-reply="reply_all">↩↩ Reply all</button>
      <button class="btn" data-reply="forward">↪ Forward</button>
    </div>`;
  const body = el.querySelector('.msg-body');
  const renderBody = () => {
    if (body.dataset.rendered) return;
    body.dataset.rendered = '1';
    if (m.html && m.html.trim()) renderFrame(body, m.html);
    else body.innerHTML = `<div class="msg-text">${textToHtml(m.text)}</div>`;
    if (files.length) {
      const list = document.createElement('div');
      list.className = 'att-list';
      list.innerHTML = files.map(attachmentChip).join('');
      body.appendChild(list);
    }
  };
  if (!collapsed) renderBody();
  el.querySelector('[data-toggle]').addEventListener('click', () => {
    el.classList.toggle('collapsed');
    if (!el.classList.contains('collapsed')) renderBody();
  });
  el._message = m;
  return el;
}

function attachmentChip(a, removable) {
  const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(a.contentType);
  const ext = (a.filename.split('.').pop() || 'file').slice(0, 4).toUpperCase();
  const href = a.url ? fileUrl(a.url) : '';
  return `<a class="att ${a.uploading ? 'uploading' : ''}" ${href ? `href="${esc(href)}" target="_blank" rel="noopener"` : ''} data-att="${esc(a.id || '')}" title="${esc(a.filename)}">
    <span class="att-thumb">${isImage && href ? `<img src="${esc(href)}" alt="" loading="lazy">` : esc(ext)}</span>
    <span style="min-width:0"><div class="att-name">${esc(a.filename)}</div><div class="att-size">${a.uploading ? 'Uploading…' : fmtSize(a.size)}</div></span>
    ${removable ? '<button class="x" data-remove-att title="Remove">✕</button>' : ''}
  </a>`;
}

const QUOTE_SELECTORS = '.gmail_quote, .edgeform-quote, blockquote[type="cite"], .yahoo_quoted, #divRplyFwdMsg, #appendonsend';

function renderFrame(container, html) {
  const iframe = document.createElement('iframe');
  iframe.className = 'msg-frame';
  iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  const absolute = html.replace(/(src|href)=(["'])\/api\/mail\/files\//g, `$1=$2${CRM_API}/api/mail/files/`);
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
    <base target="_blank">
    <style>html,body{margin:0;padding:0;background:#fff}body{font:14px/1.55 Arial,Helvetica,sans-serif;color:#111;word-wrap:break-word;overflow-wrap:anywhere;overflow-y:hidden}
    img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#1d4ed8}
    blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex}</style></head><body>${absolute}</body></html>`;
  container.appendChild(iframe);
  const resize = () => {
    const doc = iframe.contentDocument;
    if (!doc?.body) return;
    iframe.style.height = '0px';
    iframe.style.height = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight) + 'px';
  };
  iframe.addEventListener('load', () => {
    const doc = iframe.contentDocument;
    if (!doc) return;
    const quotes = [...doc.querySelectorAll(QUOTE_SELECTORS)].filter(q => !q.parentElement.closest(QUOTE_SELECTORS));
    const bodyText = doc.body.textContent.trim().length;
    const quoteText = quotes.reduce((n, q) => n + q.textContent.trim().length, 0);
    if (quotes.length && quoteText < bodyText) {
      quotes.forEach(q => { q.style.display = 'none'; });
      const btn = document.createElement('button');
      btn.className = 'quote-toggle';
      btn.textContent = '•••';
      btn.title = 'Show trimmed content';
      btn.onclick = (e) => {
        e.stopPropagation();
        const hidden = quotes[0].style.display === 'none';
        quotes.forEach(q => { q.style.display = hidden ? '' : 'none'; });
        resize();
      };
      iframe.after(btn);
    }
    resize();
    doc.querySelectorAll('img').forEach(img => img.addEventListener('load', resize));
    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(doc.body);
  });
}

async function threadAction(action) {
  if (!S.thread) return;
  const t = S.thread.thread;
  try {
    if (action === 'back') { closeThread(); return; }
    if (action === 'print') { window.print(); return; }
    if (action === 'star') {
      await api(`/api/mail/${S.box}/threads/${t.id}`, { method: 'PATCH', body: JSON.stringify({ starred: !t.starred }) });
      t.starred = t.starred ? 0 : 1;
      const row = S.threads.find(r => r.id === t.id);
      if (row) row.starred = t.starred;
      renderThread(S.thread);
      renderList();
      return;
    }
    if (action === 'unread') {
      await api(`/api/mail/${S.box}/threads/${t.id}`, { method: 'PATCH', body: JSON.stringify({ unread: true }) });
      const row = S.threads.find(r => r.id === t.id);
      if (row) row.unread = 1;
      closeThread();
      renderList();
      loadCounts();
      poll();
      return;
    }
    await bulkAction(action, [t.id]);
  } catch (error) {
    toast(error.message, { error: true });
  }
}

// ─── Reply / forward ──────────────────────────────────────────

function quoteBlock(m, forward) {
  const from = m.direction === 'out' ? `${m.sentBy} &lt;${esc(m.from.email)}&gt;` : `${esc(m.from.name || '')} &lt;${esc(m.from.email)}&gt;`;
  const content = m.html && m.html.trim() ? sanitize(m.html) : textToHtml(m.text);
  const date = new Date(m.createdAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (forward) {
    return `<div><br></div><div class="edgeform-quote">---------- Forwarded message ---------<br>From: ${from}<br>Date: ${esc(date)}<br>Subject: ${esc(m.subject)}<br>To: ${esc(m.to.map(formatAddr).join(', '))}<br>${m.cc.length ? `Cc: ${esc(m.cc.map(formatAddr).join(', '))}<br>` : ''}<br>${content}</div>`;
  }
  return `<div><br></div><div class="edgeform-quote"><div>On ${esc(date)}, ${from} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${content}</blockquote></div>`;
}

async function startReply(mode, messageId) {
  if (!S.thread) return;
  const { thread, messages } = S.thread;
  const sendable = messages.filter(m => m.status !== 'scheduled' && m.status !== 'canceled');
  const m = messages.find(x => x.id === messageId) || [...sendable].reverse().find(x => x.direction === 'in') || sendable[sendable.length - 1];
  if (!m) return;
  const base = thread.subject || m.subject || '';
  let subject;
  let to = [];
  let cc = [];
  if (mode === 'forward') {
    subject = /^fwd?:/i.test(base) ? base : `Fwd: ${base}`;
  } else {
    subject = /^re:/i.test(base) ? base : `Re: ${base}`;
    if (m.direction === 'in') to = [m.replyTo && !isOurs(m.replyTo) ? parseAddress(m.replyTo) : m.from];
    else to = m.to.filter(a => !isOurs(a.email));
    if (mode === 'reply_all') {
      const seen = new Set(to.map(a => a.email));
      const extra = (m.direction === 'in' ? [...m.to, ...m.cc] : m.cc).filter(a => !isOurs(a.email) && !seen.has(a.email) && seen.add(a.email));
      cc = extra;
    }
  }
  await openComposer({
    threadId: mode === 'forward' ? null : thread.id, mode, to, cc, subject, html: quoteBlock(m, mode === 'forward'),
    forwardFrom: mode === 'forward' ? m.attachments.filter(a => !a.inline).map(a => a.id) : [], focusBody: mode !== 'forward'
  });
}

// ─── Composer ─────────────────────────────────────────────────

const C = {
  open: false, box: null, draftId: null, threadId: null, mode: 'new', to: [], cc: [], bcc: [], attachments: [],
  dirty: false, dirtyContent: false, saving: null, lastHash: '', savedAt: null, pendingSize: null, range: null, sending: false
};

function composerHash() {
  return JSON.stringify([C.box, C.to, C.cc, C.bcc, $('c-subject').value, $('editor').innerHTML, C.threadId, C.mode]);
}

function hasContent() {
  return C.to.length || C.cc.length || C.bcc.length || $('c-subject').value.trim() || htmlText($('editor').innerHTML) || C.attachments.length;
}

async function openComposer(opts = {}) {
  if (C.open) {
    if (hasContent()) await saveDraft({ force: true });
  }
  const composer = $('composer');
  C.open = true;
  C.box = opts.box || S.box;
  C.draftId = opts.draftId || null;
  C.threadId = opts.threadId || null;
  C.mode = opts.mode || 'new';
  C.to = (opts.to || []).map(a => typeof a === 'string' ? parseAddress(a) : a);
  C.cc = opts.cc || [];
  C.bcc = opts.bcc || [];
  C.attachments = (opts.attachments || []).map(a => ({ ...a }));
  C.savedAt = null;
  C.pendingSize = null;

  $('c-from').innerHTML = S.boxes.map(b => `<option value="${b.key}" ${b.key === C.box ? 'selected' : ''}>${esc(S.user.name)} &lt;${esc(b.address)}&gt;</option>`).join('');
  $('c-from').disabled = !!C.threadId;
  $('c-subject').value = opts.subject || '';
  const editor = $('editor');
  editor.style.fontFamily = prefs.font;
  editor.style.fontSize = `${prefs.size}px`;
  editor.innerHTML = opts.html ? sanitize(opts.html) : '';
  editor.dataset.placeholder = 'Write your message…';
  $('c-cc-row').hidden = !C.cc.length;
  $('c-bcc-row').hidden = !C.bcc.length;
  $('t-font').value = prefs.font;
  $('t-size').value = String(prefs.size);
  renderChips();
  renderAttachments();
  composer.hidden = false;
  composer.classList.remove('min');
  updateComposerTitle();
  $('composer-saved').textContent = opts.draftId ? 'Draft' : '';
  $('foot-note').textContent = '';
  loadSignature(C.box);

  C.lastHash = composerHash();
  C.dirty = false;
  C.dirtyContent = false;

  if (opts.forwardFrom?.length) {
    await saveDraft({ force: true });
    try {
      const r = await api(`/api/mail/${C.box}/uploads/copy`, { method: 'POST', body: JSON.stringify({ ids: opts.forwardFrom, draftId: C.draftId }) });
      C.attachments.push(...r.attachments);
      renderAttachments();
    } catch (error) { toast(`Couldn't include attachments: ${error.message}`, { error: true }); }
  }

  if (opts.focusBody || C.to.length) {
    editor.focus();
    const sel = getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(editor, 0);
    range.collapse(true);
    sel.addRange(range);
  } else {
    $('c-to').querySelector('input')?.focus();
  }
}

function updateComposerTitle() {
  const subject = $('c-subject').value.trim();
  const label = { reply: 'Reply', reply_all: 'Reply all', forward: 'Forward', new: 'New message' }[C.mode];
  $('composer-title').textContent = subject ? `${label} · ${subject}` : label;
}

async function loadSignature(boxKey) {
  const preview = $('sig-preview');
  if (!S.signatures[boxKey]) {
    preview.innerHTML = '';
    try { S.signatures[boxKey] = (await api(`/api/mail/${boxKey}/signature`)).html; } catch { return; }
  }
  if (C.box === boxKey) preview.innerHTML = S.signatures[boxKey];
}

function setComposerBox(key) {
  if (C.attachments.length) {
    toast('Remove attachments before switching the sending inbox.', { error: true });
    $('c-from').value = C.box;
    return;
  }
  const oldDraft = C.draftId;
  const oldBox = C.box;
  C.box = key;
  $('c-from').value = key;
  loadSignature(key);
  if (oldDraft) {
    C.draftId = null;
    api(`/api/mail/${oldBox}/drafts/${oldDraft}`, { method: 'DELETE' }).catch(() => {});
  }
  markDirty();
}

function markDirty(content = true) {
  C.dirty = true;
  if (content) C.dirtyContent = true;
  scheduleSave();
}

const scheduleSave = debounce(() => saveDraft(), 1500);

async function saveDraft({ force = false } = {}) {
  if (!C.open) return;
  const hash = composerHash();
  if (!force && hash === C.lastHash) return;
  if (!C.draftId && !hasContent()) return;
  if (C.saving) { await C.saving; if (composerHash() === C.lastHash && C.draftId) return; }
  const payload = {
    id: C.draftId, threadId: C.threadId, mode: C.mode, to: C.to, cc: C.cc, bcc: C.bcc,
    subject: $('c-subject').value, html: $('editor').innerHTML
  };
  const box = C.box;
  C.saving = (async () => {
    try {
      $('composer-saved').textContent = 'Saving…';
      const r = await api(`/api/mail/${box}/drafts`, { method: 'POST', body: JSON.stringify(payload) });
      if (C.box === box) C.draftId = r.id;
      C.lastHash = hash;
      C.dirty = false;
      $('composer-saved').textContent = `Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      if (S.folder === 'drafts') loadThreads({ silent: true });
    } catch (error) {
      $('composer-saved').textContent = 'Not saved';
      if (error.status !== 401) console.warn('draft save failed', error);
    } finally {
      C.saving = null;
    }
  })();
  await C.saving;
  loadCounts();
}

async function closeComposer({ save = true } = {}) {
  if (save && C.open && hasContent()) {
    await saveDraft({ force: C.dirty });
    toast('Draft saved');
  }
  C.open = false;
  $('composer').hidden = true;
  $('composer').classList.remove('max', 'min');
  hideMenus();
  hideSuggest();
}

async function discardComposer() {
  if (hasContent() && !confirm('Discard this draft?')) return;
  const { draftId, box, attachments } = C;
  await closeComposer({ save: false });
  try {
    if (draftId) await api(`/api/mail/${box}/drafts/${draftId}`, { method: 'DELETE' });
    else for (const a of attachments) if (a.id) api(`/api/mail/${box}/uploads/${a.id}`, { method: 'DELETE' }).catch(() => {});
  } catch {}
  toast('Draft discarded');
  loadCounts();
  if (S.folder === 'drafts') loadThreads({ silent: true });
}

// Recipients -------------------------------------------------

function renderChips() {
  for (const field of ['to', 'cc', 'bcc']) {
    const wrap = $(`c-${field}`);
    const typed = wrap.querySelector('input')?.value || '';
    wrap.innerHTML = C[field].map((a, i) => `
      <span class="chip ${isEmail(a.email) ? '' : 'bad'}" title="${esc(a.email)}">
        <span>${esc(a.name || a.email)}</span><button type="button" data-remove-chip="${i}" aria-label="Remove">✕</button>
      </span>`).join('') + `<input type="text" autocomplete="off" data-chip-input="${field}" value="${esc(typed)}">`;
  }
}

function commitChipInput(input) {
  const field = input.dataset.chipInput;
  const parsed = splitAddresses(input.value);
  if (!parsed.length) return false;
  const existing = new Set(C[field].map(a => a.email));
  for (const a of parsed) if (!existing.has(a.email)) { C[field].push(a); existing.add(a.email); }
  input.value = '';
  renderChips();
  $(`c-${field}`).querySelector('input').focus();
  markDirty();
  return true;
}

let suggestState = { input: null, items: [], index: 0 };

const lookupContacts = debounce(async (input) => {
  const q = input.value.trim();
  if (q.length < 2 || document.activeElement !== input) { hideSuggest(); return; }
  try {
    const r = await api(`/api/mail/contacts?q=${encodeURIComponent(q)}`);
    if (document.activeElement !== input || input.value.trim() !== q) return;
    const teamHits = S.team.filter(u => (u.name + u.email).toLowerCase().includes(q.toLowerCase())).map(u => ({ name: u.name, email: u.email }));
    const seen = new Set();
    const items = [...r.contacts, ...teamHits].filter(c => c.email && !seen.has(c.email) && seen.add(c.email)).slice(0, 8);
    showSuggest(input, items);
  } catch { hideSuggest(); }
}, 180);

function showSuggest(input, items) {
  const box = $('suggest');
  if (!items.length) { hideSuggest(); return; }
  suggestState = { input, items, index: 0 };
  const rect = input.getBoundingClientRect();
  box.style.left = `${Math.min(rect.left, innerWidth - 300)}px`;
  box.style.top = `${rect.bottom + 4}px`;
  box.innerHTML = items.map((c, i) => `<div class="suggest-item ${i === 0 ? 'active' : ''}" data-i="${i}"><div class="n">${esc(c.name || c.email)}</div><div class="e">${esc(c.email)}</div></div>`).join('');
  box.hidden = false;
}

function hideSuggest() { $('suggest').hidden = true; suggestState = { input: null, items: [], index: 0 }; }

function pickSuggest(i) {
  const { input, items } = suggestState;
  const item = items[i];
  if (!input || !item) return;
  const field = input.dataset.chipInput;
  if (!C[field].some(a => a.email === item.email)) C[field].push({ name: item.name || '', email: item.email });
  input.value = '';
  hideSuggest();
  renderChips();
  $(`c-${field}`).querySelector('input').focus();
  markDirty();
}

// Attachments ------------------------------------------------

function renderAttachments() {
  $('c-attachments').innerHTML = C.attachments.filter(a => !a.inline).map(a => attachmentChip(a, true)).join('');
}

async function ensureDraft() {
  if (!C.draftId) await saveDraft({ force: true });
  if (!C.draftId) {
    // Nothing typed yet; create an empty draft so uploads have a home.
    const r = await api(`/api/mail/${C.box}/drafts`, { method: 'POST', body: JSON.stringify({ threadId: C.threadId, mode: C.mode, subject: $('c-subject').value, html: $('editor').innerHTML }) });
    C.draftId = r.id;
  }
  return C.draftId;
}

async function uploadFiles(files, { inline = false } = {}) {
  const list = [...files];
  if (!list.length) return [];
  try { await ensureDraft(); } catch (error) { toast(error.message, { error: true }); return []; }
  const results = [];
  for (const file of list) {
    if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is over 20MB. Share a link instead.`, { error: true }); continue; }
    const temp = { tempId: Math.random().toString(36).slice(2), filename: file.name, size: file.size, contentType: file.type, uploading: true, inline };
    C.attachments.push(temp);
    renderAttachments();
    try {
      const qs = new URLSearchParams({ filename: file.name, draftId: C.draftId });
      if (inline) qs.set('inline', '1');
      const r = await api(`/api/mail/${C.box}/uploads?${qs}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      Object.assign(temp, r.attachment, { uploading: false });
      results.push(temp);
    } catch (error) {
      C.attachments = C.attachments.filter(a => a !== temp);
      toast(`${file.name}: ${error.message}`, { error: true });
    }
    renderAttachments();
  }
  markDirty(false);
  return results;
}

async function removeAttachment(id) {
  const a = C.attachments.find(x => x.id === id);
  if (!a) return;
  C.attachments = C.attachments.filter(x => x !== a);
  renderAttachments();
  api(`/api/mail/${C.box}/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
}

// Editor -----------------------------------------------------

function saveRange() {
  const sel = getSelection();
  if (sel.rangeCount && $('editor').contains(sel.anchorNode)) C.range = sel.getRangeAt(0).cloneRange();
}

function restoreRange() {
  const editor = $('editor');
  editor.focus();
  if (C.range && editor.contains(C.range.startContainer)) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(C.range);
  }
}

function applyFontSize(px) {
  restoreRange();
  C.pendingSize = px;
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontSize', false, '7');
  convertFontTags();
  $('t-size').value = String(px);
  markDirty();
}

// execCommand only knows sizes 1-7; swap the size-7 <font> it creates for a real pixel size.
function convertFontTags() {
  const editor = $('editor');
  editor.querySelectorAll('font[size="7"]').forEach(font => {
    const span = document.createElement('span');
    span.style.fontSize = `${C.pendingSize || prefs.size}px`;
    if (font.getAttribute('face')) span.style.fontFamily = font.getAttribute('face');
    if (font.getAttribute('color')) span.style.color = font.getAttribute('color');
    span.append(...font.childNodes);
    font.replaceWith(span);
    span.querySelectorAll('span[style*="font-size"]').forEach(inner => { inner.style.fontSize = ''; if (!inner.getAttribute('style')) inner.replaceWith(...inner.childNodes); });
  });
}

function currentFontSize() {
  const sel = getSelection();
  let node = sel.anchorNode;
  if (!node || !$('editor').contains(node)) return prefs.size;
  if (node.nodeType === 3) node = node.parentElement;
  return Math.round(parseFloat(getComputedStyle(node).fontSize)) || prefs.size;
}

function execCmd(cmd, button) {
  const editor = $('editor');
  restoreRange();
  switch (cmd) {
    case 'fontStep': {
      const current = currentFontSize();
      const step = Number(button.dataset.step);
      const next = step > 0 ? FONT_SIZES.find(s => s > current) || FONT_SIZES[FONT_SIZES.length - 1] : [...FONT_SIZES].reverse().find(s => s < current) || FONT_SIZES[0];
      applyFontSize(next);
      return;
    }
    case 'link': {
      const sel = getSelection();
      const existing = sel.anchorNode?.parentElement?.closest('a')?.getAttribute('href') || '';
      let url = prompt('Link address (https://…, mailto:, or tel:)', existing || 'https://');
      if (!url || url === 'https://') return;
      url = url.trim();
      if (!/^(https?:|mailto:|tel:|sms:)/i.test(url)) url = isEmail(url) ? `mailto:${url}` : `https://${url}`;
      restoreRange();
      if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url.replace(/^mailto:/, ''))}</a>`);
      else document.execCommand('createLink', false, url);
      editor.querySelectorAll('a:not([target])').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
      break;
    }
    case 'image': $('image-input').click(); return;
    case 'blockquote': {
      const inQuote = getSelection().anchorNode?.parentElement?.closest('blockquote');
      document.execCommand('formatBlock', false, inQuote ? 'div' : 'blockquote');
      break;
    }
    case 'removeFormat':
      document.execCommand('removeFormat');
      document.execCommand('unlink');
      break;
    default:
      document.execCommand('styleWithCSS', false, ['foreColor', 'hiliteColor', 'fontName'].includes(cmd));
      document.execCommand(cmd, false, null);
  }
  updateToolbarState();
  markDirty();
}

function updateToolbarState() {
  const editor = $('editor');
  const sel = getSelection();
  if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;
  for (const btn of $('toolbar').querySelectorAll('button[data-cmd]')) {
    const cmd = btn.dataset.cmd;
    if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'justifyCenter', 'justifyRight'].includes(cmd)) {
      try { btn.classList.toggle('on', document.queryCommandState(cmd)); } catch {}
    }
  }
  const size = currentFontSize();
  const sizeSelect = $('t-size');
  if (![...sizeSelect.options].some(o => o.value === String(size))) {
    sizeSelect.querySelector('option[data-custom]')?.remove();
    const opt = new Option(String(size), String(size));
    opt.dataset.custom = '1';
    sizeSelect.add(opt);
  }
  sizeSelect.value = String(size);
  let node = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
  const family = getComputedStyle(node).fontFamily.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
  const match = [...$('t-font').options].find(o => o.value.split(',')[0].replace(/['"]/g, '').trim().toLowerCase() === family);
  if (match) $('t-font').value = match.value;
}

// Send -------------------------------------------------------

function composeSnapshot() {
  return {
    box: C.box, draftId: C.draftId, threadId: C.threadId, mode: C.mode, to: [...C.to], cc: [...C.cc], bcc: [...C.bcc],
    subject: $('c-subject').value, html: $('editor').innerHTML, attachments: C.attachments.filter(a => !a.uploading)
  };
}

function wrapBody(html) {
  const editor = $('editor');
  return `<div style="font-family:${esc(editor.style.fontFamily || prefs.font)};font-size:${esc(editor.style.fontSize || prefs.size + 'px')};line-height:1.5;color:#111111;">${html}</div>`;
}

async function send({ scheduledAt } = {}) {
  if (C.sending) return;
  for (const input of document.querySelectorAll('[data-chip-input]')) if (input.value.trim()) commitChipInput(input);
  const all = [...C.to, ...C.cc, ...C.bcc];
  if (!all.length) { toast('Add at least one recipient.', { error: true }); $('c-to').querySelector('input').focus(); return; }
  const bad = all.find(a => !isEmail(a.email));
  if (bad) { toast(`"${bad.email}" isn't a valid email address.`, { error: true }); return; }
  if (C.attachments.some(a => a.uploading)) { toast('Wait for attachments to finish uploading.', { error: true }); return; }
  let subject = $('c-subject').value.trim();
  if (!subject) {
    if (!confirm('Send this message without a subject?')) { $('c-subject').focus(); return; }
    subject = '(no subject)';
    $('c-subject').value = subject;
  }
  const editor = $('editor');
  const ownText = htmlText(editor.innerHTML.split('<div class="edgeform-quote">')[0]);
  if (/\battach(ed|ment|ing)?\b/i.test(ownText) && !C.attachments.some(a => !a.inline) && !confirm('You mentioned an attachment but nothing is attached. Send anyway?')) return;
  if (!ownText && !C.attachments.length && !editor.querySelector('img') && !confirm('Your message is empty. Send anyway?')) return;

  C.sending = true;
  $('send-btn').disabled = true;
  await saveDraft({ force: true }).catch(() => {});
  const snap = composeSnapshot();
  const html = editor.innerHTML;
  const inlineUsed = snap.attachments.filter(a => !a.inline || html.includes(a.id));
  const payload = {
    to: snap.to, cc: snap.cc, bcc: snap.bcc, subject, html: wrapBody(html), threadId: snap.threadId, draftId: snap.draftId,
    attachmentIds: inlineUsed.map(a => a.id), scheduledAt
  };
  C.sending = false;
  $('send-btn').disabled = false;
  await closeComposer({ save: false });

  const deliver = async () => {
    const pending = scheduledAt ? null : toast('Sending…', { duration: 0 });
    try {
      const r = await api(`/api/mail/${snap.box}/send`, { method: 'POST', body: JSON.stringify(payload) });
      pending?.close();
      if (r.status === 'scheduled') toast(`Scheduled for ${new Date(r.scheduledAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
      else toast('Message sent', { actionLabel: 'View', action: () => viewSent(snap.box, r.threadId) });
      if (S.box === snap.box) {
        if (S.openId && S.openId === r.threadId) openThread(r.threadId, { keepScroll: true });
        loadThreads({ silent: true });
        loadCounts();
      }
    } catch (error) {
      pending?.close();
      if (error.status === 502) {
        toast(error.message, { error: true, duration: 9000, actionLabel: 'Open', action: () => viewSent(snap.box, null) });
        loadThreads({ silent: true });
      } else {
        toast(`Not sent: ${error.message}`, { error: true, duration: 8000 });
        openComposer(snap);
      }
    }
  };

  if (scheduledAt || !prefs.undoSeconds) { deliver(); return; }
  let canceled = false;
  const t = toast(`Sending in ${prefs.undoSeconds}s…`, { duration: 0, actionLabel: 'Undo', action: () => { canceled = true; openComposer(snap); } });
  let left = prefs.undoSeconds;
  const tick = setInterval(() => {
    left--;
    if (canceled) { clearInterval(tick); return; }
    if (left > 0) { t.el.querySelector('span').textContent = `Sending in ${left}s…`; return; }
    clearInterval(tick);
    t.close();
    deliver();
  }, 1000);
}

function viewSent(box, threadId) {
  if (box !== S.box) switchBox(box);
  if (S.folder !== 'sent') switchFolder('sent');
  if (threadId) setTimeout(() => openThread(threadId), 400);
}

// Menus -------------------------------------------------------

function hideMenus() { $('schedule-menu').hidden = true; $('template-menu').hidden = true; }

function nextAt(days, hour, weekday) {
  const d = new Date();
  if (weekday !== undefined) d.setDate(d.getDate() + ((7 + weekday - d.getDay()) % 7 || 7));
  else d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function toggleScheduleMenu() {
  const menu = $('schedule-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  hideMenus();
  const opts = [
    ['Tomorrow morning', nextAt(1, 8)],
    ['Tomorrow afternoon', nextAt(1, 13)],
    ['Monday morning', nextAt(0, 8, 1)]
  ];
  const local = new Date(Date.now() + 3600000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  menu.innerHTML = `<div class="menu-label">Schedule send</div>` +
    opts.map(([label, d]) => `<button class="menu-item" data-schedule="${d.toISOString()}">${label}<small>${d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small></button>`).join('') +
    `<div class="menu-sep"></div><div class="menu-label">Pick date & time</div>
     <div style="padding:0 10px 6px"><input type="datetime-local" id="schedule-custom" value="${local}"><button class="btn primary" style="width:100%" id="schedule-custom-go">Schedule send</button></div>`;
  menu.hidden = false;
  $('schedule-custom-go').onclick = () => {
    const v = $('schedule-custom').value;
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 60000) { toast('Pick a time at least a minute from now.', { error: true }); return; }
    hideMenus();
    send({ scheduledAt: d.toISOString() });
  };
}

async function loadTemplates(force) {
  if (S.templates && !force) return S.templates;
  S.templates = (await api('/api/mail/templates')).templates;
  return S.templates;
}

async function toggleTemplateMenu() {
  const menu = $('template-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  hideMenus();
  menu.innerHTML = '<div class="menu-label">Loading…</div>';
  menu.hidden = false;
  try {
    const list = await loadTemplates(true);
    menu.innerHTML = `<div class="menu-label">Insert template</div>` +
      (list.length ? list.map(t => `<button class="menu-item" data-template="${esc(t.id)}">${esc(t.name)}<small>${esc(t.created_by_name.split(' ')[0] || '')}</small></button>`).join('') : '<div class="menu-label" style="text-transform:none;letter-spacing:0">No templates yet</div>') +
      `<div class="menu-sep"></div><button class="menu-item" data-template-save>Save this message as a template</button><button class="menu-item" data-template-manage>Manage templates…</button>`;
  } catch (error) {
    menu.innerHTML = `<div class="menu-label">${esc(error.message)}</div>`;
  }
}

function insertTemplate(id) {
  const t = S.templates?.find(x => x.id === id);
  if (!t) return;
  hideMenus();
  if (t.subject && !$('c-subject').value.trim()) $('c-subject').value = t.subject;
  const firstName = (C.to[0]?.name || '').split(' ')[0];
  const html = sanitize(t.html)
    .replace(/\{\{\s*first_name\s*\}\}/gi, esc(firstName || 'there'))
    .replace(/\{\{\s*my_name\s*\}\}/gi, esc(S.user.name));
  restoreRange();
  document.execCommand('insertHTML', false, html);
  updateComposerTitle();
  markDirty();
}

async function saveAsTemplate() {
  hideMenus();
  const name = prompt('Template name');
  if (!name) return;
  const quoteAt = $('editor').innerHTML.indexOf('<div class="edgeform-quote">');
  const html = quoteAt === -1 ? $('editor').innerHTML : $('editor').innerHTML.slice(0, quoteAt);
  try {
    await api('/api/mail/templates', { method: 'POST', body: JSON.stringify({ name, subject: $('c-subject').value.replace(/^(re|fwd?):\s*/i, ''), html }) });
    S.templates = null;
    toast(`Template "${name}" saved`);
  } catch (error) { toast(error.message, { error: true }); }
}

// ─── Settings, setup, help ────────────────────────────────────

async function showSettings(tab) {
  const fontOptions = [...$('t-font').options].map(o => `<option value="${esc(o.value)}" ${o.value === prefs.font ? 'selected' : ''}>${esc(o.textContent)}</option>`).join('');
  const sizeOptions = FONT_SIZES.map(s => `<option ${s === prefs.size ? 'selected' : ''}>${s}</option>`).join('');
  const modal = openModal('Mail settings', `
    <h4>Your signature</h4>
    <div class="row">
      <div class="field"><label>Name</label><input value="${esc(S.user.name)}" disabled title="Your name comes from your CRM account"></div>
      <div class="field"><label>Job title (optional)</label><input id="set-title" maxlength="80" value="${esc(S.user.title || '')}" placeholder="e.g. Account Manager"></div>
      <button class="btn primary" id="set-title-save" style="margin-bottom:12px">Save</button>
    </div>
    <div class="sig-box" id="set-sig">${S.signatures[S.box] || ''}</div>
    <p style="font-size:12px;color:var(--text-muted);margin:8px 0 0">Added automatically to every email you send. Replies go back to the inbox you sent from.</p>

    <h4>Composing</h4>
    <div class="row">
      <div class="field"><label>Default font</label><select id="set-font">${fontOptions}</select></div>
      <div class="field"><label>Default size</label><select id="set-size">${sizeOptions}</select></div>
      <div class="field"><label>Undo send window</label><select id="set-undo">
        ${[0, 5, 10, 20, 30].map(n => `<option value="${n}" ${n === prefs.undoSeconds ? 'selected' : ''}>${n ? `${n} seconds` : 'Off'}</option>`).join('')}
      </select></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;font-size:13.5px"><input type="checkbox" id="set-notify" ${prefs.notify ? 'checked' : ''}> Desktop notifications for new mail</label>

    <h4 id="tpl-heading">Templates</h4>
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Shared with the whole team. Use <code>{{first_name}}</code> and <code>{{my_name}}</code> as placeholders.</p>
    <div id="tpl-list"></div>
    <div id="tpl-form" style="margin-top:12px">
      <input type="hidden" id="tpl-id">
      <div class="row">
        <div class="field"><label>Template name</label><input id="tpl-name" maxlength="80"></div>
        <div class="field"><label>Subject (optional)</label><input id="tpl-subject" maxlength="300"></div>
      </div>
      <div class="field"><label>Message</label><div class="tpl-editor" id="tpl-html" contenteditable="true"></div></div>
      <div style="display:flex;gap:8px"><button class="btn primary" id="tpl-save">Save template</button><button class="btn" id="tpl-reset">Clear</button></div>
    </div>`, { wide: true });

  if (!S.signatures[S.box]) loadSignature(S.box).then(() => { const el = $('set-sig'); if (el) el.innerHTML = S.signatures[S.box] || ''; });
  $('set-title-save').onclick = async () => {
    try {
      const r = await api('/api/mail/settings', { method: 'POST', body: JSON.stringify({ title: $('set-title').value }) });
      S.user.title = r.title;
      S.signatures = {};
      await loadSignature(S.box);
      $('set-sig').innerHTML = S.signatures[S.box] || '';
      if (C.open) loadSignature(C.box);
      toast('Signature updated');
    } catch (error) { toast(error.message, { error: true }); }
  };
  $('set-font').onchange = (e) => { prefs.font = e.target.value; savePrefs(); };
  $('set-size').onchange = (e) => { prefs.size = Number(e.target.value); savePrefs(); };
  $('set-undo').onchange = (e) => { prefs.undoSeconds = Number(e.target.value); savePrefs(); };
  $('set-notify').onchange = async (e) => {
    if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { e.target.checked = false; toast('Notifications are blocked in your browser settings.', { error: true }); }
    }
    prefs.notify = e.target.checked;
    savePrefs();
  };

  const renderTpls = async () => {
    const list = await loadTemplates(true).catch(() => []);
    $('tpl-list').innerHTML = list.length ? list.map(t => `
      <div class="tpl"><div class="grow"><b>${esc(t.name)}</b><div class="sub">${esc(t.subject || htmlText(t.html).slice(0, 90))}</div></div>
      <button class="btn" data-tpl-edit="${esc(t.id)}">Edit</button><button class="btn danger" data-tpl-del="${esc(t.id)}">Delete</button></div>`).join('')
      : '<div style="color:var(--text-muted);font-size:13px">No templates yet.</div>';
  };
  renderTpls();
  const resetForm = () => { $('tpl-id').value = ''; $('tpl-name').value = ''; $('tpl-subject').value = ''; $('tpl-html').innerHTML = ''; };
  $('tpl-reset').onclick = resetForm;
  $('tpl-save').onclick = async () => {
    try {
      await api('/api/mail/templates', { method: 'POST', body: JSON.stringify({ id: $('tpl-id').value || undefined, name: $('tpl-name').value, subject: $('tpl-subject').value, html: $('tpl-html').innerHTML }) });
      resetForm();
      renderTpls();
      toast('Template saved');
    } catch (error) { toast(error.message, { error: true }); }
  };
  modal.querySelector('.modal-body').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-tpl-edit]');
    const del = e.target.closest('[data-tpl-del]');
    if (edit) {
      const t = S.templates.find(x => x.id === edit.dataset.tplEdit);
      $('tpl-id').value = t.id; $('tpl-name').value = t.name; $('tpl-subject').value = t.subject; $('tpl-html').innerHTML = sanitize(t.html);
      $('tpl-name').focus();
    }
    if (del && confirm('Delete this template for everyone?')) {
      await api(`/api/mail/templates/${del.dataset.tplDel}`, { method: 'DELETE' }).catch(err => toast(err.message, { error: true }));
      renderTpls();
    }
  });
  if (tab === 'templates') setTimeout(() => $('tpl-heading').scrollIntoView({ behavior: 'smooth' }), 50);
}

function showSetup() {
  openModal('Connect email', `
    <p style="margin-top:0">The mailboxes are built. To start sending and receiving, finish these steps once:</p>
    <ol class="setup-steps">
      <li>In <b>Resend → Domains</b>, add <code>${MAIL_DOMAIN}</code> and add the DNS records it shows at your domain registrar.</li>
      <li>Create an API key in Resend and save it as the Worker secret <code>RESEND_API_KEY</code>.</li>
      <li>Turn on <b>receiving</b> for the domain in Resend and point the MX records it gives you at Resend.</li>
      <li>Optional, for instant delivery: add a Resend webhook for <code>email.received</code> pointing to <code>${CRM_API}/api/mail/webhook</code> and save its signing secret as <code>RESEND_WEBHOOK_SECRET</code>. Without it, new mail is still picked up every minute.</li>
    </ol>`);
}

function showHelp() {
  const keys = [
    ['c', 'Compose'], ['/', 'Search'], ['j / k', 'Next / previous conversation'], ['u or Esc', 'Back to list'],
    ['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'], ['e', 'Archive'], ['#', 'Delete'], ['!', 'Report spam'],
    ['s', 'Star'], ['Shift + U', 'Mark unread'], ['x', 'Select conversation'], ['g then i', 'Go to inbox'], ['g then s', 'Go to sent'],
    ['g then d', 'Go to drafts'], ['Ctrl + Enter', 'Send'], ['Ctrl + K', 'Insert link'], ['Ctrl + B / I / U', 'Bold / italic / underline'], ['?', 'This help']
  ];
  openModal('Keyboard shortcuts', `<div class="shortcuts">${keys.map(([k, v]) => `<div><span>${v}</span><kbd>${esc(k)}</kbd></div>`).join('')}</div>`);
}

// ─── Wiring ───────────────────────────────────────────────────

let gPending = false;

function moveSelection(delta) {
  if (!S.threads.length || S.folder === 'drafts') return;
  const i = S.threads.findIndex(t => t.id === S.openId);
  const next = S.threads[Math.min(S.threads.length - 1, Math.max(0, i === -1 ? 0 : i + delta))];
  if (next) {
    openThread(next.id);
    document.querySelector(`.t-row[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

function bindUi() {
  $('box-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-box]'); if (b) switchBox(b.dataset.box); });
  $('folders').addEventListener('click', (e) => { const f = e.target.closest('[data-folder]'); if (f) switchFolder(f.dataset.folder); });
  $('compose-btn').addEventListener('click', () => { document.body.classList.remove('rail-open'); openComposer(); });
  $('fab-compose').addEventListener('click', () => openComposer());
  $('rail-toggle').addEventListener('click', () => document.body.classList.toggle('rail-open'));
  $('rail-scrim').addEventListener('click', () => document.body.classList.remove('rail-open'));
  $('sync-btn').addEventListener('click', () => { S.lastSync = 0; syncNow(false); });
  $('settings-btn').addEventListener('click', () => showSettings());
  $('help-btn').addEventListener('click', showHelp);
  $('modal-scrim').addEventListener('click', closeModal);

  const runSearch = debounce(() => { S.q = $('search').value.trim(); closeThread(); loadThreads(); }, 350);
  $('search').addEventListener('input', runSearch);
  $('search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('search').value = ''; runSearch(); $('search').blur(); } });

  $('select-all').addEventListener('change', (e) => {
    S.selected = e.target.checked ? new Set(S.threads.map(t => t.id)) : new Set();
    renderList();
    renderBulk();
  });
  $('bulk').addEventListener('click', (e) => { const b = e.target.closest('[data-bulk]'); if (!b) return; const a = b.dataset.bulk; bulkAction(a); });
  $('empty-folder').addEventListener('click', async () => {
    if (!confirm(`Permanently delete everything in ${S.folder === 'trash' ? 'Trash' : 'Spam'}? This can't be undone.`)) return;
    try {
      const r = await api(`/api/mail/${S.box}/empty/${S.folder}`, { method: 'POST' });
      toast(`Deleted ${r.deleted} conversation${r.deleted === 1 ? '' : 's'}`);
      closeThread();
      loadThreads();
      loadCounts();
    } catch (error) { toast(error.message, { error: true }); }
  });

  $('thread-list').addEventListener('click', async (e) => {
    const draftRow = e.target.closest('[data-draft]');
    if (draftRow) {
      const d = S.drafts.find(x => x.id === draftRow.dataset.draft);
      if (!d) return;
      if (e.target.closest('[data-discard]')) {
        if (!confirm('Discard this draft?')) return;
        await api(`/api/mail/${S.box}/drafts/${d.id}`, { method: 'DELETE' }).catch(err => toast(err.message, { error: true }));
        if (C.draftId === d.id) closeComposer({ save: false });
        loadThreads({ silent: true }); loadCounts();
        return;
      }
      openComposer({ draftId: d.id, threadId: d.threadId, mode: d.mode, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, html: d.html, attachments: d.attachments });
      return;
    }
    const row = e.target.closest('.t-row[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    const t = S.threads.find(x => x.id === id);
    if (e.target.closest('[data-stop]')) {
      if (e.target.matches('input[data-select]')) {
        e.target.checked ? S.selected.add(id) : S.selected.delete(id);
        row.classList.toggle('selected', e.target.checked);
        renderBulk();
      }
      return;
    }
    if (e.target.closest('[data-star]')) {
      e.stopPropagation();
      const starred = !t.starred;
      t.starred = starred ? 1 : 0;
      renderList();
      api(`/api/mail/${S.box}/threads/${id}`, { method: 'PATCH', body: JSON.stringify({ starred }) }).catch(err => toast(err.message, { error: true }));
      if (S.openId === id && S.thread) { S.thread.thread.starred = t.starred; renderThread(S.thread); }
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'read' || act.dataset.act === 'unread') {
        t.unread = act.dataset.act === 'unread' ? 1 : 0;
        renderList();
        await api(`/api/mail/${S.box}/threads/bulk`, { method: 'POST', body: JSON.stringify({ ids: [id], action: act.dataset.act }) }).catch(err => toast(err.message, { error: true }));
        loadCounts(); poll();
      } else bulkAction(act.dataset.act, [id]);
      return;
    }
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
      renderList(); renderBulk();
      return;
    }
    openThread(id);
  });

  $('thread-view').addEventListener('click', async (e) => {
    const tv = e.target.closest('[data-tv]');
    if (tv) { threadAction(tv.dataset.tv); return; }
    const reply = e.target.closest('[data-reply]');
    if (reply) { startReply(reply.dataset.reply, reply.closest('[data-msg]')?.dataset.msg); return; }
    const msgEl = e.target.closest('[data-msg]');
    if (e.target.closest('[data-retry]') && msgEl) {
      e.target.disabled = true;
      try { await api(`/api/mail/${S.box}/messages/${msgEl.dataset.msg}/retry`, { method: 'POST' }); toast('Message sent'); }
      catch (error) { toast(error.message, { error: true }); }
      openThread(S.openId, { keepScroll: true });
      return;
    }
    if (e.target.closest('[data-unsend]') && msgEl) {
      try {
        const m = msgEl._message;
        const r = await api(`/api/mail/${S.box}/messages/${m.id}/unsend`, { method: 'POST' });
        const drafts = (await api(`/api/mail/${S.box}/drafts`)).drafts;
        const d = drafts.find(x => x.id === r.draftId);
        if (d) openComposer({ draftId: d.id, threadId: d.threadId, mode: d.mode, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, html: d.html, attachments: d.attachments });
        loadThreads({ silent: true }); loadCounts();
        if (d?.threadId) openThread(d.threadId, { keepScroll: true }); else closeThread();
      } catch (error) { toast(error.message, { error: true }); }
      return;
    }
    if (e.target.closest('[data-del-note]')) {
      const noteEl = e.target.closest('[data-note]');
      try {
        await api(`/api/mail/${S.box}/threads/${S.openId}/notes/${noteEl.dataset.note}`, { method: 'DELETE' });
        S.thread.notes = S.thread.notes.filter(n => n.id !== noteEl.dataset.note);
        noteEl.remove();
      } catch (error) { toast(error.message, { error: true }); }
    }
  });
  $('thread-view').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-tv-assign]') || !S.thread) return;
    const assignedTo = e.target.value || null;
    try {
      await api(`/api/mail/${S.box}/threads/${S.openId}`, { method: 'PATCH', body: JSON.stringify({ assignedTo }) });
      const user = S.team.find(u => u.id === assignedTo);
      S.thread.thread.assigned_to = assignedTo;
      S.thread.thread.assigned_name = user?.name || null;
      const row = S.threads.find(t => t.id === S.openId);
      if (row) row.assigned_name = user?.name || null;
      renderList();
      renderThread(S.thread);
      loadCounts();
      toast(user ? `Assigned to ${user.name}` : 'Unassigned');
    } catch (error) { toast(error.message, { error: true }); }
  });
  $('thread-view').addEventListener('submit', async (e) => {
    if (e.target.id !== 'note-form') return;
    e.preventDefault();
    const input = $('note-input');
    const body = input.value.trim();
    if (!body) return;
    try {
      const r = await api(`/api/mail/${S.box}/threads/${S.openId}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
      S.thread.notes.push(r.note);
      $('notes-list').innerHTML = S.thread.notes.map(renderNote).join('');
      input.value = '';
    } catch (error) { toast(error.message, { error: true }); }
  });
  $('thread-view').addEventListener('keydown', (e) => {
    if (e.target.id === 'note-input' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('note-form').requestSubmit(); }
  });

  // Composer
  $('composer-head').addEventListener('click', (e) => {
    if (e.target.closest('#composer-close')) { closeComposer(); return; }
    if (e.target.closest('#composer-max')) { $('composer').classList.toggle('max'); $('composer').classList.remove('min'); return; }
    if (e.target.closest('#composer-min') || $('composer').classList.contains('min')) { $('composer').classList.toggle('min'); $('composer').classList.remove('max'); }
  });
  $('c-from').addEventListener('change', (e) => setComposerBox(e.target.value));
  $('c-show-cc').addEventListener('click', () => { $('c-cc-row').hidden = false; $('c-bcc-row').hidden = false; $('c-cc').querySelector('input').focus(); });
  $('c-subject').addEventListener('input', () => { updateComposerTitle(); markDirty(); });

  const composerEl = $('composer');
  composerEl.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove-chip]');
    if (rm) {
      const field = rm.closest('[data-field]').dataset.field;
      C[field].splice(Number(rm.dataset.removeChip), 1);
      renderChips();
      markDirty();
      return;
    }
    const chips = e.target.closest('.chips');
    if (chips && e.target === chips) chips.querySelector('input').focus();
    const removeAtt = e.target.closest('[data-remove-att]');
    if (removeAtt) { e.preventDefault(); removeAttachment(removeAtt.closest('[data-att]').dataset.att); return; }
    const sched = e.target.closest('[data-schedule]');
    if (sched) { hideMenus(); send({ scheduledAt: sched.dataset.schedule }); return; }
    const tpl = e.target.closest('[data-template]');
    if (tpl) { insertTemplate(tpl.dataset.template); return; }
    if (e.target.closest('[data-template-save]')) { saveAsTemplate(); return; }
    if (e.target.closest('[data-template-manage]')) { hideMenus(); showSettings('templates'); }
  });
  composerEl.addEventListener('keydown', (e) => {
    const input = e.target.closest('[data-chip-input]');
    if (input) {
      if (!$('suggest').hidden && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        const n = suggestState.items.length;
        suggestState.index = (suggestState.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        $('suggest').querySelectorAll('.suggest-item').forEach((el, i) => el.classList.toggle('active', i === suggestState.index));
        return;
      }
      if (['Enter', 'Tab', ',', ';'].includes(e.key)) {
        if (!$('suggest').hidden && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); pickSuggest(suggestState.index); return; }
        if (input.value.trim()) { e.preventDefault(); commitChipInput(input); }
        return;
      }
      if (e.key === 'Backspace' && !input.value) {
        const field = input.dataset.chipInput;
        if (C[field].length) { C[field].pop(); renderChips(); $(`c-${field}`).querySelector('input').focus(); markDirty(); }
      }
      if (e.key === 'Escape') hideSuggest();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && !input) { e.preventDefault(); closeComposer(); }
  });
  composerEl.addEventListener('input', (e) => {
    const input = e.target.closest('[data-chip-input]');
    if (input) { lookupContacts(input); if (/[,;]\s*$/.test(input.value)) commitChipInput(input); }
  });
  composerEl.addEventListener('focusout', (e) => {
    const input = e.target.closest('[data-chip-input]');
    if (input) setTimeout(() => { if (document.activeElement !== input && input.isConnected) { if (!$('suggest').matches(':hover')) { hideSuggest(); if (input.value.trim()) commitChipInput(input); } } }, 120);
  });
  composerEl.addEventListener('paste', (e) => {
    const input = e.target.closest('[data-chip-input]');
    if (!input) return;
    const text = e.clipboardData.getData('text');
    if (/[,;\n]/.test(text)) { e.preventDefault(); input.value = text; commitChipInput(input); }
  });
  $('suggest').addEventListener('mousedown', (e) => { const item = e.target.closest('[data-i]'); if (item) { e.preventDefault(); pickSuggest(Number(item.dataset.i)); } });

  const editor = $('editor');
  editor.addEventListener('input', () => { if (C.pendingSize) convertFontTags(); markDirty(); });
  editor.addEventListener('keyup', () => { saveRange(); updateToolbarState(); });
  editor.addEventListener('mouseup', () => { saveRange(); updateToolbarState(); });
  editor.addEventListener('blur', saveRange);
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); execCmd('link'); }
    if (e.key === 'Tab' && !e.shiftKey && getSelection().anchorNode?.parentElement?.closest('li')) { e.preventDefault(); document.execCommand('indent'); }
  });
  editor.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); insertInlineImages(files); return; }
    const html = e.clipboardData.getData('text/html');
    if (html) { e.preventDefault(); document.execCommand('insertHTML', false, sanitize(html)); }
  });
  $('toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('toolbar').addEventListener('click', (e) => { const b = e.target.closest('button[data-cmd]'); if (b) execCmd(b.dataset.cmd, b); });
  $('t-size').addEventListener('change', (e) => applyFontSize(Number(e.target.value)));
  $('t-font').addEventListener('change', (e) => { restoreRange(); document.execCommand('styleWithCSS', false, true); document.execCommand('fontName', false, e.target.value); markDirty(); });
  $('t-color').addEventListener('input', (e) => { restoreRange(); document.execCommand('styleWithCSS', false, true); document.execCommand('foreColor', false, e.target.value); $('t-color-swatch').style.borderBottomColor = e.target.value; markDirty(); });
  $('t-hl').addEventListener('input', (e) => { restoreRange(); document.execCommand('styleWithCSS', false, true); document.execCommand('hiliteColor', false, e.target.value); $('t-hl-swatch').style.color = e.target.value; markDirty(); });
  for (const id of ['t-color', 't-hl', 't-size', 't-font']) $(id).addEventListener('mousedown', saveRange);

  $('send-btn').addEventListener('click', () => send());
  $('send-more').addEventListener('click', (e) => { e.stopPropagation(); toggleScheduleMenu(); });
  $('template-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleTemplateMenu(); });
  $('attach-btn').addEventListener('click', () => $('file-input').click());
  $('discard-btn').addEventListener('click', discardComposer);
  $('file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
  $('image-input').addEventListener('change', (e) => { insertInlineImages(e.target.files); e.target.value = ''; });

  const wrap = $('editor-wrap');
  let dragDepth = 0;
  composerEl.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; wrap.classList.add('dragging'); } });
  composerEl.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) wrap.classList.remove('dragging'); });
  composerEl.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  composerEl.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    dragDepth = 0;
    wrap.classList.remove('dragging');
    uploadFiles(e.dataTransfer.files);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('#send-more') && !e.target.closest('#template-btn')) hideMenus();
  });
  document.addEventListener('keydown', globalKeys);
  window.addEventListener('beforeunload', (e) => {
    if (C.open && C.dirty && hasContent()) { saveDraft({ force: true }); e.preventDefault(); e.returnValue = ''; }
  });
}

async function insertInlineImages(files) {
  const images = [...files].filter(f => f.type.startsWith('image/'));
  if (!images.length) return;
  saveRange();
  const uploaded = await uploadFiles(images, { inline: true });
  restoreRange();
  for (const a of uploaded) document.execCommand('insertHTML', false, `<img src="${esc(fileUrl(a.url))}" alt="${esc(a.filename)}" style="max-width:100%;height:auto">`);
  markDirty();
}

function globalKeys(e) {
  if (!$('modal').hidden) { if (e.key === 'Escape') closeModal(); return; }
  if (typing(document.activeElement) || e.altKey) return;
  if (e.ctrlKey || e.metaKey) return;
  const k = e.key;
  if (gPending) {
    gPending = false;
    const target = { i: 'inbox', s: 'sent', d: 'drafts', a: 'all', t: 'trash', r: 'starred' }[k];
    if (target) { e.preventDefault(); switchFolder(target); }
    return;
  }
  const thread = S.openId && S.thread;
  switch (k) {
    case 'c': e.preventDefault(); openComposer(); break;
    case '/': e.preventDefault(); $('search').focus(); break;
    case '?': showHelp(); break;
    case 'j': moveSelection(1); break;
    case 'k': moveSelection(-1); break;
    case 'g': gPending = true; setTimeout(() => { gPending = false; }, 1200); break;
    case 'u': case 'Escape': if (S.openId) closeThread(); break;
    case 'U': if (thread) threadAction('unread'); break;
    case 'r': if (thread) { e.preventDefault(); startReply('reply'); } break;
    case 'a': if (thread) { e.preventDefault(); startReply('reply_all'); } break;
    case 'f': if (thread) { e.preventDefault(); startReply('forward'); } break;
    case 'e': if (thread) threadAction(['archive', 'trash', 'spam'].includes(S.thread.thread.folder) ? 'inbox' : 'archive'); break;
    case '#': case 'Delete': if (thread) threadAction(S.thread.thread.folder === 'trash' ? 'delete' : 'trash'); break;
    case '!': if (thread) threadAction('spam'); break;
    case 's': if (thread) threadAction('star'); break;
    case 'x': if (S.openId) { S.selected.has(S.openId) ? S.selected.delete(S.openId) : S.selected.add(S.openId); renderList(); renderBulk(); } break;
  }
}

boot();
