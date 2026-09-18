// TikTok and Instagram view counts through Apify (APIFY_TOKEN). One actor run per platform per cron tick,
// with every due video's link in it. Results follow the provider shape in affiliate-views.js.

const apifyBase = (env) => env.APIFY_API_URL || 'https://api.apify.com/v2';
const ACTORS = { tiktok: 'clockworks~tiktok-scraper', instagram: 'apify~instagram-scraper' };
const GONE = /not[\s_-]?found|private|unavailable|deleted|removed|restricted|doesn.?t exist/i;

async function runActor(env, actor, input) {
  const res = await fetch(`${apifyBase(env)}/acts/${actor}/run-sync-get-dataset-items?timeout=240&format=json`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.APIFY_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data)) throw new Error(`Apify ${res.status}: ${data?.error?.message || 'unexpected response'}`);
  return data;
}

const count = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));

// An item the scraper couldn't read: gone for good, or just a failed check.
function failure(item) {
  const reason = [item.error, item.errorDescription, item.errorCode].filter(Boolean).join(': ');
  return GONE.test(reason) ? { unavailable: true, reason: `Scraper: ${reason}` } : { error: `Scraper: ${reason || 'no data'}` };
}

export async function scrapeTiktok(env, videos) {
  const items = await runActor(env, ACTORS.tiktok, {
    postURLs: videos.map(v => v.canonical_url), resultsPerPage: 1,
    shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false
  });
  const results = new Map();
  for (const v of videos) {
    const item = items.find(it => String(it.id) === v.platform_video_id) || items.find(it => String(it.webVideoUrl || it.url || it.input || '').includes(v.platform_video_id));
    if (!item) { results.set(v.id, { error: 'Scraper returned nothing for this video.' }); continue; }
    if (item.error || item.errorCode) { results.set(v.id, failure(item)); continue; }
    const views = count(item.playCount);
    if (views === null) { results.set(v.id, { error: 'Scraper returned no view count.' }); continue; }
    results.set(v.id, {
      ok: true, source: 'scraper', views, likes: count(item.diggCount), comments: count(item.commentCount), raw: item,
      meta: {
        thumbnail_url: item.videoMeta?.coverUrl || null, caption: item.text || null,
        posted_at: item.createTimeISO || (item.createTime ? new Date(item.createTime * 1000).toISOString() : null),
        handles: [item.authorMeta?.name].filter(Boolean)
      }
    });
  }
  return results;
}

export async function scrapeInstagram(env, videos) {
  const items = await runActor(env, ACTORS.instagram, { directUrls: videos.map(v => v.canonical_url), resultsType: 'posts', resultsLimit: 1, addParentData: false });
  const results = new Map();
  for (const v of videos) {
    const item = items.find(it => it.shortCode === v.platform_video_id) || items.find(it => String(it.url || it.inputUrl || '').includes(v.platform_video_id));
    if (!item) { results.set(v.id, { error: 'Scraper returned nothing for this video.' }); continue; }
    if (item.error || item.errorCode) { results.set(v.id, failure(item)); continue; }
    // Instagram's public "views" on reels are plays.
    const views = count(item.videoPlayCount ?? item.videoViewCount);
    if (views === null) { results.set(v.id, { error: 'No view count. Is this post a video?' }); continue; }
    results.set(v.id, {
      ok: true, source: 'scraper', views, likes: count(item.likesCount), comments: count(item.commentsCount), raw: item,
      meta: { thumbnail_url: item.displayUrl || null, caption: item.caption || null, posted_at: item.timestamp || null, handles: [item.ownerUsername].filter(Boolean) }
    });
  }
  return results;
}
