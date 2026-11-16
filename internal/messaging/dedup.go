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

	"github.com/cailmdaley/felt/internal/sysenv"
)

// record is a session-addressed send's messages/ receipt: reserved before the
// side effect, complete with the transport's answer after it.
type record struct {
	Hash         string  `json:"hash"`
	State        string  `json:"state"`
	Receipt      Receipt `json:"receipt"`
	ErrorCode    string  `json:"error_code,omitempty"`
	ErrorMessage string  `json:"error_message,omitempty"`
	Nonce        string  `json:"nonce,omitempty"`
}

// requestHash identifies a request across retries.
func requestHash(r Request) string {
	b, _ := json.Marshal(struct {
		Address, Text, From string
		Wake                bool
		Attachments         []Attachment `json:"attachments,omitempty"`
		ReplyTo             string       `json:"reply_to,omitempty"`
		NotifyAddress       string       `json:"notify_address,omitempty"`
		NotifyWhenIdle      bool         `json:"notify_when_idle,omitempty"`
		NotifyWake          bool         `json:"notify_wake,omitempty"`
		IdleOnly            bool         `json:"idle_only,omitempty"`
	}{r.Address, r.Text, r.From, r.Wake, r.Attachments, r.ReplyTo, r.NotifyAddress, r.NotifyWhenIdle, r.NotifyWake, r.IdleOnly})
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

// withDedup runs send at most once per message_id. It exclusively creates a
// reservation before the side effect and records the receipt after it. A
// replay answers the stored receipt; a reservation without one answers
// ambiguous_delivery at once, since its send may have happened; and a
// different request under the same id is a message_id_conflict.
func withDedup(ctx context.Context, env *sysenv.Env, req Request, send func(context.Context) (Receipt, error)) (Receipt, error) {
	dir := filepath.Join(dataDir(env), "messages")
	if err := ensureDir(dir, 0700); err != nil {
		return Receipt{}, errCode("dedup_unavailable", "cannot create message store: %v", err)
	}
	path := filepath.Join(dir, mailboxKey(req.MessageID)+".json")
	hash := requestHash(req)
	nonce, err := newReservationNonce()
	if err != nil {
		return Receipt{}, errCode("dedup_unavailable", "cannot create reservation nonce: %v", err)
	}
	// The reservation is published whole, by a hard link, so no reader sees a
	// partial one; the nonce tells a network filesystem's link replay from a
	// competing sender's reservation.
	for {
		owned, err := reserveDedupRecord(path, record{Hash: hash, State: "reserved", Nonce: nonce}, mailboxWriteReservation)
		if errors.Is(err, os.ErrExist) {
			old, err := readDedupRecord(path)
			if errors.Is(err, os.ErrNotExist) {
				// Its owner's preflight failed and released it.
				continue
			}
			if err != nil {
				return Receipt{}, errCode("dedup_unavailable", "cannot read message record: %v", err)
			}
			return replay(req, hash, old)
		}
		if err != nil {
			return Receipt{}, errCode("dedup_unavailable", "cannot reserve message_id: %v", err)
		}
		if !owned {
			return Receipt{}, errCode("dedup_unavailable", "message reservation was not published")
		}
		break
	}
	receipt, sendErr := send(ctx)
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
	stored := record{Hash: hash, State: "complete", Receipt: receipt}
	if sendErr != nil {
		stored.ErrorCode, stored.ErrorMessage = ErrorCode(sendErr), sendErr.Error()
	}
	b, err := json.Marshal(stored)
	if err == nil {
		err = mailboxWrite(path, b, false)
	}
	if err != nil {
		return receipt, errCode("dedup_unavailable", "delivery completed but receipt could not be saved: %v", err)
	}
	return receipt, sendErr
}

// replay answers a send whose message_id already has a record.
func replay(req Request, hash string, old record) (Receipt, error) {
	switch {
	case old.Hash != "" && old.Hash != hash:
		return rejected(req, "dedup", "message_id was already used for a different request"), errCode("message_id_conflict", "message_id was already used for a different request")
	case old.Hash != "" && old.State == "complete":
		if old.ErrorCode != "" {
			return old.Receipt, &Error{Code: old.ErrorCode, Message: old.ErrorMessage}
		}
		return old.Receipt, nil
	}
	return unrecordedDelivery(req)
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

// unrecordedDelivery answers a message_id whose earlier delivery has no
// recorded outcome: it is still running, or stopped mid-delivery.
func unrecordedDelivery(req Request) (Receipt, error) {
	const detail = "an earlier delivery of this message_id has no recorded outcome; it may or may not have been delivered"
	return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "dedup", Detail: detail}, errCode("ambiguous_delivery", "%s; refusing to resend", detail)
}
