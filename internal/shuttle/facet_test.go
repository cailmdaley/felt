package shuttle

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"gopkg.in/yaml.v3"
)

// fiberWithShuttleNode plants a raw yaml.Node as the shuttle: ExtraField,
// bypassing SetExtraField's mapping wrapper — so a degenerate (scalar/null/
// sequence) shuttle value can be exercised.
func fiberWithShuttleNode(t *testing.T, node *yaml.Node) *felt.Felt {
	t.Helper()
	f, err := felt.New("test-fiber", "Test Fiber")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	f.ExtraFields = map[string]*yaml.Node{FacetKey: node}
	f.ExtraFieldOrder = []string{FacetKey}
	return f
}

// TestShuttleFacet_NonMappingIsNotAFacet checks that scalar, null, and sequence
// values stay opaque to Shuttle's facet decoder and JSON decorator.
func TestShuttleFacet_NonMappingIsNotAFacet(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	cases := map[string]*yaml.Node{
		"scalar":   {Kind: yaml.ScalarNode, Tag: "!!str", Value: "just-a-string"},
		"null":     {Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"},
		"sequence": {Kind: yaml.SequenceNode, Tag: "!!seq", Content: []*yaml.Node{{Kind: yaml.ScalarNode, Value: "a"}}},
	}
	reg, err := LoadAgentRegistry(env)
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	for name, node := range cases {
		t.Run(name, func(t *testing.T) {
			f := fiberWithShuttleNode(t, node)
			if HasFacet(f) {
				t.Fatal("a non-mapping shuttle value must not count as a facet")
			}
			if _, ok, err := BlockOf(f); ok || err != nil {
				t.Fatalf("BlockOf: ok=%v err=%v, want false/nil", ok, err)
			}
			if err := ValidateFacet(f); err != nil {
				t.Fatalf("validation must be a no-op on a non-facet, got: %v", err)
			}
			// The read path must not panic or error, and must attach nothing.
			if err := Resolve(f, reg, time.Now()); err != nil {
				t.Fatalf("Resolve must not fail on a non-facet, got: %v", err)
			}
			if _, ok := f.JSONField(FacetKey); ok {
				t.Fatal("a non-facet must attach no resolution")
			}
			// And the raw value still round-trips through MarshalJSON unchanged.
			out := marshalShuttle(t, f)
			if _, ok := out[FacetKey]; !ok {
				t.Fatal("the raw shuttle value must still emit (opaque round-trip)")
			}
		})
	}
}

func shuttleFiber(t *testing.T, block map[string]any) *felt.Felt {
	t.Helper()
	f, err := felt.New("test-fiber", "Test Fiber")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if block != nil {
		if err := f.SetExtraField(FacetKey, block); err != nil {
			t.Fatalf("SetExtraField: %v", err)
		}
	}
	return f
}

func TestShuttleFacet_PureNoteIsNoOp(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, nil)
	if HasFacet(f) {
		t.Fatal("a fiber with no shuttle: block must not report a facet")
	}
	if _, ok, err := BlockOf(f); ok || err != nil {
		t.Fatalf("BlockOf on a pure note: ok=%v err=%v, want false/nil", ok, err)
	}
	if err := ValidateFacet(f); err != nil {
		t.Fatalf("pure note must validate as a no-op, got: %v", err)
	}
}

func TestShuttleFacet_ValidOneshot(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{"kind": "oneshot", "agent": "claude-opus", "host": "somehost"})
	if !HasFacet(f) {
		t.Fatal("expected a shuttle facet")
	}
	if err := ValidateFacet(f); err != nil {
		t.Fatalf("valid oneshot must pass, got: %v", err)
	}
}

func TestShuttleFacet_ValidStanding(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{
		"kind":     "standing",
		"agent":    "claude-sonnet",
		"schedule": map[string]any{"expr": "0 9 * * 1-5", "tz": "Europe/Paris"},
	})
	if err := ValidateFacet(f); err != nil {
		t.Fatalf("valid standing must pass, got: %v", err)
	}
}

