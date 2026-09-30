package shuttlecli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestShuttleCheckValidatesBlocksAndReportsHostDrift(t *testing.T) {
	dir, storage := newStore(t)
	seedFiber(t, storage, "work/invalid", "invalid-uid", felt.StatusActive, map[string]any{
		"kind": "unknown",
		"host": "MyHost.local",
	}, nil)
	t.Setenv("SHUTTLE_HOST", "myhost")

	out, err := runCommand(t, dir, "check", "--json")
	if err == nil || !strings.Contains(err.Error(), "shuttle check failed: 1 error(s)") {
		t.Fatalf("shuttle check error = %v, want one schema error", err)
	}
	var issues []felt.CheckIssue
	if err := json.Unmarshal([]byte(out), &issues); err != nil {
		t.Fatalf("decode check issues: %v\n%s", err, out)
	}
	if len(issues) != 2 {
		t.Fatalf("got %d issues, want schema error and host-drift warning: %#v", len(issues), issues)
	}
	if issues[0].Level != felt.CheckLevelError || issues[0].Path != "shuttle" {
		t.Fatalf("schema issue = %#v", issues[0])
	}
	if issues[1].Level != felt.CheckLevelWarning || issues[1].Path != "shuttle.host" {
		t.Fatalf("host-drift issue = %#v", issues[1])
	}
}

func TestShuttleCheckAcceptsValidBlock(t *testing.T) {
	dir, storage := newStore(t)
	seedFiber(t, storage, "work/valid", "valid-uid", felt.StatusActive, map[string]any{
		"kind": "oneshot",
		"host": "another-host",
	}, nil)

	out, err := runCommand(t, dir, "check")
	if err != nil {
		t.Fatalf("shuttle check: %v", err)
	}
	if strings.TrimSpace(out) != "Check OK" {
		t.Fatalf("shuttle check output = %q, want Check OK", out)
	}
}
