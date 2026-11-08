package shuttle

import (
	"fmt"
	"math/bits"
	"strings"

	"github.com/robfig/cron/v3"
)

var dayNames = [7]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

// ScheduleText says a cron expression the way a person would: "weekdays 9:00",
// "daily 6:30", "Mon, Wed, Fri 7:00". It is "" for anything that vocabulary
// cannot say faithfully (several times of day, a day of the month, a month, or
// more than three scattered weekdays), so a reader shows the expression itself
// rather than a wrong reading of it.
func ScheduleText(expr string) string {
	parsed, err := cronParser.Parse(strings.TrimSpace(expr))
	if err != nil {
		return ""
	}
	spec, ok := parsed.(*cron.SpecSchedule)
	if !ok {
		return ""
	}
	minute, oneMinute := only(spec.Minute, 0, 59)
	hour, oneHour := only(spec.Hour, 0, 23)
	if !oneMinute || !oneHour || !every(spec.Dom, 1, 31) || !every(spec.Month, 1, 12) {
		return ""
	}
	clock := fmt.Sprintf("%d:%02d", hour, minute)
	var days []int
	for d := 0; d < 7; d++ {
		if spec.Dow&(1<<d) != 0 {
			days = append(days, d)
		}
	}
	switch fmt.Sprint(days) {
	case "[0 1 2 3 4 5 6]":
		return "daily " + clock
	case "[1 2 3 4 5]":
		return "weekdays " + clock
	case "[0 6]":
		return "weekends " + clock
	}
	if len(days) > 3 {
		return ""
	}
	names := make([]string, len(days))
	for i, d := range days {
		names[i] = dayNames[d]
	}
	return strings.Join(names, ", ") + " " + clock
}

// only reports the single value set in a cron field's bits, if exactly one is.
func only(field uint64, lo, hi uint) (uint, bool) {
	values := field & span(lo, hi)
	if bits.OnesCount64(values) != 1 {
		return 0, false
	}
	return uint(bits.TrailingZeros64(values)), true
}

// every reports whether a cron field's bits cover its whole range.
func every(field uint64, lo, hi uint) bool {
	return field&span(lo, hi) == span(lo, hi)
}

func span(lo, hi uint) uint64 {
	return (^uint64(0) >> (63 - hi)) &^ (1<<lo - 1)
}
