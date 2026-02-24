const statuses = ['inbox','assigned','in_progress','review','blocked','done'];
const statusTitles = { inbox:'Inbox', assigned:'Assigned', in_progress:'In Progress', review:'Review', blocked:'Blocked', done:'Done' };
const $ = (id) => document.getElementById(id);

let cachedTasks = [];
let cachedAgents = [];
let cachedEvents = [];
let selectedId = null;
let draggedTaskId = null;

const filters = { owner: 'all', status: 'all', priority: 'all', search: '' };

function showError(message) {
  const el = $('flash');
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearError() {
  $('flash').classList.add('hidden');
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
  return r.json();
}

async function loadData() {
  const [t, a, ev] = await Promise.all([api('/api/tasks'), api('/api/agents'), api('/api/activity')]);
  cachedTasks = t.tasks ?? [];
  cachedAgents = a.agents ?? [];
  cachedEvents = ev.events ?? [];
}

function filteredTasks() {
  const query = filters.search.trim().toLowerCase();
  return cachedTasks.filter((t) =>
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
    const div = document.createElement('div'); div.className = 'agent';
    div.innerHTML = `<div><strong>${a.id}</strong> <span class="badge ${status}">${status}</span></div><div class="muted">${a.role}</div><div class="muted">tasks: ${owned.length}</div>`;
    list.appendChild(div);
  }
}

function renderBoard() {
  const tasks = filteredTasks();
  const kanban = $('kanban'); kanban.innerHTML = '';
  for (const status of statuses) {
    const col = document.createElement('div'); col.className = 'col';
    col.dataset.status = status;
    col.addEventListener('dragover', (e) => e.preventDefault());
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!draggedTaskId) return;
      await api('/api/task/update', { method: 'POST', body: JSON.stringify({ id: draggedTaskId, status, actor: 'ui.dragdrop' }) });
      draggedTaskId = null;
      await refresh();
    });

    const scoped = tasks.filter((t) => t.status === status);
    col.innerHTML = `<h3>${statusTitles[status]} (${scoped.length})</h3>`;
    scoped.forEach((t) => {
      const card = document.createElement('div'); card.className = 'card';
      card.draggable = true;
      card.addEventListener('dragstart', () => { draggedTaskId = t.id; });
      card.innerHTML = `<div class="title">${t.title}</div><div class="meta">${t.id} • ${t.owner} • ${t.priority}</div>`;
      card.onclick = () => openDrawer(t.id);
      col.appendChild(card);
    });
    kanban.appendChild(col);
  }
}

function renderFeed() {
  const feed = $('feed'); feed.innerHTML = '';
  cachedEvents.slice(0, 30).forEach((e) => {
    const div = document.createElement('div'); div.className = 'feed-item';
    div.innerHTML = `<strong>${e.type}</strong><br/><span class="muted">${e.message}</span><br/><span class="muted">${e.at}</span>`;
    feed.appendChild(div);
  });
}

function renderMetrics() {
  const tasks = filteredTasks();
  $('metric-tasks').textContent = String(tasks.length);
  $('metric-inprogress').textContent = String(tasks.filter((t) => t.status === 'in_progress').length);
}

function openDrawer(id) {
  selectedId = id;
  const t = cachedTasks.find((x) => x.id === id);
  if (!t) return;
  $('drawer').classList.remove('hidden');
  $('d-title').textContent = t.title;
  $('d-id').textContent = `${t.id} • updated ${t.updatedAt || ''}`;
  $('d-status').value = t.status;
  $('d-owner').value = t.owner;
  $('d-priority').value = t.priority || 'p2';
  const notes = t.notes || [];
  $('d-notes').innerHTML = notes.length ? notes.map((n) => `<div class="note"><div class="muted">${n.at}</div>${n.note}</div>`).join('') : '<div class="muted">No notes yet.</div>';

  const events = cachedEvents.filter((e) => e.taskId === t.id).slice(0, 15);
  $('d-activity').innerHTML = events.length
    ? events.map((e) => `<div class="note"><div class="muted">${e.at} • ${e.type}</div>${e.message}</div>`).join('')
    : '<div class="muted">No activity yet.</div>';
}

async function refresh() {
  try {
    await loadData();
    clearError();
    renderAgents(); renderBoard(); renderFeed(); renderMetrics();
    if (selectedId) openDrawer(selectedId);
  } catch (e) {
    showError(`Refresh failed: ${e.message}`);
  }
}

$('filterOwner').onchange = (e) => { filters.owner = e.target.value; renderBoard(); renderMetrics(); };
$('filterStatus').onchange = (e) => { filters.status = e.target.value; renderBoard(); renderMetrics(); };
$('filterPriority').onchange = (e) => { filters.priority = e.target.value; renderBoard(); renderMetrics(); };
$('filterSearch').oninput = (e) => { filters.search = e.target.value; renderBoard(); renderMetrics(); };

$('newTaskBtn').onclick = () => $('createModal').classList.remove('hidden');
$('closeCreate').onclick = () => $('createModal').classList.add('hidden');
$('createTask').onclick = async () => {
  try {
    const title = $('c-title').value.trim();
    if (!title) return alert('Title required');
    await api('/api/task/create', { method: 'POST', body: JSON.stringify({
      title,
      owner: $('c-owner').value,
      status: $('c-status').value,
      priority: $('c-priority').value,
      actor: 'ui.create'
    })});
    $('c-title').value = '';
    $('createModal').classList.add('hidden');
    await refresh();
  } catch (e) {
    showError(`Create failed: ${e.message}`);
  }
};

$('refreshBtn').onclick = refresh;
$('closeDrawer').onclick = () => $('drawer').classList.add('hidden');

$('saveTask').onclick = async () => {
  try {
    if (!selectedId) return;
    await api('/api/task/update', {
      method: 'POST',
      body: JSON.stringify({
        id: selectedId,
        status: $('d-status').value,
        owner: $('d-owner').value,
        priority: $('d-priority').value,
        actor: 'ui.drawer'
      })
    });
    await refresh();
  } catch (e) {
    showError(`Save failed: ${e.message}`);
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
    return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

  if (e.key.toLowerCase() === 'n') $('createModal').classList.remove('hidden');
  if (e.key.toLowerCase() === 'r') await refresh();
  if (e.key.toLowerCase() === 'g') $('standupBtn').click();
});

refresh();
setInterval(refresh, 15000);
