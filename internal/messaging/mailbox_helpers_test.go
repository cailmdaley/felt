package messaging

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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

// pinBatch claims the entries at paths as one open wake batch pinned to
// conversation, as consume's claim records it before its send, and returns
// it. Its send has no recorded outcome yet, so it reads as unknown.
func pinBatch(t *testing.T, paths []string, conversation string) Attempt {
	t.Helper()
	root := filepath.Dir(filepath.Dir(paths[0]))
	a := newBatch(t, paths, conversation)
	if err := writeBatch(root, &a); err != nil {
		t.Fatal(err)
	}
	return a
}

func newBatch(t *testing.T, paths []string, conversation string) Attempt {
	t.Helper()
	root := filepath.Dir(filepath.Dir(paths[0]))
	items := make([]mailboxPendingItem, len(paths))
	wake := false
	for i, path := range paths {
		items[i] = mailboxPendingItem{path: path, entry: readEntry(t, path)}
		wake = wake || items[i].entry.Request.Wake
	}
	return newConsumedAttempt(Worker{Address: conversation, Epoch: receiverEpoch(root, conversation)}, items, wake)
}

// deliverBatch claims r for selected in a batch of its own and sends it, as
// consume claims a batch, when no open batch holds it yet; otherwise it
// advances the fiber inbox's open batches for the worker at selected, as
// consume's first step does.
func deliverBatch(t *testing.T, env *sysenv.Env, selected string, r Request, send fiberContextSender) error {
	t.Helper()
	root := mailboxDir(env, "fiber", "fiber")
	path := filepath.Join(root, "pending", mailboxKey(r.MessageID)+".json")
	if _, err := os.Stat(path); err == nil && batchOf(t, root, r.MessageID) == nil {
		a := newBatch(t, []string{path}, selected)
		_, err := sendBatch(context.Background(), env, root, "host", &a, send)
		return err
	}
	return advanceBatches(t, env, selected, send)
}

// advanceBatches advances every open batch for the worker at selected.
func advanceBatches(t *testing.T, env *sysenv.Env, selected string, send fiberContextSender) error {
	t.Helper()
	root := mailboxDir(env, "fiber", "fiber")
	_, batches, err := openBatches(root)
	if err != nil {
		t.Fatal(err)
	}
	w := Worker{Address: selected, Epoch: receiverEpoch(root, selected)}
	var errs []error
	for i := range batches {
		_, err := advanceBatch(context.Background(), env, root, "host", w, &batches[i], send)
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// batchOf reads the open batch that holds the entry id, or nil.
func batchOf(t *testing.T, root, id string) *Attempt {
	t.Helper()
	pinned, err := pinnedBy(root)
	if err != nil {
		t.Fatal(err)
	}
	return pinned[id]
}

// expireAttempt ages the open batch holding the entry at path past
// liveAttemptRetryAfter.
func expireAttempt(t *testing.T, path string) {
	t.Helper()
	root := filepath.Dir(filepath.Dir(path))
	a := batchOf(t, root, readEntry(t, path).Request.MessageID)
	if a == nil {
		return
	}
	a.OpenedAt = time.Now().Add(-liveAttemptRetryAfter).UnixNano()
	if err := writeBatch(root, a); err != nil {
		t.Fatal(err)
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
