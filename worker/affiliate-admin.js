import { json, HttpError, clean, now, readJson } from './lib.js';
import { requireUser } from './auth.js';
import { parseJson, recomputeCampaign, auditStatement } from './affiliate-lib.js';
import { checkVideoNow } from './affiliate-views.js';

// Admin side of affiliate videos: review queue, flags, manual views, audit log.

const VIDEO_STATUSES = ['pending_review', 'approved', 'rejected', 'removed', 'locked'];

const VIDEO_SQL = `SELECT v.*, cr.name creator_name, cr.email creator_email, cr.tiktok, cr.instagram, cr.youtube,
    c.name campaign_name, c.operation_id, c.view_tracking_window_days, c.min_views_to_qualify,
    COALESCE(ca.cpm_rate_override_cents, c.default_cpm_rate_cents) cpm_rate_cents,
    (SELECT json_group_array(json_object('id', f.id, 'type', f.type, 'details', f.details, 'createdAt', f.created_at))
       FROM video_flags f WHERE f.video_id = v.id AND f.resolved_at IS NULL) open_flags,
    COALESCE((SELECT li.payout_id FROM payout_line_items li WHERE li.video_id = v.id),
      (SELECT poi.payout_id FROM payout_override_items poi WHERE poi.video_id = v.id LIMIT 1)) payout_id,
    u.name approved_by_name
  FROM videos v JOIN creators cr ON cr.id = v.creator_id JOIN campaigns c ON c.id = v.campaign_id
  JOIN campaign_affiliates ca ON ca.id = v.campaign_affiliate_id LEFT JOIN users u ON u.id = v.approved_by`;

export function adminVideoJson(v) {
  return {
    id: v.id, campaignId: v.campaign_id, campaignName: v.campaign_name, operationId: v.operation_id,
    campaignAffiliateId: v.campaign_affiliate_id, creatorId: v.creator_id,
    creator: { name: v.creator_name, email: v.creator_email, tiktok: v.tiktok, instagram: v.instagram, youtube: v.youtube },
    submittedUrl: v.submitted_url, canonicalUrl: v.canonical_url, platform: v.platform, platformVideoId: v.platform_video_id,
    thumbnailUrl: v.thumbnail_url, caption: v.caption, postedAt: v.posted_at, status: v.status, rejectionReason: v.rejection_reason,
    submittedAt: v.submitted_at, approvedAt: v.approved_at, approvedByName: v.approved_by_name, trackingEndsAt: v.tracking_ends_at,
    lockedAt: v.locked_at, latestViewCount: v.latest_view_count, billableViews: v.billable_views, earnedCents: v.earned_cents,
    cpmRateCents: v.cpm_rate_cents, lastFetchedAt: v.last_fetched_at, nextFetchAt: v.next_fetch_at,
    consecutiveFetchFailures: v.consecutive_fetch_failures, payoutId: v.payout_id,
    openFlags: parseJson(v.open_flags, []).filter(Boolean)
  };
}

