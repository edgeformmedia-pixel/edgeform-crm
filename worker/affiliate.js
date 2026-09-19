import { json, HttpError, clean, now, readJson, randomToken, sha256, isEmail } from './lib.js';
import { sendEmail } from './email.js';
import {
  PLATFORMS, PAYOUT_METHODS, PORTAL_URL, ASSIGNMENT_STATS_SQL, orNull, parseJson, addDays, resolveVideoUrl, normalizeHandle,
  encryptText, auditStatement, flagStatement
} from './affiliate-lib.js';

// Affiliate portal API (CONTRACT.md §4), served at /api/affiliate/v1 to affiliate.edgeformmarketing.com.
// snake_case JSON; errors are { ok: false, error, code }. The creator always comes from the session.

export const AFFILIATE_PREFIX = '/api/affiliate/v1';
const LOGIN_TOKEN_MINUTES = 15;
const SESSION_DAYS = 30;
const MAGIC_LINKS_PER_HOUR = 5;

const fail = (status, message, code) => new HttpError(status, message, code);
const invalid = (message) => fail(400, message, 'validation_error');
const DEFAULT_CODES = { 400: 'validation_error', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 429: 'rate_limited', 501: 'not_available', 502: 'upstream_error', 503: 'not_configured' };

// ── Shapes (every key present, null when empty) ──

export const creatorJson = (c) => ({
  id: c.id, name: orNull(c.name), email: orNull(c.email), phone: orNull(c.phone),
  instagram: orNull(c.instagram), tiktok: orNull(c.tiktok), youtube: orNull(c.youtube), country: orNull(c.country),
  payout_method: orNull(c.payout_method), payout_details_last4: orNull(c.payout_details_last4), tax_form_received: c.tax_form_received === 1
});

const campaignSummary = (r) => ({
  id: r.id, name: r.name, status: r.status, start_date: orNull(r.start_date), end_date: orNull(r.end_date),
  platforms_allowed: parseJson(r.platforms_allowed, []), cpm_rate_cents: r.cpm_rate_cents, currency: r.currency,
  assignment_status: r.assignment_status, video_count: r.video_count, total_views: r.total_views,
  earned_cents: r.earned_cents,
  // Added with uplines (CONTRACT.md §6).
  rank: r.rank, override_earned_cents: r.override_earned_cents,
  // v5: the % of their downline's pay they earn on top (basis points, 500 = 5%).
  override_bps: r.override_bps
});

const campaignDetail = (r) => ({
  ...campaignSummary(r), brief: r.brief,
  min_views_to_qualify: r.min_views_to_qualify, max_payout_per_video_cents: r.max_payout_per_video_cents,
  requires_video_approval: r.requires_video_approval === 1
});

export const videoJson = (v) => ({
  id: v.id, campaign_id: v.campaign_id, submitted_url: v.submitted_url, canonical_url: v.canonical_url, platform: v.platform,
  thumbnail_url: orNull(v.thumbnail_url), caption: orNull(v.caption), posted_at: orNull(v.posted_at), status: v.status,
  rejection_reason: orNull(v.rejection_reason), submitted_at: v.submitted_at,
  locked_at: orNull(v.locked_at), latest_view_count: v.latest_view_count, billable_views: v.billable_views,
  earned_cents: v.earned_cents, last_fetched_at: orNull(v.last_fetched_at),
  // v6: insights screenshots uploaded as proof of views (CONTRACT.md §7).
  screenshot_count: v.screenshot_count || 0, last_screenshot_at: orNull(v.last_screenshot_at)
});

export const screenshotJson = (s) => ({
  id: s.id, video_id: s.video_id, content_type: s.content_type, size_bytes: s.size_bytes,
  reported_views: s.reported_views ?? null, note: orNull(s.note), uploaded_at: s.uploaded_at
});

