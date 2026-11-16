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

// Attempt is a batch's one claim record, its manifest at
// batches/<batch_id>.json: the members it holds, the conversation it went to
// and, for a consumer's batch, the payload it sent and the transport's receipt.
// An entry is pinned exactly while a manifest names it; member entries are
// rewritten only when they settle.
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
	// OpenedAt is when the batch was claimed for Conversation, in Unix
	// nanoseconds.
	OpenedAt int64 `json:"opened_at,omitempty"`
	// Outcome is empty while the batch is open, then delivered, released or
	// ambiguous, recorded before its members settle.
	Outcome string `json:"outcome,omitempty"`
	// Retry counts the sends made to Conversation after an earlier one stayed
	// unconfirmed. A retry carries its own transport id.
	Retry int `json:"retry,omitempty"`
	// Hook marks a hook's claim of the entries it is emitting; it has no
	// payload.
	Hook bool `json:"hook,omitempty"`
	// Receipt is the transport's answer for Payload, recorded after the send.
	// A manifest without one is a send whose outcome is unknown.
	Receipt *Receipt `json:"receipt,omitempty"`
	// ErrorCode is the send's error code, recorded with its receipt.
	ErrorCode string `json:"error_code,omitempty"`
	// TranscriptOffset is where Conversation's transcript ended before the
	// send, from which its receipt is observed again.
	TranscriptOffset *int64 `json:"transcript_offset,omitempty"`
}

// liveAttemptRetryAfter is how long an unconfirmed batch waits for its
// conversation before it makes one warning-marked retry to a receiver that is
// still alive, or rolls forward to one that replaced it.
const liveAttemptRetryAfter = 5 * time.Minute

const (
	attemptDelivered = "delivered"
	attemptReleased  = "released"
	attemptAmbiguous = "ambiguous"
)

func batchID(members []string) string {
	sorted := slices.Clone(members)
	slices.Sort(sorted)
	return mailboxKey(strings.Join(sorted, "\x00"))
}

// status is the batch's transport outcome so far; a send not yet answered
// is unknown.
func (a *Attempt) status() string {
	if a.Receipt == nil || a.Receipt.Status == "" {
		return StatusUnknown
	}
	return a.Receipt.Status
}

// sendError is the error an unconfirmed batch answers with on every pass.
func (a *Attempt) sendError() error {
	switch {
	case a.Receipt == nil:
		return errCode("ambiguous_delivery", "batch delivery outcome is unknown")
	case a.ErrorCode != "":
		return errCode(a.ErrorCode, "batch delivery: %s", a.Receipt.Detail)
	}
	return errCode("unconfirmed", "batch delivery: %s", a.status())
}

func batchManifest(root string, a *Attempt) string {
	return filepath.Join(root, "batches", a.BatchID+".json")
}

// writeBatch records the batch's manifest.
func writeBatch(root string, a *Attempt) error {
	bytes, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if err := ensureDir(filepath.Join(root, "batches"), 0700); err != nil {
		return err
	}
	return mailboxWrite(batchManifest(root, a), bytes, false)
}

// readBatchManifests reads every open batch's manifest. A manifest removed
// while the directory is read is left out.
func readBatchManifests(root string) ([]Attempt, error) {
	dir := filepath.Join(root, "batches")
	files, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var batches []Attempt
	for _, file := range files {
		if file.IsDir() || strings.HasPrefix(file.Name(), ".") || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		bytes, err := readBounded(filepath.Join(dir, file.Name()), 512<<10)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		var a Attempt
		if err == nil {
			err = json.Unmarshal(bytes, &a)
		}
		if err != nil {
			return nil, err
		}
		batches = append(batches, a)
	}
	return batches, nil
}

// pinnedBy maps each pinned entry's id to the open batch that holds it.
func pinnedBy(root string) (map[string]*Attempt, error) {
	batches, err := readBatchManifests(root)
	pinned := map[string]*Attempt{}
	for i := range batches {
		for _, id := range batches[i].Members {
			pinned[id] = &batches[i]
		}
	}
	return pinned, err
}

// claimBatch records a hook's claim of the entries at paths for conversation
// under the inbox lock. A claim left open belongs to a hook that died between
// its output and its close; the next reader closes it ambiguous.
func claimBatch(root string, items []mailboxPendingItem, conversation string) (Attempt, error) {
	members := make([]string, len(items))
	for i, it := range items {
		members[i] = it.entry.Request.MessageID
	}
	a := Attempt{Hook: true, BatchID: batchID(members), Conversation: conversation, Epoch: receiverEpoch(root, conversation), Members: members, OpenedAt: time.Now().UnixNano()}
	return a, writeBatch(root, &a)
}

// closeBatch records outcome in the batch's manifest, settles its pending
// members and removes the manifest. A delivered member moves to offered/ with
// the modification time it had pending. A released or ambiguous one stays
// pending, marked possible_repeat when the batch may have reached a
// conversation: an ambiguous close, or a release after a retry or roll-forward
// of an unconfirmed send.
func closeBatch(root string, a *Attempt, outcome string) error {
	a.Outcome = outcome
	if err := writeBatch(root, a); err != nil {
		return err
	}
	repeat := outcome == attemptAmbiguous || (outcome == attemptReleased && (a.Variant == "retry-1" || a.Variant == "possible-repeat"))
	offered := filepath.Join(root, "offered")
	if outcome == attemptDelivered {
		if err := ensureDir(offered, 0700); err != nil {
			return err
		}
	}
	for _, id := range a.Members {
		path := filepath.Join(root, "pending", mailboxKey(id)+".json")
		switch {
		case outcome == attemptDelivered:
			err := os.Rename(path, filepath.Join(offered, filepath.Base(path)))
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		case repeat:
			e, err := readFiberMailboxEntry(path)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			e.PossibleRepeat = true
			if err := writeMailboxEntry(path, e); err != nil {
				return err
			}
		}
	}
	if outcome == attemptDelivered {
		if err := errors.Join(syncDir(filepath.Join(root, "pending")), syncDir(offered)); err != nil {
			return err
		}
	}
	if err := os.Remove(batchManifest(root, a)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(filepath.Join(root, "batches"))
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
