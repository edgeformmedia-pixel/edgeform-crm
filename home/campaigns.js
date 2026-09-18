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
      <div class="ops-form-grid" style="margin-top:14px;">
        <div class="c-field"><label>Rank</label><select class="c-input" id="aff-rank"><option value="top_creator">Top Creator</option><option value="master">Master</option><option value="general">General</option><option value="rookie">Rookie</option></select></div>
        <div class="c-field"><label>Upline (who recruited them)</label><select class="c-input" id="aff-upline"></select></div>
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

async function activateCampaign() {
  try {
    const { campaign } = await cmpRequest(`/api/campaigns/${encodeURIComponent(cmpCurrent.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
    delete cmpCache[campaign.operationId];
    cmpCurrent = campaign;
    renderCampaignView();
  } catch (err) { alert('Not saved: ' + err.message); }
}

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
    ${c.status === 'draft' ? `<div class="email-msg show error" style="margin:0 0 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      This campaign is a draft, so affiliates can't see it in their portal yet.
      <button class="action-btn primary" onclick="activateCampaign()">Make it active</button></div>` : ''}
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
    ${pyramidPanelHtml(c)}
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
        ${a.creator.payoutMethod ? `<span>Pays via ${esc(a.creator.payoutMethod)}${a.creator.payoutDetailsLast4 ? ' ••' + esc(a.creator.payoutDetailsLast4) : ''}</span>` : ''}
        ${a.creator.connections.length ? `<span>Connected: ${a.creator.connections.map(x => `${esc(CMP_PLATFORMS[x.platform] || x.platform)} @${esc(x.username)}`).join(', ')}</span>` : ''}</div></td>
      <td><span class="chip ${RANK_CHIP[a.rank] || 'chip-muted'}">${esc(RANK_LABEL[a.rank] || a.rank)}</span>
        <div class="feed-time">${a.uplineId ? 'under ' + esc(c.affiliates.find(x => x.id === a.uplineId)?.creator.name || '—') : 'top of tree'}</div></td>
      <td><span class="chip ${AFF_STATUS_CHIP[a.status] || 'chip-muted'}">${esc(a.status)}</span>
        ${a.status === 'invited' ? `<div class="feed-time">${a.invitedAt ? 'Invited ' + fmtDate(a.invitedAt) : 'Invite not sent'}</div>` : ''}</td>
      <td><div class="cmp-rate"><div class="cmp-money"><input class="c-input" inputmode="decimal" value="${esc(cmpDollarInput(a.cpmRateOverrideCents))}" placeholder="${esc(cmpDollarInput(c.defaultCpmRateCents))}" data-id="${id}" onchange="setAffiliateRate(this)" title="Blank = campaign rate"></div><small>${a.cpmRateOverrideCents === null ? 'default' : 'custom'}</small></div></td>
      <td class="num">${cmpNum(a.videoCount)}</td>
      <td class="num">${cmpNum(a.views)}</td>
      <td class="num">${cmpMoney(a.earnedCents)}</td>
      <td class="num">${cmpMoney(a.pendingCents)}</td>
      <td class="num">${cmpMoney(a.overrideEarnedCents)}<div class="feed-time">+${cmpMoney(a.overridePendingCents)} counting</div></td>
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
      <th>Affiliate</th><th>Rank</th><th>Status</th><th>CPM</th><th class="num">Videos</th><th class="num">Views</th><th class="num">Earned</th><th class="num">Pending</th><th class="num">Team overrides</th><th class="num">Paid</th><th class="num">Owed</th><th></th>
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
    ['Affiliate', 'Email', 'Rank', 'Upline', 'Status', 'CPM (USD per 1K)', 'Videos', 'Views', 'Earned (USD)', 'Pending (USD)', 'Team overrides earned (USD)', 'Team overrides pending (USD)', 'Paid (USD)', 'Owed (USD)', 'Payout method', 'Joined'],
    ...c.affiliates.map(a => [a.creator.name, a.creator.email, RANK_LABEL[a.rank] || a.rank, c.affiliates.find(x => x.id === a.uplineId)?.creator.name || '', a.status,
      d(a.effectiveCpmRateCents), a.videoCount, a.views, d(a.earnedCents), d(a.pendingCents), d(a.overrideEarnedCents), d(a.overridePendingCents),
      d(a.paidCents), d(a.owedCents), a.creator.payoutMethod, a.joinedAt || ''])
  ]);
}

// ── Add affiliate ──

async function openAffiliateForm(preset = {}) {
  ensureCampaignModals();
  document.getElementById('aff-rank').value = preset.rank || 'rookie';
  document.getElementById('aff-upline').innerHTML = '<option value="">No upline (top of a tree)</option>' + teamMembers(cmpCurrent)
    .map(a => `<option value="${esc(a.id)}">${esc(a.creator.name)} · ${esc(RANK_LABEL[a.rank])} · ${cmpMoney(rateOfAff(a))}</option>`).join('');
  document.getElementById('aff-upline').value = preset.uplineId || '';
  const up = preset.uplineId && cmpCurrent.affiliates.find(a => a.id === preset.uplineId);
  document.getElementById('aff-modal-title').textContent = up ? `Add recruit under ${up.creator.name}` : 'Add affiliate';
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
  const body = { cpmRateOverrideCents: override, rank: document.getElementById('aff-rank').value, uplineId: document.getElementById('aff-upline').value || null };
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

// ── Videos (shared by the campaign view and the Affiliates page) ──

const VIDEO_STATUS_CHIP = { pending_review: 'chip-orange', approved: 'chip-blue', locked: 'chip-green', rejected: 'chip-red', removed: 'chip-muted' };
const VIDEO_STATUS_LABEL = { pending_review: 'to review', approved: 'tracking', locked: 'locked', rejected: 'rejected', removed: 'removed' };
const FLAG_LABEL = { handle_mismatch: 'Handle mismatch', fetch_failed: 'Views not updating', video_unavailable: 'Video unavailable', suspicious_spike: 'Suspicious spike' };
let cmpVideoFilter = 'all';
let cmpVideos = [];         // videos in the open campaign
let videoDetail = null;     // { video, snapshots, flags, audit } in the video modal

function videoRowHtml(v, { showCampaign = false } = {}) {
  const id = esc(v.id);
  const ends = v.status === 'approved' ? `Tracking until ${fmtDate(v.trackingEndsAt)}` : v.lockedAt ? `Locked ${fmtDate(v.lockedAt)}` : '';
  const actions = [];
  if (!v.payoutId) {
    if (['pending_review', 'rejected', 'removed'].includes(v.status)) actions.push(`<button class="action-btn primary" data-id="${id}" onclick="reviewVideo(this.dataset.id, 'approve', this)">${v.status === 'pending_review' ? 'Approve' : 'Restore'}</button>`);
    if (['pending_review', 'approved', 'removed'].includes(v.status)) actions.push(`<button class="action-btn" data-id="${id}" onclick="reviewVideo(this.dataset.id, 'reject', this)">Reject</button>`);
    if (['approved', 'locked'].includes(v.status)) actions.push(`<button class="action-btn" data-id="${id}" onclick="reviewVideo(this.dataset.id, 'remove', this)">Remove</button>`);
  }
  actions.push(`<button class="action-btn" data-id="${id}" onclick="openVideoDetail(this.dataset.id)">Views…</button>`);
  return `<tr>
    <td><div class="cmp-video-url"><a href="${safeUrl(v.canonicalUrl)}" target="_blank" rel="noopener">${esc(CMP_PLATFORMS[v.platform] || v.platform)} · ${esc(v.platformVideoId)} ↗</a>
      <span>Submitted ${fmtDate(v.submittedAt)}${v.caption ? ' · ' + esc(v.caption.slice(0, 60)) : ''}</span>
      ${v.openFlags.map(f => `<span class="cmp-flag" title="${esc(f.details)}">⚑ ${esc(FLAG_LABEL[f.type] || f.type)}</span>`).join('')}</div></td>
    <td><div class="cmp-who"><b>${esc(v.creator.name)}</b>${showCampaign ? `<span>${esc(v.campaignName)}</span>` : ''}</div></td>
    <td><span class="chip ${VIDEO_STATUS_CHIP[v.status] || 'chip-muted'}">${esc(VIDEO_STATUS_LABEL[v.status] || v.status)}</span>
      ${v.rejectionReason && v.status !== 'approved' ? `<div class="feed-time" title="${esc(v.rejectionReason)}">${esc(v.rejectionReason.slice(0, 50))}</div>` : ''}
      ${v.payoutId ? '<div class="feed-time">on a payout</div>' : ''}</td>
    <td class="num">${cmpNum(v.status === 'locked' ? v.billableViews : v.latestViewCount)}<div class="feed-time">${v.lastFetchedAt ? 'checked ' + fmtDate(v.lastFetchedAt) : 'not checked yet'}</div></td>
    <td class="num">${cmpMoney(v.earnedCents)}<div class="feed-time">${cmpMoney(v.cpmRateCents)}/1K</div></td>
    <td><span class="feed-time">${ends}</span></td>
    <td><div class="cmp-row-actions">${actions.join('')}</div></td>
  </tr>`;
}

const videoTableHtml = (videos, opts) => `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr>
    <th>Video</th><th>Affiliate</th><th>Status</th><th class="num">Views</th><th class="num">Earned</th><th>Tracking</th><th></th>
  </tr></thead><tbody>${videos.map(v => videoRowHtml(v, opts)).join('')}</tbody></table></div>`;

function campaignVideosPanelHtml(c) {
  setTimeout(loadCampaignVideos, 0);
  return `<div class="panel cmp-panel" id="cmp-videos-panel"><div class="panel-head"><span class="panel-title">Videos</span></div><div class="cmp-empty">Loading videos…</div></div>`;
}

async function loadCampaignVideos() {
  if (!cmpCurrent) return;
  try {
    cmpVideos = (await cmpRequest(`/api/affiliate-videos?campaignId=${encodeURIComponent(cmpCurrent.id)}`)).videos;
    renderCampaignVideos();
  } catch (err) {
    const panel = document.getElementById('cmp-videos-panel');
    if (panel) panel.innerHTML = `<div class="cmp-empty">Couldn't load videos: ${esc(err.message)}</div>`;
  }
}

function renderCampaignVideos() {
  const panel = document.getElementById('cmp-videos-panel');
  if (!panel) return;
  const counts = cmpVideos.reduce((m, v) => ({ ...m, [v.status]: (m[v.status] || 0) + 1 }), {});
  const flagged = cmpVideos.filter(v => v.openFlags.length).length;
  const filters = [['all', 'All', cmpVideos.length], ['pending_review', 'To review', counts.pending_review], ['approved', 'Tracking', counts.approved],
    ['locked', 'Locked', counts.locked], ['flagged', 'Flagged', flagged], ['rejected', 'Rejected', counts.rejected], ['removed', 'Removed', counts.removed]];
  const shown = cmpVideos.filter(v => cmpVideoFilter === 'all' || (cmpVideoFilter === 'flagged' ? v.openFlags.length : v.status === cmpVideoFilter));
  panel.innerHTML = `<div class="panel-head"><span class="panel-title">Videos</span>
      <div class="cmp-panel-actions">${filters.map(([k, label, n]) => `<button class="action-btn${cmpVideoFilter === k ? ' primary' : ''}" onclick="cmpVideoFilter='${k}';renderCampaignVideos()">${label} ${n || 0}</button>`).join('')}</div></div>
    ${shown.length ? videoTableHtml(shown) : `<div class="cmp-empty">${cmpVideos.length ? 'No videos in this view.' : 'No videos yet. Affiliates submit links from their portal.'}</div>`}`;
}

async function reviewVideo(id, action, btn) {
  let reason;
  if (action === 'reject') {
    reason = prompt('Why is this video rejected? The affiliate sees this reason.');
    if (reason === null) return;
    if (!reason.trim()) { alert('A reason is required.'); return; }
  }
  if (action === 'remove' && !confirm('Remove this video? It stops earning. You can restore it later.')) return;
  if (btn) btn.disabled = true;
  try {
    const { video } = await cmpRequest(`/api/affiliate-videos/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ action, reason }) });
    afterVideoChange(video);
  } catch (err) {
    alert('Not saved: ' + err.message);
    if (btn) btn.disabled = false;
  }
}

// Refresh whatever is showing this video.
function afterVideoChange(video) {
  if (cmpCurrent && cmpCurrent.id === video.campaignId && !campaignViewEl().hidden) refreshCampaign();
  if (document.getElementById('page-affiliates').classList.contains('active')) loadAffiliatesPage();
  if (videoDetail?.video.id === video.id) openVideoDetail(video.id);
  loadAffiliateBadge();
}

// ── Video detail: view history, manual view entry, flags, audit ──

function ensureVideoModal() {
  if (document.getElementById('video-modal')) return;
  document.body.insertAdjacentHTML('beforeend', `
<div class="ops-modal-bg" id="video-modal" hidden onclick="if (event.target === this) closeVideoDetail()">
  <div class="ops-modal" role="dialog" aria-labelledby="video-modal-title">
    <div class="ops-modal-head"><span class="compose-title" id="video-modal-title">Video</span><button class="drawer-close" onclick="closeVideoDetail()" aria-label="Close">✕</button></div>
    <div class="ops-modal-body" id="video-modal-body"></div>
    <div class="ops-modal-foot"><button class="action-btn" onclick="closeVideoDetail()">Close</button></div>
  </div>
</div>`);
}

async function openVideoDetail(id) {
  ensureVideoModal();
  document.getElementById('video-modal').hidden = false;
  const body = document.getElementById('video-modal-body');
  if (videoDetail?.video.id !== id) body.innerHTML = '<div class="cmp-empty">Loading…</div>';
  try {
    videoDetail = await cmpRequest(`/api/affiliate-videos/${encodeURIComponent(id)}`);
  } catch (err) { body.innerHTML = `<div class="cmp-empty">${esc(err.message)}</div>`; return; }
  const { video: v, snapshots, flags, audit } = videoDetail;
  document.getElementById('video-modal-title').textContent = `${v.creator.name} · ${CMP_PLATFORMS[v.platform]}`;
  body.innerHTML = `
    <div class="detail-grid">
      ${detailField('Video', `<a href="${safeUrl(v.canonicalUrl)}" target="_blank" rel="noopener">${esc(v.canonicalUrl)} ↗</a>`, true)}
      ${v.submittedUrl !== v.canonicalUrl ? detailField('Link they pasted', esc(v.submittedUrl), true) : ''}
      ${detailField('Campaign', esc(v.campaignName))}
      ${detailField('Status', `<span class="chip ${VIDEO_STATUS_CHIP[v.status]}">${esc(VIDEO_STATUS_LABEL[v.status])}</span>`)}
      ${detailField('Latest views', cmpNum(v.latestViewCount))}
      ${detailField('Billable views', v.status === 'locked' ? cmpNum(v.billableViews) : 'Set when it locks')}
      ${detailField('Earned', `${cmpMoney(v.earnedCents)} at ${cmpMoney(v.cpmRateCents)}/1K`)}
      ${detailField('Tracking ends', fmtDateTime(v.trackingEndsAt))}
      ${detailField('Next check', v.nextFetchAt ? fmtDateTime(v.nextFetchAt) : '—')}
      ${detailField('Failed checks in a row', String(v.consecutiveFetchFailures))}
    </div>
    ${v.status === 'approved' ? `<button class="action-btn" onclick="checkVideoNow(this)">↻ Check views now</button><div class="email-msg" id="vc-msg"></div>` : ''}
    ${v.payoutId ? '' : `<div class="detail-section-title">Enter views by hand</div>
    <div class="ops-form-grid">
      <div class="c-field"><label>Views *</label><input class="c-input" id="mv-views" inputmode="numeric" placeholder="${v.latestViewCount}"></div>
      <div class="c-field"><label>Likes</label><input class="c-input" id="mv-likes" inputmode="numeric"></div>
      <div class="c-field"><label>Comments</label><input class="c-input" id="mv-comments" inputmode="numeric"></div>
      <div class="c-field full"><label>Note * (where the number came from)</label><input class="c-input" id="mv-note" placeholder="Screenshot from creator's insights, 9/18"></div>
    </div>
    <button class="action-btn primary" style="margin-top:10px;" onclick="saveManualViews()">Save views</button>
    <div class="ops-hint">${v.status === 'locked' ? 'This video is locked, so this also changes its billable views.' : 'Replaces the latest count. Automatic checks only ever raise it.'} Logged in the audit log.</div>
    <div class="email-msg" id="mv-msg"></div>`}
    ${flags.length ? `<div class="detail-section-title">Flags</div>${flags.map(f => `<div class="aff-result"><div class="cmp-who"><b>${esc(FLAG_LABEL[f.type] || f.type)}</b><span>${esc(f.details)} · ${fmtDateTime(f.createdAt)}</span>
      ${f.resolvedAt ? `<span>Resolved ${fmtDateTime(f.resolvedAt)}${f.resolvedByName ? ' by ' + esc(f.resolvedByName) : ''}</span>` : ''}</div>
      ${f.resolvedAt ? '<span class="chip chip-muted">resolved</span>' : `<button class="action-btn" data-id="${esc(f.id)}" onclick="resolveFlag(this.dataset.id)">Resolve</button>`}</div>`).join('')}` : ''}
    <div class="detail-section-title">View history (${snapshots.length})</div>
    ${snapshots.length ? `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr><th>When</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th>Source</th><th>Note</th></tr></thead><tbody>
      ${snapshots.map(s => `<tr><td>${fmtDateTime(s.fetchedAt)}</td><td class="num">${cmpNum(s.viewCount)}</td><td class="num">${s.likeCount === null ? '—' : cmpNum(s.likeCount)}</td>
        <td class="num">${s.commentCount === null ? '—' : cmpNum(s.commentCount)}</td><td>${esc(s.source)}${s.enteredByName ? ' · ' + esc(s.enteredByName) : ''}</td><td>${esc(s.note || '')}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="cmp-empty">No view counts yet.</div>'}
    ${audit.length ? `<div class="detail-section-title">Audit</div>${auditRowsHtml(audit)}` : ''}`;
}

async function checkVideoNow(btn) {
  btn.disabled = true;
  try {
    const { video } = await cmpRequest(`/api/affiliate-videos/${encodeURIComponent(videoDetail.video.id)}/check`, { method: 'POST' });
    afterVideoChange(video);
  } catch (err) { cmpMsg('vc-msg', err.message); btn.disabled = false; }
}

function closeVideoDetail() {
  document.getElementById('video-modal').hidden = true;
  videoDetail = null;
}

async function saveManualViews() {
  const v = (id) => document.getElementById(id).value.trim().replace(/,/g, '');
  const body = { viewCount: v('mv-views'), likeCount: v('mv-likes') || null, commentCount: v('mv-comments') || null, note: v('mv-note') };
  if (!body.viewCount || !body.note) { cmpMsg('mv-msg', 'Views and a note are required.'); return; }
  try {
    const { video } = await cmpRequest(`/api/affiliate-videos/${encodeURIComponent(videoDetail.video.id)}/views`, { method: 'POST', body: JSON.stringify(body) });
    afterVideoChange(video);
  } catch (err) { cmpMsg('mv-msg', err.message); }
}

async function resolveFlag(id) {
  const note = prompt('Resolve this flag. Optional note:', '');
  if (note === null) return;
  try {
    await cmpRequest(`/api/video-flags/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ note }) });
    if (videoDetail) openVideoDetail(videoDetail.video.id);
    if (document.getElementById('page-affiliates').classList.contains('active')) loadAffiliatesPage();
    if (cmpCurrent && !campaignViewEl().hidden) loadCampaignVideos();
    loadAffiliateBadge();
  } catch (err) { alert('Not resolved: ' + err.message); }
}

