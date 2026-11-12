package shuttlecli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Activation, from pointer selection through readiness, quarantine release and
// the rollback receipt, is the protected unit. Losing the deployer during it
// lets activation finish and nothing after it run. The host goes through two
// cancelled runs: one that cycles the daemon onto a new target, then a re-run
// of that target whose coalesced release is cancelled the same way. The remote
// host first deploys a base release, so the cancelled activation has a
// rollback tree to retain.
func TestDeployActivationDefersCancellation(t *testing.T) {
	t.Parallel()
	for _, host := range []string{"fake", "local"} {
		t.Run(host, func(t *testing.T) {
			t.Parallel()
			f := newDeployFleet(t)
			defer fleetTouch(t, filepath.Join(f.root, "activation-go"))
			defer fleetTouch(t, filepath.Join(f.root, "coalesced-release-go"))
			fleetTouch(t, f.gate)
			last := filepath.Join(f.home, ".shuttle/deploy/last-run.log")
			receipt := filepath.Join(f.home, ".shuttle/deploy/previous")
			var previous string
			if host == "fake" {
				base, log := f.startHost(t, "base", host)
				if err := f.deployWait(t, base); err != nil {
					t.Fatalf("base: %v %s", err, fleetRead(log))
				}
				tree, err := filepath.EvalSymlinks(filepath.Join(f.remote+".deploy", f.sha))
				if err != nil {
					t.Fatal(err)
				}
				previous = tree + "\n"
				if err := os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("next\n"), 0600); err != nil {
					t.Fatal(err)
				}
				f.git(t, f.repo, "commit", "-am", "next")
				f.git(t, f.repo, "push", "origin", "main")
				if err := os.WriteFile(f.events, nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			// cancel signals the deployer (local) or kills its SSH client
			// (remote) once the run is inside its protected unit, and returns
			// the run's eventual exit.
			cancel := func(cmd *exec.Cmd, log, entered string) chan error {
				t.Helper()
				deployAwait(t, entered+": "+log, func() bool { _, err := os.Stat(filepath.Join(f.root, entered)); return err == nil })
				if host == "local" {
					cmd.Process.Signal(syscall.SIGINT)
				} else {
					pid, _ := strconv.Atoi(strings.TrimSpace(fleetRead(filepath.Join(f.root, "ssh.pid"))))
					syscall.Kill(pid, syscall.SIGKILL)
				}
				done := make(chan error, 1)
				go func() { done <- cmd.Wait() }()
				deployAwait(t, "deferred cancellation: "+last, func() bool {
					select {
					case err := <-done:
						t.Fatalf("cancellation interrupted activation: %v\n%s", err, fleetRead(last))
					default:
					}
					return strings.Contains(fleetRead(last), "deferred through activation")
				})
				return done
			}
			finish := func(done chan error, log string) {
				t.Helper()
				deployAwait(t, "released activation: "+last, func() bool { return strings.Contains(fleetRead(f.events), "release\n") })
				select {
				case err := <-done:
					if err == nil {
						t.Fatalf("cancelled deploy reported success: %s", fleetRead(log))
					}
				case <-time.After(60 * time.Second):
					t.Fatalf("cancellation did not finish: %s", fleetRead(last))
				}
				deployAwait(t, "released locks: "+last, func() bool { return f.lockFree(t) })
			}

			cmd, log := f.startHost(t, "activation-cancel", host, "ACTIVATION_GATE=1")
			done := cancel(cmd, log, "activation-entered")
			if strings.Contains(fleetRead(f.events), "release\n") {
				t.Fatal("release occurred before activation")
			}
			fleetTouch(t, filepath.Join(f.root, "activation-go"))
			finish(done, log)
			events := fleetRead(f.events)
			if strings.Count(events, "cycle\n") != 1 || strings.Count(events, "release\n") != 1 || strings.Contains(events, "prune\n") {
				t.Fatalf("activation incomplete or post-activation work ran: %s", events)
			}
			if trap := fleetRead(filepath.Join(f.root, "launcher-term-trap")); trap != "" {
				t.Fatalf("launcher inherited ignored TERM: %s", trap)
			}
			if got := fleetRead(receipt); got != previous {
				t.Fatalf("rollback receipt before E acknowledgement = %q, want %q", got, previous)
			}

			// The daemon now serves the target, so a re-run coalesces: pause
			// its release request, which cancellation must not kill even with
			// no pointer selection or daemon restart.
			curl := filepath.Join(f.bin, "curl")
			if err := os.Rename(curl, curl+"-ungated"); err != nil {
				t.Fatal(err)
			}
			gate := `#!/bin/sh
case "$*" in *'/quarantine/release'*)
 touch "$FLEET_ROOT/coalesced-release-entered"
 while [ ! -f "$FLEET_ROOT/coalesced-release-go" ]; do sleep .02; done;;
esac
exec "$FAKE_BIN/curl-ungated" "$@"
`
			if err := os.WriteFile(curl, []byte(gate), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(f.events, nil, 0600); err != nil {
				t.Fatal(err)
			}
			previous = filepath.Join(f.root, "rollback") + "\n"
			if err := os.WriteFile(receipt, []byte(previous), 0600); err != nil {
				t.Fatal(err)
			}
			cmd, log = f.startHost(t, "coalesced-cancel", host)
			done = cancel(cmd, log, "coalesced-release-entered")
			if !strings.Contains(fleetRead(log), "coalescing without a daemon cycle") {
				t.Fatalf("did not reach coalesced release: %s", fleetRead(log))
			}
			fleetTouch(t, filepath.Join(f.root, "coalesced-release-go"))
			finish(done, log)
			if events := fleetRead(f.events); strings.Count(events, "release\n") != 1 || strings.Contains(events, "cycle\n") || strings.Contains(events, "prune\n") || strings.Contains(events, "build ") {
				t.Fatalf("coalesced cancellation must finish only release: %s", events)
			}
			if got := fleetRead(receipt); got != previous {
				t.Fatalf("lost rollback receipt: got %q want %q", got, previous)
			}
		})
	}
}
