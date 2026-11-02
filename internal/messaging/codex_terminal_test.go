package messaging

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestCodexIdleWakeUsesLocalTerminalInput(t *testing.T) {
	var got struct {
		SessionUUID string `json:"session_uuid"`
		Text        string `json:"text"`
	}
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.Path != codexTerminalInputRoute {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"status":"submitted"}`))}, nil
	})
	env := codexTestEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:4000")
	registerCodexState(t, env, "thread-idle", "idle")
	request := Request{Address: "shuttle://host/codex/thread-idle", MessageID: "wake-1", Text: "please continue", From: "shuttle://peer/pi/source", Wake: true}
	receipt, err := submitCodexTerminalInputWithClient(context.Background(), env, Address{Host: "host", Harness: "codex", ID: "thread-idle"}, request, &http.Client{Transport: transport})
	if err != nil || receipt.Status != StatusSubmitted || receipt.Transport != "codex-terminal" {
		t.Fatalf("send = %+v, %v", receipt, err)
	}
	if got.SessionUUID != "thread-idle" || got.Text != Labeled(request) {
		t.Fatalf("terminal payload = %+v", got)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCodexBusyWakeSubmitsToTerminalQueue(t *testing.T) {
	env := codexTestEnv(t)
	request := Request{Address: "shuttle://host/codex/thread-busy", MessageID: "wake-busy", Text: "wait for next hook", Wake: true}
	called := false
	receipt, err := sendCodexTerminalWithDiscovery(context.Background(), env, Address{Host: "host", Harness: "codex", ID: "thread-busy"}, request, func(context.Context, *sysenv.Env, Address) error {
		t.Fatal("ordinary Wake must not depend on mailbox registration")
		return nil
	}, func(_ context.Context, _ *sysenv.Env, _ Address, got Request) (Receipt, error) {
		called = true
		if got.MessageID != request.MessageID || !got.Wake {
			t.Fatalf("submitted request = %+v", got)
		}
		return Receipt{Status: StatusSubmitted}, nil
	})
	if err != nil || !called || receipt.Status != StatusSubmitted {
		t.Fatalf("send = %+v, %v", receipt, err)
	}
	if pendingMailboxText(t, env, "codex", "thread-busy", "wait for next hook") {
		t.Fatal("terminal Wake was also queued as hook context")
	}
}

func TestCodexContextOnlyRehydratesQuietResumeReceiver(t *testing.T) {
	env := codexTestEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:4000")
	const id = "thread-resumed"
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.Path != codexTerminalReceiverRoute {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var payload struct {
			SessionUUID string `json:"session_uuid"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			return nil, err
		}
		if payload.SessionUUID != id {
			t.Errorf("receiver lookup UUID = %q", payload.SessionUUID)
		}
		body, _ := json.Marshal(map[string]any{
			"session_uuid": id, "pid": os.Getpid(), "process_start": processStartToken(os.Getpid()),
		})
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})
	client := &http.Client{Transport: transport}
	request := Request{Address: "shuttle://host/codex/" + id, MessageID: "context-resumed", Text: "next hook context", From: "shuttle://peer/pi/source"}
	receipt, err := sendCodexTerminalWithDiscovery(context.Background(), env, Address{Host: "host", Harness: "codex", ID: id}, request,
		func(ctx context.Context, env *sysenv.Env, address Address) error {
			return discoverCodexTerminalReceiverWithClient(ctx, env, address, client)
		},
		func(context.Context, *sysenv.Env, Address, Request) (Receipt, error) {
			t.Fatal("context-only message must wait for a real hook")
			return Receipt{}, nil
		},
	)
	if err != nil || receipt.Status != StatusQueued || receipt.Transport != "codex-hook" {
		t.Fatalf("send = %+v, %v", receipt, err)
	}
	if !MailboxAvailable(env, "codex", id, "host") {
		t.Fatal("quiet resume receiver was not registered")
	}
	if state, err := MailboxState(env, "codex", id, "host"); err != nil || state != "unknown" {
		t.Fatalf("unobserved turn state = %q, %v", state, err)
	}
	offered := false
	if err := OfferMailbox(env, "codex", id, "host", func(requests []Request) error {
		offered = len(requests) == 1 && requests[0].MessageID == request.MessageID
		return nil
	}); err != nil || !offered {
		t.Fatalf("first real hook did not offer queued context: offered=%v err=%v", offered, err)
	}
}

func TestSendContextOnlyRehydratesQuietResumeAfterEndedHook(t *testing.T) {
	env := codexTestEnv(t)
	const id = "thread-resumed-top-level"
	if err := RegisterMailbox(env, "codex", id, "host", "/work", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "codex", id, "host", "/work", os.Getpid(), false); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != codexTerminalReceiverRoute {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		var payload struct {
			SessionUUID string `json:"session_uuid"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload.SessionUUID != id {
			t.Errorf("receiver lookup UUID = %q", payload.SessionUUID)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"session_uuid": id, "pid": os.Getpid(), "process_start": processStartToken(os.Getpid()),
		})
	}))
	defer server.Close()
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	request := Request{Address: "shuttle://host/codex/" + id, MessageID: "context-resumed-top-level", Text: "queued after quiet resume"}
	receipt, err := Send(context.Background(), env, "host", request)
	if err != nil || receipt.Status != StatusQueued || receipt.Transport != "codex-hook" {
		t.Fatalf("Send = %+v, %v", receipt, err)
	}
	if !MailboxAvailable(env, "codex", id, "host") || !pendingMailboxText(t, env, "codex", id, request.Text) {
		t.Fatal("top-level Send did not re-register and queue context for the resumed receiver")
	}
}

func TestCodexContextOnlyRejectsChangedReceiverIdentity(t *testing.T) {
	env := codexTestEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:4000")
	const id = "thread-resumed"
	transport := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"session_uuid":"thread-resumed","pid":999999,"process_start":"old"}`))}, nil
	})
	err := discoverCodexTerminalReceiverWithClient(context.Background(), env, Address{Host: "host", Harness: "codex", ID: id}, &http.Client{Transport: transport})
	if err == nil || MailboxAvailable(env, "codex", id, "host") {
		t.Fatalf("stale receiver accepted: err=%v", err)
	}
}

