#!/usr/bin/env node
const base = process.env.MCL_BASE_URL || 'http://127.0.0.1:8787';

const endpoints = ['/api/health', '/api/config', '/api/metrics', '/api/tasks'];

let failed = false;
for (const ep of endpoints) {
  try {
    const res = await fetch(`${base}${ep}`);
    if (!res.ok) {
      failed = true;
      console.error(`[FAIL] ${ep} -> ${res.status}`);
      continue;
    }
    console.log(`[OK] ${ep} -> ${res.status}`);
  } catch (e) {
    failed = true;
    console.error(`[FAIL] ${ep} -> ${String(e.message || e)}`);
  }
}

if (failed) process.exit(1);
console.log('healthcheck: PASS');
