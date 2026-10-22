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

// Revoking a fiber that never had a mailbox creates nothing; one that has a
// mailbox loses its receiver at a higher epoch.
func TestRevokeExistingFiberReceiverCreatesNoState(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	if revoked, err := RevokeExistingFiberReceiver(env, "absent", "host"); err != nil || revoked {
		t.Fatalf("absent: %v %v", revoked, err)
	}
	if _, err := os.Stat(mailboxDir(env, "fiber", "absent")); !os.IsNotExist(err) {
		t.Fatalf("revocation created a mailbox for a fiber without one: %v", err)
	}
	epoch := transition(t, env, "execution:B", "shuttle://host/claude/B")
	if revoked, err := RevokeExistingFiberReceiver(env, "fiber", "host"); err != nil || !revoked {
		t.Fatalf("existing: %v %v", revoked, err)
	}
	receiver, err := ReadFiberReceiver(env, "fiber")
	if err != nil || receiver == nil || receiver.Identity != "" || receiver.ID != "" || receiver.Generation != epoch+1 {
		t.Fatalf("revoked: %+v %v", receiver, err)
	}
	if _, err := RevokeExistingFiberReceiver(env, "fiber", "host"); err != nil {
		t.Fatal(err)
	}
	if again, _ := ReadFiberReceiver(env, "fiber"); again.Generation != receiver.Generation {
		t.Fatalf("repeated revocation rotated the epoch: %+v", again)
	}
}