// ── Affiliates page: review queue, flags, payouts, audit log ──

let affPageTab = 'review';
const AFF_PAGE_TABS = [['review', 'Review queue'], ['flags', 'Flags'], ['audit', 'Audit log']];

const originalShowPageCampaigns = window.showPage;
window.showPage = function(name) {
  originalShowPageCampaigns(name);
  if (name === 'affiliates') loadAffiliatesPage();
};

function renderAffiliateTabs() {
  document.getElementById('aff-page-tabs').innerHTML = AFF_PAGE_TABS.map(([k, label]) =>
    `<button class="billing-tab${affPageTab === k ? ' active' : ''}" onclick="affPageTab='${k}';loadAffiliatesPage()">${label}</button>`).join('');
}

async function loadAffiliatesPage() {
  renderAffiliateTabs();
  const box = document.getElementById('aff-page-body');
  const loaders = { review: renderReviewQueue, flags: renderFlagsQueue, audit: renderAuditLog, payouts: window.renderPayoutsTab };
  try {
    await loaders[affPageTab](box);
  } catch (err) {
    box.innerHTML = `<div class="state-box">Couldn't load: ${esc(err.message)}</div>`;
  }
}

async function renderReviewQueue(box) {
  const { videos } = await cmpRequest('/api/affiliate-videos?status=pending_review');
  box.innerHTML = `<div class="panel cmp-panel"><div class="panel-head"><span class="panel-title">Waiting for review · oldest first</span><button class="panel-link" onclick="loadAffiliatesPage()">↻ Refresh</button></div>
    ${videos.length ? videoTableHtml(videos, { showCampaign: true }) : '<div class="cmp-empty">Nothing to review. New submissions on campaigns that need approval show up here.</div>'}</div>`;
}

