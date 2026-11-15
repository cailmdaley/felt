package messaging

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// A record is a line the daemon transports itself, as typed input or in a
// launch prompt: the human's typed lines, and an agent's request for a fresh
// session. It is written straight to the fiber inbox's offered/, so no reader
// ever offers it to a worker, and its id deduplicates a retried submission.
// Its disposition says what became of the transport: unknown until settled,
// then delivered, undeliverable (it never reached a worker), or unknown (it
// may have).

// BeginRecord records a line from sender before the daemon transports it,
// answering whether this call may transport it and the record's disposition.
// Only the call that writes the record may; a repeated id answers false with
// the stored disposition, unless its record was settled undeliverable, which
// may be submitted again. Text over the inbox limit is recorded cut short; the
// transport carries it whole.
func BeginRecord(env *sysenv.Env, address, id, from, text string) (bool, string, error) {
	root, err := inboxRoot(env, address)
	if err != nil {
		return false, "", err
	}
	unlock, err := lockInbox(root)
	if err != nil {
		return false, "", err
	}
	defer unlock()
	path := recordPath(root, id)
	stored, err := readFiberMailboxEntry(path)
	if err == nil && stored.Disposition != "undeliverable" {
		return false, stored.Disposition, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, "", err
	}
	if err := ensureDir(filepath.Dir(path), 0700); err != nil {
		return false, "", err
	}
	source := "message"
	if from == "human" {
		source = "human"
	}
	b, err := json.Marshal(mailboxEntry{
		Request:     Request{MessageID: id, Text: boundedInboxText(text), From: from},
		Wishes:      Wishes{Source: source, Turn: "none"},
		QueuedAt:    time.Now().UnixNano(),
		Disposition: "unknown",
	})
	if err != nil {
		return false, "", err
	}
	return true, "unknown", mailboxWrite(path, b, false)
}

// SettleRecord records the transport's outcome on a record.
func SettleRecord(env *sysenv.Env, address, id, outcome string) error {
	if outcome != "unknown" && outcome != "delivered" && outcome != "undeliverable" {
		return errCode("invalid_request", "invalid record outcome")
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
	path := recordPath(root, id)
	e, err := readFiberMailboxEntry(path)
	if err != nil {
		return err
	}
	if e.Disposition == "" {
		return errCode("invalid_request", "not a record")
	}
	e.Disposition = outcome
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return mailboxWrite(path, b, false)
}

func recordPath(root, id string) string {
	return filepath.Join(root, "offered", mailboxKey(id)+".json")
}
