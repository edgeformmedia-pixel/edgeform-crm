import { now } from './lib.js';
import { addHours, normalizeHandle, recomputeCampaign, auditStatement, flagStatement } from './affiliate-lib.js';
import { tiktokProvider, instagramProvider } from './affiliate-oauth.js';

// View polling (CONTRACT.md §3). Runs every minute from scheduled(): up to 25 approved videos per tick.
// Every 6 hours for the first 72 hours after submission, then every 24 hours, until tracking ends;
// then one final check, and the video locks with its views frozen as billable_views.

const BATCH = 25;
const LEASE_MINUTES = 15;           // an overlapping tick won't pick the same videos
const EARLY_HOURS = 72;
const FAILURES_TO_FLAG = 3;
const SPIKE_MULTIPLIER = 4;         // more than +300% …
const SPIKE_LIKE_RATIO = 0.005;     // … while likes grow by less than 0.5% of the new views
const RAW_LIMIT = 20000;

// Provider results, per video id:
//   { ok: true, views, likes, comments, source, raw, meta: { thumbnail_url, caption, posted_at, handles: [] } }
//   { unavailable: true, reason }   deleted or private
//   { error: 'message' }            counts as a failed check
//   { skip: true }                  provider not configured: try again later, not a failure

// ── YouTube Data API v3 ──

const youtubeBase = (env) => env.YOUTUBE_API_URL || 'https://www.googleapis.com/youtube/v3';

