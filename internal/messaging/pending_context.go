package messaging

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// PendingContext describes a notice waiting for a fiber's worker. Mailbox is
// the local durable queue path, including when no receiver has registered yet.
type PendingContext struct {
	Mailbox        string    `json:"mailbox"`
	MessageID      string    `json:"message_id"`
	QueuedAt       time.Time `json:"queued_at"`
	AgeSeconds     int64     `json:"age_seconds"`
	AttemptAddress string    `json:"attempt_address,omitempty"`
	PossibleRepeat bool      `json:"possible_repeat,omitempty"`
}

// OverdueFiberContext reads atomic queue records without locking delivery.
// Age is an operator diagnostic, never evidence that a receiver has ended.
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
		entries, err := os.ReadDir(filepath.Join(mailbox, "pending"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, file := range entries {
			if file.IsDir() || strings.HasPrefix(file.Name(), ".") || !strings.HasSuffix(file.Name(), ".json") {
				continue
			}
			entry, err := readFiberMailboxEntry(filepath.Join(mailbox, "pending", file.Name()))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			queued := time.Unix(0, entry.QueuedAt)
			age := now.Sub(queued)
			if age < after {
				continue
			}
			pending = append(pending, PendingContext{Mailbox: mailbox, MessageID: entry.Request.MessageID, QueuedAt: queued, AgeSeconds: int64(age / time.Second), AttemptAddress: entry.AttemptAddress, PossibleRepeat: entry.PossibleRepeat})
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
