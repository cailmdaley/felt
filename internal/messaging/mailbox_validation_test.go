package messaging

import (
	"context"
	"testing"
	"time"
)

func TestMailboxValidationDoesNotSerializeUnavailableOwners(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	done := make(chan error, 1)
	candidates := []mailboxPendingItem{{entry: mailboxEntry{Request: Request{MessageID: "one"}}}, {entry: mailboxEntry{Request: Request{MessageID: "two"}}}}
	go func() {
		_, err := validateMailboxItems(t.TempDir(), candidates, func(context.Context, Request) (bool, error) { started <- struct{}{}; <-release; return true, nil })
		done <- err
	}()
	for range 2 {
		select {
		case <-started:
		case <-time.After(time.Second):
			close(release)
			<-done
			t.Fatal("an unavailable source blocked another source's validation")
		}
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
