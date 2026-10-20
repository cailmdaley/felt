package shuttlecli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
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
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	var records []SessionProvenance
	for scanner.Scan() {
		var row SessionProvenance
		if json.Unmarshal(scanner.Bytes(), &row) != nil {
			return nil
		}
		records = append(records, row)
	}
	if scanner.Err() != nil {
		return nil
	}
	return records
}

func messageSessionFiber(address messaging.Address, records []SessionProvenance) *felt.Felt {
	var found *felt.Felt
	for _, row := range records {
		if row.Host != address.Host || messaging.NormalizeHarness(row.Harness) != address.Harness ||
			row.nativeSessionID() != address.ID || row.fiber() == "" ||
			(row.Kind != "dispatch" && row.Kind != "resume" && row.Kind != "claim") {
			continue
		}
		if found != nil && !sessionRecordBelongsToFiber(row, found) {
			return nil
		}
		found = &felt.Felt{ID: row.fiber(), UID: row.UID}
	}
	return found
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
	current, err := fiberWorkerAddress(f, worker, messaging.NormalizeHarness(worker.Harness), "", nil)
	if err != nil || current == req.Address {
		return receipt
	}
	hint := fmt.Sprintf("fiber %s has current worker %s; use shuttle message %s ... to address its current worker; this explicit session message is not forwarded", f.ID, current, f.ID)
	receipt.Detail = strings.TrimSpace(receipt.Detail + "; " + hint)
	return receipt
}
