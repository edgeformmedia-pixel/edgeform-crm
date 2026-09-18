import { HttpError, now } from './lib.js';

// Shared by the affiliate portal API, the admin campaign routes, and the view-polling cron.
// Names follow CONTRACT.md exactly.

export const PLATFORMS = ['tiktok', 'instagram', 'youtube'];
export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'ended'];
export const ASSIGNMENT_STATUSES = ['invited', 'active', 'removed'];
export const PAYOUT_METHODS = ['paypal', 'wise', 'bank', 'manual'];
export const PAYOUT_STATUSES = ['pending', 'approved', 'paid', 'failed'];

export const PORTAL_URL = 'https://affiliate.edgeformmarketing.com';

export const DAY_MS = 86400000;
export const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
export const addHours = (iso, hours) => new Date(new Date(iso).getTime() + hours * 3600000).toISOString();

// '' and undefined become null so every contract key is always present.
export const orNull = (v) => (v === undefined || v === null || v === '' ? null : v);
export const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

// ── Video URLs ──────────────────────────────────────────────────

const badUrl = (message = "That doesn't look like a video link.") => new HttpError(400, message, 'invalid_url');
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TIKTOK_ID = /^\d{8,25}$/;
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{5,64}$/;
const INSTAGRAM_KINDS = new Set(['reel', 'reels', 'p', 'tv']);

function toUrl(raw) {
  let text = String(raw ?? '').trim();
  if (!text || /\s/.test(text) || text.length > 2000) throw badUrl();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch { throw badUrl(); }
  if (!/^https?:$/.test(url.protocol)) throw badUrl();
  return url;
}

const bareHost = (url) => url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');

/**
 * Reads the platform and video ID from a link without any network calls.
 * Returns { platform, platform_video_id, canonical_url, handle } or { platform, resolve: true } for short links.
 * Throws invalid_url or unsupported_platform.
 */
export function parseVideoUrl(raw) {
  const url = toUrl(raw);
  const host = bareHost(url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com') {
    let id = null;
    if (host === 'youtu.be') id = parts[0];
    else if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'live', 'embed', 'v'].includes(parts[0])) id = parts[1];
    if (!id || !YOUTUBE_ID.test(id)) throw badUrl('That YouTube link doesn’t point to a video.');
    return { platform: 'youtube', platform_video_id: id, canonical_url: `https://www.youtube.com/watch?v=${id}`, handle: null };
  }

  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return { platform: 'tiktok', resolve: true };
  if (host === 'tiktok.com') {
    if (parts[0] === 't') return { platform: 'tiktok', resolve: true };
    let id = null;
    let handle = null;
    if (parts[0]?.startsWith('@') && parts[1] === 'video') { handle = parts[0].slice(1).toLowerCase(); id = parts[2]; }
    else if (parts[0] === 'v') id = String(parts[1] || '').replace(/\.html$/, '');
    else if (parts[0] === 'video') id = parts[1];
    if (!id || !TIKTOK_ID.test(id)) throw badUrl('That TikTok link doesn’t point to a video.');
    return {
      platform: 'tiktok', platform_video_id: id, handle,
      canonical_url: handle ? `https://www.tiktok.com/@${handle}/video/${id}` : `https://www.tiktok.com/video/${id}`
    };
  }

  if (host === 'instagram.com' || host === 'instagr.am') {
    if (parts[0] === 'share') return { platform: 'instagram', resolve: true };
    // The login wall keeps the real link in ?next=.
    if (parts[0] === 'accounts' && url.searchParams.get('next')) return parseVideoUrl(new URL(url.searchParams.get('next'), 'https://www.instagram.com').href);
    // Both /reel/CODE and /username/reel/CODE are used.
    const i = INSTAGRAM_KINDS.has(parts[0]) ? 0 : INSTAGRAM_KINDS.has(parts[1]) ? 1 : -1;
    const code = i >= 0 ? parts[i + 1] : null;
    if (!code || !INSTAGRAM_CODE.test(code)) throw badUrl('That Instagram link doesn’t point to a post or reel.');
    const kind = parts[i] === 'p' ? 'p' : 'reel';
    return {
      platform: 'instagram', platform_video_id: code, handle: i === 1 ? parts[0].toLowerCase() : null,
      canonical_url: `https://www.instagram.com/${kind}/${code}/`
    };
  }

  throw new HttpError(400, 'Only TikTok, Instagram, and YouTube videos are supported.', 'unsupported_platform');
}

