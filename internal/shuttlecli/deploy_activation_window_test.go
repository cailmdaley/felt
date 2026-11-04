package shuttlecli

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDeployLateDisconnectCompletesOnlyActivation(t *testing.T) {
	t.Parallel()
	for _, host := range []string{"fake", "local"} {
		t.Run(host, func(t *testing.T) {
			t.Parallel()
			f := newDeployFleet(t)
			defer fleetTouch(t, filepath.Join(f.root, "activation-go"))
			fleetTouch(t, f.gate)
			cmd, log := f.startHost(t, "activation-cancel", host, "ACTIVATION_GATE=1")
			deployAwait(t, "activation: "+log, func() bool { _, e := os.Stat(filepath.Join(f.root, "activation-entered")); return e == nil })
			if host == "local" {
				cmd.Process.Signal(syscall.SIGINT)
			} else {
				pid, _ := strconv.Atoi(strings.TrimSpace(fleetRead(filepath.Join(f.root, "ssh.pid"))))
				syscall.Kill(pid, syscall.SIGKILL)
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			last := filepath.Join(f.home, ".shuttle/deploy/last-run.log")
			deployAwait(t, "deferred cancellation: "+log, func() bool { return strings.Contains(fleetRead(last), "deferred through activation") })
			if strings.Contains(fleetRead(f.events), "release\n") {
				t.Fatal("release occurred before activation")
			}
			fleetTouch(t, filepath.Join(f.root, "activation-go"))
			deployAwait(t, "released activation: "+last, func() bool { return strings.Contains(fleetRead(f.events), "release\n") })
			select {
			case e := <-done:
				if e == nil {
					t.Fatalf("lost observer reported success: %s", fleetRead(log))
				}
			case <-time.After(10 * time.Second):
				t.Fatalf("cancellation did not finish: %s", fleetRead(log))
			}
			deployAwait(t, "released locks: "+last, func() bool {
				file, e := os.OpenFile(filepath.Join(f.home, ".shuttle/deploy.lock"), os.O_RDWR, 0600)
				if e != nil {
					return false
				}
				defer file.Close()
				return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
			})
			events := fleetRead(f.events)
			if strings.Count(events, "cycle\n") != 1 || strings.Count(events, "release\n") != 1 || strings.Contains(events, "prune\n") {
				t.Fatalf("activation incomplete or post-activation work ran: %s", events)
			}
			if trap := fleetRead(filepath.Join(f.root, "launcher-term-trap")); trap != "" {
				t.Fatalf("launcher inherited ignored TERM: %s", trap)
			}
		})
	}
}
