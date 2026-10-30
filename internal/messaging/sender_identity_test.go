package messaging

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectProcessSenderUsesNearestLiveUniqueRegistration(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name                           string
		inner, duplicate, stale, ended bool
		want                           string
	}{
		{name: "parent ancestry", want: "shuttle://host/claude/outer"},
		{name: "nested harness", inner: true, want: "shuttle://host/pi/inner"},
		{name: "unproved Codex hint does not obscure registered Pi", inner: true, duplicate: true, want: "shuttle://host/pi/inner"},
		{name: "reused pid", inner: true, stale: true, want: "shuttle://host/claude/outer"},
		{name: "ended inner", inner: true, ended: true, want: "shuttle://host/claude/outer"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			if err := os.MkdirAll(dataDir(env), 0700); err != nil {
				t.Fatal(err)
			}
			register := func(harness, id string, pid int) {
				t.Helper()
				if err := RegisterMailbox(env, harness, id, "host", "/project", pid, true); err != nil {
					t.Fatal(err)
				}
			}
			register("claude", "outer", os.Getppid())
			if tc.inner {
				register("pi", "inner", os.Getpid())
			}
			if tc.duplicate {
				register("codex", "other", os.Getpid())
			}
			if tc.stale || tc.ended {
				registration, err := mailboxRegistrationFor(env, "pi", "inner")
				if err != nil {
					t.Fatal(err)
				}
				if tc.stale {
					registration.Start = "another-process-lifetime"
				}
				registration.Ended = tc.ended
				b, err := json.Marshal(registration)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(mailboxDir(env, "pi", "inner"), "receiver.json"), b, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if got := DetectProcessSender(env, "host"); got != tc.want {
				t.Fatalf("sender=%q want=%q", got, tc.want)
			}
		})
	}
}

func TestDetectProcessSenderRejectsUnrelatedLiveProcessAndForeignHost(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if err := os.MkdirAll(dataDir(env), 0700); err != nil {
		t.Fatal(err)
	}
	child := exec.Command("sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	if err := RegisterMailbox(env, "claude", "unrelated", "host", "/project", child.Process.Pid, true); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "pi", "foreign", "other-host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if got := detectProcessSenderForThread(env, "host", map[int]int{os.Getpid(): 0}, 2); got != "" {
		t.Fatalf("unrelated process supplied sender %q", got)
	}
}

func TestCodexSenderRequiresValidCapabilityAndActiveOwner(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_CODEX_SOCKET", "/control.sock")
	env.Unset("CODEX_THREAD_ID")
	root := filepath.Join(dataDir(env), "app-workers")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	capability := strings.Repeat("a7", 32)
	env.Set("SHUTTLE_SENDER_CAPABILITY", capability)
	ownerPath := filepath.Join(root, "thread-1.json")
	if id, ok := codexSenderFromCapability(env, "host", capability); ok {
		t.Fatalf("missing owner accepted: %q", id)
	}
	for _, tc := range []struct {
		name                                  string
		active                                bool
		host, endpoint, thread, session, hash string
		envThread                             string
		want                                  bool
	}{
		{name: "valid", active: true, host: "host", endpoint: "/control.sock", thread: "thread-1", session: "thread-1", hash: tokenHash(capability), want: true},
		{name: "ended", active: false, host: "host", endpoint: "/control.sock", thread: "thread-1", session: "thread-1", hash: tokenHash(capability)},
		{name: "wrong host", active: true, host: "other", endpoint: "/control.sock", thread: "thread-1", session: "thread-1", hash: tokenHash(capability)},
		{name: "wrong endpoint", active: true, host: "host", endpoint: "/other.sock", thread: "thread-1", session: "thread-1", hash: tokenHash(capability)},
		{name: "wrong thread", active: true, host: "host", endpoint: "/control.sock", thread: "other", session: "thread-1", hash: tokenHash(capability)},
		{name: "wrong capability", active: true, host: "host", endpoint: "/control.sock", thread: "thread-1", session: "thread-1", hash: tokenHash(strings.Repeat("b8", 32))},
		{name: "overridden thread id", active: true, host: "host", endpoint: "/control.sock", thread: "thread-1", session: "thread-1", hash: tokenHash(capability), envThread: "impostor"},
		{name: "malformed capability", active: true, host: "host", endpoint: "/control.sock", thread: "thread-1", session: "thread-1", hash: tokenHash(capability), envThread: "thread-1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env.Unset("CODEX_THREAD_ID")
			if tc.envThread != "" {
				env.Set("CODEX_THREAD_ID", tc.envThread)
			}
			if tc.name == "malformed capability" {
				env.Set("SHUTTLE_SENDER_CAPABILITY", "bad")
			} else {
				env.Set("SHUTTLE_SENDER_CAPABILITY", capability)
			}
			data, _ := json.Marshal(codexCapabilityOwner{Active: tc.active, SessionUUID: tc.session, ThreadID: tc.thread, BackendHost: tc.host, BackendEndpoint: tc.endpoint, SenderCapabilityHash: tc.hash})
			if err := os.WriteFile(ownerPath, data, 0600); err != nil {
				t.Fatal(err)
			}
			id, ok := codexSenderFromCapability(env, "host", env.Getenv("SHUTTLE_SENDER_CAPABILITY"))
			if ok != tc.want {
				t.Fatalf("accepted=%v sender=%q want accepted=%v", ok, id, tc.want)
			}
		})
	}
}

