package messaging

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Attempt records one try at delivering a batch of inbox entries to one
// conversation. Every member entry carries the same record in its pending
// file, written under the inbox lock before any side effect.
type Attempt struct {
	// Payload pins the exact batch emission and its transport identity.
	Payload *Request `json:"payload,omitempty"`
	// BaseText is the captured text, including any labels, without a retry
	// warning.
	BaseText string `json:"base_text,omitempty"`
	// Variant names the payload's plain, retry-1 or possible-repeat framing.
	Variant string `json:"variant,omitempty"`
	// BatchID is the hash of the batch's sorted member ids, so a retry of the
	// same batch carries the same id.
	BatchID string `json:"batch_id"`
	// Conversation is the shuttle:// address the batch is going to.
	Conversation string `json:"conversation"`
	// Epoch is the fiber receiver's epoch when Conversation was the fiber's
	// receiver at the claim, and 0 otherwise (a session inbox, or a delivery
	// pinned to a conversation that has since been replaced).
	Epoch uint64 `json:"epoch,omitempty"`
	// Members are the batch's message ids, oldest first.
	Members []string `json:"members"`
	// OpenedAt is when the attempt was claimed, in Unix nanoseconds; 0 when it
	// was read from an attempt_address alone.
	OpenedAt int64 `json:"opened_at,omitempty"`
	// Outcome is empty while the attempt is open, then delivered, released or
	// ambiguous.
	Outcome string `json:"outcome,omitempty"`
	// Retry counts the sends direct delivery made to Conversation after an
	// earlier one stayed unknown. A retry carries its own transport id, so
	// the conversation's receipt for the earlier send is not replayed.
	Retry int `json:"retry,omitempty"`
}

// liveAttemptRetryAfter is how long direct delivery keeps an attempt open
// while its conversation is alive and the transport reports the outcome
// unknown, before it makes one warning-marked retry.
const liveAttemptRetryAfter = 5 * time.Minute

const (
	attemptDelivered = "delivered"
	attemptReleased  = "released"
	attemptAmbiguous = "ambiguous"
)

func (a *Attempt) open() bool { return a != nil && a.Outcome == "" }

func batchID(members []string) string {
	sorted := slices.Clone(members)
	slices.Sort(sorted)
	return mailboxKey(strings.Join(sorted, "\x00"))
}

// openAttempt records an open attempt to conversation for a batch of members.
// An attempt already open for the same batch, conversation and epoch is kept
// as it was opened.
func (e *mailboxEntry) openAttempt(conversation string, epoch uint64, members []string, now time.Time) {
	id := batchID(members)
	if !e.Attempt.open() || e.Attempt.BatchID != id || e.Attempt.Conversation != conversation || e.Attempt.Epoch != epoch {
		e.Attempt = &Attempt{BatchID: id, Conversation: conversation, Epoch: epoch, Members: slices.Clone(members), OpenedAt: now.UnixNano()}
	}
}

// closeAttempt records outcome. Released and ambiguous unpin the entry.
// Ambiguous outcomes and rejected retries preserve possible-repeat evidence.
func (e *mailboxEntry) closeAttempt(outcome string) {
	if e.Attempt != nil {
		e.Attempt.Outcome = outcome
	}
	if outcome == attemptReleased || outcome == attemptAmbiguous {
		e.AttemptAddress = ""
	}
	if outcome == attemptAmbiguous || (outcome == attemptReleased && e.Attempt != nil && e.Attempt.Retry > 0) {
		e.PossibleRepeat = true
	}
}

// claimBatch opens an unpinned attempt for a hook batch under the inbox lock.
// The batch consumer pins through its durable manifest instead. A claim
// preserves the file's modification time, from which offered/ retention runs;
// an unfinished claim is ambiguous.
func claimBatch(paths []string, conversation string) (Attempt, error) {
	entries := make([]mailboxEntry, len(paths))
	members := make([]string, len(paths))
	for i, path := range paths {
		entry, err := readFiberMailboxEntry(path)
		if err != nil {
			return Attempt{}, err
		}
		entries[i], members[i] = entry, entry.Request.MessageID
	}
	epoch := receiverEpoch(filepath.Dir(filepath.Dir(paths[0])), conversation)
	now := time.Now()
	for i := range entries {
		entries[i].openAttempt(conversation, epoch, members, now)
		if err := writeMailboxEntryKeepingTime(paths[i], entries[i]); err != nil {
			return Attempt{}, err
		}
	}
	return *entries[0].Attempt, nil
}

// closeAttempts records outcome in the entries at paths, all in one inbox. A
// delivered entry moves to offered/ with the modification time it had
// pending; released and ambiguous ones stay pending.
func closeAttempts(paths []string, outcome string) error {
	if len(paths) == 0 {
		return nil
	}
	dir := filepath.Dir(filepath.Dir(paths[0]))
	offeredDir := filepath.Join(dir, "offered")
	if outcome == attemptDelivered {
		if err := ensureDir(offeredDir, 0700); err != nil {
			return err
		}
	}
	for _, path := range paths {
		entry, err := readFiberMailboxEntry(path)
		if err != nil {
			return err
		}
		if outcome != attemptDelivered || entry.Attempt != nil {
			entry.closeAttempt(outcome)
			write := writeMailboxEntry
			if outcome == attemptDelivered {
				write = writeMailboxEntryKeepingTime
			}
			if err := write(path, entry); err != nil {
				return err
			}
		}
		if outcome == attemptDelivered {
			if err := os.Rename(path, filepath.Join(offeredDir, filepath.Base(path))); err != nil {
				return err
			}
		}
	}
	if outcome != attemptDelivered {
		return nil
	}
	if err := syncDir(filepath.Join(dir, "pending")); err != nil {
		return err
	}
	return syncDir(offeredDir)
}

// receiverEpoch is the epoch of the inbox's fiber receiver when conversation
// is that receiver, and 0 otherwise.
func receiverEpoch(root, conversation string) uint64 {
	receiver, err := readFiberReceiver(root)
	if err != nil {
		return 0
	}
	if a, err := ParseAddress(conversation); err == nil && a == receiver.Address {
		return receiver.Generation
	}
	return 0
}

func writeMailboxEntry(path string, entry mailboxEntry) error {
	b, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return mailboxWrite(path, b, false)
}

// writeMailboxEntryKeepingTime rewrites an entry's bookkeeping without moving
// its modification time.
func writeMailboxEntryKeepingTime(path string, entry mailboxEntry) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if err := writeMailboxEntry(path, entry); err != nil {
		return err
	}
	// The time only sets how long offered/ keeps the entry.
	_ = os.Chtimes(path, info.ModTime(), info.ModTime())
	return nil
}
