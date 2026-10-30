package messaging

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// DeliveredEnvelope binds the exact delivered text to its receiving conversation.
// Readers use the whole envelope as the boundary, including any quoted headers.
type DeliveredEnvelope struct {
	ID       string `json:"id"`
	Envelope string `json:"envelope"`
	Thread   bool   `json:"thread,omitempty"`
}

func envelopeDir(env *sysenv.Env, session string) string {
	return filepath.Join(dataDir(env), "message-envelopes", mailboxKey(session))
}

func recordEnvelope(env *sysenv.Env, session string, request Request) error {
	pruneEnvelopeSessions(env, time.Now())
	dir := envelopeDir(env, session)
	if err := ensureDir(dir, 0700); err != nil {
		return err
	}
	entry := DeliveredEnvelope{ID: request.MessageID, Envelope: Labeled(request), Thread: request.threadSignalVerified}
	bytes, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return mailboxWrite(filepath.Join(dir, mailboxKey(request.MessageID)+".json"), bytes, false)
}

// DeliveredEnvelopes reads only evidence belonging to session. Retained session
// mailbox payloads also supply exact delivery evidence.
// A dedup receipt alone cannot establish a message's sender or body.
func DeliveredEnvelopes(env *sysenv.Env, session string) ([]DeliveredEnvelope, error) {
	return DeliveredEnvelopesSince(env, session, time.Time{})
}

// DeliveredEnvelopesSince reads envelopes changed since the caller's watermark.
// Retention follows the board's fourteen-day window.
func DeliveredEnvelopesSince(env *sysenv.Env, session string, since time.Time) ([]DeliveredEnvelope, error) {
	if session == "" || len(session) > 4096 || hasControl(session) {
		return nil, errCode("invalid_request", "invalid envelope session")
	}
	cutoff := time.Now().Add(-14 * 24 * time.Hour)
	byID := make(map[string]DeliveredEnvelope)
	dir := envelopeDir(env, session)
	entries, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		if info.ModTime().Before(cutoff) {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			continue
		}
		if info.ModTime().Before(since) {
			continue
		}
		bytes, err := readBounded(path, 512<<10)
		if err != nil {
			return nil, err
		}
		var envelope DeliveredEnvelope
		if json.Unmarshal(bytes, &envelope) != nil || envelope.ID == "" || envelope.Envelope == "" || entry.Name() != mailboxKey(envelope.ID)+".json" {
			return nil, errCode("invalid_record", "invalid delivered envelope record")
		}
		byID[envelope.ID] = envelope
	}
	for _, harness := range []string{"claude", "codex", "pi"} {
		offered := filepath.Join(mailboxDir(env, harness, session), "offered")
		entries, err := os.ReadDir(offered)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return nil, err
			}
			if info.ModTime().Before(cutoff) || info.ModTime().Before(since) {
				continue
			}
			bytes, err := readBounded(filepath.Join(offered, entry.Name()), 512<<10)
			if err != nil {
				return nil, err
			}
			var stored mailboxEntry
			if json.Unmarshal(bytes, &stored) != nil {
				continue
			}
			r := stored.Request
			address, err := ParseAddress(r.Address)
			if err != nil || address.ID != session || address.Harness != harness || r.MessageID == "" {
				continue
			}
			if _, exists := byID[r.MessageID]; !exists {
				byID[r.MessageID] = DeliveredEnvelope{ID: r.MessageID, Envelope: Labeled(r)}
			}
		}
	}
	result := make([]DeliveredEnvelope, 0, len(byID))
	for _, envelope := range byID {
		result = append(result, envelope)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}

// pruneEnvelopeSessions removes inactive conversations when new evidence arrives.
// Active conversations prune individual records during incremental reads.
func pruneEnvelopeSessions(env *sysenv.Env, now time.Time) {
	root := filepath.Join(dataDir(env), "message-envelopes")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	cutoff := now.Add(-14 * 24 * time.Hour)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.ModTime().Before(cutoff) {
			dir := filepath.Join(root, entry.Name())
			files, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, file := range files {
				if !file.Type().IsRegular() || !strings.HasSuffix(file.Name(), ".json") {
					continue
				}
				info, err := file.Info()
				if err == nil && info.ModTime().Before(cutoff) {
					_ = os.Remove(filepath.Join(dir, file.Name()))
				}
			}
			_ = os.Remove(dir)
		}
	}
}
