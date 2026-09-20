import type { Child } from 'hono/jsx';
import type { Activity, Plan, PlanConfig } from './types';
import { distance, distanceText, miles, paceRange } from './units';

const goals: Record<string, string> = {
  base: 'Build a running habit',
  '5k': '3.1 miles (5K)',
  '10k': '6.2 miles (10K)',
  half: '13.1 miles (half marathon)',
  marathon: '26.2 miles (marathon)',
};
const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const today = () => new Date().toISOString().slice(0, 10);
const dateLabel = (value: string) =>
  new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

function DistanceUnit() {
  return (
    <label>
      Distance unit
      <select name="distanceUnit">
        <option value="mi" selected>
          Miles (mi)
        </option>
        <option value="km">Kilometers (km)</option>
      </select>
    </label>
  );
}

export function Layout({
  title,
  children,
  publicHome = false,
}: {
  title: string;
  children: Child;
  publicHome?: boolean;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>{title} · OpenStride</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {/* Safari/bookmarks/crawlers request /favicon.ico regardless of the SVG link;
            both files sit in public/ next to favicon.svg, rasterized from it by
            ~/tools/favicon-pack. */}
        <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {publicHome && (
          <>
            <meta
              name="description"
              content="A personal running planner. Build a weekly rhythm, track your progress, and adjust your plan when life happens."
            />
            <link rel="canonical" href="https://openstride.barkleesanders.com/" />
            <meta property="og:type" content="website" />
            <meta property="og:site_name" content="OpenStride" />
            <meta property="og:title" content="OpenStride — Your pace. Your plan." />
            <meta
              property="og:description"
              content="Build a weekly running rhythm and track your progress."
            />
            <meta property="og:url" content="https://openstride.barkleesanders.com/" />
            <meta property="og:image" content="https://openstride.barkleesanders.com/og.png" />
            <meta property="og:image:width" content="1200" />
            <meta property="og:image:height" content="630" />
            <meta property="og:image:alt" content="OpenStride — Your pace. Your plan." />
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content="OpenStride — Your pace. Your plan." />
            <meta
              name="twitter:description"
              content="Build a weekly running rhythm and track your progress."
            />
            <meta name="twitter:image" content="https://openstride.barkleesanders.com/og.png" />
            <meta name="twitter:image:alt" content="OpenStride — Your pace. Your plan." />
          </>
        )}
        <link rel="stylesheet" href="/styles.css" />
        <script src="/units.js" defer></script>
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <header class="site-header">
          <a class="brand" href="/" aria-label="OpenStride home">
            <span class="brand-mark" aria-hidden="true">
              ↗
            </span>{' '}
            OpenStride
          </a>
          <nav aria-label="Main navigation">
            <a href="/">Home</a>
            <a href="/app">My running</a>
            <a href="/app/calendar">Calendar</a>
            <a class="nav-create" href="/app/new">
              New plan <span aria-hidden="true">↗</span>
            </a>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer class="site-footer">
          <span>OpenStride / Your pace. Your plan.</span>
          <span>Open source.</span>
        </footer>
      </body>
    </html>
  );
}

