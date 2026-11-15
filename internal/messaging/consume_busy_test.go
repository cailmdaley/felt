package messaging

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestConsumeBusyHarnessFollowup(t *testing.T) {
	for _, harness := range []string{"claude", "codex", "pi"} {
		for _, turn := range []string{"ask", "idle", "force"} {
			t.Run(harness+"/"+turn, func(t *testing.T) {
				env := testEnv(t)
				if err := RegisterMailbox(env, harness, "A", "host", t.TempDir(), os.Getpid(), true); err != nil {
					t.Fatal(err)
				}
				address := "shuttle://host/" + harness + "/A"
				w := Worker{Address: address, Epoch: transition(t, env, "A", address), Busy: true}
				putWish(t, env, "m", turn, "hold")
				calls := 0
				send := func(_ context.Context, _ *sysenv.Env, _ string, _ Request, _ string) (Receipt, error) {
					calls++
					return Receipt{Status: StatusAccepted}, nil
				}
				got, err := consumeWith(context.Background(), env, "fiber", "host", w, send)
				want := "wake"
				if turn == "idle" || (harness == "claude" && turn == "ask") {
					want = "wait"
				}
				if err != nil || got.Action != want {
					t.Fatalf("%+v %v want %s", got, err, want)
				}
				if harness == "claude" && turn == "ask" {
					path := filepath.Join(mailboxDir(env, "fiber", "fiber"), "pending", mailboxKey("m")+".json")
					e, err := readFiberMailboxEntry(path)
					if err != nil {
						t.Fatal(err)
					}
					e.QueuedAt = time.Now().Add(-31 * time.Second).UnixNano()
					b, _ := json.Marshal(e)
					if err := mailboxWrite(path, b, false); err != nil {
						t.Fatal(err)
					}
					got, err = consumeWith(context.Background(), env, "fiber", "host", w, send)
					if err != nil || got.Action != "wake" || calls != 1 {
						t.Fatalf("fallback: %+v %v calls=%d", got, err, calls)
					}
				}
			})
		}
	}
}
