const statuses = ['inbox','assigned','in_progress','review','blocked','done','archived'];
const statusTitles = { inbox:'Inbox', assigned:'Assigned', in_progress:'In Progress', review:'Review', blocked:'Blocked', done:'Done', archived:'Archived' };
const priorityLabel = { p0:'Highest', p1:'High', p2:'Low', p3:'Lowest' };
const $ = (id) => document.getElementById(id);

let cachedTasks = [];
let cachedAgents = [];
let cachedEvents = [];
let readOnly = false;
let metrics = null;
let boardHealth = null;
let escalations = [];
let orchestraTemplates = [];
let kpiDashboard = null;
let selectedId = null;
let draggedTaskId = null;
let refreshInFlight = false;

const filters = { owner: 'all', status: 'all', priority: 'all', search: '', showArchived: false };
let feedType = 'all';
let feedLimit = 25;

const agentTone = {
  ultron: 'agent-ultron',
  codi: 'agent-codi',
  scout: 'agent-scout',
  ops: 'agent-ops'
};

function ownerChip(owner) {
  const tone = agentTone[owner] || '';
  return `<span class="owner-chip ${tone}">${owner}</span>`;
}

function actorChip(actor = 'system') {
  const root = String(actor).split('.')[0];
  const tone = agentTone[root] || '';
  return `<span class="actor-chip ${tone}">${actor}</span>`;
}

function showFlash(message, level = 'error') {
  const el = $('flash');
  el.textContent = message;
  el.classList.remove('hidden', 'ok', 'info', 'error');
  el.classList.add(level);
}

function showError(message) {
  showFlash(message, 'error');
}

function showOk(message) {
  showFlash(message, 'ok');
}

function showInfo(message) {
  showFlash(message, 'info');
}

function clearError() {
  const el = $('flash');
  el.classList.add('hidden');
  el.classList.remove('ok', 'info', 'error');
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
  return r.json();
}

async function apiTimed(path, opts = {}) {
  const started = performance.now();
  const data = await api(path, opts);
  return { data, ms: Math.round(performance.now() - started) };
}

async function loadSummaryData() {
  const out = await apiTimed('/api/autopilot/board-health');
  boardHealth = out.data || null;
  return { boardHealthMs: out.ms };
}

async function loadCoreData() {
  const tasksP = apiTimed('/api/tasks');
  const agentsP = apiTimed('/api/agents');
  const activityP = apiTimed('/api/activity');
  const configP = apiTimed('/api/config');

  const [t, a, ev, cfg] = await Promise.all([tasksP, agentsP, activityP, configP]);

  const optional = await Promise.allSettled([
    apiTimed('/api/metrics'),
    apiTimed('/api/escalations'),
    apiTimed('/api/orchestration/templates'),
    apiTimed('/api/kpi/dashboard', {
      method: 'POST',
      body: JSON.stringify({ current: {}, baseline: {} })
    })
  ]);

  cachedTasks = t.data.tasks ?? [];
  cachedAgents = a.data.agents ?? [];
  cachedEvents = ev.data.events ?? [];
  readOnly = Boolean(cfg.data.readOnly);

  metrics = optional[0].status === 'fulfilled'
    ? optional[0].value.data
    : { tasks: { done: 0 }, staleOpen: 0, escalationCount: 0, latestHeartbeats: [], assignments: {} };

  escalations = optional[1].status === 'fulfilled' ? (optional[1].value.data.items || []) : [];
  orchestraTemplates = optional[2].status === 'fulfilled' ? (optional[2].value.data.templates || []) : [];
  kpiDashboard = optional[3].status === 'fulfilled' ? (optional[3].value.data.dashboard || null) : null;

  return {
    tasksMs: t.ms,
    agentsMs: a.ms,
    activityMs: ev.ms,
    configMs: cfg.ms,
    coreMs: Math.max(t.ms, a.ms, ev.ms, cfg.ms)
  };
}

function filteredTasks() {
  const query = filters.search.trim().toLowerCase();
  return cachedTasks.filter((t) =>
    (filters.showArchived || t.status !== 'archived') &&
    (filters.owner === 'all' || t.owner === filters.owner) &&
    (filters.status === 'all' || t.status === filters.status) &&
    (filters.priority === 'all' || t.priority === filters.priority) &&
    (!query || t.title.toLowerCase().includes(query) || t.id.toLowerCase().includes(query))
  );
}

