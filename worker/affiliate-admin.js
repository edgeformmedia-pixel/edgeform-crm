import { json, HttpError, clean, now, readJson } from './lib.js';
import { requireUser } from './auth.js';
import { parseJson, recomputeCampaign, auditStatement, flagStatement, lastWeeklyCutoff } from './affiliate-lib.js';

// Admin side of affiliate videos: review queue, flags, weekly views, audit log.

const VIDEO_STATUSES = ['pending_review', 'approved', 'rejected', 'removed', 'locked'];

const VIDEO_SQL = `SELECT v.*, cr.name creator_name, cr.email creator_email, cr.tiktok, cr.instagram, cr.youtube,
    c.name campaign_name, c.operation_id, c.status campaign_status, c.min_views_to_qualify,
    COALESCE(ca.cpm_rate_override_cents, c.default_cpm_rate_cents) cpm_rate_cents,
    (SELECT json_group_array(json_object('id', f.id, 'type', f.type, 'details', f.details, 'createdAt', f.created_at))
       FROM video_flags f WHERE f.video_id = v.id AND f.resolved_at IS NULL) open_flags,
    (SELECT COUNT(*) FROM video_screenshots s WHERE s.video_id = v.id) screenshot_count,
    (SELECT MAX(s.uploaded_at) FROM video_screenshots s WHERE s.video_id = v.id) last_screenshot_at,
    (SELECT COALESCE(SUM(s.earned_cents), 0) FROM view_snapshots s WHERE s.video_id = v.id AND s.earned_cents > 0
       AND NOT EXISTS (SELECT 1 FROM payout_line_items li WHERE li.view_snapshot_id = s.id)) unpaid_earned_cents,
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
    submittedAt: v.submitted_at, approvedAt: v.approved_at, approvedByName: v.approved_by_name,
    lockedAt: v.locked_at, latestViewCount: v.latest_view_count, billableViews: v.billable_views, earnedCents: v.earned_cents,
    cpmRateCents: v.cpm_rate_cents, lastFetchedAt: v.last_fetched_at, unpaidEarnedCents: v.unpaid_earned_cents || 0,
    openFlags: parseJson(v.open_flags, []).filter(Boolean),
    screenshotCount: v.screenshot_count || 0, lastScreenshotAt: v.last_screenshot_at || null
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
  const due = q.get('due') === '1';
  if (status && !VIDEO_STATUSES.includes(status)) throw new HttpError(400, 'Invalid status.');
  if (due) {
    // Weekly checklist: approved videos in active campaigns not yet checked since the last cutoff.
    const cutoff = lastWeeklyCutoff(now());
    const rows = await env.DB.prepare(`${VIDEO_SQL}
      WHERE v.status = 'approved' AND c.status = 'active' AND (v.last_fetched_at IS NULL OR v.last_fetched_at < ?)
      ORDER BY v.last_fetched_at IS NOT NULL, v.last_fetched_at LIMIT 1000`).bind(cutoff).all();
    return json({ ok: true, videos: rows.results.map(adminVideoJson) }, 200, headers);
  }
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
  const [snapshots, flags, audit, screenshots, apiViews] = await env.DB.batch([
    env.DB.prepare(`SELECT s.id, s.view_count, s.like_count, s.comment_count, s.source, s.fetched_at, s.note, s.delta_views, s.earned_cents,
        u.name entered_by_name, li.payout_id
      FROM view_snapshots s LEFT JOIN users u ON u.id = s.entered_by LEFT JOIN payout_line_items li ON li.view_snapshot_id = s.id
      WHERE s.video_id = ? ORDER BY s.fetched_at DESC LIMIT 200`).bind(id),
    env.DB.prepare(`SELECT f.*, u.name resolved_by_name FROM video_flags f LEFT JOIN users u ON u.id = f.resolved_by
      WHERE f.video_id = ? ORDER BY f.created_at DESC`).bind(id),
    env.DB.prepare(`SELECT * FROM affiliate_audit_log WHERE entity_type = 'video' AND entity_id = ? ORDER BY created_at DESC`).bind(id),
    env.DB.prepare('SELECT * FROM video_screenshots WHERE video_id = ? ORDER BY uploaded_at DESC').bind(id),
    // v7: the number Instagram reported for this video, if the creator connected their account
    // (CONTRACT.md §8). A suggestion for the weekly entry box — it prices nothing on its own.
    env.DB.prepare(`SELECT a.*, c.username FROM video_api_views a
      LEFT JOIN videos v ON v.id = a.video_id
      LEFT JOIN creator_instagram_connections c ON c.creator_id = v.creator_id
      WHERE a.video_id = ?`).bind(id)
  ]);
  const api = apiViews.results[0] || null;
  return json({
    ok: true, video,
    snapshots: snapshots.results.map(s => ({
      id: s.id, viewCount: s.view_count, likeCount: s.like_count, commentCount: s.comment_count, source: s.source,
      fetchedAt: s.fetched_at, note: s.note, deltaViews: s.delta_views, earnedCents: s.earned_cents,
      payoutId: s.payout_id, enteredByName: s.entered_by_name
    })),
    flags: flags.results.map(flagJson),
    screenshots: screenshots.results.map(s => ({
      id: s.id, contentType: s.content_type, sizeBytes: s.size_bytes, reportedViews: s.reported_views, note: s.note, uploadedAt: s.uploaded_at
    })),
    apiViews: api ? {
      views: api.views, reach: api.reach, likes: api.likes, comments: api.comments,
      fetchedAt: api.fetched_at, error: api.error, username: api.username
    } : null,
    audit: audit.results.map(auditJson)
  }, 200, headers);
}

// The affiliate's insights screenshot. Staff-only; the CRM fetches it with its bearer token.
async function getScreenshot(request, env, headers, [id]) {
  await requireUser(request, env);
  const row = await env.DB.prepare('SELECT id FROM video_screenshots WHERE id = ?').bind(id).first();
  const object = row && await env.SKETCHES.get(`video-screenshots/${row.id}`);
  if (!object) return new Response('Not found', { status: 404, headers });
  return new Response(object.body, { headers: { ...headers, 'content-type': object.httpMetadata?.contentType || 'image/png', 'cache-control': 'private, max-age=3600' } });
}

// approve:          pending_review / rejected / removed → approved (or back to locked if it had already locked)
// reject:           pending_review / approved / removed → rejected, with a reason. Blocked once any week
//                    of this video has been paid — resolve that with a remove instead.
// remove:           pending_review / approved / locked → removed, with an optional reason
// mark_unavailable: approved → removed, flagged so staff know why (the affiliate's post disappeared)
async function reviewVideo(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const video = await loadVideo(env, id);
  const stamp = now();
  let fields;
  let action = body.action;
  if (action === 'approve') {
    if (!['pending_review', 'rejected', 'removed'].includes(video.status)) throw new HttpError(409, 'Only videos waiting for review, rejected, or removed can be approved.');
    fields = video.locked_at
      ? { status: 'locked', rejection_reason: null }
      : { status: 'approved', rejection_reason: null, approved_at: stamp, approved_by: user.id };
  } else if (action === 'reject') {
    if (!['pending_review', 'approved', 'removed'].includes(video.status)) throw new HttpError(409, 'Locked videos can’t be rejected. Remove it instead.');
    if (await env.DB.prepare('SELECT 1 FROM payout_line_items WHERE video_id = ?').bind(id).first()) {
      throw new HttpError(409, 'This video has already been paid on, so it can’t be rejected. Remove it instead.');
    }
    const reason = clean(body.reason, 1000);
    if (!reason) throw new HttpError(400, 'Give the affiliate a reason. They see it in their portal.');
    fields = { status: 'rejected', rejection_reason: reason };
  } else if (action === 'remove' || action === 'mark_unavailable') {
    const allowed = action === 'mark_unavailable' ? ['approved'] : ['pending_review', 'approved', 'locked'];
    if (!allowed.includes(video.status)) throw new HttpError(409, 'This video can’t be removed.');
    fields = { status: 'removed', rejection_reason: clean(body.reason, 1000) || video.rejection_reason };
  } else {
    throw new HttpError(400, 'action must be approve, reject, remove, or mark_unavailable.');
  }
  const statements = [
    env.DB.prepare(`UPDATE videos SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(fields), id),
    auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'video', entityId: id,
      action: `video_${{ approve: 'approved', reject: 'rejected', remove: 'removed', mark_unavailable: 'marked_unavailable' }[action]}`,
      before: { status: video.status, rejection_reason: video.rejection_reason }, after: { status: fields.status, rejection_reason: fields.rejection_reason ?? null }
    })
  ];
  if (action === 'mark_unavailable') statements.push(flagStatement(env, id, 'video_unavailable', clean(body.reason, 1000) || 'Marked unavailable by staff during a weekly check.'));
  await env.DB.batch(statements);
  await recomputeCampaign(env, video.campaign_id);
  return json({ ok: true, video: adminVideoJson(await loadVideo(env, id)) }, 200, headers);
}

