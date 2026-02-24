const statuses = ['inbox','assigned','in_progress','review','blocked','done'];
const statusTitles = { inbox:'Inbox', assigned:'Assigned', in_progress:'In Progress', review:'Review', blocked:'Blocked', done:'Done' };
const $ = (id) => document.getElementById(id);

let cachedTasks = [];
let cachedAgents = [];
let cachedEvents = [];
let selectedId = null;

const filters = { owner: 'all', status: 'all', priority: 'all' };

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
  return cachedTasks.filter((t) =>
    (filters.owner === 'all' || t.owner === filters.owner) &&
    (filters.status === 'all' || t.status === filters.status) &&
    (filters.priority === 'all' || t.priority === filters.priority)
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
    const scoped = tasks.filter((t) => t.status === status);
    col.innerHTML = `<h3>${statusTitles[status]} (${scoped.length})</h3>`;
    scoped.forEach((t) => {
      const card = document.createElement('div'); card.className = 'card';
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
  const notes = t.notes || [];
  $('d-notes').innerHTML = notes.length ? notes.map((n) => `<div class="note"><div class="muted">${n.at}</div>${n.note}</div>`).join('') : '<div class="muted">No notes yet.</div>';
}

async function refresh() {
  await loadData();
  renderAgents(); renderBoard(); renderFeed(); renderMetrics();
  if (selectedId) openDrawer(selectedId);
}

$('filterOwner').onchange = (e) => { filters.owner = e.target.value; renderBoard(); renderMetrics(); };
$('filterStatus').onchange = (e) => { filters.status = e.target.value; renderBoard(); renderMetrics(); };
$('filterPriority').onchange = (e) => { filters.priority = e.target.value; renderBoard(); renderMetrics(); };

$('newTaskBtn').onclick = () => $('createModal').classList.remove('hidden');
$('closeCreate').onclick = () => $('createModal').classList.add('hidden');
$('createTask').onclick = async () => {
  const title = $('c-title').value.trim();
  if (!title) return alert('Title required');
  await api('/api/task/create', { method: 'POST', body: JSON.stringify({
    title,
    owner: $('c-owner').value,
    status: $('c-status').value,
    priority: $('c-priority').value
  })});
  $('c-title').value = '';
  $('createModal').classList.add('hidden');
  await refresh();
};

$('refreshBtn').onclick = refresh;
$('closeDrawer').onclick = () => $('drawer').classList.add('hidden');

$('saveTask').onclick = async () => {
  if (!selectedId) return;
  await api('/api/task/update', {
    method: 'POST',
    body: JSON.stringify({ id: selectedId, status: $('d-status').value, owner: $('d-owner').value })
  });
  await refresh();
};

$('saveNote').onclick = async () => {
  if (!selectedId) return;
  const note = $('d-note').value.trim();
  if (!note) return;
  await api('/api/task/note', { method: 'POST', body: JSON.stringify({ id: selectedId, note }) });
  $('d-note').value = '';
  await refresh();
};

$('standupBtn').onclick = async () => {
  const out = await api('/api/standup', { method: 'POST' });
  $('standupOut').textContent = out.standup;
};

refresh();
setInterval(refresh, 15000);
