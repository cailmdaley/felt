package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestRemoteResumeMovesDraft(t *testing.T) {
	for _, tc := range []struct {
		name         string
		shared, fail bool
	}{
		{name: "separate"}, {name: "shared symlink", shared: true}, {name: "create fails", fail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "draft", felt.StatusOpen, remoteShuttleBlock(t.TempDir()), nil)
			local := st.Path("draft")
			ownerPath := filepath.Join(t.TempDir(), "owner.md")
			if tc.shared {
				ownerPath = filepath.Join(t.TempDir(), "alias.md")
				if err := os.Symlink(local, ownerPath); err != nil {
					t.Fatal(err)
				}
			}
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/lifecycle":
					http.Error(w, "not found", http.StatusNotFound)
				case "/api/v1/fiber/create":
					if tc.fail {
						http.Error(w, "failed", http.StatusBadRequest)
						return
					}
					var payload map[string]any
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Error(err)
						return
					}
					if tc.shared {
						if err := os.WriteFile(ownerPath, []byte("owner armed copy"), 0600); err != nil {
							t.Error(err)
							return
						}
					}
					fmt.Fprintf(w, `{"id":%q,"uid":%q,"path":%q}`, payload["id"], payload["uid"], ownerPath)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
				}
			}))
			_, _, err := executeIn(t, env, dir, "resume", "draft")
			if (err != nil) != tc.fail {
				t.Fatalf("resume: %v", err)
			}
			data, err := os.ReadFile(local)
			if tc.shared && (err != nil || string(data) != "owner armed copy") {
				t.Fatalf("shared owner file lost: %q, %v", data, err)
			}
			if tc.fail && err != nil {
				t.Fatalf("draft lost after failure: %v", err)
			}
			if !tc.shared && !tc.fail && !os.IsNotExist(err) {
				t.Fatalf("draft still exists: %q %v", data, err)
			}
		})
	}
}
