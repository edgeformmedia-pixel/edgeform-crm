// ─── Affiliate campaigns ──────────────────────────────────────
// Campaigns live on marketing operations. Each has an Email tab (placeholder) and an Affiliate tab:
// affiliates, per-affiliate CPM, earnings, and (later phases) videos, flags and payouts.

const CMP_STATUS_CHIP = { draft: 'chip-muted', active: 'chip-green', paused: 'chip-orange', ended: 'chip-purple' };
const AFF_STATUS_CHIP = { invited: 'chip-orange', active: 'chip-green', removed: 'chip-muted' };
const CMP_PLATFORMS = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };
const cmpCache = {};        // operationId → campaigns
let cmpCurrent = null;      // campaign open in the campaign view
let cmpTab = 'affiliate';
let cmpEditingId = null;    // campaign in the form modal (null = new)
let cmpFormOp = null;
let affMode = 'existing';

const cmpMoney = (cents) => (cents === null || cents === undefined ? '—' : (cents < 0 ? '−$' : '$') + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cmpNum = (n) => Number(n || 0).toLocaleString('en-US');
const cmpDollarInput = (cents) => (cents === null || cents === undefined ? '' : String(cents / 100));

// "$25" / "25.5" → cents; blank → null.
function cmpCents(value, label) {
  const text = String(value ?? '').trim().replace(/[$,\s]/g, '');
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a dollar amount.`);
  return Math.round(n * 100);
}

function cmpWhole(value, label) {
  const text = String(value ?? '').trim().replace(/[,\s]/g, '');
  if (!text) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a whole number.`);
  return n;
}

async function cmpRequest(path, options) {
  const res = await api(path, options);
  if (!res.ok) throw new Error(res.error || 'Something went wrong.');
  return res;
}

function cmpMsg(id, text, kind = 'error') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = text ? `email-msg show ${kind}` : 'email-msg';
}

// ── Section on a marketing operation ──

function opCampaignsHtml(op) {
  setTimeout(() => renderOpCampaigns(op.id, !cmpCache[op.id]), 0);
  return '<div id="opd-campaigns"><div class="state-box opd-empty">Loading campaigns…</div></div>';
}

async function renderOpCampaigns(operationId, refetch = true) {
  const box = document.getElementById('opd-campaigns');
  if (!box) return;
  if (refetch || !cmpCache[operationId]) {
    try {
      cmpCache[operationId] = (await cmpRequest(`/api/operations/${encodeURIComponent(operationId)}/campaigns`)).campaigns;
    } catch (err) {
      box.innerHTML = `<div class="state-box opd-empty">Couldn't load campaigns: ${esc(err.message)}</div>`;
      return;
    }
  }
  const list = cmpCache[operationId];
  const current = document.getElementById('opd-campaigns');
  if (!current) return;
  current.innerHTML = `${list.length ? `<div class="cmp-grid">${list.map(c => `
      <button class="cmp-card" data-id="${esc(c.id)}" onclick="openCampaign(this.dataset.id)">
        <div class="cmp-card-top"><span class="chip ${CMP_STATUS_CHIP[c.status] || 'chip-muted'}">${esc(c.status)}</span>
          ${c.pendingReview ? `<span class="chip chip-orange">${c.pendingReview} to review</span>` : ''}
          ${c.openFlags ? `<span class="chip chip-red">${c.openFlags} flag${c.openFlags === 1 ? '' : 's'}</span>` : ''}</div>
        <div class="cmp-card-name">${esc(c.name)}</div>
        <div class="cmp-card-meta"><span>${cmpMoney(c.defaultCpmRateCents)} / 1K views</span><span>${c.affiliateCount} affiliate${c.affiliateCount === 1 ? '' : 's'}</span>
          <span>${c.videoCount} video${c.videoCount === 1 ? '' : 's'}</span><span>${cmpNum(c.views)} views</span></div>
        <div class="cmp-card-meta"><span>Earned ${cmpMoney(c.earnedCents)}</span><span>Still counting ${cmpMoney(c.pendingCents)}</span></div>
      </button>`).join('')}</div>` : '<div class="state-box opd-empty">No campaigns yet. A campaign gets an Affiliate tab (creators paid per 1,000 views) and an Email tab.</div>'}
    <div class="opd-add"><button class="action-btn primary" data-op="${esc(operationId)}" onclick="openCampaignForm(null, this.dataset.op)">+ New campaign</button></div>`;
}

