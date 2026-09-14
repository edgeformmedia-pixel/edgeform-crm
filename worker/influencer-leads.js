import { json, HttpError, clean, now, readJson, sha256, isEmail } from './lib.js';
import { requireUser } from './auth.js';

const STATUSES = new Set(['New', 'Ready to Review', 'Shortlisted', 'Contacted', 'Replied', 'Not a Fit', 'Archived']);
const CONFIDENCE = new Set(['low', 'medium', 'high']);
const RECOMMENDATIONS = new Set(['shortlist', 'review', 'pass']);
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_ROWS = 500;
const MAX_BATCH = 20;
const RECENT_ANALYSIS_MS = 7 * 86400000;

const LEAD_FIELDS = {
  handle: 'handle', profileUrl: 'profile_url', name: 'name', email: 'email', niche: 'niche', location: 'location',
  followerCount: 'follower_count', averageViews: 'average_views', engagementRate: 'engagement_rate', bio: 'bio',
  recentPostNotes: 'recent_post_notes', source: 'source', notes: 'notes', tags: 'tags', status: 'status'
};

const PROFILE_FIELDS = {
  brandProduct: 'brand_product', targetCustomer: 'target_customer', desiredNiches: 'desired_niches',
  desiredLocations: 'desired_locations', followerMin: 'follower_min', followerMax: 'follower_max',
  contentStyle: 'content_style', dealType: 'deal_type', exclusions: 'exclusions'
};

const ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    fit_score: { type: 'integer', minimum: 0, maximum: 100 },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    recommendation: { type: 'string', enum: ['shortlist', 'review', 'pass'] },
    strengths: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    concise_reason: { type: 'string' },
    missing_information: { type: 'array', items: { type: 'string' } }
  },
  required: ['fit_score', 'confidence', 'recommendation', 'strengths', 'concerns', 'concise_reason', 'missing_information']
};

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function intOrNull(value, label) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(String(value).replace(/[,_\s]/g, ''));
  if (!Number.isInteger(number) || number < 0) throw new HttpError(400, `${label} must be a non-negative whole number.`);
  return number;
}

function rateOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(String(value).replace('%', '').trim());
  if (!Number.isFinite(number) || number < 0 || number > 100) throw new HttpError(400, 'Engagement rate must be between 0 and 100.');
  return number;
}

