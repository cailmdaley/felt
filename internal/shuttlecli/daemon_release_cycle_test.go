package shuttlecli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestActivationMigratesLoadedSupervisorWithoutReinstallingSettings(t *testing.T) {
	t.Parallel()
	for _, owned := range []bool{true, false} {
		t.Run(fmt.Sprint(owned), func(t *testing.T) {
			env := testEnv(t)
			home, _ := env.UserHomeDir()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"ready":true}`) }))
			defer server.Close()
			port := strings.TrimPrefix(server.URL, "http://127.0.0.1:")
			env.Set("SHUTTLE_LISTEN", "tcp://127.0.0.1:"+port)
			env.Set("TEST_EVENTS", filepath.Join(home, "events"))
			sysenvtest.FakeCommand(t, env, "tmux", "#!/bin/sh\nexit 1\n")
			lsof := "#!/bin/sh\nexit 1\n"
			if owned {
				lsof = "#!/bin/sh\necho 12345\n"
			}
			sysenvtest.FakeCommand(t, env, "lsof", lsof)
			sysenvtest.FakeCommand(t, env, "systemctl", `#!/bin/sh
case "$*" in
 *show-environment*) echo "SHUTTLE_DATA_DIR=$HOME/service-data" ;;
 *MainPID*) echo 12345 ;;
 *daemon-reload*) printf 'reload:%s\n' "$(head -n 1 "$HOME/.shuttle/repo")" >> "$TEST_EVENTS" ;;
 *restart*) printf 'restart:%s\n' "$(head -n 1 "$HOME/.shuttle/repo")" >> "$TEST_EVENTS" ;;
 *) exit 0 ;;
esac
`)
			sysenvtest.FakeCommand(t, env, "launchctl", `#!/bin/sh
case "$1" in
 print) echo 'pid = 12345' ;;
 getenv) [ "$2" != SHUTTLE_DATA_DIR ] || echo "$HOME/service-data" ;;
 unload|load) printf '%s:%s\n' "$1" "$(head -n 1 "$HOME/.shuttle/repo")" >> "$TEST_EVENTS" ;;
 *) exit 0 ;;
esac
`)
			old := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "old"))
			next := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "next"))
			if err := newApp(env).selectDaemonRelease(old); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(home, ".config", "systemd", "user", "shuttle-daemon.service")
			source := "[Service]\nExecStart=/opt/bin/shuttle daemon start\nWorkingDirectory=/old/checkout\nEnvironment=\"SHUTTLE_RELEASE=/old/release\"\nEnvironment=\"SHUTTLE_PORT=" + port + "\"\nEnvironment=\"SHUTTLE_HOST=operator-host\"\nEnvironment=\"https_proxy=http://custom-proxy\"\n"
			if runtime.GOOS == "darwin" {
				path = filepath.Join(home, "Library", "LaunchAgents", defaultDaemonLabel+".plist")
				source = `<plist><dict><key>ProgramArguments</key><array><string>/opt/bin/shuttle</string><string>daemon</string><string>start</string></array><key>WorkingDirectory</key><string>/old/checkout</string><key>EnvironmentVariables</key><dict><key>SHUTTLE_RELEASE</key><string>/old/release</string><key>SHUTTLE_PORT</key><string>` + port + `</string><key>SHUTTLE_HOST</key><string>operator-host</string><key>https_proxy</key><string>http://custom-proxy</string></dict></dict></plist>`
			}
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(source), 0640); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, 0640); err != nil {
				t.Fatal(err)
			}
			callback := `[ "$SHUTTLE_ACTIVATION_CYCLED" = 1 ] || exit 8; printf 'cycle:%s\n' "$(head -n 1 "$HOME/.shuttle/repo")" >> "$TEST_EVENTS"`
			_, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "activate-release", next.Dir, "--", "/bin/sh", "-c", callback)
			if (err == nil) != owned {
				t.Fatalf("owned=%t activation: %v %s", owned, err, stderr)
			}
			pointer, _ := os.ReadFile(filepath.Join(home, ".shuttle", "repo"))
			data, _ := os.ReadFile(path)
			events, _ := os.ReadFile(env.Getenv("TEST_EVENTS"))
			if !owned {
				if strings.TrimSpace(string(pointer)) != old.Dir || string(data) != source || len(events) != 0 {
					t.Fatalf("foreign owner was changed: pointer=%q events=%q", pointer, events)
				}
				return
			}
			expected, err := migrateReleasePins(supervisorOS(runtime.GOOS), source, home)
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != expected {
				t.Fatalf("settings changed beyond the pins:\n%s", data)
			}
			info, _ := os.Stat(path)
			if info.Mode().Perm() != 0640 {
				t.Fatal("migration changed file mode")
			}
			wantEvents := "reload:" + old.Dir + "\nrestart:" + next.Dir + "\ncycle:" + next.Dir + "\n"
			if runtime.GOOS == "darwin" {
				wantEvents = "unload:" + next.Dir + "\nload:" + next.Dir + "\ncycle:" + next.Dir + "\n"
			}
			if string(events) != wantEvents {
				t.Fatalf("selection/cycle order: %q; want %q", events, wantEvents)
			}
			// A second activation has no pin migration and does not reload the manager.
			env.Set("SHUTTLE_ACTIVATION_CYCLED", "1")
			_, stderr, err = executeIn(t, env, t.TempDir(), "daemon", "activate-release", next.Dir, "--", "/bin/sh", "-c", `[ "$SHUTTLE_ACTIVATION_CYCLED" = 0 ]`)
			if err != nil {
				t.Fatalf("second activation: %v %s", err, stderr)
			}
			again, _ := os.ReadFile(env.Getenv("TEST_EVENTS"))
			if string(again) != string(events) {
				t.Fatal("migration ran twice")
			}
		})
	}
}