// ── Campaign create / edit modal ──

function ensureCampaignModals() {
  if (document.getElementById('cmp-modal')) return;
  document.body.insertAdjacentHTML('beforeend', `
<div class="ops-modal-bg" id="cmp-modal" hidden onclick="if (event.target === this) closeCampaignForm()">
  <div class="ops-modal" role="dialog" aria-labelledby="cmp-modal-title">
    <div class="ops-modal-head"><span class="compose-title" id="cmp-modal-title">New campaign</span><button class="drawer-close" onclick="closeCampaignForm()" aria-label="Close">✕</button></div>
    <div class="ops-modal-body">
      <div class="ops-form-grid">
        <div class="c-field full"><label>Campaign name</label><input class="c-input" id="cmpf-name" type="text" placeholder="Spring launch"></div>
        <div class="c-field"><label>Status</label><select class="c-input" id="cmpf-status"><option value="draft">Draft (hidden from affiliates)</option><option value="active">Active (accepting videos)</option><option value="paused">Paused</option><option value="ended">Ended</option></select></div>
        <div class="c-field"><label>Pay per 1,000 views (CPM)</label><div class="cmp-money"><input class="c-input" id="cmpf-cpm" inputmode="decimal" placeholder="25.00"></div></div>
        <div class="c-field"><label>Start date</label><input class="c-input" id="cmpf-start" type="date"></div>
        <div class="c-field"><label>End date</label><input class="c-input" id="cmpf-end" type="date"></div>
        <div class="c-field full"><label>Platforms allowed</label><div class="cmp-platforms">${Object.entries(CMP_PLATFORMS).map(([k, label]) => `<label class="cmp-check"><input type="checkbox" data-platform="${k}"> ${label}</label>`).join('')}</div></div>
        <div class="c-field"><label>Max payout per video</label><div class="cmp-money"><input class="c-input" id="cmpf-max-video" inputmode="decimal" placeholder="No limit"></div></div>
        <div class="c-field"><label>Max payout per affiliate</label><div class="cmp-money"><input class="c-input" id="cmpf-max-affiliate" inputmode="decimal" placeholder="No limit"></div></div>
        <div class="c-field"><label>Total budget</label><div class="cmp-money"><input class="c-input" id="cmpf-budget" inputmode="decimal" placeholder="No limit"></div></div>
        <div class="c-field"><label>Minimum views to earn</label><input class="c-input" id="cmpf-min-views" inputmode="numeric" placeholder="None"></div>
        <div class="c-field"><label>Track views for (days)</label><input class="c-input" id="cmpf-window" inputmode="numeric" placeholder="30"><div class="ops-hint">Counted from when a video is submitted. After that its views freeze and it can be paid.</div></div>
        <div class="c-field"><label>Review videos first?</label><label class="cmp-check" style="padding:9px 0;"><input type="checkbox" id="cmpf-approval"> Approve each video before it earns</label></div>
        <div class="c-field full"><label>Brief (shown to affiliates)</label><textarea class="c-input" id="cmpf-brief" style="min-height:140px;" placeholder="What to post, talking points, hashtags, dos and don'ts…"></textarea></div>
      </div>
      <div class="email-msg" id="cmpf-msg"></div>
    </div>
    <div class="ops-modal-foot">
      <button class="action-btn" id="cmpf-delete" onclick="deleteCampaign()" hidden>Delete</button>
      <button class="action-btn" onclick="closeCampaignForm()">Cancel</button>
      <button class="send-btn" id="cmpf-save" onclick="saveCampaign()"><span class="btn-text">Create campaign</span></button>
    </div>
  </div>
</div>
<div class="ops-modal-bg" id="aff-modal" hidden onclick="if (event.target === this) closeAffiliateForm()">
  <div class="ops-modal" role="dialog" aria-labelledby="aff-modal-title">
    <div class="ops-modal-head"><span class="compose-title" id="aff-modal-title">Add affiliate</span><button class="drawer-close" onclick="closeAffiliateForm()" aria-label="Close">✕</button></div>
    <div class="ops-modal-body">
      <div class="billing-tabs aff-tabs"><button class="billing-tab" id="aff-tab-existing" onclick="setAffiliateMode('existing')">Pick a creator</button><button class="billing-tab" id="aff-tab-new" onclick="setAffiliateMode('new')">New creator</button></div>
      <div id="aff-existing">
        <input class="c-input" id="aff-search" type="search" placeholder="Search creators by name, email, or handle…" oninput="renderAffiliateSearch()">
        <div class="aff-results" id="aff-results"></div>
      </div>
      <div id="aff-new" hidden>
        <div class="ops-form-grid">
          <div class="c-field"><label>Name *</label><input class="c-input" id="affn-name" type="text"></div>
          <div class="c-field"><label>Email * (their portal login)</label><input class="c-input" id="affn-email" type="email"></div>
          <div class="c-field"><label>Phone</label><input class="c-input" id="affn-phone" type="tel"></div>
          <div class="c-field"><label>TikTok</label><input class="c-input" id="affn-tiktok" placeholder="@handle"></div>
          <div class="c-field"><label>Instagram</label><input class="c-input" id="affn-instagram" placeholder="@handle"></div>
          <div class="c-field"><label>YouTube</label><input class="c-input" id="affn-youtube" placeholder="@handle"></div>
        </div>
        <div class="ops-hint">Saved to Creators too (added by hand).</div>
        <button class="action-btn primary" style="margin-top:12px;" onclick="addAffiliate()">Add and send invite</button>
      </div>
      <div class="c-field" style="margin-top:14px;"><label>Their pay per 1,000 views (optional)</label><div class="cmp-money"><input class="c-input" id="aff-override" inputmode="decimal" placeholder="Campaign rate"></div>
        <div class="ops-hint">Leave blank to use the campaign's rate. Adding someone emails them an invite to affiliate.edgeformmarketing.com.</div></div>
      <div class="email-msg" id="aff-msg"></div>
    </div>
    <div class="ops-modal-foot"><button class="action-btn" onclick="closeAffiliateForm()">Done</button></div>
  </div>
</div>`);
}

