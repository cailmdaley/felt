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
