// Shared data types (they match the JSON of the Go API, see backend/api.go).

// A calendar groups events, like "Work" or "Family".
export interface Calendar {
  id: number;
  name: string;
  description: string;
  color: string;
  // IANA name, or '' for "same as the primary time zone".
  timeZone: string;
  hidden: boolean;
  primary: boolean;
}

// Fields sent when a calendar is created or changed.
export type CalendarPatch = Partial<Omit<Calendar, 'id' | 'primary'>>;

// How often an event repeats.
export type Repeat = '' | 'daily' | 'weekly' | 'monthly' | 'yearly';

// An event as the app keeps it: times are instants in milliseconds.
// All-day events are the exception: start and end are wall dates (UTC
// midnights), and end is exclusive (the day after the last day).
export interface CalendarEvent {
  id: number;
  calendarId: number;
  // IANA name, or '' for the primary time zone.
  timeZone: string;
  title: string;
  description: string;
  // '' means "use the calendar color".
  color: string;
  // Instants (ms), or wall dates for all-day events.
  start: number;
  end: number;
  // Minutes before the start.
  reminders: number[];
  allDay: boolean;
  repeat: Repeat;
  // Every N days, weeks, months or years.
  repeatInterval: number;
  // Weekdays of a weekly event (0 = Sunday).
  repeatWeekdays: number[];
  // Last allowed occurrence start (ms), or null for never.
  repeatUntil: number | null;

  // Set on the occurrences of a repeating event by GET /api/events.
  // `start`/`end` are this occurrence; `seriesStart`/`seriesEnd` are the
  // stored event. Editing uses the series times.
  occurrence?: number;
  seriesStart?: number;
  seriesEnd?: number;
}

// An event being created (no id yet) or edited in the form.
export interface Draft extends Omit<CalendarEvent, 'id'> {
  id?: number;
  // The user picked the time zone by hand (not saved).
  zoneSet?: boolean;
}

// An event as the views draw it: with wall times and the color to use.
export interface ShownEvent extends Omit<Draft, 'id'> {
  id: number | 'draft' | 'preview';
  isDraft: boolean;
  // Wall times (see time.ts).
  ws: number;
  we: number;
  dragging?: boolean;
}

export type DateFormat = 'MDY' | 'DMY' | 'YMD';
export type TimeFormat = '12h' | '24h';
export type Theme = 'system' | 'light' | 'dark';
export type NotificationMode = 'off' | 'desktop' | 'alerts';

export interface Settings {
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  // IANA name, or '' for the device time zone.
  timeZone: string;
  defaultDuration: number;
  theme: Theme;
  notifications: NotificationMode;
  snoozeBefore: number;
  notificationSound: boolean;
  // Minutes before the event, or -1 for none.
  defaultReminder: number;
  animations: boolean;
  keyboardShortcuts: boolean;
  otherTimeZones: string[];
  // First day of the week: 0 = Sunday, 1 = Monday, 6 = Saturday.
  weekStart: number;
  // The view the app opens in (also remembered across devices).
  defaultView: View;
  // Step for dragging events, in minutes (5, 10, 15 or 30).
  snapMinutes: number;
  // Calendar for new events, or 0 for the primary one.
  defaultCalendarId: number;
}

export type View = 'day' | 'week' | 'month' | 'year' | 'agenda';

// Where a floating card opens: next to this rectangle (screen pixels).
export interface Anchor {
  left: number;
  right: number;
  top: number;
}

// Props shared by the day/week grid and the month view.
export interface CalendarViewProps {
  settings: Settings;
  // Wall time of the start of today, and of now.
  today: number;
  nowWall: number;
  events: ShownEvent[];
  // A press on an empty part of the calendar. Returns true if it may create an event.
  onSurfacePointerDown: () => boolean;
  onEventClick: (ev: ShownEvent, anchor: Anchor) => void;
  onEventContext: (ev: ShownEvent, x: number, y: number) => void;
  onDayClick: (day: number) => void;
}
