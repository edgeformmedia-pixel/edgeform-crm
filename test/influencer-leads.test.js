import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  collectConsultedSources, decryptSecret, encryptSecret, leadIdentity, parseCsv, planDiscoveryBudget, redactSecrets, sourceKey,
  validateAnalysis, verifyDiscoveredCreator, wasConsulted
} from '../worker/influencer-leads.js';

test('CSV parser accepts quoted commas, escaped quotes, and multiline notes', () => {
  const rows = parseCsv('handle,name,notes\r\n@jane,"Jane, Doe","Said ""hello""\nFollow up"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].row, 2);
  assert.equal(rows[0].values.handle, '@jane');
  assert.equal(rows[0].values.name, 'Jane, Doe');
  assert.equal(rows[0].values.notes, 'Said "hello"\nFollow up');
});

test('CSV parser requires an Instagram identity column', () => {
  assert.throws(() => parseCsv('name,email\nJane,jane@example.com'), /handle or profile_url/);
});

test('handle and canonical Instagram URL produce the same duplicate identity', () => {
  assert.equal(leadIdentity({ handle: '@Jane.Creator' }), 'jane.creator');
  assert.equal(leadIdentity({ profileUrl: 'https://instagram.com/Jane.Creator/?hl=en' }), 'jane.creator');
  assert.equal(leadIdentity({ profileUrl: 'instagram.com/Jane.Creator' }), 'jane.creator');
  assert.throws(() => leadIdentity({ handle: '@jane', profileUrl: 'https://instagram.com/john/' }), /same account/);
});

test('strict AI result validation accepts valid values and rejects invented shape', () => {
  const valid = { fit_score: 82, confidence: 'high', recommendation: 'shortlist', strengths: ['Good niche fit'], concerns: [], concise_reason: 'Strong match.', missing_information: ['Audience geography'] };
  assert.deepEqual(validateAnalysis(valid), valid);
  assert.throws(() => validateAnalysis({ ...valid, fit_score: 101 }), /invalid structured result/);
  assert.throws(() => validateAnalysis({ ...valid, strengths: 'Good' }), /invalid structured result/);
});

test('saved API keys are encrypted with authenticated encryption', async () => {
  const encrypted = await encryptSecret('sk-test-secret-value-123456789', 'wrapping-secret-for-tests');
  assert.doesNotMatch(encrypted.ciphertext, /sk-test/);
  assert.equal(await decryptSecret(encrypted.ciphertext, encrypted.iv, 'wrapping-secret-for-tests'), 'sk-test-secret-value-123456789');
  await assert.rejects(() => decryptSecret(encrypted.ciphertext, encrypted.iv, 'wrong-secret'), /could not be decrypted/);
});

test('discovery planner honors creator and conservative spend limits', () => {
  const standard = planDiscoveryBudget({ count: 50, budgetUsd: 5 });
  assert.equal(standard.effectiveCount, 50);
  assert.equal(standard.maxToolCalls, 16);
  assert.ok(standard.estimatedMaxCost <= 5);

  const constrained = planDiscoveryBudget({ count: 50, budgetUsd: 0.1 });
  assert.ok(constrained.effectiveCount < 50);
  assert.ok(constrained.estimatedMaxCost <= 0.1);
  assert.throws(() => planDiscoveryBudget({ count: 51, budgetUsd: 5 }), /between 1 and 50/);
  assert.throws(() => planDiscoveryBudget({ count: 5, budgetUsd: 0.05 }), /between \$0.10 and \$25/);
});

test('discovery planner allows several searches even for small requests', () => {
  for (const count of [1, 5, 10, 25, 50]) {
    const plan = planDiscoveryBudget({ count, budgetUsd: 5 });
    assert.equal(plan.effectiveCount, count);
    assert.ok(plan.maxToolCalls >= 4, `count ${count} got ${plan.maxToolCalls} searches`);
    assert.ok(plan.maxOutputTokens >= 2000 + count * 250);
  }
  const tight = planDiscoveryBudget({ count: 20, budgetUsd: 0.25 });
  assert.ok(tight.estimatedMaxCost <= 0.25);
  assert.ok(tight.maxToolCalls >= 2);
});

const openAiResponse = {
  id: 'resp_test', status: 'completed',
  output: [
    { type: 'web_search_call', action: { type: 'search', query: 'AI side hustle creators instagram', sources: [
      { type: 'url', url: 'https://www.example-news.com/top-ai-side-hustle-creators/?utm_source=openai' },
      { type: 'url', url: 'https://linktr.ee/aimoneymaya' },
      { type: 'url', url: 'https://www.instagram.com/direct.creator/' }
    ] } },
    { type: 'web_search_call', action: { type: 'open_page', url: 'https://creatorstats.example.org/maya' } },
    { type: 'message', content: [{ type: 'output_text', text: '{}', annotations: [{ type: 'url_citation', url: 'https://podcast.example.com/ep/12#t=30', title: 'Ep 12' }] }] }
  ]
};

test('consulted sources include search results, opened pages, and citations', () => {
  const consulted = collectConsultedSources(openAiResponse);
  assert.equal(consulted.urls.length, 5);
  assert.deepEqual(consulted.queries, ['AI side hustle creators instagram']);
  assert.equal(consulted.searchActions, 1);
  assert.equal(consulted.pageActions, 1);
  assert.equal(consulted.domains['instagram.com'], 1);
  assert.ok(wasConsulted('https://example-news.com/top-ai-side-hustle-creators', consulted));
  assert.ok(wasConsulted('http://podcast.example.com/ep/12/', consulted));
  assert.ok(!wasConsulted('https://example-news.com/some-other-article', consulted));
  assert.equal(sourceKey('https://M.Example.com/a/?b=2&a=1&fbclid=x#top'), 'example.com/a?a=1&b=2');
  assert.equal(sourceKey('javascript:alert(1)'), '');
  assert.deepEqual(collectConsultedSources({}).urls, []);
});

const candidate = (overrides = {}) => ({
  handle: '@AIMoneyMaya', instagram_url: '', name: 'Maya', niche: 'AI side hustles', location: '', bio: '',
  follower_count: null, average_views: null, engagement_rate: null, metrics_source_url: '',
  handle_source_url: 'https://linktr.ee/aimoneymaya',
  source_urls: ['https://example-news.com/top-ai-side-hustle-creators', 'https://invented.example.com/fake'],
  evidence: 'Featured in a roundup of AI side hustle creators.', ...overrides
});

test('discovered creators get a canonical Instagram URL and only consulted sources', () => {
  const consulted = collectConsultedSources(openAiResponse);
  const { lead } = verifyDiscoveredCreator(candidate({ instagram_url: 'instagram.com/aimoneymaya?igsh=abc' }), consulted);
  assert.equal(lead.handle, 'aimoneymaya');
  assert.equal(lead.profileUrl, 'https://www.instagram.com/aimoneymaya/');
  assert.equal(lead.status, 'Ready to Review');
  assert.match(lead.recentPostNotes, /linktr\.ee\/aimoneymaya/);
  assert.doesNotMatch(lead.recentPostNotes, /invented\.example/);
  assert.equal(leadIdentity(lead), 'aimoneymaya');

  const direct = verifyDiscoveredCreator(candidate({ handle: 'direct.creator', handle_source_url: '' }), consulted);
  assert.equal(direct.lead.profileUrl, 'https://www.instagram.com/direct.creator/');
});

test('discovery rejects unconfirmed, invented, or non-profile Instagram identities', () => {
  const consulted = collectConsultedSources(openAiResponse);
  const reason = (value) => { try { verifyDiscoveredCreator(value, consulted); return 'accepted'; } catch (error) { return error.reason; } };
  assert.equal(reason(candidate()), 'accepted');
  assert.equal(reason(candidate({ handle_source_url: '' })), 'missing_handle_source');
  assert.equal(reason(candidate({ handle_source_url: 'https://made-up.example.com/maya' })), 'handle_source_not_consulted');
  assert.equal(reason(candidate({ handle: 'maya creator' })), 'invalid_handle');
  assert.equal(reason(candidate({ handle: 'reels' })), 'invalid_handle');
  assert.equal(reason(candidate({ handle: '.maya' })), 'invalid_handle');
  assert.equal(reason(candidate({ instagram_url: 'https://www.instagram.com/p/Cabc123/' })), 'non_profile_instagram_url');
  assert.equal(reason(candidate({ instagram_url: 'https://linktr.ee/aimoneymaya' })), 'non_profile_instagram_url');
  assert.equal(reason(candidate({ instagram_url: 'https://instagram.com/someoneelse' })), 'handle_url_mismatch');
  assert.equal(reason(null), 'invalid_shape');
  assert.throws(() => leadIdentity({ profileUrl: 'https://www.instagram.com/p/Cabc123/' }), /valid Instagram profile URL/);
});

test('discovery keeps metrics only when a consulted page states them', () => {
  const consulted = collectConsultedSources(openAiResponse);
  const unsourced = verifyDiscoveredCreator(candidate({ follower_count: 120000, engagement_rate: 4.2 }), consulted);
  assert.equal(unsourced.lead.followerCount, null);
  assert.equal(unsourced.lead.engagementRate, null);
  assert.deepEqual(unsourced.droppedMetrics, ['follower count', 'engagement rate']);

  const invented = verifyDiscoveredCreator(candidate({ follower_count: 120000, metrics_source_url: 'https://fake-stats.example.com/maya' }), consulted);
  assert.equal(invented.lead.followerCount, null);

  const sourced = verifyDiscoveredCreator(candidate({ follower_count: 120000, average_views: 30000, metrics_source_url: 'https://creatorstats.example.org/maya' }), consulted);
  assert.equal(sourced.lead.followerCount, 120000);
  assert.equal(sourced.lead.averageViews, 30000);
  assert.equal(sourced.lead.engagementRate, null);

  const badValue = verifyDiscoveredCreator(candidate({ engagement_rate: 250, metrics_source_url: 'https://creatorstats.example.org/maya' }), consulted);
  assert.equal(badValue.lead.engagementRate, null);

  assert.throws(
    () => verifyDiscoveredCreator(candidate({ follower_count: 900000, metrics_source_url: 'https://creatorstats.example.org/maya' }), consulted, { followerMin: 500, followerMax: 500000 }),
    error => error.reason === 'outside_follower_range'
  );
});

test('secrets are redacted from logged error text', () => {
  const text = redactSecrets('Incorrect API key provided: sk-proj-abc123****wxyz. Header Bearer sk-live-secret');
  assert.doesNotMatch(text, /abc123|wxyz|sk-live-secret/);
  assert.match(text, /sk-\[redacted\]/);
});

test('Find Creators is nested after Creators and before Operations in both navigations', async () => {
  const html = await readFile(new URL('../home/index.html', import.meta.url), 'utf8');
  for (const prefix of ['drawer-nav-', 'nav-']) {
    const creators = html.indexOf(`id="${prefix}creators-page"`);
    const leads = html.indexOf(`id="${prefix}influencer-leads-page"`);
    const operations = html.indexOf(`id="${prefix}operations-page"`);
    assert.ok(creators >= 0 && leads > creators && operations > leads);
  }
  assert.match(html, /id="ifl-analyze-selected"[^>]+disabled/);
  assert.match(html, /Manually contact finalists/);
  assert.match(html, /Beauty &amp; Skincare/);
  assert.match(html, /Find Creators Settings/);
  assert.match(html, /type="password"[^>]+autocomplete="off"/);
  assert.match(html, /id="ifl-discovery-modal"/);
  assert.match(html, /id="ifl-d-count"[^>]+max="50"/);
  assert.match(html, /id="ifl-d-budgetUsd"[^>]+min="0.10"[^>]+value="5"/);
  assert.match(html, /conservative request estimate, not an OpenAI account billing lock/);
});