/** parseVideoUrl, following short links (vm.tiktok.com, tiktok.com/t/, instagram.com/share/) first. */
export async function resolveVideoUrl(raw, fetchImpl = fetch) {
  let parsed = parseVideoUrl(raw);
  let current = toUrl(raw).href;
  for (let hop = 0; parsed.resolve && hop < 6; hop++) {
    let res;
    try {
      res = await fetchImpl(current, {
        method: 'GET', redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
      });
    } catch {
      throw badUrl('We couldn’t open that short link. Paste the full video link instead.');
    }
    const location = res.headers.get('location');
    if (!location) throw badUrl('That short link didn’t lead to a video. Paste the full video link instead.');
    current = new URL(location, current).href;
    parsed = parseVideoUrl(current);
  }
  if (parsed.resolve) throw badUrl('That short link didn’t lead to a video. Paste the full video link instead.');
  return parsed;
}

/** Handle or profile link → lowercase handle without @, for comparing against the creator's saved socials. */
export function normalizeHandle(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  if (/[/.]/.test(text) && !/^@?[\w.]+$/.test(text)) {
    try {
      const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : 'https://' + text);
      const parts = url.pathname.split('/').filter(Boolean);
      text = ['channel', 'c', 'user'].includes(parts[0]) ? parts[1] || '' : parts[0] || '';
    } catch { /* not a link; compare as typed */ }
  }
  return text.replace(/^@/, '').trim().toLowerCase();
}

// ── Earnings (CONTRACT.md §3, v4) ───────────────────────────────────
// Views are checked by hand, once a week. Each entry prices its own delta (this check's cumulative
// view count minus the last one) and, once priced, that amount is never revisited — a later rate or
// cap change only affects weeks priced after it. This is what lets creators be paid weekly instead of
// waiting for a video to lock.

export const videoViews = (v) => (v.status === 'locked' ? v.billable_views : v.latest_view_count);
export const effectiveRate = (campaign, override) => (override === null || override === undefined ? campaign.default_cpm_rate_cents : override);

export const RANKS = ['top_creator', 'master', 'general', 'rookie'];
const MAX_CHAIN = 50;

/** The UTC instant for a given wall-clock date/time in an IANA zone, DST-safe (converges in 1-2 passes). */
function zonedTimeToUtc(y, m, d, hh, mm, timeZone) {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const wanted = guess;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(guess));
    const get = (type) => Number(parts.find(p => p.type === type)?.value);
    const asUtcIfLocalWereUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    guess += wanted - asUtcIfLocalWereUtc;
  }
  return guess;
}

/** The most recent past Sunday 10pm America/New_York, as an ISO UTC string. Used for the weekly checklist. */
export function lastWeeklyCutoff(nowIso) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(nowIso));
  const get = (type) => parts.find(p => p.type === type)?.value;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = weekdays.indexOf(get('weekday'));
  const hour = Number(get('hour')) % 24;
  // Days since the most recent Sunday; if it's Sunday but before 10pm, the cutoff is last week's Sunday.
  const daysBack = dow === 0 && hour < 22 ? 7 : dow;
  // Walk back by calendar days using the zone's own date, not a UTC-day subtraction, so a DST transition
  // mid-week can't shift which calendar date "daysBack days ago" lands on.
  const anchor = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))) - daysBack * DAY_MS);
  return new Date(zonedTimeToUtc(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, anchor.getUTCDate(), 22, 0, 'America/New_York')).toISOString();
}

