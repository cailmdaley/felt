package shuttlecli

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestRemoteResolverRequiresUniqueVerifiedOwner(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, host, origin string
		duplicate          bool
		want               string
	}{
		{name: "local owner", host: "hub", origin: "hub", want: "no verified remote owner"},
		{name: "hostless", origin: "worker", want: "no verified remote owner"},
		{name: "different owner", host: "elsewhere", origin: "worker", want: "no verified remote owner"},
		{name: "ambiguous", host: "worker", origin: "worker", duplicate: true, want: "ambiguous across owners"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, _ := newStore(t)
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fiber := map[string]any{"id": "01JARZ3NDEKTSV4RRFFQ69G5FA", "uid": "01JARZ3NDEKTSV4RRFFQ69G5FA", "slug": "remote/task", "name": "Task", "shuttle": map[string]any{"host": tc.host, "kind": "oneshot", "project_dir": "/remote/project"}}
				switch r.URL.Path {
				case "/api/v1/fibers/composite":
					rows := []map[string]any{{"path": "remote/task/task.md", "origin": tc.origin, "fiber": fiber}}
					if tc.duplicate {
						rows = append(rows, map[string]any{"path": "other/task/task.md", "origin": "other", "fiber": fiber})
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"fibers": rows})
				case "/api/v1/fibers/remote/task":
					_ = json.NewEncoder(w).Encode(map[string]any{"fibers": []map[string]any{{"fiber": fiber}}})
				default:
					t.Errorf("unexpected request %s", r.URL.String())
					http.NotFound(w, r)
				}
			}))
			a := newApp(env)
			a.dir = dir
			_, _, _, err := a.shuttleResolveFiberRef("remote/task", true)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %s", err, tc.want)
			}
		})
	}
}

func TestRemoteResolverPreservesOwnerReadFailure(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, _ := newStore(t)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/fibers/composite" {
			_, _ = w.Write([]byte(`{"fibers":[{"path":"remote/task/task.md","origin":"worker","fiber":{"id":"01JARZ3NDEKTSV4RRFFQ69G5FA","slug":"remote/task"}}]}`))
			return
		}
		http.Error(w, "owner unavailable", http.StatusBadGateway)
	}))
	a := newApp(env)
	a.dir = dir
	_, _, _, err := a.shuttleResolveFiberRef("remote/task", true)
	if err == nil || !strings.Contains(err.Error(), "owner unavailable") {
		t.Fatalf("lost owner failure: %v", err)
	}
}

func TestRemoteResolverDoesNotOverrideLocalAmbiguity(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	for _, id := range []string{"one/task", "two/task"} {
		f, err := felt.New(id, id)
		if err != nil {
			t.Fatal(err)
		}
		if err := st.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("local ambiguity reached daemon: %s", r.URL.String())
		http.NotFound(w, r)
	}))
	a := newApp(env)
	a.dir = dir
	_, _, _, err := a.shuttleResolveFiberRef("task", true)
	if err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("error = %v", err)
	}
}
