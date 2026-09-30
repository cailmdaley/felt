package shuttlecli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestShuttleRetiredAgent_ResumeAndReopenRefuse(t *testing.T) {
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusOpen, map[string]any{"kind": "oneshot", "agent": "retired-agent", "project_dir": "/srv/work"}, nil)

	if out, err := runCommand(t, dir, "resume", "f"); err == nil || !strings.Contains(err.Error()+out, "retired-agent") {
		t.Fatalf("resume must refuse a retired agent, got: %v\n%s", err, out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusOpen {
		t.Fatal("refused resume must not arm the fiber")
	}
	if out, err := runCommand(t, dir, "reopen", "f"); err == nil || !strings.Contains(err.Error()+out, "retired-agent") {
		t.Fatalf("reopen must refuse a retired agent, got: %v\n%s", err, out)
	}
	if out, err := runCommand(t, dir, "reopen", "--as-draft", "f"); err != nil {
		t.Fatalf("reopen --as-draft arms nothing and must pass: %v\n%s", err, out)
	}
}
