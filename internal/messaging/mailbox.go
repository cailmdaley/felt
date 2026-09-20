package messaging

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Supported harness hook interfaces accept additional context without starting
// a turn. These host-local mailboxes preserve messages until a receiving hook can
// offer them. An offer is not evidence that the model read or acted on it.
type mailboxRegistration struct {
	ID       string `json:"id"`
	Host     string `json:"host"`
	CWD      string `json:"cwd"`
	LastSeen int64  `json:"last_seen"`
}

type mailboxEntry struct {
	Request  Request `json:"request"`
	QueuedAt int64   `json:"queued_at"`
}

func mailboxKey(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func mailboxDir(harness, id string) string {
	return filepath.Join(dataDir(), "mailboxes", harness, mailboxKey(id))
}

// RegisterMailbox is called by the receiver's hooks, never by a sender. A
// SessionEnd withdraws availability without deleting already queued messages.
func RegisterMailbox(harness, id, host, cwd string, active bool) error {
	if harness != "claude" && harness != "codex" {
		return errCode("invalid_request", "unsupported mailbox harness")
	}
	if id == "" || len(id) > 4096 || strings.ContainsAny(id, "\x00\r\n") {
		return errCode("invalid_request", "invalid mailbox session")
	}
	if _, err := os.Stat(dataDir()); err != nil {
		return err
	}
	dir := mailboxDir(harness, id)
	if !active {
		err := os.Remove(filepath.Join(dir, "receiver.json"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		return syncDir(dir)
	}
	if err := ensureDir(dir, 0700); err != nil {
		return err
	}
	b, err := json.Marshal(mailboxRegistration{ID: id, Host: host, CWD: cwd, LastSeen: time.Now().UnixMilli()})
	if err != nil {
		return err
	}
	return mailboxWrite(filepath.Join(dir, "receiver.json"), b, false)
}

func MailboxAvailable(harness, id, host string) bool {
	r, err := mailboxRegistrationFor(harness, id)
	return err == nil && r.ID == id && r.Host == host
}

func mailboxRegistrationFor(harness, id string) (mailboxRegistration, error) {
	b, err := mailboxRead(filepath.Join(mailboxDir(harness, id), "receiver.json"), 16384)
	var r mailboxRegistration
	if err != nil {
		return r, err
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return r, err
	}
	return r, nil
}

func QueueMailbox(a Address, r Request) (Receipt, error) {
	transport := a.Harness + "-hook"
	if (a.Harness != "claude" && a.Harness != "codex") || !MailboxAvailable(a.Harness, a.ID, a.Host) {
		return rejected(r, transport, "session has not registered a Shuttle message hook on this host"), errCode("unavailable", "session has not registered a Shuttle message hook on this host")
	}
	if r.Wake {
		return rejected(r, transport, "hook mailboxes cannot wake a session"), errCode("wake_required", "hook mailboxes cannot wake a session")
	}
	dir := filepath.Join(mailboxDir(a.Harness, a.ID), "pending")
	if err := ensureDir(dir, 0700); err != nil {
		return rejected(r, transport, err.Error()), err
	}
	f, err := os.Open(dir)
	if err != nil {
		return rejected(r, transport, err.Error()), err
	}
	entries, scanErr := f.ReadDir(129)
	f.Close()
	if scanErr != nil && !errors.Is(scanErr, io.EOF) {
		return rejected(r, transport, scanErr.Error()), scanErr
	}
	if len(entries) >= 128 {
		return rejected(r, transport, "mailbox is full"), errCode("queue_full", "mailbox is full")
	}
	b, err := json.Marshal(mailboxEntry{Request: r, QueuedAt: time.Now().UnixNano()})
	if err != nil {
		return rejected(r, transport, err.Error()), err
	}
	path := filepath.Join(dir, mailboxKey(r.MessageID)+".json")
	if err = mailboxWrite(path, b, true); err != nil {
		return rejected(r, transport, err.Error()), err
	}
	return Receipt{MessageID: r.MessageID, Address: r.Address, Status: StatusQueued, Transport: transport, Detail: "queued for the session's next prompt or tool hook; no turn started"}, nil
}

// OfferMailbox serializes concurrent hooks and acknowledges only successful
// writes to the hook's output. A crash between output and acknowledgment can
// repeat a message; its stable message_id lets the receiver recognize it.
// Offered payloads remain host-local for diagnosis and are never copied to git.
func OfferMailbox(harness, id, host string, emit func([]Request) error) error {
	if !MailboxAvailable(harness, id, host) {
		return nil
	}
	dir := mailboxDir(harness, id)
	lock, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	entries, err := os.ReadDir(filepath.Join(dir, "pending"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	type item struct {
		path  string
		entry mailboxEntry
	}
	items := []item{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, "pending", e.Name())
		b, err := mailboxRead(path, 512<<10)
		if err != nil {
			continue
		}
		var entry mailboxEntry
		if json.Unmarshal(b, &entry) != nil || entry.Request.MessageID == "" || len(entry.Request.Text) > 64<<10 {
			continue
		}
		a, err := ParseAddress(entry.Request.Address)
		if err != nil || a.Harness != harness || a.ID != id || a.Host != host {
			continue
		}
		items = append(items, item{path, entry})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].entry.QueuedAt == items[j].entry.QueuedAt {
			return items[i].path < items[j].path
		}
		return items[i].entry.QueuedAt < items[j].entry.QueuedAt
	})
	batch := []Request{}
	n := 0
	size := 0
	for _, it := range items {
		if n > 0 && size+len(it.entry.Request.Text) > 64<<10 {
			break
		}
		batch = append(batch, it.entry.Request)
		size += len(it.entry.Request.Text)
		n++
		if n == 16 {
			break
		}
	}
	if n == 0 {
		return nil
	}
	if err := ensureDir(filepath.Join(dir, "offered"), 0700); err != nil {
		return err
	}
	if err := emit(batch); err != nil {
		return err
	}
	for _, it := range items[:n] {
		if err := os.Rename(it.path, filepath.Join(dir, "offered", filepath.Base(it.path))); err != nil {
			return err
		}
	}
	if err := syncDir(filepath.Join(dir, "pending")); err != nil {
		return err
	}
	if err := syncDir(filepath.Join(dir, "offered")); err != nil {
		return err
	}
	return nil
}

// MailboxSessions returns hook-registered receivers for one harness and host.
// A registration means the hook was observed, not that a model turn is live.
func MailboxSessions(harness, host string) []Session {
	root := filepath.Join(dataDir(), "mailboxes", harness)
	entries, err := os.ReadDir(root)
	if err != nil {
		return []Session{}
	}
	out := []Session{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		b, err := mailboxRead(filepath.Join(root, entry.Name(), "receiver.json"), 16384)
		if err != nil {
			continue
		}
		var r mailboxRegistration
		if json.Unmarshal(b, &r) != nil || r.ID == "" || r.Host != host {
			continue
		}
		address, err := FormatAddress(host, harness, r.ID)
		if err != nil {
			continue
		}
		out = append(out, Session{Address: address, Host: host, Harness: harness, ID: r.ID, CWD: r.CWD, State: "hook", Capabilities: []string{"context"}, LastSeen: r.LastSeen})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Address < out[j].Address })
	return out
}

func mailboxRead(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err == nil && int64(len(b)) > limit {
		return nil, errCode("invalid_mailbox", "mailbox entry exceeds bound")
	}
	return b, err
}

func mailboxWrite(path string, b []byte, exclusive bool) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".mailbox-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if exclusive {
		if err = os.Link(f.Name(), path); err != nil {
			return err
		}
		if err = os.Remove(f.Name()); err != nil {
			return err
		}
	} else {
		if err = os.Rename(f.Name(), path); err != nil {
			return err
		}
	}
	return syncDir(filepath.Dir(path))
}
