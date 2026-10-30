package shuttlecli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestBoardDigestCursorFilteringAndCap(t *testing.T) {
	env := messageHookEnv(t, "host")
	now := time.UnixMilli(1793300000000)
	rows := []map[string]any{}
	for i := 0; i < 9; i++ {
		rows = append(rows, map[string]any{"id": fmt.Sprintf("id%d", i), "timestamp": now.UnixMilli() - 1000, "kind": "post", "member": "worker", "text": fmt.Sprintf("t%d ", i) + strings.Repeat("é", 250), "delivered": i == 0})
	}
	var queries []string
	fail := false
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/board/family": func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.Query().Get("since_ms"))
		if fail {
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"family": map[string]any{"label": "family"}, "records": rows})
	}})
	a := newApp(env)
	a.eventNow = func() time.Time { return now }
	out := a.boardDigest("pi", "s")
	if !strings.Contains(out, "Family board (family)") || !strings.Contains(out, "+2 earlier: shuttle board") {
		t.Fatal(out)
	}
	// The newest six survive the cap; the oldest undelivered two fold into the count.
	if strings.Contains(out, "t1 ") || strings.Contains(out, "t2 ") || !strings.Contains(out, "t3 ") || !strings.Contains(out, "t8 ") {
		t.Fatal(out)
	}
	lines := strings.Split(out, "\n")
	if len(lines) != 8 {
		t.Fatalf("lines %d: %s", len(lines), out)
	}
	if lines[1] != "+2 earlier: shuttle board" {
		t.Fatal(lines[1])
	}
	for _, line := range lines[2:8] {
		if len([]rune(line)) > 200 {
			t.Fatal("line too long")
		}
	}
	if queries[0] != "0" {
		t.Fatal(queries)
	}
	path := filepath.Join(env.Getenv("SHUTTLE_DATA_DIR"), "board-cursors", "pi-s.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var c boardCursor
	if json.Unmarshal(before, &c) != nil || len(c.Seen) != 9 {
		t.Fatalf("cursor %s", before)
	}
	if out = a.boardDigest("pi", "s"); out != "" {
		t.Fatalf("replayed %q", out)
	}
	if queries[1] != "0" {
		t.Fatal(queries)
	}
	before, _ = os.ReadFile(path)
	fail = true
	now = now.Add(time.Minute)
	if out = a.boardDigest("pi", "s"); out != "" {
		t.Fatal(out)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("failure changed cursor")
	}
}

func TestHumanPromptAnswersOwnedAsk(t *testing.T) {
	for _, harness := range []string{"claude", "codex", "pi"} {
		t.Run(harness, func(t *testing.T) {
			env := messageHookEnv(t, "host")
			env.Set("SHUTTLE_EVENTS", "")
			sink := filepath.Join(t.TempDir(), "events.jsonl")
			env.Set("SHUTTLE_EVENTS_FILE", sink)
			env.Set("SHUTTLE_MESSAGES", "off")
			env.Set("SHUTTLE_HUMAN", "Cail")
			dir, st := newStore(t)
			seedShuttleRole(t, st, "f", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "host", "project_dir": t.TempDir(), "runtime": map[string]any{"session_uuid": "session"}, "ask": map[string]any{"text": "Which?", "at": "2026-10-28T10:00:00Z"}}, nil)
			env.Set("SHUTTLE_STORES", dir)
			fiber := mustRead(t, st, "f")
			writeMessageIdentityLedger(t, env, []SessionProvenance{{Host: "host", Harness: harness, Session: "session", Fiber: fiber.ID, UID: fiber.UID, FiberPath: fiber.Path, Kind: "dispatch", At: 1}})
			daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/board/family": func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, `{"family":null,"viewer":null,"records":[]}`)
			}})
			a := newApp(env)
			input := eventHookInput{HookEventName: "UserPromptSubmit", Harness: harness, SessionID: "session", Prompt: "this one"}
			if harness == "codex" {
				input.Harness = ""
				input.Model = "gpt-6.1-sol"
			}
			input.Prompt = "/compact"
			b, _ := json.Marshal(input)
			var output bytes.Buffer
			if err := a.runEventAndMessageHook(bytes.NewReader(b), &output); err != nil || output.Len() != 0 {
				t.Fatalf("slash command hook %s %v", output.String(), err)
			}
			block, _, _ := shuttle.BlockOf(mustRead(t, st, "f"))
			if block.Ask == nil {
				t.Fatal("slash command cleared ask")
			}
			input.Prompt = "this one"
			b, _ = json.Marshal(input)
			if err := a.runEventAndMessageHook(bytes.NewReader(b), &output); err != nil || output.Len() != 0 {
				t.Fatalf("hook %s %v", output.String(), err)
			}
			block, _, _ = shuttle.BlockOf(mustRead(t, st, "f"))
			if block.Ask != nil {
				t.Fatal("ask not cleared")
			}
			data, err := os.ReadFile(sink)
			if err != nil {
				t.Fatal(err)
			}
			var found bool
			for _, line := range bytes.Split(data, []byte("\n")) {
				var r boardRecord
				if json.Unmarshal(line, &r) == nil && r.Type == "board" {
					found = true
					if r.Kind != "answered" || r.By == nil || r.By.Label != "Cail" || r.Text != "Q: Which? — A: this one" {
						t.Fatalf("record %+v", r)
					}
				}
			}
			if !found {
				t.Fatalf("missing record %s", data)
			}
			input.Prompt = "another thought"
			b, _ = json.Marshal(input)
			_ = a.runEventAndMessageHook(bytes.NewReader(b), &output)
			records := readBoardRecords(t, sink)
			if len(records) != 2 || records[1].Kind != "human" || records[1].Text != input.Prompt {
				t.Fatalf("human records: %+v", records)
			}
			input.SessionID = "other"
			b, _ = json.Marshal(input)
			if row, err := currentSessionBinding(messaging.Address{Host: "host", Harness: messaging.NormalizeHarness(harness), ID: input.SessionID}, a.localMessageLedger()); err != nil || row != nil {
				t.Fatalf("unexpected binding for other session: %+v, %v", row, err)
			}
			_ = a.runEventAndMessageHook(bytes.NewReader(b), &output)
			if records = readBoardRecords(t, sink); len(records) != 2 {
				t.Fatalf("unbound session changed board records: %+v", records)
			}
			writeMessageIdentityLedger(t, env, []SessionProvenance{{Host: "host", Harness: harness, Session: "other", Fiber: fiber.ID, UID: fiber.UID, FiberPath: fiber.Path, Kind: "resume", At: 2}})
			input.Prompt = "continued after session succession"
			b, _ = json.Marshal(input)
			_ = a.runEventAndMessageHook(bytes.NewReader(b), &output)
			if records = readBoardRecords(t, sink); len(records) != 3 || records[2].Kind != "human" || records[2].Text != input.Prompt {
				t.Fatalf("successor session records: %+v", records)
			}
			input.SessionID = "session"
			input.Prompt = "[Shuttle message machine]"
			b, _ = json.Marshal(input)
			_ = a.runEventAndMessageHook(bytes.NewReader(b), &output)
			env.Set("SHUTTLE_BOARD", "off")
			input.Prompt = "disabled"
			b, _ = json.Marshal(input)
			_ = a.runEventAndMessageHook(bytes.NewReader(b), &output)
			if records = readBoardRecords(t, sink); len(records) != 3 {
				t.Fatalf("unexpected records: %+v", records)
			}
		})
	}
}

