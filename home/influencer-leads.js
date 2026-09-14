const IFL_STATUSES = ['New', 'Ready to Review', 'Shortlisted', 'Contacted', 'Replied', 'Not a Fit', 'Archived'];
const IFL_NICHES = ['Beauty & Skincare', 'Fashion', 'Fitness & Wellness', 'Food & Drink', 'Travel', 'Lifestyle', 'Parenting & Family', 'Tech', 'Gaming', 'Business & Finance', 'Automotive', 'Home & DIY', 'Local / City', 'Entertainment', 'Education'];
const IFL_PROFILE_FIELDS = ['brandProduct', 'targetCustomer', 'desiredNiches', 'desiredLocations', 'followerMin', 'followerMax', 'contentStyle', 'dealType', 'exclusions'];
const IFL_LEAD_FIELDS = ['handle', 'profileUrl', 'name', 'email', 'niche', 'location', 'followerCount', 'averageViews', 'engagementRate', 'source', 'tags', 'bio', 'recentPostNotes', 'notes'];
let iflLeads = [];
let iflLoaded = false;
let iflLoading = false;
let iflEditingId = null;
let iflSort = { key: 'createdAt', direction: -1 };
const iflOpen = new Set();
const iflSelected = new Set();

document.getElementById('ifl-status').innerHTML += IFL_STATUSES.map(status => `<option value="${esc(status)}">${esc(status)}</option>`).join('');

const originalShowPage = window.showPage;
window.showPage = function(name) {
  originalShowPage(name);
  if (name === 'influencer-leads' && !iflLoaded && !iflLoading) loadIflLeads();
};

function iflRequest(path = '', options = {}) {
  return api('/api/influencer-leads' + path, options).then(result => {
    if (!result.ok) throw new Error(result.error || 'Request failed.');
    return result;
  });
}

async function loadIflLeads() {
  iflLoading = true;
  document.getElementById('ifl-tbody').innerHTML = '<tr><td colspan="11"><div class="state-box"><div class="state-icon">⌕</div>Loading creator leads…</div></td></tr>';
  try {
    const result = await iflRequest();
    iflLeads = result.leads || [];
    iflLoaded = true;
    refreshIflFilters();
    renderIflLeads();
  } catch (error) {
    document.getElementById('ifl-tbody').innerHTML = `<tr><td colspan="11"><div class="state-box"><div class="state-icon">✕</div>Could not load leads.<br><small>${esc(error.message)}</small></div></td></tr>`;
  } finally { iflLoading = false; }
}

function refreshIflFilters() {
  const setOptions = (id, values, label) => {
    const select = document.getElementById(id), value = select.value;
    select.innerHTML = `<option value="">All ${label}</option>` + [...new Set(values.filter(Boolean))].sort().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    select.value = value;
  };
  setOptions('ifl-niche', [...IFL_NICHES, ...iflLeads.map(l => l.niche)], 'niches');
  setOptions('ifl-location', iflLeads.map(l => l.location), 'locations');
  setOptions('ifl-source', iflLeads.map(l => l.source), 'sources');
}

function iflNumber(id) {
  const value = document.getElementById(id).value;
  return value === '' ? null : Number(value);
}

function filteredIflLeads() {
  const q = document.getElementById('ifl-search').value.trim().toLowerCase();
  const status = document.getElementById('ifl-status').value;
  const niche = document.getElementById('ifl-niche').value;
  const location = document.getElementById('ifl-location').value;
  const source = document.getElementById('ifl-source').value;
  const followerMin = iflNumber('ifl-followers-min'), followerMax = iflNumber('ifl-followers-max');
  const scoreMin = iflNumber('ifl-score-min'), scoreMax = iflNumber('ifl-score-max');
  const tag = document.getElementById('ifl-tag').value.trim().toLowerCase();
  const rows = iflLeads.filter(lead => {
    const haystack = [lead.name, lead.handle, lead.email, lead.niche, lead.location, lead.source, lead.bio, lead.recentPostNotes, lead.notes, ...(lead.tags || []), ...(lead.noteLog || []).map(n => n.body)].join(' ').toLowerCase();
    return (!q || haystack.includes(q)) && (!status || lead.status === status) && (!niche || lead.niche === niche) &&
      (!location || lead.location === location) && (!source || lead.source === source) &&
      (followerMin === null || (lead.followerCount !== null && lead.followerCount >= followerMin)) &&
      (followerMax === null || (lead.followerCount !== null && lead.followerCount <= followerMax)) &&
      (scoreMin === null || (lead.aiFitScore !== null && lead.aiFitScore >= scoreMin)) &&
      (scoreMax === null || (lead.aiFitScore !== null && lead.aiFitScore <= scoreMax)) &&
      (!tag || (lead.tags || []).some(value => value.toLowerCase().includes(tag)));
  });
  const { key, direction } = iflSort;
  return rows.sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === 'name') { av = a.name || a.handle; bv = b.name || b.handle; }
    if (av === null || av === undefined || av === '') return 1;
    if (bv === null || bv === undefined || bv === '') return -1;
    return direction * (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv)));
  });
}

