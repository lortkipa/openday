package main

// Backup, restore and iCalendar export.
//
// A backup is one JSON object with all calendars, all events (repeating events
// are stored once, not expanded) and the settings. The same format is used to
// restore a backup and to undo deleting a calendar: the client fetches the
// calendar as a backup before deleting it, and imports that backup again.
//
// Import only adds data; it never deletes anything. Calendars keep their names,
// descriptions, colors and time zones, but are imported as ordinary calendars
// (never as the primary one). Events are attached to the imported copies.

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

const backupVersion = 1

// Backup is the JSON file written by GET /api/export.
type Backup struct {
	Version    int        `json:"version"`
	ExportedAt time.Time  `json:"exportedAt"`
	Settings   *Settings  `json:"settings,omitempty"`
	Calendars  []Calendar `json:"calendars"`
	Events     []Event    `json:"events"`
}

// makeBackup collects the data. calendarID > 0 exports one calendar and its
// events (no settings), which is what undo uses.
func (a *API) makeBackup(calendarID int64) (Backup, error) {
	b := Backup{Version: backupVersion, ExportedAt: time.Now().UTC(), Calendars: []Calendar{}, Events: []Event{}}
	all, err := a.store.ListCalendars()
	if err != nil {
		return b, err
	}
	wanted := map[int64]bool{}
	for _, c := range all {
		if calendarID == 0 || c.ID == calendarID {
			b.Calendars = append(b.Calendars, c)
			wanted[c.ID] = true
		}
	}
	if calendarID != 0 && len(b.Calendars) == 0 {
		return b, ErrNotFound
	}
	events, err := a.store.AllEvents()
	if err != nil {
		return b, err
	}
	for _, e := range events {
		if wanted[e.CalendarID] {
			b.Events = append(b.Events, e)
		}
	}
	if calendarID == 0 {
		s, err := a.loadSettings()
		if err != nil {
			return b, err
		}
		b.Settings = &s
	}
	return b, nil
}

var errTooMuchData = errors.New("the backup is too large")

// importBackup creates the calendars and events of a backup. It returns how
// many of each were created.
func (a *API) importBackup(b Backup) (int, int, error) {
	if b.Version != 0 && b.Version != backupVersion {
		return 0, 0, errors.New("unsupported backup version")
	}
	if len(b.Calendars) > maxCalendars || len(b.Events) > 100000 {
		return 0, 0, errTooMuchData
	}

	// Old calendar id -> new calendar id.
	ids := map[int64]int64{}
	created := 0
	for _, c := range b.Calendars {
		oldID := c.ID
		c.ID = 0
		c.Primary = false
		c.Name = strings.TrimSpace(c.Name)
		if c.Name == "" {
			c.Name = "Calendar"
		}
		if len([]rune(c.Name)) > maxCalendarNameLen {
			c.Name = string([]rune(c.Name)[:maxCalendarNameLen])
		}
		if !colorRe.MatchString(c.Color) {
			c.Color = primaryCalendarColor
		}
		if !validTimeZone(c.TimeZone) {
			c.TimeZone = ""
		}
		saved, err := a.store.CreateCalendar(c)
		if err != nil {
			return 0, 0, err
		}
		ids[oldID] = saved.ID
		created++
	}

	primary, err := a.store.PrimaryCalendarID()
	if err != nil {
		return created, 0, err
	}

	imported := 0
	for _, e := range b.Events {
		in := eventInput{
			CalendarID:     e.CalendarID,
			TimeZone:       e.TimeZone,
			Title:          e.Title,
			Description:    e.Description,
			Color:          e.Color,
			Start:          e.Start,
			End:            e.End,
			Reminders:      e.Reminders,
			AllDay:         e.AllDay,
			Repeat:         e.Repeat,
			RepeatInterval: e.RepeatInterval,
			RepeatWeekdays: e.RepeatWeekdays,
			RepeatUntil:    e.RepeatUntil,
		}
		valid, err := in.validate()
		if err != nil {
			continue // skip rows that are not valid; the rest still imports
		}
		if id, ok := ids[valid.CalendarID]; ok {
			valid.CalendarID = id
		} else {
			valid.CalendarID = primary
		}
		if _, err := a.store.CreateEvent(valid); err != nil {
			return created, imported, err
		}
		imported++
	}
	return created, imported, nil
}

// ---- iCalendar (.ics) ----

