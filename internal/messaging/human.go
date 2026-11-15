package messaging

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// BeginHuman records typed input before the daemon submits it. Only the caller
// that created the entry may paste or launch. Unknown is the durable default:
// terminal input has no receipt with which to recover a lost answer.
func BeginHuman(env *sysenv.Env, address, id, text string) (bool, error) {
	created := false
	err := Enqueue(env, InboxEntry{Address: address, Request: Request{MessageID: id, Text: text, From: "human"}, Wishes: Wishes{Source: "human", Turn: "none"}, Created: &created})
	if err != nil {
		return false, err
	}
	if created {
		err = SettleHuman(env, address, id, "unknown")
	}
	return created, err
}

// SettleHuman records the typed transport's outcome. Repeating an id never
// submits it again, even when the process died before reporting its outcome.
func SettleHuman(env *sysenv.Env, address, id, outcome string) error {
	if outcome != "unknown" && outcome != "delivered" && outcome != "undeliverable" {
		return errCode("invalid_request", "invalid human outcome")
	}
	root, err := inboxRoot(env, address)
	if err != nil {
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
	path := filepath.Join(root, "pending", mailboxKey(id)+".json")
	e, err := readFiberMailboxEntry(path)
	if errors.Is(err, os.ErrNotExist) {
		path = filepath.Join(root, "offered", mailboxKey(id)+".json")
		e, err = readFiberMailboxEntry(path)
	}
	if err != nil {
		return err
	}
	if e.Wishes.Source != "human" {
		return errCode("invalid_request", "not a human entry")
	}
	e.Disposition = outcome
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if err := mailboxWrite(path, b, false); err != nil {
		return err
	}
	if filepath.Base(filepath.Dir(path)) == "pending" {
		return moveToOffered(root, path)
	}
	return nil
}
