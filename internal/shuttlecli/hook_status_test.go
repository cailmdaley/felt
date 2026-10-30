package shuttlecli

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/progstatus"
)

func TestProgramStatusMapping(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, event, tool, notification, background string
		state, kind, msg                            string
		report                                      bool
	}{
		{"start", "SessionStart", "", "", "", "idle", "", "", true},
		{"prompt", "UserPromptSubmit", "", "", "", "working", "", "", true},
		{"question", "PreToolUse", "AskUserQuestion", "", "", "blocked", "question", "Question", true},
		{"plan", "PreToolUse", "ExitPlanMode", "", "", "blocked", "permission", "Plan approval", true},
		{"tool start", "PreToolUse", "Bash", "", "", "working", "", "Bash", true},
		{"tool end", "PostToolUse", "Bash", "", "", "working", "", "Bash", true},
		{"question answered", "PostToolUse", "AskUserQuestion", "", "", "working", "", "AskUserQuestion", true},
		{"plan approved", "PostToolUse", "ExitPlanMode", "", "", "working", "", "ExitPlanMode", true},
		{"permission", "Notification", "", "permission_prompt", "", "blocked", "permission", "Notification text", true},
		{"elicitation", "Notification", "", "elicitation_dialog", "", "blocked", "question", "Notification text", true},
		{"idle notification", "Notification", "", "idle_prompt", "", "", "", "", false},
		{"other notification", "Notification", "", "other", "", "blocked", "", "Notification text", true},
		{"unspecified notification", "Notification", "", "", "", "blocked", "", "Notification text", true},
		{"background work", "Stop", "", "", `[{"status":"running"},{}]`, "working", "", "2 background tasks", true},
		{"one background task", "Stop", "", "", `[{}]`, "working", "", "1 background tasks", true},
		{"stop", "Stop", "", "", "", "done", "", "", true},
		{"empty background", "Stop", "", "", `[]`, "done", "", "", true},
		{"reshaped background", "Stop", "", "", `{"count":2}`, "done", "", "", true},
		{"subagent", "SubagentStop", "", "", `[{}]`, "", "", "", false},
		{"end", "SessionEnd", "", "", "", "clear", "", "", true},
		{"unknown", "PreCompact", "", "", "", "", "", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := eventHookInput{
				HookEventName: tc.event, ToolName: tc.tool, NotificationType: tc.notification,
				BackgroundTasks: json.RawMessage(tc.background), Message: "Notification text",
				Prompt: "private prompt", ToolInput: json.RawMessage(`{"secret":"private input"}`),
			}
			for harness, app := range map[string]string{"claude": "claude-code", "pi": "pi"} {
				got, ok := programStatusFor(input, harness, "/fibers/project/fiber-name.md")
				want := progstatus.Report{}
				if tc.report {
					want = progstatus.Report{State: tc.state, Kind: tc.kind, App: app, Title: "fiber-name", Msg: tc.msg}
				}
				if ok != tc.report || got != want {
					t.Errorf("%s: got %+v, %v; want %+v, %v", harness, got, ok, want, tc.report)
				}
			}
		})
	}
	for _, harness := range []string{"codex", "unknown", ""} {
		if _, ok := programStatusFor(eventHookInput{HookEventName: "SessionStart"}, harness, ""); ok {
			t.Errorf("unsupported harness %q reports", harness)
		}
	}
	for _, path := range []string{"", "project/fiber-name", "/fibers/fiber-name.md"} {
		got, _ := programStatusFor(eventHookInput{HookEventName: "SessionStart"}, "claude", path)
		want := "fiber-name"
		if path == "" {
			want = ""
		}
		if got.Title != want {
			t.Errorf("path %q: title %q, want %q", path, got.Title, want)
		}
	}
}