// Weekly view count: appended as a snapshot, priced against the delta since the last one. Locked videos
// (campaign ended) can't take new entries — that's what locking now means.
async function enterViews(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const video = await loadVideo(env, id);
  if (video.status === 'locked') throw new HttpError(409, 'This video is locked (its campaign ended), so its views can’t change.');
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
  const stamp = now();
  const deltaViews = Math.max(0, views - video.latest_view_count);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO view_snapshots (id, video_id, view_count, like_count, comment_count, source, fetched_at, entered_by, note, delta_views)
      VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`).bind(crypto.randomUUID(), id, views, likes, comments, stamp, user.id, note, deltaViews),
    env.DB.prepare('UPDATE videos SET latest_view_count = ?, last_fetched_at = ? WHERE id = ?').bind(views, stamp, id),
    auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'video', entityId: id, action: 'weekly_views_entered',
      before: { latest_view_count: video.latest_view_count },
      after: { latest_view_count: views, delta_views: deltaViews, like_count: likes, comment_count: comments, note }
    })
  ]);
  await recomputeCampaign(env, video.campaign_id);
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
  'GET /api/affiliate-screenshots/:id': getScreenshot,
  'GET /api/video-flags': listFlags,
  'POST /api/video-flags/:id/resolve': resolveFlag,
  'GET /api/affiliate-audit': listAudit
};
