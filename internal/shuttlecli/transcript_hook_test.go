package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSessionEndTranscriptIndexRunsDetachedSingleFileSubprocess(t *testing.T) {
	env := testEnv(t)
	bin := t.TempDir()
	marker := filepath.Join(t.TempDir(), "invoked")
	env.Set("PATH", bin)
	env.Set("TRANSCRIPT_HOOK_MARKER", marker)
	shim := "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$TRANSCRIPT_HOOK_MARKER\"\n"
	if err := os.WriteFile(filepath.Join(bin, "shuttle"), []byte(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err := newApp(env).startTranscriptIndexHook(eventHookInput{HookEventName: "SessionEnd", Harness: "codex", TranscriptPath: "/transcripts/rollout.jsonl"})
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("hook waited for subprocess: %s", elapsed)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if body, err := os.ReadFile(marker); err == nil {
			got := string(body)
			if !strings.Contains(got, "transcript index --file /transcripts/rollout.jsonl --harness codex") {
				t.Fatalf("child args: %q", got)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("detached child did not invoke the index command")
}
