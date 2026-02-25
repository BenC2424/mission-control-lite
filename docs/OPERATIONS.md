# Operations Runbook (Phase 1)

## 1) Service setup (systemd)

```bash
cd /home/ubuntu/.openclaw/workspace/mission-control-lite
sudo cp deploy/systemd/mission-control-lite.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mission-control-lite
sudo systemctl start mission-control-lite
sudo systemctl status mission-control-lite --no-pager
```

## 2) Basic health checks

```bash
cd /home/ubuntu/.openclaw/workspace/mission-control-lite
node scripts/healthcheck.mjs
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/metrics
```

## 3) Heartbeat loop validation (live)

This script performs an end-to-end test:
- create task
- assign to codi
- trigger wake
- verify inbox
- post progress note and set in_progress
- read metrics

```bash
cd /home/ubuntu/.openclaw/workspace/mission-control-lite
node scripts/validate-heartbeat-loop.mjs
```

## 4) Watchdog alerts (Phase 1 Step 3)

Run manually:

```bash
cd /home/ubuntu/.openclaw/workspace/mission-control-lite
npm run watchdog
```

Alert policy file:
- `config/alert-policy.json`

Suggested OpenClaw cron (every 5 min, alert-only):

```bash
openclaw cron add \
  --name "mcl-watchdog" \
  --agent main \
  --cron "*/5 * * * *" \
  --tz UTC \
  --session isolated \
  --message "Run: cd /home/ubuntu/.openclaw/workspace/mission-control-lite && npm run -s watchdog. If output starts with ALERT:, send it to Ben. Otherwise reply HEARTBEAT_OK." \
  --announce
```

## 5) Logs

```bash
sudo journalctl -u mission-control-lite -f
```

## 6) Restart / stop

```bash
sudo systemctl restart mission-control-lite
sudo systemctl stop mission-control-lite
```

## 7) Safety mode

For demo/read-only mode, edit service file and set:

```ini
Environment=READ_ONLY=1
```

Then reload + restart.
