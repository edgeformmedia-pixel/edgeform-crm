import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVideoUrl, resolveVideoUrl, normalizeHandle, computeEarnings, priceEvents, encryptText, decryptText, lastWeeklyCutoff } from '../worker/affiliate-lib.js';

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

test('the weekly cutoff is the most recent past Sunday 10pm America/New_York, DST-safe', () => {
  assert.equal(lastWeeklyCutoff('2026-09-18T12:00:00.000Z'), '2026-09-14T02:00:00.000Z');   // Friday -> last Sunday, EDT
  assert.equal(lastWeeklyCutoff('2026-09-20T23:00:00.000Z'), '2026-09-14T02:00:00.000Z');   // Sunday 7pm ET, before this week's cutoff
  assert.equal(lastWeeklyCutoff('2026-09-21T02:00:00.000Z'), '2026-09-21T02:00:00.000Z');   // Sunday 10pm ET exactly -> this week's cutoff
  assert.equal(lastWeeklyCutoff('2026-01-05T00:00:00.000Z'), '2025-12-29T03:00:00.000Z');   // winter, EST
  assert.equal(lastWeeklyCutoff('2026-11-01T12:00:00.000Z'), '2026-10-26T02:00:00.000Z');   // around fall-back
  assert.equal(lastWeeklyCutoff('2026-03-08T12:00:00.000Z'), '2026-03-02T03:00:00.000Z');   // around spring-forward
});

// A weekly view-check event: the delta since the last check, and the cumulative count at this check.
const event = (id, fields) => ({ id, video_id: fields.video_id || id, campaign_affiliate_id: 'a1', video_status: 'approved', view_count: 0, delta_views: 0, ...fields });

test('earnings: floor(delta views × CPM / 1000); only an approved video prices a new week', () => {
  const campaign = { default_cpm_rate_cents: 2500 };
  const earned = computeEarnings(campaign, [
    event('s1', { delta_views: 12345, view_count: 12345 }),
    event('s2', { delta_views: 1001, view_count: 1001, video_status: 'locked' }),
    event('s3', { delta_views: 50000, view_count: 50000, video_status: 'pending_review' }),
    event('s4', { delta_views: 50000, view_count: 50000, video_status: 'rejected' })
  ]);
  assert.equal(earned.get('s1'), 30862); // 12345 * 2500 / 1000 = 30862.5
  assert.equal(earned.get('s2'), 0);     // not approved: earns nothing new (defensive backstop; in practice this never happens)
  assert.equal(earned.get('s3'), 0);
  assert.equal(earned.get('s4'), 0);
});

test('earnings: override rate, and a cumulative minimum views to qualify', () => {
  const campaign = { default_cpm_rate_cents: 1000, min_views_to_qualify: 1000 };
  const earned = computeEarnings(campaign, [
    event('s1', { delta_views: 999, view_count: 999 }),    // cumulative views haven't crossed the bar yet
    event('s2', { delta_views: 1001, view_count: 2000 }),  // this check crosses it; the whole week's delta counts
    event('s3', { delta_views: 100, view_count: 100, video_status: 'removed' })
  ], new Map([['a1', 3000]]));
  assert.equal(earned.get('s1'), 0);
  assert.equal(earned.get('s2'), 3003);
  assert.equal(earned.get('s3'), 0);
});

test('earnings: per-video cap, then per-affiliate cap, then budget, in event order', () => {
  const campaign = { default_cpm_rate_cents: 1000, max_payout_per_video_cents: 5000, max_payout_per_affiliate_cents: 8000, total_budget_cents: 10000 };
  // priceEvents doesn't sort its input — recomputeCampaign always passes events in fetched_at order.
  const earned = computeEarnings(campaign, [
    event('s1', { video_id: 'v1', delta_views: 10000, view_count: 10000 }),                           // → video cap 5000
    event('s2', { video_id: 'v2', delta_views: 4000, view_count: 4000 }),                              // → affiliate cap leaves 3000
    event('s3', { video_id: 'v3', campaign_affiliate_id: 'a2', delta_views: 10000, view_count: 10000 }) // → video cap 5000; budget leaves 2000
  ]);
  assert.equal(earned.get('s1'), 5000);
  assert.equal(earned.get('s2'), 3000);
  assert.equal(earned.get('s3'), 2000);
});

test('earnings: committed totals from already-priced weeks reduce what a new week can earn', () => {
  const campaign = { default_cpm_rate_cents: 1000, max_payout_per_video_cents: 8000, max_payout_per_affiliate_cents: 8000, total_budget_cents: 9000 };
  // v1 already earned 4000 in an earlier, already-priced week — 4000 of its video/affiliate cap and 5000
  // of the campaign budget remain, so this new week is capped by the video's remaining room.
  const { priced } = priceEvents(campaign, [event('s2', { video_id: 'v1', delta_views: 10000, view_count: 10000 })],
    new Map(), new Map([['v1', 4000]]), new Map([['a1', 4000]]), 4000);
  assert.equal(priced[0].earned_cents, 4000);
});

