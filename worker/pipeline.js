import { json, HttpError, clean, now, readJson } from './lib.js';
import { requireUser } from './auth.js';
import { sendEmail, buildIcs } from './email.js';

const STAGES = ['New Lead', 'Contacted', 'Interested', 'Appt Set', 'Presented', 'Closed ✅', 'Not Interested ❌'];
const MAX_BATCH = 1000;

const dedupeKey = (name, address) => `${name || ''}${address || ''}`.toLowerCase().replace(/\s/g, '');
const yesNo = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  return ['true', 'yes', 'y', '1'].includes(s) ? 'Yes' : 'No';
};

// Keys match the header aliases the pipeline page already understands.
function toSheetRow(l) {
  return {
    ID: l.id, Name: l.name, Category: l.category, Address: l.address, City: l.city, State: l.state,
    Phone: l.phone, Email: l.email, Rating: l.rating, Reviews: l.review_count,
    'Has Website': l.has_website, Website: l.website, 'Maps URL': l.maps_url,
    'Google Search URL': l.search_url, 'Website Type': l.website_type,
    Stage: l.stage, Notes: l.notes, 'Scan Query': l.scan_query,
    'Saved At': l.created_at, 'Last Updated': l.updated_at
  };
}

const IMPORT_ALIASES = {
  name: ['name', 'business name', 'company name', 'lead name', 'contact name', 'full name', 'client'],
  category: ['category', 'type', 'business type', 'industry', 'service', 'niche'],
  address: ['address', 'street address', 'street', 'location', 'full address'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'province', 'region', 'st'],
  phone: ['phone', 'phone number', 'telephone', 'tel', 'mobile', 'cell', 'contact phone'],
  email: ['email', 'email address', 'e-mail', 'contact email'],
  rating: ['rating', 'stars', 'google rating', 'avg rating'],
  reviewCount: ['reviews', 'review count', 'reviewcount', 'num reviews', 'total reviews'],
  hasWebsite: ['has website', 'haswebsite', 'website?', 'has_website', 'has site'],
  website: ['website', 'website url', 'web', 'url', 'site', 'homepage'],
  mapsUrl: ['maps url', 'mapsurl', 'google maps', 'maps link', 'map url', 'map link', 'maps'],
  googleSearchUrl: ['google search url', 'search url', 'searchurl', 'google search'],
  websiteType: ['website type', 'websitetype', 'site type'],
  stage: ['stage', 'status', 'pipeline stage', 'lead stage', 'disposition'],
  notes: ['notes', 'note', 'comments', 'comment', 'memo'],
  scanQuery: ['scan query', 'scanquery', 'search query', 'query'],
  scannedAt: ['scanned at', 'scannedat', 'scan date', 'saved at', 'savedat', 'created at', 'date added']
};

function fromSheetRow(row) {
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const out = {};
  for (const [key, aliases] of Object.entries(IMPORT_ALIASES)) {
    const hit = aliases.find(a => lower[a] !== undefined && String(lower[a]).trim() !== '');
    if (hit) out[key] = lower[hit];
  }
  return out;
}

function normalizeLead(raw, source) {
  const name = clean(raw.name, 200);
  if (!name) return null;
  const address = clean(raw.address, 300);
  const stage = STAGES.includes(clean(raw.stage, 40)) ? clean(raw.stage, 40) : '';
  return {
    key: dedupeKey(name, address), name, address, source,
    category: clean(raw.category, 120), city: clean(raw.city, 120), state: clean(raw.state, 40),
    phone: clean(raw.phone, 60), email: clean(raw.email, 254),
    rating: clean(raw.rating, 10), reviewCount: clean(raw.reviewCount, 12),
    hasWebsite: yesNo(raw.hasWebsite), website: clean(raw.website, 1000),
    mapsUrl: clean(raw.mapsUrl, 1500), searchUrl: clean(raw.googleSearchUrl, 1000),
    websiteType: clean(raw.websiteType, 60), stage, notes: clean(raw.notes, 4000),
    scanQuery: clean(raw.scanQuery, 300), scannedAt: clean(raw.scannedAt, 64)
  };
}

