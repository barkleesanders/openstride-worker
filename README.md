# OpenStride

A personal running planner you can host on Cloudflare Workers and D1. Original,
transparent training rules; no subscription, paid AI, or Runna account required.
MIT licensed. Not affiliated with Runna or Strava.

## Features

- Build 4–24 week plans for a running habit, 5K, 10K, half marathon, or marathon preparation.
- Choose running days, a long-run day, your recent mileage, and training approach.
- Track completion, actual distance/time, effort, and notes. Move sessions to another date.
- Explicitly reduce future training by 20%; completed sessions stay intact.
- Download iCalendar and CSV files, and access your plans through a JSON API or MCP.
- Optionally import recent runs from your own Strava account.
- Server-rendered, responsive interface with no client JavaScript or external assets.

This is a **single-person installation**. Everyone with the installation password
can access and change all its data. There are no separate user accounts.

## Run locally

Install Node.js 22 or newer and npm. From this directory:

```sh
npm ci
node scripts/local-secret.mjs
npm run db:local
npm run dev
```

Open the local URL printed by Wrangler. Your running space uses HTTP Basic auth:
username `runner`, password the `APP_TOKEN` value in `.dev.vars`.
The home page is public. Keep `.dev.vars` private; it is ignored by Git.

```sh
npm run check
npm run build
```

`build` bundles the Worker in dry-run mode; it does not deploy.
Tests cover the engine, exports, and integration behavior. Strava API tests use
fixtures; connecting a real account is an optional separate verification.

## Deploy on the free tier

Use a Cloudflare account on **Workers Free**. The app needs one Worker and one D1
database. It does not require a domain purchase, R2, Workers AI, a paid cron service,
or a paid Workers subscription.

```sh
npx wrangler login
npx wrangler d1 create openstride --config wrangler.jsonc
```

Replace the placeholder `database_id` in `wrangler.jsonc` with the ID printed by
that command. If you change the database name, update `database_name` too. Choose
an available Worker `name` if `openstride` is already used in your account.

Generate a different production password and store it in your password manager:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put APP_TOKEN --config wrangler.jsonc
npm run db:remote
npm run check
npm run build
npm run deploy
```

Paste the generated password at the secret prompt. Never put it in `wrangler.jsonc`
or source code. Open the HTTPS `workers.dev` URL printed after deployment.
Use `runner` and that production password. A token shorter than 32 characters
fails closed. Basic authentication must only be used over HTTPS outside localhost.

Cloudflare's documented free limits, checked September 10, 2026:

| Resource | Free allowance |
| --- | --- |
| Worker requests | 100,000/day across the account |
| Worker CPU | 10 ms per invocation |
| D1 rows read | 5 million/day |
| D1 rows written | 100,000/day |
| D1 storage | 5 GB total across the account |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
These are account limits, shared with your other apps. This is intended for
personal use, not unlimited public traffic. On Free, exhausted limits can make
requests fail. On a paid account, paid pricing applies. Check your account plan
and usage before deploying. A local test does not prove production CPU usage;
inspect Cloudflare's CPU metrics after deployment.

## Training rules

Read `src/engine.ts` for the full algorithm. It is original code, not a Runna
algorithm reproduction or a clinically validated coaching system.

The engine starts from recent weekly and longest-run distances. A zero baseline
starts with a small run-walk schedule. Gentle, balanced, and challenging approaches
use 4%, 6%, and 8% peak-volume increments, respectively; every fourth non-taper
week reduces volume. Race-oriented plans finish with a taper. Long runs and total
volume have caps. Low longest-run baselines can reduce the weekly total further.
Distances are allocated in tenths of a kilometer. A recent 5K result optionally
provides rough pace ranges. Quality sessions begin after the first two weeks,
with at most one per week; recovery and taper weeks use easy work.

These are software heuristics, **not evidence that any progression is safe for you**.
Race goals mean preparation: the app does not automatically insert a race-distance
workout, assess injury, establish race readiness, or replace a coach. Review each
plan, adjust for your circumstances, and stop a session that is unsuitable.

Weeks are seven-day windows starting on your chosen date. Dates are calendar
strings; exports use all-day events. "Today" in the interface uses UTC.
Moving a workout preserves its original training-week grouping.

Easing is explicit, never inferred from a missed run or imported activity. Repeating
an ease request with the same start date is idempotent. A different start date can
reduce overlapping future sessions again. Imported activities do not automatically
complete workouts.

## Optional Strava import

Create your own API application at [Strava API settings](https://www.strava.com/settings/api).
Configure its authorization callback domain to match your deployment hostname.
Set these additional secrets:

```sh
npx wrangler secret put STRAVA_CLIENT_ID --config wrangler.jsonc
npx wrangler secret put STRAVA_CLIENT_SECRET --config wrangler.jsonc
npx wrangler secret put STRAVA_REDIRECT_URI --config wrangler.jsonc
```

Use `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/app/strava/callback` for the
redirect URI. For local development, add the same variables to `.dev.vars` and
use a localhost callback accepted by your Strava app settings.

Open **My running → Connect Strava**, grant activity-read access, and then sync.
The adapter fetches one page of at most 100 recent activities and retains Run,
TrailRun, and VirtualRun metadata. It stores name, date, distance, and moving time;
it does not store GPS routes, heart rate, or activity photos. This is a bounded
recent import, not a complete historical backup. Strava rate limits and developer
application restrictions still apply. See [Strava authentication](https://developers.strava.com/docs/authentication/).

Tokens are encrypted with AES-GCM using a key derived from `APP_TOKEN`. Changing
that password makes existing tokens unreadable: reconnect Strava afterward.
Disconnect removes the local connection; revoke application access in Strava to
revoke its authorization there. Previously imported activity records remain.

Apple Health and Android Health Connect are not directly supported by this Worker;
they require a native companion with device permissions. Watch guidance, live GPS
recording, and push notifications are also outside this web app.

## Data and maintenance

Plans and activities live in your D1 database. Only optional Strava operations make
third-party API calls. The app has no advertising or analytics scripts; Cloudflare
still processes requests and may retain operational logs according to your settings.
Do not share your installation token with an untrusted MCP client.

The dashboard displays the 10 most recent plans and 100 most recent activities.
Keep plan IDs from the API or your links to access older plans directly. Plan changes
use optimistic concurrency checks so simultaneous edits cannot silently overwrite
each other. Conflicting updates require reloading and retrying.

Back up the complete database before changing migrations:

```sh
npx wrangler d1 export DB --remote --output openstride-backup.sql --config wrangler.jsonc
```

Treat that backup as private: it includes your training data and encrypted connection
records. Keep the corresponding installation token separately if restoring a Strava
connection. Do not commit backups. Update dependencies deliberately, run the checks,
then deploy. Deleting a Worker does not automatically delete its D1 database.

## JSON API

Send `Authorization: Bearer YOUR_APP_TOKEN`. Browser exports also accept the same
Basic login as the dashboard. JSON requests use `Content-Type: application/json`.
Browser mutations require a matching `Origin`; cross-origin requests are rejected.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/api/plans` | Latest ten plans |
| POST | `/api/plans` | Plan configuration; returns saved plan |
| GET | `/api/plans/:id` | Complete plan |
| PATCH | `/api/plans/:planId/workouts/:id` | Status, date, actualKm, actualMinutes, effort, notes |
| POST | `/api/plans/:id/ease` | `{ "startDate": "2026-10-01" }` |
| GET | `/api/plans/:id/calendar.ics` | All-day calendar export |
| GET | `/api/plans/:id/export.csv` | Spreadsheet export |
| GET / POST | `/api/activities` | List / record an activity |
| GET | `/api/integrations` | Strava configuration and connection status |
| POST | `/api/strava/sync` | Import bounded recent runs |
| DELETE | `/api/strava` | Forget local Strava connection |

