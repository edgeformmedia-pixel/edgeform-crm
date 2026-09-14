import { json, HttpError, clean, now, readJson, sha256, isEmail } from './lib.js';
import { requireUser, requireAdmin } from './auth.js';

const STATUSES = new Set(['New', 'Ready to Review', 'Shortlisted', 'Contacted', 'Replied', 'Not a Fit', 'Archived']);
const CONFIDENCE = new Set(['low', 'medium', 'high']);
const RECOMMENDATIONS = new Set(['shortlist', 'review', 'pass']);
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_ROWS = 500;
const MAX_BATCH = 20;
const RECENT_ANALYSIS_MS = 7 * 86400000;
const MAX_DISCOVERY_CREATORS = 50;

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

const MIN_DISCOVERY_BUDGET = 0.1;
const MAX_DISCOVERY_TOOL_CALLS = 24;
// First path segments on instagram.com that are never creator profiles.
const RESERVED_INSTAGRAM_PATHS = new Set(['p', 'reel', 'reels', 'tv', 'igtv', 'explore', 'stories', 'accounts', 'direct', 'about', 'developer',
  'legal', 'privacy', 'terms', 'web', 'challenge', 'emails', 'session', 'api', 'graphql', 'static', 'oauth', 'invites', 'lite', 'nametag',
  'directory', 'topics', 'ar', 'locations', 'tags', 'create', 's', 'stickers', 'your_activity', 'archive', 'press', 'help', 'blog', 'business', 'share']);

const DISCOVERY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    search_summary: { type: 'string' },
    creators: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          handle: { type: 'string' }, instagram_url: { type: 'string' }, name: { type: 'string' }, niche: { type: 'string' },
          location: { type: 'string' }, bio: { type: 'string' },
          follower_count: { type: ['integer', 'null'] }, average_views: { type: ['integer', 'null'] }, engagement_rate: { type: ['number', 'null'] },
          metrics_source_url: { type: 'string' }, handle_source_url: { type: 'string' },
          activity_date: { type: 'string' }, activity_source_url: { type: 'string' },
          email: { type: 'string' }, email_source_url: { type: 'string' },
          source_urls: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' }
        },
        required: ['handle', 'instagram_url', 'name', 'niche', 'location', 'bio', 'follower_count', 'average_views', 'engagement_rate',
          'metrics_source_url', 'handle_source_url', 'activity_date', 'activity_source_url', 'email', 'email_source_url', 'source_urls', 'evidence']
      }
    },
    unconfirmed: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name', 'reason'] }
    }
  },
  required: ['search_summary', 'creators', 'unconfirmed']
};

const DISCOVERY_INSTRUCTIONS = (limit) => `You build a shortlist of real, individual Instagram creators from public web sources.

1. Search the open web, not only instagram.com. Good sources: YouTube channels and videos, TikTok profiles, podcast episode pages, link-in-bio pages (Linktree, Beacons, Stan), personal websites and newsletters, X profiles, community posts (Skool, Reddit) where creators share their own links, creator roundups, and agency or marketplace rosters. Vary your queries with synonyms, niche terms, tools, and location.
2. If reference_creators are given, study what they post about, their format, and their audience, then find different creators who are similar. Never return a reference creator.
3. Confirm each candidate's Instagram handle on a page returned by your searches that explicitly shows "@handle" or links to instagram.com/handle. Put that exact page URL in handle_source_url. Never derive or guess a handle from a person's name or another platform's username. Confirmation is the slow step: prefer pages that show a creator's links directly (YouTube About or descriptions, link-in-bio pages, podcast show notes, roundups listing several handles), and move on after two failed attempts for one person.
4. Prefer creators who are active now. Put the date of their most recent dated post, video, episode, or article you found in activity_date (YYYY-MM or YYYY-MM-DD) and that page in activity_source_url; leave both empty if you found no dated activity. Skip creators whose latest dated activity is more than 12 months old.
5. Return up to ${limit} confirmed creators. Put the pages that show they fit the brief in source_urls, and one or two sentences in evidence describing what those pages say.
6. Only fill follower_count, average_views, or engagement_rate when a consulted page states the number explicitly; set metrics_source_url to that page. Otherwise use null and an empty metrics_source_url. Leave name, location, and bio empty unless a source states them.
   If a consulted page shows a contact or business email the creator published (YouTube About, website contact page, link-in-bio, media kit), put it in email and that page in email_source_url. Never guess an email from a name or domain; otherwise leave both empty.
7. When follower_max is set, favor early-stage creators documenting their own journey over widely known personalities, and skip anyone a source shows well above the range.
8. List candidates you considered but could not confirm in unconfirmed with a short reason. Do not include guessed handles there.
9. Exclude brands, stores, publications, meme or repost pages, and duplicates. Honor the exclusions and follower range when a source states follower counts.
10. Only read public web search results. Do not log in, scrape, message, follow, like, or take any action on Instagram or other platforms.`;

const MAX_REFERENCE_CREATORS = 10;
const INACTIVE_AFTER_MS = 365 * 86400000;

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const base64ToBytes = (value) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

async function wrappingKey(secret) {
  if (!secret) throw new HttpError(503, 'AI settings encryption is not configured.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(value, wrappingSecret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrappingKey(wrappingSecret), new TextEncoder().encode(value));
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(ciphertext, iv, wrappingSecret) {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, await wrappingKey(wrappingSecret), base64ToBytes(ciphertext));
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'The saved OpenAI key could not be decrypted. Save it again in Find Creators settings.');
  }
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

