import { HttpError } from './lib.js';
import { PORTAL_URL } from './affiliate-lib.js';

// TikTok / Instagram account connections. Not available until the platform apps exist (phase 5).

export const connectionsConfigured = () => false;

export async function connectionStart() {
  throw new HttpError(501, 'Connecting accounts isn’t available yet.', 'not_available');
}

export async function connectionCallback(request, env, headers) {
  return Response.redirect(`${PORTAL_URL}/settings.html?error=not_available`, 302);
}
