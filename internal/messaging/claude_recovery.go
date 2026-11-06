package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

const claudeHookOfferWindow = 30 * time.Second
const claudeHookBatchBytes = (8 << 10) - 512 // Leave room for the hook's framing.
const claudeFallbackAttempts = 3

// The fallback directory is the transport claim. WriteStarted is persisted
// immediately before the native write: an interrupted preflight is safe to
// retry, but a write without a result is ambiguous and must not be repeated.
type claudeFallback struct {
	Attempts     int      `json:"attempts,omitempty"`
	WriteStarted bool     `json:"write_started,omitempty"`
	Receipt      *Receipt `json:"receipt,omitempty"`
	ErrorCode    string   `json:"error_code,omitempty"`
	ErrorMessage string   `json:"error_message,omitempty"`
}

// ClaudeFailureTarget is a return address, not an assertion of sender identity.
// A sender with no return address must use synchronous native delivery.
func ClaudeFailureTarget(req Request) string {
	for _, target := range []string{req.From, req.NotifyAddress, req.FromClaim, req.ReplyTo} {
		if _, err := ParseAddress(target); err == nil {
			return target
		}
	}
	return ""
}

// RecoverClaudeMail runs one bounded pass. A single writable lock excludes
// overlapping CLI/daemon passes, including on NFS. Hooks only contend on the
// short mailbox rename, never on native delivery or notification I/O.
// notify routes failures back through the daemon; nil leaves failures durable.
func RecoverClaudeMail(ctx context.Context, env *sysenv.Env, host string, now time.Time, notify func(context.Context, Request) error) error {
	root := filepath.Join(dataDir(env), "mailboxes", "claude")
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	lock, err := os.OpenFile(filepath.Join(root, ".recovery.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil
		}
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	ctx, cancel := context.WithTimeout(ctx, reservationDeadlineCeiling)
	defer cancel()
	var items []mailboxPendingItem
	if err := walkClaudeMail(env, func(item mailboxPendingItem) error {
		a, err := ParseAddress(item.entry.Request.Address)
		if err != nil || a.Harness != "claude" || a.Host != host {
			return nil
		}
		turn, _ := MailboxState(env, "claude", a.ID, host)
		if filepath.Base(filepath.Dir(item.path)) == "pending" && turn == "working" && now.Sub(time.Unix(0, item.entry.QueuedAt)) < claudeHookOfferWindow {
			return nil
		}
		items = append(items, item)
		return nil
	}); err != nil {
		return err
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].entry.QueuedAt == items[j].entry.QueuedAt {
			return items[i].path < items[j].path
		}
		return items[i].entry.QueuedAt < items[j].entry.QueuedAt
	})
	var failures []error
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		if err := recoverClaudeMessage(ctx, env, item, notify); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// ClaudeMailPending keeps fast recovery scheduled only while automatic mail
// remains. Context-only mail never schedules a wake.
func ClaudeMailPending(env *sysenv.Env) (bool, error) {
	pending := false
	err := walkClaudeMail(env, func(mailboxPendingItem) error {
		pending = true
		return fs.SkipAll
	})
	return pending, err
}

// Both recovery and scheduling inspect the same live automatic entries.
func walkClaudeMail(env *sysenv.Env, visit func(mailboxPendingItem) error) error {
	root := filepath.Join(dataDir(env), "mailboxes", "claude")
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if d.IsDir() && d.Name() == "offered" {
			return filepath.SkipDir
		}
		state := filepath.Base(filepath.Dir(path))
		if d.IsDir() || (state != "pending" && state != "fallback") || !strings.HasSuffix(path, ".json") {
			return nil
		}
		entry, err := readFiberMailboxEntry(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil // A hook can offer the entry during the scan.
		}
		if err != nil {
			return err
		}
		if !entry.Request.ContextIfBusy {
			return nil
		}
		return visit(mailboxPendingItem{path, entry})
	})
}

