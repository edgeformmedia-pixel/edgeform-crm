import { json, HttpError, clean, now, readJson } from './lib.js';
import { requireUser } from './auth.js';

// Public website intake ("Let's talk" form, formVersion 2) plus the legacy
// website-only form, which has no leadId and keeps its insert-every-time behavior.

const MAX_BODY_BYTES = 64 * 1024; // browsers cap keepalive bodies at 64KB anyway
const MAX_DETAILS_BYTES = 16 * 1024;
const MAX_EXTRA_BYTES = 16 * 1024;
const MAX_SKETCH_BYTES = 5 * 1024 * 1024;
const LEAD_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const TYPE_RE = /^[a-z0-9_-]{1,32}$/;
export const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const ROSTER_STATUSES = ['applied', 'approved', 'declined'];

// Top-level keys stored in their own columns; anything else lands in `extra`.
const KNOWN_KEYS = new Set([
  'leadId', 'formVersion', 'source', 'inquiryType', 'inquiryLabel', 'status', 'autoSave', 'complete',
  'name', 'email', 'phone', 'phoneE164', 'phoneCountry', 'businessType', 'details', 'summary', 'hasSketch',
  'timestamp', 'pageUrl', 'referrer', 'utm', 'websiteDescription', 'description', 'hasWebsite', 'inputMode',
  'company', 'sketchUrl', 'sketchThumbUrl', 'migratedFrom', 'canvasImage'
]);

const dash = (s) => String(s || '').replace(/[-‐‑‒—−]/g, '–').trim();
const AUDIENCE_TIERS = { 'Under 5K': 1, '5K–25K': 2, '25K–100K': 3, '100K–500K': 4, '500K+': 5 };
const BUDGET_MAX_TIER = { 'Under $1K': 2, '$1K–$5K': 3, '$5K–$15K': 4, '$15K+': 5, 'Not sure yet': 5 };

const jsonText = (value, fallback, maxBytes) => {
  const text = JSON.stringify(value ?? fallback);
  if (text.length > maxBytes) throw new HttpError(413, 'Payload too large.');
  return text;
};
const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const cleanList = (v, max = 30) => (Array.isArray(v) ? v : []).map(x => clean(x, 80)).filter(Boolean).slice(0, max);
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Payload too large.');
  if (!text) throw new HttpError(400, 'Invalid JSON body.');
  try {
    const body = JSON.parse(text);
    if (!isPlainObject(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'Invalid JSON body.'); }
}

function normalize(body) {
  const inquiryType = TYPE_RE.test(String(body.inquiryType || '').toLowerCase()) ? String(body.inquiryType).toLowerCase() : 'website';
  const status = body.status === 'complete' || body.complete === true ? 'complete'
    : body.status === 'partial' || body.autoSave === true ? 'partial'
    : clean(body.status, 32) || 'new';
  const details = isPlainObject(body.details) ? body.details : {};
  const extra = Object.fromEntries(Object.entries(body).filter(([k]) => !KNOWN_KEYS.has(k)));
  return {
    leadId: body.leadId === undefined || body.leadId === null || body.leadId === '' ? null : String(body.leadId),
    formVersion: Number.isInteger(body.formVersion) ? body.formVersion : 1,
    source: clean(body.source, 80) || 'website',
    inquiryType,
    inquiryLabel: clean(body.inquiryLabel, 80),
    status,
    name: clean(body.name, 160),
    email: clean(body.email, 254).toLowerCase(),
    phone: clean(body.phone, 40),
    phoneE164: /^\+[1-9]\d{6,14}$/.test(clean(body.phoneE164, 20)) ? clean(body.phoneE164, 20) : '',
    phoneCountry: clean(body.phoneCountry, 8),
    company: clean(body.company || details.company, 200),
    businessType: clean(body.businessType, 160),
    hasWebsite: clean(body.hasWebsite, 24),
    // Only website leads have a real description; other types send `summary` here as a fallback we ignore.
    description: inquiryType === 'website' ? clean(body.websiteDescription || body.description, 4000) : '',
    inputMode: clean(body.inputMode, 32) || 'text',
    summary: clean(body.summary, 8000),
    details: jsonText(details, {}, MAX_DETAILS_BYTES),
    detailsObj: details,
    hasSketch: body.hasSketch === true,
    sketchUrl: clean(body.sketchUrl, 1000),
    sketchThumbUrl: clean(body.sketchThumbUrl, 1000),
    timestamp: clean(body.timestamp, 64),
    pageUrl: clean(body.pageUrl, 1000),
    referrer: clean(body.referrer, 1000),
    utm: jsonText(isPlainObject(body.utm) ? Object.fromEntries(Object.entries(body.utm).map(([k, v]) => [clean(k, 40), clean(v, 200)])) : {}, {}, 4096),
    extra: jsonText(extra, {}, MAX_EXTRA_BYTES),
    migratedFrom: body.migratedFrom || null
  };
}

