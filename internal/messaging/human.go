package messaging

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// The human's typed lines are records, not deliveries: the daemon transports
// them as terminal input or a launch prompt. A record is written straight to
// the fiber inbox's offered/, so no reader ever offers it, and its id
// deduplicates a retried submission.

// BeginHuman records typed input before the daemon submits it, answering
// whether this call may paste or launch it. Only the call that writes the
// record may; a repeated id answers false, unless its record was settled
// undeliverable, which never reached the worker and may be submitted again.
// The record's disposition is unknown until settled: terminal input has no
// receipt with which to recover a lost answer. Text over the inbox limit is
// recorded cut short; the transport carries it whole.
func BeginHuman(env *sysenv.Env, address, id, text string) (bool, error) {
	root, err := inboxRoot(env, address)
	if err != nil {
		return false, err
	}
	unlock, err := lockInbox(root)
	if err != nil {
		return false, err
	}
	defer unlock()
	path := humanRecordPath(root, id)
	stored, err := readFiberMailboxEntry(path)
	if err == nil && stored.Disposition != "undeliverable" {
		return false, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := ensureDir(filepath.Dir(path), 0700); err != nil {
		return false, err
	}
	b, err := json.Marshal(mailboxEntry{
		Request:     Request{MessageID: id, Text: boundedInboxText(text), From: "human"},
		Wishes:      Wishes{Source: "human", Turn: "none"},
		QueuedAt:    time.Now().UnixNano(),
		Disposition: "unknown",
	})
	if err != nil {
		return false, err
	}
	return true, mailboxWrite(path, b, false)
}

// SettleHuman records the typed transport's outcome on the record.
func SettleHuman(env *sysenv.Env, address, id, outcome string) error {
	if outcome != "unknown" && outcome != "delivered" && outcome != "undeliverable" {
		return errCode("invalid_request", "invalid human outcome")
	}
	root, err := inboxRoot(env, address)
	if err != nil {
		return err
	}
	unlock, err := lockInbox(root)
	if err != nil {
		return err
	}
	defer unlock()
	path := humanRecordPath(root, id)
	e, err := readFiberMailboxEntry(path)
	if err != nil {
		return err
	}
	if e.Wishes.Source != "human" {
		return errCode("invalid_request", "not a human entry")
	}
	e.Disposition = outcome
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return mailboxWrite(path, b, false)
}

func humanRecordPath(root, id string) string {
	return filepath.Join(root, "offered", mailboxKey(id)+".json")
}
