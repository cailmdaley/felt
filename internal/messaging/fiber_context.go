package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
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

// designateFiberReceiver serializes replacement with hook output and native
// delivery. Subscription links only locate queues; this receiver record alone
// grants consumption authority, including when the queue is empty.
type fiberReceiver struct {
	Address
	Generation uint64 `json:"generation"`
}

// ReserveFiberGeneration runs in the owner's serialized selection call, before
// any asynchronous delivery. The counter survives daemon restarts and empty queues.
func ReserveFiberGeneration(env *sysenv.Env, fiber string) (uint64, error) {
	root := mailboxDir(env, "fiber", fiber)
	if err := ensureDir(root, 0700); err != nil {
		return 0, err
	}
	lock, err := os.OpenFile(filepath.Join(root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return 0, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return 0, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	path := filepath.Join(root, "generation")
	bytes, err := readBounded(path, 64)
	var n uint64
	if err == nil {
		n, err = strconv.ParseUint(string(bytes), 10, 64)
	} else if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	if err != nil {
		return 0, err
	}
	if n == ^uint64(0) {
		return 0, errors.New("fiber generation exhausted")
	}
	n++
	return n, mailboxWrite(path, []byte(strconv.FormatUint(n, 10)), false)
}

func designateFiberReceiver(env *sysenv.Env, fiber string, a Address, hook bool, generation uint64, strict bool) error {
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
	previous, readErr := readBounded(filepath.Join(root, "destination.json"), 16384)
	var old fiberReceiver
	if readErr == nil {
		if json.Unmarshal(previous, &old) != nil && strict {
			return errors.New("invalid fiber receiver authority")
		}
		if old.Generation > generation || (old.Generation == generation && old.Address != a) {
			return errCode("stale_receiver", "superseded fiber receiver selection")
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	bytes, err := json.Marshal(fiberReceiver{Address: a, Generation: generation})
	if err != nil {
		return err
	}
	// Revoke the predecessor before publishing the successor's discovery link.
	// An interrupted or failed update leaves results pending, not readable by A.
	if err := mailboxWrite(filepath.Join(root, "destination.json"), bytes, false); err != nil {
		return err
	}
	if !hook {
		return nil
	}
	bytes, err = json.Marshal(fiberMailboxLink{Fiber: fiber, Host: a.Host})
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
	var receiver fiberReceiver
	return err == nil && json.Unmarshal(bytes, &receiver) == nil && receiver.Address == a
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
func DeliverFiberContext(ctx context.Context, env *sysenv.Env, fiber, host, address string, generations ...uint64) error {
	var generation uint64
	var err error
	if len(generations) > 0 {
		generation = generations[0]
	} else {
		generation, err = ReserveFiberGeneration(env, fiber)
	}
	if err != nil {
		return err
	}
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
	if err := designateFiberReceiver(env, fiber, a, hook, generation, len(generations) > 0); err != nil {
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
	return offerMailbox(root, func(r Request) bool { return (r.Wake || !hook) && fiberReceiverMatches(root, a) }, func(batch []Request) error {
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
