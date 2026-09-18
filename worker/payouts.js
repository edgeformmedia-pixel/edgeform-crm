import { json, HttpError, clean, now, readJson } from './lib.js';
import { requireUser, requireAdmin } from './auth.js';
import { PAYOUT_METHODS, auditStatement } from './affiliate-lib.js';

// Affiliate payouts. The CRM only records payouts: a person sends the money, then marks the payout paid
// with a reference. Nothing here moves money.
//
// A payout is built from a creator's priced weekly view-check events (approved or locked videos) that
// earned something and aren't on a payout yet — one row per week, so a video can appear on many payouts
// over its life as new weeks are checked and paid. pending → approved → paid; pending/approved → failed;
// failed → pending (retry). Pending and failed payouts can be deleted, which frees their events for a new payout.

const TRANSITIONS = { pending: ['approved', 'failed'], approved: ['paid', 'failed', 'pending'], failed: ['pending'], paid: [] };

// Priced weekly events (view_snapshots) on approved/locked videos, not yet on any payout.
const UNPAID_SQL = `SELECT s.id view_snapshot_id, s.view_count billable_views, s.earned_cents,
    s.fetched_at, v.id video_id, v.campaign_id, v.submitted_at,
    COALESCE(ca.cpm_rate_override_cents, c.default_cpm_rate_cents) cpm_rate_cents
  FROM view_snapshots s JOIN videos v ON v.id = s.video_id
    JOIN campaign_affiliates ca ON ca.id = v.campaign_affiliate_id JOIN campaigns c ON c.id = v.campaign_id
  WHERE v.creator_id = ? AND v.status IN ('approved', 'locked') AND s.earned_cents > 0
    AND NOT EXISTS (SELECT 1 FROM payout_line_items li WHERE li.view_snapshot_id = s.id)
  ORDER BY s.fetched_at`;

// Upline overrides on priced weekly events, not yet on any payout.
const UNPAID_OVERRIDES_SQL = `SELECT oe.*, s.view_count billable_views, s.fetched_at, v.submitted_at
  FROM override_earnings oe JOIN view_snapshots s ON s.id = oe.view_snapshot_id JOIN videos v ON v.id = s.video_id
  WHERE oe.creator_id = ? AND v.status IN ('approved', 'locked') AND oe.amount_cents > 0
    AND NOT EXISTS (SELECT 1 FROM payout_override_items poi WHERE poi.view_snapshot_id = oe.view_snapshot_id AND poi.campaign_affiliate_id = oe.campaign_affiliate_id)
  ORDER BY s.fetched_at`;

function payoutJson(p, items = [], overrideItems = []) {
  return {
    id: p.id, creatorId: p.creator_id, creatorName: p.creator_name, creatorEmail: p.creator_email,
    creatorPayoutMethod: p.creator_payout_method || '', creatorPayoutLast4: p.creator_payout_last4 || '', taxFormReceived: p.tax_form_received === 1,
    periodStart: p.period_start, periodEnd: p.period_end, amountCents: p.amount_cents, currency: p.currency, status: p.status,
    paymentMethod: p.payment_method, paymentReference: p.payment_reference, paidAt: p.paid_at,
    createdByName: p.created_by_name || null, createdAt: p.created_at, updatedAt: p.updated_at, videoCount: p.video_count ?? items.length,
    overrideCount: p.override_count ?? overrideItems.length,
    overrideItems: overrideItems.map(o => ({
      id: o.id, videoId: o.video_id, campaignId: o.campaign_id, campaignName: o.campaign_name, canonicalUrl: o.canonical_url, platform: o.platform,
      fromName: o.from_name, billableViews: o.billable_views, cpmDiffCents: o.cpm_diff_cents, amountCents: o.amount_cents, weekOf: o.fetched_at
    })),
    lineItems: items.map(li => ({
      id: li.id, videoId: li.video_id, campaignId: li.campaign_id, campaignName: li.campaign_name, canonicalUrl: li.canonical_url,
      platform: li.platform, billableViews: li.billable_views, cpmRateCents: li.cpm_rate_cents, amountCents: li.amount_cents, weekOf: li.fetched_at
    }))
  };
}

