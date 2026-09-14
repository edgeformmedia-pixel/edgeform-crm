import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decryptSecret, encryptSecret, leadIdentity, parseCsv, planDiscoveryBudget, validateAnalysis } from '../worker/influencer-leads.js';

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
  assert.equal(standard.maxToolCalls, 5);
  assert.ok(standard.estimatedMaxCost <= 5);

  const constrained = planDiscoveryBudget({ count: 50, budgetUsd: 0.1 });
  assert.ok(constrained.effectiveCount < 50);
  assert.ok(constrained.estimatedMaxCost <= 0.1);
  assert.throws(() => planDiscoveryBudget({ count: 51, budgetUsd: 5 }), /between 1 and 50/);
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
  assert.match(html, /id="ifl-d-budgetUsd"[^>]+value="5"/);
  assert.match(html, /conservative request estimate, not an OpenAI account billing lock/);
});
