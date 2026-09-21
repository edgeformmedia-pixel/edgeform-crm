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

// Basis points <-> percent: 500 -> "5", 550 -> "5.5". "5%" / "5.5" -> 500 / 550; blank -> null.
const cmpPct = (bps) => (bps === null || bps === undefined ? '' : String(bps / 100));
function cmpBps(value, label) {
  const text = String(value ?? '').trim().replace(/[%\s]/g, '');
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${label} must be a percentage from 0 to 100.`);
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
          ${c.openFlags ? `<span class="chip chip-red">${c.openFlags} flag${c.openFlags === 1 ? '' : 's'}</span>` : ''}
          ${c.applicationCounts?.new ? `<span class="chip chip-blue">${c.applicationCounts.new} new application${c.applicationCounts.new === 1 ? '' : 's'}</span>` : ''}</div>
        <div class="cmp-card-name">${esc(c.name)}</div>
        <div class="cmp-card-meta"><span>${cmpMoney(c.defaultCpmRateCents)} / 1K views</span><span>${c.affiliateCount} affiliate${c.affiliateCount === 1 ? '' : 's'}</span>
          <span>${c.videoCount} video${c.videoCount === 1 ? '' : 's'}</span><span>${cmpNum(c.views)} views</span></div>
        <div class="cmp-card-meta"><span>Earned ${cmpMoney(c.earnedCents)}</span>${c.overrideEarnedCents ? `<span>+ ${cmpMoney(c.overrideEarnedCents)} team</span>` : ''}</div>
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
        <div class="c-field"><label>Starting pay (what the application page advertises)</label><div class="cmp-money"><input class="c-input" id="cmpf-cpm" inputmode="decimal" placeholder="25.00" oninput="renderFormExplainer()"></div><div class="ops-hint">Per 1,000 views. Everyone approved from the application page starts here.</div></div>
        <div class="c-field"><label>Team bonus (% of their team's pay)</label><input class="c-input" id="cmpf-override" inputmode="decimal" placeholder="5" oninput="renderFormExplainer()"><div class="ops-hint">Each upline earns this % of what the people they brought in get paid, on top. Nobody's pay is reduced. Can be changed per person.</div></div>
        <div class="c-field full"><label>What applicants read about pay</label><div class="cmp-explainer" id="cmpf-explainer"></div></div>
        <div class="c-field"><label>Start date</label><input class="c-input" id="cmpf-start" type="date"></div>
        <div class="c-field"><label>End date</label><input class="c-input" id="cmpf-end" type="date"></div>
        <div class="c-field full"><label>Platforms allowed</label><div class="cmp-platforms">${Object.entries(CMP_PLATFORMS).map(([k, label]) => `<label class="cmp-check"><input type="checkbox" data-platform="${k}" onchange="renderFormExplainer()"> ${label}</label>`).join('')}</div></div>
        <div class="c-field"><label>Max payout per video</label><div class="cmp-money"><input class="c-input" id="cmpf-max-video" inputmode="decimal" placeholder="No limit"></div></div>
        <div class="c-field"><label>Max payout per affiliate</label><div class="cmp-money"><input class="c-input" id="cmpf-max-affiliate" inputmode="decimal" placeholder="No limit"></div></div>
        <div class="c-field"><label>Total budget</label><div class="cmp-money"><input class="c-input" id="cmpf-budget" inputmode="decimal" placeholder="No limit"></div></div>
        <div class="c-field"><label>Minimum views to earn</label><input class="c-input" id="cmpf-min-views" inputmode="numeric" placeholder="None"><div class="ops-hint">Cumulative lifetime views. Weeks before a video crosses this stay unpaid; every week after counts.</div></div>
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
  set('name', c?.name); set('status', c?.status || 'draft'); set('cpm', cmpDollarInput(c?.defaultCpmRateCents)); set('override', cmpPct(c ? c.defaultOverrideBps : 500));
  set('start', c?.startDate); set('end', c?.endDate); set('brief', c?.brief);
  set('max-video', cmpDollarInput(c?.maxPayoutPerVideoCents)); set('max-affiliate', cmpDollarInput(c?.maxPayoutPerAffiliateCents));
  set('budget', cmpDollarInput(c?.totalBudgetCents)); set('min-views', c?.minViewsToQualify ?? '');
  document.getElementById('cmpf-approval').checked = c ? c.requiresVideoApproval : true;
  document.querySelectorAll('#cmp-modal [data-platform]').forEach(el => { el.checked = c ? c.platformsAllowed.includes(el.dataset.platform) : true; });
  document.getElementById('cmp-modal-title').textContent = c ? 'Edit campaign' : 'New campaign';
  document.querySelector('#cmpf-save .btn-text').textContent = c ? 'Save campaign' : 'Create campaign';
  document.getElementById('cmpf-delete').hidden = !c || !['admin', 'owner'].includes(currentUser.role);
  cmpMsg('cmpf-msg', '');
  renderFormExplainer();
  document.getElementById('cmp-modal').hidden = false;
  document.getElementById('cmpf-name').focus();
}

// The §9 pay wording, live, from what's typed in the campaign form.
function renderFormExplainer() {
  const box = document.getElementById('cmpf-explainer');
  if (!box) return;
  let cents = 0, bps = 0;
  try { cents = cmpCents(document.getElementById('cmpf-cpm').value, 'x') ?? 0; bps = cmpBps(document.getElementById('cmpf-override').value, 'x') ?? 0; } catch { /* shown as typed once valid */ }
  box.innerHTML = payExplainerHtml({
    name: document.getElementById('cmpf-name').value.trim() || 'this campaign',
    brand_name: cmpEditingId ? cmpCurrent?.brandName : '',
    platforms_allowed: [...document.querySelectorAll('#cmp-modal [data-platform]:checked')].map(el => el.dataset.platform),
    starting_cpm_rate_cents: cents, team_bonus_bps: bps
  });
}

function payExplainerHtml(c) {
  if (typeof window.payExplainer !== 'function') return '<span class="feed-time">Loading…</span>';
  return window.payExplainer(c).map((p, i) => `<p>${i === 0 ? `<b>${esc(p.heading)}</b><br>` : `<b>${esc(p.heading)}</b> `}${esc(p.body)}</p>`).join('');
}
document.addEventListener('pay-explainer-ready', () => {
  renderFormExplainer();
  const preview = document.getElementById('app-explainer');
  if (preview && cmpCurrent) renderAppExplainer();
});

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
      defaultOverrideBps: cmpBps(v('override'), 'Team override') ?? 0,
      maxPayoutPerVideoCents: cmpCents(v('max-video'), 'Max per video'),
      maxPayoutPerAffiliateCents: cmpCents(v('max-affiliate'), 'Max per affiliate'),
      totalBudgetCents: cmpCents(v('budget'), 'Total budget'),
      minViewsToQualify: cmpWhole(v('min-views'), 'Minimum views'),
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
      <button class="billing-tab${cmpTab === 'applications' ? ' active' : ''}" onclick="cmpTab='applications';renderCampaignView()">Applications${c.applicationCounts.new ? ` <span class="cmp-badge">${c.applicationCounts.new}</span>` : ''}</button>
      <button class="billing-tab${cmpTab === 'application' ? ' active' : ''}" onclick="cmpTab='application';renderCampaignView()">Application page</button>
      <button class="billing-tab${cmpTab === 'email' ? ' active' : ''}" onclick="cmpTab='email';renderCampaignView()">Email</button>
    </div>
    ${cmpTab === 'email' ? '<div class="cmp-placeholder">✉<br><br>Email campaigns are coming soon.</div>'
      : cmpTab === 'application' ? applicationPageHtml(c)
      : cmpTab === 'applications' ? applicationsPanelHtml(c) : `
    <div class="cmp-kpis">
      <div class="cmp-kpi"><div class="cmp-kpi-label">Affiliates</div><div class="cmp-kpi-val">${active.length}</div><div class="cmp-kpi-sub">${active.filter(a => a.status === 'invited').length} haven't signed in</div></div>
      <div class="cmp-kpi"><div class="cmp-kpi-label">Videos</div><div class="cmp-kpi-val">${cmpNum(c.videoCount)}</div><div class="cmp-kpi-sub">${c.pendingReview} to review</div></div>
      <div class="cmp-kpi"><div class="cmp-kpi-label">Views</div><div class="cmp-kpi-val">${cmpNum(c.views)}</div><div class="cmp-kpi-sub">all tracked videos</div></div>
      <div class="cmp-kpi"><div class="cmp-kpi-label">Earned</div><div class="cmp-kpi-val">${cmpMoney(c.earnedCents)}</div><div class="cmp-kpi-sub">paid weekly, as checked</div></div>
      <div class="cmp-kpi"><div class="cmp-kpi-label">Team overrides</div><div class="cmp-kpi-val">${cmpMoney(c.overrideEarnedCents)}</div><div class="cmp-kpi-sub">upline earnings</div></div>
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
        ${a.creator.payoutMethod ? `<span>Pays via ${esc(a.creator.payoutMethod)}${a.creator.payoutDetailsLast4 ? ' ••' + esc(a.creator.payoutDetailsLast4) : ''}</span>` : ''}</div></td>
      <td><span class="chip ${RANK_CHIP[a.rank] || 'chip-muted'}">${esc(RANK_LABEL[a.rank] || a.rank)}</span>
        <div class="feed-time">${a.uplineId ? 'under ' + esc(c.affiliates.find(x => x.id === a.uplineId)?.creator.name || '—') : 'top of tree'}</div></td>
      <td><span class="chip ${AFF_STATUS_CHIP[a.status] || 'chip-muted'}">${esc(a.status)}</span>
        ${a.status === 'invited' ? `<div class="feed-time">${a.invitedAt ? 'Invited ' + fmtDate(a.invitedAt) : 'Invite not sent'}</div>` : ''}</td>
      <td><div class="cmp-rate"><div class="cmp-money"><input class="c-input" inputmode="decimal" value="${esc(cmpDollarInput(a.cpmRateOverrideCents))}" placeholder="${esc(cmpDollarInput(c.defaultCpmRateCents))}" data-id="${id}" onchange="setAffiliateRate(this)" title="Blank = campaign rate"></div><small>${a.cpmRateOverrideCents === null ? 'default' : 'custom'}</small></div></td>
      <td class="num">${cmpNum(a.videoCount)}</td>
      <td class="num">${cmpNum(a.views)}</td>
      <td class="num">${cmpMoney(a.earnedCents)}</td>
      <td class="num">${cmpMoney(a.overrideEarnedCents)}</td>
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
      <th>Affiliate</th><th>Rank</th><th>Status</th><th>CPM</th><th class="num">Videos</th><th class="num">Views</th><th class="num">Earned</th><th class="num">Team overrides</th><th class="num">Paid</th><th class="num">Owed</th><th></th>
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
    ['Affiliate', 'Email', 'Rank', 'Upline', 'Status', 'CPM (USD per 1K)', 'Videos', 'Views', 'Earned (USD)', 'Team overrides earned (USD)', 'Paid (USD)', 'Owed (USD)', 'Payout method', 'Joined'],
    ...c.affiliates.map(a => [a.creator.name, a.creator.email, RANK_LABEL[a.rank] || a.rank, c.affiliates.find(x => x.id === a.uplineId)?.creator.name || '', a.status,
      d(a.effectiveCpmRateCents), a.videoCount, a.views, d(a.earnedCents), d(a.overrideEarnedCents),
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
  const newShot = v.lastScreenshotAt && (!v.lastFetchedAt || v.lastScreenshotAt > v.lastFetchedAt);
  const checked = (v.lockedAt ? `Locked ${fmtDate(v.lockedAt)}` : v.lastFetchedAt ? `Checked ${fmtDate(v.lastFetchedAt)}` : 'Not checked yet')
    + (v.screenshotCount ? ` · ${v.screenshotCount} screenshot${v.screenshotCount === 1 ? '' : 's'}${newShot ? ' (new)' : ''}` : '');
  const actions = [];
  if (['pending_review', 'rejected', 'removed'].includes(v.status)) actions.push(`<button class="action-btn primary" data-id="${id}" onclick="reviewVideo(this.dataset.id, 'approve', this)">${v.status === 'pending_review' ? 'Approve' : 'Restore'}</button>`);
  if (['pending_review', 'approved', 'removed'].includes(v.status)) actions.push(`<button class="action-btn" data-id="${id}" onclick="reviewVideo(this.dataset.id, 'reject', this)">Reject</button>`);
  if (['pending_review', 'approved', 'locked'].includes(v.status)) actions.push(`<button class="action-btn" data-id="${id}" onclick="reviewVideo(this.dataset.id, 'remove', this)">Remove</button>`);
  // Only an approved video can take a weekly entry, so don't invite one on anything else.
  actions.push(`<button class="action-btn" data-id="${id}" onclick="openVideoDetail(this.dataset.id)">${v.status === 'approved' ? 'Weekly views…' : 'Details…'}</button>`);
  return `<tr>
    <td><div class="cmp-video-url"><a href="${safeUrl(v.canonicalUrl)}" target="_blank" rel="noopener">${esc(CMP_PLATFORMS[v.platform] || v.platform)} · ${esc(v.platformVideoId)} ↗</a>
      <span>Submitted ${fmtDate(v.submittedAt)}${v.caption ? ' · ' + esc(v.caption.slice(0, 60)) : ''}</span>
      ${v.openFlags.map(f => `<span class="cmp-flag" title="${esc(f.details)}">⚑ ${esc(FLAG_LABEL[f.type] || f.type)}</span>`).join('')}</div></td>
    <td><div class="cmp-who"><b>${esc(v.creator.name)}</b>${showCampaign ? `<span>${esc(v.campaignName)}</span>` : ''}</div></td>
    <td><span class="chip ${VIDEO_STATUS_CHIP[v.status] || 'chip-muted'}">${esc(VIDEO_STATUS_LABEL[v.status] || v.status)}</span>
      ${v.rejectionReason && v.status !== 'approved' ? `<div class="feed-time" title="${esc(v.rejectionReason)}">${esc(v.rejectionReason.slice(0, 50))}</div>` : ''}
      ${v.unpaidEarnedCents > 0 ? `<div class="feed-time">${cmpMoney(v.unpaidEarnedCents)} ready to pay</div>` : ''}</td>
    <td class="num">${cmpNum(v.status === 'locked' ? v.billableViews : v.latestViewCount)}<div class="feed-time">${checked}</div></td>
    <td class="num">${cmpMoney(v.earnedCents)}<div class="feed-time">${cmpMoney(v.cpmRateCents)}/1K</div></td>
    <td><div class="cmp-row-actions">${actions.join('')}</div></td>
  </tr>`;
}

const videoTableHtml = (videos, opts) => `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr>
    <th>Video</th><th>Affiliate</th><th>Status</th><th class="num">Views</th><th class="num">Earned</th><th></th>
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
  const { video: v, snapshots, flags, audit, screenshots = [], apiViews = null } = videoDetail;
  // v7: Instagram reported a number for this video (CONTRACT.md §8). It pre-fills the box below;
  // saving is still a person's decision, because a priced week can never be changed afterwards.
  const apiNumber = apiViews && apiViews.views !== null && apiViews.views !== undefined ? apiViews.views : null;
  document.getElementById('video-modal-title').textContent = `${v.creator.name} · ${CMP_PLATFORMS[v.platform]}`;
  body.innerHTML = `
    <div class="detail-grid">
      ${detailField('Video', `<a href="${safeUrl(v.canonicalUrl)}" target="_blank" rel="noopener">${esc(v.canonicalUrl)} ↗</a>`, true)}
      ${v.submittedUrl !== v.canonicalUrl ? detailField('Link they pasted', esc(v.submittedUrl), true) : ''}
      ${detailField('Campaign', esc(v.campaignName))}
      ${detailField('Status', `<span class="chip ${VIDEO_STATUS_CHIP[v.status]}">${esc(VIDEO_STATUS_LABEL[v.status])}</span>`)}
      ${detailField('Latest views', cmpNum(v.latestViewCount))}
      ${detailField('Billable views', v.status === 'locked' ? cmpNum(v.billableViews) : 'Set when the campaign ends')}
      ${detailField('Earned', `${cmpMoney(v.earnedCents)} at ${cmpMoney(v.cpmRateCents)}/1K`)}
      ${detailField('Ready to pay', cmpMoney(v.unpaidEarnedCents))}
    </div>
    <div class="detail-section-title">Affiliate's screenshots (${screenshots.length})</div>
    ${screenshots.length ? `<div class="cmp-shots">${screenshots.map(s => `<a class="cmp-shot" data-shot="${esc(s.id)}" target="_blank" rel="noopener">
        <img alt="Insights screenshot" data-shot-img="${esc(s.id)}">
        <span>${fmtDateTime(s.uploadedAt)}${s.reportedViews !== null ? ` · says ${cmpNum(s.reportedViews)} views` : ''}${v.lastFetchedAt && s.uploadedAt > v.lastFetchedAt || !v.lastFetchedAt ? ' · <b>new</b>' : ''}</span>
        ${s.note ? `<span>${esc(s.note)}</span>` : ''}</a>`).join('')}</div>`
      : '<div class="cmp-empty">None yet. Affiliates can upload their insights screen from the portal (needed for trial reels).</div>'}
    ${v.status === 'approved' ? `<button class="action-btn" onclick="markVideoUnavailable(this)">Mark post unavailable</button>` : ''}
    ${v.status === 'locked' ? '<div class="ops-hint">This video is locked (its campaign ended) — no more weekly entries.</div>'
      : v.status !== 'approved' ? `<div class="ops-hint">This video is ${esc(VIDEO_STATUS_LABEL[v.status] || v.status)}. Approve it before entering views — a week entered now is paid at zero, and priced weeks can't be corrected afterwards.</div>`
      : `<div class="detail-section-title">This week's views</div>
    ${apiNumber !== null ? `<div class="ops-hint cmp-api-note">Instagram reported <b>${cmpNum(apiNumber)} views</b> ${fmtDateTime(apiViews.fetchedAt)}${apiViews.username ? ` for @${esc(apiViews.username)}` : ''}. Check it against the screenshot before saving — once a week is priced it can't be changed.</div>`
      : apiViews && apiViews.error ? `<div class="ops-hint cmp-api-note">Instagram couldn't be read for this video: ${esc(apiViews.error)}</div>` : ''}
    <div class="ops-form-grid">
      <div class="c-field"><label>Views *${apiNumber !== null ? ' <span class="cmp-api-tag">from Instagram</span>' : ''}</label><input class="c-input" id="mv-views" inputmode="numeric" value="${apiNumber !== null ? apiNumber : ''}" placeholder="${v.latestViewCount}"></div>
      <div class="c-field"><label>Likes</label><input class="c-input" id="mv-likes" inputmode="numeric"></div>
      <div class="c-field"><label>Comments</label><input class="c-input" id="mv-comments" inputmode="numeric"></div>
      <div class="c-field full"><label>Note * (where the number came from)</label><input class="c-input" id="mv-note" value="${apiNumber !== null ? esc(`Instagram API${apiViews.username ? ' — @' + apiViews.username : ''}, ${fmtDateTime(apiViews.fetchedAt)}`) : ''}" placeholder="${screenshots.length ? `Affiliate's screenshot, ${fmtDate(screenshots[0].uploadedAt)}` : "Screenshot from creator's insights, 9/18"}"></div>
    </div>
    <button class="action-btn primary" style="margin-top:10px;" onclick="saveManualViews()">Save views</button>
    <div class="ops-hint">The cumulative total, not this week's gain — the delta since the last check is priced automatically. Logged in the audit log.</div>
    <div class="email-msg" id="mv-msg"></div>`}
    ${flags.length ? `<div class="detail-section-title">Flags</div>${flags.map(f => `<div class="aff-result"><div class="cmp-who"><b>${esc(FLAG_LABEL[f.type] || f.type)}</b><span>${esc(f.details)} · ${fmtDateTime(f.createdAt)}</span>
      ${f.resolvedAt ? `<span>Resolved ${fmtDateTime(f.resolvedAt)}${f.resolvedByName ? ' by ' + esc(f.resolvedByName) : ''}</span>` : ''}</div>
      ${f.resolvedAt ? '<span class="chip chip-muted">resolved</span>' : `<button class="action-btn" data-id="${esc(f.id)}" onclick="resolveFlag(this.dataset.id)">Resolve</button>`}</div>`).join('')}` : ''}
    <div class="detail-section-title">View history (${snapshots.length})</div>
    ${snapshots.length ? `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr><th>When</th><th class="num">Views</th><th class="num">New views</th><th class="num">Earned</th><th>Note</th><th>Payout</th></tr></thead><tbody>
      ${snapshots.map(s => `<tr><td>${fmtDateTime(s.fetchedAt)}<div class="feed-time">${esc(s.enteredByName || s.source)}</div></td><td class="num">${cmpNum(s.viewCount)}</td>
        <td class="num">${s.deltaViews === null ? '—' : cmpNum(s.deltaViews)}</td><td class="num">${s.earnedCents === null ? '—' : cmpMoney(s.earnedCents)}</td>
        <td>${esc(s.note || '')}</td><td>${s.payoutId ? `<button class="action-btn" onclick="closeVideoDetail();affPageTab='payouts';loadAffiliatesPage().then(()=>showPayoutItems('${esc(s.payoutId)}',true))">Paid</button>` : s.earnedCents ? 'Unpaid' : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="cmp-empty">No view counts yet.</div>'}
    ${audit.length ? `<div class="detail-section-title">Audit</div>${auditRowsHtml(audit)}` : ''}`;
  loadScreenshotImages(body);
}

// Screenshots need the bearer token, so fetch them as blobs instead of plain <img src>.
async function loadScreenshotImages(root) {
  for (const img of root.querySelectorAll('[data-shot-img]')) {
    try {
      const r = await fetch(`${CRM_API}/api/affiliate-screenshots/${encodeURIComponent(img.dataset.shotImg)}`, { headers: { Authorization: `Bearer ${getSession()?.token || ''}` } });
      if (!r.ok) throw new Error();
      const url = URL.createObjectURL(await r.blob());
      img.src = url;
      img.closest('a').href = url;
    } catch { img.replaceWith(Object.assign(document.createElement('span'), { textContent: 'Couldn’t load image' })); }
  }
}

async function markVideoUnavailable(btn) {
  const reason = prompt('Why is this video unavailable? (e.g. the post was deleted or made private)');
  if (reason === null) return;
  btn.disabled = true;
  try {
    const { video } = await cmpRequest(`/api/affiliate-videos/${encodeURIComponent(videoDetail.video.id)}/review`, { method: 'POST', body: JSON.stringify({ action: 'mark_unavailable', reason }) });
    afterVideoChange(video);
  } catch (err) { alert('Not saved: ' + err.message); btn.disabled = false; }
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
const AFF_PAGE_TABS = [['review', 'Review queue'], ['due', 'This week'], ['flags', 'Flags'], ['audit', 'Audit log']];

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
  const loaders = { review: renderReviewQueue, due: renderDueQueue, flags: renderFlagsQueue, audit: renderAuditLog, payouts: window.renderPayoutsTab };
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

async function renderDueQueue(box) {
  const { videos } = await cmpRequest('/api/affiliate-videos?due=1');
  box.innerHTML = `<div class="panel cmp-panel"><div class="panel-head"><span class="panel-title">This week's checklist · not checked since the cutoff</span><button class="panel-link" onclick="loadAffiliatesPage()">↻ Refresh</button></div>
    ${videos.length ? videoTableHtml(videos, { showCampaign: true }) : '<div class="cmp-empty">Everything’s checked for this week.</div>'}</div>`;
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
  manual_views_entered: 'Views entered by hand', weekly_views_entered: 'Weekly views entered', flag_resolved: 'Flag resolved', payout_details_changed: 'Payout details changed',
  payout_created: 'Payout created', payout_status_changed: 'Payout status changed', payout_deleted: 'Payout deleted', video_locked: 'Video locked',
  video_unavailable: 'Video unavailable', video_marked_unavailable: 'Marked unavailable', promoted: 'Promoted', rank_changed: 'Rank changed', upline_changed: 'Moved to a new upline',
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
        <th>Affiliate</th><th>Pays via</th><th>Tax form</th><th class="num">Earned</th><th class="num">Paid</th><th class="num">Owed</th><th class="num">On a payout</th><th class="num">Ready to pay</th><th></th>
      </tr></thead><tbody>${creators.map(c => `<tr>
        <td><div class="cmp-who"><b>${esc(c.name)}</b><span>${esc(c.email)}${c.country ? ' · ' + esc(c.country) : ''}</span></div></td>
        <td>${c.payoutMethod ? `${esc(PAYOUT_METHOD_LABEL[c.payoutMethod] || c.payoutMethod)}${c.payoutDetailsLast4 ? ` <span class="feed-time">••${esc(c.payoutDetailsLast4)}</span>` : ''}` : '<span class="cmp-flag">not set</span>'}</td>
        <td><label class="cmp-check"><input type="checkbox" ${c.taxFormReceived ? 'checked' : ''} data-id="${esc(c.id)}" onchange="setTaxForm(this)"> received</label></td>
        <td class="num">${cmpMoney(c.earnedCents)}</td><td class="num">${cmpMoney(c.paidCents)}</td><td class="num strong">${cmpMoney(c.owedCents)}</td>
        <td class="num">${cmpMoney(c.inProgressCents)}</td>
        <td class="num strong">${cmpMoney(c.readyCents)}<div class="feed-time">${c.readyWeeks} week${c.readyWeeks === 1 ? '' : 's'}</div></td>
        <td><div class="cmp-row-actions">${c.readyCents > 0 && isAdmin ? `<button class="action-btn primary" data-id="${esc(c.id)}" onclick="createPayout(this.dataset.id, this)">Create payout</button>` : ''}</div></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="cmp-empty">No affiliate earnings yet. Videos are paid weekly, as soon as their views are checked.</div>'}
      <div class="ops-hint" style="padding:0 18px 14px;">Owed = earned (paid weekly, as soon as checked) − paid. "Ready to pay" is what a new payout would include.${isAdmin ? '' : ' Only admins can create or change payouts.'}</div>
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
    cell.innerHTML = `<table class="cmp-table"><thead><tr><th>Campaign</th><th>Video</th><th>Week of</th><th class="num">Views that week</th><th class="num">CPM</th><th class="num">Amount</th></tr></thead><tbody>
      ${payout.lineItems.map(li => `<tr><td>${esc(li.campaignName || '')}</td><td><a href="${safeUrl(li.canonicalUrl)}" target="_blank" rel="noopener">${esc(CMP_PLATFORMS[li.platform] || li.platform || 'Video')} ↗</a></td>
        <td>${fmtDate(li.weekOf)}</td><td class="num">${cmpNum(li.billableViews)}</td><td class="num">${cmpMoney(li.cpmRateCents)}</td><td class="num">${cmpMoney(li.amountCents)}</td></tr>`).join('')}
      ${payout.overrideItems.map(o => `<tr><td>${esc(o.campaignName || '')}</td><td>Team override from <b>${esc(o.fromName || '—')}</b> · <a href="${safeUrl(o.canonicalUrl)}" target="_blank" rel="noopener">${esc(CMP_PLATFORMS[o.platform] || 'Video')} ↗</a></td>
        <td>${fmtDate(o.weekOf)}</td><td class="num">${cmpNum(o.billableViews)}</td><td class="num">${overrideRateText(o)}</td><td class="num">${cmpMoney(o.amountCents)}</td></tr>`).join('')}
    </tbody></table>`;
  } catch (err) { cell.innerHTML = `<div class="cmp-empty">${esc(err.message)}</div>`; }
}

async function createPayout(creatorId, btn) {
  if (!confirm('Create a pending payout from all of this affiliate’s priced, unpaid weeks? No money is sent. You mark it paid after paying them.')) return;
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
    ['Affiliate', 'Email', 'Country', 'Payout method', 'Details (last 4)', 'Tax form', 'Earned (USD)', 'Paid (USD)', 'Owed (USD)', 'On a payout (USD)', 'Ready to pay (USD)'],
    ...creators.map(c => [c.name, c.email, c.country, c.payoutMethod, c.payoutDetailsLast4, c.taxFormReceived ? 'yes' : 'no', d(c.earnedCents), d(c.paidCents), d(c.owedCents), d(c.inProgressCents), d(c.readyCents)])
  ]);
}

async function exportPayoutsCsv() {
  const rows = [['Payout ID', 'Affiliate', 'Email', 'Status', 'Period start', 'Period end', 'Method', 'Reference', 'Paid at', 'Type', 'From (downline)', 'Campaign', 'Video', 'Week of', 'Views that week', 'CPM (USD per 1K) or team override', 'Amount (USD)']];
  for (const p of payoutsCache) {
    const { payout } = await cmpRequest(`/api/payouts/${encodeURIComponent(p.id)}`);
    const head = [payout.id, payout.creatorName, payout.creatorEmail, payout.status, payout.periodStart, payout.periodEnd, payout.paymentMethod || '', payout.paymentReference || '', payout.paidAt || ''];
    for (const li of payout.lineItems) rows.push([...head, 'own video', '', li.campaignName || '', li.canonicalUrl || '', li.weekOf || '', li.billableViews, (li.cpmRateCents / 100).toFixed(2), (li.amountCents / 100).toFixed(2)]);
    for (const o of payout.overrideItems) rows.push([...head, 'team override', o.fromName || '', o.campaignName || '', o.canonicalUrl || '', o.weekOf || '', o.billableViews, o.overrideBps === null ? `+${(o.cpmDiffCents / 100).toFixed(2)} CPM difference` : `${cmpPct(o.overrideBps)}% of ${((o.fromEarnedCents || 0) / 100).toFixed(2)}`, (o.amountCents / 100).toFixed(2)]);
  }
  downloadCsv('affiliate-payouts.csv', rows);
}

// ── Team pyramid (uplines and ranks) ──
// Each rank is a band of the pyramid; lines connect every affiliate to their upline. A solid line means the
// upline earns their override % on that person; dashed means $0 (the upline's override is 0%).

const RANKS = [['top_creator', 'Top Creator'], ['master', 'Master'], ['general', 'General'], ['rookie', 'Rookie']];
const RANK_LABEL = Object.fromEntries(RANKS);
const RANK_CHIP = { top_creator: 'rank-chip-top_creator', master: 'chip-purple', general: 'chip-blue', rookie: 'chip-green' };
let pyramidPerson = null;   // affiliate id open in the person modal

const teamMembers = (c) => c.affiliates.filter(a => a.status !== 'removed');
const rateOfAff = (a) => a.effectiveCpmRateCents;
const pctOfAff = (a) => a.effectiveOverrideBps ?? 0;
// Payout override row: "5% of $12.00", or the old "+$0.50" CPM difference on rows priced before percentages.
const overrideRateText = (o) => (o.overrideBps === null || o.overrideBps === undefined ? `+${cmpMoney(o.cpmDiffCents)}` : `${cmpPct(o.overrideBps)}% of ${cmpMoney(o.fromEarnedCents)}`);

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
        // Upline with a 0% override: they earn nothing on this person.
        const warn = up && up.status !== 'removed' && !pctOfAff(up);
        return `<button class="pyr-node rank-${a.rank}${a.status === 'invited' ? ' invited' : ''}${warn ? ' warn' : ''}" data-id="${esc(a.id)}" onclick="openPerson(this.dataset.id)"
          title="${warn ? esc(`${up.creator.name} earns $0 on ${a.creator.name}: their team override is 0%`) : ''}">
          <b>${esc(a.creator.name)}</b><div class="pyr-cpm">${cmpMoney(rateOfAff(a))} / 1K · ${cmpPct(pctOfAff(a))}% team</div>
          <div class="pyr-sub">${cmpNum(a.views)} views · ${cmpMoney(a.earnedCents)}${a.overrideEarnedCents ? ` + ${cmpMoney(a.overrideEarnedCents)} team` : ''}</div>
        </button>`;
      }).join('') || '<span class="pyr-empty">Nobody at this rank</span>'}
    </div></div>`;
  };
  setTimeout(drawPyramidLines, 0);
  return `<div class="panel cmp-panel"><div class="panel-head"><span class="panel-title">Team pyramid</span>
      <div class="cmp-panel-actions"><button class="action-btn primary" onclick="openAffiliateForm({ rank: 'top_creator', uplineId: null })">+ New node</button></div></div>
    ${members.length ? `<div class="pyr" id="pyr"><svg class="pyr-lines" id="pyr-lines"></svg>${RANKS.map(band).join('')}</div>
      <div class="pyr-legend"><span><i></i>upline earns their team % of this person's pay (on top, not taken from it)</span><span><i class="zero"></i>upline's team % is 0, earns $0</span><span>Dashed card = hasn't signed in yet · click anyone to promote, recruit, or move</span></div>`
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
    const earns = pctOfAff(byId.get(a.uplineId)) > 0;
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
      <span class="feed-time" style="margin-left:6px;">${up ? `Upline: <b>${esc(up.creator.name)}</b> (${esc(RANK_LABEL[up.rank])}, earns ${cmpPct(pctOfAff(up))}% of this person's pay)` : 'Top of their tree (no upline)'}</span></div>
    <div class="person-stats">
      <div><span>CPM</span><b>${cmpMoney(rateOfAff(a))}</b></div>
      <div><span>Team override</span><b>${cmpPct(pctOfAff(a))}%</b></div>
      <div><span>Views</span><b>${cmpNum(a.views)}</b></div>
      <div><span>Own earned</span><b>${cmpMoney(a.earnedCents)}</b></div>
      <div><span>Team earned</span><b>${cmpMoney(a.overrideEarnedCents)}</b></div>
      <div><span>Paid</span><b>${cmpMoney(a.paidCents)}</b></div>
      <div><span>Owed</span><b>${cmpMoney(a.owedCents)}</b></div>
    </div>

    <div class="detail-section-title">Promote / change pay</div>
    <div class="person-row">
      <div class="c-field"><label>Rank</label><select class="c-input" id="pp-rank">${RANKS.map(([k, l]) => `<option value="${k}"${k === a.rank ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="c-field"><label>CPM (per 1,000 views)</label><div class="cmp-money"><input class="c-input" id="pp-cpm" inputmode="decimal" value="${esc(cmpDollarInput(a.cpmRateOverrideCents))}" placeholder="${esc(cmpDollarInput(cmpCurrent.defaultCpmRateCents))} (campaign)"></div></div>
      <div class="c-field"><label>Team override %</label><input class="c-input" id="pp-override" inputmode="decimal" value="${esc(cmpPct(a.overrideBps))}" placeholder="${esc(cmpPct(cmpCurrent.defaultOverrideBps))} (campaign)"></div>
      <button class="action-btn primary" onclick="savePersonRank()">Save</button>
    </div>
    <div class="ops-hint">Blank = the campaign's setting. Team override is the % of their recruits' pay (every level below them) this person earns on top. Recruits keep all of their own pay.</div>

    <div class="detail-section-title">Upline</div>
    <div class="person-row">
      <div class="c-field"><label>Reports to</label><select class="c-input" id="pp-upline"><option value="">No upline (top of a tree)</option>
        ${uplineOptions.map(x => `<option value="${esc(x.id)}"${x.id === a.uplineId ? ' selected' : ''}>${esc(x.creator.name)} · ${esc(RANK_LABEL[x.rank])} · ${cmpMoney(rateOfAff(x))}</option>`).join('')}</select></div>
      <button class="action-btn" onclick="savePersonUpline()">Move</button>
    </div>

    <div class="detail-section-title">Recruits (${recruits.length})</div>
    ${recruits.map(r => {
      const pct = pctOfAff(a);
      return `<div class="aff-result"><div class="cmp-who"><b>${esc(r.creator.name)}</b><span>${esc(RANK_LABEL[r.rank])} · ${cmpMoney(rateOfAff(r))}/1K · ${cmpNum(r.views)} views</span></div>
        <span class="feed-time">${pct > 0 ? `${esc(a.creator.name.split(' ')[0])} earns ${cmpPct(pct)}% of their pay` : 'earns $0 on them'}</span>
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
  let cents, bps;
  try {
    cents = cmpCents(document.getElementById('pp-cpm').value, 'CPM');
    bps = cmpBps(document.getElementById('pp-override').value, 'Team override');
  } catch (err) { cmpMsg('pp-msg', err.message); return; }
  patchPerson({ rank: document.getElementById('pp-rank').value, cpmRateOverrideCents: cents, overrideBps: bps });
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

// ─── Application page + applications (CONTRACT.md §9) ─────────
// The "Application page" tab edits the campaign's public page; the "Applications" tab reviews what comes in.

const APP_STATUS_CHIP = { new: 'chip-blue', reviewing: 'chip-orange', approved: 'chip-green', declined: 'chip-muted', withdrawn: 'chip-muted' };
const APP_STATE_TEXT = {
  open: ['chip-green', 'Taking applications'],
  closed: ['chip-orange', 'Closed — paused, past the closing date, or every seat is filled'],
  not_found: ['chip-muted', 'Off — the link shows “not found”']
};
const AUDIENCE_LABEL = { under_5k: 'Under 5K', '5k_25k': '5K–25K', '25k_100k': '25K–100K', '100k_500k': '100K–500K', '500k_plus': '500K+' };
const CADENCE_LABEL = { '1_2_week': '1–2 videos a week', '3_5_week': '3–5 a week', '6_plus_week': '6+ a week', not_sure: 'Not sure yet' };
const QUESTION_TYPES = [['short_text', 'Short answer'], ['long_text', 'Paragraph'], ['select', 'Pick one'], ['multi_select', 'Pick any'], ['boolean', 'Yes / no'], ['url', 'Link'], ['number', 'Number']];
const APP_PAGE_BASE = 'https://affiliate.edgeformmarketing.com/apply.html?c=';

let appQuestions = [];          // questions being edited on the Application page tab
let appQuestionsFor = null;     // campaign id they were loaded from
let appList = [];               // applications for the open campaign
let appFilter = 'new';
let appDetail = null;           // application open in the review modal
let appEmbedSuggestion = null;  // what the framing check found after the last save
let appListNotice = null;       // [text, kind] shown once the list re-renders after an action

// ── Application page tab ──

function applicationPageHtml(c) {
  if (appQuestionsFor !== c.id) { appQuestions = structuredClone(c.applicationQuestions); appQuestionsFor = c.id; appEmbedSuggestion = null; }
  const [chip, stateText] = APP_STATE_TEXT[c.applicationState] || APP_STATE_TEXT.not_found;
  const slug = c.publicSlug || c.suggestedSlug || '';
  setTimeout(() => { renderAppExplainer(); renderAppQuestions(); renderPromoPreview(); }, 0);
  return `
    <div class="panel cmp-panel">
      <div class="panel-head"><span class="panel-title">Public application page</span><span class="chip ${chip}">${esc(stateText)}</span></div>
      <div class="app-form">
        <label class="cmp-check app-toggle"><input type="checkbox" id="app-enabled" ${c.applicationEnabled ? 'checked' : ''}> Page is on — anyone with the link can apply</label>
        ${c.status === 'draft' ? '<div class="ops-hint">This campaign is a draft, so the page stays off until the campaign is active.</div>' : ''}

        <div class="c-field"><label>Link</label>
          <div class="app-link"><span class="app-link-base">${esc(APP_PAGE_BASE)}</span><input class="c-input" id="app-slug" value="${esc(slug)}" data-saved="${esc(c.publicSlug || '')}" maxlength="60" oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9-]/g,'')"></div>
          <div class="cmp-panel-actions" style="margin-top:6px;">
            <button class="action-btn" onclick="copyApplicationLink(this)">Copy link</button>
            ${c.publicUrl ? `<a class="action-btn" href="${safeUrl(c.publicUrl)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
          </div>
          <div class="ops-hint">Changing it breaks links you've already sent. Affiliates on the campaign share this same page with their own code added.</div></div>

        <div class="ops-form-grid">
          <div class="c-field full"><label>Headline <span class="app-count" id="app-headline-count"></span></label><input class="c-input" id="app-headline" maxlength="120" value="${esc(c.publicHeadline)}" placeholder="Get paid for every view you drive for ${esc(c.brandName || c.name)}" oninput="appCount('headline', 120)"></div>
          <div class="c-field full"><label>Pitch (public) <span class="app-count" id="app-pitch-count"></span></label><textarea class="c-input" id="app-pitch" maxlength="4000" style="min-height:130px;" placeholder="What the brand is, who it's for, and what kind of videos work. Everything here is public." oninput="appCount('pitch', 4000)">${esc(c.publicPitch)}</textarea>
            <div class="ops-hint">Applicants see this. The brief stays private — only affiliates on the campaign ever see it.</div></div>
          <div class="c-field"><label>Brand name</label><input class="c-input" id="app-brand" maxlength="120" value="${esc(c.brandName)}" placeholder="${esc(c.name)}" oninput="renderAppExplainer()"><div class="ops-hint">What they'd be promoting. Blank uses the campaign name.</div></div>
          <div class="c-field"><label>Starting pay</label><div class="app-static">${cmpMoney(c.defaultCpmRateCents)} per 1,000 views · ${cmpPct(c.defaultOverrideBps)}% team bonus</div>
            <div class="ops-hint">The campaign's own rate. Change it with “Edit campaign”.</div></div>
          <div class="c-field full"><label>What applicants read about pay</label><div class="cmp-explainer" id="app-explainer"></div></div>
        </div>

        <div class="detail-section-title">The site they'd promote</div>
        <div class="ops-form-grid">
          <div class="c-field full"><label>Promo site</label><input class="c-input" id="app-promo-url" value="${esc(c.promoUrl)}" placeholder="https://" oninput="renderPromoPreview()"></div>
          <div class="c-field full"><label class="cmp-check"><input type="checkbox" id="app-promo-embed" ${c.promoEmbed ? 'checked' : ''} onchange="renderPromoPreview()"> Show the site in a frame on the page</label>
            <div class="ops-hint">Some sites refuse to be framed. We check when you save; if it does, turn this off and the page shows the image below instead.</div>
            <div id="app-embed-msg"></div></div>
          <div class="c-field full"><label>Fallback image</label><input class="c-input" id="app-promo-image" value="${esc(c.promoImageUrl)}" placeholder="https://… (a screenshot of the site)" oninput="renderPromoPreview()"></div>
          <div class="c-field full"><div class="app-preview" id="app-promo-preview"></div></div>
        </div>

        <div class="detail-section-title">Questions (<span id="app-q-count"></span> of 10)</div>
        <div class="ops-hint" style="margin-bottom:8px;">Name, email, socials, platforms, audience size, how often they post, niches and “why you” are always asked. These are the extras for this campaign.</div>
        <div id="app-questions"></div>
        <button class="action-btn" id="app-add-q" onclick="addAppQuestion()">+ Add question</button>

        <div class="detail-section-title">When the page closes itself</div>
        <div class="ops-form-grid">
          <div class="c-field"><label>Seats</label><input class="c-input" id="app-seats" inputmode="numeric" value="${c.applicationSeats ?? ''}" placeholder="No limit"><div class="ops-hint">Closes once this many applications are approved. ${c.applicationCounts.approved} approved so far.</div></div>
          <div class="c-field"><label>Closing date</label><input class="c-input" id="app-closes" type="date" value="${esc(c.applicationClosesAt || '')}"><div class="ops-hint">Last day to apply (inclusive).</div></div>
        </div>
        <div class="email-msg" id="app-msg"></div>
        <div class="cmp-panel-actions" style="margin-top:12px;"><button class="send-btn" id="app-save" onclick="saveApplicationPage()"><span class="btn-text">Save application page</span></button></div>
      </div>
    </div>
    ${exampleVideosPanelHtml(c)}`;
}

function appCount(field, max) {
  const el = document.getElementById(`app-${field}`);
  const out = document.getElementById(`app-${field}-count`);
  if (el && out) out.textContent = `${el.value.length}/${max}`;
}

function renderAppExplainer() {
  const box = document.getElementById('app-explainer');
  if (!box || !cmpCurrent) return;
  const c = cmpCurrent;
  box.innerHTML = payExplainerHtml({
    name: c.name, brand_name: document.getElementById('app-brand')?.value.trim() || '', platforms_allowed: c.platformsAllowed,
    starting_cpm_rate_cents: c.defaultCpmRateCents, team_bonus_bps: c.defaultOverrideBps
  });
  appCount('headline', 120); appCount('pitch', 4000);
}

// The same iframe (or fallback card) the applicant sees.
function renderPromoPreview() {
  const box = document.getElementById('app-promo-preview');
  if (!box) return;
  const url = document.getElementById('app-promo-url').value.trim();
  const image = document.getElementById('app-promo-image').value.trim();
  const embed = document.getElementById('app-promo-embed').checked;
  const msg = document.getElementById('app-embed-msg');
  if (msg) {
    msg.innerHTML = appEmbedSuggestion === null ? ''
      : appEmbedSuggestion === embed ? `<div class="ops-hint app-ok">✓ Checked: this site ${embed ? 'can' : 'can’t'} be framed, and that matches your setting.</div>`
      : `<div class="email-msg show error" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">We checked the site: it ${appEmbedSuggestion ? 'allows' : 'refuses'} framing, so we suggest turning the frame ${appEmbedSuggestion ? 'on' : 'off'}.
          <button class="action-btn" onclick="document.getElementById('app-promo-embed').checked=${appEmbedSuggestion};saveApplicationPage()">Turn it ${appEmbedSuggestion ? 'on' : 'off'} and save</button></div>`;
  }
  if (!/^https:\/\//i.test(url)) { box.innerHTML = '<div class="cmp-empty">Add an https:// link to preview the site.</div>'; return; }
  box.innerHTML = embed
    ? `<div class="app-preview-label">Preview · what applicants see (a blank frame means the site refuses framing)</div>
       <iframe src="${esc(url)}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups" title="Promo site preview"></iframe>`
    : `<div class="app-preview-label">Preview · fallback card</div>
       <a class="app-fallback" href="${esc(url)}" target="_blank" rel="noopener">
         ${/^https:\/\//i.test(image) ? `<img src="${esc(image)}" alt="">` : '<div class="cmp-empty">No fallback image yet</div>'}
         <span>${esc(url.replace(/^https:\/\//i, ''))} ↗</span></a>`;
}

// ── Question editor ──

function newQuestionId(label) {
  const base = String(label || 'question').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 34) || 'question';
  let id = base;
  for (let n = 2; appQuestions.some(q => q.id === id); n++) id = `${base}_${n}`;
  return id;
}

function renderAppQuestions() {
  const box = document.getElementById('app-questions');
  if (!box) return;
  const saved = new Set((cmpCurrent?.applicationQuestions || []).map(q => q.id));
  document.getElementById('app-q-count').textContent = appQuestions.length;
  document.getElementById('app-add-q').disabled = appQuestions.length >= 10;
  box.innerHTML = appQuestions.map((q, i) => {
    const choices = q.type === 'select' || q.type === 'multi_select';
    const text = q.type === 'short_text' || q.type === 'long_text';
    return `<div class="app-q">
      <div class="app-q-head">
        <input class="c-input" value="${esc(q.label)}" placeholder="Question" maxlength="200" oninput="appQuestions[${i}].label=this.value">
        <select class="c-input" onchange="setQuestionType(${i}, this.value)">${QUESTION_TYPES.map(([k, l]) => `<option value="${k}"${q.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <label class="cmp-check"><input type="checkbox" ${q.required ? 'checked' : ''} onchange="appQuestions[${i}].required=this.checked"> Required</label>
        <div class="cmp-row-actions">
          <button class="action-btn" onclick="moveAppQuestion(${i}, -1)" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="action-btn" onclick="moveAppQuestion(${i}, 1)" ${i === appQuestions.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button class="action-btn" onclick="removeAppQuestion(${i})">Delete</button>
        </div>
      </div>
      <input class="c-input" value="${esc(q.help)}" placeholder="Help line under the field (optional)" maxlength="300" oninput="appQuestions[${i}].help=this.value">
      ${choices ? `<textarea class="c-input" placeholder="One option per line" oninput="appQuestions[${i}].options=this.value.split('\\n').map(s=>s.trim()).filter(Boolean)">${esc(q.options.join('\n'))}</textarea>` : ''}
      ${text ? `<input class="c-input app-q-max" inputmode="numeric" value="${q.max_length ?? ''}" placeholder="Max characters (optional)" oninput="appQuestions[${i}].max_length=this.value.trim()===''?null:Number(this.value)">` : ''}
      <div class="app-q-id">id: ${saved.has(q.id)
        ? `${esc(q.id)} <span title="Answers already received are stored under this id, so it can't change.">(fixed)</span>`
        : `<input class="c-input" value="${esc(q.id)}" maxlength="40" oninput="appQuestions[${i}].id=this.value.toLowerCase().replace(/[^a-z0-9_]/g,'');this.value=appQuestions[${i}].id">`}</div>
    </div>`;
  }).join('') || '<div class="cmp-empty">No extra questions. Applicants only fill in the standard fields.</div>';
}

function setQuestionType(i, type) {
  const q = appQuestions[i];
  q.type = type;
  if ((type === 'select' || type === 'multi_select') && q.options.length < 2) q.options = ['Option 1', 'Option 2'];
  if (type !== 'select' && type !== 'multi_select') q.options = [];
  if (type !== 'short_text' && type !== 'long_text') q.max_length = null;
  renderAppQuestions();
}

function addAppQuestion() {
  if (appQuestions.length >= 10) return;
  appQuestions.push({ id: newQuestionId('question'), label: '', type: 'short_text', required: false, help: '', options: [], max_length: null });
  renderAppQuestions();
  document.querySelector('#app-questions .app-q:last-child input')?.focus();
}

function moveAppQuestion(i, by) {
  const j = i + by;
  if (j < 0 || j >= appQuestions.length) return;
  [appQuestions[i], appQuestions[j]] = [appQuestions[j], appQuestions[i]];
  renderAppQuestions();
}

function removeAppQuestion(i) {
  const q = appQuestions[i];
  if (q.label && !confirm(`Delete “${q.label}”? Answers already received stay on those applications.`)) return;
  appQuestions.splice(i, 1);
  renderAppQuestions();
}

// ── Save ──

async function saveApplicationPage() {
  const v = (id) => document.getElementById(id).value;
  const slugEl = document.getElementById('app-slug');
  const slug = slugEl.value.trim();
  const savedSlug = slugEl.dataset.saved;
  const enabled = document.getElementById('app-enabled').checked;
  if (enabled && slug.length < 3) { cmpMsg('app-msg', 'The link needs at least 3 letters or digits.'); return; }
  if (savedSlug && slug !== savedSlug && !confirm(`Change the link from “${savedSlug}” to “${slug}”?\n\nLinks already sent — including the ones affiliates are sharing — will stop working.`)) return;
  let seats;
  try { seats = cmpWhole(v('app-seats'), 'Seats'); } catch (err) { cmpMsg('app-msg', err.message); return; }
  const body = {
    applicationEnabled: enabled, publicSlug: slug || null,
    publicHeadline: v('app-headline').trim(), publicPitch: v('app-pitch').trim(), brandName: v('app-brand').trim(),
    promoUrl: v('app-promo-url').trim(), promoEmbed: document.getElementById('app-promo-embed').checked, promoImageUrl: v('app-promo-image').trim(),
    applicationQuestions: appQuestions, applicationSeats: seats || null, applicationClosesAt: v('app-closes') || null
  };
  const btn = document.getElementById('app-save');
  btn.disabled = true;
  try {
    const res = await cmpRequest(`/api/campaigns/${encodeURIComponent(cmpCurrent.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    cmpCurrent = res.campaign;
    delete cmpCache[res.campaign.operationId];
    appQuestionsFor = null;
    renderCampaignView();
    appEmbedSuggestion = typeof res.promoEmbedDetected === 'boolean' ? res.promoEmbedDetected : null;
    setTimeout(() => { renderPromoPreview(); cmpMsg('app-msg', 'Saved.', 'success'); }, 0);
  } catch (err) {
    cmpMsg('app-msg', err.message);
    btn.disabled = false;
  }
}

async function copyApplicationLink(btn) {
  const slug = document.getElementById('app-slug').value.trim();
  if (!slug) return;
  const url = APP_PAGE_BASE + slug;
  try { await navigator.clipboard.writeText(url); btn.textContent = 'Copied'; }
  catch { prompt('Copy this link:', url); }
  setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
  if (slug !== document.getElementById('app-slug').dataset.saved) cmpMsg('app-msg', 'That link isn’t saved yet — save the page before sharing it.');
}

// ── Example videos ──

function exampleVideosPanelHtml(c) {
  const list = c.exampleVideos || [];
  return `<div class="panel cmp-panel">
    <div class="panel-head"><span class="panel-title">Example videos (${list.length} of 6)</span><span class="feed-time">Shown on the page as examples of the work. Never tracked or paid.</span></div>
    ${list.length ? `<div class="app-examples">${list.map(v => `
      <div class="app-example" draggable="true" data-id="${esc(v.id)}" ondragstart="event.dataTransfer.setData('text/plain', this.dataset.id);this.classList.add('dragging')" ondragend="this.classList.remove('dragging')"
           ondragover="event.preventDefault()" ondrop="event.preventDefault();dropExampleVideo(event.dataTransfer.getData('text/plain'), this.dataset.id)">
        <span class="app-drag" title="Drag to reorder">⋮⋮</span>
        ${v.thumbnailUrl ? `<img src="${safeUrl(v.thumbnailUrl)}" alt="">` : `<div class="app-thumb">${esc(CMP_PLATFORMS[v.platform] || v.platform)}</div>`}
        <div class="app-example-body">
          <a href="${safeUrl(v.url)}" target="_blank" rel="noopener">${esc(CMP_PLATFORMS[v.platform] || v.platform)} · ${esc(v.platformVideoId)} ↗</a>
          <input class="c-input" value="${esc(v.caption)}" placeholder="Caption (optional)" maxlength="300" data-id="${esc(v.id)}" onchange="saveExampleCaption(this)">
        </div>
        <button class="action-btn" data-id="${esc(v.id)}" onclick="deleteExampleVideo(this.dataset.id)">Remove</button>
      </div>`).join('')}</div>` : '<div class="cmp-empty">No examples yet. Add a few videos that show the kind of content that works.</div>'}
    ${list.length < 6 ? `<div class="app-example-add">
      <input class="c-input" id="app-ex-url" placeholder="TikTok, Instagram or YouTube link">
      <input class="c-input" id="app-ex-caption" placeholder="Caption (optional)" maxlength="300">
      <button class="action-btn primary" onclick="addExampleVideo(this)">Add</button></div>` : ''}
    <div class="email-msg" id="app-ex-msg" style="margin:0 18px 14px;"></div>
  </div>`;
}

async function addExampleVideo(btn) {
  const url = document.getElementById('app-ex-url').value.trim();
  if (!url) { cmpMsg('app-ex-msg', 'Paste a video link.'); return; }
  btn.disabled = true;
  try {
    await cmpRequest(`/api/campaigns/${encodeURIComponent(cmpCurrent.id)}/example-videos`, { method: 'POST', body: JSON.stringify({ url, caption: document.getElementById('app-ex-caption').value.trim() }) });
    refreshCampaign();
  } catch (err) { cmpMsg('app-ex-msg', err.message); btn.disabled = false; }
}

async function saveExampleCaption(input) {
  try {
    await cmpRequest(`/api/campaign-example-videos/${encodeURIComponent(input.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ caption: input.value.trim() }) });
    const v = cmpCurrent.exampleVideos.find(x => x.id === input.dataset.id);
    if (v) v.caption = input.value.trim();
  } catch (err) { cmpMsg('app-ex-msg', 'Caption not saved: ' + err.message); }
}

async function deleteExampleVideo(id) {
  if (!confirm('Remove this example video from the page?')) return;
  try {
    await cmpRequest(`/api/campaign-example-videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
    refreshCampaign();
  } catch (err) { cmpMsg('app-ex-msg', err.message); }
}

// Dropping one video onto another puts it in that spot; only the ones whose position changed are saved.
async function dropExampleVideo(dragId, targetId) {
  if (!dragId || dragId === targetId) return;
  const list = [...cmpCurrent.exampleVideos];
  const from = list.findIndex(v => v.id === dragId);
  const to = list.findIndex(v => v.id === targetId);
  if (from < 0 || to < 0) return;
  list.splice(to, 0, list.splice(from, 1)[0]);
  const changed = list.map((v, i) => [v, i]).filter(([v, i]) => v.sortOrder !== i);
  try {
    await Promise.all(changed.map(([v, i]) => cmpRequest(`/api/campaign-example-videos/${encodeURIComponent(v.id)}`, { method: 'PATCH', body: JSON.stringify({ sortOrder: i }) })));
  } catch (err) { cmpMsg('app-ex-msg', 'Order not saved: ' + err.message); }
  refreshCampaign();
}

// ── Applications tab ──

function applicationsPanelHtml() {
  setTimeout(loadApplications, 0);
  return `<div class="panel cmp-panel" id="app-list-panel"><div class="panel-head"><span class="panel-title">Applications</span></div><div class="cmp-empty">Loading applications…</div></div>`;
}

async function loadApplications() {
  if (!cmpCurrent) return;
  try {
    appList = (await cmpRequest(`/api/campaigns/${encodeURIComponent(cmpCurrent.id)}/applications`)).applications;
    renderApplications();
  } catch (err) {
    const panel = document.getElementById('app-list-panel');
    if (panel) panel.innerHTML = `<div class="cmp-empty">Couldn't load applications: ${esc(err.message)}</div>`;
  }
}

function socialHref(platform, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(www\.)?(instagram|tiktok|youtube)\.com\//i.test(v) || /^youtu\.be\//i.test(v)) return 'https://' + v;
  const h = encodeURIComponent(v.replace(/^@/, ''));
  return { instagram: `https://www.instagram.com/${h}/`, tiktok: `https://www.tiktok.com/@${h}`, youtube: `https://www.youtube.com/@${h}` }[platform] || '';
}

const appSocialLinks = (a) => ['tiktok', 'instagram', 'youtube'].filter(p => a[p]).map(p =>
  `<a href="${safeUrl(socialHref(p, a[p]))}" target="_blank" rel="noopener">${esc(CMP_PLATFORMS[p])} ${esc(a[p].replace(/^https?:\/\/(www\.)?/i, ''))} ↗</a>`).join('');

function renderApplications() {
  const panel = document.getElementById('app-list-panel');
  if (!panel) return;
  const counts = appList.reduce((m, a) => ({ ...m, [a.status]: (m[a.status] || 0) + 1 }), {});
  const filters = [['new', 'New'], ['reviewing', 'Reviewing'], ['approved', 'Approved'], ['declined', 'Declined'], ['all', 'All']];
  const shown = appList.filter(a => appFilter === 'all' || a.status === appFilter);
  const c = cmpCurrent;
  panel.innerHTML = `<div class="panel-head"><span class="panel-title">Applications</span>
      <div class="cmp-panel-actions">${filters.map(([k, label]) => `<button class="action-btn${appFilter === k ? ' primary' : ''}" onclick="appFilter='${k}';renderApplications()">${label} ${k === 'all' ? appList.length : counts[k] || 0}</button>`).join('')}</div></div>
    ${shown.length ? `<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr>
        <th>Applicant</th><th>Socials</th><th>Posts on</th><th>Referred by</th><th>Submitted</th><th>Status</th><th></th>
      </tr></thead><tbody>${shown.map(a => `<tr>
        <td><div class="cmp-who"><b>${esc(a.name)}</b><span>${esc(a.email)}</span>${a.alreadyOnCampaign ? '<span class="cmp-alert">already on this campaign</span>' : a.creatorName && a.status !== 'approved' ? '<span>already a creator</span>' : ''}</div></td>
        <td><div class="app-socials">${appSocialLinks(a) || '—'}</div></td>
        <td><div class="cmp-who"><span>${a.platforms.map(p => esc(CMP_PLATFORMS[p] || p)).join(' · ')}</span><span>${esc(AUDIENCE_LABEL[a.audienceSize] || '')}${a.postingCadence ? ' · ' + esc(CADENCE_LABEL[a.postingCadence]) : ''}</span></div></td>
        <td>${a.referredByName ? esc(a.referredByName) : '<span class="feed-time">—</span>'}</td>
        <td>${fmtDate(a.submittedAt)}</td>
        <td><span class="chip ${APP_STATUS_CHIP[a.status] || 'chip-muted'}">${esc(a.status)}</span></td>
        <td><div class="cmp-row-actions"><button class="action-btn${a.status === 'new' ? ' primary' : ''}" data-id="${esc(a.id)}" onclick="openApplication(this.dataset.id)">Review…</button></div></td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="cmp-empty">${appList.length ? 'Nothing in this view.' : c.applicationEnabled ? 'No applications yet. Share the link from the Application page tab.' : 'No applications yet. Turn the page on from the Application page tab to start taking them.'}</div>`}
    <div class="email-msg" id="app-list-msg" style="margin:0 18px 14px;"></div>`;
  if (appListNotice) { cmpMsg('app-list-msg', ...appListNotice); appListNotice = null; }
}

// ── Review modal ──

function ensureApplicationModal() {
  if (document.getElementById('app-modal')) return;
  document.body.insertAdjacentHTML('beforeend', `
<div class="ops-modal-bg" id="app-modal" hidden onclick="if (event.target === this) closeApplication()">
  <div class="ops-modal" role="dialog" aria-labelledby="app-modal-title">
    <div class="ops-modal-head"><span class="compose-title" id="app-modal-title">Application</span><button class="drawer-close" onclick="closeApplication()" aria-label="Close">✕</button></div>
    <div class="ops-modal-body" id="app-modal-body"></div>
    <div class="ops-modal-foot" id="app-modal-foot"></div>
  </div>
</div>`);
}

function answerHtml(q, value) {
  if (value === undefined || value === null || value === '') return '<span class="feed-time">—</span>';
  if (q?.type === 'boolean') return value ? 'Yes' : 'No';
  if (q?.type === 'url') return `<a href="${safeUrl(value)}" target="_blank" rel="noopener">${esc(value)} ↗</a>`;
  if (Array.isArray(value)) return esc(value.join(', '));
  if (typeof value === 'number') return cmpNum(value);
  return `<span style="white-space:pre-wrap">${esc(value)}</span>`;
}

function openApplication(id, mode = 'view') {
  ensureApplicationModal();
  appDetail = appList.find(a => a.id === id);
  if (!appDetail) return;
  const a = appDetail;
  const questions = cmpCurrent.applicationQuestions;
  // Answers to questions that were later deleted still show, under their id.
  const extraIds = Object.keys(a.answers).filter(k => !questions.some(q => q.id === k));
  document.getElementById('app-modal-title').textContent = a.name;
  document.getElementById('app-modal').hidden = false;
  document.getElementById('app-modal-body').innerHTML = `
    <div class="cmp-title" style="margin-bottom:10px;"><span class="chip ${APP_STATUS_CHIP[a.status]}">${esc(a.status)}</span>
      ${a.alreadyOnCampaign ? '<span class="chip chip-orange">already on this campaign</span>' : a.creatorName && a.status !== 'approved' ? '<span class="chip chip-purple">already a creator</span>' : ''}</div>
    <div class="detail-grid">
      ${detailField('Email', `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>`)}
      ${detailField('Phone', esc(a.phone))}
      ${detailField('Country', esc(a.country))}
      ${detailField('Submitted', fmtDateTime(a.submittedAt))}
      ${detailField('Socials', `<div class="app-socials">${appSocialLinks(a)}</div>`, true)}
      ${detailField('Portfolio', a.portfolioUrl ? `<a href="${safeUrl(a.portfolioUrl)}" target="_blank" rel="noopener">${esc(a.portfolioUrl)} ↗</a>` : '')}
      ${detailField('Would post on', a.platforms.map(p => esc(CMP_PLATFORMS[p] || p)).join(', '))}
      ${detailField('Audience', esc(AUDIENCE_LABEL[a.audienceSize] || ''))}
      ${detailField('Posts', esc(CADENCE_LABEL[a.postingCadence] || ''))}
      ${detailField('Niches', esc(a.niches.join(', ')))}
      ${detailField('Referred by', a.referredByName ? `${esc(a.referredByName)} <span class="feed-time">code ${esc(a.refCode || '')}</span>` : a.refCode ? `<span class="feed-time">code ${esc(a.refCode)} didn't match anyone on a campaign</span>` : '')}
      ${detailField('Why them', a.why ? `<span style="white-space:pre-wrap">${esc(a.why)}</span>` : '', true)}
    </div>
    ${questions.length || extraIds.length ? `<div class="detail-section-title">Answers</div>
      <div class="detail-grid">${questions.map(q => `<div class="detail-field" style="grid-column:1/-1;"><label>${esc(q.label)}</label><div class="val">${answerHtml(q, a.answers[q.id])}</div></div>`).join('')}
      ${extraIds.map(k => `<div class="detail-field" style="grid-column:1/-1;"><label>${esc(k)} (question since removed)</label><div class="val">${answerHtml(null, a.answers[k])}</div></div>`).join('')}</div>` : ''}
    ${a.status === 'declined' && a.declineReason ? `<div class="detail-section-title">Decline reason (staff only unless emailed)</div><div class="cmp-brief" style="padding:0;">${esc(a.declineReason)}</div>` : ''}
    <div class="detail-section-title">Notes (staff only)</div>
    <textarea class="c-input" id="app-notes" style="min-height:70px;" placeholder="Anything the team should know">${esc(a.reviewNotes)}</textarea>
    <button class="action-btn" style="margin-top:6px;" onclick="saveApplicationNotes(this)">Save notes</button>
    ${mode === 'approve' ? approveFormHtml(a) : mode === 'decline' ? declineFormHtml(a) : ''}
    <div class="email-msg" id="app-modal-msg"></div>
    <details class="app-meta"><summary>Where it came from</summary>
      <div class="cmp-audit-json">${esc(JSON.stringify({ pageUrl: a.pageUrl, referrer: a.referrer, utm: a.utm, userAgent: a.userAgent }, null, 2))}</div></details>`;
  const id_ = esc(a.id);
  const foot = [];
  if (a.status === 'new') foot.push(`<button class="action-btn" onclick="setApplicationStatus('reviewing')">Mark reviewing</button>`);
  if (a.status === 'declined') foot.push(`<button class="action-btn" onclick="setApplicationStatus('new')">Move back to new</button>`);
  if (['new', 'reviewing'].includes(a.status) && mode !== 'decline') foot.push(`<button class="action-btn" data-id="${id_}" onclick="openApplication(this.dataset.id, 'decline')">Decline…</button>`);
  if (['new', 'reviewing', 'declined'].includes(a.status) && mode !== 'approve') foot.push(`<button class="action-btn primary" data-id="${id_}" onclick="openApplication(this.dataset.id, 'approve')">Approve…</button>`);
  foot.push('<button class="action-btn" onclick="closeApplication()">Close</button>');
  document.getElementById('app-modal-foot').innerHTML = foot.join('');
  if (mode !== 'view') document.getElementById(mode === 'approve' ? 'app-approve-box' : 'app-decline-box')?.scrollIntoView({ block: 'nearest' });
}

function approveFormHtml(a) {
  const c = cmpCurrent;
  const members = teamMembers(c);
  const suggested = a.suggestedUplineId && members.some(m => m.id === a.suggestedUplineId) ? a.suggestedUplineId : '';
  return `<div class="app-action-box" id="app-approve-box">
    <div class="detail-section-title" style="margin-top:0;">Approve ${esc(a.name)}</div>
    ${a.alreadyOnCampaign ? '<div class="ops-hint">They\'re already on this campaign, so approving just links this application to them. Nothing else changes.</div>' : `
    <div class="ops-form-grid">
      <div class="c-field"><label>Pay per 1,000 views</label><div class="cmp-money"><input class="c-input" id="app-ap-rate" inputmode="decimal" value="${esc(cmpDollarInput(c.defaultCpmRateCents))}"></div>
        <div class="ops-hint">The starting pay they saw on the page. Change it only if you agreed something else.</div></div>
      <div class="c-field"><label>Rank</label><select class="c-input" id="app-ap-rank">${RANKS.map(([k, l]) => `<option value="${k}"${k === 'rookie' ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="c-field full"><label>Upline on this campaign</label><select class="c-input" id="app-ap-upline">
        <option value="">No upline (top of a tree)</option>
        ${members.map(m => `<option value="${esc(m.id)}"${m.id === suggested ? ' selected' : ''}>${esc(m.creator.name)} · ${esc(RANK_LABEL[m.rank])}</option>`).join('')}</select>
        <div class="ops-hint">${a.suggestedUplineName
          ? `Suggested: <b>${esc(a.suggestedUplineName)}</b> — the first person up their referral chain who's on this campaign.`
          : a.referredByName ? `${esc(a.referredByName)} referred them, but nobody in that chain is on this campaign, so no upline is suggested.` : 'Nobody referred them.'}</div></div>
      <div class="c-field full"><label class="cmp-check"><input type="checkbox" id="app-ap-invite" checked> Email them the invite to the affiliate portal</label></div>
    </div>`}
    <button class="send-btn" id="app-ap-go" onclick="approveApplication()"><span class="btn-text">Approve${a.alreadyOnCampaign ? '' : ' and add to campaign'}</span></button>
  </div>`;
}

function declineFormHtml(a) {
  return `<div class="app-action-box" id="app-decline-box">
    <div class="detail-section-title" style="margin-top:0;">Decline ${esc(a.name)}</div>
    <div class="c-field"><label>Reason (optional)</label><textarea class="c-input" id="app-dc-reason" style="min-height:70px;" placeholder="Stays with staff unless you email it">${esc(a.declineReason)}</textarea></div>
    <label class="cmp-check" style="margin:8px 0;"><input type="checkbox" id="app-dc-email"> Email them a short note (includes the reason, if any)</label>
    <div><button class="send-btn" onclick="declineApplication(this)"><span class="btn-text">Decline</span></button></div>
  </div>`;
}

function closeApplication() {
  document.getElementById('app-modal').hidden = true;
  appDetail = null;
}

async function patchApplication(body) {
  const res = await cmpRequest(`/api/campaign-applications/${encodeURIComponent(appDetail.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  appList = appList.map(a => (a.id === res.application.id ? res.application : a));
  return res;
}

async function saveApplicationNotes(btn) {
  btn.disabled = true;
  try {
    await patchApplication({ reviewNotes: document.getElementById('app-notes').value });
    cmpMsg('app-modal-msg', 'Notes saved.', 'success');
  } catch (err) { cmpMsg('app-modal-msg', err.message); }
  btn.disabled = false;
}

async function setApplicationStatus(status) {
  try {
    const res = await patchApplication({ status, reviewNotes: document.getElementById('app-notes').value });
    openApplication(res.application.id);
    afterApplicationChange();
  } catch (err) { cmpMsg('app-modal-msg', err.message); }
}

async function declineApplication(btn) {
  btn.disabled = true;
  try {
    const email = document.getElementById('app-dc-email').checked;
    const res = await patchApplication({
      status: 'declined', declineReason: document.getElementById('app-dc-reason').value.trim(),
      reviewNotes: document.getElementById('app-notes').value, sendDeclineEmail: email
    });
    closeApplication();
    afterApplicationChange(email ? (res.emailSent ? 'Declined, and the email was sent.' : `Declined, but the email failed: ${res.emailError}`) : 'Declined.', !email || res.emailSent);
  } catch (err) { cmpMsg('app-modal-msg', err.message); btn.disabled = false; }
}

async function approveApplication() {
  const a = appDetail;
  const btn = document.getElementById('app-ap-go');
  const body = {};
  if (!a.alreadyOnCampaign) {
    let cents;
    try { cents = cmpCents(document.getElementById('app-ap-rate').value, 'Pay per 1,000 views'); } catch (err) { cmpMsg('app-modal-msg', err.message); return; }
    // The campaign rate means "no custom rate", so later changes to the campaign rate still reach them.
    body.cpmRateOverrideCents = cents === null || cents === cmpCurrent.defaultCpmRateCents ? null : cents;
    body.rank = document.getElementById('app-ap-rank').value;
    body.uplineId = document.getElementById('app-ap-upline').value || null;
    body.sendInvite = document.getElementById('app-ap-invite').checked;
  }
  btn.disabled = true;
  try {
    await patchApplication({ reviewNotes: document.getElementById('app-notes').value });
    const res = await cmpRequest(`/api/campaign-applications/${encodeURIComponent(a.id)}/approve`, { method: 'POST', body: JSON.stringify(body) });
    closeApplication();
    const who = res.creator?.name || a.name;
    afterApplicationChange(
      a.alreadyOnCampaign ? `${who} was already on the campaign; the application is now marked approved.`
        : res.inviteSent ? `${who} is on the campaign. Invite emailed to ${a.email}.`
        : res.inviteError ? `${who} is on the campaign, but the invite email failed (${res.inviteError}). Use “Resend invite” on the Affiliate tab.`
        : `${who} is on the campaign. No invite was sent.`,
      !res.inviteError);
    if (res.creator?.created) loadCreators();
  } catch (err) { cmpMsg('app-modal-msg', err.message); btn.disabled = false; }
}

// Counts, the affiliate list and the tab badge all come from the campaign, so reload it.
function afterApplicationChange(message, ok = true) {
  appListNotice = message ? [message, ok ? 'success' : 'error'] : null;
  refreshCampaign();
}
