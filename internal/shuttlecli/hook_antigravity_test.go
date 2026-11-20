package shuttlecli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
)

// The hook payloads agy 1.5.13 sent in a recorded session (a launch prompt
// that ran one command, then a second prompt typed into its terminal), from
// the shared conformance fixtures, replayed through `shuttle hook antigravity`.
func TestAntigravityHooksReplayAsShuttleEvents(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS", "")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	names := antigravityHookFixtures(t)
	const id = "e63c2d73-3d33-457e-9457-0ab8670fac39"
	hook := func(payload []byte) string {
		t.Helper()
		var out bytes.Buffer
		if err := newApp(env).runAntigravityHook(bytes.NewReader(payload), &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	state := func() string {
		s, _ := messaging.MailboxState(env, "antigravity", id, "host")
		return s
	}
	var states []string
	for _, name := range names {
		payload, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		event := strings.TrimSuffix(filepath.Base(name)[3:], ".json")
		if event == "PreInvocation" && len(states) == 1 {
			// Mail queued after the session started reaches the first model call.
			r := messaging.Request{Address: "shuttle://host/antigravity/" + id, Text: "peer message", From: "work/peer", MessageID: "m"}
			if receipt, err := messaging.Send(context.Background(), env, "host", r); err != nil || receipt.Transport != "antigravity-hook" {
				t.Fatalf("send: %+v %v", receipt, err)
			}
		}
		out := hook(payload)
		switch {
		case event == "PreInvocation" && len(states) == 1:
			var got antigravityInjection
			if err := json.Unmarshal([]byte(out), &got); err != nil || len(got.InjectSteps) != 1 || !strings.Contains(got.InjectSteps[0].SystemMessage.SystemMessage, "[from work/peer]\npeer message") {
				t.Fatalf("PreInvocation injected %q", out)
			}
		case out != "":
			// A PreToolUse hook's `{}` denies the tool.
			t.Fatalf("%s printed %q", name, out)
		}
		states = append(states, event+"="+state())
	}
	want := "SessionStart=idle PreInvocation=working PreToolUse=working PostToolUse=working PostInvocation=working PreInvocation=working PostInvocation=working Stop=idle PreInvocation=working PostInvocation=working Stop=idle"
	if got := strings.Join(states, " "); got != want {
		t.Fatalf("mailbox states\n got %s\nwant %s", got, want)
	}

	// A Stop that leaves a background command running keeps the turn open,
	// and the turn agy starts itself when the command ends repeats the last
	// input: it is not a prompt. The same input after a Stop that left
	// nothing running is one.
	prompt, _ := os.ReadFile(names[8])
	var stop map[string]any
	if err := json.Unmarshal(prompt, &stop); err != nil {
		t.Fatal(err)
	}
	stop["hookEventName"], stop["fullyIdle"] = "Stop", false
	busy, _ := json.Marshal(stop)
	hook(busy)
	if state() != "working" {
		t.Fatalf("a Stop with a background command running reads as %q", state())
	}
	hook(prompt)
	idle, _ := os.ReadFile(names[10])
	hook(idle)
	hook(prompt)

	data, err := os.ReadFile(events)
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var e eventLine
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatal(err)
		}
		if e.Harness != "antigravity" || e.SessionID != id || e.CWD != "/work/sky" {
			t.Fatalf("event line %s", line)
		}
		label := e.Type
		if e.BackgroundTasks > 0 {
			label += "+background"
		}
		types = append(types, label)
	}
	want = "session_start user_prompt_submit pre_tool_use post_tool_use stop user_prompt_submit stop stop+background stop user_prompt_submit"
	if got := strings.Join(types, " "); got != want {
		t.Fatalf("event stream\n got %s\nwant %s", got, want)
	}
}

func TestAntigravityHookIgnoresWhatItCannotRead(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	for _, payload := range []string{"", "not json", `{"hookEventName":"Stop"}`, `{"hookEventName":"Elsewhen","conversationId":"c"}`} {
		var out bytes.Buffer
		if err := newApp(env).runAntigravityHook(strings.NewReader(payload), &out); err != nil || out.Len() != 0 {
			t.Fatalf("%q: %q %v", payload, out.String(), err)
		}
	}
}

// A host that never set Shuttle up gets nothing from agy's hooks: no stream,
// no mailbox, no turn state.
func TestAntigravityHookWritesNothingWithoutStateDir(t *testing.T) {
	t.Parallel()
	env, home := isolateEvents(t)
	for _, name := range antigravityHookFixtures(t) {
		payload, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := newApp(env).runAntigravityHook(bytes.NewReader(payload), io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	if entries, _ := os.ReadDir(home); len(entries) != 0 {
		t.Fatalf("agy hooks created %v in a HOME with no ~/.shuttle", entries)
	}
}

// A turn state holds a digest of the turn's input, never the input, and a
// SessionStart removes the states of conversations idle for a week.
func TestAntigravityTurnStateHoldsNoPromptAndExpires(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	a := newApp(env)
	const secret = "the whole prompt the human typed"
	a.antigravityTurnEnded("fresh", secret, true)
	a.antigravityTurnEnded("stale", secret, false)
	fresh, _ := a.antigravityTurnPath("fresh")
	stale, _ := a.antigravityTurnPath("stale")
	if data, err := os.ReadFile(fresh); err != nil || strings.Contains(string(data), secret) || len(data) > 128 {
		t.Fatalf("turn state %q %v", data, err)
	}
	old := time.Now().Add(-antigravityTurnTTL - time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	if a.antigravityTurnStarted("fresh", secret) {
		t.Fatal("agy's own turn after a running Stop read as a prompt")
	}
	start := `{"hookEventName":"SessionStart","conversationId":"new","cwd":"/work"}`
	if err := a.runAntigravityHook(strings.NewReader(start), io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("a week-idle turn state survived a SessionStart: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("a live turn state was pruned: %v", err)
	}
}

func antigravityHookFixtures(t *testing.T) []string {
	t.Helper()
	dir := filepath.Join("..", "..", "daemon", "test", "fixtures", "harnesses", "antigravity", "hooks")
	names, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(names) == 0 {
		t.Fatalf("no recorded hooks: %v", err)
	}
	sort.Strings(names)
	return names
}