export function planDiscoveryBudget({ count, budgetUsd, inputRate = 2, outputRate = 12, searchCallRate = 0.01, searchInputTokens = 12000 }) {
  const requestedCount = Number(count);
  const budget = Number(budgetUsd);
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > MAX_DISCOVERY_CREATORS) throw new HttpError(400, `Creator limit must be between 1 and ${MAX_DISCOVERY_CREATORS}.`);
  if (!Number.isFinite(budget) || budget < MIN_DISCOVERY_BUDGET || budget > 25) throw new HttpError(400, 'Estimated spend limit must be between $0.10 and $25.');
  const baseInputCost = 2000 / 1e6 * inputRate;
  const perSearch = searchCallRate + searchInputTokens / 1e6 * inputRate;
  // Finding a creator on the open web and then confirming their handle usually takes more than one search,
  // so keep at least half the desired searches before lowering the creator count. Output tokens include reasoning.
  for (let effectiveCount = requestedCount; effectiveCount >= 1; effectiveCount--) {
    const desiredToolCalls = Math.min(MAX_DISCOVERY_TOOL_CALLS, 3 + Math.ceil(effectiveCount / 2));
    const maxOutputTokens = 2000 + effectiveCount * 250;
    for (let maxToolCalls = desiredToolCalls; maxToolCalls >= Math.max(2, Math.ceil(desiredToolCalls / 2)); maxToolCalls--) {
      const estimatedMaxCost = baseInputCost + maxToolCalls * perSearch + maxOutputTokens / 1e6 * outputRate;
      if (estimatedMaxCost <= budget) return { requestedCount, effectiveCount, maxToolCalls, maxOutputTokens, estimatedMaxCost: Number(estimatedMaxCost.toFixed(4)) };
    }
  }
  throw new HttpError(400, 'That spend limit is too low for a discovery search. Increase it to at least $0.10.');
}

function normalizeHandle(value) {
  let handle = clean(value, 200).toLowerCase();
  if (/instagram\.com/i.test(handle)) {
    try {
      const url = new URL(/^https?:\/\//.test(handle) ? handle : `https://${handle}`);
      if (!/(^|\.)instagram\.com$/.test(url.hostname.toLowerCase())) return '';
      handle = url.pathname.split('/').filter(Boolean)[0] || '';
      if (RESERVED_INSTAGRAM_PATHS.has(handle)) return '';
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

async function readAiSettings(env) {
  return env.DB.prepare("SELECT * FROM influencer_ai_settings WHERE id = 'default'").first();
}

async function getAiSettings(request, env, headers) {
  const user = await requireUser(request, env);
  const row = await readAiSettings(env);
  const saved = !!(row?.api_key_ciphertext && row?.api_key_iv);
  const environment = !!env.OPENAI_API_KEY;
  return json({
    ok: true,
    settings: {
      configured: saved || environment,
      source: saved ? 'settings' : environment ? 'environment' : 'none',
      hint: saved ? row.api_key_hint : environment ? 'Worker secret' : '',
      updatedAt: saved ? row.updated_at : null,
      canEdit: user.role === 'admin' || user.role === 'owner'
    }
  }, 200, headers);
}

async function saveAiSettings(request, env, headers) {
  const user = await requireAdmin(request, env);
  const apiKey = clean((await readJson(request)).apiKey, 500);
  if (apiKey.length < 20 || !apiKey.startsWith('sk-')) throw new HttpError(400, 'Enter a valid OpenAI API key beginning with sk-.');
  const encrypted = await encryptSecret(apiKey, env.AI_SETTINGS_ENCRYPTION_KEY);
  const hint = `••••${apiKey.slice(-4)}`;
  await env.DB.prepare(`UPDATE influencer_ai_settings SET api_key_ciphertext = ?, api_key_iv = ?, api_key_hint = ?, updated_by_user_id = ?, updated_at = ? WHERE id = 'default'`)
    .bind(encrypted.ciphertext, encrypted.iv, hint, user.id, now()).run();
  return json({ ok: true, settings: { configured: true, source: 'settings', hint, updatedAt: now(), canEdit: true } }, 200, headers);
}

async function deleteAiSettings(request, env, headers) {
  await requireAdmin(request, env);
  await env.DB.prepare("UPDATE influencer_ai_settings SET api_key_ciphertext = '', api_key_iv = '', api_key_hint = '', updated_by_user_id = NULL, updated_at = NULL WHERE id = 'default'").run();
  return json({ ok: true, settings: { configured: !!env.OPENAI_API_KEY, source: env.OPENAI_API_KEY ? 'environment' : 'none', hint: env.OPENAI_API_KEY ? 'Worker secret' : '', updatedAt: null, canEdit: true } }, 200, headers);
}

async function openAiApiKey(env) {
  const row = await readAiSettings(env);
  if (row?.api_key_ciphertext && row?.api_key_iv) return decryptSecret(row.api_key_ciphertext, row.api_key_iv, env.AI_SETTINGS_ENCRYPTION_KEY);
  return env.OPENAI_API_KEY || '';
}

function responseOutputText(data) {
  return data.output_text || data.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text || '';
}

function discoveryPricing(env) {
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  return {
    inputRate: number(env.OPENAI_DISCOVERY_INPUT_USD_PER_MTOK, 2),
    outputRate: number(env.OPENAI_DISCOVERY_OUTPUT_USD_PER_MTOK, 12),
    searchCallRate: number(env.OPENAI_WEB_SEARCH_USD_PER_CALL, 0.01),
    searchInputTokens: number(env.OPENAI_SEARCH_INPUT_TOKENS_ESTIMATE, 12000)
  };
}

// Removes anything that looks like an API key or bearer token before text reaches logs or the browser.
export function redactSecrets(value) {
  return String(value ?? '').replace(/\bsk-[A-Za-z0-9_\-*.]{4,}/g, 'sk-[redacted]').replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [redacted]');
}

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|igsh$|igshid$|mc_cid$|mc_eid$|ref$|ref_src$|si$)/i;

// Comparison key for a URL: host without www/m, no hash, no tracking params, no trailing slash.
export function sourceKey(value) {
  try {
    const url = new URL(clean(value, 2000));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    const query = url.searchParams.toString();
    return `${url.hostname.toLowerCase().replace(/^(www|m)\./, '')}${url.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`.toLowerCase();
  } catch { return ''; }
}

const sourceDomain = (key) => key.split(/[/?]/)[0];

// Every URL the model actually saw: search result sources, pages it opened, and inline citations.
export function collectConsultedSources(data) {
  const keys = new Set(), urls = [], queries = [], domains = {};
  let searchActions = 0, pageActions = 0;
  const add = (raw) => {
    const key = sourceKey(raw);
    if (!key || keys.has(key)) return;
    keys.add(key); keys.add(key.split('?')[0]);
    urls.push(clean(raw, 500));
    const domain = sourceDomain(key);
    domains[domain] = (domains[domain] || 0) + 1;
  };
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type === 'web_search_call') {
      const action = item.action || {};
      if (action.type === 'search') searchActions++; else if (action.type) pageActions++;
      for (const q of [action.query, ...(Array.isArray(action.queries) ? action.queries : [])]) if (q && queries.length < 40) queries.push(clean(q, 300));
      for (const source of Array.isArray(action.sources) ? action.sources : []) if (source?.url) add(source.url);
      if (action.url) add(action.url);
    } else if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        for (const note of Array.isArray(part?.annotations) ? part.annotations : []) if (note?.type === 'url_citation' && note.url) add(note.url);
      }
    }
  }
  return { keys, urls, queries: [...new Set(queries)], domains, searchActions, pageActions };
}