const PAYOUT_SQL = `SELECT p.*, cr.name creator_name, cr.email creator_email, cr.payout_method creator_payout_method,
    cr.payout_details_last4 creator_payout_last4, cr.tax_form_received, u.name created_by_name,
    (SELECT COUNT(*) FROM payout_line_items li WHERE li.payout_id = p.id) video_count,
    (SELECT COUNT(*) FROM payout_override_items poi WHERE poi.payout_id = p.id) override_count
  FROM payouts p JOIN creators cr ON cr.id = p.creator_id LEFT JOIN users u ON u.id = p.created_by`;

const ITEMS_SQL = `SELECT li.*, c.name campaign_name, v.canonical_url, v.platform, s.fetched_at FROM payout_line_items li
  LEFT JOIN campaigns c ON c.id = li.campaign_id LEFT JOIN videos v ON v.id = li.video_id LEFT JOIN view_snapshots s ON s.id = li.view_snapshot_id`;

export const OVERRIDE_ITEMS_SQL = `SELECT poi.*, c.name campaign_name, v.canonical_url, v.platform, cr.name from_name, s.fetched_at FROM payout_override_items poi
  LEFT JOIN campaigns c ON c.id = poi.campaign_id LEFT JOIN videos v ON v.id = poi.video_id LEFT JOIN view_snapshots s ON s.id = poi.view_snapshot_id
  LEFT JOIN campaign_affiliates src ON src.id = poi.source_campaign_affiliate_id LEFT JOIN creators cr ON cr.id = src.creator_id`;

async function loadPayout(env, id) {
  const [payout, items, overrideItems] = await env.DB.batch([
    env.DB.prepare(`${PAYOUT_SQL} WHERE p.id = ?`).bind(id),
    env.DB.prepare(`${ITEMS_SQL} WHERE li.payout_id = ? ORDER BY c.name, s.fetched_at`).bind(id),
    env.DB.prepare(`${OVERRIDE_ITEMS_SQL} WHERE poi.payout_id = ? ORDER BY c.name, s.fetched_at`).bind(id)
  ]);
  if (!payout.results[0]) throw new HttpError(404, 'Payout not found.');
  return payoutJson(payout.results[0], items.results, overrideItems.results);
}

// Everyone with money earned: owed = earned (paid weekly, as soon as priced) − paid, and what's ready to
// put on a payout now.
async function owed(request, env, headers) {
  await requireUser(request, env);
  const rows = await env.DB.prepare(`SELECT cr.id, cr.name, cr.email, cr.payout_method, cr.payout_details_last4, cr.tax_form_received, cr.country,
      (SELECT COALESCE(SUM(v.earned_cents), 0) FROM videos v WHERE v.creator_id = cr.id)
        + (SELECT COALESCE(SUM(oe.amount_cents), 0) FROM override_earnings oe WHERE oe.creator_id = cr.id) earned_cents,
      (SELECT COALESCE(SUM(oe.amount_cents), 0) FROM override_earnings oe WHERE oe.creator_id = cr.id) override_cents,
      (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payouts p WHERE p.creator_id = cr.id AND p.status = 'paid') paid_cents,
      (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payouts p WHERE p.creator_id = cr.id AND p.status IN ('pending', 'approved')) in_progress_cents,
      (SELECT COALESCE(SUM(s.earned_cents), 0) FROM view_snapshots s JOIN videos v ON v.id = s.video_id
         WHERE v.creator_id = cr.id AND v.status IN ('approved', 'locked') AND s.earned_cents > 0
         AND NOT EXISTS (SELECT 1 FROM payout_line_items li WHERE li.view_snapshot_id = s.id))
        + (SELECT COALESCE(SUM(oe.amount_cents), 0) FROM override_earnings oe JOIN videos v ON v.id = oe.video_id
         WHERE oe.creator_id = cr.id AND v.status IN ('approved', 'locked')
         AND NOT EXISTS (SELECT 1 FROM payout_override_items poi WHERE poi.view_snapshot_id = oe.view_snapshot_id AND poi.campaign_affiliate_id = oe.campaign_affiliate_id)) ready_cents,
      (SELECT COUNT(*) FROM view_snapshots s JOIN videos v ON v.id = s.video_id
         WHERE v.creator_id = cr.id AND v.status IN ('approved', 'locked') AND s.earned_cents > 0
         AND NOT EXISTS (SELECT 1 FROM payout_line_items li WHERE li.view_snapshot_id = s.id)) ready_weeks
    FROM creators cr WHERE EXISTS (SELECT 1 FROM campaign_affiliates ca WHERE ca.creator_id = cr.id)
    ORDER BY ready_cents DESC, cr.name`).all();
  return json({
    ok: true,
    creators: rows.results.filter(r => r.earned_cents || r.paid_cents).map(r => ({
      id: r.id, name: r.name, email: r.email, country: r.country || '', payoutMethod: r.payout_method || '', payoutDetailsLast4: r.payout_details_last4 || '',
      taxFormReceived: r.tax_form_received === 1, earnedCents: r.earned_cents, paidCents: r.paid_cents, overrideCents: r.override_cents,
      owedCents: r.earned_cents - r.paid_cents, inProgressCents: r.in_progress_cents, readyCents: r.ready_cents, readyWeeks: r.ready_weeks
    }))
  }, 200, headers);
}

