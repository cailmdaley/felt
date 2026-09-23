package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestEventHookOffersClaudeMailboxWithoutStopWake(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	t.Setenv("SHUTTLE_HOST", "host")
	t.Setenv("SHUTTLE_EVENTS", "off")
	hook := func(name string) string {
		t.Helper()
		b, _ := json.Marshal(eventHookInput{HookEventName: name, SessionID: "s", TranscriptPath: filepath.Join(home, ".claude", "projects", "p", "s.jsonl")})
		var out bytes.Buffer
		if err := runEventAndMessageHook(bytes.NewReader(b), &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if out := hook("SessionStart"); out != "" {
		t.Fatal(out)
	}
	if !messaging.MailboxAvailable("claude", "s", "host") {
		t.Fatal("hook failed to register")
	}
	r := messaging.Request{Address: "shuttle://host/claude/s", Text: "peer message", From: "peer", MessageID: "m"}
	if _, err := messaging.Send(context.Background(), "host", r); err != nil {
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
	if messaging.MailboxAvailable("claude", "s", "host") {
		t.Fatal("mailbox still available")
	}
}

func TestEventHookOffersCodexMailbox(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	t.Setenv("SHUTTLE_EVENTS", "off")
	t.Setenv("SHUTTLE_HOST", "host")
	var out bytes.Buffer
	_ = runEventAndMessageHook(bytes.NewBufferString(`{"hook_event_name":"SessionStart","session_id":"s","model":"gpt-6","cwd":"/work"}`), &out)
	if out.Len() != 0 || !messaging.MailboxAvailable("codex", "s", "host") {
		t.Fatal("Codex hook failed to register a mailbox")
	}
	r := messaging.Request{Address: "shuttle://host/codex/s", Text: "peer context", MessageID: "m"}
	if receipt, err := messaging.Send(context.Background(), "host", r); err != nil || receipt.Transport != "codex-hook" {
		t.Fatalf("send: %+v %v", receipt, err)
	}
	out.Reset()
	_ = runEventAndMessageHook(bytes.NewBufferString(`{"hook_event_name":"UserPromptSubmit","session_id":"s","model":"gpt-6"}`), &out)
	if !bytes.Contains(out.Bytes(), []byte("peer context")) {
		t.Fatalf("Codex context missing: %s", out.String())
	}
}

func TestEventHookOffersPiMailboxOnlyOnPrompt(t *testing.T) {
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	t.Setenv("SHUTTLE_EVENTS", "off")
	t.Setenv("SHUTTLE_HOST", "host")
	hook := func(name string) string {
		var out bytes.Buffer
		payload, _ := json.Marshal(eventHookInput{
			HookEventName:  name,
			Harness:        "pi",
			SessionID:      "session",
			CWD:            "/project",
			TranscriptPath: filepath.Join(t.TempDir(), "session.jsonl"),
		})
		if err := runEventAndMessageHook(bytes.NewReader(payload), &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if out := hook("SessionStart"); out != "" || !messaging.MailboxAvailable("pi", "session", "host") {
		t.Fatalf("Pi hook did not register: %q", out)
	}
	request := messaging.Request{Address: "shuttle://host/pi/session", Text: "queued", MessageID: "pi-hook"}
	if _, err := messaging.Send(context.Background(), "host", request); err != nil {
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
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	t.Setenv("SHUTTLE_EVENTS", "off")
	var out bytes.Buffer
	_ = runEventAndMessageHook(bytes.NewBufferString(`{"hook_event_name":"PreToolUse","session_id":"s"}`), &out)
	if out.Len() != 0 || messaging.MailboxAvailable("codex", "s", "") {
		t.Fatal("unidentified hook registered a Codex mailbox")
	}
}

func TestClaudeHookHonorsCustomConfigDirectory(t *testing.T) {
	config := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", config)
	t.Setenv("SHUTTLE_DATA_DIR", t.TempDir())
	t.Setenv("SHUTTLE_EVENTS", "off")
	t.Setenv("SHUTTLE_HOST", "host")
	input := eventHookInput{HookEventName: "SessionStart", SessionID: "custom-session", TranscriptPath: filepath.Join(config, "projects", "workspace", "custom-session.jsonl")}
	b, _ := json.Marshal(input)
	var out bytes.Buffer
	if err := runEventAndMessageHook(bytes.NewReader(b), &out); err != nil {
		t.Fatal(err)
	}
	if !messaging.MailboxAvailable("claude", input.SessionID, "host") || messaging.MailboxAvailable("codex", input.SessionID, "host") {
		t.Fatal("custom Claude config registered the wrong harness")
	}
	input.TranscriptPath = filepath.Join(config+"-unrelated", "projects", "workspace", "custom-session.jsonl")
	if messageHookHarness(input) != "" {
		t.Fatal("unrelated transcript inherited Claude identity")
	}
}
