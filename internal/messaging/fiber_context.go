package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/cailmdaley/felt/internal/sysenv"
)

type fiberMailboxLink struct {
	Fiber string `json:"fiber"`
	Host  string `json:"host"`
}

// QueueFiberContext keeps context for a task across worker conversations. It
// uses the hook mailbox storage and offer/ack protocol, keyed by durable fiber
// identity instead of a harness process. Only the owning daemon calls it.
func QueueFiberContext(env *sysenv.Env, fiber string, r Request) error {
	if fiber == "" || r.MessageID == "" || r.Text == "" || len(r.Text) > 64<<10 {
		return errCode("invalid_request", "fiber context requires a key, message id and text (at most 64 KiB)")
	}
	root := mailboxDir(env, "fiber", fiber)
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
		if _, err := os.Stat(filepath.Join(root, state, mailboxKey(r.MessageID)+".json")); err == nil {
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return enqueueMailbox(root, r)
}

// PendingFiberContext counts the context a fiber's mailbox holds that no
// worker has taken yet: thread results and messages queued for its next
// worker. A fiber without a mailbox holds none. It reads only the directory
// listing, so it never contends with a delivery holding the mailbox lock.
func PendingFiberContext(env *sysenv.Env, fiber string) (int, error) {
	entries, err := os.ReadDir(filepath.Join(mailboxDir(env, "fiber", fiber), "pending"))
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

// Worker transitions alone publish authority. Delivery and hook subscriptions
// cannot change it. Identity includes the execution and conversation identity.
type FiberReceiver struct {
	Address
	Identity   string `json:"identity"`
	Generation uint64 `json:"generation"`
}

// TransitionFiberReceiver runs synchronously in the owner's serialized worker
// transition. Re-adoption of an unchanged worker preserves its durable epoch.
// A removed or not-yet-addressable worker uses address "-".
func TransitionFiberReceiver(env *sysenv.Env, fiber, host, identity, address string) (uint64, error) {
	return transitionFiberReceiver(env, fiber, host, identity, address, true)
}

// RevokeExistingFiberReceiver revokes the receiver of a fiber that already has
// a mailbox, and reports whether it had one. A fiber without a mailbox has no
// receiver to fence, so no state is created for it.
func RevokeExistingFiberReceiver(env *sysenv.Env, fiber, host string) (bool, error) {
	epoch, err := transitionFiberReceiver(env, fiber, host, "", "-", false)
	return epoch != 0, err
}

func transitionFiberReceiver(env *sysenv.Env, fiber, host, identity, address string, create bool) (uint64, error) {
	a := Address{Host: host}
	var err error
	if address != "-" {
		a, err = ParseAddress(address)
	}
	if err != nil {
		return 0, err
	}
	if a.Host != host {
		return 0, errCode("wrong_host", "fiber receiver belongs to another host")
	}
	root := mailboxDir(env, "fiber", fiber)
	if create {
		if err := ensureDir(root, 0700); err != nil {
			return 0, err
		}
	}
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if !create && errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return 0, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	path := filepath.Join(root, "destination.json")
	bytes, err := readBounded(path, 16384)
	var old FiberReceiver
	if err == nil {
		if err := json.Unmarshal(bytes, &old); err != nil {
			return 0, err
		}
		if old.Identity == identity && old.Address == a && old.Generation != 0 {
			return old.Generation, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	if old.Generation == ^uint64(0) {
		return 0, errors.New("fiber epoch exhausted")
	}
	next := FiberReceiver{Address: a, Identity: identity, Generation: old.Generation + 1}
	bytes, err = json.Marshal(next)
	if err != nil {
		return 0, err
	}
	return next.Generation, mailboxWrite(path, bytes, false)
}

// ReadFiberReceiver reads the durable worker-owned authority for restart
// recovery. A missing record is distinct from an explicit unknown receiver;
// corrupt or unreadable records are errors, never permission to reset identity.
func ReadFiberReceiver(env *sysenv.Env, fiber string) (*FiberReceiver, error) {
	root := mailboxDir(env, "fiber", fiber)
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return nil, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	receiver, err := readFiberReceiver(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if receiver.Generation == 0 {
		return nil, errors.New("invalid fiber receiver epoch")
	}
	return &receiver, nil
}

// Called only under the mailbox lock, including during output emission.
func readFiberReceiver(root string) (FiberReceiver, error) {
	bytes, err := readBounded(filepath.Join(root, "destination.json"), 16384)
	var receiver FiberReceiver
	if err == nil {
		err = json.Unmarshal(bytes, &receiver)
	}
	return receiver, err
}

func subscribeFiberReceiver(env *sysenv.Env, fiber string, a Address, hook bool, generation uint64) error {
	root := mailboxDir(env, "fiber", fiber)
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	receiver, err := readFiberReceiver(root)
	if err != nil || generation == 0 || receiver.Generation != generation || receiver.Address != a {
		return errCode("stale_receiver", "superseded worker identity")
	}
	if !hook {
		return nil
	}
	bytes, err := json.Marshal(fiberMailboxLink{Fiber: fiber, Host: a.Host})
	if err != nil {
		return err
	}
	dir := filepath.Join(mailboxDir(env, a.Harness, a.ID), "fibers")
	if err := ensureDir(dir, 0700); err != nil {
		return err
	}
	return mailboxWrite(filepath.Join(dir, mailboxKey(fiber)+".json"), bytes, false)
}

// fiberReceiverMatches is called only while the fiber mailbox lock is held.
// Missing or malformed authority fails closed; registration cannot restore it.
func fiberReceiverMatches(root string, a Address) bool {
	bytes, err := readBounded(filepath.Join(root, "destination.json"), 16384)
	var receiver FiberReceiver
	return err == nil && json.Unmarshal(bytes, &receiver) == nil && receiver.Address == a && receiver.Generation != 0 && receiver.Identity != ""
}

// offerLinkedFiberContext uses the fiber mailbox's own lock and acknowledgment
// boundary. Competing hooks (including a successor's) cannot emit it twice.
func offerLinkedFiberContext(env *sysenv.Env, harness, id, host string, emit func([]Request) error) error {
	dir := filepath.Join(mailboxDir(env, harness, id), "fibers")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		bytes, err := readBounded(filepath.Join(dir, entry.Name()), 16384)
		var link fiberMailboxLink
		if err != nil || json.Unmarshal(bytes, &link) != nil || link.Fiber == "" || link.Host != host || entry.Name() != mailboxKey(link.Fiber)+".json" {
			continue
		}
		offered := false
		root := mailboxDir(env, "fiber", link.Fiber)
		err = offerMailbox(root, func(r Request) bool {
			return !r.Wake && fiberReceiverMatches(root, Address{Host: host, Harness: harness, ID: id}) && MailboxAvailable(env, harness, id, host)
		}, func(batch []Request) error {
			offered = true
			return emit(batch)
		})
		if err != nil || offered {
			return err
		}
	}
	return nil
}

// DeliverFiberContext offers pending context to the current conversation. The
// mailbox acknowledges only confirmed context receipts; retries retain each
// message id so a crash after delivery cannot inject it twice.
func DeliverFiberContext(ctx context.Context, env *sysenv.Env, fiber, host, address string, generation uint64) error {
	var err error
	a := Address{Host: host}
	if address != "-" {
		a, err = ParseAddress(address)
	}
	if err != nil {
		return err
	}
	if a.Host != host {
		return errCode("wrong_host", "fiber context belongs to another host")
	}
	root := mailboxDir(env, "fiber", fiber)
	// Hooks offer the fiber queue itself, so replacing a conversation before
	// its next hook cannot strand a result in a session-scoped pending queue.
	hook := MailboxAvailable(env, a.Harness, a.ID, host)
	if err := ensureDir(root, 0700); err != nil {
		return err
	}
	if err := subscribeFiberReceiver(env, fiber, a, hook, generation); err != nil {
		return err
	}
	if address == "-" {
		return nil
	}
	// Selection revokes A even if B is not hook-ready yet. Never fall back to
	// an old subscriber merely because the designated successor is unavailable.
	if a.Harness == "claude" {
		if reason := mailboxUnavailable(env, a.Harness, a.ID, host); reason != "" {
			return errCode("unavailable", "%s", reason)
		}
	}
	return offerMailbox(root, func(r Request) bool {
		receiver, err := readFiberReceiver(root)
		return err == nil && receiver.Generation == generation && (r.Wake || !hook) && fiberReceiverMatches(root, a)
	}, func(batch []Request) error {
		for _, req := range batch {
			req.Address = address
			// A successor has its own dedup fingerprint; retries to the same
			// conversation still carry exactly the same transport message id.
			req.MessageID += "-" + mailboxKey(address)[:16]
			receipt, err := Send(ctx, env, host, req)
			if err != nil {
				return err
			}
			if receipt.Status != StatusContextAdded && receipt.Status != StatusAccepted {
				return errCode("unconfirmed", "context delivery: %s", receipt.Status)
			}
		}
		return nil
	})
}
