package messaging

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

type senderProofRecord struct {
	Sender         string        `json:"sender"`
	Address        string        `json:"address"`
	Text           string        `json:"text"`
	ReplyTo        string        `json:"reply_to"`
	ID             string        `json:"message_id"`
	Claim          string        `json:"from_claim,omitempty"`
	Wake           bool          `json:"wake"`
	NotifyAddress  string        `json:"notify_address,omitempty"`
	NotifyWhenIdle bool          `json:"notify_when_idle,omitempty"`
	NotifyWake     bool          `json:"notify_wake,omitempty"`
	ThreadSignal   *ThreadSignal `json:"thread_signal,omitempty"`
	Attachments    []Attachment  `json:"attachments,omitempty"`
	Issued         int64         `json:"issued_at"`
}

func proofRecord(request Request) senderProofRecord {
	attachments := request.Attachments
	if len(attachments) == 0 {
		attachments = nil
	}
	return senderProofRecord{
		Sender: request.From, Address: request.Address, Text: request.Text,
		ReplyTo: request.ReplyTo, ID: request.MessageID, Claim: request.FromClaim,
		Wake: request.Wake, NotifyAddress: request.NotifyAddress,
		NotifyWhenIdle: request.NotifyWhenIdle, NotifyWake: request.NotifyWake,
		ThreadSignal: request.ThreadSignal, Attachments: attachments,
	}
}

// CreateSenderProof stores a one-use binding between a locally detected sender
// and the message the CLI is about to submit to its daemon. This handoff
// distinguishes the supported CLI from an unproved HTTP request; it does not
// authenticate against arbitrary code with the same filesystem permissions.
func CreateSenderProof(env *sysenv.Env, request Request) (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw[:])
	bound := proofRecord(request)
	bound.Issued = time.Now().Unix()
	record, err := json.Marshal(bound)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(dataDir(env), "message-sender-proofs")
	if err := ensureDir(dir, 0700); err != nil {
		return "", err
	}
	pruneSenderProofs(dir, time.Now())
	path := filepath.Join(dir, tokenHash(token)+".json")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	_, writeErr := file.Write(record)
	closeErr := file.Close()
	if writeErr != nil {
		_ = os.Remove(path)
		return "", writeErr
	}
	if closeErr != nil {
		_ = os.Remove(path)
		return "", closeErr
	}
	return token, nil
}

// pruneSenderProofs bounds stale proof storage after callers fail to reach the
// daemon. Each creation removes at most 100 expired regular JSON files.
func pruneSenderProofs(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	removed := 0
	for _, entry := range entries {
		if removed == 100 {
			return
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || now.Sub(info.ModTime()) <= 10*time.Minute {
			continue
		}
		if os.Remove(path) == nil {
			removed++
		}
	}
}

// VerifySenderProof validates the sender binding and optionally consumes it.
func VerifySenderProof(env *sysenv.Env, request Request, consume bool) (string, bool, error) {
	if len(request.SenderProof) != 64 {
		return "", false, nil
	}
	if _, err := hex.DecodeString(request.SenderProof); err != nil {
		return "", false, nil
	}
	path := filepath.Join(dataDir(env), "message-sender-proofs", tokenHash(request.SenderProof)+".json")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if consume {
		if err := os.Remove(path); err != nil {
			return "", false, err
		}
	}
	var stored senderProofRecord
	if json.Unmarshal(b, &stored) != nil || stored.Sender == "" || stored.Issued > time.Now().Unix() || time.Since(time.Unix(stored.Issued, 0)) > 10*time.Minute {
		return "", false, nil
	}
	bound := proofRecord(request)
	bound.Issued = stored.Issued
	if !reflect.DeepEqual(stored, bound) {
		return "", false, nil
	}
	return stored.Sender, true, nil
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
