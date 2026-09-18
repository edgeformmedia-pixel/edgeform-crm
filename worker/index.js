import { json, HttpError } from './lib.js';
import { authRoutes, requireUser } from './auth.js';
import { userRoutes } from './users.js';
import { intakeRoutes } from './intake.js';
import { dialerRoutes } from './dialer.js';
import { mailRoutes, mailCron } from './mail.js';
import { operationRoutes } from './operations.js';
import { influencerLeadRoutes, discoveryCron } from './influencer-leads.js';
import { campaignRoutes } from './campaigns.js';
import { affiliateFetch, AFFILIATE_PREFIX } from './affiliate.js';

function cors(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim());
  return {
    'access-control-allow-origin': allowed.includes(origin) ? origin : allowed[0] || '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
}

async function dashboard(request, env, headers) {
  await requireUser(request, env);
  const [submissions, contacts, deals, activity] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) qualified FROM submissions"),
    env.DB.prepare("SELECT COUNT(*) total FROM contacts WHERE status='active'"),
    env.DB.prepare("SELECT COUNT(*) total, COALESCE(SUM(value_cents),0) value FROM deals WHERE stage NOT IN ('won','lost')"),
    env.DB.prepare('SELECT * FROM activities ORDER BY created_at DESC LIMIT 8')
  ]);
  return json({ ok: true, submissions: submissions.results[0], contacts: contacts.results[0], pipeline: deals.results[0], activity: activity.results }, 200, headers);
}

const routes = {
  'GET /api/health': (request, env, headers) => json({ ok: true, service: 'edgeform-crm-api' }, 200, headers),
  ...intakeRoutes,
  'GET /api/dashboard': dashboard,
  ...authRoutes,
  ...userRoutes,
  ...dialerRoutes,
  ...mailRoutes,
  ...operationRoutes,
  ...influencerLeadRoutes,
  ...campaignRoutes
};

const compiled = Object.entries(routes).map(([key, handler]) => {
  const [method, path] = key.split(' ');
  const pattern = new RegExp('^' + path.replace(/:[a-z]+/g, '([^/]+)') + '$');
  return { method, pattern, handler };
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    // The affiliate portal API has its own error shape ({ ok, error, code }).
    if (url.pathname === AFFILIATE_PREFIX || url.pathname.startsWith(AFFILIATE_PREFIX + '/')) return affiliateFetch(request, env, headers);
    try {
      for (const { method, pattern, handler } of compiled) {
        const match = request.method === method && url.pathname.match(pattern);
        if (match) return await handler(request, env, headers, match.slice(1).map(decodeURIComponent));
      }
      return json({ ok: false, error: 'Not found' }, 404, headers);
    } catch (error) {
      if (error instanceof HttpError) return json({ ok: false, success: false, error: error.message }, error.status, headers);
      console.error(error);
      return json({ ok: false, success: false, error: 'Internal error' }, 500, headers);
    }
  },

  // Every minute: scheduled sends, inbound mail sync, trash cleanup, and background creator discovery runs.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(mailCron(env));
    ctx.waitUntil(discoveryCron(env).catch(error => console.error('discovery cron failed', error?.message)));
  }
};
