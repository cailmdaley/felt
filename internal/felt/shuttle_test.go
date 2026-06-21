package felt

import (
	"strings"
	"testing"
)

func shuttleFiber(t *testing.T, block map[string]any) *Felt {
	t.Helper()
	f, err := New("test-fiber", "Test Fiber")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if block != nil {
		if err := f.SetExtraField("shuttle", block); err != nil {
			t.Fatalf("SetExtraField: %v", err)
		}
	}
	return f
}

func TestShuttleFacet_PureNoteIsNoOp(t *testing.T) {
	f := shuttleFiber(t, nil)
	if f.HasShuttleFacet() {
		t.Fatal("a fiber with no shuttle: block must not report a facet")
	}
	if _, ok, err := f.ShuttleBlock(); ok || err != nil {
		t.Fatalf("ShuttleBlock on a pure note: ok=%v err=%v, want false/nil", ok, err)
	}
	if err := f.ValidateShuttleFacet(); err != nil {
		t.Fatalf("pure note must validate as a no-op, got: %v", err)
	}
}

func TestShuttleFacet_ValidOneshot(t *testing.T) {
	f := shuttleFiber(t, map[string]any{"kind": "oneshot", "agent": "claude-opus", "host": "somehost"})
	if !f.HasShuttleFacet() {
		t.Fatal("expected a shuttle facet")
	}
	if err := f.ValidateShuttleFacet(); err != nil {
		t.Fatalf("valid oneshot must pass, got: %v", err)
	}
}

func TestShuttleFacet_ValidStanding(t *testing.T) {
	f := shuttleFiber(t, map[string]any{
		"kind":     "standing",
		"agent":    "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	})
	if err := f.ValidateShuttleFacet(); err != nil {
		t.Fatalf("valid standing must pass, got: %v", err)
	}
}

func TestShuttleFacet_RejectsBadKind(t *testing.T) {
	f := shuttleFiber(t, map[string]any{"kind": "bogus"})
	err := f.ValidateShuttleFacet()
	if err == nil || !strings.Contains(err.Error(), "kind") {
		t.Fatalf("bad kind must fail mentioning kind, got: %v", err)
	}
}

func TestShuttleFacet_RejectsUnknownAgent(t *testing.T) {
	f := shuttleFiber(t, map[string]any{"kind": "oneshot", "agent": "no-such-agent"})
	err := f.ValidateShuttleFacet()
	if err == nil || !strings.Contains(err.Error(), "agent") {
		t.Fatalf("unknown agent must fail mentioning agent, got: %v", err)
	}
}

func TestShuttleFacet_StandingRequiresSchedule(t *testing.T) {
	f := shuttleFiber(t, map[string]any{"kind": "standing", "agent": "claude-sonnet"})
	err := f.ValidateShuttleFacet()
	if err == nil || !strings.Contains(err.Error(), "schedule") {
		t.Fatalf("standing without a schedule must fail mentioning schedule, got: %v", err)
	}
}

func TestShuttleFacet_ToleratesRuntimeFields(t *testing.T) {
	// The daemon and shuttle-ctl write continuation/runtime fields as flat
	// siblings of the config keys. felt's validation must accept a block that
	// carries them, and the typed view must ignore them (they ride opaquely).
	f := shuttleFiber(t, map[string]any{
		"kind":          "oneshot",
		"agent":         "claude-opus",
		"session_uuid":  "abc-123",
		"dispatched_at": "2026-06-21T00:08:44Z",
		"handed_off_at": "2026-06-21T01:00:00Z",
		"run_id":        "adhoc-xyz",
	})
	if err := f.ValidateShuttleFacet(); err != nil {
		t.Fatalf("a block carrying runtime fields must validate, got: %v", err)
	}
	b, ok, err := f.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Kind != "oneshot" || b.Agent != "claude-opus" {
		t.Fatalf("typed view should decode only config fields, got: %+v", b)
	}
}
