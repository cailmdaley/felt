package shuttlecli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/harnesspaths"
	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestEventHookOffersClaudeMailboxWithoutStopWake(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	provideClaudeNative(t, env, "s")
	claudeProjects, _ := harnesspaths.ClaudeProjects(env)
	transcript := filepath.Join(claudeProjects, "p", "s.jsonl")
	hook := func(name string) string {
		t.Helper()
		b, _ := json.Marshal(eventHookInput{HookEventName: name, SessionID: "s", TranscriptPath: transcript})
		var out bytes.Buffer
		if err := newApp(env).runEventAndMessageHook(bytes.NewReader(b), &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if out := hook("SessionStart"); out != "" {
		t.Fatal(out)
	}
	if !messaging.MailboxAvailable(env, "claude", "s", "host") {
		t.Fatal("hook failed to register")
	}
	hook("UserPromptSubmit")
	if state, err := messaging.MailboxState(env, "claude", "s", "host"); err != nil || state != "working" {
		t.Fatalf("Claude prompt state = %q, %v", state, err)
	}
	r := messaging.Request{Address: "shuttle://host/claude/s", Text: "peer message", From: "shuttle://peer/pi/A", ReplyTo: "work/fiber", MessageID: "m", Wake: true, ContextIfBusy: true}
	if receipt, err := messaging.Send(context.Background(), env, "host", r); err != nil || receipt.Transport != "claude-hook" {
		t.Fatalf("send: %+v %v", receipt, err)
	}
	passive := r
	passive.MessageID, passive.Text, passive.Wake, passive.ContextIfBusy = "passive", "passive message", false, false
	if _, err := messaging.Send(context.Background(), env, "host", passive); err != nil {
		t.Fatal(err)
	}
	if out := hook("SessionStart"); out != "" {
		t.Fatalf("SessionStart cannot safely offer queued context: %s", out)
	}
	child, _ := json.Marshal(eventHookInput{HookEventName: "PostToolUse", SessionID: "s", AgentID: "subagent", TranscriptPath: transcript})
	var childOut bytes.Buffer
	if err := newApp(env).runEventAndMessageHook(bytes.NewReader(child), &childOut); err != nil || childOut.Len() != 0 {
		t.Fatalf("a subagent consumed its parent's mail: %s %v", childOut.String(), err)
	}
	var got sessionEnvelope
	if out := hook("PreToolUse"); out != "" {
		t.Fatalf("PreToolUse context can be lost on interrupt: %s", out)
	}
	if err := json.Unmarshal([]byte(hook("PostToolUse")), &got); err != nil {
		t.Fatal(err)
	}
	if got.HookSpecificOutput.HookEventName != "PostToolUse" || !bytes.Contains([]byte(got.HookSpecificOutput.AdditionalContext), []byte("[from work/fiber]\npeer message")) || !bytes.Contains([]byte(got.HookSpecificOutput.AdditionalContext), []byte("passive message")) {
		t.Fatalf("bad context: %+v", got)
	}
	if out := hook("PostToolUse"); out != "" {
		t.Fatalf("duplicated message: %s", out)
	}
	if out := hook("Stop"); out != "" {
		t.Fatalf("Stop would wake the model: %s", out)
	}
	if state, err := messaging.MailboxState(env, "claude", "s", "host"); err != nil || state != "idle" {
		t.Fatalf("Claude stop state = %q, %v", state, err)
	}
	hook("SessionEnd")
	if messaging.MailboxAvailable(env, "claude", "s", "host") {
		t.Fatal("mailbox still available")
	}
}

func TestClaudeStopDoesNotContinueOrDrainMail(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	provideClaudeNative(t, env, "s")
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS", "on")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	env.Set("SHUTTLE_BOARD", "off")
	hook := func(name string) string {
		t.Helper()
		b, _ := json.Marshal(eventHookInput{HookEventName: name, Harness: "claude", SessionID: "s"})
		var out bytes.Buffer
		if err := newApp(env).runEventAndMessageHook(bytes.NewReader(b), &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	hook("SessionStart")
	hook("UserPromptSubmit")
	hook("PostToolUse") // the last tool has finished
	send := func(id string, busy bool) {
		t.Helper()
		r := messaging.Request{Address: "shuttle://host/claude/s", Text: id, From: "shuttle://peer/pi/sender", MessageID: id, Wake: busy, ContextIfBusy: busy}
		if receipt, err := messaging.Send(context.Background(), env, "host", r); err != nil || receipt.Status != messaging.StatusQueued {
			t.Fatalf("send: %+v %v", receipt, err)
		}
	}
	send("context-only", false)
	send("late-busy", true)
	if out := hook("StopFailure"); out != "" {
		t.Fatalf("StopFailure offered context without a continuing turn: %s", out)
	}
	if state, err := messaging.MailboxState(env, "claude", "s", "host"); err != nil || state != "idle" {
		t.Fatalf("failed-turn state=%s %v", state, err)
	}
	lines, _ := os.ReadFile(events)
	if bytes.Count(lines, []byte(`"type":"stop"`)) != 1 {
		t.Fatalf("failed turn did not record Stop: %s", lines)
	}
	hook("PreToolUse") // A subsequent turn can still finish normally.
	if out := hook("Stop"); out != "" {
		t.Fatalf("Stop continued: %s", out)
	}
	if state, err := messaging.MailboxState(env, "claude", "s", "host"); err != nil || state != "idle" {
		t.Fatalf("state=%s %v", state, err)
	}
	lines, _ = os.ReadFile(events)
	if bytes.Count(lines, []byte(`"type":"stop"`)) != 2 {
		t.Fatalf("final Stop not recorded once: %s", lines)
	}
	if out := hook("UserPromptSubmit"); !bytes.Contains([]byte(out), []byte("context-only")) || !bytes.Contains([]byte(out), []byte("late-busy")) {
		t.Fatalf("queued context lost: %s", out)
	}
}

// Busy automatic delivery is accepted only with a registered native fallback.
func provideClaudeNative(t *testing.T, env *sysenv.Env, id string) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "cm-hook-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket, transcript := filepath.Join(dir, "s.sock"), filepath.Join(dir, "s.jsonl")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	if err := os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(transcript, nil, 0600); err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			// Held open until the client hangs up: the client reads its peer's
			// credentials after connecting, which fail once this side closes.
			go func() {
				_, _ = io.Copy(io.Discard, conn)
				conn.Close()
			}()
		}
	}()
	if err := messaging.RegisterClaudeNative(env, id, "host", dir, socket, transcript, true); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeSubagentToolsDoNotCountAsParentTurn(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS", "on")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	for _, input := range []eventHookInput{
		{Harness: "claude", HookEventName: "SessionStart", SessionID: "parent"},
		{Harness: "claude", HookEventName: "PreToolUse", SessionID: "parent", AgentID: "background", ToolName: "Bash"},
		{Harness: "claude", HookEventName: "PostToolUse", SessionID: "parent", AgentID: "background", ToolName: "Bash"},
	} {
		b, _ := json.Marshal(input)
		var out bytes.Buffer
		if err := newApp(env).runEventAndMessageHook(bytes.NewReader(b), &out); err != nil || out.Len() != 0 {
			t.Fatalf("hook=%s %v", out.String(), err)
		}
	}
	if state, err := messaging.MailboxState(env, "claude", "parent", "host"); err != nil || state != "idle" {
		t.Fatalf("subagent made parent busy: %q %v", state, err)
	}
	lines, err := os.ReadFile(events)
	if err != nil || bytes.Contains(lines, []byte("tool_use")) {
		t.Fatalf("subagent activity counted as parent: %s %v", lines, err)
	}
}

func TestSubagentStopNeverTouchesReceiverRegistrations(t *testing.T) {
	for _, harness := range []string{"claude", "codex", "pi"} {
		t.Run(harness, func(t *testing.T) {
			env := messageHookEnv(t, "host")
			events := filepath.Join(t.TempDir(), "events.jsonl")
			env.Set("SHUTTLE_EVENTS", "")
			env.Set("SHUTTLE_EVENTS", "on")
			env.Set("SHUTTLE_EVENTS_FILE", events)
			hook := func(name, cwd string) {
				t.Helper()
				payload, _ := json.Marshal(eventHookInput{HookEventName: name, Harness: harness, SessionID: "resumed", CWD: cwd})
				var out bytes.Buffer
				if err := newApp(env).runEventAndMessageHook(bytes.NewReader(payload), &out); err != nil || out.Len() != 0 {
					t.Fatalf("%s: %s %v", name, out.String(), err)
				}
			}
			// A child event cannot create a receiver before the parent registers.
			hook("SubagentStop", "/old")
			if messaging.MailboxAvailable(env, harness, "resumed", "host") {
				t.Fatal("child created receiver")
			}
			hook("SessionStart", "/new-generation")
			var receiver string
			err := filepath.WalkDir(env.Getenv("SHUTTLE_DATA_DIR"), func(path string, entry os.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if entry.Name() == "receiver.json" {
					receiver = path
				}
				return nil
			})
			if err != nil || receiver == "" {
				t.Fatalf("receiver: %q %v", receiver, err)
			}
			before, err := os.ReadFile(receiver)
			if err != nil {
				t.Fatal(err)
			}
			hook("SubagentStop", "/old-generation")
			after, err := os.ReadFile(receiver)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatalf("child overwrote resumed receiver: %s %v", after, err)
			}
			hook("SessionEnd", "/new-generation")
			hook("SubagentStop", "/old-generation")
			if messaging.MailboxAvailable(env, harness, "resumed", "host") {
				t.Fatal("child resurrected ended receiver")
			}
			data, err := os.ReadFile(events)
			if err != nil || bytes.Count(data, []byte(`"type":"subagent_stop"`)) != 3 {
				t.Fatalf("child events lost: %s %v", data, err)
			}
		})
	}
}