export function wasConsulted(url, consulted) {
  const key = sourceKey(url);
  return !!key && (consulted.keys.has(key) || consulted.keys.has(key.split('?')[0]));
}

class DiscoveryRejection extends Error {
  constructor(reason, detail) { super(detail); this.reason = reason; }
}

// Turns one model-proposed creator into a lead, or throws DiscoveryRejection with a machine-readable reason.
export function verifyDiscoveredCreator(value, consulted, criteria = {}, nowMs = Date.now()) {
  if (!value || typeof value !== 'object') throw new DiscoveryRejection('invalid_shape', 'Candidate was not an object.');
  const rawHandle = clean(value.handle, 200).replace(/^@/, '').toLowerCase();
  const handle = normalizeHandle(rawHandle);
  if (!handle || RESERVED_INSTAGRAM_PATHS.has(handle) || /^\.|\.$|\.\./.test(handle)) throw new DiscoveryRejection('invalid_handle', `"${clean(value.handle, 60)}" is not a valid Instagram handle.`);
  if ((criteria.lookalikes || []).includes(handle)) throw new DiscoveryRejection('reference_creator', `@${handle} is one of the reference creators.`);
  const instagramUrl = clean(value.instagram_url, 500);
  if (instagramUrl) {
    const urlHandle = /instagram\.com/i.test(instagramUrl) ? normalizeHandle(instagramUrl) : '';
    if (!urlHandle) throw new DiscoveryRejection('non_profile_instagram_url', `${instagramUrl} is not an Instagram profile URL.`);
    if (urlHandle !== handle) throw new DiscoveryRejection('handle_url_mismatch', `@${handle} does not match ${instagramUrl}.`);
  }
  const profileUrl = `https://www.instagram.com/${handle}/`;
  const handleSource = clean(value.handle_source_url, 500);
  const profileSeen = wasConsulted(profileUrl, consulted);
  if (!profileSeen) {
    if (!handleSource) throw new DiscoveryRejection('missing_handle_source', `@${handle} had no page confirming the handle.`);
    if (!wasConsulted(handleSource, consulted)) throw new DiscoveryRejection('handle_source_not_consulted', `@${handle} cited ${handleSource}, which was not in the search results.`);
  }
  const verifiedSources = [...new Set([profileSeen ? profileUrl : handleSource, ...(Array.isArray(value.source_urls) ? value.source_urls : [])]
    .map(url => clean(url, 500)).filter(url => wasConsulted(url, consulted)))].slice(0, 8);
  const dropped = [];
  const metricsVerified = !!clean(value.metrics_source_url, 500) && wasConsulted(value.metrics_source_url, consulted);
  const metric = (input, label, parse) => {
    if (input === null || input === undefined) return null;
    if (!metricsVerified) { dropped.push(label); return null; }
    try { return parse(input); } catch { dropped.push(label); return null; }
  };
  const followerCount = metric(value.follower_count, 'follower count', v => intOrNull(v, 'Follower count'));
  const averageViews = metric(value.average_views, 'average views', v => intOrNull(v, 'Average views'));
  const engagementRate = metric(value.engagement_rate, 'engagement rate', rateOrNull);
  if (followerCount !== null && ((criteria.followerMin != null && followerCount < criteria.followerMin) || (criteria.followerMax != null && followerCount > criteria.followerMax))) {
    throw new DiscoveryRejection('outside_follower_range', `@${handle} has ${followerCount} followers, outside the requested range.`);
  }
  const activity = verifiedActivity(value, consulted, nowMs);
  if (activity.stale) throw new DiscoveryRejection('inactive', `@${handle}'s latest dated activity (${activity.date}) is more than 12 months old.`);
  const emailSource = clean(value.email_source_url, 500);
  const suppliedEmail = clean(value.email, 254).toLowerCase().replace(/^mailto:/, '');
  const email = suppliedEmail && isEmail(suppliedEmail) && emailSource && wasConsulted(emailSource, consulted) ? suppliedEmail : '';
  if (suppliedEmail && !email) dropped.push('email');
  const notes = [clean(value.evidence, 1200), verifiedSources.length ? `Sources:\n${verifiedSources.join('\n')}` : '',
    activity.date ? `Latest activity found: ${activity.date} (${activity.url})` : 'No dated recent activity found. Check the account is still active.',
    email ? `Email source: ${emailSource}` : '',
    metricsVerified && (followerCount !== null || averageViews !== null || engagementRate !== null) ? `Metrics source: ${clean(value.metrics_source_url, 500)}` : '',
    dropped.length ? `Unverified ${dropped.join(', ')} omitted.` : ''].filter(Boolean).join('\n\n');
  return {
    lead: {
      handle, profileUrl, name: clean(value.name, 160), email, niche: clean(value.niche, 160), location: clean(value.location, 160), bio: clean(value.bio, 3000),
      followerCount, averageViews, engagementRate, recentPostNotes: clean(notes, 3000), source: 'OpenAI web discovery',
      tags: activity.date ? ['AI discovered'] : ['AI discovered', 'Activity unverified'], status: 'Ready to Review', notes: ''
    },
    droppedMetrics: dropped
  };
}

