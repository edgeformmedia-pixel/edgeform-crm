import { HttpError } from './lib.js';
import { PORTAL_URL, parseJson } from './affiliate-lib.js';

// Campaign applications (CONTRACT.md §9): shared by the public page API, the admin routes and the portal.

export const APPLICATION_STATUSES = ['new', 'reviewing', 'approved', 'declined', 'withdrawn'];
export const QUESTION_TYPES = ['short_text', 'long_text', 'select', 'multi_select', 'boolean', 'url', 'number'];
export const AUDIENCE_SIZES = ['under_5k', '5k_25k', '25k_100k', '100k_500k', '500k_plus'];
export const POSTING_CADENCES = ['1_2_week', '3_5_week', '6_plus_week', 'not_sure'];
export const MAX_QUESTIONS = 10;
export const MAX_EXAMPLE_VIDEOS = 6;

// audience_size enum → the label and tier creators already use (AUDIENCE_TIERS in worker/intake.js).
export const AUDIENCE_LABELS = {
  under_5k: ['Under 5K', 1], '5k_25k': ['5K–25K', 2], '25k_100k': ['25K–100K', 3], '100k_500k': ['100K–500K', 4], '500k_plus': ['500K+', 5]
};

// The default question pack seeded into new campaigns. Migration 0025 seeds the same list into existing ones.
export const DEFAULT_QUESTIONS = [
  { id: 'fit', label: 'What would your first video for this look like?', type: 'long_text', required: true, help: 'A sentence or two on the hook or angle you\'d use.', options: [], max_length: 600 },
  { id: 'posted_similar', label: 'Have you posted for a brand or product before?', type: 'boolean', required: false, help: '', options: [], max_length: null },
  { id: 'best_video', label: 'Link to your best-performing video', type: 'url', required: false, help: 'Any platform. It doesn\'t have to be sponsored.', options: [], max_length: null },
  { id: 'typical_views', label: 'Typical views on a recent video', type: 'number', required: false, help: 'A rough number is fine.', options: [], max_length: null },
  { id: 'start_when', label: 'When could you post your first video?', type: 'select', required: true, help: '', options: ['This week', 'Next week', 'Within a month'], max_length: null }
];

// Text answers with no max_length set still get a ceiling.
const DEFAULT_TEXT_MAX = { short_text: 300, long_text: 2000 };

// ── Questions ──

/** Validates staff-edited questions (admin API). Returns the normalized Question[]. */
export function readQuestions(value) {
  const list = typeof value === 'string' ? parseJson(value, null) : value;
  if (!Array.isArray(list)) throw new HttpError(400, 'Questions must be a list.');
  if (list.length > MAX_QUESTIONS) throw new HttpError(400, `Up to ${MAX_QUESTIONS} questions.`);
  const ids = new Set();
  return list.map((q, i) => {
    const n = i + 1;
    if (!q || typeof q !== 'object') throw new HttpError(400, `Question ${n} is empty.`);
    const id = String(q.id ?? '').trim();
    if (!/^[a-z0-9_]{1,40}$/.test(id)) throw new HttpError(400, `Question ${n}: the id must be 1–40 lowercase letters, digits or underscores.`);
    if (ids.has(id)) throw new HttpError(400, `Two questions use the id "${id}".`);
    ids.add(id);
    const label = String(q.label ?? '').trim();
    if (!label || label.length > 200) throw new HttpError(400, `Question ${n} needs a label of up to 200 characters.`);
    if (!QUESTION_TYPES.includes(q.type)) throw new HttpError(400, `Question ${n}: type must be one of ${QUESTION_TYPES.join(', ')}.`);
    const help = String(q.help ?? '').trim();
    if (help.length > 300) throw new HttpError(400, `Question ${n}: the help line is over 300 characters.`);
    let options = [];
    if (q.type === 'select' || q.type === 'multi_select') {
      options = (Array.isArray(q.options) ? q.options : []).map(o => String(o ?? '').trim()).filter(Boolean);
      if (options.length < 2 || options.length > 20) throw new HttpError(400, `Question ${n} needs 2–20 options.`);
      if (options.some(o => o.length > 120)) throw new HttpError(400, `Question ${n}: options are up to 120 characters.`);
      if (new Set(options).size !== options.length) throw new HttpError(400, `Question ${n} lists the same option twice.`);
    }
    let maxLength = null;
    if ((q.type === 'short_text' || q.type === 'long_text') && q.max_length !== null && q.max_length !== undefined && q.max_length !== '') {
      maxLength = Number(q.max_length);
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 4000) throw new HttpError(400, `Question ${n}: max length must be 1–4000.`);
    }
    return { id, label, type: q.type, required: q.required === true, help, options, max_length: maxLength };
  });
}

export const isHttpUrl = (text) => {
  try { return /^https?:$/.test(new URL(text).protocol); } catch { return false; }
};

