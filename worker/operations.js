import { json, HttpError, clean, now, readJson, isEmail } from './lib.js';
import { requireUser, requireAdmin } from './auth.js';

const TYPES = ['marketing', 'sales', 'systems'];
const STATUSES = ['planning', 'active', 'paused', 'completed'];
const CRM_DOMAIN = 'edgeform-media.com';
// Subdomains we use ourselves, so a client CRM can't claim them.
const RESERVED_SLUGS = new Set(['www', 'crm', 'api', 'app', 'mail', 'admin', 'team', 'login', 'email', 'stripe', 'dev', 'staging']);
const MAX_METRICS = 20;

const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

function normalizeSlug(value) {
  return clean(value, 80).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
}

function publicOperation(op, metrics) {
  return {
    id: op.id, type: op.type, name: op.name, client: op.client,
    contactName: op.contact_name, contactEmail: op.contact_email,
    status: op.status, slug: op.slug, crmUrl: op.slug ? `https://${op.slug}.${CRM_DOMAIN}` : '',
    startDate: op.start_date, notes: op.notes,
    ownerId: op.owner_id, ownerName: op.owner_name || '',
    createdAt: op.created_at, updatedAt: op.updated_at,
    metrics: metrics.map(m => ({ id: m.id, label: m.label, unit: m.unit, baseline: m.baseline, current: m.current, goal: m.goal, updatedAt: m.updated_at }))
  };
}

// Validates the editable fields. `existing` is the stored row on update, so omitted fields keep their value.
function readFields(body, existing = {}) {
  const pick = (key, fallback) => (body[key] === undefined ? fallback : body[key]);
  const type = pick('type', existing.type);
  if (!TYPES.includes(type)) throw new HttpError(400, 'Pick Marketing, Sales, or Systems.');
  const name = clean(pick('name', existing.name), 120);
  if (!name) throw new HttpError(400, 'Operation name is required.');
  const status = pick('status', existing.status || 'active');
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Invalid status.');
  const contactEmail = clean(pick('contactEmail', existing.contact_email), 254).toLowerCase();
  if (contactEmail && !isEmail(contactEmail)) throw new HttpError(400, 'Enter a valid contact email.');
  const startDate = clean(pick('startDate', existing.start_date), 10);
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new HttpError(400, 'Invalid start date.');

  let slug = type === 'marketing' ? '' : body.slug === undefined ? existing.slug || '' : normalizeSlug(body.slug);
  // Sales always runs through a CRM we build, so it always gets a subdomain.
  if (type === 'sales' && !slug) slug = normalizeSlug(name);
  if (slug && (slug.length < 2 || RESERVED_SLUGS.has(slug))) throw new HttpError(400, `"${slug}.${CRM_DOMAIN}" can't be used. Pick another CRM subdomain.`);

  return {
    type, name, status, slug: slug || null,
    client: clean(pick('client', existing.client), 120),
    contact_name: clean(pick('contactName', existing.contact_name), 120),
    contact_email: contactEmail,
    start_date: startDate || null,
    notes: clean(pick('notes', existing.notes), 8000)
  };
}

function readMetrics(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, MAX_METRICS)
    .map(m => ({ id: clean(m.id, 64), label: clean(m.label, 80), unit: clean(m.unit, 12), baseline: num(m.baseline), current: num(m.current), goal: num(m.goal) }))
    .filter(m => m.label);
}

async function loadOperations(env, where = '', binds = []) {
  const ops = await env.DB.prepare(
    `SELECT o.*, u.name owner_name FROM operations o LEFT JOIN users u ON u.id = o.owner_id ${where} ORDER BY o.updated_at DESC`
  ).bind(...binds).all();
  if (!ops.results.length) return [];
  const ids = ops.results.map(o => o.id);
  const metrics = await env.DB.prepare(
    `SELECT * FROM operation_metrics WHERE operation_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort`
  ).bind(...ids).all();
  return ops.results.map(o => publicOperation(o, metrics.results.filter(m => m.operation_id === o.id)));
}