function openCampaignForm(id, operationId) {
  ensureCampaignModals();
  const c = id ? cmpCurrent : null;
  cmpEditingId = id;
  cmpFormOp = operationId || c?.operationId;
  const set = (field, value) => { document.getElementById('cmpf-' + field).value = value ?? ''; };
  set('name', c?.name); set('status', c?.status || 'draft'); set('cpm', cmpDollarInput(c?.defaultCpmRateCents));
  set('start', c?.startDate); set('end', c?.endDate); set('brief', c?.brief);
  set('max-video', cmpDollarInput(c?.maxPayoutPerVideoCents)); set('max-affiliate', cmpDollarInput(c?.maxPayoutPerAffiliateCents));
  set('budget', cmpDollarInput(c?.totalBudgetCents)); set('min-views', c?.minViewsToQualify ?? ''); set('window', c?.viewTrackingWindowDays ?? 30);
  document.getElementById('cmpf-approval').checked = c ? c.requiresVideoApproval : true;
  document.querySelectorAll('#cmp-modal [data-platform]').forEach(el => { el.checked = c ? c.platformsAllowed.includes(el.dataset.platform) : true; });
  document.getElementById('cmp-modal-title').textContent = c ? 'Edit campaign' : 'New campaign';
  document.querySelector('#cmpf-save .btn-text').textContent = c ? 'Save campaign' : 'Create campaign';
  document.getElementById('cmpf-delete').hidden = !c || !['admin', 'owner'].includes(currentUser.role);
  cmpMsg('cmpf-msg', '');
  document.getElementById('cmp-modal').hidden = false;
  document.getElementById('cmpf-name').focus();
}