/** Validates an applicant's answers against the campaign's questions. Returns the object to store. */
export function readAnswers(questions, answers, invalid) {
  if (answers === undefined || answers === null) answers = {};
  if (typeof answers !== 'object' || Array.isArray(answers)) throw invalid('answers must be an object.');
  const byId = new Map(questions.map(q => [q.id, q]));
  for (const key of Object.keys(answers)) if (!byId.has(key)) throw invalid(`Unknown question "${key}".`);
  const out = {};
  for (const q of questions) {
    const value = answers[q.id];
    const blank = value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
    if (blank) {
      if (q.required) throw invalid(`Please answer "${q.label}".`);
      continue;
    }
    const bad = (why) => invalid(`"${q.label}": ${why}`);
    switch (q.type) {
      case 'short_text':
      case 'long_text': {
        if (typeof value !== 'string') throw bad('must be text.');
        const text = value.trim();
        const max = q.max_length || DEFAULT_TEXT_MAX[q.type];
        if (text.length > max) throw bad(`keep it under ${max} characters.`);
        out[q.id] = text;
        break;
      }
      case 'select':
        if (typeof value !== 'string' || !q.options.includes(value)) throw bad('pick one of the options.');
        out[q.id] = value;
        break;
      case 'multi_select':
        if (!Array.isArray(value) || value.some(v => !q.options.includes(v))) throw bad('pick from the options.');
        out[q.id] = q.options.filter(o => value.includes(o));
        break;
      case 'boolean':
        if (typeof value !== 'boolean') throw bad('answer yes or no.');
        out[q.id] = value;
        break;
      case 'url': {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text.length > 2000 || !isHttpUrl(text)) throw bad('enter a full link starting with https://.');
        out[q.id] = text;
        break;
      }
      case 'number': {
        const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''));
        if (!Number.isFinite(n) || n < 0 || n > 1e12) throw bad('enter a number.');
        out[q.id] = n;
        break;
      }
    }
  }
  return out;
}

// ── Referral codes ──

// Crockford base32 minus its two remaining vowels (A, E), so a code can't spell a word.
const REF_ALPHABET = '0123456789BCDFGHJKMNPQRSTVWXYZ';

export function newRefCode() {
  // Rejection sampling keeps every character equally likely.
  let code = '';
  while (code.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 240 && code.length < 8) code += REF_ALPHABET[b % 30];
    }
  }
  return code;
}

/** What a person might type or a link might carry → the stored form, or null if it can't be a code. */
export function normalizeRefCode(value) {
  const text = String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9BCDFGHJKMNPQRSTVWXYZ]{8}$/.test(text) ? text : null;
}

/** Mints a ref code for a creator who doesn't have one yet. Returns their code either way. */
export async function ensureRefCode(env, creatorId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await env.DB.prepare('SELECT ref_code FROM creators WHERE id = ?').bind(creatorId).first();
    if (!existing) return null;
    if (existing.ref_code) return existing.ref_code;
    try {
      await env.DB.prepare('UPDATE creators SET ref_code = ? WHERE id = ? AND ref_code IS NULL').bind(newRefCode(), creatorId).run();
    } catch (error) {
      if (!/UNIQUE/i.test(error.message)) throw error;   // a collision: try another code
    }
  }
  throw new HttpError(500, 'Couldn’t create a referral code.');
}

/** A code that isn't already taken, for use inside a batch. */
export async function freshRefCode(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newRefCode();
    if (!await env.DB.prepare('SELECT 1 FROM creators WHERE ref_code = ?').bind(code).first()) return code;
  }
  throw new HttpError(500, 'Couldn’t create a referral code.');
}

// ── Is the page open? ──

/** Today in New York as YYYY-MM-DD — the same clock the weekly check runs on. */
export const todayNewYork = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/**
 * 'open', 'not_found' (404: disabled, no slug, draft, ended) or 'closed' (410: paused, past the closing
 * date, or every seat filled). `approvedCount` is the number of approved applications on the campaign.
 */
export function applicationState(campaign, approvedCount, today = todayNewYork()) {
  if (!campaign || campaign.application_enabled !== 1 || !campaign.public_slug) return 'not_found';
  if (campaign.status === 'draft' || campaign.status === 'ended') return 'not_found';
  if (campaign.status === 'paused') return 'closed';
  if (campaign.application_closes_at && today > campaign.application_closes_at) return 'closed';
  if (campaign.application_seats !== null && campaign.application_seats !== undefined && approvedCount >= campaign.application_seats) return 'closed';
  return 'open';
}

export const publicUrl = (slug) => (slug ? `${PORTAL_URL}/apply.html?c=${encodeURIComponent(slug)}` : null);
export const shareUrl = (slug, refCode) => (slug && refCode ? `${publicUrl(slug)}&r=${encodeURIComponent(refCode)}` : null);

/** "Spring Launch — TikTok!" → "spring-launch-tiktok" */
export function slugify(name) {
  const slug = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug.length >= 3 ? slug : (slug + '-campaign').replace(/^-/, '');
}

