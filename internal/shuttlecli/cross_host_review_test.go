package shuttlecli

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func subtreeView(t *testing.T, loom, prefix string) string {
	t.Helper()
	project := t.TempDir()
	if err := os.Symlink(filepath.Join(loom, ".felt", filepath.FromSlash(prefix)), filepath.Join(project, ".felt")); err != nil {
		t.Fatal(err)
	}
	return project
}

func TestCrossHostWritesRequireOwnerNamespaceContract(t *testing.T) {
	for _, operation := range []string{"create", "resume-project"} {
		t.Run(operation, func(t *testing.T) {
			env := remoteLifecycleEnv(t)
			env.Set("SHUTTLE_TEST_OWNER_CONTRACT", "")
			dir, st := newStore(t)
			seedShuttleRole(t, st, "hub", felt.StatusOpen, remoteShuttleBlock("/remote/project"), nil)
			posts := 0
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/version" {
					fmt.Fprint(w, `{"host":"worker","contract_level":30}`)
					return
				}
				if r.Method == "POST" {
					posts++
				}
				if r.URL.Path == "/api/v1/fiber/create" {
					fmt.Fprint(w, `{"id":"hub/measure","uid":"01ARZ3NDEKTSV4RRFFQ69G5FAX","host":"worker","status":"active","path":"/owner/measure.md"}`)
				} else {
					fmt.Fprint(w, `resumed`)
				}
			}))
			args := []string{"thread", "hub", "Measure"}
			if operation == "resume-project" {
				args = []string{"resume", "hub", "--project-dir", "/remote/project"}
			}
			_, _, err := executeIn(t, env, dir, args...)
			if err == nil || !strings.Contains(err.Error(), "deploy") || !strings.Contains(err.Error(), "worker") {
				t.Fatalf("old owner accepted: %v (posts=%d)", err, posts)
			}
			if posts != 0 {
				t.Fatalf("sent %d writes to incompatible owner", posts)
			}
		})
	}
}

func TestRemoteResumeLetsOwnerValidateItsDocument(t *testing.T) {
	for _, stale := range []string{"closed", "owner-only-agent"} {
		t.Run(stale, func(t *testing.T) {
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			status := felt.StatusOpen
			block := remoteShuttleBlock("/remote/project")
			if stale == "closed" {
				status = felt.StatusClosed
			} else {
				block["agent"] = "owner-only-agent"
			}
			seedShuttleRole(t, st, "task", status, block, nil)
			var bodies requestBodies
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/lifecycle" {
					bodies.record(t, r)
				}
				fmt.Fprint(w, `resumed`)
			}))
			if _, _, err := executeIn(t, env, dir, "resume", "task"); err != nil {
				t.Fatal(err)
			}
			if got := bodies.last(); got["action"] != "resume" {
				t.Fatalf("owner never received resume: %#v", got)
			}
		})
	}
}

func TestLocalOwnerViewLifecycleCarriesIntrinsicIdentity(t *testing.T) {
	for _, command := range [][]string{{"rest"}, {"close"}, {"reopen"}, {"accept"}, {"resume"}, {"dispatch"}, {"dispatch", "--release-launch-reservation"}} {
		verb := command[0]
		t.Run(strings.Join(command, " "), func(t *testing.T) {
			env := remoteLifecycleEnv(t)
			loom, st := newStore(t)
			status := felt.StatusActive
			if verb == "accept" || verb == "resume" {
				status = felt.StatusClosed
			}
			seedShuttleRole(t, st, "science/team/design/rex", status, map[string]any{"kind": "standing", "schedule": map[string]any{"expr": "0 0 * * *"}, "host": "hub", "project_dir": t.TempDir()}, nil)
			f, err := st.Read("science/team/design/rex")
			if err != nil {
				t.Fatal(err)
			}
			project := subtreeView(t, loom, "science/team")
			var bodies requestBodies
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/lifecycle" || r.URL.Path == "/api/v1/dispatch" {
					bodies.record(t, r)
				}
				fmt.Fprint(w, `ok`)
			}))
			args := append([]string{verb, "design/rex"}, command[1:]...)
			_, _, err = executeIn(t, env, project, args...)
			if err != nil {
				t.Fatal(err)
			}
			if len(command) > 1 && (bodies.last()["release_launch_reservation"] != true || bodies.last()["force"] != true) {
				t.Fatalf("lost reservation release fields: %#v", bodies.last())
			}
			key := "fiber"
			if verb == "dispatch" {
				key = "fiber_id"
			}
			if got := bodies.last()[key]; got != f.UID {
				t.Fatalf("%s sent %v, want UID %s", verb, got, f.UID)
			}
		})
	}
}