async function upsertLeads(env, ownerId, leads) {
  if (leads.length > MAX_BATCH) throw new HttpError(413, `Send at most ${MAX_BATCH} leads per request.`);
  const unique = [...new Map(leads.filter(Boolean).map(l => [l.key, l])).values()];
  let added = 0, updated = 0;
  const ts = now();
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const existing = await env.DB.prepare(`SELECT dedupe_key FROM leads WHERE owner_id = ? AND dedupe_key IN (${placeholders})`)
      .bind(ownerId, ...chunk.map(l => l.key)).all();
    const known = new Set(existing.results.map(r => r.dedupe_key));
    added += chunk.filter(l => !known.has(l.key)).length;
    updated += chunk.filter(l => known.has(l.key)).length;
    // Re-scans refresh scraped fields but never clobber stage/notes a caller already set.
    await env.DB.batch(chunk.map(l => env.DB.prepare(
      `INSERT INTO leads (id, owner_id, created_at, updated_at, dedupe_key, name, category, address, city, state, phone, email,
         rating, review_count, has_website, website, maps_url, search_url, website_type, stage, notes, scan_query, scanned_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, dedupe_key) DO UPDATE SET
         updated_at = excluded.updated_at,
         category = COALESCE(NULLIF(excluded.category, ''), leads.category),
         city = COALESCE(NULLIF(excluded.city, ''), leads.city),
         state = COALESCE(NULLIF(excluded.state, ''), leads.state),
         phone = COALESCE(NULLIF(excluded.phone, ''), leads.phone),
         email = COALESCE(NULLIF(excluded.email, ''), leads.email),
         rating = COALESCE(NULLIF(excluded.rating, ''), leads.rating),
         review_count = COALESCE(NULLIF(excluded.review_count, ''), leads.review_count),
         has_website = COALESCE(NULLIF(excluded.has_website, ''), leads.has_website),
         website = COALESCE(NULLIF(excluded.website, ''), leads.website),
         maps_url = COALESCE(NULLIF(excluded.maps_url, ''), leads.maps_url),
         search_url = COALESCE(NULLIF(excluded.search_url, ''), leads.search_url),
         website_type = COALESCE(NULLIF(excluded.website_type, ''), leads.website_type),
         scan_query = COALESCE(NULLIF(excluded.scan_query, ''), leads.scan_query)`
    ).bind(
      crypto.randomUUID(), ownerId, ts, ts, l.key, l.name, l.category, l.address, l.city, l.state, l.phone, l.email,
      l.rating, l.reviewCount, l.hasWebsite, l.website, l.mapsUrl, l.searchUrl, l.websiteType,
      l.stage || 'New Lead', l.notes, l.scanQuery, l.scannedAt || ts, l.source
    )));
  }
  return { added, updated };
}

async function listLeads(request, env, headers) {
  const user = await requireUser(request, env);
  const all = new URL(request.url).searchParams.get('scope') === 'all' && user.role === 'admin';
  const result = all
    ? await env.DB.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 5000').all()
    : await env.DB.prepare('SELECT * FROM leads WHERE owner_id = ? ORDER BY created_at DESC LIMIT 5000').bind(user.id).all();
  return json({ ok: true, success: true, leads: result.results.map(toSheetRow) }, 200, headers);
}

