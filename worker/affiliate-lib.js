import { HttpError, now } from './lib.js';

// Shared by the affiliate portal API, the admin campaign routes, and the view-polling cron.
// Names follow CONTRACT.md exactly.

export const PLATFORMS = ['tiktok', 'instagram', 'youtube'];
export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'ended'];
export const ASSIGNMENT_STATUSES = ['invited', 'active', 'removed'];
export const PAYOUT_METHODS = ['paypal', 'wise', 'bank', 'manual'];
export const PAYOUT_STATUSES = ['pending', 'approved', 'paid', 'failed'];
export const EARNING_STATUSES = new Set(['approved', 'locked']);

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

// ── Earnings (CONTRACT.md §3) ───────────────────────────────────

export const videoViews = (v) => (v.status === 'locked' ? v.billable_views : v.latest_view_count);
export const effectiveRate = (campaign, override) => (override === null || override === undefined ? campaign.default_cpm_rate_cents : override);

/**
 * Earned cents per video for one campaign.
 * - Only approved and locked videos earn. Removed videos keep whatever they had (never zeroed automatically)
 *   but, like every other non-earning status, don't count toward totals or caps.
 * - `frozen` (videoId → cents) holds videos already on a payout; their amount never changes but counts toward caps.
 * - Caps apply per video, then per affiliate, then the campaign budget, oldest submission first.
 */
export function computeEarnings(campaign, videos, overrides = new Map(), frozen = new Map()) {
  const earned = new Map();
  const perAffiliate = new Map();
  let total = 0;
  const cap = (n) => (n === null || n === undefined ? Infinity : n);
  const ordered = [...videos].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.id.localeCompare(b.id));
  for (const v of ordered) {
    if (!EARNING_STATUSES.has(v.status)) {
      earned.set(v.id, v.status === 'removed' ? v.earned_cents || 0 : 0);
      continue;
    }
    const soFar = perAffiliate.get(v.campaign_affiliate_id) || 0;
    let cents;
    if (frozen.has(v.id)) {
      cents = frozen.get(v.id);
    } else {
      const views = videoViews(v) || 0;
      const qualifies = campaign.min_views_to_qualify === null || campaign.min_views_to_qualify === undefined || views >= campaign.min_views_to_qualify;
      cents = qualifies ? Math.floor(views * effectiveRate(campaign, overrides.get(v.campaign_affiliate_id)) / 1000) : 0;
      cents = Math.min(cents, cap(campaign.max_payout_per_video_cents));
      cents = Math.max(0, Math.min(cents, cap(campaign.max_payout_per_affiliate_cents) - soFar));
      cents = Math.max(0, Math.min(cents, cap(campaign.total_budget_cents) - total));
    }
    perAffiliate.set(v.campaign_affiliate_id, soFar + cents);
    total += cents;
    earned.set(v.id, cents);
  }
  return earned;
}

/** Recomputes and stores earned_cents for every video in a campaign. Returns the number of videos changed. */
export async function recomputeCampaign(env, campaignId) {
  const [campaign, affiliates, videos, frozen] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId),
    env.DB.prepare('SELECT id, cpm_rate_override_cents FROM campaign_affiliates WHERE campaign_id = ?').bind(campaignId),
    env.DB.prepare('SELECT id, campaign_affiliate_id, creator_id, status, submitted_at, latest_view_count, billable_views, earned_cents FROM videos WHERE campaign_id = ?').bind(campaignId),
    env.DB.prepare('SELECT video_id, amount_cents FROM payout_line_items WHERE campaign_id = ?').bind(campaignId)
  ]);
  const c = campaign.results[0];
  if (!c) return 0;
  const overrides = new Map(affiliates.results.map(a => [a.id, a.cpm_rate_override_cents]));
  const earned = computeEarnings(c, videos.results, overrides, new Map(frozen.results.map(f => [f.video_id, f.amount_cents])));
  const changed = videos.results.filter(v => earned.get(v.id) !== v.earned_cents);
  for (let i = 0; i < changed.length; i += 50) {
    await env.DB.batch(changed.slice(i, i + 50).map(v => env.DB.prepare('UPDATE videos SET earned_cents = ? WHERE id = ?').bind(earned.get(v.id), v.id)));
  }
  return changed.length;
}

// Per-assignment totals, joined onto campaign_affiliates `ca`. Used by the portal and the admin tables.
export const ASSIGNMENT_STATS_SQL = `
  (SELECT COUNT(*) FROM videos v WHERE v.campaign_affiliate_id = ca.id) video_count,
  (SELECT COALESCE(SUM(CASE v.status WHEN 'locked' THEN v.billable_views WHEN 'approved' THEN v.latest_view_count ELSE 0 END), 0)
     FROM videos v WHERE v.campaign_affiliate_id = ca.id) total_views,
  (SELECT COALESCE(SUM(v.earned_cents), 0) FROM videos v WHERE v.campaign_affiliate_id = ca.id AND v.status = 'locked') earned_cents,
  (SELECT COALESCE(SUM(v.earned_cents), 0) FROM videos v WHERE v.campaign_affiliate_id = ca.id AND v.status = 'approved') pending_cents,
  (SELECT COALESCE(SUM(li.amount_cents), 0) FROM payout_line_items li JOIN payouts p ON p.id = li.payout_id
     WHERE p.status = 'paid' AND li.campaign_id = ca.campaign_id AND p.creator_id = ca.creator_id) paid_cents`;

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
