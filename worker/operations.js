import { json, HttpError, clean, now, readJson, isEmail } from './lib.js';
import { requireUser, requireAdmin } from './auth.js';

const TYPES = ['marketing', 'sales', 'systems'];
const STATUSES = ['planning', 'active', 'paused', 'completed'];
const CRM_DOMAIN = 'edgeform-media.com';
// Subdomains we use ourselves, so a client CRM can't claim them.
const RESERVED_SLUGS = new Set(['www', 'crm', 'api', 'app', 'mail', 'admin', 'team', 'login', 'email', 'stripe', 'dev', 'staging']);
const VAR_FORMATS = ['number', 'money', 'percent'];
const FORMULA_FORMATS = ['number', 'money', 'percent', 'multiple', 'months'];
// Names the page fills in from creators and people, so a typed number can't use them.
const AUTO_KEYS = new Set(['views', 'hires', 'hireRevenue', 'hireFees', 'prospects', 'prospectRevenue', 'prospectFees', 'overrideRevenue', 'overrideIncome']);
const LIMITS = { vars: 40, formulas: 30, creators: 100, videos: 200, people: 200, overrides: 200 };

// Starting numbers and calculations for a new operation, by type.
const recruitVars = (percent) => [{ key: 'myPercent', label: 'I get', value: percent, format: 'percent' }];
const recruitFormulas = [
  { label: 'My cut /mo from hires', expr: 'hireRevenue * myPercent / 100', format: 'money' },
  { label: 'Brings in per hire /mo', expr: 'hireRevenue / hires', format: 'money' },
  { label: 'My extra cut /mo if prospects get hired', expr: 'prospectRevenue * myPercent / 100', format: 'money' }
];
// Added when a section is switched on (and its formulas removed when switched off).
const SECTION_PACKS = {
  recruiting_recurring: { vars: recruitVars(10), formulas: recruitFormulas },
  recruiting_one_time: {
    vars: [{ key: 'feePerHire', label: 'My fee per hire', value: 0, format: 'money' }],
    formulas: [
      { label: 'Earned from recruits (one-time)', expr: 'hireFees', format: 'money' },
      { label: 'Could earn if prospects get hired', expr: 'prospectFees', format: 'money' },
      { label: 'Average fee per hire', expr: 'hireFees / hires', format: 'money' }
    ]
  },
  overrides: {
    vars: [],
    formulas: [
      { label: 'My overrides /mo', expr: 'overrideIncome', format: 'money' },
      { label: 'Total I make /mo', expr: 'closed * avgJob * myPercent / 100 + overrideIncome', format: 'money', types: ['sales'] }
    ]
  }
};
const TEMPLATES = {
  marketing: {
    vars: [
      { key: 'x', label: 'Client revenue per 1K views', value: 0, format: 'money' },
      { key: 'cpmToCreators', label: 'Creator pay per 1K views (CPM)', value: 0, format: 'money' },
      { key: 'retainer', label: 'Our monthly fee', value: 0, format: 'money' }
    ],
    formulas: [
      { label: 'Client revenue from our work', expr: 'views / 1000 * x - (views / 1000 * cpmToCreators)', format: 'money' },
      { label: 'Paid to creators', expr: 'views / 1000 * cpmToCreators', format: 'money' },
      { label: 'Client return on our fee', expr: '(views / 1000 * x - views / 1000 * cpmToCreators) / retainer', format: 'multiple' }
    ]
  },
  sales: {
    vars: [
      { key: 'leads', label: 'Leads in CRM', value: 0, tracked: true },
      { key: 'closed', label: 'Deals closed', value: 0, tracked: true },
      { key: 'avgJob', label: 'Average job value', value: 0, format: 'money' },
      ...recruitVars(10)
    ],
    formulas: [
      { label: 'My commission /mo', expr: 'closed * avgJob * myPercent / 100', format: 'money' },
      { label: 'Revenue closed', expr: 'closed * avgJob', format: 'money' },
      { label: 'Close rate', expr: 'closed / leads * 100', format: 'percent' }
    ]
  },
  systems: {
    vars: [
      { key: 'callsBefore', label: 'Booked calls/mo before us', value: 0 },
      { key: 'calls', label: 'Booked calls/mo now', value: 0, tracked: true },
      { key: 'showRate', label: 'Show-up rate (0-1)', value: 0 },
      { key: 'ticket', label: 'Average ticket', value: 0, format: 'money' }
    ],
    formulas: [
      { label: 'Extra revenue per month', expr: '(calls - callsBefore) * showRate * ticket', format: 'money' }
    ]
  }
};

