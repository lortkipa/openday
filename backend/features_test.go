package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func listRange(t *testing.T, srv *httptest.Server, start, end, tz string) []Event {
	t.Helper()
	q := url.Values{"start": {start}, "end": {end}}
	if tz != "" {
		q.Set("tz", tz)
	}
	code, body := do(t, srv, "GET", "/api/events?"+q.Encode(), "")
	if code != http.StatusOK {
		t.Fatalf("list: %d %s", code, body)
	}
	var list []Event
	if err := json.Unmarshal([]byte(body), &list); err != nil {
		t.Fatalf("list json: %v (%s)", err, body)
	}
	return list
}

func TestWeeklyOccurrencesAndDelete(t *testing.T) {
	srv := newTestServer(t)
	code, body := do(t, srv, "POST", "/api/events",
		`{"title":"Standup","start":"2026-11-02T08:00:00Z","end":"2026-11-02T08:30:00Z","timeZone":"Europe/Berlin","repeat":"weekly","repeatWeekdays":[1,3]}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}

	list := listRange(t, srv, "2026-11-02T00:00:00Z", "2026-11-16T00:00:00Z", "Europe/Berlin")
	if len(list) != 4 {
		t.Fatalf("expected 4 occurrences (Mon/Wed), got %d: %+v", len(list), list)
	}
	for _, e := range list {
		if e.Occurrence == nil || e.SeriesStart == nil {
			t.Fatalf("occurrence fields missing: %+v", e)
		}
		// 09:00 in Berlin (UTC+1 in November) is 08:00 UTC.
		if e.Start.Hour() != 9 || e.Start.UTC().Hour() != 8 {
			t.Fatalf("occurrence not at 09:00 local: %v", e.Start)
		}
	}

	// Delete the Wednesday 4 November occurrence.
	code, body = do(t, srv, "DELETE", "/api/events/1?occurrence=2026-11-04T08:00:00Z", "")
	if code != http.StatusNoContent {
		t.Fatalf("delete occurrence: %d %s", code, body)
	}
	list = listRange(t, srv, "2026-11-02T00:00:00Z", "2026-11-16T00:00:00Z", "Europe/Berlin")
	if len(list) != 3 {
		t.Fatalf("expected 3 occurrences after delete, got %d", len(list))
	}
	for _, e := range list {
		if e.Start.Equal(time.Date(2026, 11, 4, 8, 0, 0, 0, time.UTC)) {
			t.Fatal("deleted occurrence still listed")
		}
	}
}

func TestDailyKeepsWallClockAcrossDST(t *testing.T) {
	srv := newTestServer(t)
	code, body := do(t, srv, "POST", "/api/events",
		`{"title":"Coffee","start":"2026-03-28T08:00:00Z","end":"2026-03-28T08:15:00Z","timeZone":"Europe/Berlin","repeat":"daily"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}
	list := listRange(t, srv, "2026-03-28T00:00:00Z", "2026-03-31T00:00:00Z", "Europe/Berlin")
	if len(list) != 3 {
		t.Fatalf("expected 3 daily occurrences, got %d: %+v", len(list), list)
	}
	// 29 March 2026: Berlin switches to summer time. 09:00 local is 07:00 UTC.
	if !list[1].Start.Equal(time.Date(2026, 3, 29, 7, 0, 0, 0, time.UTC)) {
		t.Fatalf("occurrence moved with DST: %v", list[1].Start)
	}
}

func TestMonthlySkipsMissingDays(t *testing.T) {
	srv := newTestServer(t)
	code, body := do(t, srv, "POST", "/api/events",
		`{"title":"Rent","start":"2026-01-31T09:00:00Z","end":"2026-01-31T10:00:00Z","repeat":"monthly"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}
	// February and April have no 31st, so only January and March.
	list := listRange(t, srv, "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z", "UTC")
	if len(list) != 2 {
		t.Fatalf("expected 2 occurrences, got %d: %+v", len(list), list)
	}
}

func TestRepeatUntil(t *testing.T) {
	srv := newTestServer(t)
	code, body := do(t, srv, "POST", "/api/events",
		`{"title":"Countdown","start":"2026-11-01T09:00:00Z","end":"2026-11-01T10:00:00Z","repeat":"daily","repeatUntil":"2026-11-03T12:00:00Z"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}
	list := listRange(t, srv, "2026-11-01T00:00:00Z", "2026-11-10T00:00:00Z", "UTC")
	if len(list) != 3 {
		t.Fatalf("expected 3 occurrences, got %d: %+v", len(list), list)
	}
}

func TestAllDayEvents(t *testing.T) {
	srv := newTestServer(t)
	code, body := do(t, srv, "POST", "/api/events",
		`{"title":"Conference","start":"2026-11-13T00:00:00Z","end":"2026-11-15T00:00:00Z","allDay":true}`)
	if code != http.StatusCreated {
		t.Fatalf("create all-day: %d %s", code, body)
	}
	var e Event
	if err := json.Unmarshal([]byte(body), &e); err != nil {
		t.Fatal(err)
	}
	if !e.AllDay || e.TimeZone != "" {
		t.Fatalf("unexpected all-day event: %+v", e)
	}
	list := listRange(t, srv, "2026-11-12T00:00:00Z", "2026-11-16T00:00:00Z", "Europe/Berlin")
	if len(list) != 1 {
		t.Fatalf("all-day event missing: %+v", list)
	}

	// A time in the middle of the day is not a valid all-day event.
	code, body = do(t, srv, "POST", "/api/events",
		`{"title":"Bad","start":"2026-11-13T10:00:00Z","end":"2026-11-14T10:00:00Z","allDay":true}`)
	if code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a timed all-day event, got %d %s", code, body)
	}
}

func TestBackupExportAndImport(t *testing.T) {
	srv := newTestServer(t)
	do(t, srv, "POST", "/api/events",
		`{"title":"Lunch","start":"2026-11-06T12:00:00Z","end":"2026-11-06T13:00:00Z"}`)
	do(t, srv, "POST", "/api/events",
		`{"title":"Weekly","start":"2026-11-02T09:00:00Z","end":"2026-11-02T10:00:00Z","repeat":"weekly","repeatWeekdays":[1]}`)
	do(t, srv, "POST", "/api/calendars", `{"name":"Work","color":"#0b8043"}`)

	code, body := do(t, srv, "GET", "/api/export", "")
	if code != http.StatusOK {
		t.Fatalf("export: %d %s", code, body)
	}
	var backup Backup
	if err := json.Unmarshal([]byte(body), &backup); err != nil {
		t.Fatalf("export json: %v", err)
	}
	if len(backup.Events) != 2 || len(backup.Calendars) != 2 || backup.Settings == nil {
		t.Fatalf("unexpected backup: %+v", backup)
	}

	cal, events, err := NewAPIForTest(t).importBackup(backup)
	if err != nil {
		t.Fatal(err)
	}
	if cal != 2 || events != 2 {
		t.Fatalf("imported %d calendars and %d events", cal, events)
	}

	// One-calendar export (used by undo) contains only that calendar.
	id := backup.Calendars[1].ID
	_, body = do(t, srv, "GET", fmt.Sprintf("/api/export?calendar=%d", id), "")
	var one Backup
	if err := json.Unmarshal([]byte(body), &one); err != nil {
		t.Fatal(err)
	}
	if len(one.Calendars) != 1 || one.Settings != nil {
		t.Fatalf("single calendar export: %+v", one)
	}
}

// NewAPIForTest builds an API over a fresh database (for direct calls).
func NewAPIForTest(t *testing.T) *API {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "import.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return NewAPI(store, NewHub())
}

func TestICSExport(t *testing.T) {
	srv := newTestServer(t)
	do(t, srv, "POST", "/api/events",
		`{"title":"Standup, daily","start":"2026-11-02T09:00:00Z","end":"2026-11-02T09:30:00Z","repeat":"weekly","repeatWeekdays":[1,3],"description":"Line one\nLine two"}`)
	do(t, srv, "POST", "/api/events",
		`{"title":"Trip","start":"2026-11-13T00:00:00Z","end":"2026-11-15T00:00:00Z","allDay":true}`)

	code, body := do(t, srv, "GET", "/api/export.ics", "")
	if code != http.StatusOK {
		t.Fatalf("ics: %d", code)
	}
	for _, want := range []string{
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE",
		"SUMMARY:Standup\\, daily",
		"DESCRIPTION:Line one\\nLine two",
		"DTSTART;VALUE=DATE:20261113",
		"DTEND;VALUE=DATE:20261115",
		"END:VCALENDAR",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("ics export is missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "\n") && !strings.Contains(body, "\r\n") {
		t.Error("ics export must use CRLF line endings")
	}
}
