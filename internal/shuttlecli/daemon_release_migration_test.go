package shuttlecli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestReleaseMigrationPreservesEveryOtherByte(t *testing.T) {
	t.Parallel()
	for _, osName := range []string{"Darwin", "Linux"} {
		t.Run(osName, func(t *testing.T) {
			name := "io.shuttle.daemon.service.template"
			if osName == "Darwin" {
				name = "io.shuttle.daemon.plist.template"
			}
			template, err := os.ReadFile(filepath.Join("../../daemon/share", name))
			if err != nil {
				t.Fatal(err)
			}
			env := testEnv(t)
			home, _ := env.UserHomeDir()
			rendered, err := newApp(env).renderSupervisorTemplate(osName, string(template), supervisorOptions{Label: defaultDaemonLabel, ShuttleBin: "/opt/bin/shuttle", Path: "/opt/bin:/bin", Log: "/tmp/daemon.log"}, daemonRelease{})
			if err != nil {
				t.Fatal(err)
			}
			source, expected := "", ""
			if osName == "Linux" {
				extras := "Environment=\"SHUTTLE_HOST=operator-host\" 'https_proxy=http://proxy/with space'\nEnvironment=\"EXTRA=SHUTTLE_RELEASE=/keep/this/value\"\n"
				expected = rendered + extras
				source = strings.Replace(rendered, "WorkingDirectory="+systemdLiteralPath(home), "WorkingDirectory=/old/checkout", 1) + "Environment=\"SHUTTLE_RELEASE=/old/release\"\n" + extras
			} else {
				extras := "<key>SHUTTLE_HOST</key><string>operator-host</string>\n<key>https_proxy</key><string>http://proxy/?x=1&amp;y=2</string>\n<key>WorkingDirectory</key><string>verbatim-env-value</string>\n"
				expected = strings.Replace(rendered, "<key>PATH</key>", extras+"<key>PATH</key>", 1)
				source = strings.Replace(expected, "<key>PATH</key>", "<key>SHUTTLE_RELEASE</key><string>/old/release</string><key>PATH</key>", 1)
				source = strings.Replace(source, xmlEscape(home)+"</string>", "/old/checkout</string>", 1)
			}
			got, err := migrateReleasePins(osName, source, home)
			if err != nil || got != expected {
				t.Fatalf("migration changed fields besides the pins: %v\nwant:\n%s\ngot:\n%s", err, expected, got)
			}
			again, err := migrateReleasePins(osName, got, home)
			if err != nil || again != got {
				t.Fatalf("migration is not idempotent: %v", err)
			}
			if strings.Contains(got, "Environment=\"TMUX_TMPDIR=\"") || strings.Contains(got, "<key>TMUX_TMPDIR</key>") {
				t.Fatal("migration inserted an absent tmux setting")
			}
		})
	}
}

func TestWorkingDirectoryPinMigratesWithoutReleaseEnvironmentPin(t *testing.T) {
	t.Parallel()
	for _, osName := range []string{"Darwin", "Linux"} {
		env := testEnv(t)
		home, _ := env.UserHomeDir()
		source := "[Service]\nExecStart=/opt/bin/shuttle daemon start\nWorkingDirectory=/deleted/checkout\nEnvironment=\"https_proxy=http://p\"\n"
		expected := strings.Replace(source, "/deleted/checkout", systemdLiteralPath(home), 1)
		path := filepath.Join(home, ".config", "systemd", "user", "shuttle-daemon.service")
		if osName == "Darwin" {
			source = `<plist><dict><key>ProgramArguments</key><array><string>/opt/bin/shuttle</string><string>daemon</string><string>start</string></array><key>WorkingDirectory</key><string>/deleted/checkout</string><key>EnvironmentVariables</key><dict><key>https_proxy</key><string>http://p</string></dict></dict></plist>`
			expected = strings.Replace(source, "/deleted/checkout", xmlEscape(home), 1)
			path = filepath.Join(home, "Library", "LaunchAgents", defaultDaemonLabel+".plist")
		}
		got, err := migrateReleasePins(osName, source, home)
		if err != nil || got != expected {
			t.Fatalf("cwd-only %s migration: %v %s", osName, err, got)
		}
		if osName != supervisorOS(runtime.GOOS) {
			continue
		}
		sysenvtest.FakeCommand(t, env, "tmux", "#!/bin/sh\nexit 1\n")
		sysenvtest.FakeCommand(t, env, "systemctl", "#!/bin/sh\nexit 1\n")
		sysenvtest.FakeCommand(t, env, "launchctl", "#!/bin/sh\nexit 1\n")
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
		plans, err := newApp(env).planReleaseMigrations()
		if err != nil || len(plans) != 1 || string(plans[0].updated) != expected {
			t.Fatalf("cwd-only definition was not discovered: plans=%v err=%v", plans, err)
		}
	}
}

