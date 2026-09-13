import { json, HttpError, clean, readJson, isEmail } from './lib.js';
import { authRoutes, requireUser } from './auth.js';
import { pipelineRoutes } from './pipeline.js';
import { dialerRoutes } from './dialer.js';
import { sendEmail } from './email.js';

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

function mapSubmission(row) {
  let metadata = {};
  try { metadata = JSON.parse(row.metadata || '{}'); } catch {}
  return {
    ID: row.id,
    Timestamp: row.created_at,
    Name: row.name,
    Email: row.email,
    Phone: row.phone,
    Company: row.company,
    'Business Type': row.business_type,
    'Has Website': row.has_website,
    Description: row.description,
    Mode: row.input_mode,
    'Sketch URL': row.sketch_url,
    'Sketch Thumb URL': row.sketch_thumb_url,
    'Has Sketch': metadata.hasSketch === true,
    Status: row.status,
    Source: row.source
  };
}

async function createSubmission(request, env, headers) {
  const body = await readJson(request);
  if (!clean(body.name, 160)) return json({ ok: false, error: 'Name is required.' }, 400, headers);
  const id = crypto.randomUUID();
  const createdAt = clean(body.timestamp, 64) || new Date().toISOString();
  const status = body.complete ? 'complete' : body.autoSave ? 'partial' : clean(body.status, 32) || 'new';
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO submissions
      (id, created_at, updated_at, name, email, phone, company, business_type, has_website, description, input_mode, sketch_url, sketch_thumb_url, status, source, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, createdAt, createdAt, clean(body.name,160), clean(body.email,254), clean(body.phone,80), clean(body.company,200), clean(body.businessType,160), clean(body.hasWebsite,24), clean(body.websiteDescription || body.description,4000), clean(body.inputMode,32) || 'text', clean(body.sketchUrl,1000), clean(body.sketchThumbUrl,1000), status, clean(body.source,80) || 'website', JSON.stringify({ migratedFrom: body.migratedFrom || null, hasSketch: body.hasSketch === true })),
    env.DB.prepare(`INSERT INTO activities (id, created_at, actor, type, subject_type, subject_id, summary, metadata)
      VALUES (?, ?, 'system', 'submission.created', 'submission', ?, ?, '{}')`)
      .bind(crypto.randomUUID(), createdAt, id, `New submission from ${clean(body.name,160)}`)
  ]);
  return json({ ok: true, id, status }, 201, headers);
}

async function listSubmissions(request, env, headers) {
  await requireUser(request, env);
  const result = await env.DB.prepare('SELECT * FROM submissions ORDER BY created_at ASC LIMIT 500').all();
  return json({ ok: true, rows: result.results.map(mapSubmission), total: result.results.length }, 200, headers);
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

// Staff email from the dashboard composer. The sender address is derived from
// the signed-in user, never taken from the request.
async function composeEmail(request, env, headers) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const to = clean(body.to, 254);
  const subject = clean(body.subject, 300);
  const text = clean(body.body, 50000);
  if (!isEmail(to) || !subject || !text) throw new HttpError(400, 'Fill in To, Subject, and Message.');
  const parts = user.name.trim().toLowerCase().replace(/[^a-z\s-]/g, '').split(/\s+/).filter(Boolean);
  const handle = (parts.length >= 2 ? `${parts[0]}.${parts[parts.length - 1]}` : parts[0]) || 'team';
  const address = `${handle}@${env.MAIL_DOMAIN}`;
  const result = await sendEmail(env, { from: `${user.name} <${address}>`, to, subject, text, replyTo: address });
  return json({ ok: true, success: true, id: result.id }, 200, headers);
}

const routes = {
  'GET /api/health': (request, env, headers) => json({ ok: true, service: 'edgeform-crm-api' }, 200, headers),
  'POST /api/submissions': createSubmission,
  'GET /api/submissions': listSubmissions,
  'GET /api/dashboard': dashboard,
  'POST /api/email/send': composeEmail,
  ...authRoutes,
  ...pipelineRoutes,
  ...dialerRoutes
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
  }
};