// Template plus the packs for whichever sections are on, without repeating a var key or formula.
function applyPacks(type, vars, formulas, fields) {
  vars = [...vars];
  formulas = [...formulas];
  const sections = {
    recruiting_recurring: fields.recruiting && fields.recruit_pay === 'recurring',
    recruiting_one_time: fields.recruiting && fields.recruit_pay === 'one_time',
    overrides: fields.overrides
  };
  for (const [name, pack] of Object.entries(SECTION_PACKS)) {
    const packFormulas = pack.formulas.filter(f => !f.types || f.types.includes(type));
    if (sections[name]) {
      for (const v of pack.vars) if (!vars.some(x => x.key === v.key)) vars.push(v);
      for (const f of packFormulas) if (!formulas.some(x => x.expr === f.expr)) formulas.push(f);
    } else {
      formulas = formulas.filter(f => !packFormulas.some(p => p.expr === f.expr));
    }
  }
  return { vars, formulas };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bool = (v) => (v ? 1 : 0);
const url = (v, label) => {
  const value = clean(v, 500);
  if (!/^https?:\/\/\S+$/i.test(value)) throw new HttpError(400, `${label} must be a full link starting with https://`);
  return value;
};

function normalizeSlug(value) {
  return clean(value, 80).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
}

// ── Validation ──

// `existing` is the stored row on update, so omitted fields keep their value.
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
  const driveUrl = clean(pick('driveUrl', existing.drive_url), 500);
  if (driveUrl) url(driveUrl, 'Google Drive link');

  let slug = type === 'marketing' ? '' : body.slug === undefined ? existing.slug || '' : normalizeSlug(body.slug);
  // Sales always runs through a CRM we build, so it always gets a subdomain.
  if (type === 'sales' && !slug) slug = normalizeSlug(name);
  if (slug && (slug.length < 2 || RESERVED_SLUGS.has(slug))) throw new HttpError(400, `"${slug}.${CRM_DOMAIN}" can't be used. Pick another CRM subdomain.`);

  // Recruiting and overrides are sections of sales / systems work only.
  const sectionFlag = (key, column, fallback) => type === 'marketing' ? 0 : bool(body[key] === undefined ? existing[column] ?? fallback : body[key]);

  return {
    type, name, status, slug: slug || null,
    recruiting: sectionFlag('recruiting', 'recruiting', 1),
    overrides: sectionFlag('overrides', 'overrides', 0),
    // Systems recruiting is paid per recruit; sales recruiting as a cut of what hires bring in.
    recruit_pay: ['recurring', 'one_time'].includes(body.recruitPay) ? body.recruitPay
      : existing.recruit_pay || (type === 'systems' ? 'one_time' : 'recurring'),
    client: clean(pick('client', existing.client), 120),
    contact_name: clean(pick('contactName', existing.contact_name), 120),
    contact_email: contactEmail,
    drive_url: driveUrl,
    start_date: startDate || null,
    notes: clean(pick('notes', existing.notes), 8000)
  };
}

function capped(list, name) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) throw new HttpError(400, `Expected a list of ${name}.`);
  if (list.length > LIMITS[name]) throw new HttpError(400, `At most ${LIMITS[name]} ${name}.`);
  return list;
}

function readVars(list) {
  const seen = new Set();
  return capped(list, 'vars')?.map(v => {
    const key = clean(v.key, 40);
    if (!/^[A-Za-z_]\w*$/.test(key)) throw new HttpError(400, `"${key}" isn't a valid name. Use letters and numbers, no spaces.`);
    if (AUTO_KEYS.has(key)) throw new HttpError(400, `"${key}" is filled in automatically. Pick another name.`);
    if (seen.has(key)) throw new HttpError(400, `Two numbers are named "${key}".`);
    seen.add(key);
    return {
      id: clean(v.id, 64), key, label: clean(v.label, 80) || key, value: num(v.value),
      format: VAR_FORMATS.includes(v.format) ? v.format : 'number', tracked: bool(v.tracked)
    };
  }) ?? null;
}

