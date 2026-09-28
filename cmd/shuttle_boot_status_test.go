package cmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestShuttleStatusTreatsBoundBootingDaemonAsAlive(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bin/shuttle is a POSIX shell script")
	}

	fakeBin := installShuttleProbeFakes(t)
	stateProbe := filepath.Join(t.TempDir(), "state-probed")
	t.Setenv("SHUTTLE_STATE_PROBE", stateProbe)
	t.Setenv("PATH", fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))

	cmd := exec.Command("sh", "../bin/shuttle", "status")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("status returned %v: %s", err, out)
	}
	if !strings.Contains(string(out), `"ready":false`) {
		t.Fatalf("status did not surface the booting version receipt: %s", out)
	}
	if _, err := os.Stat(stateProbe); !os.IsNotExist(err) {
		t.Fatalf("status fell through to /state while booting (stat err: %v)", err)
	}
}

func TestShuttleReleaseExplainsBootingDaemon(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bin/shuttle is a POSIX shell script")
	}

	fakeBin := installShuttleProbeFakes(t)
	t.Setenv("PATH", fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))

	cmd := exec.Command("sh", "../bin/shuttle", "release")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("release should wait for readiness instead of succeeding: %s", out)
	}
	if !strings.Contains(string(out), "daemon is still booting; retry when /api/v1/version shows ready:true") {
		t.Fatalf("release did not explain the readiness gate: %s", out)
	}
}

func TestShuttleStatusKeepsResponsiveDaemonAliveWhenStateIsUnavailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bin/shuttle is a POSIX shell script")
	}

	fakeBin := installShuttleProbeFakes(t)
	stateProbe := filepath.Join(t.TempDir(), "state-probed")
	t.Setenv("SHUTTLE_STATE_PROBE", stateProbe)
	t.Setenv("SHUTTLE_READY_TRUE", "1")
	t.Setenv("PATH", fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))

	cmd := exec.Command("sh", "../bin/shuttle", "status")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("status considered an answering listener dead: %v: %s", err, out)
	}
	if !strings.Contains(string(out), `"ready":true`) {
		t.Fatalf("status did not return the live version receipt: %s", out)
	}
	if _, err := os.Stat(stateProbe); err != nil {
		t.Fatalf("status did not test the state route: %v", err)
	}
}

func TestShuttleStartDoesNotLaunchBesideBoundBootingDaemon(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bin/shuttle is a POSIX shell script")
	}

	fakeBin := installShuttleProbeFakes(t)
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	launcher := filepath.Join(binDir, "rel", "bin", "shuttled")
	launched := filepath.Join(root, "launched")
	if err := os.MkdirAll(filepath.Dir(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile("../bin/shuttle")
	if err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(binDir, "shuttle")
	if err := os.WriteFile(shim, script, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nprintf started > \"$SHUTTLE_LAUNCH_MARKER\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SHUTTLE_LAUNCH_MARKER", launched)
	cmd := exec.Command("sh", shim, "start")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("start should refuse the already-bound daemon: %s", out)
	}
	if !strings.Contains(string(out), "Daemon already running") {
		t.Fatalf("start did not identify the bound daemon: %s", out)
	}
	if _, err := os.Stat(launched); !os.IsNotExist(err) {
		t.Fatalf("start launched a second daemon (stat err: %v)", err)
	}
}

func TestShuttleLaunchWaitsForBootingListenerThenNoticesDeath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shuttle-launch is a POSIX shell script")
	}

	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	fakeBin := filepath.Join(root, "fake-bin")
	for _, dir := range []string{binDir, fakeBin, filepath.Join(binDir, "rel", "bin")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, source := range map[string]string{
		"shuttle":        "../bin/shuttle",
		"shuttle-launch": "../bin/shuttle-launch",
	} {
		body, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(binDir, name), body, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	state := filepath.Join(root, "daemon-died")
	started := filepath.Join(root, "forced-starts")
	launcher := filepath.Join(binDir, "rel", "bin", "shuttled")
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nprintf 'start\\n' >> \"$SHUTTLE_TEST_STARTS\"\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	sleepBin, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	fakes := map[string]string{
		"felt": `#!/bin/sh
case "$*" in
  "shuttle host --json") printf '%s\n' '{"listen":"tcp://127.0.0.1:4000"}' ;;
  "shuttle host check-owner") exit 0 ;;
  *) exit 1 ;;
esac
`,
		"curl": `#!/bin/sh
case "$*" in
  *"/api/v1/version"*)
    if [ -f "$SHUTTLE_TEST_DIED" ]; then exit 22; fi
    printf '%s\n' '{"ready":false,"boot_duration_ms":10}'
    ;;
  *) exit 22 ;;
esac
`,
		"sleep": "#!/bin/sh\ncase \"${1:-}\" in\n  5) : > \"$SHUTTLE_TEST_DIED\" ;;\n  2) [ ! -f \"$SHUTTLE_TEST_STARTS\" ] || kill -TERM \"$PPID\" ;;\nesac\n" + sleepBin + " 0.05\n",
	}
	for name, body := range fakes {
		if err := os.WriteFile(filepath.Join(fakeBin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	t.Setenv("HOME", filepath.Join(root, "home"))
	t.Setenv("SHUTTLE_DIR", root)
	t.Setenv("SHUTTLE_LOG", filepath.Join(root, "shuttle.log"))
	t.Setenv("SHUTTLE_TEST_DIED", state)
	t.Setenv("SHUTTLE_TEST_STARTS", started)
	t.Setenv("PATH", fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))

	cmd := exec.Command("sh", filepath.Join(binDir, "shuttle-launch"), "--loop")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("respawn loop unexpectedly survived its test stop signal: %s", out)
	}
	if !strings.Contains(string(out), "still booting; checking again in 5s") {
		t.Fatalf("launcher did not stand down during boot: %s", out)
	}
	calls, readErr := os.ReadFile(started)
	if readErr != nil {
		t.Fatalf("launcher never restarted after the listener died: %v\n%s", readErr, out)
	}
	if got := strings.Count(string(calls), "start"); got != 1 {
		t.Fatalf("force-start count = %d, want exactly one after listener death; calls=%q", got, calls)
	}
}

func installShuttleProbeFakes(t *testing.T) string {
	t.Helper()
	fakeBin := t.TempDir()

	felt := `#!/bin/sh
case "$*" in
  "shuttle host --json") printf '%s\n' '{"listen":"tcp://127.0.0.1:4000"}' ;;
  "shuttle host check-owner") exit 0 ;;
  *) echo "unexpected felt probe: $*" >&2; exit 1 ;;
esac
`
	curl := `#!/bin/sh
case "$*" in
  *"/api/v1/version"*)
    if [ "${SHUTTLE_READY_TRUE:-0}" = 1 ]; then
      printf '%s\n' '{"ready":true,"boot_duration_ms":123}'
    else
      printf '%s\n' '{"ready":false,"boot_duration_ms":123}'
    fi
    ;;
  *"/api/v1/state"*) : > "$SHUTTLE_STATE_PROBE"; exit 22 ;;
  *) echo "unexpected curl probe: $*" >&2; exit 22 ;;
esac
`
	for name, body := range map[string]string{"felt": felt, "curl": curl} {
		if err := os.WriteFile(filepath.Join(fakeBin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return fakeBin
}
