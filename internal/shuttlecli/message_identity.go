package shuttlecli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/messaging"
)

// localMessageLedger reads owner-local provenance without calling back into the
// daemon that shells this CLI for delivery. Remote rejection hints come from
// the receiving owner, not a sender's potentially stale synchronized store.
func (a *app) localMessageLedger() []SessionProvenance {
	path, _ := a.shuttleStatePath("SHUTTLE_SESSIONS_FILE", "sessions.jsonl")
	if path == "" {
		return nil
	}
	var records []SessionProvenance
	// Match the daemon's ledger window: rotated history first, live rows
	// second, then stable timestamp order, retaining live-after-rotated order
	// at equal timestamps. Conflicting newest worker identities still refuse.
	for _, source := range []string{path + ".1", path} {
		file, err := os.Open(source)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		for scanner.Scan() {
			var row SessionProvenance
			if json.Unmarshal(scanner.Bytes(), &row) == nil {
				records = append(records, row)
			}
		}
		file.Close()
		if scanner.Err() != nil {
			return nil
		}
	}
	sort.SliceStable(records, func(i, j int) bool { return records[i].At < records[j].At })
	return records
}

func messageSessionFiber(address messaging.Address, records []SessionProvenance) *felt.Felt {
	row, err := currentSessionBinding(address, records)
	if err != nil || row == nil {
		return nil
	}
	return &felt.Felt{ID: row.fiber(), UID: row.UID, Path: row.FiberPath}
}

func (a *app) messageReplyTarget(from string) string {
	address, err := messaging.ParseAddress(from)
	if err != nil {
		return ""
	}
	host, err := a.resolveOwnHost("")
	if err != nil || address.Host != host {
		return ""
	}
	if row, err := currentSessionBinding(address, a.localMessageLedger()); err != nil {
		return ""
	} else if row != nil {
		if f, err := a.workerBindingFiber(*row); err == nil {
			return f.ID
		}
		return row.fiber()
	}
	// Dispatch exports this path. Check the native identity too: nested harnesses
	// inherit the path but are not the fiber's assigned worker.
	if path := a.env.Getenv("SHUTTLE_FIBER_PATH"); path != "" {
		if data, err := os.ReadFile(a.env.Resolve(path)); err == nil {
			if f, err := felt.Parse("", data); err == nil && shuttleRuntimeSessionID(f) == address.ID && f.UID != "" {
				if lookup, err := a.lookupShuttleAddressFibers(f.UID); err == nil && len(lookup.Fibers) == 1 {
					return lookup.Fibers[0].ID
				}
				return f.UID
			}
		}
	}
	if f := messageSessionFiber(address, a.localMessageLedger()); f != nil {
		return f.ID
	}
	return ""
}

// enrichUnavailableSession advises a new target without ever forwarding an
// explicit session message. An unavailable receiver is not proof of an ended
// conversation; preserve the transport's reason verbatim.
func (a *app) enrichUnavailableSession(req messaging.Request, receipt messaging.Receipt) messaging.Receipt {
	if receipt.Status != messaging.StatusRejected && receipt.Status != messaging.StatusUnknown {
		return receipt
	}
	address, err := messaging.ParseAddress(req.Address)
	if err != nil {
		return receipt
	}
	host, err := a.resolveOwnHost("")
	if err != nil || address.Host != host {
		return receipt
	}
	records := a.localMessageLedger()
	f := messageSessionFiber(address, records)
	if f == nil {
		return receipt
	}
	worker, err := newestFiberWorkerRecord(f, records)
	if err != nil || worker == nil {
		return receipt
	}
	harness := messaging.NormalizeHarness(worker.Harness)
	if worker.Host == address.Host && harness == address.Harness && worker.nativeSessionID() == address.ID {
		return receipt
	}
	// Reuse the normal fiber resolver's runtime and peer evidence. A Codex
	// CLI row can name its native session without a separate thread_id.
	query := f.ID
	if f.UID != "" {
		query = f.UID
	}
	if lookup, err := a.lookupShuttleAddressFibers(query); err == nil && len(lookup.Fibers) == 1 {
		f = lookup.Fibers[0]
	}
	runtimeID := shuttleRuntimeSessionID(f)
	current, resolveErr := fiberWorkerAddress(f, worker, harness, runtimeID, nil)
	if resolveErr != nil {
		if directory, err := a.fetchPeerDirectory(worker.Host, harness); err == nil {
			current, resolveErr = fiberWorkerAddress(f, worker, harness, runtimeID, directory.Sessions)
		}
	}
	if resolveErr == nil && current == req.Address {
		return receipt
	}
	if resolveErr != nil {
		current = fmt.Sprintf("session %s on %s/%s (exact address unresolved)", worker.Session, worker.Host, harness)
	}
	hint := fmt.Sprintf("fiber %s has current worker %s; use shuttle message %s ... to address its current worker; this explicit session message is not forwarded", f.ID, current, f.ID)
	receipt.Detail = strings.TrimSpace(receipt.Detail + "; " + hint)
	return receipt
}
