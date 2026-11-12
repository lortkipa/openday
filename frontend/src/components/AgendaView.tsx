import { colorOf, textOn } from '../colors';
import * as T from '../time';
import type { Anchor, Calendar, CalendarViewProps, ShownEvent } from '../types';

// Agenda ("Schedule") view: the coming days, one section per day, with the
// events in order. Days without events are left out, like the classic
// calendar. Multi-day all-day events are listed once, on their first day.
interface AgendaViewProps extends CalendarViewProps {
  from: number; // wall time of the first shown day
  days: number;
  calendars: Calendar[];
}

export default function AgendaView({
  from,
  days,
  events,
  settings,
  today,
  calendars,
  onEventClick,
  onEventContext,
  onDayClick,
}: AgendaViewProps) {
  const tf = settings.timeFormat;
  const end = T.addDays(from, days);
  const list = events
    .filter((ev) => ev.ws < end && ev.we > from)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.ws - b.ws);

  const calName = (ev: ShownEvent) => calendars.find((c) => c.id === ev.calendarId)?.name || '';

  const groups: { day: number; items: ShownEvent[] }[] = [];
  for (let i = 0; i < days; i++) {
    const day = T.addDays(from, i);
    const dayEnd = T.addDays(day, 1);
    const items = list.filter((ev) => {
      if (!ev.allDay) return ev.ws < dayEnd && ev.we > day;
      // All-day events are listed once, on their first day in this range.
      return T.startOfDay(Math.max(ev.ws, from)) === day;
    });
    if (items.length) groups.push({ day, items });
  }

  if (!groups.length) {
    return (
      <div className="agenda agenda-empty">
        <p>No events in the next {days} days.</p>
      </div>
    );
  }

  const rectOf = (el: Element): Anchor => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top };
  };

  return (
    <div className="agenda">
      {groups.map(({ day, items }) => (
        <section key={day} className="agenda-day" aria-label={`${T.weekdayName(day)}, ${T.formatDate(day, settings.dateFormat)}`}>
          <button type="button" className={`agenda-date ${day === today ? 'today' : ''}`} onClick={() => onDayClick(day)}>
            <span className="agenda-dow">{T.weekdayName(day)}</span>
            <span className="agenda-num">{T.ymd(day)[2]}</span>
            <span className="agenda-month">{T.MONTHS[T.ymd(day)[1]].slice(0, 3)}</span>
          </button>
          <div className="agenda-items">
            {items.map((ev) => {
              const color = colorOf(ev);
              return (
                <button
                  key={`${ev.id}-${day}`}
                  type="button"
                  className={`agenda-ev ${ev.isDraft ? 'draft' : ''}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    // Let a touch scroll: the click below opens the card.
                  }}
                  onClick={(e) => onEventClick(ev, rectOf(e.currentTarget))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onEventContext(ev, e.clientX, e.clientY);
                  }}
                  aria-label={`${ev.title || '(No title)'}, ${ev.allDay ? 'all day' : T.formatTimeRange(ev.ws, ev.we, tf)}`}
                >
                  <span className="agenda-bar" style={{ background: color }} aria-hidden="true" />
                  <span className="agenda-time">
                    {ev.allDay ? 'All day' : T.formatTimeRange(ev.ws, ev.we, tf)}
                  </span>
                  <span className="agenda-title" style={ev.isDraft ? { color: textOn(color) } : undefined}>
                    {ev.title || '(No title)'}
                  </span>
                  {calName(ev) && <span className="agenda-cal">{calName(ev)}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