async function getOperation(env, id) {
  const [op] = await loadOperations(env, 'WHERE o.id = ?', [id]);
  if (!op) throw new HttpError(404, 'Operation not found.');
  return op;
}

// Inserts, updates, and removes metrics to match `metrics`, logging every change to a current value.
function syncMetricStatements(env, user, operationId, metrics, previous = []) {
  const stamp = now();
  const before = new Map(previous.map(m => [m.id, m]));
  const keep = new Set();
  const statements = [];
  metrics.forEach((m, sort) => {
    const old = m.id && before.get(m.id);
    const id = old ? m.id : crypto.randomUUID();
    keep.add(id);
    if (old) {
      statements.push(env.DB.prepare('UPDATE operation_metrics SET label = ?, unit = ?, baseline = ?, current = ?, goal = ?, sort = ?, updated_at = ? WHERE id = ?')
        .bind(m.label, m.unit, m.baseline, m.current, m.goal, sort, old.current === m.current ? old.updatedAt : stamp, id));
    } else {
      statements.push(env.DB.prepare('INSERT INTO operation_metrics (id, operation_id, label, unit, baseline, current, goal, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, operationId, m.label, m.unit, m.baseline, m.current, m.goal, sort, stamp));
    }
    if (m.current !== null && (!old || old.current !== m.current)) {
      statements.push(env.DB.prepare('INSERT INTO operation_metric_logs (id, metric_id, value, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), id, m.current, user.id, stamp));
    }
  });
  for (const m of previous) {
    if (!keep.has(m.id)) statements.push(env.DB.prepare('DELETE FROM operation_metrics WHERE id = ?').bind(m.id));
  }
  return statements;
}

const slugTaken = (error) => /UNIQUE/i.test(error.message);

async function listOperations(request, env, headers) {
  await requireUser(request, env);
  return json({ ok: true, domain: CRM_DOMAIN, operations: await loadOperations(env) }, 200, headers);
}

async function createOperation(request, env, headers) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const fields = readFields(body);
  const metrics = readMetrics(body.metrics) || [];
  const id = crypto.randomUUID();
  const stamp = now();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO operations (id, type, name, client, contact_name, contact_email, status, slug, start_date, notes, owner_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, fields.type, fields.name, fields.client, fields.contact_name, fields.contact_email, fields.status, fields.slug,
          fields.start_date, fields.notes, user.id, user.id, stamp, stamp),
      ...syncMetricStatements(env, user, id, metrics)
    ]);
  } catch (error) {
    if (slugTaken(error)) throw new HttpError(409, `${fields.slug}.${CRM_DOMAIN} is already used by another operation.`);
    throw error;
  }
  return json({ ok: true, operation: await getOperation(env, id) }, 201, headers);
}

async function updateOperation(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const existing = await env.DB.prepare('SELECT * FROM operations WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Operation not found.');
  const body = await readJson(request);
  const fields = readFields(body, existing);
  const metrics = readMetrics(body.metrics);
  const statements = [
    env.DB.prepare(`UPDATE operations SET type = ?, name = ?, client = ?, contact_name = ?, contact_email = ?, status = ?, slug = ?, start_date = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .bind(fields.type, fields.name, fields.client, fields.contact_name, fields.contact_email, fields.status, fields.slug, fields.start_date, fields.notes, now(), id)
  ];
  if (metrics) statements.push(...syncMetricStatements(env, user, id, metrics, (await getOperation(env, id)).metrics));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (slugTaken(error)) throw new HttpError(409, `${fields.slug}.${CRM_DOMAIN} is already used by another operation.`);
    throw error;
  }
  return json({ ok: true, operation: await getOperation(env, id) }, 200, headers);
}

async function deleteOperation(request, env, headers, [id]) {
  await requireAdmin(request, env);
  const result = await env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Operation not found.');
  return json({ ok: true }, 200, headers);
}

export const operationRoutes = {
  'GET /api/operations': listOperations,
  'POST /api/operations': createOperation,
  'PATCH /api/operations/:id': updateOperation,
  'DELETE /api/operations/:id': deleteOperation
};
