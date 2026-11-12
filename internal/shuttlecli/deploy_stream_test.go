package shuttlecli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDeployWaitingAttemptPreservesOwnersLog(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	defer fleetTouch(t, f.gate)
	first, log := f.start(t, "log-owner")
	deployAwait(t, "owner build: "+log, func() bool { return strings.Contains(fleetRead(f.events), "build ") })
	path := filepath.Join(f.home, ".shuttle/deploy/last-run.log")
	before, e := os.Stat(path)
	if e != nil {
		t.Fatal(e)
	}
	waiter, waitLog := f.start(t, "log-waiter")
	deployAwait(t, "waiter: "+waitLog, func() bool { return strings.Contains(fleetRead(waitLog), "waiting for") })
	after, e := os.Stat(path)
	if e != nil {
		t.Fatal(e)
	}
	if !os.SameFile(before, after) || !strings.Contains(fleetRead(path), "build/install CLIs") {
		t.Fatal("waiting attempt overwrote the held transaction's diagnostics")
	}
	waiter.Process.Kill()
	waiter.Wait()
	fleetTouch(t, f.gate)
	if e := first.Wait(); e != nil {
		t.Fatalf("owner: %v %s", e, fleetRead(log))
	}
}

func TestDeployStoppedObserverCannotLeaveRollbackWaiter(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	if e := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("new target\n"), 0600); e != nil {
		t.Fatal(e)
	}
	f.git(t, f.repo, "add", "tracked")
	f.git(t, f.repo, "commit", "-m", "new target")
	newSHA := f.git(t, f.repo, "rev-parse", "HEAD")
	f.git(t, f.repo, "push", "origin", "main")
	first, firstLog := f.start(t, "heartbeat-holder")
	defer func() { fleetTouch(t, f.gate); first.Wait() }()
	deployAwait(t, "holder build: "+firstLog, func() bool { return strings.Contains(fleetRead(f.events), "build ") })
	waiter, log := f.startArgs(t, "stopped-rollback", "fake", []string{"--ref", f.sha}, fmt.Sprintf("SHUTTLE_DEPLOY_DEADLINE=%d", time.Now().Add(180*time.Second).Unix()))
	deployAwait(t, "rollback waiter: "+log, func() bool { return strings.Contains(fleetRead(log), "waiting for") })
	var observer int
	for _, line := range strings.Split(fleetRead(log), "\n") {
		if strings.HasPrefix(line, "deploy-lock: transaction pgid=") {
			fmt.Sscanf(line, "deploy-lock: transaction pgid=%d", &observer)
			break
		}
	}
	remote, _ := strconv.Atoi(strings.TrimSpace(fleetRead(filepath.Join(f.root, "remote.pid"))))
	if observer <= 0 || remote <= 0 {
		t.Fatal("missing observer/remote identity")
	}
	defer func() { syscall.Kill(observer, syscall.SIGKILL); waiter.Process.Kill(); waiter.Wait() }()
	if e := syscall.Kill(observer, syscall.SIGSTOP); e != nil {
		t.Fatal(e)
	}
	until := time.Now().Add(75 * time.Second)
	for syscall.Kill(remote, 0) == nil && time.Now().Before(until) {
		time.Sleep(100 * time.Millisecond)
	}
	if syscall.Kill(remote, 0) == nil {
		t.Fatal("stopped observer left a live rollback waiter despite silent transport")
	}
	syscall.Kill(observer, syscall.SIGCONT)
	if e := waiter.Wait(); e == nil {
		t.Fatalf("stopped observer reported success: %s", fleetRead(log))
	}
	fleetTouch(t, f.gate)
	if e := first.Wait(); e != nil {
		t.Fatalf("holder: %v %s", e, fleetRead(firstLog))
	}
	if !strings.Contains(fleetRead(f.state), newSHA) || strings.Count(fleetRead(f.events), "cycle\n") != 1 {
		t.Fatalf("abandoned waiter rolled back: %s %s", fleetRead(f.state), fleetRead(f.events))
	}
}

func TestDeployLoggerDoesNotWaitForEscapedWriters(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"background-profile", "real-tmux"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			f := newDeployFleet(t)
			runner, e := os.ReadFile("../../scripts/deploy-run.sh")
			if e != nil {
				t.Fatal(e)
			}
			script := `printf '%s 0\n' "$SHUTTLE_DEPLOY_TOKEN"`
			if kind == "background-profile" {
				p := filepath.Join(f.home, ".bash_profile")
				file, e := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0600)
				if e != nil {
					t.Fatal(e)
				}
				fmt.Fprintln(file, `sleep 300 &`)
				file.Close()
			} else {
				tmux, e := exec.LookPath("tmux")
				if e != nil {
					t.Skip("tmux is not installed")
				}
				sock := filepath.Join("/tmp", "shuttle-log-"+filepath.Base(t.TempDir())+".sock")
				t.Cleanup(func() { exec.Command(tmux, "-S", sock, "kill-server").Run() })
				script = shellQuote(tmux) + " -S " + shellQuote(sock) + " -f /dev/null new-session -d -s proof 'sleep 300'\n" + script
			}
			r, w, e := os.Pipe()
			if e != nil {
				t.Fatal(e)
			}
			defer r.Close()
			defer w.Close()
			log, e := os.Create(filepath.Join(f.root, "stream.log"))
			if e != nil {
				t.Fatal(e)
			}
			defer log.Close()
			cmd := exec.Command("bash", "-c", string(runner), "runner", "PROOF_DONE")
			cmd.Env = f.env
			cmd.Stdin = r
			cmd.Stdout, cmd.Stderr = log, log
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			if e = cmd.Start(); e != nil {
				t.Fatal(e)
			}
			fmt.Fprintf(w, "%d\n%s", len(script), script)
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case e = <-done:
				if kind == "background-profile" {
					syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				}
				if e != nil || !strings.Contains(fleetRead(log.Name()), "PROOF_DONE 0") {
					t.Fatalf("runner failed: %v %s", e, fleetRead(log.Name()))
				}
			case <-time.After(3 * time.Second):
				syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				<-done
				t.Fatalf("logger waited for escaped writer: %s", fleetRead(log.Name()))
			}
		})
	}
}
