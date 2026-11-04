package shuttlecli

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

func TestDeployLoggerDoesNotWaitForEscapedWriters(t *testing.T) {
	for _, kind := range []string{"background-profile", "real-tmux"} {
		t.Run(kind, func(t *testing.T) {
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
