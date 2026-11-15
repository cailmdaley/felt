package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestThreadInboxVerbsCaptureForwardSettleAndContract40Enqueue(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "sender")
	run := func(stdin string, args ...string) string {
		t.Helper()
		var out bytes.Buffer
		env.Stdout, env.Stdin = &out, strings.NewReader(stdin)
		if code := Run(env, args); code != 0 {
			t.Fatalf("%v: exit %d (%s)", args, code, out.String())
		}
		return strings.TrimSpace(out.String())
	}
	if out := run("", "inbox", "thread-state"); !strings.Contains(out, "baseline") {
		t.Fatal(out)
	}
	record := map[string]any{"owner": "sender", "store": "/sender", "parent_uid": "anchor", "parent_host": "owner", "parent_unresolved": true, "text": "thread hub/child unblocked: result", "retained_at": time.Now().UTC().Format(time.RFC3339Nano)}
	batch, _ := json.Marshal([]map[string]any{{"id": "thread-1", "record": record}})
	for i, want := range []string{`{"board_errors":[],"created":["thread-1"],"refused":[]}`, `{"board_errors":[],"created":[],"refused":[]}`} {
		if out := run(string(batch), "inbox", "thread-put"); out != want {
			t.Fatalf("capture %d: %s", i, out)
		}
	}
	if out := run("", "inbox", "routes"); !strings.Contains(out, `"id":"thread-1"`) {
		t.Fatal(out)
	}
	resolved, _ := json.Marshal(map[string]any{"parent_uid": "parent", "parent_host": "owner", "store": "/owner"})
	for i := 0; i < 2; i++ {
		out := run("", "inbox", "route", "thread-1", "--current", "true", "--record", string(resolved))
		var decision map[string]any
		if err := json.Unmarshal([]byte(out), &decision); err != nil || decision["action"] != "forward" {
			t.Fatalf("forward: %s %v", out, err)
		}
	}
	run("", "inbox", "settle", "thread-1", "forwarded")
	if out := run("", "inbox", "routes"); out != "[]" {
		t.Fatal(out)
	}
	// A contract-40 owner's /deliver shells this verb for the forward. Losing
	// its first confirmation repeats the same enqueue, a no-op there.
	env.Set("SHUTTLE_DATA_DIR", filepath.Join(t.TempDir(), "owner-data"))
	for i := 0; i < 2; i++ {
		run("", "context-mailbox", "put", "/owner:parent", "thread-1", record["text"].(string), "--derived", "--retained-at", record["retained_at"].(string))
	}
	if out := run("", "inbox", "pending", "/owner:parent"); out != `{"/owner:parent":1}` {
		t.Fatal(out)
	}
}

func TestThreadStateExitsThreeOnACorruptOutbox(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	data := filepath.Join(t.TempDir(), "data")
	env.Set("SHUTTLE_DATA_DIR", data)
	if err := os.MkdirAll(data, 0700); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(data, "thread-outbox"), 0700)
	os.WriteFile(filepath.Join(data, "thread-outbox", "baseline"), []byte("not a time"), 0600)
	var out bytes.Buffer
	env.Stdout, env.Stderr = &out, &out
	if code := Run(env, []string{"inbox", "thread-state"}); code != exitCorrupt {
		t.Fatalf("exit %d: %s", code, out.String())
	}
}

func TestThreadPutTriesEveryPublicationAndReportsTheRefused(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", filepath.Join(t.TempDir(), "data"))
	var out bytes.Buffer
	env.Stdout, env.Stderr = &out, &bytes.Buffer{}
	if code := Run(env, []string{"inbox", "thread-state"}); code != 0 {
		t.Fatal(code)
	}
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	record := func(text string) map[string]any {
		return map[string]any{"owner": "h", "store": "/s", "parent_uid": "p", "text": text, "retained_at": stamp}
	}
	bad := record("thread a closed: x")
	bad["signal"] = map[string]any{"uid": "a"}
	batch, _ := json.Marshal([]map[string]any{
		{"id": "thread-big", "record": record("thread a closed: " + strings.Repeat("x", 65<<10))},
		{"id": "thread-bad", "record": bad},
		{"id": "thread-good", "record": record("thread b unblocked: c closed")},
	})
	for poll := 0; poll < 2; poll++ {
		out.Reset()
		env.Stdin = strings.NewReader(string(batch))
		if code := Run(env, []string{"inbox", "thread-put"}); code != 0 {
			t.Fatal(code, out.String())
		}
		var got struct {
			Created []string
			Refused []struct{ ID, Error string }
		}
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if want := map[int][]string{0: {"thread-good"}, 1: {}}[poll]; strings.Join(got.Created, ",") != strings.Join(want, ",") {
			t.Fatalf("poll %d created %v", poll, got.Created)
		}
		if len(got.Refused) != 2 || got.Refused[0].ID != "thread-big" || !strings.Contains(got.Refused[0].Error, "64 KiB") || got.Refused[1].ID != "thread-bad" {
			t.Fatalf("poll %d refused %+v", poll, got.Refused)
		}
	}
}

