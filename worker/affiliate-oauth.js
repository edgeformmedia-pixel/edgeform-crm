import { now, randomToken, timingSafeEqual } from './lib.js';
import { PORTAL_URL, encryptText, decryptText, auditStatement } from './affiliate-lib.js';

// TikTok and Instagram account connections for affiliates, and reading view counts through them.
// TikTok: Login Kit v2 (TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET), scopes user.info.basic, user.info.profile, video.list.
// Instagram: Instagram API with Instagram Login (INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET), which needs a
// Business or Creator account; scopes instagram_business_basic, instagram_business_manage_insights.
// Tokens are stored AES-GCM encrypted with AFFILIATE_ENCRYPTION_KEY.

const hosts = (env) => ({
  tiktokAuth: env.TIKTOK_AUTH_URL || 'https://www.tiktok.com/v2/auth/authorize/',
  tiktokApi: env.TIKTOK_API_URL || 'https://open.tiktokapis.com/v2',
  igAuth: env.INSTAGRAM_AUTH_URL || 'https://www.instagram.com/oauth/authorize',
  igApi: env.INSTAGRAM_API_URL || 'https://api.instagram.com',
  igGraph: env.INSTAGRAM_GRAPH_URL || 'https://graph.instagram.com'
});
const STATE_MINUTES = 15;

export function connectionsConfigured(env, platform) {
  if (!env.AFFILIATE_ENCRYPTION_KEY) return false;
  if (platform === 'tiktok') return !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
  if (platform === 'instagram') return !!(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
  return false;
}

const redirectUri = (env, platform) => `${env.API_URL}/api/affiliate/v1/oauth/${platform}/callback`;

// ── Signed state (who is connecting, and which platform) ──

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text) => atob(text.replace(/-/g, '+').replace(/_/g, '/'));

