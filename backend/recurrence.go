package main

// Repeating events. A repeating event is stored once (the "series") and
// expanded into occurrences when a range of events is loaded.
//
// The rules are deliberately simple (the same four choices as the calendar
// form): every N days, on chosen weekdays of every N weeks, on the same day of
// every N months, or on the same date of every N years. Occurrences keep the
// wall clock time of the series in the event's time zone, so a 9am weekly event
// stays at 9am across daylight saving changes.
//
// Deleting one occurrence stores it in event_exceptions; it is skipped here.
// Editing a repeating event changes the whole series.

import (
	"time"
)

// A safety cap: a range can never produce more than this many occurrences of
// one event (a daily event over 50 years is about 18,000).
const maxOccurrences = 20000

// daysBetween counts calendar days from a to b (both dates, in their own zone).
func daysBetween(a, b time.Time) int64 {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	au := time.Date(ay, am, ad, 0, 0, 0, 0, time.UTC)
	bu := time.Date(by, bm, bd, 0, 0, 0, 0, time.UTC)
	return int64(bu.Sub(au) / (24 * time.Hour))
}

// expandOccurrences returns the occurrences of e that can be seen in [from, to).
func expandOccurrences(e Event, cancelled map[int64]bool, from, to time.Time, primaryTZ string) []Event {
	// All-day dates are floating: use UTC so adding days never crosses a DST
	// boundary. Timed events repeat at a wall clock time in their own zone.
	loc := time.UTC
	if !e.AllDay {
		zone := e.TimeZone
		if zone == "" {
			zone = primaryTZ
		}
		if zone != "" {
			if l, err := time.LoadLocation(zone); err == nil {
				loc = l
			}
		}
	}

	base := e.Start.In(loc)
	y0, m0, d0 := base.Date()
	hh, mm, ss := base.Clock()
	startDay := time.Date(y0, m0, d0, 0, 0, 0, 0, loc)
	duration := e.End.Sub(e.Start)
	interval := e.RepeatInterval
	if interval < 1 {
		interval = 1
	}

	// All-day events are stored as dates, so a range gets one day of slack.
	winStart, winEnd := from, to
	if e.AllDay {
		winStart = from.AddDate(0, 0, -1)
		winEnd = to.AddDate(0, 0, 1)
	}
	// An occurrence may have started before the range and still overlap it.
	consider := winStart.Add(-duration)

	out := []Event{}
	add := func(start time.Time) bool {
		if start.Before(e.Start) {
			return true // earlier than the series: keep looking
		}
		if e.RepeatUntil != nil && start.After(*e.RepeatUntil) {
			return false // past the end of the series
		}
		if start.After(winEnd) {
			return false
		}
		end := start.Add(duration)
		if end.After(consider) && !cancelled[start.UnixMilli()] {
			occStart := start
			seriesStart := e.Start
			seriesEnd := e.End
			occ := e
			occ.Start = start
			occ.End = end
			occ.Occurrence = &occStart
			occ.SeriesStart = &seriesStart
			occ.SeriesEnd = &seriesEnd
			out = append(out, occ)
		}
		return len(out) < maxOccurrences
	}

	at := func(day time.Time) time.Time {
		return time.Date(day.Year(), day.Month(), day.Day(), hh, mm, ss, 0, loc)
	}

	switch e.Repeat {
	case "daily":
		// Start a little before the range instead of walking the whole series.
		n := int64(0)
		if ahead := daysBetween(startDay, consider); ahead > 0 {
			n = ahead / int64(interval)
		}
		for ; ; n++ {
			day := startDay.AddDate(0, 0, int(n)*interval)
			if !add(at(day)) {
				break
			}
		}

	case "weekly":
		anchor := startDay.AddDate(0, 0, -int(startDay.Weekday()))
		weekdays := e.RepeatWeekdays
		if len(weekdays) == 0 {
			weekdays = []int{int(base.Weekday())}
		}
		k := int64(0)
		if ahead := daysBetween(anchor, consider); ahead > 7 {
			k = ((ahead / 7) / int64(interval)) - 1
			if k < 0 {
				k = 0
			}
		}
		for ; ; k++ {
			week := anchor.AddDate(0, 0, int(k)*7*interval)
			if week.After(winEnd) {
				break
			}
			stop := false
			for _, wd := range weekdays {
				day := week.AddDate(0, 0, wd)
				if !add(at(day)) {
					stop = true
					break
				}
			}
			if stop {
				break
			}
		}

	case "monthly":
		k := int64(0)
		if cy, cm, _ := consider.Date(); cy != y0 || cm != m0 {
			months := int64(cy-y0)*12 + int64(cm-m0)
			if months > int64(interval) {
				k = months/int64(interval) - 1
			}
		}
		for ; ; k++ {
			start := time.Date(y0, m0+time.Month(k*int64(interval)), d0, hh, mm, ss, 0, loc)
			// Months without this day (31st, February 30) have no occurrence.
			if start.Day() != d0 {
				if start.After(winEnd) {
					break
				}
				continue
			}
			if !add(start) {
				break
			}
		}

	case "yearly":
		k := int64(0)
		if cy := consider.Year(); cy > y0+1 {
			k = int64(cy-y0) - 1
		}
		for ; ; k++ {
			start := time.Date(y0+int(k*int64(interval)), m0, d0, hh, mm, ss, 0, loc)
			// February 29 has no occurrence in other years.
			if start.Day() != d0 || start.Month() != m0 {
				if start.After(winEnd) {
					break
				}
				continue
			}
			if !add(start) {
				break
			}
		}
	}

	return out
}