function renderAgents() {
  const list = $('agentList'); list.innerHTML = '';
  for (const a of cachedAgents) {
    const owned = cachedTasks.filter((t) => t.owner === a.id);
    const blocked = owned.some((t) => t.status === 'blocked');
    const working = owned.some((t) => ['assigned','in_progress','review'].includes(t.status));
    const status = blocked ? 'blocked' : working ? 'working' : 'idle';
    const div = document.createElement('div'); div.className = `agent ${agentTone[a.id] || ''}`;
    div.innerHTML = `<div>${ownerChip(a.id)} <span class="badge ${status}">${status}</span></div><div class="muted">${a.role}</div><div class="muted">tasks: ${owned.length}</div>`;
    list.appendChild(div);
  }
}

function renderBoard() {
  const tasks = filteredTasks();
  const kanban = $('kanban');
  kanban.innerHTML = '';
  const visibleStatuses = filters.showArchived ? statuses : statuses.filter((s) => s !== 'archived');

  const columns = new Map();
  for (const status of visibleStatuses) {
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.status = status;
    col.innerHTML = `<h3>${statusTitles[status]} (…)</h3><div class="muted">Loading…</div>`;
    col.addEventListener('dragover', (e) => e.preventDefault());
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (readOnly) return;
      if (!draggedTaskId) return;
      await api('/api/task/update', { method: 'POST', body: JSON.stringify({ id: draggedTaskId, status, actor: 'ui.dragdrop' }) });
      draggedTaskId = null;
      await refresh();
    });
    kanban.appendChild(col);
    columns.set(status, col);
  }

  // progressive render to avoid UI freeze on large boards
  visibleStatuses.forEach((status, idx) => {
    setTimeout(() => {
      const col = columns.get(status);
      if (!col) return;
      const scoped = tasks.filter((t) => t.status === status);
      col.innerHTML = `<h3>${statusTitles[status]} (${scoped.length})</h3>`;
      scoped.slice(0, 100).forEach((t) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.draggable = true;
        card.addEventListener('dragstart', () => { draggedTaskId = t.id; });
        card.innerHTML = `<div class="title">${t.title}</div><div class="meta">${t.id} • ${ownerChip(t.owner)} • ${t.priority}</div>`;
        card.onclick = () => openDrawer(t.id);
        col.appendChild(card);
      });
      if (scoped.length > 100) {
        const more = document.createElement('div');
        more.className = 'muted';
        more.textContent = `+${scoped.length - 100} more`; 
        col.appendChild(more);
      }
    }, idx * 0);
  });
}

function renderFeed() {
  const feed = $('feed'); feed.innerHTML = '';
  cachedEvents
    .filter((e) => feedType === 'all' || e.type === feedType)
    .slice(0, feedLimit)
    .forEach((e) => {
      const div = document.createElement('div'); div.className = 'feed-item';
      div.innerHTML = `<strong>${e.type}</strong> ${actorChip(e.actor)}<br/><span class="muted">${e.message}</span><br/><span class="muted">${e.at}</span>`;
      feed.appendChild(div);
    });
}

function renderMode() {
  const badge = $('readonlyBadge');
  if (readOnly) badge.classList.remove('hidden');
  else badge.classList.add('hidden');

  ['newTaskBtn','saveTask','assignTask','runOrchestra','deleteTask','saveNote','createTask','standupBtn','archiveDoneBtn','importBtn','wakeCodiBtn','wakeScoutBtn'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = readOnly;
  });
}

function renderOrchestraTemplates() {
  const sel = $('orchestraTemplate');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = orchestraTemplates.map((t) => `<option value="${t}">${t}</option>`).join('');
  if (current && orchestraTemplates.includes(current)) sel.value = current;
}

function renderEscalations() {
  const el = $('escalations');
  if (!escalations.length) {
    el.innerHTML = '<div class="muted">No escalations.</div>';
    return;
  }
  el.innerHTML = escalations.slice(0, 20)
    .map((e) => `<div class="feed-item"><strong>${e.reason}</strong><br/><span class="muted">${e.taskId} • ${ownerChip(e.owner || 'unowned')}</span><br/>${e.title}</div>`)
    .join('');
}

