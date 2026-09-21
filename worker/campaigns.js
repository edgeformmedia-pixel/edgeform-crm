import { json, HttpError, clean, now, readJson, isEmail } from './lib.js';
import { requireUser, requireAdmin } from './auth.js';
import { sendEmail } from './email.js';
import {
  PLATFORMS, CAMPAIGN_STATUSES, ASSIGNMENT_STATUSES, RANKS, PORTAL_URL, ASSIGNMENT_STATS_SQL, parseJson, recomputeCampaign, auditStatement,
  resolveVideoUrl
} from './affiliate-lib.js';
import {
  DEFAULT_QUESTIONS, MAX_EXAMPLE_VIDEOS, AUDIENCE_LABELS, readQuestions, isHttpUrl, applicationState, publicUrl, uniqueSlug,
  ensureRefCode, freshRefCode, deriveUpline, wouldCycle, checkFraming, exampleEmbed
} from './applications-lib.js';
import { payExplainerText } from './pay-explainer.js';

// Admin side of affiliate campaigns (camelCase JSON, like the rest of the admin API).
// Campaigns hang off marketing operations; each has an Email channel (placeholder) and an Affiliate channel.

const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function wholeNumber(value, label, { nullable = true, max = 1e12 } = {}) {
  if (value === null || value === '' || value === undefined) {
    if (nullable) return null;
    throw new HttpError(400, `${label} is required.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, `${label} must be a whole number of 0 or more.`);
  return n;
}

function dateOrNull(value, label) {
  const text = clean(value, 10);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, `${label} must be a date.`);
  return text;
}

const httpsUrlOrBlank = (value, label) => {
  const text = clean(value, 2000);
  if (text && (!/^https:\/\//i.test(text) || !isHttpUrl(text))) throw new HttpError(400, `${label} must be a full https:// link.`);
  return text;
};

const limited = (value, max, label) => {
  const text = String(value ?? '').trim();
  if (text.length > max) throw new HttpError(400, `${label} is ${text.length} characters; the limit is ${max}.`);
  return text;
};

// The application page settings (CONTRACT.md §9). Format only; slug uniqueness is checked against the DB by the caller.
function readApplicationSettings(body, existing) {
  const pick = (key, column) => (body[key] === undefined ? existing[column] : body[key]);
  const slug = String(pick('publicSlug', 'public_slug') ?? '').trim().toLowerCase();
  if (slug && !/^[a-z0-9-]{3,60}$/.test(slug)) throw new HttpError(400, 'The link name must be 3–60 lowercase letters, digits or dashes.');
  const seats = pick('applicationSeats', 'application_seats');
  const questions = body.applicationQuestions !== undefined ? body.applicationQuestions
    : existing.application_questions !== undefined ? existing.application_questions : DEFAULT_QUESTIONS;
  return {
    application_enabled: (body.applicationEnabled === undefined ? existing.application_enabled === 1 : body.applicationEnabled === true) ? 1 : 0,
    public_slug: slug || null,
    public_headline: limited(pick('publicHeadline', 'public_headline'), 120, 'The headline'),
    public_pitch: limited(pick('publicPitch', 'public_pitch'), 4000, 'The pitch'),
    brand_name: limited(pick('brandName', 'brand_name'), 120, 'The brand name'),
    promo_url: httpsUrlOrBlank(pick('promoUrl', 'promo_url'), 'The promo site'),
    promo_embed: (body.promoEmbed === undefined ? (existing.promo_embed ?? 1) === 1 : body.promoEmbed === true) ? 1 : 0,
    promo_image_url: httpsUrlOrBlank(pick('promoImageUrl', 'promo_image_url'), 'The fallback image'),
    application_questions: JSON.stringify(readQuestions(questions)),
    application_seats: seats === null || seats === undefined || seats === '' ? null : wholeNumber(seats, 'Seats', { max: 100000 }) || null,
    application_closes_at: dateOrNull(pick('applicationClosesAt', 'application_closes_at'), 'Closing date')
  };
}

// `existing` is the stored row on update, so omitted fields keep their value.
function readCampaign(body, existing = {}) {
  const pick = (key, column) => (body[key] === undefined ? existing[column] : body[key]);
  const name = clean(pick('name', 'name'), 120);
  if (!name) throw new HttpError(400, 'Campaign name is required.');
  const status = pick('status', 'status') || 'draft';
  if (!CAMPAIGN_STATUSES.includes(status)) throw new HttpError(400, 'Invalid campaign status.');
  const platforms = body.platformsAllowed === undefined ? parseJson(existing.platforms_allowed, PLATFORMS) : body.platformsAllowed;
  if (!Array.isArray(platforms) || !platforms.length || platforms.some(p => !PLATFORMS.includes(p))) {
    throw new HttpError(400, 'Pick at least one platform: TikTok, Instagram, or YouTube.');
  }
  const fields = {
    name, status,
    brief: clean(pick('brief', 'brief'), 20000),
    start_date: dateOrNull(pick('startDate', 'start_date'), 'Start date'),
    end_date: dateOrNull(pick('endDate', 'end_date'), 'End date'),
    platforms_allowed: JSON.stringify(PLATFORMS.filter(p => platforms.includes(p))),
    default_cpm_rate_cents: wholeNumber(pick('defaultCpmRateCents', 'default_cpm_rate_cents') ?? 0, 'CPM rate', { nullable: false }),
    default_override_bps: wholeNumber(pick('defaultOverrideBps', 'default_override_bps') ?? 500, 'Team override %', { nullable: false, max: 10000 }),
    max_payout_per_video_cents: wholeNumber(pick('maxPayoutPerVideoCents', 'max_payout_per_video_cents'), 'Max per video'),
    max_payout_per_affiliate_cents: wholeNumber(pick('maxPayoutPerAffiliateCents', 'max_payout_per_affiliate_cents'), 'Max per affiliate'),
    total_budget_cents: wholeNumber(pick('totalBudgetCents', 'total_budget_cents'), 'Total budget'),
    min_views_to_qualify: wholeNumber(pick('minViewsToQualify', 'min_views_to_qualify'), 'Minimum views'),
    requires_video_approval: (body.requiresVideoApproval === undefined ? existing.requires_video_approval ?? 1 : body.requiresVideoApproval) ? 1 : 0,
    ...readApplicationSettings(body, existing)
  };
  if (fields.start_date && fields.end_date && fields.end_date < fields.start_date) throw new HttpError(400, 'End date is before the start date.');
  return fields;
}

// owed = own earned + overrides earned − paid. Everything approved is immediately earned (paid weekly).
const statsJson = (r) => ({
  videoCount: r.video_count, views: r.total_views, earnedCents: r.earned_cents,
  overrideEarnedCents: r.override_earned_cents,
  paidCents: r.paid_cents, owedCents: r.earned_cents + r.override_earned_cents - r.paid_cents
});

function campaignJson(c) {
  return {
    id: c.id, operationId: c.operation_id, name: c.name, brief: c.brief, status: c.status, startDate: c.start_date, endDate: c.end_date,
    platformsAllowed: parseJson(c.platforms_allowed, []), defaultCpmRateCents: c.default_cpm_rate_cents, defaultOverrideBps: c.default_override_bps, currency: c.currency,
    maxPayoutPerVideoCents: c.max_payout_per_video_cents, maxPayoutPerAffiliateCents: c.max_payout_per_affiliate_cents,
    totalBudgetCents: c.total_budget_cents, minViewsToQualify: c.min_views_to_qualify,
    requiresVideoApproval: c.requires_video_approval === 1, createdBy: c.created_by, createdAt: c.created_at, updatedAt: c.updated_at,
    channels: parseJson(c.channels, []).filter(Boolean),
    affiliateCount: c.affiliate_count ?? 0, videoCount: c.video_count ?? 0, pendingReview: c.pending_review ?? 0, openFlags: c.open_flags ?? 0,
    views: c.total_views ?? 0, earnedCents: c.earned_cents ?? 0,
    overrideEarnedCents: c.override_earned_cents ?? 0,
    // v8: the public application page (CONTRACT.md §9).
    applicationEnabled: c.application_enabled === 1, publicSlug: c.public_slug, publicHeadline: c.public_headline, publicPitch: c.public_pitch,
    brandName: c.brand_name, promoUrl: c.promo_url, promoEmbed: c.promo_embed === 1, promoImageUrl: c.promo_image_url,
    applicationQuestions: parseJson(c.application_questions, []), applicationSeats: c.application_seats, applicationClosesAt: c.application_closes_at,
    applicationCounts: { new: 0, reviewing: 0, approved: 0, declined: 0, ...parseJson(c.application_counts, {}) },
    applicationState: applicationState(c, parseJson(c.application_counts, {}).approved || 0),
    publicUrl: publicUrl(c.public_slug)
  };
}

const CAMPAIGN_SQL = `SELECT c.*,
    (SELECT json_group_array(type) FROM campaign_channels ch WHERE ch.campaign_id = c.id) channels,
    (SELECT COUNT(*) FROM campaign_affiliates ca WHERE ca.campaign_id = c.id AND ca.status <> 'removed') affiliate_count,
    (SELECT COUNT(*) FROM videos v WHERE v.campaign_id = c.id) video_count,
    (SELECT COUNT(*) FROM videos v WHERE v.campaign_id = c.id AND v.status = 'pending_review') pending_review,
    (SELECT COUNT(*) FROM video_flags f JOIN videos v ON v.id = f.video_id WHERE v.campaign_id = c.id AND f.resolved_at IS NULL) open_flags,
    (SELECT COALESCE(SUM(v.latest_view_count), 0) FROM videos v WHERE v.campaign_id = c.id) total_views,
    (SELECT COALESCE(SUM(v.earned_cents), 0) FROM videos v WHERE v.campaign_id = c.id) earned_cents,
    (SELECT COALESCE(SUM(oe.amount_cents), 0) FROM override_earnings oe WHERE oe.campaign_id = c.id) override_earned_cents,
    (SELECT json_object('new', COALESCE(SUM(a.status = 'new'), 0), 'reviewing', COALESCE(SUM(a.status = 'reviewing'), 0),
        'approved', COALESCE(SUM(a.status = 'approved'), 0), 'declined', COALESCE(SUM(a.status = 'declined'), 0))
       FROM campaign_applications a WHERE a.campaign_id = c.id) application_counts
  FROM campaigns c`;

function affiliateJson(a) {
  return {
    id: a.id, campaignId: a.campaign_id, creatorId: a.creator_id, status: a.status, rank: a.rank, uplineId: a.upline_id,
    cpmRateOverrideCents: a.cpm_rate_override_cents, effectiveCpmRateCents: a.cpm_rate_override_cents ?? a.default_cpm_rate_cents,
    overrideBps: a.override_bps, effectiveOverrideBps: a.override_bps ?? a.default_override_bps,
    invitedAt: a.invited_at, joinedAt: a.joined_at, createdAt: a.created_at,
    creator: {
      id: a.creator_id, name: a.creator_name, email: a.creator_email, instagram: a.instagram, tiktok: a.tiktok, youtube: a.youtube,
      payoutMethod: a.payout_method || '', payoutDetailsLast4: a.payout_details_last4 || '', taxFormReceived: a.tax_form_received === 1,
      portalLastLoginAt: a.portal_last_login_at
    },
    ...statsJson(a)
  };
}

const AFFILIATES_SQL = `SELECT ca.*, c.default_cpm_rate_cents, c.default_override_bps, cr.name creator_name, cr.email creator_email, cr.instagram, cr.tiktok, cr.youtube,
    cr.payout_method, cr.payout_details_last4, cr.tax_form_received, cr.portal_last_login_at,
    ${ASSIGNMENT_STATS_SQL}
  FROM campaign_affiliates ca JOIN campaigns c ON c.id = ca.campaign_id JOIN creators cr ON cr.id = ca.creator_id`;

async function loadCampaign(env, id) {
  const row = await env.DB.prepare(`${CAMPAIGN_SQL} WHERE c.id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Campaign not found.');
  return row;
}

const exampleVideoJson = (v) => ({
  id: v.id, campaignId: v.campaign_id, url: v.url, platform: v.platform, platformVideoId: v.platform_video_id,
  embedUrl: v.embed_url, thumbnailUrl: v.thumbnail_url, caption: v.caption, sortOrder: v.sort_order, createdAt: v.created_at
});

async function campaignDetail(env, id) {
  const campaign = campaignJson(await loadCampaign(env, id));
  const [affiliates, examples] = await env.DB.batch([
    env.DB.prepare(`${AFFILIATES_SQL} WHERE ca.campaign_id = ? ORDER BY ca.status = 'removed', cr.name`).bind(id),
    env.DB.prepare('SELECT * FROM campaign_example_videos WHERE campaign_id = ? ORDER BY sort_order, created_at').bind(id)
  ]);
  return {
    ...campaign, affiliates: affiliates.results.map(affiliateJson), exampleVideos: examples.results.map(exampleVideoJson),
    // What the Application tab pre-fills when no link name has been picked yet.
    suggestedSlug: campaign.publicSlug || await uniqueSlug(env, campaign.name, id)
  };
}

// ── Campaigns ──

async function listCampaigns(request, env, headers, [operationId]) {
  await requireUser(request, env);
  const rows = await env.DB.prepare(`${CAMPAIGN_SQL} WHERE c.operation_id = ? ORDER BY c.created_at DESC`).bind(operationId).all();
  return json({ ok: true, campaigns: rows.results.map(campaignJson) }, 200, headers);
}

async function listAllCampaigns(request, env, headers) {
  await requireUser(request, env);
  const rows = await env.DB.prepare(`${CAMPAIGN_SQL} ORDER BY c.name`).all();
  return json({ ok: true, campaigns: rows.results.map(campaignJson) }, 200, headers);
}

async function createCampaign(request, env, headers, [operationId]) {
  const user = await requireUser(request, env);
  const op = await env.DB.prepare('SELECT id, type FROM operations WHERE id = ?').bind(operationId).first();
  if (!op) throw new HttpError(404, 'Operation not found.');
  if (op.type !== 'marketing') throw new HttpError(400, 'Campaigns are only for marketing operations.');
  const fields = readCampaign(await readJson(request));
  const id = crypto.randomUUID();
  await settleSlug(env, fields, id);
  const stamp = now();
  const row = { id, operation_id: operationId, ...fields, currency: 'USD', created_by: user.id, created_at: stamp, updated_at: stamp };
  await runWithSlug(env, [
    env.DB.prepare(`INSERT INTO campaigns (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).bind(...Object.values(row)),
    // Every campaign gets both channels. Email is a placeholder for now.
    ...['email', 'affiliate'].map(type => env.DB.prepare('INSERT INTO campaign_channels (id, campaign_id, type, created_at) VALUES (?, ?, ?, ?)')
      .bind(crypto.randomUUID(), id, type, stamp)),
    auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'campaign', entityId: id, action: 'campaign_created', after: fields })
  ]);
  const promoEmbedDetected = fields.promo_url ? await checkFraming(fields.promo_url) : null;
  return json({ ok: true, campaign: await campaignDetail(env, id), promoEmbedDetected }, 201, headers);
}

