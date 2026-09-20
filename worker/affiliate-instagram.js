// Instagram connections (CONTRACT.md §8).
//
// Why this exists: Instagram trial reels are shown only to non-followers and their view count
// isn't public anywhere — not on the post, not to a logged-out scraper. But the account's OWN
// token can read it. Verified 2026-09-19: a trial reel comes back from /me/media and its
// insights return a real `views` number, even though the profile's public media_count doesn't
// count it. Meta documents neither way, so treat this as behaviour that could change.
//
// What this is NOT: v3's automated polling. Nothing here prices a week, moves money, or writes
// to view_snapshots. Numbers land in video_api_views and pre-fill the weekly entry box; a human
// still saves every priced week, because priced weeks are permanent (CONTRACT.md §3).

import { encryptText, decryptText, PORTAL_URL, addDays } from './affiliate-lib.js';
import { now } from './lib.js';

const GRAPH = 'https://graph.instagram.com/v23.0';
const SCOPES = 'instagram_business_basic,instagram_business_manage_insights';

// Long-lived tokens last ~60 days. Refresh well before that: a token that expires is a broken
// connection the affiliate has to notice and fix themselves.
const REFRESH_WHEN_DAYS_LEFT = 10;
const MIN_TOKEN_AGE_HOURS = 24;   // Instagram refuses to refresh a token younger than this
const SYNC_EVERY_MINUTES = 6 * 60;
const MEDIA_PAGE_LIMIT = 100;
const MAX_MEDIA_PAGES = 10;       // 1000 posts; beyond that the video is too old to still be tracking

export const redirectUri = (env) => `${env.API_URL}/api/affiliate/instagram/callback`;
// AFFILIATE_ENCRYPTION_KEY is part of being configured: without it there's nowhere safe to put
// the token, and an empty HMAC key fails deep inside WebCrypto with a DataError that tells
// nobody anything. Better to report the feature as off.
export const isConfigured = (env) => Boolean(env.IG_APP_ID && env.IG_APP_SECRET && env.AFFILIATE_ENCRYPTION_KEY);

// ── Signed state ──
// The OAuth callback arrives with no session (it's a browser redirect from Instagram), so the
// creator is carried in a signed, expiring state parameter rather than looked up from a cookie.

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

export async function signState(env, creatorId) {
  const body = b64url(new TextEncoder().encode(JSON.stringify({ c: creatorId, e: Date.now() + 15 * 60000 })));
  return `${body}.${await hmac(body, env.AFFILIATE_ENCRYPTION_KEY)}`;
}

export async function readState(env, state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  if (sig !== await hmac(body, env.AFFILIATE_ENCRYPTION_KEY)) return null;
  try {
    const padded = body.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), ch => ch.charCodeAt(0))));
    return parsed.e > Date.now() ? parsed.c : null;
  } catch { return null; }
}