const activity = (env, type, subjectId, summary) => env.DB.prepare(
  `INSERT INTO activities (id, created_at, actor, type, subject_type, subject_id, summary, metadata) VALUES (?, ?, 'system', ?, 'submission', ?, ?, '{}')`
).bind(crypto.randomUUID(), now(), type, subjectId, summary);

// Match on phoneE164 and/or email; create the contact only once the form is complete.
async function linkContact(env, s, create) {
  if (!s.phoneE164 && !s.email) return null;
  const found = await env.DB.prepare(
    `SELECT * FROM contacts WHERE (? <> '' AND phone_e164 = ?) OR (? <> '' AND email = ? COLLATE NOCASE)
     ORDER BY (phone_e164 = ? AND email = ? COLLATE NOCASE) DESC, created_at LIMIT 1`
  ).bind(s.phoneE164, s.phoneE164, s.email, s.email, s.phoneE164, s.email).first();
  if (found) {
    await env.DB.prepare(
      `UPDATE contacts SET updated_at = ?, email = COALESCE(NULLIF(email, ''), ?), phone = COALESCE(NULLIF(phone, ''), ?),
         phone_e164 = COALESCE(NULLIF(phone_e164, ''), ?), name = COALESCE(NULLIF(name, ''), ?) WHERE id = ?`
    ).bind(now(), s.email, s.phone, s.phoneE164, s.name, found.id).run();
    return found.id;
  }
  if (!create) return null;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO contacts (id, created_at, updated_at, name, email, phone, phone_e164, status, source, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, '{}')`
  ).bind(id, now(), now(), s.name, s.email, s.phone, s.phoneE164, `${s.source}:${s.inquiryType}`).run();
  return id;
}

async function syncCreator(env, s, submissionId, contactId) {
  if (s.inquiryType !== 'creator') {
    // They went back and picked a different inquiry type.
    await env.DB.prepare('DELETE FROM creators WHERE lead_id = ?').bind(s.leadId).run();
    return;
  }
  const d = s.detailsObj;
  const socials = isPlainObject(d.socials) ? d.socials : {};
  const audience = dash(d.audienceSize);
  await env.DB.prepare(
    `INSERT INTO creators (id, lead_id, submission_id, contact_id, created_at, updated_at, name, email, phone, phone_e164,
       instagram, tiktok, youtube, other_social, audience_size, audience_tier, niches, location, content_types, media_kit, consent, form_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lead_id) DO UPDATE SET updated_at = excluded.updated_at, contact_id = COALESCE(excluded.contact_id, creators.contact_id),
       name = excluded.name, email = excluded.email, phone = excluded.phone, phone_e164 = excluded.phone_e164,
       instagram = excluded.instagram, tiktok = excluded.tiktok, youtube = excluded.youtube, other_social = excluded.other_social,
       audience_size = excluded.audience_size, audience_tier = excluded.audience_tier, niches = excluded.niches,
       location = excluded.location, content_types = excluded.content_types, media_kit = excluded.media_kit,
       consent = excluded.consent, form_status = excluded.form_status`
  ).bind(
    crypto.randomUUID(), s.leadId, submissionId, contactId, now(), now(), s.name, s.email, s.phone, s.phoneE164,
    clean(socials.instagram, 200), clean(socials.tiktok, 200), clean(socials.youtube, 300), clean(socials.other, 300),
    audience, AUDIENCE_TIERS[audience] || 0, JSON.stringify(cleanList(d.niches)), clean(d.location, 160),
    JSON.stringify(cleanList(d.contentTypes)), clean(d.mediaKit, 1000), d.consent === true ? 1 : 0, s.status
  ).run();
}

function rowValues(s) {
  return [
    s.name, s.email, s.phone, s.company, s.businessType, s.hasWebsite, s.description, s.inputMode, s.status, s.source,
    s.formVersion, s.inquiryType, s.inquiryLabel, s.phoneE164, s.phoneCountry, s.summary, s.details, s.pageUrl, s.referrer, s.utm, s.extra
  ];
}

async function createSubmission(request, env, headers) {
  const s = normalize(await readBody(request));
  if (!s.name) throw new HttpError(400, 'Name is required.');

  if (s.leadId === null) {
    // Legacy form: unchanged insert-per-request behavior.
    const id = crypto.randomUUID();
    const createdAt = s.timestamp || now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO submissions
        (id, created_at, updated_at, name, email, phone, company, business_type, has_website, description, input_mode, sketch_url, sketch_thumb_url, status, source, metadata, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, createdAt, createdAt, s.name, s.email, s.phone, s.company, s.businessType, s.hasWebsite, s.description, s.inputMode,
          s.sketchUrl, s.sketchThumbUrl, s.status, s.source, JSON.stringify({ migratedFrom: s.migratedFrom, hasSketch: s.hasSketch }),
          s.status === 'complete' ? createdAt : null),
      activity(env, 'submission.created', id, `New submission from ${s.name}`)
    ]);
    return json({ ok: true, id, leadId: null, status: s.status, created: true }, 201, headers);
  }

  if (!LEAD_ID_RE.test(s.leadId)) throw new HttpError(400, 'leadId must be 8-64 letters, numbers, or dashes.');

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await env.DB.prepare('SELECT id, status, metadata, contact_id FROM submissions WHERE lead_id = ?').bind(s.leadId).first();

    if (!existing) {
      const id = crypto.randomUUID();
      const ts = now();
      const contactId = await linkContact(env, s, s.status === 'complete');
      try {
        await env.DB.prepare(`INSERT INTO submissions
          (id, lead_id, created_at, updated_at, name, email, phone, company, business_type, has_website, description, input_mode, status, source,
           form_version, inquiry_type, inquiry_label, phone_e164, phone_country, summary, details, page_url, referrer, utm, extra,
           metadata, contact_id, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, s.leadId, s.timestamp || ts, ts, ...rowValues(s), JSON.stringify({ hasSketch: s.hasSketch }), contactId,
            s.status === 'complete' ? ts : null).run();
      } catch (error) {
        if (/UNIQUE/i.test(error.message) && attempt === 0) continue; // partial and complete raced; update instead
        throw error;
      }
      await env.DB.batch([
        activity(env, 'submission.created', id, `New ${s.inquiryLabel || s.inquiryType} inquiry from ${s.name}`),
        ...(s.status === 'complete' ? [activity(env, 'submission.completed', id, `${s.name} completed the ${s.inquiryLabel || s.inquiryType} form`)] : [])
      ]);
      await syncCreator(env, s, id, contactId);
      return json({ ok: true, id, leadId: s.leadId, status: s.status, created: true }, 201, headers);
    }

    // A late partial (keepalive requests can arrive out of order) never downgrades a completed lead.
    if (existing.status === 'complete' && s.status !== 'complete') {
      return json({ ok: true, id: existing.id, leadId: s.leadId, status: 'complete', created: false, ignored: true }, 200, headers);
    }
    const completing = s.status === 'complete' && existing.status !== 'complete';
    const contactId = existing.contact_id || await linkContact(env, s, s.status === 'complete');
    const metadata = { ...parse(existing.metadata, {}), hasSketch: s.hasSketch || parse(existing.metadata, {}).hasSketch === true };
    const ts = now();
    await env.DB.batch([
      env.DB.prepare(`UPDATE submissions SET updated_at = ?, name = ?, email = ?, phone = ?, company = ?, business_type = ?, has_website = ?,
          description = ?, input_mode = ?, status = ?, source = ?, form_version = ?, inquiry_type = ?, inquiry_label = ?, phone_e164 = ?,
          phone_country = ?, summary = ?, details = ?, page_url = ?, referrer = ?, utm = ?, extra = ?, metadata = ?, contact_id = ?,
          completed_at = COALESCE(completed_at, ?)
        WHERE id = ?`)
        .bind(ts, ...rowValues(s), JSON.stringify(metadata), contactId, completing ? ts : null, existing.id),
      ...(completing ? [activity(env, 'submission.completed', existing.id, `${s.name} completed the ${s.inquiryLabel || s.inquiryType} form`)] : [])
    ]);
    await syncCreator(env, s, existing.id, contactId);
    return json({ ok: true, id: existing.id, leadId: s.leadId, status: s.status, created: false }, 200, headers);
  }
  throw new HttpError(409, 'Could not save this submission. Try again.');
}

