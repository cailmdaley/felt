package shuttlecli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestShuttleCheckValidatesBlocksAndReportsHostDrift(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work/invalid", "invalid-uid", felt.StatusActive, map[string]any{
		"kind": "unknown",
		"host": "MyHost.local",
	}, nil)
	env.Set("SHUTTLE_HOST", "myhost")

	out, err := runIn(t, env, dir, "check", "--json")
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
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work/valid", "valid-uid", felt.StatusActive, map[string]any{
		"kind": "oneshot",
		"host": "another-host",
	}, nil)

	out, err := runIn(t, env, dir, "check")
	if err != nil {
		t.Fatalf("shuttle check: %v", err)
	}
	if strings.TrimSpace(out) != "Check OK" {
		t.Fatalf("shuttle check output = %q, want Check OK", out)
	}
}

func TestShuttleCheckWarnsOnVerdictOffAClosedCard(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	no := false
	seedShuttleRole(t, storage, "hub", "", oneshot(), &no)
	seedShuttleRole(t, storage, "done", felt.StatusClosed, oneshot(), &no)

	out, _ := runIn(t, env, dir, "check", "--json")
	var issues []felt.CheckIssue
	if err := json.Unmarshal([]byte(out), &issues); err != nil {
		t.Fatalf("decode check issues: %v\n%s", err, out)
	}
	var flagged []string
	for _, issue := range issues {
		if issue.Path == "tempered" {
			flagged = append(flagged, issue.FiberID)
		}
	}
	if len(flagged) != 1 || flagged[0] != "hub" {
		t.Fatalf("tempered warnings on %v, want only hub:\n%s", flagged, out)
	}
}