async function renderFlagsQueue(box) {
  const { flags } = await cmpRequest('/api/video-flags?open=1');
  box.innerHTML = `<div class="panel cmp-panel"><div class="panel-head"><span class="panel-title">Open flags</span><button class="panel-link" onclick="loadAffiliatesPage()">↻ Refresh</button></div>
    ${flags.length ? `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr><th>Flag</th><th>Video</th><th>Affiliate</th><th>Status</th><th class="num">Views</th><th>Raised</th><th></th></tr></thead><tbody>
      ${flags.map(f => `<tr><td><div class="cmp-who"><b>${esc(FLAG_LABEL[f.type] || f.type)}</b><span>${esc(f.details)}</span></div></td>
        <td><div class="cmp-video-url"><a href="${safeUrl(f.canonicalUrl)}" target="_blank" rel="noopener">${esc(CMP_PLATFORMS[f.platform] || f.platform)} ↗</a><span>${esc(f.campaignName)}</span></div></td>
        <td>${esc(f.creatorName)}</td><td><span class="chip ${VIDEO_STATUS_CHIP[f.videoStatus] || 'chip-muted'}">${esc(VIDEO_STATUS_LABEL[f.videoStatus] || f.videoStatus)}</span></td>
        <td class="num">${cmpNum(f.latestViewCount)}</td><td>${fmtDateTime(f.createdAt)}</td>
        <td><div class="cmp-row-actions"><button class="action-btn" data-id="${esc(f.videoId)}" onclick="openVideoDetail(this.dataset.id)">Open video</button>
          <button class="action-btn" data-id="${esc(f.id)}" onclick="resolveFlag(this.dataset.id)">Resolve</button></div></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="cmp-empty">No open flags.</div>'}</div>`;
}

const AUDIT_ACTIONS = {
  rate_changed: 'Rate changed', caps_changed: 'Caps changed', status_changed: 'Status changed', campaign_created: 'Campaign created', campaign_deleted: 'Campaign deleted',
  affiliate_added: 'Affiliate added', video_approved: 'Video approved', video_rejected: 'Video rejected', video_removed: 'Video removed',
  manual_views_entered: 'Views entered by hand', flag_resolved: 'Flag resolved', payout_details_changed: 'Payout details changed',
  payout_created: 'Payout created', payout_status_changed: 'Payout status changed', payout_deleted: 'Payout deleted', video_locked: 'Video locked',
  video_unavailable: 'Video unavailable', promoted: 'Promoted', rank_changed: 'Rank changed', upline_changed: 'Moved to a new upline',
  recruits_rolled_up: 'Recruits moved up', platform_connected: 'Account connected', platform_disconnected: 'Account disconnected', payout_updated: 'Payout updated'
};

function auditRowsHtml(entries) {
  const show = (obj) => (obj === null ? '' : esc(Object.entries(obj).map(([k, val]) => `${k}: ${typeof val === 'object' && val !== null ? JSON.stringify(val) : val}`).join('\n')));
  return `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Before</th><th>After</th></tr></thead><tbody>
    ${entries.map(a => `<tr><td>${fmtDateTime(a.createdAt)}</td><td>${esc(a.actorName || a.actorType)}<div class="feed-time">${esc(a.actorType)}</div></td>
      <td><b>${esc(AUDIT_ACTIONS[a.action] || a.action)}</b><div class="feed-time">${esc(a.entityType)}</div></td>
      <td><div class="cmp-audit-json">${show(a.before)}</div></td><td><div class="cmp-audit-json">${show(a.after)}</div></td></tr>`).join('')}
  </tbody></table></div>`;
}

async function renderAuditLog(box) {
  const { entries } = await cmpRequest('/api/affiliate-audit');
  box.innerHTML = `<div class="panel cmp-panel"><div class="panel-head"><span class="panel-title">Audit log · latest 500</span><button class="panel-link" onclick="loadAffiliatesPage()">↻ Refresh</button></div>
    ${entries.length ? auditRowsHtml(entries) : '<div class="cmp-empty">Nothing logged yet.</div>'}</div>`;
}

// Sidebar badge: videos waiting for review + open flags.
async function loadAffiliateBadge() {
  try {
    const [{ videos }, { flags }] = await Promise.all([cmpRequest('/api/affiliate-videos?status=pending_review'), cmpRequest('/api/video-flags?open=1')]);
    const n = videos.length + flags.length;
    for (const id of ['badge-affiliates', 'drawer-badge-affiliates']) {
      const el = document.getElementById(id);
      el.textContent = n;
      el.hidden = !n;
    }
  } catch { /* the badge is best-effort */ }
}

(function waitForSession() {
  if (document.body.classList.contains('ready')) { loadAffiliateBadge(); setInterval(loadAffiliateBadge, 5 * 60 * 1000); }
  else setTimeout(waitForSession, 500);
})();

// ── Payouts (Affiliates page) ──
// Payouts are records: someone sends the money outside the CRM, then marks the payout paid with a reference.

const PAYOUT_STATUS_CHIP = { pending: 'chip-orange', approved: 'chip-blue', paid: 'chip-green', failed: 'chip-red' };
const PAYOUT_METHOD_LABEL = { paypal: 'PayPal', wise: 'Wise', bank: 'Bank transfer', manual: 'Manual' };
let payoutFilter = '';
let payoutsCache = [];
const openPayouts = new Set();

AFF_PAGE_TABS.splice(2, 0, ['payouts', 'Payouts']);

window.renderPayoutsTab = async function renderPayoutsTab(box) {
  const [{ creators }, { payouts }] = await Promise.all([cmpRequest('/api/payouts/owed'), cmpRequest('/api/payouts' + (payoutFilter ? `?status=${payoutFilter}` : ''))]);
  payoutsCache = payouts;
  const isAdmin = ['admin', 'owner'].includes(currentUser.role);
  box.innerHTML = `
    <div class="panel cmp-panel"><div class="panel-head"><span class="panel-title">Owed to affiliates</span>
      <div class="cmp-panel-actions"><button class="action-btn" onclick="exportOwedCsv()">Export CSV</button><button class="panel-link" onclick="loadAffiliatesPage()">↻ Refresh</button></div></div>
      ${creators.length ? `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr>
        <th>Affiliate</th><th>Pays via</th><th>Tax form</th><th class="num">Earned</th><th class="num">Paid</th><th class="num">Owed</th><th class="num">On a payout</th><th class="num">Ready to pay</th><th class="num">Still counting</th><th></th>
      </tr></thead><tbody>${creators.map(c => `<tr>
        <td><div class="cmp-who"><b>${esc(c.name)}</b><span>${esc(c.email)}${c.country ? ' · ' + esc(c.country) : ''}</span></div></td>
        <td>${c.payoutMethod ? `${esc(PAYOUT_METHOD_LABEL[c.payoutMethod] || c.payoutMethod)}${c.payoutDetailsLast4 ? ` <span class="feed-time">••${esc(c.payoutDetailsLast4)}</span>` : ''}` : '<span class="cmp-flag">not set</span>'}</td>
        <td><label class="cmp-check"><input type="checkbox" ${c.taxFormReceived ? 'checked' : ''} data-id="${esc(c.id)}" onchange="setTaxForm(this)"> received</label></td>
        <td class="num">${cmpMoney(c.earnedCents)}</td><td class="num">${cmpMoney(c.paidCents)}</td><td class="num strong">${cmpMoney(c.owedCents)}</td>
        <td class="num">${cmpMoney(c.inProgressCents)}</td>
        <td class="num strong">${cmpMoney(c.readyCents)}<div class="feed-time">${c.readyVideos} video${c.readyVideos === 1 ? '' : 's'}</div></td>
        <td class="num">${cmpMoney(c.pendingCents)}</td>
        <td><div class="cmp-row-actions">${c.readyCents > 0 && isAdmin ? `<button class="action-btn primary" data-id="${esc(c.id)}" onclick="createPayout(this.dataset.id, this)">Create payout</button>` : ''}</div></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="cmp-empty">No affiliate earnings yet. Videos earn once approved and are payable once they lock.</div>'}
      <div class="ops-hint" style="padding:0 18px 14px;">Owed = earned on locked videos − paid. "Ready to pay" is what a new payout would include.${isAdmin ? '' : ' Only admins can create or change payouts.'}</div>
    </div>
    <div class="panel cmp-panel"><div class="panel-head"><span class="panel-title">Payouts</span>
      <div class="cmp-panel-actions">
        ${[['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['paid', 'Paid'], ['failed', 'Failed']].map(([k, label]) => `<button class="action-btn${payoutFilter === k ? ' primary' : ''}" onclick="payoutFilter='${k}';loadAffiliatesPage()">${label}</button>`).join('')}
        <button class="action-btn" onclick="exportPayoutsCsv()">Export CSV</button></div></div>
      ${payouts.length ? `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr>
        <th>Affiliate</th><th>Period</th><th class="num">Amount</th><th>Status</th><th>Method</th><th>Reference</th><th>Created</th><th></th>
      </tr></thead><tbody>${payouts.map(p => payoutRowHtml(p, isAdmin)).join('')}</tbody></table></div>` : '<div class="cmp-empty">No payouts yet.</div>'}
      <div class="email-msg" id="payout-msg" style="margin:0 18px 14px;"></div>
    </div>`;
  for (const id of openPayouts) showPayoutItems(id, true);
};

function payoutRowHtml(p, isAdmin) {
  const id = esc(p.id);
  const next = { pending: [['approved', 'Approve'], ['failed', 'Mark failed']], approved: [['paid', 'Mark paid'], ['failed', 'Mark failed'], ['pending', 'Back to pending']], failed: [['pending', 'Retry']], paid: [] }[p.status] || [];
  return `<tr>
    <td><div class="cmp-who"><b>${esc(p.creatorName)}</b><span>${esc(p.creatorEmail)}${p.creatorPayoutMethod ? ` · ${esc(PAYOUT_METHOD_LABEL[p.creatorPayoutMethod] || p.creatorPayoutMethod)}${p.creatorPayoutLast4 ? ' ••' + esc(p.creatorPayoutLast4) : ''}` : ''}</span>
      ${p.taxFormReceived ? '' : '<span class="cmp-flag">no tax form</span>'}</div></td>
    <td>${esc(p.periodStart || '')} → ${esc(p.periodEnd || '')}</td>
    <td class="num strong">${cmpMoney(p.amountCents)}<div class="feed-time">${p.videoCount} video${p.videoCount === 1 ? '' : 's'}${p.overrideCount ? ` + ${p.overrideCount} override${p.overrideCount === 1 ? '' : 's'}` : ''}</div></td>
    <td><span class="chip ${PAYOUT_STATUS_CHIP[p.status] || 'chip-muted'}">${esc(p.status)}</span>${p.paidAt ? `<div class="feed-time">${fmtDate(p.paidAt)}</div>` : ''}</td>
    <td>${esc(PAYOUT_METHOD_LABEL[p.paymentMethod] || p.paymentMethod || '—')}</td>
    <td><span class="cmp-audit-json">${esc(p.paymentReference || '—')}</span></td>
    <td>${fmtDate(p.createdAt)}<div class="feed-time">${esc(p.createdByName || '')}</div></td>
    <td><div class="cmp-row-actions">
      <button class="action-btn" data-id="${id}" onclick="showPayoutItems(this.dataset.id)">Videos</button>
      ${isAdmin ? next.map(([status, label]) => `<button class="action-btn${status === 'paid' ? ' primary' : ''}" data-id="${id}" onclick="setPayoutStatus(this.dataset.id, '${status}', this)">${label}</button>`).join('') : ''}
      ${isAdmin && ['pending', 'failed'].includes(p.status) ? `<button class="action-btn" data-id="${id}" onclick="deletePayout(this.dataset.id)">Delete</button>` : ''}
    </div></td>
  </tr><tr id="payout-items-${id}" hidden><td colspan="8"></td></tr>`;
}

async function showPayoutItems(id, keepOpen) {
  const row = document.getElementById('payout-items-' + id);
  if (!row) return;
  if (!keepOpen && !row.hidden) { row.hidden = true; openPayouts.delete(id); return; }
  row.hidden = false;
  openPayouts.add(id);
  const cell = row.firstElementChild;
  cell.innerHTML = '<div class="cmp-empty">Loading…</div>';
  try {
    const { payout } = await cmpRequest(`/api/payouts/${encodeURIComponent(id)}`);
    cell.innerHTML = `<table class="cmp-table"><thead><tr><th>Campaign</th><th>Video</th><th class="num">Billable views</th><th class="num">CPM</th><th class="num">Amount</th></tr></thead><tbody>
      ${payout.lineItems.map(li => `<tr><td>${esc(li.campaignName || '')}</td><td><a href="${safeUrl(li.canonicalUrl)}" target="_blank" rel="noopener">${esc(CMP_PLATFORMS[li.platform] || li.platform || 'Video')} ↗</a></td>
        <td class="num">${cmpNum(li.billableViews)}</td><td class="num">${cmpMoney(li.cpmRateCents)}</td><td class="num">${cmpMoney(li.amountCents)}</td></tr>`).join('')}
      ${payout.overrideItems.map(o => `<tr><td>${esc(o.campaignName || '')}</td><td>Team override from <b>${esc(o.fromName || '—')}</b> · <a href="${safeUrl(o.canonicalUrl)}" target="_blank" rel="noopener">${esc(CMP_PLATFORMS[o.platform] || 'Video')} ↗</a></td>
        <td class="num">${cmpNum(o.billableViews)}</td><td class="num">+${cmpMoney(o.cpmDiffCents)}</td><td class="num">${cmpMoney(o.amountCents)}</td></tr>`).join('')}
    </tbody></table>`;
  } catch (err) { cell.innerHTML = `<div class="cmp-empty">${esc(err.message)}</div>`; }
}

async function createPayout(creatorId, btn) {
  if (!confirm('Create a pending payout from all of this affiliate’s locked, unpaid videos? No money is sent. You mark it paid after paying them.')) return;
  btn.disabled = true;
  try {
    const { payout } = await cmpRequest('/api/payouts', { method: 'POST', body: JSON.stringify({ creatorId }) });
    openPayouts.add(payout.id);
    await loadAffiliatesPage();
    cmpMsg('payout-msg', `Payout of ${cmpMoney(payout.amountCents)} created for ${payout.creatorName}.`, 'success');
  } catch (err) { alert('Not created: ' + err.message); btn.disabled = false; }
}

async function setPayoutStatus(id, status, btn) {
  const p = payoutsCache.find(x => x.id === id);
  const body = { status };
  if (status === 'paid') {
    const methods = Object.keys(PAYOUT_METHOD_LABEL);
    const method = prompt(`Paid ${cmpMoney(p.amountCents)} to ${p.creatorName} how? (${methods.join(', ')})`, p.paymentMethod || p.creatorPayoutMethod || '');
    if (method === null) return;
    if (!methods.includes(method.trim().toLowerCase())) { alert(`Use one of: ${methods.join(', ')}`); return; }
    const reference = prompt('Payment reference (transaction ID, transfer number…):', p.paymentReference || '');
    if (reference === null) return;
    if (!reference.trim()) { alert('A reference is required to mark a payout paid.'); return; }
    Object.assign(body, { paymentMethod: method.trim().toLowerCase(), paymentReference: reference.trim() });
  } else if (status === 'failed' && !confirm('Mark this payout failed? You can retry it or delete it afterwards.')) return;
  btn.disabled = true;
  try {
    await cmpRequest(`/api/payouts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    loadAffiliatesPage();
  } catch (err) { alert('Not saved: ' + err.message); btn.disabled = false; }
}

async function deletePayout(id) {
  if (!confirm('Delete this payout? Its videos go back to "ready to pay".')) return;
  try {
    await cmpRequest(`/api/payouts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    openPayouts.delete(id);
    loadAffiliatesPage();
  } catch (err) { alert('Not deleted: ' + err.message); }
}

async function setTaxForm(input) {
  try {
    await cmpRequest(`/api/creators/${encodeURIComponent(input.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ taxFormReceived: input.checked }) });
  } catch (err) { input.checked = !input.checked; alert('Not saved: ' + err.message); }
}

async function exportOwedCsv() {
  const { creators } = await cmpRequest('/api/payouts/owed');
  const d = (cents) => (cents / 100).toFixed(2);
  downloadCsv('affiliates-owed.csv', [
    ['Affiliate', 'Email', 'Country', 'Payout method', 'Details (last 4)', 'Tax form', 'Earned (USD)', 'Paid (USD)', 'Owed (USD)', 'On a payout (USD)', 'Ready to pay (USD)', 'Still counting (USD)'],
    ...creators.map(c => [c.name, c.email, c.country, c.payoutMethod, c.payoutDetailsLast4, c.taxFormReceived ? 'yes' : 'no', d(c.earnedCents), d(c.paidCents), d(c.owedCents), d(c.inProgressCents), d(c.readyCents), d(c.pendingCents)])
  ]);
}

async function exportPayoutsCsv() {
  const rows = [['Payout ID', 'Affiliate', 'Email', 'Status', 'Period start', 'Period end', 'Method', 'Reference', 'Paid at', 'Type', 'From (downline)', 'Campaign', 'Video', 'Billable views', 'CPM or CPM difference (USD per 1K)', 'Amount (USD)']];
  for (const p of payoutsCache) {
    const { payout } = await cmpRequest(`/api/payouts/${encodeURIComponent(p.id)}`);
    const head = [payout.id, payout.creatorName, payout.creatorEmail, payout.status, payout.periodStart, payout.periodEnd, payout.paymentMethod || '', payout.paymentReference || '', payout.paidAt || ''];
    for (const li of payout.lineItems) rows.push([...head, 'own video', '', li.campaignName || '', li.canonicalUrl || '', li.billableViews, (li.cpmRateCents / 100).toFixed(2), (li.amountCents / 100).toFixed(2)]);
    for (const o of payout.overrideItems) rows.push([...head, 'team override', o.fromName || '', o.campaignName || '', o.canonicalUrl || '', o.billableViews, (o.cpmDiffCents / 100).toFixed(2), (o.amountCents / 100).toFixed(2)]);
  }
  downloadCsv('affiliate-payouts.csv', rows);
}

// ── Team pyramid (uplines and ranks) ──
// Each rank is a band of the pyramid; lines connect every affiliate to their upline. A solid line means the
// upline earns on that person (their CPM is higher); dashed means $0 (same or lower CPM).

const RANKS = [['top_creator', 'Top Creator'], ['master', 'Master'], ['general', 'General'], ['rookie', 'Rookie']];
const RANK_LABEL = Object.fromEntries(RANKS);
const RANK_CHIP = { top_creator: 'rank-chip-top_creator', master: 'chip-purple', general: 'chip-blue', rookie: 'chip-green' };
let pyramidPerson = null;   // affiliate id open in the person modal

const teamMembers = (c) => c.affiliates.filter(a => a.status !== 'removed');
const rateOfAff = (a) => a.effectiveCpmRateCents;

// Depth-first order so recruits sit under their uplines and lines cross as little as possible.
function pyramidOrder(c) {
  const members = teamMembers(c);
  const ids = new Set(members.map(a => a.id));
  const kids = new Map();
  for (const a of members) if (a.uplineId && ids.has(a.uplineId)) kids.set(a.uplineId, [...(kids.get(a.uplineId) || []), a]);
  const order = new Map();
  const visit = (a) => { if (order.has(a.id)) return; order.set(a.id, order.size); (kids.get(a.id) || []).sort((x, y) => x.creator.name.localeCompare(y.creator.name)).forEach(visit); };
  members.filter(a => !a.uplineId || !ids.has(a.uplineId)).sort((x, y) => RANKS.findIndex(r => r[0] === x.rank) - RANKS.findIndex(r => r[0] === y.rank) || x.creator.name.localeCompare(y.creator.name)).forEach(visit);
  members.forEach(visit);
  return order;
}

function pyramidPanelHtml(c) {
  const members = teamMembers(c);
  const order = pyramidOrder(c);
  const byId = new Map(c.affiliates.map(a => [a.id, a]));
  const band = ([rank, label]) => {
    const people = members.filter(a => a.rank === rank).sort((x, y) => order.get(x.id) - order.get(y.id));
    return `<div class="pyr-band pyr-band-${rank}"><div class="pyr-band-label">${label} · ${people.length}</div><div class="pyr-row">
      ${people.map(a => {
        const up = a.uplineId && byId.get(a.uplineId);
        // Upline ranked below or at a lower CPM than this person: they earn nothing on them.
        const warn = up && up.status !== 'removed' && rateOfAff(up) <= rateOfAff(a);
        return `<button class="pyr-node rank-${a.rank}${a.status === 'invited' ? ' invited' : ''}${warn ? ' warn' : ''}" data-id="${esc(a.id)}" onclick="openPerson(this.dataset.id)"
          title="${warn ? esc(`${up.creator.name} earns $0 on ${a.creator.name}: same or lower CPM`) : ''}">
          <b>${esc(a.creator.name)}</b><div class="pyr-cpm">${cmpMoney(rateOfAff(a))} / 1K</div>
          <div class="pyr-sub">${cmpNum(a.views)} views · ${cmpMoney(a.earnedCents + a.pendingCents)}${a.overrideEarnedCents + a.overridePendingCents ? ` + ${cmpMoney(a.overrideEarnedCents + a.overridePendingCents)} team` : ''}</div>
        </button>`;
      }).join('') || '<span class="pyr-empty">Nobody at this rank</span>'}
    </div></div>`;
  };
  setTimeout(drawPyramidLines, 0);
  return `<div class="panel cmp-panel"><div class="panel-head"><span class="panel-title">Team pyramid</span>
      <div class="cmp-panel-actions"><button class="action-btn primary" onclick="openAffiliateForm({ rank: 'top_creator', uplineId: null })">+ New node</button></div></div>
    ${members.length ? `<div class="pyr" id="pyr"><svg class="pyr-lines" id="pyr-lines"></svg>${RANKS.map(band).join('')}</div>
      <div class="pyr-legend"><span><i></i>upline earns the CPM difference</span><span><i class="zero"></i>same or lower CPM, upline earns $0</span><span>Dashed card = hasn't signed in yet · click anyone to promote, recruit, or move</span></div>`
      : '<div class="cmp-empty">No team yet. Start with "+ New node", then add recruits under them.</div>'}
  </div>`;
}

function drawPyramidLines() {
  const box = document.getElementById('pyr');
  const svg = document.getElementById('pyr-lines');
  if (!box || !svg || !cmpCurrent) return;
  const origin = box.getBoundingClientRect();
  svg.setAttribute('width', box.scrollWidth);
  svg.setAttribute('height', box.scrollHeight);
  const nodes = new Map([...box.querySelectorAll('.pyr-node')].map(el => [el.dataset.id, el.getBoundingClientRect()]));
  const byId = new Map(cmpCurrent.affiliates.map(a => [a.id, a]));
  const x = (r) => r.left - origin.left + box.scrollLeft + r.width / 2;
  svg.innerHTML = teamMembers(cmpCurrent).filter(a => a.uplineId && nodes.has(a.uplineId) && nodes.has(a.id)).map(a => {
    const up = nodes.get(a.uplineId), me = nodes.get(a.id);
    const x1 = x(up), y1 = up.bottom - origin.top + box.scrollTop, x2 = x(me), y2 = me.top - origin.top + box.scrollTop;
    const earns = rateOfAff(byId.get(a.uplineId)) > rateOfAff(a);
    const mid = (y1 + y2) / 2;
    return `<path d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}" fill="none" stroke="${earns ? 'var(--accent)' : 'var(--text-muted)'}" stroke-width="${earns ? 2 : 1.4}" ${earns ? '' : 'stroke-dasharray="4 4"'} opacity=".75"/>`;
  }).join('');
}
window.addEventListener('resize', () => requestAnimationFrame(drawPyramidLines));

// ── Person: promote, change CPM, add recruit, move ──

function ensurePersonModal() {
  if (document.getElementById('person-modal')) return;
  document.body.insertAdjacentHTML('beforeend', `
<div class="ops-modal-bg" id="person-modal" hidden onclick="if (event.target === this) closePerson()">
  <div class="ops-modal" role="dialog" aria-labelledby="person-modal-title">
    <div class="ops-modal-head"><span class="compose-title" id="person-modal-title">Affiliate</span><button class="drawer-close" onclick="closePerson()" aria-label="Close">✕</button></div>
    <div class="ops-modal-body" id="person-modal-body"></div>
    <div class="ops-modal-foot"><button class="action-btn" onclick="closePerson()">Close</button></div>
  </div>
</div>`);
}

// Everyone below `id`, so they can't become its upline.
function downlineIds(id) {
  const out = new Set();
  const walk = (parent) => cmpCurrent.affiliates.filter(a => a.uplineId === parent && !out.has(a.id)).forEach(a => { out.add(a.id); walk(a.id); });
  walk(id);
  return out;
}

function openPerson(id) {
  ensurePersonModal();
  pyramidPerson = id;
  const a = cmpCurrent.affiliates.find(x => x.id === id);
  if (!a) return;
  const byId = new Map(cmpCurrent.affiliates.map(x => [x.id, x]));
  const up = a.uplineId ? byId.get(a.uplineId) : null;
  const recruits = cmpCurrent.affiliates.filter(x => x.uplineId === id && x.status !== 'removed');
  const blocked = downlineIds(id);
  const uplineOptions = teamMembers(cmpCurrent).filter(x => x.id !== id && !blocked.has(x.id))
    .sort((x, y) => RANKS.findIndex(r => r[0] === x.rank) - RANKS.findIndex(r => r[0] === y.rank) || x.creator.name.localeCompare(y.creator.name));
  document.getElementById('person-modal-title').textContent = a.creator.name;
  document.getElementById('person-modal-body').innerHTML = `
    <div style="margin-bottom:12px;"><span class="chip ${RANK_CHIP[a.rank]}">${esc(RANK_LABEL[a.rank])}</span> <span class="chip ${AFF_STATUS_CHIP[a.status]}">${esc(a.status)}</span>
      <span class="feed-time" style="margin-left:6px;">${up ? `Upline: <b>${esc(up.creator.name)}</b> (${esc(RANK_LABEL[up.rank])}, ${cmpMoney(rateOfAff(up))}/1K)` : 'Top of their tree (no upline)'}</span></div>
    ${up && rateOfAff(up) <= rateOfAff(a) ? `<div class="email-msg show error" style="margin:0 0 12px;">${esc(up.creator.name)} earns $0 on ${esc(a.creator.name)}'s views: their CPM isn't higher.</div>` : ''}
    <div class="person-stats">
      <div><span>CPM</span><b>${cmpMoney(rateOfAff(a))}</b></div>
      <div><span>Views</span><b>${cmpNum(a.views)}</b></div>
      <div><span>Own earned</span><b>${cmpMoney(a.earnedCents)}</b></div>
      <div><span>Own counting</span><b>${cmpMoney(a.pendingCents)}</b></div>
      <div><span>Team earned</span><b>${cmpMoney(a.overrideEarnedCents)}</b></div>
      <div><span>Team counting</span><b>${cmpMoney(a.overridePendingCents)}</b></div>
      <div><span>Paid</span><b>${cmpMoney(a.paidCents)}</b></div>
      <div><span>Owed</span><b>${cmpMoney(a.owedCents)}</b></div>
    </div>

    <div class="detail-section-title">Promote / change CPM</div>
    <div class="person-row">
      <div class="c-field"><label>Rank</label><select class="c-input" id="pp-rank">${RANKS.map(([k, l]) => `<option value="${k}"${k === a.rank ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="c-field"><label>CPM (per 1,000 views)</label><div class="cmp-money"><input class="c-input" id="pp-cpm" inputmode="decimal" value="${esc(cmpDollarInput(a.cpmRateOverrideCents))}" placeholder="${esc(cmpDollarInput(cmpCurrent.defaultCpmRateCents))} (campaign)"></div></div>
      <button class="action-btn primary" onclick="savePersonRank()">Save</button>
    </div>
    <div class="ops-hint">Blank CPM = the campaign's rate. Their upline earns the difference between the two CPMs on this person's views.</div>

    <div class="detail-section-title">Upline</div>
    <div class="person-row">
      <div class="c-field"><label>Reports to</label><select class="c-input" id="pp-upline"><option value="">No upline (top of a tree)</option>
        ${uplineOptions.map(x => `<option value="${esc(x.id)}"${x.id === a.uplineId ? ' selected' : ''}>${esc(x.creator.name)} · ${esc(RANK_LABEL[x.rank])} · ${cmpMoney(rateOfAff(x))}</option>`).join('')}</select></div>
      <button class="action-btn" onclick="savePersonUpline()">Move</button>
    </div>

    <div class="detail-section-title">Recruits (${recruits.length})</div>
    ${recruits.map(r => {
      const diff = rateOfAff(a) - rateOfAff(r);
      return `<div class="aff-result"><div class="cmp-who"><b>${esc(r.creator.name)}</b><span>${esc(RANK_LABEL[r.rank])} · ${cmpMoney(rateOfAff(r))}/1K · ${cmpNum(r.views)} views</span></div>
        <span class="feed-time">${diff > 0 ? `${esc(a.creator.name.split(' ')[0])} earns ${cmpMoney(diff)}/1K on them` : 'earns $0 on them'}</span>
        <button class="action-btn" data-id="${esc(r.id)}" onclick="openPerson(this.dataset.id)">Open</button></div>`;
    }).join('') || '<div class="feed-time">No recruits yet.</div>'}
    <button class="action-btn primary" style="margin-top:10px;" onclick="addRecruitFor('${esc(a.id)}')">+ Add recruit under ${esc(a.creator.name.split(' ')[0])}</button>

    <div class="detail-actions" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">
      ${a.status === 'invited' ? `<button class="action-btn" data-id="${esc(a.id)}" onclick="resendAffiliateInvite(this.dataset.id, this)">Resend invite</button>` : ''}
      <button class="action-btn" style="margin-left:auto;" data-id="${esc(a.id)}" onclick="closePerson();setAffiliateStatus(this.dataset.id, 'removed')">Remove from campaign</button>
    </div>
    <div class="email-msg" id="pp-msg"></div>`;
  document.getElementById('person-modal').hidden = false;
}

function closePerson() {
  document.getElementById('person-modal').hidden = true;
  pyramidPerson = null;
}

async function patchPerson(body) {
  try {
    await cmpRequest(`/api/campaign-affiliates/${encodeURIComponent(pyramidPerson)}`, { method: 'PATCH', body: JSON.stringify(body) });
    const id = pyramidPerson;
    await openCampaign(cmpCurrent.id);
    openPerson(id);
    cmpMsg('pp-msg', 'Saved.', 'success');
  } catch (err) { cmpMsg('pp-msg', err.message); }
}

function savePersonRank() {
  let cents;
  try { cents = cmpCents(document.getElementById('pp-cpm').value, 'CPM'); } catch (err) { cmpMsg('pp-msg', err.message); return; }
  patchPerson({ rank: document.getElementById('pp-rank').value, cpmRateOverrideCents: cents });
}

function savePersonUpline() {
  patchPerson({ uplineId: document.getElementById('pp-upline').value || null });
}

// New recruits start one rank below their upline.
function addRecruitFor(id) {
  const a = cmpCurrent.affiliates.find(x => x.id === id);
  const below = RANKS[Math.min(RANKS.length - 1, RANKS.findIndex(r => r[0] === a.rank) + 1)][0];
  closePerson();
  openAffiliateForm({ uplineId: id, rank: below });
}
