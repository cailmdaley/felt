package messaging

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type record struct {
	Hash         string  `json:"hash"`
	State        string  `json:"state"`
	Receipt      Receipt `json:"receipt"`
	ErrorCode    string  `json:"error_code,omitempty"`
	ErrorMessage string  `json:"error_message,omitempty"`
	OwnerPID     int     `json:"owner_pid,omitempty"`
	OwnerStart   string  `json:"owner_start_time,omitempty"`
}

func requestHash(r Request) string {
	b, _ := json.Marshal(struct {
		Address, Text, From string
		Wake                bool
		Attachments         []Attachment `json:"attachments,omitempty"`
	}{r.Address, r.Text, r.From, r.Wake, r.Attachments})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

const (
	duplicateWaitTimeout  = 15 * time.Second
	duplicatePollInterval = 150 * time.Millisecond
)

func withDedup(ctx context.Context, req Request, send func() (Receipt, error)) (Receipt, error) {
	return withDedupTiming(ctx, req, send, duplicateWaitTimeout, duplicatePollInterval, nil)
}

// withDedupTimeout permits tests to exercise the bounded wait without waiting
// for the production timeout.
func withDedupTimeout(ctx context.Context, req Request, send func() (Receipt, error), timeout time.Duration) (Receipt, error) {
	return withDedupTiming(ctx, req, send, timeout, duplicatePollInterval, nil)
}

func withDedupTiming(ctx context.Context, req Request, send func() (Receipt, error), timeout, pollInterval time.Duration, onWait func()) (Receipt, error) {
	dir := filepath.Join(dataDir(), "messages")
	if err := ensureDir(dir, 0700); err != nil {
		return Receipt{}, errCode("dedup_unavailable", "cannot create message store: %v", err)
	}
	nameHash := sha256.Sum256([]byte(req.MessageID))
	path := filepath.Join(dir, hex.EncodeToString(nameHash[:])+".json")
	hash := requestHash(req)

	reservation := record{Hash: hash, State: "reserved", OwnerPID: os.Getpid(), OwnerStart: currentProcessStartTime()}
	reservationJSON, err := json.Marshal(reservation)
	if err != nil {
		return Receipt{}, err
	}
	// Publish a complete reservation atomically: an O_EXCL-created empty file
	// would let a concurrent duplicate mistake the brief write window for a
	// malformed, legacy record.
	for {
		err := mailboxWrite(path, reservationJSON, true)
		if errors.Is(err, os.ErrExist) {
			receipt, readErr, retry := duplicateResult(ctx, req, path, hash, timeout, pollInterval, onWait)
			if retry {
				continue
			}
			return receipt, readErr
		}
		if err != nil {
			return Receipt{}, errCode("dedup_unavailable", "cannot reserve message_id: %v", err)
		}
		return sendReserved(dir, path, hash, req, send)
	}
}

func sendReserved(dir, path, hash string, req Request, send func() (Receipt, error)) (Receipt, error) {
	receipt, sendErr := send()
	if ErrorCode(sendErr) == "preflight_failed" {
		// No bytes capable of delivering the message were written. Releasing the
		// reservation makes an explicit retry safe.
		_ = os.Remove(path)
		_ = syncDir(dir)
		return receipt, sendErr
	}
	// Once dispatch begins, every result is durable. Unknown is used when the peer
	// may have accepted before a timeout or malformed reply.
	if receipt.MessageID == "" {
		receipt = Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "unknown", Detail: "delivery outcome is unknown"}
	}
	tmp, err := os.CreateTemp(dir, ".receipt-")
	if err != nil {
		return receipt, errCode("dedup_unavailable", "delivery completed but receipt could not be saved: %v", err)
	}
	tmp.Chmod(0600)
	stored := record{Hash: hash, State: "complete", Receipt: receipt}
	if sendErr != nil {
		stored.ErrorCode = ErrorCode(sendErr)
		stored.ErrorMessage = sendErr.Error()
	}
	err = json.NewEncoder(tmp).Encode(stored)
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	} else {
		os.Remove(tmp.Name())
	}
	if err != nil {
		return receipt, errCode("dedup_unavailable", "delivery completed but receipt could not be saved: %v", err)
	}
	if err = syncDir(dir); err != nil {
		return receipt, errCode("dedup_unavailable", "delivery completed but receipt directory could not be synced: %v", err)
	}
	return receipt, sendErr
}