const VIDEO_WITH_SCREENSHOTS = `SELECT v.*,
    (SELECT COUNT(*) FROM video_screenshots s WHERE s.video_id = v.id) screenshot_count,
    (SELECT MAX(s.uploaded_at) FROM video_screenshots s WHERE s.video_id = v.id) last_screenshot_at
  FROM videos v`;

// ── Session ──

const bearer = (request) => (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

async function requireCreator(request, env) {
  const token = bearer(request);
  if (!token) throw fail(401, 'Please sign in.', 'unauthorized');
  const creator = await env.DB.prepare(
    `SELECT c.* FROM affiliate_sessions s JOIN creators c ON c.id = s.creator_id WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256(token), now()).first();
  if (!creator) throw fail(401, 'Your session has expired. Please sign in again.', 'unauthorized');
  return creator;
}

// ── Auth ──

async function magicLink(request, env, headers) {
  const email = clean((await readJson(request)).email, 254).toLowerCase();
  if (!isEmail(email)) throw invalid('Enter a valid email address.');
  // Only creators on at least one campaign get a link. The response never says whether the email exists.
  const creator = await env.DB.prepare(
    `SELECT c.id, c.name, c.email FROM creators c WHERE c.email = ? COLLATE NOCASE AND c.email <> ''
       AND EXISTS (SELECT 1 FROM campaign_affiliates ca WHERE ca.creator_id = c.id AND ca.status <> 'removed')`
  ).bind(email).first();
  if (creator) {
    const recent = await env.DB.prepare('SELECT COUNT(*) n FROM affiliate_login_tokens WHERE creator_id = ? AND created_at > ?')
      .bind(creator.id, new Date(Date.now() - 3600000).toISOString()).first();
    if (recent.n < MAGIC_LINKS_PER_HOUR) {
      const token = randomToken(32);
      await env.DB.prepare('INSERT INTO affiliate_login_tokens (token_hash, creator_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .bind(await sha256(token), creator.id, new Date(Date.now() + LOGIN_TOKEN_MINUTES * 60000).toISOString(), now()).run();
      const first = String(creator.name || '').split(' ')[0] || 'there';
      try {
        await sendEmail(env, {
          to: creator.email,
          subject: 'Your Edgeform affiliate sign-in link',
          text: `Hi ${first},\n\nUse this link to sign in to your Edgeform affiliate dashboard. It works once and expires in ${LOGIN_TOKEN_MINUTES} minutes:\n${PORTAL_URL}/verify.html?token=${token}\n\nIf you didn't ask for this, you can ignore this email.\n\n— Edgeform Marketing Group`
        });
      } catch (error) {
        console.error('affiliate magic link email failed', error?.message);
      }
    }
  }
  return json({ ok: true }, 200, headers);
}