// icsText builds a VCALENDAR with one VEVENT per stored event. Repeating
// events keep their rule and their deleted occurrences (EXDATE).
func icsText(events []Event, exceptions map[int64][]int64) string {
	var b strings.Builder
	line := func(s string) {
		b.WriteString(foldICS(s))
		b.WriteString("\r\n")
	}
	line("BEGIN:VCALENDAR")
	line("VERSION:2.0")
	line("PRODID:-//OpenDay//OpenDay Calendar//EN")
	line("CALSCALE:GREGORIAN")
	line("X-WR-CALNAME:OpenDay")

	for _, e := range events {
		line("BEGIN:VEVENT")
		line(fmt.Sprintf("UID:event-%d@openday", e.ID))
		line("DTSTAMP:" + icsDateTime(time.Now()))
		if e.AllDay {
			line("DTSTART;VALUE=DATE:" + icsDateOnly(e.Start))
			line("DTEND;VALUE=DATE:" + icsDateOnly(e.End))
		} else {
			line("DTSTART:" + icsDateTime(e.Start))
			line("DTEND:" + icsDateTime(e.End))
		}
		line("SUMMARY:" + icsEscape(e.Title))
		if e.Description != "" {
			line("DESCRIPTION:" + icsEscape(e.Description))
		}
		if rule := icsRule(e); rule != "" {
			line("RRULE:" + rule)
		}
		if ms := exceptions[e.ID]; len(ms) > 0 {
			ex := make([]string, 0, len(ms))
			for _, m := range ms {
				t := time.UnixMilli(m).UTC()
				if e.AllDay {
					ex = append(ex, icsDateOnly(t))
				} else {
					ex = append(ex, icsDateTime(t))
				}
			}
			sort.Strings(ex)
			line("EXDATE:" + strings.Join(ex, ","))
		}
		line("END:VEVENT")
	}

	line("END:VCALENDAR")
	return b.String()
}

func icsRule(e Event) string {
	if e.Repeat == "" {
		return ""
	}
	interval := e.RepeatInterval
	if interval < 1 {
		interval = 1
	}
	parts := []string{"FREQ=" + strings.ToUpper(e.Repeat), "INTERVAL=" + strconv.Itoa(interval)}
	if e.Repeat == "weekly" {
		names := []string{"SU", "MO", "TU", "WE", "TH", "FR", "SA"}
		days := make([]string, 0, len(e.RepeatWeekdays))
		for _, d := range e.RepeatWeekdays {
			if d >= 0 && d < 7 {
				days = append(days, names[d])
			}
		}
		if len(days) > 0 {
			parts = append(parts, "BYDAY="+strings.Join(days, ","))
		}
	}
	if e.RepeatUntil != nil {
		if e.AllDay {
			parts = append(parts, "UNTIL="+icsDateOnly(*e.RepeatUntil))
		} else {
			parts = append(parts, "UNTIL="+icsDateTime(*e.RepeatUntil))
		}
	}
	return strings.Join(parts, ";")
}

// icsDateTime is a UTC timestamp: 20261106T120000Z.
func icsDateTime(t time.Time) string {
	return t.UTC().Format("20060102T150405Z")
}

// icsDateOnly is a calendar date: 20261106.
func icsDateOnly(t time.Time) string {
	return t.UTC().Format("20060102")
}

func icsEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, ";", `\;`)
	s = strings.ReplaceAll(s, ",", `\,`)
	s = strings.ReplaceAll(s, "\r\n", `\n`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\n`)
	return s
}

// foldICS wraps long lines at 75 octets, as RFC 5545 requires.
func foldICS(line string) string {
	if len(line) <= 75 {
		return line
	}
	var b strings.Builder
	for len(line) > 75 {
		b.WriteString(line[:75])
		b.WriteString("\r\n ")
		line = line[75:]
	}
	b.WriteString(line)
	return b.String()
}

// allExceptions reads every deleted occurrence (used by the .ics export).
func (s *Store) allExceptions() (map[int64][]int64, error) {
	rows, err := s.db.Query(`SELECT event_id, occurrence_ms FROM event_exceptions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]int64{}
	for rows.Next() {
		var id, ms int64
		if err := rows.Scan(&id, &ms); err != nil {
			return nil, err
		}
		out[id] = append(out[id], ms)
	}
	return out, rows.Err()
}