// duplicateResult returns retry=true only when the reservation disappeared,
// which happens when its owner reports a preflight failure.
func duplicateResult(ctx context.Context, req Request, path, hash string, timeout, pollInterval time.Duration, onWait func()) (Receipt, error, bool) {
	old, err := readDedupRecord(path)
	if errors.Is(err, os.ErrNotExist) {
		return Receipt{}, nil, true
	}
	if err != nil {
		return Receipt{}, errCode("dedup_unavailable", "cannot read message record: %v", err), false
	}
	if old.Hash == "" {
		receipt, recordErr := incompleteRecord(req)
		return receipt, recordErr, false
	}
	if old.Hash != hash {
		return rejected(req, "dedup", "message_id was already used for a different request"), errCode("message_id_conflict", "message_id was already used for a different request"), false
	}
	if old.State == "complete" {
		receipt, storedErr := storedResult(old)
		return receipt, storedErr, false
	}
	if old.State != "reserved" || old.OwnerPID <= 0 {
		receipt, ambiguousErr := legacyAmbiguous(req)
		return receipt, ambiguousErr, false
	}
	if !processAlive(old.OwnerPID, old.OwnerStart) {
		receipt, stoppedErr := stoppedAttempt(req)
		return receipt, stoppedErr, false
	}

	deadline := time.Now().Add(timeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if onWait != nil {
		onWait()
	}
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			receipt, waitErr := inProgress(req)
			return receipt, waitErr, false
		}
		interval := pollInterval
		if interval <= 0 || interval > remaining {
			interval = remaining
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			receipt, waitErr := inProgress(req)
			return receipt, waitErr, false
		case <-timer.C:
		}

		old, err = readDedupRecord(path)
		if errors.Is(err, os.ErrNotExist) {
			return Receipt{}, nil, true
		}
		if err != nil {
			return Receipt{}, errCode("dedup_unavailable", "cannot read message record: %v", err), false
		}
		if old.Hash == "" {
			receipt, recordErr := incompleteRecord(req)
			return receipt, recordErr, false
		}
		if old.Hash != hash {
			return rejected(req, "dedup", "message_id was already used for a different request"), errCode("message_id_conflict", "message_id was already used for a different request"), false
		}
		if old.State == "complete" {
			receipt, storedErr := storedResult(old)
			return receipt, storedErr, false
		}
		if old.State != "reserved" || old.OwnerPID <= 0 {
			receipt, ambiguousErr := legacyAmbiguous(req)
			return receipt, ambiguousErr, false
		}
		if !processAlive(old.OwnerPID, old.OwnerStart) {
			receipt, stoppedErr := stoppedAttempt(req)
			return receipt, stoppedErr, false
		}
	}
}

func readDedupRecord(path string) (record, error) {
	b, err := mailboxRead(path, 2<<20)
	if err != nil {
		return record{}, err
	}
	var old record
	if json.Unmarshal(b, &old) != nil {
		return record{}, nil
	}
	return old, nil
}

func storedResult(old record) (Receipt, error) {
	if old.ErrorCode != "" {
		return old.Receipt, &Error{Code: old.ErrorCode, Message: old.ErrorMessage}
	}
	return old.Receipt, nil
}

func incompleteRecord(req Request) (Receipt, error) {
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "dedup", Detail: "message record is incomplete"}, errCode("ambiguous_delivery", "message record is incomplete; refusing to resend")
}

func legacyAmbiguous(req Request) (Receipt, error) {
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "dedup", Detail: "delivery may have been attempted"}, errCode("ambiguous_delivery", "delivery may have been attempted; refusing to resend")
}

func stoppedAttempt(req Request) (Receipt, error) {
	const detail = "a previous attempt stopped mid-delivery; it may or may not have been delivered"
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "dedup", Detail: detail}, errCode("ambiguous_delivery", detail)
}

func inProgress(req Request) (Receipt, error) {
	const detail = "an identical delivery is still in progress; retry with the same message_id"
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "dedup", Detail: detail}, errCode("ambiguous_delivery", detail)
}