func TestSystemdMigrationHandlesSharedEnvironmentDirectives(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ input, want string }{
		{`Environment="SHUTTLE_HOST=host" "SHUTTLE_RELEASE=/old path" 'https_proxy=http://p/a b'`, `Environment="SHUTTLE_HOST=host"  'https_proxy=http://p/a b'`},
		{"Environment=SHUTTLE_RELEASE=/old\n", ""},
		{"Environment=\"SHUTTLE_RELEASE=/old\"\nEnvironment=\"SHUTTLE_HOST=after\"\n", "Environment=\"SHUTTLE_HOST=after\"\n"},
		{`Environment="OTHER=SHUTTLE_RELEASE=/not-a-pin"`, `Environment="OTHER=SHUTTLE_RELEASE=/not-a-pin"`},
		{"Environment=\n", "Environment=\n"},
		{" Environment = \"SHUTTLE_RELEASE=/old\" \"https_proxy=http://p\"\n", " Environment =  \"https_proxy=http://p\"\n"},
		{"Environment=\"\"\n", "Environment=\"\"\n"},
		{"Environment=SHUTTLE_HOST=host \\\nWorkingDirectory=/verbatim/env/value\n", "Environment=SHUTTLE_HOST=host \\\nWorkingDirectory=/verbatim/env/value\n"},
		{"Environment=\"SHUTTLE_HOST=host\" \\\n \"SHUTTLE_RELEASE=/old\" \\\n \"https_proxy=http://p\"\n", "Environment=\"SHUTTLE_HOST=host\" \\\n  \\\n \"https_proxy=http://p\"\n"},
	} {
		got, err := migrateReleasePins("Linux", tc.input, "/home/test")
		if err != nil || got != tc.want {
			t.Errorf("%q => %q, %v; want %q", tc.input, got, err, tc.want)
		}
	}
}

func TestSupervisorEnvironmentReadsMultipleAndContinuedAssignments(t *testing.T) {
	t.Parallel()
	source := "Environment=DROP=old\nEnvironment=\n Environment = \"SHUTTLE_HOST=operator-host\" \\\n 'SHUTTLE_PORT=4401' \\\n \"https_proxy=http://proxy/with space\"\n"
	values, err := supervisorEnvironment("Linux", source)
	if err != nil || len(values) != 3 || values["SHUTTLE_HOST"] != "operator-host" || values["SHUTTLE_PORT"] != "4401" || values["https_proxy"] != "http://proxy/with space" {
		t.Fatalf("continued environment: %v %v", values, err)
	}
}

