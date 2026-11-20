package messaging

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// A fiber with inboxes under two stores (the store its tree moved out of and
// the one it moved into) ends with one inbox under its uid key: the receiver
// written last, and the pending entries of both.
func TestRekeyMergesEveryStoreKeyedInbox(t *testing.T) {
	env := testEnv(t)
	oldKey, newKey := "/loom:UID", "/pando:UID"
	for key, id := range map[string]string{oldKey: "stranded", newKey: "current"} {
		if err := Enqueue(env, InboxEntry{Address: key, Request: Request{MessageID: id, Text: id}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := Enqueue(env, InboxEntry{Address: oldKey, Request: Request{MessageID: "current", Text: "current"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := TransitionFiberReceiver(env, oldKey, "host", "old-worker", "-"); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(mailboxDir(env, "fiber", oldKey), "destination.json"), past, past); err != nil {
		t.Fatal(err)
	}
	if _, err := TransitionFiberReceiver(env, newKey, "host", "new-worker", "-"); err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if _, err := RekeyFiberInboxes(env, []string{"/loom", "/pando", "/other"}, []string{"UID"}); err != nil {
			t.Fatal(err)
		}
	}

	entries, err := PendingEntries(env, FiberKey("UID"))
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, e := range entries {
		ids = append(ids, e.MessageID)
	}
	slices.Sort(ids)
	if !slices.Equal(ids, []string{"current", "stranded"}) {
		t.Fatalf("pending = %v", ids)
	}
	receiver, err := ReadFiberReceiver(env, FiberKey("UID"))
	if err != nil || receiver == nil || receiver.Identity != "new-worker" {
		t.Fatalf("receiver = %+v, %v", receiver, err)
	}
	for _, key := range []string{oldKey, newKey} {
		if _, err := os.Stat(mailboxDir(env, "fiber", key)); !os.IsNotExist(err) {
			t.Fatalf("%s still has an inbox: %v", key, err)
		}
	}
}

// An id one store-keyed inbox already offered (here, cancelled) stays offered
// when another still holds it pending: the merge never makes it due again.
func TestRekeyKeepsAnOfferedIDOffered(t *testing.T) {
	env := testEnv(t)
	for _, key := range []string{"/loom:UID", "/pando:UID"} {
		if err := Enqueue(env, InboxEntry{Address: key, Request: Request{MessageID: "x", Text: "x"}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := CancelPending(env, "/pando:UID", "x"); err != nil {
		t.Fatal(err)
	}
	if _, err := TransitionFiberReceiver(env, "/pando:UID", "host", "worker", "-"); err != nil {
		t.Fatal(err)
	}
	if _, err := RekeyFiberInboxes(env, []string{"/loom", "/pando"}, []string{"UID"}); err != nil {
		t.Fatal(err)
	}
	if entries, err := PendingEntries(env, FiberKey("UID")); err != nil || len(entries) != 0 {
		t.Fatalf("pending = %+v, %v", entries, err)
	}
}

// A store-keyed inbox written after the uid-keyed one (a rollback that ran
// the old daemon) brings its receiver and open batches along.
func TestRekeyIntoAnExistingInboxTakesANewerReceiverAndBatches(t *testing.T) {
	env := testEnv(t)
	if _, err := TransitionFiberReceiver(env, FiberKey("UID"), "host", "old-worker", "-"); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(mailboxDir(env, "fiber", FiberKey("UID")), "destination.json"), past, past); err != nil {
		t.Fatal(err)
	}
	if _, err := TransitionFiberReceiver(env, "/loom:UID", "host", "new-worker", "-"); err != nil {
		t.Fatal(err)
	}
	batches := filepath.Join(mailboxDir(env, "fiber", "/loom:UID"), "batches")
	if err := os.MkdirAll(batches, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(batches, "b1.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := RekeyFiberInboxes(env, []string{"/loom"}, []string{"UID"}); err != nil {
		t.Fatal(err)
	}
	receiver, err := ReadFiberReceiver(env, FiberKey("UID"))
	if err != nil || receiver == nil || receiver.Identity != "new-worker" {
		t.Fatalf("receiver = %+v, %v", receiver, err)
	}
	if _, err := os.Stat(filepath.Join(mailboxDir(env, "fiber", FiberKey("UID")), "batches", "b1.json")); err != nil {
		t.Fatal(err)
	}
}