async function loadVideo(env, id) {
  const row = await env.DB.prepare(`${VIDEO_SQL} WHERE v.id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Video not found.');
  return row;
}

async function listVideos(request, env, headers) {
  await requireUser(request, env);
  const q = new URL(request.url).searchParams;
  const status = q.get('status') || '';
  const campaignId = q.get('campaignId') || '';
  const flagged = q.get('flagged') === '1';
  if (status && !VIDEO_STATUSES.includes(status)) throw new HttpError(400, 'Invalid status.');
  const rows = await env.DB.prepare(`${VIDEO_SQL}
    WHERE (? = '' OR v.status = ?) AND (? = '' OR v.campaign_id = ?)
      AND (? = 0 OR EXISTS (SELECT 1 FROM video_flags f WHERE f.video_id = v.id AND f.resolved_at IS NULL))
    ORDER BY v.submitted_at ${status === 'pending_review' ? 'ASC' : 'DESC'} LIMIT 1000`)
    .bind(status, status, campaignId, campaignId, flagged ? 1 : 0).all();
  return json({ ok: true, videos: rows.results.map(adminVideoJson) }, 200, headers);
}

async function getVideo(request, env, headers, [id]) {
  await requireUser(request, env);
  const video = adminVideoJson(await loadVideo(env, id));
  const [snapshots, flags, audit] = await env.DB.batch([
    env.DB.prepare(`SELECT s.id, s.view_count, s.like_count, s.comment_count, s.source, s.fetched_at, s.note, u.name entered_by_name
      FROM view_snapshots s LEFT JOIN users u ON u.id = s.entered_by WHERE s.video_id = ? ORDER BY s.fetched_at DESC LIMIT 200`).bind(id),
    env.DB.prepare(`SELECT f.*, u.name resolved_by_name FROM video_flags f LEFT JOIN users u ON u.id = f.resolved_by
      WHERE f.video_id = ? ORDER BY f.created_at DESC`).bind(id),
    env.DB.prepare(`SELECT * FROM affiliate_audit_log WHERE entity_type = 'video' AND entity_id = ? ORDER BY created_at DESC`).bind(id)
  ]);
  return json({
    ok: true, video,
    snapshots: snapshots.results.map(s => ({
      id: s.id, viewCount: s.view_count, likeCount: s.like_count, commentCount: s.comment_count, source: s.source,
      fetchedAt: s.fetched_at, note: s.note, enteredByName: s.entered_by_name
    })),
    flags: flags.results.map(flagJson),
    audit: audit.results.map(auditJson)
  }, 200, headers);
}

// approve: pending_review / rejected / removed → approved (or back to locked if it had already locked)
// reject:  pending_review / approved / removed → rejected, with a reason
// remove:  pending_review / approved / locked → removed
// Videos on a payout can't change status.
async function reviewVideo(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const video = await loadVideo(env, id);
  if (video.payout_id) throw new HttpError(409, 'This video is on a payout, so its status can’t change.');
  const stamp = now();
  let fields;
  if (body.action === 'approve') {
    if (!['pending_review', 'rejected', 'removed'].includes(video.status)) throw new HttpError(409, 'Only videos waiting for review, rejected, or removed can be approved.');
    fields = video.locked_at
      ? { status: 'locked', rejection_reason: null }
      : { status: 'approved', rejection_reason: null, approved_at: stamp, approved_by: user.id, next_fetch_at: stamp, consecutive_fetch_failures: 0 };
  } else if (body.action === 'reject') {
    if (!['pending_review', 'approved', 'removed'].includes(video.status)) throw new HttpError(409, 'Locked videos can’t be rejected. Remove it instead.');
    const reason = clean(body.reason, 1000);
    if (!reason) throw new HttpError(400, 'Give the affiliate a reason. They see it in their portal.');
    fields = { status: 'rejected', rejection_reason: reason, next_fetch_at: null };
  } else if (body.action === 'remove') {
    if (!['pending_review', 'approved', 'locked'].includes(video.status)) throw new HttpError(409, 'This video can’t be removed.');
    fields = { status: 'removed', next_fetch_at: null, rejection_reason: clean(body.reason, 1000) || video.rejection_reason };
  } else {
    throw new HttpError(400, 'action must be approve, reject, or remove.');
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE videos SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(fields), id),
    auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'video', entityId: id, action: `video_${body.action === 'approve' ? 'approved' : body.action === 'reject' ? 'rejected' : 'removed'}`,
      before: { status: video.status, rejection_reason: video.rejection_reason }, after: { status: fields.status, rejection_reason: fields.rejection_reason ?? null }
    })
  ]);
  await recomputeCampaign(env, video.campaign_id);
  return json({ ok: true, video: adminVideoJson(await loadVideo(env, id)) }, 200, headers);
}

// Manual view count: appended as a snapshot. On a locked video (not yet paid) it also sets the billable views.
async function enterViews(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const video = await loadVideo(env, id);
  const count = (value, label, required) => {
    if (value === undefined || value === null || value === '') {
      if (required) throw new HttpError(400, `${label} is required.`);
      return null;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${label} must be a whole number.`);
    return n;
  };
  const views = count(body.viewCount, 'View count', true);
  const likes = count(body.likeCount, 'Likes');
  const comments = count(body.commentCount, 'Comments');
  const note = clean(body.note, 1000);
  if (!note) throw new HttpError(400, 'Add a note saying where the number came from.');
  if (video.payout_id) throw new HttpError(409, 'This video is on a payout, so its views can’t change.');
  const stamp = now();
  const fields = { latest_view_count: views };
  if (video.status === 'locked') fields.billable_views = views;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO view_snapshots (id, video_id, view_count, like_count, comment_count, source, fetched_at, entered_by, note)
      VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)`).bind(crypto.randomUUID(), id, views, likes, comments, stamp, user.id, note),
    env.DB.prepare(`UPDATE videos SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(fields), id),
    auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'video', entityId: id, action: 'manual_views_entered',
      before: { latest_view_count: video.latest_view_count, billable_views: video.billable_views },
      after: { ...fields, like_count: likes, comment_count: comments, note }
    })
  ]);
  await recomputeCampaign(env, video.campaign_id);
  return json({ ok: true, video: adminVideoJson(await loadVideo(env, id)) }, 200, headers);
}