function closeCampaignForm() { document.getElementById('cmp-modal').hidden = true; }

async function saveCampaign() {
  const v = (f) => document.getElementById('cmpf-' + f).value;
  const btn = document.getElementById('cmpf-save');
  let body;
  try {
    body = {
      name: v('name').trim(), status: v('status'), brief: v('brief'), startDate: v('start') || null, endDate: v('end') || null,
      platformsAllowed: [...document.querySelectorAll('#cmp-modal [data-platform]:checked')].map(el => el.dataset.platform),
      defaultCpmRateCents: cmpCents(v('cpm'), 'Pay per 1,000 views') ?? 0,
      maxPayoutPerVideoCents: cmpCents(v('max-video'), 'Max per video'),
      maxPayoutPerAffiliateCents: cmpCents(v('max-affiliate'), 'Max per affiliate'),
      totalBudgetCents: cmpCents(v('budget'), 'Total budget'),
      minViewsToQualify: cmpWhole(v('min-views'), 'Minimum views'),
      viewTrackingWindowDays: cmpWhole(v('window'), 'Tracking days') ?? 30,
      requiresVideoApproval: document.getElementById('cmpf-approval').checked
    };
    if (!body.name) throw new Error('Campaign name is required.');
    if (!body.platformsAllowed.length) throw new Error('Pick at least one platform.');
  } catch (err) { cmpMsg('cmpf-msg', err.message); return; }
  btn.disabled = true;
  try {
    const { campaign } = cmpEditingId
      ? await cmpRequest(`/api/campaigns/${encodeURIComponent(cmpEditingId)}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await cmpRequest(`/api/operations/${encodeURIComponent(cmpFormOp)}/campaigns`, { method: 'POST', body: JSON.stringify(body) });
    delete cmpCache[campaign.operationId];
    closeCampaignForm();
    if (cmpEditingId) { cmpCurrent = campaign; renderCampaignView(); } else openCampaign(campaign.id, campaign);
  } catch (err) {
    cmpMsg('cmpf-msg', err.message);
  } finally { btn.disabled = false; }
}

async function deleteCampaign() {
  if (!cmpCurrent || !confirm(`Delete the "${cmpCurrent.name}" campaign, its affiliates and videos? This can't be undone.`)) return;
  try {
    await cmpRequest(`/api/campaigns/${encodeURIComponent(cmpCurrent.id)}`, { method: 'DELETE' });
    delete cmpCache[cmpCurrent.operationId];
    closeCampaignForm();
    closeCampaign();
  } catch (err) { cmpMsg('cmpf-msg', err.message); }
}

// ── Campaign view ──

function campaignViewEl() {
  let el = document.getElementById('campaign-view');
  if (!el) {
    document.getElementById('page-operations').insertAdjacentHTML('beforeend', '<div id="campaign-view" hidden></div>');
    el = document.getElementById('campaign-view');
  }
  return el;
}

async function openCampaign(id, preloaded) {
  const view = campaignViewEl();
  document.getElementById('ops-detail').hidden = true;
  document.getElementById('ops-browse').hidden = true;
  view.hidden = false;
  window.scrollTo(0, 0);
  if (preloaded) { cmpCurrent = preloaded; renderCampaignView(); return; }
  if (cmpCurrent?.id !== id) view.innerHTML = '<div class="state-box"><div class="state-icon">▣</div>Loading campaign…</div>';
  try {
    cmpCurrent = (await cmpRequest(`/api/campaigns/${encodeURIComponent(id)}`)).campaign;
    renderCampaignView();
  } catch (err) {
    view.innerHTML = `<div class="cmp-bar"><button class="refresh-btn" onclick="closeCampaign()">← Back</button></div><div class="state-box">Couldn't load this campaign: ${esc(err.message)}</div>`;
  }
}

function closeCampaign() {
  const opId = cmpCurrent?.operationId;
  cmpCurrent = null;
  campaignViewEl().hidden = true;
  if (opDraft && opDraft.id === opId) {
    document.getElementById('ops-detail').hidden = false;
    renderOpCampaigns(opId);
  } else if (opId && allOperations.some(o => o.id === opId)) {
    openOpDetail(opId);
  } else {
    document.getElementById('ops-browse').hidden = false;
  }
}

const refreshCampaign = () => cmpCurrent && openCampaign(cmpCurrent.id);

function renderCampaignView() {
  const c = cmpCurrent;
  const op = allOperations.find(o => o.id === c.operationId);
  const active = c.affiliates.filter(a => a.status !== 'removed');
  const owed = active.reduce((n, a) => n + a.owedCents, 0);
  campaignViewEl().innerHTML = `
    <div class="cmp-bar">
      <button class="refresh-btn" onclick="closeCampaign()">← ${esc(op?.name || 'Operation')}</button>
      <span class="cmp-spacer"></span>
      <button class="refresh-btn" onclick="refreshCampaign()">↻ Refresh</button>
      <button class="action-btn" onclick="openCampaignForm(cmpCurrent.id)">Edit campaign</button>
    </div>
    <div class="cmp-title"><span class="chip chip-blue">Campaign</span> <span class="chip ${CMP_STATUS_CHIP[c.status] || 'chip-muted'}">${esc(c.status)}</span><h1>${esc(c.name)}</h1></div>
    <div class="cmp-sub">
      <span>${cmpMoney(c.defaultCpmRateCents)} per 1K views</span>
      <span>${c.platformsAllowed.map(p => CMP_PLATFORMS[p]).join(' · ')}</span>
      <span>Views tracked ${c.viewTrackingWindowDays} days</span>
      ${c.requiresVideoApproval ? '<span>Videos need approval</span>' : '<span>Videos earn right away</span>'}
      ${c.minViewsToQualify ? `<span>Min ${cmpNum(c.minViewsToQualify)} views</span>` : ''}
      ${c.maxPayoutPerVideoCents !== null ? `<span>Max ${cmpMoney(c.maxPayoutPerVideoCents)}/video</span>` : ''}
      ${c.maxPayoutPerAffiliateCents !== null ? `<span>Max ${cmpMoney(c.maxPayoutPerAffiliateCents)}/affiliate</span>` : ''}
      ${c.totalBudgetCents !== null ? `<span>Budget ${cmpMoney(c.totalBudgetCents)}</span>` : ''}
      ${c.startDate || c.endDate ? `<span>${esc(c.startDate || '…')} → ${esc(c.endDate || '…')}</span>` : ''}
    </div>
    <div class="billing-tabs">
      <button class="billing-tab${cmpTab === 'affiliate' ? ' active' : ''}" onclick="cmpTab='affiliate';renderCampaignView()">Affiliate</button>
      <button class="billing-tab${cmpTab === 'email' ? ' active' : ''}" onclick="cmpTab='email';renderCampaignView()">Email</button>
    </div>
    ${cmpTab === 'email' ? '<div class="cmp-placeholder">✉<br><br>Email campaigns are coming soon.</div>' : `
    <div class="cmp-kpis">
      <div class="cmp-kpi"><div class="cmp-kpi-label">Affiliates</div><div class="cmp-kpi-val">${active.length}</div><div class="cmp-kpi-sub">${active.filter(a => a.status === 'invited').length} haven't signed in</div></div>
      <div class="cmp-kpi"><div class="cmp-kpi-label">Videos</div><div class="cmp-kpi-val">${cmpNum(c.videoCount)}</div><div class="cmp-kpi-sub">${c.pendingReview} to review</div></div>
      <div class="cmp-kpi"><div class="cmp-kpi-label">Views</div><div class="cmp-kpi-val">${cmpNum(c.views)}</div><div class="cmp-kpi-sub">approved + locked</div></div>
      <div class="cmp-kpi"><div class="cmp-kpi-label">Earned</div><div class="cmp-kpi-val">${cmpMoney(c.earnedCents)}</div><div class="cmp-kpi-sub">locked videos</div></div>
      <div class="cmp-kpi"><div class="cmp-kpi-label">Still counting</div><div class="cmp-kpi-val">${cmpMoney(c.pendingCents)}</div><div class="cmp-kpi-sub">estimated</div></div>
      <div class="cmp-kpi"><div class="cmp-kpi-label">Owed</div><div class="cmp-kpi-val">${cmpMoney(owed)}</div><div class="cmp-kpi-sub">earned − paid</div></div>
    </div>
    ${affiliatesPanelHtml(c)}
    ${typeof campaignVideosPanelHtml === 'function' ? campaignVideosPanelHtml(c) : ''}
    <div class="panel cmp-panel"><div class="panel-head"><span class="panel-title">Brief</span></div>
      <div class="cmp-brief">${c.brief ? esc(c.brief) : '<span class="feed-time">No brief yet. Edit the campaign to add one. Affiliates see it in their portal.</span>'}</div></div>`}`;
}

function affiliatesPanelHtml(c) {
  const rows = c.affiliates.map(a => {
    const id = esc(a.id);
    const removed = a.status === 'removed';
    return `<tr${removed ? ' style="opacity:.55"' : ''}>
      <td><div class="cmp-who"><b>${esc(a.creator.name)}</b><span>${esc(a.creator.email || 'no email')}</span>
        ${a.creator.payoutMethod ? `<span>Pays via ${esc(a.creator.payoutMethod)}${a.creator.payoutDetailsLast4 ? ' ••' + esc(a.creator.payoutDetailsLast4) : ''}</span>` : ''}</div></td>
      <td><span class="chip ${AFF_STATUS_CHIP[a.status] || 'chip-muted'}">${esc(a.status)}</span>
        ${a.status === 'invited' ? `<div class="feed-time">${a.invitedAt ? 'Invited ' + fmtDate(a.invitedAt) : 'Invite not sent'}</div>` : ''}</td>
      <td><div class="cmp-rate"><div class="cmp-money"><input class="c-input" inputmode="decimal" value="${esc(cmpDollarInput(a.cpmRateOverrideCents))}" placeholder="${esc(cmpDollarInput(c.defaultCpmRateCents))}" data-id="${id}" onchange="setAffiliateRate(this)" title="Blank = campaign rate"></div><small>${a.cpmRateOverrideCents === null ? 'default' : 'custom'}</small></div></td>
      <td class="num">${cmpNum(a.videoCount)}</td>
      <td class="num">${cmpNum(a.views)}</td>
      <td class="num">${cmpMoney(a.earnedCents)}</td>
      <td class="num">${cmpMoney(a.pendingCents)}</td>
      <td class="num">${cmpMoney(a.paidCents)}</td>
      <td class="num strong">${cmpMoney(a.owedCents)}</td>
      <td><div class="cmp-row-actions">
        ${removed
          ? `<button class="action-btn" data-id="${id}" onclick="setAffiliateStatus(this.dataset.id, 'invited')">Add back</button>`
          : `${a.status === 'invited' ? `<button class="action-btn" data-id="${id}" onclick="resendAffiliateInvite(this.dataset.id, this)">Resend invite</button>` : ''}
             <button class="action-btn" data-id="${id}" onclick="setAffiliateStatus(this.dataset.id, 'removed')">Remove</button>`}
      </div></td>
    </tr>`;
  }).join('');
  return `<div class="panel cmp-panel">
    <div class="panel-head"><span class="panel-title">Affiliates</span>
      <div class="cmp-panel-actions"><button class="action-btn" onclick="exportCampaignCsv()">Export CSV</button><button class="action-btn primary" onclick="openAffiliateForm()">+ Add affiliate</button></div></div>
    ${c.affiliates.length ? `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr>
      <th>Affiliate</th><th>Status</th><th>CPM</th><th class="num">Videos</th><th class="num">Views</th><th class="num">Earned</th><th class="num">Pending</th><th class="num">Paid</th><th class="num">Owed</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="cmp-empty">No affiliates yet. Add a creator to send them an invite.</div>'}
    <div class="email-msg" id="cmp-aff-msg" style="margin:0 18px 14px;"></div>
  </div>`;
}

async function setAffiliateRate(input) {
  let cents;
  try { cents = cmpCents(input.value, 'Rate'); } catch (err) { cmpMsg('cmp-aff-msg', err.message); return; }
  try {
    await cmpRequest(`/api/campaign-affiliates/${encodeURIComponent(input.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ cpmRateOverrideCents: cents }) });
    refreshCampaign();
  } catch (err) { cmpMsg('cmp-aff-msg', 'Rate not saved: ' + err.message); }
}