func TestShuttleFacet_RejectsBadKind(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{"kind": "bogus"})
	err := ValidateFacet(f)
	if err == nil || !strings.Contains(err.Error(), "kind") {
		t.Fatalf("bad kind must fail mentioning kind, got: %v", err)
	}
}

// Facet schema validation does not resolve an agent identity; Shuttle resolves
// agents where a block is armed or dispatched.
func TestShuttleFacet_ToleratesUnknownAgent(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{"kind": "oneshot", "agent": "no-such-agent"})
	if err := ValidateFacet(f); err != nil {
		t.Fatalf("unknown agent must not fail facet validation, got: %v", err)
	}
}

func TestShuttleFacet_StandingRequiresSchedule(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{"kind": "standing", "agent": "claude-sonnet"})
	err := ValidateFacet(f)
	if err == nil || !strings.Contains(err.Error(), "schedule") {
		t.Fatalf("standing without a schedule must fail mentioning schedule, got: %v", err)
	}
}

func TestShuttleFacet_ToleratesRuntimeFields(t *testing.T) {
	t.Parallel()
	// The daemon writes continuation/runtime fields as flat siblings of the
	// config keys. Facet validation accepts them, and the typed view ignores them.
	f := shuttleFiber(t, map[string]any{
		"kind":          "oneshot",
		"agent":         "claude-opus",
		"session_uuid":  "abc-123",
		"dispatched_at": "2026-06-21T00:08:44Z",
		"handed_off_at": "2026-06-21T01:00:00Z",
		"run_id":        "adhoc-xyz",
	})
	if err := ValidateFacet(f); err != nil {
		t.Fatalf("a block carrying runtime fields must validate, got: %v", err)
	}
	b, ok, err := BlockOf(f)
	if err != nil || !ok {
		t.Fatalf("BlockOf: ok=%v err=%v", ok, err)
	}
	if b.Kind != "oneshot" || b.Agent != "claude-opus" {
		t.Fatalf("typed view should decode only config fields, got: %+v", b)
	}
}

// TestSetField_PreservesRuntimeKeys checks that writing one config/runtime key
// preserves sibling fields and survives a Marshal -> Parse round-trip.
func TestSetField_PreservesRuntimeKeys(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "h", "project_dir": "/tmp/x",
		"session_uuid": "abc-123", "dispatched_at": "2026-06-21T00:00:00Z",
	})

	// A worker's clean-exit stamp.
	if err := SetField(f, "handed_off_at", "2026-06-21T01:00:00Z"); err != nil {
		t.Fatalf("SetField(handed_off_at): %v", err)
	}
	// A config edit (set-model) on the same block.
	if err := SetField(f, "agent", "claude-sonnet"); err != nil {
		t.Fatalf("SetField(agent): %v", err)
	}

	// Round-trip through the on-disk format to prove durability, not just memory.
	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := felt.Parse(f.ID, raw)
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

