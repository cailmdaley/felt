package shuttle

import (
	"strings"
	"testing"
)

// loadReg loads the embedded registry for axis tests.
func loadReg(t *testing.T) *AgentRegistry {
	t.Helper()
	reg, err := LoadAgentRegistry()
	if err != nil {
		t.Fatalf("loading registry: %v", err)
	}
	return reg
}

func TestResolve_BareClaudeUsesRegistryDefaultEffort(t *testing.T) {
	reg := loadReg(t)
	base, eff, err := reg.Resolve("claude-opus", "", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if base.ID != "claude-opus" {
		t.Fatalf("base = %q, want claude-opus", base.ID)
	}
	// claude-opus's registry default_effort is xhigh.
	if eff.Effort != "xhigh" || eff.Chrome {
		t.Fatalf("expected effort=xhigh and chrome=false, got %+v", eff)
	}
}

func TestResolve_ClaudeEffortValid(t *testing.T) {
	reg := loadReg(t)
	_, eff, err := reg.Resolve("claude-opus", "xhigh", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if eff.Effort != "xhigh" {
		t.Fatalf("effort = %q, want xhigh", eff.Effort)
	}
}

func TestResolve_EffortOutOfRange(t *testing.T) {
	reg := loadReg(t)
	// Copilot Sonnet caps at high; xhigh must be rejected.
	_, _, err := reg.Resolve("pi-sonnet", "xhigh", false)
	if err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("expected effort-out-of-range error, got: %v", err)
	}
}

func TestResolve_PiDefaultEffort(t *testing.T) {
	reg := loadReg(t)
	_, eff, err := reg.Resolve("pi-sonnet", "", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if eff.Effort != "high" {
		t.Fatalf("pi-sonnet default effort = %q, want high", eff.Effort)
	}
}

func TestResolve_EffortUnsupported(t *testing.T) {
	reg := loadReg(t)
	// openrouter pi agents have no effort axis.
	_, _, err := reg.Resolve("pi-kimi", "high", false)
	if err == nil || !strings.Contains(err.Error(), "does not support an effort") {
		t.Fatalf("expected effort-unsupported error, got: %v", err)
	}
}

func TestResolve_ChromeOnNonClaudeRejected(t *testing.T) {
	reg := loadReg(t)
	_, _, err := reg.Resolve("codex", "", true)
	if err == nil || !strings.Contains(err.Error(), "chrome not supported") {
		t.Fatalf("expected chrome-unsupported error, got: %v", err)
	}
}

func TestResolve_ChromeAliasExpands(t *testing.T) {
	reg := loadReg(t)
	base, eff, err := reg.Resolve("claude-opus-chrome", "", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if base.ID != "claude-opus" {
		t.Fatalf("alias base = %q, want claude-opus", base.ID)
	}
	if !eff.Chrome {
		t.Fatalf("expected chrome:true from alias overlay, got %+v", eff)
	}
}

func TestResolve_HeadlessAliasExpands(t *testing.T) {
	reg := loadReg(t)
	base, eff, err := reg.Resolve("claude-haiku-headless", "", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if base.ID != "claude-haiku" {
		t.Fatalf("alias base = %q, want claude-haiku", base.ID)
	}
	if !eff.Headless {
		t.Fatalf("expected headless:true from alias overlay, got %+v", eff)
	}
	// Headless composes with effort declared on the block.
	_, eff2, err := reg.Resolve("claude-opus-headless", "max", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !eff2.Headless || eff2.Effort != "max" {
		t.Fatalf("expected headless:true effort:max, got %+v", eff2)
	}
}

// Note: headless rejection on a non-claude harness is unreachable through the
// public API — headless has no shuttle:-block field, so it only ever arrives
// via a claude-base alias overlay. The validateAxes guard is symmetric
// defense-in-depth (mirroring the Elixir side's white-box test) for any future
// non-claude `*-headless` alias slipped into the registry.

func TestResolve_UnknownAgent(t *testing.T) {
	reg := loadReg(t)
	_, _, err := reg.Resolve("nope", "", false)
	if err == nil || !strings.Contains(err.Error(), "unknown agent") {
		t.Fatalf("expected unknown-agent error, got: %v", err)
	}
}

func TestValidate_AxesIntegration(t *testing.T) {
	reg := loadReg(t)
	// chrome on codex via the full Block validation path.
	b := &Block{Kind: "oneshot", ProjectDir: "/tmp/p", Host: "h", Agent: "codex", Chrome: true}
	errs := Validate(b, reg)
	if len(errs) == 0 {
		t.Fatalf("expected validation error for chrome on codex")
	}
	// valid composition passes.
	b2 := &Block{Kind: "oneshot", ProjectDir: "/tmp/p", Host: "h", Agent: "claude-sonnet", Effort: "high", Chrome: true}
	if errs := Validate(b2, reg); len(errs) != 0 {
		t.Fatalf("expected valid, got: %v", errs)
	}
}

func TestBaseIDs_ExcludesAliases(t *testing.T) {
	reg := loadReg(t)
	for _, id := range reg.BaseIDs() {
		if id == "claude-opus-chrome" {
			t.Fatalf("BaseIDs should exclude alias claude-opus-chrome")
		}
	}
}
