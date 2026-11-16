package messaging

import (
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
	pinned, err := pinnedBy(root)
	if err != nil {
		return err
	}
	if pinned[id] != nil {
		return errCode("in_flight", "message %s has a delivery in flight; it cannot be cancelled", id)
	}
	// Marked before the move, so offered/ never reads as its delivery.
	e.Disposition = "cancelled"
	if err := writeMailboxEntry(path, e); err != nil {
		return err
	}
	return moveToOffered(root, path)
}