function readFormulas(list) {
  return capped(list, 'formulas')?.map(f => {
    const expr = clean(f.expr, 400);
    if (!/^[\w\s.+\-*/()]*$/.test(expr)) throw new HttpError(400, `Formula "${clean(f.label, 80)}" can only use numbers, names, + - * / ( ).`);
    return { id: clean(f.id, 64), label: clean(f.label, 80) || 'Untitled', expr, format: FORMULA_FORMATS.includes(f.format) ? f.format : 'money' };
  }) ?? null;
}

function readCreators(list) {
  const creators = capped(list, 'creators');
  if (!creators) return null;
  if (creators.reduce((n, c) => n + (Array.isArray(c.videos) ? c.videos.length : 0), 0) > LIMITS.videos) {
    throw new HttpError(400, `At most ${LIMITS.videos} videos per operation.`);
  }
  return creators.map(c => ({
    id: clean(c.id, 64), profile_url: url(c.profileUrl, 'Creator profile'),
    videos: (Array.isArray(c.videos) ? c.videos : []).map(v => ({
      id: clean(v.id, 64), url: url(v.url, 'Video link'), views: Math.max(0, Math.round(num(v.views))), views_confirmed: bool(v.viewsConfirmed)
    }))
  }));
}

function readPeople(list) {
  return capped(list, 'people')?.map(p => {
    const started = clean(p.started, 10);
    return {
      id: clean(p.id, 64), name: clean(p.name, 120) || 'Unnamed', role: clean(p.role, 80),
      stage: p.stage === 'hired' ? 'hired' : 'prospect',
      started: /^\d{4}-\d{2}-\d{2}$/.test(started) ? started : null, revenue: Math.max(0, num(p.revenue)), fee: Math.max(0, num(p.fee))
    };
  }) ?? null;
}

function readOverrides(list) {
  return capped(list, 'overrides')?.map(o => ({
    id: clean(o.id, 64), name: clean(o.name, 120) || 'Unnamed',
    revenue: Math.max(0, num(o.revenue)), percent: Math.min(100, Math.max(0, num(o.percent)))
  })) ?? null;
}

// ── Loading ──

