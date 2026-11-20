package messaging

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestDetectProcessSenderUsesNearestLiveUniqueRegistration(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name                string
		inner, stale, ended bool
		want                string
	}{
		{name: "parent ancestry", want: "shuttle://host/claude/outer"},
		{name: "nested harness", inner: true, want: "shuttle://host/pi/inner"},
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

// TestDetectProcessSenderStopsAtAnotherHarnessProcess registers a Claude
// receiver on this process and asks for the sender from a grandchild started
// by a copy of this test binary under a harness binary's name. A receiver
// beyond a nearer agy process belongs to the session agy runs inside, not to
// the caller; beyond a process of no harness it is the caller.
func TestDetectProcessSenderStopsAtAnotherHarnessProcess(t *testing.T) {
	t.Parallel()
	run := func(path string, env ...string) ([]byte, error) {
		cmd := exec.Command(path, "-test.run=^TestDetectProcessSenderStopsAtAnotherHarnessProcess$")
		cmd.Env = append(os.Environ(), env...)
		return cmd.Output()
	}
	switch os.Getenv("SHUTTLE_TEST_SENDER_ROLE") {
	case "caller":
		wd, _ := os.Getwd()
		os.Stdout.WriteString(DetectProcessSender(sysenv.New(wd, os.Environ()), "host") + "\n")
		return
	case "wrapper":
		out, err := run(os.Getenv("SHUTTLE_TEST_SENDER_BIN"), "SHUTTLE_TEST_SENDER_ROLE=caller")
		if err != nil {
			t.Fatal(err)
		}
		os.Stdout.Write(out)
		return
	}
	binary, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	env := testEnv(t)
	if err := RegisterMailbox(env, "claude", "outer", "host", "/project", os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	for wrapper, want := range map[string]string{"agy": "", "wrapper": "shuttle://host/claude/outer"} {
		path := filepath.Join(t.TempDir(), wrapper)
		if err := os.WriteFile(path, binary, 0o755); err != nil {
			t.Fatal(err)
		}
		out, err := run(path, "SHUTTLE_TEST_SENDER_ROLE=wrapper", "SHUTTLE_TEST_SENDER_BIN="+os.Args[0], "SHUTTLE_DATA_DIR="+dataDir(env))
		if err != nil {
			t.Fatalf("%s: %v", wrapper, err)
		}
		if got := strings.SplitN(string(out), "\n", 2)[0]; got != want {
			t.Fatalf("under %s: sender=%q want=%q", wrapper, got, want)
		}
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
	if got := detectProcessSenderForThread(env, "host", map[int]int{os.Getpid(): 0}, 2, ""); got != "" {
		t.Fatalf("unrelated process supplied sender %q", got)
	}
}
