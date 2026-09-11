import { describe, expect, it } from 'vitest';
// Standalone Node bridge runs independently of the Worker's TypeScript bundle.
import {
  busySlots,
  calendarInstant,
  googleClient,
  listPages,
  reconcileEvent,
  runBridge,
  // @ts-expect-error Standalone JavaScript module outside Worker source set.
} from '../scripts/calendar-bridge.mjs';

const now = new Date('2026-03-01T12:00:00Z');
const calendar = { id: 'personal', timeZone: 'America/Los_Angeles', accessRole: 'owner' };
const desired = {
  workoutId: 'w1',
  planId: 'p1',
  calendarId: 'personal',
  eventId: 'os0123456789abcdef',
  fingerprint: 'f'.repeat(64),
  start: '2026-03-08T08:00:00-07:00',
  end: '2026-03-08T09:00:00-07:00',
  timeZone: calendar.timeZone,
  summary: 'OpenStride easy run',
  description: 'Easy effort',
  status: 'upsert',
};
const properties = { private: { managedBy: 'openstride', workoutId: 'w1', planId: 'p1' } };
const existing = {
  id: desired.eventId,
  summary: desired.summary,
  description: desired.description,
  start: { dateTime: desired.start },
  end: { dateTime: desired.end },
  extendedProperties: properties,
};
const settings = { writeCalendarId: 'personal', readCalendarIds: ['personal'] };
const missing = () => Object.assign(new Error('Not found'), { status: 404 });

describe('calendar bridge privacy and timezone', () => {
  it('preserves an all-day date across the 23-hour DST day', () => {
    expect(calendarInstant({ date: '2026-03-08' }, calendar.timeZone)).toBe(
      '2026-03-08T08:00:00.000Z',
    );
    expect(calendarInstant({ date: '2026-03-09' }, calendar.timeZone)).toBe(
      '2026-03-09T07:00:00.000Z',
    );
  });
  it('uploads only clipped times, omitting transparent, declined and managed events', () => {
    const event = {
      summary: 'Private appointment',
      location: 'Private place',
      start: { dateTime: '2026-03-01T10:00:00Z' },
      end: { dateTime: '2026-03-01T14:00:00Z' },
    };
    const busy = busySlots(
      [
        event,
        { ...event, transparency: 'transparent' },
        { ...event, attendees: [{ self: true, responseStatus: 'declined' }] },
        { ...event, extendedProperties: properties },
      ],
      calendar,
      now.toISOString(),
      '2026-03-02T00:00:00.000Z',
    );
    expect(busy).toEqual([
      { calendarId: 'personal', start: now.toISOString(), end: '2026-03-01T14:00:00.000Z' },
    ]);
  });
  it('fails closed on unzoned times and truncated calendar enumeration', async () => {
    expect(() => calendarInstant({ dateTime: '2026-03-01T12:00:00' }, calendar.timeZone)).toThrow();
    await expect(
      listPages(async () => ({ items: [], nextPageToken: 'more' }), 'events.list', {}, 2),
    ).rejects.toThrow();
  });
});

