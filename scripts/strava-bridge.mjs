import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configPath = process.argv[2] || path.join(os.homedir(), '.config/openstride/bridge.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const origin = new URL(config.url);
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password)
  throw new Error('Configure an HTTPS origin.');
if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('Missing token.');
const cli = config.cli || path.join(os.homedir(), '.local/bin/strava-pp-cli');
const statePath = `${configPath}.state`;
const after = fs.existsSync(statePath) ? Math.floor(Date.now() / 1000) - 90 * 86400 : 0;
const runs = new Map();
let fetched = 0;
let complete = false;
for (let page = 1; page <= 20; page++) {
  const raw = execFileSync(
    cli,
    [
      'athlete',
      'get-logged-in-activities',
      '--per-page',
      '200',
      '--page',
      String(page),
      '--after',
      String(after),
      '--before',
      String(Math.floor(Date.now() / 1000)),
      '--data-source',
      'live',
      '--no-cache',
      '--json',
      '--select',
      'id,name,type,sport_type,distance,moving_time,start_date_local',
    ],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
  );
  const data = JSON.parse(raw);
  if (data.meta?.source !== 'live' || !Array.isArray(data.results))
    throw new Error('Expected live activity results.');
  fetched += data.results.length;
  for (const item of data.results) {
    if (!['Run', 'TrailRun', 'VirtualRun'].includes(item.sport_type || item.type)) continue;
    if (
      !Number.isSafeInteger(item.id) ||
      typeof item.start_date_local !== 'string' ||
      !Number.isFinite(item.distance) ||
      !Number.isFinite(item.moving_time) ||
      item.moving_time <= 0
    )
      throw new Error('Invalid Strava run.');
    runs.set(item.id, {
      id: `strava:${item.id}`,
      source: 'strava',
      date: item.start_date_local.slice(0, 10),
      name: String(item.name || 'Run').slice(0, 120),
      distanceKm: item.distance / 1000,
      durationMinutes: item.moving_time / 60,
    });
  }
  if (data.results.length < 200) {
    complete = true;
    break;
  }
}
if (!complete)
  throw new Error('Import exceeds 4000 source activities; narrow the window before retrying.');
const activities = [...runs.values()];
for (let offset = 0; offset < Math.max(activities.length, 1); offset += 50) {
  const response = await fetch(new URL('/api/activities/import', origin), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activities: activities.slice(offset, offset + 50) }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`OpenStride import failed (${response.status}).`);
  const result = await response.json();
  if (result.imported !== activities.slice(offset, offset + 50).length)
    throw new Error('Import count mismatch.');
}
fs.writeFileSync(statePath, new Date().toISOString(), { mode: 0o600 });
console.log(
  JSON.stringify({
    syncedAt: new Date().toISOString(),
    source: 'live',
    fetched,
    imported: activities.length,
    window: after ? '90 days' : 'history',
  }),
);