// A dated activity only counts when its page was consulted; dates in the future are ignored.
function verifiedActivity(value, consulted, nowMs) {
  const date = clean(value.activity_date, 20);
  const url = clean(value.activity_source_url, 500);
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(date);
  if (!match || !url || !wasConsulted(url, consulted)) return { date: '', url: '', stale: false };
  const month = Number(match[2]), day = Number(match[3] || 1);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { date: '', url: '', stale: false };
  // Month-only dates count from the end of that month.
  const time = match[3] ? Date.UTC(Number(match[1]), month - 1, day) : Date.UTC(Number(match[1]), month, 0);
  if (time > nowMs + 31 * 86400000) return { date: '', url: '', stale: false };
  return { date, url, stale: nowMs - time > INACTIVE_AFTER_MS };
}

// Reference creators as bare handles, from a list or free text of @handles and profile URLs.
export function parseReferenceCreators(value) {
  const tokens = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  return [...new Set(tokens.map(token => normalizeHandle(clean(token, 200))).filter(handle => handle && !RESERVED_INSTAGRAM_PATHS.has(handle)))].slice(0, MAX_REFERENCE_CREATORS);
}

const ACTIVE_RUN_STATUSES = ['starting', 'running', 'importing'];
const OPENAI_PENDING = new Set(['queued', 'in_progress']);
const BROWSER_POLL_INTERVAL_MS = 3000;
const CRON_POLL_INTERVAL_MS = 20000;
const DISCOVERY_TIMEOUT_MS = 20 * 60000;
const STALE_START_MS = 2 * 60000;
const STALE_IMPORT_MS = 5 * 60000;
const ACTIVE_RUNS_SQL = `status IN (${ACTIVE_RUN_STATUSES.map(s => `'${s}'`).join(',')})`;

function openAiErrorDetails(status, data) {
  const error = data?.error || {};
  return { httpStatus: status, type: clean(error.type, 100), code: clean(error.code, 100), param: clean(error.param, 100), message: clean(redactSecrets(error.message), 500) };
}