func TestCodexCapabilityOverridesOuterRegistrationButNestedRegistrationWins(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_CODEX_SOCKET", "/control.sock")
	env.Unset("CODEX_THREAD_ID")
	if err := os.MkdirAll(dataDir(env), 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dataDir(env), "app-workers")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	capability := strings.Repeat("c4", 32)
	env.Set("SHUTTLE_SENDER_CAPABILITY", capability)
	record, _ := json.Marshal(codexCapabilityOwner{Active: true, SessionUUID: "thread-1", ThreadID: "thread-1", BackendHost: "host", BackendEndpoint: "/control.sock", SenderCapabilityHash: tokenHash(capability)})
	if err := os.WriteFile(filepath.Join(root, "thread-1.json"), record, 0600); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "claude", "outer", "host", "/project", os.Getppid(), true); err != nil {
		t.Fatal(err)
	}
	if id, ok := codexSenderFromCapability(env, "host", capability); !ok || id != "thread-1" {
		t.Fatalf("capability owner = %q, %v", id, ok)
	}
	if got := detectProcessSenderForThread(env, "host", map[int]int{os.Getpid(): 0, os.Getppid(): 3}, 2); got != "shuttle://host/codex/thread-1" {
		t.Fatalf("sender=%q", got)
	}
	if err := RegisterMailbox(env, "pi", "inner", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	if got := detectProcessSenderForThread(env, "host", map[int]int{os.Getpid(): 0, os.Getppid(): 1}, 2); got != "shuttle://host/pi/inner" {
		t.Fatalf("nested sender=%q", got)
	}
}

func TestInheritedCodexCapabilityYieldsToNestedParentPi(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_CODEX_SOCKET", "/control.sock")
	if err := os.MkdirAll(dataDir(env), 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dataDir(env), "app-workers")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	capability := strings.Repeat("d5", 32)
	env.Set("SHUTTLE_SENDER_CAPABILITY", capability)
	record, _ := json.Marshal(codexCapabilityOwner{Active: true, SessionUUID: "thread-1", ThreadID: "thread-1", BackendHost: "host", BackendEndpoint: "/control.sock", SenderCapabilityHash: tokenHash(capability)})
	if err := os.WriteFile(filepath.Join(root, "thread-1.json"), record, 0600); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "pi", "inner", "host", "/project", os.Getppid(), true); err != nil {
		t.Fatal(err)
	}
	ancestors := map[int]int{os.Getpid(): 0, os.Getppid(): 1}
	if got := detectProcessSenderForThread(env, "host", ancestors, 3); got != "shuttle://host/pi/inner" {
		t.Fatalf("nested sender=%q", got)
	}
}

