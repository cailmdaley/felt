package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func sendFileTestEnv(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	sink := filepath.Join(dir, "events.jsonl")
	t.Setenv("SHUTTLE_EVENTS_FILE", sink)
	t.Setenv("SHUTTLE_EVENTS", "")
	t.Setenv("SHUTTLE_HOST", "test-host")
	t.Setenv("SHUTTLE_TMUX_SESSION", "")
	t.Setenv("TMUX", "")
	t.Setenv("CODEX_THREAD_ID", "codex-session")
	t.Setenv("CLAUDE_SESSION_ID", "")
	t.Setenv("SHUTTLE_SESSIONS_FILE", filepath.Join(dir, "sessions.jsonl"))
	artifact := filepath.Join(dir, "report with spaces.html")
	if err := os.WriteFile(artifact, []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	return sink, artifact
}

func TestSendFilesRecordsExplicitDelivery(t *testing.T) {
	sink, artifact := sendFileTestEnv(t)
	files, err := sendFiles([]string{artifact, artifact}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("duplicate files: %v", files)
	}
	raw, err := os.ReadFile(sink)
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatal(err)
	}
	if event["type"] != "file_sent" || event["sessionId"] != "codex-session" || event["originName"] != "test-host" {
		t.Fatalf("bad attribution: %s", raw)
	}
	if event["tool"] != nil || event["harness"] != "" {
		t.Fatalf("invented harness activity: %s", raw)
	}
	if event["files"].([]any)[0] != artifact {
		t.Fatalf("wrong file: %s", raw)
	}
}

func TestSendFilesFailuresNeverRecord(t *testing.T) {
	for _, scenario := range []string{"missing", "directory", "disabled", "identity", "unwritable"} {
		t.Run(scenario, func(t *testing.T) {
			sink, artifact := sendFileTestEnv(t)
			paths := []string{artifact}
			switch scenario {
			case "missing":
				paths = append(paths, artifact+"missing")
			case "directory":
				paths = append(paths, filepath.Dir(artifact))
			case "disabled":
				t.Setenv("SHUTTLE_EVENTS", "off")
			case "identity":
				t.Setenv("CODEX_THREAD_ID", "")
				t.Setenv("SHUTTLE_TMUX_SESSION", "ordinary-shell")
			case "unwritable":
				t.Setenv("SHUTTLE_EVENTS_FILE", artifact+"/events.jsonl")
			}
			if _, err := sendFiles(paths, ""); err == nil {
				t.Fatal("expected error")
			}
			if _, err := os.Stat(sink); !os.IsNotExist(err) {
				t.Fatalf("recorded invalid batch: %v", err)
			}
		})
	}
}

func TestSendFilesLedgerAndExplicitSession(t *testing.T) {
	sink, artifact := sendFileTestEnv(t)
	t.Setenv("CODEX_THREAD_ID", "")
	t.Setenv("SHUTTLE_TMUX_SESSION", "worker")
	ledger := "{\"tmux\":\"worker\",\"session\":\"older\"}\n{\"tmux\":\"other\",\"session\":\"wrong\"}\n{\"tmux\":\"worker\",\"session\":\"newer\"}\n"
	if err := os.WriteFile(os.Getenv("SHUTTLE_SESSIONS_FILE"), []byte(ledger), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := sendFiles([]string{artifact}, ""); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(sink)
	var event eventLine
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatal(err)
	}
	if event.SessionID != "newer" {
		t.Fatalf("wrong session: %s", raw)
	}
}

func TestSendFilesIdentityPrecedence(t *testing.T) {
	for _, tc := range []struct{ name, explicit, codex, claude, want string }{
		{"explicit", "chosen", "codex", "claude", "chosen"},
		{"codex", "", "codex", "claude", "codex"},
		{"claude", "", "", "claude", "claude"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sink, artifact := sendFileTestEnv(t)
			t.Setenv("CODEX_THREAD_ID", tc.codex)
			t.Setenv("CLAUDE_SESSION_ID", tc.claude)
			cwd, _ := os.Getwd()
			relative, err := filepath.Rel(cwd, artifact)
			if err != nil {
				t.Fatal(err)
			}
			files, err := sendFiles([]string{relative}, tc.explicit)
			if err != nil {
				t.Fatal(err)
			}
			if files[0] != artifact {
				t.Fatalf("relative path not resolved: %v", files)
			}
			raw, _ := os.ReadFile(sink)
			var event eventLine
			if err := json.Unmarshal(raw, &event); err != nil {
				t.Fatal(err)
			}
			if event.SessionID != tc.want {
				t.Fatalf("got %q, want %q", event.SessionID, tc.want)
			}
		})
	}
}

func TestSendFilesRejectsFIFOWithoutBlocking(t *testing.T) {
	_, artifact := sendFileTestEnv(t)
	fifo := artifact + ".fifo"
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { _, err := sendFiles([]string{fifo}, "test-session"); result <- err }()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("FIFO accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked opening FIFO")
	}
}