func TestActivationMigratesOnceAndRollsBackOnFailure(t *testing.T) {
	t.Parallel()
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			env := testEnv(t)
			home, _ := env.UserHomeDir()
			sysenvtest.FakeCommand(t, env, "tmux", "#!/bin/sh\nexit 1\n")
			sysenvtest.FakeCommand(t, env, "launchctl", "#!/bin/sh\nexit 1\n")
			sysenvtest.FakeCommand(t, env, "systemctl", "#!/bin/sh\nexit 1\n")
			old := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "old"))
			next := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "next"))
			if err := newApp(env).selectDaemonRelease(old); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(home, ".config", "systemd", "user", "shuttle-daemon.service")
			source := "[Service]\nExecStart=/opt/bin/shuttle daemon start\nWorkingDirectory=/old/checkout\nEnvironment=\"SHUTTLE_RELEASE=/old/release\"\nEnvironment=\"SHUTTLE_HOST=operator-host\"\nEnvironment=\"https_proxy=http://p\"\n"
			if runtime.GOOS == "darwin" {
				path = filepath.Join(home, "Library", "LaunchAgents", defaultDaemonLabel+".plist")
				source = `<plist><dict><key>Program</key><string>/opt/bin/shuttle</string><key>WorkingDirectory</key><string>/old/checkout</string><key>EnvironmentVariables</key><dict><key>SHUTTLE_RELEASE</key><string>/old/release</string><key>SHUTTLE_HOST</key><string>operator-host</string><key>https_proxy</key><string>http://p</string></dict></dict></plist>`
			}
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(source), 0600); err != nil {
				t.Fatal(err)
			}
			env.Set("EXPECTED_SELECTION", next.Dir)
			callback := `[ "$(head -n 1 "$HOME/.shuttle/repo")" = "$EXPECTED_SELECTION" ] || exit 9`
			if fail {
				callback += "; exit 7"
			}
			_, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "activate-release", next.Dir, "--", "/bin/sh", "-c", callback)
			if (err != nil) != fail {
				t.Fatalf("activation: %v %s", err, stderr)
			}
			pointer, _ := os.ReadFile(filepath.Join(home, ".shuttle", "repo"))
			want := next.Dir
			if fail {
				want = old.Dir
			}
			if strings.TrimSpace(string(pointer)) != want {
				t.Fatalf("selection %q, want %q", pointer, want)
			}
			data, _ := os.ReadFile(path)
			expected := source
			if !fail {
				expected, err = migrateReleasePins(supervisorOS(runtime.GOOS), source, home)
				if err != nil {
					t.Fatal(err)
				}
			}
			if string(data) != expected {
				t.Fatalf("definition differs:\n%s", data)
			}
			// Invalid targets and commands are rejected before touching either file.
			for _, args := range [][]string{{"daemon", "activate-release", "/missing/release", "--", "/bin/sh", "-c", ":"}, {"daemon", "activate-release", next.Dir, "--", "/missing/command"}} {
				if _, _, err := executeIn(t, env, t.TempDir(), args...); err == nil {
					t.Fatal("invalid activation succeeded")
				}
				unchanged, _ := os.ReadFile(filepath.Join(home, ".shuttle", "repo"))
				if string(unchanged) != string(pointer) {
					t.Fatal("preflight failure changed selection")
				}
			}
		})
	}
}

func TestWorktreeScopedStopRefusesForeignOrUnreportedRelease(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	for _, path := range []string{"/production/bin/rel", "", filepath.Join(root, "bin", "rel")} {
		t.Run(path, func(t *testing.T) {
			env := testEnv(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprintf(w, `{"release_path":%q}`, path) }))
			defer server.Close()
			env.Set("SHUTTLE_LISTEN", "tcp://"+strings.TrimPrefix(server.URL, "http://"))
			a := newApp(env)
			settings, err := a.resolveHostSettings()
			if err != nil {
				t.Fatal(err)
			}
			ownerPath, err := a.daemonOwnerPath(settings)
			if err != nil {
				t.Fatal(err)
			}
			birth, err := processBirth(env, os.Getpid())
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(ownerPath), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(ownerPath, []byte(fmt.Sprintf(`{"pid":%d,"birth":%q}`, os.Getpid(), birth)), 0600); err != nil {
				t.Fatal(err)
			}
			signals := 0
			a.daemonSignalPID = func(int, syscall.Signal) error { signals++; return nil }
			a.daemonPause = func(time.Duration) {}
			_, _, err = executeApp(t, a, t.TempDir(), "daemon", "stop", "--within", root)
			inside := path != "" && releasePathWithin(root, path)
			if (err == nil) != inside || (!inside && signals != 0) || (inside && signals != 2) {
				t.Fatalf("stop release %q: err=%v signals=%d", path, err, signals)
			}
		})
	}
}
