package messaging

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func offerMailbox(dir string, accepts func(Request) bool, emit func([]Request) error) error {
	return offerMailboxWithAck(dir, "shuttle://host/claude/hook", accepts, emit, nil, "")
}

func offerMailboxValidated(dir string, accepts func(Request) bool, current func(context.Context, Request) (bool, error), emit func([]Request) error) error {
	return offerMailboxWithAck(dir, "shuttle://host/claude/hook", accepts, emit, current, "")
}

// writeFiberMailboxAttempt pins an entry to address, or unpins it, the way a
// build that predates the attempt record does: attempt_address alone.
func writeFiberMailboxAttempt(path string, entry mailboxEntry, address string) error {
	entry.AttemptAddress = address
	entry.Attempt = nil
	return writeMailboxEntry(path, entry)
}

// pinClaim claims entries for conversation and pins them there, the way a
// build before batch payloads claimed a direct delivery.
func pinClaim(paths []string, conversation string) error {
	if _, err := claimBatch(paths, conversation); err != nil {
		return err
	}
	for _, path := range paths {
		entry, err := readFiberMailboxEntry(path)
		if err != nil {
			return err
		}
		entry.AttemptAddress = conversation
		if err := writeMailboxEntry(path, entry); err != nil {
			return err
		}
	}
	return nil
}

// deliverPinned advances the fiber inbox's open batches for the worker at
// selected, as consume's first step does, after pinning r to selected the way
// a build before batch payloads claimed an entry when it is not pinned yet.
func deliverPinned(t *testing.T, env *sysenv.Env, selected string, r Request, send fiberContextSender) error {
	t.Helper()
	root := mailboxDir(env, "fiber", "fiber")
	path := filepath.Join(root, "pending", mailboxKey(r.MessageID)+".json")
	if e, err := readFiberMailboxEntry(path); err == nil && e.AttemptAddress == "" {
		if err := pinClaim([]string{path}, selected); err != nil {
			t.Fatal(err)
		}
	}
	return advanceBatches(t, env, selected, send)
}

// pinBatch claims the entries at paths as one open wake batch pinned to
// conversation, manifest first, as consume claims a batch, and returns it.
func pinBatch(t *testing.T, paths []string, conversation string) Attempt {
	t.Helper()
	root := filepath.Dir(filepath.Dir(paths[0]))
	items := make([]mailboxPendingItem, len(paths))
	wake := false
	for i, path := range paths {
		items[i] = mailboxPendingItem{path: path, entry: readEntry(t, path)}
		wake = wake || items[i].entry.Request.Wake
	}
	a := newConsumedAttempt(Worker{Address: conversation, Epoch: receiverEpoch(root, conversation)}, items, wake)
	if err := pinConsumedBatch(root, &a); err != nil {
		t.Fatal(err)
	}
	return a
}

// deliverBatch advances the fiber inbox's open batches for the worker at
// selected, as consume's first step does, after claiming r for selected in a
// batch of its own when no open batch holds it yet.
func deliverBatch(t *testing.T, env *sysenv.Env, selected string, r Request, send fiberContextSender) error {
	t.Helper()
	root := mailboxDir(env, "fiber", "fiber")
	path := filepath.Join(root, "pending", mailboxKey(r.MessageID)+".json")
	batches, err := readBatchManifests(root)
	if err != nil {
		t.Fatal(err)
	}
	held := false
	for _, b := range batches {
		held = held || slices.Contains(b.Members, r.MessageID)
	}
	if _, err := os.Stat(path); err == nil && !held {
		pinBatch(t, []string{path}, selected)
	}
	return advanceBatches(t, env, selected, send)
}

// advanceBatches advances every open batch for the worker at selected.
func advanceBatches(t *testing.T, env *sysenv.Env, selected string, send fiberContextSender) error {
	t.Helper()
	root := mailboxDir(env, "fiber", "fiber")
	_, batches, err := openBatches(env, root)
	if err != nil {
		t.Fatal(err)
	}
	w := Worker{Address: selected, Epoch: receiverEpoch(root, selected)}
	var errs []error
	for i := range batches {
		_, err := deliverConsumedBatch(context.Background(), env, root, "host", w, &batches[i], send)
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// expireAttempt ages an entry's open attempt, and its batch's manifest, past
// liveAttemptRetryAfter.
func expireAttempt(t *testing.T, path string) {
	t.Helper()
	entry := readEntry(t, path)
	entry.Attempt.OpenedAt = time.Now().Add(-liveAttemptRetryAfter).UnixNano()
	if err := writeMailboxEntry(path, entry); err != nil {
		t.Fatal(err)
	}
	if entry.Attempt.Payload == nil {
		return
	}
	root := filepath.Dir(filepath.Dir(path))
	if _, err := os.Stat(batchManifest(root, entry.Attempt)); err == nil {
		if err := pinConsumedBatch(root, entry.Attempt); err != nil {
			t.Fatal(err)
		}
	}
}

// readConsumedBatch reads the inbox's one open batch manifest.
func readConsumedBatch(root string) (Attempt, error) {
	batches, err := readBatchManifests(root)
	if err == nil && len(batches) != 1 {
		err = fmt.Errorf("%d open batches", len(batches))
	}
	if err != nil {
		return Attempt{}, err
	}
	return batches[0], nil
}

// answerThreadSignalsCurrent puts a shuttle on env's PATH that reports every
// thread signal current.
func answerThreadSignalsCurrent(t *testing.T, env *sysenv.Env) {
	t.Helper()
	scripts := t.TempDir()
	if err := os.WriteFile(filepath.Join(scripts, "shuttle"), []byte("#!/bin/sh\nprintf '{\"current\":true}\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", scripts+string(os.PathListSeparator)+env.Getenv("PATH"))
}