function normalizeHandle(value) {
  let handle = clean(value, 200).toLowerCase();
  if (/instagram\.com/i.test(handle)) {
    try {
      const url = new URL(/^https?:\/\//.test(handle) ? handle : `https://${handle}`);
      if (!/(^|\.)instagram\.com$/.test(url.hostname.toLowerCase())) return '';
      handle = url.pathname.split('/').filter(Boolean)[0] || '';
    } catch { return ''; }
  }
  handle = handle.replace(/^@/, '').split(/[/?#]/)[0];
  return /^[a-z0-9._]{1,30}$/.test(handle) ? handle : '';
}

function normalizeProfileUrl(value, handle) {
  const supplied = clean(value, 500);
  if (supplied) {
    try {
      const url = new URL(/^https?:\/\//i.test(supplied) ? supplied : `https://${supplied}`);
      if (!/(^|\.)instagram\.com$/i.test(url.hostname)) throw new Error();
      const fromUrl = normalizeHandle(url.href);
      if (!fromUrl) throw new Error();
      return `https://www.instagram.com/${fromUrl}/`;
    } catch { throw new HttpError(400, 'Profile URL must be a valid Instagram profile URL.'); }
  }
  return handle ? `https://www.instagram.com/${handle}/` : '';
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[|;,]/);
  return [...new Set(list.map(v => clean(v, 40)).filter(Boolean))].slice(0, 20);
}

function normalizeLead(input, partial = false) {
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const text = (key, max) => { if (!partial || has(key)) out[key] = clean(input[key], max); };
  text('name', 160); text('email', 254); text('niche', 160); text('location', 160); text('bio', 3000);
  text('recentPostNotes', 3000); text('source', 160); text('notes', 4000);
  if (!partial || has('handle') || has('profileUrl')) {
    const enteredHandle = normalizeHandle(input.handle);
    const urlHandle = normalizeHandle(input.profileUrl);
    if (enteredHandle && urlHandle && enteredHandle !== urlHandle) throw new HttpError(400, 'Instagram handle and profile URL must identify the same account.');
    const handle = enteredHandle || urlHandle;
    const profileUrl = normalizeProfileUrl(input.profileUrl, handle);
    if (!partial && !handle && !profileUrl) throw new HttpError(400, 'Add an Instagram handle or profile URL.');
    if (has('handle') || !partial) out.handle = handle;
    if (has('profileUrl') || has('handle') || !partial) out.profileUrl = profileUrl;
  }
  if (!partial || has('followerCount')) out.followerCount = intOrNull(input.followerCount, 'Follower count');
  if (!partial || has('averageViews')) out.averageViews = intOrNull(input.averageViews, 'Average views');
  if (!partial || has('engagementRate')) out.engagementRate = rateOrNull(input.engagementRate);
  if (!partial || has('tags')) out.tags = cleanTags(input.tags);
  if (!partial || has('status')) {
    const status = clean(input.status || 'New', 40);
    if (!STATUSES.has(status)) throw new HttpError(400, 'Invalid lead status.');
    out.status = status;
  }
  if (out.email && !isEmail(out.email)) throw new HttpError(400, 'Email must be valid or blank.');
  return out;
}

export function leadIdentity(input) {
  const normalized = normalizeLead(input);
  return normalized.handle || normalized.profileUrl;
}

function normalizeProfile(input) {
  const result = {};
  for (const key of Object.keys(PROFILE_FIELDS)) {
    result[key] = key === 'followerMin' || key === 'followerMax' ? intOrNull(input[key], key === 'followerMin' ? 'Minimum followers' : 'Maximum followers') : clean(input[key], 3000);
  }
  if (result.followerMin !== null && result.followerMax !== null && result.followerMin > result.followerMax) {
    throw new HttpError(400, 'Minimum followers cannot exceed maximum followers.');
  }
  return result;
}

function mapLead(row, notes = []) {
  return {
    id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, handle: row.handle, profileUrl: row.profile_url,
    name: row.name, email: row.email, niche: row.niche, location: row.location, followerCount: row.follower_count,
    averageViews: row.average_views, engagementRate: row.engagement_rate, bio: row.bio, recentPostNotes: row.recent_post_notes,
    source: row.source, notes: row.notes, tags: parseJson(row.tags, []), status: row.status, aiFitScore: row.ai_fit_score,
    aiConfidence: row.ai_confidence, aiRecommendation: row.ai_recommendation, aiStrengths: parseJson(row.ai_strengths, []),
    aiConcerns: parseJson(row.ai_concerns, []), aiReason: row.ai_reason, aiMissingInformation: parseJson(row.ai_missing_information, []),
    aiAnalyzedAt: row.ai_analyzed_at, aiModel: row.ai_model, aiState: row.ai_state, aiError: row.ai_error,
    lastReviewedAt: row.last_reviewed_at, noteLog: notes
  };
}

function mapProfile(row) {
  return Object.fromEntries(Object.entries(PROFILE_FIELDS).map(([key, column]) => [key, row?.[column] ?? (key.startsWith('follower') ? null : '')]));
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (quoted) throw new HttpError(400, 'CSV has an unclosed quoted field.');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(v => v.trim()));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty.shift().map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  if (!headers.includes('handle') && !headers.includes('profile_url')) throw new HttpError(400, 'CSV needs a handle or profile_url column.');
  return nonEmpty.map((values, index) => ({ row: index + 2, values: Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ''])) }));
}