export function authorizeUrl(env, state) {
  const params = new URLSearchParams({
    client_id: env.IG_APP_ID,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: SCOPES,
    state
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

// ── Token lifecycle ──

async function graph(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const message = data.error?.message || data.error_message || `Instagram returned ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export async function exchangeCode(env, code) {
  const body = new URLSearchParams({
    client_id: env.IG_APP_ID,
    client_secret: env.IG_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(env),
    // Instagram appends "#_" to the code in the browser redirect; it isn't part of the code.
    code: String(code).replace(/#_$/, '')
  });
  const response = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_message || data.error?.message || 'Instagram rejected the sign-in.');
  return data;   // { access_token (short-lived), user_id, permissions }
}

const longLived = (env, shortToken) =>
  graph(`${GRAPH.replace('/v23.0', '')}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(env.IG_APP_SECRET)}&access_token=${encodeURIComponent(shortToken)}`);

const refreshed = (token) =>
  graph(`${GRAPH.replace('/v23.0', '')}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);

const profile = (token) =>
  graph(`${GRAPH}/me?fields=id,username,account_type&access_token=${encodeURIComponent(token)}`);

// Stores (or replaces) a creator's connection. Called from the OAuth callback.
export async function saveConnection(env, creatorId, shortToken) {
  const long = await longLived(env, shortToken);
  const me = await profile(long.access_token);
  const stamp = now();
  const row = {
    creator_id: creatorId,
    ig_user_id: String(me.id),
    username: me.username || null,
    access_token_encrypted: await encryptText(long.access_token, env.AFFILIATE_ENCRYPTION_KEY),
    token_expires_at: addDays(stamp, Math.max(1, Math.floor((long.expires_in || 5184000) / 86400))),
    scopes: SCOPES,
    connected_at: stamp,
    last_refreshed_at: stamp,
    last_synced_at: null,
    last_error: null
  };
  await env.DB.prepare(`INSERT INTO creator_instagram_connections
      (creator_id, ig_user_id, username, access_token_encrypted, token_expires_at, scopes, connected_at, last_refreshed_at, last_synced_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(creator_id) DO UPDATE SET
      ig_user_id = excluded.ig_user_id, username = excluded.username,
      access_token_encrypted = excluded.access_token_encrypted, token_expires_at = excluded.token_expires_at,
      scopes = excluded.scopes, last_refreshed_at = excluded.last_refreshed_at, last_error = NULL`)
    .bind(...Object.values(row)).run();
  return { ...row, account_type: me.account_type };
}

const tokenOf = (env, connection) => decryptText(connection.access_token_encrypted, env.AFFILIATE_ENCRYPTION_KEY);

// ── Reading views ──

export function shortcodeOf(permalink) {
  const match = String(permalink || '').match(/\/(?:reel|reels|p|tv)\/([\w-]+)/);
  return match ? match[1] : null;
}

// Instagram has no "look up a post by its URL" endpoint, so the whole media list is walked and
// matched on permalink. Trial reels are in here even though they're missing from the public
// profile grid — that's the entire point of this integration.
async function fetchMediaIndex(token) {
  const index = new Map();
  let url = `${GRAPH}/me/media?fields=id,permalink,timestamp,media_product_type&limit=${MEDIA_PAGE_LIMIT}&access_token=${encodeURIComponent(token)}`;
  for (let page = 0; page < MAX_MEDIA_PAGES && url; page++) {
    const data = await graph(url);
    for (const media of data.data || []) {
      const code = shortcodeOf(media.permalink);
      if (code && !index.has(code)) index.set(code, media);
    }
    url = data.paging?.next || null;
  }
  return index;
}

async function fetchInsights(token, mediaId) {
  const data = await graph(`${GRAPH}/${encodeURIComponent(mediaId)}/insights?metric=views,reach,likes,comments&access_token=${encodeURIComponent(token)}`);
  const out = {};
  for (const metric of data.data || []) out[metric.name] = metric.values?.[0]?.value ?? null;
  return out;
}

// Refreshes one creator's numbers for every video of theirs that's still being tracked.
// Never throws for a single bad video: one deleted reel shouldn't stop the rest.
export async function syncCreator(env, connection) {
  const videos = await env.DB.prepare(
    `SELECT id, platform_video_id FROM videos
      WHERE creator_id = ? AND platform = 'instagram' AND status IN ('pending_review', 'approved')`
  ).bind(connection.creator_id).all();
  if (!videos.results.length) {
    await env.DB.prepare('UPDATE creator_instagram_connections SET last_synced_at = ?, last_error = NULL WHERE creator_id = ?')
      .bind(now(), connection.creator_id).run();
    return { matched: 0, total: 0 };
  }

  const token = await tokenOf(env, connection);
  let index;
  try {
    index = await fetchMediaIndex(token);
  } catch (error) {
    await env.DB.prepare('UPDATE creator_instagram_connections SET last_synced_at = ?, last_error = ? WHERE creator_id = ?')
      .bind(now(), String(error.message).slice(0, 300), connection.creator_id).run();
    return { matched: 0, total: videos.results.length, error: error.message };
  }

  const statements = [];
  let matched = 0;
  for (const video of videos.results) {
    const media = index.get(video.platform_video_id);
    let row;
    if (!media) {
      row = [video.id, null, null, null, null, null, now(), 'This post is not on the connected Instagram account.'];
    } else {
      try {
        const insights = await fetchInsights(token, media.id);
        row = [video.id, media.id, insights.views ?? null, insights.reach ?? null, insights.likes ?? null, insights.comments ?? null, now(), null];
        matched++;
      } catch (error) {
        row = [video.id, media.id, null, null, null, null, now(), String(error.message).slice(0, 300)];
      }
    }
    statements.push(env.DB.prepare(
      `INSERT INTO video_api_views (video_id, ig_media_id, views, reach, likes, comments, fetched_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET ig_media_id = excluded.ig_media_id, views = excluded.views,
         reach = excluded.reach, likes = excluded.likes, comments = excluded.comments,
         fetched_at = excluded.fetched_at, error = excluded.error`).bind(...row));
  }
  statements.push(env.DB.prepare('UPDATE creator_instagram_connections SET last_synced_at = ?, last_error = NULL WHERE creator_id = ?')
    .bind(now(), connection.creator_id));
  await env.DB.batch(statements);
  return { matched, total: videos.results.length };
}

// ── Cron ──
// Runs every minute with the rest of the Worker's cron, but only does work when something is
// actually due: a token near expiry, or a connection that hasn't synced in SYNC_EVERY_MINUTES.

export async function instagramCron(env) {
  if (!isConfigured(env) || !env.AFFILIATE_ENCRYPTION_KEY) return;
  const stamp = now();

  const expiring = await env.DB.prepare(
    `SELECT * FROM creator_instagram_connections
      WHERE token_expires_at IS NOT NULL AND token_expires_at < ?
        AND (last_refreshed_at IS NULL OR last_refreshed_at < ?)
      LIMIT 5`
  ).bind(addDays(stamp, REFRESH_WHEN_DAYS_LEFT), new Date(Date.now() - MIN_TOKEN_AGE_HOURS * 3600000).toISOString()).all();

  for (const connection of expiring.results) {
    try {
      const fresh = await refreshed(await tokenOf(env, connection));
      await env.DB.prepare(`UPDATE creator_instagram_connections
          SET access_token_encrypted = ?, token_expires_at = ?, last_refreshed_at = ?, last_error = NULL WHERE creator_id = ?`)
        .bind(
          await encryptText(fresh.access_token, env.AFFILIATE_ENCRYPTION_KEY),
          addDays(now(), Math.max(1, Math.floor((fresh.expires_in || 5184000) / 86400))),
          now(), connection.creator_id
        ).run();
    } catch (error) {
      // Left connected with the error recorded: the affiliate has to reconnect, and staff can see why.
      await env.DB.prepare('UPDATE creator_instagram_connections SET last_error = ?, last_refreshed_at = ? WHERE creator_id = ?')
        .bind(`Couldn't refresh the Instagram connection: ${String(error.message).slice(0, 200)}`, now(), connection.creator_id).run();
    }
  }

  const due = await env.DB.prepare(
    `SELECT * FROM creator_instagram_connections
      WHERE last_synced_at IS NULL OR last_synced_at < ? LIMIT 3`
  ).bind(new Date(Date.now() - SYNC_EVERY_MINUTES * 60000).toISOString()).all();

  for (const connection of due.results) {
    try { await syncCreator(env, connection); }
    catch (error) { console.error('instagram sync failed', connection.creator_id, error?.message); }
  }
}

// ── Shapes ──

export const connectionJson = (c) => c ? ({
  connected: true,
  username: c.username || null,
  connected_at: c.connected_at,
  last_synced_at: c.last_synced_at || null,
  expires_at: c.token_expires_at || null,
  needs_reconnect: Boolean(c.last_error),
  error: c.last_error || null
}) : { connected: false, username: null, connected_at: null, last_synced_at: null, expires_at: null, needs_reconnect: false, error: null };

export const settingsUrl = (result) => `${PORTAL_URL}/settings.html?instagram=${result}`;
