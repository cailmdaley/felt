package messaging

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// AppWorkers owns writes. Native messaging reads only backend_host and
// backend_endpoint from its private record; these cases match the daemon's
// read-only owner projection, including records that require explicit repair.
func TestCodexOwnerProjectionParity(t *testing.T) {
	t.Parallel()
	bytes, err := os.ReadFile(filepath.Join("..", "..", "daemon", "test", "fixtures", "app_worker_owners.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Host, Socket, Expected string
		Record                       json.RawMessage
	}
	if err := json.Unmarshal(bytes, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			env := testEnv(t)
			env.Set("SHUTTLE_CODEX_SOCKET", tc.Socket)
			dir := filepath.Join(dataDir(env), "app-workers")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "thread-1.json"), tc.Record, 0600); err != nil {
				t.Fatal(err)
			}
			err := checkCodexOwnerEndpoint(env, tc.Host, "thread-1")
			got := "ok"
			if err != nil {
				got = ErrorCode(err)
			}
			if got != tc.Expected {
				t.Fatalf("owner projection %s, want %s: %v", got, tc.Expected, err)
			}
		})
	}
}

func TestCodexWrongOwnerNeverConnectsOrQueues(t *testing.T) {
	t.Parallel()
	for _, reason := range []string{"endpoint", "host", "unrecorded", "malformed"} {
		for _, wake := range []bool{false, true} {
			t.Run(reason+map[bool]string{false: "/context", true: "/wake"}[wake], func(t *testing.T) {
				env := testEnv(t)
				f := &fakeCodex{t: t, state: "idle"}
				socket := startFakeCodex(t, f)
				env.Set("SHUTTLE_CODEX_SOCKET", socket)
				record := map[string]any{"session_uuid": "thread-1", "thread_id": "thread-1", "active": true, "backend_host": "owner", "backend_endpoint": socket}
				switch reason {
				case "endpoint":
					record["backend_endpoint"] = "/another-owner.sock"
				case "host":
					record["backend_host"] = "other-host"
				case "unrecorded":
					delete(record, "backend_endpoint")
				}
				bytes, _ := json.Marshal(record)
				if reason == "malformed" {
					bytes = []byte("not json")
				}
				dir := filepath.Join(dataDir(env), "app-workers")
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "thread-1.json"), bytes, 0600); err != nil {
					t.Fatal(err)
				}
				receipt, err := (codexAdapter{}).send(context.Background(), env, Address{Host: "owner", Harness: "codex", ID: "thread-1"}, Request{Address: "shuttle://owner/codex/thread-1", MessageID: "wrong-owner", Text: "do not deliver", Wake: wake})
				if err == nil || receipt.Status != StatusRejected || ErrorCode(err) != "preflight_failed" {
					t.Fatalf("receipt %+v error %v", receipt, err)
				}
				if f.methodCount("initialize") != 0 || f.methodCount("thread/read") != 0 {
					t.Fatal("contacted a different conversation owner")
				}
				after, err := os.ReadFile(filepath.Join(dir, "thread-1.json"))
				if err != nil || string(after) != string(bytes) {
					t.Fatalf("ownership record changed: %q %v", after, err)
				}
			})
		}
	}
}