// TestSetRuntimeField_NestsAndPreserves checks that runtime keys nest below
// shuttle.runtime, config edits preserve them, and empty values remove keys.
func TestSetRuntimeField_NestsAndPreserves(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{
		"kind": "standing", "agent": "claude-opus", "host": "h", "project_dir": "/tmp/x",
	})

	// Daemon dispatch stamp (three runtime fields) + a config edit on the same block.
	for k, v := range map[string]string{
		"dispatched_at": "2026-06-21T00:00:00Z",
		"session_uuid":  "abc-123",
		"run_id":        "20260621T000000Z",
	} {
		if err := SetRuntimeField(f, k, v); err != nil {
			t.Fatalf("SetRuntimeField(%s): %v", k, err)
		}
	}
	if err := SetField(f, "agent", "claude-sonnet"); err != nil {
		t.Fatalf("SetField(agent): %v", err)
	}

	// Round-trip through the on-disk format to prove durability, not just memory.
	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := felt.Parse(f.ID, raw)
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
	if err := SetRuntimeField(f2, "session_uuid", ""); err != nil {
		t.Fatalf("SetRuntimeField(clear): %v", err)
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
func roundTrip(t *testing.T, f *felt.Felt) *felt.Felt {
	t.Helper()
	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := felt.Parse(f.ID, raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return f2
}

// TestSetField_NoBlockErrors checks that field writes require a mapping-valued
// facet.
func TestSetField_NoBlockErrors(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, nil)
	if err := SetField(f, "handed_off_at", "2026-06-21T01:00:00Z"); err == nil {
		t.Fatal("SetField on a pure note must error, got nil")
	}
}

// TestSetNodeField_TypedAndDelete checks typed scalar values, key removal, and
// preservation of runtime siblings across a Marshal -> Parse round-trip.
func TestSetNodeField_TypedAndDelete(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "effort": "high",
		"session_uuid": "abc-123", "dispatched_at": "2026-06-21T00:00:00Z",
	})

	// chrome as a real bool; effort cleared (deleted); agent replaced.
	if err := SetNodeField(f, "chrome", true); err != nil {
		t.Fatalf("SetNodeField(chrome): %v", err)
	}
	if err := SetNodeField(f, "effort", nil); err != nil {
		t.Fatalf("SetNodeField(effort, nil): %v", err)
	}
	if err := SetNodeField(f, "agent", "claude-sonnet"); err != nil {
		t.Fatalf("SetNodeField(agent): %v", err)
	}

	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := felt.Parse(f.ID, raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	// chrome must decode to a typed bool through the typed Block (not a string).
	b, ok, err := BlockOf(f2)
	if err != nil || !ok {
		t.Fatalf("BlockOf: ok=%v err=%v", ok, err)
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

// TestSetConfig_PreservesRuntimeKeys checks that replacing block configuration
// retains daemon-owned continuation fields and drops omitted config keys.
func TestSetConfig_PreservesRuntimeKeys(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "effort": "high",
		"session_uuid": "keep-uuid", "dispatched_at": "2026-06-21T00:00:00Z",
	})

	// Redefine as a standing role with a new agent and no effort.
	newBlock := &Block{
		Kind: "standing", Host: "h", ProjectDir: "/tmp/x", Agent: "claude-sonnet",
		Schedule: &Schedule{Expr: "0 9 * * 1-5", TZ: "Europe/Paris"},
	}
	if err := SetConfig(f, newBlock); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	f2, err := felt.Parse(f.ID, raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	b, ok, err := BlockOf(f2)
	if err != nil || !ok {
		t.Fatalf("BlockOf: ok=%v err=%v", ok, err)
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

// TestSetConfig_FreshInstall installs a block on a fiber without a facet.
func TestSetConfig_FreshInstall(t *testing.T) {
	t.Parallel()
	f := shuttleFiber(t, nil)
	if err := SetConfig(f, &Block{Kind: "oneshot", Host: "h", Agent: "claude-opus"}); err != nil {
		t.Fatalf("SetConfig (fresh): %v", err)
	}
	if !HasFacet(f) {
		t.Fatal("fresh SetConfig must install a facet")
	}
	b, ok, err := BlockOf(f)
	if err != nil || !ok || b.Kind != "oneshot" || b.Agent != "claude-opus" {
		t.Fatalf("fresh block: ok=%v err=%v b=%+v", ok, err, b)
	}
}

func marshalShuttle(t *testing.T, f *felt.Felt) map[string]any {
	t.Helper()
	reg, err := LoadAgentRegistry(testEnv(t))
	if err != nil {
		t.Fatalf("LoadAgentRegistry: %v", err)
	}
	if err := Resolve(f, reg, time.Now()); err != nil {
		t.Fatalf("Resolve: %v", err)
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

func TestResolve_AdditiveAndFlatPreserved(t *testing.T) {
	t.Parallel()
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

func TestResolve_StandingNextDue(t *testing.T) {
	t.Parallel()
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

func TestResolve_PureNoteIsNoOp(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	f := shuttleFiber(t, nil)
	reg, _ := LoadAgentRegistry(env)
	if err := Resolve(f, reg, time.Now()); err != nil {
		t.Fatalf("Resolve on a note: %v", err)
	}
	if _, ok := f.JSONField(FacetKey); ok {
		t.Fatal("a pure note must attach no resolution")
	}
	out := marshalShuttle(t, f)
	if _, ok := out["shuttle"]; ok {
		t.Fatal("a pure note must emit no shuttle key")
	}
}
