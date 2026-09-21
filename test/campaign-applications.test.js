import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { campaignRoutes } from '../worker/campaigns.js';
import { publicFetch } from '../worker/public-campaigns.js';
import { affiliateFetch } from '../worker/affiliate.js';
import { sha256 } from '../worker/lib.js';
import {
  applicationState, normalizeRefCode, newRefCode, framingAllowed, readQuestions, DEFAULT_QUESTIONS, slugify
} from '../worker/applications-lib.js';
import { payExplainer, payExplainerText, platformList } from '../worker/pay-explainer.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
const needsSqlite = { skip: DatabaseSync ? false : 'node:sqlite is unavailable in this Node version' };

// ── Pure helpers ──

test('ref codes: 8 chars, Crockford base32 with no vowels; typos normalize', () => {
  for (let i = 0; i < 200; i++) assert.match(newRefCode(), /^[0-9BCDFGHJKMNPQRSTVWXYZ]{8}$/);
  assert.equal(normalizeRefCode('bcd-fgh-jk'), 'BCDFGHJK');
  assert.equal(normalizeRefCode(' 0o1il234 '), '00111234');   // O→0, I/L→1, as Crockford reads them
  assert.equal(normalizeRefCode('ABCDEFGH'), null);            // vowels never appear in a code
  assert.equal(normalizeRefCode('SHORT'), null);
  assert.equal(normalizeRefCode(null), null);
});

test('page state: disabled/draft/ended are 404, paused/closed/full are 410', () => {
  const base = { application_enabled: 1, public_slug: 'spring', status: 'active', application_closes_at: null, application_seats: null };
  assert.equal(applicationState(base, 0, '2026-09-20'), 'open');
  assert.equal(applicationState({ ...base, application_enabled: 0 }, 0), 'not_found');
  assert.equal(applicationState({ ...base, public_slug: null }, 0), 'not_found');
  assert.equal(applicationState({ ...base, status: 'draft' }, 0), 'not_found');
  assert.equal(applicationState({ ...base, status: 'ended' }, 0), 'not_found');
  assert.equal(applicationState({ ...base, status: 'paused' }, 0), 'closed');
  assert.equal(applicationState({ ...base, application_closes_at: '2026-09-20' }, 0, '2026-09-20'), 'open');   // inclusive
  assert.equal(applicationState({ ...base, application_closes_at: '2026-09-19' }, 0, '2026-09-20'), 'closed');
  assert.equal(applicationState({ ...base, application_seats: 3 }, 2), 'open');
  assert.equal(applicationState({ ...base, application_seats: 3 }, 3), 'closed');
  assert.equal(applicationState(null, 0), 'not_found');
});

test('framing check reads X-Frame-Options and CSP frame-ancestors like a browser', () => {
  const h = (o) => new Headers(o);
  assert.equal(framingAllowed(h({})), true);
  assert.equal(framingAllowed(h({ 'x-frame-options': 'DENY' })), false);
  assert.equal(framingAllowed(h({ 'x-frame-options': 'sameorigin' })), false);
  assert.equal(framingAllowed(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })), false);
  assert.equal(framingAllowed(h({ 'content-security-policy': "frame-ancestors 'self'" })), false);
  assert.equal(framingAllowed(h({ 'content-security-policy': 'frame-ancestors *' })), true);
  assert.equal(framingAllowed(h({ 'content-security-policy': 'frame-ancestors https://*.edgeformmarketing.com' })), true);
  assert.equal(framingAllowed(h({ 'content-security-policy': 'frame-ancestors https://affiliate.edgeformmarketing.com/' })), true);
  assert.equal(framingAllowed(h({ 'content-security-policy': 'frame-ancestors https://other.com' })), false);
  // CSP wins over X-Frame-Options when both are sent.
  assert.equal(framingAllowed(h({ 'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors *' })), true);
});

