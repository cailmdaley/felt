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

func TestDeployCoalescedReleaseDefersCancellation(t *testing.T) {
	t.Parallel()
	for _, host := range []string{"fake", "local"} {
		t.Run(host, func(t *testing.T) {
			t.Parallel()
			f := newDeployFleet(t)
			fleetTouch(t, f.gate)
			first, log := f.startHost(t, "coalesced-base", host)
			if err := first.Wait(); err != nil {
				t.Fatalf("base: %v %s", err, fleetRead(log))
			}

			// Pause the release request itself: cancellation must not kill it,
			// even when no pointer selection or daemon restart was necessary.
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
			defer fleetTouch(t, filepath.Join(f.root, "coalesced-release-go"))
			if err := os.WriteFile(f.events, nil, 0600); err != nil {
				t.Fatal(err)
			}
			receipt := filepath.Join(f.home, ".shuttle/deploy/previous")
			previous := filepath.Join(f.root, "rollback") + "\n"
			if err := os.WriteFile(receipt, []byte(previous), 0600); err != nil {
				t.Fatal(err)
			}

			cmd, log := f.startHost(t, "coalesced-cancel", host)
			deployAwait(t, "coalesced release: "+log, func() bool {
				_, err := os.Stat(filepath.Join(f.root, "coalesced-release-entered"))
				return err == nil
			})
			if !strings.Contains(fleetRead(log), "coalescing without a daemon cycle") {
				t.Fatalf("did not reach coalesced release: %s", fleetRead(log))
			}
			if host == "local" {
				if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
					t.Fatal(err)
				}
			} else {
				pid, err := strconv.Atoi(strings.TrimSpace(fleetRead(filepath.Join(f.root, "ssh.pid"))))
				if err != nil {
					t.Fatal(err)
				}
				if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
					t.Fatal(err)
				}
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			last := filepath.Join(f.home, ".shuttle/deploy/last-run.log")
			deployAwait(t, "deferred coalesced cancellation: "+last, func() bool {
				select {
				case err := <-done:
					t.Fatalf("cancellation interrupted coalesced release: %v\n%s", err, fleetRead(last))
				default:
				}
				return strings.Contains(fleetRead(last), "deferred through activation")
			})
			fleetTouch(t, filepath.Join(f.root, "coalesced-release-go"))
			deployAwait(t, "completed coalesced release: "+last, func() bool {
				return strings.Contains(fleetRead(f.events), "release\n")
			})
			select {
			case err := <-done:
				if err == nil {
					t.Fatalf("cancelled deploy reported success: %s", fleetRead(log))
				}
			case <-time.After(10 * time.Second):
				t.Fatalf("cancellation did not finish: %s", fleetRead(last))
			}
			if events := fleetRead(f.events); strings.Count(events, "release\n") != 1 || strings.Contains(events, "cycle\n") || strings.Contains(events, "prune\n") || strings.Contains(events, "build ") {
				t.Fatalf("coalesced cancellation must finish only release: %s", events)
			}
			if got := fleetRead(receipt); got != previous {
				t.Fatalf("lost rollback receipt: got %q want %q", got, previous)
			}
		})
	}
}

func TestDeployCancelledActivationRetainsRollbackBeforeAcknowledgement(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleetTouch(t, f.gate)
	first, log := f.start(t, "rollback-base")
	if e := first.Wait(); e != nil {
		t.Fatalf("base: %v %s", e, fleetRead(log))
	}
	previous, e := filepath.EvalSymlinks(filepath.Join(f.remote+".deploy", f.sha))
	if e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(f.repo, "tracked"), []byte("next\n"), 0600)
	f.git(t, f.repo, "add", "tracked")
	f.git(t, f.repo, "commit", "-m", "next")
	f.git(t, f.repo, "push", "origin", "main")
	defer fleetTouch(t, filepath.Join(f.root, "activation-go"))
	next, log := f.start(t, "cancelled-activation", "ACTIVATION_GATE=1")
	deployAwait(t, "activation: "+log, func() bool { _, e := os.Stat(filepath.Join(f.root, "activation-entered")); return e == nil })
	client, _ := strconv.Atoi(strings.TrimSpace(fleetRead(filepath.Join(f.root, "ssh.pid"))))
	syscall.Kill(client, syscall.SIGKILL)
	last := filepath.Join(f.home, ".shuttle/deploy/last-run.log")
	deployAwait(t, "deferred cancellation", func() bool { return strings.Contains(fleetRead(last), "deferred through activation") })
	fleetTouch(t, filepath.Join(f.root, "activation-go"))
	if e := next.Wait(); e == nil {
		t.Fatal("cancelled activation succeeded")
	}
	deployAwait(t, "released deploy lock: "+last, func() bool {
		file, err := os.OpenFile(filepath.Join(f.home, ".shuttle/deploy.lock"), os.O_RDWR, 0600)
		if err != nil {
			return false
		}
		defer file.Close()
		return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
	})
	if got := strings.TrimSpace(fleetRead(filepath.Join(f.home, ".shuttle/deploy/previous"))); got != previous {
		t.Fatalf("lost previous release before E acknowledgement: got %q want %q", got, previous)
	}
}

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