func TestEventHookOffersCodexMailbox(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	var out bytes.Buffer
	_ = newApp(env).runEventAndMessageHook(bytes.NewBufferString(`{"hook_event_name":"SessionStart","session_id":"s","model":"gpt-6","cwd":"/work"}`), &out)
	if out.Len() != 0 || !messaging.MailboxAvailable(env, "codex", "s", "host") {
		t.Fatal("Codex hook failed to register a mailbox")
	}
	if state, err := codexHookStateForTest(env, "s"); err != nil || state != "idle" {
		t.Fatalf("Codex SessionStart state = %q, %v", state, err)
	}
	r := messaging.Request{Address: "shuttle://host/codex/s", Text: "peer context", From: "shuttle://peer/pi/A", ReplyTo: "work/fiber", MessageID: "m"}
	if receipt, err := messaging.Send(context.Background(), env, "host", r); err != nil || receipt.Transport != "codex-hook" {
		t.Fatalf("send: %+v %v", receipt, err)
	}
	out.Reset()
	_ = newApp(env).runEventAndMessageHook(bytes.NewBufferString(`{"hook_event_name":"UserPromptSubmit","session_id":"s","model":"gpt-6"}`), &out)
	if state, err := codexHookStateForTest(env, "s"); err != nil || state != "working" {
		t.Fatalf("Codex prompt state = %q, %v", state, err)
	}
	if !bytes.Contains(out.Bytes(), []byte("[from work/fiber]\\npeer context")) {
		t.Fatalf("Codex context missing: %s", out.String())
	}
	out.Reset()
	_ = newApp(env).runEventAndMessageHook(bytes.NewBufferString(`{"hook_event_name":"Stop","session_id":"s","model":"gpt-6"}`), &out)
	if state, err := codexHookStateForTest(env, "s"); err != nil || state != "idle" {
		t.Fatalf("Codex Stop state = %q, %v", state, err)
	}
}

