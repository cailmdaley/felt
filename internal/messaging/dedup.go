package messaging

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

type record struct {
	Hash                   string  `json:"hash"`
	State                  string  `json:"state"`
	Receipt                Receipt `json:"receipt"`
	ErrorCode              string  `json:"error_code,omitempty"`
	ErrorMessage           string  `json:"error_message,omitempty"`
	OwnerPID               int     `json:"owner_pid,omitempty"`
	OwnerStart             string  `json:"owner_start_time,omitempty"`
	OwnerDeadlineUnixNano  int64   `json:"owner_deadline_unix_nano,omitempty"`
	Nonce                  string  `json:"nonce,omitempty"`
	TranscriptOffset       *int64  `json:"transcript_offset,omitempty"`
	ClaudeQueueContentHash string  `json:"claude_queue_content_hash,omitempty"`
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

func newReservationNonce() (string, error) {
	var nonce [16]byte
	if _, err := cryptorand.Read(nonce[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(nonce[:]), nil
}

func reserveDedupRecord(path string, reservation record, write func(string, []byte) (bool, error)) (bool, error) {
	b, err := json.Marshal(reservation)
	if err != nil {
		return false, err
	}
	linked, err := write(path, b)
	if err == nil {
		return linked, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return false, err
	}
	// A network filesystem can complete link(2), lose its reply, then report
	// EEXIST when the caller retransmits. Only our unguessable nonce proves the
	// reservation at this path came from this attempt.
	old, readErr := readDedupRecord(path)
	if readErr == nil && old.State == "reserved" && old.Hash == reservation.Hash && old.Nonce == reservation.Nonce {
		return true, nil
	}
	return false, err
}

type reservationDeadlinePublisherKey struct{}

func publishOwnerDeadline(ctx context.Context, deadline time.Time) error {
	publish, _ := ctx.Value(reservationDeadlinePublisherKey{}).(func(time.Time) error)
	if publish == nil {
		return nil
	}
	return publish(deadline)
}

// The reservation starts with its owner-context deadline; transports publish
// narrower RPC or observation deadlines before their side effects. The 28s
// ceiling plus the 1.5s waiter margin fits the 32s local shell-out timeout.
const (
	duplicateWaitTimeout       = 15 * time.Second
	duplicatePollInterval      = 150 * time.Millisecond
	duplicateWaitMargin        = 1500 * time.Millisecond
	reservationDeadlineCeiling = 28 * time.Second
)

type dedupMetadata struct {
	ClaudeTranscriptOffset *int64
	ClaudeQueueContentHash string
}

type dedupSendResult struct {
	Receipt  Receipt
	Err      error
	Metadata dedupMetadata
}

type claudeReceiptRefresh struct {
	Receipt      Receipt
	ErrorCode    string
	ErrorMessage string
}

func withDedup(ctx context.Context, req Request, send func() (Receipt, error)) (Receipt, error) {
	return withDedupTiming(ctx, req, send, duplicateWaitTimeout, duplicatePollInterval, nil)
}

func withDedupDetailed(ctx context.Context, req Request, send func(context.Context) dedupSendResult) (Receipt, error) {
	return withDedupDetailedTiming(ctx, req, send, duplicateWaitTimeout, duplicatePollInterval, nil)
}

// withDedupTimeout permits tests to exercise the bounded wait without waiting
// for the production timeout.
func withDedupTimeout(ctx context.Context, req Request, send func() (Receipt, error), timeout time.Duration) (Receipt, error) {
	return withDedupTiming(ctx, req, send, timeout, duplicatePollInterval, nil)
}

func withDedupTiming(ctx context.Context, req Request, send func() (Receipt, error), timeout, pollInterval time.Duration, onWait func()) (Receipt, error) {
	return withDedupDetailedTiming(ctx, req, func(context.Context) dedupSendResult {
		receipt, err := send()
		return dedupSendResult{Receipt: receipt, Err: err}
	}, timeout, pollInterval, onWait)
}

func withDedupDetailedTiming(ctx context.Context, req Request, send func(context.Context) dedupSendResult, timeout, pollInterval time.Duration, onWait func()) (Receipt, error) {
	return withDedupDetailedTimingUsing(ctx, req, send, timeout, pollInterval, onWait, mailboxWriteReservation)
}

func withDedupDetailedTimingUsing(ctx context.Context, req Request, send func(context.Context) dedupSendResult, timeout, pollInterval time.Duration, onWait func(), reserve func(string, []byte) (bool, error)) (Receipt, error) {
	dir := filepath.Join(dataDir(), "messages")
	if err := ensureDir(dir, 0700); err != nil {
		return Receipt{}, errCode("dedup_unavailable", "cannot create message store: %v", err)
	}
	nameHash := sha256.Sum256([]byte(req.MessageID))
	path := filepath.Join(dir, hex.EncodeToString(nameHash[:])+".json")
	hash := requestHash(req)

	ownerDeadline := time.Now().Add(reservationDeadlineCeiling)
	if ctxDeadline, ok := ctx.Deadline(); ok {
		ownerDeadline = ctxDeadline
	}
	ownerCtx, cancelOwner := context.WithDeadline(ctx, ownerDeadline)
	defer cancelOwner()

	nonce, err := newReservationNonce()
	if err != nil {
		return Receipt{}, errCode("dedup_unavailable", "cannot create reservation nonce: %v", err)
	}
	reservation := record{
		Hash:                  hash,
		State:                 "reserved",
		OwnerPID:              os.Getpid(),
		OwnerStart:            currentProcessStartTime(),
		OwnerDeadlineUnixNano: ownerDeadline.UnixNano(),
		Nonce:                 nonce,
	}
	// Publish a complete reservation atomically: an O_EXCL-created empty file
	// would let a concurrent duplicate mistake the brief write window for a
	// malformed, legacy record. The nonce distinguishes an NFS link replay from
	// a competing sender's reservation.
	for {
		owned, err := reserveDedupRecord(path, reservation, reserve)
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
		if !owned {
			return Receipt{}, errCode("dedup_unavailable", "message reservation was not published")
		}
		return sendReserved(ownerCtx, dir, path, hash, req, nonce, send)
	}
}

func sendReserved(ctx context.Context, dir, path, hash string, req Request, nonce string, send func(context.Context) dedupSendResult) (Receipt, error) {
	ownerCtx := context.WithValue(ctx, reservationDeadlinePublisherKey{}, func(deadline time.Time) error {
		return updateReservationOwnerDeadline(path, hash, nonce, deadline)
	})
	result := send(ownerCtx)
	receipt, sendErr := result.Receipt, result.Err
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
	metadata := result.Metadata
	if receipt.Transport != claudeNativeTransport || (receipt.Status != StatusQueued && receipt.Status != StatusSubmitted && receipt.Status != StatusUnknown) {
		metadata = dedupMetadata{}
	}
	stored := record{
		Hash:                   hash,
		State:                  "complete",
		Receipt:                receipt,
		TranscriptOffset:       metadata.ClaudeTranscriptOffset,
		ClaudeQueueContentHash: metadata.ClaudeQueueContentHash,
	}
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
func updateReservationOwnerDeadline(path, hash, nonce string, deadline time.Time) error {
	old, err := readDedupRecord(path)
	if err != nil {
		return err
	}
	if old.State != "reserved" || old.Hash != hash || old.Nonce != nonce {
		return errCode("dedup_unavailable", "message reservation changed before observation began")
	}
	old.OwnerDeadlineUnixNano = deadline.UnixNano()
	b, err := json.Marshal(old)
	if err != nil {
		return err
	}
	if err := mailboxWrite(path, b, false); err != nil {
		current, readErr := readDedupRecord(path)
		if readErr == nil && current.State == "reserved" && current.Hash == hash && current.Nonce == nonce && current.OwnerDeadlineUnixNano == deadline.UnixNano() {
			return nil
		}
		return err
	}
	return nil
}

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
		old = refreshCompletedClaudeReceipt(ctx, req, path, hash, old)
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

	ownerDeadlineStamp := old.OwnerDeadlineUnixNano
	ownerDeadline := duplicateOwnerWaitDeadline(ownerDeadlineStamp, timeout)
	deadline := capDedupWaitDeadline(ctx, ownerDeadline)
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
			old = refreshCompletedClaudeReceipt(ctx, req, path, hash, old)
			receipt, storedErr := storedResult(old)
			return receipt, storedErr, false
		}
		if old.OwnerDeadlineUnixNano > 0 && old.OwnerDeadlineUnixNano != ownerDeadlineStamp {
			ownerDeadlineStamp = old.OwnerDeadlineUnixNano
			ownerDeadline = time.Unix(0, ownerDeadlineStamp).Add(duplicateWaitMargin)
			deadline = capDedupWaitDeadline(ctx, ownerDeadline)
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

func duplicateOwnerWaitDeadline(ownerDeadlineUnixNano int64, fallback time.Duration) time.Time {
	if ownerDeadlineUnixNano > 0 {
		return time.Unix(0, ownerDeadlineUnixNano).Add(duplicateWaitMargin)
	}
	return time.Now().Add(fallback)
}

func capDedupWaitDeadline(ctx context.Context, deadline time.Time) time.Time {
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		return ctxDeadline
	}
	return deadline
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

func refreshCompletedClaudeReceipt(ctx context.Context, req Request, path, hash string, old record) record {
	if old.State != "complete" || old.Hash != hash || old.Receipt.Transport != claudeNativeTransport || old.TranscriptOffset == nil || old.ClaudeQueueContentHash == "" || (old.Receipt.Status != StatusQueued && old.Receipt.Status != StatusSubmitted && old.Receipt.Status != StatusUnknown) {
		return old
	}
	candidate, ok := refreshClaudeNativeReceipt(ctx, req, old)
	if !ok {
		return old
	}

	// One stable lock per messages directory avoids a sidecar for every message.
	lock, err := os.OpenFile(filepath.Join(filepath.Dir(path), ".refresh.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return mergeClaudeReceiptRefresh(old, candidate)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if current, readErr := readDedupRecord(path); readErr == nil && current.Hash == hash && current.State == "complete" {
			return mergeClaudeReceiptRefresh(current, candidate)
		}
		return mergeClaudeReceiptRefresh(old, candidate)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	current, err := readDedupRecord(path)
	if err != nil || current.Hash != hash || current.State != "complete" {
		return mergeClaudeReceiptRefresh(old, candidate)
	}
	upgraded, changed := mergeClaudeReceiptRefreshWithChange(current, candidate)
	if !changed {
		return current
	}
	b, err := json.Marshal(upgraded)
	if err == nil {
		_ = mailboxWrite(path, b, false)
	}
	return upgraded
}

func mergeClaudeReceiptRefresh(current record, candidate claudeReceiptRefresh) record {
	merged, _ := mergeClaudeReceiptRefreshWithChange(current, candidate)
	return merged
}

func mergeClaudeReceiptRefreshWithChange(current record, candidate claudeReceiptRefresh) (record, bool) {
	if current.Receipt.Status == StatusAccepted {
		return current, false
	}
	if current.ErrorCode == "receiver_turn_failed" && candidate.ErrorCode != "receiver_turn_failed" {
		return current, false
	}
	if candidate.ErrorCode == "receiver_turn_failed" {
		if current.Receipt.Status == StatusUnknown && current.ErrorCode == candidate.ErrorCode && current.ErrorMessage == candidate.ErrorMessage && current.Receipt.Detail == candidate.Receipt.Detail {
			return current, false
		}
	} else if claudeStageRank(candidate.Receipt.Status) <= claudeStageRank(current.Receipt.Status) {
		return current, false
	}
	current.Receipt = candidate.Receipt
	current.ErrorCode = candidate.ErrorCode
	current.ErrorMessage = candidate.ErrorMessage
	return current, true
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