// Turning the page on with no link name picks one from the campaign name; a name someone else uses is a 409.
async function settleSlug(env, fields, campaignId) {
  if (fields.application_enabled && !fields.public_slug) fields.public_slug = await uniqueSlug(env, fields.name, campaignId);
  if (fields.public_slug && await env.DB.prepare('SELECT 1 FROM campaigns WHERE public_slug = ? AND id <> ?').bind(fields.public_slug, campaignId).first()) {
    throw new HttpError(409, `Another campaign already uses the link name "${fields.public_slug}". Pick a different one.`);
  }
}

async function runWithSlug(env, statements) {
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (/UNIQUE/i.test(error.message) && /public_slug/i.test(error.message)) throw new HttpError(409, 'Another campaign just took that link name. Pick a different one.');
    throw error;
  }
}

const APPLICATION_KEYS = ['application_enabled', 'public_slug', 'public_headline', 'public_pitch', 'brand_name', 'promo_url', 'promo_embed',
  'promo_image_url', 'application_questions', 'application_seats', 'application_closes_at'];

async function getCampaign(request, env, headers, [id]) {
  await requireUser(request, env);
  return json({ ok: true, campaign: await campaignDetail(env, id) }, 200, headers);
}

async function updateCampaign(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const existing = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Campaign not found.');
  const fields = readCampaign(await readJson(request), existing);
  await settleSlug(env, fields, id);
  const statements = [
    env.DB.prepare(`UPDATE campaigns SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...Object.values(fields), now(), id)
  ];
  const audit = (action, keys) => {
    const before = Object.fromEntries(keys.map(k => [k, existing[k]]));
    const after = Object.fromEntries(keys.map(k => [k, fields[k]]));
    if (JSON.stringify(before) !== JSON.stringify(after)) statements.push(auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'campaign', entityId: id, action, before, after }));
  };
  audit('rate_changed', ['default_cpm_rate_cents', 'default_override_bps']);
  audit('caps_changed', ['max_payout_per_video_cents', 'max_payout_per_affiliate_cents', 'total_budget_cents', 'min_views_to_qualify']);
  audit('status_changed', ['status']);
  audit('application_settings_changed', APPLICATION_KEYS);
  // Ending a campaign permanently locks its still-tracking videos: final views frozen, no more weekly
  // entries taken. Pausing is a temporary hold and doesn't touch videos at all.
  const justEnded = existing.status !== 'ended' && fields.status === 'ended';
  if (justEnded) {
    statements.push(env.DB.prepare(`UPDATE videos SET status = 'locked', billable_views = latest_view_count, locked_at = ?
      WHERE campaign_id = ? AND status = 'approved'`).bind(now(), id));
  }
  await runWithSlug(env, statements);
  const moneyChanged = ['default_cpm_rate_cents', 'default_override_bps', 'max_payout_per_video_cents', 'max_payout_per_affiliate_cents', 'total_budget_cents', 'min_views_to_qualify']
    .some(k => existing[k] !== fields[k]);
  if (moneyChanged || justEnded) await recomputeCampaign(env, id);
  // A new promo site is fetched once to see whether it allows framing. It's a suggestion for the
  // promoEmbed toggle; what staff picked is never changed here.
  const promoEmbedDetected = fields.promo_url && fields.promo_url !== existing.promo_url ? await checkFraming(fields.promo_url) : null;
  return json({ ok: true, campaign: await campaignDetail(env, id), promoEmbedDetected }, 200, headers);
}

async function deleteCampaign(request, env, headers, [id]) {
  const user = await requireAdmin(request, env);
  const existing = await env.DB.prepare('SELECT id, name FROM campaigns WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Campaign not found.');
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(id),
      auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'campaign', entityId: id, action: 'campaign_deleted', before: { name: existing.name } })
    ]);
  } catch (error) {
    if (/FOREIGN KEY/i.test(error.message)) throw new HttpError(409, 'This campaign has payouts on record, so it can’t be deleted. Set it to Ended instead.');
    throw error;
  }
  return json({ ok: true }, 200, headers);
}

// ── Affiliates ──

// An upline must be in the same campaign, not removed, and not below this affiliate in the tree.
async function checkUpline(env, campaignId, uplineId, selfId = null) {
  if (uplineId === null || uplineId === undefined || uplineId === '') return null;
  const rows = (await env.DB.prepare('SELECT id, upline_id, status FROM campaign_affiliates WHERE campaign_id = ?').bind(campaignId).all()).results;
  const byId = new Map(rows.map(r => [r.id, r]));
  const upline = byId.get(uplineId);
  if (!upline) throw new HttpError(400, 'That upline isn’t in this campaign.');
  if (upline.status === 'removed') throw new HttpError(400, 'That upline was removed from the campaign.');
  for (let cur = upline, hops = 0; cur && hops < 100; cur = byId.get(cur.upline_id), hops++) {
    if (cur.id === selfId) throw new HttpError(400, 'Someone can’t be placed under their own downline.');
  }
  return uplineId;
}

function readRank(value, fallback = 'rookie') {
  if (value === undefined || value === null || value === '') return fallback;
  if (!RANKS.includes(value)) throw new HttpError(400, `Rank must be one of: ${RANKS.join(', ')}.`);
  return value;
}

async function sendInvite(env, creator, campaign, rateCents, overrideBps = null) {
  const first = String(creator.name || '').split(' ')[0] || 'there';
  // On the starting rate, the invite explains pay in exactly the words the application page uses (§9).
  // A custom rate isn't "where everyone starts", so those invites keep the one-line version.
  const explainer = rateCents === campaign.default_cpm_rate_cents
    ? payExplainerText({
      name: campaign.name, brand_name: campaign.brand_name, platforms_allowed: parseJson(campaign.platforms_allowed, []),
      starting_cpm_rate_cents: rateCents, team_bonus_bps: overrideBps ?? campaign.default_override_bps
    }) + '\n\n'
    : '';
  await sendEmail(env, {
    to: creator.email,
    subject: `You're invited to the ${campaign.name} campaign`,
    text: `Hi ${first},\n\nEdgeform Marketing Group added you to the "${campaign.name}" campaign as an affiliate. ` +
      `You earn ${dollars(rateCents)} per 1,000 views on the videos you post for it.\n\n` + explainer +
      `Sign in with this email address (${creator.email}) to read the brief, submit your videos, and track your views and earnings:\n${PORTAL_URL}/\n\n` +
      `— Edgeform Marketing Group`
  });
}