export function Home({ accessLogin = false }: { accessLogin?: boolean }) {
  return (
    <>
      <section class="hero">
        <div class="eyebrow">A little structure. A lot of possibility.</div>
        <h1>
          Make room
          <br />
          for your next run.
        </h1>
        <p class="hero-copy">
          A personal running planner that belongs to you. Build a weekly rhythm, keep track of your
          progress, and adjust when life happens.
        </p>
        <div class="actions">
          <a class="button" href="/app/new">
            Build my plan <span aria-hidden="true">↗</span>
          </a>
          <a class="text-link" href="/app">
            Open my running space
          </a>
        </div>
        <p class="quiet login-note">
          {accessLogin
            ? 'Sign in with the one-time code sent to your email by Cloudflare Access.'
            : 'Sign in with username runner and your deployment password.'}
        </p>
      </section>
      <section class="home-grid" aria-label="How it works">
        <article class="feature">
          <span class="step">01 / START WHERE YOU ARE</span>
          <h2>A week that fits.</h2>
          <p>
            Choose your running days, current distance, and goal. Get a structured plan with easy
            days, a long run, and room to recover.
          </p>
        </article>
        <article class="feature">
          <span class="step">02 / KEEP IT HUMAN</span>
          <h2>Progress, with flexibility.</h2>
          <p>
            Log a run, move a session, or ease upcoming weeks. Changes are yours to make, with a
            clear view of what is ahead.
          </p>
        </article>
        <article class="feature">
          <span class="step">03 / KEEP IT YOURS</span>
          <h2>Run on your terms.</h2>
          <p>
            Self-host on Cloudflare’s free tier within its usage limits. Export your schedule and
            optionally bring in Strava activities.
          </p>
        </article>
      </section>
      <section class="note-panel">
        <h2>Structure to support you.</h2>
        <p>
          AI can recommend a starting point from your recent running and availability. Training
          rules bound the resulting schedule. This planner cannot assess injury, health, or race
          readiness. Start with your recent training, keep easy runs comfortable, and stop if
          something hurts.
        </p>
        <p class="quiet">
          Manual planning is also available. Apple Health and Android Health Connect need an
          on-device companion; this web app does not connect to them directly.
        </p>
      </section>
      <section class="note-panel" aria-labelledby="veteran-resource-heading">
        <h2 id="veteran-resource-heading">A resource for veterans.</h2>
        <p>
          Preparing a VA disability claim? AIVA Claims helps veterans organize medical records and
          prepare claim documents. You review the documents and submit your own claim to the VA.
        </p>
        <p>
          <a
            class="text-link"
            href="https://aivaclaims.com/?utm_source=openstride&utm_medium=referral&utm_campaign=veteran_resources"
          >
            Explore AIVA Claims
          </a>
        </p>
      </section>
    </>
  );
}