// Runs the view provider for one tracking video right away.
async function checkNow(request, env, headers, [id]) {
  await requireUser(request, env);
  if (!await checkVideoNow(env, id)) throw new HttpError(409, 'Only videos that are tracking views can be checked.');
  return json({ ok: true, video: adminVideoJson(await loadVideo(env, id)) }, 200, headers);
}

// ── Flags ──

const flagJson = (f) => ({
  id: f.id, videoId: f.video_id, type: f.type, details: f.details, createdAt: f.created_at,
  resolvedAt: f.resolved_at, resolvedByName: f.resolved_by_name || null
});

async function listFlags(request, env, headers) {
  await requireUser(request, env);
  const open = new URL(request.url).searchParams.get('open') !== '0';
  const rows = await env.DB.prepare(`SELECT f.*, u.name resolved_by_name, v.canonical_url, v.platform, v.status video_status, v.latest_view_count,
      v.campaign_id, c.name campaign_name, cr.name creator_name
    FROM video_flags f JOIN videos v ON v.id = f.video_id JOIN campaigns c ON c.id = v.campaign_id JOIN creators cr ON cr.id = v.creator_id
    LEFT JOIN users u ON u.id = f.resolved_by
    WHERE (? = 1 AND f.resolved_at IS NULL) OR (? = 0 AND f.resolved_at IS NOT NULL)
    ORDER BY f.created_at DESC LIMIT 500`).bind(open ? 1 : 0, open ? 1 : 0).all();
  return json({
    ok: true,
    flags: rows.results.map(f => ({
      ...flagJson(f), canonicalUrl: f.canonical_url, platform: f.platform, videoStatus: f.video_status, latestViewCount: f.latest_view_count,
      campaignId: f.campaign_id, campaignName: f.campaign_name, creatorName: f.creator_name
    }))
  }, 200, headers);
}

async function resolveFlag(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const flag = await env.DB.prepare('SELECT * FROM video_flags WHERE id = ?').bind(id).first();
  if (!flag) throw new HttpError(404, 'Flag not found.');
  if (flag.resolved_at) return json({ ok: true }, 200, headers);
  const note = clean((await readJson(request)).note, 1000);
  await env.DB.batch([
    env.DB.prepare('UPDATE video_flags SET resolved_at = ?, resolved_by = ? WHERE id = ?').bind(now(), user.id, id),
    auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'video', entityId: flag.video_id, action: 'flag_resolved', before: { type: flag.type }, after: note ? { note } : null })
  ]);
  return json({ ok: true }, 200, headers);
}

// ── Audit log ──

const auditJson = (a) => ({
  id: a.id, actorType: a.actor_type, actorId: a.actor_id, actorName: a.actor_name || null, entityType: a.entity_type, entityId: a.entity_id,
  action: a.action, before: parseJson(a.before_json, null), after: parseJson(a.after_json, null), createdAt: a.created_at
});

async function listAudit(request, env, headers) {
  await requireUser(request, env);
  const q = new URL(request.url).searchParams;
  const entityType = q.get('entityType') || '';
  const entityId = q.get('entityId') || '';
  const rows = await env.DB.prepare(`SELECT a.*, CASE a.actor_type WHEN 'user' THEN u.name WHEN 'creator' THEN cr.name ELSE 'System' END actor_name
    FROM affiliate_audit_log a LEFT JOIN users u ON a.actor_type = 'user' AND u.id = a.actor_id
    LEFT JOIN creators cr ON a.actor_type = 'creator' AND cr.id = a.actor_id
    WHERE (? = '' OR a.entity_type = ?) AND (? = '' OR a.entity_id = ?)
    ORDER BY a.created_at DESC LIMIT 500`).bind(entityType, entityType, entityId, entityId).all();
  return json({ ok: true, entries: rows.results.map(auditJson) }, 200, headers);
}

export const affiliateAdminRoutes = {
  'GET /api/affiliate-videos': listVideos,
  'GET /api/affiliate-videos/:id': getVideo,
  'POST /api/affiliate-videos/:id/review': reviewVideo,
  'POST /api/affiliate-videos/:id/views': enterViews,
  'POST /api/affiliate-videos/:id/check': checkNow,
  'GET /api/video-flags': listFlags,
  'POST /api/video-flags/:id/resolve': resolveFlag,
  'GET /api/affiliate-audit': listAudit
};