// Creators added inline land in the real Creators list, like "+ Add creator".
async function createCreatorInline(env, input) {
  const name = clean(input?.name, 160);
  const email = clean(input?.email, 254).toLowerCase();
  if (!name) throw new HttpError(400, 'Enter the creator’s name.');
  if (!isEmail(email)) throw new HttpError(400, 'Enter the creator’s email. It’s how they sign in to the affiliate portal.');
  const taken = await env.DB.prepare("SELECT name FROM creators WHERE email = ? COLLATE NOCASE AND email <> ''").bind(email).first();
  if (taken) throw new HttpError(409, `${taken.name} already uses that email. Pick them from the creator search instead.`);
  const stamp = now();
  const row = {
    id: crypto.randomUUID(), source: 'manual', created_at: stamp, updated_at: stamp, consent: 1, form_status: 'complete', roster_status: 'approved',
    name, email, phone: clean(input.phone, 40),
    instagram: clean(input.instagram, 300), tiktok: clean(input.tiktok, 300), youtube: clean(input.youtube, 300)
  };
  await env.DB.prepare(`INSERT INTO creators (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).bind(...Object.values(row)).run();
  return row;
}

async function addAffiliate(request, env, headers, [campaignId]) {
  const user = await requireUser(request, env);
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) throw new HttpError(404, 'Campaign not found.');
  const body = await readJson(request);
  const override = wholeNumber(body.cpmRateOverrideCents, 'CPM override');
  const overrideBps = wholeNumber(body.overrideBps, 'Team override %', { max: 10000 });
  const rank = readRank(body.rank);
  const uplineId = await checkUpline(env, campaignId, body.uplineId);

  let creator;
  if (body.creatorId) {
    creator = await env.DB.prepare('SELECT * FROM creators WHERE id = ?').bind(clean(body.creatorId, 64)).first();
    if (!creator) throw new HttpError(404, 'Creator not found.');
    if (!isEmail(creator.email || '')) throw new HttpError(400, `Add an email to ${creator.name} first. It’s how they sign in to the affiliate portal.`);
  } else {
    creator = await createCreatorInline(env, body.creator);
  }

  const existing = await env.DB.prepare('SELECT * FROM campaign_affiliates WHERE campaign_id = ? AND creator_id = ?').bind(campaignId, creator.id).first();
  if (existing && existing.status !== 'removed') throw new HttpError(409, `${creator.name} is already in this campaign.`);
  const stamp = now();
  const id = existing?.id || crypto.randomUUID();
  await env.DB.batch([
    existing
      ? env.DB.prepare("UPDATE campaign_affiliates SET status = 'invited', cpm_rate_override_cents = ?, override_bps = ?, rank = ?, upline_id = ?, updated_at = ? WHERE id = ?").bind(override, overrideBps, rank, uplineId, stamp, id)
      : env.DB.prepare(`INSERT INTO campaign_affiliates (id, campaign_id, creator_id, cpm_rate_override_cents, override_bps, rank, upline_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'invited', ?, ?)`).bind(id, campaignId, creator.id, override, overrideBps, rank, uplineId, stamp, stamp),
    auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'campaign_affiliate', entityId: id, action: 'affiliate_added',
      after: { campaign_id: campaignId, creator_id: creator.id, cpm_rate_override_cents: override, override_bps: overrideBps, rank, upline_id: uplineId }
    })
  ]);
  if (uplineId) await recomputeCampaign(env, campaignId);
  // Being put on a campaign is what gives a creator a share link (§9).
  await ensureRefCode(env, creator.id);

  let inviteError = null;
  try {
    await sendInvite(env, creator, campaign, override ?? campaign.default_cpm_rate_cents, overrideBps);
    await env.DB.prepare('UPDATE campaign_affiliates SET invited_at = ? WHERE id = ?').bind(now(), id).run();
  } catch (error) {
    inviteError = error.message || 'Invite email failed.';
  }
  const affiliate = await env.DB.prepare(`${AFFILIATES_SQL} WHERE ca.id = ?`).bind(id).first();
  return json({ ok: true, affiliate: affiliateJson(affiliate), inviteSent: !inviteError, inviteError, creatorCreated: !body.creatorId }, 201, headers);
}

async function updateAffiliate(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const existing = await env.DB.prepare('SELECT * FROM campaign_affiliates WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Affiliate not found.');
  const body = await readJson(request);
  const fields = {};
  if (body.cpmRateOverrideCents !== undefined) fields.cpm_rate_override_cents = wholeNumber(body.cpmRateOverrideCents, 'CPM override');
  if (body.overrideBps !== undefined) fields.override_bps = wholeNumber(body.overrideBps, 'Team override %', { max: 10000 });
  if (body.status !== undefined) {
    if (!ASSIGNMENT_STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid affiliate status.');
    fields.status = body.status;
  }
  if (body.rank !== undefined) fields.rank = readRank(body.rank);
  if (body.uplineId !== undefined) fields.upline_id = await checkUpline(env, existing.campaign_id, body.uplineId, id);
  if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to update.');
  const statements = [env.DB.prepare(`UPDATE campaign_affiliates SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...Object.values(fields), now(), id)];
  const rateKeys = ['cpm_rate_override_cents', 'override_bps'].filter(k => k in fields && fields[k] !== existing[k]);
  if (rateKeys.length) {
    statements.push(auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'campaign_affiliate', entityId: id, action: 'rate_changed',
      before: Object.fromEntries(rateKeys.map(k => [k, existing[k]])), after: Object.fromEntries(rateKeys.map(k => [k, fields[k]]))
    }));
  }
  if ('status' in fields && fields.status !== existing.status) {
    statements.push(auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'campaign_affiliate', entityId: id, action: 'status_changed',
      before: { status: existing.status }, after: { status: fields.status }
    }));
  }
  if ('rank' in fields && fields.rank !== existing.rank) {
    const up = RANKS.indexOf(fields.rank) < RANKS.indexOf(existing.rank);
    statements.push(auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'campaign_affiliate', entityId: id, action: up ? 'promoted' : 'rank_changed',
      before: { rank: existing.rank }, after: { rank: fields.rank }
    }));
  }
  // Removing someone rolls their recruits up to that person's upline, so nobody is left hanging off a removed node.
  if (fields.status === 'removed' && existing.status !== 'removed') {
    const recruits = (await env.DB.prepare('SELECT id FROM campaign_affiliates WHERE upline_id = ?').bind(id).all()).results;
    if (recruits.length) {
      const newUpline = 'upline_id' in fields ? fields.upline_id : existing.upline_id;
      statements.push(
        env.DB.prepare('UPDATE campaign_affiliates SET upline_id = ?, updated_at = ? WHERE upline_id = ?').bind(newUpline, now(), id),
        auditStatement(env, {
          actorType: 'user', actorId: user.id, entityType: 'campaign_affiliate', entityId: id, action: 'recruits_rolled_up',
          after: { recruits: recruits.map(r => r.id), new_upline_id: newUpline }
        })
      );
    }
  }
  const uplineChanged = 'upline_id' in fields && fields.upline_id !== existing.upline_id;
  if (uplineChanged) {
    statements.push(auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'campaign_affiliate', entityId: id, action: 'upline_changed',
      before: { upline_id: existing.upline_id }, after: { upline_id: fields.upline_id }
    }));
  }
  await env.DB.batch(statements);
  // Status matters too: removed uplines are skipped in the chain.
  if (rateKeys.length || uplineChanged || ('status' in fields && fields.status !== existing.status)) await recomputeCampaign(env, existing.campaign_id);
  const affiliate = await env.DB.prepare(`${AFFILIATES_SQL} WHERE ca.id = ?`).bind(id).first();
  return json({ ok: true, affiliate: affiliateJson(affiliate) }, 200, headers);
}

