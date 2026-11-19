package messaging

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// ThreadRoutingAddress names the host's routing inbox. It holds every thread
// publication this host captured and has not yet placed: results whose
// recipient is unresolved, remote or not yet current, and asker notices.
// Placing an entry settles it here; what it became lives in the recipient's
// inbox, the owner's, or the asking session's transport.
const ThreadRoutingAddress = "threads"

func routingRoot(env *sysenv.Env) string { return mailboxDir(env, "fiber", ThreadRoutingAddress) }

// ThreadInboxState is the capture window's baseline, which never changes: a
// lifecycle stamp at or before it is history this host does not publish.
// Enqueue's 14-day window on the stamp keeps a publication whose offered
// entry has expired from returning.
type ThreadInboxState struct {
	Baseline string `json:"baseline"`
}

func threadStatePath(env *sysenv.Env) string {
	return filepath.Join(dataDir(env), "mailboxes", "threads.json")
}

func ReadThreadInboxState(env *sysenv.Env) (ThreadInboxState, error) {
	var s ThreadInboxState
	b, err := os.ReadFile(threadStatePath(env))
	if err != nil {
		return s, err
	}
	if err = json.Unmarshal(b, &s); err != nil {
		return s, errCode("corrupt", "thread inbox state: %v", err)
	}
	if _, err := parseStamp(s.Baseline); err != nil {
		return s, errCode("corrupt", "thread inbox state: %v", err)
	}
	return s, nil
}

// admits reports whether a publication stamped at stamp is after the
// baseline. A record without a stamp has nothing to judge.
func (s ThreadInboxState) admits(stamp string) bool {
	if stamp == "" {
		return true
	}
	t, err := parseStamp(stamp)
	if err != nil {
		return false
	}
	baseline, _ := parseStamp(s.Baseline)
	return t.After(baseline)
}

func lockInbox(root string) (func(), error) {
	if err := ensureDir(root, 0700); err != nil {
		return nil, err
	}
	return lockFile(filepath.Join(root, ".lock"))
}

func lockFile(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}

func routeString(r map[string]any, key string) string { s, _ := r[key].(string); return s }

func threadStamp(r map[string]any) string {
	if signal, ok := r["signal"].(map[string]any); ok && routeString(signal, "stamp") != "" {
		return routeString(signal, "stamp")
	}
	return routeString(r, "retained_at")
}

// ThreadPublication is one thread publication as the daemon captures it: the
// producer's id and the routing record. A record with a session is the asker
// notice for that session; any other names its recipient fiber by
// parent_uid, marked parent_unresolved until the daemon resolves it.
// Aliases are other ids of the same publication: a routing inbox entry under
// any of them, pending or offered, is this publication captured before.
type ThreadPublication struct {
	ID      string         `json:"id"`
	Aliases []string       `json:"aliases,omitempty"`
	Record  map[string]any `json:"record"`
}

// ThreadEntry is a publication's routing inbox entry. The text and wishes it
// stores are what its recipient receives: a turn only when the asking session
// is the recipient's own worker (wake), or for an asker notice.
func ThreadEntry(id string, record map[string]any) (InboxEntry, error) {
	req := Request{MessageID: id, Text: routeString(record, "text"), From: "shuttle", RetainedAt: routeString(record, "retained_at")}
	if signal := record["signal"]; signal != nil {
		b, err := json.Marshal(signal)
		if err == nil {
			req.ThreadSignal = &ThreadSignal{}
			err = json.Unmarshal(b, req.ThreadSignal)
		}
		if err != nil {
			return InboxEntry{}, errCode("invalid_request", "thread signal: %v", err)
		}
	}
	turn := "none"
	if record["wake"] == true || routeString(record, "session") != "" {
		turn = "ask"
	}
	return InboxEntry{Address: ThreadRoutingAddress, Request: req, Wishes: Wishes{Source: "thread", Turn: turn, IfCostly: "fresh"}, Derived: true, Routing: record}, nil
}

// ThreadRefusal names a publication the routing inbox did not take and why.
type ThreadRefusal struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

// ThreadCapture is a capture's answer: the ids this call stored and the
// publications the routing inbox refused.
type ThreadCapture struct {
	Created []string
	Refused []ThreadRefusal
}

// CaptureThreads enqueues each publication into the routing inbox; one
// refusal does not stop the others. A publication captured before under its id
// or an alias (pending or offered in the routing inbox) or outside the capture
// window stores nothing,
// so the first capture fixes the publication whatever a later poll renders.
// A record with a board line stores it in its entry, which owes the line
// until BoardLineAppended records it (OwedBoardLines).
func CaptureThreads(env *sysenv.Env, publications []ThreadPublication) ThreadCapture {
	c := ThreadCapture{Created: []string{}, Refused: []ThreadRefusal{}}
	for _, p := range publications {
		if capturedAs(routingRoot(env), p.Aliases) {
			continue
		}
		entry, err := ThreadEntry(p.ID, p.Record)
		made := false
		entry.Created = &made
		if err == nil {
			err = Enqueue(env, entry)
		}
		if err != nil {
			c.Refused = append(c.Refused, ThreadRefusal{p.ID, err.Error()})
		} else if made {
			c.Created = append(c.Created, p.ID)
		}
	}
	return c
}

