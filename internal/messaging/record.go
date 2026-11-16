package messaging

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// A record is a line the daemon transports itself, as typed input or in a
// launch prompt: the human's typed lines, and an agent's request for a fresh
// session. It is written straight to the fiber inbox's offered/, so no reader
// ever offers it to a worker, and its id deduplicates a retried submission.
// Its disposition says what became of the transport: unknown until settled,
// then delivered, undeliverable (it never reached a worker), or unknown (it
// may have).

// BeginRecord records a line from sender before the daemon transports it,
// answering whether this call may transport it and the record's disposition.
// Only the call that writes the record may; a repeated id answers false with
// the stored disposition, unless its record was settled undeliverable, which
// may be submitted again except for voice (a spoken id never pastes twice). Text over the inbox limit is recorded cut short; the
// transport carries it whole.
func BeginRecord(env *sysenv.Env, address, id, from, text string, sources ...string) (bool, string, error) {
	root, err := inboxRoot(env, address)
	if err != nil {
		return false, "", err
	}
	unlock, err := lockInbox(root)
	if err != nil {
		return false, "", err
	}
	defer unlock()
	path := recordPath(root, id)
	stored, err := readFiberMailboxEntry(path)
	if err == nil && (stored.Disposition != "undeliverable" || stored.Wishes.Source == "voice") {
		return false, stored.Disposition, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, "", err
	}
	if err := ensureDir(filepath.Dir(path), 0700); err != nil {
		return false, "", err
	}
	source := "message"
	if from == "human" {
		source = "human"
	}
	if len(sources) > 0 && sources[0] != "" {
		source = sources[0]
	}
	if source != "message" && source != "human" && source != "voice" && source != "pulse" {
		return false, "", errCode("invalid_request", "invalid record source")
	}
	b, err := json.Marshal(mailboxEntry{
		Request:     Request{MessageID: id, Text: boundedInboxText(text), From: from},
		Wishes:      Wishes{Source: source, Turn: "none"},
		QueuedAt:    time.Now().UnixNano(),
		Disposition: "unknown",
	})
	if err != nil {
		return false, "", err
	}
	return true, "unknown", mailboxWrite(path, b, false)
}

// SettleRecord records the transport's outcome on a record.
func SettleRecord(env *sysenv.Env, address, id, outcome string) error {
	if outcome != "unknown" && outcome != "delivered" && outcome != "undeliverable" {
		return errCode("invalid_request", "invalid record outcome")
	}
	root, err := inboxRoot(env, address)
	if err != nil {
		return err
	}
	unlock, err := lockInbox(root)
	if err != nil {
		return err
	}
	defer unlock()
	path := recordPath(root, id)
	e, err := readFiberMailboxEntry(path)
	if err != nil {
		return err
	}
	if e.Disposition == "" {
		return errCode("invalid_request", "not a record")
	}
	e.Disposition = outcome
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return mailboxWrite(path, b, false)
}

func recordPath(root, id string) string {
	return filepath.Join(root, "offered", mailboxKey(id)+".json")
}

// HumanRecordFor names the human record whose line a session's prompt is: a
// record of the human's, written to a fiber inbox linked to the session within
// the last window, with the same text. The prompt hook writes its board row
// under that record's identity, so a line the daemon typed into the session
// keeps the one row the daemon wrote for it. It answers "" for a line typed in
// the terminal.
func HumanRecordFor(env *sysenv.Env, harness, id, host, prompt string, window time.Duration) string {
	links, err := os.ReadDir(filepath.Join(mailboxDir(env, harness, id), "fibers"))
	if err != nil {
		return ""
	}
	text := strings.TrimSpace(boundedInboxText(strings.TrimSpace(prompt)))
	since := time.Now().Add(-window)
	newest, found := int64(0), ""
	for _, linkFile := range links {
		bytes, err := readBounded(filepath.Join(mailboxDir(env, harness, id), "fibers", linkFile.Name()), 16384)
		var link fiberMailboxLink
		if err != nil || json.Unmarshal(bytes, &link) != nil || link.Fiber == "" || link.Host != host {
			continue
		}
		offered := filepath.Join(mailboxDir(env, "fiber", link.Fiber), "offered")
		files, err := os.ReadDir(offered)
		if err != nil {
			continue
		}
		for _, file := range files {
			info, err := file.Info()
			if err != nil || info.ModTime().Before(since) {
				continue
			}
			e, err := readFiberMailboxEntry(filepath.Join(offered, file.Name()))
			if err != nil || (e.Wishes.Source != "human" && e.Wishes.Source != "voice") || e.Disposition == "" || e.QueuedAt < since.UnixNano() || e.QueuedAt <= newest {
				continue
			}
			if strings.TrimSpace(e.Request.Text) == text {
				newest, found = e.QueuedAt, e.Request.MessageID
			}
		}
	}
	return found
}

// boundedInboxText cuts text over the inbox's 64 KiB limit short: its first
// 60,000 bytes, ending on a whole character, as the daemon captures a result
// whose outcome is that long. A record's text is cut the same way, while its
// transport carries the line whole.
func boundedInboxText(text string) string {
	if len(text) <= 64<<10 {
		return text
	}
	cut := text[:60_000]
	for !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + " … (truncated)"
}
