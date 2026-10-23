package shuttlecli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/transcriptindex"
)

func TestTranscriptSearchSessionFilterDoesNotDependOnLedgerAndJSONArraysArePresent(t *testing.T) {
	env := testEnv(t)
	db := filepath.Join(t.TempDir(), "index.sqlite")
	env.Set("SHUTTLE_TRANSCRIPT_INDEX", db)
	transcript := filepath.Join(t.TempDir(), "session.jsonl")
	const session = "11111111-2222-4333-8444-555555555555"
	body := `{"type":"user","sessionId":"` + session + `","cwd":"/work/project","timestamp":"2026-10-20T10:00:00Z","message":{"role":"user","content":"socket timeout recovery"}}` + "\n"
	if err := os.WriteFile(transcript, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	idx, err := transcriptindex.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	if err := idx.IndexFile(context.Background(), transcript, "claude"); err != nil {
		t.Fatal(err)
	}
	_ = idx.Close()
	// The closed port makes any accidental ledger request fail the test.
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	out, _, err := executeIn(t, env, t.TempDir(), "transcript", "search", "socket timeout", "--no-index", "--session", session, "--json")
	if err != nil {
		t.Fatalf("offline search: %v\n%s", err, out)
	}
	var got struct {
		Query  string            `json:"query"`
		Hits   []json.RawMessage `json:"hits"`
		Errors []json.RawMessage `json:"errors"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode JSON: %v\n%s", err, out)
	}
	if len(got.Hits) != 1 || len(got.Errors) != 1 || !strings.Contains(string(got.Hits[0]), `"fibers": []`) || !strings.Contains(string(got.Errors[0]), "session ledger unavailable") {
		t.Fatalf("unexpected search result: %s", out)
	}
}

func TestTranscriptIndexFileHookModeValidatesHarness(t *testing.T) {
	env := testEnv(t)
	_, _, err := executeIn(t, env, t.TempDir(), "transcript", "index", "--file", filepath.Join(t.TempDir(), "missing"), "--harness", "invalid")
	if err == nil {
		t.Fatal("invalid harness unexpectedly accepted")
	}
}
