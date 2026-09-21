import { json, HttpError, now, sha256, isEmail } from './lib.js';
import { PLATFORMS, parseJson } from './affiliate-lib.js';
import {
  AUDIENCE_SIZES, POSTING_CADENCES, applicationState, readAnswers, normalizeRefCode, isHttpUrl
} from './applications-lib.js';

// Public campaign application pages (CONTRACT.md §9), served at /api/public/v1 with no auth of any kind.
// It sits outside /api/affiliate/v1 and outside requireUser on purpose, and it only ever reads the
// columns named in publicCampaignJson — never SELECT * into a response — so a private column added
// to `campaigns` later can't leak through here.

export const PUBLIC_PREFIX = '/api/public/v1';

const IP_LIMIT_PER_HOUR = 5;
const EMAIL_LIMIT_PER_HOUR = 3;
const MAX_BODY_BYTES = 64 * 1024;

const fail = (status, message, code) => new HttpError(status, message, code);
const invalid = (message) => fail(400, message, 'validation_error');
const notFound = () => fail(404, 'This application page doesn’t exist.', 'not_found');
const closed = () => fail(410, 'Applications for this campaign are closed.', 'applications_closed');

// The only campaign columns this module reads.
const CAMPAIGN_COLUMNS = `c.id, c.name, c.status, c.platforms_allowed, c.currency, c.default_cpm_rate_cents, c.default_override_bps,
  c.min_views_to_qualify, c.requires_video_approval, c.start_date, c.end_date,
  c.application_enabled, c.public_slug, c.public_headline, c.public_pitch, c.brand_name,
  c.promo_url, c.promo_embed, c.promo_image_url, c.application_questions, c.application_seats, c.application_closes_at,
  (SELECT COUNT(*) FROM campaign_applications a WHERE a.campaign_id = c.id AND a.status = 'approved') approved_count`;

/** The campaign behind a slug if its page is open; otherwise the 404 or 410 the contract calls for. */
async function openCampaign(env, slug) {
  const clean = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{3,60}$/.test(clean)) throw notFound();
  const campaign = await env.DB.prepare(`SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c WHERE c.public_slug = ?`).bind(clean).first();
  const state = applicationState(campaign, campaign?.approved_count || 0);
  if (state === 'not_found') throw notFound();
  if (state === 'closed') throw closed();
  return campaign;
}

/**
 * A creator who can refer: the code matches and they're on at least one campaign right now.
 * Returns { id, name, ref_code } or null. A bad code is ignored, never an error.
 */
async function liveReferrer(env, rawCode) {
  const code = normalizeRefCode(rawCode);
  if (!code) return null;
  return env.DB.prepare(`SELECT cr.id, cr.name, cr.email, cr.ref_code FROM creators cr WHERE cr.ref_code = ?
      AND EXISTS (SELECT 1 FROM campaign_affiliates ca WHERE ca.creator_id = cr.id AND ca.status <> 'removed')`).bind(code).first();
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;
const orNull = (v) => (v === undefined || v === null || v === '' ? null : v);

/** PublicCampaign, built field by field. */
export function publicCampaignJson(c, exampleVideos, referrer) {
  return {
    slug: c.public_slug,
    name: c.name,
    brand_name: c.brand_name || c.name,
    headline: c.public_headline || '',
    pitch: c.public_pitch || '',
    status: c.status,
    platforms_allowed: parseJson(c.platforms_allowed, []),
    currency: c.currency || 'USD',
    starting_cpm_rate_cents: c.default_cpm_rate_cents,
    team_bonus_bps: c.default_override_bps ?? 0,
    min_views_to_qualify: c.min_views_to_qualify ?? null,
    requires_video_approval: c.requires_video_approval === 1,
    start_date: orNull(c.start_date),
    end_date: orNull(c.end_date),
    closes_at: orNull(c.application_closes_at),
    promo_url: orNull(c.promo_url),
    promo_embed: c.promo_embed === 1,
    promo_image_url: orNull(c.promo_image_url),
    example_videos: exampleVideos.map(v => ({
      url: v.url, platform: v.platform, embed_url: orNull(v.embed_url), thumbnail_url: orNull(v.thumbnail_url), caption: v.caption || ''
    })),
    questions: parseJson(c.application_questions, []),
    referrer_first_name: referrer ? firstName(referrer.name) : null,
    // Only echoed when it matched a live creator, so the page never carries a dead code into the form.
    ref_code: referrer ? referrer.ref_code : null
  };
}

async function getCampaign(request, env, headers, [slug]) {
  const campaign = await openCampaign(env, slug);
  const [videos, referrer] = await Promise.all([
    env.DB.prepare(`SELECT url, platform, embed_url, thumbnail_url, caption FROM campaign_example_videos
      WHERE campaign_id = ? ORDER BY sort_order, created_at`).bind(campaign.id).all(),
    liveReferrer(env, new URL(request.url).searchParams.get('ref'))
  ]);
  return json({ ok: true, campaign: publicCampaignJson(campaign, videos.results, referrer) }, 200, { ...headers, 'cache-control': 'no-store' });
}

// ── Applications ──

const INPUT_KEYS = ['name', 'email', 'phone', 'country', 'instagram', 'tiktok', 'youtube', 'portfolio_url', 'platforms',
  'audience_size', 'posting_cadence', 'niches', 'why', 'answers', 'consent', 'age_confirmed', 'ref_code', 'utm', 'page_url', 'referrer'];

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw invalid('That application is too long.');
  let body;
  try { body = JSON.parse(text || 'null'); } catch { throw invalid('Invalid JSON body.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send the application as a JSON object.');
  const unknown = Object.keys(body).filter(k => !INPUT_KEYS.includes(k));
  if (unknown.length) throw invalid(`Unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
  return body;
}

/** Optional text: null/undefined → '', otherwise a trimmed string no longer than `max`. */
function text(body, key, max, label = key) {
  const value = body[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${label} is too long (${max} characters max).`);
  return trimmed;
}

// "+1 (555) 123-4567" → "+15551234567". Ten digits with no country code are read as US/Canada.
function toE164(phone, country) {
  const digits = phone.replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits) && (!country || country === 'US' || country === 'CA')) return '+1' + digits;
  if (/^1\d{10}$/.test(digits) && (!country || country === 'US' || country === 'CA')) return '+' + digits;
  return '';
}

