package messaging

import "testing"

func TestHumanInputDedupAndSettlement(t *testing.T) {
	env := testEnv(t)
	for i := 0; i < 3; i++ {
		created, err := BeginHuman(env, "fiber", "human-1", "hello\n[Image: /tmp/test.png]")
		if err != nil || created != (i == 0) {
			t.Fatalf("created=%v err=%v", created, err)
		}
	}
	root := mailboxDir(env, "fiber", "fiber")
	before, err := readFiberMailboxEntry(root + "/offered/" + mailboxKey("human-1") + ".json")
	if err != nil || before.Disposition != "unknown" {
		t.Fatalf("interrupted submission: %+v %v", before, err)
	}
	if err := SettleHuman(env, "fiber", "human-1", "delivered"); err != nil {
		t.Fatal(err)
	}
	entries, err := PendingEntries(env, "fiber")
	if err != nil || len(entries) != 0 {
		t.Fatalf("%+v %v", entries, err)
	}
	e, err := readFiberMailboxEntry(root + "/offered/" + mailboxKey("human-1") + ".json")
	if err != nil || e.Wishes.Source != "human" || e.Disposition != "delivered" {
		t.Fatalf("%+v %v", e, err)
	}
}
