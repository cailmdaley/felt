package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestStatusUsesOwnerStateAndLabelsUnavailableLocalCopy(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		code  int
		want  string
		stale bool
	}{
		{name: "closed", code: 200, want: "closed"},
		{name: "unavailable", code: 502, want: "active", stale: true},
		{name: "authoritative missing", code: 404},
		{name: "malformed owner", code: 200, want: "malformed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "source", felt.StatusActive, remoteShuttleBlock("/remote/project"), nil)
			local := mustRead(t, st, "source")
			owner := map[string]any{"id": local.UID, "uid": local.UID, "slug": "source", "name": "Source", "status": "closed", "shuttle": map[string]any{"kind": "oneshot", "host": "worker", "project_dir": "/remote/project"}}
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/fibers/composite" {
					_ = json.NewEncoder(w).Encode(map[string]any{"origins": map[string]any{"worker": map[string]any{"stale": false}}, "fibers": []any{map[string]any{"origin": "worker", "fiber": owner}}})
					return
				}
				if r.URL.Query().Get("origin") != "worker" {
					t.Errorf("read not owner routed: %s", r.URL.String())
				}
				if tc.code != 200 {
					http.Error(w, "owner response", tc.code)
					return
				}
				if tc.want == "malformed" {
					_, _ = w.Write([]byte(`{"fibers":[{"fiber":{"name":"wrong"}}]}`))
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"fibers": []any{map[string]any{"fiber": owner}}})
			}))
			stdout, _, err := executeIn(t, env, dir, "status", "source", "--json")
			if tc.code == 404 || tc.want == "malformed" {
				if err == nil {
					t.Fatalf("owner failure silently fell back: %s", stdout)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal([]byte(stdout), &got); err != nil {
				t.Fatal(err)
			}
			if got["status"] != tc.want || got["stale"] != tc.stale {
				t.Fatalf("status result = %#v", got)
			}
			if tc.stale && got["source"] != "local_fallback" {
				t.Fatalf("unlabelled local state: %#v", got)
			}
		})
	}
}

func TestStatusAllIncludesOwnerOnlyClosedAndRestedInventory(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, _ := newStore(t)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/state/composite":
			_, _ = w.Write([]byte(`{"local":{"host":"hub","eligible":[],"standing_roles":[]},"remotes":{"worker":{"snapshot":{"host":"worker","eligible":[],"standing_roles":[]},"stale":false}}}`))
		case "/api/v1/fibers/composite":
			_, _ = w.Write([]byte(`{"host":"hub","origins":{"worker":{"stale":false}},"fibers":[{"origin":"worker","fiber":{"id":"01JARZ3NDEKTSV4RRFFQ69G5FA","uid":"01JARZ3NDEKTSV4RRFFQ69G5FA","slug":"owner/closed","name":"Closed","status":"closed","shuttle":{"kind":"oneshot","host":"worker"}}},{"origin":"worker","fiber":{"id":"01JARZ3NDEKTSV4RRFFQ69G5FB","uid":"01JARZ3NDEKTSV4RRFFQ69G5FB","slug":"owner/rested","name":"Rested","status":"open","horizon":"stashed","shuttle":{"kind":"oneshot","host":"worker"}}}]}`))
		default:
			t.Errorf("unexpected request %s", r.URL.String())
			http.NotFound(w, r)
		}
	}))
	stdout, _, err := executeIn(t, env, dir, "status", "--all", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []FiberStatus
	if err := json.Unmarshal([]byte(stdout), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].State != "closed" || rows[1].State != "resting" {
		t.Fatalf("owner inventory omitted or misclassified: %s", stdout)
	}
}

func TestThreadStaleLabelPreservesEveryState(t *testing.T) {
	for _, state := range []string{"Archived", "Resting", "Working", "To review", "Armed", "Draft"} {
		row := threadRow{State: state, Stale: true, HostUnreachable: true}
		if got := row.stateLabel(); !strings.HasPrefix(got, state+" · local copy;") {
			t.Errorf("state %s label = %s", state, got)
		}
	}
}

func TestStatusTableFetchesOwnerInventoryOnce(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "one", felt.StatusActive, remoteShuttleBlock("/remote/project"), nil)
	seedShuttleRole(t, st, "two", felt.StatusActive, remoteShuttleBlock("/remote/project"), nil)
	one := mustRead(t, st, "one")
	two := mustRead(t, st, "two")
	var requests atomic.Int32
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/fibers/composite" {
			t.Errorf("table made per-document request: %s", r.URL.String())
			http.NotFound(w, r)
			return
		}
		requests.Add(1)
		fibers := []any{}
		for _, f := range []*felt.Felt{one, two} {
			fibers = append(fibers, map[string]any{"origin": "worker", "fiber": map[string]any{"id": f.UID, "uid": f.UID, "slug": f.ID, "status": "closed", "shuttle": map[string]any{"kind": "oneshot", "host": "worker"}}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"origins": map[string]any{"worker": map[string]any{"stale": false}}, "fibers": fibers})
	}))
	stdout, _, err := executeIn(t, env, dir, "status", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []FiberStatus
	if err := json.Unmarshal([]byte(stdout), &rows); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 || len(rows) != 2 || rows[0].State != "closed" || rows[1].State != "closed" {
		t.Fatalf("requests %d; rows %s", requests.Load(), stdout)
	}
}

func TestStatusTableDoesNotTreatUnknownOrColdOwnerAsEmpty(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, origins string
		fallback      bool
	}{
		{name: "unknown origin", origins: `{}`, fallback: true},
		{name: "cold cache", origins: `{"worker":{"stale":false,"cache":{"state":"cold"}}}`, fallback: true},
		{name: "fresh owner absent", origins: `{"worker":{"stale":false,"cache":{"state":"fresh"}}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "source", felt.StatusActive, remoteShuttleBlock("/remote/project"), nil)
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/fibers/composite" {
					_, _ = fmt.Fprintf(w, `{"origins":%s,"fibers":[]}`, tc.origins)
					return
				}
				if !tc.fallback {
					t.Errorf("fresh authoritative absence caused owner/local retry: %s", r.URL.String())
				}
				http.Error(w, "unavailable", http.StatusBadGateway)
			}))
			stdout, _, err := executeIn(t, env, dir, "status", "--json")
			if err != nil {
				t.Fatal(err)
			}
			var rows []FiberStatus
			if err := json.Unmarshal([]byte(stdout), &rows); err != nil {
				t.Fatal(err)
			}
			if tc.fallback {
				if len(rows) != 1 || !rows[0].Stale || rows[0].Source != "local_fallback" {
					t.Fatalf("unmarked/lost local fallback: %s", stdout)
				}
			} else if len(rows) != 0 {
				t.Fatalf("fresh absence resurrected mirror: %s", stdout)
			}
		})
	}
}

func TestThreadIncompleteOwnerCacheReportsUnknown(t *testing.T) {
	for _, cache := range []string{"cold", "partial"} {
		node := ThreadNode{ID: "task", State: "Unknown", Stale: true, OwnerCacheState: cache}
		rows, _ := threadRows([]ThreadNode{node}, true)
		if len(rows) != 1 || rows[0].HostUnreachable || rows[0].OwnerCacheState != cache || rows[0].stateLabel() != "Unknown · owner cache "+cache {
			t.Fatalf("incomplete owner cache mislabeled: %#v", rows)
		}
	}
	row := threadRow{State: "Unknown", Stale: true}
	if got := row.stateLabel(); strings.Contains(got, "unreachable") || strings.Contains(got, "local copy") {
		t.Fatalf("staleness invented an outage: %s", got)
	}
}
