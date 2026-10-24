package shuttlecli

import (
	"bufio"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSupervisorReinstallVerifiesTargetListener(t *testing.T) {
	for _, tc := range []struct {
		name              string
		manager, listener string
		reachable, want   bool
	}{
		{"matching supervisor", "12345", "12345", true, true},
		{"other supervisor", "23456", "", true, false},
		{"unreachable manager", "12345", "12345", false, false},
		{"stale enabled supervisor", "0", "", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnv(t)
			home, _ := env.UserHomeDir()
			bin := t.TempDir()
			write := func(path, source string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(source), 0755); err != nil {
					t.Fatal(err)
				}
			}
			write(filepath.Join(bin, "tmux"), "#!/bin/sh\nexit 1\n")
			serviceData := filepath.Join(home, "service-data")
			callerData := filepath.Join(home, "caller-data")
			env.Set("SHUTTLE_DATA_DIR", callerData)
			pidFile := filepath.Join(bin, "mainpid")
			t.Cleanup(func() {
				if data, err := os.ReadFile(pidFile); err == nil {
					pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
					if pid > 0 {
						_ = syscall.Kill(pid, syscall.SIGKILL)
					}
				}
			})
			write(filepath.Join(bin, "lsof"), "#!/bin/sh\n[ -n '"+tc.listener+"' ] || exit 1\necho '"+tc.listener+"'\n")
			env.Set("PATH", bin+":"+env.Getenv("PATH"))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"ready":true}`) }))
			defer server.Close()
			// Caller-only overrides must not select the installed service's claim.
			env.Set("SHUTTLE_LISTEN", "tcp://127.0.0.1:1")
			address := strings.TrimPrefix(server.URL, "http://")
			gate := filepath.Join(bin, "child-gate")
			child := fmt.Sprintf("( while [ ! -f %q ]; do sleep 0.01; done; exec env SHUTTLE_TEST_OWNER_HELPER=service SHUTTLE_TEST_OWNER_HOME=%q SHUTTLE_TEST_OWNER_ADDRESS=%q %q -test.run=^TestDaemonOwnerHelper$ ) </dev/null >%q 2>&1 &\necho $! >%q\n", gate, home, address, os.Args[0], filepath.Join(bin, "child.log"), pidFile)
			mainPID := fmt.Sprintf("cat %q 2>/dev/null || echo %s", pidFile, tc.manager)
			managerCode := fmt.Sprintf("#!/bin/sh\ncase \"$*\" in *show-environment*) %s;; *MainPID*) %s;; *restart*) %s;; *) exit 0;; esac\n", map[bool]string{true: "echo SHUTTLE_DATA_DIR=" + serviceData, false: "exit 1"}[tc.reachable], mainPID, child)
			write(filepath.Join(bin, "systemctl"), managerCode)
			write(filepath.Join(bin, "launchctl"), "#!/bin/sh\ncase \"$1\" in print) printf 'pid = '; "+mainPID+";; load) "+child+";; getenv) [ \"$2\" != SHUTTLE_DATA_DIR ] || echo '"+serviceData+"';; *) exit 0;; esac\n")
			release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
			osName := supervisorOS(runtime.GOOS)
			name := "io.shuttle.daemon.service.template"
			if osName == "Darwin" {
				name = "io.shuttle.daemon.plist.template"
			}
			source, err := os.ReadFile(filepath.Join("../../daemon/share", name))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Join(release.Dir, "share"), 0755); err != nil {
				t.Fatal(err)
			}
			write(filepath.Join(release.Dir, "share", name), string(source))
			env.Set("SHUTTLE_RELEASE", release.Dir)
			// A real unrelated foreground process has the same release identity
			// that stopDaemonRelease's release-wide pgrep would select.
			otherPath := filepath.Join(release.Dir, "releases", "other", "start")
			if err := os.MkdirAll(filepath.Dir(otherPath), 0755); err != nil {
				t.Fatal(err)
			}
			write(otherPath, "#!/bin/sh\necho READY\nread token\n")
			other := env.Command(otherPath)
			otherIn, e := other.StdinPipe()
			if e != nil {
				t.Fatal(e)
			}
			otherOut, e := other.StdoutPipe()
			if e != nil {
				t.Fatal(e)
			}
			if e := other.Start(); e != nil {
				t.Fatal(e)
			}
			ready, e := bufio.NewReader(otherOut).ReadString('\n')
			if e != nil || ready != "READY\n" {
				t.Fatalf("unrelated process readiness: %q %v", ready, e)
			}
			otherDone := make(chan error, 1)
			go func() { otherDone <- other.Wait() }()
			t.Cleanup(func() {
				_ = otherIn.Close()
				_ = other.Process.Kill()
				select {
				case <-otherDone:
				case <-time.After(5 * time.Second):
					t.Error("unrelated process cleanup timed out")
				}
			})
			a := newApp(env)
			options := supervisorOptions{OS: osName, Label: defaultDaemonLabel, Port: strings.TrimPrefix(address, "127.0.0.1:"), Path: env.Getenv("PATH"), Log: filepath.Join(home, "daemon.log"), Stores: "test-store", TmuxTmpdirSet: true, SSHSocketSet: true}
			// Darwin has no systemd reachability probe; exercise that separately.
			want := tc.want || (osName == "Darwin" && tc.name == "unreachable manager")
			if want {
				awaiting := make(chan struct{}, 1)
				a.daemonPause = func(time.Duration) {
					select {
					case awaiting <- struct{}{}:
					default:
					}
					time.Sleep(time.Millisecond)
				}
				result := make(chan error, 1)
				go func() { result <- a.installDaemonSupervisor(options) }()
				select {
				case <-awaiting:
				case early := <-result:
					t.Fatalf("installer returned before child handoff: %v", early)
				case <-time.After(30 * time.Second):
					t.Fatal("installer never reached handoff wait")
				}
				settings, e := a.supervisorHostSettings(options)
				if e != nil {
					t.Fatal(e)
				}
				if release, e := a.claimDaemonOwner(settings, 0, nil); e == nil {
					release()
					t.Fatal("installer released its claim while child was paused")
				}
				write(gate, "ready")
				select {
				case err = <-result:
				case <-time.After(35 * time.Second):
					t.Fatal("handoff did not finish")
				}
			} else {
				err = a.installDaemonSupervisor(options)
			}
			if (err == nil) != want {
				t.Fatalf("install error=%v, want success=%t", err, want)
			}
			if !want && (err == nil || (!strings.Contains(err.Error(), "outside the target supervisor") && !strings.Contains(err.Error(), "manager is unavailable"))) {
				t.Fatalf("conflict was not refused: %v", err)
			}
			select {
			case stopped := <-otherDone:
				otherDone <- stopped
				t.Fatalf("refresh stopped unrelated same-release process: %v", stopped)
			default:
			}
			if want {
				if _, e := os.Stat(filepath.Join(serviceData, "heartbeat.stopped")); e != nil {
					t.Fatalf("target service stop marker missing: %v", e)
				}
				if _, e := os.Stat(filepath.Join(callerData, "heartbeat.stopped")); !os.IsNotExist(e) {
					t.Fatalf("caller data directory was marked: %v", e)
				}
				unit := filepath.Join(home, ".config", "systemd", "user", "shuttle-daemon.service")
				if osName == "Darwin" {
					unit = filepath.Join(home, "Library", "LaunchAgents", defaultDaemonLabel+".plist")
				}
				if _, err := os.Stat(unit); err != nil {
					t.Fatalf("refresh did not install supervisor: %v", err)
				}
			}
			if !tc.reachable {
				if pid := a.supervisorMainPID(supervisorOptions{OS: "Linux", Label: defaultDaemonLabel}); pid != 0 {
					t.Fatalf("unreachable user manager trusted: pid=%d", pid)
				}
			}
		})
	}
}

func TestRespawnLoopRejectsMarkerInUnrelatedArgv(t *testing.T) {
	env := testEnv(t)
	home, _ := env.UserHomeDir()
	bin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(bin, 0755); err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(bin, "shuttle-launch")
	if err := os.WriteFile(launcher, source, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "tmux"), []byte("#!/bin/sh\necho 12345\n"), 0755); err != nil {
		t.Fatal(err)
	}
	ps := filepath.Join(bin, "ps")
	env.Set("PATH", bin+":"+env.Getenv("PATH"))
	for _, argv := range []string{
		"/bin/sh -c echo " + launcher + " --loop SHUTTLE_RESPAWN_LOOP=1",
		"/bin/sh " + launcher + " --loop --other SHUTTLE_RESPAWN_LOOP=1",
		"/bin/sh /somewhere/else/shuttle-launch --loop SHUTTLE_RESPAWN_LOOP=1",
	} {
		if err := os.WriteFile(ps, []byte("#!/bin/sh\nprintf '%s\\n' '"+argv+"'\n"), 0755); err != nil {
			t.Fatal(err)
		}
		if daemonRespawnLoopPresent(env) {
			t.Fatalf("unrelated process accepted: %s", argv)
		}
	}
}