async function sign(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

async function signState(env, payload) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await sign(env.AFFILIATE_ENCRYPTION_KEY, 'oauth-state:' + body)}`;
}

async function readState(env, state) {
  const [body, signature] = String(state || '').split('.');
  if (!body || !signature || !timingSafeEqual(signature, await sign(env.AFFILIATE_ENCRYPTION_KEY, 'oauth-state:' + body))) return null;
  try {
    const payload = JSON.parse(fromB64url(body));
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

// ── Connect ──

export async function connectionStart(env, creator, platform) {
  const h = hosts(env);
  const state = await signState(env, { c: creator.id, p: platform, n: randomToken(8), exp: Date.now() + STATE_MINUTES * 60000 });
  if (platform === 'tiktok') {
    return `${h.tiktokAuth}?${new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, scope: 'user.info.basic,user.info.profile,video.list', response_type: 'code', redirect_uri: redirectUri(env, platform), state })}`;
  }
  return `${h.igAuth}?${new URLSearchParams({ client_id: env.INSTAGRAM_APP_ID, redirect_uri: redirectUri(env, platform), response_type: 'code', scope: 'instagram_business_basic,instagram_business_manage_insights', state })}`;
}

async function readApi(res, label) {
  const data = await res.json().catch(() => null);
  const failed = !res.ok || !data || data.error_description || (data.error && (typeof data.error === 'string' || (data.error.code && data.error.code !== 'ok')));
  if (failed) throw new Error(`${label} ${res.status}: ${data?.error_description || data?.error?.message || data?.error_message || data?.error || 'request failed'}`);
  return data;
}

const form = (fields) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
const inSeconds = (seconds) => (seconds ? new Date(Date.now() + Number(seconds) * 1000).toISOString() : null);

async function tiktokExchange(env, code) {
  const h = hosts(env);
  const token = await readApi(await fetch(`${h.tiktokApi}/oauth/token/`, form({
    client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirectUri(env, 'tiktok')
  })), 'TikTok token');
  const info = await readApi(await fetch(`${h.tiktokApi}/user/info/?fields=open_id,username,display_name`, { headers: { authorization: `Bearer ${token.access_token}` } }), 'TikTok user');
  const user = info.data?.user || {};
  return {
    platform_user_id: user.open_id || token.open_id, platform_username: user.username || user.display_name || '',
    access_token: token.access_token, refresh_token: token.refresh_token || null, token_expires_at: inSeconds(token.expires_in)
  };
}

async function instagramExchange(env, code) {
  const h = hosts(env);
  const short = await readApi(await fetch(`${h.igApi}/oauth/access_token`, form({
    client_id: env.INSTAGRAM_APP_ID, client_secret: env.INSTAGRAM_APP_SECRET, grant_type: 'authorization_code', redirect_uri: redirectUri(env, 'instagram'), code
  })), 'Instagram token');
  const shortToken = (short.data?.[0] || short).access_token;
  // Short-lived (1h) → long-lived (60 days).
  const long = await readApi(await fetch(`${h.igGraph}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: env.INSTAGRAM_APP_SECRET, access_token: shortToken })}`), 'Instagram long-lived token');
  const me = await readApi(await fetch(`${h.igGraph}/me?${new URLSearchParams({ fields: 'user_id,username', access_token: long.access_token })}`), 'Instagram profile');
  return {
    platform_user_id: String(me.user_id || me.id || (short.data?.[0] || short).user_id), platform_username: me.username || '',
    access_token: long.access_token, refresh_token: null, token_expires_at: inSeconds(long.expires_in)
  };
}

export async function connectionCallback(request, env, headers, [platform]) {
  const url = new URL(request.url);
  const back = (query) => Response.redirect(`${PORTAL_URL}/settings.html?${query}`, 302);
  if (!['tiktok', 'instagram'].includes(platform)) return back('error=unsupported_platform');
  if (!connectionsConfigured(env, platform)) return back('error=not_available');
  if (url.searchParams.get('error')) return back('error=access_denied');
  const state = await readState(env, url.searchParams.get('state'));
  if (!state || state.p !== platform) return back('error=invalid_state');
  const code = url.searchParams.get('code');
  if (!code) return back('error=missing_code');
  try {
    const conn = await (platform === 'tiktok' ? tiktokExchange : instagramExchange)(env, code);
    const key = env.AFFILIATE_ENCRYPTION_KEY;
    const stamp = now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO creator_platform_connections (id, creator_id, platform, platform_user_id, platform_username, access_token_encrypted,
          refresh_token_encrypted, token_expires_at, connected_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(creator_id, platform) DO UPDATE SET platform_user_id = excluded.platform_user_id, platform_username = excluded.platform_username,
          access_token_encrypted = excluded.access_token_encrypted, refresh_token_encrypted = excluded.refresh_token_encrypted,
          token_expires_at = excluded.token_expires_at, connected_at = excluded.connected_at, revoked_at = NULL`)
        .bind(crypto.randomUUID(), state.c, platform, conn.platform_user_id, conn.platform_username, await encryptText(conn.access_token, key),
          conn.refresh_token ? await encryptText(conn.refresh_token, key) : null, conn.token_expires_at, stamp),
      auditStatement(env, { actorType: 'creator', actorId: state.c, entityType: 'creator', entityId: state.c, action: 'platform_connected', after: { platform, platform_username: conn.platform_username } })
    ]);
    return back(`connected=${platform}`);
  } catch (error) {
    console.error('affiliate oauth callback failed', platform, error?.message);
    return back('error=connection_failed');
  }
}

// ── Tokens ──

async function connectionFor(env, creatorId, platform) {
  const row = await env.DB.prepare('SELECT * FROM creator_platform_connections WHERE creator_id = ? AND platform = ? AND revoked_at IS NULL').bind(creatorId, platform).first();
  if (!row) return null;
  const key = env.AFFILIATE_ENCRYPTION_KEY;
  let token = await decryptText(row.access_token_encrypted, key);
  const expiresSoon = (ms) => row.token_expires_at && new Date(row.token_expires_at).getTime() - Date.now() < ms;
  const h = hosts(env);
  if (platform === 'tiktok' && expiresSoon(5 * 60000) && row.refresh_token_encrypted) {
    const fresh = await readApi(await fetch(`${h.tiktokApi}/oauth/token/`, form({
      client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: await decryptText(row.refresh_token_encrypted, key)
    })), 'TikTok refresh');
    token = fresh.access_token;
    await env.DB.prepare('UPDATE creator_platform_connections SET access_token_encrypted = ?, refresh_token_encrypted = COALESCE(?, refresh_token_encrypted), token_expires_at = ? WHERE id = ?')
      .bind(await encryptText(token, key), fresh.refresh_token ? await encryptText(fresh.refresh_token, key) : null, inSeconds(fresh.expires_in), row.id).run();
  } else if (platform === 'instagram' && expiresSoon(7 * 86400000)) {
    // Long-lived Instagram tokens refresh themselves for another 60 days.
    const fresh = await readApi(await fetch(`${h.igGraph}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })}`), 'Instagram refresh');
    token = fresh.access_token;
    await env.DB.prepare('UPDATE creator_platform_connections SET access_token_encrypted = ?, token_expires_at = ? WHERE id = ?')
      .bind(await encryptText(token, key), inSeconds(fresh.expires_in), row.id).run();
  }
  return { ...row, token };
}

