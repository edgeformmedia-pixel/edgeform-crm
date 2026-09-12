const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});

function cors(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim());
  return {
    'access-control-allow-origin': allowed.includes(origin) ? origin : allowed[0] || '*',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
}

async function authorized(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  try {
    const payload = encodeURIComponent(JSON.stringify({ action: 'verifySession', token }));
    const response = await fetch(`${env.AUTH_SERVICE_URL}?payload=${payload}`);
    const result = await response.json();
    return result?.ok === true;
  } catch { return false; }
}

const clean = (value, max = 4000) => String(value ?? '').trim().slice(0, max);

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
  const body = await request.json().catch(() => null);
  if (!body || !clean(body.name, 160)) return json({ ok: false, error: 'Name is required.' }, 400, headers);
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
  if (!await authorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401, headers);
  const result = await env.DB.prepare('SELECT * FROM submissions ORDER BY created_at ASC LIMIT 500').all();
  return json({ ok: true, rows: result.results.map(mapSubmission), total: result.results.length }, 200, headers);
}

async function dashboard(request, env, headers) {
  if (!await authorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401, headers);
  const [submissions, contacts, deals, activity] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) qualified FROM submissions"),
    env.DB.prepare("SELECT COUNT(*) total FROM contacts WHERE status='active'"),
    env.DB.prepare("SELECT COUNT(*) total, COALESCE(SUM(value_cents),0) value FROM deals WHERE stage NOT IN ('won','lost')"),
    env.DB.prepare('SELECT * FROM activities ORDER BY created_at DESC LIMIT 8')
  ]);
  return json({ ok: true, submissions: submissions.results[0], contacts: contacts.results[0], pipeline: deals.results[0], activity: activity.results }, 200, headers);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      if (url.pathname === '/api/health') return json({ ok: true, service: 'edgeform-crm-api' }, 200, headers);
      if (url.pathname === '/api/submissions' && request.method === 'POST') return createSubmission(request, env, headers);
      if (url.pathname === '/api/submissions' && request.method === 'GET') return listSubmissions(request, env, headers);
      if (url.pathname === '/api/dashboard' && request.method === 'GET') return dashboard(request, env, headers);
      return json({ ok: false, error: 'Not found' }, 404, headers);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: 'Internal error' }, 500, headers);
    }
  }
};
