import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import * as T from './time';
import { colorOf } from './colors';
import { calendarZone, sortCalendars } from './calendars';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import TimeGrid from './components/TimeGrid';
import MonthView from './components/MonthView';
import YearView from './components/YearView';
import AgendaView from './components/AgendaView';
import EventEditor from './components/EventEditor';
import DeleteRepeatDialog from './components/DeleteRepeatDialog';
import EventDetails from './components/EventDetails';
import ContextMenu from './components/ContextMenu';
import CalendarMenu from './components/CalendarMenu';
import SettingsPage from './components/SettingsPage';
import AppearanceDialog from './components/AppearanceDialog';
import ShortcutsDialog from './components/ShortcutsDialog';
import Snackbar from './components/Snackbar';
import NotificationAlert from './components/NotificationAlert';
import { describeWhen } from './components/EventDetails';
import { useNotifications } from './notifications';
import { useLiveUpdates } from './live';
import { useMedia, NARROW, PHONE, TOUCH } from './useMedia';
import { useExit } from './motion';
import type { Exit } from './motion';
import type { SnackMessage } from './components/Snackbar';
import type { ExtraZone } from './components/TimeGrid';
import type { SlimEvent } from './notifications';
import type { TouchEvent as ReactTouchEvent } from 'react';
import type {
  Anchor,
  Calendar,
  CalendarEvent,
  CalendarPatch,
  Draft,
  Settings,
  ShownEvent,
  Theme,
  View,
} from './types';

const DEFAULT_SETTINGS: Settings = {
  dateFormat: 'MDY',
  timeFormat: '12h',
  timeZone: '',
  defaultDuration: 60,
  theme: 'system',
  notifications: 'desktop',
  snoozeBefore: 1,
  notificationSound: true,
  defaultReminder: 30,
  animations: true,
  keyboardShortcuts: true,
  otherTimeZones: [],
  weekStart: 0,
  defaultView: 'week',
  snapMinutes: 15,
  defaultCalendarId: 0,
};

const VIEWS: View[] = ['day', 'week', 'month', 'year', 'agenda'];

