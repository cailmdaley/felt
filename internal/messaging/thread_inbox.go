package messaging

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// ThreadRoutingAddress names the host's routing inbox. It holds every thread
// publication this host captured and has not yet placed: results whose
// recipient is unresolved, remote or not yet current, and asker notices.
// Placing an entry settles it here; what it became lives in the recipient's
// inbox, the owner's, or the asking session's transport.
const ThreadRoutingAddress = "threads"

// outboxKey matches an older daemon's acknowledgment file name.
var outboxKey = regexp.MustCompile(`^[0-9a-f]{64}$`)

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

// CaptureThreads enqueues each publication into the routing inbox, calls
// created with the index of each one this call stored as soon as it is
// stored, and answers the publications it refused; one refusal does not stop
// the others. A publication captured before (pending or offered in the
// routing inbox) or outside the capture window stores nothing, so the first
// capture fixes the publication whatever a later poll renders.
func CaptureThreads(env *sysenv.Env, publications []ThreadPublication, created func(int)) []ThreadRefusal {
	refused := []ThreadRefusal{}
	for i, p := range publications {
		entry, err := ThreadEntry(p.ID, p.Record)
		made := false
		entry.Created = &made
		if err == nil {
			err = Enqueue(env, entry)
		}
		switch {
		case err != nil:
			refused = append(refused, ThreadRefusal{p.ID, err.Error()})
		case made:
			created(i)
		}
	}
	return refused
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

// ThreadImport is a boot's report: the capture window's baseline, the pending
// records the routing inbox can never accept, which the import skips, and the
// cleanup failure, if any, of an imported outbox. A failed cleanup leaves the
// renamed outbox behind for the next boot to remove; it is never imported
// again.
type ThreadImport struct {
	Baseline string          `json:"baseline"`
	Skipped  []ThreadRefusal `json:"skipped,omitempty"`
	Cleanup  string          `json:"cleanup_error,omitempty"`
}

// BootThreadInbox establishes the capture window and imports a thread outbox
// left by an older daemon. A malformed baseline or pending payload is a
// "corrupt" error and is left untouched. No source file is removed until the
// whole import is durable, and repeating an interrupted import is safe: an
// acknowledgment wins over a pending copy of its id, and Enqueue keeps the
// first pending publication.
func BootThreadInbox(env *sysenv.Env) (ThreadImport, error) {
	if err := ensureDir(dataDir(env), 0700); err != nil {
		return ThreadImport{}, err
	}
	unlock, err := lockFile(filepath.Join(dataDir(env), "thread-import.lock"))
	if err != nil {
		return ThreadImport{}, err
	}
	defer unlock()
	return bootThreadInbox(env, nil)
}

func bootThreadInbox(env *sysenv.Env, imported func(string) error) (ThreadImport, error) {
	root := filepath.Join(dataDir(env), "thread-outbox")
	completed := root + ".imported"
	var report ThreadImport
	var cleanup []error
	if err := os.RemoveAll(completed); err != nil {
		cleanup = append(cleanup, err)
	}
	state, err := ReadThreadInboxState(env)
	established := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return report, err
	}
	src, err := readOutbox(root)
	if err != nil {
		return report, err
	}
	// An established inbox keeps its own baseline, also over an outbox an
	// older daemon recreated after a rollback: what either daemon published
	// dedups, and what happened between them is published.
	if !established {
		state.Baseline = src.baseline
		if state.Baseline == "" {
			state.Baseline = time.Now().UTC().Format(time.RFC3339Nano)
		}
	}
	report.Baseline = state.Baseline
	b, err := json.Marshal(state)
	if err != nil {
		return report, err
	}
	if err = ensureDir(filepath.Dir(threadStatePath(env)), 0700); err != nil {
		return report, err
	}
	if err = mailboxWrite(threadStatePath(env), b, false); err != nil {
		return report, err
	}
	for key := range src.acked {
		if err = importThreadAck(env, key); err != nil {
			return report, err
		}
		if imported != nil {
			if err = imported(key); err != nil {
				return report, err
			}
		}
	}
	for id, record := range src.pending {
		if src.acked[mailboxKey(id)] {
			continue
		}
		if text, ok := record["text"].(string); ok {
			record["text"] = boundedThreadText(text)
		}
		entry, err := ThreadEntry(id, record)
		if _, stampErr := parseStamp(threadStamp(record)); stampErr != nil {
			err = errCode("invalid_request", "thread publication stamp: %v", stampErr)
		}
		if err == nil {
			err = Enqueue(env, entry)
		}
		// Retrying cannot change an invalid record's answer. A record without
		// a stamp would never expire, so it is refused here too.
		if ErrorCode(err) == "invalid_request" {
			report.Skipped = append(report.Skipped, ThreadRefusal{id, err.Error()})
		} else if err != nil {
			return report, err
		}
		if imported != nil {
			if err = imported(id); err != nil {
				return report, err
			}
		}
	}
	// Everything is imported. Rename the source before recursive deletion, so
	// a crash during cleanup cannot leave a partial outbox that reads as
	// corrupt; whatever the cleanup cannot remove is reported, not retried
	// here, and a source left in place imports again as a no-op.
	if err = os.Rename(root, completed); err != nil && !errors.Is(err, os.ErrNotExist) {
		cleanup = append(cleanup, err)
	} else if err = syncDir(dataDir(env)); err != nil {
		cleanup = append(cleanup, err)
	} else if err = os.RemoveAll(completed); err != nil {
		cleanup = append(cleanup, err)
	}
	if err = errors.Join(cleanup...); err != nil {
		report.Cleanup = err.Error()
	}
	return report, nil
}

