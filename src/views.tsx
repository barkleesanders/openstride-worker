import type { Child } from 'hono/jsx';
import type { Activity, Plan } from './types';

const goals: Record<string, string> = {
  base: 'Build a running habit',
  '5k': '5K',
  '10k': '10K',
  half: 'Half marathon',
  marathon: 'Marathon',
};
const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const today = () => new Date().toISOString().slice(0, 10);
const dateLabel = (value: string) =>
  new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
const distance = (value: number) => `${Math.round(value * 10) / 10} km`;
const pace = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

export function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>{title} · OpenStride</title>
        <link rel="stylesheet" href="/styles.css" />
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
            <a class="nav-create" href="/app/new">
              New plan <span aria-hidden="true">↗</span>
            </a>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer class="site-footer">
          <span>OpenStride / Your pace. Your plan.</span>
          <span>Open source. No ads. No tracking.</span>
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
          This is a transparent, rules-based planner, not a personal coach or medical service. It
          cannot assess injury, health, or race readiness. Start with your recent training, keep
          easy runs comfortable, and stop if something hurts.
        </p>
        <p class="quiet">
          No subscription or paid AI is required. Apple Health and Android Health Connect need an
          on-device companion; this web app does not connect to them directly.
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
                  Distance (km)
                  <input type="number" name="distanceKm" min={0} max={300} step="0.01" required />
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

export function NewPlan({ error }: { error?: string }) {
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
      <form class="plan-form" method="post" action="/app/plans">
        <fieldset>
          <legend>
            <span class="step">01</span> A direction
          </legend>
          <div class="form-grid">
            <label>
              Plan name
              <input name="name" required maxlength={80} value="My next chapter" />
            </label>
            <label>
              Goal
              <select name="goal">
                <option value="base">Build a running habit</option>
                <option value="5k">5K</option>
                <option value="10k">10K</option>
                <option value="half">Half marathon</option>
                <option value="marathon">Marathon</option>
              </select>
            </label>
            <label>
              Start date
              <input type="date" name="startDate" required value={today()} />
            </label>
            <label>
              Plan length, in weeks
              <input type="number" name="weeks" min={4} max={24} required value={12} />
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
              Current weekly distance (km)
              <input
                type="number"
                name="currentWeeklyKm"
                min={0}
                max={100}
                step="0.1"
                required
                value={10}
              />
            </label>
            <label>
              Longest comfortable recent run (km)
              <input
                type="number"
                name="currentLongestKm"
                min={0}
                max={100}
                step="0.1"
                required
                value={4}
              />
            </label>
            <label>
              Training approach
              <select name="intensity">
                <option value="gentle">Gentle — focus on easy running</option>
                <option value="balanced">Balanced — add some variety</option>
                <option value="challenging">Challenging — more demanding sessions</option>
              </select>
            </label>
            <label>
              Recent 5K time (minutes, optional)
              <input
                type="number"
                name="recent5kMinutes"
                min={12}
                max={90}
                step="0.1"
                placeholder="For example, 30"
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
                  checked={[2, 4, 7].includes(i + 1)}
                />
                <span>{day}</span>
              </label>
            ))}
          </div>
          <label class="short-field">
            Long-run day
            <select name="longRunDay">
              {dayNames.map((day, i) => (
                <option value={i + 1} selected={i === 6}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <div class="form-footer">
          <p class="quiet">
            Your plan uses fixed training rules. Review it before starting and adjust to how you
            feel. A generated plan does not establish race readiness.
          </p>
          <button class="button" type="submit">
            Build my plan <span aria-hidden="true">↗</span>
          </button>
        </div>
      </form>
    </>
  );
}

export function PlanPage({ plan, message }: { plan: Plan; message?: string }) {
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
      <div class="stats">
        <div>
          <span class="stat-value">
            {complete}
            <small> / {plan.workouts.length}</small>
          </span>
          <span class="stat-label">Sessions completed</span>
        </div>
        <div>
          <span class="stat-value">
            {Math.round(totalKm)}
            <small> km</small>
          </span>
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
              <li>{warning}</li>
            ))}
          </ul>
        </aside>
      )}
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
                    <p>{workout.description}</p>
                    {workout.paceMinSeconds !== undefined &&
                      workout.paceMaxSeconds !== undefined && (
                        <p class="quiet">
                          Estimated pace: {pace(workout.paceMinSeconds)}–
                          {pace(workout.paceMaxSeconds)} /km. Effort and comfort come first.
                        </p>
                      )}
                    <form method="post" action={`/app/workouts/${workout.id}`}>
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
                          Actual distance (km)
                          <input
                            type="number"
                            name="actualKm"
                            min={0}
                            max={300}
                            step="0.01"
                            value={workout.actualKm ?? ''}
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