const count = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));

function byCreator(videos) {
  const groups = new Map();
  for (const v of videos) groups.set(v.creator_id, [...(groups.get(v.creator_id) || []), v]);
  return groups;
}

// ── View counts through connected accounts ──
// Videos with no connection, or not found in the connected account, are left out so the scraper can try them.

export async function oauthTiktok(env, videos) {
  const results = new Map();
  const h = hosts(env);
  for (const [creatorId, list] of byCreator(videos)) {
    let conn;
    try { conn = await connectionFor(env, creatorId, 'tiktok'); } catch (error) { for (const v of list) results.set(v.id, { error: error.message }); continue; }
    if (!conn) continue;
    for (let i = 0; i < list.length; i += 20) {
      const chunk = list.slice(i, i + 20);
      try {
        const data = await readApi(await fetch(`${h.tiktokApi}/video/query/?fields=id,view_count,like_count,comment_count,cover_image_url,video_description,create_time`, {
          method: 'POST', headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ filters: { video_ids: chunk.map(v => v.platform_video_id) } })
        }), 'TikTok video query');
        for (const v of chunk) {
          const item = (data.data?.videos || []).find(x => String(x.id) === v.platform_video_id);
          const views = count(item?.view_count);
          if (!item || views === null) continue;
          results.set(v.id, {
            ok: true, source: 'oauth', views, likes: count(item.like_count), comments: count(item.comment_count), raw: item,
            meta: {
              thumbnail_url: item.cover_image_url || null, caption: item.video_description || null,
              posted_at: item.create_time ? new Date(item.create_time * 1000).toISOString() : null, handles: [conn.platform_username].filter(Boolean)
            }
          });
        }
      } catch (error) {
        for (const v of chunk) results.set(v.id, { error: error.message });
      }
    }
  }
  return results;
}

export async function oauthInstagram(env, videos) {
  const results = new Map();
  const h = hosts(env);
  for (const [creatorId, list] of byCreator(videos)) {
    let conn;
    try { conn = await connectionFor(env, creatorId, 'instagram'); } catch (error) { for (const v of list) results.set(v.id, { error: error.message }); continue; }
    if (!conn) continue;
    try {
      // Their recent media (up to 300 posts), matched to our videos by shortcode.
      const media = [];
      let next = `${h.igGraph}/me/media?${new URLSearchParams({ fields: 'id,shortcode,permalink,like_count,comments_count,media_type,thumbnail_url,media_url,caption,timestamp', limit: '100', access_token: conn.token })}`;
      for (let page = 0; next && page < 3 && !list.every(v => media.some(m => m.shortcode === v.platform_video_id)); page++) {
        const data = await readApi(await fetch(next), 'Instagram media');
        media.push(...(data.data || []));
        next = data.paging?.next || null;
      }
      for (const v of list) {
        const m = media.find(x => x.shortcode === v.platform_video_id || String(x.permalink || '').includes(`/${v.platform_video_id}/`));
        if (!m) continue;
        try {
          const insights = await readApi(await fetch(`${h.igGraph}/${m.id}/insights?${new URLSearchParams({ metric: 'views', access_token: conn.token })}`), 'Instagram insights');
          const metric = (insights.data || []).find(x => x.name === 'views') || insights.data?.[0];
          const views = count(metric?.total_value?.value ?? metric?.values?.[0]?.value);
          if (views === null) continue;
          results.set(v.id, {
            ok: true, source: 'oauth', views, likes: count(m.like_count), comments: count(m.comments_count), raw: { media: m, insights },
            meta: { thumbnail_url: m.thumbnail_url || m.media_url || null, caption: m.caption || null, posted_at: m.timestamp || null, handles: [conn.platform_username].filter(Boolean) }
          });
        } catch (error) {
          results.set(v.id, { error: error.message });
        }
      }
    } catch (error) {
      for (const v of list) results.set(v.id, { error: error.message });
    }
  }
  return results;
}

