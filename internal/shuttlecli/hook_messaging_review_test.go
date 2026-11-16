package shuttlecli

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
)

func TestHookOutputSurvivesSiblingValidationFailure(t *testing.T) {
	t.Parallel()
	env := messageHookEnv(t, "host")
	env.Set("PATH", t.TempDir())
	env.Set("SHUTTLE_BOARD", "off")
	const address = "shuttle://host/pi/s"
	if err := messaging.RegisterMailbox(env, "pi", "s", "host", "/work", os.Getppid(), true); err != nil {
		t.Fatal(err)
	}
	generation, err := messaging.TransitionFiberReceiver(env, "fiber", "host", "execution", address)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := messaging.Consume(context.Background(), env, "fiber", "host", messaging.Worker{Address: address, Epoch: generation}); err != nil {
		t.Fatal(err)
	}
	for _, request := range []messaging.Request{{MessageID: "plain", Text: "plain peer message"}, {MessageID: "thread-notice", Text: "thread child closed: result"}} {
		if err := messaging.Enqueue(env, messaging.InboxEntry{Address: "fiber", Request: request}); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	err = newApp(env).runEventAndMessageHook(strings.NewReader(fmt.Sprintf(`{"hook_event_name":"UserPromptSubmit","harness":"pi","session_id":"s","native_pid":%d}`, os.Getppid())), &out)
	if !strings.Contains(out.String(), "plain peer message") {
		t.Fatalf("output = %q", out.String())
	}
	if err != nil {
		t.Fatalf("successful hook output returned error: %v", err)
	}
	if entries, err := messaging.PendingEntries(env, "fiber"); err != nil || len(entries) != 1 {
		t.Fatalf("pending = %v, %v", entries, err)
	}
}
