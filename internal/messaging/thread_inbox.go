package messaging

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// ThreadInboxState is capture policy, not a queue. Baseline never advances;
// Cutoff is monotonic so expiring dedup entries cannot republish old events.
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
		return s, err
	}
	for _, stamp := range []string{s.Baseline, s.Cutoff} {
		if _, err := time.Parse(time.RFC3339Nano, stamp); err != nil {
			return s, fmt.Errorf("invalid thread inbox cutoff: %w", err)
		}
	}
	return s, nil
}

func (s ThreadInboxState) retains(stamp string) bool {
	t, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil {
		return true
	}
	cutoff, _ := time.Parse(time.RFC3339Nano, s.Cutoff)
	return !t.Before(cutoff) && !t.Before(time.Now().Add(-mailboxRetention))
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

// publicationExists deduplicates derived IDs across placement changes. It reads
// entries, not another receipt store: imported ack-only entries live in offered.
// The mailboxes lock serializes derived writers; readers may only finalize them.
func publicationExists(env *sysenv.Env, id string) (bool, error) {
	paths, err := filepath.Glob(filepath.Join(dataDir(env), "mailboxes", "*", "*", "*", mailboxKey(id)+".json"))
	if err != nil {
		return false, err
	}
	for _, path := range paths {
		state := filepath.Base(filepath.Dir(path))
		if state != "pending" && state != "offered" {
			continue
		}
		st, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, err
		}
		if state == "offered" && time.Since(st.ModTime()) > mailboxRetention {
			continue
		}
		return true, nil
	}
	return false, nil
}

func routeString(r map[string]any, key string) string { s, _ := r[key].(string); return s }
func threadStamp(r map[string]any) string {
	if signal, ok := r["signal"].(map[string]any); ok && routeString(signal, "stamp") != "" {
		return routeString(signal, "stamp")
	}
	return routeString(r, "retained_at")
}

// ThreadEntry preserves the thread producer's IDs and immutable publication.
// Unresolved fiber entries use the captured parent's host-local inbox key;
// session notices use the session's own inbox, with routing holding its wake.
func ThreadEntry(id string, record map[string]any) (InboxEntry, error) {
	address := routeString(record, "session")
	if address == "" {
		address = routeString(record, "store") + ":" + routeString(record, "parent_uid")
	}
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
	return InboxEntry{Address: address, Request: req, Wishes: Wishes{Source: "thread", Turn: turn, IfCostly: "fresh"}, Derived: true, Routing: record}, nil
}

type RoutedEntry struct {
	Address string         `json:"address"`
	ID      string         `json:"id"`
	Record  map[string]any `json:"record"`
}

// RoutedEntries lists pending routing work from the inbox alone, even when
// the original fiber no longer appears in the poller's inventory.
func RoutedEntries(env *sysenv.Env, owner string) ([]RoutedEntry, error) {
	paths, err := filepath.Glob(filepath.Join(dataDir(env), "mailboxes", "*", "*", "pending", "*.json"))
	if err != nil {
		return nil, err
	}
	out := []RoutedEntry{}
	for _, path := range paths {
		e, err := readFiberMailboxEntry(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if e.Routing == nil || routeString(e.Routing, "owner") != owner {
			continue
		}
		entry, err := ThreadEntry(e.Request.MessageID, e.Routing)
		if err != nil {
			return nil, err
		}
		// Routing resolution never changes the physical address of the entry.
		address := routeString(e.Routing, "inbox_address")
		if address == "" {
			address = entry.Address
		}
		out = append(out, RoutedEntry{address, e.Request.MessageID, e.Routing})
	}
	return out, nil
}

// RouteFacts are the daemon's fresh authoritative observations. An empty
// Current or Owner waits. Resolution may select a UID only while unresolved;
// later observations can change its placement, never the recipient.
type RouteFacts struct {
	ID          string
	Current     string
	Record      map[string]any
	Destination string
	Owner       string
}

func consumeRoute(env *sysenv.Env, address, host string, f RouteFacts) (Consumption, error) {
	result := Consumption{Action: "wait"}
	root, err := inboxRoot(env, address)
	if err != nil {
		return Consumption{}, err
	}
	unlock, err := lockInbox(root)
	if err != nil {
		return Consumption{}, err
	}
	defer unlock()
	path := filepath.Join(root, "pending", mailboxKey(f.ID)+".json")
	e, err := readFiberMailboxEntry(path)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return Consumption{}, err
	}
	if e.Disposition != "" {
		return result, moveToOffered(root, path)
	}
	if e.Routing == nil || !e.due(time.Now()) {
		return result, nil
	}
	if requestExpired(e.Request, time.Now()) {
		return result, finishRouted(root, path, e, "expired")
	}
	if f.Current == "false" {
		return result, finishRouted(root, path, e, "superseded")
	}
	if routeString(e.Routing, "session") != "" {
		if f.Current != "true" {
			return result, nil
		}
		return Consumption{Action: "session", Members: []string{f.ID}, Entry: &RoutedEntry{address, f.ID, e.Routing}}, nil
	}
	if f.Record == nil || f.Owner == "" {
		return result, nil
	}
	if e.Routing["parent_unresolved"] != true && routeString(e.Routing, "parent_uid") != routeString(f.Record, "parent_uid") {
		return Consumption{}, errCode("invalid_request", "a resolved thread recipient is immutable")
	}
	// Persist only routing fields; the publication and wishes never change.
	for _, key := range []string{"parent_uid", "parent_host", "store", "resolved_from_uid"} {
		if value, ok := f.Record[key]; ok {
			e.Routing[key] = value
		}
	}
	delete(e.Routing, "parent_unresolved")
	e.Routing["inbox_address"] = address
	b, err := json.Marshal(e)
	if err != nil {
		return Consumption{}, err
	}
	if err = mailboxWrite(path, b, false); err != nil {
		return Consumption{}, err
	}
	if f.Current != "true" {
		return result, nil
	}
	if f.Owner != host {
		return Consumption{Action: "forward", Members: []string{f.ID}, Entry: &RoutedEntry{address, f.ID, e.Routing}}, nil
	}
	if f.Destination == "" {
		return result, nil
	}
	if f.Destination == address {
		e.Routing = nil
		b, err := json.Marshal(e)
		if err != nil {
			return Consumption{}, err
		}
		return result, mailboxWrite(path, b, false)
	}
	// A local archived anchor resolves to another inbox. The destination is
	// durable before the source is finalized, and a repeated transfer is a no-op.
	err = Enqueue(env, InboxEntry{Address: f.Destination, Request: e.Request, Wishes: e.Wishes, Derived: true, localTransfer: true})
	if err != nil {
		return Consumption{}, err
	}
	return result, finishRouted(root, path, e, "forwarded")
}

