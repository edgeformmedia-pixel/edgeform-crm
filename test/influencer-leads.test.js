import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { leadIdentity, parseCsv, validateAnalysis } from '../worker/influencer-leads.js';

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
});
