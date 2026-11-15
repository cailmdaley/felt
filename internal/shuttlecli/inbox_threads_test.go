package shuttlecli

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestThreadInboxVerbsForwardLostConfirmationAndContract40Enqueue(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "sender")
	run := func(args ...string) string {
		t.Helper()
		var out bytes.Buffer
		env.Stdout = &out
		cmd := NewRootCmd(env)
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatalf("%v: %v (%s)", args, err, out.String())
		}
		return out.String()
	}
	if out := run("inbox", "thread-state"); !strings.Contains(out, "baseline") {
		t.Fatal(out)
	}
	record := map[string]any{"owner": "sender", "store": "/sender", "parent_uid": "parent", "parent_host": "owner", "parent_unresolved": true, "text": "thread hub/child unblocked: result", "retained_at": time.Now().UTC().Format(time.RFC3339Nano)}
	b, _ := json.Marshal(record)
	for i, want := range []string{"true", "false"} {
		if out := run("inbox", "thread-put", "thread-1", string(b)); strings.TrimSpace(out) != `{"created":`+want+`}` {
			t.Fatalf("capture %d: %s", i, out)
		}
	}
	if out := run("inbox", "routes", "sender"); !strings.Contains(out, `"address":"/sender:parent"`) {
		t.Fatal(out)
	}
	args := []string{"inbox", "consume", "/sender:parent", "-", "0", "--route", "thread-1", "--route-current", "true", "--route-owner", "owner", "--route-record", string(b), "--route-key", "/owner:parent"}
	var decision map[string]any
	for i := 0; i < 2; i++ {
		out := run(args...)
		if err := json.Unmarshal([]byte(out), &decision); err != nil || decision["action"] != "forward" {
			t.Fatalf("forward: %s %v", out, err)
		}
	}
	// The contract-40 /deliver implementation shells this same verb and flags.
	// Losing its first confirmation must not duplicate or change the publication.
	ownerData := filepath.Join(t.TempDir(), "owner-data")
	env.Set("SHUTTLE_DATA_DIR", ownerData)
	for i := 0; i < 2; i++ {
		run("context-mailbox", "put", "/owner:parent", "thread-1", record["text"].(string), "--derived", "--retained-at", record["retained_at"].(string))
	}
	if out := run("inbox", "pending", "/owner:parent"); strings.TrimSpace(out) != `{"/owner:parent":1}` {
		t.Fatal(out)
	}
}
