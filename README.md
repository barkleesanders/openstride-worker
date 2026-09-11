# OpenStride

A personal running planner you can host on Cloudflare Workers and D1. Original,
transparent training rules, optional Worker LLM recommendations, and calendar sync.
Manual planning does not require AI or a Runna account.
MIT licensed. Not affiliated with Runna or Strava.

## Latest Changes

### September 11, 2026

- Worker AI recommendations use recent runs and connected calendar availability.
- Google Calendar bridge refreshes availability and reconciles opted-in workouts.
- Miles lead distances and paces; kilometers follow. Forms support both units.
- Calendar and CSV exports include miles before kilometers. API storage remains metric.

## Features

- Build 4–24 week plans for a running habit, 5K, 10K, half marathon, or marathon preparation.
- Choose running days, a long-run day, your recent mileage, and training approach.
- Get AI recommendations from recent running and calendar availability, then review before saving.
- Check Google Calendar availability and opt individual plans into scheduled event sync.
- Track completion, actual distance/time, effort, and notes. Move sessions to another date.
- Explicitly reduce future training by 20%; completed sessions stay intact.
- Download iCalendar and CSV files, and access your plans through a JSON API or MCP.
- Optionally import recent runs from your own Strava account.
- Server-rendered interface with a small script for distance-unit conversion. Cloudflare may
  inject its analytics beacon according to the zone configuration.

This is a **single-person installation**. Cloudflare Access can restrict browser
login to one email address using emailed one-time codes. API and MCP clients use
a separate bearer token with access to all installation data.

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

## Deploy

The app needs one Worker and one D1 database. Manual planning can run within
Workers Free limits. The checked-in configuration enables Workers AI, which adds
model usage subject to your account's allowances and pricing. Remove the `ai`
binding to disable recommendations. Calendar sync uses a separate online host.

```sh
npx wrangler login
npx wrangler d1 create openstride --config wrangler.jsonc
```

Replace the deployment's `database_id` in `wrangler.jsonc` with the ID printed by
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
or source code. Set your own custom domain in `routes`; preview and workers.dev
hostnames are disabled. A token shorter than 32 characters fails closed.