func finishRouted(root, path string, e mailboxEntry, disposition string) error {
	e.Disposition = disposition
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	// Persist the verdict before moving. A crash between these writes settles
	// it on the next consume without another emission.
	if err = mailboxWrite(path, b, false); err != nil {
		return err
	}
	return moveToOffered(root, path)
}

// SettleRoute records a confirmed durable forward or final session outcome.
// Unknown outcomes never call it and leave the same entry for the next poll.
func SettleRoute(env *sysenv.Env, address, id, disposition string) error {
	if disposition != "forwarded" && disposition != "delivered" && disposition != "undeliverable" {
		return errCode("invalid_request", "invalid routing disposition")
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

// BootThreadInbox imports every supported outbox image before removing it.
// No source file is removed until the entire import is durable. Repeating an
// interrupted import is safe: acknowledgments win, and Enqueue keeps the first
// pending publication. The state file survives removal and future boots.
func BootThreadInbox(env *sysenv.Env) (ThreadInboxState, error) {
	unlock, err := lockInbox(filepath.Join(dataDir(env), "thread-import"))
	if err != nil {
		return ThreadInboxState{}, err
	}
	defer unlock()
	return bootThreadInbox(env, nil)
}

func bootThreadInbox(env *sysenv.Env, imported func(string) error) (ThreadInboxState, error) {
	root := filepath.Join(dataDir(env), "thread-outbox")
	snapshot := root + ".json"
	state, stateErr := ReadThreadInboxState(env)
	if stateErr != nil && !errors.Is(stateErr, os.ErrNotExist) {
		return state, stateErr
	}
	completed := root + ".imported"
	if stateErr == nil {
		if err := os.RemoveAll(completed); err != nil {
			return state, err
		}
	}
	baseline, err := os.ReadFile(filepath.Join(root, "baseline"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return state, err
	}
	records := map[string]map[string]any{}
	acked := map[string]bool{}
	var legacy struct {
		Version  int                       `json:"version"`
		Baseline string                    `json:"baseline"`
		Records  map[string]map[string]any `json:"records"`
	}
	bytes, err := os.ReadFile(snapshot)
	if err == nil {
		if err = json.Unmarshal(bytes, &legacy); err != nil {
			return state, err
		}
		if legacy.Version < 1 || legacy.Version > 3 || legacy.Records == nil {
			return state, errors.New("invalid thread outbox snapshot")
		}
		if legacy.Version > 1 {
			if _, err = time.Parse(time.RFC3339Nano, legacy.Baseline); err != nil {
				return state, err
			}
		}
		for id, record := range legacy.Records {
			if record == nil {
				return state, errors.New("invalid thread outbox record")
			}
			if record["acked"] == true {
				acked[id] = true
			} else {
				records[id] = record
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return state, err
	}
	pending, err := filepath.Glob(filepath.Join(root, "pending", "*.json"))
	if err != nil {
		return state, err
	}
	acks, err := filepath.Glob(filepath.Join(root, "acked", "*"))
	if err != nil {
		return state, err
	}
	_, versionErr := os.Stat(filepath.Join(root, "version"))
	if len(baseline) == 0 && (versionErr == nil || len(pending)+len(acks) > 0) {
		return state, errors.New("missing thread outbox baseline")
	}
	if len(baseline) == 0 {
		baseline = []byte(legacy.Baseline)
	}
	if len(baseline) != 0 {
		if _, err = time.Parse(time.RFC3339Nano, string(baseline)); err != nil {
			return state, err
		}
		if legacy.Baseline != "" && legacy.Baseline != string(baseline) {
			return state, errors.New("thread outbox baselines differ")
		}
		if state.Baseline != "" && state.Baseline != string(baseline) {
			return state, errors.New("thread inbox and outbox baselines differ")
		}
		state.Baseline = string(baseline)
	}
	if state.Baseline == "" {
		state.Baseline = time.Now().UTC().Format(time.RFC3339Nano)
	}
	cutoff, err := os.ReadFile(filepath.Join(root, "retention_cutoff"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return state, err
	}
	for _, value := range []string{string(cutoff), time.Now().Add(-mailboxRetention).UTC().Format(time.RFC3339Nano)} {
		if value == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return state, err
		}
		old, _ := time.Parse(time.RFC3339Nano, state.Cutoff)
		if t.After(old) {
			state.Cutoff = value
		}
	}
	for _, path := range acks {
		b, err := os.ReadFile(path)
		if err != nil {
			return state, err
		}
		id := string(b)
		if filepath.Base(path) != mailboxKey(id) {
			return state, fmt.Errorf("invalid thread acknowledgment: %s", path)
		}
		acked[id] = true
	}
	for _, path := range pending {
		var record struct {
			ID     string         `json:"id"`
			Record map[string]any `json:"record"`
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return state, err
		}
		if err = json.Unmarshal(b, &record); err != nil {
			return state, err
		}
		if record.ID == "" || record.Record == nil || filepath.Base(path) != mailboxKey(record.ID)+".json" {
			return state, fmt.Errorf("invalid thread payload: %s", path)
		}
		records[record.ID] = record.Record
	}
	// Validate the complete source before writing any migration state.
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
	for id := range acked {
		if err = importThreadAck(env, id); err != nil {
			return state, err
		}
		if imported != nil {
			if err = imported(id); err != nil {
				return state, err
			}
		}
	}
	for id, record := range records {
		if acked[id] {
			continue
		}
		if parent, ok := record["parent"].(map[string]any); ok {
			if uid := routeString(parent, "uid"); uid != "" {
				record["parent_uid"] = uid
				delete(record, "parent")
			}
		}
		entry, err := ThreadEntry(id, record)
		if err != nil {
			return state, err
		}
		entry.importing = true
		if err = Enqueue(env, entry); err != nil {
			return state, err
		}
		if imported != nil {
			if err = imported(id); err != nil {
				return state, err
			}
		}
	}
	if err = os.Remove(snapshot); err != nil && !errors.Is(err, os.ErrNotExist) {
		return state, err
	}
	// Rename the complete source before recursive deletion. A crash during
	// cleanup cannot make a partially removed outbox look corrupt on boot.
	if err = os.Rename(root, completed); err != nil && !errors.Is(err, os.ErrNotExist) {
		return state, err
	}
	if err = syncDir(dataDir(env)); err != nil {
		return state, err
	}
	if err = os.RemoveAll(completed); err != nil {
		return state, err
	}
	return state, nil
}

func importThreadAck(env *sysenv.Env, id string) error {
	// Ack files have no recipient or payload. An offered entry in this inbox is
	// sufficient for cross-inbox derived dedup without inventing either.
	root := mailboxDir(env, "fiber", "thread-acknowledgments")
	unlock, err := lockInbox(root)
	if err != nil {
		return err
	}
	defer unlock()
	path := filepath.Join(root, "offered", mailboxKey(id)+".json")
	if _, err = os.Stat(path); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err = ensureDir(filepath.Dir(path), 0700); err != nil {
			return err
		}
		b, _ := json.Marshal(mailboxEntry{Request: Request{MessageID: id}, Wishes: Wishes{Source: "thread"}.withDefaults(Request{}), Disposition: "forwarded", QueuedAt: time.Now().UnixNano()})
		if err = mailboxWrite(path, b, false); err != nil {
			return err
		}
	}
	// An interrupted earlier import may have installed a pending copy first.
	paths, _ := filepath.Glob(filepath.Join(dataDir(env), "mailboxes", "*", "*", "pending", mailboxKey(id)+".json"))
	for _, path := range paths {
		if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
