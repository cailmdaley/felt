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

// dedupOptions tunes how a duplicate sender waits on a live reservation and
// how the reservation is published. The zero value is the production policy;
// tests shorten the wait, observe it, or substitute the reservation writer.
type dedupOptions struct {
	timeout      time.Duration
	pollInterval time.Duration
	onWait       func()
	reserve      func(string, []byte) (bool, error)
}

// withDedup runs send at most once per message_id: a replay returns the stored
// receipt, a concurrent duplicate waits for the live owner, and a different
// request under the same id is rejected.
func withDedup(ctx context.Context, req Request, send func(context.Context) dedupSendResult) (Receipt, error) {
	return dedupOptions{}.run(ctx, req, send)
}

func (o dedupOptions) run(ctx context.Context, req Request, send func(context.Context) dedupSendResult) (Receipt, error) {
	if o.timeout <= 0 {
		o.timeout = duplicateWaitTimeout
	}
	if o.pollInterval <= 0 {
		o.pollInterval = duplicatePollInterval
	}
	if o.reserve == nil {
		o.reserve = mailboxWriteReservation
	}
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
	// would let a concurrent duplicate mistake the brief write window for an
	// ownerless record. The nonce distinguishes an NFS link replay from a
	// competing sender's reservation.
	for {
		owned, err := reserveDedupRecord(path, reservation, o.reserve)
		if errors.Is(err, os.ErrExist) {
			receipt, readErr, retry := duplicateResult(ctx, req, path, hash, o)
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

// updateReservationOwnerDeadline republishes the owner's deadline so a waiting
// duplicate extends its wait to cover the transport's observation window.
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

// duplicateResult resolves a sender that found its message_id already
// reserved. While a live owner holds the reservation it polls until the
// owner's published deadline (plus a margin) or ctx ends. It returns
// retry=true only when the reservation disappeared, which happens when its
// owner reports a preflight failure.
func duplicateResult(ctx context.Context, req Request, path, hash string, o dedupOptions) (Receipt, error, bool) {
	var ownerDeadlineStamp int64
	var deadline time.Time
	for waited := false; ; waited = true {
		if waited {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				receipt, waitErr := inProgress(req)
				return receipt, waitErr, false
			}
			timer := time.NewTimer(min(o.pollInterval, remaining))
			select {
			case <-ctx.Done():
				timer.Stop()
				receipt, waitErr := inProgress(req)
				return receipt, waitErr, false
			case <-timer.C:
			}
		}

		old, err := readDedupRecord(path)
		var receipt Receipt
		switch {
		case errors.Is(err, os.ErrNotExist):
			return Receipt{}, nil, true
		case err != nil:
			return Receipt{}, errCode("dedup_unavailable", "cannot read message record: %v", err), false
		case old.Hash == "":
			receipt, err = incompleteRecord(req)
		case old.Hash != hash:
			receipt, err = rejected(req, "dedup", "message_id was already used for a different request"), errCode("message_id_conflict", "message_id was already used for a different request")
		case old.State == "complete":
			receipt, err = storedResult(refreshCompletedClaudeReceipt(ctx, req, path, hash, old))
		case old.State != "reserved" || old.OwnerPID <= 0:
			receipt, err = ownerlessRecord(req)
		case !processAlive(old.OwnerPID, old.OwnerStart):
			receipt, err = stoppedAttempt(req)
		default:
			// A live owner: arm the wait, and follow a deadline it republishes.
			if !waited || (old.OwnerDeadlineUnixNano > 0 && old.OwnerDeadlineUnixNano != ownerDeadlineStamp) {
				ownerDeadlineStamp = old.OwnerDeadlineUnixNano
				deadline = capDedupWaitDeadline(ctx, duplicateOwnerWaitDeadline(ownerDeadlineStamp, o.timeout))
			}
			if !waited && o.onWait != nil {
				o.onWait()
			}
			continue
		}
		return receipt, err, false
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
	b, err := readBounded(path, 2<<20)
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

// ownerlessRecord answers a record that is neither complete nor a reservation
// with a recorded owner process, so no live sender can be waited on.
func ownerlessRecord(req Request) (Receipt, error) {
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
