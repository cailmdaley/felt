package shuttle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---- Validation tests -------------------------------------------------------

func TestValidate_ValidOneshot(t *testing.T) {
	b := &Block{Kind: "oneshot", ProjectDir: "/tmp/project", Host: "test-host"}
	if errs := Validate(b, nil); len(errs) != 0 {
		t.Fatalf("expected no errors, got: %v", errs)
	}
}

func TestValidate_ValidStanding(t *testing.T) {
	b := &Block{
		Kind:       "standing",
		ProjectDir: "/tmp/project",
		Host:       "test-host",
		Schedule:   &Schedule{Expr: "0 9 * * 1-5", TZ: "Europe/Paris"},
	}
	if errs := Validate(b, nil); len(errs) != 0 {
		t.Fatalf("expected no errors, got: %v", errs)
	}
}

func TestValidate_MinimalBlockValidates(t *testing.T) {
	// Validate keys only on kind (+ schedule for standing, + agent registry).
	// project_dir/host requirements for an armed install belong to the install
	// path, which knows the status. A host-less, project_dir-less oneshot block
	// is structurally valid.
	b := &Block{Kind: "oneshot"}
	if errs := Validate(b, nil); len(errs) != 0 {
		t.Fatalf("expected no errors for minimal oneshot block, got: %v", errs)
	}
}

func TestValidate_BadCron(t *testing.T) {
	b := &Block{
		Kind:       "standing",
		ProjectDir: "/tmp/project",
		Host:       "test-host",
		Schedule:   &Schedule{Expr: "0 25 * * *", TZ: "UTC"},
	}
	errs := Validate(b, nil)
	if len(errs) == 0 {
		t.Fatal("expected validation error for invalid cron")
	}
	if !strings.Contains(errs[0].Field, "schedule.expr") {
		t.Fatalf("expected schedule.expr error, got field=%q", errs[0].Field)
	}
}

func TestValidate_BadTimezone(t *testing.T) {
	b := &Block{
		Kind:       "standing",
		ProjectDir: "/tmp/project",
		Host:       "test-host",
		Schedule:   &Schedule{Expr: "0 9 * * *", TZ: "Atlantis/Bermuda"},
	}
	errs := Validate(b, nil)
	if len(errs) == 0 {
		t.Fatal("expected validation error for unknown timezone")
	}
	if !strings.Contains(errs[0].Field, "schedule.tz") {
		t.Fatalf("expected schedule.tz error, got field=%q", errs[0].Field)
	}
}

func TestValidate_MissingScheduleForStanding(t *testing.T) {
	b := &Block{Kind: "standing", ProjectDir: "/tmp/project"}
	errs := Validate(b, nil)
	if len(errs) == 0 {
		t.Fatal("expected error: schedule required for standing")
	}
}

func TestValidate_BadKind(t *testing.T) {
	b := &Block{Kind: "weekly"}
	errs := Validate(b, nil)
	if len(errs) == 0 {
		t.Fatal("expected validation error for unknown kind")
	}
}

func TestValidate_ValidPinned(t *testing.T) {
	// A pinned role is schedule-less and valid without a schedule.
	b := &Block{Kind: "pinned", ProjectDir: "/tmp/project", Host: "test-host"}
	if errs := Validate(b, nil); len(errs) != 0 {
		t.Fatalf("expected no errors for valid pinned block, got: %v", errs)
	}
}

func TestValidate_PinnedRejectsSchedule(t *testing.T) {
	// A schedule on a pinned role is contradictory (pinned never auto-dispatches)
	// and must be rejected loudly.
	b := &Block{
		Kind:       "pinned",
		ProjectDir: "/tmp/project",
		Host:       "test-host",
		Schedule:   &Schedule{Expr: "0 9 * * 1-5", TZ: "UTC"},
	}
	errs := Validate(b, nil)
	if len(errs) == 0 {
		t.Fatal("expected error: schedule not allowed for kind=pinned")
	}
	found := false
	for _, e := range errs {
		if e.Field == "schedule" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a schedule field error, got: %v", errs)
	}
}