async function verify(request, env, headers) {
  const token = clean((await readJson(request)).token, 256);
  const badToken = () => fail(400, 'This sign-in link is invalid, already used, or expired. Request a new one.', 'invalid_token');
  if (!token) throw badToken();
  const hash = await sha256(token);
  const row = await env.DB.prepare('SELECT * FROM affiliate_login_tokens WHERE token_hash = ?').bind(hash).first();
  if (!row || row.used_at || row.expires_at <= now()) throw badToken();
  // Claim first so a link can't be used twice concurrently.
  const claim = await env.DB.prepare('UPDATE affiliate_login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(now(), hash).run();
  if (!claim.meta.changes) throw badToken();

  const session = randomToken(32);
  const stamp = now();
  const expiresAt = addDays(stamp, SESSION_DAYS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM affiliate_sessions WHERE creator_id = ? AND expires_at <= ?').bind(row.creator_id, stamp),
    env.DB.prepare('INSERT INTO affiliate_sessions (token_hash, creator_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(session), row.creator_id, stamp, expiresAt),
    env.DB.prepare('UPDATE creators SET portal_last_login_at = ? WHERE id = ?').bind(stamp, row.creator_id),
    env.DB.prepare(`UPDATE campaign_affiliates SET status = 'active', joined_at = COALESCE(joined_at, ?), updated_at = ?
      WHERE creator_id = ? AND status = 'invited'`).bind(stamp, stamp, row.creator_id)
  ]);
  const creator = await env.DB.prepare('SELECT * FROM creators WHERE id = ?').bind(row.creator_id).first();
  if (!creator) throw badToken();
  return json({ ok: true, session_token: session, expires_at: expiresAt, creator: creatorJson(creator) }, 200, headers);
}

async function logout(request, env, headers) {
  const token = bearer(request);
  if (token) await env.DB.prepare('DELETE FROM affiliate_sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, headers);
}

// ── Me ──

async function getMe(request, env, headers) {
  return json({ ok: true, creator: creatorJson(await requireCreator(request, env)) }, 200, headers);
}

// Last 4 letters/digits of what they typed (PayPal email, IBAN, account number…).
const lastFour = (text) => String(text).replace(/[^A-Za-z0-9]/g, '').slice(-4) || null;

async function patchMe(request, env, headers) {
  const creator = await requireCreator(request, env);
  const body = await readJson(request);
  const fields = {};
  const text = (key, max) => {
    if (body[key] === undefined) return;
    if (body[key] !== null && typeof body[key] !== 'string') throw invalid(`${key} must be text.`);
    fields[key] = clean(body[key], max);
  };
  text('name', 160);
  if (fields.name === '') throw invalid('Name can’t be empty.');
  text('phone', 40);
  for (const platform of PLATFORMS) text(platform, 300);
  if (body.country !== undefined) {
    const country = clean(body.country, 2).toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) throw invalid('country must be a 2-letter ISO code, like US.');
    fields.country = country || null;
  }
  if (body.payout_method !== undefined) {
    if (body.payout_method !== null && !PAYOUT_METHODS.includes(body.payout_method)) throw invalid(`payout_method must be one of: ${PAYOUT_METHODS.join(', ')}.`);
    fields.payout_method = body.payout_method;
  }
  if (body.payout_details !== undefined) {
    const details = body.payout_details;
    const plain = details === null ? '' : typeof details === 'string' ? details.trim() : typeof details === 'object' ? JSON.stringify(details) : null;
    if (plain === null) throw invalid('payout_details must be text or an object.');
    if (plain.length > 4000) throw invalid('payout_details is too long.');
    const shown = typeof details === 'object' && details !== null ? Object.values(details).join('') : plain;
    fields.payout_details_encrypted = plain ? await encryptText(plain, env.AFFILIATE_ENCRYPTION_KEY) : null;
    fields.payout_details_last4 = plain ? lastFour(shown) : null;
  }
  if (!Object.keys(fields).length) return json({ ok: true, creator: creatorJson(creator) }, 200, headers);

  fields.updated_at = now();
  const statements = [env.DB.prepare(`UPDATE creators SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(fields), creator.id)];
  const payoutChanged = 'payout_details_encrypted' in fields || ('payout_method' in fields && fields.payout_method !== creator.payout_method);
  if (payoutChanged) {
    statements.push(auditStatement(env, {
      actorType: 'creator', actorId: creator.id, entityType: 'creator', entityId: creator.id, action: 'payout_details_changed',
      before: { payout_method: creator.payout_method, payout_details_last4: creator.payout_details_last4 },
      after: { payout_method: fields.payout_method ?? creator.payout_method, payout_details_last4: 'payout_details_last4' in fields ? fields.payout_details_last4 : creator.payout_details_last4 }
    }));
  }
  await env.DB.batch(statements);
  const fresh = await env.DB.prepare('SELECT * FROM creators WHERE id = ?').bind(creator.id).first();
  return json({ ok: true, creator: creatorJson(fresh) }, 200, headers);
}

// ── Campaigns ──

const CAMPAIGN_SQL = `SELECT c.*, ca.id assignment_id, ca.status assignment_status, ca.rank,
    COALESCE(ca.cpm_rate_override_cents, c.default_cpm_rate_cents) cpm_rate_cents,
    COALESCE(ca.override_bps, c.default_override_bps) override_bps, ${ASSIGNMENT_STATS_SQL}
  FROM campaign_affiliates ca JOIN campaigns c ON c.id = ca.campaign_id
  WHERE ca.creator_id = ? AND ca.status <> 'removed' AND c.status <> 'draft'`;

async function assignedCampaign(env, creatorId, campaignId) {
  const row = await env.DB.prepare(`${CAMPAIGN_SQL} AND c.id = ?`).bind(creatorId, campaignId).first();
  if (!row) throw fail(404, 'Campaign not found.', 'not_found');
  return row;
}

async function listCampaigns(request, env, headers) {
  const creator = await requireCreator(request, env);
  const rows = await env.DB.prepare(`${CAMPAIGN_SQL} ORDER BY c.created_at DESC`).bind(creator.id).all();
  return json({ ok: true, data: rows.results.map(campaignSummary) }, 200, headers);
}

async function getCampaign(request, env, headers, [id]) {
  const creator = await requireCreator(request, env);
  return json({ ok: true, campaign: campaignDetail(await assignedCampaign(env, creator.id, id)) }, 200, headers);
}

// ── Videos ──

async function listVideos(request, env, headers, [id]) {
  const creator = await requireCreator(request, env);
  const campaign = await assignedCampaign(env, creator.id, id);
  const rows = await env.DB.prepare(`${VIDEO_WITH_SCREENSHOTS} WHERE v.campaign_affiliate_id = ? ORDER BY v.submitted_at DESC, v.id DESC`).bind(campaign.assignment_id).all();
  return json({ ok: true, data: rows.results.map(videoJson) }, 200, headers);
}

async function submitVideo(request, env, headers, [id]) {
  const creator = await requireCreator(request, env);
  const body = await readJson(request);
  const row = await env.DB.prepare(`SELECT c.*, ca.id assignment_id, ca.status assignment_status
    FROM campaigns c LEFT JOIN campaign_affiliates ca ON ca.campaign_id = c.id AND ca.creator_id = ? WHERE c.id = ?`).bind(creator.id, id).first();
  if (!row || row.status === 'draft') throw fail(404, 'Campaign not found.', 'not_found');
  if (!row.assignment_id || row.assignment_status === 'removed') throw fail(403, 'You’re not part of this campaign.', 'not_assigned');
  if (row.status !== 'active') throw fail(409, 'This campaign isn’t accepting videos right now.', 'campaign_not_active');
  if (typeof body.url !== 'string' || !body.url.trim()) throw fail(400, 'Paste the link to your video.', 'invalid_url');

  const parsed = await resolveVideoUrl(body.url);
  if (!parseJson(row.platforms_allowed, []).includes(parsed.platform)) {
    throw fail(400, `This campaign doesn’t accept ${({ tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' })[parsed.platform]} videos.`, 'platform_not_allowed');
  }
  const duplicate = () => fail(409, 'That video was already submitted.', 'duplicate_video');
  if (await env.DB.prepare('SELECT 1 FROM videos WHERE platform = ? AND platform_video_id = ?').bind(parsed.platform, parsed.platform_video_id).first()) throw duplicate();

  const stamp = now();
  const approved = row.requires_video_approval !== 1;
  const video = {
    id: crypto.randomUUID(), campaign_affiliate_id: row.assignment_id, campaign_id: row.id, creator_id: creator.id,
    submitted_url: clean(body.url, 2000), platform: parsed.platform, platform_video_id: parsed.platform_video_id,
    canonical_url: parsed.canonical_url, status: approved ? 'approved' : 'pending_review', submitted_at: stamp,
    approved_at: approved ? stamp : null,
    // Retired (views are now checked weekly by hand, for as long as the campaign stays active), but the
    // column is still NOT NULL with no default — a distant sentinel keeps the insert valid without giving
    // it real meaning.
    tracking_ends_at: addDays(stamp, 36500)
  };
  const statements = [
    env.DB.prepare(`INSERT INTO videos (${Object.keys(video).join(', ')}) VALUES (${Object.keys(video).map(() => '?').join(', ')})`).bind(...Object.values(video)),
    // Submitting counts as joining, for creators added to this campaign after they last signed in.
    env.DB.prepare(`UPDATE campaign_affiliates SET status = 'active', joined_at = COALESCE(joined_at, ?), updated_at = ? WHERE id = ? AND status = 'invited'`)
      .bind(stamp, stamp, row.assignment_id)
  ];
  const saved = normalizeHandle(creator[parsed.platform]);
  if (parsed.handle && saved && parsed.handle !== saved) {
    statements.push(flagStatement(env, video.id, 'handle_mismatch', `Link is from @${parsed.handle}; creator's ${parsed.platform} is @${saved}.`));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) throw duplicate();
    throw error;
  }
  const stored = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(video.id).first();
  return json({ ok: true, video: videoJson(stored) }, 201, headers);
}

async function deleteVideo(request, env, headers, [id]) {
  const creator = await requireCreator(request, env);
  const video = await env.DB.prepare('SELECT id, status FROM videos WHERE id = ? AND creator_id = ?').bind(id, creator.id).first();
  if (!video) throw fail(404, 'Video not found.', 'not_found');
  if (video.status !== 'pending_review') throw fail(409, 'Only videos waiting for review can be deleted.', 'not_deletable');
  const result = await env.DB.prepare("DELETE FROM videos WHERE id = ? AND status = 'pending_review'").bind(id).run();
  if (!result.meta.changes) throw fail(409, 'Only videos waiting for review can be deleted.', 'not_deletable');
  return json({ ok: true }, 200, headers);
}

// ── Earnings and payouts ──

async function earnings(request, env, headers) {
  const creator = await requireCreator(request, env);
  const [rows, paid] = await env.DB.batch([
    env.DB.prepare(`SELECT c.id campaign_id, c.name campaign_name, c.status, ca.status assignment_status, ${ASSIGNMENT_STATS_SQL}
      FROM campaign_affiliates ca JOIN campaigns c ON c.id = ca.campaign_id WHERE ca.creator_id = ? ORDER BY c.created_at DESC`).bind(creator.id),
    env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) n FROM payouts WHERE creator_id = ? AND status = 'paid'").bind(creator.id)
  ]);
  // Drafts and removed assignments only show once they have money in them.
  const byCampaign = rows.results
    .filter(r => (r.status !== 'draft' && r.assignment_status !== 'removed') || r.earned_cents || r.paid_cents || r.override_earned_cents)
    .map(r => ({
      campaign_id: r.campaign_id, campaign_name: r.campaign_name, earned_cents: r.earned_cents,
      paid_cents: r.paid_cents, owed_cents: r.earned_cents + r.override_earned_cents - r.paid_cents,
      override_earned_cents: r.override_earned_cents
    }));
  const sum = (key) => rows.results.reduce((n, r) => n + r[key], 0);
  const paidCents = paid.results[0].n;
  // owed includes upline overrides, since they're paid on the same payouts.
  return json({
    ok: true,
    earnings: {
      currency: 'USD', earned_cents: sum('earned_cents'),
      paid_cents: paidCents, owed_cents: sum('earned_cents') + sum('override_earned_cents') - paidCents, by_campaign: byCampaign,
      override_earned_cents: sum('override_earned_cents')
    }
  }, 200, headers);
}

async function payouts(request, env, headers) {
  const creator = await requireCreator(request, env);
  const [list, items, overrides] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM payouts WHERE creator_id = ? ORDER BY created_at DESC, id DESC').bind(creator.id),
    env.DB.prepare(`SELECT li.*, c.name campaign_name, v.canonical_url FROM payout_line_items li
      JOIN payouts p ON p.id = li.payout_id LEFT JOIN campaigns c ON c.id = li.campaign_id LEFT JOIN videos v ON v.id = li.video_id
      WHERE p.creator_id = ? ORDER BY c.name, v.submitted_at`).bind(creator.id),
    env.DB.prepare(`SELECT poi.*, c.name campaign_name, v.canonical_url, cr.name from_name, s.earned_cents from_earned_cents FROM payout_override_items poi
      JOIN payouts p ON p.id = poi.payout_id LEFT JOIN campaigns c ON c.id = poi.campaign_id LEFT JOIN videos v ON v.id = poi.video_id
      LEFT JOIN campaign_affiliates src ON src.id = poi.source_campaign_affiliate_id LEFT JOIN creators cr ON cr.id = src.creator_id
      LEFT JOIN view_snapshots s ON s.id = poi.view_snapshot_id
      WHERE p.creator_id = ? ORDER BY c.name, v.submitted_at`).bind(creator.id)
  ]);
  const data = list.results.map(p => ({
    id: p.id, period_start: orNull(p.period_start), period_end: orNull(p.period_end), amount_cents: p.amount_cents, currency: p.currency,
    status: p.status, payment_method: orNull(p.payment_method), payment_reference: orNull(p.payment_reference), paid_at: orNull(p.paid_at),
    line_items: items.results.filter(li => li.payout_id === p.id).map(li => ({
      video_id: li.video_id, campaign_id: li.campaign_id, campaign_name: orNull(li.campaign_name), canonical_url: orNull(li.canonical_url),
      billable_views: li.billable_views, cpm_rate_cents: li.cpm_rate_cents, amount_cents: li.amount_cents
    })),
    // Added with uplines: what they earned on their downline's videos.
    override_items: overrides.results.filter(o => o.payout_id === p.id).map(o => ({
      video_id: o.video_id, campaign_id: o.campaign_id, campaign_name: orNull(o.campaign_name), canonical_url: orNull(o.canonical_url),
      from_name: orNull(o.from_name), billable_views: o.billable_views, cpm_diff_cents: o.cpm_diff_cents, amount_cents: o.amount_cents,
      override_bps: o.override_bps ?? null, from_earned_cents: o.from_earned_cents ?? null
    }))
  }));
  return json({ ok: true, data }, 200, headers);
}

// ── Team (their downline only) ──

// The caller and everyone below them in this campaign. Only names, ranks, rates and totals: no contact details,
// and nothing about their upline.
async function team(request, env, headers, [id]) {
  const creator = await requireCreator(request, env);
  const campaign = await assignedCampaign(env, creator.id, id);
  const [members, fromEach] = await env.DB.batch([
    env.DB.prepare(`SELECT ca.id, ca.upline_id, ca.rank, ca.status, cr.name, COALESCE(ca.cpm_rate_override_cents, c.default_cpm_rate_cents) cpm_rate_cents,
        COALESCE(ca.override_bps, c.default_override_bps) override_bps,
        (SELECT COUNT(*) FROM videos v WHERE v.campaign_affiliate_id = ca.id) video_count,
        (SELECT COALESCE(SUM(CASE v.status WHEN 'locked' THEN v.billable_views WHEN 'approved' THEN v.latest_view_count ELSE 0 END), 0) FROM videos v WHERE v.campaign_affiliate_id = ca.id) total_views
      FROM campaign_affiliates ca JOIN campaigns c ON c.id = ca.campaign_id JOIN creators cr ON cr.id = ca.creator_id
      WHERE ca.campaign_id = ? AND ca.status <> 'removed'`).bind(id),
    // What the caller earned from each downline member's own videos.
    env.DB.prepare(`SELECT oe.source_campaign_affiliate_id id, COALESCE(SUM(oe.amount_cents), 0) earned
      FROM override_earnings oe WHERE oe.campaign_affiliate_id = ? GROUP BY oe.source_campaign_affiliate_id`).bind(campaign.assignment_id)
  ]);
  const children = new Map();
  for (const m of members.results) if (m.upline_id) children.set(m.upline_id, [...(children.get(m.upline_id) || []), m]);
  const mine = new Map(fromEach.results.map(r => [r.id, r]));
  const node = (m, depth) => ({
    id: m.id, name: m.name, rank: m.rank, cpm_rate_cents: m.cpm_rate_cents, override_bps: m.override_bps, status: m.status, level: depth,
    video_count: m.video_count, total_views: m.total_views,
    your_override_earned_cents: depth ? mine.get(m.id)?.earned || 0 : 0,
    downline: depth < 50 ? (children.get(m.id) || []).sort((a, b) => a.name.localeCompare(b.name)).map(c => node(c, depth + 1)) : []
  });
  const me = members.results.find(m => m.id === campaign.assignment_id);
  return json({ ok: true, team: node(me, 0) }, 200, headers);
}

// ── View screenshots (v6) ──
// The affiliate uploads their insights screen (trial reels and other posts with no public count).
// Raw image body; staff read the number off it during the weekly check.

const SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_SCREENSHOTS_PER_VIDEO = 30;

async function ownVideo(env, creatorId, id) {
  const video = await env.DB.prepare('SELECT id, status FROM videos WHERE id = ? AND creator_id = ?').bind(id, creatorId).first();
  if (!video) throw fail(404, 'Video not found.', 'not_found');
  return video;
}

async function uploadScreenshot(request, env, headers, [id]) {
  const creator = await requireCreator(request, env);
  const video = await ownVideo(env, creator.id, id);
  if (!['pending_review', 'approved'].includes(video.status)) throw fail(409, 'Screenshots can only be added to videos that are still being tracked.', 'video_not_tracking');
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!SCREENSHOT_TYPES.includes(type)) throw fail(415, 'Upload a PNG, JPEG, or WebP image.', 'unsupported_image');
  if (Number(request.headers.get('content-length') || 0) > MAX_SCREENSHOT_BYTES) throw fail(413, 'Screenshots must be 10MB or smaller.', 'image_too_large');
  const q = new URL(request.url).searchParams;
  let views = null;
  if (q.get('views') !== null && q.get('views') !== '') {
    views = Number(String(q.get('views')).replace(/[,\s]/g, ''));
    if (!Number.isSafeInteger(views) || views < 0) throw invalid('Views must be a whole number.');
  }
  const { n } = await env.DB.prepare('SELECT COUNT(*) n FROM video_screenshots WHERE video_id = ?').bind(id).first();
  if (n >= MAX_SCREENSHOTS_PER_VIDEO) throw fail(409, 'This video already has the maximum number of screenshots.', 'too_many_screenshots');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw invalid('The image is empty.');
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw fail(413, 'Screenshots must be 10MB or smaller.', 'image_too_large');
  const row = {
    id: crypto.randomUUID(), video_id: id, creator_id: creator.id, content_type: type, size_bytes: bytes.byteLength,
    reported_views: views, note: clean(q.get('note'), 500) || null, uploaded_at: now()
  };
  await env.SKETCHES.put(`video-screenshots/${row.id}`, bytes, { httpMetadata: { contentType: type } });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO video_screenshots (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).bind(...Object.values(row)),
    auditStatement(env, { actorType: 'creator', actorId: creator.id, entityType: 'video', entityId: id, action: 'screenshot_uploaded', before: null, after: { screenshot_id: row.id, reported_views: views } })
  ]);
  return json({ ok: true, screenshot: screenshotJson(row) }, 201, headers);
}