type boardFailWriter struct{}

func (boardFailWriter) Write([]byte) (int, error) { return 0, fmt.Errorf("write failed") }

func TestBoardMailboxWriteFailureRetainsMessage(t *testing.T) {
	env := messageHookEnv(t, "host")
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/board/family": func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"family":{"label":"family"},"records":[{"id":"id","timestamp":1793300000000,"kind":"post","member":"member","text":"new"}]}`)
	}})
	a := newApp(env)
	a.eventNow = func() time.Time { return time.UnixMilli(1793300000000) }
	start := []byte(`{"hook_event_name":"SessionStart","harness":"pi","session_id":"s"}`)
	prompt := []byte(`{"hook_event_name":"UserPromptSubmit","harness":"pi","session_id":"s"}`)
	_ = a.runEventAndMessageHook(bytes.NewReader(start), &bytes.Buffer{})
	_, err := messaging.Send(context.Background(), env, "host", messaging.Request{Address: "shuttle://host/pi/s", Text: "mail", From: "person", MessageID: "m"})
	if err != nil {
		t.Fatal(err)
	}
	_ = a.runEventAndMessageHook(bytes.NewReader(prompt), boardFailWriter{})
	var out bytes.Buffer
	_ = a.runEventAndMessageHook(bytes.NewReader(prompt), &out)
	if !strings.Contains(out.String(), "mail") {
		t.Fatalf("mail was acknowledged after output failure: %s", out.String())
	}
}

func TestBoardDigestCombinedWithMailbox(t *testing.T) {
	env := messageHookEnv(t, "host")
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/board/family": func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"family": map[string]any{"label": "family"}, "records": []map[string]any{{"id": "one", "timestamp": time.Now().UnixMilli(), "kind": "post", "member": "child", "text": "hello"}}})
	}})
	hook := func(name string) string {
		b, _ := json.Marshal(eventHookInput{HookEventName: name, Harness: "pi", SessionID: "s"})
		var out bytes.Buffer
		_ = newApp(env).runEventAndMessageHook(bytes.NewReader(b), &out)
		return out.String()
	}
	hook("SessionStart")
	_, err := messaging.Send(context.Background(), env, "host", messaging.Request{Address: "shuttle://host/pi/s", Text: "mail", From: "person", MessageID: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var e sessionEnvelope
	out := hook("UserPromptSubmit")
	if err := json.Unmarshal([]byte(out), &e); err != nil {
		t.Fatalf("%q %v", out, err)
	}
	text := e.HookSpecificOutput.AdditionalContext
	if !strings.Contains(text, "mail") || !strings.Contains(text, "Family board (family)") || strings.Index(text, "mail") > strings.Index(text, "Family board") {
		t.Fatal(text)
	}
	if out = hook("UserPromptSubmit"); out != "" {
		t.Fatalf("replayed: %s", out)
	}
}
