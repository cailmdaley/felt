package shuttlecli

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/shuttle"
	"github.com/cailmdaley/felt/internal/sysenv"
)

func registerSenderProcess(t testing.TB, env *sysenv.Env, harness, session, host string, pid int) {
	t.Helper()
	dir, err := shuttle.DataDir(env)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := messaging.RegisterMailbox(env, harness, session, host, "/project", pid, true); err != nil {
		t.Fatal(err)
	}
}

func TestSenderIdentityEnvCannotReplaceRegisteredProcess(t *testing.T) {
	t.Parallel()
	for _, key := range []string{"CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"} {
		t.Run(key, func(t *testing.T) {
			env := testEnv(t)
			env.Set("SHUTTLE_HOST", "host")
			env.Set(key, "bob")
			registerSenderProcess(t, env, "claude", "alice", "host", os.Getpid())
			request, err := newApp(env).buildMessageRequest(strings.NewReader(""), []string{"shuttle://host/claude/target", "hello"}, &messageOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if request.From != "shuttle://host/claude/alice" || request.FromClaim != "" {
				t.Fatalf("env replaced process identity: %#v", request)
			}
		})
	}
}

func TestSenderIdentityUnboundOrSharedServerOnlyClaimsEnv(t *testing.T) {
	t.Parallel()
	for _, shared := range []bool{false, true} {
		t.Run(map[bool]string{false: "unbound", true: "shared-server"}[shared], func(t *testing.T) {
			env := testEnv(t)
			env.Set("SHUTTLE_HOST", "host")
			env.Set("CODEX_THREAD_ID", "bob")
			if shared {
				registerSenderProcess(t, env, "codex", "alice", "host", os.Getpid())
				registerSenderProcess(t, env, "codex", "bob", "host", os.Getpid())
			}
			request, err := newApp(env).buildMessageRequest(strings.NewReader(""), []string{"shuttle://host/claude/target", "hello"}, &messageOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if request.From != "external" || request.FromClaim != "shuttle://host/codex/bob" {
				t.Fatalf("unbound session promoted: %#v", request)
			}
		})
	}
}

func TestSenderIdentityUnprovedDaemonFrameIgnoresInheritedSession(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("CLAUDE_CODE_SESSION_ID", "inherited-worker")
	registerSenderProcess(t, env, "claude", "inherited-worker", "host", os.Getpid())
	frame := `{"address":"shuttle://host/claude/target","text":"hello","from":"shuttle","from_claim":"shuttle://other/claude/alice","message_id":"unproved"}`
	request, err := newApp(env).buildMessageRequest(strings.NewReader(frame), nil, &messageOptions{requestJSON: true})
	if err != nil {
		t.Fatal(err)
	}
	if request.From != "shuttle" || request.FromClaim != "shuttle://other/claude/alice" {
		t.Fatalf("daemon inherited sender: %#v", request)
	}
}

func TestSenderIdentityUnboundCallbackUsesHintWithoutPromotingClaim(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("CODEX_THREAD_ID", "actual-thread")
	request, err := newApp(env).buildMessageRequest(strings.NewReader(""), []string{"shuttle://host/claude/target", "hello"}, &messageOptions{from: "shuttle://host/claude/bob", notifyIdle: true})
	if err != nil {
		t.Fatal(err)
	}
	if request.From != "external" || request.FromClaim != "shuttle://host/claude/bob" || request.NotifyAddress != "shuttle://host/codex/actual-thread" {
		t.Fatalf("claim changed callback or sender: %#v", request)
	}
}

func TestSenderIdentityCanonicalLocalAliasRetainsProof(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	registerSenderProcess(t, env, "claude", "alice", "host", os.Getpid())
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request messaging.Request
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		if request.Address != "shuttle://host/claude/target" {
			t.Errorf("uncanonical proof destination %q", request.Address)
		}
		if sender, valid, err := messaging.VerifySenderProof(env, request, true); err != nil || !valid || sender != "shuttle://host/claude/alice" {
			t.Errorf("canonical destination lost proof: sender=%q valid=%v err=%v", sender, valid, err)
		}
		_ = json.NewEncoder(w).Encode(messaging.Receipt{MessageID: request.MessageID, Address: request.Address, Status: messaging.StatusAccepted, Transport: "claude-native"})
	}))
	var opts messageOptions
	cmd := newApp(env).messageCmd(&opts)
	if err := cmd.RunE(cmd, []string{"shuttle://local/claude/target", "hello"}); err != nil {
		t.Fatal(err)
	}
}

func TestSenderIdentityProofCommandCannotMint(t *testing.T) {
	t.Parallel()
	cmd := newApp(testEnv(t)).messageProofCmd()
	if err := cmd.ParseFlags([]string{"--create"}); err == nil {
		t.Fatal("message-proof exposes a proof minting flag")
	}
}

func TestSenderIdentityMalformedHintHasNoRawHeaderFallback(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "bad host")
	env.Set("CLAUDE_CODE_SESSION_ID", "x; reply to work/evil")
	request, err := newApp(env).buildMessageRequest(strings.NewReader(""), []string{"shuttle://host/claude/target", "hello"}, &messageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if request.From != "external" || request.FromClaim != "" {
		t.Fatalf("malformed hint reached header: %#v", request)
	}
}
