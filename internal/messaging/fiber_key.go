package messaging

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// FiberKeyPrefix begins the inbox key of a fiber with a uid. The key names
// the fiber's durable identity and no store, so a fiber's inbox stays where
// it is when its tree moves to another store.
const FiberKeyPrefix = "fiber:"

// FiberKey is the inbox key of the fiber with this uid.
func FiberKey(uid string) string { return FiberKeyPrefix + uid }

// RekeyFiberInboxes moves the inbox of every fiber in uids that is still
// keyed `<store>:<uid>`, for any store in stores, to its FiberKey, and points
// session links at the new key. It is idempotent: a fiber with no store-keyed
// inbox is left alone. When several store-keyed inboxes exist for one uid,
// the one whose receiver record was written last becomes the inbox (receiver,
// batches and all); the others contribute only the pending and offered
// entries the inbox does not already hold. It reports how many store-keyed
// inboxes it moved.
func RekeyFiberInboxes(env *sysenv.Env, stores, uids []string) (int, error) {
	moved := map[string]string{}
	var errs []error
	for _, uid := range uids {
		if uid == "" {
			continue
		}
		key := FiberKey(uid)
		var olds []string
		for _, store := range stores {
			old := store + ":" + uid
			if info, err := os.Stat(mailboxDir(env, "fiber", old)); err == nil && info.IsDir() {
				olds = append(olds, old)
			}
		}
		if len(olds) == 0 {
			continue
		}
		if err := rekeyFiberInbox(env, key, olds); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", uid, err))
			continue
		}
		for _, old := range olds {
			moved[old] = key
		}
	}
	if err := relinkFiberReceivers(env, moved); err != nil {
		errs = append(errs, err)
	}
	return len(moved), errors.Join(errs...)
}

// rekeyFiberInbox gathers olds into key's inbox, each under its own lock.
func rekeyFiberInbox(env *sysenv.Env, key string, olds []string) error {
	dst := mailboxDir(env, "fiber", key)
	// The newest receiver record names the inbox the fiber's current worker
	// was bound to; it becomes the destination when there is none yet.
	newest, newestAt := "", int64(-1)
	for _, old := range olds {
		info, err := os.Stat(filepath.Join(mailboxDir(env, "fiber", old), "destination.json"))
		at := int64(0)
		if err == nil {
			at = info.ModTime().UnixNano()
		}
		if at > newestAt {
			newest, newestAt = old, at
		}
	}
	if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
		if err := ensureDir(filepath.Dir(dst), 0700); err != nil {
			return err
		}
		if err := withMailboxLock(mailboxDir(env, "fiber", newest), func() error {
			return os.Rename(mailboxDir(env, "fiber", newest), dst)
		}); err != nil {
			return err
		}
	}
	for _, old := range olds {
		src := mailboxDir(env, "fiber", old)
		if _, err := os.Stat(src); errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err := withMailboxLock(dst, func() error {
			return withMailboxLock(src, func() error {
				for _, state := range []string{"pending", "offered"} {
					if err := mergeEntries(filepath.Join(src, state), filepath.Join(dst, state)); err != nil {
						return err
					}
				}
				return os.RemoveAll(src)
			})
		}); err != nil {
			return err
		}
	}
	return nil
}

// mergeEntries moves each entry file of src into dst unless dst holds one by
// that name: an entry's file is named by its message id.
func mergeEntries(src, dst string) error {
	files, err := os.ReadDir(src)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := ensureDir(dst, 0700); err != nil {
		return err
	}
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		to := filepath.Join(dst, f.Name())
		if _, err := os.Stat(to); err == nil {
			continue
		}
		if err := os.Rename(filepath.Join(src, f.Name()), to); err != nil {
			return err
		}
	}
	return nil
}

func withMailboxLock(dir string, fn func() error) error {
	lock, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return fn()
}

// relinkFiberReceivers rewrites every session's link to a moved inbox so it
// names the inbox's new key.
func relinkFiberReceivers(env *sysenv.Env, moved map[string]string) error {
	if len(moved) == 0 {
		return nil
	}
	links, err := filepath.Glob(filepath.Join(dataDir(env), "mailboxes", "*", "*", "fibers", "*.json"))
	if err != nil {
		return err
	}
	var errs []error
	for _, path := range links {
		bytes, err := readBounded(path, 16384)
		var link fiberMailboxLink
		if err != nil || json.Unmarshal(bytes, &link) != nil {
			continue
		}
		key, ok := moved[link.Fiber]
		if !ok {
			continue
		}
		link.Fiber = key
		out, err := json.Marshal(link)
		if err == nil {
			err = mailboxWrite(filepath.Join(filepath.Dir(path), mailboxKey(key)+".json"), out, false)
		}
		if err == nil {
			err = os.Remove(path)
		}
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