export function readApplication(body, campaign) {
  const name = text(body, 'name', 160, 'Name');
  if (!name) throw invalid('Enter your name.');
  const email = text(body, 'email', 254, 'Email').toLowerCase();
  if (!isEmail(email)) throw invalid('Enter a valid email address.');
  const country = text(body, 'country', 2, 'Country').toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw invalid('Country must be a 2-letter code, like US.');
  const phone = text(body, 'phone', 40, 'Phone');

  const handles = { instagram: text(body, 'instagram', 300, 'Instagram'), tiktok: text(body, 'tiktok', 300, 'TikTok'), youtube: text(body, 'youtube', 300, 'YouTube') };
  if (!handles.instagram && !handles.tiktok && !handles.youtube) throw invalid('Add at least one of your Instagram, TikTok or YouTube accounts.');
  const portfolioUrl = text(body, 'portfolio_url', 2000, 'Portfolio link');
  if (portfolioUrl && !isHttpUrl(portfolioUrl)) throw invalid('The portfolio link needs to start with https://.');

  const allowed = parseJson(campaign.platforms_allowed, []);
  if (!Array.isArray(body.platforms) || !body.platforms.length) throw invalid('Pick at least one platform you’d post on.');
  if (body.platforms.some(p => !PLATFORMS.includes(p))) throw invalid('platforms can only contain tiktok, instagram or youtube.');
  if (body.platforms.some(p => !allowed.includes(p))) throw invalid('This campaign doesn’t take videos on one of the platforms you picked.');
  const platforms = PLATFORMS.filter(p => body.platforms.includes(p));

  const audienceSize = text(body, 'audience_size', 20, 'Audience size');
  if (audienceSize && !AUDIENCE_SIZES.includes(audienceSize)) throw invalid('Pick an audience size from the list.');
  const postingCadence = text(body, 'posting_cadence', 20, 'Posting cadence');
  if (postingCadence && !POSTING_CADENCES.includes(postingCadence)) throw invalid('Pick how often you post from the list.');

  if (body.niches !== undefined && body.niches !== null && !Array.isArray(body.niches)) throw invalid('niches must be a list.');
  const niches = (body.niches || []).map(n => (typeof n === 'string' ? n.trim() : '')).filter(Boolean);
  if (niches.length > 15 || niches.some(n => n.length > 60)) throw invalid('Up to 15 niches, 60 characters each.');

  const why = text(body, 'why', 1000, 'Why you');
  const answers = readAnswers(parseJson(campaign.application_questions, []), body.answers, invalid);

  if (body.consent !== true) throw invalid('Please agree to be contacted about this campaign.');
  if (body.age_confirmed !== true) throw invalid('You need to be 18 or older to apply.');

  const refCode = text(body, 'ref_code', 40, 'ref_code') || null;
  if (body.utm !== undefined && body.utm !== null && (typeof body.utm !== 'object' || Array.isArray(body.utm))) throw invalid('utm must be an object.');
  const utm = {};
  for (const [k, v] of Object.entries(body.utm || {}).slice(0, 10)) {
    if (typeof v === 'string' && /^[\w-]{1,40}$/.test(k)) utm[k] = v.slice(0, 200);
  }

  return {
    name, email, phone, phone_e164: phone ? toE164(phone, country) : '', country,
    ...handles, portfolio_url: portfolioUrl,
    platforms: JSON.stringify(platforms), audience_size: audienceSize, posting_cadence: postingCadence,
    niches: JSON.stringify([...new Set(niches)]), why, answers: JSON.stringify(answers),
    consent: 1, age_confirmed: 1, ref_code: refCode, utm: JSON.stringify(utm),
    page_url: text(body, 'page_url', 2000, 'page_url'), referrer: text(body, 'referrer', 2000, 'referrer')
  };
}