async function resendInvite(request, env, headers, [id]) {
  await requireUser(request, env);
  const row = await env.DB.prepare(`SELECT ca.*, cr.name creator_name, cr.email creator_email FROM campaign_affiliates ca
    JOIN creators cr ON cr.id = ca.creator_id WHERE ca.id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Affiliate not found.');
  if (row.status === 'removed') throw new HttpError(400, 'Add them back to the campaign before re-sending the invite.');
  if (!isEmail(row.creator_email || '')) throw new HttpError(400, 'This creator has no email address.');
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(row.campaign_id).first();
  await sendInvite(env, { name: row.creator_name, email: row.creator_email }, campaign, row.cpm_rate_override_cents ?? campaign.default_cpm_rate_cents, row.override_bps);
  await env.DB.prepare('UPDATE campaign_affiliates SET invited_at = ? WHERE id = ?').bind(now(), id).run();
  return json({ ok: true }, 200, headers);
}

// ── Applications (CONTRACT.md §9) ──

const APPLICATION_SQL = `SELECT a.*, rc.name referred_by_name, u.name reviewed_by_name,
    cr.id matched_creator_id, cr.name matched_creator_name, cr.referred_by_creator_id matched_referred_by,
    (SELECT ca.id FROM campaign_affiliates ca WHERE ca.campaign_id = a.campaign_id AND ca.creator_id = cr.id AND ca.status <> 'removed') on_campaign_id
  FROM campaign_applications a
  LEFT JOIN creators rc ON rc.id = a.referred_by_creator_id
  LEFT JOIN users u ON u.id = a.reviewed_by
  LEFT JOIN creators cr ON cr.email = a.email COLLATE NOCASE AND cr.email <> ''`;

function applicationJson(a, suggestedUpline = null) {
  return {
    id: a.id, campaignId: a.campaign_id, status: a.status,
    name: a.name, email: a.email, phone: a.phone, phoneE164: a.phone_e164, country: a.country,
    instagram: a.instagram, tiktok: a.tiktok, youtube: a.youtube, portfolioUrl: a.portfolio_url,
    platforms: parseJson(a.platforms, []), audienceSize: a.audience_size, postingCadence: a.posting_cadence,
    niches: parseJson(a.niches, []), why: a.why, answers: parseJson(a.answers, {}),
    refCode: a.ref_code, referredByCreatorId: a.referred_by_creator_id, referredByName: a.referred_by_name || null,
    // The creator with this email, if there is one now (they may have been added after applying).
    creatorId: a.creator_id || a.matched_creator_id || null, creatorName: a.matched_creator_name || null,
    campaignAffiliateId: a.campaign_affiliate_id, alreadyOnCampaign: !!a.on_campaign_id && a.status !== 'approved',
    consent: a.consent === 1, ageConfirmed: a.age_confirmed === 1,
    utm: parseJson(a.utm, {}), pageUrl: a.page_url, referrer: a.referrer, userAgent: a.user_agent,
    reviewNotes: a.review_notes, declineReason: a.decline_reason,
    submittedAt: a.submitted_at, createdAt: a.created_at, updatedAt: a.updated_at,
    reviewedAt: a.reviewed_at, reviewedBy: a.reviewed_by, reviewedByName: a.reviewed_by_name || null,
    // Where approval would place them, walking the company-wide chain (staff can change it).
    suggestedUplineId: suggestedUpline?.id || null, suggestedUplineName: suggestedUpline?.name || null
  };
}

// The applicant's company-wide referrer: the one already on their creator record wins, since it's set once.
const referrerOf = (a) => a.matched_referred_by || a.referred_by_creator_id || null;

async function loadApplication(env, id) {
  const row = await env.DB.prepare(`${APPLICATION_SQL} WHERE a.id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Application not found.');
  return row;
}

async function applicationWithUpline(env, a) {
  const open = a.status === 'new' || a.status === 'reviewing';
  return applicationJson(a, open ? await deriveUpline(env, a.campaign_id, referrerOf(a), a.matched_creator_id) : null);
}

async function listApplications(request, env, headers, [campaignId]) {
  await requireUser(request, env);
  const status = new URL(request.url).searchParams.get('status') || '';
  if (status && !['new', 'reviewing', 'approved', 'declined', 'withdrawn'].includes(status)) throw new HttpError(400, 'Invalid status.');
  const rows = await env.DB.prepare(`${APPLICATION_SQL} WHERE a.campaign_id = ? AND (? = '' OR a.status = ?) ORDER BY a.submitted_at DESC`)
    .bind(campaignId, status, status).all();
  const applications = [];
  for (const a of rows.results) applications.push(await applicationWithUpline(env, a));
  return json({ ok: true, applications }, 200, headers);
}

async function sendDeclineEmail(env, application, campaign, reason) {
  const first = String(application.name || '').split(' ')[0] || 'there';
  const brand = campaign.brand_name || campaign.name;
  await sendEmail(env, {
    to: application.email,
    subject: `Your application to post for ${brand}`,
    text: `Hi ${first},\n\nThanks for applying to post for ${brand}. We're not able to add you to this campaign right now.` +
      (reason ? `\n\n${reason}` : '') +
      `\n\nWe run new campaigns regularly, so keep an eye out for the next one.\n\n— Edgeform Marketing Group`
  });
}

// Review status and notes. Approving goes through approveApplication.
async function updateApplication(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const existing = await loadApplication(env, id);
  const body = await readJson(request);
  const fields = {};
  if (body.status !== undefined && body.status !== existing.status) {
    if (!['new', 'reviewing', 'declined'].includes(body.status)) throw new HttpError(400, 'Status can be new, reviewing or declined here. Use Approve to approve.');
    if (existing.status === 'approved') throw new HttpError(409, 'This application is already approved. Manage them from the Affiliates list instead.');
    fields.status = body.status;
    if (body.status === 'declined') { fields.reviewed_at = now(); fields.reviewed_by = user.id; }
  }
  if (body.reviewNotes !== undefined) fields.review_notes = clean(body.reviewNotes, 4000);
  if (body.declineReason !== undefined) fields.decline_reason = clean(body.declineReason, 2000);
  if (!Object.keys(fields).length && !body.sendDeclineEmail) throw new HttpError(400, 'Nothing to update.');
  if (Object.keys(fields).length) {
    const statements = [env.DB.prepare(`UPDATE campaign_applications SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...Object.values(fields), now(), id)];
    if (fields.status) {
      statements.push(auditStatement(env, {
        actorType: 'user', actorId: user.id, entityType: 'campaign_application', entityId: id,
        action: fields.status === 'declined' ? 'application_declined' : 'application_status_changed',
        before: { status: existing.status }, after: { status: fields.status, decline_reason: fields.decline_reason ?? existing.decline_reason }
      }));
    }
    await env.DB.batch(statements);
  }
  let emailSent = false;
  let emailError = null;
  const status = fields.status || existing.status;
  if (body.sendDeclineEmail === true) {
    if (status !== 'declined') throw new HttpError(400, 'Only a declined application gets a decline email.');
    try {
      const campaign = await env.DB.prepare('SELECT name, brand_name FROM campaigns WHERE id = ?').bind(existing.campaign_id).first();
      await sendDeclineEmail(env, existing, campaign, fields.decline_reason ?? existing.decline_reason);
      emailSent = true;
      await env.DB.batch([auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'campaign_application', entityId: id, action: 'decline_email_sent' })]);
    } catch (error) {
      emailError = error.message || 'Decline email failed.';
    }
  }
  return json({ ok: true, application: await applicationWithUpline(env, await loadApplication(env, id)), emailSent, emailError }, 200, headers);
}

const creatorBrief = (c, created) => c && ({
  id: c.id, name: c.name, email: c.email, refCode: c.ref_code, referredByCreatorId: c.referred_by_creator_id, created
});

async function approvalResult(env, id, { inviteSent = false, inviteError = null, creatorCreated = false } = {}) {
  const application = await loadApplication(env, id);
  const [affiliate, creator] = await Promise.all([
    application.campaign_affiliate_id ? env.DB.prepare(`${AFFILIATES_SQL} WHERE ca.id = ?`).bind(application.campaign_affiliate_id).first() : null,
    application.creator_id ? env.DB.prepare('SELECT * FROM creators WHERE id = ?').bind(application.creator_id).first() : null
  ]);
  return {
    ok: true, application: applicationJson(application), affiliate: affiliate ? affiliateJson(affiliate) : null,
    creator: creatorBrief(creator, creatorCreated), inviteSent, inviteError
  };
}

// Approve, in one batch: match-or-create the creator, fill their blank handles, set who referred them
// (once), mint their ref code, add them to the campaign under the derived upline, flip the application,
// audit. Then the invite email, which can fail without undoing any of it.
async function approveApplication(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const app = await loadApplication(env, id);
  // A double-click lands here the second time: nothing new is created.
  if (app.status === 'approved') return json(await approvalResult(env, id), 200, headers);
  if (app.status === 'withdrawn') throw new HttpError(409, 'The applicant withdrew this application.');
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(app.campaign_id).first();
  if (!campaign) throw new HttpError(404, 'Campaign not found.');
  if (campaign.status === 'ended') throw new HttpError(409, 'This campaign has ended, so nobody new can join it.');

  const override = wholeNumber(body.cpmRateOverrideCents, 'CPM override');
  const overrideBps = wholeNumber(body.overrideBps, 'Team override %', { max: 10000 });
  const rank = readRank(body.rank);
  const stamp = now();

  let creator = await env.DB.prepare("SELECT * FROM creators WHERE email = ? COLLATE NOCASE AND email <> ''").bind(app.email).first();
  const creatorId = creator?.id || crypto.randomUUID();
  const assignment = creator && await env.DB.prepare('SELECT * FROM campaign_affiliates WHERE campaign_id = ? AND creator_id = ?').bind(campaign.id, creatorId).first();

  // Already on this campaign: approving just links the application to them. Nothing else changes.
  if (assignment && assignment.status !== 'removed') {
    await env.DB.batch([
      env.DB.prepare(`UPDATE campaign_applications SET status = 'approved', creator_id = ?, campaign_affiliate_id = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ?
        WHERE id = ? AND status <> 'approved'`).bind(creatorId, assignment.id, stamp, user.id, stamp, id),
      auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'campaign_application', entityId: id, action: 'application_approved',
        before: { status: app.status }, after: { status: 'approved', campaign_affiliate_id: assignment.id, already_on_campaign: true } })
    ]);
    return json(await approvalResult(env, id), 200, headers);
  }

  // Company-wide referrer: set once, never onto themselves, never in a loop.
  const offered = app.referred_by_creator_id;
  const setReferrer = offered && !creator?.referred_by_creator_id && !await wouldCycle(env, creatorId, offered) ? offered : null;
  const referrer = creator?.referred_by_creator_id || setReferrer;
  const uplineId = body.uplineId !== undefined
    ? await checkUpline(env, campaign.id, body.uplineId, assignment?.id)
    : (await deriveUpline(env, campaign.id, referrer, creatorId))?.id || null;
  const refCode = creator?.ref_code || await freshRefCode(env);
  const [audienceLabel, audienceTier] = AUDIENCE_LABELS[app.audience_size] || ['', 0];

  const statements = [];
  if (creator) {
    // Fill blanks from the application; never overwrite what's there.
    const fill = ['phone', 'phone_e164', 'country', 'instagram', 'tiktok', 'youtube'];
    statements.push(env.DB.prepare(`UPDATE creators SET
        ${fill.map(k => `${k} = CASE WHEN COALESCE(${k}, '') = '' THEN ? ELSE ${k} END`).join(', ')},
        ref_code = COALESCE(ref_code, ?),
        referred_at = CASE WHEN referred_by_creator_id IS NULL AND ? IS NOT NULL THEN ? ELSE referred_at END,
        referred_by_creator_id = COALESCE(referred_by_creator_id, ?),
        updated_at = ?
      WHERE id = ?`).bind(...fill.map(k => app[k] || ''), refCode, setReferrer, stamp, setReferrer, stamp, creatorId));
  } else {
    const row = {
      id: creatorId, source: 'campaign_application', created_at: stamp, updated_at: stamp, consent: 1, form_status: 'complete', roster_status: 'approved',
      name: app.name, email: app.email, phone: app.phone, phone_e164: app.phone_e164, country: app.country || null,
      instagram: app.instagram, tiktok: app.tiktok, youtube: app.youtube, other_social: app.portfolio_url,
      audience_size: audienceLabel, audience_tier: audienceTier, niches: app.niches,
      ref_code: refCode, referred_by_creator_id: setReferrer, referred_at: setReferrer ? stamp : null
    };
    statements.push(env.DB.prepare(`INSERT INTO creators (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).bind(...Object.values(row)));
  }
  const affiliateId = assignment?.id || crypto.randomUUID();
  // Same row addAffiliate writes: invited, rookie unless staff chose otherwise, no custom rate unless typed.
  statements.push(assignment
    ? env.DB.prepare("UPDATE campaign_affiliates SET status = 'invited', cpm_rate_override_cents = ?, override_bps = ?, rank = ?, upline_id = ?, updated_at = ? WHERE id = ?")
      .bind(override, overrideBps, rank, uplineId, stamp, affiliateId)
    : env.DB.prepare(`INSERT INTO campaign_affiliates (id, campaign_id, creator_id, cpm_rate_override_cents, override_bps, rank, upline_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'invited', ?, ?)`).bind(affiliateId, campaign.id, creatorId, override, overrideBps, rank, uplineId, stamp, stamp));
  statements.push(
    env.DB.prepare(`UPDATE campaign_applications SET status = 'approved', creator_id = ?, campaign_affiliate_id = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ?
      WHERE id = ?`).bind(creatorId, affiliateId, stamp, user.id, stamp, id),
    auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'campaign_application', entityId: id, action: 'application_approved',
      before: { status: app.status },
      after: { status: 'approved', creator_id: creatorId, creator_created: !creator, campaign_affiliate_id: affiliateId, referred_by_creator_id: setReferrer }
    }),
    auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'campaign_affiliate', entityId: affiliateId, action: 'affiliate_added',
      after: { campaign_id: campaign.id, creator_id: creatorId, cpm_rate_override_cents: override, override_bps: overrideBps, rank, upline_id: uplineId, application_id: id }
    })
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // Two approvals racing: the loser's batch hits a UNIQUE index and rolls back. Report the winner's result.
    if (/UNIQUE/i.test(error.message)) {
      const fresh = await loadApplication(env, id);
      if (fresh.status === 'approved') return json(await approvalResult(env, id), 200, headers);
      throw new HttpError(409, 'Something changed while approving. Refresh and try again.');
    }
    throw error;
  }
  if (uplineId) await recomputeCampaign(env, campaign.id);

  let inviteError = null;
  const sendIt = body.sendInvite !== false;
  if (sendIt) {
    try {
      await sendInvite(env, { name: creator?.name || app.name, email: app.email }, campaign, override ?? campaign.default_cpm_rate_cents, overrideBps);
      await env.DB.prepare('UPDATE campaign_affiliates SET invited_at = ? WHERE id = ?').bind(now(), affiliateId).run();
    } catch (error) {
      inviteError = error.message || 'Invite email failed.';
    }
  }
  return json(await approvalResult(env, id, { inviteSent: sendIt && !inviteError, inviteError, creatorCreated: !creator }), 201, headers);
}

