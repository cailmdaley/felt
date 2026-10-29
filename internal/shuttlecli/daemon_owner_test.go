package shuttlecli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDaemonOwnerBirthIgnoresCallerTimezone(t *testing.T) {
	a, b := testEnv(t), testEnv(t)
	a.Set("TZ", "Pacific/Honolulu")
	b.Set("TZ", "Europe/Paris")
	first, err := processBirth(a, os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	second, err := processBirth(b, os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("same live process changed identity across environments: %q != %q", first, second)
	}
}

func TestDaemonStartCannotBypassPrelistenClaim(t *testing.T) {
	env := testEnv(t)
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	env.Set("SHUTTLE_RELEASE", release.Dir)
	a := newApp(env)
	settings, err := a.resolveHostSettings()
	if err != nil {
		t.Fatal(err)
	}
	unlock, err := a.claimDaemonOwner(settings, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	launched := false
	a.execDaemonRelease = func(string, ...string) error { launched = true; return nil }
	_, _, err = executeApp(t, a, t.TempDir(), "daemon", "start", "--force")
	if err == nil || launched || !strings.Contains(err.Error(), "already claimed") {
		t.Fatalf("claimed pre-listen endpoint was bypassed: launched=%t err=%v", launched, err)
	}
}

func TestDaemonHandoffTimeoutStopsPendingService(t *testing.T) {
	env := testEnv(t)
	bin := t.TempDir()
	calls := filepath.Join(bin, "calls")
	source := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + calls + "'\ncase \"$*\" in *MainPID*) echo 0;; esac\n"
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte(source), 0755); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", bin+":"+env.Getenv("PATH"))
	a := newApp(env)
	settings, err := a.resolveHostSettings()
	if err != nil {
		t.Fatal(err)
	}
	options := supervisorOptions{OS: "Linux", Label: defaultDaemonLabel}
	release, err := a.claimDaemonOwner(settings, 0, &options)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	err = a.awaitDaemonOwnerHandoff(settings, options, 0*time.Second)
	if err == nil || !strings.Contains(err.Error(), "pending service stopped") {
		t.Fatalf("timeout cleanup: %v", err)
	}
	data, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "--user stop shuttle-daemon.service") || !strings.Contains(string(data), "MainPID") {
		t.Fatalf("pending child was not stopped and checked: %s", data)
	}
}

func TestSupervisorEndpointUsesManagerAndRenderedPort(t *testing.T) {
	for _, tc := range []struct{ name, managerEnv, dropins, want string }{
		{"caller override excluded", "", "", "tcp://127.0.0.1:4401"},
		{"manager listen wins", "SHUTTLE_LISTEN=tcp://127.0.0.1:4410", "", "tcp://127.0.0.1:4410"},
		{"endpoint dropin refused", "", "DropInPaths=DIR/listen.conf", ""},
		{"environment file dropin refused", "", "DropInPaths=DIR/host.conf DIR/envfile.conf", ""},
		{"unreadable dropin refused", "", "DropInPaths=DIR/missing.conf", ""},
		{"unrelated dropins kept", "", "DropInPaths=DIR/host.conf DIR/ld.conf", "tcp://127.0.0.1:4401"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			bin := t.TempDir()
			unitDir := t.TempDir()
			for name, body := range map[string]string{
				"listen.conf":  "[Service]\nEnvironment=\"SHUTTLE_LISTEN=tcp://127.0.0.1:9\"\n",
				"envfile.conf": "[Service]\nEnvironmentFile=/etc/shuttle.env\n",
				"host.conf":    "[Unit]\n# shared home\nConditionHost=builder.example.org\n",
				"ld.conf":      "[Service]\nEnvironment=\"LD_LIBRARY_PATH=/opt/lib\"\n",
			} {
				if err := os.WriteFile(filepath.Join(unitDir, name), []byte(body), 0644); err != nil {
					t.Fatal(err)
				}
			}
			tc.dropins = strings.ReplaceAll(tc.dropins, "DIR", unitDir)
			source := "#!/bin/sh\ncase \"$*\" in *DropInPaths*) echo '" + tc.dropins + "';; *show-environment*) echo '" + tc.managerEnv + "';; esac\n"
			if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte(source), 0755); err != nil {
				t.Fatal(err)
			}
			env.Set("PATH", bin+":"+env.Getenv("PATH"))
			env.Set("SHUTTLE_LISTEN", "tcp://127.0.0.1:1")
			env.Set("SHUTTLE_PORT", "2")
			got, err := newApp(env).supervisorHostSettings(supervisorOptions{OS: "Linux", Label: defaultDaemonLabel, Port: "4401"})
			if tc.want == "" {
				if err == nil {
					t.Fatal("unsafe drop-in was accepted")
				}
				return
			}
			if err != nil || got.Listen != tc.want {
				t.Fatalf("service listener=%s err=%v want %s", got.Listen, err, tc.want)
			}
		})
	}
}