func TestProgramStatusGatesAndTarget(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, tmux, off, harness, transcript, event, notification, tty string
		wantPID                                                        int
		wantApp, wantPath                                              string
	}{
		{"claude receiver", "socket", "", "claude", "", "SessionStart", "", "/dev/test-tty", 123, "claude-code", "/dev/test-tty"},
		{"pi native pid", "socket", "", "pi", "", "SessionStart", "", "/dev/test-tty", 456, "pi", "/dev/test-tty"},
		{"fallback tty", "socket", "", "claude", "", "SessionStart", "", "", 123, "claude-code", "/dev/tty"},
		{"off", "socket", "off", "claude", "", "SessionStart", "", "", 0, "", ""},
		{"zero", "socket", "0", "claude", "", "SessionStart", "", "", 0, "", ""},
		{"direct terminal", "", "", "claude", "", "SessionStart", "", "", 0, "", ""},
		{"no force outside tmux", "", "1", "pi", "", "SessionStart", "", "", 0, "", ""},
		{"codex", "socket", "", "codex", ".claude/projects/s.jsonl", "SessionStart", "", "", 0, "", ""},
		{"inferred codex", "socket", "", "", ".codex/sessions/s.jsonl", "SessionStart", "", "", 0, "", ""},
		{"unknown transcript", "socket", "", "other", "unrelated/s.jsonl", "SessionStart", "", "", 0, "", ""},
		{"inferred claude", "socket", "", "", ".claude/projects/s.jsonl", "SessionStart", "", "/dev/test-tty", 123, "claude-code", "/dev/test-tty"},
		{"inferred pi", "socket", "", "", ".pi/agent/sessions/s.jsonl", "SessionStart", "", "/dev/test-tty", 456, "pi", "/dev/test-tty"},
		{"explicit pi wins", "socket", "", "pi", ".codex/sessions/s.jsonl", "SessionStart", "", "/dev/test-tty", 456, "pi", "/dev/test-tty"},
		{"unknown harness falls back", "socket", "", "other", ".claude/projects/s.jsonl", "SessionStart", "", "/dev/test-tty", 123, "claude-code", "/dev/test-tty"},
		{"idle notification", "socket", "", "claude", "", "Notification", "idle_prompt", "", 0, "", ""},
		{"async subagent", "socket", "", "claude", "", "SubagentStop", "", "", 0, "", ""},
		{"unknown event", "socket", "", "claude", "", "Other", "", "", 0, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env, home := isolateEvents(t)
			env.Set("TMUX", tc.tmux)
			env.Set("SHUTTLE_PROGRAM_STATUS", tc.off)
			env.Set("SHUTTLE_FIBER_PATH", "/fibers/project/fiber.md")
			a := newApp(env)
			receiverCalls, ttyCalls, writes := 0, 0, 0
			a.eventReceiverPID = func() int { receiverCalls++; return 123 }
			a.programStatusTTY = func(pid int) string {
				ttyCalls++
				if pid != tc.wantPID {
					t.Errorf("receiver = %d, want %d", pid, tc.wantPID)
				}
				return tc.tty
			}
			a.programStatusWrite = func(path string, b []byte) error {
				writes++
				want := progstatus.WrapTmux(progstatus.Report{State: "idle", App: tc.wantApp, Title: "fiber"}.Encode())
				if path != tc.wantPath || !bytes.Equal(b, want) {
					t.Errorf("write %q %q; want %q %q", path, b, tc.wantPath, want)
				}
				return errors.New("unwritable terminal")
			}
			transcript := ""
			if tc.transcript != "" {
				transcript = filepath.Join(home, tc.transcript)
			}
			a.reportProgramStatus(eventHookInput{HookEventName: tc.event, Harness: tc.harness, NativePID: 456,
				TranscriptPath: transcript, NotificationType: tc.notification, Model: "model"})
			wantCalls := 0
			if tc.wantPath != "" {
				wantCalls = 1
			}
			if writes != wantCalls || ttyCalls != wantCalls {
				t.Errorf("writes=%d tty lookups=%d, want %d each", writes, ttyCalls, wantCalls)
			}
			wantReceiverCalls := 0
			if tc.wantPID == 123 {
				wantReceiverCalls = 1
			}
			if receiverCalls != wantReceiverCalls {
				t.Errorf("receiver calls=%d, want %d", receiverCalls, wantReceiverCalls)
			}
		})
	}
}

