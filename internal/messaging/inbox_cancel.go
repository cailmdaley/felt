package messaging

import (
	"encoding/json"
	"github.com/cailmdaley/felt/internal/sysenv"
	"os"
	"path/filepath"
)

// CancelPending settles a pending entry without emitting it. A pinned batch
// may already be in flight, so cancellation cannot retract that publication.
func CancelPending(env *sysenv.Env, address, id string) error {
	root, err := inboxRoot(env, address)
	if err != nil {
		return err
	}
	unlock, err := lockInbox(root)
	if err != nil {
		return err
	}
	defer unlock()
	path := filepath.Join(root, "pending", mailboxKey(id)+".json")
	e, err := readFiberMailboxEntry(path)
	if os.IsNotExist(err) {
		return errCode("not_pending", "message %s is not pending", id)
	}
	if err != nil {
		return err
	}
	if e.Attempt.open() {
		return errCode("in_flight", "message %s has a delivery in flight; it cannot be cancelled", id)
	}
	// Remove it from every reader's pending set before updating its verdict.
	// A crash here leaves an offered record, never a retryable publication.
	if err := moveToOffered(root, path); err != nil {
		return err
	}
	e.Disposition = "cancelled"
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return mailboxWrite(filepath.Join(root, "offered", filepath.Base(path)), data, false)
}
