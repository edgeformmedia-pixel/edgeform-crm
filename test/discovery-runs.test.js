import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { buildDiscoveryRequest, discoveryCron, influencerLeadRoutes, nextDiscoveryAction, planDiscoveryBudget, serializeDiscoveryRun } from '../worker/influencer-leads.js';
import { sha256 } from '../worker/lib.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
const needsSqlite = { skip: DatabaseSync ? false : 'node:sqlite is unavailable in this Node version' };

test('discovery requests run in OpenAI background mode on the open web', () => {
  const plan = planDiscoveryBudget({ count: 5, budgetUsd: 1 });
  const body = buildDiscoveryRequest({ model: 'gpt-test', plan, query: 'AI side hustle creators', criteria: { followerMin: null } });
  assert.equal(body.background, true);
  assert.equal(body.store, true);
  assert.deepEqual(body.tools, [{ type: 'web_search', search_context_size: 'medium' }]);
  assert.equal(body.max_tool_calls, plan.maxToolCalls);
  assert.deepEqual(body.include, ['web_search_call.action.sources']);
});

test('run lifecycle decisions cover polling, stale starts, abandoned imports, and timeouts', () => {
  const t = Date.parse('2026-09-14T12:00:00Z');
  const ago = (ms) => new Date(t - ms).toISOString();
  assert.equal(nextDiscoveryAction({ status: 'running', created_at: ago(30000), polled_at: ago(5000) }, t), 'poll');
  assert.equal(nextDiscoveryAction({ status: 'running', created_at: ago(30000), polled_at: ago(1000) }, t), 'wait');
  assert.equal(nextDiscoveryAction({ status: 'running', created_at: ago(30000), polled_at: ago(5000) }, t, 20000), 'wait');
  assert.equal(nextDiscoveryAction({ status: 'running', created_at: ago(21 * 60000), polled_at: ago(1000) }, t), 'timeout');
  assert.equal(nextDiscoveryAction({ status: 'starting', created_at: ago(10000), updated_at: ago(10000) }, t), 'wait');
  assert.equal(nextDiscoveryAction({ status: 'starting', created_at: ago(3 * 60000), updated_at: ago(3 * 60000) }, t), 'fail_stale_start');
  assert.equal(nextDiscoveryAction({ status: 'importing', claimed_at: ago(60000) }, t), 'wait');
  assert.equal(nextDiscoveryAction({ status: 'importing', claimed_at: ago(6 * 60000) }, t), 'release_import');
  assert.equal(nextDiscoveryAction({ status: 'complete' }, t), 'none');
});

test('serialized runs expose status and results but not internal response data', () => {
  const run = serializeDiscoveryRun({ id: 'r1', status: 'running', created_at: 'x', response_id: 'resp_secret', api_error: '{"message":"x"}', result: '', criteria: '{}' });
  assert.equal(run.active, true);
  assert.equal(run.result, null);
  assert.ok(!('responseId' in run) && !JSON.stringify(run).includes('resp_secret'));
});