// ── Example videos on the application page. Never tracked, never priced, never in `videos`. ──

// TikTok's public oEmbed has a thumbnail; the others either have a fixed URL (YouTube) or need a token.
async function tiktokThumbnail(url) {
  try {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(4000) });
    const data = res.ok ? await res.json() : null;
    return typeof data?.thumbnail_url === 'string' && data.thumbnail_url.startsWith('https://') ? data.thumbnail_url : '';
  } catch { return ''; }
}

async function addExampleVideo(request, env, headers, [campaignId]) {
  const user = await requireUser(request, env);
  const campaign = await env.DB.prepare('SELECT id FROM campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) throw new HttpError(404, 'Campaign not found.');
  const body = await readJson(request);
  const { n, top } = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(MAX(sort_order), -1) top FROM campaign_example_videos WHERE campaign_id = ?').bind(campaignId).first();
  if (n >= MAX_EXAMPLE_VIDEOS) throw new HttpError(409, `Up to ${MAX_EXAMPLE_VIDEOS} example videos. Remove one first.`);
  if (typeof body.url !== 'string' || !body.url.trim()) throw new HttpError(400, 'Paste a TikTok, Instagram or YouTube link.');
  const parsed = await resolveVideoUrl(body.url);
  const embed = exampleEmbed(parsed);
  if (parsed.platform === 'tiktok') embed.thumbnail_url = await tiktokThumbnail(parsed.canonical_url);
  const row = {
    id: crypto.randomUUID(), campaign_id: campaignId, url: parsed.canonical_url, platform: parsed.platform, platform_video_id: parsed.platform_video_id,
    ...embed, caption: clean(body.caption, 300), sort_order: top + 1, created_at: now()
  };
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO campaign_example_videos (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).bind(...Object.values(row)),
      auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'campaign', entityId: campaignId, action: 'example_video_added', after: { url: row.url } })
    ]);
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) throw new HttpError(409, 'That video is already one of the examples.');
    throw error;
  }
  return json({ ok: true, exampleVideo: exampleVideoJson(row) }, 201, headers);
}