async function listScreenshots(request, env, headers, [id]) {
  const creator = await requireCreator(request, env);
  await ownVideo(env, creator.id, id);
  const rows = await env.DB.prepare('SELECT * FROM video_screenshots WHERE video_id = ? ORDER BY uploaded_at DESC').bind(id).all();
  return json({ ok: true, data: rows.results.map(screenshotJson) }, 200, headers);
}

async function getScreenshot(request, env, headers, [id]) {
  const creator = await requireCreator(request, env);
  const row = await env.DB.prepare('SELECT id FROM video_screenshots WHERE id = ? AND creator_id = ?').bind(id, creator.id).first();
  const object = row && await env.SKETCHES.get(`video-screenshots/${row.id}`);
  if (!object) throw fail(404, 'Screenshot not found.', 'not_found');
  return new Response(object.body, { headers: { ...headers, 'content-type': object.httpMetadata?.contentType || 'image/png', 'cache-control': 'private, max-age=3600' } });
}

async function deleteScreenshot(request, env, headers, [id]) {
  const creator = await requireCreator(request, env);
  const row = await env.DB.prepare(`SELECT s.id, s.video_id, s.uploaded_at, v.last_fetched_at FROM video_screenshots s JOIN videos v ON v.id = s.video_id
    WHERE s.id = ? AND s.creator_id = ?`).bind(id, creator.id).first();
  if (!row) throw fail(404, 'Screenshot not found.', 'not_found');
  // Once staff have checked views after the upload, it's evidence for a priced week and stays.
  if (row.last_fetched_at && row.last_fetched_at >= row.uploaded_at) throw fail(409, 'This screenshot was already used for a views check, so it can’t be deleted.', 'not_deletable');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM video_screenshots WHERE id = ?').bind(id),
    auditStatement(env, { actorType: 'creator', actorId: creator.id, entityType: 'video', entityId: row.video_id, action: 'screenshot_deleted', before: { screenshot_id: id }, after: null })
  ]);
  await env.SKETCHES.delete(`video-screenshots/${id}`);
  return json({ ok: true }, 200, headers);
}