func TestCodexCapabilityDisambiguatesSharedCodexRegistration(t *testing.T) {
	env := testEnv(t)
	env.Set("SHUTTLE_CODEX_SOCKET", "/control.sock")
	env.Unset("CODEX_THREAD_ID")
	if err := os.MkdirAll(dataDir(env), 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dataDir(env), "app-workers")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	capability := strings.Repeat("e6", 32)
	env.Set("SHUTTLE_SENDER_CAPABILITY", capability)
	record, _ := json.Marshal(codexCapabilityOwner{Active: true, SessionUUID: "thread-1", ThreadID: "thread-1", BackendHost: "host", BackendEndpoint: "/control.sock", SenderCapabilityHash: tokenHash(capability)})
	if err := os.WriteFile(filepath.Join(root, "thread-1.json"), record, 0600); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "codex", "thread-1", "host", "/project", os.Getppid(), true); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "codex", "thread-2", "host", "/project", os.Getppid(), true); err != nil {
		t.Fatal(err)
	}
	if got := detectProcessSenderForThread(env, "host", map[int]int{os.Getpid(): 0, os.Getppid(): 1}, 2); got != "shuttle://host/codex/thread-1" {
		t.Fatalf("shared Codex sender=%q", got)
	}
}

func TestMissingCodexCapabilityDoesNotSuppressPiRegistration(t *testing.T) {
	env := testEnv(t)
	env.Set("CODEX_THREAD_ID", "finished-thread")
	env.Set("SHUTTLE_SENDER_CAPABILITY", "invalid")
	if err := os.MkdirAll(dataDir(env), 0700); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "pi", "inner", "host", "/project", os.Getppid(), true); err != nil {
		t.Fatal(err)
	}
	if got := DetectProcessSender(env, "host"); got != "shuttle://host/pi/inner" {
		t.Fatalf("sender=%q", got)
	}
}

func TestCodexBoundaryBlocksOuterRegistrationsWithoutValidCapability(t *testing.T) {
	for _, capability := range []string{"", "invalid"} {
		t.Run(map[string]string{"": "missing", "invalid": "invalid"}[capability], func(t *testing.T) {
			env := testEnv(t)
			if capability != "" {
				env.Set("SHUTTLE_SENDER_CAPABILITY", capability)
			}
			if err := os.MkdirAll(dataDir(env), 0700); err != nil {
				t.Fatal(err)
			}
			if err := RegisterMailbox(env, "pi", "outer", "host", "/project", os.Getppid(), true); err != nil {
				t.Fatal(err)
			}
			ancestors := map[int]int{os.Getpid(): 0, os.Getppid(): 3}
			if got := detectProcessSenderForThread(env, "host", ancestors, 2); got != "" {
				t.Fatalf("outer registration crossed Codex boundary: %q", got)
			}
		})
	}
}

func TestCodexBoundaryKeepsCloserPiWithoutCapability(t *testing.T) {
	env := testEnv(t)
	if err := os.MkdirAll(dataDir(env), 0700); err != nil {
		t.Fatal(err)
	}
	if err := RegisterMailbox(env, "pi", "inner", "host", "/project", os.Getppid(), true); err != nil {
		t.Fatal(err)
	}
	ancestors := map[int]int{os.Getpid(): 0, os.Getppid(): 1}
	if got := detectProcessSenderForThread(env, "host", ancestors, 2); got != "shuttle://host/pi/inner" {
		t.Fatalf("closer nested registration=%q", got)
	}
}

func TestSenderHeaderRejectsDelimiters(t *testing.T) {
	t.Parallel()
	for _, from := range []string{"claude:x; reply to work/evil", "alice]", "[alice"} {
		request := Request{Address: "shuttle://host/claude/target", Text: "hello", MessageID: "header", From: from}
		if err := validateRequest("host", request); err == nil {
			t.Errorf("sender header injection accepted: %q", from)
		}
	}
}