func capturedAs(root string, ids []string) bool {
	for _, id := range ids {
		if _, _, err := routedEntry(root, id); !errors.Is(err, os.ErrNotExist) {
			return true
		}
	}
	return false
}

// routedEntry finds a routing inbox entry, pending or offered, by id.
func routedEntry(root, id string) (string, mailboxEntry, error) {
	for _, state := range []string{"pending", "offered"} {
		path := filepath.Join(root, state, mailboxKey(id)+".json")
		e, err := readFiberMailboxEntry(path)
		if !errors.Is(err, os.ErrNotExist) {
			return path, e, err
		}
	}
	return "", mailboxEntry{}, os.ErrNotExist
}

// OwedBoardLine is a routing inbox entry's board line not yet on the board:
// the publication's id and the board record its first capture stored.
type OwedBoardLine struct {
	ID    string
	Board any
}

// OwedBoardLines lists the board lines the routing inbox's entries, pending
// or offered, still owe. An offered entry and the line it owes expire
// together, 14 days after the entry settles.
func OwedBoardLines(env *sysenv.Env) ([]OwedBoardLine, error) {
	var owed []OwedBoardLine
	for _, state := range []string{"pending", "offered"} {
		dir := filepath.Join(routingRoot(env), state)
		files, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, file := range files {
			if file.IsDir() || strings.HasPrefix(file.Name(), ".") || !strings.HasSuffix(file.Name(), ".json") {
				continue
			}
			e, err := readFiberMailboxEntry(filepath.Join(dir, file.Name()))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if e.Routing["board"] != nil && e.Routing["board_appended"] != true {
				owed = append(owed, OwedBoardLine{e.Request.MessageID, e.Routing["board"]})
			}
		}
	}
	return owed, nil
}

// BoardLineAppended records that a routing entry's board line is on the
// board, pending or offered, so it is owed no longer. The entry keeps its
// modification time, from which offered/ retention runs.
func BoardLineAppended(env *sysenv.Env, id string) error {
	root := routingRoot(env)
	unlock, err := lockInbox(root)
	if err != nil {
		return err
	}
	defer unlock()
	path, e, err := routedEntry(root, id)
	if err != nil {
		return err
	}
	e.Routing["board_appended"] = true
	return writeMailboxEntryKeepingTime(path, e)
}

// ThreadRoutes lists the routing inbox's pending publications.
func ThreadRoutes(env *sysenv.Env) ([]ThreadPublication, error) {
	items, err := pendingItems(routingRoot(env))
	if err != nil {
		return nil, err
	}
	out := []ThreadPublication{}
	for _, it := range items {
		out = append(out, ThreadPublication{ID: it.entry.Request.MessageID, Record: it.entry.Routing})
	}
	return out, nil
}

// RouteFacts are the daemon's fresh authoritative observations of one routing
// entry: its lifecycle currency ("true", "false" or "unknown") and, once the
// recipient resolves, its routing fields (Record) and, when this host owns
// it, its inbox key (Key). No Record leaves the recipient unresolved; a
// Record without a Key names a recipient another host owns.
type RouteFacts struct {
	ID      string
	Current string
	Record  map[string]any
	Key     string
}

// RouteDecision is a routing step's answer. Action is wait; forward (to the
// recipient's host) or session (to the asking session's transport), each with
// the entry's routing Record, for the daemon to hand off and then settle; or
// the disposition this step recorded: placed, superseded or expired.
type RouteDecision struct {
	Action string         `json:"action"`
	Record map[string]any `json:"record,omitempty"`
}