// An unblock note's board line is appended in the step that creates its
// entry, so no later loss of thread-put's output can drop it, and a
// re-capture appends nothing.
func TestThreadPutAppendsTheBoardLineWhenItCreatesTheEntry(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_EVENTS", "")
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	env.Set("SHUTTLE_DATA_DIR", filepath.Join(t.TempDir(), "data"))
	var out bytes.Buffer
	env.Stdout, env.Stderr = &out, &bytes.Buffer{}
	if code := Run(env, []string{"inbox", "thread-state"}); code != 0 {
		t.Fatal(code)
	}
	record := map[string]any{"owner": "host", "store": "/s", "parent_uid": "p", "text": "thread a unblocked: b closed", "retained_at": time.Now().UTC().Format(time.RFC3339Nano)}
	batch, _ := json.Marshal([]map[string]any{
		{"id": "thread-unblock", "record": record, "board": map[string]any{"kind": "unblocked", "fiber": "a", "text": "b closed"}},
		{"id": "thread-quiet", "record": record},
	})
	for poll := 0; poll < 2; poll++ {
		out.Reset()
		env.Stdin = strings.NewReader(string(batch))
		if code := Run(env, []string{"inbox", "thread-put"}); code != 0 {
			t.Fatal(code, out.String())
		}
	}
	records := readBoardRecords(t, events)
	if len(records) != 1 || records[0].Kind != "unblocked" || records[0].Fiber != "a" || records[0].Text != "b closed" {
		t.Fatalf("%+v", records)
	}
}

// An unblock's entry owes its board line until the line is appended. An
// append that failed (or a thread-put killed before it) is retried by the
// next capture of the same publication, also after the entry is placed; the
// line's identity is the publication's, so a repeat replaces it.
func TestThreadPutRetriesAnOwedBoardLine(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_HOST", "host")
	env.Set("SHUTTLE_DATA_DIR", filepath.Join(t.TempDir(), "data"))
	env.Set("SHUTTLE_EVENTS", "")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	var out bytes.Buffer
	env.Stdout, env.Stderr = &out, &bytes.Buffer{}
	run := func(input string, args ...string) string {
		t.Helper()
		out.Reset()
		env.Stdin = strings.NewReader(input)
		if code := Run(env, args); code != 0 {
			t.Fatalf("%v: exit %d (%s)", args, code, out.String())
		}
		return strings.TrimSpace(out.String())
	}
	lines := func() []map[string]any {
		t.Helper()
		b, err := os.ReadFile(events)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			t.Fatal(err)
		}
		var got []map[string]any
		for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
			var r map[string]any
			if err := json.Unmarshal([]byte(line), &r); err != nil {
				t.Fatal(err)
			}
			got = append(got, r)
		}
		return got
	}
	run("", "inbox", "thread-state")
	batch, _ := json.Marshal([]map[string]any{{
		"id":     "thread-unblock",
		"record": map[string]any{"owner": "host", "store": "/s", "parent_uid": "p", "text": "thread a unblocked: b closed", "retained_at": time.Now().UTC().Format(time.RFC3339Nano)},
		"board":  map[string]any{"kind": "unblocked", "fiber": "a", "text": "b closed"},
	}})
	// The ledger cannot be opened as a file.
	if err := os.Mkdir(events, 0700); err != nil {
		t.Fatal(err)
	}
	if got := run(string(batch), "inbox", "thread-put"); !strings.Contains(got, `"created":["thread-unblock"]`) || !strings.Contains(got, `"board_errors":[{"id":"thread-unblock"`) {
		t.Fatal(got)
	}
	if err := os.Remove(events); err != nil {
		t.Fatal(err)
	}
	// Placed before the retry: the obligation follows the entry to offered.
	run("", "inbox", "route", "thread-unblock", "--current", "true", "--record", `{"parent_uid":"p","parent_host":"host","store":"/s"}`, "--key", "/s:p")
	for i := 0; i < 2; i++ {
		if got := run(string(batch), "inbox", "thread-put"); got != `{"board_errors":[],"created":[],"refused":[]}` {
			t.Fatalf("capture %d: %s", i, got)
		}
	}
	if got := lines(); len(got) != 1 || got[0]["id"] != "brd-thread-unblock" || got[0]["kind"] != "unblocked" || got[0]["text"] != "b closed" {
		t.Fatalf("%v", got)
	}
}