/**
 * Prices a batch of new (unpriced) weekly events against a campaign's caps and budget, continuing from
 * whatever's already committed. Once returned, these prices are final — recomputeCampaign never re-prices
 * an event a second time.
 *
 * `events`: [{ id (view_snapshot id), video_id, campaign_affiliate_id, view_count (cumulative at this
 *   check), delta_views, video_status }], in chronological order.
 * `affiliates`: Map campaign_affiliate_id → { cpm_rate_override_cents, upline_id, status }.
 * `perVideoCommitted` / `perAffiliateCommitted`: cents already earned before this batch (Map keyed by
 *   video_id / campaign_affiliate_id). `campaignCommittedTotal`: the campaign's own + override total so far.
 *
 * Returns { priced: [{ id, video_id, earned_cents }], overrides: [{ view_snapshot_id, video_id,
 *   campaign_affiliate_id, source_campaign_affiliate_id, depth, cpm_diff_cents, amount_cents }] }.
 */
export function priceEvents(campaign, events, affiliates = new Map(), perVideoCommitted = new Map(), perAffiliateCommitted = new Map(), campaignCommittedTotal = 0) {
  const cap = (n) => (n === null || n === undefined ? Infinity : n);
  const rateOf = (id) => effectiveRate(campaign, affiliates.get(id)?.cpm_rate_override_cents);
  const perVideo = new Map(perVideoCommitted);
  const perAffiliate = new Map(perAffiliateCommitted);
  let total = campaignCommittedTotal;
  const priced = [];
  const overrides = [];

  for (const e of events) {
    // Only an actively-tracking video prices a new week. In normal operation this is the only status an
    // unpriced event can belong to (entries are rejected once a video isn't approved), but recomputeCampaign
    // doesn't filter by status, so this is the defensive backstop: anything else (removed, locked, rejected,
    // pending_review) earns nothing new and keeps whatever it already had.
    if (e.video_status !== 'approved') { priced.push({ id: e.id, video_id: e.video_id, earned_cents: 0 }); continue; }
    const qualifies = campaign.min_views_to_qualify === null || campaign.min_views_to_qualify === undefined || e.view_count >= campaign.min_views_to_qualify;
    const videoSoFar = perVideo.get(e.video_id) || 0;
    const affSoFar = perAffiliate.get(e.campaign_affiliate_id) || 0;
    let cents = qualifies ? Math.floor(e.delta_views * rateOf(e.campaign_affiliate_id) / 1000) : 0;
    cents = Math.max(0, Math.min(cents, cap(campaign.max_payout_per_video_cents) - videoSoFar));
    cents = Math.max(0, Math.min(cents, cap(campaign.max_payout_per_affiliate_cents) - affSoFar));
    cents = Math.max(0, Math.min(cents, cap(campaign.total_budget_cents) - total));
    perVideo.set(e.video_id, videoSoFar + cents);
    perAffiliate.set(e.campaign_affiliate_id, affSoFar + cents);
    total += cents;
    priced.push({ id: e.id, video_id: e.video_id, earned_cents: cents });

    // Upline overrides: each upline earns the gap between their CPM and the highest CPM below them so
    // far in the chain, only capped by the remaining campaign budget (not the per-affiliate cap, which
    // only limits a person's own posted-video earnings).
    let highest = rateOf(e.campaign_affiliate_id);
    const seen = new Set([e.campaign_affiliate_id]);
    let current = affiliates.get(e.campaign_affiliate_id)?.upline_id;
    for (let depth = 1; current && !seen.has(current) && depth <= MAX_CHAIN; depth++) {
      seen.add(current);
      const upline = affiliates.get(current);
      if (!upline) break;
      const rate = rateOf(current);
      if (upline.status !== 'removed' && rate > highest) {
        const diff = rate - highest;
        const amount = qualifies ? Math.max(0, Math.min(Math.floor(e.delta_views * diff / 1000), cap(campaign.total_budget_cents) - total)) : 0;
        total += amount;
        overrides.push({ view_snapshot_id: e.id, video_id: e.video_id, campaign_affiliate_id: current, source_campaign_affiliate_id: e.campaign_affiliate_id, depth, cpm_diff_cents: diff, amount_cents: amount });
      }
      if (upline.status !== 'removed') highest = Math.max(highest, rate);
      current = upline.upline_id;
    }
  }
  return { priced, overrides };
}

