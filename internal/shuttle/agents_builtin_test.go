package shuttle

import (
	"slices"
	"strings"
	"testing"
)

// TestBuiltinRegistry_IsGenericAndComplete pins what a stranger's felt ships
// with. Two failure modes to guard, pulling opposite ways: the set drifting back
// toward one operator's account tiers, and the set thinning until the tool looks
// broken out of the box.
func TestBuiltinRegistry_IsGenericAndComplete(t *testing.T) {
	reg, err := LoadBuiltinAgentRegistry()
	if err != nil {
		t.Fatalf("LoadBuiltinAgentRegistry: %v", err)
	}

	want := []string{
		"claude-sonnet", "claude-opus", "claude-haiku", "claude-fable",
		"claude-sonnet-headless", "claude-opus-headless",
		"codex", "human",
	}
	if got := reg.IDs(); !slices.Equal(got, want) {
		t.Fatalf("built-in ids = %v, want %v", got, want)
	}

	for _, a := range reg.Records() {
		if a.Source != SourceBuiltin {
			t.Fatalf("record %q has source %q, want %q", a.ID, a.Source, SourceBuiltin)
		}
		// A model *tier* names an account's entitlement; a harness names a CLI.
		// Built-ins may only claim harnesses and the generic tier words.
		if strings.Contains(a.Model, "gpt-") || strings.HasPrefix(a.ID, "pi-") {
			t.Fatalf("record %q looks account-specific (model %q) — belongs in the user registry", a.ID, a.Model)
		}
	}

	def, err := reg.Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	if def.ID != "claude-sonnet" {
		t.Fatalf("default = %q, want claude-sonnet", def.ID)
	}

	// Exactly one default, or Default() is picking arbitrarily.
	defaults := 0
	for _, a := range reg.Records() {
		if a.Default {
			defaults++
		}
	}
	if defaults != 1 {
		t.Fatalf("%d built-ins marked default, want exactly 1", defaults)
	}
}

// TestBuiltinRegistry_HeadlessIsReachable: headless has no shuttle:-block field,
// so an alias record is the only way a fiber can ask for print mode. Ship the
// aliases or the capability is gone.
func TestBuiltinRegistry_HeadlessIsReachable(t *testing.T) {
	reg, err := LoadBuiltinAgentRegistry()
	if err != nil {
		t.Fatalf("LoadBuiltinAgentRegistry: %v", err)
	}
	base, axes, err := reg.Resolve("claude-opus-headless", "", false)
	if err != nil {
		t.Fatalf("Resolve(claude-opus-headless): %v", err)
	}
	if base.ID != "claude-opus" || !axes.Headless {
		t.Fatalf("resolved %+v / %+v, want claude-opus with headless", base, axes)
	}
}

// TestBuiltinRegistry_WrapperDefaultsToCLI: the record format lets `wrapper` be
// omitted, and the loader fills it from `cli`. The daemon reads wrapper to build
// the launch command, so an empty one would dispatch nothing.
func TestBuiltinRegistry_WrapperDefaultsToCLI(t *testing.T) {
	reg, err := LoadBuiltinAgentRegistry()
	if err != nil {
		t.Fatalf("LoadBuiltinAgentRegistry: %v", err)
	}
	for _, a := range reg.Records() {
		if a.IsAlias() {
			continue
		}
		if a.Wrapper != a.CLI {
			t.Fatalf("%s: wrapper = %q, want the cli %q", a.ID, a.Wrapper, a.CLI)
		}
	}
}

// TestFleetFixtureParses guards the axis tests' fixture (the pre-trim 22, also
// shipped as share/agents.example.json) against bit-rot in the record format.
func TestFleetFixtureParses(t *testing.T) {
	reg := loadReg(t)
	if len(reg.Records()) != 22 {
		t.Fatalf("fleet fixture has %d records, want 22", len(reg.Records()))
	}
	if _, ok := reg.Find("human"); !ok {
		t.Fatal("fleet fixture is missing the reserved human agent")
	}
}