// An older daemon's outbox took any text. One over the inbox's 64 KiB limit
// imports cut short, as the daemon captures a result whose outcome is that
// long: its first 60,000 bytes, ending on a whole character.
func boundedThreadText(text string) string {
	if len(text) <= 64<<10 {
		return text
	}
	cut := text[:60_000]
	for !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + " … (truncated)"
}

// outboxImage is an older daemon's thread outbox, thread-outbox/: its
// baseline, pending/<key>.json payloads and acked/<key> files, held here by
// key. Its retention_cutoff is not read: Enqueue's 14-day window on the
// stamp refuses everything it would.
type outboxImage struct {
	baseline string
	acked    map[string]bool
	pending  map[string]map[string]any
}

func readOutbox(root string) (outboxImage, error) {
	img := outboxImage{acked: map[string]bool{}, pending: map[string]map[string]any{}}
	baseline, err := os.ReadFile(filepath.Join(root, "baseline"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return img, err
	}
	img.baseline = string(baseline)
	// An acknowledgment's file name is the hash of the publication's id, the
	// routing inbox's key for it, so its content is never read. Any other
	// name (an old daemon's <key>.<n>.tmp, an NFS silly-rename, .DS_Store)
	// was never an acknowledgment.
	acks, err := os.ReadDir(filepath.Join(root, "acked"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return img, err
	}
	for _, ack := range acks {
		if outboxKey.MatchString(ack.Name()) {
			img.acked[ack.Name()] = true
		}
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
		if json.Unmarshal(b, &payload) != nil || payload.ID == "" || payload.Record == nil {
			return img, errCode("corrupt", "invalid thread payload: %s", path)
		}
		img.pending[payload.ID] = payload.Record
	}
	_, versionErr := os.Stat(filepath.Join(root, "version"))
	if img.baseline == "" && (versionErr == nil || len(img.acked)+len(payloads) > 0) {
		return img, errCode("corrupt", "missing thread outbox baseline")
	}
	if _, err := parseStamp(img.baseline); img.baseline != "" && err != nil {
		return img, errCode("corrupt", "thread outbox: %v", err)
	}
	return img, nil
}

// importThreadAck records an outbox acknowledgment, which means the old
// daemon placed the publication, as a payload-free offered entry under its
// key that dedups a re-capture for the retention window. It settles a pending
// copy of the same publication: the acknowledgment wins.
func importThreadAck(env *sysenv.Env, key string) error {
	root := routingRoot(env)
	unlock, err := lockInbox(root)
	if err != nil {
		return err
	}
	defer unlock()
	pending := filepath.Join(root, "pending", key+".json")
	e, err := readFiberMailboxEntry(pending)
	if err == nil {
		return finishRouted(root, pending, e, "acknowledged")
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	offered := filepath.Join(root, "offered", key+".json")
	if _, err = os.Stat(offered); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = ensureDir(filepath.Dir(offered), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(mailboxEntry{Wishes: Wishes{Source: "thread"}.withDefaults(Request{}), QueuedAt: time.Now().UnixNano(), Disposition: "acknowledged"})
	if err != nil {
		return err
	}
	return mailboxWrite(offered, b, false)
}
