package messaging

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// writeEntryReservation writes the reservation a contract-39 CLI made for a
// fresh launch: the same open launch attempt in every reserved entry.
func writeEntryReservation(t *testing.T, root string, w Worker, members []string, openedAt time.Time) {
	t.Helper()
	a := Attempt{BatchID: batchID(members), Conversation: w.Address, Epoch: w.Epoch, Members: members, OpenedAt: openedAt.UnixNano(), Launch: true}
	for _, id := range members {
		path := filepath.Join(root, "pending", mailboxKey(id)+".json")
		e := readEntry(t, path)
		e.Attempt = &a
		if err := writeMailboxEntry(path, e); err != nil {
			t.Fatal(err)
		}
	}
}

// A reservation a contract-39 CLI left in the entries still holds its lease
// after the CLI is upgraded: the first locked reader moves it to launch.json
// as it was, and settles nothing as a possible repeat.
func TestAnEntryReservationFromAnOlderCLIKeepsItsLease(t *testing.T) {
	env, w := consumeFixture(t)
	w.Idle, w.Costly = true, true
	putWish(t, env, "m", "ask", "fresh")
	root := mailboxDir(env, "fiber", "fiber")
	opened := time.Now().Add(-30 * time.Second)
	writeEntryReservation(t, root, w, []string{"m"}, opened)
	if result, err := consumeWith(context.Background(), env, "fiber", "host", w, neverSend(t)); err != nil || result.Action != "wait" {
		t.Fatalf("an upgraded CLI asked again within the old lease: %+v %v", result, err)
	}
	r, err := readLaunchReservation(root)
	want := launchReservation{Conversation: w.Address, Epoch: w.Epoch, Members: []string{"m"}, OpenedAt: opened.UnixNano()}
	if err != nil || r.Conversation != want.Conversation || r.Epoch != want.Epoch || !slices.Equal(r.Members, want.Members) || r.OpenedAt != want.OpenedAt {
		t.Fatalf("migrated reservation = %+v %v, want %+v", r, err, want)
	}
	if e := readEntry(t, filepath.Join(root, "pending", mailboxKey("m")+".json")); e.Attempt != nil || e.PossibleRepeat {
		t.Fatalf("the migrated entry = %+v", e)
	}
	lapseLease(t, env)
	if result, err := consumeWith(context.Background(), env, "fiber", "host", w, neverSend(t)); err != nil || result.Action != "fresh" {
		t.Fatalf("after the migrated lease: %+v %v", result, err)
	}
}

// The launched session's hook, reaching the inbox first, migrates the
// reservation too, and takes the idle entry it reserved, unmarked.
func TestTheLaunchedSessionsHookTakesAnOlderCLIsReservation(t *testing.T) {
	env, w := consumeFixture(t)
	putWish(t, env, "idle", "idle", "fresh")
	root := mailboxDir(env, "fiber", "fiber")
	writeEntryReservation(t, root, w, []string{"idle"}, time.Now().Add(-30*time.Second))
	if n, err := WakingCount(env, "fiber"); err != nil || n != 0 {
		t.Fatalf("waking count = %d %v within the older CLI's lease", n, err)
	}
	if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	transition(t, env, "B", "shuttle://host/claude/B")
	var got []Request
	if err := OfferMailbox(env, "claude", "B", "host", func(batch []Request) error {
		got = append(got, batch...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].MessageID != "idle" || got[0].Text != "text of idle" {
		t.Fatalf("the launched session took %+v", got)
	}
	if e := readEntry(t, filepath.Join(root, "offered", mailboxKey("idle")+".json")); e.PossibleRepeat {
		t.Fatalf("a launch reservation was settled as a possible repeat: %+v", e)
	}
}
