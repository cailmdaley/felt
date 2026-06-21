package shuttle

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestSchedule_AcceptsLegacyTimezone(t *testing.T) {
	const yamlSrc = `
expr: "0 9 * * 1-5"
kind: cron
timezone: Europe/Paris
`
	var s Schedule
	if err := yaml.Unmarshal([]byte(yamlSrc), &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if s.Expr != "0 9 * * 1-5" {
		t.Fatalf("expr: %q", s.Expr)
	}
	if s.TZ != "Europe/Paris" {
		t.Fatalf("tz: %q (expected Europe/Paris from legacy timezone field)", s.TZ)
	}
}

func TestSchedule_PrefersTzOverTimezone(t *testing.T) {
	const yamlSrc = `
expr: "0 9 * * *"
tz: UTC
timezone: Europe/Paris
`
	var s Schedule
	if err := yaml.Unmarshal([]byte(yamlSrc), &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if s.TZ != "UTC" {
		t.Fatalf("expected tz to win: %q", s.TZ)
	}
}

func TestSchedule_EmitsOnlyTz(t *testing.T) {
	s := Schedule{Expr: "0 9 * * 1-5", TZ: "Europe/Paris"}
	out, err := yaml.Marshal(&s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "timezone") {
		t.Fatalf("output contains legacy timezone field:\n%s", string(out))
	}
	if !strings.Contains(string(out), "tz: Europe/Paris") {
		t.Fatalf("output missing tz: Europe/Paris:\n%s", string(out))
	}
}
