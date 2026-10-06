package messaging

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/cailmdaley/felt/internal/sysenv"
)

// Supported harness hook interfaces accept additional context without starting
// a turn. These host-local mailboxes preserve messages until a receiving hook can
// offer them. An offer is not evidence that the model read or acted on it.
//
// A registration names the receiver's harness process. The mailbox is
// available only while that process lives: a harness that exits without
// running its SessionEnd hook, as one killed with its tmux pane does, leaves
// its registration behind, and a message queued there would never be offered.
type mailboxRegistration struct {
	ID       string `json:"id"`
	Host     string `json:"host"`
	CWD      string `json:"cwd"`
	LastSeen int64  `json:"last_seen"`
	PID      int    `json:"pid,omitempty"`
	Start    string `json:"start,omitempty"`
}

// live reports whether the registration's receiver process still runs. A
// registration without a process identity cannot be verified and is not live.
func (r mailboxRegistration) live() bool {
	return r.PID > 0 && processAlive(r.PID, r.Start)
}

// hookShells are the launchers a harness may interpose between itself and a
// hook command. They exit with the hook, so they never identify the receiver.
var hookShells = map[string]bool{
	"sh": true, "bash": true, "dash": true, "zsh": true, "ksh": true, "mksh": true,
	"fish": true, "csh": true, "tcsh": true, "env": true,
}

// HookReceiverPID names the harness process running the calling hook: the
// nearest ancestor that is not a shell. It returns 0 when the chain cannot be
// read.
func HookReceiverPID() int {
	pid := os.Getppid()
	for hops := 0; hops < 8 && pid > 0; hops++ {
		ppid, name, ok := processParent(pid)
		if !ok {
			return 0
		}
		if !hookShells[name] {
			return pid
		}
		pid = ppid
	}
	return 0
}

type mailboxEntry struct {
	Request  Request `json:"request"`
	QueuedAt int64   `json:"queued_at"`
}