test('questions: the default pack is valid; bad ones are refused', () => {
  assert.deepEqual(readQuestions(DEFAULT_QUESTIONS), DEFAULT_QUESTIONS);
  assert.throws(() => readQuestions([{ id: 'Bad Id', label: 'x', type: 'short_text' }]), /id/);
  assert.throws(() => readQuestions([{ id: 'a', label: 'x', type: 'select', options: ['only one'] }]), /options/);
  assert.throws(() => readQuestions([{ id: 'a', label: 'x', type: 'essay' }]), /type/);
  assert.throws(() => readQuestions(Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, label: 'x', type: 'boolean' }))), /10/);
  assert.throws(() => readQuestions([{ id: 'a', label: 'x', type: 'boolean' }, { id: 'a', label: 'y', type: 'boolean' }]), /use the id/);
});

test('the migration seeds the same default questions the code uses', () => {
  const sql = readFileSync(new URL('../migrations/0025_campaign_applications.sql', import.meta.url), 'utf8');
  const seeded = JSON.parse(sql.match(/application_questions = '(\[.*\])'\n/)[1].replace(/''/g, "'"));
  assert.deepEqual(seeded, DEFAULT_QUESTIONS);
});

test('pay explainer renders the §9 words from the variables', () => {
  assert.equal(platformList(['tiktok', 'instagram', 'youtube']), 'TikTok, Instagram or YouTube');
  assert.equal(platformList(['tiktok', 'youtube']), 'TikTok or YouTube');
  assert.equal(platformList(['instagram']), 'Instagram');
  const c = { name: 'Spring', brand_name: 'Glow', platforms_allowed: ['tiktok', 'instagram'], starting_cpm_rate_cents: 150, team_bonus_bps: 500 };
  const text = payExplainerText(c);
  assert.match(text, /^How you get paid\nYou post about Glow on TikTok or Instagram\. Every Sunday/);
  assert.match(text, /you're paid \$1\.50 for every 1,000 of them/);
  assert.match(text, /\$1\.50 per 1,000 views is where everyone starts\. As your videos deliver/);
  assert.match(text, /earn a 5% team bonus on what they're paid/);
  assert.equal(payExplainer({ ...c, brand_name: '' })[0].body.startsWith('You post about Spring'), true);
  assert.match(payExplainerText({ ...c, team_bonus_bps: 550 }), /5\.5% team bonus/);
  assert.equal(payExplainer({ ...c, team_bonus_bps: 0 }).length, 2);
  for (const banned of [/pyramid/i, /downline/i, /recruit/i, /passive income/i, /unlimited earnings/i]) assert.doesNotMatch(text, banned);
});

test('slugs come from the campaign name', () => {
  assert.equal(slugify('Spring Launch — TikTok!'), 'spring-launch-tiktok');
  assert.equal(slugify('Café Crème'), 'cafe-creme');
  assert.equal(slugify('AB'), 'ab-campaign');
});

// ── Against a real schema (every migration, in node:sqlite) ──

function harness() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).sort()) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    now: () => ({ results: sqlite.prepare(sql).all(...args) })
  });
  // D1 runs a batch as one transaction, so this does too: a failed statement rolls back the rest.
  const DB = {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      sqlite.exec('BEGIN');
      try {
        const out = statements.map(s => s.now());
        sqlite.exec('COMMIT');
        return out;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };

  const insert = (table, row) => {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    for (const c of columns) if (!(c.name in row) && c.notnull && c.dflt_value == null && !c.pk) row[c.name] = c.name.endsWith('_at') ? new Date().toISOString() : `${c.name}-x`;
    const keys = Object.keys(row).filter(k => columns.some(c => c.name === k));
    sqlite.prepare(`INSERT INTO ${table} (${keys}) VALUES (${keys.map(() => '?')})`).run(...keys.map(k => row[k]));
    return row;
  };
  insert('users', { id: 'u1', email: 'staff@example.com', name: 'Staff', verified: 1, role: 'admin', created_at: new Date().toISOString() });
  insert('operations', { id: 'op1', type: 'marketing', name: 'Glow', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

  const env = { DB, AFFILIATE_ENCRYPTION_KEY: 'test-key' };
  const staffToken = 'staff-token';
  const ready = sha256(staffToken).then(hash => sqlite.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(hash, 'u1', new Date().toISOString(), '2099-01-01T00:00:00Z'));

  const admin = async (key, { body, params = [], query = '' } = {}) => {
    await ready;
    const request = new Request('https://api.test/x' + query, {
      method: key.split(' ')[0], headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    });
    try {
      const response = await campaignRoutes[key](request, env, {}, params);
      return { status: response.status, ...(await response.json()) };
    } catch (error) { return { status: error.status || 500, error: error.message }; }
  };
  const pub = async (method, path, { body, ip = '203.0.113.1' } = {}) => {
    const request = new Request('https://api.test/api/public/v1' + path, {
      method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: body ? JSON.stringify(body) : undefined
    });
    const response = await publicFetch(request, env, {});
    const json = await response.json();
    // `status` is the HTTP status here; the body's own `status` ("received") stays in `body`.
    return { ...json, status: response.status, body: json };
  };
  const creator = (id, fields = {}) => insert('creators', { id, name: fields.name || id, email: fields.email || `${id}@example.com`, source: 'manual', ...fields });
  const assign = (id, campaignId, creatorId, fields = {}) => insert('campaign_affiliates', {
    id, campaign_id: campaignId, creator_id: creatorId, status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...fields
  });
  const row = (sql, ...args) => sqlite.prepare(sql).get(...args);
  const rows = (sql, ...args) => sqlite.prepare(sql).all(...args);
  return { sqlite, env, admin, pub, creator, assign, row, rows };
}

async function liveCampaign(h, extra = {}) {
  const created = await h.admin('POST /api/operations/:id/campaigns', {
    params: ['op1'],
    body: {
      name: 'Glow Spring', status: 'active', brief: 'SECRET BRIEF: client is Acme, never say "cheap"', defaultCpmRateCents: 150, defaultOverrideBps: 500,
      totalBudgetCents: 999900, maxPayoutPerVideoCents: 5000, platformsAllowed: ['tiktok', 'instagram'],
      applicationEnabled: true, publicHeadline: 'Post about Glow', publicPitch: 'Glow is a skincare app.', brandName: 'Glow', ...extra
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created));
  return created.campaign;
}

const application = (fields = {}) => ({
  name: 'Ava Makes', email: 'ava@example.com', phone: '(555) 123-4567', country: 'US',
  instagram: '', tiktok: '@ava.makes', youtube: '', portfolio_url: '',
  platforms: ['tiktok'], audience_size: '5k_25k', posting_cadence: '3_5_week', niches: ['beauty'],
  why: 'I love it', answers: { fit: 'A before/after routine', start_when: 'This week' },
  consent: true, age_confirmed: true, ref_code: null, utm: { utm_source: 'tiktok' }, page_url: 'https://affiliate.edgeformmarketing.com/apply.html?c=glow-spring', referrer: '',
  ...fields
});

test('a new campaign gets a slug when its page is turned on, and the default questions', needsSqlite, async () => {
  const h = harness();
  const c = await liveCampaign(h);
  assert.equal(c.publicSlug, 'glow-spring');
  assert.equal(c.publicUrl, 'https://affiliate.edgeformmarketing.com/apply.html?c=glow-spring');
  assert.deepEqual(c.applicationQuestions, DEFAULT_QUESTIONS);
  assert.deepEqual(c.applicationCounts, { new: 0, reviewing: 0, approved: 0, declined: 0 });
  // A second campaign with the same name gets its own link; picking a taken one is a 409.
  const second = await liveCampaign(h);
  assert.equal(second.publicSlug, 'glow-spring-2');
  const taken = await h.admin('PATCH /api/campaigns/:id', { params: [second.id], body: { publicSlug: 'glow-spring' } });
  assert.equal(taken.status, 409);
  assert.equal((await h.admin('PATCH /api/campaigns/:id', { params: [second.id], body: { publicSlug: 'Bad Slug!' } })).status, 400);
  assert.equal((await h.admin('PATCH /api/campaigns/:id', { params: [second.id], body: { promoUrl: 'http://insecure.example.com' } })).status, 400);
});

test('the public GET is an allow-list: no brief, budgets, caps or affiliate data', needsSqlite, async () => {
  const h = harness();
  const c = await liveCampaign(h);
  h.creator('cr-ref', { name: 'Maya Lopez', ref_code: 'BCDFGHJK', email: 'maya@example.com' });
  h.assign('ca-ref', c.id, 'cr-ref');
  const res = await h.pub('GET', '/campaigns/glow-spring?ref=bcdfghjk');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.campaign).sort(), [
    'brand_name', 'closes_at', 'currency', 'end_date', 'example_videos', 'headline', 'min_views_to_qualify', 'name', 'pitch',
    'platforms_allowed', 'promo_embed', 'promo_image_url', 'promo_url', 'questions', 'ref_code', 'referrer_first_name',
    'requires_video_approval', 'slug', 'start_date', 'starting_cpm_rate_cents', 'status', 'team_bonus_bps'
  ]);
  const text = JSON.stringify(res);
  for (const secret of ['SECRET', 'Acme', '999900', '5000', 'budget', 'brief', 'funded_by', 'maya@example.com', 'Lopez']) assert.ok(!text.includes(secret), secret);
  assert.equal(res.campaign.referrer_first_name, 'Maya');
  assert.equal(res.campaign.ref_code, 'BCDFGHJK');
  assert.equal(res.campaign.starting_cpm_rate_cents, 150);
  assert.equal(res.campaign.team_bonus_bps, 500);
  // A code that doesn't match anyone is ignored, not an error.
  const bad = await h.pub('GET', '/campaigns/glow-spring?ref=ZZZZZZZZ');
  assert.equal(bad.status, 200);
  assert.equal(bad.campaign.referrer_first_name, null);
  assert.equal(bad.campaign.ref_code, null);
});

test('404 for unknown, disabled, draft and ended pages; 410 for paused, closed and full ones', needsSqlite, async () => {
  const h = harness();
  const c = await liveCampaign(h);
  const status = async () => (await h.pub('GET', '/campaigns/glow-spring')).status;
  const post = async (email) => (await h.pub('POST', '/campaigns/glow-spring/applications', { body: application({ email }), ip: email })).status;
  const patch = (body) => h.admin('PATCH /api/campaigns/:id', { params: [c.id], body });

  assert.equal((await h.pub('GET', '/campaigns/nope')).status, 404);
  assert.equal((await h.pub('GET', '/campaigns/nope')).code, 'not_found');
  await patch({ applicationEnabled: false }); assert.equal(await status(), 404);
  await patch({ applicationEnabled: true, status: 'draft' }); assert.equal(await status(), 404);
  await patch({ status: 'paused' });
  assert.equal(await status(), 410);
  assert.equal((await h.pub('GET', '/campaigns/glow-spring')).code, 'applications_closed');
  assert.equal(await post('paused@example.com'), 410);
  await patch({ status: 'active', applicationClosesAt: '2020-01-01' }); assert.equal(await status(), 410);
  await patch({ applicationClosesAt: null, applicationSeats: 1 }); assert.equal(await status(), 200);

  // Seats count approvals, not applications.
  assert.equal(await post('one@example.com'), 201);
  assert.equal(await post('two@example.com'), 201);
  assert.equal(await status(), 200);
  const [first] = (await h.admin('GET /api/campaigns/:id/applications', { params: [c.id] })).applications;
  assert.equal((await h.admin('POST /api/campaign-applications/:id/approve', { params: [first.id], body: {} })).status, 201);
  assert.equal(await status(), 410);
  assert.equal(await post('three@example.com'), 410);

  await patch({ status: 'ended' }); assert.equal(await status(), 404);
});

test('submissions: 201 with nothing else, strict validation, already_applied, rate limits', needsSqlite, async () => {
  const h = harness();
  const c = await liveCampaign(h);
  const submit = (body, ip) => h.pub('POST', '/campaigns/glow-spring/applications', { body, ip });

  const ok = await submit(application(), '198.51.100.1');
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body, { ok: true, status: 'received' });

  const stored = h.row('SELECT * FROM campaign_applications WHERE email = ?', 'ava@example.com');
  assert.equal(stored.status, 'new');
  assert.equal(stored.phone_e164, '+15551234567');
  assert.notEqual(stored.ip_hash, '198.51.100.1');
  assert.equal(stored.ip_hash, await sha256('198.51.100.1' + 'test-key'));
  assert.ok(!JSON.stringify(stored).includes('198.51.100.1'));
  // Applications aren't creators.
  assert.equal(h.row('SELECT COUNT(*) n FROM creators').n, 0);

  // Same email, any case, any outcome → already_applied, worded the same.
  const again = await submit(application({ email: 'AVA@Example.com' }), '198.51.100.2');
  assert.equal(again.status, 409);
  assert.equal(again.code, 'already_applied');
  await h.admin('PATCH /api/campaign-applications/:id', { params: [stored.id], body: { status: 'declined' } });
  const afterDecline = await submit(application(), '198.51.100.3');
  assert.equal(afterDecline.error, again.error);

  const bad = async (fields, pattern) => {
    const res = await submit(application({ email: `v${Math.random()}@example.com`, ...fields }), '198.51.100.9' + Math.random());
    assert.equal(res.status, 400, JSON.stringify(fields));
    assert.equal(res.code, 'validation_error');
    if (pattern) assert.match(res.error, pattern);
  };
  await bad({ is_admin: true }, /Unknown field/);
  await bad({ tiktok: '', instagram: '', youtube: '' }, /at least one/);
  await bad({ platforms: [] }, /platform/);
  await bad({ platforms: ['youtube'] }, /doesn’t take/);         // not in this campaign's platforms_allowed
  await bad({ consent: false }, /agree/);
  await bad({ age_confirmed: false }, /18/);
  await bad({ answers: { start_when: 'This week' } }, /first video/);   // required question missing
  await bad({ answers: { fit: 'x', start_when: 'Tomorrow' } }, /options/);
  await bad({ answers: { fit: 'x', start_when: 'This week', surprise: 1 } }, /Unknown question/);
  await bad({ answers: { fit: 'x', start_when: 'This week', best_video: 'javascript:alert(1)' } }, /https/);
  await bad({ why: 'x'.repeat(1001) }, /too long/);
  await bad({ audience_size: 'huge' });

  // Five per IP per hour.
  for (let i = 0; i < 4; i++) assert.equal((await submit(application({ email: `ip${i}@example.com` }), '192.0.2.50')).status, 201);
  assert.equal((await submit(application({ email: 'ip4@example.com' }), '192.0.2.50')).status, 201);
  const limited = await submit(application({ email: 'ip5@example.com' }), '192.0.2.50');
  assert.equal(limited.status, 429);
  assert.equal(limited.code, 'rate_limited');

  // Three per email per hour, across campaigns.
  const others = [await liveCampaign(h, { name: 'B' }), await liveCampaign(h, { name: 'Cc' }), await liveCampaign(h, { name: 'Dd' })];
  const same = (slug, ip) => h.pub('POST', `/campaigns/${slug}/applications`, { body: application({ email: 'busy@example.com' }), ip });
  assert.equal((await same('glow-spring', '10.0.0.1')).status, 201);
  assert.equal((await same(others[0].publicSlug, '10.0.0.2')).status, 201);
  assert.equal((await same(others[1].publicSlug, '10.0.0.3')).status, 201);
  assert.equal((await same(others[2].publicSlug, '10.0.0.4')).status, 429);
  assert.ok(c.id);
});