function mapSubmission(row) {
  const metadata = parse(row.metadata, {});
  return {
    ID: row.id,
    'Lead ID': row.lead_id,
    Timestamp: row.created_at,
    Updated: row.updated_at,
    Completed: row.completed_at,
    Name: row.name,
    Email: row.email,
    Phone: row.phone,
    'Phone E164': row.phone_e164,
    'Phone Country': row.phone_country,
    Company: row.company,
    'Business Type': row.business_type,
    'Has Website': row.has_website,
    Description: row.description,
    Summary: row.summary,
    Details: parse(row.details, {}),
    'Inquiry Type': row.inquiry_type,
    'Inquiry Label': row.inquiry_label,
    Mode: row.input_mode,
    'Sketch URL': row.sketch_url,
    'Sketch Thumb URL': row.sketch_thumb_url,
    'Has Sketch': metadata.hasSketch === true,
    Status: row.status,
    Stage: row.stage,
    Source: row.source,
    'Form Version': row.form_version,
    'Page URL': row.page_url,
    Referrer: row.referrer,
    UTM: parse(row.utm, {}),
    Extra: parse(row.extra, {}),
    'Contact ID': row.contact_id,
    'Other Inquiries': row.other_inquiries || 0
  };
}

async function listSubmissions(request, env, headers) {
  await requireUser(request, env);
  const type = new URL(request.url).searchParams.get('type') || 'sales';
  const where = type === 'all' ? '1 = 1' : type === 'sales' ? "s.inquiry_type <> 'creator'" : 's.inquiry_type = ?';
  const result = await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM submissions o WHERE o.contact_id = s.contact_id AND o.id <> s.id) other_inquiries
     FROM submissions s WHERE ${where} ORDER BY s.created_at ASC LIMIT 2000`
  ).bind(...(type === 'all' || type === 'sales' ? [] : [type])).all();
  return json({ ok: true, rows: result.results.map(mapSubmission), total: result.results.length }, 200, headers);
}

async function updateSubmission(request, env, headers, [id]) {
  await requireUser(request, env);
  const body = await readJson(request);
  if (!STAGES.includes(body.stage)) throw new HttpError(400, `stage must be one of: ${STAGES.join(', ')}`);
  const result = await env.DB.prepare('UPDATE submissions SET stage = ?, updated_at = ? WHERE id = ?').bind(body.stage, now(), id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Submission not found.');
  return json({ ok: true }, 200, headers);
}

// ── Creator roster ────────────────────────────────────────────
function mapCreator(c) {
  return {
    id: c.id, leadId: c.lead_id, submissionId: c.submission_id, contactId: c.contact_id, createdAt: c.created_at, updatedAt: c.updated_at,
    name: c.name, email: c.email, phone: c.phone, phoneE164: c.phone_e164,
    socials: Object.fromEntries(Object.entries({ instagram: c.instagram, tiktok: c.tiktok, youtube: c.youtube, other: c.other_social }).filter(([, v]) => v)),
    audienceSize: c.audience_size, audienceTier: c.audience_tier, niches: parse(c.niches, []), location: c.location,
    contentTypes: parse(c.content_types, []), mediaKit: c.media_kit, consent: c.consent === 1,
    formStatus: c.form_status, rosterStatus: c.roster_status, notes: c.notes
  };
}

async function listCreators(request, env, headers) {
  await requireUser(request, env);
  const includePartial = new URL(request.url).searchParams.get('include') === 'partial';
  const result = await env.DB.prepare(
    `SELECT * FROM creators ${includePartial ? '' : "WHERE form_status = 'complete'"} ORDER BY created_at DESC LIMIT 2000`
  ).all();
  return json({ ok: true, creators: result.results.map(mapCreator) }, 200, headers);
}

async function updateCreator(request, env, headers, [id]) {
  await requireUser(request, env);
  const body = await readJson(request);
  const sets = [], values = [];
  if (body.rosterStatus !== undefined) {
    if (!ROSTER_STATUSES.includes(body.rosterStatus)) throw new HttpError(400, `rosterStatus must be one of: ${ROSTER_STATUSES.join(', ')}`);
    sets.push('roster_status = ?'); values.push(body.rosterStatus);
  }
  if (body.notes !== undefined) { sets.push('notes = ?'); values.push(clean(body.notes, 4000)); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  const result = await env.DB.prepare(`UPDATE creators SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...values, now(), id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Creator not found.');
  return json({ ok: true }, 200, headers);
}

