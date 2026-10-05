package shuttlecli

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestShuttleLaunchRejectsARepositoryWithoutARelease(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("shuttle-launch is a POSIX shell script")
	}
	repo := t.TempDir()
	env := testEnv(t)
	env.Set("SHUTTLE_DIR", repo)
	script, err := os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(t.TempDir(), "shuttle-launch")
	if err := os.WriteFile(launcher, script, 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := env.Command("/bin/sh", launcher).CombinedOutput()
	if err == nil || !strings.Contains(string(out), "could not find a daemon release") {
		t.Fatalf("release-less repository result err=%v output=%q", err, out)
	}
}

func TestShuttleLaunchUsesGoDaemonLifecycleCommands(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("shuttle-launch is a POSIX shell script")
	}
	root := t.TempDir()
	releaseLauncher := filepath.Join(root, "bin", "rel", "bin", "shuttled")
	if err := os.MkdirAll(filepath.Dir(releaseLauncher), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(releaseLauncher, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	env := testEnv(t)
	dead := filepath.Join(root, "listener-dead")
	calls := filepath.Join(root, "calls")
	shuttle := `#!/bin/sh
case "$*" in
  "daemon status")
    [ -f "$SHUTTLE_TEST_DEAD" ] && exit 1
    printf '%s\n' '{"ready":false}'
    ;;
  "daemon start --force")
    printf 'start:%s\n' "$SHUTTLE_RELEASE" >> "$SHUTTLE_TEST_CALLS"
    exit 1
    ;;
  *) echo "unexpected shuttle argv: $*" >&2; exit 2 ;;
esac
`
	sysenvtest.FakeCommand(t, env, "shuttle", shuttle)
	sleep := `#!/bin/sh
case "${1:-}" in
  5) : > "$SHUTTLE_TEST_DEAD" ;;
  2) kill -TERM "$PPID" ;;
esac
exec /bin/sleep 0.02
`
	sysenvtest.FakeCommand(t, env, "sleep", sleep)
	script, err := os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(root, "shuttle-launch")
	if err := os.WriteFile(launcher, script, 0o755); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	env.Set("HOME", home)
	env.Set("SHUTTLE_DIR", root)
	env.Set("SHUTTLE_LOG", filepath.Join(root, "shuttle.log"))
	env.Set("SHUTTLE_TEST_DEAD", dead)
	env.Set("SHUTTLE_TEST_CALLS", calls)
	out, err := env.Command("/bin/sh", launcher, "--loop").CombinedOutput()
	if err == nil {
		t.Fatalf("respawn loop survived its stop signal: %s", out)
	}
	if !strings.Contains(string(out), "still booting; checking again in 5s") {
		t.Fatalf("loop did not wait on a booting listener: %s", out)
	}
	got, err := os.ReadFile(calls)
	if err != nil {
		t.Fatalf("loop did not start the daemon after the listener died: %v\n%s", err, out)
	}
	want := "start:" + filepath.Join(root, "bin", "rel")
	if strings.TrimSpace(string(got)) != want {
		t.Fatalf("daemon CLI calls = %q, want %q", got, want)
	}
}