// ---- Cron next occurrence ---------------------------------------------------

func TestNextOccurrence(t *testing.T) {
	s := &Schedule{Expr: "0 9 * * 1-5", TZ: "Europe/Paris"}
	// Use a reference time: Monday 2026-05-04 08:00 Paris time.
	paris, _ := time.LoadLocation("Europe/Paris")
	after := time.Date(2026, 5, 4, 6, 0, 0, 0, time.UTC) // 08:00 Paris
	next, err := NextOccurrence(s, after)
	if err != nil {
		t.Fatalf("NextOccurrence error: %v", err)
	}
	if next.In(paris).Hour() != 9 {
		t.Fatalf("expected hour=9, got %d", next.In(paris).Hour())
	}
}

func TestPrevOccurrence(t *testing.T) {
	s := &Schedule{Expr: "0 9 * * 1-5", TZ: "Europe/Paris"}
	paris, _ := time.LoadLocation("Europe/Paris")

	// After Monday's 09:00 tick → prev is that same Monday tick.
	// 2026-05-04 is a Monday; 2026-05-01 is the previous Friday.
	after := time.Date(2026, 5, 4, 10, 0, 0, 0, paris) // Mon 10:00 Paris
	prev, err := PrevOccurrence(s, after)
	if err != nil {
		t.Fatalf("PrevOccurrence error: %v", err)
	}
	if h := prev.In(paris).Hour(); h != 9 {
		t.Fatalf("prev hour = %d, want 9", h)
	}
	if d := prev.In(paris).Day(); d != 4 {
		t.Fatalf("prev day = %d, want 4 (same Monday)", d)
	}
	if prev.After(after) {
		t.Fatalf("prev %v must be <= before %v", prev, after)
	}

	// Before Monday's 09:00 tick → prev skips the weekend to the previous Friday.
	before := time.Date(2026, 5, 4, 8, 0, 0, 0, paris) // Mon 08:00 Paris
	prev2, err := PrevOccurrence(s, before)
	if err != nil {
		t.Fatalf("PrevOccurrence error: %v", err)
	}
	if wd := prev2.In(paris).Weekday(); wd != time.Friday {
		t.Fatalf("prev weekday = %v, want Friday (cron is Mon-Fri, no weekend tick)", wd)
	}
	if d := prev2.In(paris).Day(); d != 1 {
		t.Fatalf("prev day = %d, want 1 (previous Friday)", d)
	}
}

// TestPrevNextBracketNow is the invariant the daemon's catch-up decision rests
// on: for any now, prev ≤ now < next, and the tick immediately after prev is
// exactly next — i.e. (prev, next) contains no occurrence, so "a tick fired
// since last_serviced" reduces to "prev > last_serviced".
func TestPrevNextBracketNow(t *testing.T) {
	s := &Schedule{Expr: "30 14 10 * *", TZ: "Europe/Paris"} // 14:30 on the 10th, monthly
	now := time.Date(2026, 6, 21, 9, 3, 17, 0, time.UTC)     // arbitrary mid-month instant
	prev, err := PrevOccurrence(s, now)
	if err != nil {
		t.Fatalf("PrevOccurrence error: %v", err)
	}
	next, err := NextOccurrence(s, now)
	if err != nil {
		t.Fatalf("NextOccurrence error: %v", err)
	}
	if prev.After(now) {
		t.Fatalf("prev %v must be <= now %v", prev, now)
	}
	if !next.After(now) {
		t.Fatalf("next %v must be > now %v", next, now)
	}
	// The first tick strictly after prev is next — nothing fires between them.
	bridge, err := NextOccurrence(s, prev)
	if err != nil {
		t.Fatalf("NextOccurrence(prev) error: %v", err)
	}
	if !bridge.Equal(next) {
		t.Fatalf("NextOccurrence(prev)=%v != next=%v — a tick exists in (prev,next)", bridge, next)
	}
}