async function listPayouts(request, env, headers) {
  await requireUser(request, env);
  const status = new URL(request.url).searchParams.get('status') || '';
  const rows = await env.DB.prepare(`${PAYOUT_SQL} WHERE (? = '' OR p.status = ?) ORDER BY p.created_at DESC LIMIT 500`).bind(status, status).all();
  return json({ ok: true, payouts: rows.results.map(p => payoutJson(p)) }, 200, headers);
}

async function getPayout(request, env, headers, [id]) {
  await requireUser(request, env);
  return json({ ok: true, payout: await loadPayout(env, id) }, 200, headers);
}

async function createPayout(request, env, headers) {
  const user = await requireAdmin(request, env);
  const body = await readJson(request);
  const creator = await env.DB.prepare('SELECT id, name, payout_method FROM creators WHERE id = ?').bind(clean(body.creatorId, 64)).first();
  if (!creator) throw new HttpError(404, 'Creator not found.');
  const [videoRows, overrideRows] = await env.DB.batch([env.DB.prepare(UNPAID_SQL).bind(creator.id), env.DB.prepare(UNPAID_OVERRIDES_SQL).bind(creator.id)]);
  const videos = videoRows.results;
  const overrides = overrideRows.results;
  if (!videos.length && !overrides.length) throw new HttpError(400, `${creator.name} has nothing waiting to be paid.`);

  const id = crypto.randomUUID();
  const stamp = now();
  const amount = videos.reduce((n, v) => n + v.earned_cents, 0) + overrides.reduce((n, o) => n + o.amount_cents, 0);
  const all = [...videos, ...overrides];
  const days = all.map(v => (v.fetched_at || v.submitted_at).slice(0, 10)).sort();
  const payout = {
    id, creator_id: creator.id, period_start: days[0], period_end: days[days.length - 1],
    amount_cents: amount, currency: 'USD', status: 'pending', payment_method: creator.payout_method || null,
    created_by: user.id, created_at: stamp, updated_at: stamp
  };
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO payouts (${Object.keys(payout).join(', ')}) VALUES (${Object.keys(payout).map(() => '?').join(', ')})`).bind(...Object.values(payout)),
      ...videos.map(v => env.DB.prepare(`INSERT INTO payout_line_items (id, payout_id, view_snapshot_id, video_id, campaign_id, billable_views, cpm_rate_cents, amount_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), id, v.view_snapshot_id, v.video_id, v.campaign_id, v.billable_views, v.cpm_rate_cents, v.earned_cents)),
      ...overrides.map(o => env.DB.prepare(`INSERT INTO payout_override_items (id, payout_id, view_snapshot_id, video_id, campaign_affiliate_id, campaign_id, source_campaign_affiliate_id, billable_views, cpm_diff_cents, amount_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), id, o.view_snapshot_id, o.video_id, o.campaign_affiliate_id, o.campaign_id, o.source_campaign_affiliate_id, o.billable_views, o.cpm_diff_cents, o.amount_cents)),
      auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'payout', entityId: id, action: 'payout_created', after: { creator_id: creator.id, amount_cents: amount, videos: videos.length, overrides: overrides.length } })
    ]);
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) throw new HttpError(409, 'Some of these weeks were just added to another payout. Refresh and try again.');
    throw error;
  }
  return json({ ok: true, payout: await loadPayout(env, id) }, 201, headers);
}

async function updatePayout(request, env, headers, [id]) {
  const user = await requireAdmin(request, env);
  const existing = await env.DB.prepare('SELECT * FROM payouts WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Payout not found.');
  const body = await readJson(request);
  const fields = {};
  if (body.paymentMethod !== undefined) {
    if (body.paymentMethod !== null && !PAYOUT_METHODS.includes(body.paymentMethod)) throw new HttpError(400, `Payment method must be one of: ${PAYOUT_METHODS.join(', ')}.`);
    fields.payment_method = body.paymentMethod;
  }
  if (body.paymentReference !== undefined) fields.payment_reference = clean(body.paymentReference, 300) || null;
  if (body.status !== undefined && body.status !== existing.status) {
    if (!(TRANSITIONS[existing.status] || []).includes(body.status)) throw new HttpError(409, `A ${existing.status} payout can't be marked ${body.status}.`);
    fields.status = body.status;
    if (body.status === 'paid') {
      const method = fields.payment_method ?? existing.payment_method;
      const reference = fields.payment_reference ?? existing.payment_reference;
      if (!method) throw new HttpError(400, 'Pick how it was paid.');
      if (!reference) throw new HttpError(400, 'Add the payment reference (transaction ID, transfer number…).');
      fields.paid_at = now();
    }
  }
  if (existing.status === 'paid' && Object.keys(fields).some(k => k !== 'payment_reference')) throw new HttpError(409, 'Paid payouts can’t be changed.');
  if (!Object.keys(fields).length) return json({ ok: true, payout: await loadPayout(env, id) }, 200, headers);
  fields.updated_at = now();
  const statements = [env.DB.prepare(`UPDATE payouts SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(fields), id)];
  if (fields.status || 'payment_reference' in fields || 'payment_method' in fields) {
    statements.push(auditStatement(env, {
      actorType: 'user', actorId: user.id, entityType: 'payout', entityId: id, action: fields.status ? 'payout_status_changed' : 'payout_updated',
      before: { status: existing.status, payment_method: existing.payment_method, payment_reference: existing.payment_reference },
      after: { status: fields.status ?? existing.status, payment_method: fields.payment_method ?? existing.payment_method, payment_reference: fields.payment_reference ?? existing.payment_reference }
    }));
  }
  await env.DB.batch(statements);
  return json({ ok: true, payout: await loadPayout(env, id) }, 200, headers);
}

async function deletePayout(request, env, headers, [id]) {
  const user = await requireAdmin(request, env);
  const existing = await env.DB.prepare('SELECT * FROM payouts WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Payout not found.');
  if (!['pending', 'failed'].includes(existing.status)) throw new HttpError(409, 'Only pending or failed payouts can be deleted.');
  // The week's price itself never changes (once priced, always priced) — deleting just frees those
  // already-priced weeks (ON DELETE CASCADE on payout_line_items/payout_override_items) to go on a new payout.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM payouts WHERE id = ?').bind(id),
    auditStatement(env, { actorType: 'user', actorId: user.id, entityType: 'payout', entityId: id, action: 'payout_deleted', before: { status: existing.status, amount_cents: existing.amount_cents, creator_id: existing.creator_id } })
  ]);
  return json({ ok: true }, 200, headers);
}

export const payoutRoutes = {
  'GET /api/payouts/owed': owed,
  'GET /api/payouts': listPayouts,
  'POST /api/payouts': createPayout,
  'GET /api/payouts/:id': getPayout,
  'PATCH /api/payouts/:id': updatePayout,
  'DELETE /api/payouts/:id': deletePayout
};