// ── Sponsor ↔ creator matching ────────────────────────────────
const STATES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de',
  florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky',
  louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo',
  montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri',
  'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va',
  washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy', 'district of columbia': 'dc'
};
const CODES = new Set(Object.values(STATES));

function place(text) {
  const lower = String(text || '').toLowerCase().trim();
  const parts = lower.split(',').map(p => p.replace(/[^a-z ]/g, '').trim()).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  let state = CODES.has(last) ? last : STATES[last] || '';
  if (!state) state = STATES[Object.keys(STATES).find(n => new RegExp(`\\b${n}\\b`).test(lower))] || '';
  const first = parts[0] || '';
  const city = parts.length > 1 || (!CODES.has(first) && !STATES[first]) ? first : '';
  return { city, state, lower };
}

const NICHE_KEYWORDS = {
  'Lifestyle': /lifestyle|everyday|millennial|gen ?z/,
  'Food & drink': /food|restaurant|cafe|coffee|bar\b|brew|bakery|drink|kitchen|catering|dining/,
  'Fitness & health': /fitness|gym|health|wellness|yoga|pilates|nutrition|medical|clinic|dental|chiro|supplement/,
  'Beauty & fashion': /beauty|salon|spa|skin|cosmetic|fashion|boutique|apparel|clothing|hair|nail|barber/,
  'Home & family': /home|family|parent|mom|kids|child|real estate|realtor|interior|furniture|pet/,
  'Business & finance': /business|finance|financial|insurance|b2b|entrepreneur|accounting|law|legal|invest|mortgage/,
  'Tech': /tech|software|app\b|saas|gadget|electronics|ai\b/,
  'Travel': /travel|hotel|resort|tour|vacation|airbnb/,
  'Local / city': /local|neighborhood|community|city|downtown/,
  'Automotive': /auto|car\b|cars\b|dealer|detailing|mechanic|tire|vehicle/,
  'Gaming': /gam(e|ing)|esports|twitch/
};
const PLATFORM_KEYS = { Instagram: 'instagram', TikTok: 'tiktok', YouTube: 'youtube' };
const GOAL_CONTENT = {
  'Brand awareness': ['Sponsored posts', 'Short-form video', 'Stories', 'Long-form / YouTube'],
  'Product launch': ['Sponsored posts', 'Short-form video', 'Reviews', 'Long-form / YouTube'],
  'Foot traffic': ['Live & in-person events', 'Stories', 'Short-form video'],
  'Online sales': ['Sponsored posts', 'Reviews', 'Short-form video'],
  'Sign-ups / app installs': ['Sponsored posts', 'Short-form video', 'Long-form / YouTube'],
  'Event promotion': ['Live & in-person events', 'Stories', 'Sponsored posts'],
  'Content for our own ads': ['UGC (no posting)', 'Short-form video']
};