async function loadOperations(env, where = '', binds = []) {
  const scope = `IN (SELECT id FROM operations o ${where})`;
  const [ops, vars, formulas, creators, videos, people, overrides] = await env.DB.batch([
    env.DB.prepare(`SELECT o.*, u.name owner_name FROM operations o LEFT JOIN users u ON u.id = o.owner_id ${where} ORDER BY o.updated_at DESC`).bind(...binds),
    env.DB.prepare(`SELECT * FROM operation_vars WHERE operation_id ${scope} ORDER BY sort`).bind(...binds),
    env.DB.prepare(`SELECT * FROM operation_formulas WHERE operation_id ${scope} ORDER BY sort`).bind(...binds),
    env.DB.prepare(`SELECT * FROM operation_creators WHERE operation_id ${scope} ORDER BY sort`).bind(...binds),
    env.DB.prepare(`SELECT v.*, c.operation_id FROM operation_videos v JOIN operation_creators c ON c.id = v.creator_id WHERE c.operation_id ${scope} ORDER BY v.sort`).bind(...binds),
    env.DB.prepare(`SELECT * FROM operation_people WHERE operation_id ${scope} ORDER BY sort`).bind(...binds),
    env.DB.prepare(`SELECT * FROM operation_overrides WHERE operation_id ${scope} ORDER BY sort`).bind(...binds)
  ]);
  const byOp = (rows) => rows.results.reduce((map, r) => map.set(r.operation_id, [...(map.get(r.operation_id) || []), r]), new Map());
  const [varMap, formulaMap, creatorMap, peopleMap, overrideMap] = [vars, formulas, creators, people, overrides].map(byOp);
  return ops.results.map(o => ({
    id: o.id, type: o.type, name: o.name, client: o.client,
    contactName: o.contact_name, contactEmail: o.contact_email, driveUrl: o.drive_url || '',
    status: o.status, slug: o.slug, crmUrl: o.slug ? `https://${o.slug}.${CRM_DOMAIN}` : '',
    startDate: o.start_date, notes: o.notes, recruiting: !!o.recruiting, overrides: !!o.overrides, recruitPay: o.recruit_pay,
    ownerId: o.owner_id, ownerName: o.owner_name || '',
    createdAt: o.created_at, updatedAt: o.updated_at,
    vars: (varMap.get(o.id) || []).map(v => ({ id: v.id, key: v.key, label: v.label, value: v.value, format: v.format, tracked: !!v.tracked, updatedAt: v.updated_at })),
    formulas: (formulaMap.get(o.id) || []).map(f => ({ id: f.id, label: f.label, expr: f.expr, format: f.format })),
    creators: (creatorMap.get(o.id) || []).map(c => ({
      id: c.id, profileUrl: c.profile_url,
      videos: videos.results.filter(v => v.creator_id === c.id)
        .map(v => ({ id: v.id, url: v.url, views: v.views, viewsConfirmed: !!v.views_confirmed, viewsUpdatedAt: v.views_updated_at }))
    })),
    people: (peopleMap.get(o.id) || []).map(p => ({ id: p.id, name: p.name, role: p.role, stage: p.stage, started: p.started, revenue: p.revenue, fee: p.fee })),
    overrideList: (overrideMap.get(o.id) || []).map(r => ({ id: r.id, name: r.name, revenue: r.revenue, percent: r.percent }))
  }));
}

async function getOperation(env, id) {
  const [op] = await loadOperations(env, 'WHERE o.id = ?', [id]);
  if (!op) throw new HttpError(404, 'Operation not found.');
  return op;
}

// ── Saving ──

