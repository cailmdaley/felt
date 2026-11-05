package shuttle

import "testing"

func TestStandingRunDisposition(t *testing.T) {
	t.Parallel()
	const dispatch = "2026-01-02T00:00:00Z"
	for _, tc := range []struct {
		name, dispatch, handoff, verb string
		want                          RunDisposition
	}{
		{"never dispatched", "", "", "", RunUnrecorded},
		{"dirty first run", dispatch, "", "", RunInProgress},
		{"previous acceptance", dispatch, "2026-01-01T00:00:00Z", "tempered", RunInProgress},
		{"previous rearm", dispatch, "2026-01-01T00:00:00Z", "rearmed", RunInProgress},
		{"worker result", dispatch, "2026-01-03T00:00:00Z", "handed off", RunHandedOff},
		{"accepted run", dispatch, "2026-01-03T00:00:00Z", "tempered", RunRearmed},
		{"human rearm", dispatch, "2026-01-03T00:00:00Z", "rearmed", RunRearmed},
		{"scheduled occurrence rearm", dispatch, dispatch, "rearmed", RunRearmed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := StandingRunDisposition(RunFacts{tc.dispatch, tc.handoff, tc.verb}); got != tc.want {
				t.Fatalf("disposition = %s, want %s", got, tc.want)
			}
		})
	}
}