test('approval: creates the creator, derives the upline through a two-level chain, and survives a double-click', needsSqlite, async () => {
  const h = harness();
  const c = await liveCampaign(h);
  // Top is on the campaign. Mid was referred by Top but isn't on it. Mid's link brings in Ava.
  h.creator('cr-top', { name: 'Tess Top', ref_code: 'TTTTTTTT' });
  h.creator('cr-mid', { name: 'Mo Mid', ref_code: 'MMMMMMMM', referred_by_creator_id: 'cr-top' });
  h.assign('ca-top', c.id, 'cr-top');
  const other = await liveCampaign(h, { name: 'Other' });
  h.assign('ca-mid-other', other.id, 'cr-mid');   // Mid is live (on some campaign), so the code counts

  assert.equal((await h.pub('POST', '/campaigns/glow-spring/applications', { body: application({ ref_code: 'mmmmmmmm' }) })).status, 201);
  const [app] = (await h.admin('GET /api/campaigns/:id/applications', { params: [c.id] })).applications;
  assert.equal(app.referredByCreatorId, 'cr-mid');
  assert.equal(app.referredByName, 'Mo Mid');
  assert.equal(app.suggestedUplineId, 'ca-top');
  assert.equal(app.suggestedUplineName, 'Tess Top');
  assert.equal(app.answers.fit, 'A before/after routine');

  // Two clicks at once, then a third later.
  const [a, b] = await Promise.all([
    h.admin('POST /api/campaign-applications/:id/approve', { params: [app.id], body: {} }),
    h.admin('POST /api/campaign-applications/:id/approve', { params: [app.id], body: {} })
  ]);
  const later = await h.admin('POST /api/campaign-applications/:id/approve', { params: [app.id], body: {} });
  for (const r of [a, b, later]) assert.ok([200, 201].includes(r.status), JSON.stringify(r));
  assert.equal(h.row("SELECT COUNT(*) n FROM creators WHERE email = 'ava@example.com'").n, 1);
  assert.equal(h.row('SELECT COUNT(*) n FROM campaign_affiliates WHERE campaign_id = ?', c.id).n, 2);   // Top + Ava

  const creator = h.row("SELECT * FROM creators WHERE email = 'ava@example.com'");
  assert.equal(creator.source, 'campaign_application');
  assert.equal(creator.roster_status, 'approved');
  assert.equal(creator.referred_by_creator_id, 'cr-mid');   // company-wide: who actually brought them in
  assert.ok(creator.referred_at);
  assert.match(creator.ref_code, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{8}$/);
  assert.equal(creator.audience_size, '5K–25K');

  const affiliate = h.row('SELECT * FROM campaign_affiliates WHERE creator_id = ?', creator.id);
  assert.equal(affiliate.upline_id, 'ca-top');              // per campaign: the first one up the chain who's on it
  assert.equal(affiliate.status, 'invited');
  assert.equal(affiliate.rank, 'rookie');
  assert.equal(affiliate.cpm_rate_override_cents, null);    // starts on exactly the advertised rate

  const result = a.status === 201 ? a : b;
  assert.equal(result.application.status, 'approved');
  assert.equal(result.creator.created, true);
  assert.equal(result.inviteSent, false);                   // no mail transport in tests…
  assert.ok(result.inviteError);                            // …and the approval stands anyway
  const actions = h.rows('SELECT action FROM affiliate_audit_log ORDER BY created_at').map(r => r.action);
  assert.equal(actions.filter(x => x === 'application_approved').length, 1);
  assert.ok(actions.includes('affiliate_added'));

  // Mid still isn't on the campaign — referrers are never auto-added.
  assert.equal(h.row("SELECT COUNT(*) n FROM campaign_affiliates WHERE creator_id = 'cr-mid' AND campaign_id = ?", c.id).n, 0);
});