// Rows keep their id when it matches a stored row of this operation; anything else is inserted,
// and stored rows missing from the list are deleted.
function syncStatements(env, user, operationId, data, previous) {
  const stamp = now();
  const statements = [];
  const known = (list, id) => (id && list.find(r => r.id === id)) || null;
  const removeMissing = (table, list, keep) => {
    for (const r of list) if (!keep.has(r.id)) statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(r.id));
  };

  if (data.vars) {
    // Delete first so a renamed key can be reused in the same save without tripping the unique index.
    const ids = data.vars.map(v => known(previous.vars, v.id)?.id).filter(Boolean);
    removeMissing('operation_vars', previous.vars, new Set(ids));
    data.vars.forEach((v, sort) => {
      const old = known(previous.vars, v.id);
      const id = old ? old.id : crypto.randomUUID();
      const changed = !old || old.value !== v.value;
      statements.push(old
        ? env.DB.prepare('UPDATE operation_vars SET key = ?, label = ?, value = ?, format = ?, tracked = ?, sort = ?, updated_at = ? WHERE id = ?')
          .bind(`~${sort}~${id}`, v.label, v.value, v.format, v.tracked, sort, changed ? stamp : old.updatedAt, id)
        : env.DB.prepare('INSERT INTO operation_vars (id, operation_id, key, label, value, format, tracked, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, operationId, `~${sort}~${id}`, v.label, v.value, v.format, v.tracked, sort, stamp));
      if (v.tracked && changed) {
        statements.push(env.DB.prepare('INSERT INTO operation_var_logs (id, var_id, value, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), id, v.value, user.id, stamp));
      }
      v.savedId = id;
    });
    // Real keys go on after every row has a temporary unique one, so swapping two names works.
    for (const v of data.vars) statements.push(env.DB.prepare('UPDATE operation_vars SET key = ? WHERE id = ?').bind(v.key, v.savedId));
  }

  if (data.formulas) {
    const keep = new Set();
    data.formulas.forEach((f, sort) => {
      const old = known(previous.formulas, f.id);
      const id = old ? old.id : crypto.randomUUID();
      keep.add(id);
      statements.push(old
        ? env.DB.prepare('UPDATE operation_formulas SET label = ?, expr = ?, format = ?, sort = ? WHERE id = ?').bind(f.label, f.expr, f.format, sort, id)
        : env.DB.prepare('INSERT INTO operation_formulas (id, operation_id, label, expr, format, sort) VALUES (?, ?, ?, ?, ?, ?)').bind(id, operationId, f.label, f.expr, f.format, sort));
    });
    removeMissing('operation_formulas', previous.formulas, keep);
  }

  if (data.creators) {
    const keepCreators = new Set();
    const keepVideos = new Set();
    const oldVideos = previous.creators.flatMap(c => c.videos);
    data.creators.forEach((c, sort) => {
      const old = known(previous.creators, c.id);
      const creatorId = old ? old.id : crypto.randomUUID();
      keepCreators.add(creatorId);
      statements.push(old
        ? env.DB.prepare('UPDATE operation_creators SET profile_url = ?, sort = ? WHERE id = ?').bind(c.profile_url, sort, creatorId)
        : env.DB.prepare('INSERT INTO operation_creators (id, operation_id, profile_url, sort, created_at) VALUES (?, ?, ?, ?, ?)').bind(creatorId, operationId, c.profile_url, sort, stamp));
      c.videos.forEach((v, vsort) => {
        const oldVideo = known(oldVideos, v.id);
        const id = oldVideo ? oldVideo.id : crypto.randomUUID();
        keepVideos.add(id);
        const viewsAt = !oldVideo || oldVideo.views !== v.views ? stamp : oldVideo.viewsUpdatedAt;
        statements.push(oldVideo
          ? env.DB.prepare('UPDATE operation_videos SET creator_id = ?, url = ?, views = ?, views_confirmed = ?, views_updated_at = ?, sort = ? WHERE id = ?')
            .bind(creatorId, v.url, v.views, v.views_confirmed, viewsAt, vsort, id)
          : env.DB.prepare('INSERT INTO operation_videos (id, creator_id, url, views, views_confirmed, views_updated_at, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, creatorId, v.url, v.views, v.views_confirmed, viewsAt, vsort, stamp));
      });
    });
    removeMissing('operation_videos', oldVideos, keepVideos);
    removeMissing('operation_creators', previous.creators, keepCreators);
  }

  if (data.people) {
    const keep = new Set();
    data.people.forEach((p, sort) => {
      const old = known(previous.people, p.id);
      const id = old ? old.id : crypto.randomUUID();
      keep.add(id);
      statements.push(old
        ? env.DB.prepare('UPDATE operation_people SET name = ?, role = ?, stage = ?, started = ?, revenue = ?, fee = ?, sort = ?, updated_at = ? WHERE id = ?')
          .bind(p.name, p.role, p.stage, p.started, p.revenue, p.fee, sort, stamp, id)
        : env.DB.prepare('INSERT INTO operation_people (id, operation_id, name, role, stage, started, revenue, fee, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, operationId, p.name, p.role, p.stage, p.started, p.revenue, p.fee, sort, stamp, stamp));
    });
    removeMissing('operation_people', previous.people, keep);
  }

  if (data.overrides) {
    const keep = new Set();
    data.overrides.forEach((r, sort) => {
      const old = known(previous.overrideList, r.id);
      const id = old ? old.id : crypto.randomUUID();
      keep.add(id);
      statements.push(old
        ? env.DB.prepare('UPDATE operation_overrides SET name = ?, revenue = ?, percent = ?, sort = ?, updated_at = ? WHERE id = ?')
          .bind(r.name, r.revenue, r.percent, sort, stamp, id)
        : env.DB.prepare('INSERT INTO operation_overrides (id, operation_id, name, revenue, percent, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, operationId, r.name, r.revenue, r.percent, sort, stamp, stamp));
    });
    removeMissing('operation_overrides', previous.overrideList, keep);
  }

  return statements;
}

const EMPTY = { vars: [], formulas: [], creators: [], people: [], overrideList: [] };
const slugTaken = (error) => /UNIQUE/i.test(error.message) && /slug/i.test(error.message);

async function runSave(env, statements, fields) {
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (slugTaken(error)) throw new HttpError(409, `${fields.slug}.${CRM_DOMAIN} is already used by another operation.`);
    throw error;
  }
}

async function listOperations(request, env, headers) {
  await requireUser(request, env);
  return json({ ok: true, domain: CRM_DOMAIN, operations: await loadOperations(env) }, 200, headers);
}

async function createOperation(request, env, headers) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const fields = readFields(body);
  const template = applyPacks(fields.type, TEMPLATES[fields.type].vars, TEMPLATES[fields.type].formulas, fields);
  const data = {
    vars: readVars(body.vars ?? template.vars),
    formulas: readFormulas(body.formulas ?? template.formulas),
    creators: readCreators(body.creators ?? []),
    people: readPeople(body.people ?? []),
    overrides: readOverrides(body.overrideList ?? [])
  };
  const id = crypto.randomUUID();
  const stamp = now();
  await runSave(env, [
    env.DB.prepare(`INSERT INTO operations (id, type, name, client, contact_name, contact_email, drive_url, status, slug, start_date, notes, recruiting, overrides, recruit_pay, owner_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, fields.type, fields.name, fields.client, fields.contact_name, fields.contact_email, fields.drive_url, fields.status, fields.slug,
        fields.start_date, fields.notes, fields.recruiting, fields.overrides, fields.recruit_pay, user.id, user.id, stamp, stamp),
    ...syncStatements(env, user, id, data, EMPTY)
  ], fields);
  return json({ ok: true, operation: await getOperation(env, id) }, 201, headers);
}

async function updateOperation(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const existing = await env.DB.prepare('SELECT * FROM operations WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Operation not found.');
  const body = await readJson(request);
  const fields = readFields(body, existing);
  const data = {
    vars: readVars(body.vars), formulas: readFormulas(body.formulas), creators: readCreators(body.creators),
    people: readPeople(body.people), overrides: readOverrides(body.overrideList)
  };
  const previous = await getOperation(env, id);
  // Switching a section on or off adds or removes its starter numbers and calculations.
  if (fields.recruiting !== existing.recruiting || fields.overrides !== existing.overrides || fields.recruit_pay !== existing.recruit_pay) {
    const packed = applyPacks(fields.type, readVars(data.vars ?? previous.vars), readFormulas(data.formulas ?? previous.formulas), fields);
    data.vars = packed.vars.map(v => ({ ...v, format: v.format || 'number', tracked: bool(v.tracked) }));
    data.formulas = packed.formulas;
  }
  await runSave(env, [
    env.DB.prepare(`UPDATE operations SET type = ?, name = ?, client = ?, contact_name = ?, contact_email = ?, drive_url = ?, status = ?, slug = ?, start_date = ?, notes = ?, recruiting = ?, overrides = ?, recruit_pay = ?, updated_at = ? WHERE id = ?`)
      .bind(fields.type, fields.name, fields.client, fields.contact_name, fields.contact_email, fields.drive_url, fields.status, fields.slug, fields.start_date, fields.notes, fields.recruiting, fields.overrides, fields.recruit_pay, now(), id),
    ...syncStatements(env, user, id, data, previous)
  ], fields);
  return json({ ok: true, operation: await getOperation(env, id) }, 200, headers);
}

async function deleteOperation(request, env, headers, [id]) {
  await requireAdmin(request, env);
  let result;
  try {
    result = await env.DB.prepare('DELETE FROM operations WHERE id = ?').bind(id).run();
  } catch (error) {
    if (/FOREIGN KEY/i.test(error.message)) throw new HttpError(409, 'A campaign in this operation has affiliate payouts on record, so it can’t be deleted.');
    throw error;
  }
  if (!result.meta.changes) throw new HttpError(404, 'Operation not found.');
  return json({ ok: true }, 200, headers);
}

export const operationRoutes = {
  'GET /api/operations': listOperations,
  'POST /api/operations': createOperation,
  'PATCH /api/operations/:id': updateOperation,
  'DELETE /api/operations/:id': deleteOperation
};