async function youtubeGet(env, path, params) {
  const url = `${youtubeBase(env)}/${path}?${new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY })}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !Array.isArray(data.items)) throw new Error(`YouTube API ${res.status}: ${data?.error?.message || 'unexpected response'}`);
  return data;
}

const count = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export async function youtubeProvider(env, videos) {
  const results = new Map();
  if (!env.YOUTUBE_API_KEY) { for (const v of videos) results.set(v.id, { skip: true }); return results; }
  for (let i = 0; i < videos.length; i += 50) {
    const chunk = videos.slice(i, i + 50);
    let items;
    try {
      items = (await youtubeGet(env, 'videos', { part: 'statistics,snippet,status', id: chunk.map(v => v.platform_video_id).join(','), maxResults: '50' })).items || [];
    } catch (error) {
      for (const v of chunk) results.set(v.id, { error: error.message });
      continue;
    }
    // Channel handles, only for videos we haven't read details for yet.
    const needHandles = [...new Set(items.filter(it => chunk.some(v => v.platform_video_id === it.id && !v.posted_at)).map(it => it.snippet?.channelId).filter(Boolean))];
    const handles = new Map();
    if (needHandles.length) {
      try {
        const channels = (await youtubeGet(env, 'channels', { part: 'snippet', id: needHandles.join(','), maxResults: '50' })).items || [];
        for (const ch of channels) handles.set(ch.id, ch.snippet?.customUrl || '');
      } catch { /* handles are only used for the mismatch check */ }
    }
    for (const v of chunk) {
      const item = items.find(it => it.id === v.platform_video_id);
      if (!item) { results.set(v.id, { unavailable: true, reason: 'YouTube says this video was deleted or made private.' }); continue; }
      if (item.status?.privacyStatus === 'private') { results.set(v.id, { unavailable: true, reason: 'This YouTube video is private.' }); continue; }
      const views = count(item.statistics?.viewCount);
      if (views === null) { results.set(v.id, { error: 'YouTube returned no view count.' }); continue; }
      const snippet = item.snippet || {};
      results.set(v.id, {
        ok: true, source: 'api', views, likes: count(item.statistics?.likeCount), comments: count(item.statistics?.commentCount), raw: item,
        meta: {
          thumbnail_url: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
          caption: snippet.title || null, posted_at: snippet.publishedAt || null,
          handles: [handles.get(snippet.channelId), snippet.channelId].filter(Boolean)
        }
      });
    }
  }
  return results;
}

const PROVIDERS = { youtube: youtubeProvider, tiktok: tiktokProvider, instagram: instagramProvider };

// ── Scheduling ──

/** When to check a video next: every 6h for its first 72h, then daily, never past the end of tracking. */
export function nextFetchAt(video, stamp) {
  const ageHours = (new Date(stamp) - new Date(video.submitted_at)) / 3600000;
  const next = addHours(stamp, ageHours < EARLY_HOURS ? 6 : 24);
  return next < video.tracking_ends_at ? next : video.tracking_ends_at;
}

/** Views up more than 300% in 24h while likes grew by less than 0.5% of the new views. */
export function isSuspiciousSpike(baseline, views, likes) {
  if (!baseline || !(baseline.view_count > 0) || likes === null || baseline.like_count === null || baseline.like_count === undefined) return false;
  const gained = views - baseline.view_count;
  return views > baseline.view_count * SPIKE_MULTIPLIER && likes - baseline.like_count < gained * SPIKE_LIKE_RATIO;
}

// ── Processing ──

async function spikeBaseline(env, videoId, stamp) {
  const dayAgo = addHours(stamp, -24);
  return await env.DB.prepare('SELECT view_count, like_count FROM view_snapshots WHERE video_id = ? AND fetched_at <= ? ORDER BY fetched_at DESC LIMIT 1').bind(videoId, dayAgo).first()
    || await env.DB.prepare('SELECT view_count, like_count FROM view_snapshots WHERE video_id = ? AND fetched_at > ? ORDER BY fetched_at ASC LIMIT 1').bind(videoId, dayAgo).first();
}

function lockStatements(env, video, views, stamp) {
  return [
    env.DB.prepare("UPDATE videos SET status = 'locked', billable_views = ?, locked_at = ?, next_fetch_at = NULL WHERE id = ? AND status = 'approved'").bind(views, stamp, video.id),
    auditStatement(env, { actorType: 'system', entityType: 'video', entityId: video.id, action: 'video_locked', after: { billable_views: views } })
  ];
}

async function applyResult(env, video, result, stamp) {
  const trackingOver = video.tracking_ends_at <= stamp;
  const statements = [];

  if (result.skip) {
    // No provider: freeze on whatever we have (manual entries) once tracking is over.
    if (trackingOver) statements.push(...lockStatements(env, video, video.latest_view_count, stamp));
    else statements.push(env.DB.prepare('UPDATE videos SET next_fetch_at = ? WHERE id = ?').bind(addHours(stamp, 1), video.id));
  } else if (result.unavailable) {
    // Earnings are never zeroed automatically: the video is set aside and flagged for a person to decide.
    statements.push(
      env.DB.prepare("UPDATE videos SET status = 'removed', next_fetch_at = NULL, last_fetched_at = ? WHERE id = ? AND status = 'approved'").bind(stamp, video.id),
      flagStatement(env, video.id, 'video_unavailable', result.reason),
      auditStatement(env, { actorType: 'system', entityType: 'video', entityId: video.id, action: 'video_unavailable', before: { status: video.status }, after: { status: 'removed', reason: result.reason } })
    );
  } else if (result.error) {
    const failures = video.consecutive_fetch_failures + 1;
    if (failures >= FAILURES_TO_FLAG) statements.push(flagStatement(env, video.id, 'fetch_failed', `${failures} checks in a row failed. Last error: ${result.error}`));
    if (trackingOver && failures >= FAILURES_TO_FLAG) {
      statements.push(env.DB.prepare('UPDATE videos SET consecutive_fetch_failures = ? WHERE id = ?').bind(failures, video.id), ...lockStatements(env, video, video.latest_view_count, stamp));
    } else {
      const retry = addHours(stamp, Math.min(6, failures));
      statements.push(env.DB.prepare('UPDATE videos SET consecutive_fetch_failures = ?, next_fetch_at = ? WHERE id = ?')
        .bind(failures, trackingOver || retry < video.tracking_ends_at ? retry : video.tracking_ends_at, video.id));
    }
  } else {
    // Views only go up from automatic checks; a person can lower them with a manual entry.
    const views = Math.max(video.latest_view_count, result.views);
    const baseline = await spikeBaseline(env, video.id, stamp);
    let raw = result.raw === undefined ? null : JSON.stringify(result.raw);
    if (raw && raw.length > RAW_LIMIT) raw = raw.slice(0, RAW_LIMIT);
    const meta = result.meta || {};
    statements.push(
      env.DB.prepare(`INSERT INTO view_snapshots (id, video_id, view_count, like_count, comment_count, source, fetched_at, raw_response) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), video.id, result.views, result.likes ?? null, result.comments ?? null, result.source, stamp, raw),
      env.DB.prepare(`UPDATE videos SET latest_view_count = ?, last_fetched_at = ?, consecutive_fetch_failures = 0, next_fetch_at = ?,
          thumbnail_url = COALESCE(?, thumbnail_url), caption = COALESCE(caption, ?), posted_at = COALESCE(posted_at, ?) WHERE id = ?`)
        .bind(views, stamp, trackingOver ? null : nextFetchAt(video, stamp), meta.thumbnail_url || null, meta.caption || null, meta.posted_at || null, video.id)
    );
    if (isSuspiciousSpike(baseline, result.views, result.likes ?? null)) {
      statements.push(flagStatement(env, video.id, 'suspicious_spike',
        `Views went from ${baseline.view_count} to ${result.views} while likes went from ${baseline.like_count} to ${result.likes}.`));
    }
    const saved = normalizeHandle(video.creator_handle);
    const found = (meta.handles || []).map(normalizeHandle).filter(Boolean);
    // Only compare real handles; a saved display name ("Ava Makes") can't be checked.
    if (!video.posted_at && /^[\w.-]+$/.test(saved) && found.length && !found.includes(saved)) {
      statements.push(flagStatement(env, video.id, 'handle_mismatch', `Posted by ${found[0]}; creator's ${video.platform} is ${saved}.`));
    }
    if (trackingOver) statements.push(...lockStatements(env, video, views, stamp));
  }
  await env.DB.batch(statements);
}

