package messaging

import (
	"context"
	"encoding/json"
	"github.com/cailmdaley/felt/internal/sysenv"
	"os"
	"testing"
	"time"
)

func TestConsumeExplicitFreshReservedOnce(t *testing.T) {
	for _, dormant := range []bool{false, true} {
		env, w := consumeFixture(t)
		if dormant {
			w = Worker{Address: "-"}
		}
		entry := InboxEntry{Address: "fiber", Request: Request{MessageID: "fresh", Text: "new session"}, Wishes: Wishes{Turn: "force", Session: "fresh"}}
		sends := 0
		send := func(context.Context, *sysenv.Env, string, Request, string) (Receipt, error) {
			sends++
			return Receipt{Status: StatusAccepted}, nil
		}
		for i := 0; i < 3; i++ {
			if err := Enqueue(env, entry); err != nil {
				t.Fatal(err)
			}
			got, err := consumeWith(context.Background(), env, "fiber", "host", w, send)
			want := "wait"
			if i == 0 {
				want = "fresh"
				if dormant {
					want = "launch"
				}
			}
			if err != nil || got.Action != want {
				t.Fatalf("dormant=%v retry=%d got=%+v err=%v", dormant, i, got, err)
			}
			if i == 0 && got.Session != "fresh" {
				t.Fatalf("session: %+v", got)
			}
		}
		if sends != 0 {
			t.Fatal("fresh text sent to old conversation")
		}
		if err := RegisterMailbox(env, "claude", "B", "host", t.TempDir(), os.Getpid(), true); err != nil {
			t.Fatal(err)
		}
		w = Worker{Address: "shuttle://host/claude/B", Epoch: transition(t, env, "B", "shuttle://host/claude/B")}
		root := mailboxDir(env, "fiber", "fiber")
		reservation, err := readLaunchReservation(root)
		if err != nil {
			t.Fatal(err)
		}
		reservation.OpenedAt = time.Now().Add(-3 * time.Minute).UnixNano()
		b, _ := json.Marshal(reservation)
		if err := mailboxWrite(launchReservationPath(root), b, false); err != nil {
			t.Fatal(err)
		}
		got, err := consumeWith(context.Background(), env, "fiber", "host", w, send)
		if err != nil || got.Action != "wake" || sends != 1 {
			t.Fatalf("replacement must take text, not be cut again: %+v %v sends=%d", got, err, sends)
		}
	}
}