/** A free slug based on the name: "spring-launch", then "spring-launch-2", … */
export async function uniqueSlug(env, name, exceptCampaignId = '') {
  const base = slugify(name).slice(0, 56).replace(/-+$/, '');
  for (let n = 1; n < 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const taken = await env.DB.prepare('SELECT 1 FROM campaigns WHERE public_slug = ? AND id <> ?').bind(slug, exceptCampaignId).first();
    if (!taken) return slug;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 60);
}

// ── Company-wide chain → campaign upline ──

/**
 * Walks up the company-wide referral chain starting at `startCreatorId` (the applicant's referrer) and
 * returns the first person with a non-removed assignment on this campaign: { id, name } of that
 * campaign_affiliates row, or null. Loops in the chain stop at 50 hops.
 */
export async function deriveUpline(env, campaignId, startCreatorId, excludeCreatorId = null) {
  if (!startCreatorId) return null;
  const row = await env.DB.prepare(`WITH RECURSIVE chain(id, depth) AS (
      SELECT ?, 1
      UNION ALL
      SELECT c.referred_by_creator_id, chain.depth + 1 FROM creators c JOIN chain ON c.id = chain.id
        WHERE c.referred_by_creator_id IS NOT NULL AND chain.depth < 50
    )
    SELECT ca.id, cr.name FROM chain
      JOIN campaign_affiliates ca ON ca.creator_id = chain.id AND ca.campaign_id = ? AND ca.status <> 'removed'
      JOIN creators cr ON cr.id = ca.creator_id
    WHERE chain.id <> ?
    ORDER BY chain.depth LIMIT 1`).bind(startCreatorId, campaignId, excludeCreatorId || '').first();
  return row ? { id: row.id, name: row.name } : null;
}

/** True when making `referrerId` the referrer of `creatorId` would put the creator above themselves. */
export async function wouldCycle(env, creatorId, referrerId) {
  if (!referrerId) return false;
  if (referrerId === creatorId) return true;
  const hit = await env.DB.prepare(`WITH RECURSIVE chain(id, depth) AS (
      SELECT ?, 1
      UNION ALL
      SELECT c.referred_by_creator_id, chain.depth + 1 FROM creators c JOIN chain ON c.id = chain.id
        WHERE c.referred_by_creator_id IS NOT NULL AND chain.depth < 50
    ) SELECT 1 FROM chain WHERE id = ? LIMIT 1`).bind(referrerId, creatorId).first();
  return !!hit;
}

// ── Can the promo site be framed? ──

/**
 * Reads X-Frame-Options and CSP frame-ancestors the way a browser would for a page on `portalOrigin`.
 * CSP frame-ancestors, when present, wins over X-Frame-Options.
 */
export function framingAllowed(headers, portalOrigin = PORTAL_URL) {
  const get = (name) => (typeof headers.get === 'function' ? headers.get(name) : headers[name]) || '';
  const csp = get('content-security-policy');
  const directive = csp.split(/[;,]/).map(d => d.trim()).find(d => /^frame-ancestors(\s|$)/i.test(d));
  if (directive) {
    const sources = directive.split(/\s+/).slice(1).map(s => s.toLowerCase().replace(/\/$/, ''));
    if (!sources.length || sources.includes("'none'")) return false;
    const origin = new URL(portalOrigin);
    return sources.some(s => {
      if (s === '*') return true;
      if (s === 'https:' || s === `${origin.protocol}`) return true;
      if (s === origin.origin || s === origin.host) return true;
      const wild = s.match(/^(?:(https?):\/\/)?\*\.(.+)$/);
      return !!wild && (!wild[1] || wild[1] + ':' === origin.protocol) && origin.hostname.endsWith('.' + wild[2]);
    });
  }
  const xfo = get('x-frame-options').trim().toLowerCase();
  return !(xfo === 'deny' || xfo === 'sameorigin' || xfo.startsWith('allow-from'));
}

/** Fetches the promo URL once and reports whether it can be framed: true, false, or null (couldn't tell). */
export async function checkFraming(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, {
      method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; EdgeformCRM/1.0; +https://crm.edgeformmarketing.com)' }
    });
    try { res.body?.cancel(); } catch { /* the body isn't needed */ }
    if (!res.ok && res.status >= 500) return null;
    return framingAllowed(res.headers);
  } catch {
    return null;
  }
}

// ── Example videos ──

/** Embed and thumbnail URLs from a parsed video link (parseVideoUrl's output). */
export function exampleEmbed(parsed) {
  const id = parsed.platform_video_id;
  if (parsed.platform === 'youtube') return { embed_url: `https://www.youtube.com/embed/${id}`, thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  if (parsed.platform === 'tiktok') return { embed_url: `https://www.tiktok.com/embed/v2/${id}`, thumbnail_url: '' };
  return { embed_url: `${parsed.canonical_url}embed/`, thumbnail_url: '' };
}
