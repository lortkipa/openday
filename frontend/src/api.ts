// Small wrapper around the Go JSON API.

import { CLIENT_ID } from './live';
import type { Calendar, CalendarEvent, CalendarPatch, Draft, Settings } from './types';

// An event as the API sends it: times are ISO strings, and the fields that
// describe an occurrence are only present for repeating events.
type WireEvent = Omit<
  CalendarEvent,
  'start' | 'end' | 'reminders' | 'repeatUntil' | 'occurrence' | 'seriesStart' | 'seriesEnd'
> & {
  start: string;
  end: string;
  reminders: number[] | null;
  repeatUntil?: string | null;
  occurrence?: string;
  seriesStart?: string;
  seriesEnd?: string;
};

async function request<R>(method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(path, {
    method,
    // The client id lets the live stream tell other apps who made a change.
    headers: body
      ? { 'Content-Type': 'application/json', 'X-OpenDay-Client': CLIENT_ID }
      : { 'X-OpenDay-Client': CLIENT_ID },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null as R;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as R;
}

const ms = (iso?: string | null): number | null => (iso ? Date.parse(iso) : null);

const fromWire = (e: WireEvent): CalendarEvent => ({
  ...e,
  start: Date.parse(e.start),
  end: Date.parse(e.end),
  reminders: e.reminders || [],
  repeatUntil: ms(e.repeatUntil),
  occurrence: e.occurrence ? Date.parse(e.occurrence) : undefined,
  seriesStart: e.seriesStart ? Date.parse(e.seriesStart) : undefined,
  seriesEnd: e.seriesEnd ? Date.parse(e.seriesEnd) : undefined,
});

const toWire = (e: Draft) => ({
  calendarId: e.calendarId || 0,
  timeZone: e.timeZone || '',
  title: e.title,
  description: e.description,
  color: e.color,
  start: new Date(e.start).toISOString(),
  end: new Date(e.end).toISOString(),
  reminders: e.reminders || [],
  allDay: Boolean(e.allDay),
  repeat: e.repeat || '',
  repeatInterval: e.repeatInterval || 1,
  repeatWeekdays: e.repeatWeekdays || [],
  repeatUntil: e.repeatUntil ? new Date(e.repeatUntil).toISOString() : null,
});

export const api = {
  listEvents: async (start: number, end: number, tz: string): Promise<CalendarEvent[]> => {
    const q = new URLSearchParams({
      start: new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      end: new Date(end).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    // The primary time zone lets the server keep repeating events at their
    // clock time across daylight saving changes.
    if (tz) q.set('tz', tz);
    return (await request<WireEvent[]>('GET', `/api/events?${q}`)).map(fromWire);
  },
  createEvent: async (e: Draft) => fromWire(await request<WireEvent>('POST', '/api/events', toWire(e))),
  updateEvent: async (e: Draft) => fromWire(await request<WireEvent>('PUT', `/api/events/${e.id}`, toWire(e))),
  // occurrence: delete only that start of a repeating event.
  deleteEvent: (id: number, occurrence?: number) =>
    request<null>(
      'DELETE',
      `/api/events/${id}${occurrence ? `?occurrence=${encodeURIComponent(new Date(occurrence).toISOString())}` : ''}`,
    ),
  listCalendars: () => request<Calendar[]>('GET', '/api/calendars'),
  createCalendar: (c: CalendarPatch) => request<Calendar>('POST', '/api/calendars', c),
  // Only the fields in `patch` are changed.
  updateCalendar: (id: number, patch: CalendarPatch) => request<Calendar>('PUT', `/api/calendars/${id}`, patch),
  deleteCalendar: (id: number) => request<null>('DELETE', `/api/calendars/${id}`),
  getSettings: () => request<Partial<Settings>>('GET', '/api/settings'),
  updateSettings: (patch: Partial<Settings>) => request<Partial<Settings>>('PUT', '/api/settings', patch),
  // Backups are JSON objects (see backend/export.go). `calendar` limits the
  // backup to one calendar and its events, which is what undo uses.
  exportBackup: (calendarId?: number) =>
    request<unknown>('GET', `/api/export${calendarId ? `?calendar=${calendarId}` : ''}`),
  restoreBackup: (data: unknown) =>
    request<{ calendars: number; events: number }>('POST', '/api/import', data),
};