export function Dashboard({
  plans,
  activities,
  stravaConfigured,
  stravaConnected,
  bridgeSyncedAt,
}: {
  plans: Plan[];
  activities: Activity[];
  stravaConfigured: boolean;
  stravaConnected: boolean;
  bridgeSyncedAt?: string;
}) {
  const completed = plans.reduce(
    (sum, plan) => sum + plan.workouts.filter((workout) => workout.status === 'completed').length,
    0,
  );
  return (
    <>
      <section class="page-heading">
        <div>
          <div class="eyebrow">Your running space</div>
          <h1>One run at a time.</h1>
          <p class="lead">A clear view of your plans and the miles behind you.</p>
        </div>
        <a class="button" href="/app/new">
          Create a plan <span aria-hidden="true">+</span>
        </a>
      </section>
      <div class="stats">
        <div>
          <span class="stat-value">{plans.length}</span>
          <span class="stat-label">Training plans</span>
        </div>
        <div>
          <span class="stat-value">{completed}</span>
          <span class="stat-label">Sessions marked complete</span>
        </div>
        <div>
          <span class="stat-value">{activities.length}</span>
          <span class="stat-label">Recent activities shown</span>
        </div>
      </div>
      <section class="section">
        <div class="section-title">
          <h2>Your plans</h2>
          <span class="quiet">Build consistency, week by week.</span>
        </div>
        {plans.length ? (
          <div class="plan-grid">
            {plans.map((plan) => (
              <a class="plan-card" href={`/app/plans/${plan.id}`}>
                <span class="eyebrow">{goals[plan.config.goal]}</span>
                <h3>{plan.config.name}</h3>
                <p>
                  {plan.config.weeks} weeks · {plan.config.days.length} runs a week
                </p>
                <div class="card-bottom">
                  <span>Starts {dateLabel(plan.config.startDate)}</span>
                  <span aria-hidden="true">↗</span>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <div class="empty">
            <h3>Your next chapter starts here.</h3>
            <p>
              Tell us what your running looks like today. We’ll help you build a manageable next
              step.
            </p>
            <a class="text-link" href="/app/new">
              Create your first plan →
            </a>
          </div>
        )}
      </section>
      <div class="dashboard-columns">
        <section class="section">
          <h2>Recent activities</h2>
          <details class="note-panel">
            <summary>Log a standalone run</summary>
            <p class="field-help">
              For runs outside your plan. This does not mark a planned session complete.
            </p>
            <form method="post" action="/app/activities">
              <DistanceUnit />
              <div class="form-grid">
                <label>
                  Run name
                  <input name="name" maxlength={120} required />
                </label>
                <label>
                  Date
                  <input type="date" name="date" value={today()} required />
                </label>
                <label>
                  Distance (in selected unit)
                  <input type="number" name="distanceKm" min={0} max={300} step="any" required />
                  <span class="field-help">
                    Miles first. Choose kilometers to enter a metric distance.
                  </span>
                </label>
                <label>
                  Moving time (minutes)
                  <input
                    type="number"
                    name="durationMinutes"
                    min={0.1}
                    max={3000}
                    step="0.1"
                    required
                  />
                </label>
              </div>
              <button class="button small" type="submit">
                Save activity
              </button>
            </form>
          </details>
          {activities.length ? (
            <ul class="activity-list">
              {activities.map((activity) => (
                <li>
                  <div>
                    <strong>{activity.name}</strong>
                    <span class="quiet">
                      {dateLabel(activity.date)} ·{' '}
                      {activity.source === 'strava' ? 'Strava' : 'Manual'}
                    </span>
                  </div>
                  <div class="activity-metrics">
                    {distance(activity.distanceKm)}
                    <span class="quiet">{Math.round(activity.durationMinutes)} min</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p class="empty-small">
              No activities yet. Log a standalone run below or record a planned session inside your
              plan.
            </p>
          )}
        </section>
        <section class="section integration" id="connections">
          <span class="eyebrow">Connected running</span>
          <h2>Bring your runs along.</h2>
          {bridgeSyncedAt ? (
            <>
              <p class="status-pill">Strava sync connected</p>
              <p>
                Your activity bridge sends running workouts automatically. Last received:{' '}
                {bridgeSyncedAt}.
              </p>
              <p class="quiet">
                Imported runs stay separate from planned sessions. Sync includes run date, distance,
                and duration.
              </p>
            </>
          ) : stravaConnected ? (
            <>
              <p class="status-pill">Strava connected</p>
              <p>
                Import your recent activities. Imported runs stay separate from your plan’s session
                log.
              </p>
              <div class="actions">
                <form method="post" action="/app/strava/sync">
                  <button class="button" type="submit">
                    Sync Strava
                  </button>
                </form>
                <form method="post" action="/app/strava/disconnect">
                  <button class="button secondary" type="submit">
                    Disconnect
                  </button>
                </form>
              </div>
            </>
          ) : stravaConfigured ? (
            <>
              <p>
                Connect your own Strava account to import activities. You choose what to share on
                Strava’s authorization screen.
              </p>
              <a class="button secondary" href="/app/strava/connect">
                Connect Strava ↗
              </a>
            </>
          ) : (
            <>
              <p>Strava is not configured on this installation.</p>
              <p class="quiet">
                The deployment owner can enable it using the setup instructions. Planning and
                logging work without it.
              </p>
            </>
          )}
          <p class="quiet integration-footnote">
            Calendar and spreadsheet exports are available inside each plan.
          </p>
        </section>
      </div>
    </>
  );
}

export function NewPlan({
  error,
  config,
  aiEnabled = false,
  activityCount = 0,
  calendarConnected = false,
  calendarSyncedAt,
  rationale,
  draftId,
  notes = '',
}: {
  error?: string;
  config?: PlanConfig;
  aiEnabled?: boolean;
  activityCount?: number;
  calendarConnected?: boolean;
  calendarSyncedAt?: string;
  rationale?: string;
  draftId?: string;
  notes?: string;
}) {
  return (
    <>
      <section class="page-heading">
        <div>
          <div class="eyebrow">Start with your real week</div>
          <h1>Find your rhythm.</h1>
          <p class="lead">Build from what you can comfortably do today.</p>
        </div>
      </section>
      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      <section class="note-panel" aria-label="Planning context">
        <h2>
          {rationale
            ? 'Your recommendation is ready to review.'
            : 'Start with what is already connected.'}
        </h2>
        <p>
          {activityCount > 0
            ? `${activityCount} recent running activities are available to inform your plan. Check the starting distances below against how you feel today.`
            : 'No recent running activities are available yet. Enter your current training below.'}
        </p>
        <p>
          {calendarConnected
            ? 'Calendar availability is connected. Your selected calendars help find room for runs.'
            : 'Connect your calendar to plan around your existing commitments.'}
          {calendarSyncedAt && <> Last availability sync: {calendarSyncedAt}.</>}
        </p>
        <a class="text-link" href="/app/calendar">
          Manage calendar connection →
        </a>
        {rationale && (
          <div role="status">
            <h3>Why these recommendations</h3>
            <p>{rationale}</p>
            <p class="quiet">
              The fields below contain the recommendation. Review or edit them, then save your plan.
              Nothing has been saved yet.
            </p>
          </div>
        )}
      </section>
      <form class="plan-form" method="post" action="/app/plans">
        <DistanceUnit />
        {draftId && <input type="hidden" name="draftId" value={draftId} />}
        <fieldset>
          <legend>
            <span class="step">01</span> A direction
          </legend>
          <div class="form-grid">
            <label>
              Plan name
              <input
                name="name"
                required
                maxlength={80}
                value={config?.name ?? 'My next chapter'}
              />
            </label>
            <label>
              Goal
              <select name="goal">
                {Object.entries(goals).map(([value, label]) => (
                  <option value={value} selected={value === (config?.goal ?? 'base')}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Start date
              <input type="date" name="startDate" required value={config?.startDate ?? today()} />
            </label>
            <label>
              Plan length, in weeks
              <input
                type="number"
                name="weeks"
                min={4}
                max={24}
                required
                value={config?.weeks ?? 12}
              />
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>
            <span class="step">02</span> Where you are now
          </legend>
          <p class="field-help">
            Use a typical recent week, not your best week. Distances are in kilometers.
          </p>
          <div class="form-grid">
            <label>
              Current weekly distance (in selected unit)
              <input
                type="number"
                name="currentWeeklyKm"
                min={0}
                max={100}
                step="any"
                required
                value={miles(config?.currentWeeklyKm ?? 10)}
              />
            </label>
            <label>
              Longest comfortable recent run (in selected unit)
              <input
                type="number"
                name="currentLongestKm"
                min={0}
                max={100}
                step="any"
                required
                value={miles(config?.currentLongestKm ?? 4)}
              />
            </label>
            <label>
              Training approach
              <select name="intensity">
                <option value="gentle" selected={(config?.intensity ?? 'gentle') === 'gentle'}>
                  Gentle — focus on easy running
                </option>
                <option value="balanced" selected={config?.intensity === 'balanced'}>
                  Balanced — add some variety
                </option>
                <option value="challenging" selected={config?.intensity === 'challenging'}>
                  Challenging — more demanding sessions
                </option>
              </select>
            </label>
            <label>
              Recent 3.1-mile (5K) time (minutes, optional)
              <input
                type="number"
                name="recent5kMinutes"
                min={12}
                max={90}
                step="0.1"
                placeholder="For example, 30"
                value={config?.recent5kMinutes ?? ''}
              />
              <span class="field-help">
                An actual recent result can guide pace estimates. Leave blank if unsure.
              </span>
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>
            <span class="step">03</span> Room in your calendar
          </legend>
          <p class="field-help">Choose your running days. Your long-run day must be one of them.</p>
          <div class="day-picker">
            {dayNames.map((day, i) => (
              <label>
                <input
                  type="checkbox"
                  name="days"
                  value={i + 1}
                  checked={(config?.days ?? [2, 4, 7]).includes(i + 1)}
                />
                <span>{day}</span>
              </label>
            ))}
          </div>
          <label class="short-field">
            Long-run day
            <select name="longRunDay">
              {dayNames.map((day, i) => (
                <option value={i + 1} selected={i + 1 === (config?.longRunDay ?? 7)}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend>
            <span class="step">04</span> What else should your plan account for?
          </legend>
          <label>
            Preferences and constraints (optional)
            <textarea
              name="notes"
              maxlength={2000}
              rows={4}
              placeholder="For example: keep weekday runs short, or build back gradually after time off."
            >
              {notes}
            </textarea>
          </label>
          <p class="field-help">
            AI uses these notes with your training and calendar availability to recommend settings.
            Review the recommendation before saving.
          </p>
        </fieldset>
        <div class="form-footer">
          <p class="quiet">
            {aiEnabled
              ? 'Ask AI for recommended settings, or save the settings you chose yourself.'
              : 'AI recommendations are not enabled on this installation. You can save a plan using your own settings.'}{' '}
            Training rules bound the schedule in both cases. Review it before starting and adjust to
            how you feel.
          </p>
          <div class="actions">
            {aiEnabled && (
              <button class="button" type="submit" formaction="/app/plans/propose">
                {rationale ? 'Revise with AI' : 'Get AI recommendations'}{' '}
                <span aria-hidden="true">↗</span>
              </button>
            )}
            <button class="button secondary" type="submit" formaction="/app/plans">
              {rationale ? 'Save this plan' : 'Save with these settings'}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}

export function PlanPage({
  plan,
  message,
  calendarSync,
}: {
  plan: Plan;
  message?: string;
  calendarSync?: { enabled: boolean; syncedAt?: string; pending?: number; conflicts?: number };
}) {
  const complete = plan.workouts.filter((workout) => workout.status === 'completed').length;
  const totalKm = plan.workouts.reduce((sum, workout) => sum + workout.distanceKm, 0);
  const weeks = [...new Set(plan.workouts.map((workout) => workout.week))].sort((a, b) => a - b);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return (
    <>
      <a class="back-link" href="/app">
        ← All plans
      </a>
      <section class="page-heading">
        <div>
          <div class="eyebrow">
            {goals[plan.config.goal]} / {plan.config.intensity}
          </div>
          <h1>{plan.config.name}</h1>
          <p class="lead">{plan.config.weeks} weeks of making time for yourself.</p>
        </div>
        <div class="export-links">
          <a href={`/app/plans/${plan.id}/calendar.ics`}>Download calendar ↗</a>
          <a href={`/app/plans/${plan.id}/export.csv`}>Download spreadsheet ↗</a>
          <a href={`/app/plans/${plan.id}/data`}>View plan data ↗</a>
        </div>
      </section>
      {message && (
        <p class="notice" role="status">
          {message}
        </p>
      )}
      {plan.ai && (
        <section class="note-panel" aria-label="AI recommendation">
          <h2>The thinking behind your plan</h2>
          <p>{plan.ai.rationale}</p>
          <p class="quiet">
            AI recommendation created {plan.ai.generatedAt}. Training rules bound the final
            schedule.
          </p>
        </section>
      )}
      <div class="stats">
        <div>
          <span class="stat-value">
            {complete}
            <small> / {plan.workouts.length}</small>
          </span>
          <span class="stat-label">Sessions completed</span>
        </div>
        <div>
          <span class="stat-value">{distance(totalKm)}</span>
          <span class="stat-label">Scheduled distance</span>
        </div>
        <div>
          <span class="stat-value">{plan.config.days.length}</span>
          <span class="stat-label">Running days each week</span>
        </div>
      </div>
      {plan.warnings.length > 0 && (
        <aside class="notice">
          <h2>Before you begin</h2>
          <ul>
            {plan.warnings.map((warning) => (
              <li>{distanceText(warning)}</li>
            ))}
          </ul>
        </aside>
      )}
      <section class="note-panel" aria-label="Calendar sync">
        <h2>Make time for this plan.</h2>
        <p>
          {calendarSync?.enabled
            ? 'Calendar sync is enabled for this plan.'
            : 'Calendar sync is off for this plan. Choose your calendars, then enable sync to schedule these runs.'}
        </p>
        {calendarSync?.syncedAt && <p class="quiet">Last sync: {calendarSync.syncedAt}</p>}
        {Boolean(calendarSync?.pending) && (
          <p>{calendarSync?.pending} calendar changes are waiting to sync.</p>
        )}
        {Boolean(calendarSync?.conflicts) && (
          <p class="notice">
            {calendarSync?.conflicts} sessions need more room in your calendar. Review your
            availability or move the session.
          </p>
        )}
        <div class="actions">
          <a class="text-link" href="/app/calendar">
            Calendar settings →
          </a>
          <form method="post" action={`/app/plans/${plan.id}/calendar`}>
            <button
              class="button secondary"
              type="submit"
              name="action"
              value={calendarSync?.enabled ? 'disable' : 'enable'}
            >
              {calendarSync?.enabled ? 'Turn off calendar sync' : 'Enable calendar sync'}
            </button>
          </form>
        </div>
      </section>
      <section class="schedule section">
        <div class="section-title">
          <h2>The weeks ahead</h2>
          <span class="quiet">Open a session to log it or change its date.</span>
        </div>
        {weeks.map((week) => {
          const workouts = plan.workouts.filter((workout) => workout.week === week);
          return (
            <section class="week">
              <div class="week-heading">
                <h3>Week {week}</h3>
                <span>
                  {distance(workouts.reduce((sum, workout) => sum + workout.distanceKm, 0))}{' '}
                  scheduled
                </span>
              </div>
              {workouts.map((workout) => (
                <details class={`workout ${workout.status}`}>
                  <summary>
                    <span class="workout-date">{dateLabel(workout.date)}</span>
                    <span class="workout-title">
                      {workout.title}
                      <span class="workout-kind">{workout.type.replace('-', ' ')}</span>
                    </span>
                    <span class="workout-distance">{distance(workout.distanceKm)}</span>
                    <span class="workout-status">{workout.status}</span>
                    <span class="expand-mark" aria-hidden="true">
                      +
                    </span>
                  </summary>
                  <div class="workout-body">
                    <p>{distanceText(workout.description)}</p>
                    {workout.paceMinSeconds !== undefined &&
                      workout.paceMaxSeconds !== undefined && (
                        <p class="quiet">
                          Estimated pace:{' '}
                          {paceRange(workout.paceMinSeconds, workout.paceMaxSeconds)}. Effort and
                          comfort come first.
                        </p>
                      )}
                    <form method="post" action={`/app/workouts/${workout.id}`}>
                      <DistanceUnit />
                      <input type="hidden" name="planId" value={plan.id} />
                      <div class="form-grid compact">
                        <label>
                          Session status
                          <select name="status">
                            <option value="planned" selected={workout.status === 'planned'}>
                              Planned
                            </option>
                            <option value="completed" selected={workout.status === 'completed'}>
                              Completed
                            </option>
                            <option value="skipped" selected={workout.status === 'skipped'}>
                              Skipped
                            </option>
                          </select>
                        </label>
                        <label>
                          Session date
                          <input type="date" name="date" required value={workout.date} />
                        </label>
                        <label>
                          Actual distance (in selected unit)
                          <input
                            type="number"
                            name="actualKm"
                            min={0}
                            max={300}
                            step="any"
                            value={workout.actualKm === undefined ? '' : miles(workout.actualKm)}
                          />
                        </label>
                        <label>
                          Actual duration (minutes)
                          <input
                            type="number"
                            name="actualMinutes"
                            min={0}
                            max={3000}
                            step="0.1"
                            value={workout.actualMinutes ?? ''}
                          />
                        </label>
                        <label>
                          Effort (1 easy to 10 maximal)
                          <input
                            type="number"
                            name="effort"
                            min={1}
                            max={10}
                            value={workout.effort ?? ''}
                          />
                        </label>
                        <label>
                          Notes
                          <textarea name="notes" rows={2} maxlength={1000}>
                            {workout.notes ?? ''}
                          </textarea>
                        </label>
                      </div>
                      <button class="button small" type="submit">
                        Save session
                      </button>
                    </form>
                  </div>
                </details>
              ))}
            </section>
          );
        })}
      </section>
      <section class="note-panel ease-panel">
        <div>
          <div class="eyebrow">Leave room for life</div>
          <h2>Need an easier stretch?</h2>
          <p>
            Reduce future planned sessions by 20% and replace intensity with easy running. Completed
            and skipped sessions stay as they are. This applies only when you press the button; it
            does not adapt automatically.
          </p>
          <p class="quiet">Applying this again reduces the remaining planned distances again.</p>
        </div>
        <form method="post" action={`/app/plans/${plan.id}/ease`}>
          <label>
            Ease sessions from
            <input type="date" name="startDate" required value={tomorrow} />
          </label>
          <button class="button secondary" type="submit">
            Ease upcoming sessions
          </button>
        </form>
      </section>
    </>
  );
}

export function ErrorPage({ message }: { message: string }) {
  return (
    <section class="hero">
      <div class="eyebrow">Let’s get you back on track</div>
      <h1>A small pause.</h1>
      <p class="lead" role="alert">
        {message}
      </p>
      <a class="button" href="/app">
        Back to my running
      </a>
    </section>
  );
}
