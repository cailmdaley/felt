package shuttlecli

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestStandingCloseAcceptUnknownOwnerRefuses(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	ownHost(t, env, "hub")
	writeRemotesIn(t, env, `{"version":1,"defaults":{"discover":false},"remotes":[]}`)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusClosed, map[string]any{"kind": "standing", "host": "retired", "project_dir": dir, "schedule": map[string]any{"expr": "* * * * *", "tz": "UTC"}}, nil)
	if out, err := runIn(t, env, dir, "close", "f", "--tempered=true"); err == nil {
		t.Fatalf("standing acceptance must stay owner-routed: %s", out)
	}
	if mustRead(t, storage, "f").Status != felt.StatusClosed {
		t.Fatal("unknown owner was armed locally")
	}
}

func TestStandingCloseAcceptPublication(t *testing.T) {
	t.Parallel()
	env, sink, _ := sendFileTestEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "parent", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "test-host", "runtime": map[string]any{"session_uuid": "reviewer"}}, nil)
	seedShuttleRole(t, storage, "parent/thread", felt.StatusActive, map[string]any{"kind": "standing", "host": "test-host", "project_dir": dir, "schedule": map[string]any{"expr": "* * * * *", "tz": "UTC"}}, nil)
	if out, err := runIn(t, env, dir, "close", "parent/thread", "--tempered=true", "--quiet", "--actor", "reviewer", "--local"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	f := mustRead(t, storage, "parent/thread")
	rt := shuttleRuntimeMap(t, f)
	if rt["quiet_closed_at"] != rt["handed_off_at"] || rt["orchestrator_acted_at"] != rt["handed_off_at"] || rt["thread_exit_verb"] != "tempered" {
		t.Fatalf("publication flags lost: %#v", rt)
	}
	data, err := os.ReadFile(sink)
	if err != nil {
		t.Fatal(err)
	}
	var record boardRecord
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &record); err != nil {
		t.Fatal(err)
	}
	if record.Kind != "closed" || record.Verdict != "tempered" || record.Fiber != f.UID || record.By == nil || record.By.Session != "reviewer" {
		t.Fatalf("close record lost: %#v", record)
	}
}

func TestReopenOccurrenceConditionalWrite(t *testing.T) {
	t.Parallel()
	for _, state := range []string{"dirty", "older-handoff", "clean", "active", "paused", "accepted", "discarded", "stashed", "foreign", "unowned", "just-closed", "oneshot", "unarmable"} {
		t.Run(state, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			env.Set("SHUTTLE_HOST", "test-host")
			dir, storage := newStore(t)
			dispatched := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Second)
			runtime := map[string]any{"dispatched_at": dispatched.Format(time.RFC3339Nano), "session_uuid": "dead-session"}
			if state == "older-handoff" {
				runtime["handed_off_at"] = dispatched.Add(-time.Hour).Format(time.RFC3339Nano)
			}
			if state == "clean" {
				runtime["handed_off_at"] = dispatched.Add(time.Second).Format(time.RFC3339Nano)
			}
			block := map[string]any{"kind": "standing", "host": "test-host", "agent": "claude-sonnet", "project_dir": dir, "schedule": map[string]any{"expr": "* * * * *", "tz": "UTC"}, "runtime": runtime}
			switch state {
			case "foreign":
				block["host"] = "other-host"
			case "unowned":
				delete(block, "host")
			case "oneshot":
				block["kind"] = "oneshot"
			case "unarmable":
				delete(block, "project_dir")
			}
			status := felt.StatusClosed
			if state == "active" {
				status = felt.StatusActive
			}
			if state == "paused" {
				status = felt.StatusOpen
			}
			var verdict *bool
			if state == "accepted" || state == "discarded" {
				v := state == "accepted"
				verdict = &v
			}
			seedShuttleRole(t, storage, "f", status, block, verdict)
			f := mustRead(t, storage, "f")
			f.CreatedAt = dispatched.Add(-time.Hour)
			closed := dispatched.Add(time.Second)
			if state == "just-closed" {
				closed = time.Now().UTC()
			}
			f.ClosedAt = &closed
			if state == "stashed" {
				f.SetExtraField("horizon", "stashed")
			}
			if err := storage.Write(f); err != nil {
				t.Fatal(err)
			}
			out, err := runIn(t, env, dir, "reopen", "f", "--occurrence", "--local")
			if state == "unarmable" {
				if err == nil || !strings.Contains(err.Error(), "project_dir") {
					t.Fatalf("expected arming refusal, got %v %s", err, out)
				}
				if mustRead(t, storage, "f").Status != felt.StatusClosed {
					t.Fatal("refusal armed the document")
				}
				return
			}
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			got := mustRead(t, storage, "f")
			if state != "dirty" && state != "older-handoff" && state != "clean" {
				if !strings.Contains(out, "skipped occurrence") {
					t.Fatalf("must quietly skip: %s", out)
				}
				if got.Status != status || got.ClosedAt == nil || !got.ClosedAt.Equal(closed) {
					t.Fatalf("skip changed lifecycle: %#v", got)
				}
				return
			}
			if got.Status != felt.StatusActive || got.ClosedAt != nil {
				t.Fatalf("not armed: %#v", got)
			}
			rt := shuttleRuntimeMap(t, got)
			want := runtime["handed_off_at"]
			if state != "clean" {
				want = runtime["dispatched_at"]
			}
			if rt["handed_off_at"] != want || rt["dispatched_at"] != runtime["dispatched_at"] {
				t.Fatalf("service anchor moved or dirty markers remain: %#v", rt)
			}
			if readTempered(got) != nil {
				t.Fatal("verdict set on occurrence")
			}
		})
	}
}
