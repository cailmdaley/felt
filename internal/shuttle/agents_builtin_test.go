package shuttle

import (
	"slices"
	"testing"
)

// TestBuiltinRegistry_IsComplete pins the maintained default fleet. The point
// is that a fresh install is useful without copying an operator's agents.json.
func TestBuiltinRegistry_IsComplete(t *testing.T) {
	reg, err := LoadBuiltinAgentRegistry()
	if err != nil {
		t.Fatalf("LoadBuiltinAgentRegistry: %v", err)
	}

	want := []string{
		"claude-sonnet", "claude-opus", "claude-haiku", "claude-fable",
		"codex-sol", "codex-terra", "codex-luna", "codex",
		"pi-sonnet", "pi-luna",
		"pi-kimi", "pi-deepseek-flash", "pi-glm-flash",
	}
	if got := reg.IDs(); !slices.Equal(got, want) {
		t.Fatalf("built-in ids = %v, want %v", got, want)
	}

	for _, a := range reg.Records() {
		if a.Source != SourceBuiltin {
			t.Fatalf("record %q has source %q, want %q", a.ID, a.Source, SourceBuiltin)
		}
	}
	if _, ok := reg.Find("human"); ok {
		t.Fatal("human must not be a shipped agent")
	}
	for _, id := range []string{"claude-sonnet-headless", "claude-opus-headless", "claude-fable-headless", "claude-haiku-headless"} {
		if _, ok := reg.Find(id); ok {
			t.Fatalf("%s must not be a shipped agent", id)
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

func TestBuiltinRegistry_ChromeAxisIsReachable(t *testing.T) {
	reg, err := LoadBuiltinAgentRegistry()
	if err != nil {
		t.Fatalf("LoadBuiltinAgentRegistry: %v", err)
	}
	base, axes, err := reg.Resolve("claude-opus", "", true)
	if err != nil {
		t.Fatalf("Resolve(claude-opus, chrome=true): %v", err)
	}
	if base.ID != "claude-opus" || !axes.Chrome {
		t.Fatalf("resolved %+v / %+v, want claude-opus with chrome", base, axes)
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

// TestFleetFixtureParses guards the axis tests' fixture (which retains
// headless aliases as an internal -p test fixture) against bit-rot.
func TestFleetFixtureParses(t *testing.T) {
	reg := loadReg(t)
	if len(reg.Records()) != 17 {
		t.Fatalf("fleet fixture has %d records, want 17", len(reg.Records()))
	}
	if _, ok := reg.Find("human"); ok {
		t.Fatal("fleet fixture must not carry the removed human agent")
	}
}