test('priced weeks are never repriced: a later rate change only affects new weeks', () => {
  const week1 = priceEvents({ default_cpm_rate_cents: 1000 }, [event('s1', { video_id: 'v1', delta_views: 10000, view_count: 10000 })]);
  assert.equal(week1.priced[0].earned_cents, 10000); // 10000 * 1000 / 1000

  // recomputeCampaign only ever prices an unpriced snapshot once, so a rate change and a second week only
  // ever reach this function together with week1 already excluded — simulated here by starting week2's
  // call from what week1 already committed, at the new rate.
  const week2 = priceEvents({ default_cpm_rate_cents: 2000 }, [event('s2', { video_id: 'v1', delta_views: 5000, view_count: 15000 })],
    new Map(), new Map([['v1', week1.priced[0].earned_cents]]));
  assert.equal(week2.priced[0].earned_cents, 10000); // 5000 * 2000 / 1000 at the new rate; week1's price is untouched
});

test('payout details round-trip through AES-GCM', async () => {
  const stored = await encryptText('iban DE89 3704 0044 0532 0130 00', 'secret');
  assert.doesNotMatch(stored, /DE89/);
  assert.equal(await decryptText(stored, 'secret'), 'iban DE89 3704 0044 0532 0130 00');
  await assert.rejects(() => decryptText(stored, 'wrong'));
});

test('uplines: your example — rookie $1.50, upline $2.00', () => {
  const affiliates = new Map([['up', { cpm_rate_override_cents: 200, upline_id: null, status: 'active' }], ['rook', { cpm_rate_override_cents: 150, upline_id: 'up', status: 'active' }]]);
  const { priced, overrides } = priceEvents({ default_cpm_rate_cents: 0 }, [
    event('s1', { video_id: 'v1', campaign_affiliate_id: 'rook', delta_views: 1000, view_count: 1000 }),
    event('s2', { video_id: 'v2', campaign_affiliate_id: 'up', delta_views: 1000, view_count: 1000 })
  ], affiliates);
  assert.equal(priced.find(p => p.id === 's1').earned_cents, 150); // rookie: $1.50
  assert.equal(priced.find(p => p.id === 's2').earned_cents, 200); // upline's own 1K views: $2.00
  assert.deepEqual(overrides.map(o => [o.video_id, o.campaign_affiliate_id, o.cpm_diff_cents, o.amount_cents]), [['v1', 'up', 50, 50]]); // upline: $0.50
});

test('uplines: same CPM earns nothing; chain pays each level its difference', () => {
  const a = (cpm, up, status = 'active') => ({ cpm_rate_override_cents: cpm, upline_id: up, status });
  const run = (affiliates, budget = null) => priceEvents({ default_cpm_rate_cents: 0, total_budget_cents: budget },
    [event('s1', { video_id: 'v1', campaign_affiliate_id: 'rook', delta_views: 100000, view_count: 100000 })], new Map(Object.entries(affiliates)));
  const amounts = (r) => Object.fromEntries(r.overrides.map(o => [o.campaign_affiliate_id, o.amount_cents]));

  assert.deepEqual(amounts(run({ top: a(3000, null), master: a(2500, 'top'), general: a(2000, 'master'), rook: a(1500, 'general') })),
    { general: 50000, master: 50000, top: 50000 });
  // General at the same CPM as the rookie earns nothing; master earns the full gap above the rookie.
  assert.deepEqual(amounts(run({ top: a(3000, null), master: a(2500, 'top'), general: a(1500, 'master'), rook: a(1500, 'general') })),
    { master: 100000, top: 50000 });
  // An upline below their downline's CPM earns nothing, and never negative.
  assert.deepEqual(amounts(run({ general: a(1000, null), rook: a(1500, 'general') })), {});
  // Removed uplines are skipped; the next one up still earns its difference.
  assert.deepEqual(amounts(run({ top: a(3000, null), general: a(2000, 'top', 'removed'), rook: a(1500, 'general') })), { top: 150000 });
  // Overrides share the campaign budget with own earnings.
  const capped = run({ up: a(2000, null), rook: a(1500, 'up') }, 160000);
  assert.equal(capped.priced[0].earned_cents, 150000);
  assert.deepEqual(amounts(capped), { up: 10000 });
  // A loop in the tree can't hang or double pay.
  assert.deepEqual(amounts(run({ x: a(2000, 'rook'), rook: a(1500, 'x') })), { x: 50000 });
});
