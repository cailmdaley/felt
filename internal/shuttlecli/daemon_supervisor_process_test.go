//go:build darwin || linux

package shuttlecli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// Mutation: remove the live-owner rejection in claimDaemonOwner. Both real
// contenders then enter the protected pre-listen window.
func TestDaemonOwnerHelper(t *testing.T) {
	mode := os.Getenv("SHUTTLE_TEST_OWNER_HELPER")
	if mode == "" {
		return
	}
	env := sysenv.OS().Clone()
	env.Set("HOME", os.Getenv("SHUTTLE_TEST_OWNER_HOME"))
	a := newApp(env)
	address := os.Getenv("SHUTTLE_TEST_OWNER_ADDRESS")
	if address == "" {
		address = "127.0.0.1:49999"
	}
	settings := hostSettings{listen: listenAddr{Network: "tcp", Address: address}}
	var installing *supervisorOptions
	if mode == "install" {
		installing = &supervisorOptions{OS: "Linux", Label: defaultDaemonLabel}
	}
	// All subprocesses wait for the parent to release the same launch barrier.
	fmt.Println("WAITING")
	input := bufio.NewReader(os.Stdin)
	_, _ = input.ReadString('\n')
	release, err := a.claimDaemonOwner(settings, 0, installing)
	if err != nil {
		fmt.Println("REFUSED:", err)
		os.Exit(3)
	}
	defer release()
	if mode == "exec" {
		// The claim must remain live after the CLI becomes the release process,
		// even though the release closes every non-standard file descriptor.
		if err := syscall.Exec("/bin/sh", []string{"/bin/sh", "-c", "printf 'EXECUTED\\n'; cat >/dev/null"}, env.Environ()); err != nil {
			panic(err)
		}
	}
	fmt.Println("CLAIMED")
	if mode == "service" {
		time.Sleep(60 * time.Second)
		return
	}
	_, _ = input.ReadString('\n')
}

type ownerHelper struct {
	cmd   *exec.Cmd
	in    io.WriteCloser
	lines *bufio.Reader
}

func startOwnerHelper(t *testing.T, home, mode, path string) ownerHelper {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDaemonOwnerHelper$")
	cmd.Env = append(os.Environ(), "SHUTTLE_TEST_OWNER_HOME="+home, "SHUTTLE_TEST_OWNER_HELPER="+mode)
	if path != "" {
		cmd.Env = append(cmd.Env, "PATH="+path)
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { in.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() })
	h := ownerHelper{cmd: cmd, in: in, lines: bufio.NewReader(out)}
	if line := ownerLine(t, h); line != "WAITING" {
		t.Fatalf("helper readiness: %q", line)
	}
	return h
}
func ownerLine(t *testing.T, h ownerHelper) string {
	t.Helper()
	line, err := h.lines.ReadString('\n')
	if err != nil {
		t.Fatalf("helper output: %v (%q)", err, line)
	}
	return strings.TrimSpace(line)
}
func TestDaemonOwnerConcurrentProcessesAndExecLifetime(t *testing.T) {
	home := t.TempDir()
	a := startOwnerHelper(t, home, "exec", "")
	b := startOwnerHelper(t, home, "exec", "")
	// Both children are alive and ready before either attempts its atomic claim.
	fmt.Fprintln(a.in, "GO")
	fmt.Fprintln(b.in, "GO")
	al, bl := ownerLine(t, a), ownerLine(t, b)
	if !((al == "EXECUTED" && strings.HasPrefix(bl, "REFUSED:")) || (bl == "EXECUTED" && strings.HasPrefix(al, "REFUSED:"))) {
		t.Fatalf("concurrent starts: %q / %q", al, bl)
	}
	// An installer cannot race the winner while the release is still pre-listen.
	c := startOwnerHelper(t, home, "install", "")
	fmt.Fprintln(c.in, "GO")
	if line := ownerLine(t, c); !strings.HasPrefix(line, "REFUSED:") {
		t.Fatalf("installer entered pre-listen window: %s", line)
	}
	winner := a
	if bl == "EXECUTED" {
		winner = b
	}
	_ = winner.in.Close()
	if err := winner.cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	// A dead claim is recoverable; no permanent stale PID lock remains.
	d := startOwnerHelper(t, home, "exec", "")
	fmt.Fprintln(d.in, "GO")
	if line := ownerLine(t, d); line != "EXECUTED" {
		t.Fatalf("dead claim recovery: %s", line)
	}
}

func TestDaemonOwnerInstallerHandoffToManagerChild(t *testing.T) {
	home := t.TempDir()
	installer := startOwnerHelper(t, home, "install", "")
	fmt.Fprintln(installer.in, "GO")
	if line := ownerLine(t, installer); line != "CLAIMED" {
		t.Fatal(line)
	}
	unrelated := startOwnerHelper(t, home, "exec", "")
	fmt.Fprintln(unrelated.in, "GO")
	if line := ownerLine(t, unrelated); !strings.HasPrefix(line, "REFUSED:") {
		t.Fatal(line)
	}
	bin := t.TempDir()
	// Emulate a manager reporting the calling child's actual PID as MainPID.
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte("#!/bin/sh\ncase \"$*\" in *show-environment*) exit 0;; *MainPID*) echo \"$PPID\";; *) exit 1;; esac\n"), 0755); err != nil {
		t.Fatal(err)
	}
	child := startOwnerHelper(t, home, "exec", bin+":"+os.Getenv("PATH"))
	fmt.Fprintln(child.in, "GO")
	if line := ownerLine(t, child); line != "EXECUTED" {
		t.Fatalf("manager child self-blocked: %s", line)
	}
	// Installer cleanup must not release the child's replacement claim.
	fmt.Fprintln(installer.in, "EXIT")
	if err := installer.cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	contender := startOwnerHelper(t, home, "exec", "")
	fmt.Fprintln(contender.in, "GO")
	if line := ownerLine(t, contender); !strings.HasPrefix(line, "REFUSED:") {
		t.Fatalf("installer erased child ownership: %s", line)
	}
}

