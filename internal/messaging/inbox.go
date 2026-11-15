package messaging

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// Wishes say how an inbox entry wants to reach its worker. They are fixed
// when the entry is enqueued.
type Wishes struct {
	// Source names what produced the entry.
	Source string `json:"source"`
	// Turn is none (context only), idle (start a turn only when the worker is
	// idle), ask (start a turn; a costly wake may be held) or force.
	Turn string `json:"turn"`
	// Session is any, fresh or previous.
	Session string `json:"session"`
	// IfCostly says what to do instead of waking a large, cold session.
	IfCostly string `json:"if_costly"`
	// NotBefore is an RFC 3339 time before which readers leave the entry pending.
	NotBefore string `json:"not_before,omitempty"`
}

var wishValues = map[string][]string{
	"source":    {"message", "human", "voice", "thread", "pulse", "notice"},
	"turn":      {"none", "idle", "ask", "force"},
	"session":   {"any", "fresh", "previous"},
	"if_costly": {"hold", "fresh"},
}

// InboxEntry is what Enqueue is asked to store. Address is a fiber key or a
// session's shuttle:// address. Derived marks a publication whose id Shuttle
// minted from the event it reports (a thread result, a pulse): a second
// capture under that id is a no-op whatever its content.
type InboxEntry struct {
	Address string
	Request Request
	Wishes  Wishes
	Derived bool
}

// legacyTurn reads the turn wish from a request's wake fields, for an entry
// written without wishes.
func legacyTurn(r Request) string {
	switch {
	case r.IdleOnly:
		return "idle"
	case r.ContextIfBusy:
		return "ask"
	case r.Wake:
		return "force"
	}
	return "none"
}

// withDefaults fills the wishes an entry left unsaid from its request.
func (w Wishes) withDefaults(r Request) Wishes {
	if w.Source == "" {
		w.Source = "message"
		for prefix, source := range map[string]string{"thread-": "thread", "pulse-": "pulse", "voice-": "voice", "claude-mail-failure-": "notice"} {
			if strings.HasPrefix(r.MessageID, prefix) {
				w.Source = source
			}
		}
	}
	if w.Turn == "" {
		w.Turn = legacyTurn(r)
	}
	if w.Session == "" {
		w.Session = "any"
	}
	if w.IfCostly == "" {
		w.IfCostly = "hold"
		if w.Source == "thread" {
			w.IfCostly = "fresh"
		}
	}
	return w
}

func (w Wishes) validate() error {
	for name, value := range map[string]string{"source": w.Source, "turn": w.Turn, "session": w.Session, "if_costly": w.IfCostly} {
		if !slices.Contains(wishValues[name], value) {
			return errCode("invalid_request", "unknown %s %q (want one of %s)", name, value, strings.Join(wishValues[name], ", "))
		}
	}
	if w.NotBefore != "" {
		if _, err := time.Parse(time.RFC3339, w.NotBefore); err != nil {
			return errCode("invalid_request", "not_before must be an RFC 3339 time: %v", err)
		}
	}
	return nil
}

// availableAt is when readers may first offer or deliver the entry.
func (e mailboxEntry) availableAt() time.Time {
	at := time.Unix(0, e.QueuedAt)
	if t, err := time.Parse(time.RFC3339, e.Wishes.NotBefore); err == nil && t.After(at) {
		return t
	}
	return at
}

func (e mailboxEntry) due(now time.Time) bool {
	return !now.Before(e.availableAt())
}

// UnmarshalJSON gives an entry written without wishes the wishes its request
// fields imply, and reads an attempt_address with no attempt record for that
// address, as a build that predates the record writes it, as an open attempt
// of that one entry to that address.
func (e *mailboxEntry) UnmarshalJSON(data []byte) error {
	type stored mailboxEntry
	var s stored
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	*e = mailboxEntry(s)
	e.Wishes = e.Wishes.withDefaults(e.Request)
	if e.AttemptAddress != "" && (e.Attempt == nil || e.Attempt.Conversation != e.AttemptAddress) {
		members := []string{e.Request.MessageID}
		e.Attempt = &Attempt{BatchID: batchID(members), Conversation: e.AttemptAddress, Members: members}
	}
	return nil
}

