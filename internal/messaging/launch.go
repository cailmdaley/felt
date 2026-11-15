package messaging

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// launchLease is how long a launch reservation stands. A launch that never
// arrives, or that the Poller refuses or holds after the request, is asked for
// again once it passes.
const launchLease = 2 * time.Minute

// launchReservation records the one session a fiber's inbox has asked the
// daemon to start: a fresh session replacing the costly live worker
// Conversation at Epoch, or a session for a fiber with no worker (Conversation
// "-"). It lives beside the entries in the inbox's launch.json, apart from
// their delivery attempts, so reserving a launch never rewrites a batch's
// pinned payload or transport identity. Members are the asking entries the
// launch was requested for, free or held by an open batch.
type launchReservation struct {
	Conversation string   `json:"conversation"`
	Epoch        uint64   `json:"epoch,omitempty"`
	Members      []string `json:"members"`
	OpenedAt     int64    `json:"opened_at"`
}

func launchReservationPath(root string) string { return filepath.Join(root, "launch.json") }

// readLaunchReservation reads the inbox's reservation; an inbox that never
// reserved a launch has the zero reservation, which holds nothing.
func readLaunchReservation(root string) (launchReservation, error) {
	var r launchReservation
	bytes, err := readBounded(launchReservationPath(root), 512<<10)
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err == nil {
		err = json.Unmarshal(bytes, &r)
	}
	return r, err
}

// reserveLaunch records a reservation for members, requested by the worker w
// (Address "-" for a fiber with none), replacing any earlier one. Called under
// the inbox lock.
func reserveLaunch(root string, w Worker, members []string, now time.Time) error {
	bytes, err := json.Marshal(launchReservation{Conversation: w.Address, Epoch: w.Epoch, Members: members, OpenedAt: now.UnixNano()})
	if err != nil {
		return err
	}
	return mailboxWrite(launchReservationPath(root), bytes, false)
}

// holds reports that the reservation is in its lease and was requested for
// the entry id.
func (r launchReservation) holds(id string, now time.Time) bool {
	return r.OpenedAt != 0 && now.Sub(time.Unix(0, r.OpenedAt)) < launchLease && slices.Contains(r.Members, id)
}

// requestedBy reports that the live worker w requested the reservation.
func (r launchReservation) requestedBy(w Worker) bool {
	return r.Conversation == w.Address && r.Epoch == w.Epoch
}

// inFlight reports that the reservation's launch is in its lease and still
// owes one of the pending items: once the launched session has taken them
// all, a new entry may ask for another.
func (r launchReservation) inFlight(items []mailboxPendingItem, now time.Time) bool {
	for _, it := range items {
		if r.holds(it.entry.Request.MessageID, now) {
			return true
		}
	}
	return false
}

// entryReservation is the newest open reservation a contract-39 CLI wrote
// into items, or the zero reservation.
func entryReservation(items []mailboxPendingItem) launchReservation {
	var r launchReservation
	for _, it := range items {
		if a := it.entry.Attempt; a.open() && a.Launch && a.OpenedAt > r.OpenedAt {
			r = launchReservation{Conversation: a.Conversation, Epoch: a.Epoch, Members: slices.Clone(a.Members), OpenedAt: a.OpenedAt}
		}
	}
	return r
}

// currentReservation is the inbox's reservation: launch.json's, or a newer
// one a contract-39 CLI left in the entries and no locked reader has moved
// yet.
func currentReservation(root string, items []mailboxPendingItem) (launchReservation, error) {
	r, err := readLaunchReservation(root)
	if err != nil {
		return r, err
	}
	if legacy := entryReservation(items); legacy.OpenedAt > r.OpenedAt {
		r = legacy
	}
	return r, nil
}

// migrateEntryReservations moves a reservation a contract-39 CLI wrote into
// the entries to launch.json, keeping its receiver, epoch, members and opening
// time, and clears it from every entry: it was never a delivery attempt, so
// it is no evidence of a possible repeat. An entry it cannot read is left to
// the caller's own reading. Called under the inbox lock.
func migrateEntryReservations(root string) error {
	files, err := os.ReadDir(filepath.Join(root, "pending"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var items []mailboxPendingItem
	for _, file := range files {
		path := filepath.Join(root, "pending", file.Name())
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		if entry, err := readFiberMailboxEntry(path); err == nil && entry.Attempt != nil && entry.Attempt.Launch {
			items = append(items, mailboxPendingItem{path, entry})
		}
	}
	legacy := entryReservation(items)
	if legacy.OpenedAt == 0 {
		return nil
	}
	current, err := readLaunchReservation(root)
	if err != nil {
		return err
	}
	if legacy.OpenedAt > current.OpenedAt {
		bytes, err := json.Marshal(legacy)
		if err != nil {
			return err
		}
		if err := mailboxWrite(launchReservationPath(root), bytes, false); err != nil {
			return err
		}
	}
	for _, it := range items {
		it.entry.Attempt = nil
		if err := writeMailboxEntryKeepingTime(it.path, it.entry); err != nil {
			return err
		}
	}
	return nil
}
