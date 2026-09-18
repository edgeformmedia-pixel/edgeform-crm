import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVideoUrl, resolveVideoUrl, normalizeHandle, computeEarnings, encryptText, decryptText } from '../worker/affiliate-lib.js';

test('YouTube links: watch, shorts, youtu.be, live all give the same video', () => {
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'youtube.com/shorts/dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?si=x', 'https://m.youtube.com/live/dQw4w9WgXcQ']) {
    const v = parseVideoUrl(url);
    assert.equal(v.platform, 'youtube');
    assert.equal(v.platform_video_id, 'dQw4w9WgXcQ');
    assert.equal(v.canonical_url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  }
  assert.throws(() => parseVideoUrl('https://www.youtube.com/@creator'), e => e.code === 'invalid_url');
});

test('TikTok links carry the handle; short links need resolving', () => {
  const v = parseVideoUrl('https://www.tiktok.com/@Ava.Makes/video/7301234567890123456?is_from_webapp=1');
  assert.deepEqual([v.platform, v.platform_video_id, v.handle, v.canonical_url],
    ['tiktok', '7301234567890123456', 'ava.makes', 'https://www.tiktok.com/@ava.makes/video/7301234567890123456']);
  assert.equal(parseVideoUrl('https://vm.tiktok.com/ZMabc123/').resolve, true);
  assert.equal(parseVideoUrl('https://www.tiktok.com/t/ZTabc/').resolve, true);
});

test('Instagram reels and posts, with or without the username prefix', () => {
  assert.equal(parseVideoUrl('https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=abc').canonical_url, 'https://www.instagram.com/reel/C1a2B3c4D5e/');
  assert.equal(parseVideoUrl('instagram.com/reels/C1a2B3c4D5e').platform_video_id, 'C1a2B3c4D5e');
  const p = parseVideoUrl('https://www.instagram.com/ava.makes/p/C1a2B3c4D5e/');
  assert.equal(p.canonical_url, 'https://www.instagram.com/p/C1a2B3c4D5e/');
  assert.equal(p.handle, 'ava.makes');
});

test('bad and unsupported links get the contract error codes', () => {
  assert.throws(() => parseVideoUrl(''), e => e.code === 'invalid_url');
  assert.throws(() => parseVideoUrl('not a link'), e => e.code === 'invalid_url');
  assert.throws(() => parseVideoUrl('https://vimeo.com/123'), e => e.code === 'unsupported_platform');
  assert.throws(() => parseVideoUrl('ftp://tiktok.com/@a/video/123456789'), e => e.code === 'invalid_url');
});

test('short links are followed to the real video', async () => {
  const fakeFetch = async (url) => ({
    headers: new Map([['location', url.includes('vm.tiktok') ? 'https://www.tiktok.com/@ava/video/7301234567890123456?_r=1' : null]])
  });
  const v = await resolveVideoUrl('https://vm.tiktok.com/ZMabc123/', fakeFetch);
  assert.equal(v.platform_video_id, '7301234567890123456');
  await assert.rejects(() => resolveVideoUrl('https://www.instagram.com/share/reel/abc/', async () => ({ headers: new Map() })), e => e.code === 'invalid_url');
});

test('handles normalize from @handles and profile links', () => {
  assert.equal(normalizeHandle('@Ava.Makes'), 'ava.makes');
  assert.equal(normalizeHandle('https://www.tiktok.com/@ava.makes?lang=en'), 'ava.makes');
  assert.equal(normalizeHandle('instagram.com/ava.makes/'), 'ava.makes');
  assert.equal(normalizeHandle('https://youtube.com/@AvaMakes'), 'avamakes');
  assert.equal(normalizeHandle(''), '');
});

const video = (id, fields) => ({ id, campaign_affiliate_id: 'a1', creator_id: 'c1', status: 'approved', submitted_at: `2026-01-0${id.slice(1)}T00:00:00.000Z`, latest_view_count: 0, billable_views: 0, earned_cents: 0, ...fields });

test('earnings: floor(views × CPM / 1000), locked uses billable views, only approved/locked earn', () => {
  const campaign = { default_cpm_rate_cents: 2500 };
  const earned = computeEarnings(campaign, [
    video('v1', { latest_view_count: 12345 }),
    video('v2', { status: 'locked', latest_view_count: 99999, billable_views: 1001 }),
    video('v3', { status: 'pending_review', latest_view_count: 50000 }),
    video('v4', { status: 'rejected', latest_view_count: 50000, earned_cents: 700 })
  ]);
  assert.equal(earned.get('v1'), 30862); // 12345 * 2500 / 1000 = 30862.5
  assert.equal(earned.get('v2'), 2502);
  assert.equal(earned.get('v3'), 0);
  assert.equal(earned.get('v4'), 0);
});

test('earnings: override rate, minimum views, and removed videos keep their amount', () => {
  const campaign = { default_cpm_rate_cents: 1000, min_views_to_qualify: 1000 };
  const earned = computeEarnings(campaign, [
    video('v1', { latest_view_count: 999 }),
    video('v2', { latest_view_count: 2000 }),
    video('v3', { status: 'removed', earned_cents: 1234 })
  ], new Map([['a1', 3000]]));
  assert.equal(earned.get('v1'), 0);
  assert.equal(earned.get('v2'), 6000);
  assert.equal(earned.get('v3'), 1234);
});

test('earnings: per-video cap, then per-affiliate cap, then budget, oldest first', () => {
  const campaign = { default_cpm_rate_cents: 1000, max_payout_per_video_cents: 5000, max_payout_per_affiliate_cents: 8000, total_budget_cents: 10000 };
  const earned = computeEarnings(campaign, [
    video('v3', { latest_view_count: 10000, campaign_affiliate_id: 'a2', creator_id: 'c2' }), // 10000 → cap 5000; budget left 2000
    video('v1', { latest_view_count: 10000 }),  // 10000 → 5000
    video('v2', { latest_view_count: 4000 })    // 4000 → affiliate cap leaves 3000
  ]);
  assert.equal(earned.get('v1'), 5000);
  assert.equal(earned.get('v2'), 3000);
  assert.equal(earned.get('v3'), 2000);
});

test('earnings: videos already on a payout keep their amount and count toward caps', () => {
  const campaign = { default_cpm_rate_cents: 1000, total_budget_cents: 5000 };
  const earned = computeEarnings(campaign, [
    video('v1', { status: 'locked', billable_views: 10000 }),
    video('v2', { latest_view_count: 10000 })
  ], new Map(), new Map([['v1', 4000]]));
  assert.equal(earned.get('v1'), 4000);
  assert.equal(earned.get('v2'), 1000);
});

test('payout details round-trip through AES-GCM', async () => {
  const stored = await encryptText('iban DE89 3704 0044 0532 0130 00', 'secret');
  assert.doesNotMatch(stored, /DE89/);
  assert.equal(await decryptText(stored, 'secret'), 'iban DE89 3704 0044 0532 0130 00');
  await assert.rejects(() => decryptText(stored, 'wrong'));
});