func recoverClaudeMessage(ctx context.Context, env *sysenv.Env, item mailboxPendingItem, notify func(context.Context, Request) error) error {
	dir, key := filepath.Dir(filepath.Dir(item.path)), filepath.Base(item.path)
	claimed, err := claimClaudeFallback(dir, key)
	if err != nil || !claimed {
		return err
	}
	path := filepath.Join(dir, "fallback", key)
	entry, err := readFiberMailboxEntry(path)
	if err != nil {
		return err
	}
	if entry.Fallback == nil {
		entry.Fallback = &claudeFallback{}
	}
	attempt := entry.Fallback
	req := entry.Request
	a, _ := ParseAddress(req.Address)
	if attempt.Receipt == nil {
		var receipt Receipt
		var failure error
		switch {
		case attempt.WriteStarted:
			receipt, failure = stoppedAttempt(req)
		case mailboxReceiverEnded(env, "claude", a.ID, a.Host):
			receipt, failure = rejected(req, "claude-native", "receiver exited before delivery"), errCode("receiver_exited", "receiver exited before delivery")
		default:
			attempt.Attempts++
			if err := writeClaudeEntry(path, entry); err != nil {
				return err
			}
			// publishOwnerDeadline runs immediately before conn.Write. No other
			// reservation or delivery record is needed for this exclusive claim.
			sendCtx := context.WithValue(ctx, reservationDeadlinePublisherKey{}, func(time.Time) error {
				attempt.WriteStarted = true
				return writeClaudeEntry(path, entry)
			})
			req.Wake, req.ContextIfBusy = true, false
			receipt, failure, _ = sendClaudeNativeBrief(sendCtx, env, a, req)
			if ErrorCode(failure) == "preflight_failed" && attempt.Attempts < claudeFallbackAttempts {
				attempt.WriteStarted = false
				if err := writeClaudeEntry(path, entry); err != nil {
					return err
				}
				// No write happened. A later main-thread hook can still deliver.
				return renameClaudeMail(path, filepath.Join(dir, "pending", key))
			}
		}
		attempt.Receipt = &receipt
		if failure != nil {
			attempt.ErrorCode, attempt.ErrorMessage = ErrorCode(failure), failure.Error()
		}
		if err := writeClaudeEntry(path, entry); err != nil {
			return err
		}
	}
	if attempt.ErrorCode != "" {
		if notify == nil {
			return fmt.Errorf("Claude mail %s: %s", req.MessageID, attempt.ErrorMessage)
		}
		notice := Request{
			Address: ClaudeFailureTarget(req), From: "shuttle", Wake: true,
			MessageID: "claude-mail-failure-" + mailboxKey(req.Address + "\x00" + req.MessageID)[:32],
			Text:      fmt.Sprintf("Shuttle could not confirm delivery of message %s to %s: %s. Delivery status: %s. No automatic resend will occur; check the receiver before resending.", req.MessageID, req.Address, attempt.ErrorMessage, attempt.Receipt.Status),
		}
		if err := notify(ctx, notice); err != nil {
			return err // Keep the result, not permission to repeat the write.
		}
	}
	return renameClaudeMail(path, filepath.Join(dir, "offered", key))
}

func writeClaudeEntry(path string, entry mailboxEntry) error {
	b, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return mailboxWrite(path, b, false)
}

func renameClaudeMail(from, to string) error {
	if err := ensureDir(filepath.Dir(to), 0700); err != nil {
		return err
	}
	if err := os.Rename(from, to); err != nil {
		return err
	}
	return errors.Join(syncDir(filepath.Dir(from)), syncDir(filepath.Dir(to)))
}

// The rename is the claim. The same short lock encloses hook output, so a
// message can belong to the hook or the fallback, never both.
func claimClaudeFallback(dir, key string) (bool, error) {
	lock, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return false, nil
		}
		return false, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	fallback := filepath.Join(dir, "fallback", key)
	if _, err := os.Stat(fallback); err == nil {
		return true, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	err = renameClaudeMail(filepath.Join(dir, "pending", key), fallback)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// A queued receipt can report a completed hook/fallback result on retry,
// without another native write or a model-response observation window.
func refreshClaudeHookReceipt(env *sysenv.Env, req Request, old record) record {
	a, err := ParseAddress(req.Address)
	if err != nil {
		return old
	}
	dir := mailboxDir(env, "claude", a.ID)
	for _, state := range []string{"offered", "fallback"} {
		entry, err := readFiberMailboxEntry(filepath.Join(dir, state, mailboxKey(req.MessageID)+".json"))
		if err != nil {
			continue
		}
		if entry.Fallback != nil && entry.Fallback.Receipt != nil {
			r := entry.Fallback.Receipt
			old.Receipt.Status, old.Receipt.Transport, old.Receipt.Detail = r.Status, r.Transport, r.Detail
			old.ErrorCode, old.ErrorMessage = entry.Fallback.ErrorCode, entry.Fallback.ErrorMessage
		} else if state == "offered" {
			old.Receipt.Status, old.Receipt.Detail = StatusContextAdded, "the main-thread hook wrote this message as context; no claim of a model reply"
		}
		return old
	}
	return old
}
