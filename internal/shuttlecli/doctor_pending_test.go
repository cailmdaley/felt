package shuttlecli

import (
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestDoctorPrintsOverduePendingContext(t *testing.T) {
	t.Parallel()
	a := testApp(t)
	streams := sysenvtest.Capture(a.env)
	a.printPendingContextReceipt(DoctorReceipt{PendingContext: []messaging.PendingContext{{Mailbox: "/queue/fiber", MessageID: "thread-close", AgeSeconds: 660, AttemptAddress: "shuttle://host/claude/A", PossibleRepeat: true}}})
	out := streams.Stdout.String()
	for _, want := range []string{"thread-close", "pending for 11 minutes", "mailbox /queue/fiber", "pinned to shuttle://host/claude/A", "possible repeat"} {
		if !strings.Contains(out, want) {
			t.Fatalf("diagnostic missing %q: %s", want, out)
		}
	}
}
