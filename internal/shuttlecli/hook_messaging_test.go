package shuttlecli

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestEventHookOffersClaudeMailboxWithoutStopWake(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	home, _ := env.UserHomeDir()
	hook := func(name string) string {
		t.Helper()
		b, _ := json.Marshal(eventHookInput{HookEventName: name, SessionID: "s", TranscriptPath: filepath.Join(home, ".claude", "projects", "p", "s.jsonl")})
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
	r := messaging.Request{Address: "shuttle://host/claude/s", Text: "peer message", From: "peer", MessageID: "m"}
	if _, err := messaging.Send(context.Background(), env, "host", r); err != nil {
		t.Fatal(err)
	}
	if out := hook("Stop"); out != "" {
		t.Fatalf("Stop would wake the model: %s", out)
	}
	var got sessionEnvelope
	if err := json.Unmarshal([]byte(hook("PreToolUse")), &got); err != nil {
		t.Fatal(err)
	}
	if got.HookSpecificOutput.HookEventName != "PreToolUse" || !bytes.Contains([]byte(got.HookSpecificOutput.AdditionalContext), []byte(r.Text)) {
		t.Fatalf("bad context: %+v", got)
	}
	if out := hook("PostToolUse"); out != "" {
		t.Fatalf("duplicated message: %s", out)
	}
	hook("SessionEnd")
	if messaging.MailboxAvailable(env, "claude", "s", "host") {
		t.Fatal("mailbox still available")
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
	r := messaging.Request{Address: "shuttle://host/codex/s", Text: "peer context", MessageID: "m"}
	if receipt, err := messaging.Send(context.Background(), env, "host", r); err != nil || receipt.Transport != "codex-hook" {
		t.Fatalf("send: %+v %v", receipt, err)
	}
	out.Reset()
	_ = newApp(env).runEventAndMessageHook(bytes.NewBufferString(`{"hook_event_name":"UserPromptSubmit","session_id":"s","model":"gpt-6"}`), &out)
	if !bytes.Contains(out.Bytes(), []byte("peer context")) {
		t.Fatalf("Codex context missing: %s", out.String())
	}
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
	request := messaging.Request{Address: "shuttle://host/pi/session", Text: "queued", MessageID: "pi-hook"}
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
	if !bytes.Contains([]byte(envelope.HookSpecificOutput.AdditionalContext), []byte("queued")) {
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
