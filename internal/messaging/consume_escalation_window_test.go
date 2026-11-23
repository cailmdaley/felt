package messaging

import (
	"testing"
	"time"
)

func TestCostHoldEscalationWindow(t *testing.T) {
	for value, want := range map[string]time.Duration{
		"":       time.Hour,
		"0":      0,
		"0.25":   250 * time.Millisecond,
		"7200":   2 * time.Hour,
		"-1":     time.Hour,
		"NaN":    time.Hour,
		"+Inf":   time.Hour,
		"-Inf":   time.Hour,
		"1e300":  time.Hour,
		"1e10":   time.Hour,
		"soon":   time.Hour,
		"9.2e9":  time.Duration(9.2e9 * float64(time.Second)),
		"9.3e9":  time.Hour,
		"3600.0": time.Hour,
	} {
		env := testEnv(t)
		env.Set("SHUTTLE_COST_HOLD_ESCALATE_SEC", value)
		if got := costHoldEscalation(env); got != want {
			t.Errorf("%q: got %v, want %v", value, got, want)
		}
	}
}