/** Test/tool convenience: prices a list of {campaign_affiliate_id, view_count, delta_views} events with flat per-affiliate rates and no uplines. Returns Map eventId → cents. */
export function computeEarnings(campaign, events, rates = new Map()) {
  const affiliates = new Map([...rates].map(([id, cpm]) => [id, { cpm_rate_override_cents: cpm, upline_id: null, status: 'active' }]));
  const { priced } = priceEvents(campaign, events, affiliates);
  return new Map(priced.map(p => [p.id, p.earned_cents]));
}

async function runInChunks(env, statements) {
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
}

/**
 * Prices every unpriced weekly entry (view_snapshots with delta_views set and earned_cents still NULL)
 * for a campaign, against its current caps and budget, continuing from what's already committed. Stores
 * the results on view_snapshots.earned_cents, videos.earned_cents, and override_earnings. Returns the
 * number of rows written.
 */
export async function recomputeCampaign(env, campaignId) {
  const [campaignRes, affiliatesRes, videosRes, eventsRes, overrideTotalRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId),
    env.DB.prepare('SELECT id, creator_id, cpm_rate_override_cents, upline_id, status FROM campaign_affiliates WHERE campaign_id = ?').bind(campaignId),
    env.DB.prepare('SELECT id, campaign_affiliate_id, status, earned_cents FROM videos WHERE campaign_id = ?').bind(campaignId),
    env.DB.prepare(`SELECT s.id, s.video_id, s.view_count, s.delta_views, s.fetched_at, v.campaign_affiliate_id, v.status video_status
      FROM view_snapshots s JOIN videos v ON v.id = s.video_id
      WHERE v.campaign_id = ? AND s.delta_views IS NOT NULL AND s.earned_cents IS NULL
      ORDER BY s.fetched_at, s.id`).bind(campaignId),
    env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) cents FROM override_earnings WHERE campaign_id = ?').bind(campaignId)
  ]);
  const c = campaignRes.results[0];
  if (!c) return 0;
  const events = eventsRes.results;
  if (!events.length) return 0;

  const affiliates = new Map(affiliatesRes.results.map(a => [a.id, a]));
  const perVideoCommitted = new Map(videosRes.results.map(v => [v.id, v.earned_cents]));
  const perAffiliateCommitted = new Map();
  for (const v of videosRes.results) perAffiliateCommitted.set(v.campaign_affiliate_id, (perAffiliateCommitted.get(v.campaign_affiliate_id) || 0) + v.earned_cents);
  const ownTotal = videosRes.results.reduce((n, v) => n + v.earned_cents, 0);
  const campaignCommittedTotal = ownTotal + (overrideTotalRes.results[0]?.cents || 0);

  const { priced, overrides } = priceEvents(c, events, affiliates, perVideoCommitted, perAffiliateCommitted, campaignCommittedTotal);

  const videoDelta = new Map();
  for (const p of priced) videoDelta.set(p.video_id, (videoDelta.get(p.video_id) || 0) + p.earned_cents);

  const statements = priced.map(p => env.DB.prepare('UPDATE view_snapshots SET earned_cents = ? WHERE id = ?').bind(p.earned_cents, p.id));
  for (const [videoId, delta] of videoDelta) statements.push(env.DB.prepare('UPDATE videos SET earned_cents = earned_cents + ? WHERE id = ?').bind(delta, videoId));
  for (const o of overrides) {
    if (!o.amount_cents) continue;
    const upline = affiliates.get(o.campaign_affiliate_id);
    statements.push(env.DB.prepare(`INSERT INTO override_earnings (id, view_snapshot_id, video_id, campaign_id, campaign_affiliate_id, creator_id, source_campaign_affiliate_id, depth, cpm_diff_cents, amount_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), o.view_snapshot_id, o.video_id, campaignId, o.campaign_affiliate_id, upline.creator_id, o.source_campaign_affiliate_id, o.depth, o.cpm_diff_cents, o.amount_cents));
  }
  await runInChunks(env, statements);
  return statements.length;
}

// Per-assignment totals, joined onto campaign_affiliates `ca`. Used by the portal and the admin tables.
// Everything approved is immediately earned (paid weekly, no more "pending" bucket). owed = earned + override_earned − paid.
export const ASSIGNMENT_STATS_SQL = `
  (SELECT COUNT(*) FROM videos v WHERE v.campaign_affiliate_id = ca.id) video_count,
  (SELECT COALESCE(SUM(v.latest_view_count), 0) FROM videos v WHERE v.campaign_affiliate_id = ca.id) total_views,
  (SELECT COALESCE(SUM(v.earned_cents), 0) FROM videos v WHERE v.campaign_affiliate_id = ca.id) earned_cents,
  (SELECT COALESCE(SUM(oe.amount_cents), 0) FROM override_earnings oe WHERE oe.campaign_affiliate_id = ca.id) override_earned_cents,
  (SELECT COALESCE(SUM(li.amount_cents), 0) FROM payout_line_items li JOIN payouts p ON p.id = li.payout_id
     WHERE p.status = 'paid' AND li.campaign_id = ca.campaign_id AND p.creator_id = ca.creator_id)
  + (SELECT COALESCE(SUM(poi.amount_cents), 0) FROM payout_override_items poi JOIN payouts p ON p.id = poi.payout_id
     WHERE p.status = 'paid' AND poi.campaign_affiliate_id = ca.id) paid_cents`;

// ── Encryption (payout details, OAuth tokens) ───────────────────

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function affiliateKey(secret) {
  if (!secret) throw new HttpError(503, 'Encryption isn’t set up on the server yet. Try again later.', 'not_configured');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** AES-GCM, stored in one column as "<iv base64>.<ciphertext base64>". */
export async function encryptText(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await affiliateKey(secret), new TextEncoder().encode(value));
  return `${b64(iv)}.${b64(ciphertext)}`;
}

export async function decryptText(stored, secret) {
  const [iv, ciphertext] = String(stored || '').split('.');
  if (!iv || !ciphertext) throw new HttpError(500, 'Stored value is not encrypted text.');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await affiliateKey(secret), unb64(ciphertext));
  return new TextDecoder().decode(plaintext);
}

// ── Audit log ───────────────────────────────────────────────────

/** Statement for affiliate_audit_log; batch it with the change it records. */
export function auditStatement(env, { actorType, actorId = null, entityType, entityId, action, before = null, after = null }) {
  return env.DB.prepare(`INSERT INTO affiliate_audit_log (id, actor_type, actor_id, entity_type, entity_id, action, before_json, after_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), actorType, actorId, entityType, entityId, action,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), now());
}

/** Opens a flag unless the same kind is already open on that video. */
export function flagStatement(env, videoId, type, details) {
  return env.DB.prepare(`INSERT INTO video_flags (id, video_id, type, details, created_at)
    SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM video_flags WHERE video_id = ? AND type = ? AND resolved_at IS NULL)`)
    .bind(crypto.randomUUID(), videoId, type, String(details || '').slice(0, 2000), now(), videoId, type);
}
