package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func readBoardRecords(t *testing.T, path string) []boardRecord {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []boardRecord
	for _, line := range bytes.Split(b, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var r boardRecord
		if err := json.Unmarshal(line, &r); err != nil {
			t.Fatal(err)
		}
		if r.Type == "board" {
			out = append(out, r)
		}
	}
	return out
}

func TestBoardLifecycleAndQuestionWriters(t *testing.T) {
	for _, tc := range []struct {
		name          string
		args          []string
		kind, verdict string
	}{
		{"asked", []string{"ask", "f", "Question?"}, "asked", ""},
		{"cleared", []string{"ask", "f", "--clear"}, "cleared", ""},
		{"answered", []string{"ask", "f", "--clear", "--answered-by", "Alice"}, "answered", ""},
		{"closed", []string{"close", "f", "--local"}, "closed", ""},
		{"tempered", []string{"close", "f", "--local", "--tempered=true"}, "closed", "tempered"},
		{"discarded", []string{"close", "f", "--local", "--tempered=false"}, "closed", "discarded"},
		{"rested", []string{"rest", "f", "--local"}, "rested", ""},
		{"handed_off", []string{"handoff", "f"}, "handed_off", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			env.Set("SHUTTLE_HOST", "host")
			env.Set("SHUTTLE_EVENTS", "")
			path := filepath.Join(t.TempDir(), "events.jsonl")
			env.Set("SHUTTLE_EVENTS_FILE", path)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "f", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir(), "ask": map[string]any{"text": "old question", "at": "2026-10-28T10:00:00Z"}}, nil)
			_, stderr, err := executeIn(t, env, dir, tc.args...)
			if err != nil {
				t.Fatalf("%v %s", err, stderr)
			}
			records := readBoardRecords(t, path)
			if len(records) != 1 || records[0].Kind != tc.kind || records[0].Fiber != mustRead(t, st, "f").UID || records[0].Verdict != tc.verdict {
				t.Fatalf("records %+v", records)
			}
			if tc.name == "answered" && (records[0].By == nil || records[0].By.Label != "Alice") {
				t.Fatalf("record %+v", records[0])
			}
		})
	}
}

func TestBoardWriteFailureDoesNotFailAsk(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_EVENTS", "off")
	dir, st := newStore(t)
	seedShuttleRole(t, st, "f", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
	_, stderr, err := executeIn(t, env, dir, "ask", "f", "question")
	if err != nil || !strings.Contains(stderr, "warning: could not record family board") {
		t.Fatalf("ask failed: %v %s", err, stderr)
	}
}

func TestBoardAppendAndPost(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_EVENTS", "")
	path := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", path)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "f", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
	run := func(stdin string, args ...string) {
		t.Helper()
		env.Stdin = strings.NewReader(stdin)
		var out, errout bytes.Buffer
		env.Stdout = &out
		env.Stderr = &errout
		a := newApp(env)
		cmd := a.rootCmd()
		a.dir = dir
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatalf("%v: %v %s", args, err, errout.String())
		}
	}
	run(`{"kind":"unblocked","fiber":"member","text":"ready"}`, "board", "append")
	run("from stdin", "post", "--fiber", "f", "-")
	records := readBoardRecords(t, path)
	if len(records) != 2 || records[0].Kind != "unblocked" || records[1].Kind != "post" || records[1].Text != "from stdin" || records[1].Fiber != mustRead(t, st, "f").UID || records[1].By == nil || records[1].By.Fiber != records[1].Fiber {
		t.Fatalf("records %+v", records)
	}
}

func TestBoardMessageClearsAsk(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_EVENTS", "")
	path := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", path)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "f", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir(), "ask": map[string]any{"text": "why?", "at": "2026-10-28T10:00:00Z"}}, nil)
	env.Set("SHUTTLE_STORES", dir)
	a := newApp(env)
	a.dir = dir
	if err := a.clearMessagedFiberAsk("f", "Alice"); err != nil {
		t.Fatal(err)
	}
	records := readBoardRecords(t, path)
	if len(records) != 1 || records[0].Kind != "answered" || records[0].By == nil || records[0].By.Label != "Alice" || records[0].Text != "why?" {
		t.Fatalf("%+v", records)
	}
}
