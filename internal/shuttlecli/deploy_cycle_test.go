package shuttlecli

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestDeployCycleListenerChild is the real HTTP process launched by the real
// shuttle-launch respawn loop in TestRemoteDeployRestartsInactiveSystemdUnit.
func TestDeployCycleListenerChild(t *testing.T) {
	port := os.Getenv("SHUTTLE_CYCLE_CHILD_PORT")
	pidFile := os.Getenv("SHUTTLE_CYCLE_CHILD_PID_FILE")
	if port == "" || pidFile == "" {
		return
	}
	if err := os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
		return
	}
	server := &http.Server{Addr: "127.0.0.1:" + port, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "alive") })}
	_ = server.ListenAndServe()
}

func TestRemoteDeployRestartsInactiveSystemdUnit(t *testing.T) {
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("real tmux is required")
	}
	script, err := os.ReadFile("../../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	root := shortPrivateTempDir(t)
	home := filepath.Join(root, "home")
	bin := filepath.Join(home, ".local", "bin")
	data := filepath.Join(home, ".shuttle")
	for _, dir := range []string{bin, data, filepath.Join(home, ".config", "systemd", "user")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	unit, err := os.ReadFile("../../daemon/share/io.shuttle.daemon.service.template")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".config", "systemd", "user", "shuttle-daemon.service"), unit, 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := netListenLoopback()
	if err != nil {
		t.Fatal(err)
	}
	port := listener
	pidFile := filepath.Join(root, "listener.pid")
	socket := filepath.Join(root, "tmux.sock")
	write := func(path, body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0755); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(bin, "tmux"), "#!/bin/sh\nexec '"+tmux+"' -S '"+socket+"' \"$@\"\n")
	write(filepath.Join(bin, "systemctl"), "#!/bin/sh\ncase \"$*\" in *show-environment*) exit 0;; *is-active*|*is-enabled*) [ \"${SHUTTLE_TEST_ACTIVE:-0}\" = 1 ] && exit 0 || exit 3;; *) exit 0;; esac\n")
	write(filepath.Join(bin, "launchctl"), "#!/bin/sh\nexit 1\n")
	write(filepath.Join(bin, "felt"), "#!/bin/sh\nexit 0\n")
	write(filepath.Join(bin, "shuttle"), "#!/bin/sh\ncase \"$*\" in 'daemon loop-present') exit 1;; 'daemon status') curl -fsS --max-time 1 http://127.0.0.1:"+port+"/health >/dev/null || exit 1; echo '{\"ready\":true}';; 'daemon start --force') '"+os.Args[0]+"' -test.run=^TestDeployCycleListenerChild$ >/dev/null 2>&1 & exit 0;; 'host --json') printf '{\"data_dir\":\"%s\",\"listen\":\"tcp://127.0.0.1:%s\"}\\n' '"+data+"' '"+port+"';; *) exit 2;; esac\n")
	launcher, err := os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "shuttle-launch"), launcher, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "shuttle-launch"), launcher, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "bin", "rel", "bin"), 0755); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(root, "bin", "rel", "bin", "shuttled"), "#!/bin/sh\nexit 0\n")
	startLoop := exec.Command("/usr/bin/env", "HOME="+home, "PATH="+bin+":"+os.Getenv("PATH"), "SHUTTLE_DIR="+root, "SHUTTLE_DATA_DIR="+data, "SHUTTLE_PORT="+port, "SHUTTLE_CYCLE_CHILD_PORT="+port, "SHUTTLE_CYCLE_CHILD_PID_FILE="+pidFile, filepath.Join(bin, "shuttle-launch"), "--tmux")
	if out, err := startLoop.CombinedOutput(); err != nil {
		t.Fatalf("start real tmux loop: %v\n%s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command(tmux, "-S", socket, "kill-server").Run() })
	env := []string{"HOME=" + home, "PATH=" + bin + ":" + os.Getenv("PATH"), "SHUTTLE_DIR=" + root, "SHUTTLE_DATA_DIR=" + data, "SHUTTLE_PORT=" + port, "SHUTTLE_CYCLE_CHILD_PORT=" + port, "SHUTTLE_CYCLE_CHILD_PID_FILE=" + pidFile}
	waitHealthy := func(want bool) int {
		t.Helper()
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			response, err := http.Get("http://127.0.0.1:" + port + "/health")
			if err == nil {
				response.Body.Close()
				if want {
					return processListeningPID(t, pidFile)
				}
			}
			if !want && err != nil {
				return 0
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("listener healthy=%t timed out", want)
		return 0
	}
	firstPID := waitHealthy(true)
	// Let the loop finish its start turn and enter the healthy-listener poll wait.
	time.Sleep(3 * time.Second)

	// Run deploy's actual remote host cycle function in dash. Its probe sees a
	// reachable manager and a matching current-format inactive unit; it must
	// select the tmux loop and cycle the listener through that loop.
	probe := shellFunction(t, string(script), "supervisor_probe_cmd")
	cycle := shellFunction(t, string(script), "remote_host_cycle")
	harness := shellFunction(t, string(script), "shell_quote") + shellFunction(t, string(script), "listen_prelude") + shellFunction(t, string(script), "daemon_kill") + shellFunction(t, string(script), "respawn_launcher_restart_cmd") + probe + cycle + `run_on() { /bin/dash -c "$2"; }
bad() { echo "$*" >&2; }
remote_host_cycle remote "$SHUTTLE_DIR"
`
	cmd := exec.Command("/bin/dash", "-c", harness)
	cmd.Env = append(os.Environ(), env...)
	cmd.Env = append(cmd.Env, "SHUTTLE_TEST_ACTIVE=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("deploy cycle: %v\n%s", err, out)
	}
	secondPID := waitHealthy(true)
	if firstPID == secondPID {
		t.Fatalf("listener PID stayed %d: deploy did not kill and respawn it", firstPID)
	}
	if got := strings.TrimSpace(string(mustOutput(t, tmux, "-S", socket, "list-sessions", "-F", "#{session_name}"))); got != "shuttle-daemon" {
		t.Fatalf("real tmux session = %q", got)
	}
}

func netListenLoopback() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return strconv.Itoa(port), nil
}

func processListeningPID(t *testing.T, pidFile string) int {
	t.Helper()
	out, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("listener PID file: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatalf("listener PID output %q: %v", out, err)
	}
	return pid
}

func mustOutput(t *testing.T, name string, args ...string) []byte {
	t.Helper()
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		t.Fatalf("%s %v: %v", name, args, err)
	}
	return out
}
