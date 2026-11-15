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

// ThreadInboxState is the capture window. Baseline never changes: a lifecycle
// stamp at or before it is history this host does not publish. Cutoff only
// advances, so a publication whose offered entry has expired cannot return.
type ThreadInboxState struct {
	Baseline string `json:"baseline"`
	Cutoff   string `json:"retention_cutoff"`
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
	for _, stamp := range []string{s.Baseline, s.Cutoff} {
		if _, err := time.Parse(time.RFC3339Nano, stamp); err != nil {
			return s, errCode("corrupt", "thread inbox state: %v", err)
		}
	}
	return s, nil
}

// admits reports whether a publication stamped at stamp is inside the
// capture window. A record without a stamp has nothing to judge.
func (s ThreadInboxState) admits(stamp string) bool {
	if stamp == "" {
		return true
	}
	t, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil {
		return false
	}
	baseline, _ := time.Parse(time.RFC3339Nano, s.Baseline)
	cutoff, _ := time.Parse(time.RFC3339Nano, s.Cutoff)
	return t.After(baseline) && !t.Before(cutoff)
}

func lockInbox(root string) (func(), error) {
	if err := ensureDir(root, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
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
type ThreadPublication struct {
	ID     string         `json:"id"`
	Record map[string]any `json:"record"`
}

// ThreadEntry is a publication's routing inbox entry. The text and wishes it
// stores are what its recipient receives: a turn only when the asking session
// is the recipient's own worker (wake), or for an asker notice.
func ThreadEntry(id string, record map[string]any) (InboxEntry, error) {
	req := Request{MessageID: id, Text: routeString(record, "text"), From: "shuttle", RetainedAt: routeString(record, "retained_at")}
	if signal := record["signal"]; signal != nil {
		b, err := json.Marshal(signal)
		if err != nil {
			return InboxEntry{}, err
		}
		req.ThreadSignal = &ThreadSignal{}
		if err := json.Unmarshal(b, req.ThreadSignal); err != nil {
			return InboxEntry{}, err
		}
	}
	turn := "none"
	if record["wake"] == true || routeString(record, "session") != "" {
		turn = "ask"
	}
	return InboxEntry{Address: ThreadRoutingAddress, Request: req, Wishes: Wishes{Source: "thread", Turn: turn, IfCostly: "fresh"}, Derived: true, Routing: record}, nil
}

// CaptureThreads enqueues publications into the routing inbox and answers the
// ids this call created, up to the first failure. A publication captured
// before (pending or offered in the routing inbox) or outside the capture
// window stores nothing, so the first capture fixes the publication whatever
// a later poll renders.
func CaptureThreads(env *sysenv.Env, publications []ThreadPublication) ([]string, error) {
	created := []string{}
	for _, p := range publications {
		entry, err := ThreadEntry(p.ID, p.Record)
		if err != nil {
			return created, err
		}
		made := false
		entry.Created = &made
		if err = Enqueue(env, entry); err != nil {
			return created, err
		}
		if made {
			created = append(created, p.ID)
		}
	}
	return created, nil
}

// ThreadRoutes lists the routing inbox's pending publications.
func ThreadRoutes(env *sysenv.Env) ([]ThreadPublication, error) {
	items, err := pendingItems(routingRoot(env))
	if err != nil {
		return nil, err
	}
	out := []ThreadPublication{}
	for _, it := range items {
		out = append(out, ThreadPublication{it.entry.Request.MessageID, it.entry.Routing})
	}
	return out, nil
}

// RouteFacts are the daemon's fresh authoritative observations of one routing
// entry: its lifecycle currency ("true", "false" or "unknown") and, once the
// recipient resolves, its routing fields (Record), host (Owner) and local inbox
// key (Key). An empty Owner leaves the recipient unresolved.
type RouteFacts struct {
	ID      string
	Current string
	Record  map[string]any
	Owner   string
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
func RouteThread(env *sysenv.Env, host string, f RouteFacts) (RouteDecision, error) {
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
	case f.Owner == "":
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
	case f.Owner != host:
		return RouteDecision{Action: "forward", Record: e.Routing}, nil
	}
	if err := Enqueue(env, InboxEntry{Address: f.Key, Request: e.Request, Wishes: e.Wishes, Derived: true}); err != nil {
		return wait, err
	}
	return settle("placed")
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

// BootThreadInbox establishes the capture window and imports a thread outbox
// left by an older daemon. A malformed outbox or state is a "corrupt" error
// and is left untouched. No source file is removed until the whole import is
// durable, and repeating an interrupted import is safe: an acknowledgment
// wins over a pending copy of its id, and Enqueue keeps the first pending
// publication.
func BootThreadInbox(env *sysenv.Env) (ThreadInboxState, error) {
	unlock, err := lockInbox(filepath.Join(dataDir(env), "mailboxes", ".thread-import"))
	if err != nil {
		return ThreadInboxState{}, err
	}
	defer unlock()
	return bootThreadInbox(env, nil)
}

func bootThreadInbox(env *sysenv.Env, imported func(string) error) (ThreadInboxState, error) {
	root := filepath.Join(dataDir(env), "thread-outbox")
	completed := root + ".imported"
	state, err := ReadThreadInboxState(env)
	established := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return state, err
	}
	if err = os.RemoveAll(completed); err != nil {
		return state, err
	}
	src, err := readOutbox(root)
	if err != nil {
		return state, err
	}
	now := time.Now().UTC()
	// An established inbox keeps its own baseline, also over an outbox an
	// older daemon recreated after a rollback: what either daemon published
	// dedups, and what happened between them is published.
	if !established {
		state.Baseline = src.baseline
		if state.Baseline == "" {
			state.Baseline = now.Format(time.RFC3339Nano)
		}
	}
	for _, value := range []string{src.cutoff, now.Add(-mailboxRetention).Format(time.RFC3339Nano)} {
		t, err := time.Parse(time.RFC3339Nano, value)
		old, _ := time.Parse(time.RFC3339Nano, state.Cutoff)
		if err == nil && t.After(old) {
			state.Cutoff = value
		}
	}
	b, err := json.Marshal(state)
	if err != nil {
		return state, err
	}
	if err = ensureDir(filepath.Dir(threadStatePath(env)), 0700); err != nil {
		return state, err
	}
	if err = mailboxWrite(threadStatePath(env), b, false); err != nil {
		return state, err
	}
	for id := range src.acked {
		if err = importThreadAck(env, id); err != nil {
			return state, err
		}
		if imported != nil {
			if err = imported(id); err != nil {
				return state, err
			}
		}
	}
	for id, record := range src.pending {
		if src.acked[id] {
			continue
		}
		entry, err := ThreadEntry(id, record)
		if err != nil {
			return state, err
		}
		if err = Enqueue(env, entry); err != nil {
			return state, err
		}
		if imported != nil {
			if err = imported(id); err != nil {
				return state, err
			}
		}
	}
	if err = os.Remove(root + ".json"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return state, err
	}
	// Rename the complete source before recursive deletion, so a crash during
	// cleanup cannot leave a partial outbox that reads as corrupt.
	if err = os.Rename(root, completed); err != nil && !errors.Is(err, os.ErrNotExist) {
		return state, err
	}
	if err = syncDir(dataDir(env)); err != nil {
		return state, err
	}
	return state, os.RemoveAll(completed)
}

// outboxImage is an older daemon's thread outbox: thread-outbox/ (baseline,
// retention_cutoff, pending/<key>.json payloads, acked/<key> ids) and the
// thread-outbox.json snapshot that preceded it.
type outboxImage struct {
	baseline, cutoff string
	acked            map[string]bool
	pending          map[string]map[string]any
}

func readOutbox(root string) (outboxImage, error) {
	img := outboxImage{acked: map[string]bool{}, pending: map[string]map[string]any{}}
	var legacy struct {
		Version  int                       `json:"version"`
		Baseline string                    `json:"baseline"`
		Records  map[string]map[string]any `json:"records"`
	}
	b, err := os.ReadFile(root + ".json")
	switch {
	case err == nil:
		if err = json.Unmarshal(b, &legacy); err != nil {
			return img, errCode("corrupt", "thread outbox snapshot: %v", err)
		}
		if legacy.Version < 1 || legacy.Version > 3 || legacy.Records == nil {
			return img, errCode("corrupt", "invalid thread outbox snapshot")
		}
		if _, err = time.Parse(time.RFC3339Nano, legacy.Baseline); legacy.Version > 1 && err != nil {
			return img, errCode("corrupt", "thread outbox snapshot baseline: %v", err)
		}
		for id, record := range legacy.Records {
			switch {
			case record == nil:
				return img, errCode("corrupt", "invalid thread outbox record %q", id)
			case record["acked"] == true:
				img.acked[id] = true
			default:
				img.pending[id] = migrateRecipient(record)
			}
		}
	case !errors.Is(err, os.ErrNotExist):
		return img, err
	}
	baseline, err := os.ReadFile(filepath.Join(root, "baseline"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return img, err
	}
	img.baseline = string(baseline)
	cutoff, err := os.ReadFile(filepath.Join(root, "retention_cutoff"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return img, err
	}
	img.cutoff = string(cutoff)
	acks, err := filepath.Glob(filepath.Join(root, "acked", "*"))
	if err != nil {
		return img, err
	}
	for _, path := range acks {
		// The old daemon wrote <key>.<n>.tmp and renamed it into place; one
		// left by a hard kill was never an acknowledgment.
		if strings.HasSuffix(path, ".tmp") {
			continue
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return img, err
		}
		if filepath.Base(path) != mailboxKey(string(b)) {
			return img, errCode("corrupt", "invalid thread acknowledgment: %s", path)
		}
		img.acked[string(b)] = true
	}
	payloads, err := filepath.Glob(filepath.Join(root, "pending", "*.json"))
	if err != nil {
		return img, err
	}
	for _, path := range payloads {
		var payload struct {
			ID     string         `json:"id"`
			Record map[string]any `json:"record"`
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return img, err
		}
		if json.Unmarshal(b, &payload) != nil || payload.ID == "" || payload.Record == nil || filepath.Base(path) != mailboxKey(payload.ID)+".json" {
			return img, errCode("corrupt", "invalid thread payload: %s", path)
		}
		img.pending[payload.ID] = migrateRecipient(payload.Record)
	}
	_, versionErr := os.Stat(filepath.Join(root, "version"))
	switch {
	case img.baseline == "" && (versionErr == nil || len(acks)+len(payloads) > 0):
		return img, errCode("corrupt", "missing thread outbox baseline")
	case img.baseline == "":
		img.baseline = legacy.Baseline
	case legacy.Baseline != "" && legacy.Baseline != img.baseline:
		return img, errCode("corrupt", "thread outbox baselines differ")
	}
	for _, stamp := range []string{img.baseline, img.cutoff} {
		if _, err := time.Parse(time.RFC3339Nano, stamp); stamp != "" && err != nil {
			return img, errCode("corrupt", "thread outbox: %v", err)
		}
	}
	return img, nil
}

// migrateRecipient reads an early record's embedded parent document as its uid.
func migrateRecipient(record map[string]any) map[string]any {
	if parent, ok := record["parent"].(map[string]any); ok && routeString(parent, "uid") != "" {
		record["parent_uid"] = routeString(parent, "uid")
		delete(record, "parent")
	}
	return record
}

// importThreadAck records an outbox acknowledgment, which means the old
// daemon placed the publication, as a payload-free offered entry that dedups
// a re-capture for the retention window. It settles a pending copy of the
// same id: the acknowledgment wins.
func importThreadAck(env *sysenv.Env, id string) error {
	root := routingRoot(env)
	unlock, err := lockInbox(root)
	if err != nil {
		return err
	}
	defer unlock()
	pending := filepath.Join(root, "pending", mailboxKey(id)+".json")
	e, err := readFiberMailboxEntry(pending)
	if err == nil {
		return finishRouted(root, pending, e, "acknowledged")
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	offered := filepath.Join(root, "offered", mailboxKey(id)+".json")
	if _, err = os.Stat(offered); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = ensureDir(filepath.Dir(offered), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(mailboxEntry{Request: Request{MessageID: id}, Wishes: Wishes{Source: "thread"}.withDefaults(Request{}), QueuedAt: time.Now().UnixNano(), Disposition: "acknowledged"})
	if err != nil {
		return err
	}
	return mailboxWrite(offered, b, false)
}