test('approval matches an existing creator, fills only blank handles, and never rewrites their referrer', needsSqlite, async () => {
  const h = harness();
  const c = await liveCampaign(h);
  h.creator('cr-first', { name: 'First Referrer', ref_code: 'FFFFFFFF' });
  h.creator('cr-second', { name: 'Second Referrer', ref_code: 'SSSSSSSS' });
  h.assign('ca-second', c.id, 'cr-second');
  h.creator('cr-ava', { name: 'Ava Existing', email: 'ava@example.com', instagram: '@ava.ig', tiktok: '', referred_by_creator_id: 'cr-first' });

  await h.pub('POST', '/campaigns/glow-spring/applications', { body: application({ instagram: '@someone.else', ref_code: 'SSSSSSSS' }) });
  const [app] = (await h.admin('GET /api/campaigns/:id/applications', { params: [c.id] })).applications;
  const res = await h.admin('POST /api/campaign-applications/:id/approve', { params: [app.id], body: { cpmRateOverrideCents: 200, uplineId: null, sendInvite: false } });
  assert.equal(res.status, 201, JSON.stringify(res));
  assert.equal(res.creator.created, false);
  assert.equal(res.inviteSent, false);
  assert.equal(res.inviteError, null);

  const ava = h.row("SELECT * FROM creators WHERE id = 'cr-ava'");
  assert.equal(ava.instagram, '@ava.ig');                     // filled already: kept
  assert.equal(ava.tiktok, '@ava.makes');                     // blank: filled
  assert.equal(ava.referred_by_creator_id, 'cr-first');       // set once, never overwritten
  assert.ok(ava.ref_code);
  const affiliate = h.row("SELECT * FROM campaign_affiliates WHERE creator_id = 'cr-ava'");
  assert.equal(affiliate.cpm_rate_override_cents, 200);       // staff typed a rate at approval
  assert.equal(affiliate.upline_id, null);                    // staff chose no upline
  assert.equal(h.row('SELECT COUNT(*) n FROM creators').n, 3);
});