function renderKpiDashboard() {
  const el = $('kpiDashboard');
  if (!el) return;
  const generated = $('kpiGeneratedAt');
  if (!kpiDashboard?.metrics) {
    el.innerHTML = '<div class="muted">KPI dashboard unavailable.</div>';
    if (generated) generated.textContent = 'Not available';
    return;
  }

  const order = kpiDashboard.order || Object.keys(kpiDashboard.metrics);
  el.innerHTML = order
    .map((key) => {
      const metric = kpiDashboard.metrics[key];
      if (!metric) return '';
      const delta = Number(metric.delta || 0);
      const deltaClass = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const sign = delta > 0 ? '+' : '';
      return `<div class="kpi-card"><div class="kpi-name">${metric.label}</div><div class="kpi-value">${metric.value}${metric.unit || ''}</div><div class="kpi-delta ${deltaClass}">${sign}${delta.toFixed(1)}pp vs baseline</div></div>`;
    })
    .join('');

  if (generated) generated.textContent = kpiDashboard.generatedAt || 'n/a';
}

function renderMetrics() {
  const tasks = filteredTasks();
  const byStatus = boardHealth?.by_status || {};
  const flow = boardHealth?.flow_ratio || null;

  $('metric-agents').textContent = String(cachedAgents.length);
  $('metric-tasks').textContent = String(tasks.length);
  $('metric-inprogress').textContent = String(byStatus.in_progress ?? tasks.filter((t) => t.status === 'in_progress').length);
  $('metric-done').textContent = String(byStatus.done ?? metrics?.tasks?.done ?? 0);
  $('metric-stale').textContent = String(metrics?.staleOpen ?? 0);
  $('metric-escalations').textContent = String(metrics?.escalationCount ?? 0);

  const flowValueEl = $('metric-flowratio');
  const flowTile = $('metric-flowratio-tile');
  if (flowValueEl && flowTile && flow) {
    flowValueEl.textContent = String(flow.value ?? 'n/a');
    flowTile.classList.remove('flow-green', 'flow-yellow', 'flow-red');
    flowTile.classList.add(flow.color === 'green' ? 'flow-green' : flow.color === 'yellow' ? 'flow-yellow' : 'flow-red');
    flowTile.title = `completed_24h=${flow.tasks_completed_24h ?? 0}, average_wip=${flow.average_wip ?? 0}`;
  }

  const hb = metrics?.latestHeartbeats?.[0];
  $('heartbeatStatus').textContent = hb
    ? `heartbeat: ${hb.agentId} ${hb.status} @ ${hb.at}`
    : 'heartbeat: no runs yet';

  const a = metrics?.assignments || {};
  const total = Number(a.totalAssignments || 0);
  const completed = Number(a.completedAssignments || 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  $('assignmentHealth').textContent = `assignment health: ${completed}/${total} completed (${pct}%) • in-flight ${a.inFlightAssignments || 0}`;
}

function openDrawer(id) {
  selectedId = id;
  const t = cachedTasks.find((x) => x.id === id);
  if (!t) return;
  $('drawer').classList.remove('hidden');
  $('d-title').textContent = t.title;
  $('d-id').textContent = `${t.id} • updated ${t.updatedAt || ''}`;
  $('d-description').value = t.description || '';
  $('d-status').value = t.status;
  $('d-owner').value = t.owner;
  $('d-priority').value = t.priority || 'p2';
  const notes = t.notes || [];
  $('d-notes').innerHTML = notes.length ? notes.map((n) => `<div class="note"><div class="muted">${n.at}</div>${n.note}</div>`).join('') : '<div class="muted">No notes yet.</div>';

  const events = cachedEvents.filter((e) => e.taskId === t.id).slice(0, 15);
  $('d-activity').innerHTML = events.length
    ? events.map((e) => `<div class="note"><div class="muted">${e.at} • ${e.type} • ${e.actor || 'system'}</div>${e.message}</div>`).join('')
    : '<div class="muted">No activity yet.</div>';
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const refreshBtn = $('refreshBtn');
  const started = performance.now();
  const prevLabel = refreshBtn?.textContent;
  if (refreshBtn) { refreshBtn.textContent = 'Refreshing…'; refreshBtn.disabled = true; }

  try {
    // Stage A: fast summary/header first
    const summaryTiming = await loadSummaryData();
    renderMetrics();
    clearError();

    // Stage B: board + panels
    const coreTiming = await loadCoreData();
    renderAgents();
    renderBoard();
    renderFeed();
    renderMetrics();
    renderEscalations();
    renderKpiDashboard();
    renderOrchestraTemplates();
    renderMode();

    if (selectedId) {
      const exists = cachedTasks.some((t) => t.id === selectedId);
      if (exists) openDrawer(selectedId);
      else {
        selectedId = null;
        $('drawer').classList.add('hidden');
      }
    }

    const totalMs = Math.round(performance.now() - started);
    const cardsReturned = Array.isArray(cachedTasks) ? cachedTasks.length : 0;
    const timing = `refresh: total=${totalMs}ms board_health=${summaryTiming.boardHealthMs}ms tasks=${coreTiming.tasksMs}ms activity=${coreTiming.activityMs}ms mode=board cards=${cardsReturned}`;
    console.info(timing);
    window.__mclTiming = {
      total_refresh_ms: totalMs,
      board_health_ms: summaryTiming.boardHealthMs,
      tasks_ms: coreTiming.tasksMs,
      activity_ms: coreTiming.activityMs,
      render_mode: 'header_then_board',
      board_mode: 'board',
      cards_returned: cardsReturned,
      at: new Date().toISOString()
    };
    const timingEl = $('refreshTiming');
    if (timingEl) timingEl.textContent = timing;
  } catch (e) {
    showError(`Refresh failed: ${e.message}`);
  } finally {
    refreshInFlight = false;
    if (refreshBtn) { refreshBtn.textContent = prevLabel || 'Refresh'; refreshBtn.disabled = false; }
  }
}

$('filterOwner').onchange = (e) => { filters.owner = e.target.value; renderBoard(); renderMetrics(); };
$('filterStatus').onchange = (e) => { filters.status = e.target.value; renderBoard(); renderMetrics(); };
$('filterPriority').onchange = (e) => { filters.priority = e.target.value; renderBoard(); renderMetrics(); };
$('filterSearch').oninput = (e) => { filters.search = e.target.value; renderBoard(); renderMetrics(); };
$('showArchived').onchange = (e) => { filters.showArchived = Boolean(e.target.checked); renderBoard(); renderMetrics(); };
$('feedType').onchange = (e) => { feedType = e.target.value; renderFeed(); };
$('feedLimit').onchange = (e) => { feedLimit = Number(e.target.value || 25); renderFeed(); };

$('newTaskBtn').onclick = () => { if (!readOnly) $('createModal').classList.remove('hidden'); };
$('closeCreate').onclick = () => $('createModal').classList.add('hidden');
$('createTask').onclick = async () => {
  try {
    const title = $('c-title').value.trim();
    if (!title) return alert('Title required');
    await api('/api/task/create', { method: 'POST', body: JSON.stringify({
      title,
      description: $('c-description').value,
      owner: $('c-owner').value,
      status: $('c-status').value,
      priority: $('c-priority').value,
      actor: 'ui.create'
    })});
    $('c-title').value = '';
    $('c-description').value = '';
    $('createModal').classList.add('hidden');
    await refresh();
  } catch (e) {
    showError(`Create failed: ${e.message}`);
  }
};

$('refreshBtn').onclick = refresh;
$('archiveDoneBtn').onclick = async () => {
  try {
    const ok = confirm('Archive all completed tasks?');
    if (!ok) return;
    showInfo('Archiving completed tasks...');
    const out = await api('/api/tasks/archive-done', { method: 'POST' });
    await refresh();
    showOk(`Archived ${out.archived ?? 0} completed task(s).`);
  } catch (e) {
    showError(`Archive failed: ${e.message}`);
  }
};
$('closeDrawer').onclick = () => {
  $('drawer').classList.add('hidden');
  selectedId = null;
};

$('saveTask').onclick = async () => {
  try {
    if (!selectedId) return;
    await api('/api/task/update', {
      method: 'POST',
      body: JSON.stringify({
        id: selectedId,
        status: $('d-status').value,
        owner: $('d-owner').value,
        description: $('d-description').value,
        priority: $('d-priority').value,
        actor: 'ui.drawer'
      })
    });
    await refresh();
  } catch (e) {
    showError(`Save failed: ${e.message}`);
  }
};

$('assignTask').onclick = async () => {
  try {
    if (!selectedId) return;
    const agentId = $('assignAgent').value;
    await api('/api/task/assign', {
      method: 'POST',
      body: JSON.stringify({ taskId: selectedId, agentIds: [agentId], actor: 'ui.assign' })
    });
    await refresh();
  } catch (e) {
    showError(`Assign failed: ${e.message}`);
  }
};

$('runOrchestra').onclick = async () => {
  try {
    if (!selectedId) return;
    const template = $('orchestraTemplate').value;
    if (!template) return showError('No orchestra template selected');
    await api('/api/orchestrate', {
      method: 'POST',
      body: JSON.stringify({ taskId: selectedId, template, actor: 'ui.orchestra' })
    });
    await refresh();
  } catch (e) {
    showError(`Orchestra failed: ${e.message}`);
  }
};

$('deleteTask').onclick = async () => {
  try {
    if (!selectedId) return;
    const ok = confirm(`Delete task ${selectedId}? This cannot be undone.`);
    if (!ok) return;
    await api('/api/task/delete', {
      method: 'POST',
      body: JSON.stringify({ id: selectedId, actor: 'ui.delete' })
    });
    $('drawer').classList.add('hidden');
    selectedId = null;
    await refresh();
  } catch (e) {
    showError(`Delete failed: ${e.message}`);
  }
};

$('saveNote').onclick = async () => {
  try {
    if (!selectedId) return;
    const note = $('d-note').value.trim();
    if (!note) return;
    await api('/api/task/note', { method: 'POST', body: JSON.stringify({ id: selectedId, note, actor: 'ui.note' }) });
    $('d-note').value = '';
    await refresh();
  } catch (e) {
    showError(`Note failed: ${e.message}`);
  }
};

$('standupBtn').onclick = async () => {
  try {
    const out = await api('/api/standup', { method: 'POST' });
    $('standupOut').textContent = out.standup;
  } catch (e) {
    showError(`Standup failed: ${e.message}`);
  }
};

$('exportBtn').onclick = async () => {
  try {
    const snapshot = await api('/api/export');
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mission-control-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    showError(`Export failed: ${e.message}`);
  }
};

$('importBtn').onclick = () => $('importFile').click();
$('wakeCodiBtn').onclick = async () => {
  try {
    showInfo('Waking Codi...');
    const out = await api('/api/agent/codi/wake', { method: 'POST' });
    await refresh();
    showOk(out.task ? `Codi claimed ${out.task.id}.` : 'Codi wake complete: no actionable tasks.');
  } catch (e) {
    showError(`Wake Codi failed: ${e.message}`);
  }
};
$('wakeScoutBtn').onclick = async () => {
  try {
    showInfo('Waking Scout...');
    const out = await api('/api/agent/scout/wake', { method: 'POST' });
    await refresh();
    showOk(out.task ? `Scout claimed ${out.task.id}.` : 'Scout wake complete: no actionable tasks.');
  } catch (e) {
    showError(`Wake Scout failed: ${e.message}`);
  }
};
$('importFile').onchange = async (e) => {
  try {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const json = JSON.parse(text);
    const ok = confirm('Import snapshot and overwrite current local tasks/activity?');
    if (!ok) return;
    await api('/api/import', {
      method: 'POST',
      body: JSON.stringify({
        overwrite: true,
        tasks: json.tasks || [],
        activity: json.activity || [],
        actor: 'ui.import'
      })
    });
    await refresh();
  } catch (err) {
    showError(`Import failed: ${err.message}`);
  } finally {
    $('importFile').value = '';
  }
};

document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    $('drawer').classList.add('hidden');
    $('createModal').classList.add('hidden');
    selectedId = null;
    return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

  if (e.key.toLowerCase() === 'n') $('createModal').classList.remove('hidden');
  if (e.key.toLowerCase() === 'r') await refresh();
  if (e.key.toLowerCase() === 'g') $('standupBtn').click();
});

refresh();
setInterval(refresh, 15000);