async function setAffiliateStatus(id, status) {
  const a = cmpCurrent.affiliates.find(x => x.id === id);
  if (status === 'removed' && !confirm(`Remove ${a?.creator.name || 'this affiliate'} from the campaign? They'll stop seeing it in the portal. Their videos and earnings stay.`)) return;
  try {
    await cmpRequest(`/api/campaign-affiliates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    refreshCampaign();
  } catch (err) { cmpMsg('cmp-aff-msg', err.message); }
}

async function resendAffiliateInvite(id, btn) {
  btn.disabled = true;
  try {
    await cmpRequest(`/api/campaign-affiliates/${encodeURIComponent(id)}/invite`, { method: 'POST' });
    cmpMsg('cmp-aff-msg', 'Invite sent.', 'success');
    refreshCampaign();
  } catch (err) { cmpMsg('cmp-aff-msg', 'Invite not sent: ' + err.message); btn.disabled = false; }
}

function cmpCsv(rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map(r => r.map(cell).join(',')).join('\r\n');
}

function downloadCsv(name, rows) {
  const blob = new Blob([cmpCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportCampaignCsv() {
  const c = cmpCurrent;
  const d = (cents) => (cents / 100).toFixed(2);
  downloadCsv(`${c.name.replace(/[^\w-]+/g, '-').toLowerCase()}-affiliates.csv`, [
    ['Affiliate', 'Email', 'Status', 'CPM (USD per 1K)', 'Videos', 'Views', 'Earned (USD)', 'Pending (USD)', 'Paid (USD)', 'Owed (USD)', 'Payout method', 'Joined'],
    ...c.affiliates.map(a => [a.creator.name, a.creator.email, a.status, d(a.effectiveCpmRateCents), a.videoCount, a.views,
      d(a.earnedCents), d(a.pendingCents), d(a.paidCents), d(a.owedCents), a.creator.payoutMethod, a.joinedAt || ''])
  ]);
}

// ── Add affiliate ──

async function openAffiliateForm() {
  ensureCampaignModals();
  ['name', 'email', 'phone', 'tiktok', 'instagram', 'youtube'].forEach(f => { document.getElementById('affn-' + f).value = ''; });
  document.getElementById('aff-search').value = '';
  document.getElementById('aff-override').value = '';
  cmpMsg('aff-msg', '');
  setAffiliateMode('existing');
  document.getElementById('aff-modal').hidden = false;
  document.getElementById('aff-search').focus();
  if (!allCreators.length) { document.getElementById('aff-results').innerHTML = '<div class="cmp-empty">Loading creators…</div>'; await loadCreators(); }
  renderAffiliateSearch();
}

function closeAffiliateForm() {
  document.getElementById('aff-modal').hidden = true;
  refreshCampaign();
  loadCreators();
}

function setAffiliateMode(mode) {
  affMode = mode;
  document.getElementById('aff-existing').hidden = mode !== 'existing';
  document.getElementById('aff-new').hidden = mode !== 'new';
  document.getElementById('aff-tab-existing').classList.toggle('active', mode === 'existing');
  document.getElementById('aff-tab-new').classList.toggle('active', mode === 'new');
}

function renderAffiliateSearch() {
  const q = document.getElementById('aff-search').value.trim().toLowerCase();
  const inCampaign = new Map((cmpCurrent?.affiliates || []).map(a => [a.creatorId, a.status]));
  const rows = allCreators.filter(c => !q || [c.name, c.email, ...Object.values(c.socials || {})].join(' ').toLowerCase().includes(q)).slice(0, 30);
  document.getElementById('aff-results').innerHTML = rows.map(c => {
    const status = inCampaign.get(c.id);
    const handles = CREATOR_PLATFORMS.filter(([k]) => c.socials[k]).map(([k, , short]) => `${short} ${c.socials[k]}`).join(' · ');
    const action = status && status !== 'removed' ? '<span class="chip chip-green">in campaign</span>'
      : !c.email ? '<span class="chip chip-muted" title="Add an email on the Creators page first">needs email</span>'
      : `<button class="action-btn primary" data-id="${esc(c.id)}" onclick="addAffiliate(this.dataset.id, this)">${status === 'removed' ? 'Add back' : 'Add'}</button>`;
    return `<div class="aff-result"><div class="cmp-who"><b>${esc(c.name)}</b><span>${esc(c.email || 'no email')}${handles ? ' · ' + esc(handles) : ''}</span></div>${action}</div>`;
  }).join('') || `<div class="cmp-empty">No creators match. <button class="action-btn" onclick="setAffiliateMode('new')">Create a new one</button></div>`;
}

async function addAffiliate(creatorId, btn) {
  let override;
  try { override = cmpCents(document.getElementById('aff-override').value, 'Their pay per 1,000 views'); } catch (err) { cmpMsg('aff-msg', err.message); return; }
  const body = { cpmRateOverrideCents: override };
  if (creatorId) body.creatorId = creatorId;
  else {
    const v = (f) => document.getElementById('affn-' + f).value.trim();
    body.creator = { name: v('name'), email: v('email'), phone: v('phone'), tiktok: v('tiktok'), instagram: v('instagram'), youtube: v('youtube') };
    if (!body.creator.name || !body.creator.email) { cmpMsg('aff-msg', 'Name and email are required.'); return; }
  }
  if (btn) btn.disabled = true;
  try {
    const res = await cmpRequest(`/api/campaigns/${encodeURIComponent(cmpCurrent.id)}/affiliates`, { method: 'POST', body: JSON.stringify(body) });
    const name = res.affiliate.creator.name;
    cmpMsg('aff-msg', res.inviteSent ? `${name} added. Invite emailed to ${res.affiliate.creator.email}.` : `${name} added, but the invite email failed (${res.inviteError}). Use "Resend invite" on the campaign.`, res.inviteSent ? 'success' : 'error');
    cmpCurrent.affiliates.push(res.affiliate);
    if (res.creatorCreated) {
      ['name', 'email', 'phone', 'tiktok', 'instagram', 'youtube'].forEach(f => { document.getElementById('affn-' + f).value = ''; });
      await loadCreators();
    }
    renderAffiliateSearch();
  } catch (err) {
    cmpMsg('aff-msg', err.message);
    if (btn) btn.disabled = false;
  }
}
