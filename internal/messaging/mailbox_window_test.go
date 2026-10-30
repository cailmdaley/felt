package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMailboxValidationErrorsDoNotConsumeAcceptedWindow(t *testing.T) {
	for _, payload := range []int{1, 8192} {
		t.Run(fmt.Sprint(payload), func(t *testing.T) {
			dir := t.TempDir()
			if err := os.Mkdir(filepath.Join(dir, "pending"), 0700); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 40; i++ {
				request := Request{MessageID: fmt.Sprintf("%02d", i), Text: strings.Repeat("x", payload)}
				bytes, _ := json.Marshal(mailboxEntry{Request: request, QueuedAt: int64(i)})
				if err := mailboxWrite(filepath.Join(dir, "pending", mailboxKey(request.MessageID)+".json"), bytes, false); err != nil {
					t.Fatal(err)
				}
			}
			unavailable := errors.New("owner unreachable")
			var offered []Request
			err := offerMailboxValidated(dir, func(Request) bool { return true }, func(_ context.Context, r Request) (bool, error) {
				if r.MessageID < "16" {
					return false, unavailable
				}
				return true, nil
			}, func(batch []Request) error { offered = batch; return nil })
			if !errors.Is(err, unavailable) {
				t.Fatalf("validation error = %v", err)
			}
			want := 16
			if payload == 8192 {
				want = 8
			}
			if len(offered) != want {
				t.Fatalf("offered %d notices, want %d despite 16 earlier errors", len(offered), want)
			}
			if offered[0].MessageID != "16" {
				t.Fatalf("first accepted = %s", offered[0].MessageID)
			}
			pending, err := os.ReadDir(filepath.Join(dir, "pending"))
			if err != nil || len(pending) != 40-want {
				t.Fatalf("pending = %d, %v", len(pending), err)
			}
		})
	}
}
