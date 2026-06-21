package felt

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/shuttle"
	"gopkg.in/yaml.v3"
)

// fiberWithShuttleNode plants a raw yaml.Node as the shuttle: ExtraField,
// bypassing SetExtraField's mapping wrapper — so a degenerate (scalar/null/
// sequence) shuttle value can be exercised.
func fiberWithShuttleNode(t *testing.T, node *yaml.Node) *Felt {
	t.Helper()
	f, err := New("test-fiber", "Test Fiber")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	f.ExtraFields = map[string]*yaml.Node{ShuttleFacetKey: node}
	f.ExtraFieldOrder = []string{ShuttleFacetKey}
	return f
}

// TestShuttleFacet_NonMappingIsNotAFacet proves a degenerate shuttle: value (a
// scalar, null, or sequence — not a YAML mapping) is treated as a pure
// ExtraField: felt does not interpret it, never validates or resolves it, and —
// critically — never crashes or fails a read on it (the daemon polls felt ls
// --json over the whole loom; one malformed block must not take it down).
func TestShuttleFacet_NonMappingIsNotAFacet(t *testing.T) {
	cases := map[string]*yaml.Node{
		"scalar":   {Kind: yaml.ScalarNode, Tag: "!!str", Value: "just-a-string"},
		"null":     {Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"},
		"sequence": {Kind: yaml.SequenceNode, Tag: "!!seq", Content: []*yaml.Node{{Kind: yaml.ScalarNode, Value: "a"}}},
	}
	reg, err := shuttle.LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	for name, node := range cases {
		t.Run(name, func(t *testing.T) {
			f := fiberWithShuttleNode(t, node)
			if f.HasShuttleFacet() {
				t.Fatal("a non-mapping shuttle value must not count as a facet")
			}
			if _, ok, err := f.ShuttleBlock(); ok || err != nil {
				t.Fatalf("ShuttleBlock: ok=%v err=%v, want false/nil", ok, err)
			}
			if err := f.ValidateShuttleFacet(); err != nil {
				t.Fatalf("validation must be a no-op on a non-facet, got: %v", err)
			}
			// The read path must not panic or error, and must attach nothing.
			if err := f.AttachShuttleResolution(reg, time.Now()); err != nil {
				t.Fatalf("AttachShuttleResolution must not fail on a non-facet, got: %v", err)
			}
			if _, ok := f.ResolvedShuttle(); ok {
				t.Fatal("a non-facet must attach no resolution")
			}
			// And the raw value still round-trips through MarshalJSON unchanged.
			out := marshalShuttle(t, f)
			if _, ok := out[ShuttleFacetKey]; !ok {
				t.Fatal("the raw shuttle value must still emit (opaque round-trip)")
			}
		})
	}
}

// TestShuttleFacet_LegacyModeAlias proves felt's YAML decode path honors the
// legacy `mode:` -> `kind:` alias (a block carrying mode: standing must validate
// and resolve a next_due, not be rejected for an empty kind).
func TestShuttleFacet_LegacyModeAlias(t *testing.T) {
	f := shuttleFiber(t, map[string]any{
		"mode":     "standing",
		"agent":    "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	})
	b, ok, err := f.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Kind != "standing" {
		t.Fatalf("mode: standing should decode to Kind=standing, got %q", b.Kind)
	}
	if err := f.ValidateShuttleFacet(); err != nil {
		t.Fatalf("a valid mode: standing block must validate, got: %v", err)
	}
	out := marshalShuttle(t, f)
	sh := out["shuttle"].(map[string]any)
	resolved, ok := sh["resolved"].(map[string]any)
	if !ok {
		t.Fatalf("expected resolved for a mode: standing role, got: %v", sh)
	}
	if _, ok := resolved["next_due"]; !ok {
		t.Fatalf("mode: standing must resolve a next_due, got: %v", resolved)
	}
}

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

// TestSetShuttleField_PreservesRuntimeKeys is the load-bearing test for the
// Stage-3 write primitive: stamping a single config/runtime field (as a worker's
// `handoff` does, or `set-model`) must leave every sibling key — especially the
// daemon-owned continuation fields — exactly in place, and survive a full
// Marshal -> Parse round-trip through the on-disk frontmatter format.
func TestSetShuttleField_PreservesRuntimeKeys(t *testing.T) {
	f := shuttleFiber(t, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "h", "project_dir": "/tmp/x",
		"session_uuid": "abc-123", "dispatched_at": "2026-06-21T00:00:00Z",
	})

	// A worker's clean-exit stamp.
	if err := f.SetShuttleField("handed_off_at", "2026-06-21T01:00:00Z"); err != nil {
		t.Fatalf("SetShuttleField(handed_off_at): %v", err)
	}
	// A config edit (set-model) on the same block.
	if err := f.SetShuttleField("agent", "claude-sonnet"); err != nil {
		t.Fatalf("SetShuttleField(agent): %v", err)
	}

	// Round-trip through the on-disk format to prove durability, not just memory.
	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := Parse(f.ID, raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	sh := marshalShuttle(t, f2)["shuttle"].(map[string]any)
	want := map[string]string{
		"kind": "oneshot", "host": "h", "project_dir": "/tmp/x",
		"session_uuid": "abc-123", "dispatched_at": "2026-06-21T00:00:00Z",
		"handed_off_at": "2026-06-21T01:00:00Z", // stamped
		"agent":         "claude-sonnet",        // replaced in place
	}
	for k, v := range want {
		if got := sh[k]; got != v {
			t.Fatalf("shuttle.%s = %v after round-trip, want %q (a sibling was clobbered or the set failed)", k, got, v)
		}
	}
}

// TestSetShuttleRuntimeField_NestsAndPreserves proves the Stage-5 nested writer:
// runtime fields land under shuttle.runtime (not as flat siblings), a config edit
// rides past them untouched, an empty value removes a nested key, and it all
// survives the on-disk round-trip.
func TestSetShuttleRuntimeField_NestsAndPreserves(t *testing.T) {
	f := shuttleFiber(t, map[string]any{
		"kind": "standing", "agent": "claude-opus", "host": "h", "project_dir": "/tmp/x",
	})

	// Daemon dispatch stamp (three runtime fields) + a config edit on the same block.
	for k, v := range map[string]string{
		"dispatched_at": "2026-06-21T00:00:00Z",
		"session_uuid":  "abc-123",
		"run_id":        "20260621T000000Z",
	} {
		if err := f.SetShuttleRuntimeField(k, v); err != nil {
			t.Fatalf("SetShuttleRuntimeField(%s): %v", k, err)
		}
	}
	if err := f.SetShuttleField("agent", "claude-sonnet"); err != nil {
		t.Fatalf("SetShuttleField(agent): %v", err)
	}

	// Round-trip through the on-disk format to prove durability, not just memory.
	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := Parse(f.ID, raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	sh := marshalShuttle(t, f2)["shuttle"].(map[string]any)

	// Config keys stay flat at the top level.
	for k, v := range map[string]string{"kind": "standing", "agent": "claude-sonnet", "host": "h"} {
		if got := sh[k]; got != v {
			t.Fatalf("shuttle.%s = %v, want %q (config clobbered)", k, got, v)
		}
	}
	// Runtime keys are NESTED under shuttle.runtime, not flat siblings.
	for _, k := range []string{"dispatched_at", "session_uuid", "run_id"} {
		if _, flat := sh[k]; flat {
			t.Fatalf("shuttle.%s leaked to the top level; runtime must nest under shuttle.runtime", k)
		}
	}
	rt, ok := sh["runtime"].(map[string]any)
	if !ok {
		t.Fatalf("shuttle.runtime missing or not a mapping: %#v", sh["runtime"])
	}
	for k, v := range map[string]string{
		"dispatched_at": "2026-06-21T00:00:00Z", "session_uuid": "abc-123", "run_id": "20260621T000000Z",
	} {
		if got := rt[k]; got != v {
			t.Fatalf("shuttle.runtime.%s = %v, want %q", k, got, v)
		}
	}

	// Empty value removes a nested key (omitempty), leaving the others.
	if err := f2.SetShuttleRuntimeField("session_uuid", ""); err != nil {
		t.Fatalf("SetShuttleRuntimeField(clear): %v", err)
	}
	sh2 := marshalShuttle(t, roundTrip(t, f2))["shuttle"].(map[string]any)
	rt2 := sh2["runtime"].(map[string]any)
	if _, present := rt2["session_uuid"]; present {
		t.Fatal("empty value should remove shuttle.runtime.session_uuid")
	}
	if rt2["dispatched_at"] != "2026-06-21T00:00:00Z" {
		t.Fatalf("clearing one runtime key dropped a sibling: %#v", rt2)
	}
}

// roundTrip marshals f to bytes and re-parses it — proves a mutation persists on
// disk, not just in the in-memory node.
func roundTrip(t *testing.T, f *Felt) *Felt {
	t.Helper()
	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := Parse(f.ID, raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return f2
}

// TestSetShuttleField_NoBlockErrors proves the primitive refuses to invent a
// block: a pure note (or a fiber whose block was uninstalled) has no mapping to
// set a field on, and the caller must build one via SetExtraField instead.
func TestSetShuttleField_NoBlockErrors(t *testing.T) {
	f := shuttleFiber(t, nil)
	if err := f.SetShuttleField("handed_off_at", "2026-06-21T01:00:00Z"); err == nil {
		t.Fatal("SetShuttleField on a pure note must error, got nil")
	}
}

// TestSetShuttleNodeField_TypedAndDelete proves the typed counterpart writes a
// real !!bool (so the daemon/validation decode chrome correctly), drops a key on
// a nil value (omitempty), and — like SetShuttleField — preserves the runtime
// siblings across a Marshal -> Parse round-trip. This is the set-agent primitive.
func TestSetShuttleNodeField_TypedAndDelete(t *testing.T) {
	f := shuttleFiber(t, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "effort": "high",
		"session_uuid": "abc-123", "dispatched_at": "2026-06-21T00:00:00Z",
	})

	// chrome as a real bool; effort cleared (deleted); agent replaced.
	if err := f.SetShuttleNodeField("chrome", true); err != nil {
		t.Fatalf("SetShuttleNodeField(chrome): %v", err)
	}
	if err := f.SetShuttleNodeField("effort", nil); err != nil {
		t.Fatalf("SetShuttleNodeField(effort, nil): %v", err)
	}
	if err := f.SetShuttleNodeField("agent", "claude-sonnet"); err != nil {
		t.Fatalf("SetShuttleNodeField(agent): %v", err)
	}

	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := Parse(f.ID, raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	// chrome must decode to a typed bool through the typed Block (not a string).
	b, ok, err := f2.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if !b.Chrome {
		t.Fatalf("chrome must decode to bool true, got block %+v", b)
	}
	if b.Effort != "" {
		t.Fatalf("effort must be dropped (omitempty), got %q", b.Effort)
	}
	if b.Agent != "claude-sonnet" {
		t.Fatalf("agent must be replaced, got %q", b.Agent)
	}

	// Runtime siblings survive untouched.
	sh := marshalShuttle(t, f2)["shuttle"].(map[string]any)
	if sh["session_uuid"] != "abc-123" || sh["dispatched_at"] != "2026-06-21T00:00:00Z" {
		t.Fatalf("runtime keys clobbered: %v", sh)
	}
	if _, present := sh["effort"]; present {
		t.Fatalf("effort key must be absent after delete, got: %v", sh)
	}
}

// TestSetShuttleConfig_PreservesRuntimeKeys is the regression for the repeat
// runtime-key clobber: re-installing a block's config (a recurrence redefinition)
// must keep the daemon-owned continuation siblings, drop a cleared config key, and
// apply the new config — the felt analogue of shuttle's mergeUnknownShuttleFields.
func TestSetShuttleConfig_PreservesRuntimeKeys(t *testing.T) {
	f := shuttleFiber(t, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "effort": "high",
		"session_uuid": "keep-uuid", "dispatched_at": "2026-06-21T00:00:00Z",
	})

	// Redefine as a standing role with a new agent and no effort.
	newBlock := &shuttle.Block{
		Kind: "standing", Host: "h", ProjectDir: "/tmp/x", Agent: "claude-sonnet",
		Schedule: &shuttle.Schedule{Expr: "0 9 * * 1-5", TZ: "Europe/Paris"},
	}
	if err := f.SetShuttleConfig(newBlock); err != nil {
		t.Fatalf("SetShuttleConfig: %v", err)
	}

	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := Parse(f.ID, raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	b, ok, err := f2.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Kind != "standing" || b.Agent != "claude-sonnet" || b.Schedule == nil || b.Schedule.Expr != "0 9 * * 1-5" {
		t.Fatalf("new config not applied: %+v", b)
	}
	if b.Effort != "" {
		t.Fatalf("a cleared config key must be dropped, got effort=%q", b.Effort)
	}
	sh := marshalShuttle(t, f2)["shuttle"].(map[string]any)
	if sh["session_uuid"] != "keep-uuid" || sh["dispatched_at"] != "2026-06-21T00:00:00Z" {
		t.Fatalf("runtime keys clobbered by config rewrite: %v", sh)
	}
}

// TestSetShuttleConfig_FreshInstall installs wholesale on a fiber with no block.
func TestSetShuttleConfig_FreshInstall(t *testing.T) {
	f := shuttleFiber(t, nil)
	if err := f.SetShuttleConfig(&shuttle.Block{Kind: "oneshot", Host: "h", Agent: "claude-opus"}); err != nil {
		t.Fatalf("SetShuttleConfig (fresh): %v", err)
	}
	if !f.HasShuttleFacet() {
		t.Fatal("fresh SetShuttleConfig must install a facet")
	}
	b, ok, err := f.ShuttleBlock()
	if err != nil || !ok || b.Kind != "oneshot" || b.Agent != "claude-opus" {
		t.Fatalf("fresh block: ok=%v err=%v b=%+v", ok, err, b)
	}
}

func marshalShuttle(t *testing.T, f *Felt) map[string]any {
	t.Helper()
	reg, err := shuttle.LoadAgentRegistry()
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if err := f.AttachShuttleResolution(reg, time.Now()); err != nil {
		t.Fatalf("AttachShuttleResolution: %v", err)
	}
	raw, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	return out
}

func TestAttachShuttleResolution_AdditiveAndFlatPreserved(t *testing.T) {
	// The daemon reads the flat config+runtime fields directly off `shuttle`.
	// Resolution must leave every one of them in place and add ONLY `resolved`.
	f := shuttleFiber(t, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "h", "project_dir": "/tmp/x",
		"session_uuid": "abc-123", "dispatched_at": "2026-06-21T00:00:00Z",
	})
	out := marshalShuttle(t, f)
	sh, ok := out["shuttle"].(map[string]any)
	if !ok {
		t.Fatalf("shuttle key missing/!object: %v", out["shuttle"])
	}
	for _, k := range []string{"kind", "agent", "host", "project_dir", "session_uuid", "dispatched_at"} {
		if _, ok := sh[k]; !ok {
			t.Fatalf("flat field %q was dropped by resolution (daemon contract!)", k)
		}
	}
	resolved, ok := sh["resolved"].(map[string]any)
	if !ok {
		t.Fatalf("resolved sub-key missing/!object: %v", sh["resolved"])
	}
	agent, ok := resolved["agent"].(map[string]any)
	if !ok {
		t.Fatalf("resolved.agent missing: %v", resolved)
	}
	if agent["cli"] != "claude" || agent["model"] != "opus" {
		t.Fatalf("resolved.agent = %v, want claude/opus", agent)
	}
}

func TestAttachShuttleResolution_StandingNextDue(t *testing.T) {
	f := shuttleFiber(t, map[string]any{
		"kind": "standing", "agent": "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	})
	out := marshalShuttle(t, f)
	sh := out["shuttle"].(map[string]any)
	resolved, ok := sh["resolved"].(map[string]any)
	if !ok {
		t.Fatalf("resolved missing for standing role: %v", sh)
	}
	if _, ok := resolved["next_due"]; !ok {
		t.Fatalf("standing role must carry resolved.next_due, got: %v", resolved)
	}
}

func TestAttachShuttleResolution_PureNoteIsNoOp(t *testing.T) {
	f := shuttleFiber(t, nil)
	reg, _ := shuttle.LoadAgentRegistry()
	if err := f.AttachShuttleResolution(reg, time.Now()); err != nil {
		t.Fatalf("AttachShuttleResolution on a note: %v", err)
	}
	if _, ok := f.ResolvedShuttle(); ok {
		t.Fatal("a pure note must attach no resolution")
	}
	out := marshalShuttle(t, f)
	if _, ok := out["shuttle"]; ok {
		t.Fatal("a pure note must emit no shuttle key")
	}
}
