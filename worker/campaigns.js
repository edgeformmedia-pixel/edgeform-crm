import { json, HttpError, clean, now, readJson, isEmail } from './lib.js';
import { requireUser, requireAdmin } from './auth.js';
import { sendEmail } from './email.js';
import {
  PLATFORMS, CAMPAIGN_STATUSES, ASSIGNMENT_STATUSES, RANKS, PORTAL_URL, ASSIGNMENT_STATS_SQL, parseJson, recomputeCampaign, auditStatement
} from './affiliate-lib.js';

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
    max_payout_per_video_cents: wholeNumber(pick('maxPayoutPerVideoCents', 'max_payout_per_video_cents'), 'Max per video'),
    max_payout_per_affiliate_cents: wholeNumber(pick('maxPayoutPerAffiliateCents', 'max_payout_per_affiliate_cents'), 'Max per affiliate'),
    total_budget_cents: wholeNumber(pick('totalBudgetCents', 'total_budget_cents'), 'Total budget'),
    view_tracking_window_days: wholeNumber(pick('viewTrackingWindowDays', 'view_tracking_window_days') ?? 30, 'Tracking window', { nullable: false, max: 365 }),
    min_views_to_qualify: wholeNumber(pick('minViewsToQualify', 'min_views_to_qualify'), 'Minimum views'),
    requires_video_approval: (body.requiresVideoApproval === undefined ? existing.requires_video_approval ?? 1 : body.requiresVideoApproval) ? 1 : 0
  };
  if (fields.view_tracking_window_days < 1) throw new HttpError(400, 'Tracking window must be at least 1 day.');
  if (fields.start_date && fields.end_date && fields.end_date < fields.start_date) throw new HttpError(400, 'End date is before the start date.');
  return fields;
}

// owed = own earned + overrides earned − paid.
const statsJson = (r) => ({
  videoCount: r.video_count, views: r.total_views, earnedCents: r.earned_cents, pendingCents: r.pending_cents,
  overrideEarnedCents: r.override_earned_cents, overridePendingCents: r.override_pending_cents,
  paidCents: r.paid_cents, owedCents: r.earned_cents + r.override_earned_cents - r.paid_cents
});

function campaignJson(c) {
  return {
    id: c.id, operationId: c.operation_id, name: c.name, brief: c.brief, status: c.status, startDate: c.start_date, endDate: c.end_date,
    platformsAllowed: parseJson(c.platforms_allowed, []), defaultCpmRateCents: c.default_cpm_rate_cents, currency: c.currency,
    maxPayoutPerVideoCents: c.max_payout_per_video_cents, maxPayoutPerAffiliateCents: c.max_payout_per_affiliate_cents,
    totalBudgetCents: c.total_budget_cents, viewTrackingWindowDays: c.view_tracking_window_days, minViewsToQualify: c.min_views_to_qualify,
    requiresVideoApproval: c.requires_video_approval === 1, createdBy: c.created_by, createdAt: c.created_at, updatedAt: c.updated_at,
    channels: parseJson(c.channels, []).filter(Boolean),
    affiliateCount: c.affiliate_count ?? 0, videoCount: c.video_count ?? 0, pendingReview: c.pending_review ?? 0, openFlags: c.open_flags ?? 0,
    views: c.total_views ?? 0, earnedCents: c.earned_cents ?? 0, pendingCents: c.pending_cents ?? 0,
    overrideEarnedCents: c.override_earned_cents ?? 0, overridePendingCents: c.override_pending_cents ?? 0
  };
}

