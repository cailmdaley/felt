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
	if err := messaging.DeliverFiberContext(context.Background(), env, "fiber", "host", address, generation); err != nil {
		t.Fatal(err)
	}
	for _, request := range []messaging.Request{{MessageID: "plain", Text: "plain peer message"}, {MessageID: "thread-notice", Text: "thread child closed: result"}} {
		if err := messaging.QueueFiberContext(env, "fiber", request); err != nil {
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
	if n, err := messaging.PendingFiberContext(env, "fiber"); err != nil || n != 1 {
		t.Fatalf("pending = %d, %v", n, err)
	}
}