// inboxRoot is the directory of an address's inbox.
func inboxRoot(env *sysenv.Env, address string) (string, error) {
	if address == "" {
		return "", errCode("invalid_request", "an inbox address is required")
	}
	if !strings.HasPrefix(address, "shuttle://") {
		return mailboxDir(env, "fiber", address), nil
	}
	a, err := ParseAddress(address)
	if err != nil {
		return "", err
	}
	return mailboxDir(env, a.Harness, a.ID), nil
}

// Enqueue is the only function that creates an inbox entry. An entry for a
// session needs that session's live hook registration on this host; an entry
// for a fiber is kept whether or not the fiber has a worker.
//
// The stored request carries only the wake fields its inbox's readers act on:
// a fiber's force sets wake, and a Claude session's ask sets context_if_busy.
// A session inbox cannot start a turn, so it refuses force and idle.
//
// In a fiber inbox, an id already pending, claimed or offered is a successful
// no-op when the content and wishes match or the entry is Derived; otherwise it
// is a message_id_conflict. A session inbox refuses an id already pending. A
// thread notice past its retention is not stored for a fiber and refused as
// expired for a session.
func Enqueue(env *sysenv.Env, e InboxEntry) error {
	r, w := e.Request, e.Wishes.withDefaults(e.Request)
	session := strings.HasPrefix(e.Address, "shuttle://")
	if r.MessageID == "" || len(r.Text) > 64<<10 || (!session && r.Text == "") {
		return errCode("invalid_request", "an inbox entry requires a message id and text (at most 64 KiB)")
	}
	if err := w.validate(); err != nil {
		return err
	}
	if w.NotBefore != "" {
		t, _ := time.Parse(time.RFC3339, w.NotBefore)
		w.NotBefore = t.UTC().Format(time.RFC3339Nano)
	}
	root, err := inboxRoot(env, e.Address)
	if err != nil {
		return err
	}
	r.Wake, r.ContextIfBusy, r.IdleOnly = false, false, false
	if session {
		a, _ := ParseAddress(e.Address)
		if a.Harness != "claude" && a.Harness != "codex" && a.Harness != "pi" {
			return errCode("unavailable", "harness has no Shuttle message hook")
		}
		if reason := mailboxUnavailable(env, a.Harness, a.ID, a.Host); reason != "" {
			return errCode("unavailable", "%s", reason)
		}
		if w.Turn == "force" || w.Turn == "idle" {
			return errCode("wake_required", "hook mailboxes cannot wake a session")
		}
		if requestExpired(r, time.Now()) {
			return errCode("expired", "thread notice is outside the 14-day retention window")
		}
		r.Address = e.Address
		r.ContextIfBusy = w.Turn == "ask" && a.Harness == "claude"
		return enqueueMailbox(root, mailboxEntry{Request: r, Wishes: w, QueuedAt: time.Now().UnixNano()})
	}
	r.Wake = w.Turn == "force"
	if err := ensureDir(root, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	for _, state := range []string{"pending", "offered"} {
		stored, err := readFiberMailboxEntry(filepath.Join(root, state, mailboxKey(r.MessageID)+".json"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !e.Derived && (fiberRequestIdentity(stored.Request) != fiberRequestIdentity(r) || !sameWishes(stored.Wishes, w, e.Wishes.Turn != "")) {
			return errCode("message_id_conflict", "message id already names a different inbox entry")
		}
		return nil
	}
	if requestExpired(r, time.Now()) {
		return nil
	}
	if r.ThreadSignal != nil && (r.ThreadSignal.UID == "" || r.ThreadSignal.Verb == "" || r.ThreadSignal.Stamp == "" || r.ThreadSignal.Owner == "") {
		return errCode("invalid_request", "thread signal requires uid, verb, stamp and owner")
	}
	return enqueueMailbox(root, mailboxEntry{Request: r, Wishes: w, QueuedAt: time.Now().UnixNano()})
}

// sameWishes compares two entries' wishes. A turn the caller left unsaid
// follows the request's wake, which is routing and not content, so it counts
// only when stated.
func sameWishes(stored, w Wishes, turnStated bool) bool {
	if !turnStated {
		stored.Turn, w.Turn = "", ""
	}
	return stored == w
}

// PendingCount counts the entries an address's inbox holds that no worker has
// taken, including those whose not_before has not passed. An address without
// an inbox holds none. It reads only the directory listing, so it never
// contends with a delivery holding the inbox lock.
func PendingCount(env *sysenv.Env, address string) (int, error) {
	root, err := inboxRoot(env, address)
	if err != nil {
		return 0, err
	}
	entries, err := os.ReadDir(filepath.Join(root, "pending"))
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	n := 0
	for _, entry := range entries {
		if name := entry.Name(); !entry.IsDir() && !strings.HasPrefix(name, ".") && strings.HasSuffix(name, ".json") {
			n++
		}
	}
	return n, nil
}

// WakingCount counts the due entries in an address's inbox that ask for a
// turn, free or held by an open batch: what a session started for a fiber with
// no worker would be started for. It is zero while a launch reservation in its
// lease still owes any pending entry, since that launch is in flight. Like
// PendingCount, it reads without the inbox lock and settles nothing, so it
// also counts a held batch that local records already resolve (a confirmed
// receipt, a superseded thread result); consume settles those and decides.
func WakingCount(env *sysenv.Env, address string) (int, error) {
	root, err := inboxRoot(env, address)
	if err != nil {
		return 0, err
	}
	items, err := pendingItems(root)
	if err != nil {
		return 0, err
	}
	reservation, err := currentReservation(root, items)
	if err != nil {
		return 0, err
	}
	now := time.Now()
	if reservation.inFlight(items, now) {
		return 0, nil
	}
	n := 0
	for _, it := range items {
		if it.entry.Wishes.Turn != "none" && it.entry.due(now) {
			n++
		}
	}
	return n, nil
}

// PendingEntry describes one pending inbox entry.
type PendingEntry struct {
	MessageID string    `json:"id"`
	Source    string    `json:"source"`
	Turn      string    `json:"turn"`
	NotBefore string    `json:"not_before,omitempty"`
	QueuedAt  time.Time `json:"queued_at"`
	From      string    `json:"from,omitempty"`
	// Attempt is the entry's open attempt, if any.
	Attempt *Attempt `json:"attempt,omitempty"`
}

// PendingEntries lists an address's pending entries, oldest first.
func PendingEntries(env *sysenv.Env, address string) ([]PendingEntry, error) {
	root, err := inboxRoot(env, address)
	if err != nil {
		return nil, err
	}
	items, err := pendingItems(root)
	if err != nil {
		return nil, err
	}
	out := make([]PendingEntry, 0, len(items))
	for _, it := range items {
		e := it.entry
		pending := PendingEntry{MessageID: e.Request.MessageID, Source: e.Wishes.Source, Turn: e.Wishes.Turn, NotBefore: e.Wishes.NotBefore, QueuedAt: time.Unix(0, e.QueuedAt), From: e.Request.From}
		if e.Attempt.open() {
			pending.Attempt = e.Attempt
		}
		out = append(out, pending)
	}
	return out, nil
}

// pendingItems reads an inbox's pending entries without its lock, oldest
// first. An entry taken while the directory is read is left out.
func pendingItems(root string) ([]mailboxPendingItem, error) {
	dir := filepath.Join(root, "pending")
	files, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var items []mailboxPendingItem
	for _, file := range files {
		if file.IsDir() || strings.HasPrefix(file.Name(), ".") || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, file.Name())
		entry, err := readFiberMailboxEntry(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		items = append(items, mailboxPendingItem{path, entry})
	}
	sortPendingItems(items)
	return items, nil
}

func sortPendingItems(items []mailboxPendingItem) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].entry.QueuedAt == items[j].entry.QueuedAt {
			return items[i].path < items[j].path
		}
		return items[i].entry.QueuedAt < items[j].entry.QueuedAt
	})
}
