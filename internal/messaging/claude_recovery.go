package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

const claudeHookOfferWindow = 3 * time.Second
const claudeFallbackKeyPrefix = "claude-fallback\x00"

// RecoverClaudeMail gives unoffered automatic Claude mail a native wake path.
// Queue time and exclusive transport ownership live on disk, not in a timer or
// a turn-state guess. The daemon runs this at boot and every second afterwards.
func RecoverClaudeMail(ctx context.Context, env *sysenv.Env, host string, now time.Time) error {
	root := filepath.Join(dataDir(env), "mailboxes", "claude")
	sessions, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var failures []error
	slots := make(chan struct{}, 8)
	report := func(err error) {
		if err != nil {
			mu.Lock()
			failures = append(failures, err)
			mu.Unlock()
		}
	}
	for _, session := range sessions {
		if !session.IsDir() {
			continue
		}
		dir := filepath.Join(root, session.Name())
		for _, state := range []string{"pending", "fallback"} {
			files, err := os.ReadDir(filepath.Join(dir, state))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				report(err)
				continue
			}
			for _, file := range files {
				if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
					continue
				}
				path := filepath.Join(dir, state, file.Name())
				entry, err := readFiberMailboxEntry(path)
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				if err != nil {
					report(err)
					continue
				}
				req := entry.Request
				address, err := ParseAddress(req.Address)
				if err != nil || address.Harness != "claude" || address.Host != host || !req.ContextIfBusy || now.Sub(time.Unix(0, entry.QueuedAt)) < claudeHookOfferWindow {
					continue
				}
				select {
				case slots <- struct{}{}:
				case <-ctx.Done():
					wg.Wait()
					return ctx.Err()
				}
				wg.Add(1)
				go func(dir, key string, req Request) {
					defer wg.Done()
					defer func() { <-slots }()
					report(recoverClaudeMessage(ctx, env, dir, key, req))
				}(dir, file.Name(), req)
			}
		}
	}
	wg.Wait()
	return errors.Join(failures...)
}

func recoverClaudeMessage(ctx context.Context, env *sysenv.Env, dir, key string, req Request) error {
	claimed, err := claimClaudeFallback(dir, key)
	if err != nil || !claimed {
		return err
	}
	// Overlapping recovery passes skip an in-flight native observation instead
	// of queueing behind it. New messages still start their fallback on time.
	file, err := os.Open(filepath.Join(dir, "fallback", key))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil
		}
		return err
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	address, err := ParseAddress(req.Address)
	if err != nil {
		return err
	}
	req.Wake, req.ContextIfBusy = true, false
	receipt, sendErr := (dedupOptions{keyPrefix: claudeFallbackKeyPrefix}).run(ctx, env, req, func(ctx context.Context) dedupSendResult {
		receipt, err, metadata := sendClaudeNativeWithMetadata(ctx, env, address, req)
		return dedupSendResult{Receipt: receipt, Err: err, Metadata: metadata}
	})
	// Preflight failures prove that nothing was sent. Leave the durable claim
	// for the next recovery pass; hooks must not take it back in the meantime.
	if ErrorCode(sendErr) == "preflight_failed" {
		return fmt.Errorf("Claude mail %s: %w", req.MessageID, sendErr)
	}
	if receipt.MessageID == "" {
		return sendErr
	}
	path := dedupRecordPath(env, claudeFallbackKeyPrefix+req.MessageID)
	stored, err := readDedupRecord(path)
	if err != nil {
		return err
	}
	if stored.State != "complete" {
		// An abandoned native reservation is ambiguous, never permission to
		// resend. Persist that terminal uncertainty before retiring the queue.
		if stored.State != "reserved" || processAlive(stored.OwnerPID, stored.OwnerStart) {
			return sendErr
		}
		stored = record{Hash: stored.Hash, State: "complete", Receipt: receipt, ErrorCode: ErrorCode(sendErr)}
		if sendErr != nil {
			stored.ErrorMessage = sendErr.Error()
		}
		b, err := json.Marshal(stored)
		if err != nil {
			return err
		}
		if err := mailboxWrite(path, b, false); err != nil {
			return err
		}
	}
	if err := ensureDir(filepath.Join(dir, "offered"), 0700); err != nil {
		return err
	}
	if err := os.Rename(filepath.Join(dir, "fallback", key), filepath.Join(dir, "offered", key)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := syncDir(filepath.Join(dir, "offered")); err != nil {
		return err
	}
	if err := syncDir(filepath.Join(dir, "fallback")); err != nil {
		return err
	}
	return sendErr
}

// The hook's own output lock makes choosing the hook or native transport
// exclusive. Never hold this lock while calling Claude: its native turn may
// itself run a hook. A persisted claim also fences hooks after a crash.
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
	pending := filepath.Join(dir, "pending", key)
	entry, err := readFiberMailboxEntry(pending)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	entry.NativeFallback = true
	b, err := json.Marshal(entry)
	if err != nil {
		return false, err
	}
	if err := mailboxWrite(pending, b, false); err != nil {
		return false, err
	}
	if err := ensureDir(filepath.Dir(fallback), 0700); err != nil {
		return false, err
	}
	if err := os.Rename(pending, fallback); err != nil {
		return false, err
	}
	if err := syncDir(filepath.Dir(fallback)); err != nil {
		return false, err
	}
	if err := syncDir(filepath.Dir(pending)); err != nil {
		return false, err
	}
	return true, nil
}

func refreshClaudeHookReceipt(ctx context.Context, env *sysenv.Env, req Request, old record) record {
	address, err := ParseAddress(req.Address)
	if err != nil {
		return old
	}
	dir := mailboxDir(env, "claude", address.ID)
	entry, err := readFiberMailboxEntry(filepath.Join(dir, "offered", mailboxKey(req.MessageID)+".json"))
	if err == nil && !entry.NativeFallback {
		old.Receipt.Status = StatusContextAdded
		old.Receipt.Detail = "the main-thread hook wrote this message as context; no claim of a model reply"
		return old
	}
	path := dedupRecordPath(env, claudeFallbackKeyPrefix+req.MessageID)
	fallback, err := readDedupRecord(path)
	nativeReq := req
	nativeReq.Wake, nativeReq.ContextIfBusy = true, false
	if err == nil {
		if fallback.State == "complete" {
			// The outer dedup record has already checked the original request.
			// The fallback hashes the rendered delivery (attachments included
			// in Text), so its hash is intentionally different from that input.
			fallback = refreshCompletedReceipt(ctx, env, nativeReq, path, fallback.Hash, fallback)
			old.Receipt.Status, old.Receipt.Transport, old.Receipt.Detail = fallback.Receipt.Status, fallback.Receipt.Transport, fallback.Receipt.Detail
			old.ErrorCode, old.ErrorMessage = fallback.ErrorCode, fallback.ErrorMessage
			return old
		}
		if fallback.State == "reserved" && !processAlive(fallback.OwnerPID, fallback.OwnerStart) {
			receipt, failure := stoppedAttempt(req)
			old.Receipt.Status, old.Receipt.Transport, old.Receipt.Detail = receipt.Status, receipt.Transport, receipt.Detail
			old.ErrorCode, old.ErrorMessage = ErrorCode(failure), failure.Error()
			return old
		}
	}
	if mailboxReceiverEnded(env, "claude", address.ID, address.Host) {
		old.Receipt.Status = StatusUnknown
		old.Receipt.Detail = "receiver exited before the queued message was offered"
		old.ErrorCode, old.ErrorMessage = "receiver_exited", old.Receipt.Detail
	}
	return old
}
