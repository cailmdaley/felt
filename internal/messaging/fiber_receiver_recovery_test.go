package messaging

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadFiberReceiverPreservesDurableRecoveryIdentity(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if receiver, err := ReadFiberReceiver(env, "fiber"); err != nil || receiver != nil {
		t.Fatalf("absent: %+v %v", receiver, err)
	}
	for _, address := range []string{"shuttle://host/claude/B", "-"} {
		identity := "execution:B"
		if address == "-" {
			identity = "execution:-"
		}
		epoch := transition(t, env, identity, address)
		path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "destination.json")
		before, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		receiver, err := ReadFiberReceiver(env, "fiber")
		if err != nil || receiver == nil || receiver.Generation != epoch || receiver.Identity != identity {
			t.Fatalf("read: %+v %v", receiver, err)
		}
		after, err := os.ReadFile(path)
		if err != nil || string(after) != string(before) {
			t.Fatal("recovery read changed authority")
		}
		if address == "-" && receiver.ID != "" {
			t.Fatalf("unknown identity: %+v", receiver)
		}
	}
	path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "destination.json")
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFiberReceiver(env, "fiber"); err == nil {
		t.Fatal("corruption treated as missing identity")
	}
}