function sortIfl(key) {
  iflSort = { key, direction: iflSort.key === key ? -iflSort.direction : 1 };
  renderIflLeads();
}

function iflCompact(value) {
  return value === null || value === undefined ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function iflScoreClass(score) { return score >= 75 ? 'high' : score >= 50 ? 'mid' : score === null ? '' : 'low'; }
function iflStatusClass(status) { return status.toLowerCase().replaceAll(' ', '-'); }

function renderIflLeads() {
  if (!iflLoaded) return;
  const rows = filteredIflLeads();
  document.getElementById('ifl-count').textContent = `${rows.length} of ${iflLeads.length} lead${iflLeads.length === 1 ? '' : 's'}`;
  document.getElementById('ifl-selected-count').textContent = `${iflSelected.size} selected`;
  document.getElementById('ifl-analyze-selected').disabled = !iflSelected.size;
  document.getElementById('ifl-select-all').checked = rows.length > 0 && rows.every(l => iflSelected.has(l.id));
  document.querySelectorAll('[data-sort]').forEach(el => { el.textContent = el.dataset.sort === iflSort.key ? (iflSort.direction > 0 ? '↑' : '↓') : ''; });
  if (!rows.length) {
    document.getElementById('ifl-tbody').innerHTML = `<tr><td colspan="11"><div class="ifl-empty"><div class="state-icon">⌕</div><strong>${iflLeads.length ? 'No leads match these filters' : 'Build your creator shortlist'}</strong><p>${iflLeads.length ? 'Adjust the filters or search to see more creator leads.' : 'Find, import, or add creator leads → review and rank them with AI → manually contact the finalists. Nothing is sent to Instagram automatically.'}</p>${iflLeads.length ? '' : '<button class="action-btn primary" onclick="openIflDiscovery()">⌕ Find Influencers</button>'}</div></td></tr>`;
    return;
  }
  document.getElementById('ifl-tbody').innerHTML = rows.map(lead => iflRowHtml(lead)).join('');
}

function iflRowHtml(lead) {
  const id = esc(lead.id), score = lead.aiFitScore;
  const avatar = (lead.name || lead.handle || '?').split(/\s+/).map(v => v[0]).join('').slice(0, 2).toUpperCase();
  const reviewed = lead.lastReviewedAt ? fmtDate(lead.lastReviewedAt) : '—';
  const processing = lead.aiState === 'processing' ? '<span class="ifl-processing">Analyzing…</span>' : `<span class="ifl-score ${iflScoreClass(score)}">${score ?? '—'}</span>`;
  return `<tr class="ifl-row" onclick="toggleIflDetail('${id}')">
    <td onclick="event.stopPropagation()"><input type="checkbox" ${iflSelected.has(lead.id) ? 'checked' : ''} onchange="selectIfl('${id}',this.checked)" aria-label="Select ${esc(lead.name || lead.handle)}"></td>
    <td><div class="ifl-creator"><span class="ifl-avatar">${esc(avatar)}</span><span><strong>${esc(lead.name || '@' + lead.handle)}</strong><span class="ifl-handle">${lead.handle ? '@' + esc(lead.handle) : 'No handle'}</span></span></div></td>
    <td>${lead.profileUrl ? `<a class="ifl-ig" href="${esc(lead.profileUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open ↗</a>` : '—'}</td>
    <td>${esc(lead.niche || '—')}</td><td>${esc(lead.location || '—')}</td><td class="num">${iflCompact(lead.followerCount)}</td><td class="num">${iflCompact(lead.averageViews)}</td><td class="num">${processing}</td>
    <td><span class="ifl-status ${iflStatusClass(lead.status)}">${esc(lead.status)}</span></td><td>${fmtDate(lead.createdAt)}</td><td>${reviewed}</td>
  </tr>${iflOpen.has(lead.id) ? iflDetailHtml(lead) : ''}`;
}

function iflDetailHtml(lead) {
  const id = esc(lead.id), score = lead.aiFitScore;
  const list = (title, values) => values?.length ? `<div class="ifl-detail-title">${title}</div><ul class="ifl-ai-list">${values.map(v => `<li>${esc(v)}</li>`).join('')}</ul>` : '';
  const notes = (lead.noteLog || []).map(note => `<div class="ifl-note-item">${esc(note.body)}<small>${esc(note.author)} · ${fmtDateTime(note.createdAt)} <button class="opd-x" onclick="deleteIflNote('${id}','${esc(note.id)}')">Delete</button></small></div>`).join('');
  const ai = lead.aiFitScore !== null ? `<div class="ifl-ai-head"><span class="ifl-score ${iflScoreClass(score)}">${score}</span><div><strong>${esc(lead.aiRecommendation || 'review')}</strong><div class="ifl-ai-meta">${esc(lead.aiConfidence || '')} confidence</div></div></div><div class="ifl-ai-reason">${esc(lead.aiReason)}</div>${list('Strengths', lead.aiStrengths)}${list('Concerns', lead.aiConcerns)}${list('Missing information', lead.aiMissingInformation)}<div class="ifl-ai-meta">Analyzed ${fmtDateTime(lead.aiAnalyzedAt)} · ${esc(lead.aiModel)}</div>` : '<p class="ifl-copy">No analysis yet. Complete the Ideal Creator Profile, then analyze this lead.</p>';
  return `<tr class="ifl-detail-row"><td colspan="11"><div class="ifl-detail">
    <div class="ifl-detail-card"><div class="ifl-detail-title">Lead information</div><div class="ifl-facts">
      <div class="ifl-fact"><label>Email</label><div>${esc(lead.email || '—')}</div></div><div class="ifl-fact"><label>Engagement</label><div>${lead.engagementRate === null ? '—' : esc(lead.engagementRate) + '%'}</div></div><div class="ifl-fact"><label>Source</label><div>${esc(lead.source || '—')}</div></div>
    </div>${lead.tags?.length ? `<div class="ifl-tags">${lead.tags.map(tag => `<span class="ifl-tag">${esc(tag)}</span>`).join('')}</div>` : ''}
    ${lead.bio ? `<div class="ifl-detail-title" style="margin-top:14px">Bio</div><div class="ifl-copy">${esc(lead.bio)}</div>` : ''}${lead.recentPostNotes ? `<div class="ifl-detail-title" style="margin-top:14px">Recent post notes</div><div class="ifl-copy">${esc(lead.recentPostNotes)}</div>` : ''}${lead.notes ? `<div class="ifl-detail-title" style="margin-top:14px">Notes</div><div class="ifl-copy">${esc(lead.notes)}</div>` : ''}
    <div class="ifl-detail-actions"><button class="action-btn" onclick="openIflLeadForm('${id}')">Edit</button><select class="filter-select" onchange="setIflStatus('${id}',this.value)">${IFL_STATUSES.map(s => `<option ${s === lead.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
    <div class="ifl-note-form"><textarea class="c-input" id="ifl-note-${id}" placeholder="Add a dated note…"></textarea><button class="action-btn" onclick="addIflNote('${id}')">Add note</button></div><div class="ifl-note-log">${notes}</div>
    </div><div class="ifl-detail-card"><div class="ifl-detail-title">AI fit analysis</div>${ai}${lead.aiError ? `<div class="ifl-error">${esc(lead.aiError)}</div>` : ''}<div class="ifl-detail-actions"><button class="action-btn primary" ${lead.aiState === 'processing' ? 'disabled' : ''} onclick="analyzeIfl('${id}')">${lead.aiFitScore === null ? 'Analyze' : 'Analyze again'}</button></div></div>
  </div></td></tr>`;
}

function toggleIflDetail(id) { iflOpen.has(id) ? iflOpen.delete(id) : iflOpen.add(id); renderIflLeads(); }
function selectIfl(id, checked) { checked ? iflSelected.add(id) : iflSelected.delete(id); renderIflLeads(); }
function toggleAllIfl(checked) { filteredIflLeads().forEach(l => checked ? iflSelected.add(l.id) : iflSelected.delete(l.id)); renderIflLeads(); }

function replaceIflLead(lead) {
  const index = iflLeads.findIndex(item => item.id === lead.id);
  if (index >= 0) lead.noteLog = lead.noteLog?.length ? lead.noteLog : iflLeads[index].noteLog;
  if (index >= 0) iflLeads[index] = lead; else iflLeads.unshift(lead);
  refreshIflFilters(); renderIflLeads();
}

function openIflLeadForm(id = null) {
  iflEditingId = id;
  const lead = id ? iflLeads.find(item => item.id === id) : null;
  IFL_LEAD_FIELDS.forEach(field => {
    const el = document.getElementById('ifl-f-' + field);
    const value = field === 'tags' ? (lead?.tags || []).join('; ') : lead?.[field];
    el.value = value ?? '';
  });
  document.getElementById('ifl-lead-modal-title').textContent = lead ? `Edit ${lead.name || '@' + lead.handle}` : 'Add creator lead';
  document.getElementById('ifl-save').querySelector('.btn-text').textContent = lead ? 'Save changes' : 'Add lead';
  document.getElementById('ifl-delete').hidden = !lead;
  document.getElementById('ifl-lead-msg').className = 'email-msg';
  document.getElementById('ifl-lead-modal').hidden = false;
  document.getElementById('ifl-f-handle').focus();
}

function closeIflLeadForm() { document.getElementById('ifl-lead-modal').hidden = true; iflEditingId = null; }

async function saveIflLead() {
  const body = Object.fromEntries(IFL_LEAD_FIELDS.map(field => [field, document.getElementById('ifl-f-' + field).value.trim()]));
  const msg = document.getElementById('ifl-lead-msg'), button = document.getElementById('ifl-save');
  msg.className = 'email-msg'; button.disabled = true;
  try {
    const result = await iflRequest(iflEditingId ? '/' + encodeURIComponent(iflEditingId) : '', { method: iflEditingId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    replaceIflLead(result.lead); closeIflLeadForm();
  } catch (error) { msg.textContent = error.message; msg.className = 'email-msg error show'; }
  finally { button.disabled = false; }
}

async function deleteIflLead() {
  const lead = iflLeads.find(item => item.id === iflEditingId);
  if (!lead || !confirm(`Delete ${lead.name || '@' + lead.handle} and its notes? This cannot be undone.`)) return;
  try { await iflRequest('/' + encodeURIComponent(lead.id), { method: 'DELETE' }); iflLeads = iflLeads.filter(item => item.id !== lead.id); iflSelected.delete(lead.id); iflOpen.delete(lead.id); closeIflLeadForm(); refreshIflFilters(); renderIflLeads(); }
  catch (error) { alert('Not deleted: ' + error.message); }
}

async function setIflStatus(id, status) {
  try { replaceIflLead((await iflRequest('/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status }) })).lead); }
  catch (error) { alert('Status not saved: ' + error.message); }
}

async function addIflNote(id) {
  const box = document.getElementById('ifl-note-' + id), body = box.value.trim();
  if (!body) return box.focus();
  try { const { note } = await iflRequest(`/${encodeURIComponent(id)}/notes`, { method: 'POST', body: JSON.stringify({ body }) }); const lead = iflLeads.find(item => item.id === id); lead.noteLog.unshift(note); renderIflLeads(); }
  catch (error) { alert('Note not saved: ' + error.message); }
}

async function deleteIflNote(id, noteId) {
  if (!confirm('Delete this note?')) return;
  try { await iflRequest(`/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' }); const lead = iflLeads.find(item => item.id === id); lead.noteLog = lead.noteLog.filter(n => n.id !== noteId); renderIflLeads(); }
  catch (error) { alert('Note not deleted: ' + error.message); }
}

async function importIflCsv(input) {
  const file = input.files[0]; input.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return alert('CSV must be 2 MB or smaller.');
  try {
    const result = await iflRequest('/import', { method: 'POST', headers: { 'Content-Type': 'text/csv; charset=utf-8' }, body: await file.text() });
    const s = result.summary;
    document.getElementById('ifl-import-results').innerHTML = `<div class="ifl-import-stats"><div class="ifl-import-stat"><b>${s.total}</b><span>Rows</span></div><div class="ifl-import-stat"><b>${s.created}</b><span>Created</span></div><div class="ifl-import-stat"><b>${s.duplicates}</b><span>Duplicates</span></div><div class="ifl-import-stat"><b>${s.failed}</b><span>Failed</span></div></div>${s.errors.length ? `<div class="ifl-import-errors">${s.errors.map(e => `Row ${e.row}: ${esc(e.error)}`).join('<br>')}</div>` : ''}`;
    document.getElementById('ifl-import-modal').hidden = false;
    await loadIflLeads();
  } catch (error) { alert('Import failed: ' + error.message); }
}

function closeIflImport() { document.getElementById('ifl-import-modal').hidden = true; }

async function openIflDiscovery() {
  const modal = document.getElementById('ifl-discovery-modal');
  const msg = document.getElementById('ifl-discovery-msg');
  msg.textContent = '';
  msg.className = 'email-msg';
  document.getElementById('ifl-discovery-results').hidden = true;
  modal.hidden = false;
  try {
    const { profile } = await iflRequest('/profile');
    const defaults = {
      niche: profile.desiredNiches,
      location: profile.desiredLocations,
      followerMin: profile.followerMin,
      followerMax: profile.followerMax,
      exclusions: profile.exclusions
    };
    Object.entries(defaults).forEach(([field, value]) => {
      const input = document.getElementById('ifl-d-' + field);
      if (!input.value && value !== null && value !== undefined) input.value = value;
    });
  } catch (error) {
    msg.textContent = `Could not load saved creator preferences: ${error.message}`;
    msg.className = 'email-msg error show';
  }
  document.getElementById('ifl-d-query').focus();
}

function closeIflDiscovery() { document.getElementById('ifl-discovery-modal').hidden = true; }

function iflDiscoveryNumber(id) {
  const value = document.getElementById(id).value.trim();
  return value === '' ? null : Number(value);
}

function iflDiscoveryDiagnostics(d, summary) {
  if (!d) return '';
  const domains = Object.entries(d.sourceDomains || {}).slice(0, 8).map(([domain, n]) => `${esc(domain)} (${n})`).join(', ');
  const unconfirmed = (d.unconfirmed || []).slice(0, 8).map(u => `<li>${esc(u.name)}: ${esc(u.reason)}</li>`).join('');
  const status = d.incompleteReason ? `${esc(d.responseStatus)} (${esc(d.incompleteReason)})` : esc(d.responseStatus || 'unknown');
  return `<details class="ifl-discovery-diagnostics"${summary.imported ? '' : ' open'}><summary>Search details</summary>
    <div>Response: ${status} · ${d.sourceCount} sources consulted · ${d.candidateCount} candidates · ${d.rejectedCount} rejected</div>
    ${d.searchQueries?.length ? `<div>Queries: ${d.searchQueries.slice(0, 8).map(esc).join(' · ')}</div>` : ''}
    ${domains ? `<div>Top sources: ${domains}</div>` : ''}
    ${unconfirmed ? `<div>Not confirmed:</div><ul>${unconfirmed}</ul>` : ''}
    <div class="ifl-ai-meta">Run ${esc(d.runId)}</div></details>`;
}

async function runIflDiscovery() {
  const query = document.getElementById('ifl-d-query').value.trim();
  const count = iflDiscoveryNumber('ifl-d-count');
  const budgetUsd = iflDiscoveryNumber('ifl-d-budgetUsd');
  const followerMin = iflDiscoveryNumber('ifl-d-followerMin');
  const followerMax = iflDiscoveryNumber('ifl-d-followerMax');
  const msg = document.getElementById('ifl-discovery-msg');
  const results = document.getElementById('ifl-discovery-results');
  const button = document.getElementById('ifl-discovery-run');
  msg.className = 'email-msg';
  results.hidden = true;
  if (!query) {
    msg.textContent = 'Describe the influencers you want to find.';
    msg.className = 'email-msg error show';
    return document.getElementById('ifl-d-query').focus();
  }
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    msg.textContent = 'Creator limit must be between 1 and 50.';
    msg.className = 'email-msg error show';
    return;
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0.1 || budgetUsd > 25) {
    msg.textContent = 'Estimated spend limit must be between $0.10 and $25.';
    msg.className = 'email-msg error show';
    return;
  }
  if (followerMin !== null && followerMax !== null && followerMin > followerMax) {
    msg.textContent = 'Minimum followers cannot exceed maximum followers.';
    msg.className = 'email-msg error show';
    return;
  }
  button.disabled = true;
  button.classList.add('loading');
  button.querySelector('.btn-text').textContent = 'Searching…';
  msg.textContent = 'Searching public web sources and confirming Instagram handles. This can take a few minutes…';
  msg.className = 'email-msg show';
  try {
    const response = await iflRequest('/discover', {
      method: 'POST',
      body: JSON.stringify({
        query, count, budgetUsd, followerMin, followerMax,
        niche: document.getElementById('ifl-d-niche').value.trim(),
        location: document.getElementById('ifl-d-location').value.trim(),
        exclusions: document.getElementById('ifl-d-exclusions').value.trim()
      })
    });
    const { summary, usage, plan } = response;
    const reduced = plan.effectiveCount < plan.requestedCount ? `<div class="ifl-budget-note">Your budget allowed a search for up to ${plan.effectiveCount} of the ${plan.requestedCount} requested creators.</div>` : '';
    results.innerHTML = `<div class="ifl-discovery-summary"><strong>${summary.imported} new creator${summary.imported === 1 ? '' : 's'} added</strong><span>${summary.found} found · ${summary.duplicates} already in CRM · ${summary.failed} skipped</span></div>
      ${response.searchSummary ? `<p class="ifl-copy">${esc(response.searchSummary)}</p>` : ''}
      <div class="ifl-discovery-usage"><span>${usage.webSearchCalls} web search call${usage.webSearchCalls === 1 ? '' : 's'}</span><span>${usage.inputTokens.toLocaleString()} input tokens</span><span>${usage.outputTokens.toLocaleString()} output tokens</span><span>≈ $${Number(usage.estimatedCostUsd).toFixed(4)}</span></div>
      ${summary.errors?.length ? `<div class="ifl-import-errors">${summary.errors.map(esc).join('<br>')}</div>` : ''}${reduced}${iflDiscoveryDiagnostics(response.diagnostics, summary)}`;
    results.hidden = false;
    msg.textContent = summary.imported ? 'Discovery complete. The new profiles are ready to review below.' : 'Discovery completed, but no new profiles were added.';
    msg.className = 'email-msg success show';
    await loadIflLeads();
  } catch (error) {
    msg.textContent = error.message;
    msg.className = 'email-msg error show';
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    button.querySelector('.btn-text').textContent = '⌕ Find Influencers';
  }
}

async function openIflProfile() {
  document.getElementById('ifl-profile-msg').className = 'email-msg';
  document.getElementById('ifl-api-key').value = '';
  document.getElementById('ifl-api-key').type = 'password';
  document.getElementById('ifl-profile-modal').hidden = false;
  try {
    const [{ profile }, { settings }] = await Promise.all([iflRequest('/profile'), iflRequest('/settings')]);
    IFL_PROFILE_FIELDS.forEach(field => { document.getElementById('ifl-p-' + field).value = profile[field] ?? ''; });
    renderIflKeyStatus(settings);
  }
  catch (error) { const msg = document.getElementById('ifl-profile-msg'); msg.textContent = error.message; msg.className = 'email-msg error show'; }
}

function closeIflProfile() { document.getElementById('ifl-profile-modal').hidden = true; }

function renderIflKeyStatus(settings) {
  const status = document.getElementById('ifl-key-status');
  const input = document.getElementById('ifl-api-key');
  status.textContent = settings.configured ? `Configured ${settings.hint ? '· ' + settings.hint : ''}${settings.source === 'environment' ? ' · Worker secret' : ''}` : 'Not configured';
  status.classList.toggle('configured', settings.configured);
  input.disabled = !settings.canEdit;
  input.placeholder = settings.canEdit ? (settings.configured ? 'Paste a new key to replace it' : 'sk-…') : 'Only an admin can change the key';
  document.getElementById('ifl-key-remove').hidden = !settings.canEdit || settings.source !== 'settings';
}

function toggleIflKeyVisibility() {
  const input = document.getElementById('ifl-api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function saveIflProfile() {
  const body = Object.fromEntries(IFL_PROFILE_FIELDS.map(field => [field, document.getElementById('ifl-p-' + field).value.trim()]));
  const apiKey = document.getElementById('ifl-api-key').value.trim();
  const msg = document.getElementById('ifl-profile-msg'), button = document.getElementById('ifl-profile-save'); button.disabled = true;
  try {
    if (apiKey) await iflRequest('/settings', { method: 'PATCH', body: JSON.stringify({ apiKey }) });
    await iflRequest('/profile', { method: 'PATCH', body: JSON.stringify(body) });
    closeIflProfile();
  }
  catch (error) { msg.textContent = error.message; msg.className = 'email-msg error show'; }
  finally { button.disabled = false; }
}

async function removeIflApiKey() {
  if (!confirm('Remove the API key saved in Find Creators settings?')) return;
  try { const { settings } = await iflRequest('/settings', { method: 'DELETE' }); document.getElementById('ifl-api-key').value = ''; renderIflKeyStatus(settings); }
  catch (error) { const msg = document.getElementById('ifl-profile-msg'); msg.textContent = error.message; msg.className = 'email-msg error show'; }
}

async function analyzeIfl(id) {
  const lead = iflLeads.find(item => item.id === id); if (!lead) return;
  lead.aiState = 'processing'; lead.aiError = ''; renderIflLeads();
  try { const result = await iflRequest(`/${encodeURIComponent(id)}/analyze`, { method: 'POST', body: '{}' }); replaceIflLead(result.lead); }
  catch (error) { lead.aiState = 'failed'; lead.aiError = error.message; renderIflLeads(); }
}

async function analyzeSelectedIfl() {
  const ids = [...iflSelected];
  if (ids.length > 20) return alert('Analyze up to 20 leads at a time.');
  if (ids.length > 10 && !confirm(`Analyze ${ids.length} leads? OpenAI API usage may incur cost.`)) return;
  ids.forEach(id => { const lead = iflLeads.find(item => item.id === id); if (lead) { lead.aiState = 'processing'; lead.aiError = ''; } }); renderIflLeads();
  try {
    const { results } = await iflRequest('/analyze-batch', { method: 'POST', body: JSON.stringify({ ids }) });
    results.forEach(result => { const lead = iflLeads.find(item => item.id === result.id); if (result.ok) replaceIflLead(result.lead); else if (lead) { lead.aiState = 'failed'; lead.aiError = result.error; } });
    iflSelected.clear(); renderIflLeads();
    const failures = results.filter(result => !result.ok).length, skipped = results.filter(result => result.skipped).length;
    alert(`Analysis complete: ${results.length - failures - skipped} analyzed, ${skipped} unchanged/recent skipped, ${failures} failed.`);
  } catch (error) { ids.forEach(id => { const lead = iflLeads.find(item => item.id === id); if (lead) { lead.aiState = 'failed'; lead.aiError = error.message; } }); renderIflLeads(); }
}

function csvCell(value) { const text = Array.isArray(value) ? value.join('; ') : String(value ?? ''); return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

function exportIflCsv() {
  const columns = [['handle','handle'],['profile_url','profileUrl'],['name','name'],['email','email'],['niche','niche'],['location','location'],['follower_count','followerCount'],['average_views','averageViews'],['engagement_rate','engagementRate'],['bio','bio'],['recent_post_notes','recentPostNotes'],['source','source'],['notes','notes'],['tags','tags'],['status','status'],['ai_fit_score','aiFitScore'],['ai_confidence','aiConfidence'],['ai_recommendation','aiRecommendation'],['ai_reason','aiReason'],['date_added','createdAt'],['last_reviewed','lastReviewedAt']];
  const rows = filteredIflLeads(), csv = [columns.map(c => c[0]).join(','), ...rows.map(row => columns.map(([, key]) => csvCell(row[key])).join(','))].join('\r\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = `influencer-leads-${new Date().toISOString().slice(0,10)}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