// Mutation: move the marker assignment from the tmux command into the script.
// Linux ps eww will no longer expose it, and this real-process test fails.
func TestRespawnLoopRealTmuxProcess(t *testing.T) {
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux unavailable")
	}
	root := shortPrivateTempDir(t)
	home := filepath.Join(root, "home")
	bin := filepath.Join(home, ".local", "bin")
	release := filepath.Join(root, "release")
	for _, dir := range []string{bin, filepath.Join(release, "bin")} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	socket := filepath.Join(root, "tmux.sock")
	write := func(path, source string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(source), 0755); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(bin, "tmux"), "#!/bin/sh\nexec '"+tmux+"' -S '"+socket+"' \"$@\"\n")
	write(filepath.Join(bin, "systemctl"), "#!/bin/sh\nexit 1\n")
	write(filepath.Join(bin, "launchctl"), "#!/bin/sh\nexit 1\n")
	write(filepath.Join(release, "bin", "shuttled"), "#!/bin/sh\nexit 0\n")
	write(filepath.Join(bin, "shuttle"), "#!/bin/sh\ncase \"$*\" in 'daemon status') tmux wait-for -S loop-ready; echo '{\"ready\":true}';; 'host --json') echo '{}';; *) exit 1;; esac\n")
	source, err := os.ReadFile("../../bin/shuttle-launch")
	if err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(bin, "shuttle-launch")
	write(launcher, string(source))
	env := testEnv(t)
	env.Set("HOME", home)
	env.Set("SHUTTLE_DIR", release)
	env.Set("PATH", bin+":"+os.Getenv("PATH"))
	t.Cleanup(func() { _ = exec.Command(tmux, "-S", socket, "kill-server").Run() })
	cmd := env.Command(launcher)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("launcher: %v\n%s", err, out)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, tmux, "-S", socket, "wait-for", "loop-ready").CombinedOutput(); err != nil {
		t.Fatalf("loop readiness: %v %s", err, out)
	}
	pids, err := exec.Command(tmux, "-S", socket, "list-panes", "-t", "shuttle-daemon", "-F", "#{pane_pid}").Output()
	if err != nil {
		t.Fatal(err)
	}
	ps, err := exec.Command("ps", "eww", "-p", strings.TrimSpace(string(pids)), "-o", "command=").Output()
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "linux" && !strings.Contains(string(ps), "SHUTTLE_RESPAWN_LOOP=1") {
		t.Fatalf("marker absent from actual shell environment: %s", ps)
	}
	if !daemonRespawnLoopPresent(env) {
		t.Fatalf("real launcher was not detected: %s", ps)
	}
	// Keep the isolated server alive while replacing its last test session;
	// otherwise tmux server shutdown can race the next new-session request.
	if out, err := exec.Command(tmux, "-S", socket, "new-session", "-d", "-s", "keeper", "sleep 60").CombinedOutput(); err != nil {
		t.Fatalf("tmux keeper: %v %s", err, out)
	}
	// Legacy marker-in-shell compatibility: same exact installed script argv,
	// no marker at creation. This is recognized by path and script signature.
	_ = exec.Command(tmux, "-S", socket, "kill-session", "-t", "shuttle-daemon").Run()
	cmd = env.Command("tmux", "new-session", "-d", "-s", "shuttle-daemon", "exec env -u SHUTTLE_RESPAWN_LOOP SHUTTLE_DIR='"+release+"' '"+launcher+"' --loop")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("legacy launcher: %v %s", err, out)
	}
	if out, err := exec.CommandContext(ctx, tmux, "-S", socket, "wait-for", "loop-ready").CombinedOutput(); err != nil {
		t.Fatalf("legacy readiness: %v %s", err, out)
	}
	if !daemonRespawnLoopPresent(env) {
		t.Fatal("legacy loop not detected")
	}
}

func TestDeploySelectedTmuxDisablesCompetingSystemd(t *testing.T) {
	for _, selection := range []string{"tmux", "live-tmux"} {
		t.Run(selection, func(t *testing.T) {
			_, _, tmux, supervisor := runLauncherRestart(t, "systemd", selection)
			disabled, created := strings.Index(tmux, "disabled-before-loop"), strings.Index(tmux, "new-session")
			if disabled < 0 || created <= disabled || !strings.Contains(supervisor, "disable --now shuttle-daemon.service") || strings.Contains(supervisor, "restart") {
				t.Fatalf("selected tmux owner lost: tmux=%s supervisor=%s", tmux, supervisor)
			}
		})
	}
}
