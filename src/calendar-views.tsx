export function CalendarSettings({
  calendars,
  settings,
  syncedAt,
  error,
}: {
  calendars: Array<{
    id: string;
    summary: string;
    timeZone: string;
    accessRole: string;
    primary?: boolean;
  }>;
  settings: {
    readCalendarIds: string[];
    writeCalendarId: string | null;
    timeZone: string;
    windowStart: string;
    windowEnd: string;
  };
  syncedAt?: string;
  error?: string;
}) {
  const writable = calendars.filter((calendar) =>
    ['owner', 'writer'].includes(calendar.accessRole),
  );
  return (
    <>
      <a class="back-link" href="/app">
        ← My running
      </a>
      <section class="page-heading">
        <div>
          <div class="eyebrow">Room for running</div>
          <h1>Your calendar, connected.</h1>
          <p class="lead">
            Choose which calendars to check and where your planned runs should appear.
          </p>
        </div>
      </section>
      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      <section class="note-panel">
        <h2>{calendars.length ? 'Calendar connection available' : 'Connect your calendar'}</h2>
        {calendars.length ? (
          <>
            <p>
              Your calendar list is available. Select the calendars that reflect your commitments
              below.
            </p>
            <p class="quiet">
              {syncedAt
                ? `Last availability sync: ${syncedAt}.`
                : 'Waiting for the first availability sync.'}{' '}
              Availability reflects the most recent successful sync.
            </p>
          </>
        ) : (
          <>
            <p>
              No calendar connection has arrived yet. The installation owner needs to connect Google
              Calendar through the calendar bridge and run its first sync.
            </p>
            <p>
              After setup, refresh this page to choose calendars. You can continue creating plans
              while the connection is being set up.
            </p>
            <a class="text-link" href="/app/new">
              Continue to plan setup →
            </a>
          </>
        )}
      </section>
      {calendars.length > 0 && (
        <form class="plan-form" method="post" action="/app/calendar">
          <fieldset>
            <legend>
              <span class="step">01</span> Check availability
            </legend>
            <p class="field-help">
              Busy time from these calendars helps avoid conflicts. Selecting a calendar here does
              not give OpenStride a destination for new events.
            </p>
            {calendars.map((calendar) => (
              <label>
                <input
                  type="checkbox"
                  name="readCalendarIds"
                  value={calendar.id}
                  checked={settings.readCalendarIds.includes(calendar.id)}
                />{' '}
                {calendar.summary}
                {calendar.primary ? ' (primary)' : ''}
                <span class="field-help">{calendar.timeZone}</span>
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>
              <span class="step">02</span> Add planned runs
            </legend>
            <label>
              Destination calendar
              <select name="writeCalendarId">
                <option value="" selected={!settings.writeCalendarId}>
                  Do not add events
                </option>
                {writable.map((calendar) => (
                  <option value={calendar.id} selected={settings.writeCalendarId === calendar.id}>
                    {calendar.summary}
                  </option>
                ))}
              </select>
            </label>
            <p class="field-help">
              Only calendars you can edit appear here. Sync creates and updates OpenStride workout
              events; your other events stay under your control.
            </p>
            <p class="quiet">
              Saving a destination does not turn on sync for any plan. Enable calendar sync from the
              individual plan when you are ready.
            </p>
          </fieldset>
          <fieldset>
            <legend>
              <span class="step">03</span> Your running window
            </legend>
            <div class="form-grid">
              <label>
                Time zone
                <input
                  name="timeZone"
                  value={settings.timeZone}
                  required
                  maxlength={100}
                  placeholder="America/Los_Angeles"
                />
                <span class="field-help">Use an IANA time zone, such as America/Los_Angeles.</span>
              </label>
              <label>
                Earliest start
                <input type="time" name="windowStart" value={settings.windowStart} required />
              </label>
              <label>
                Finish by
                <input type="time" name="windowEnd" value={settings.windowEnd} required />
              </label>
            </div>
            <p class="field-help">
              Runs are placed within this daily window when there is enough free time. Sessions that
              do not fit are flagged for review.
            </p>
          </fieldset>
          <div class="form-footer">
            <p class="quiet">Calendar changes appear after the next successful bridge sync.</p>
            <button class="button" type="submit">
              Save calendar settings <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      )}
    </>
  );
}