const hourAgo = () => new Date(Date.now() - 3600000).toISOString();

async function submitApplication(request, env, headers, [slug]) {
  const campaign = await openCampaign(env, slug);
  const input = readApplication(await readBody(request), campaign);

  // Rate limits. The raw IP is hashed with a server secret and never stored.
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || '';
  const ipHash = await sha256(ip + (env.AFFILIATE_ENCRYPTION_KEY || ''));
  const since = hourAgo();
  const [byIp, byEmail] = await Promise.all([
    ip ? env.DB.prepare('SELECT COUNT(*) n FROM campaign_applications WHERE ip_hash = ? AND submitted_at > ?').bind(ipHash, since).first() : { n: 0 },
    env.DB.prepare('SELECT COUNT(*) n FROM campaign_applications WHERE email = ? COLLATE NOCASE AND submitted_at > ?').bind(input.email, since).first()
  ]);
  if (byIp.n >= IP_LIMIT_PER_HOUR || byEmail.n >= EMAIL_LIMIT_PER_HOUR) {
    throw fail(429, 'Too many applications from here in the last hour. Please try again later.', 'rate_limited');
  }

  // Same wording whatever happened to the first one: it never hints at a decision.
  const alreadyApplied = () => fail(409, 'You’ve already applied to this campaign with that email. We’ll be in touch by email.', 'already_applied');
  if (await env.DB.prepare('SELECT 1 FROM campaign_applications WHERE campaign_id = ? AND email = ? COLLATE NOCASE').bind(campaign.id, input.email).first()) {
    throw alreadyApplied();
  }

  const [referrer, creator] = await Promise.all([
    liveReferrer(env, input.ref_code),
    env.DB.prepare("SELECT id FROM creators WHERE email = ? COLLATE NOCASE AND email <> ''").bind(input.email).first()
  ]);
  // Nobody refers themselves.
  const referredBy = referrer && referrer.id !== creator?.id && String(referrer.email || '').toLowerCase() !== input.email ? referrer.id : null;

  const stamp = now();
  const row = {
    id: crypto.randomUUID(), campaign_id: campaign.id, status: 'new', ...input,
    referred_by_creator_id: referredBy, creator_id: creator?.id || null,
    user_agent: String(request.headers.get('user-agent') || '').slice(0, 500), ip_hash: ipHash,
    submitted_at: stamp, created_at: stamp, updated_at: stamp
  };
  try {
    await env.DB.prepare(`INSERT INTO campaign_applications (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
      .bind(...Object.values(row)).run();
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) throw alreadyApplied();
    throw error;
  }
  return json({ ok: true, status: 'received' }, 201, headers);
}

// ── Routing (same error shape as the affiliate API) ──

const routes = {
  'GET /campaigns/:slug': getCampaign,
  'POST /campaigns/:slug/applications': submitApplication
};

const compiled = Object.entries(routes).map(([key, handler]) => {
  const [method, path] = key.split(' ');
  return { method, pattern: new RegExp('^' + PUBLIC_PREFIX + path.replace(/:[a-z]+/g, '([^/]+)') + '$'), handler };
});

const DEFAULT_CODES = { 400: 'validation_error', 404: 'not_found', 405: 'not_found', 409: 'already_applied', 410: 'applications_closed', 429: 'rate_limited' };

export async function publicFetch(request, env, headers) {
  // Only GET and POST are ever served here.
  headers = { ...headers, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  try {
    for (const { method, pattern, handler } of compiled) {
      const match = request.method === method && path.match(pattern);
      if (match) return await handler(request, env, headers, match.slice(1).map(decodeURIComponent));
    }
    throw notFound();
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ ok: false, error: error.message, code: error.code || DEFAULT_CODES[error.status] || 'error' }, error.status, headers);
    }
    console.error('public api error', error);
    return json({ ok: false, error: 'Something went wrong. Please try again.', code: 'internal_error' }, 500, headers);
  }
}
