package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestExplicitReleaseActivationDoesNotRerenderIndependentSupervisor(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	home, _ := env.UserHomeDir()
	a := newApp(env)
	first := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "deployed", "bin", "rel"))
	second := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "checkout with spaces", "bin", "rel"))
	for _, release := range []daemonRelease{first, second, first} {
		if _, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "select-release", release.Dir); err != nil {
			t.Fatalf("select: %v %s", err, stderr)
		}
		got, err := a.findDaemonReleaseAt("", filepath.Join(second.Dir, "bin", "shuttle"), home)
		if err != nil || got != release {
			t.Fatalf("selected %+v, %v; want %+v", got, err, release)
		}
		pointer, err := os.ReadFile(filepath.Join(home, ".shuttle", "repo"))
		if err != nil || string(pointer) != release.Dir+"\n" {
			t.Fatalf("pointer %q, %v", pointer, err)
		}
	}
	if _, _, err := executeIn(t, env, t.TempDir(), "daemon", "select-release", t.TempDir()); err == nil {
		t.Fatal("selected an unbuilt release")
	}
	if err := os.RemoveAll(first.Dir); err != nil {
		t.Fatal(err)
	}
	if _, err := a.findDaemonReleaseAt("", filepath.Join(second.Dir, "bin", "shuttle"), home); err == nil {
		t.Fatal("deleted selection silently fell back to another release")
	}
}

func TestReleasePointerThroughInstalledCLI(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	binary := filepath.Join(t.TempDir(), "shuttle")
	linkShuttleCLI(t, binary)
	env.Unset("SHUTTLE_RELEASE")
	env.Set("SHUTTLE_LISTEN", "unix://"+filepath.Join(shortPrivateTempDir(t), "absent.sock"))
	sysenvtest.FakeCommand(t, env, "tmux", "#!/bin/sh\nexit 1\n")
	for _, name := range []string{"exact-ref", "plain checkout"} {
		release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), name, "bin", "rel"))
		if err := os.WriteFile(release.Launcher, []byte("#!/bin/sh\nprintf '%s\\n' \"$0\"\n"), 0755); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{{"daemon", "select-release", release.Dir}, {"daemon", "activate-release", release.Dir, "--", "/bin/sh", "-c", ":"}, {"daemon", "start"}} {
			output, err := env.Command(binary, args...).CombinedOutput()
			if err != nil {
				t.Fatalf("%v: %v %s", args, err, output)
			}
			if args[1] == "start" && strings.TrimSpace(string(output)) != release.Launcher {
				t.Fatalf("launched %q, want %q", output, release.Launcher)
			}
		}
	}
	pointer, _ := os.ReadFile(filepath.Join(env.Getenv("HOME"), ".shuttle", "repo"))
	missing := strings.TrimSpace(string(pointer))
	if err := os.RemoveAll(missing); err != nil {
		t.Fatal(err)
	}
	output, err := env.Command(binary, "daemon", "start").CombinedOutput()
	if err == nil || !strings.Contains(string(output), missing) || !strings.Contains(string(output), "bin/shuttle-deploy --hosts local") || !strings.Contains(string(output), "main checkout") {
		t.Fatalf("missing selection diagnostic: %v %s", err, output)
	}
}

func TestDaemonStatusIncludesBootedReleaseEvenWhenStateAnswers(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/version" {
			fmt.Fprint(w, `{"ready":true,"release_path":"/absolute/booted/release"}`)
		} else {
			fmt.Fprint(w, `{"state":"running"}`)
		}
	}))
	defer server.Close()
	env := testEnv(t)
	env.Set("SHUTTLE_LISTEN", "tcp://"+strings.TrimPrefix(server.URL, "http://"))
	out, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "status")
	if err != nil {
		t.Fatalf("status: %v %s", err, stderr)
	}
	var receipt map[string]any
	if err := json.Unmarshal([]byte(out), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt["release_path"] != "/absolute/booted/release" || receipt["state"] != "running" {
		t.Fatalf("status: %s", out)
	}
}

func TestRespawnLoopReadsPointerBetweenStarts(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	home, _ := env.UserHomeDir()
	first := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "first release"))
	second := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "second release"))
	if err := newApp(env).selectDaemonRelease(first); err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(t.TempDir(), "shuttle-launch")
	if err := os.WriteFile(launcher, script, 0755); err != nil {
		t.Fatal(err)
	}
	calls := filepath.Join(t.TempDir(), "calls")
	env.Set("POINTER_TEST_CALLS", calls)
	env.Set("POINTER_TEST_NEXT", second.Dir)
	env.Set("SHUTTLE_DIR", first.Dir) // The loop must not retain this launch-time selection.
	env.Set("SHUTTLE_LOG", filepath.Join(t.TempDir(), "daemon.log"))
	sysenvtest.FakeCommand(t, env, "shuttle", `#!/bin/sh
case "$*" in
 "daemon status") exit 1;;
 "daemon start")
 printf '%s\n' "$SHUTTLE_RELEASE" >> "$POINTER_TEST_CALLS"
 if [ "$(wc -l < "$POINTER_TEST_CALLS")" -ge 2 ]; then kill -TERM "$PPID"; exit 1; fi
 printf '%s\n' "$POINTER_TEST_NEXT" > "$HOME/.shuttle/next"
 mv "$HOME/.shuttle/next" "$HOME/.shuttle/repo"
 exit 1;;
 *) exit 2;;
esac
`)
	sysenvtest.FakeCommand(t, env, "sleep", "#!/bin/sh\nexit 0\n")
	_, err = env.Command("/bin/sh", launcher, "--loop").CombinedOutput()
	if err == nil {
		t.Fatal("loop did not terminate")
	}
	data, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != first.Dir+"\n"+second.Dir+"\n" {
		t.Fatalf("starts used %q", data)
	}
	pointer, _ := os.ReadFile(filepath.Join(home, ".shuttle", "repo"))
	if strings.TrimSpace(string(pointer)) != second.Dir {
		t.Fatalf("loop overwrote pointer: %q", pointer)
	}
}