const DUE_SQL = `SELECT v.*, CASE v.platform WHEN 'youtube' THEN cr.youtube WHEN 'tiktok' THEN cr.tiktok ELSE cr.instagram END creator_handle
  FROM videos v JOIN creators cr ON cr.id = v.creator_id`;

/** Checks the given videos now, stores the results, and recomputes their campaigns. */
export async function checkVideos(env, videos) {
  const stamp = now();
  const byPlatform = {};
  for (const v of videos) (byPlatform[v.platform] ||= []).push(v);
  const touched = new Set();
  for (const [platform, list] of Object.entries(byPlatform)) {
    let results;
    try {
      results = await PROVIDERS[platform](env, list);
    } catch (error) {
      results = new Map(list.map(v => [v.id, { error: error.message || 'Provider failed.' }]));
    }
    for (const v of list) {
      try {
        await applyResult(env, v, results.get(v.id) || { error: 'No result from provider.' }, stamp);
        touched.add(v.campaign_id);
      } catch (error) {
        console.error('affiliate view check failed', v.id, error?.message);
      }
    }
  }
  for (const campaignId of touched) await recomputeCampaign(env, campaignId);
  return touched.size;
}

export async function affiliateViewsCron(env) {
  const stamp = now();
  const due = await env.DB.prepare(`${DUE_SQL} WHERE v.status = 'approved' AND (v.next_fetch_at <= ? OR v.tracking_ends_at <= ?)
    ORDER BY COALESCE(v.next_fetch_at, v.tracking_ends_at) LIMIT ${BATCH}`).bind(stamp, stamp).all();
  if (!due.results.length) return;
  const lease = new Date(Date.now() + LEASE_MINUTES * 60000).toISOString();
  await env.DB.batch(due.results.map(v => env.DB.prepare('UPDATE videos SET next_fetch_at = ? WHERE id = ?').bind(lease, v.id)));
  await checkVideos(env, due.results);
}

/** Admin "check now" for one video. */
export async function checkVideoNow(env, id) {
  const video = await env.DB.prepare(`${DUE_SQL} WHERE v.id = ?`).bind(id).first();
  if (!video || video.status !== 'approved') return false;
  await checkVideos(env, [video]);
  return true;
}