func TestCodexIdleOnlyRefusesUnknownTurnState(t *testing.T) {
	env := codexTestEnv(t)
	registerCodexState(t, env, "thread-unknown", "")
	request := Request{Address: "shuttle://host/codex/thread-unknown", MessageID: "pulse-unknown", Text: "pulse", Wake: true, IdleOnly: true}
	receipt, err := (codexAdapter{}).send(context.Background(), env, Address{Host: "host", Harness: "codex", ID: "thread-unknown"}, request)
	if ErrorCode(err) != "busy" || receipt.Status != StatusRejected {
		t.Fatalf("send = %+v, %v", receipt, err)
	}
}

func TestCodexIdleOnlySerializesWithHookStateTransition(t *testing.T) {
	env := codexTestEnv(t)
	registerCodexState(t, env, "thread-race", "idle")
	request := Request{Address: "shuttle://host/codex/thread-race", MessageID: "pulse-race", Text: "pulse", Wake: true, IdleOnly: true}
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := sendCodexTerminal(context.Background(), env, Address{Host: "host", Harness: "codex", ID: "thread-race"}, request, func(context.Context, *sysenv.Env, Address, Request) (Receipt, error) {
			close(entered)
			<-release
			return Receipt{Status: StatusSubmitted}, nil
		})
		done <- err
	}()
	<-entered
	stateChanged := make(chan error, 1)
	attempting := make(chan struct{})
	go func() {
		close(attempting)
		stateChanged <- SetMailboxState(env, "codex", "thread-race", "host", "working")
	}()
	<-attempting
	select {
	case err := <-stateChanged:
		t.Fatalf("hook state changed before IdleOnly submission completed: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := <-stateChanged; err != nil {
		t.Fatal(err)
	}
}

func TestCodexDaemonEndpointUsesUnixSocket(t *testing.T) {
	env := codexTestEnv(t)
	dir, err := os.MkdirTemp("/tmp", "cdx-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "shuttle.sock")
	env.Set("SHUTTLE_LISTEN", "unix://"+socket)
	url, gotSocket, err := codexDaemonEndpoint(env)
	if err != nil || url != "http://shuttle.invalid" || gotSocket != socket {
		t.Fatalf("endpoint = %q, %q, %v", url, gotSocket, err)
	}
}

func TestCodexDaemonEndpointRejectsNonLocalURLs(t *testing.T) {
	for _, override := range []string{"https://127.0.0.1:4000", "http://example.com:4000", "http://127.0.0.1:4000/path"} {
		t.Run(override, func(t *testing.T) {
			env := codexTestEnv(t)
			env.Set("SHUTTLE_DAEMON_URL", override)
			if _, _, err := codexDaemonEndpoint(env); err == nil {
				t.Fatalf("accepted non-local daemon URL %q", override)
			}
		})
	}
	env := codexTestEnv(t)
	env.Set("SHUTTLE_LISTEN", "tcp://0.0.0.0:4000")
	if _, _, err := codexDaemonEndpoint(env); err == nil {
		t.Fatal("accepted exposed Shuttle listener")
	}
}

func TestCodexDaemonEndpointMatchesHostClassDefault(t *testing.T) {
	env := codexTestEnv(t)
	env.Set("SHUTTLE_HOST_CONFIG_FILE", "")
	dir, err := os.MkdirTemp("/tmp", "cdx-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	env.Set("SHUTTLE_DATA_DIR", filepath.Join(dir, ".shuttle"))
	home, err := env.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(home, ".config", "shuttle", "host.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(`{"class":"shared-multi-user"}`), 0600); err != nil {
		t.Fatal(err)
	}
	url, socket, err := codexDaemonEndpoint(env)
	wantSocket := env.Getenv("SHUTTLE_DATA_DIR") + "/sock/daemon.sock"
	if err != nil || url != "http://shuttle.invalid" || socket != wantSocket {
		t.Fatalf("shared class endpoint = %q, %q, %v", url, socket, err)
	}
	if err := os.WriteFile(configPath, []byte("{invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := codexDaemonEndpoint(env); err == nil {
		t.Fatal("malformed host config silently selected a different daemon")
	}
}

func codexTestEnv(t *testing.T) *sysenv.Env {
	t.Helper()
	root := t.TempDir()
	env := sysenv.New(root, []string{"HOME=" + root, "SHUTTLE_DATA_DIR=" + filepath.Join(root, ".shuttle")})
	if err := os.MkdirAll(env.Getenv("SHUTTLE_DATA_DIR"), 0700); err != nil {
		t.Fatal(err)
	}
	return env
}

func registerCodexState(t *testing.T, env *sysenv.Env, id, state string) {
	t.Helper()
	if err := RegisterMailbox(env, "codex", id, "host", "/work", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if state != "" {
		if err := SetMailboxState(env, "codex", id, "host", state); err != nil {
			t.Fatal(err)
		}
	}
}

func pendingMailboxText(t *testing.T, env *sysenv.Env, harness, id, text string) bool {
	t.Helper()
	root := filepath.Join(dataDir(env), "mailboxes", harness, mailboxKey(id), "pending")
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return false
		}
		t.Fatal(err)
	}
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(root, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var row mailboxEntry
		if json.Unmarshal(data, &row) == nil && row.Request.Text == text {
			return true
		}
	}
	return false
}
