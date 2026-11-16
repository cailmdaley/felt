package shuttlecli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestInboxVerbs(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	run := func(args ...string) (string, error) {
		var out bytes.Buffer
		env.Stdout = &out
		cmd := NewRootCmd(env)
		cmd.SetArgs(args)
		err := cmd.Execute()
		return out.String(), err
	}

	if _, err := run("inbox", "put", "/store:FIBER", "later", "wait for it", "--source", "pulse", "--turn", "ask", "--not-before", "2999-01-01T00:00:00Z", "--from", "bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := run("inbox", "put", "/store:FIBER", "now", "context"); err != nil {
		t.Fatal(err)
	}
	if _, err := run("inbox", "put", "/store:FIBER", "bad", "x", "--turn", "later"); messaging.ErrorCode(err) != "invalid_request" {
		t.Fatalf("unknown turn: %v", err)
	}
	if _, err := run("inbox", "put", "/store:FIBER", "now", "other text"); messaging.ErrorCode(err) != "message_id_conflict" {
		t.Fatalf("reused id: %v", err)
	}
	if _, err := run("inbox", "put", "/store:FIBER", "now", "other text", "--derived"); err != nil {
		t.Fatalf("derived recapture: %v", err)
	}

	out, err := run("inbox", "ls", "/store:FIBER", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var entries []messaging.PendingEntry
	if err := json.Unmarshal([]byte(out), &entries); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(entries) != 2 || entries[0].MessageID != "later" || entries[1].MessageID != "now" {
		t.Fatalf("entries = %+v", entries)
	}
	if e := entries[0]; e.Source != "pulse" || e.Turn != "ask" || e.NotBefore != "2999-01-01T00:00:00Z" || e.From != "bob" || e.QueuedAt.IsZero() {
		t.Fatalf("delayed entry = %+v", e)
	}
	if e := entries[1]; e.Source != "message" || e.Turn != "none" || e.NotBefore != "" {
		t.Fatalf("plain entry = %+v", e)
	}

	out, err = run("inbox", "ls", "/store:FIBER")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 || strings.Join(strings.Fields(lines[0])[:4], " ") != "later pulse ask 2999-01-01T00:00:00Z" || !strings.Contains(lines[0], "bob  wait for it") || strings.Join(strings.Fields(lines[1])[:4], " ") != "now message none -" {
		t.Fatalf("ls text:\n%s", out)
	}

	out, err = run("inbox", "pending", "/store:FIBER", "store:EMPTY")
	if err != nil {
		t.Fatal(err)
	}
	var counts map[string]messaging.PendingSummary
	if err := json.Unmarshal([]byte(out), &counts); err != nil || counts["/store:FIBER"].Count != 1 || counts["store:EMPTY"].Count != 0 || len(counts["/store:FIBER"].Scheduled) != 1 {
		t.Fatalf("pending = %s (%v)", out, err)
	}
}