const CAMPAIGN_SQL = `SELECT c.*,
    (SELECT json_group_array(type) FROM campaign_channels ch WHERE ch.campaign_id = c.id) channels,
    (SELECT COUNT(*) FROM campaign_affiliates ca WHERE ca.campaign_id = c.id AND ca.status <> 'removed') affiliate_count,
    (SELECT COUNT(*) FROM videos v WHERE v.campaign_id = c.id) video_count,
    (SELECT COUNT(*) FROM videos v WHERE v.campaign_id = c.id AND v.status = 'pending_review') pending_review,
    (SELECT COUNT(*) FROM video_flags f JOIN videos v ON v.id = f.video_id WHERE v.campaign_id = c.id AND f.resolved_at IS NULL) open_flags,
    (SELECT COALESCE(SUM(CASE v.status WHEN 'locked' THEN v.billable_views WHEN 'approved' THEN v.latest_view_count ELSE 0 END), 0) FROM videos v WHERE v.campaign_id = c.id) total_views,
    (SELECT COALESCE(SUM(v.earned_cents), 0) FROM videos v WHERE v.campaign_id = c.id AND v.status = 'locked') earned_cents,
    (SELECT COALESCE(SUM(v.earned_cents), 0) FROM videos v WHERE v.campaign_id = c.id AND v.status = 'approved') pending_cents,
    (SELECT COALESCE(SUM(oe.amount_cents), 0) FROM override_earnings oe JOIN videos v ON v.id = oe.video_id WHERE oe.campaign_id = c.id AND v.status = 'locked') override_earned_cents,
    (SELECT COALESCE(SUM(oe.amount_cents), 0) FROM override_earnings oe JOIN videos v ON v.id = oe.video_id WHERE oe.campaign_id = c.id AND v.status = 'approved') override_pending_cents
  FROM campaigns c`;

function affiliateJson(a) {
  return {
    id: a.id, campaignId: a.campaign_id, creatorId: a.creator_id, status: a.status, rank: a.rank, uplineId: a.upline_id,
    cpmRateOverrideCents: a.cpm_rate_override_cents, effectiveCpmRateCents: a.cpm_rate_override_cents ?? a.default_cpm_rate_cents,
    invitedAt: a.invited_at, joinedAt: a.joined_at, createdAt: a.created_at,
    creator: {
      id: a.creator_id, name: a.creator_name, email: a.creator_email, instagram: a.instagram, tiktok: a.tiktok, youtube: a.youtube,
      payoutMethod: a.payout_method || '', payoutDetailsLast4: a.payout_details_last4 || '', taxFormReceived: a.tax_form_received === 1,
      portalLastLoginAt: a.portal_last_login_at,
      connections: String(a.connections || '').split(',').filter(Boolean).map(x => { const [platform, ...name] = x.split(':'); return { platform, username: name.join(':') }; })
    },
    ...statsJson(a)
  };
}

const AFFILIATES_SQL = `SELECT ca.*, c.default_cpm_rate_cents, cr.name creator_name, cr.email creator_email, cr.instagram, cr.tiktok, cr.youtube,
    cr.payout_method, cr.payout_details_last4, cr.tax_form_received, cr.portal_last_login_at,
    (SELECT group_concat(pc.platform || ':' || pc.platform_username) FROM creator_platform_connections pc WHERE pc.creator_id = ca.creator_id AND pc.revoked_at IS NULL) connections,
    ${ASSIGNMENT_STATS_SQL}
  FROM campaign_affiliates ca JOIN campaigns c ON c.id = ca.campaign_id JOIN creators cr ON cr.id = ca.creator_id`;