// ── Routing ──

const routes = {
  'POST /auth/magic-link': magicLink,
  'POST /auth/verify': verify,
  'POST /auth/logout': logout,
  'GET /me': getMe,
  'PATCH /me': patchMe,
  'GET /campaigns': listCampaigns,
  'GET /campaigns/:id': getCampaign,
  'GET /campaigns/:id/videos': listVideos,
  'GET /campaigns/:id/team': team,
  'POST /campaigns/:id/videos': submitVideo,
  'DELETE /videos/:id': deleteVideo,
  'GET /videos/:id/screenshots': listScreenshots,
  'POST /videos/:id/screenshots': uploadScreenshot,
  'GET /screenshots/:id': getScreenshot,
  'DELETE /screenshots/:id': deleteScreenshot,
  'GET /earnings': earnings,
  'GET /payouts': payouts
};

const compiled = Object.entries(routes).map(([key, handler]) => {
  const [method, path] = key.split(' ');
  return { method, pattern: new RegExp('^' + AFFILIATE_PREFIX + path.replace(/:[a-z]+/g, '([^/]+)') + '$'), handler };
});

export async function affiliateFetch(request, env, headers) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  try {
    for (const { method, pattern, handler } of compiled) {
      const match = request.method === method && path.match(pattern);
      if (match) return await handler(request, env, headers, match.slice(1).map(decodeURIComponent));
    }
    throw fail(404, 'Not found.', 'not_found');
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ ok: false, error: error.message, code: error.code || DEFAULT_CODES[error.status] || 'error' }, error.status, headers);
    }
    console.error('affiliate api error', error);
    return json({ ok: false, error: 'Something went wrong. Please try again.', code: 'internal_error' }, 500, headers);
  }
}
