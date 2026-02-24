#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const dbPath = new URL('../runtime/tasks.json', import.meta.url);
const standupPath = new URL('../runtime/standup-latest.md', import.meta.url);

const now = () => new Date().toISOString();

function load() {
  return JSON.parse(readFileSync(dbPath, 'utf8'));
}

function save(data) {
  writeFileSync(dbPath, JSON.stringify(data, null, 2) + '\n');
}

function findTask(db, id) {
  const task = db.tasks.find(t => t.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}

const [, , cmd, ...args] = process.argv;
const db = load();

if (cmd === 'add') {
  const [title, owner = 'codi', priority = 'p2'] = args;
  if (!title) throw new Error('Usage: add "<title>" <owner> [priority]');
  const task = {
    id: `mcl-${randomUUID().slice(0, 8)}`,
    title,
    status: 'assigned',
    priority,
    owner,
    notes: [],
    evidence: { tests: [], artifacts: [], sources: [] },
    createdAt: now(),
    updatedAt: now()
  };
  db.tasks.push(task);
  save(db);
  console.log(task.id);
} else if (cmd === 'status') {
  const [id, status] = args;
  const task = findTask(db, id);
  task.status = status;
  task.updatedAt = now();
  save(db);
  console.log(`updated ${id} -> ${status}`);
} else if (cmd === 'note') {
  const [id, note] = args;
  const task = findTask(db, id);
  task.notes.push({ at: now(), note });
  task.updatedAt = now();
  save(db);
  console.log(`noted ${id}`);
} else if (cmd === 'standup') {
  const by = (s) => db.tasks.filter(t => t.status === s);
  const lines = [
    `# DAILY STANDUP — ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## ✅ Completed',
    ...by('done').map(t => `- ${t.owner}: ${t.title} (${t.id})`),
    '',
    '## 🔄 In Progress',
    ...by('in_progress').map(t => `- ${t.owner}: ${t.title} (${t.id})`),
    '',
    '## 🚫 Blocked',
    ...by('blocked').map(t => `- ${t.owner}: ${t.title} (${t.id})`),
    '',
    '## 👀 Review',
    ...by('review').map(t => `- ${t.owner}: ${t.title} (${t.id})`),
    ''
  ];
  writeFileSync(standupPath, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
} else {
  console.log('Commands: add | status | note | standup');
}
