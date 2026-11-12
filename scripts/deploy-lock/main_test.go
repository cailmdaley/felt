package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func await(t *testing.T, description string, condition func() bool) {
	t.Helper()
	until := time.Now().Add(20 * time.Second)
	for !condition() {
		if time.Now().After(until) {
			t.Fatalf("timed out: %s", description)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func contents(path string) string { b, _ := os.ReadFile(path); return string(b) }
func present(path string) bool    { _, e := os.Stat(path); return e == nil }

// binary is deploy-lock built once for every test, with a one-second
// activation margin and a short TERM-to-KILL grace, so a deadline or
// cancellation test need not outlast the production minute and three seconds.
var binary string

func TestMain(m *testing.M) {
	dir, e := os.MkdirTemp("", "deploy-lock-test-*")
	if e != nil {
		panic(e)
	}
	binary = filepath.Join(dir, "lock")
	if out, e := exec.Command("go", "build", "-ldflags", "-X main.activationMargin=1s -X main.cancelGrace=200ms", "-o", binary, ".").CombinedOutput(); e != nil {
		panic(fmt.Sprintf("build: %v %s", e, out))
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
func start(t *testing.T, binary, root, label, script string, env ...string) (*exec.Cmd, *os.File, string) {
	t.Helper()
	logPath := filepath.Join(root, label+".log")
	log, e := os.Create(logPath)
	if e != nil {
		t.Fatal(e)
	}
	r, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	leasePath := filepath.Join(root, label+".lease")
	cmd := exec.Command(binary, filepath.Join(root, "host.lock"), leasePath, "target="+label, "bash", "-c", script, "transaction", root)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = r, log, log
	cmd.Env = append(os.Environ(), env...)
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	r.Close()
	t.Cleanup(func() {
		w.Close()
		if cmd.ProcessState == nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_ = cmd.Wait()
		} else if lease, err := os.OpenFile(leasePath, os.O_RDWR, 0600); err == nil {
			// A retained private lease identifies surviving fixture children;
			// otherwise the reaped group's numeric id is no longer ours.
			if syscall.Flock(int(lease.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == syscall.EWOULDBLOCK {
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			}
			lease.Close()
		}
		log.Close()
	})
	return cmd, w, logPath
}
func result(t *testing.T, cmd *exec.Cmd) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(30 * time.Second):
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		t.Fatal("transaction did not stop within 30 seconds")
		return nil
	}
}
func free(t *testing.T, path string) {
	t.Helper()
	f, e := os.OpenFile(path, os.O_RDWR, 0600)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	// Group members close their descriptors independently after group KILL;
	// reaping the helper is not a barrier for the final descendant's exit.
	until := time.Now().Add(20 * time.Second)
	for {
		e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if e == nil {
			return
		}
		if e != syscall.EWOULDBLOCK || !time.Now().Before(until) {
			t.Fatalf("lock retained: %v", e)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func TestObserverEOFAndSignalsCancelGroup(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"eof", "TERM", "INT", "HUP", "deadline"} {
		t.Run(how, func(t *testing.T) {
			t.Parallel()
			root := t.TempDir()
			env := []string{}
			if how == "deadline" {
				env = append(env, fmt.Sprintf("SHUTTLE_DEPLOY_DEADLINE=%d", time.Now().Add(2*time.Second).Unix()))
			}
			// Even a child that treats TERM as a successful exit cannot turn a
			// cancelled deployment into success.
			cmd, pipe, log := start(t, binary, root, how, `trap 'exit 0' TERM; sleep 300 & echo $! > "$1/descendant"; touch "$1/entered"; wait`, env...)
			await(t, log, func() bool { return present(filepath.Join(root, "entered")) })
			switch how {
			case "eof":
				pipe.Close()
			case "TERM":
				cmd.Process.Signal(syscall.SIGTERM)
			case "INT":
				cmd.Process.Signal(syscall.SIGINT)
			case "HUP":
				cmd.Process.Signal(syscall.SIGHUP)
			}
			if e := result(t, cmd); e == nil {
				t.Fatalf("cancel reported success: %s", contents(log))
			}
			free(t, filepath.Join(root, "host.lock"))
			free(t, filepath.Join(root, how+".lease"))
			if !strings.Contains(contents(log), "cancelling group") {
				t.Fatalf("missing cancellation: %s", contents(log))
			}
		})
	}
}
func TestForgottenWaiterNeverRuns(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	holder, life, log := start(t, binary, root, "holder", `touch "$1/entered"; sleep 300`)
	await(t, log, func() bool { return present(filepath.Join(root, "entered")) })
	waiter, observer, waitlog := start(t, binary, root, "waiter", `touch "$1/forbidden"`)
	await(t, waitlog, func() bool { return strings.Contains(contents(waitlog), "waiting for") })
	observer.Close()
	if e := result(t, waiter); e == nil {
		t.Fatal("abandoned waiter succeeded")
	}
	life.Close()
	_ = result(t, holder)
	free(t, filepath.Join(root, "host.lock"))
	next, nextlife, nextlog := start(t, binary, root, "next", `exit 7`)
	defer nextlife.Close()
	e := result(t, next)
	if exit, ok := e.(*exec.ExitError); !ok || exit.ExitCode() != 7 {
		t.Fatalf("status %v: %s", e, contents(nextlog))
	}
	if present(filepath.Join(root, "forbidden")) {
		t.Fatal("abandoned waiter deployed later")
	}
	node, _ := os.Hostname()
	if !strings.Contains(contents(log), "node="+node) {
		t.Fatalf("holder lacks node: %s", contents(log))
	}
}
func TestLateEOFFinishesOnlyActivation(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cmd, pipe, log := start(t, binary, root, "activation", `printf B >&5; read -r ack <&5; trap '' TERM INT HUP; touch "$1/critical"; while [ ! -f "$1/release" ]; do sleep .02; done; touch "$1/activated"; printf E >&5; trap 'exit 143' TERM; sleep 300`)
	await(t, log, func() bool { return present(filepath.Join(root, "critical")) })
	pipe.Close()
	await(t, log, func() bool { return strings.Contains(contents(log), "deferred through activation") })
	if e := os.WriteFile(filepath.Join(root, "release"), nil, 0600); e != nil {
		t.Fatal(e)
	}
	if e := result(t, cmd); e == nil {
		t.Fatalf("cancelled activation reported success: %s", contents(log))
	}
	if !present(filepath.Join(root, "activated")) {
		t.Fatal("activation torn by EOF")
	}
	free(t, filepath.Join(root, "host.lock"))
}
func TestLostOutputObserverClosesTransport(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	script := filepath.Join(root, "script")
	if e := os.WriteFile(script, []byte("bootstrap"), 0600); e != nil {
		t.Fatal(e)
	}
	input, life, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer input.Close()
	defer life.Close()
	reader, output, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	reader.Close()
	defer output.Close()
	log, e := os.Create(filepath.Join(root, "log"))
	if e != nil {
		t.Fatal(e)
	}
	defer log.Close()
	cmd := exec.Command(binary, "--observe", script, "completion", "bash", "-c", `read -r size; dd bs=1 count="$size" of=/dev/null 2>/dev/null; printf 'output\n'; cat >/dev/null; exit 143`)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, output, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_ = cmd.Wait()
		}
	})
	if e = result(t, cmd); e == nil {
		t.Fatal("closed output observer reported success")
	}
	if !strings.Contains(contents(log.Name()), "broken pipe") {
		t.Fatalf("output failure did not cancel transport: %s", contents(log.Name()))
	}
}

func TestActivationControlGetsEOFWhenOwnerDies(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cmd, life, log := start(t, binary, root, "control-eof", `touch "$1/entered"; read -r ack <&5; echo $? > "$1/control-eof"`)
	defer life.Close()
	await(t, log, func() bool { return present(filepath.Join(root, "entered")) })
	cmd.Process.Kill()
	_ = result(t, cmd)
	await(t, "transaction retained an activation-owner socket and never received EOF", func() bool { return present(filepath.Join(root, "control-eof")) })
	if strings.TrimSpace(contents(filepath.Join(root, "control-eof"))) == "0" {
		t.Fatal("activation owner death produced data, not EOF")
	}
	free(t, filepath.Join(root, "host.lock"))
}

func TestTransactionDoesNotInheritIgnoredSIGPIPE(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cmd, life, log := start(t, binary, root, "pipe-signal", `trap -p PIPE > "$1/pipe-signal"; exit 7`)
	defer life.Close()
	if e := result(t, cmd); e == nil {
		t.Fatalf("missing transaction status: %s", contents(log))
	}
	if got := contents(filepath.Join(root, "pipe-signal")); got != "" {
		t.Fatalf("inherited ignored SIGPIPE: %s", got)
	}
}

func TestActivationRefusesInsufficientDeadlineBudget(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cmd, life, log := start(t, binary, root, "budget", `printf B >&5; read -r ack <&5 || exit 43; touch "$1/pointer"`, fmt.Sprintf("SHUTTLE_DEPLOY_DEADLINE=%d", time.Now().Add(4*time.Second).Unix()), "SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=10")
	defer life.Close()
	if e := result(t, cmd); e == nil || present(filepath.Join(root, "pointer")) {
		t.Fatalf("activation began without readiness reserve: %v %s", e, contents(log))
	}
	if !strings.Contains(contents(log), "insufficient activation deadline budget") {
		t.Fatalf("missing budget diagnosis: %s", contents(log))
	}
}

func TestHardDeadlineStillStopsStalledActivation(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cmd, life, log := start(t, binary, root, "stalled", `printf B >&5; read -r ack <&5; trap '' TERM; touch "$1/critical"; sleep 300`, fmt.Sprintf("SHUTTLE_DEPLOY_DEADLINE=%d", time.Now().Add(4*time.Second).Unix()), "SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0")
	defer life.Close()
	await(t, log, func() bool { return present(filepath.Join(root, "critical")) })
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("stalled activation succeeded")
		}
	case <-time.After(20 * time.Second):
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		t.Fatal("hard activation deadline did not stop the group")
	}
	if !strings.Contains(contents(log), "overall host deadline exceeded") {
		t.Fatalf("missing hard deadline: %s", contents(log))
	}
	free(t, filepath.Join(root, "host.lock"))
}

func TestDeadlineKillsTermIgnoringGroup(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cmd, life, log := start(t, binary, root, "stubborn", `trap '' TERM INT HUP; touch "$1/entered"; sleep 300`, fmt.Sprintf("SHUTTLE_DEPLOY_DEADLINE=%d", time.Now().Add(2*time.Second).Unix()))
	defer life.Close()
	if e := result(t, cmd); e == nil {
		t.Fatal("stubborn command succeeded")
	}
	if !strings.Contains(contents(log), "KILL group") {
		t.Fatalf("missing escalation: %s", contents(log))
	}
	free(t, filepath.Join(root, "host.lock"))
}