func mailboxKey(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func mailboxDir(env *sysenv.Env, harness, id string) string {
	return filepath.Join(dataDir(env), "mailboxes", harness, mailboxKey(id))
}

// RegisterMailbox is called by the receiver's hooks, never by a sender, with
// the receiver's harness process (see HookReceiverPID). A SessionEnd withdraws
// availability without deleting already queued messages.
func RegisterMailbox(env *sysenv.Env, harness, id, host, cwd string, pid int, active bool) error {
	if harness != "claude" && harness != "codex" && harness != "pi" {
		return errCode("invalid_request", "unsupported mailbox harness")
	}
	if id == "" || len(id) > 4096 || strings.ContainsAny(id, "\x00\r\n") {
		return errCode("invalid_request", "invalid mailbox session")
	}
	if _, err := os.Stat(dataDir(env)); err != nil {
		return err
	}
	dir := mailboxDir(env, harness, id)
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
	reg := mailboxRegistration{ID: id, Host: host, CWD: cwd, LastSeen: time.Now().UnixMilli(), PID: pid, Start: processStartToken(pid)}
	if !reg.live() {
		return errCode("unavailable", "mailbox receiver process %d is not running", pid)
	}
	if err := ensureDir(dir, 0700); err != nil {
		return err
	}
	b, err := json.Marshal(reg)
	if err != nil {
		return err
	}
	return mailboxWrite(filepath.Join(dir, "receiver.json"), b, false)
}

func MailboxAvailable(env *sysenv.Env, harness, id, host string) bool {
	return mailboxUnavailable(env, harness, id, host) == ""
}

// mailboxUnavailable says why a session cannot take a queued message, or
// returns "" when a live receiver on host registered it.
func mailboxUnavailable(env *sysenv.Env, harness, id, host string) string {
	r, err := mailboxRegistrationFor(env, harness, id)
	if err != nil || r.ID != id || r.Host != host {
		return "session has not registered a Shuttle message hook on this host"
	}
	if !r.live() {
		return "session's registered receiver process is no longer running; no hook would offer this message"
	}
	return ""
}

func mailboxRegistrationFor(env *sysenv.Env, harness, id string) (mailboxRegistration, error) {
	b, err := readBounded(filepath.Join(mailboxDir(env, harness, id), "receiver.json"), 16384)
	var r mailboxRegistration
	if err != nil {
		return r, err
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return r, err
	}
	return r, nil
}

func queueMailbox(env *sysenv.Env, a Address, r Request) (Receipt, error) {
	transport := a.Harness + "-hook"
	if a.Harness != "claude" && a.Harness != "codex" && a.Harness != "pi" {
		return rejected(r, transport, "harness has no Shuttle message hook"), errCode("unavailable", "harness has no Shuttle message hook")
	}
	if reason := mailboxUnavailable(env, a.Harness, a.ID, a.Host); reason != "" {
		return rejected(r, transport, reason), errCode("unavailable", "%s", reason)
	}
	if r.Wake {
		return rejected(r, transport, "hook mailboxes cannot wake a session"), errCode("wake_required", "hook mailboxes cannot wake a session")
	}
	dir := filepath.Join(mailboxDir(env, a.Harness, a.ID), "pending")
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
func OfferMailbox(env *sysenv.Env, harness, id, host string, emit func([]Request) error) error {
	if !MailboxAvailable(env, harness, id, host) {
		return nil
	}
	dir := mailboxDir(env, harness, id)
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
		b, err := readBounded(path, 512<<10)
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

// mailboxSessions returns hook-registered receivers for one harness and host
// whose harness process still runs. A registration means the hook was
// observed, not that a model turn is live.
func mailboxSessions(env *sysenv.Env, harness, host string) []Session {
	root := filepath.Join(dataDir(env), "mailboxes", harness)
	entries, err := os.ReadDir(root)
	if err != nil {
		return []Session{}
	}
	out := []Session{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		b, err := readBounded(filepath.Join(root, entry.Name(), "receiver.json"), 16384)
		if err != nil {
			continue
		}
		var r mailboxRegistration
		if json.Unmarshal(b, &r) != nil || r.ID == "" || r.Host != host || !r.live() {
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

// readBounded reads a host-local state file (mailbox entry, registration,
// dedup record, Confer job) and refuses one larger than limit.
func readBounded(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err == nil && int64(len(b)) > limit {
		return nil, fmt.Errorf("%s exceeds %d bytes", path, limit)
	}
	return b, err
}

// mailboxWrite publishes b at path in one step. A replacing write is an
// atomic rename; an exclusive one hard-links the finished temp file into
// place, so it fails rather than replace a message already there.
func mailboxWrite(path string, b []byte, exclusive bool) error {
	if !exclusive {
		return atomicfile.Write(path, b, 0o600)
	}
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
	if err = os.Link(f.Name(), path); err != nil {
		return err
	}
	if err = os.Remove(f.Name()); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

// mailboxWriteReservation treats a successful hard link as the reservation
// commit point. Cleanup and directory-sync failures cannot revoke ownership of
// the published path, especially when a network filesystem acknowledges a
// retried link ambiguously.
func mailboxWriteReservation(path string, b []byte) (bool, error) {
	return mailboxWriteReservationWith(path, b, os.Link, os.Remove, syncDir)
}

func mailboxWriteReservationWith(path string, b []byte, link func(string, string) error, removeTemp func(string) error, syncDirectory func(string) error) (bool, error) {
	f, err := os.CreateTemp(filepath.Dir(path), ".reservation-")
	if err != nil {
		return false, err
	}
	tempPath := f.Name()
	defer os.Remove(tempPath)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return false, err
	}
	if err := link(tempPath, path); err != nil {
		return false, err
	}
	_ = removeTemp(tempPath)
	_ = syncDirectory(filepath.Dir(path))
	return true, nil
}
