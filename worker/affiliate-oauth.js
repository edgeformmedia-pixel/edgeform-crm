import { HttpError } from './lib.js';
import { PORTAL_URL } from './affiliate-lib.js';

// TikTok / Instagram account connections. Not available until the platform apps exist (phase 5).

export const connectionsConfigured = () => false;

// View providers for TikTok and Instagram (OAuth or Apify). Until they exist, videos wait and lock on manual views.
const skipAll = (videos) => new Map(videos.map(v => [v.id, { skip: true }]));
export const tiktokProvider = async (env, videos) => skipAll(videos);
export const instagramProvider = async (env, videos) => skipAll(videos);

export async function connectionStart() {
  throw new HttpError(501, 'Connecting accounts isn’t available yet.', 'not_available');
}

export async function connectionCallback(request, env, headers) {
  return Response.redirect(`${PORTAL_URL}/settings.html?error=not_available`, 302);
}