For email-code login, create a Cloudflare Access self-hosted application for
`YOUR-HOST/app`, select One-time PIN, and allow only your email. Store
`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `OWNER_EMAIL` as Worker secrets.
The Worker verifies the assertion signature, issuer, audience, expiry, and email.
Partial configuration fails closed; Basic authentication is disabled in Access mode.
Leave `/api/*` and `/mcp` reachable for bearer-authenticated clients. Browser exports
use `/app/*` and remain protected by Access. With no Access configuration, local
Basic authentication uses username `runner` and `APP_TOKEN`.

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

## Worker AI recommendations

The checked-in configuration binds Workers AI as `AI` with remote inference.
The model is `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Remote inference, including
local development with that binding, consumes account usage. Review
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
before enabling it; no zero-cost guarantee is implied.

Open **New plan**, review the starting distances, choose your constraints, and add
optional notes. **Get AI recommendations** returns a preview without saving a plan
or writing calendar events. The model receives your configuration and notes,
a summary of imported runs from the latest 28 calendar days, and daily calendar
availability totals. Activity names, IDs, GPS routes, appointment titles, and
appointment descriptions are excluded from its prompt. Notes are sent as entered.

Recommendations preserve your goal, start date, plan length, long-run day, and
provided 5K result. Recommended days must fit your selected days; training volume
and intensity cannot exceed your submitted baseline. The training engine builds
workouts after you review and save. The browser retains a model rationale only
when the saved configuration matches its server-side draft. Drafts expire after
24 hours. Manual settings remain available if AI fails or is disabled.

The Worker allows **20 attempts per installation per UTC day**, including failures,
with **1,200 output tokens** and a **25-second application timeout** per attempt.
The timeout is not a billing guarantee. Invalid output is rejected. Check the
returned recommendation and rationale when verifying model behavior.

## Google Calendar connection and sync

The bridge uses an existing authenticated `gog` installation on an online host.
Google credentials remain there; the browser has no Google token entry form.
The account needs Calendar read access and write access to a chosen destination
if you enable plan sync. Confirm stored authorization with `gog auth doctor`.

Create a private `~/.config/openstride/calendar-bridge.json`:

```json
{
  "url": "https://YOUR-HOST",
  "token": "YOUR_APP_TOKEN",
  "account": "YOUR_GOOGLE_ACCOUNT",
  "gog": "/opt/homebrew/bin/gog"
}
```

Use your actual installation token/account, set file permissions to `600`, and
never commit it. The URL must be an HTTPS origin without a path or credentials.
Run the first import on the host where `gog` is authorized:

```sh
node scripts/calendar-bridge.mjs ~/.config/openstride/calendar-bridge.json
```

In **Calendar**, select Personal or the other calendars whose busy time should
inform planning. Initial setup is read-only: no destination is selected and no
plan is opted into event sync. A newly discovered primary calendar is the default
availability calendar. Run another sync after selecting calendars to refresh
their busy intervals. Choose a writable destination and time zone/running window,
then explicitly **Enable calendar sync** inside each desired plan. Saving calendar
settings alone does not enable plan sync.

The bridge imports a bounded **180-day window** (one day back and 179 days ahead),
with at most **2,000 busy intervals** and **512 KiB per upload**. It uploads calendar
names/IDs/time zones, busy intervals, and sync receipts. Existing appointment
titles, descriptions, attendees, and locations are not uploaded. Stale or
incomplete availability is not presented as connected. Changing read calendars
requires a new snapshot before their availability is used.

Timed runs are placed within free intervals in your daily running window; sessions
without enough room are flagged as conflicts. Stable event IDs and private
ownership markers restrict changes to OpenStride events. Receipt fingerprints
skip unchanged writes and let failed changes retry. Concurrent or older snapshot
writes are rejected instead of silently overwriting newer state. Past and completed
sessions are preserved when sync is disabled. Google Calendar edits do not update
workout records; edit the plan in OpenStride. This is not general two-way editing.

### Optional five-minute host schedule

`scripts/calendar-sync.zsh` acquires a local lock, loads the existing private
`~/.config/gogcli/agent-env.zsh` environment, and runs the bridge. It expects
`calendar-sync.zsh` and `calendar-bridge.mjs` in `~/tools/openstride/` and Node at
`/opt/homebrew/bin/node`. Adapt these paths for another host.

`scripts/com.barkleesanders.openstride-calendar.plist.template` runs every 300
seconds and at load. Replace every `__HOME__` with the host's absolute home path
before installing it in `~/Library/LaunchAgents/`. The repository provides the
template; it does not install or activate a LaunchAgent. Installation and bootstrap
belong to the deployment step, after checking the wrapper's prerequisites.
Logs use `~/tools/openstride/calendar-sync.log` and `calendar-sync-error.log`.
The host must remain online; stopping the agent pauses sync. If a stale lock is
reported, verify the earlier process has stopped before removing the lock.

## Optional Strava import

Create your own API application at [Strava API settings](https://www.strava.com/settings/api).
Strava currently requires a subscription to create an API application; existing
applications can be reused. See [Strava getting started](https://developers.strava.com/docs/getting-started/).
Configure its authorization callback domain to match your deployment hostname.
Set these additional secrets:

```sh
npx wrangler secret put STRAVA_CLIENT_ID --config wrangler.jsonc
npx wrangler secret put STRAVA_CLIENT_SECRET --config wrangler.jsonc
npx wrangler secret put STRAVA_REDIRECT_URI --config wrangler.jsonc
```

Use `https://YOUR-HOST/app/strava/callback` for the
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

### Existing Strava CLI bridge

If an existing `strava-pp-cli` installation owns your Strava tokens, keep refreshes
there and run `node scripts/strava-bridge.mjs /path/to/private/bridge.json` hourly.
The private config contains `url` (your HTTPS origin), `token` (`APP_TOKEN`), and
optionally `cli` (absolute CLI path). Never commit this file.

The first successful run imports history, capped at 4,000 source activities;
later runs refresh the last 90 days. Reaching the cap fails visibly without claiming
a complete import. Only Run, TrailRun, and VirtualRun records are sent. Stable
Strava IDs prevent duplicates. Imports update metadata but do not remove older
records or mark plan sessions complete. The dashboard shows the last receipt time.
The bridge requires the host to be online; stop its scheduler to pause sync.

`POST /api/activities/import` and MCP `import_activities` accept batches of up to
100 validated run records. Apple Watch workouts can reach this bridge through
Strava's Health integration on iPhone; this does not import sleep, HRV, or the
entire Apple Health database.
Disconnect removes the local connection; revoke application access in Strava to
revoke its authorization there. Previously imported activity records remain.

Apple Health and Android Health Connect are not directly supported by this Worker;
they require a native companion with device permissions. Watch guidance, live GPS
recording, and push notifications are also outside this web app.

## Data and maintenance

Plans, activities, calendar snapshots, sync receipts, and AI drafts live in D1.
Enabled recommendations call Workers AI, Strava adapters call Strava, and the host
calendar bridge calls Google Calendar. Cloudflare processes requests and may inject
its analytics beacon or retain operational logs according to your settings.
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

Send `Authorization: Bearer YOUR_APP_TOKEN`. Browser exports use the dashboard's
configured Access or Basic login. JSON requests use `Content-Type: application/json`.
Browser mutations require a matching `Origin`; cross-origin requests are rejected.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/api/plans` | Latest ten plans |
| POST | `/api/plans` | Plan configuration; returns saved plan |
| POST | `/api/plans/propose` | `{ "config": { ... }, "notes": "..." }`; recommendation and draft ID, no saved plan |
| GET / PUT | `/api/calendar` | Snapshot/settings / save read calendars, destination, time zone, and window |
| GET | `/api/calendar/bridge` | Desired event changes for the host bridge |
| POST | `/api/calendar/import` | Calendar snapshot and event receipts from the bridge |
| PUT | `/api/plans/:id/calendar` | `{ "enabled": true }` or `{ "enabled": false }` |
| GET | `/api/plans/:id` | Complete plan |
| PATCH | `/api/plans/:planId/workouts/:id` | Status, date, actualKm, actualMinutes, effort, notes |
| POST | `/api/plans/:id/ease` | `{ "startDate": "2026-10-01" }` |
| GET | `/api/plans/:id/calendar.ics` | All-day calendar export |
| GET | `/api/plans/:id/export.csv` | Spreadsheet export |
| GET / POST | `/api/activities` | List / record an activity |
| POST | `/api/activities/import` | `{ "activities": [...] }`; up to 100 Strava run records |
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
`https://YOUR-HOST/mcp` using the same installation token.
This is a stateless HTTP JSON-RPC endpoint; POST returns JSON, GET streaming is not
implemented. It negotiates MCP protocol `2025-03-26` and requires no session ID.
It does not implement OAuth discovery, so clients that require OAuth rather than
static bearer credentials cannot connect directly.

Tools: `list_plans`, `get_plan`, `create_plan`, `update_workout`, `ease_plan`,
`list_activities`, `log_activity`, `export_calendar`, `export_csv`, `strava_status`,
`sync_strava`, `disconnect_strava`, `import_activities`, `propose_plan`,
`calendar_status`, `configure_calendar`, and `sync_plan_calendar`. `tools/list`
returns each input schema. `propose_plan` returns a recommendation without saving;
after review, pass its configuration to `create_plan`. Calendar sync is opt-in via
`sync_plan_calendar`, after choosing a destination with `configure_calendar`.
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
