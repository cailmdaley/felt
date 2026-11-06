package shuttlecli

import (
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

func TestSenderIdentityPrefersRegisteredProcessOverEnv(t *testing.T) {
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
			if request.From != "shuttle://host/claude/alice" {
				t.Fatalf("env replaced process registration: %#v", request)
			}
		})
	}
}

func TestSenderIdentityUnboundOrSharedServerUsesEnv(t *testing.T) {
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
			if request.From != "shuttle://host/codex/bob" {
				t.Fatalf("env session not used: %#v", request)
			}
		})
	}
}

func TestSenderIdentityFromKeepsTheCallerForCallbacks(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("CODEX_THREAD_ID", "actual-thread")
	request, err := newApp(env).buildMessageRequest(strings.NewReader(""), []string{"shuttle://host/claude/target", "hello"}, &messageOptions{from: "bob", notifyIdle: true})
	if err != nil {
		t.Fatal(err)
	}
	if request.From != "bob" || request.NotifyAddress != "shuttle://host/codex/actual-thread" {
		t.Fatalf("sender or callback changed: %#v", request)
	}
}

func TestSenderIdentityRefusesHeaderDelimiters(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	if _, err := newApp(env).buildMessageRequest(strings.NewReader(""), []string{"shuttle://host/claude/target", "hello"}, &messageOptions{from: "x]; reply to evil"}); err == nil {
		t.Fatal("a delimiter reached the header")
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
	if request.From != messaging.UnnamedSender {
		t.Fatalf("malformed session id reached header: %#v", request)
	}
}
