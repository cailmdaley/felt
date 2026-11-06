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
	Attempts       int      `json:"attempts,omitempty"`
	WriteStarted   bool     `json:"write_started,omitempty"`
	Receipt        *Receipt `json:"receipt,omitempty"`
	ErrorCode      string   `json:"error_code,omitempty"`
	ErrorMessage   string   `json:"error_message,omitempty"`
	NoticeAttempts int      `json:"notice_attempts,omitempty"`
	NoticeAfter    int64    `json:"notice_after,omitempty"`
}

// ClaudeFailureTarget is the session a failure notice returns to. A sender with
// no return address must use synchronous native delivery.
func ClaudeFailureTarget(req Request) string {
	for _, target := range []string{req.From, req.NotifyAddress, req.ReplyTo} {
		if _, err := ParseAddress(target); err == nil {
			return target
		}
	}
	return ""
}

// RecoverClaudeMail runs one bounded pass and reports whether unsent automatic
// mail needs a fast follow-up. Notice-only entries wait for the minute sweep.
// One writable lock excludes overlapping passes, including on NFS. Hooks only
// contend on the short mailbox rename, never on native or notification I/O.
func RecoverClaudeMail(ctx context.Context, env *sysenv.Env, host string, now time.Time, notify func(context.Context, Request) error) (pending bool, result error) {
	root := filepath.Join(dataDir(env), "mailboxes", "claude")
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	lock, err := os.OpenFile(filepath.Join(root, ".recovery.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return true, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return true, nil
		}
		return true, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	ctx, cancel := context.WithTimeout(ctx, reservationDeadlineCeiling)
	defer cancel()
	var items []mailboxPendingItem
	var failures []error
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("skipping Claude mail %s: %w", path, err))
			return nil
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
			return nil
		} // A hook can offer during the scan.
		if err != nil {
			failures = append(failures, fmt.Errorf("skipping Claude mail %s: %w", path, err))
			return nil
		}
		a, err := ParseAddress(entry.Request.Address)
		if err != nil || a.Harness != "claude" || a.Host != host || !entry.Request.ContextIfBusy {
			return nil
		}
		if entry.Fallback != nil && entry.Fallback.Receipt != nil && now.UnixNano() < entry.Fallback.NoticeAfter {
			return nil
		}
		turn, _ := MailboxState(env, "claude", a.ID, host)
		if state == "pending" && turn == "working" && now.Sub(time.Unix(0, entry.QueuedAt)) < claudeHookOfferWindow {
			pending = true
			return nil
		}
		items = append(items, mailboxPendingItem{path, entry})
		return nil
	})
	if err != nil {
		failures = append(failures, err)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].entry.QueuedAt == items[j].entry.QueuedAt {
			return items[i].path < items[j].path
		}
		return items[i].entry.QueuedAt < items[j].entry.QueuedAt
	})
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return true, errors.Join(append(failures, err)...)
		}
		fast, err := recoverClaudeMessage(ctx, env, item, now, notify)
		pending = pending || fast
		if err != nil {
			failures = append(failures, err)
		}
	}
	return pending, errors.Join(failures...)
}

func recoverClaudeMessage(ctx context.Context, env *sysenv.Env, item mailboxPendingItem, now time.Time, notify func(context.Context, Request) error) (bool, error) {
	dir, key := filepath.Dir(filepath.Dir(item.path)), filepath.Base(item.path)
	claimed, err := claimClaudeFallback(dir, key)
	if err != nil || !claimed {
		return true, err
	}
	path := filepath.Join(dir, "fallback", key)
	entry, err := readFiberMailboxEntry(path)
	if err != nil {
		return true, err
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
				return true, err
			}
			// This marker is published immediately before conn.Write.
			sendCtx := context.WithValue(ctx, reservationDeadlinePublisherKey{}, func(time.Time) error {
				attempt.WriteStarted = true
				return writeClaudeEntry(path, entry)
			})
			req.Wake, req.ContextIfBusy = true, false
			receipt, failure, _ = sendClaudeNativeBrief(sendCtx, env, a, req)
			if ErrorCode(failure) == "preflight_failed" && attempt.Attempts < claudeFallbackAttempts {
				attempt.WriteStarted = false
				if err := writeClaudeEntry(path, entry); err != nil {
					return true, err
				}
				return true, renameClaudeMail(path, filepath.Join(dir, "pending", key))
			}
		}
		attempt.Receipt = &receipt
		if failure != nil {
			attempt.ErrorCode, attempt.ErrorMessage = ErrorCode(failure), failure.Error()
		}
		if err := writeClaudeEntry(path, entry); err != nil {
			return true, err
		}
	}
	if attempt.ErrorCode != "" {
		if notify == nil {
			return false, fmt.Errorf("Claude mail %s: %s", req.MessageID, attempt.ErrorMessage)
		}
		if attempt.NoticeAttempts < claudeFallbackAttempts {
			attempt.NoticeAttempts++
			attempt.NoticeAfter = now.Add(time.Minute).UnixNano()
			if err := writeClaudeEntry(path, entry); err != nil {
				return false, err
			}
			notice := Request{
				Address: ClaudeFailureTarget(req), From: "shuttle", Wake: true,
				MessageID: "claude-mail-failure-" + mailboxKey(req.Address + "\x00" + req.MessageID)[:32],
				Text:      fmt.Sprintf("Shuttle could not confirm delivery of message %s to %s (%s, status %s). No automatic resend will occur; check the receiver before resending.", req.MessageID, req.Address, attempt.ErrorCode, attempt.Receipt.Status),
			}
			noticeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = notify(noticeCtx, notice)
			cancel()
			if err != nil && attempt.NoticeAttempts < claudeFallbackAttempts {
				return false, err
			}
		} else {
			err = fmt.Errorf("notice attempt interrupted")
		}
		if err != nil {
			err = fmt.Errorf("retiring Claude mail %s after %d failed notice attempts: %w", req.MessageID, attempt.NoticeAttempts, err)
		}
	}
	return false, errors.Join(err, renameClaudeMail(path, filepath.Join(dir, "offered", key)))
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
