package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestThreadInboxVerbsCaptureForwardSettleAndContract40Enqueue(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_HOST", "sender")
	run := func(stdin string, args ...string) string {
		t.Helper()
		var out bytes.Buffer
		env.Stdout, env.Stdin = &out, strings.NewReader(stdin)
		if code := Run(env, args); code != 0 {
			t.Fatalf("%v: exit %d (%s)", args, code, out.String())
		}
		return strings.TrimSpace(out.String())
	}
	if out := run("", "inbox", "thread-state"); !strings.Contains(out, "baseline") {
		t.Fatal(out)
	}
	record := map[string]any{"owner": "sender", "store": "/sender", "parent_uid": "anchor", "parent_host": "owner", "parent_unresolved": true, "text": "thread hub/child unblocked: result", "retained_at": time.Now().UTC().Format(time.RFC3339Nano)}
	batch, _ := json.Marshal([]map[string]any{{"id": "thread-1", "record": record}})
	for i, want := range []string{`{"created":["thread-1"]}`, `{"created":[]}`} {
		if out := run(string(batch), "inbox", "thread-put"); out != want {
			t.Fatalf("capture %d: %s", i, out)
		}
	}
	if out := run("", "inbox", "routes"); !strings.Contains(out, `"id":"thread-1"`) {
		t.Fatal(out)
	}
	resolved, _ := json.Marshal(map[string]any{"parent_uid": "parent", "parent_host": "owner", "store": "/owner"})
	for i := 0; i < 2; i++ {
		out := run("", "inbox", "route", "thread-1", "--current", "true", "--owner", "owner", "--key", "/owner:parent", "--record", string(resolved))
		var decision map[string]any
		if err := json.Unmarshal([]byte(out), &decision); err != nil || decision["action"] != "forward" {
			t.Fatalf("forward: %s %v", out, err)
		}
	}
	run("", "inbox", "settle", "thread-1", "forwarded")
	if out := run("", "inbox", "routes"); out != "[]" {
		t.Fatal(out)
	}
	// A contract-40 owner's /deliver shells this verb for the forward. Losing
	// its first confirmation repeats the same enqueue, a no-op there.
	env.Set("SHUTTLE_DATA_DIR", filepath.Join(t.TempDir(), "owner-data"))
	for i := 0; i < 2; i++ {
		run("", "context-mailbox", "put", "/owner:parent", "thread-1", record["text"].(string), "--derived", "--retained-at", record["retained_at"].(string))
	}
	if out := run("", "inbox", "pending", "/owner:parent"); out != `{"/owner:parent":1}` {
		t.Fatal(out)
	}
}

func TestThreadStateExitsThreeOnACorruptOutbox(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	data := filepath.Join(t.TempDir(), "data")
	env.Set("SHUTTLE_DATA_DIR", data)
	if err := os.MkdirAll(data, 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(data, "thread-outbox.json"), []byte("not json"), 0600)
	var out bytes.Buffer
	env.Stdout, env.Stderr = &out, &out
	if code := Run(env, []string{"inbox", "thread-state"}); code != exitCorrupt {
		t.Fatalf("exit %d: %s", code, out.String())
	}
}

func TestThreadPutReportsCreatedIdsWhenALaterPublicationFails(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", filepath.Join(t.TempDir(), "data"))
	var out bytes.Buffer
	env.Stdout, env.Stderr = &out, &bytes.Buffer{}
	if code := Run(env, []string{"inbox", "thread-state"}); code != 0 {
		t.Fatal(code)
	}
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	good := map[string]any{"owner": "h", "store": "/s", "parent_uid": "p", "text": "thread a unblocked: b closed", "retained_at": stamp}
	bad := map[string]any{"owner": "h", "store": "/s", "parent_uid": "p", "text": "thread a closed: x", "retained_at": stamp, "signal": map[string]any{"uid": "a"}}
	batch, _ := json.Marshal([]map[string]any{{"id": "thread-good", "record": good}, {"id": "thread-bad", "record": bad}})
	out.Reset()
	env.Stdin = strings.NewReader(string(batch))
	if code := Run(env, []string{"inbox", "thread-put"}); code == 0 {
		t.Fatal("an invalid publication was accepted")
	}
	if got := strings.TrimSpace(out.String()); got != `{"created":["thread-good"]}` {
		t.Fatal(got)
	}
}