export function validateAnalysis(value) {
  if (!value || !Number.isInteger(value.fit_score) || value.fit_score < 0 || value.fit_score > 100 ||
      !CONFIDENCE.has(value.confidence) || !RECOMMENDATIONS.has(value.recommendation) ||
      !Array.isArray(value.strengths) || !Array.isArray(value.concerns) || !Array.isArray(value.missing_information) ||
      typeof value.concise_reason !== 'string') throw new HttpError(502, 'AI returned an invalid structured result.');
  const strings = (items) => items.every(item => typeof item === 'string');
  if (!strings(value.strengths) || !strings(value.concerns) || !strings(value.missing_information)) throw new HttpError(502, 'AI returned invalid list values.');
  return {
    fit_score: value.fit_score, confidence: value.confidence, recommendation: value.recommendation,
    strengths: value.strengths.map(v => clean(v, 500)).slice(0, 12), concerns: value.concerns.map(v => clean(v, 500)).slice(0, 12),
    concise_reason: clean(value.concise_reason, 1500), missing_information: value.missing_information.map(v => clean(v, 500)).slice(0, 12)
  };
}

async function listLeads(request, env, headers) {
  await requireUser(request, env);
  const [leads, notes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM influencer_leads ORDER BY created_at DESC LIMIT 2000'),
    env.DB.prepare('SELECT * FROM influencer_lead_notes ORDER BY created_at DESC')
  ]);
  const byLead = {};
  for (const note of notes.results) (byLead[note.lead_id] ||= []).push({ id: note.id, body: note.body, author: note.author, createdAt: note.created_at });
  return json({ ok: true, leads: leads.results.map(row => mapLead(row, byLead[row.id] || [])) }, 200, headers);
}

async function insertLead(env, user, input) {
  const fields = normalizeLead(input);
  const row = { id: crypto.randomUUID(), created_by_user_id: user.id, created_at: now(), updated_at: now() };
  for (const [key, column] of Object.entries(LEAD_FIELDS)) row[column] = key === 'tags' ? JSON.stringify(fields[key]) : fields[key];
  try {
    await env.DB.prepare(`INSERT INTO influencer_leads (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run();
  } catch (error) {
    if (/unique/i.test(String(error?.message))) throw new HttpError(409, 'A lead with this Instagram handle or profile URL already exists.');
    throw error;
  }
  return env.DB.prepare('SELECT * FROM influencer_leads WHERE id = ?').bind(row.id).first();
}

async function createLead(request, env, headers) {
  const user = await requireUser(request, env);
  return json({ ok: true, lead: mapLead(await insertLead(env, user, await readJson(request))) }, 201, headers);
}

async function updateLead(request, env, headers, [id]) {
  await requireUser(request, env);
  if (!await env.DB.prepare('SELECT 1 FROM influencer_leads WHERE id = ?').bind(id).first()) throw new HttpError(404, 'Lead not found.');
  const fields = normalizeLead(await readJson(request), true);
  if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to update.');
  const dbFields = {};
  for (const [key, value] of Object.entries(fields)) dbFields[LEAD_FIELDS[key]] = key === 'tags' ? JSON.stringify(value) : value;
  dbFields.updated_at = now();
  try {
    await env.DB.prepare(`UPDATE influencer_leads SET ${Object.keys(dbFields).map(key => `${key} = ?`).join(',')} WHERE id = ?`).bind(...Object.values(dbFields), id).run();
  } catch (error) {
    if (/unique/i.test(String(error?.message))) throw new HttpError(409, 'A lead with this Instagram handle or profile URL already exists.');
    throw error;
  }
  return json({ ok: true, lead: mapLead(await env.DB.prepare('SELECT * FROM influencer_leads WHERE id = ?').bind(id).first()) }, 200, headers);
}

async function deleteLead(request, env, headers, [id]) {
  await requireUser(request, env);
  const result = await env.DB.prepare('DELETE FROM influencer_leads WHERE id = ?').bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Lead not found.');
  return json({ ok: true }, 200, headers);
}

async function importLeads(request, env, headers) {
  const user = await requireUser(request, env);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_IMPORT_BYTES) throw new HttpError(413, 'CSV must be 2 MB or smaller.');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) throw new HttpError(413, 'CSV must be 2 MB or smaller.');
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Import up to ${MAX_IMPORT_ROWS} leads at a time.`);
  const summary = { total: rows.length, created: 0, duplicates: 0, failed: 0, errors: [] };
  const seen = new Set();
  for (const item of rows) {
    const v = item.values;
    const input = {
      handle: v.handle, profileUrl: v.profile_url, name: v.name, email: v.email, niche: v.niche, location: v.location,
      followerCount: v.follower_count, averageViews: v.average_views, engagementRate: v.engagement_rate, bio: v.bio,
      recentPostNotes: v.recent_post_notes, source: v.source || 'CSV import', notes: v.notes,
      tags: v.tags, status: v.status || 'New'
    };
    try {
      const key = leadIdentity(input);
      if (seen.has(key)) { summary.duplicates++; continue; }
      seen.add(key);
      await insertLead(env, user, input);
      summary.created++;
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) summary.duplicates++;
      else { summary.failed++; if (summary.errors.length < 20) summary.errors.push({ row: item.row, error: error.message || 'Import failed.' }); }
    }
  }
  return json({ ok: true, summary }, 200, headers);
}