// ---- Agent registry ---------------------------------------------------------

func TestAgentRegistry_FindByID(t *testing.T) {
	// Build a minimal registry via LoadAgentRegistryFromFile on a temp JSON.
	dir := t.TempDir()
	agentJSON := `[{"id":"test-agent","cli":"test","wrapper":"test","aliases":[],"default":true}]`
	agentsPath := filepath.Join(dir, "agents.json")
	_ = os.WriteFile(agentsPath, []byte(agentJSON), 0644)

	reg, err := LoadAgentRegistryFromFile(agentsPath)
	if err != nil {
		t.Fatalf("LoadAgentRegistryFromFile: %v", err)
	}
	a, ok := reg.Find("test-agent")
	if !ok {
		t.Fatal("expected to find test-agent")
	}
	if a.ID != "test-agent" {
		t.Fatalf("expected id=test-agent, got %q", a.ID)
	}
}

func TestAgentRegistry_FindByAlias(t *testing.T) {
	dir := t.TempDir()
	agentJSON := `[{"id":"my-agent","cli":"cli","wrapper":"w","aliases":["shortname"],"default":false}]`
	_ = os.WriteFile(filepath.Join(dir, "agents.json"), []byte(agentJSON), 0644)
	reg, _ := LoadAgentRegistryFromFile(filepath.Join(dir, "agents.json"))

	_, ok := reg.Find("shortname")
	if !ok {
		t.Fatal("expected to find by alias 'shortname'")
	}
}

func TestValidate_UnknownAgent(t *testing.T) {
	dir := t.TempDir()
	agentJSON := `[{"id":"known","cli":"cli","wrapper":"w","aliases":[],"default":true}]`
	_ = os.WriteFile(filepath.Join(dir, "agents.json"), []byte(agentJSON), 0644)
	agents, _ := LoadAgentRegistryFromFile(filepath.Join(dir, "agents.json"))

	b := &Block{Kind: "oneshot", ProjectDir: "/tmp/project", Host: "test-host", Agent: "unknown-agent"}
	errs := Validate(b, agents)
	if len(errs) == 0 {
		t.Fatal("expected validation error for unknown agent")
	}
	if errs[0].Field != "agent" {
		t.Fatalf("expected field=agent, got %q", errs[0].Field)
	}
}

// ---- Block JSON unmarshaling ------------------------------------------------

func TestBlockUnmarshalJSON_NewFormat(t *testing.T) {
	var block Block
	// A felt JSON view may still carry legacy/retired keys (enabled, review, and
	// the retired interactive axis); they drop silently (no read-tolerance, no
	// struct field) — they must not error, and the live fields decode normally.
	data := []byte(`{
	  "enabled": true,
	  "kind": "standing",
	  "interactive": true,
	  "agent": "claude-sonnet",
	  "schedule": {"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	  "review": {"state": "scheduled"}
	}`)
	if err := json.Unmarshal(data, &block); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if block.Kind != "standing" || block.Agent != "claude-sonnet" {
		t.Fatalf("unexpected block: %+v", block)
	}
	if block.Schedule == nil || block.Schedule.TZ != "Europe/Paris" {
		t.Fatalf("unexpected schedule: %+v", block.Schedule)
	}
}

func TestBlockUnmarshalJSON_LegacyAliases(t *testing.T) {
	var block Block
	data := []byte(`{
	  "mode": "standing",
	  "schedule": {"expr": "0 9 * * 1-5", "timezone": "UTC"}
	}`)
	if err := json.Unmarshal(data, &block); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if block.Kind != "standing" {
		t.Fatalf("expected legacy mode to populate Kind, got %+v", block)
	}
	if block.Schedule == nil || block.Schedule.TZ != "UTC" {
		t.Fatalf("expected legacy timezone alias, got %+v", block.Schedule)
	}
}
