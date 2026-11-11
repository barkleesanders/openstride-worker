// Observability lint rule (native observability rollout, 2026-11-04).
//
// This Worker must never ship without the platform observability that
// feeds Workers Logs, Workers Traces, and Cloudflare Issues — and the
// wide-event middleware must stay wired into the app entry. Run via
// `npm run lint:observability`; it is part of the `check` script so a
// regression fails the normal gate. NOTE: this site deliberately samples
// at 0.1 — the rule asserts the blocks stay enabled, not any rate.
import { readFileSync } from 'node:fs';

const failures = [];

// wrangler.jsonc is JSONC: strip comments + trailing commas, then parse.
const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:"'])\/\/.*$/gm, '$1')
  .replace(/,(\s*[}\]])/g, '$1');
let config;
try {
  config = JSON.parse(stripped);
} catch (err) {
  console.error(`wrangler.jsonc: could not parse after comment-stripping: ${err.message}`);
  process.exit(1);
}
const obs = config.observability ?? {};
if (obs.enabled !== true) {
  failures.push('wrangler.jsonc: observability must exist with enabled = true');
}
if (obs.logs?.enabled !== true) {
  failures.push('wrangler.jsonc: observability.logs must exist with enabled = true');
}
if (obs.traces?.enabled !== true) {
  failures.push('wrangler.jsonc: observability.traces must exist with enabled = true');
}

const entry = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
if (!entry.includes("from './wide-event'") || !entry.includes('wideEvent')) {
  failures.push('src/index.tsx: wideEvent middleware is not wired into the app');
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('observability check passed: logs + traces enabled, wideEvent wired');
