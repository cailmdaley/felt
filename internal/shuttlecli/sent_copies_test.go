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

// sentEvent reads the one event a send appended to sink.
func sentEvent(t *testing.T, sink string) map[string]any {
	t.Helper()
	lines := readEventLines(t, sink)
	if len(lines) != 1 {
		t.Fatalf("stream holds %d lines, want 1", len(lines))
	}
	return lines[0]
}

// The bug: a send recorded only a path, which the daemon read later. A file
// from a folder the daemon could not read, or a scratch directory a reboot
// cleared, could then never be opened. The send now carries a copy that
// outlives its original.
func TestSendFileCopyOutlivesItsOriginal(t *testing.T) {
	t.Parallel()
	env, sink, artifact := sendFileTestEnv(t)
	if _, _, err := executeIn(t, env, filepath.Dir(artifact), "send-file", artifact); err != nil {
		t.Fatal(err)
	}
	event := sentEvent(t, sink)
	copies, _ := event["copies"].(map[string]any)
	stored, _ := copies[artifact].(string)
	if filepath.Dir(stored) != filepath.Join(filepath.Dir(sink), "sent-files") || filepath.Ext(stored) != ".html" {
		t.Fatalf("copy %q is not a typed file in the stream's copy store: %v", stored, event)
	}
	if event["files"].([]any)[0] != artifact {
		t.Fatalf("the send no longer names its original: %v", event)
	}
	if err := os.Remove(artifact); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(stored); err != nil || string(body) != "hello" {
		t.Fatalf("copy after the original went: %q, %v", body, err)
	}
	if info, err := os.Stat(stored); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("copy is not private: %v, %v", info, err)
	}
}

func TestSendFileRefusesAnUnreadableFile(t *testing.T) {
	t.Parallel()
	if os.Geteuid() == 0 {
		t.Skip("root reads every file")
	}
	env, sink, artifact := sendFileTestEnv(t)
	if err := os.Chmod(artifact, 0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executeIn(t, env, filepath.Dir(artifact), "send-file", artifact); err == nil || !strings.Contains(err.Error(), "read artifact") {
		t.Fatalf("unreadable send = %v, want a read refusal", err)
	}
	if _, err := os.Stat(sink); !os.IsNotExist(err) {
		t.Fatalf("an unreadable send was recorded: %v", err)
	}
}

// Claude's SendUserFile is recorded by the hook, which runs inside the
// worker's harness and so can read what the daemon cannot. It takes the copy,
// keyed by the path the daemon resolves against the event's cwd.
func TestSendUserFileHookCopiesWhatItSends(t *testing.T) {
	t.Parallel()
	env, sink := eventStream(t)
	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, "results"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cwd, "results", "frame.png"), []byte("png bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse", "session_id": "sess-a", "cwd": cwd,
		"tool_name":  "SendUserFile",
		"tool_input": map[string]any{"files": []string{"results/frame.png", filepath.Join(cwd, "gone.png")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	env.Stdin, env.Stdout = bytes.NewReader(payload), &bytes.Buffer{}
	cmd := NewRootCmd(env)
	cmd.SetArgs([]string{"hook", "event"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	event := sentEvent(t, sink)
	copies, _ := event["copies"].(map[string]any)
	if len(copies) != 1 {
		t.Fatalf("copies = %v, want the one file that exists", event["copies"])
	}
	stored, _ := copies[filepath.Join(cwd, "results", "frame.png")].(string)
	if body, err := os.ReadFile(stored); err != nil || string(body) != "png bytes" {
		t.Fatalf("hook copy = %q, %v", body, err)
	}
}

// Copies are content-addressed: a re-send of the same bytes keeps one copy
// and renews it, and a send removes copies untouched for the retention window.
func TestSentCopiesAreSharedAndExpire(t *testing.T) {
	t.Parallel()
	env, sink, artifact := sendFileTestEnv(t)
	twin := filepath.Join(filepath.Dir(artifact), "twin.html")
	if err := os.WriteFile(twin, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := newApp(env)
	if _, err := a.sendFiles([]string{artifact}, "", ""); err != nil {
		t.Fatal(err)
	}
	store := filepath.Join(filepath.Dir(sink), "sent-files")
	stale := filepath.Join(store, "0000.png")
	if err := os.WriteFile(stale, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-sentCopyRetention - time.Hour)
	entries, _ := os.ReadDir(store)
	for _, entry := range entries {
		if err := os.Chtimes(filepath.Join(store, entry.Name()), old, old); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.sendFiles([]string{twin}, "", ""); err != nil {
		t.Fatal(err)
	}
	entries, _ = os.ReadDir(store)
	if len(entries) != 1 || entries[0].Name() == "0000.png" {
		t.Fatalf("store holds %v, want the one renewed shared copy", entries)
	}
	if info, _ := entries[0].Info(); time.Since(info.ModTime()) > time.Hour {
		t.Fatalf("a re-send did not renew its copy: %v", info.ModTime())
	}
}
