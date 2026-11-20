package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

// The daemon clears after every delivered message and every forced start, so a
// clear with no outstanding question must leave the board alone.
func TestBoardClearWithoutQuestionRecordsNothing(t *testing.T) {
	for _, args := range [][]string{{"ask", "f", "--clear"}, {"ask", "f", "--clear", "--answered-by", "shuttle://host/claude/abc"}} {
		env := testEnv(t)
		env.Set("SHUTTLE_HOST", "host")
		env.Set("SHUTTLE_EVENTS", "")
		path := filepath.Join(t.TempDir(), "events.jsonl")
		env.Set("SHUTTLE_EVENTS_FILE", path)
		dir, st := newStore(t)
		seedShuttleRole(t, st, "f", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
		if _, stderr, err := executeIn(t, env, dir, args...); err != nil {
			t.Fatalf("%v %s", err, stderr)
		}
		if _, err := os.Stat(path); err == nil {
			if records := readBoardRecords(t, path); len(records) != 0 {
				t.Fatalf("%v recorded %+v", args, records)
			}
		}
	}
}

// An address names a session, not a person: it goes in by.session, never the label.
func TestBoardMessageActorKeepsAddressOutOfLabel(t *testing.T) {
	a := newApp(testEnv(t))
	if by := a.boardMessageActor("shuttle://host/claude/abc"); by.Label != "" || by.Session != "shuttle://host/claude/abc" {
		t.Fatalf("%+v", by)
	}
	if by := a.boardMessageActor("Cail"); by.Label != "Cail" || by.Session != "" {
		t.Fatalf("%+v", by)
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

func TestPostAttachesFiles(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_EVENTS", "")
	env.Set("CLAUDE_CODE_SESSION_ID", "worker-session")
	path := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", path)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "f", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
	plot := filepath.Join(t.TempDir(), "plot.png")
	if err := os.WriteFile(plot, []byte("png"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := executeIn(t, env, dir, "post", "--fiber", "f", "--file", plot, "here is the plot"); err != nil {
		t.Fatalf("post: %v %s", err, stderr)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), `"type":"file_sent"`) {
		t.Fatalf("file not recorded as sent: %v %s", err, raw)
	}
	records := readBoardRecords(t, path)
	if len(records) != 1 || records[0].Kind != "post" || len(records[0].Files) != 1 || records[0].Files[0] != plot {
		t.Fatalf("records %+v", records)
	}
}

// The night seat of 20 Nov 2026 posted its digest and tapestry twice: the post
// printed nothing, its check read the board --since a time still in the future
// and found nothing, and it posted again. A post says it posted, and a future
// --since is refused with the current time.
func TestPostThatPrintedNothingWasPostedTwice(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_HUMAN", "Cail")
	env.Set("CLAUDE_CODE_SESSION_ID", "worker-session")
	env.Set("SHUTTLE_EVENTS", "")
	env.Set("SHUTTLE_EVENTS_FILE", filepath.Join(t.TempDir(), "events.jsonl"))
	dir, st := newStore(t)
	seedShuttleRole(t, st, "vizier/dream", felt.StatusActive, map[string]any{"kind": "standing", "host": "host", "project_dir": t.TempDir()}, nil)
	page := filepath.Join(t.TempDir(), "tapestry.html")
	if err := os.WriteFile(page, []byte("<p>night</p>"), 0600); err != nil {
		t.Fatal(err)
	}
	out, stderr, err := executeIn(t, env, dir, "post", "--fiber", "vizier/dream", "--to", "human", "--file", page, "Dream, Fri 20 Nov")
	if err != nil || strings.TrimSpace(out) != "posted as vizier/dream to Cail with 1 file(s)" {
		t.Fatalf("post: %q %v %s", out, err, stderr)
	}

	a := newApp(env)
	a.eventNow = func() time.Time { return time.Date(2026, 11, 20, 3, 53, 44, 0, time.UTC) }
	_, _, err = executeApp(t, a, dir, "board", "--all", "--since", "2026-11-20T04:00:00Z")
	if err == nil || !strings.Contains(err.Error(), "is in the future: it is now ") {
		t.Fatalf("board --since in the future: %v", err)
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
	if _, stderr, err := executeIn(t, env, dir, "ask", "f", "--clear", "--answered-by", "Alice"); err != nil {
		t.Fatalf("ask --clear: %v %s", err, stderr)
	}
	records := readBoardRecords(t, path)
	if len(records) != 1 || records[0].Kind != "answered" || records[0].By == nil || records[0].By.Label != "Alice" || records[0].Text != "why?" {
		t.Fatalf("%+v", records)
	}
}

// The board's own clear answers as "human", which names the human as the
// human's other lines do.
func TestBoardAskClearAnsweredByHumanNamesTheHuman(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_HUMAN", "Cail")
	env.Set("SHUTTLE_EVENTS", "")
	path := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", path)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "f", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir(), "ask": map[string]any{"text": "why?", "at": "2026-10-28T10:00:00Z"}}, nil)
	if _, stderr, err := executeIn(t, env, dir, "ask", "f", "--clear", "--answered-by", "human"); err != nil {
		t.Fatalf("ask --clear: %v %s", err, stderr)
	}
	records := readBoardRecords(t, path)
	if len(records) != 1 || records[0].Kind != "answered" || records[0].By == nil || *records[0].By != (boardParty{Label: "Cail"}) {
		t.Fatalf("%+v", records)
	}
}

// A post's address says whose attention it asks for: up to the poster's
// orchestrator by default, unaddressed at the top level, or --to the human or
// a fiber. Questions and closes for review go up, or to the human at the top;
// a mark goes to the human; a verdict is addressed to no one.
func TestBoardAddresses(t *testing.T) {
	type want struct {
		kind string
		to   *boardParty
	}
	cail := &boardParty{Label: "Cail"}
	for _, tc := range []struct {
		name string
		args []string
		want func(hub, fit string) want
	}{
		{"post goes up", []string{"post", "--fiber", "hub/fit", "fit converged"}, func(hub, _ string) want { return want{"post", &boardParty{Fiber: hub}} }},
		{"top-level post is unaddressed", []string{"post", "--fiber", "hub", "routine"}, func(string, string) want { return want{"post", nil} }},
		{"post to the human by name", []string{"post", "--fiber", "hub/fit", "--to", "cail", "look"}, func(string, string) want { return want{"post", cail} }},
		{"post to the human", []string{"post", "--fiber", "hub", "--to", "human", "look"}, func(string, string) want { return want{"post", cail} }},
		{"post to a fiber", []string{"post", "--fiber", "hub", "--to", "hub/fit", "go"}, func(_, fit string) want { return want{"post", &boardParty{Fiber: fit}} }},
		{"thread asks up", []string{"ask", "hub/fit", "which prior?"}, func(hub, _ string) want { return want{"asked", &boardParty{Fiber: hub}} }},
		{"top-level asks the human", []string{"ask", "hub", "which prior?"}, func(string, string) want { return want{"asked", cail} }},
		{"thread closes up", []string{"close", "hub/fit", "--local"}, func(hub, _ string) want { return want{"closed", &boardParty{Fiber: hub}} }},
		{"a mark goes to the human", []string{"close", "hub/fit", "--review", "worth a look", "--local"}, func(string, string) want { return want{"closed", cail} }},
		{"a verdict is unaddressed", []string{"close", "hub/fit", "--tempered=true", "--local"}, func(string, string) want { return want{"closed", nil} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			env.Set("SHUTTLE_HOST", "host")
			env.Set("SHUTTLE_HUMAN", "Cail")
			env.Set("SHUTTLE_EVENTS", "")
			path := filepath.Join(t.TempDir(), "events.jsonl")
			env.Set("SHUTTLE_EVENTS_FILE", path)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "hub", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
			seedShuttleRole(t, st, "hub/fit", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
			if _, stderr, err := executeIn(t, env, dir, tc.args...); err != nil {
				t.Fatalf("%v %s", err, stderr)
			}
			w := tc.want(mustRead(t, st, "hub").UID, mustRead(t, st, "hub/fit").UID)
			records := readBoardRecords(t, path)
			if len(records) != 1 || records[0].Kind != w.kind {
				t.Fatalf("records %+v", records)
			}
			if got := records[0].To; (got == nil) != (w.to == nil) || (got != nil && *got != *w.to) {
				t.Fatalf("to = %+v, want %+v", got, w.to)
			}
		})
	}
}

func TestPostToAnUnknownAddressIsRefused(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_HUMAN", "Cail")
	dir, st := newStore(t)
	seedShuttleRole(t, st, "hub", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
	_, stderr, err := executeIn(t, env, dir, "post", "--fiber", "hub", "--to", "nobody", "hello")
	if err == nil || !strings.Contains(err.Error()+stderr, "names neither the human (Cail) nor a fiber") {
		t.Fatalf("err %v %s", err, stderr)
	}
}

// The closing post is the outcome: --post writes it, with its files, on the
// fiber and on the board's close line; a close without it leaves the outcome.
func TestCloseWithPostWritesTheOutcome(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_EVENTS", "")
	env.Set("CLAUDE_CODE_SESSION_ID", "worker-session")
	path := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", path)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "hub", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
	seedShuttleRole(t, st, "hub/fit", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
	seedShuttleRole(t, st, "hub/plain", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
	plot := filepath.Join(t.TempDir(), "plot.png")
	if err := os.WriteFile(plot, []byte("png"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := executeIn(t, env, dir, "close", "hub/fit", "--post", "  Converged at 3%.  ", "--file", plot, "--local"); err != nil {
		t.Fatalf("%v %s", err, stderr)
	}
	if f := mustRead(t, st, "hub/fit"); f.Outcome != "Converged at 3%." || f.Status != felt.StatusClosed {
		t.Fatalf("outcome %q status %s", f.Outcome, f.Status)
	}
	before := mustRead(t, st, "hub/plain").Outcome
	if _, stderr, err := executeIn(t, env, dir, "close", "hub/plain", "--local"); err != nil {
		t.Fatalf("%v %s", err, stderr)
	}
	if got := mustRead(t, st, "hub/plain").Outcome; got != before {
		t.Fatalf("plain close changed the outcome %q → %q", before, got)
	}
	records := readBoardRecords(t, path)
	if len(records) != 2 || records[0].Text != "Converged at 3%." || len(records[0].Files) != 1 || records[0].Files[0] != plot || records[1].Text != "" {
		t.Fatalf("records %+v", records)
	}
}

func TestClosePostRefusals(t *testing.T) {
	for name, c := range map[string]struct {
		args []string
		want string
	}{
		"empty":       {[]string{"close", "hub/fit", "--post", " "}, "--post is empty"},
		"with a mark": {[]string{"close", "hub/fit", "--post", "x", "--review", "why"}, "the thread writes its own closing post"},
		"file alone":  {[]string{"close", "hub/fit", "--file", "x.png"}, "give it with --post"},
	} {
		t.Run(name, func(t *testing.T) {
			env := testEnv(t)
			env.Set("SHUTTLE_HOST", "host")
			dir, st := newStore(t)
			seedShuttleRole(t, st, "hub", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
			seedShuttleRole(t, st, "hub/fit", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir()}, nil)
			_, stderr, err := executeIn(t, env, dir, append(c.args, "--local")...)
			if err == nil || !strings.Contains(err.Error()+stderr, c.want) {
				t.Fatalf("want %q, got %v %s", c.want, err, stderr)
			}
			if mustRead(t, st, "hub/fit").Status != felt.StatusActive {
				t.Fatal("refusal closed it")
			}
		})
	}
}
