package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// sendFileTestEnv is an env attributing sends to a Codex session on
// test-host, with its event sink and an artifact to send.
func sendFileTestEnv(t *testing.T) (env *sysenv.Env, sink, artifact string) {
	t.Helper()
	dir := t.TempDir()
	sink = filepath.Join(dir, "events.jsonl")
	env = testEnv(t)
	env.Set("SHUTTLE_EVENTS_FILE", sink)
	env.Set("SHUTTLE_EVENTS", "")
	env.Set("SHUTTLE_HOST", "test-host")
	env.Set("SHUTTLE_TMUX_SESSION", "")
	env.Set("TMUX", "")
	env.Set("CODEX_THREAD_ID", "codex-session")
	env.Set("CLAUDE_SESSION_ID", "")
	env.Set("CLAUDE_CODE_SESSION_ID", "")
	env.Set("SHUTTLE_SESSIONS_FILE", filepath.Join(dir, "sessions.jsonl"))
	artifact = filepath.Join(dir, "report with spaces.html")
	if err := os.WriteFile(artifact, []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	return env, sink, artifact
}

func TestSendFilesRecordsExplicitDelivery(t *testing.T) {
	t.Parallel()
	env, sink, artifact := sendFileTestEnv(t)
	files, err := newApp(env).sendFiles([]string{artifact, artifact}, "")
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
	t.Parallel()
	for _, scenario := range []string{"missing", "directory", "disabled", "identity", "unwritable"} {
		t.Run(scenario, func(t *testing.T) {
			t.Parallel()
			env, sink, artifact := sendFileTestEnv(t)
			paths := []string{artifact}
			switch scenario {
			case "missing":
				paths = append(paths, artifact+"missing")
			case "directory":
				paths = append(paths, filepath.Dir(artifact))
			case "disabled":
				env.Set("SHUTTLE_EVENTS", "off")
			case "identity":
				env.Set("CODEX_THREAD_ID", "")
				env.Set("SHUTTLE_TMUX_SESSION", "ordinary-shell")
			case "unwritable":
				env.Set("SHUTTLE_EVENTS_FILE", artifact+"/events.jsonl")
			}
			if _, err := newApp(env).sendFiles(paths, ""); err == nil {
				t.Fatal("expected error")
			}
			if _, err := os.Stat(sink); !os.IsNotExist(err) {
				t.Fatalf("recorded invalid batch: %v", err)
			}
		})
	}
}

func TestSendFilesLedgerAndExplicitSession(t *testing.T) {
	t.Parallel()
	env, sink, artifact := sendFileTestEnv(t)
	env.Set("CODEX_THREAD_ID", "")
	env.Set("SHUTTLE_TMUX_SESSION", "worker")
	ledger := "{\"tmux\":\"worker\",\"session\":\"older\"}\n{\"tmux\":\"other\",\"session\":\"wrong\"}\n{\"tmux\":\"worker\",\"session\":\"newer\"}\n"
	if err := os.WriteFile(env.Getenv("SHUTTLE_SESSIONS_FILE"), []byte(ledger), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newApp(env).sendFiles([]string{artifact}, ""); err != nil {
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
	t.Parallel()
	for _, tc := range []struct{ name, explicit, codex, claude, pi, aiAgent, want string }{
		{"explicit", "chosen", "codex", "claude", "pi", "pi", "chosen"},
		{"codex", "", "codex", "claude", "", "", "codex"},
		{"claude", "", "", "claude", "", "", "claude"},
		{"pi", "", "", "", "pi", "pi", "pi"},
		{"pi nested in claude", "", "", "claude", "pi", "pi", "pi"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env, sink, artifact := sendFileTestEnv(t)
			env.Set("CODEX_THREAD_ID", tc.codex)
			env.Set("CLAUDE_CODE_SESSION_ID", tc.claude)
			env.Set("PI_SESSION_ID", tc.pi)
			env.Set("AI_AGENT", tc.aiAgent)
			cwd := t.TempDir()
			env.Chdir(cwd)
			relative, err := filepath.Rel(cwd, artifact)
			if err != nil {
				t.Fatal(err)
			}
			files, err := newApp(env).sendFiles([]string{relative}, tc.explicit)
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
	t.Parallel()
	env, _, artifact := sendFileTestEnv(t)
	fifo := artifact + ".fifo"
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	a := newApp(env)
	go func() { _, err := a.sendFiles([]string{fifo}, "test-session"); result <- err }()
	// The rejection returns at once; the bound only names a send that opened
	// the FIFO and is waiting for a writer that never comes.
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("FIFO accepted")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("blocked opening FIFO")
	}
}