test('decline keeps the reason staff-only and a declined application can’t be approved-by-PATCH', needsSqlite, async () => {
  const h = harness();
  const c = await liveCampaign(h);
  await h.pub('POST', '/campaigns/glow-spring/applications', { body: application() });
  const [app] = (await h.admin('GET /api/campaigns/:id/applications', { params: [c.id] })).applications;
  const declined = await h.admin('PATCH /api/campaign-applications/:id', { params: [app.id], body: { status: 'declined', declineReason: 'Audience too small', reviewNotes: 'maybe later' } });
  assert.equal(declined.status, 200);
  assert.equal(declined.application.status, 'declined');
  assert.equal(declined.application.reviewedBy, 'u1');
  assert.equal((await h.admin('PATCH /api/campaign-applications/:id', { params: [app.id], body: { status: 'approved' } })).status, 400);
  assert.equal((await h.admin('GET /api/campaigns/:id', { params: [c.id] })).campaign.applicationCounts.declined, 1);
});

test('example videos: parsed like submissions, capped at 6, and never touch `videos`', needsSqlite, async () => {
  const h = harness();
  const c = await liveCampaign(h);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ thumbnail_url: 'https://p16.tiktokcdn.com/thumb.jpg' }));
  try {
    const add = (url) => h.admin('POST /api/campaigns/:id/example-videos', { params: [c.id], body: { url, caption: 'Nice hook' } });
    const yt = await add('https://youtu.be/dQw4w9WgXcQ');
    assert.equal(yt.status, 201);
    assert.equal(yt.exampleVideo.embedUrl, 'https://www.youtube.com/embed/dQw4w9WgXcQ');
    const tt = await add('https://www.tiktok.com/@ava/video/7301234567890123456');
    assert.equal(tt.exampleVideo.thumbnailUrl, 'https://p16.tiktokcdn.com/thumb.jpg');
    assert.equal((await add('https://youtu.be/dQw4w9WgXcQ')).status, 409);
    for (let i = 0; i < 4; i++) assert.equal((await add(`https://www.youtube.com/shorts/abcdefghij${i}`)).status, 201);
    assert.equal((await add('https://www.youtube.com/shorts/abcdefghijZ')).status, 409);
  } finally { globalThis.fetch = original; }
  assert.equal(h.row('SELECT COUNT(*) n FROM videos').n, 0);
  const pub = await h.pub('GET', '/campaigns/glow-spring');
  assert.equal(pub.campaign.example_videos.length, 6);
  assert.deepEqual(Object.keys(pub.campaign.example_videos[0]).sort(), ['caption', 'embed_url', 'platform', 'thumbnail_url', 'url']);
});