function harness() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).sort()) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) })
  });
  const DB = { prepare: (sql) => statement(sql), batch: (statements) => Promise.all(statements.map(s => s.all())) };
  const columns = sqlite.prepare('PRAGMA table_info(users)').all();
  const addUser = (id, role = 'member') => {
    const user = { id, email: `${id}@example.com`, name: id, verified: 1, role, created_at: new Date().toISOString() };
    for (const column of columns) if (!(column.name in user) && column.notnull && column.dflt_value == null) user[column.name] = `${column.name}-${id}`;
    const keys = Object.keys(user).filter(key => columns.some(c => c.name === key));
    sqlite.prepare(`INSERT INTO users (${keys}) VALUES (${keys.map(() => '?')})`).run(...keys.map(key => user[key]));
  };
  addUser('u1'); addUser('u2');
  const openai = { calls: [], responses: new Map(), create: null };
  const fetchMock = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/v1\/responses/, '');
    openai.calls.push({ method: init.method || 'GET', path, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, body) => new Response(JSON.stringify(body), { status });
    if (init.method === 'POST' && path === '') return openai.create ? openai.create() : reply(200, { id: 'resp_1', status: 'queued' });
    const [, id, action] = path.split('/');
    const stored = openai.responses.get(id);
    if (!stored) return reply(404, { error: { message: 'No response found.', type: 'invalid_request_error' } });
    if (action === 'cancel' && (stored.status === 'queued' || stored.status === 'in_progress')) stored.status = 'cancelled';
    return reply(200, stored);
  };
  const env = { DB, OPENAI_API_KEY: 'sk-test-env-key-000000000000', AI_SETTINGS_ENCRYPTION_KEY: 'test-wrapping-key' };
  const tokens = {};
  const session = async (userId) => {
    tokens[userId] = `token-${userId}`;
    sqlite.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(await sha256(tokens[userId]), userId, new Date().toISOString(), '2099-01-01T00:00:00Z');
  };
  const call = async (key, userId, { body, params = [] } = {}) => {
    const request = new Request('https://api.test/x', { method: key.split(' ')[0], headers: { authorization: `Bearer ${tokens[userId]}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    try {
      const response = await influencerLeadRoutes[key](request, env, {}, params);
      return { status: response.status, ...(await response.json()) };
    } catch (error) { return { status: error.status || 500, error: error.message }; }
  };
  const run = (id) => sqlite.prepare('SELECT * FROM influencer_discovery_runs WHERE id = ?').get(id);
  const age = (id, fields) => sqlite.prepare(`UPDATE influencer_discovery_runs SET ${Object.keys(fields).map(k => `${k} = ?`)} WHERE id = ?`).run(...Object.values(fields), id);
  return { sqlite, env, openai, fetchMock, session, call, run, age };
}

const completedResponse = (id = 'resp_1') => {
  const creator = (handle, source) => ({
    handle, instagram_url: '', name: '', niche: 'AI side hustles', location: '', bio: '', follower_count: null, average_views: null,
    engagement_rate: null, metrics_source_url: '', handle_source_url: source, source_urls: [], evidence: 'Listed in a roundup.'
  });
  return {
    id, status: 'completed', usage: { input_tokens: 20000, output_tokens: 1500 },
    output: [
      { type: 'web_search_call', action: { type: 'search', query: 'AI side hustle creators', sources: [{ url: 'https://news.example.com/list' }] } },
      { type: 'message', content: [{ type: 'output_text', annotations: [], text: JSON.stringify({
        search_summary: 'Found creators.', unconfirmed: [],
        creators: [creator('maya.ai', 'https://news.example.com/list'), creator('ghost', 'https://invented.example.com/')]
      }) }] }
    ]
  };
};

const start = { body: { query: 'AI side hustle creators', count: 5, budgetUsd: 1 } };
const POLL = 'GET /api/influencer-leads/discover/runs/:id';

async function withFetch(h, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = h.fetchMock;
  try { await fn(); } finally { globalThis.fetch = original; }
}

test('a background run survives the start request, imports once, and enforces one active run per user', needsSqlite, async () => {
  const h = harness();
  await withFetch(h, async () => {
    await h.session('u1'); await h.session('u2');
    const started = await h.call('POST /api/influencer-leads/discover', 'u1', start);
    assert.equal(started.status, 202);
    assert.equal(started.run.status, 'running');
    assert.equal(h.openai.calls[0].body.background, true);
    h.openai.responses.set('resp_1', { id: 'resp_1', status: 'in_progress' });

    assert.equal((await h.call('POST /api/influencer-leads/discover', 'u1', start)).status, 409);
    assert.equal((await h.call(POLL, 'u2', { params: [started.run.id] })).status, 404);

    h.age(started.run.id, { polled_at: '' });
    assert.equal((await h.call(POLL, 'u1', { params: [started.run.id] })).run.status, 'running');

    // Browser poll and cron collect the finished response at the same moment: only one import happens.
    h.openai.responses.set('resp_1', completedResponse());
    h.age(started.run.id, { polled_at: '' });
    const snapshot = h.run(started.run.id);
    await Promise.all([h.call(POLL, 'u1', { params: [started.run.id] }), discoveryCron(h.env)]);
    const row = h.run(started.run.id);
    assert.equal(row.status, 'complete', JSON.stringify(snapshot));
    assert.equal(row.imported_count, 1);
    assert.equal(row.rejected_count, 1);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM influencer_leads WHERE handle = 'maya.ai'").get().n, 1);
    const listed = await h.call('GET /api/influencer-leads/discover/runs', 'u1');
    assert.equal(listed.active, null);
    assert.equal(listed.recent[0].result.summary.imported, 1);
    assert.ok(!JSON.stringify(h.sqlite.prepare('SELECT * FROM influencer_discovery_runs').all()).includes('sk-test-env-key'));

    h.openai.create = () => new Response(JSON.stringify({ id: 'resp_2', status: 'queued' }), { status: 200 });
    assert.equal((await h.call('POST /api/influencer-leads/discover', 'u1', start)).status, 202);
  });
});

test('cancel stops a running search, and an abandoned import is re-imported without duplicate leads', needsSqlite, async () => {
  const h = harness();
  await withFetch(h, async () => {
    await h.session('u1');
    const { run } = await h.call('POST /api/influencer-leads/discover', 'u1', start);
    h.openai.responses.set('resp_1', { id: 'resp_1', status: 'in_progress', usage: { input_tokens: 5000, output_tokens: 100 } });
    const cancelled = await h.call('POST /api/influencer-leads/discover/runs/:id/cancel', 'u1', { params: [run.id] });
    assert.equal(cancelled.run.status, 'cancelled');
    assert.ok(h.openai.calls.some(c => c.path === '/resp_1/cancel'));
    assert.equal(h.run(run.id).input_tokens, 5000);

    h.openai.create = () => new Response(JSON.stringify({ id: 'resp_3', status: 'queued' }), { status: 200 });
    const second = (await h.call('POST /api/influencer-leads/discover', 'u1', start)).run;
    h.openai.responses.set('resp_3', completedResponse('resp_3'));
    h.age(second.id, { polled_at: '' });
    await discoveryCron(h.env);
    assert.equal(h.run(second.id).imported_count, 1);
    // Simulate a Worker that died mid-import: the run is released and collected again.
    h.age(second.id, { status: 'importing', claimed_at: new Date(Date.now() - 6 * 60000).toISOString() });
    await discoveryCron(h.env);
    assert.equal(h.run(second.id).status, 'running');
    await discoveryCron(h.env);
    const row = h.run(second.id);
    assert.equal(row.status, 'complete');
    assert.equal(row.imported_count, 0);
    assert.equal(row.duplicate_count, 1);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM influencer_leads WHERE handle = 'maya.ai'").get().n, 1);
  });
});

test('stuck starts fail, expired runs are cancelled, and OpenAI start errors are recorded without keys', needsSqlite, async () => {
  const h = harness();
  await withFetch(h, async () => {
    await h.session('u1');
    const old = new Date(Date.now() - 25 * 60000).toISOString();
    const { run } = await h.call('POST /api/influencer-leads/discover', 'u1', start);
    h.openai.responses.set('resp_1', { id: 'resp_1', status: 'in_progress' });
    h.age(run.id, { created_at: old, polled_at: '' });
    await discoveryCron(h.env);
    assert.equal(h.run(run.id).status, 'failed');
    assert.match(h.run(run.id).error, /timed out/);

    h.sqlite.prepare(`INSERT INTO influencer_discovery_runs (id,user_id,created_at,updated_at,query,requested_count,budget_usd,status)
      VALUES ('stuck','u1',?,?,'q',5,1,'starting')`).run(old, old);
    await discoveryCron(h.env);
    assert.equal(h.run('stuck').status, 'failed');

    h.openai.create = () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-proj-abcd****wxyz.', type: 'invalid_request_error', code: 'invalid_api_key' } }), { status: 401 });
    const failed = await h.call('POST /api/influencer-leads/discover', 'u1', start);
    assert.equal(failed.status, 502);
    const row = h.sqlite.prepare("SELECT * FROM influencer_discovery_runs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 1").get();
    assert.match(row.api_error, /invalid_api_key/);
    assert.doesNotMatch(row.error + row.api_error, /abcd|wxyz/);
  });
});

test('search profiles are shared CRUD records, and runs pass reference creators and fill missing emails', needsSqlite, async () => {
  const h = harness();
  await withFetch(h, async () => {
    await h.session('u1'); await h.session('u2');
    const created = await h.call('POST /api/influencer-leads/discovery-profiles', 'u1', { body: { name: 'Ulio', brief: 'AI agency creators', followerMax: 20000, lookalikes: '@aiguyofficial, @mavgpt', creatorCount: 25, budgetUsd: 5 } });
    assert.equal(created.status, 201);
    assert.deepEqual(created.profile.lookalikes, ['aiguyofficial', 'mavgpt']);
    assert.equal((await h.call('POST /api/influencer-leads/discovery-profiles', 'u2', { body: { name: 'ulio' } })).status, 409);
    const updated = await h.call('PATCH /api/influencer-leads/discovery-profiles/:id', 'u2', { params: [created.profile.id], body: { name: 'Ulio', brief: 'Updated brief', followerMax: 20000 } });
    assert.equal(updated.profile.brief, 'Updated brief');
    assert.equal((await h.call('GET /api/influencer-leads/discovery-profiles', 'u2')).profiles.length, 1);

    // maya.ai already exists without an email; the run finds her published email and adds it.
    h.sqlite.prepare("INSERT INTO influencer_leads (id,created_by_user_id,created_at,updated_at,handle,profile_url,status,tags,email) VALUES ('l1','u1','t','t','maya.ai','https://www.instagram.com/maya.ai/','New','[]','')").run();
    h.sqlite.prepare("INSERT INTO influencer_lead_notes (id,lead_id,user_id,author,body,created_at) VALUES ('n1','l1','u1','Tester','too old, owns an AI agency','t')").run();
    const started = await h.call('POST /api/influencer-leads/discover', 'u1', { body: { ...start.body, lookalikes: '@aiguyofficial', profileId: created.profile.id } });
    const input = JSON.parse(h.openai.calls.find(c => c.method === 'POST' && c.path === '').body.input);
    assert.deepEqual(input.reference_creators, ['@aiguyofficial']);
    assert.deepEqual(input.already_in_crm, ['@maya.ai']);
    assert.deepEqual(input.team_feedback, [{ creator: '@maya.ai', status: 'New', note: 'too old, owns an AI agency' }]);
    assert.ok(!('profileId' in input) && !('lookalikes' in input));
    assert.equal(JSON.parse(h.run(started.run.id).criteria).profileId, created.profile.id);

    const response = completedResponse();
    const message = response.output[1].content[0];
    const payload = JSON.parse(message.text);
    Object.assign(payload.creators[0], { email: 'maya@example.com', email_source_url: 'https://news.example.com/list' });
    payload.creators.push({ ...payload.creators[0], handle: 'aiguyofficial', email: '' });
    message.text = JSON.stringify(payload);
    h.openai.responses.set('resp_1', response);
    h.age(started.run.id, { polled_at: '' });
    await discoveryCron(h.env);
    const row = h.run(started.run.id);
    assert.equal(row.duplicate_count, 1);
    assert.match(row.rejections, /reference_creator/);
    assert.equal(h.sqlite.prepare("SELECT email FROM influencer_leads WHERE handle = 'maya.ai'").get().email, 'maya@example.com');

    assert.equal((await h.call('DELETE /api/influencer-leads/discovery-profiles/:id', 'u1', { params: [created.profile.id] })).status, 200);
    assert.equal((await h.call('GET /api/influencer-leads/discovery-profiles', 'u1')).profiles.length, 0);
  });
});
