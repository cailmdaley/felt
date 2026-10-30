package shuttlecli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestIsLiveDaemonChildProbe(t *testing.T) {
	role := os.Getenv("FELT_DAEMON_OWNER_PROBE")
	if role == "" {
		return
	}
	if role == "wrapper" {
		command := exec.Command(os.Args[0], "-test.run=^TestIsLiveDaemonChildProbe$")
		command.Env = daemonProbeEnv(os.Environ(), "inner")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("inner probe: %v\n%s", err, output)
		}
		return
	}

	env, _ := sysenvtest.FromProcess(t, map[string]string{
		"HOME":           os.Getenv("FELT_DAEMON_OWNER_HOME"),
		"SHUTTLE_LISTEN": os.Getenv("FELT_DAEMON_OWNER_LISTEN"),
	})
	want := os.Getenv("FELT_DAEMON_OWNER_EXPECTED") == "true"
	a := newApp(env)
	if got := a.isLiveDaemonChild(); got != want {
		t.Fatalf("live daemon child = %t, want %t", got, want)
	}
	frame := `{"address":"shuttle://host/claude/target","text":"daemon notice","from":"shuttle","daemon_sender":true,"message_id":"daemon-probe","wake":true}`
	request, err := a.buildMessageRequest(strings.NewReader(frame+"\n"), nil, &messageOptions{requestJSON: true})
	if want {
		if err != nil || request.From != "shuttle" || request.FromClaim != "" || request.DaemonSender {
			t.Fatalf("trusted daemon frame = %+v, err %v", request, err)
		}
	} else if err == nil || !strings.Contains(err.Error(), "requires a Shuttle daemon parent") {
		t.Fatalf("untrusted daemon frame error = %v", err)
	}
	if shuttlePath := os.Getenv("FELT_DAEMON_OWNER_SHUTTLE"); shuttlePath != "" {
		command := exec.Command(shuttlePath, "message", "--local", "--json", "--request-json")
		command.Stdin = strings.NewReader(frame + "\n")
		output, commandErr := command.CombinedOutput()
		if want {
			if strings.Contains(string(output), "requires a Shuttle daemon parent") {
				t.Fatalf("registered daemon request lost attribution at the CLI boundary: %s", output)
			}
		} else if commandErr == nil || !strings.Contains(string(output), "requires a Shuttle daemon parent") {
			t.Fatalf("untrusted CLI daemon marker: err=%v output=%s", commandErr, output)
		}
	}
}

func TestDaemonSenderRequiresLiveOwnerAncestor(t *testing.T) {
	env := testEnv(t)
	a := newApp(env)
	settings, err := a.resolveHostSettings()
	if err != nil {
		t.Fatal(err)
	}
	path, err := a.daemonOwnerPath(settings)
	if err != nil {
		t.Fatal(err)
	}
	unlock, err := a.claimDaemonOwner(settings, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	shuttlePath := filepath.Join(t.TempDir(), "shuttle")
	build := exec.Command("go", "build", "-o", shuttlePath, "./cmd/shuttle")
	build.Dir = filepath.Clean(filepath.Join("..", ".."))
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build shuttle CLI: %v\n%s", err, output)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var owner daemonOwner
	if err := json.Unmarshal(data, &owner); err != nil {
		t.Fatal(err)
	}
	probe := func(want bool) {
		t.Helper()
		command := exec.Command(os.Args[0], "-test.run=^TestIsLiveDaemonChildProbe$")
		command.Env = daemonProbeEnv(os.Environ(), "wrapper", map[bool]string{true: "true", false: "false"}[want], env.Getenv("HOME"), settings.Listen, shuttlePath)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("daemon child probe want=%t: %v\n%s", want, err, output)
		}
	}

	probe(true)
	other := exec.Command("sleep", "30")
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = other.Process.Kill()
		_ = other.Wait()
	}()
	otherBirth, err := processBirth(env, other.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	writeOwner := func(record daemonOwner) {
		t.Helper()
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	writeOwner(daemonOwner{PID: other.Process.Pid, Birth: otherBirth})
	probe(false)
	writeOwner(daemonOwner{PID: owner.PID, Birth: "stale-start-token"})
	probe(false)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	probe(false)
}

func daemonProbeEnv(environment []string, values ...string) []string {
	keys := []string{"FELT_DAEMON_OWNER_PROBE", "FELT_DAEMON_OWNER_EXPECTED", "FELT_DAEMON_OWNER_HOME", "FELT_DAEMON_OWNER_LISTEN", "FELT_DAEMON_OWNER_SHUTTLE"}
	for _, key := range keys {
		prefix := key + "="
		filtered := environment[:0]
		for _, value := range environment {
			if !strings.HasPrefix(value, prefix) {
				filtered = append(filtered, value)
			}
		}
		environment = filtered
	}
	if len(values) > 0 {
		environment = append(environment, "FELT_DAEMON_OWNER_PROBE="+values[0])
	}
	if len(values) > 1 {
		environment = append(environment, "FELT_DAEMON_OWNER_EXPECTED="+values[1])
	}
	if len(values) > 2 {
		environment = append(environment, "FELT_DAEMON_OWNER_HOME="+values[2])
	}
	if len(values) > 3 {
		environment = append(environment, "FELT_DAEMON_OWNER_LISTEN="+values[3])
	}
	if len(values) > 4 {
		environment = append(environment, "FELT_DAEMON_OWNER_SHUTTLE="+values[4])
	}
	return environment
}

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