// RouteThread advances one routing entry from fresh facts. A superseded or
// expired publication settles without a handoff, an unresolved or uncertain
// one waits, a resolved recipient's uid is stored and never changes, and a
// current local result is placed: enqueued as an ordinary entry in the
// recipient fiber's inbox before it settles here, so a repeat is a no-op.
func RouteThread(env *sysenv.Env, f RouteFacts) (RouteDecision, error) {
	wait := RouteDecision{Action: "wait"}
	root := routingRoot(env)
	unlock, err := lockInbox(root)
	if err != nil {
		return wait, err
	}
	defer unlock()
	path := filepath.Join(root, "pending", mailboxKey(f.ID)+".json")
	e, err := readFiberMailboxEntry(path)
	if errors.Is(err, os.ErrNotExist) {
		return wait, nil
	}
	if err != nil {
		return wait, err
	}
	settle := func(disposition string) (RouteDecision, error) {
		return RouteDecision{Action: disposition}, finishRouted(root, path, e, disposition)
	}
	switch {
	case e.Disposition != "":
		// Recorded before a crash interrupted the move to offered.
		return RouteDecision{Action: e.Disposition}, moveToOffered(root, path)
	case requestExpired(e.Request, time.Now()):
		return settle("expired")
	case f.Current == "false":
		return settle("superseded")
	case routeString(e.Routing, "session") != "":
		if f.Current != "true" {
			return wait, nil
		}
		return RouteDecision{Action: "session", Record: e.Routing}, nil
	case f.Record == nil:
		return wait, nil
	}
	if e.Routing["parent_unresolved"] != true && routeString(f.Record, "parent_uid") != routeString(e.Routing, "parent_uid") {
		return wait, errCode("invalid_request", "a resolved thread recipient is immutable")
	}
	// Persist the resolution before currency is known. The recipient's host
	// and store may follow it; its uid may not.
	_, changed := e.Routing["parent_unresolved"]
	delete(e.Routing, "parent_unresolved")
	for _, key := range []string{"parent_uid", "parent_host", "store", "resolved_from_uid"} {
		if value := routeString(f.Record, key); value != "" && value != routeString(e.Routing, key) {
			e.Routing[key], changed = value, true
		}
	}
	// The asking fiber's worker was to be woken. A recipient resolved past it
	// (an archived asking parent) takes the result as quiet context, and the
	// asking session hears it through an asker notice, stored first so a
	// crash before this entry is rewritten repeats it as a no-op.
	if asked, _ := e.Routing["asked_by"].(map[string]any); e.Routing["wake"] == true && asked != nil && routeString(asked, "fiber") != routeString(e.Routing, "parent_uid") {
		if err := storeAskerNotice(root, e, routeString(asked, "session")); err != nil {
			return wait, err
		}
		e.Routing["wake"], e.Wishes.Turn, changed = false, "none", true
	}
	if changed {
		b, err := json.Marshal(e)
		if err != nil {
			return wait, err
		}
		if err = mailboxWrite(path, b, false); err != nil {
			return wait, err
		}
	}
	switch {
	case f.Current != "true":
		return wait, nil
	case f.Key == "":
		return RouteDecision{Action: "forward", Record: e.Routing}, nil
	}
	if err := Enqueue(env, InboxEntry{Address: f.Key, Request: e.Request, Wishes: e.Wishes, Derived: true}); err != nil {
		return wait, err
	}
	return settle("placed")
}

// storeAskerNotice stores the asker notice for entry e, id <id>-asker, in the
// routing inbox at root, whose lock the caller holds; one stored before is
// kept.
func storeAskerNotice(root string, e mailboxEntry, session string) error {
	id := e.Request.MessageID + "-asker"
	if _, _, err := routedEntry(root, id); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	record := map[string]any{"session": session}
	for _, key := range []string{"owner", "store", "retained_at", "text", "signal"} {
		if value, ok := e.Routing[key]; ok {
			record[key] = value
		}
	}
	notice, err := ThreadEntry(id, record)
	if err != nil {
		return err
	}
	return enqueueMailbox(root, mailboxEntry{Request: notice.Request, Wishes: notice.Wishes.withDefaults(notice.Request), QueuedAt: time.Now().UnixNano(), Routing: record})
}

func finishRouted(root, path string, e mailboxEntry, disposition string) error {
	e.Disposition = disposition
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	// Persist the verdict before moving, so a crash between the two settles it
	// on the next route without another handoff.
	if err = mailboxWrite(path, b, false); err != nil {
		return err
	}
	return moveToOffered(root, path)
}

// SettleThread records a handoff's known outcome: forwarded (the owner
// confirmed a durable enqueue), delivered (the asking session's transport
// answered) or undeliverable (it refused; the orchestrator holds the same
// result). An unknown outcome is not settled, and the next poll repeats it.
func SettleThread(env *sysenv.Env, id, disposition string) error {
	if disposition != "forwarded" && disposition != "delivered" && disposition != "undeliverable" {
		return errCode("invalid_request", "invalid routing disposition")
	}
	root := routingRoot(env)
	unlock, err := lockInbox(root)
	if err != nil {
		return err
	}
	defer unlock()
	path := filepath.Join(root, "pending", mailboxKey(id)+".json")
	e, err := readFiberMailboxEntry(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return finishRouted(root, path, e, disposition)
}

// BootThreadInbox establishes the capture window: a host without a baseline
// records the current time as its baseline, and one with a baseline keeps it.
// A malformed state is a "corrupt" error and is left untouched.
func BootThreadInbox(env *sysenv.Env) (ThreadInboxState, error) {
	unlock, err := lockInbox(routingRoot(env))
	if err != nil {
		return ThreadInboxState{}, err
	}
	defer unlock()
	state, err := ReadThreadInboxState(env)
	if !errors.Is(err, os.ErrNotExist) {
		return state, err
	}
	state.Baseline = time.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.Marshal(state)
	if err != nil {
		return state, err
	}
	return state, mailboxWrite(threadStatePath(env), b, false)
}
