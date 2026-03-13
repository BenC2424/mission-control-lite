#!/usr/bin/env node

const base = process.env.MCL_BASE_URL || 'http://127.0.0.1:8787';
const url = `${base}/api/watchdog/run`;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ actor: 'watchdog.cron' })
});

if (!res.ok) {
  const text = await res.text();
  console.error(`WATCHDOG_RUN_FAILED ${res.status} ${text}`);
  process.exit(2);
}

const out = await res.json();
console.log(JSON.stringify({
  ok: true,
  checked: out.checked,
  nudged: out.nudged,
  recovered: out.recovered,
  skipped: out.skipped,
  thresholds: out.thresholds
}));
