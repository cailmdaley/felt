package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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

// sentCopy is the file the copy store holds under the name an event's
// `copies` records for path.
func sentCopy(t *testing.T, sink string, event map[string]any, path string) string {
	t.Helper()
	copies, _ := event["copies"].(map[string]any)
	name, _ := copies[path].(string)
	if !regexp.MustCompile(`^[0-9a-f]{64}(\.[A-Za-z0-9]{1,16})?$`).MatchString(name) {
		t.Fatalf("copy of %s is named %q, not <sha256>[.ext]: %v", path, name, event)
	}
	return filepath.Join(filepath.Dir(sink), "sent-files", name)
}

// storeCopies names the copies the store holds, leaving out its own files.
func storeCopies(t *testing.T, store string) []string {
	t.Helper()
	entries, err := os.ReadDir(store)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".") {
			names = append(names, entry.Name())
		}
	}
	return names
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
	stored := sentCopy(t, sink, event, artifact)
	if filepath.Ext(stored) != ".html" {
		t.Fatalf("copy %q lost its file type", stored)
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

// A file over the copy limit is sent without a copy, but it is opened all the
// same: an unreadable one is refused like any other.
func TestSendFileOverTheCopyLimitIsOpenedNotCopied(t *testing.T) {
	t.Parallel()
	env, sink, _ := sendFileTestEnv(t)
	large := filepath.Join(filepath.Dir(sink), "cube.fits")
	if err := os.WriteFile(large, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(large, sentCopyMaxBytes+1); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executeIn(t, env, filepath.Dir(large), "send-file", large); err != nil {
		t.Fatal(err)
	}
	if event := sentEvent(t, sink); event["copies"] != nil || event["files"].([]any)[0] != large {
		t.Fatalf("a file over the limit = %v, want it sent without a copy", event)
	}
	if names := storeCopies(t, filepath.Join(filepath.Dir(sink), "sent-files")); len(names) != 0 {
		t.Fatalf("store holds %v after a send over the limit", names)
	}
	if os.Geteuid() == 0 {
		return
	}
	if err := os.Chmod(large, 0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executeIn(t, env, filepath.Dir(large), "send-file", large); err == nil || !strings.Contains(err.Error(), "read artifact") {
		t.Fatalf("unreadable send over the limit = %v, want a read refusal", err)
	}
}

// The bug: a copy was named <sha256> plus the file's whole extension, so a
// name with an early dot (`v1.<200 characters>`) made a name longer than the
// filesystem allows and the whole send failed. Only a short alphanumeric
// extension is kept.
func TestSendFileCopiesAFileWithALongExtension(t *testing.T) {
	t.Parallel()
	env, sink, _ := sendFileTestEnv(t)
	odd := filepath.Join(filepath.Dir(sink), "v1."+strings.Repeat("x", 200))
	if err := os.WriteFile(odd, []byte("bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executeIn(t, env, filepath.Dir(odd), "send-file", odd); err != nil {
		t.Fatal(err)
	}
	if stored := sentCopy(t, sink, sentEvent(t, sink), odd); filepath.Ext(stored) != "" {
		t.Fatalf("copy %q kept an extension past the limit", stored)
	}
}

// Claude's SendUserFile is recorded by the hook, which runs inside the
// worker's harness and so can read what the daemon cannot. It takes the copy,
// keyed by the path the daemon resolves against the event's cwd, cleaned.
func TestSendUserFileHookCopiesWhatItSends(t *testing.T) {
	t.Parallel()
	env, sink := eventStream(t)
	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, "results"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"frame.png", "plot.png"} {
		if err := os.WriteFile(filepath.Join(cwd, "results", name), []byte("png bytes "+name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	payload, err := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse", "session_id": "sess-a", "cwd": cwd,
		"tool_name": "SendUserFile",
		"tool_input": map[string]any{"files": []string{
			"results/frame.png", cwd + "/results/../results//plot.png", filepath.Join(cwd, "gone.png"),
		}},
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
	if copies, _ := event["copies"].(map[string]any); len(copies) != 2 {
		t.Fatalf("copies = %v, want the two files that exist", event["copies"])
	}
	for _, name := range []string{"frame.png", "plot.png"} {
		stored := sentCopy(t, sink, event, filepath.Join(cwd, "results", name))
		if body, err := os.ReadFile(stored); err != nil || string(body) != "png bytes "+name {
			t.Fatalf("hook copy of %s = %q, %v", name, body, err)
		}
	}
}

// A SendUserFile call too long for one line keeps its caption and gives up
// its copies; its files are still recorded.
func TestSendUserFileHookDropsCopiesBeforeTheCaption(t *testing.T) {
	t.Parallel()
	env, sink := eventStream(t)
	cwd := t.TempDir()
	var files []string
	for i := 0; i < 45; i++ {
		name := filepath.Join(cwd, "figure-"+strconv.Itoa(i)+".png")
		if err := os.WriteFile(name, []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, name)
	}
	payload, err := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse", "session_id": "sess-a", "cwd": cwd,
		"tool_name":  "SendUserFile",
		"tool_input": map[string]any{"files": files, "caption": "every panel of the scan"},
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
	input, _ := event["toolInput"].(map[string]any)
	if input["caption"] != "every panel of the scan" || len(input["files"].([]any)) != len(files) || event["copies"] != nil {
		t.Fatalf("oversized send = caption %v, %d files, copies %v; want the caption and files without copies",
			input["caption"], len(input["files"].([]any)), event["copies"])
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
	stale := filepath.Join(store, strings.Repeat("0", 64)+".png")
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
	names := storeCopies(t, store)
	if len(names) != 1 || names[0] == filepath.Base(stale) {
		t.Fatalf("store holds %v, want the one renewed shared copy", names)
	}
	if info, _ := os.Stat(filepath.Join(store, names[0])); time.Since(info.ModTime()) > time.Hour {
		t.Fatalf("a re-send did not renew its copy: %v", info.ModTime())
	}
	if _, err := os.Stat(filepath.Join(store, ".lock")); err != nil {
		t.Fatalf("the prune removed the store's lock: %v", err)
	}
}
