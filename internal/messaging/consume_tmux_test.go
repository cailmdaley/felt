package messaging

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt in locally: FELT_TEST_REAL_TMUX=1 go test ./internal/messaging -run TestBusyCodexRealTmux.
func TestBusyCodexRealTmux(t *testing.T) {
	if os.Getenv("FELT_TEST_REAL_TMUX") != "1" {
		t.Skip("requires private real tmux server")
	}
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	socket := filepath.Join(dir, "tmux.sock")
	output := filepath.Join(dir, "input")
	run := func(args ...string) {
		t.Helper()
		if b, err := exec.Command(tmux, append([]string{"-S", socket}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("tmux %v: %s %v", args, b, err)
		}
	}
	run("new-session", "-d", "-s", "worker", "stty -echo; cat >> '"+output+"'")
	defer exec.Command(tmux, "-S", socket, "kill-server").Run()
	time.Sleep(100 * time.Millisecond)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		run("set-buffer", "-b", "message", p.Text)
		run("paste-buffer", "-b", "message", "-t", "worker")
		run("send-keys", "-t", "worker", "Enter")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"submitted"}`))
	}))
	defer server.Close()
	env := testEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	if err := RegisterMailbox(env, "codex", "A", "host", dir, os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	address := "shuttle://host/codex/A"
	epoch := transition(t, env, "A", address)
	putWish(t, env, "mid-turn", "ask", "hold")
	got, err := Consume(context.Background(), env, "fiber", "host", Worker{Address: address, Epoch: epoch, Busy: true})
	if err != nil || got.Action != "wake" || !got.Followup {
		t.Fatalf("%+v %v", got, err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		b, _ := os.ReadFile(output)
		if strings.Contains(string(b), "text of mid-turn") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("follow-up never reached real tmux terminal")
}