func TestReleaseSelectionRecognizesCheckoutLoopAndLeavesCompetingManagerDormant(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	home, _ := env.UserHomeDir()
	env.Chdir(t.TempDir())
	env.Unset("SHUTTLE_DIR")
	root := canonicalReleasePath(t.TempDir())
	old := writeTestDaemonRelease(t, filepath.Join(root, "bin", "rel"))
	next := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "next"))
	source, err := os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(root, "bin", "shuttle-launch")
	if err := os.WriteFile(launcher, source, 0755); err != nil {
		t.Fatal(err)
	}
	if err := newApp(env).selectDaemonRelease(old); err != nil {
		t.Fatal(err)
	}
	env.Set("LOOP_ARGV", "/bin/sh "+launcher+" --loop")
	sysenvtest.FakeCommand(t, env, "tmux", "#!/bin/sh\necho 12345\n")
	sysenvtest.FakeCommand(t, env, "ps", `#!/bin/sh
case "$1" in -ww) printf '%s\n' "$LOOP_ARGV";; eww) printf '%s SHUTTLE_RESPAWN_LOOP=1\n' "$LOOP_ARGV";; *) exit 1;; esac
`)
	env.Set("TEST_EVENTS", filepath.Join(home, "manager-events"))
	for _, manager := range []string{"launchctl", "systemctl"} {
		sysenvtest.FakeCommand(t, env, manager, "#!/bin/sh\necho BAD-manager-called >> \"$TEST_EVENTS\"\nexit 0\n")
	}
	if !daemonRespawnLoopPresent(env) {
		t.Fatal("release-root pointer lost its checkout's existing loop")
	}
	path := filepath.Join(home, ".config", "systemd", "user", "shuttle-daemon.service")
	definition := "[Service]\nExecStart=/opt/bin/shuttle daemon start\nEnvironment=SHUTTLE_RELEASE=/old\nWorkingDirectory=/old\nEnvironment=https_proxy=http://p\n"
	if runtime.GOOS == "darwin" {
		path = filepath.Join(home, "Library", "LaunchAgents", defaultDaemonLabel+".plist")
		definition = `<plist><dict><key>Program</key><string>/opt/bin/shuttle</string><key>WorkingDirectory</key><string>/old</string><key>EnvironmentVariables</key><dict><key>SHUTTLE_RELEASE</key><string>/old</string><key>https_proxy</key><string>http://p</string></dict></dict></plist>`
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(definition), 0600); err != nil {
		t.Fatal(err)
	}
	if _, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "activate-release", next.Dir, "--", "/bin/sh", "-c", ":"); err != nil {
		t.Fatalf("activate: %v %s", err, stderr)
	}
	if events, err := os.ReadFile(env.Getenv("TEST_EVENTS")); !os.IsNotExist(err) {
		t.Fatalf("live loop activated a competing manager: %s %v", events, err)
	}
	data, _ := os.ReadFile(path)
	expected, err := migrateReleasePins(supervisorOS(runtime.GOOS), definition, home)
	if err != nil || string(data) != expected {
		t.Fatalf("dormant definition not migrated losslessly: %v %s", err, data)
	}
}

func TestInactiveSystemdMigrationReloadsButNeverRestartsUnit(t *testing.T) {
	t.Parallel()
	if runtime.GOOS != "linux" {
		t.Skip("systemd migration runs on Linux")
	}
	env := testEnv(t)
	home, _ := env.UserHomeDir()
	sysenvtest.FakeCommand(t, env, "tmux", "#!/bin/sh\nexit 1\n")
	env.Set("TEST_EVENTS", filepath.Join(home, "events"))
	sysenvtest.FakeCommand(t, env, "systemctl", `#!/bin/sh
case "$*" in
 *show-environment*) exit 0 ;;
 *is-active*) exit 3 ;;
 *daemon-reload*) echo reload >> "$TEST_EVENTS" ;;
 *) echo "unexpected:$*" >> "$TEST_EVENTS"; exit 9 ;;
esac
`)
	path := filepath.Join(home, ".config", "systemd", "user", "shuttle-daemon.service")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("[Service]\nExecStart=/opt/bin/shuttle daemon start\nEnvironment=SHUTTLE_RELEASE=/old/release\nWorkingDirectory=/old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	if _, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "activate-release", release.Dir, "--", "/bin/sh", "-c", ":"); err != nil {
		t.Fatalf("activate: %v %s", err, stderr)
	}
	events, _ := os.ReadFile(env.Getenv("TEST_EVENTS"))
	if string(events) != "reload\n" {
		t.Fatalf("inactive unit was not only reloaded: %s", events)
	}
}
