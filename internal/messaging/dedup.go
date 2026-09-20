package messaging

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type record struct {
	Hash         string  `json:"hash"`
	State        string  `json:"state"`
	Receipt      Receipt `json:"receipt"`
	ErrorCode    string  `json:"error_code,omitempty"`
	ErrorMessage string  `json:"error_message,omitempty"`
}

func requestHash(r Request) string {
	b, _ := json.Marshal(struct {
		Address, Text, From string
		Wake                bool
	}{r.Address, r.Text, r.From, r.Wake})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func withDedup(ctx context.Context, req Request, send func() (Receipt, error)) (Receipt, error) {
	dir := filepath.Join(dataDir(), "messages")
	if err := ensureDir(dir, 0700); err != nil {
		return Receipt{}, errCode("dedup_unavailable", "cannot create message store: %v", err)
	}
	nameHash := sha256.Sum256([]byte(req.MessageID))
	path := filepath.Join(dir, hex.EncodeToString(nameHash[:])+".json")
	hash := requestHash(req)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		b, readErr := mailboxRead(path, 2<<20)
		if readErr != nil {
			return Receipt{}, errCode("dedup_unavailable", "cannot read message record: %v", readErr)
		}
		var old record
		if json.Unmarshal(b, &old) != nil || old.Hash == "" {
			return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "dedup", Detail: "message record is incomplete"}, errCode("ambiguous_delivery", "message record is incomplete; refusing to resend")
		}
		if old.Hash != hash {
			return rejected(req, "dedup", "message_id was already used for a different request"), errCode("message_id_conflict", "message_id was already used for a different request")
		}
		if old.State == "complete" {
			if old.ErrorCode != "" {
				return old.Receipt, &Error{Code: old.ErrorCode, Message: old.ErrorMessage}
			}
			return old.Receipt, nil
		}
		return Receipt{MessageID: req.MessageID, Address: req.Address, Status: StatusUnknown, Transport: "dedup", Detail: "delivery may have been attempted"}, errCode("ambiguous_delivery", "delivery may have been attempted; refusing to resend")
	}
	if err != nil {
		return Receipt{}, errCode("dedup_unavailable", "cannot reserve message_id: %v", err)
	}
	enc := json.NewEncoder(f)
	if err := enc.Encode(record{Hash: hash, State: "reserved"}); err != nil {
		f.Close()
		_ = os.Remove(path)
		_ = syncDir(dir)
		return Receipt{}, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		_ = os.Remove(path)
		_ = syncDir(dir)
		return Receipt{}, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		_ = syncDir(dir)
		return Receipt{}, err
	}
	if err := syncDir(dir); err != nil {
		return Receipt{}, errCode("dedup_unavailable", "cannot persist message reservation: %v", err)
	}

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