describe('calendar event reconciliation', () => {
  it('performs no mutation when the stable owned event already matches', async () => {
    const calls: string[] = [];
    const result = await reconcileEvent(
      async (method: string) => {
        calls.push(method);
        return existing;
      },
      desired,
      settings,
      [calendar],
      now,
    );
    expect(result.status).toBe('synced');
    expect(calls).toEqual(['events.get', 'events.get']);
    expect(result.fingerprint).toBe(desired.fingerprint);
    expect(result.scheduledStart).toBe('2026-03-08T15:00:00.000Z');
    expect(result.scheduledEnd).toBe('2026-03-08T16:00:00.000Z');
  });
  it('reconciles insert conflicts without generating another event ID', async () => {
    const calls: string[] = [];
    let gets = 0;
    const result = await reconcileEvent(
      async (method: string) => {
        calls.push(method);
        if (method === 'events.get' && ++gets === 1) throw missing();
        if (method === 'events.insert') throw Object.assign(new Error('Conflict'), { status: 409 });
        return existing;
      },
      desired,
      settings,
      [calendar],
      now,
    );
    expect(result.status).toBe('synced');
    expect(calls.filter((method) => method === 'events.insert')).toHaveLength(1);
    expect(calls).not.toContain('events.patch');
  });
  it('refuses update and deletion of an event lacking its ownership marker', async () => {
    for (const status of ['upsert', 'delete']) {
      const calls: string[] = [];
      const result = await reconcileEvent(
        async (method: string) => {
          calls.push(method);
          return { ...existing, extendedProperties: {} };
        },
        { ...desired, status },
        settings,
        [calendar],
        now,
      );
      expect(result.status).toBe('error');
      expect(calls).toEqual(['events.get']);
    }
  });
  it('uses explicit owned tombstones only, including the former calendar', async () => {
    const calls: string[] = [];
    const result = await reconcileEvent(
      async (method: string) => {
        calls.push(method);
        if (calls.length === 3) throw missing();
        return existing;
      },
      { ...desired, status: 'delete' },
      { writeCalendarId: null },
      [calendar],
      now,
    );
    expect(result.status).toBe('deleted');
    expect(calls).toEqual(['events.get', 'events.delete', 'events.get']);
  });
  it('rejects a destination the user did not select before Google writes', async () => {
    const result = await reconcileEvent(
      async () => {
        throw new Error('Should not call Google');
      },
      desired,
      { writeCalendarId: null },
      [calendar],
      now,
    );
    expect(result.error).toBe('Destination is not selected.');
  });
  it('does not leak request payloads from CLI errors', async () => {
    const call = googleClient({ account: 'owner@example.com' }, () => {
      throw Object.assign(new Error('private payload'), { stderr: 'HTTP 403 secret body' });
    });
    await expect(call('events.get', {})).rejects.toMatchObject({
      message: 'Google Calendar request failed.',
      status: 403,
    });
  });
  it('uploads current busy snapshot before asking Worker for desired schedule', async () => {
    const routes: string[] = [];
    const result = await runBridge(
      { url: 'https://example.com', token: 'x'.repeat(32), account: 'owner@example.com' },
      {
        now,
        call: async (method: string) => ({
          items: method === 'calendarList.list' ? [calendar] : [],
        }),
        fetcher: async (url: URL, init: RequestInit) => {
          routes.push(`${init.method} ${url.pathname}`);
          if (init.method === 'POST')
            expect(JSON.parse(String(init.body)).readCalendarIds).toEqual(['personal']);
          return Response.json(init.method === 'GET' ? { settings, desired: [] } : { ok: true });
        },
      },
    );
    expect(result.errors).toBe(0);
    expect(routes).toEqual([
      'GET /api/calendar/bridge',
      'POST /api/calendar/import',
      'GET /api/calendar/bridge',
      'POST /api/calendar/import',
    ]);
  });
  it('marks the initial empty snapshot and rereads primary after discovery', async () => {
    let gets = 0;
    const captured: string[][] = [];
    const queried: string[] = [];
    await runBridge(
      { url: 'https://example.com', token: 'x'.repeat(32), account: 'owner@example.com' },
      {
        now,
        call: async (method: string, params: { calendarId?: string }) => {
          if (method === 'events.list') queried.push(params.calendarId || '');
          return { items: method === 'calendarList.list' ? [{ ...calendar, primary: true }] : [] };
        },
        fetcher: async (_url: URL, init: RequestInit) => {
          if (init.method === 'GET') {
            gets++;
            return Response.json({
              settings: gets === 1 ? { ...settings, readCalendarIds: [] } : settings,
              desired: [],
            });
          }
          captured.push(JSON.parse(String(init.body)).readCalendarIds);
          return Response.json({ ok: true });
        },
      },
    );
    expect(captured).toEqual([[], ['personal'], ['personal']]);
    expect(queried).toEqual(['personal']);
  });
  it('skips matching receipts but reconciles changed fingerprints and failures', async () => {
    const variants = [
      { fingerprint: desired.fingerprint, status: 'synced', unchanged: 1 },
      { fingerprint: 'old', status: 'synced', unchanged: 0 },
      { fingerprint: desired.fingerprint, status: 'error', unchanged: 0 },
    ];
    for (const variant of variants) {
      const eventCalls: string[] = [];
      const result = await runBridge(
        { url: 'https://example.com', token: 'x'.repeat(32), account: 'owner@example.com' },
        {
          now,
          call: async (method: string) => {
            if (method === 'calendarList.list') return { items: [calendar] };
            if (method === 'events.list') return { items: [] };
            eventCalls.push(method);
            return existing;
          },
          fetcher: async (_url: URL, init: RequestInit) =>
            Response.json(
              init.method === 'GET'
                ? {
                    settings,
                    desired: [desired],
                    receipts: [{ ...desired, ...variant }],
                  }
                : { ok: true },
            ),
        },
      );
      expect(result.unchanged).toBe(variant.unchanged);
      expect(eventCalls).toHaveLength(variant.unchanged ? 0 : 2);
      expect(result.synced).toBe(variant.unchanged ? 0 : 1);
    }
  });
  it('normalizes milliseconds that Google Calendar drops from event times', async () => {
    const result = await reconcileEvent(
      async () => existing,
      {
        ...desired,
        start: '2026-03-08T15:00:00.123Z',
        end: '2026-03-08T16:00:00.123Z',
      },
      settings,
      [calendar],
      now,
    );
    expect(result.status).toBe('synced');
    expect(result.scheduledStart).toBe('2026-03-08T15:00:00.000Z');
  });
});