test('the portal gets share_url, team_bonus_bps and ref_code', needsSqlite, async () => {
  const h = harness();
  const c = await liveCampaign(h);
  h.creator('cr-ava', { name: 'Ava', email: 'ava@example.com' });
  h.assign('ca-ava', c.id, 'cr-ava', { override_bps: 700 });
  const token = 'portal-token';
  h.sqlite.prepare('INSERT INTO affiliate_sessions (token_hash, creator_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(await sha256(token), 'cr-ava', new Date().toISOString(), '2099-01-01T00:00:00Z');
  const portal = async (path) => {
    const res = await affiliateFetch(new Request('https://api.test/api/affiliate/v1' + path, { headers: { authorization: `Bearer ${token}` } }), h.env, {});
    return res.json();
  };
  const me = await portal('/me');
  assert.match(me.creator.ref_code, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{8}$/);   // minted on first use for pre-v8 creators
  const { data: [summary] } = await portal('/campaigns');
  assert.equal(summary.share_url, `https://affiliate.edgeformmarketing.com/apply.html?c=glow-spring&r=${me.creator.ref_code}`);
  assert.equal(summary.team_bonus_bps, 700);

  await h.admin('PATCH /api/campaigns/:id', { params: [c.id], body: { applicationEnabled: false } });
  assert.equal((await portal(`/campaigns/${c.id}`)).campaign.share_url, null);
});
