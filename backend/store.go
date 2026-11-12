package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	_ "modernc.org/sqlite" // pure Go SQLite driver (no CGO)
)

// Event is a calendar event. Start and End are stored as Unix milliseconds (UTC).
type Event struct {
	ID         int64 `json:"id"`
	CalendarID int64 `json:"calendarId"`
	// TimeZone the event's times were set in (IANA name), or '' for the
	// primary time zone. Start and End are instants either way.
	TimeZone    string `json:"timeZone"`
	Title       string `json:"title"`
	Description string `json:"description"`
	// Color is empty when the event uses the color of its calendar.
	Color string    `json:"color"`
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`
	// Reminders are notification times in minutes before the start (sorted, no duplicates).
	Reminders []int `json:"reminders"`
	// AllDay events use whole days. Start and End are UTC midnights of the
	// calendar dates, so the dates do not move when the time zone changes.
	// End is exclusive (the day after the last day).
	AllDay bool `json:"allDay"`
	// Repeat is "", "daily", "weekly", "monthly" or "yearly".
	Repeat string `json:"repeat"`
	// RepeatInterval is the number of days, weeks, months or years between
	// occurrences (at least 1).
	RepeatInterval int `json:"repeatInterval"`
	// RepeatWeekdays are the weekdays of a weekly event (0 = Sunday).
	RepeatWeekdays []int `json:"repeatWeekdays"`
	// RepeatUntil is the last allowed occurrence start, or nil for never.
	RepeatUntil *time.Time `json:"repeatUntil,omitempty"`
	// The fields below are set on occurrences made by expanding a repeating
	// event (GET /api/events). They are not stored.
	Occurrence  *time.Time `json:"occurrence,omitempty"`
	SeriesStart *time.Time `json:"seriesStart,omitempty"`
	SeriesEnd   *time.Time `json:"seriesEnd,omitempty"`
}

// Calendar groups events, like "Work" or "Family". There is always one
// primary calendar; it cannot be deleted.
type Calendar struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Color       string `json:"color"`
	// TimeZone is an IANA name like "Europe/Berlin", or empty for "same as
	// the primary time zone" (the timeZone setting).
	TimeZone string `json:"timeZone"`
	// Hidden calendars stay in the list, but their events are not shown.
	Hidden  bool `json:"hidden"`
	Primary bool `json:"primary"`
}

var (
	ErrNotFound = errors.New("not found")
	ErrPrimary  = errors.New("the primary calendar cannot be deleted")
)

// Name and color of the calendar made for a new (or older) database.
const (
	primaryCalendarName  = "My calendar"
	primaryCalendarColor = "#039be5"
)

// Store wraps the SQLite database.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS events (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	title           TEXT    NOT NULL DEFAULT '',
	description     TEXT    NOT NULL DEFAULT '',
	color           TEXT    NOT NULL DEFAULT '',
	start_ms        INTEGER NOT NULL,
	end_ms          INTEGER NOT NULL,
	all_day         INTEGER NOT NULL DEFAULT 0,
	repeat_rule     TEXT    NOT NULL DEFAULT '',
	repeat_interval INTEGER NOT NULL DEFAULT 1,
	repeat_until    INTEGER NOT NULL DEFAULT 0,
	repeat_weekdays TEXT    NOT NULL DEFAULT '[]',
	created_at      INTEGER NOT NULL,
	updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_start_end ON events(start_ms, end_ms);

-- Occurrences of a repeating event that the user deleted.
CREATE TABLE IF NOT EXISTS event_exceptions (
	event_id      INTEGER NOT NULL,
	occurrence_ms INTEGER NOT NULL,
	PRIMARY KEY (event_id, occurrence_ms)
);

CREATE TABLE IF NOT EXISTS calendars (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	name        TEXT    NOT NULL,
	description TEXT    NOT NULL DEFAULT '',
	color       TEXT    NOT NULL,
	time_zone   TEXT    NOT NULL DEFAULT '',
	hidden      INTEGER NOT NULL DEFAULT 0,
	is_primary  INTEGER NOT NULL DEFAULT 0,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`

// OpenStore opens (or creates) the database file and makes sure the tables exist.
func OpenStore(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection keeps SQLite simple and avoids "database is locked" errors.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &Store{db: db}, nil
}

// migrate adds columns that older databases do not have yet, and makes sure
// there is a primary calendar.
func migrate(db *sql.DB) error {
	has, err := hasColumn(db, "events", "reminders")
	if err != nil {
		return err
	}
	if !has {
		if _, err := db.Exec(`ALTER TABLE events ADD COLUMN reminders TEXT NOT NULL DEFAULT '[]'`); err != nil {
			return err
		}
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Events made before events had a time zone.
	has, err = hasColumn(tx, "events", "time_zone")
	if err != nil {
		return err
	}
	if !has {
		if _, err := tx.Exec(`ALTER TABLE events ADD COLUMN time_zone TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}

	// Events made before all-day events and repeating events existed.
	newColumns := []struct{ name, def string }{
		{"all_day", "INTEGER NOT NULL DEFAULT 0"},
		{"repeat_rule", "TEXT NOT NULL DEFAULT ''"},
		{"repeat_interval", "INTEGER NOT NULL DEFAULT 1"},
		{"repeat_until", "INTEGER NOT NULL DEFAULT 0"},
		{"repeat_weekdays", "TEXT NOT NULL DEFAULT '[]'"},
	}
	for _, c := range newColumns {
		has, err := hasColumn(tx, "events", c.name)
		if err != nil {
			return err
		}
		if !has {
			if _, err := tx.Exec(`ALTER TABLE events ADD COLUMN ` + c.name + ` ` + c.def); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS event_exceptions (
		event_id      INTEGER NOT NULL,
		occurrence_ms INTEGER NOT NULL,
		PRIMARY KEY (event_id, occurrence_ms))`); err != nil {
		return err
	}

	// Calendar tables made before calendars had a time zone.
	has, err = hasColumn(tx, "calendars", "time_zone")
	if err != nil {
		return err
	}
	if !has {
		if _, err := tx.Exec(`ALTER TABLE calendars ADD COLUMN time_zone TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}

	primary, err := ensurePrimaryCalendar(tx)
	if err != nil {
		return err
	}
	has, err = hasColumn(tx, "events", "calendar_id")
	if err != nil {
		return err
	}
	if !has {
		// Events from before calendars all go to the primary calendar.
		// They were always saved with the default color, so that color now
		// means "use the calendar color": they follow the calendar if its
		// color changes.
		if _, err := tx.Exec(`ALTER TABLE events ADD COLUMN calendar_id INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE events SET color = '' WHERE color = ?`, primaryCalendarColor); err != nil {
			return err
		}
	}
	// Also repairs events whose calendar is missing.
	if _, err := tx.Exec(`
		UPDATE events SET calendar_id = ?
		WHERE calendar_id NOT IN (SELECT id FROM calendars)`, primary); err != nil {
		return err
	}
	if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS events_calendar ON events(calendar_id)`); err != nil {
		return err
	}
	return tx.Commit()
}

// ensurePrimaryCalendar returns the id of the primary calendar, and creates
// it if there is none.
func ensurePrimaryCalendar(tx *sql.Tx) (int64, error) {
	var id int64
	err := tx.QueryRow(`SELECT id FROM calendars WHERE is_primary = 1 ORDER BY id LIMIT 1`).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	// No primary calendar: use the oldest one, or make a new one.
	err = tx.QueryRow(`SELECT id FROM calendars ORDER BY id LIMIT 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		now := nowMs()
		res, err := tx.Exec(`
			INSERT INTO calendars (name, color, is_primary, created_at, updated_at)
			VALUES (?, ?, 1, ?, ?)`, primaryCalendarName, primaryCalendarColor, now, now)
		if err != nil {
			return 0, err
		}
		return res.LastInsertId()
	}
	if err != nil {
		return 0, err
	}
	_, err = tx.Exec(`UPDATE calendars SET is_primary = 1 WHERE id = ?`, id)
	return id, err
}

type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func hasColumn(db querier, table, column string) (bool, error) {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func encodeReminders(r []int) string {
	if r == nil {
		r = []int{}
	}
	b, _ := json.Marshal(r)
	return string(b)
}

func decodeReminders(s string) []int {
	r := []int{}
	_ = json.Unmarshal([]byte(s), &r)
	return r
}

func (s *Store) Close() error { return s.db.Close() }

func toMs(t time.Time) int64    { return t.UnixMilli() }
func fromMs(ms int64) time.Time { return time.UnixMilli(ms).UTC() }
func nowMs() int64              { return time.Now().UnixMilli() }

// eventColumns is the column list every event query uses (see scanEvent).
const eventColumns = `id, calendar_id, time_zone, title, description, color, start_ms, end_ms, reminders, all_day, repeat_rule, repeat_interval, repeat_until, repeat_weekdays`

func scanEvent(row interface{ Scan(...any) error }) (Event, error) {
	var e Event
	var start, end, until int64
	var reminders, weekdays string
	err := row.Scan(&e.ID, &e.CalendarID, &e.TimeZone, &e.Title, &e.Description, &e.Color,
		&start, &end, &reminders, &e.AllDay, &e.Repeat, &e.RepeatInterval, &until, &weekdays)
	if err != nil {
		return e, err
	}
	e.Start, e.End = fromMs(start), fromMs(end)
	e.Reminders = decodeReminders(reminders)
	e.RepeatWeekdays = decodeReminders(weekdays)
	if until > 0 {
		u := fromMs(until)
		e.RepeatUntil = &u
	}
	return e, nil
}

// ListEvents returns events that overlap the range [from, to). Repeating events
// are expanded into occurrences. tz is the primary time zone: repeating events
// without a time zone keep their clock time there (also across DST changes).
//
// All-day events are stored as calendar dates, so they are fetched with one
// day of slack on each side; the views draw only the days in range.
func (s *Store) ListEvents(from, to time.Time, tz string) ([]Event, error) {
	day := int64(24 * time.Hour / time.Millisecond)
	rows, err := s.db.Query(`
		SELECT `+eventColumns+`
		FROM events
		WHERE (all_day = 0 AND start_ms < ? AND end_ms > ?)
		   OR (all_day = 1 AND start_ms < ? AND end_ms > ?)
		   OR (repeat_rule != '' AND start_ms < ? AND (repeat_until = 0 OR repeat_until >= ?))
		ORDER BY start_ms, end_ms DESC, id`,
		toMs(to), toMs(from),
		toMs(to)+day, toMs(from)-day,
		toMs(to), toMs(from))
	if err != nil {
		return nil, err
	}
	// Read the rows first and close them before any other query: the store has
	// one connection, so a second query while these rows are open would wait
	// forever.
	stored := []Event{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		stored = append(stored, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}

	allExceptions, err := s.allExceptions()
	if err != nil {
		return nil, err
	}

	events := []Event{}
	for _, e := range stored {
		if e.Repeat == "" {
			events = append(events, e)
			continue
		}
		cancelled := make(map[int64]bool, len(allExceptions[e.ID]))
		for _, ms := range allExceptions[e.ID] {
			cancelled[ms] = true
		}
		events = append(events, expandOccurrences(e, cancelled, from, to, tz)...)
	}
	sort.Slice(events, func(i, j int) bool {
		if events[i].Start.Equal(events[j].Start) {
			return events[i].ID < events[j].ID
		}
		return events[i].Start.Before(events[j].Start)
	})
	return events, nil
}

// AllEvents returns every event (repeating events are not expanded). Used by
// the backup and iCalendar export.
func (s *Store) AllEvents() ([]Event, error) {
	rows, err := s.db.Query(`SELECT ` + eventColumns + ` FROM events ORDER BY start_ms, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []Event{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

func (s *Store) GetEvent(id int64) (Event, error) {
	e, err := scanEvent(s.db.QueryRow(`SELECT `+eventColumns+` FROM events WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return e, ErrNotFound
	}
	return e, err
}

func (s *Store) CreateEvent(e Event) (Event, error) {
	now := nowMs()
	res, err := s.db.Exec(`
		INSERT INTO events (calendar_id, time_zone, title, description, color, start_ms, end_ms, reminders,
			all_day, repeat_rule, repeat_interval, repeat_until, repeat_weekdays, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.CalendarID, e.TimeZone, e.Title, e.Description, e.Color, toMs(e.Start), toMs(e.End), encodeReminders(e.Reminders),
		e.AllDay, e.Repeat, e.RepeatInterval, repeatUntilMs(e.RepeatUntil), encodeReminders(e.RepeatWeekdays), now, now)
	if err != nil {
		return e, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return e, err
	}
	return s.GetEvent(id)
}

func repeatUntilMs(t *time.Time) int64 {
	if t == nil || t.IsZero() {
		return 0
	}
	return toMs(*t)
}

func (s *Store) UpdateEvent(e Event) (Event, error) {
	res, err := s.db.Exec(`
		UPDATE events
		SET calendar_id = ?, time_zone = ?, title = ?, description = ?, color = ?, start_ms = ?, end_ms = ?, reminders = ?,
			all_day = ?, repeat_rule = ?, repeat_interval = ?, repeat_until = ?, repeat_weekdays = ?, updated_at = ?
		WHERE id = ?`,
		e.CalendarID, e.TimeZone, e.Title, e.Description, e.Color, toMs(e.Start), toMs(e.End), encodeReminders(e.Reminders),
		e.AllDay, e.Repeat, e.RepeatInterval, repeatUntilMs(e.RepeatUntil), encodeReminders(e.RepeatWeekdays), nowMs(), e.ID)
	if err != nil {
		return e, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return e, ErrNotFound
	}
	return s.GetEvent(e.ID)
}

func (s *Store) DeleteEvent(id int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM event_exceptions WHERE event_id = ?`, id); err != nil {
		return err
	}
	res, err := tx.Exec(`DELETE FROM events WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// exceptions lists the deleted occurrences of a repeating event.
func (s *Store) exceptions(id int64) (map[int64]bool, error) {
	rows, err := s.db.Query(`SELECT occurrence_ms FROM event_exceptions WHERE event_id = ?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var ms int64
		if err := rows.Scan(&ms); err != nil {
			return nil, err
		}
		out[ms] = true
	}
	return out, rows.Err()
}

var ErrNotRepeating = errors.New("event does not repeat")

// DeleteOccurrence deletes one occurrence of a repeating event.
func (s *Store) DeleteOccurrence(id, occurrenceMs int64) error {
	e, err := s.GetEvent(id)
	if err != nil {
		return err
	}
	if e.Repeat == "" {
		return ErrNotRepeating
	}
	_, err = s.db.Exec(`INSERT OR IGNORE INTO event_exceptions (event_id, occurrence_ms) VALUES (?, ?)`, id, occurrenceMs)
	return err
}

// ---- Calendars ----

const calendarColumns = `id, name, description, color, time_zone, hidden, is_primary`

func scanCalendar(row interface{ Scan(...any) error }) (Calendar, error) {
	var c Calendar
	err := row.Scan(&c.ID, &c.Name, &c.Description, &c.Color, &c.TimeZone, &c.Hidden, &c.Primary)
	return c, err
}

// ListCalendars returns the primary calendar first, then the others by name.
func (s *Store) ListCalendars() ([]Calendar, error) {
	rows, err := s.db.Query(`SELECT ` + calendarColumns + ` FROM calendars
		ORDER BY is_primary DESC, name COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Calendar{}
	for rows.Next() {
		c, err := scanCalendar(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, c)
	}
	return list, rows.Err()
}

func (s *Store) GetCalendar(id int64) (Calendar, error) {
	c, err := scanCalendar(s.db.QueryRow(`SELECT `+calendarColumns+` FROM calendars WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}

func (s *Store) PrimaryCalendarID() (int64, error) {
	var id int64
	err := s.db.QueryRow(`SELECT id FROM calendars WHERE is_primary = 1 ORDER BY id LIMIT 1`).Scan(&id)
	return id, err
}

func (s *Store) CountCalendars() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM calendars`).Scan(&n)
	return n, err
}

func (s *Store) CreateCalendar(c Calendar) (Calendar, error) {
	now := nowMs()
	res, err := s.db.Exec(`
		INSERT INTO calendars (name, description, color, time_zone, hidden, is_primary, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
		c.Name, c.Description, c.Color, c.TimeZone, c.Hidden, now, now)
	if err != nil {
		return c, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return c, err
	}
	return s.GetCalendar(id)
}

// UpdateCalendar saves name, description, color, time zone and hidden. Primary is not changed.
func (s *Store) UpdateCalendar(c Calendar) (Calendar, error) {
	res, err := s.db.Exec(`
		UPDATE calendars SET name = ?, description = ?, color = ?, time_zone = ?, hidden = ?, updated_at = ?
		WHERE id = ?`,
		c.Name, c.Description, c.Color, c.TimeZone, c.Hidden, nowMs(), c.ID)
	if err != nil {
		return c, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return c, ErrNotFound
	}
	return s.GetCalendar(c.ID)
}

// DeleteCalendar deletes a calendar and all of its events.
func (s *Store) DeleteCalendar(id int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var primary bool
	err = tx.QueryRow(`SELECT is_primary FROM calendars WHERE id = ?`, id).Scan(&primary)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if primary {
		return ErrPrimary
	}
	if _, err := tx.Exec(`DELETE FROM event_exceptions WHERE event_id IN (SELECT id FROM events WHERE calendar_id = ?)`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM events WHERE calendar_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM calendars WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// Settings are stored as key/value text pairs.
func (s *Store) GetSettings() (map[string]string, error) {
	rows, err := s.db.Query(`SELECT key, value FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (s *Store) SetSettings(values map[string]string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for k, v := range values {
		if _, err := tx.Exec(`
			INSERT INTO settings (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`, k, v); err != nil {
			return err
		}
	}
	return tx.Commit()
}