func TestProgramStatusDefaultWriterRefusesIsolatedEnv(t *testing.T) {
	t.Parallel()
	a := testApp(t)
	path := filepath.Join(t.TempDir(), "terminal")
	const sentinel = "untouched"
	if err := os.WriteFile(path, []byte(sentinel), 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.programStatusWrite(path, []byte("escape bytes")); err == nil {
		t.Fatal("isolated default writer accepted a write")
	}
	a.env.Set("TMUX", "socket")
	a.programStatusTTY = func(int) string { return path }
	a.eventReceiverPID = func() int { return 123 }
	a.reportProgramStatus(eventHookInput{Harness: "claude", HookEventName: "SessionStart"})
	got, err := os.ReadFile(path)
	if err != nil || string(got) != sentinel {
		t.Fatalf("isolated writer touched file: %q, %v", got, err)
	}
}

func TestProgramStatusHookBeforeEventAndMessagesOff(t *testing.T) {
	t.Parallel()
	env, path := eventStream(t)
	env.Set("TMUX", "socket")
	env.Set("SHUTTLE_MESSAGES", "off")
	env.Set("SHUTTLE_FIBER_PATH", "/fibers/project/fiber.md")
	a := newApp(env)
	a.eventReceiverPID = func() int { return 123 }
	a.eventProcessBirth = func(int) string { return "birth" }
	a.programStatusTTY = func(int) string { return "/dev/test-tty" }
	writes := 0
	a.programStatusWrite = func(path string, b []byte) error {
		writes++
		want := "\x1bPtmux;\x1b\x1b]7501;state=blocked:kind=permission:app=claude-code:title=ZmliZXI=:msg=QXBwcm92ZT8=\x1b\x1b\\\x1b\\"
		if path != "/dev/test-tty" || string(b) != want {
			t.Errorf("write %q %q, want wrapped notification %q", path, b, want)
		}
		return errors.New("write failure is silent")
	}
	a.eventNow = func() time.Time {
		if writes != 1 {
			t.Errorf("event recording started before status: writes=%d", writes)
		}
		return time.Unix(123, 0)
	}
	var stdout bytes.Buffer
	payload := `{"hook_event_name":"Notification","harness":"claude","session_id":"session","notification_type":"permission_prompt","message":"Approve?"}`
	if err := a.runEventAndMessageHook(bytes.NewBufferString(payload), &stdout); err != nil {
		t.Fatal(err)
	}
	if writes != 1 || stdout.Len() != 0 {
		t.Fatalf("writes=%d stdout=%q, want one silent write", writes, stdout.String())
	}
	lines := readEventLines(t, path)
	if len(lines) != 1 || lines[0]["notificationKind"] != "permission_prompt" {
		t.Fatalf("event missing: %+v", lines)
	}
	if _, exists := lines[0]["message"]; exists {
		t.Fatalf("notification message leaked into wire format: %+v", lines[0])
	}
}

func TestProgramStatusAndBoardDigestWithMessagesOff(t *testing.T) {
	env := messageHookEnv(t, "host")
	env.Set("TMUX", "socket")
	env.Set("SHUTTLE_MESSAGES", "off")
	const now = 1793300000000
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/board/family": func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"family":  map[string]any{"label": "family"},
			"records": []map[string]any{{"id": "one", "timestamp": now, "kind": "post", "member": "child", "text": "family update"}},
		})
	}})
	a := newApp(env)
	a.eventNow = func() time.Time { return time.UnixMilli(now) }
	a.eventReceiverPID = func() int { return 123 }
	a.programStatusTTY = func(int) string { return "/dev/test-tty" }
	writes := 0
	a.programStatusWrite = func(_ string, b []byte) error {
		writes++
		if !bytes.Contains(b, []byte("state=working:app=claude-code")) {
			t.Errorf("unexpected terminal status: %q", b)
		}
		return nil
	}
	var stdout bytes.Buffer
	payload := `{"hook_event_name":"UserPromptSubmit","harness":"claude","session_id":"session"}`
	if err := a.runEventAndMessageHook(strings.NewReader(payload), &stdout); err != nil {
		t.Fatal(err)
	}
	var envelope sessionEnvelope
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatalf("board context missing: %q, %v", stdout.String(), err)
	}
	if writes != 1 || !strings.Contains(envelope.HookSpecificOutput.AdditionalContext, "family update") {
		t.Fatalf("writes=%d context=%q; status and board must both survive disabled messaging", writes, stdout.String())
	}
}