func codexHookStateForTest(env *sysenv.Env, id string) (string, error) {
	return messaging.MailboxState(env, "codex", id, "host")
}

func TestEventHookOffersPiMailboxOnlyOnPrompt(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	hook := func(name string) string {
		var out bytes.Buffer
		payload, _ := json.Marshal(eventHookInput{
			HookEventName:  name,
			Harness:        "pi",
			SessionID:      "session",
			CWD:            "/project",
			TranscriptPath: filepath.Join(t.TempDir(), "session.jsonl"),
		})
		if err := newApp(env).runEventAndMessageHook(bytes.NewReader(payload), &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if out := hook("SessionStart"); out != "" || !messaging.MailboxAvailable(env, "pi", "session", "host") {
		t.Fatalf("Pi hook did not register: %q", out)
	}
	request := messaging.Request{Address: "shuttle://host/pi/session", Text: "queued", From: "shuttle://peer/pi/A", ReplyTo: "work/fiber", MessageID: "pi-hook"}
	if _, err := messaging.Send(context.Background(), env, "host", request); err != nil {
		t.Fatal(err)
	}
	if out := hook("PreToolUse"); out != "" {
		t.Fatalf("Pi activity hook drained mailbox: %s", out)
	}
	var envelope sessionEnvelope
	if err := json.Unmarshal([]byte(hook("UserPromptSubmit")), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.HookSpecificOutput.AdditionalContext != "[from work/fiber]\nqueued\n\n" {
		t.Fatalf("Pi prompt context missing: %s", envelope.HookSpecificOutput.AdditionalContext)
	}
	if out := hook("UserPromptSubmit"); out != "" {
		t.Fatalf("Pi mailbox replayed: %s", out)
	}
}

func TestEventHookDoesNotClassifyUnknownPayloadAsCodex(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "")
	var out bytes.Buffer
	_ = newApp(env).runEventAndMessageHook(bytes.NewBufferString(`{"hook_event_name":"PreToolUse","session_id":"s"}`), &out)
	if out.Len() != 0 || messaging.MailboxAvailable(env, "codex", "s", "") {
		t.Fatal("unidentified hook registered a Codex mailbox")
	}
}

func TestClaudeHookHonorsCustomConfigDirectory(t *testing.T) {
	t.Parallel()
	config := t.TempDir()
	env := messageHookEnv(t, "host")
	env.Unset("SHUTTLE_CLAUDE_PROJECTS_DIR")
	env.Set("CLAUDE_CONFIG_DIR", config)
	input := eventHookInput{HookEventName: "SessionStart", SessionID: "custom-session", TranscriptPath: filepath.Join(config, "projects", "workspace", "custom-session.jsonl")}
	b, _ := json.Marshal(input)
	var out bytes.Buffer
	if err := newApp(env).runEventAndMessageHook(bytes.NewReader(b), &out); err != nil {
		t.Fatal(err)
	}
	if !messaging.MailboxAvailable(env, "claude", input.SessionID, "host") || messaging.MailboxAvailable(env, "codex", input.SessionID, "host") {
		t.Fatal("custom Claude config registered the wrong harness")
	}
	input.TranscriptPath = filepath.Join(config+"-unrelated", "projects", "workspace", "custom-session.jsonl")
	if newApp(env).messageHookHarness(input) != "" {
		t.Fatal("unrelated transcript inherited Claude identity")
	}
}

// messageHookEnv is an env whose mailboxes live in a data directory of its
// own, with the event stream switched off and host as this machine's id (left
// unset when empty).
func messageHookEnv(t *testing.T, host string) *sysenv.Env {
	t.Helper()
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", t.TempDir())
	env.Set("SHUTTLE_EVENTS", "off")
	if host != "" {
		env.Set("SHUTTLE_HOST", host)
	}
	return env
}
