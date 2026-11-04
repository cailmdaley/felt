package shuttlecli

import (
	"fmt"
	"github.com/cailmdaley/felt/internal/felt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestThreadStorageMatchesParentNamespace(t *testing.T) {
	for _, topology := range []string{"remote-parent", "project-canonical"} {
		t.Run(topology, func(t *testing.T) {
			env := remoteLifecycleEnv(t)
			loom, st := newStore(t)
			seedPlainFiber(t, st, "science/team/anchor", "")
			sender, parent, destination := loom, "ai-futures/lightcone/hub", ""
			if topology == "remote-parent" {
				sender = subtreeView(t, loom, "science/team")
				parent = "science/team/hub"
				destination = filepath.Join(loom, ".felt", "science/team/hub/measure/measure.md")
			} else {
				project, ps := newStore(t)
				seedShuttleRole(t, ps, "hub", felt.StatusActive, map[string]any{"kind": "oneshot", "host": "hub", "project_dir": project}, nil)
				if err := os.MkdirAll(filepath.Join(loom, ".felt", "ai-futures"), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(project, ".felt"), filepath.Join(loom, ".felt", "ai-futures", "lightcone")); err != nil {
					t.Fatal(err)
				}
				destination = filepath.Join(project, ".felt", "hub/measure/measure.md")
			}
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/api/v1/fibers/composite":
					fmt.Fprint(w, `{"fibers":[{"origin":"worker","fiber":{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAX","uid":"01ARZ3NDEKTSV4RRFFQ69G5FAX","slug":"science/team/hub","shuttle":{"kind":"oneshot","host":"worker"}}}]}`)
				case strings.HasPrefix(r.URL.Path, "/api/v1/fibers/"):
					fmt.Fprint(w, `{"fibers":[{"fiber":{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAX","uid":"01ARZ3NDEKTSV4RRFFQ69G5FAX","slug":"science/team/hub","name":"Hub","status":"active","shuttle":{"kind":"oneshot","host":"worker","project_dir":"/remote/project"}}}]}`)
				default:
					fmt.Fprint(w, `{}`)
				}
			}))
			if _, _, err := executeIn(t, env, sender, "thread", parent, "Measure", "--disabled"); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(destination); err != nil {
				t.Fatalf("child absent from parent namespace: %s: %v", destination, err)
			}
		})
	}
}