async function updateLead(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const sets = [], values = [];
  if (body.stage !== undefined) {
    if (!STAGES.includes(body.stage)) throw new HttpError(400, 'Unknown stage.');
    sets.push('stage = ?'); values.push(body.stage);
  }
  if (body.notes !== undefined) { sets.push('notes = ?'); values.push(clean(body.notes, 4000)); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  const ownerClause = user.role === 'admin' ? '' : ' AND owner_id = ?';
  const result = await env.DB.prepare(`UPDATE leads SET ${sets.join(', ')}, updated_at = ? WHERE id = ?${ownerClause}`)
    .bind(...values, now(), id, ...(ownerClause ? [user.id] : [])).run();
  if (!result.meta.changes) throw new HttpError(404, 'Lead not found.');
  return json({ ok: true }, 200, headers);
}

async function importLeads(request, env, headers) {
  const user = await requireUser(request, env);
  const { rows } = await readJson(request);
  if (!Array.isArray(rows)) throw new HttpError(400, 'Expected { rows: [...] }.');
  const leads = rows.map(r => normalizeLead(fromSheetRow(r || {}), 'import'));
  const result = await upsertLeads(env, user.id, leads);
  return json({ ok: true, ...result, skipped: leads.filter(l => !l).length }, 200, headers);
}

// LeadHunter userscript endpoint. The per-user key in the URL is the credential,
// so the Tampermonkey script needs no login.
async function leadHunterSync(request, env, headers, [key]) {
  const user = await env.DB.prepare('SELECT id FROM users WHERE lead_key = ? AND verified = 1').bind(key).first();
  if (!user) return json({ success: false, error: 'Invalid LeadHunter link. Copy a fresh script from the CRM.' }, 401, headers);
  const body = await readJson(request);
  if (body.action && body.action !== 'syncLeads') throw new HttpError(400, 'Unsupported action.');
  if (!Array.isArray(body.leads)) throw new HttpError(400, 'Expected { leads: [...] }.');
  const result = await upsertLeads(env, user.id, body.leads.map(l => normalizeLead(l || {}, 'leadhunter')));
  return json({ success: true, ...result }, 200, headers);
}

async function logCall(request, env, headers) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const result = clean(body.result, 60);
  if (!result) throw new HttpError(400, 'Call result is required.');
  await env.DB.prepare(
    `INSERT INTO call_logs (id, created_at, user_id, lead_id, lead_name, phone, result, agent, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), now(), user.id, clean(body.leadId, 64) || null, clean(body.leadName, 200),
    clean(body.phone, 60), result, clean(body.agent, 120) || user.name, clean(body.source, 40) || 'pipeline').run();
  return json({ ok: true }, 201, headers);
}

const toAppt = (a) => ({
  id: a.id, leadId: a.lead_id, leadName: a.lead_name, company: a.company, phone: a.phone, email: a.email,
  mapsUrl: a.maps_url, address: a.address, booker: a.booker, datetime: a.starts_at,
  duration: a.duration_min, notes: a.notes, status: a.status, createdAt: a.created_at
});

async function listAppointments(request, env, headers) {
  const user = await requireUser(request, env);
  const result = await env.DB.prepare(
    `SELECT * FROM appointments WHERE ${user.role === 'admin' ? '1 = 1' : 'user_id = ?'} ORDER BY starts_at LIMIT 2000`
  ).bind(...(user.role === 'admin' ? [] : [user.id])).all();
  return json({ ok: true, appointments: result.results.map(toAppt) }, 200, headers);
}

async function createAppointment(request, env, headers) {
  const user = await requireUser(request, env);
  const b = await readJson(request);
  const leadName = clean(b.leadName, 200);
  const datetime = clean(b.datetime, 40);
  const start = new Date(b.startsAt || datetime);
  if (!leadName) throw new HttpError(400, 'Lead name is required.');
  if (isNaN(start)) throw new HttpError(400, 'Pick a valid date and time.');
  const duration = Math.min(Math.max(parseInt(b.duration, 10) || 30, 5), 480);
  const appt = {
    id: crypto.randomUUID(), created_at: now(), user_id: user.id, lead_id: clean(b.leadId, 64) || null,
    lead_name: leadName, company: clean(b.company, 200), phone: clean(b.phone, 60), email: clean(b.email, 254),
    maps_url: clean(b.mapsUrl, 1500), address: clean(b.address, 300), booker: clean(b.booker, 120) || user.name,
    // Keep the wall-clock string the caller picked so the calendar renders it as entered.
    starts_at: datetime || start.toISOString(), duration_min: duration, notes: clean(b.notes, 4000), status: 'booked'
  };
  const stmts = [env.DB.prepare(
    `INSERT INTO appointments (id, created_at, user_id, lead_id, lead_name, company, phone, email, maps_url, address, booker, starts_at, duration_min, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(...Object.values(appt))];
  if (appt.lead_id) {
    stmts.push(env.DB.prepare(`UPDATE leads SET stage = 'Appt Set', updated_at = ? WHERE id = ? AND (owner_id = ? OR ? = 'admin')`)
      .bind(now(), appt.lead_id, user.id, user.role));
  }
  await env.DB.batch(stmts);

  // Calendar invite to the person who booked it (replaces the Google Calendar event).
  let invited = false;
  try {
    const details = [
      `Lead: ${appt.lead_name}`, appt.company && `Company: ${appt.company}`, appt.phone && `Phone: ${appt.phone}`,
      appt.email && `Email: ${appt.email}`, appt.maps_url && `Maps: ${appt.maps_url}`, appt.notes && `Notes: ${appt.notes}`,
      `Booked by: ${appt.booker}`
    ].filter(Boolean).join('\n');
    await sendEmail(env, {
      to: user.email,
      subject: `Appointment booked: ${appt.lead_name} — ${start.toLocaleString('en-US', { timeZone: env.TIMEZONE || 'America/Detroit', dateStyle: 'medium', timeStyle: 'short' })}`,
      text: `${details}\n\nThe attached invite adds this to your calendar.`,
      attachments: env.RESEND_API_KEY ? [{
        filename: 'appointment.ics',
        content: buildIcs({ uid: appt.id, start, durationMin: duration, summary: `Meeting: ${appt.lead_name}`, description: details, location: appt.address })
      }] : undefined
    });
    invited = true;
  } catch (error) { console.error('invite failed', error); }

  return json({ ok: true, success: true, apptId: appt.id, invited, appointment: toAppt(appt) }, 201, headers);
}

export const pipelineRoutes = {
  'GET /api/leads': listLeads,
  'PATCH /api/leads/:id': updateLead,
  'POST /api/leads/import': importLeads,
  'POST /api/leadhunter/:key': leadHunterSync,
  'POST /api/calls': logCall,
  'GET /api/appointments': listAppointments,
  'POST /api/appointments': createAppointment
};
