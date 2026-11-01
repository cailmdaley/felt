package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestStatusOwnerDispatchHold(t *testing.T) {
	for _, tc := range []struct{ name, snapshot, want string }{
		{"held", `{"stale":false,"snapshot":{"pending_launch":[{"fiber_id":"task","reason":"boot quarantine — awaiting release","parked_at":1793574180000}]}}`, "Held on worker: boot quarantine"},
		{"eligible", `{"stale":false,"snapshot":{"pending_launch":[]}}`, "eligible for dispatch"},
		{"unreachable", `{"stale":true,"snapshot":{"pending_launch":[]}}`, "dispatch hold unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "task", felt.StatusActive, remoteShuttleBlock("/remote"), nil)
			f := mustRead(t, st, "task")
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/state/composite":
					fmt.Fprintf(w, `{"remotes":{"worker":%s}}`, tc.snapshot)
				case "/api/v1/fibers/composite":
					fmt.Fprintf(w, `{"origins":{"worker":{"stale":false}},"fibers":[{"origin":"worker","fiber":{"id":%q,"uid":%q,"slug":"task","status":"active","shuttle":{"kind":"oneshot","host":"worker","project_dir":"/remote"}}}]}`, f.UID, f.UID)
				default:
					http.Error(w, "unreachable", 502)
				}
			}))
			out, _, err := executeIn(t, env, dir, "status", "task", "--json")
			if err != nil {
				t.Fatal(err)
			}
			var result struct {
				Dispatch string `json:"dispatch"`
			}
			if err := json.Unmarshal([]byte(out), &result); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(result.Dispatch, tc.want) {
				t.Fatalf("dispatch = %q", result.Dispatch)
			}
			if tc.name == "held" && (!strings.Contains(result.Dispatch, "2026-") || !strings.Contains(result.Dispatch, "shuttle daemon release") || !strings.Contains(result.Dispatch, "shuttle dispatch task")) {
				t.Fatal(result.Dispatch)
			}
		})
	}
}

func TestThreadsShowsOwnerHold(t *testing.T) {
	env := remoteLifecycleEnv(t)
	dir, _ := newStore(t)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/threads/hub":
			fmt.Fprint(w, `{"fiber_id":"hub","threads":[{"id":"hub/task","uid":"01JARZ3NDEKTSV4RRFFQ69G5FA","host":"worker","state":"Armed","threads":[]}]}`)
		case "/api/v1/state/composite":
			fmt.Fprint(w, `{"remotes":{"worker":{"stale":false,"snapshot":{"pending_launch":[{"uid":"01JARZ3NDEKTSV4RRFFQ69G5FA","reason":"boot quarantine — awaiting release","parked_at":1793574180000}]}}}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	out, _, err := executeIn(t, env, dir, "threads", "hub")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Held · worker: boot quarantine") || !strings.Contains(out, "since 2026-") {
		t.Fatal(out)
	}
}
