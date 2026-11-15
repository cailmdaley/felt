package messaging

import (
	"os"
	"strings"
	"testing"
)

func TestReview3HookRecoveryMarksRepeatWithinLimit(t *testing.T) {
	env := testEnv(t)
	if err := RegisterMailbox(env, "claude", "A", "host", t.TempDir(), os.Getpid(), true); err != nil {
		t.Fatal(err)
	}
	a := Address{Host: "host", Harness: "claude", ID: "A"}
	for _, id := range []string{"one", "two"} {
		if _, err := queueMailbox(env, a, Request{Address: "shuttle://host/claude/A", MessageID: id, Text: strings.Repeat("x", 3785)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := OfferMailbox(env, "claude", "A", "host", func([]Request) error { return errCode("test_death", "hook died after output") }); err == nil {
		t.Fatal("missing injected failure")
	}
	var got []Request
	if err := OfferMailbox(env, "claude", "A", "host", func(batch []Request) error { got = batch; return nil }); err != nil {
		t.Fatal(err)
	}
	// Both originals fit together; their warnings push the second past the limit.
	if len(got) != 1 || !strings.HasPrefix(got[0].Text, "Possible repeat:") || len(Labeled(got[0])) > claudeHookBatchBytes {
		t.Fatalf("hook emission count=%d, repeat=%v", len(got), strings.HasPrefix(got[0].Text, "Possible repeat:"))
	}
	if n, _ := pendingCount(env, "shuttle://host/claude/A"); n != 1 {
		t.Fatalf("pending=%d", n)
	}
}

func TestHookRepeatWarningNamesAnyEarlierDelivery(t *testing.T) {
	got := hookEmission(mailboxEntry{Request: Request{Text: "result"}, PossibleRepeat: true}).Text
	if got != "Possible repeat: an earlier delivery of this message had an unknown outcome.\n\nresult" {
		t.Fatalf("hook warning = %q", got)
	}
}