async function addNote(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  const body = clean((await readJson(request)).body, 4000);
  if (!body) throw new HttpError(400, 'Write a note first.');
  if (!await env.DB.prepare('SELECT 1 FROM influencer_leads WHERE id = ?').bind(id).first()) throw new HttpError(404, 'Lead not found.');
  const note = { id: crypto.randomUUID(), lead_id: id, user_id: user.id, author: user.name || user.email, body, created_at: now() };
  await env.DB.prepare('INSERT INTO influencer_lead_notes (id,lead_id,user_id,author,body,created_at) VALUES (?,?,?,?,?,?)').bind(...Object.values(note)).run();
  return json({ ok: true, note: { id: note.id, author: note.author, body, createdAt: note.created_at } }, 201, headers);
}

async function deleteNote(request, env, headers, [id, noteId]) {
  await requireUser(request, env);
  const result = await env.DB.prepare('DELETE FROM influencer_lead_notes WHERE id = ? AND lead_id = ?').bind(noteId, id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Note not found.');
  return json({ ok: true }, 200, headers);
}

async function getProfile(request, env, headers) {
  await requireUser(request, env);
  return json({ ok: true, profile: mapProfile(await env.DB.prepare("SELECT * FROM ideal_creator_profiles WHERE id = 'default'").first()) }, 200, headers);
}

async function saveProfile(request, env, headers) {
  const user = await requireUser(request, env);
  const profile = normalizeProfile(await readJson(request));
  const columns = Object.values(PROFILE_FIELDS);
  await env.DB.prepare(`UPDATE ideal_creator_profiles SET ${columns.map(c => `${c} = ?`).join(',')}, updated_by_user_id = ?, updated_at = ? WHERE id = 'default'`)
    .bind(...Object.keys(PROFILE_FIELDS).map(k => profile[k]), user.id, now()).run();
  return json({ ok: true, profile }, 200, headers);
}

function analysisPayload(lead, profile) {
  return {
    ideal_creator_profile: mapProfile(profile),
    lead: {
      handle: lead.handle || 'unknown', profile_url: lead.profile_url || 'unknown', name: lead.name || 'unknown', email: lead.email || 'unknown',
      niche: lead.niche || 'unknown', location: lead.location || 'unknown', follower_count: lead.follower_count ?? 'unknown',
      average_views: lead.average_views ?? 'unknown', engagement_rate: lead.engagement_rate ?? 'unknown', bio: lead.bio || 'unknown',
      recent_post_notes: lead.recent_post_notes || 'unknown', source: lead.source || 'unknown', notes: lead.notes || 'unknown',
      tags: parseJson(lead.tags, [])
    }
  };
}

async function callOpenAI(env, payload) {
  if (!env.OPENAI_API_KEY) throw new HttpError(503, 'OPENAI_API_KEY is not configured on the Worker.');
  const model = clean(env.OPENAI_MODEL || 'gpt-5.6-terra', 100);
  const endpoint = `${String(env.OPENAI_API_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: 'Rank this creator lead against the ideal profile using only the supplied data. Never infer or invent metrics, demographics, identity, audience facts, or recent activity. Treat missing fields as unknown and list decision-relevant unknowns in missing_information. Keep the reason concise.',
      input: JSON.stringify(payload),
      text: { format: { type: 'json_schema', name: 'influencer_lead_fit', strict: true, schema: ANALYSIS_SCHEMA } }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, clean(data?.error?.message || `OpenAI request failed (${response.status}).`, 500));
  const outputText = data.output_text || data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  if (!outputText) throw new HttpError(502, 'OpenAI returned no structured output.');
  try { return { result: validateAnalysis(JSON.parse(outputText)), model }; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'OpenAI returned malformed structured output.'); }
}

async function analyzeOne(env, id, force = false) {
  const [lead, profile] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM influencer_leads WHERE id = ?').bind(id),
    env.DB.prepare("SELECT * FROM ideal_creator_profiles WHERE id = 'default'")
  ]);
  const row = lead.results[0];
  if (!row) throw new HttpError(404, 'Lead not found.');
  const payload = analysisPayload(row, profile.results[0]);
  const inputHash = await sha256(JSON.stringify(payload));
  if (!force && row.ai_input_hash === inputHash && row.ai_analyzed_at && Date.now() - new Date(row.ai_analyzed_at).getTime() < RECENT_ANALYSIS_MS) {
    return { lead: mapLead(row), skipped: true };
  }
  await env.DB.prepare("UPDATE influencer_leads SET ai_state = 'processing', ai_error = '', updated_at = ? WHERE id = ?").bind(now(), id).run();
  try {
    const { result, model } = await callOpenAI(env, payload);
    const timestamp = now();
    await env.DB.prepare(`UPDATE influencer_leads SET ai_fit_score=?, ai_confidence=?, ai_recommendation=?, ai_strengths=?, ai_concerns=?,
      ai_reason=?, ai_missing_information=?, ai_analyzed_at=?, ai_model=?, ai_input_hash=?, ai_state='complete', ai_error='', last_reviewed_at=?, updated_at=? WHERE id=?`)
      .bind(result.fit_score, result.confidence, result.recommendation, JSON.stringify(result.strengths), JSON.stringify(result.concerns),
        result.concise_reason, JSON.stringify(result.missing_information), timestamp, model, inputHash, timestamp, timestamp, id).run();
    return { lead: mapLead(await env.DB.prepare('SELECT * FROM influencer_leads WHERE id = ?').bind(id).first()), skipped: false };
  } catch (error) {
    await env.DB.prepare("UPDATE influencer_leads SET ai_state='failed', ai_error=?, updated_at=? WHERE id=?").bind(clean(error.message, 500), now(), id).run();
    throw error;
  }
}

async function analyzeLead(request, env, headers, [id]) {
  await requireUser(request, env);
  const body = await readJson(request);
  return json({ ok: true, ...await analyzeOne(env, id, body.force === true) }, 200, headers);
}

async function analyzeBatch(request, env, headers) {
  await requireUser(request, env);
  const body = await readJson(request);
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(id => clean(id, 64)).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'Select at least one lead.');
  if (ids.length > MAX_BATCH) throw new HttpError(400, `Analyze up to ${MAX_BATCH} leads at a time.`);
  const results = new Array(ids.length);
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const index = cursor++;
      try { results[index] = { id: ids[index], ok: true, ...await analyzeOne(env, ids[index], body.force === true) }; }
      catch (error) { results[index] = { id: ids[index], ok: false, error: error.message || 'Analysis failed.' }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, () => worker()));
  return json({ ok: true, results }, 200, headers);
}

export const influencerLeadRoutes = {
  'GET /api/influencer-leads': listLeads,
  'POST /api/influencer-leads': createLead,
  'POST /api/influencer-leads/import': importLeads,
  'POST /api/influencer-leads/analyze-batch': analyzeBatch,
  'GET /api/influencer-leads/profile': getProfile,
  'PATCH /api/influencer-leads/profile': saveProfile,
  'PATCH /api/influencer-leads/:id': updateLead,
  'DELETE /api/influencer-leads/:id': deleteLead,
  'POST /api/influencer-leads/:id/notes': addNote,
  'DELETE /api/influencer-leads/:id/notes/:note': deleteNote,
  'POST /api/influencer-leads/:id/analyze': analyzeLead
};