export function scoreCreator(sponsor, creator) {
  const d = sponsor.details;
  const reasons = [];
  let score = 0;

  // Niche (35): explicit sponsor niches if the form sends them, otherwise keywords from what they told us.
  const sponsorNiches = cleanList(d.niches);
  const text = `${sponsor.businessType} ${d.targetAudience || ''} ${d.notes || ''} ${d.market || ''}`.toLowerCase();
  const wanted = sponsorNiches.length ? sponsorNiches : Object.keys(NICHE_KEYWORDS).filter(n => NICHE_KEYWORDS[n].test(text));
  if (wanted.length) {
    const hits = creator.niches.filter(n => wanted.includes(n));
    if (hits.length) { score += Math.round(35 * Math.min(1, hits.length / Math.min(wanted.length, 2))); reasons.push(`Niche: ${hits.join(', ')}`); }
  } else {
    score += 15;
  }

  // Location (25)
  const market = String(d.market || '').trim();
  if (!market || /nation|national|nationwide|anywhere|online|usa?\b|united states/i.test(market)) {
    score += market ? 20 : 12;
  } else {
    const m = place(market), c = place(creator.location);
    if (c.city && (m.lower.includes(c.city) || (m.city && c.lower.includes(m.city)))) { score += 25; reasons.push(`Located in ${creator.location}`); }
    else if (m.state && m.state === c.state) { score += 15; reasons.push(`Same state (${c.state.toUpperCase()})`); }
  }

  // Platforms (20)
  const platforms = cleanList(d.platforms).filter(p => p !== 'No preference');
  const has = Object.keys(creator.socials);
  if (!platforms.length) {
    if (has.length) score += 20;
  } else {
    const hits = platforms.filter(p => has.includes(PLATFORM_KEYS[p]));
    if (hits.length) { score += Math.round(20 * hits.length / platforms.length); reasons.push(`On ${hits.join(', ')}`); }
  }

  // Budget vs audience size (10)
  const maxTier = BUDGET_MAX_TIER[dash(d.budget)] || 5;
  if (creator.audienceTier && creator.audienceTier <= maxTier) { score += 10; reasons.push(`${creator.audienceSize} audience fits budget`); }
  else if (creator.audienceTier === maxTier + 1) score += 4;

  // Goals vs content types (10)
  const goals = cleanList(d.goals);
  const suited = new Set(goals.flatMap(g => GOAL_CONTENT[g] || []));
  const contentHits = creator.contentTypes.filter(t => suited.has(t));
  if (contentHits.length) { score += 10; reasons.push(`Does ${contentHits.slice(0, 3).join(', ')}`); }
  else if (!suited.size) score += 5;

  return { score, reasons };
}