async function loadCampaign(env, id) {
  const row = await env.DB.prepare(`${CAMPAIGN_SQL} WHERE c.id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Campaign not found.');
  return row;
}

async function campaignDetail(env, id) {
  const campaign = campaignJson(await loadCampaign(env, id));
  const affiliates = await env.DB.prepare(`${AFFILIATES_SQL} WHERE ca.campaign_id = ? ORDER BY ca.status = 'removed', cr.name`).bind(id).all();
  return { ...campaign, affiliates: affiliates.results.map(affiliateJson) };
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
  const stamp = now();
  const row = { id, operation_id: operationId, ...fields, currency: 'USD', created_by: user.id, created_at: stamp, updated_at: stamp };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO campaigns (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).bind(...Object.values(row)),
    // Every campaign gets both channels. Email is a placeholder for now.
    ...['email', 'affiliate'].map(type => env.DB.prepare('INSERT INTO campaign_channels (id, campaign_id, type, created_at) VALUES (?, ?, ?, ?)')
      .bind(crypto.randomUUID(), id, type, stamp)),
    auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'campaign', entityId: id, action: 'campaign_created', after: fields })
  ]);
  return json({ ok: true, campaign: await campaignDetail(env, id) }, 201, headers);
}

async function getCampaign(request, env, headers, [id]) {
  await requireUser(request, env);
  return json({ ok: true, campaign: await campaignDetail(env, id) }, 200, headers);
}

async function updateCampaign(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const existing = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Campaign not found.');
  const fields = readCampaign(await readJson(request), existing);
  const statements = [
    env.DB.prepare(`UPDATE campaigns SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...Object.values(fields), now(), id)
  ];
  const audit = (action, keys) => {
    const before = Object.fromEntries(keys.map(k => [k, existing[k]]));
    const after = Object.fromEntries(keys.map(k => [k, fields[k]]));
    if (JSON.stringify(before) !== JSON.stringify(after)) statements.push(auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'campaign', entityId: id, action, before, after }));
  };
  audit('rate_changed', ['default_cpm_rate_cents']);
  audit('caps_changed', ['max_payout_per_video_cents', 'max_payout_per_affiliate_cents', 'total_budget_cents', 'min_views_to_qualify']);
  audit('status_changed', ['status']);
  await env.DB.batch(statements);
  const moneyChanged = ['default_cpm_rate_cents', 'max_payout_per_video_cents', 'max_payout_per_affiliate_cents', 'total_budget_cents', 'min_views_to_qualify']
    .some(k => existing[k] !== fields[k]);
  if (moneyChanged) await recomputeCampaign(env, id);
  return json({ ok: true, campaign: await campaignDetail(env, id) }, 200, headers);
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

async function sendInvite(env, creator, campaign, rateCents) {
  const first = String(creator.name || '').split(' ')[0] || 'there';
  await sendEmail(env, {
    to: creator.email,
    subject: `You're invited to the ${campaign.name} campaign`,
    text: `Hi ${first},\n\nEdgeform Marketing Group added you to the "${campaign.name}" campaign as an affiliate. ` +
      `You earn ${dollars(rateCents)} per 1,000 views on the videos you post for it.\n\n` +
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
      ? env.DB.prepare("UPDATE campaign_affiliates SET status = 'invited', cpm_rate_override_cents = ?, rank = ?, upline_id = ?, updated_at = ? WHERE id = ?").bind(override, rank, uplineId, stamp, id)
      : env.DB.prepare(`INSERT INTO campaign_affiliates (id, campaign_id, creator_id, cpm_rate_override_cents, rank, upline_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'invited', ?, ?)`).bind(id, campaignId, creator.id, override, rank, uplineId, stamp, stamp),
    auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'campaign_affiliate', entityId: id, action: 'affiliate_added',
      after: { campaign_id: campaignId, creator_id: creator.id, cpm_rate_override_cents: override, rank, upline_id: uplineId }
    })
  ]);
  if (uplineId) await recomputeCampaign(env, campaignId);

  let inviteError = null;
  try {
    await sendInvite(env, creator, campaign, override ?? campaign.default_cpm_rate_cents);
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
  if (body.status !== undefined) {
    if (!ASSIGNMENT_STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid affiliate status.');
    fields.status = body.status;
  }
  if (body.rank !== undefined) fields.rank = readRank(body.rank);
  if (body.uplineId !== undefined) fields.upline_id = await checkUpline(env, existing.campaign_id, body.uplineId, id);
  if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to update.');
  const statements = [env.DB.prepare(`UPDATE campaign_affiliates SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...Object.values(fields), now(), id)];
  const rateChanged = 'cpm_rate_override_cents' in fields && fields.cpm_rate_override_cents !== existing.cpm_rate_override_cents;
  if (rateChanged) {
    statements.push(auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'campaign_affiliate', entityId: id, action: 'rate_changed',
      before: { cpm_rate_override_cents: existing.cpm_rate_override_cents }, after: { cpm_rate_override_cents: fields.cpm_rate_override_cents }
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
  if (rateChanged || uplineChanged || ('status' in fields && fields.status !== existing.status)) await recomputeCampaign(env, existing.campaign_id);
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
  await sendInvite(env, { name: row.creator_name, email: row.creator_email }, campaign, row.cpm_rate_override_cents ?? campaign.default_cpm_rate_cents);
  await env.DB.prepare('UPDATE campaign_affiliates SET invited_at = ? WHERE id = ?').bind(now(), id).run();
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
  'POST /api/campaign-affiliates/:id/invite': resendInvite
};

