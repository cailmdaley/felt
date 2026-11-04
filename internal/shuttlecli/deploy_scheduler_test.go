package shuttlecli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestDeploySchedulerQueueIsBoundedAndCancelled(t *testing.T) {
	t.Parallel()
	f := newDeployFleet(t)
	fleet := fmt.Sprintf(`{"remotes":[{"name":"fake","ssh":"fake","checkout":%q,"build_wrap":"srun --partition=test"}]}`, f.remote)
	if e := os.WriteFile(filepath.Join(f.root, "remotes.json"), []byte(fleet), 0600); e != nil {
		t.Fatal(e)
	}
	script := `#!/bin/sh
[ "$1" = --partition=test ] && [ "$2" = --immediate=900 ] || { echo unbounded-srun >&2; exit 91; }
trap 'echo srun-cancelled >> "$EVENTS"; exit 143' TERM INT HUP
echo srun-queued >> "$EVENTS"
while :; do sleep 300; done
`
	if e := os.WriteFile(filepath.Join(f.bin, "srun"), []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	cmd, log := f.start(t, "queued")
	deployAwait(t, "queued scheduler: "+log, func() bool {
		return strings.Contains(fleetRead(f.events), "srun-queued") || strings.Contains(fleetRead(log), "unbounded-srun")
	})
	if strings.Contains(fleetRead(log), "unbounded-srun") {
		t.Fatalf("scheduler queue limit is not 900s: %s", fleetRead(log))
	}
	cmd.Process.Signal(syscall.SIGINT)
	if e := cmd.Wait(); e == nil {
		t.Fatalf("cancelled queue reported success: %s", fleetRead(log))
	}
	if events := fleetRead(f.events); !strings.Contains(events, "srun-cancelled") || strings.Contains(events, "cycle\n") {
		t.Fatalf("queue cancellation did not reach scheduler: %s", events)
	}
}