Example plan body:

```json
{
  "name": "Autumn running",
  "goal": "10k",
  "startDate": "2026-10-01",
  "weeks": 12,
  "currentWeeklyKm": 20,
  "currentLongestKm": 8,
  "days": [2, 4, 7],
  "longRunDay": 7,
  "intensity": "balanced",
  "recent5kMinutes": 30
}
```

Weekdays use ISO numbering: Monday 1 through Sunday 7. Choose 2–6 distinct days,
including the long-run day. Distances must be 0–100 km in tenths, with longest run
no greater than weekly distance. Optional 5K time must be 12–90 minutes. Unknown
configuration fields are rejected. See Zod schemas for the complete input contract.

Manual activity body: `date`, `name`, `distanceKm`, `durationMinutes`.
Workout `status` is `planned`, `completed`, or `skipped`; `effort` is 1–10.
Imported runs and workout completion logs are distinct, avoiding automatic matching
or accidental double attribution. Endpoints return 400 for invalid inputs, 404 for
missing resources, and 409 for conflicting edits. No delete-plan endpoint is
provided; export data before performing deliberate database maintenance.

## MCP

Point a client that supports custom bearer headers at
`https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp` using the same installation token.
This is a stateless HTTP JSON-RPC endpoint; POST returns JSON, GET streaming is not
implemented. It negotiates MCP protocol `2025-03-26` and requires no session ID.
It does not implement OAuth discovery, so clients that require OAuth rather than
static bearer credentials cannot connect directly.

Tools: `list_plans`, `get_plan`, `create_plan`, `update_workout`, `ease_plan`,
`list_activities`, `log_activity`, `export_calendar`, `export_csv`, `strava_status`,
`sync_strava`, and `disconnect_strava`. `tools/list` returns each input schema.
Connect Strava in your browser before invoking its import tools.

Example initialization body:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": { "name": "my-client", "version": "1.0" }
  }
}
```

Then send a `notifications/initialized` notification and `tools/list` or
`tools/call` requests. Tools can change your data; approve mutations according to
your MCP client's controls. The shared token gives full access to this installation.

## Contributing

Use `npm ci`, keep changes focused, and run `npm run check` plus `npm run build`.
Include regression tests for behavior changes. Do not submit credentials, personal
training records, proprietary app assets, or decompiled third-party source.
The CI workflow checks pull requests without deploying anything.

To clear logged numeric values, PATCH their fields to `null`; omitting a field preserves it.
Blank numeric fields in the browser form clear the saved value. Notes accept up to 1,000 characters.
