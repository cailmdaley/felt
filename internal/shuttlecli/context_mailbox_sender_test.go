package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestContextMailboxFromFlagNamesTheSender(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "host")
	env.Set("CODEX_THREAD_ID", "real-thread")
	cmd := NewRootCmd(env)
	cmd.SetArgs([]string{"context-mailbox", "put", "fiber", "message-1", "hello", "--from", "bob"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}

	var request messaging.Request
	data, err := shuttle.DataDir(env)
	if err != nil {
		t.Fatal(err)
	}
	err = filepath.WalkDir(data, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != ".json" {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var record struct {
			Request messaging.Request `json:"request"`
		}
		if json.Unmarshal(b, &record) == nil && record.Request.MessageID == "message-1" {
			request = record.Request
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.MessageID != "message-1" {
		t.Fatal("queued context message was not recorded")
	}
	if request.From != "bob" {
		t.Fatalf("sender = %q", request.From)
	}
}