async function matchCreators(request, env, headers, [id]) {
  await requireUser(request, env);
  const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Submission not found.');
  if (row.inquiry_type !== 'sponsor') throw new HttpError(400, 'Matching is only available for influencer requests.');
  const sponsor = { businessType: row.business_type, details: parse(row.details, {}) };
  const creators = await env.DB.prepare(
    `SELECT * FROM creators WHERE form_status = 'complete' AND consent = 1 AND roster_status <> 'declined'`
  ).all();
  const matches = creators.results.map(mapCreator)
    .map(c => ({ creator: c, ...scoreCreator(sponsor, c) }))
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score || (b.creator.rosterStatus === 'approved') - (a.creator.rosterStatus === 'approved'))
    .slice(0, 25);
  return json({ ok: true, matches }, 200, headers);
}

// ── Website sketches (replaces the Google Drive bridge) ───────
async function uploadSketch(request, env, headers, [leadId]) {
  if (!LEAD_ID_RE.test(leadId)) throw new HttpError(400, 'Invalid leadId.');
  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new HttpError(415, 'Send the image as image/png, image/jpeg, or image/webp.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_SKETCH_BYTES) throw new HttpError(413, 'Sketch must be 5MB or smaller.');
  const row = await env.DB.prepare('SELECT id, metadata FROM submissions WHERE lead_id = ?').bind(leadId).first();
  if (!row) throw new HttpError(404, 'Unknown leadId. Send the submission first.');
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new HttpError(400, 'Empty image.');
  if (bytes.byteLength > MAX_SKETCH_BYTES) throw new HttpError(413, 'Sketch must be 5MB or smaller.');

  await env.SKETCHES.put(`sketches/${row.id}`, bytes, { httpMetadata: { contentType: type } });
  const url = `${new URL(request.url).origin}/api/sketches/${row.id}`;
  const metadata = { ...parse(row.metadata, {}), hasSketch: true };
  await env.DB.prepare('UPDATE submissions SET sketch_url = ?, sketch_thumb_url = ?, metadata = ?, updated_at = ? WHERE id = ?')
    .bind(url, url, JSON.stringify(metadata), now(), row.id).run();
  return json({ ok: true, sketchUrl: url }, 201, headers);
}

async function getSketch(request, env, headers, [id]) {
  const object = await env.SKETCHES.get(`sketches/${clean(id, 64)}`);
  if (!object) return new Response('Not found', { status: 404, headers });
  return new Response(object.body, {
    headers: { ...headers, 'content-type': object.httpMetadata?.contentType || 'image/png', 'cache-control': 'private, max-age=3600' }
  });
}

export const intakeRoutes = {
  'POST /api/submissions': createSubmission,
  'GET /api/submissions': listSubmissions,
  'PATCH /api/submissions/:id': updateSubmission,
  'GET /api/submissions/:id/matches': matchCreators,
  'POST /api/submissions/:lead/sketch': uploadSketch,
  'GET /api/sketches/:id': getSketch,
  'GET /api/creators': listCreators,
  'PATCH /api/creators/:id': updateCreator
};