async function openAiResponses(env, apiKey, path = '', { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${String(env.OPENAI_API_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/responses${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw Object.assign(new HttpError(502, 'Could not reach OpenAI for discovery. Try again shortly.'), {
      apiError: { httpStatus: 0, type: 'network_error', code: '', param: '', message: clean(redactSecrets(error?.message), 500) }
    });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiError = openAiErrorDetails(response.status, data);
    throw Object.assign(new HttpError(502, apiError.message || `OpenAI discovery request failed (${response.status}).`), { apiError });
  }
  return data;
}

// Background mode: OpenAI keeps working after this Worker request ends, and the run is collected by polling.
export function buildDiscoveryRequest({ model, plan, query, criteria }) {
  const { lookalikes = [], profileId, ...filters } = criteria;
  return {
    model,
    background: true,
    store: true,
    reasoning: { effort: 'low' },
    // Open web: Instagram profile pages are sparsely indexed, so a domain filter starves the search.
    tools: [{ type: 'web_search', search_context_size: 'medium' }],
    tool_choice: 'required',
    max_tool_calls: plan.maxToolCalls,
    max_output_tokens: plan.maxOutputTokens,
    include: ['web_search_call.action.sources'],
    instructions: DISCOVERY_INSTRUCTIONS(plan.effectiveCount),
    input: JSON.stringify({ request: query, ...filters, reference_creators: lookalikes.map(handle => '@' + handle), creator_limit: plan.effectiveCount }),
    text: { format: { type: 'json_schema', name: 'influencer_discovery', strict: true, schema: DISCOVERY_SCHEMA } }
  };
}

// Decides what an active run needs next, from its row alone.
export function nextDiscoveryAction(row, nowMs = Date.now(), minPollMs = BROWSER_POLL_INTERVAL_MS) {
  const since = (value) => value ? nowMs - Date.parse(value) : Infinity;
  if (row.status === 'starting') return since(row.updated_at || row.created_at) > STALE_START_MS ? 'fail_stale_start' : 'wait';
  if (row.status === 'importing') return since(row.claimed_at) > STALE_IMPORT_MS ? 'release_import' : 'wait';
  if (row.status !== 'running') return 'none';
  if (since(row.created_at) > DISCOVERY_TIMEOUT_MS) return 'timeout';
  return since(row.polled_at) >= minPollMs ? 'poll' : 'wait';
}

export function serializeDiscoveryRun(row) {
  if (!row) return null;
  return {
    id: row.id, status: row.status, active: ACTIVE_RUN_STATUSES.includes(row.status), createdAt: row.created_at,
    updatedAt: row.updated_at || null, completedAt: row.completed_at || null, query: row.query, requestedCount: row.requested_count,
    effectiveCount: row.effective_count, budgetUsd: row.budget_usd, responseStatus: row.response_status || '', error: row.error || '',
    result: parseJson(row.result, null)
  };
}

const emptyOutcome = () => ({ parsed: null, consulted: collectConsultedSources({}), summary: { found: 0, imported: 0, duplicates: 0, failed: 0, errors: [] }, rejections: [] });

// A creator already in the CRM keeps their data, but gains a sourced email if they had none.
async function fillMissingEmail(env, candidate, consulted, criteria) {
  try {
    const { lead } = verifyDiscoveredCreator(candidate, consulted, criteria);
    if (lead.email) await env.DB.prepare("UPDATE influencer_leads SET email = ?, updated_at = ? WHERE handle = ? AND email = ''").bind(lead.email, now(), lead.handle).run();
  } catch {}
}

async function importDiscoveryResponse(env, row, data) {
  const outcome = { ...emptyOutcome(), consulted: collectConsultedSources(data) };
  const outputText = responseOutputText(data);
  try { outcome.parsed = outputText ? JSON.parse(outputText) : null; } catch { outcome.parsed = null; }
  if (!outcome.parsed || !Array.isArray(outcome.parsed.creators)) {
    outcome.message = data.incomplete_details?.reason === 'max_output_tokens'
      ? 'Discovery reached the spend/output cap before it could finish. Increase the limit or request fewer creators.'
      : outputText ? 'OpenAI returned malformed discovery results.' : 'OpenAI returned no discovery results.';
    outcome.parsed = null;
    return outcome;
  }
  const criteria = parseJson(row.criteria, {});
  const { summary, rejections } = outcome;
  const candidates = outcome.parsed.creators.slice(0, row.effective_count || MAX_DISCOVERY_CREATORS);
  summary.found = candidates.length;
  const seen = new Set();
  for (const candidate of candidates) {
    try {
      const { lead } = verifyDiscoveredCreator(candidate, outcome.consulted, criteria);
      if (seen.has(lead.handle)) { summary.duplicates++; continue; }
      seen.add(lead.handle);
      await insertLead(env, { id: row.user_id }, lead);
      summary.imported++;
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        summary.duplicates++;
        await fillMissingEmail(env, candidate, outcome.consulted, criteria);
        continue;
      }
      summary.failed++;
      const reason = error instanceof DiscoveryRejection ? error.reason : 'invalid_lead';
      rejections.push({ handle: clean(candidate?.handle, 60), name: clean(candidate?.name, 120), reason, detail: clean(redactSecrets(error.message), 300) });
      if (summary.errors.length < 10) summary.errors.push(error.message || 'Invalid discovery result.');
    }
  }
  return outcome;
}

// Writes the final state of a run. With expectStatus, the write only lands if the run is still in that state.
async function writeDiscoveryOutcome(env, row, data, outcome, status, { error = '', apiError = null, expectStatus = null } = {}) {
  const pricing = discoveryPricing(env);
  const inputTokens = Number(data.usage?.input_tokens || 0), outputTokens = Number(data.usage?.output_tokens || 0);
  const webSearchCalls = (Array.isArray(data.output) ? data.output : []).filter(item => item?.type === 'web_search_call').length;
  const usage = {
    inputTokens, outputTokens, reasoningTokens: Number(data.usage?.output_tokens_details?.reasoning_tokens || 0), webSearchCalls,
    estimatedCostUsd: Number((inputTokens / 1e6 * pricing.inputRate + outputTokens / 1e6 * pricing.outputRate + webSearchCalls * pricing.searchCallRate).toFixed(4))
  };
  const { parsed, consulted, summary, rejections } = outcome;
  const diagnostics = {
    runId: row.id, responseStatus: clean(data.status, 40), incompleteReason: clean(data.incomplete_details?.reason, 100),
    candidateCount: summary.found, rejectedCount: rejections.length, rejections: rejections.slice(0, 50),
    unconfirmed: (Array.isArray(parsed?.unconfirmed) ? parsed.unconfirmed : []).slice(0, 30).map(item => ({ name: clean(item?.name, 120), reason: clean(item?.reason, 300) })),
    searchQueries: consulted.queries.slice(0, 30), sourceCount: consulted.urls.length,
    sourceDomains: Object.fromEntries(Object.entries(consulted.domains).sort((a, b) => b[1] - a[1]).slice(0, 40)),
    searchActions: consulted.searchActions, pageActions: consulted.pageActions
  };
  const plan = { requestedCount: row.requested_count, effectiveCount: row.effective_count, maxToolCalls: row.max_tool_calls, maxOutputTokens: row.max_output_tokens };
  const result = { summary, searchSummary: clean(parsed?.search_summary, 1000), usage: { ...usage, budgetUsd: row.budget_usd, model: row.model }, plan, diagnostics };
  const at = now();
  const fields = {
    status, error: clean(redactSecrets(error), 500), api_error: apiError ? JSON.stringify(apiError) : '',
    response_status: diagnostics.responseStatus || row.response_status || '', incomplete_reason: diagnostics.incompleteReason,
    search_summary: clean(parsed?.search_summary, 2000), found_count: summary.found, imported_count: summary.imported,
    duplicate_count: summary.duplicates, failed_count: summary.failed, candidate_count: summary.found, rejected_count: rejections.length,
    rejections: JSON.stringify(diagnostics.rejections), unconfirmed: JSON.stringify(diagnostics.unconfirmed),
    search_queries: JSON.stringify(diagnostics.searchQueries), source_count: diagnostics.sourceCount,
    source_domains: JSON.stringify(diagnostics.sourceDomains), source_urls: JSON.stringify(consulted.urls.slice(0, 100)),
    input_tokens: inputTokens, output_tokens: outputTokens, reasoning_tokens: usage.reasoningTokens, web_search_calls: webSearchCalls,
    estimated_cost_usd: usage.estimatedCostUsd, duration_ms: Math.max(0, Date.parse(at) - Date.parse(row.created_at)),
    result: JSON.stringify(result), completed_at: at, updated_at: at
  };
  const where = expectStatus ? 'WHERE id = ? AND status = ?' : 'WHERE id = ?';
  const write = await env.DB.prepare(`UPDATE influencer_discovery_runs SET ${Object.keys(fields).map(key => `${key} = ?`).join(',')} ${where}`)
    .bind(...Object.values(fields), row.id, ...(expectStatus ? [expectStatus] : [])).run();
  return write.meta.changes > 0;
}

// Claims a running run so exactly one invocation imports it, then records the outcome.
async function finalizeDiscoveryRun(env, row, data, { endedReason = '' } = {}) {
  const claimedAt = now();
  const claim = await env.DB.prepare("UPDATE influencer_discovery_runs SET status = 'importing', claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(claimedAt, claimedAt, row.id).run();
  if (!claim.meta.changes) return false;
  const claimed = { ...row, status: 'importing' };
  if (data.status === 'completed' || data.status === 'incomplete') {
    const outcome = await importDiscoveryResponse(env, claimed, data);
    await writeDiscoveryOutcome(env, claimed, data, outcome, outcome.message ? 'failed' : 'complete', { error: outcome.message || '', expectStatus: 'importing' });
  } else if (data.status === 'cancelled') {
    await writeDiscoveryOutcome(env, claimed, data, { ...emptyOutcome(), consulted: collectConsultedSources(data) }, endedReason === 'timeout' ? 'failed' : 'cancelled', {
      error: endedReason === 'timeout' ? 'Discovery timed out after 20 minutes and was cancelled.' : 'Discovery was cancelled.', expectStatus: 'importing'
    });
  } else {
    const apiError = data.error ? { httpStatus: 200, type: 'response_failed', code: clean(data.error.code, 100), param: '', message: clean(redactSecrets(data.error.message), 500) } : null;
    await writeDiscoveryOutcome(env, claimed, data, { ...emptyOutcome(), consulted: collectConsultedSources(data) }, 'failed', {
      error: apiError?.message || `Discovery ended with status "${clean(data.status, 40) || 'unknown'}".`, apiError, expectStatus: 'importing'
    });
  }
  return true;
}

const readRun = (env, id) => env.DB.prepare('SELECT * FROM influencer_discovery_runs WHERE id = ?').bind(id).first();

async function cancelOpenAiRun(env, row, apiKey, endedReason) {
  try {
    const data = await openAiResponses(env, apiKey, `/${encodeURIComponent(row.response_id)}/cancel`, { method: 'POST' });
    return finalizeDiscoveryRun(env, row, OPENAI_PENDING.has(data.status) ? { ...data, status: 'cancelled' } : data, { endedReason });
  } catch (error) {
    if (error.apiError?.httpStatus !== 404) throw error;
    const status = endedReason === 'timeout' ? 'failed' : 'cancelled';
    return writeDiscoveryOutcome(env, row, {}, emptyOutcome(), status, { error: 'OpenAI no longer has this discovery response.', apiError: error.apiError, expectStatus: 'running' });
  }
}

// Moves one active run forward: polls OpenAI, imports finished results, or cleans up stuck and expired runs.
async function advanceDiscoveryRun(env, row, apiKey, minPollMs = BROWSER_POLL_INTERVAL_MS) {
  const action = nextDiscoveryAction(row, Date.now(), minPollMs);
  if (action === 'fail_stale_start') {
    return writeDiscoveryOutcome(env, row, {}, emptyOutcome(), 'failed', { error: 'Discovery did not start. Try again.', expectStatus: 'starting' });
  }
  if (action === 'release_import') {
    // The importing invocation died. Hand the run back so it is re-imported; existing leads count as duplicates.
    return env.DB.prepare("UPDATE influencer_discovery_runs SET status = 'running', polled_at = '', updated_at = ? WHERE id = ? AND status = 'importing' AND claimed_at = ?")
      .bind(now(), row.id, row.claimed_at).run();
  }
  if (action !== 'poll' && action !== 'timeout') return;
  if (!apiKey) {
    if (action !== 'timeout') return;
    return writeDiscoveryOutcome(env, row, {}, emptyOutcome(), 'failed', { error: 'Discovery timed out and no OpenAI key was available to cancel it.', expectStatus: 'running' });
  }
  if (action === 'timeout') return cancelOpenAiRun(env, row, apiKey, 'timeout');
  const polledAt = now();
  const mark = await env.DB.prepare("UPDATE influencer_discovery_runs SET polled_at = ? WHERE id = ? AND status = 'running' AND polled_at = ?")
    .bind(polledAt, row.id, row.polled_at || '').run();
  if (!mark.meta.changes) return;
  let data;
  try {
    data = await openAiResponses(env, apiKey, `/${encodeURIComponent(row.response_id)}?include[]=web_search_call.action.sources`);
  } catch (error) {
    if (error.apiError?.httpStatus === 404 || error.apiError?.httpStatus === 401) {
      return writeDiscoveryOutcome(env, row, {}, emptyOutcome(), 'failed', { error: error.message, apiError: error.apiError, expectStatus: 'running' });
    }
    console.error('discovery poll failed', row.id, redactSecrets(error?.message));
    return;
  }
  if (OPENAI_PENDING.has(data.status)) {
    return env.DB.prepare("UPDATE influencer_discovery_runs SET response_status = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .bind(clean(data.status, 40), now(), row.id).run();
  }
  return finalizeDiscoveryRun(env, row, data);
}

async function advanceActiveRuns(env, rows, minPollMs) {
  if (!rows.length) return;
  let apiKey = '';
  try { apiKey = await openAiApiKey(env); } catch (error) { console.error('discovery key unavailable', redactSecrets(error?.message)); }
  for (const row of rows) {
    try { await advanceDiscoveryRun(env, row, apiKey, minPollMs); }
    catch (error) { console.error('discovery run update failed', row.id, redactSecrets(error?.message)); }
  }
}

// Every minute: collect finished background runs even when nobody has the CRM open.
export async function discoveryCron(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM influencer_discovery_runs WHERE ${ACTIVE_RUNS_SQL} ORDER BY created_at LIMIT 10`).all();
  await advanceActiveRuns(env, results || [], CRON_POLL_INTERVAL_MS);
}

async function discoverInfluencers(request, env, headers) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const query = clean(body.query, 1000);
  if (!query) throw new HttpError(400, 'Describe the influencers you want to find.');
  const criteria = {
    niche: clean(body.niche, 160), location: clean(body.location, 160), followerMin: intOrNull(body.followerMin, 'Minimum followers'),
    followerMax: intOrNull(body.followerMax, 'Maximum followers'), exclusions: clean(body.exclusions, 1000),
    lookalikes: parseReferenceCreators(body.lookalikes), profileId: clean(body.profileId, 64)
  };
  if (criteria.followerMin !== null && criteria.followerMax !== null && criteria.followerMin > criteria.followerMax) throw new HttpError(400, 'Minimum followers cannot exceed maximum followers.');
  const plan = planDiscoveryBudget({ count: body.count, budgetUsd: body.budgetUsd, ...discoveryPricing(env) });
  const apiKey = await openAiApiKey(env);
  if (!apiKey) throw new HttpError(503, 'Add an OpenAI API key in Find Creators → Settings first.');
  // Clear out this user's stuck or finished runs before enforcing one active run per user.
  const { results: existing } = await env.DB.prepare(`SELECT * FROM influencer_discovery_runs WHERE user_id = ? AND ${ACTIVE_RUNS_SQL}`).bind(user.id).all();
  await advanceActiveRuns(env, existing || [], BROWSER_POLL_INTERVAL_MS);
  const model = clean(env.OPENAI_DISCOVERY_MODEL || env.OPENAI_MODEL || 'gpt-5.6-terra', 100);
  const at = now();
  const run = {
    id: crypto.randomUUID(), user_id: user.id, created_at: at, updated_at: at, query, criteria: JSON.stringify(criteria),
    requested_count: plan.requestedCount, budget_usd: Number(body.budgetUsd), effective_count: plan.effectiveCount,
    max_tool_calls: plan.maxToolCalls, max_output_tokens: plan.maxOutputTokens, model, status: 'starting'
  };
  const columns = Object.keys(run);
  const inserted = await env.DB.prepare(`INSERT INTO influencer_discovery_runs (${columns.join(',')}) SELECT ${columns.map(() => '?').join(',')}
    WHERE NOT EXISTS (SELECT 1 FROM influencer_discovery_runs WHERE user_id = ? AND ${ACTIVE_RUNS_SQL})`).bind(...Object.values(run), user.id).run();
  if (!inserted.meta.changes) throw new HttpError(409, 'You already have a discovery search running. Wait for it to finish or cancel it.');
  let data;
  try {
    data = await openAiResponses(env, apiKey, '', { method: 'POST', body: buildDiscoveryRequest({ model, plan, query, criteria }) });
    if (!data.id) throw new HttpError(502, 'OpenAI did not return a discovery response ID.');
  } catch (error) {
    await writeDiscoveryOutcome(env, run, {}, emptyOutcome(), 'failed', { error: error.message, apiError: error.apiError || null, expectStatus: 'starting' });
    throw error;
  }
  const started = await env.DB.prepare("UPDATE influencer_discovery_runs SET status = 'running', response_id = ?, response_status = ?, polled_at = ?, updated_at = ? WHERE id = ? AND status = 'starting'")
    .bind(clean(data.id, 100), clean(data.status, 40), now(), now(), run.id).run();
  if (!started.meta.changes) {
    // Cancelled while OpenAI was accepting the request.
    if (OPENAI_PENDING.has(data.status)) await openAiResponses(env, apiKey, `/${encodeURIComponent(data.id)}/cancel`, { method: 'POST' }).catch(() => {});
  } else if (!OPENAI_PENDING.has(data.status)) {
    await finalizeDiscoveryRun(env, { ...run, status: 'running', response_id: data.id }, data);
  }
  return json({ ok: true, run: serializeDiscoveryRun(await readRun(env, run.id)), plan }, 202, headers);
}

async function ownedRun(request, env, id) {
  const user = await requireUser(request, env);
  const row = await readRun(env, clean(id, 64));
  if (!row || (row.user_id !== user.id && user.role !== 'admin' && user.role !== 'owner')) throw new HttpError(404, 'Discovery run not found.');
  return row;
}

async function listDiscoveryRuns(request, env, headers) {
  const user = await requireUser(request, env);
  const activeSql = `SELECT * FROM influencer_discovery_runs WHERE user_id = ? AND ${ACTIVE_RUNS_SQL}`;
  const { results: active } = await env.DB.prepare(activeSql).bind(user.id).all();
  await advanceActiveRuns(env, active || [], BROWSER_POLL_INTERVAL_MS);
  const [current, recent] = await env.DB.batch([
    env.DB.prepare(`${activeSql} ORDER BY created_at DESC LIMIT 1`).bind(user.id),
    env.DB.prepare('SELECT * FROM influencer_discovery_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').bind(user.id)
  ]);
  return json({ ok: true, active: serializeDiscoveryRun(current.results[0]), recent: recent.results.map(serializeDiscoveryRun) }, 200, headers);
}

async function getDiscoveryRun(request, env, headers, [id]) {
  const row = await ownedRun(request, env, id);
  if (ACTIVE_RUN_STATUSES.includes(row.status)) await advanceActiveRuns(env, [row], BROWSER_POLL_INTERVAL_MS);
  return json({ ok: true, run: serializeDiscoveryRun(await readRun(env, row.id)) }, 200, headers);
}

async function cancelDiscoveryRun(request, env, headers, [id]) {
  const row = await ownedRun(request, env, id);
  if (row.status === 'importing') throw new HttpError(409, 'This search already finished and its results are being added.');
  if (row.status === 'starting') {
    await writeDiscoveryOutcome(env, row, {}, emptyOutcome(), 'cancelled', { error: 'Discovery was cancelled.', expectStatus: 'starting' });
  } else if (row.status === 'running') {
    const apiKey = await openAiApiKey(env);
    if (!apiKey) throw new HttpError(503, 'Add an OpenAI API key in Find Creators → Settings to cancel this search.');
    await cancelOpenAiRun(env, row, apiKey, 'user');
  }
  return json({ ok: true, run: serializeDiscoveryRun(await readRun(env, row.id)) }, 200, headers);
}

export function normalizeDiscoveryProfile(input) {
  const name = clean(input.name, 80);
  if (!name) throw new HttpError(400, 'Name the search profile.');
  const followerMin = intOrNull(input.followerMin, 'Minimum followers'), followerMax = intOrNull(input.followerMax, 'Maximum followers');
  if (followerMin !== null && followerMax !== null && followerMin > followerMax) throw new HttpError(400, 'Minimum followers cannot exceed maximum followers.');
  const creatorCount = intOrNull(input.creatorCount, 'Creator limit');
  if (creatorCount !== null && (creatorCount < 1 || creatorCount > MAX_DISCOVERY_CREATORS)) throw new HttpError(400, `Creator limit must be between 1 and ${MAX_DISCOVERY_CREATORS}.`);
  const budget = input.budgetUsd === '' || input.budgetUsd === null || input.budgetUsd === undefined ? null : Number(input.budgetUsd);
  if (budget !== null && (!Number.isFinite(budget) || budget < MIN_DISCOVERY_BUDGET || budget > 25)) throw new HttpError(400, 'Estimated spend limit must be between $0.10 and $25.');
  return {
    name, brief: clean(input.brief, 1000), niche: clean(input.niche, 160), location: clean(input.location, 160), follower_min: followerMin,
    follower_max: followerMax, exclusions: clean(input.exclusions, 1000), lookalikes: JSON.stringify(parseReferenceCreators(input.lookalikes)),
    creator_count: creatorCount, budget_usd: budget
  };
}

function mapDiscoveryProfile(row) {
  return {
    id: row.id, name: row.name, brief: row.brief, niche: row.niche, location: row.location, followerMin: row.follower_min,
    followerMax: row.follower_max, exclusions: row.exclusions, lookalikes: parseJson(row.lookalikes, []), creatorCount: row.creator_count,
    budgetUsd: row.budget_usd, updatedAt: row.updated_at
  };
}

async function writeDiscoveryProfile(env, sql, values) {
  try { await env.DB.prepare(sql).bind(...values).run(); }
  catch (error) {
    if (/unique/i.test(String(error?.message))) throw new HttpError(409, 'A search profile with that name already exists.');
    throw error;
  }
}

async function listDiscoveryProfiles(request, env, headers) {
  await requireUser(request, env);
  const { results } = await env.DB.prepare('SELECT * FROM discovery_profiles ORDER BY name COLLATE NOCASE').all();
  return json({ ok: true, profiles: results.map(mapDiscoveryProfile) }, 200, headers);
}

async function createDiscoveryProfile(request, env, headers) {
  const user = await requireUser(request, env);
  const row = { id: crypto.randomUUID(), ...normalizeDiscoveryProfile(await readJson(request)), created_by_user_id: user.id, updated_by_user_id: user.id, created_at: now(), updated_at: now() };
  await writeDiscoveryProfile(env, `INSERT INTO discovery_profiles (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row));
  return json({ ok: true, profile: mapDiscoveryProfile(await env.DB.prepare('SELECT * FROM discovery_profiles WHERE id = ?').bind(row.id).first()) }, 201, headers);
}

async function updateDiscoveryProfile(request, env, headers, [id]) {
  const user = await requireUser(request, env);
  if (!await env.DB.prepare('SELECT 1 FROM discovery_profiles WHERE id = ?').bind(id).first()) throw new HttpError(404, 'Search profile not found.');
  const fields = { ...normalizeDiscoveryProfile(await readJson(request)), updated_by_user_id: user.id, updated_at: now() };
  await writeDiscoveryProfile(env, `UPDATE discovery_profiles SET ${Object.keys(fields).map(key => `${key} = ?`).join(',')} WHERE id = ?`, [...Object.values(fields), id]);
  return json({ ok: true, profile: mapDiscoveryProfile(await env.DB.prepare('SELECT * FROM discovery_profiles WHERE id = ?').bind(id).first()) }, 200, headers);
}

async function deleteDiscoveryProfile(request, env, headers, [id]) {
  await requireUser(request, env);
  const result = await env.DB.prepare('DELETE FROM discovery_profiles WHERE id = ?').bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Search profile not found.');
  return json({ ok: true }, 200, headers);
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
  const apiKey = await openAiApiKey(env);
  if (!apiKey) throw new HttpError(503, 'Add an OpenAI API key in Find Creators → Settings.');
  const model = clean(env.OPENAI_MODEL || 'gpt-5.6-terra', 100);
  const endpoint = `${String(env.OPENAI_API_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: 'Rank this creator lead against the ideal profile using only the supplied data. Never infer or invent metrics, demographics, identity, audience facts, or recent activity. Treat missing fields as unknown and list decision-relevant unknowns in missing_information. Keep the reason concise.',
      input: JSON.stringify(payload),
      text: { format: { type: 'json_schema', name: 'influencer_lead_fit', strict: true, schema: ANALYSIS_SCHEMA } }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, clean(data?.error?.message || `OpenAI request failed (${response.status}).`, 500));
  const outputText = responseOutputText(data);
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
  'POST /api/influencer-leads/discover': discoverInfluencers,
  'GET /api/influencer-leads/discover/runs': listDiscoveryRuns,
  'GET /api/influencer-leads/discover/runs/:id': getDiscoveryRun,
  'POST /api/influencer-leads/discover/runs/:id/cancel': cancelDiscoveryRun,
  'GET /api/influencer-leads/discovery-profiles': listDiscoveryProfiles,
  'POST /api/influencer-leads/discovery-profiles': createDiscoveryProfile,
  'PATCH /api/influencer-leads/discovery-profiles/:id': updateDiscoveryProfile,
  'DELETE /api/influencer-leads/discovery-profiles/:id': deleteDiscoveryProfile,
  'GET /api/influencer-leads/profile': getProfile,
  'PATCH /api/influencer-leads/profile': saveProfile,
  'GET /api/influencer-leads/settings': getAiSettings,
  'PATCH /api/influencer-leads/settings': saveAiSettings,
  'DELETE /api/influencer-leads/settings': deleteAiSettings,
  'PATCH /api/influencer-leads/:id': updateLead,
  'DELETE /api/influencer-leads/:id': deleteLead,
  'POST /api/influencer-leads/:id/notes': addNote,
  'DELETE /api/influencer-leads/:id/notes/:note': deleteNote,
  'POST /api/influencer-leads/:id/analyze': analyzeLead
};
