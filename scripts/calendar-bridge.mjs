import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY = 86400000;
const OWNER = 'openstride';

// Calendar date-only end is exclusive; resolve each midnight separately across DST.
export function calendarInstant(value, timeZone) {
  if (value.dateTime) {
    if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value.dateTime)) throw new Error('Unzoned calendar time.');
    const result = new Date(value.dateTime);
    if (!Number.isFinite(result.getTime())) throw new Error('Invalid calendar time.');
    return result.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date || '')) throw new Error('Missing calendar date.');
  const target = Date.parse(`${value.date}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let instant = target;
  for (let attempt = 0; attempt < 5; attempt++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    const rendered = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    if (rendered === target) return new Date(instant).toISOString();
    instant += target - rendered;
  }
  throw new Error('Calendar midnight cannot be resolved.');
}

export function isOwned(event, desired) {
  const properties = event.extendedProperties?.private;
  return (
    properties?.managedBy === OWNER &&
    properties.workoutId === desired.workoutId &&
    properties.planId === desired.planId
  );
}

export function busySlots(events, calendar, rangeStart, rangeEnd) {
  return events.flatMap((event) => {
    if (
      event.status === 'cancelled' ||
      event.transparency === 'transparent' ||
      event.extendedProperties?.private?.managedBy === OWNER ||
      event.attendees?.some((person) => person.self && person.responseStatus === 'declined')
    )
      return [];
    const start = calendarInstant(event.start || {}, calendar.timeZone);
    const end = calendarInstant(event.end || {}, calendar.timeZone);
    if (end <= start) throw new Error('Invalid calendar interval.');
    if (end <= rangeStart || start >= rangeEnd) return [];
    return [
      {
        calendarId: calendar.id,
        start: start < rangeStart ? rangeStart : start,
        end: end > rangeEnd ? rangeEnd : end,
      },
    ];
  });
}

export function googleClient(config, execute = execFileSync) {
  return async (method, params, body) => {
    const write = ['events.insert', 'events.patch', 'events.delete'].includes(method);
    if (!write && !['calendarList.list', 'events.list', 'events.get'].includes(method))
      throw new Error('Unsupported calendar method.');
    const args = [
      'api',
      'call',
      'calendar',
      'v3',
      method,
      '--params',
      JSON.stringify(params),
      '--account',
      config.account,
      '--json',
      '--no-input',
    ];
    if (write) args.push('--allow-write', '--force');
    else args.push('--readonly');
    if (body) args.push('--body', JSON.stringify(body));
    try {
      const raw = execute(config.gog || '/opt/homebrew/bin/gog', args, {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      // Never emit CLI arguments, private payloads, or inherited environment in errors.
      const match = String(error.stderr || '').match(/(?:HTTP\s+|"code"\s*:\s*)(\d{3})/);
      const safe = new Error('Google Calendar request failed.');
      safe.status = match ? Number(match[1]) : 0;
      throw safe;
    }
  };
}

export async function listPages(call, method, params, maxPages = 20) {
  const items = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const result = await call(method, { ...params, ...(pageToken ? { pageToken } : {}) });
    if (!Array.isArray(result.items) && result.items !== undefined)
      throw new Error('Invalid calendar response.');
    items.push(...(result.items || []));
    if (!result.nextPageToken) return items;
    if (result.nextPageToken === pageToken) throw new Error('Repeated calendar page.');
    pageToken = result.nextPageToken;
  }
  throw new Error('Calendar pagination limit exceeded; snapshot not uploaded.');
}

export async function reconcileEvent(call, desired, settings, calendars, now = new Date()) {
  const receipt = {
    workoutId: desired.workoutId,
    eventId: desired.eventId,
    calendarId: desired.calendarId,
    updatedAt: now.toISOString(),
    ...(desired.fingerprint ? { fingerprint: desired.fingerprint } : {}),
  };
  try {
    if (
      !['upsert', 'delete'].includes(desired.status) ||
      !/^[0-9a-v]{5,1024}$/.test(desired.eventId) ||
      !desired.workoutId ||
      !desired.planId
    )
      throw new Error('Invalid workout event.');
    const calendar = calendars.find((item) => item.id === desired.calendarId);
    if (!calendar || !['owner', 'writer'].includes(calendar.accessRole))
      throw new Error('Calendar is not writable.');
    // Tombstones may target a former destination, but still require ownership proof.
    if (desired.status === 'upsert' && desired.calendarId !== settings.writeCalendarId)
      throw new Error('Destination is not selected.');
    const params = { calendarId: desired.calendarId, eventId: desired.eventId };
    let existing;
    try {
      existing = await call('events.get', params);
    } catch (error) {
      if (![404, 410].includes(error.status)) throw error;
    }
    if (existing?.status === 'cancelled') existing = undefined;
    if (existing && !isOwned(existing, desired)) throw new Error('Event ownership mismatch.');
    if (desired.status === 'delete') {
      if (existing) {
        await call('events.delete', { ...params, sendUpdates: 'none' });
        try {
          const remaining = await call('events.get', params);
          if (remaining.status !== 'cancelled')
            throw new Error('Calendar deletion readback mismatch.');
        } catch (error) {
          if (![404, 410].includes(error.status)) throw error;
        }
      }
      return { ...receipt, status: 'deleted' };
    }
    // Google Calendar stores event times with whole-second precision.
    const start = calendarInstant({ dateTime: desired.start }, desired.timeZone).replace(
      /\.\d{3}Z$/,
      '.000Z',
    );
    const end = calendarInstant({ dateTime: desired.end }, desired.timeZone).replace(
      /\.\d{3}Z$/,
      '.000Z',
    );
    if (
      end <= start ||
      Date.parse(start) < now.getTime() - DAY ||
      Date.parse(end) > now.getTime() + 180 * DAY
    )
      throw new Error('Workout outside sync horizon.');
    const body = {
      summary: String(desired.summary).slice(0, 200),
      description: String(desired.description || '').slice(0, 4000),
      start: { dateTime: start, timeZone: desired.timeZone },
      end: { dateTime: end, timeZone: desired.timeZone },
      extendedProperties: {
        private: { managedBy: OWNER, workoutId: desired.workoutId, planId: desired.planId },
      },
    };
    if (!existing) {
      try {
        existing = await call(
          'events.insert',
          { calendarId: desired.calendarId, sendUpdates: 'none' },
          { id: desired.eventId, ...body },
        );
      } catch (error) {
        if (error.status !== 409) throw error;
        existing = await call('events.get', params);
        if (!isOwned(existing, desired)) throw new Error('Event ownership mismatch.');
      }
    }
    if (!isOwned(existing, desired)) throw new Error('Event ownership mismatch.');
    const equal =
      existing.summary === body.summary &&
      (existing.description || '') === body.description &&
      calendarInstant(existing.start || {}, desired.timeZone) === start &&
      calendarInstant(existing.end || {}, desired.timeZone) === end;
    if (!equal) await call('events.patch', { ...params, sendUpdates: 'none' }, body);
    const verified = await call('events.get', params);
    if (
      !isOwned(verified, desired) ||
      verified.summary !== body.summary ||
      (verified.description || '') !== body.description ||
      calendarInstant(verified.start || {}, desired.timeZone) !== start ||
      calendarInstant(verified.end || {}, desired.timeZone) !== end
    )
      throw new Error('Calendar readback mismatch.');
    return { ...receipt, status: 'synced', scheduledStart: start, scheduledEnd: end };
  } catch (error) {
    return {
      ...receipt,
      status: 'error',
      error: error.status
        ? `Google Calendar request failed (${error.status}).`
        : error.message.slice(0, 160),
    };
  }
}

export async function runBridge(
  config,
  { call = googleClient(config), fetcher = fetch, now = new Date(), retrySelection = true } = {},
) {
  const origin = new URL(config.url);
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error('Configure an HTTPS origin.');
  if (
    typeof config.token !== 'string' ||
    config.token.length < 32 ||
    typeof config.account !== 'string'
  )
    throw new Error('Missing bridge configuration.');
  const request = async (route, body) => {
    const response = await fetcher(new URL(route, origin), {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`OpenStride calendar request failed (${response.status}).`);
    return response.json();
  };
  const { settings } = await request('/api/calendar/bridge');
  if (!settings) throw new Error('Invalid calendar bridge response.');
  const calendars = await listPages(
    call,
    'calendarList.list',
    { maxResults: 100, fields: 'items(id,summary,timeZone,accessRole,primary),nextPageToken' },
    10,
  );
  const rangeStart = new Date(now.getTime() - DAY).toISOString();
  const rangeEnd = new Date(now.getTime() + 179 * DAY).toISOString();
  const readIds =
    settings.readCalendarIds ?? calendars.filter((item) => item.primary).map((item) => item.id);
  if (readIds.some((id) => !calendars.some((item) => item.id === id)))
    throw new Error('Selected calendar is unavailable.');
  const busy = [];
  for (const calendar of calendars.filter((item) => readIds.includes(item.id))) {
    const events = await listPages(call, 'events.list', {
      calendarId: calendar.id,
      timeMin: rangeStart,
      timeMax: rangeEnd,
      singleEvents: true,
      maxResults: 250,
      fields:
        'items(id,status,transparency,start,end,attendees(self,responseStatus),extendedProperties/private),nextPageToken',
    });
    busy.push(...busySlots(events, calendar, rangeStart, rangeEnd));
  }
  if (busy.length > 2000) throw new Error('Calendar busy limit exceeded; snapshot not uploaded.');
  const payload = {
    calendars,
    readCalendarIds: calendars.filter((item) => readIds.includes(item.id)).map((item) => item.id),
    rangeStart,
    rangeEnd,
    busy,
    syncedAt: now.toISOString(),
    receipts: [],
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > 512 * 1024)
    throw new Error('Calendar snapshot exceeds upload limit.');
  await request('/api/calendar/import', payload);
  const fresh = await request('/api/calendar/bridge');
  if (!fresh.settings || !Array.isArray(fresh.desired) || fresh.desired.length > 1500)
    throw new Error('Invalid calendar bridge response.');
  if (JSON.stringify(fresh.settings) !== JSON.stringify(settings)) {
    if (retrySelection)
      return runBridge(config, { call, fetcher, now: new Date(), retrySelection: false });
    throw new Error('Calendar selection changed; retry sync.');
  }
  const receipts = [];
  let unchanged = 0;
  for (const event of fresh.desired) {
    const matching =
      event.fingerprint &&
      (fresh.receipts || []).some(
        (receipt) =>
          receipt.workoutId === event.workoutId &&
          receipt.calendarId === event.calendarId &&
          receipt.eventId === event.eventId &&
          receipt.fingerprint === event.fingerprint &&
          receipt.status === (event.status === 'delete' ? 'deleted' : 'synced'),
      );
    if (matching) {
      unchanged++;
      continue;
    }
    receipts.push(await reconcileEvent(call, event, settings, calendars, now));
  }
  const completed = { ...payload, syncedAt: new Date().toISOString(), receipts };
  if (Buffer.byteLength(JSON.stringify(completed)) > 512 * 1024)
    throw new Error('Calendar receipts exceed upload limit.');
  await request('/api/calendar/import', completed);
  return {
    syncedAt: now.toISOString(),
    calendars: calendars.length,
    busy: busy.length,
    unchanged,
    synced: receipts.filter((item) => item.status === 'synced').length,
    errors: receipts.filter((item) => item.status === 'error').length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const configPath =
    process.argv[2] || path.join(os.homedir(), '.config/openstride/calendar-bridge.json');
  try {
    const result = await runBridge(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    console.log(JSON.stringify(result));
    if (result.errors > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
