package shuttle

import "testing"

func TestScheduleTextSaysTheCadencesAPersonSays(t *testing.T) {
	t.Parallel()
	for expr, want := range map[string]string{
		"0 9 * * 1-5":   "weekdays 9:00",
		"30 6 * * *":    "daily 6:30",
		"0 8 * * 1":     "Mon 8:00",
		"15 20 * * 0,6": "weekends 20:15",
		"0 7 * * 1,3,5": "Mon, Wed, Fri 7:00",
		" 5 0 * * 2 ":   "Tue 0:05",
	} {
		if got := ScheduleText(expr); got != want {
			t.Errorf("ScheduleText(%q) = %q, want %q", expr, got, want)
		}
	}
}

func TestScheduleTextStaysSilentRatherThanLie(t *testing.T) {
	t.Parallel()
	for _, expr := range []string{
		"*/15 * * * *",    // many times of day
		"0 9,17 * * *",    // two hours
		"0 9 1 * *",       // a day of the month
		"0 9 * 3 *",       // one month only
		"0 9 * * 0,1,3,5", // four scattered weekdays
		"not a cron",
		"",
	} {
		if got := ScheduleText(expr); got != "" {
			t.Errorf("ScheduleText(%q) = %q, want silence", expr, got)
		}
	}
}
