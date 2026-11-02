package shuttle

import (
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestPulseAcceptsCompactAndWindowForms(t *testing.T) {
	for _, input := range []string{"pulse: 59m\n", "pulse:\n  every: 59m\n  window: {start: '08:00', end: '20:00', tz: Europe/Paris}\n"} {
		var block Block
		if err := yaml.Unmarshal([]byte("kind: oneshot\n"+input), &block); err != nil {
			t.Fatal(err)
		}
		if errs := Validate(&block, nil); len(errs) != 0 {
			t.Fatalf("%s: %v", input, errs)
		}
		if d, err := block.Pulse.Interval(); err != nil || d != 59*time.Minute {
			t.Fatalf("interval=%v err=%v", d, err)
		}
	}
}

func TestPulseRejectsInvalidDurationsAndWindows(t *testing.T) {
	for _, pulse := range []*Pulse{
		{Every: "30s"}, {Every: "25h"}, {Every: "1m1µs"},
		{Every: "1m", Window: &PulseWindow{Start: "8:00", End: "20:00", TZ: "UTC"}},
		{Every: "1m", Window: &PulseWindow{Start: "08:00", End: "08:00", TZ: "UTC"}},
		{Every: "1m", Window: &PulseWindow{Start: "08:00", End: "20:00", TZ: "Atlantis/Bermuda"}},
	} {
		if errs := Validate(&Block{Kind: "oneshot", Pulse: pulse}, nil); len(errs) == 0 {
			t.Errorf("accepted invalid pulse %+v", pulse)
		}
	}
	if errs := Validate(&Block{Kind: "standing", Pulse: &Pulse{Every: "1h"}, Schedule: &Schedule{Expr: "0 9 * * *", TZ: "UTC"}}, nil); !strings.Contains(errs.Error(), "pulse") {
		t.Fatalf("standing pulse validation: %v", errs)
	}
}

func TestPulseRequiresAgentWithSafeWake(t *testing.T) {
	reg := builtinReg(t)
	errs := Validate(&Block{Kind: "oneshot", Agent: "pi-openai-terra", Pulse: &Pulse{Every: "59m"}}, reg)
	if !strings.Contains(errs.Error(), "idle-only wake") {
		t.Fatalf("Pi pulse error = %v", errs)
	}
	if errs := Validate(&Block{Kind: "oneshot", Agent: "claude-opus", Pulse: &Pulse{Every: "59m"}}, reg); len(errs) != 0 {
		t.Fatalf("Claude pulse rejected: %v", errs)
	}
}

func TestResolveBlockEmitsPulseInterval(t *testing.T) {
	reg := builtinReg(t)
	resolved, err := ResolveBlock(&Block{Kind: "oneshot", Agent: "codex-sol", Pulse: &Pulse{Every: "59m"}}, reg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if resolved.PulseIntervalMS != int64((59*time.Minute)/time.Millisecond) {
		t.Fatalf("pulse interval ms = %d", resolved.PulseIntervalMS)
	}
}

func TestResolveBlockOmitsInvalidPulse(t *testing.T) {
	reg := builtinReg(t)
	for _, pulse := range []*Pulse{
		{Every: "1m", Window: &PulseWindow{Start: "08:00", End: "08:00", TZ: "UTC"}},
		{Every: "bogus"},
	} {
		resolved, err := ResolveBlock(&Block{Kind: "oneshot", Agent: "codex-sol", Pulse: pulse}, reg, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if resolved.PulseIntervalMS != 0 {
			t.Fatalf("invalid pulse resolved: %+v", resolved)
		}
	}
	resolved, err := ResolveBlock(&Block{Kind: "oneshot", Agent: "pi-openai-terra", Pulse: &Pulse{Every: "59m"}}, reg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if resolved.PulseIntervalMS != 0 {
		t.Fatalf("Pi pulse resolved: %+v", resolved)
	}
}