func TestProgramStatusIndependentOfEvents(t *testing.T) {
	t.Parallel()
	for _, enabled := range []bool{false, true} {
		env, path := eventStream(t)
		env.Set("TMUX", "socket")
		env.Set("SHUTTLE_MESSAGES", "off")
		if enabled {
			env.Set("SHUTTLE_PROGRAM_STATUS", "off")
		} else {
			env.Set("SHUTTLE_EVENTS", "off")
		}
		a := newApp(env)
		a.eventReceiverPID = func() int { return 0 }
		a.eventProcessBirth = func(int) string { return "" }
		a.programStatusTTY = func(int) string { return "" }
		writes := 0
		a.programStatusWrite = func(string, []byte) error { writes++; return nil }
		var stdout bytes.Buffer
		if err := a.runEventAndMessageHook(bytes.NewBufferString(`{"hook_event_name":"Stop","harness":"claude","session_id":"s"}`), &stdout); err != nil {
			t.Fatal(err)
		}
		wantWrites, wantEvents := 1, 0
		if enabled {
			wantWrites, wantEvents = 0, 1
		}
		if writes != wantWrites || len(readEventLines(t, path)) != wantEvents || stdout.Len() != 0 {
			t.Fatalf("events enabled=%v: writes=%d lines=%v stdout=%q", enabled, writes, readEventLines(t, path), stdout.String())
		}
	}
}

func TestProgramStatusFirstHookValue(t *testing.T) {
	t.Parallel()
	for _, suffix := range []string{" trailing", `{"hook_event_name":"SessionEnd","session_id":"other"}`} {
		t.Run(suffix, func(t *testing.T) {
			env, path := eventStream(t)
			env.Set("TMUX", "socket")
			env.Set("TMUX_PANE", "%1")
			env.Set("SHUTTLE_MESSAGES", "off")
			a := newApp(env)
			a.eventReceiverPID = func() int { return 123 }
			a.programStatusTTY = func(int) string { return "/dev/test-tty" }
			writes := 0
			a.programStatusWrite = func(_ string, b []byte) error {
				writes++
				if !bytes.Contains(b, []byte("state=done:app=claude-code")) {
					t.Errorf("status did not use first object: %q", b)
				}
				return nil
			}
			var stdout bytes.Buffer
			payload := `{"hook_event_name":"Stop","harness":"claude","session_id":"first"}` + suffix
			if err := a.runEventAndMessageHook(strings.NewReader(payload), &stdout); err != nil {
				t.Fatal(err)
			}
			lines := readEventLines(t, path)
			if writes != 1 || stdout.Len() != 0 || len(lines) != 1 || lines[0]["type"] != "stop" || lines[0]["sessionId"] != "first" {
				t.Fatalf("writes=%d stdout=%q events=%+v; want only the first hook", writes, stdout.String(), lines)
			}
		})
	}
}

func TestProgramStatusMalformedHookSilent(t *testing.T) {
	t.Parallel()
	for _, payload := range []string{`not JSON`, `{"hook_event_name":"Stop"`, `{"hook_event_name":"Stop","harness":"claude","native_pid":"bad"}`} {
		env, path := eventStream(t)
		env.Set("TMUX", "socket")
		a := newApp(env)
		a.programStatusTTY = func(int) string { t.Fatal("malformed input probed tty"); return "" }
		a.programStatusWrite = func(string, []byte) error { t.Fatal("malformed input wrote status"); return nil }
		var stdout bytes.Buffer
		if err := a.runEventAndMessageHook(bytes.NewBufferString(payload), &stdout); err != nil || stdout.Len() != 0 || len(readEventLines(t, path)) != 0 {
			t.Fatalf("malformed hook not silent: %v %q", err, stdout.String())
		}
	}
}