// Small per-browser preferences (current view, sidebar open).
function useLocalState<V>(key: string, initial: V) {
  const [value, setValue] = useState<V>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage not available: ignore */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

function useResolvedTheme(theme: Theme) {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  return resolved;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const tz = settings.timeZone || T.browserTimeZone();
  useResolvedTheme(settings.theme);
  useEffect(() => {
    document.documentElement.dataset.motion = settings.animations ? 'on' : 'off';
  }, [settings.animations]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  const nowWall = T.toWall(now, tz);
  const today = T.startOfDay(nowWall);

  // The view is a setting (last used), so it follows the user across devices.
  const [view, setViewState] = useState<View>('week');
  const viewChosen = useRef(false);
  useEffect(() => {
    if (!viewChosen.current) setViewState(settings.defaultView);
  }, [settings.defaultView]);
  const setView = (v: View) => {
    if (!VIEWS.includes(v)) return;
    viewChosen.current = true;
    setViewState(v);
    if (settings.defaultView !== v) updateSettings({ defaultView: v });
  };
  const [cursor, setCursor] = useState(() => T.startOfDay(T.toWall(Date.now(), T.browserTimeZone())));
  const narrow = useMedia(NARROW);
  const phone = useMedia(PHONE);
  const touch = useMedia(TOUCH);
  // Shortcut hints and the shortcuts dialog are hidden on phones and touch devices.
  const showShortcuts = !phone && !touch;
  // On wide screens the sidebar choice is remembered. On phones the sidebar
  // floats over the calendar, so it always starts closed.
  const [wideSidebar, setWideSidebar] = useLocalState('openday.sidebarOpen', true);
  const [phoneSidebar, setPhoneSidebar] = useState(false);
  const sidebarOpen = narrow ? phoneSidebar : wideSidebar;
  const setSidebarOpen = narrow ? setPhoneSidebar : setWideSidebar;
  useEffect(() => {
    if (!narrow) setPhoneSidebar(false);
  }, [narrow]);
  // The form always opens floating. The user can dock it; it undocks again when closed.
  const [dockedChoice, setDocked] = useState(false);
  // Phones have no docking: the form is a sheet stuck to the bottom.
  const docked = dockedChoice && !phone;
  const [page, setPage] = useState<'calendar' | 'settings'>('calendar');
  // Section to show when the settings page opens (e.g. "calendar-3").
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  const [calendarListOpen, setCalendarListOpen] = useLocalState('openday.calendarListOpen', true);

  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventsVersion, setEventsVersion] = useState(0); // goes up when events changed elsewhere
  const [draft, setDraft] = useState<Draft | null>(null); // event being created (no id) or edited
  const [editorAnchor, setEditorAnchor] = useState<Anchor | null>(null);
  // Occurrences of a repeating event share an id, so the card remembers the occurrence.
  const [details, setDetails] = useState<{ id: number; occurrence?: number; anchor: Anchor } | null>(null);
  const [menu, setMenu] = useState<{ id: number; occurrence?: number; x: number; y: number } | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<CalendarEvent | null>(null);
  const [calMenu, setCalMenu] = useState<{ id: number; x: number; y: number } | null>(null); // options of a calendar
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [snack, setSnack] = useState<SnackMessage | null>(null);

  const formOpen = draft !== null;
  useEffect(() => {
    if (!formOpen) setDocked(false);
  }, [formOpen]);

  const describe = (event: SlimEvent) => describeWhen(event, tz, settings);
  // Load reminders again when events change (here or, in year view, elsewhere).
  const notifyKey = useMemo(() => ({}), [events, eventsVersion]);
  const { alerts, dismissAlerts } = useNotifications({ settings, describe, changeKey: notifyKey });
  const alertExit = useExit(alerts.length > 0 ? alerts : null);
  const alertBox = alertExit.shown && (
    <NotificationAlert
      key={`alert-${alertExit.key}`}
      alerts={alertExit.shown}
      describe={describe}
      onClose={dismissAlerts}
      closing={alertExit.phase === 'exit'}
    />
  );
  const snackExit = useExit(snack);
  const snackBar = snackExit.shown && (
    <Snackbar
      key={`snack-${snackExit.key}`}
      {...snackExit.shown}
      onClose={() => setSnack(null)}
      closing={snackExit.phase === 'exit'}
    />
  );

  const showError = useCallback(
    (err: unknown) => setSnack({ text: (err instanceof Error && err.message) || String(err) }),
    [],
  );

  // ---- Load settings and calendars ----
  const loadSettings = useCallback(
    () => api.getSettings().then((s) => setSettings({ ...DEFAULT_SETTINGS, ...s }), showError),
    [showError],
  );
  const loadCalendars = useCallback(
    () => api.listCalendars().then((list) => setCalendars(sortCalendars(list)), showError),
    [showError],
  );
  useEffect(() => {
    loadSettings();
    loadCalendars();
  }, [loadSettings, loadCalendars]);

  // Changes made in another tab, browser or the desktop app show up right away.
  useLiveUpdates((topic) => {
    if (topic === 'settings') loadSettings();
    else if (topic === 'calendars') loadCalendars();
    else setEventsVersion((v) => v + 1);
  });

  const updateSettings = async (patch: Partial<Settings>) => {
    const before = settings;
    setSettings({ ...settings, ...patch });
    try {
      setSettings({ ...DEFAULT_SETTINGS, ...(await api.updateSettings(patch)) });
    } catch (err) {
      setSettings(before);
      showError(err);
    }
  };

  // ---- Calendars ----
  const calById = useMemo(
    (): Partial<Record<number, Calendar>> => Object.fromEntries(calendars.map((c) => [c.id, c])),
    [calendars],
  );
  const primaryCal: Calendar | undefined = calendars.find((c) => c.primary) || calendars[0];

  // Change some fields of a calendar (name, description, color, hidden).
  const updateCalendar = async (id: number, patch: CalendarPatch) => {
    const before = calById[id];
    if (!before) return;
    setCalendars((list) => sortCalendars(list.map((c) => (c.id === id ? { ...c, ...patch } : c))));
    try {
      const saved = await api.updateCalendar(id, patch);
      setCalendars((list) => sortCalendars(list.map((c) => (c.id === id ? saved : c))));
    } catch (err) {
      setCalendars((list) => sortCalendars(list.map((c) => (c.id === id ? before : c))));
      showError(err);
    }
  };

  // Show only this calendar ("Display this only").
  const showOnlyCalendar = (id: number) => {
    for (const c of calendars) {
      if (c.hidden !== (c.id !== id)) updateCalendar(c.id, { hidden: c.id !== id });
    }
  };

  const createCalendar = async (fields: CalendarPatch) => {
    try {
      const created = await api.createCalendar(fields);
      setCalendars((list) => sortCalendars([...list, created]));
      setSnack({ text: 'Calendar created' });
      return created;
    } catch (err) {
      showError(err);
      return null;
    }
  };

  // Deletes the calendar and all of its events (the server does the same).
  // A backup is taken first, so Undo can put the calendar and its events back.
  const deleteCalendar = async (id: number) => {
    let backup: unknown;
    try {
      backup = await api.exportBackup(id);
    } catch (err) {
      showError(err);
      return false;
    }
    try {
      await api.deleteCalendar(id);
    } catch (err) {
      showError(err);
      return false;
    }
    setCalendars((list) => list.filter((c) => c.id !== id));
    setEvents((list) => list.filter((e) => e.calendarId !== id));
    setDraft((d) => (d && d.calendarId === id ? null : d));
    setDetails(null);
    setMenu(null);
    setCalMenu(null);
    setSnack({
      text: 'Calendar deleted',
      action: 'Undo',
      onAction: async () => {
        try {
          const res = await api.restoreBackup(backup);
          await loadCalendars();
          setEventsVersion((v) => v + 1);
          setSnack({ text: res.calendars === 1 ? 'Calendar restored' : `${res.calendars} calendars restored` });
        } catch (err) {
          showError(err);
        }
      },
    });
    return true;
  };

  // Restore a backup file chosen in Settings. It only adds data.
  const restoreBackup = async (data: unknown) => {
    const res = await api.restoreBackup(data);
    await loadCalendars();
    setEventsVersion((v) => v + 1);
    setSnack({ text: `Restored ${res.calendars} calendar(s) and ${res.events} event(s)` });
    return res;
  };

  // When the time zone changes, keep showing the same calendar day.
  const prevTz = useRef(tz);
  useEffect(() => {
    if (prevTz.current !== tz) {
      prevTz.current = tz;
      setCursor(T.startOfDay(T.toWall(Date.now(), tz)));
    }
  }, [tz]);

  // ---- Visible range and events ----
  const range = useMemo((): [number, number] | null => {
    const day = T.startOfDay(cursor);
    if (view === 'day') return [day, T.addDays(day, 1)];
    if (view === 'week') {
      const s = T.startOfWeek(cursor, settings.weekStart);
      return [s, T.addDays(s, 7)];
    }
    if (view === 'month') {
      const days = T.monthGridDays(cursor, settings.weekStart);
      return [days[0], T.addDays(days[days.length - 1], 1)];
    }
    if (view === 'agenda') return [day, T.addDays(day, 30)];
    return null;
  }, [view, cursor, settings.weekStart]);

  const rangeKey = range ? `${range[0]}-${range[1]}-${tz}` : 'none';
  useEffect(() => {
    if (!range) return undefined;
    let cancelled = false;
    api
      .listEvents(T.fromWall(range[0], tz), T.fromWall(range[1], tz), tz)
      .then((list) => !cancelled && setEvents(list), (err) => !cancelled && showError(err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, eventsVersion, showError]);

  // Events with wall times, with the draft shown in place of the saved event.
  // Events of hidden calendars are left out (but not the one being edited).
  // `color` is the color to draw: the event's own, or its calendar's.
  const shownEvents = useMemo((): ShownEvent[] => {
    let list: (Omit<CalendarEvent, 'id'> & { id: ShownEvent['id']; zoneSet?: boolean })[] = events;
    if (draft) {
      const d = draft;
      // While editing, the draft stands in for the whole series (occurrences
      // share an id, so they are all taken out and one draft is shown).
      list = d.id
        ? [...events.filter((e) => e.id !== d.id), { ...d, id: d.id }]
        : [...events, { ...d, id: 'draft' as const }];
    }
    return list
      .filter((e) => !calById[e.calendarId]?.hidden || (draft && (e.id === 'draft' || e.id === draft.id)))
      .map((e) => ({
        ...e,
        color: colorOf(e, calById[e.calendarId]),
        isDraft: e.id === 'draft',
        // All-day events are calendar dates, not instants: they need no
        // time zone conversion.
        ws: e.allDay ? e.start : T.toWall(e.start, tz),
        we: e.allDay ? e.end : T.toWall(e.end, tz),
      }));
  }, [events, draft, tz, calById]);
  // Color of an event that is being drawn with the mouse (before the form opens).
  const newEventColor = colorOf({}, (draft && !draft.id && calById[draft.calendarId]) || primaryCal);

  // ---- Navigation ----
  const go = (dir: number) => {
    if (view === 'day') setCursor((c) => T.addDays(c, dir));
    else if (view === 'week') setCursor((c) => T.addDays(c, 7 * dir));
    else if (view === 'month') setCursor((c) => T.addMonths(c, dir));
    else if (view === 'agenda') setCursor((c) => T.addDays(c, 30 * dir));
    else setCursor((c) => T.addMonths(c, 12 * dir));
  };
  const openDay = (day: number) => {
    setCursor(day);
    setView('day');
  };

  // ---- Popups ----
  const closePopups = () => {
    setDetails(null);
    setMenu(null);
    setCalMenu(null);
  };

  // Called when the user presses on an empty part of the calendar.
  // Returns true if that press should start creating an event.
  const onSurfacePointerDown = () => {
    if (details || menu || calMenu) {
      closePopups();
      return false;
    }
    if (draft && draft.id && !docked) {
      setDraft(null);
      return false;
    }
    return true;
  };

  // ---- Create / edit ----
  // New events go to the default calendar from Settings (or the primary one).
  const defaultCal = () =>
    (settings.defaultCalendarId ? calById[settings.defaultCalendarId] : undefined) || primaryCal;

  const startDraft = (wallStart: number, wallEnd: number, anchor: Anchor | null) => {
    closePopups();
    const start = T.fromWall(wallStart, tz);
    const end = T.fromWall(wallEnd, tz);
    setDraft((d) =>
      d && !d.id
        ? { ...d, start, end }
        : {
            calendarId: defaultCal()?.id || 0,
            timeZone: calendarZone(defaultCal(), tz), // the calendar's time zone
            title: '',
            description: '',
            color: '', // calendar color
            start,
            end,
            reminders: settings.defaultReminder >= 0 ? [settings.defaultReminder] : [],
            allDay: false,
            repeat: '',
            repeatInterval: 1,
            repeatWeekdays: [],
            repeatUntil: null,
          },
    );
    setEditorAnchor(anchor || null);
  };

  // Clicking the all-day row creates a one-day all-day event (dates can be
  // changed in the form).
  const startAllDay = (day: number, anchor: Anchor | null) => {
    closePopups();
    setDraft({
      calendarId: defaultCal()?.id || 0,
      timeZone: '',
      title: '',
      description: '',
      color: '',
      start: T.startOfDay(day),
      end: T.addDays(T.startOfDay(day), 1),
      reminders: settings.defaultReminder >= 0 ? [settings.defaultReminder] : [],
      allDay: true,
      repeat: '',
      repeatInterval: 1,
      repeatWeekdays: [],
      repeatUntil: null,
    });
    setEditorAnchor(anchor);
  };

  // Swipe left/right on the calendar to go to the next/previous period (phones).
  const swipe = useRef<{ x: number; y: number; time: number } | null>(null);
  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    swipe.current =
      e.touches.length === 1 && !(e.target as Element).closest('.ev, .mv-ev, [data-popover]')
        ? { x: t.clientX, y: t.clientY, time: Date.now() }
        : null;
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    const s0 = swipe.current;
    swipe.current = null;
    if (!s0 || draft) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s0.x;
    const dy = t.clientY - s0.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - s0.time < 700) go(dx < 0 ? 1 : -1);
  };

  // `focus`: id of the settings section to scroll to, e.g. "calendar-3".
  const openSettings = (focus: string | null = null) => {
    setDraft(null);
    setShortcutsOpen(false);
    closePopups();
    setPhoneSidebar(false);
    setSettingsFocus(focus);
    setPage('settings');
  };

  const createFromButton = () => {
    if (narrow) setPhoneSidebar(false);
    const hour = new Date(nowWall).getUTCHours() + 1;
    const start = T.startOfDay(cursor) + Math.min(hour, 23) * T.HOUR;
    startDraft(start, start + settings.defaultDuration * T.MINUTE, null);
  };

  const editEvent = (id: number, occurrence: number | undefined, anchor: Anchor | null) => {
    const ev = events.find((e) => e.id === id && (e.occurrence ?? 0) === (occurrence ?? 0));
    if (!ev) return;
    closePopups();
    // Editing an occurrence edits the whole series: show its first occurrence.
    setDraft({
      ...ev,
      start: ev.seriesStart ?? ev.start,
      end: ev.seriesEnd ?? ev.end,
      occurrence: undefined,
      seriesStart: undefined,
      seriesEnd: undefined,
    });
    setEditorAnchor(anchor || null);
  };

  // A copy of the event (same fields, new event).
  const duplicateEvent = (ev: CalendarEvent) => {
    closePopups();
    setDraft({
      ...ev,
      id: undefined,
      occurrence: undefined,
      seriesStart: undefined,
      seriesEnd: undefined,
      start: ev.seriesStart ?? ev.start,
      end: ev.seriesEnd ?? ev.end,
    });
    setEditorAnchor(null);
  };

  const saveDraft = async () => {
    const d = draft;
    if (!d) return;
    setDraft(null);
    try {
      const saved = d.id ? await api.updateEvent(d) : await api.createEvent(d);
      if (saved.repeat || d.repeat) {
        // The saved event expands into several occurrences: load them again.
        setEventsVersion((v) => v + 1);
      } else {
        setEvents((list) => (d.id ? list.map((e) => (e.id === saved.id ? saved : e)) : [...list, saved]));
      }
      // Saved into a hidden calendar: show that calendar, so the event does not vanish.
      if (calById[saved.calendarId]?.hidden) updateCalendar(saved.calendarId, { hidden: false });
      setSnack({ text: 'Event saved' });
    } catch (err) {
      setDraft(d);
      showError(err);
    }
  };

  // Delete one occurrence ('this') or the whole series ('all').
  const deleteEvent = async (ev: CalendarEvent, mode: 'this' | 'all' = 'all') => {
    closePopups();
    if (draft && draft.id === ev.id) setDraft(null);
    const occurrence = mode === 'this' ? ev.occurrence ?? ev.start : undefined;
    const same = (e: CalendarEvent) =>
      e.id === ev.id && (mode === 'all' || (e.occurrence ?? 0) === (ev.occurrence ?? 0));
    setEvents((list) => list.filter((e) => !same(e)));
    try {
      await api.deleteEvent(ev.id, occurrence);
      if (ev.repeat) {
        // Occurrences are made by the server: load the remaining ones again.
        setEventsVersion((v) => v + 1);
        setSnack({ text: mode === 'this' ? 'Event deleted' : 'Repeating events deleted' });
        return;
      }
      setSnack({
        text: 'Event deleted',
        action: 'Undo',
        onAction: async () => {
          try {
            const restored = await api.createEvent(ev);
            setEvents((list) => [...list, restored]);
          } catch (err) {
            showError(err);
          }
        },
      });
    } catch (err) {
      setEventsVersion((v) => v + 1);
      showError(err);
    }
  };

  // A repeating event asks before deleting: one occurrence or the series?
  const askDelete = (ev: CalendarEvent) => {
    if (ev.repeat) setDeleteAsk(ev);
    else void deleteEvent(ev);
  };

  // Save a change to a saved event right away (drag, resize, color).
  const patchEvent = async (id: number, patch: Partial<CalendarEvent>) => {
    const ev = events.find((e) => e.id === id);
    if (!ev) return;
    const next = { ...ev, ...patch };
    if (!ev.repeat) setEvents((list) => list.map((e) => (e.id === id ? next : e)));
    if (draft && draft.id === id) setDraft((d) => d && { ...d, ...patch });
    try {
      const saved = await api.updateEvent(next);
      if (ev.repeat) setEventsVersion((v) => v + 1);
      else setEvents((list) => list.map((e) => (e.id === id ? saved : e)));
    } catch (err) {
      if (ev.repeat) setEventsVersion((v) => v + 1);
      else setEvents((list) => list.map((e) => (e.id === id ? ev : e)));
      showError(err);
    }
  };

  const onEventTimeChange = (ev: ShownEvent, wallStart: number, wallEnd: number) => {
    if (ev.allDay) return; // all-day bars are changed in the form
    const patch = { start: T.fromWall(wallStart, tz), end: T.fromWall(wallEnd, tz) };
    if (ev.isDraft || (draft && draft.id === ev.id)) setDraft((d) => d && { ...d, ...patch });
    else if (typeof ev.id === 'number') {
      if (ev.repeat && ev.seriesStart !== undefined && ev.seriesEnd !== undefined) {
        // Moving an occurrence moves the whole series by the same amount.
        patchEvent(ev.id, {
          start: ev.seriesStart + (patch.start - ev.start),
          end: ev.seriesEnd + (patch.end - ev.end),
        });
      } else patchEvent(ev.id, patch);
    }
  };

  const onEventClick = (ev: ShownEvent, anchor: Anchor) => {
    if (ev.isDraft || typeof ev.id !== 'number') return;
    if (draft && !docked) setDraft(null);
    if (draft && docked && draft.id === ev.id) return;
    setMenu(null);
    setDetails({ id: ev.id, occurrence: ev.occurrence, anchor });
  };

  const onEventContext = (ev: ShownEvent, x: number, y: number) => {
    if (ev.isDraft || typeof ev.id !== 'number') return;
    setDetails(null);
    setMenu({ id: ev.id, occurrence: ev.occurrence, x, y });
  };

  // ---- Keyboard shortcuts (like the classic calendar ones) ----
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (alerts.length) {
      if (e.key === 'Escape') dismissAlerts();
      return;
    }
    if (e.key === 'Escape') {
      if (menu || details || calMenu) closePopups();
      else if (appearanceOpen) setAppearanceOpen(false);
      else if (shortcutsOpen) setShortcutsOpen(false);
      else if (draft) setDraft(null);
      return;
    }
    // Everything below can be turned off in Settings → Keyboard shortcuts.
    if (!settings.keyboardShortcuts) return;
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (e.ctrlKey || e.metaKey || e.altKey || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (target.isContentEditable) return;
    if (page !== 'calendar' || draft || appearanceOpen || shortcutsOpen) return;
    const k = e.key.toLowerCase();
    if (k === '?') {
      closePopups();
      setShortcutsOpen(true);
    } else if (k === 'd') setView('day');
    else if (k === 'w') setView('week');
    else if (k === 'm') setView('month');
    else if (k === 'y') setView('year');
    else if (k === 'a') setView('agenda');
    else if (k === 't') setCursor(today);
    else if (k === 'j' || k === 'n') go(1);
    else if (k === 'k' || k === 'p') go(-1);
    else if (k === 'c') createFromButton();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- Things that animate when they open and close (see motion.js) ----
  // They stay on the page for a moment after closing, showing what they
  // showed last. Hooks must run before the early return below.
  const detailsEvent =
    details && events.find((e) => e.id === details.id && (e.occurrence ?? 0) === (details.occurrence ?? 0));
  const detailsExit = useExit(details && detailsEvent ? { event: detailsEvent, anchor: details.anchor } : null);
  const appearanceExit = useExit(appearanceOpen);
  const shortcutsExit = useExit(shortcutsOpen);
  const deleteAskExit = useExit(deleteAsk);
  const menuEvent = menu && events.find((e) => e.id === menu.id && (e.occurrence ?? 0) === (menu.occurrence ?? 0));
  const menuExit = useExit(menu && menuEvent ? { event: menuEvent, x: menu.x, y: menu.y } : null);
  const calMenuCalendar = calMenu && calById[calMenu.id];
  const calMenuExit = useExit(
    calMenu && calMenuCalendar ? { calendar: calMenuCalendar, x: calMenu.x, y: calMenu.y } : null,
  );
  // Plain variables, so TypeScript keeps them non-null inside callbacks.
  const detailsShown = detailsExit.shown;
  const menuShown = menuExit.shown;
  const calMenuShown = calMenuExit.shown;
  // The form is floating or docked. Moving it between the two plays the
  // closing animation of one and the opening animation of the other.
  const floatExit = useExit(!docked ? draft : null);
  const dockExit = useExit(docked ? draft : null);
  // The docked form takes the sidebar's place, so the sidebar closes meanwhile.
  const sidebarExit = useExit(sidebarOpen && !(docked && draft));

  // ---- Render ----
  if (page === 'settings') {
    return (
      <>
        <SettingsPage
          settings={settings}
          onChange={updateSettings}
          onBack={() => setPage('calendar')}
          focus={settingsFocus}
          calendars={calendars}
          onCreateCalendar={createCalendar}
          onUpdateCalendar={updateCalendar}
          onDeleteCalendar={deleteCalendar}
          onRestore={restoreBackup}
          showShortcuts={showShortcuts}
          onViewShortcuts={() => {
            setPage('calendar');
            setShortcutsOpen(true);
          }}
        />
        {snackBar}
        {alertBox}
      </>
    );
  }

  const common = {
    settings,
    today,
    nowWall,
    events: shownEvents,
    onSurfacePointerDown,
    onEventClick,
    onEventContext,
    onDayClick: openDay,
  };

  // Other time zones get their own hour column in the day/week grid
  // (not on phones: no room). `shift`: minutes ahead of the primary time zone,
  // measured in the middle of the first shown day.
  const refInstant = range ? T.fromWall(range[0] + 12 * T.HOUR, tz) : now;
  const extraZones: ExtraZone[] = phone
    ? []
    : settings.otherTimeZones
        .filter((z) => z !== tz)
        .map((z) => ({
          tz: z,
          label: T.gmtShort(z, refInstant),
          shift: T.offsetMinutes(z, refInstant) - T.offsetMinutes(tz, refInstant),
        }));

  let main;
  if (view === 'day' || view === 'week') {
    const first = view === 'day' ? T.startOfDay(cursor) : T.startOfWeek(cursor);
    const days = Array.from({ length: view === 'day' ? 1 : 7 }, (_, i) => T.addDays(first, i));
    main = (
      <TimeGrid
        {...common}
        key={view}
        days={days}
        newEventColor={newEventColor}
        tzLabel={gmtLabel(now, nowWall)}
        tzName={tz}
        extraZones={extraZones}
        onCreate={startDraft}
        onCreateAllDay={startAllDay}
        onEventTimeChange={onEventTimeChange}
        onInteract={closePopups}
      />
    );
  } else if (view === 'month') {
    main = (
      <MonthView
        {...common}
        cursor={cursor}
        onCreate={(day, anchor) => {
          const start = day + 9 * T.HOUR;
          startDraft(start, start + settings.defaultDuration * T.MINUTE, anchor);
        }}
      />
    );
  } else if (view === 'agenda' && range) {
    main = <AgendaView {...common} from={range[0]} days={30} calendars={calendars} />;
  } else {
    main = (
      <YearView cursor={cursor} today={today} onDayClick={openDay} weekStart={settings.weekStart} />
    );
  }

  // A closing form shows the last draft and ignores the user.
  const noop = () => {};
  const renderEditor = ({ shown, phase, key }: Exit<Draft>, isDocked: boolean) => {
    if (!shown) return null;
    const closing = phase === 'exit';
    return (
      <EventEditor
        key={`editor-${isDocked}-${key}`}
        draft={shown}
        calendars={calendars}
        settings={settings}
        tz={tz}
        today={today}
        docked={isDocked}
        closing={closing}
        anchor={editorAnchor}
        onChange={closing ? noop : (patch) => setDraft((d) => d && { ...d, ...patch })}
        onSave={closing ? noop : saveDraft}
        onClose={closing ? noop : () => setDraft(null)}
        onDelete={
          shown.id && !closing
            ? () => {
                const ev = events.find((e) => e.id === shown.id);
                // The form edits the series; the details card and menu offer
                // "this event" for one occurrence.
                if (ev) void deleteEvent(ev, 'all');
              }
            : null
        }
        sheet={phone}
        onToggleDock={phone || closing ? null : () => setDocked(!docked)}
      />
    );
  };
  const dockClosing = dockExit.phase === 'exit';
  const sidebarClosing = sidebarExit.phase === 'exit';

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to calendar
      </a>
      <Header
        view={view}
        cursor={cursor}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onToday={() => setCursor(today)}
        onPrev={() => go(-1)}
        onNext={() => go(1)}
        onView={setView}
        onOpenSettings={() => openSettings()}
        onOpenAppearance={() => setAppearanceOpen(true)}
        onOpenShortcuts={showShortcuts ? () => setShortcutsOpen(true) : null}
        shortcuts={showShortcuts && settings.keyboardShortcuts}
        weekStart={settings.weekStart}
      />
      <div className="app-body">
        {/* Docked form takes the sidebar's place on the left, like the classic calendar. */}
        {dockExit.shown && (
          <aside key={`dock-${dockExit.key}`} className={`dock ${dockClosing ? 'closing' : ''}`} inert={dockClosing || undefined}>
            {renderEditor(dockExit, true)}
          </aside>
        )}
        {sidebarExit.shown && (
          <>
            {narrow && (
              <div
                className={`sidebar-backdrop ${sidebarExit.phase === 'enter' ? 'entering' : ''} ${sidebarClosing ? 'closing' : ''}`}
                onClick={sidebarClosing ? undefined : () => setPhoneSidebar(false)}
              />
            )}
            <Sidebar
              cursor={cursor}
              today={today}
              phase={sidebarExit.phase}
              onCreate={createFromButton}
              onOpenSettings={() => openSettings()}
              calendarList={{
                calendars,
                open: calendarListOpen,
                onToggleOpen: () => setCalendarListOpen(!calendarListOpen),
                onCreate: () => openSettings('create-calendar'),
                onToggle: (c) => updateCalendar(c.id, { hidden: !c.hidden }),
                onMenu: (c, x, y) => {
                  setDetails(null);
                  setMenu(null);
                  setCalMenu({ id: c.id, x, y });
                },
              }}
              shortcuts={showShortcuts && settings.keyboardShortcuts}
              weekStart={settings.weekStart}
              onPick={(d) => {
                setCursor(d);
                if (narrow) setPhoneSidebar(false);
              }}
            />
          </>
        )}
        <main id="main" tabIndex={-1} className="main" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {main}
        </main>
      </div>

      {renderEditor(floatExit, false)}
      {detailsShown && (
        <EventDetails
          key={`details-${detailsExit.key}`}
          event={detailsShown.event}
          calendar={calById[detailsShown.event.calendarId]}
          tz={tz}
          settings={settings}
          anchor={detailsShown.anchor}
          closing={detailsExit.phase === 'exit'}
          onClose={() => setDetails(null)}
          onEdit={() => editEvent(detailsShown.event.id, detailsShown.event.occurrence, detailsShown.anchor)}
          onDelete={() => askDelete(detailsShown.event)}
          onDuplicate={() => duplicateEvent(detailsShown.event)}
        />
      )}
      {menuShown && (
        <ContextMenu
          key={`menu-${menuExit.key}`}
          event={menuShown.event}
          calendar={calById[menuShown.event.calendarId]}
          x={menuShown.x}
          y={menuShown.y}
          closing={menuExit.phase === 'exit'}
          onClose={() => setMenu(null)}
          onColor={(color) => {
            setMenu(null);
            patchEvent(menuShown.event.id, { color });
          }}
          onEdit={() =>
            editEvent(menuShown.event.id, menuShown.event.occurrence, {
              left: menuShown.x,
              right: menuShown.x,
              top: menuShown.y,
            })
          }
          onDelete={() => askDelete(menuShown.event)}
          onDuplicate={() => duplicateEvent(menuShown.event)}
        />
      )}
      {calMenuShown && (
        <CalendarMenu
          key={`calmenu-${calMenuExit.key}`}
          calendar={calMenuShown.calendar}
          x={calMenuShown.x}
          y={calMenuShown.y}
          closing={calMenuExit.phase === 'exit'}
          onClose={() => setCalMenu(null)}
          onOnly={() => {
            setCalMenu(null);
            showOnlyCalendar(calMenuShown.calendar.id);
          }}
          onSettings={() => openSettings(`calendar-${calMenuShown.calendar.id}`)}
          onColor={(color) => {
            setCalMenu(null);
            updateCalendar(calMenuShown.calendar.id, { color });
          }}
        />
      )}
      {appearanceExit.shown && (
        <AppearanceDialog
          key={`appearance-${appearanceExit.key}`}
          theme={settings.theme}
          closing={appearanceExit.phase === 'exit'}
          onChange={(theme) => updateSettings({ theme })}
          onClose={() => setAppearanceOpen(false)}
        />
      )}
      {shortcutsExit.shown && (
        <ShortcutsDialog
          key={`shortcuts-${shortcutsExit.key}`}
          enabled={settings.keyboardShortcuts}
          closing={shortcutsExit.phase === 'exit'}
          onEnable={() => updateSettings({ keyboardShortcuts: true })}
          onClose={() => setShortcutsOpen(false)}
        />
      )}
      {deleteAskExit.shown && (
        <DeleteRepeatDialog
          key={`delete-${deleteAskExit.key}`}
          title={deleteAskExit.shown.title}
          closing={deleteAskExit.phase === 'exit'}
          onCancel={() => setDeleteAsk(null)}
          onThis={() => {
            const ev = deleteAskExit.shown!;
            setDeleteAsk(null);
            void deleteEvent(ev, 'this');
          }}
          onAll={() => {
            const ev = deleteAskExit.shown!;
            setDeleteAsk(null);
            void deleteEvent(ev, 'all');
          }}
        />
      )}
      {snackBar}
      {alertBox}
    </div>
  );
}

// "GMT+04", "GMT-05:30", "GMT+00"
function gmtLabel(instant: number, wall: number) {
  const mins = Math.round((wall - instant) / T.MINUTE);
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = abs % 60;
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}