async function updateExampleVideo(request, env, headers, [id]) {
  await requireUser(request, env);
  const existing = await env.DB.prepare('SELECT * FROM campaign_example_videos WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Example video not found.');
  const body = await readJson(request);
  const fields = {};
  if (body.caption !== undefined) fields.caption = clean(body.caption, 300);
  if (body.sortOrder !== undefined) fields.sort_order = wholeNumber(body.sortOrder, 'Order', { nullable: false, max: 1000 });
  if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to update.');
  await env.DB.prepare(`UPDATE campaign_example_videos SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(fields), id).run();
  return json({ ok: true, exampleVideo: exampleVideoJson({ ...existing, ...fields }) }, 200, headers);
}

async function deleteExampleVideo(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const existing = await env.DB.prepare('SELECT * FROM campaign_example_videos WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Example video not found.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM campaign_example_videos WHERE id = ?').bind(id),
    auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'campaign', entityId: existing.campaign_id, action: 'example_video_removed', before: { url: existing.url } })
  ]);
  return json({ ok: true }, 200, headers);
}

export const campaignRoutes = {
  'GET /api/campaigns': listAllCampaigns,
  'GET /api/operations/:id/campaigns': listCampaigns,
  'POST /api/operations/:id/campaigns': createCampaign,
  'GET /api/campaigns/:id': getCampaign,
  'PATCH /api/campaigns/:id': updateCampaign,
  'DELETE /api/campaigns/:id': deleteCampaign,
  'POST /api/campaigns/:id/affiliates': addAffiliate,
  'PATCH /api/campaign-affiliates/:id': updateAffiliate,
  'POST /api/campaign-affiliates/:id/invite': resendInvite,
  'GET /api/campaigns/:id/applications': listApplications,
  'PATCH /api/campaign-applications/:id': updateApplication,
  'POST /api/campaign-applications/:id/approve': approveApplication,
  'POST /api/campaigns/:id/example-videos': addExampleVideo,
  'PATCH /api/campaign-example-videos/:id': updateExampleVideo,
  'DELETE /api/campaign-example-videos/:id': deleteExampleVideo
};

