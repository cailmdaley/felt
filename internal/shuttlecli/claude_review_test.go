package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestCodexChildEventsRemainInStream(t *testing.T) {
	env := messageHookEnv(t, "host")
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS", "on")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	for _, in := range []eventHookInput{
		{Harness: "codex", HookEventName: "SessionStart", SessionID: "parent"},
		{Harness: "codex", HookEventName: "SubagentStop", SessionID: "parent", AgentID: "child-1"},
		{Harness: "codex", HookEventName: "PostToolUse", SessionID: "parent", AgentID: "child-1", ToolName: "Bash"},
	} {
		b, _ := json.Marshal(in)
		var out bytes.Buffer
		_ = newApp(env).runEventAndMessageHook(bytes.NewReader(b), &out)
	}
	lines, _ := os.ReadFile(events)
	if !bytes.Contains(lines, []byte("subagent_stop")) || !bytes.Contains(lines, []byte("post_tool_use")) {
		t.Fatalf("Codex child event dropped: %s", lines)
	}
}

func TestClaudeChildSentFileDoesNotAffectParentTurn(t *testing.T) {
	env := messageHookEnv(t, "host")
	events := filepath.Join(t.TempDir(), "events.jsonl")
	env.Set("SHUTTLE_EVENTS", "on")
	env.Set("SHUTTLE_EVENTS_FILE", events)
	for _, in := range []eventHookInput{
		{Harness: "claude", HookEventName: "SessionStart", SessionID: "parent"},
		{Harness: "claude", HookEventName: "PreToolUse", SessionID: "parent", AgentID: "child", ToolName: "SendUserFile", ToolInput: json.RawMessage(`{"files":["/tmp/report.html"]}`)},
	} {
		b, _ := json.Marshal(in)
		var out bytes.Buffer
		_ = newApp(env).runEventAndMessageHook(bytes.NewReader(b), &out)
		if out.Len() != 0 {
			t.Fatal(out.String())
		}
	}
	lines, _ := os.ReadFile(events)
	if !bytes.Contains(lines, []byte(`"type":"file_sent"`)) || !bytes.Contains(lines, []byte("/tmp/report.html")) || bytes.Contains(lines, []byte("pre_tool_use")) {
		t.Fatalf("child file missing or counted as turn activity: %s", lines)
	}
	if state, _ := messaging.MailboxState(env, "claude", "parent", "host"); state != "idle" {
		t.Fatalf("child file changed parent state: %q", state)
	}
}
