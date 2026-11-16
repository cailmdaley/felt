package messaging

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// PendingContext describes a notice waiting for a fiber's worker. Mailbox is
// the local durable queue path, including when no receiver has registered yet.
// AttemptAddress is the conversation an open batch holding it was sent to.
type PendingContext struct {
	Mailbox        string    `json:"mailbox"`
	MessageID      string    `json:"message_id"`
	QueuedAt       time.Time `json:"queued_at"`
	AgeSeconds     int64     `json:"age_seconds"`
	AttemptAddress string    `json:"attempt_address,omitempty"`
	PossibleRepeat bool      `json:"possible_repeat,omitempty"`
}

// OverdueFiberContext reads atomic queue records without locking delivery.
// An entry's age counts from when it became deliverable: its not_before, when
// that is later than its queueing. Age is an operator diagnostic, never
// evidence that a receiver has ended.
func OverdueFiberContext(env *sysenv.Env, now time.Time, after time.Duration) ([]PendingContext, error) {
	root := filepath.Join(dataDir(env), "mailboxes", "fiber")
	boxes, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var pending []PendingContext
	for _, box := range boxes {
		if !box.IsDir() {
			continue
		}
		mailbox := filepath.Join(root, box.Name())
		items, err := pendingItems(mailbox)
		if err != nil {
			return nil, err
		}
		pinned, err := pinnedBy(mailbox)
		if err != nil {
			return nil, err
		}
		for _, it := range items {
			entry := it.entry
			age := now.Sub(entry.availableAt())
			if age < after {
				continue
			}
			context := PendingContext{Mailbox: mailbox, MessageID: entry.Request.MessageID, QueuedAt: time.Unix(0, entry.QueuedAt), AgeSeconds: int64(age / time.Second), PossibleRepeat: entry.PossibleRepeat}
			if b := pinned[entry.Request.MessageID]; b != nil {
				context.AttemptAddress = b.Conversation
			}
			pending = append(pending, context)
		}
	}
	sort.Slice(pending, func(i, j int) bool {
		if pending[i].QueuedAt.Equal(pending[j].QueuedAt) {
			return pending[i].MessageID < pending[j].MessageID
		}
		return pending[i].QueuedAt.Before(pending[j].QueuedAt)
	})
	return pending, nil
}
