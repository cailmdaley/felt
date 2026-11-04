package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestRemoteResumeRetainsDraftUntilOwnerConfirmsArmedWrite(t *testing.T) {
	t.Parallel()
	for _, reply := range []string{
		`{"id":%q,"uid":%q,"path":%q}`,
		`{"id":%q,"uid":%q,"path":%q,"host":"worker","status":"open"}`,
		`{"id":%q,"uid":%q,"path":%q,"host":"another-host","status":"active"}`,
	} {
		t.Run(reply, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			seedShuttleRole(t, st, "draft", felt.StatusOpen, remoteShuttleBlock("/remote/project"), nil)
			draft := mustRead(t, st, "draft")
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/lifecycle" {
					http.Error(w, "not found", http.StatusNotFound)
					return
				}
				fmt.Fprintf(w, reply, draft.ID, draft.UID, "/remote/loom/.felt/draft/draft.md")
			}))
			if out, _, err := executeIn(t, env, dir, "resume", "draft"); err == nil {
				t.Fatalf("unconfirmed create reported success: %s", out)
			}
			if got := mustRead(t, st, "draft"); got.Status != felt.StatusOpen || got.UID != draft.UID {
				t.Fatalf("unconfirmed transfer changed source: %#v", got)
			}
		})
	}
}

func TestRemoteResumeTransfersSubtreeDraftAtNamespacePath(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	loom, st := newStore(t)
	seedPlainFiber(t, st, "commons", "")
	seedShuttleRole(t, st, "science/team/draft", felt.StatusOpen, remoteShuttleBlock(""), nil)
	draft := mustRead(t, st, "science/team/draft")
	project := t.TempDir()
	if err := os.Symlink(filepath.Join(loom, ".felt", "science", "team"), filepath.Join(project, ".felt")); err != nil {
		t.Fatal(err)
	}
	var lifecycle, creates requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/lifecycle":
			lifecycle.record(t, r)
			http.Error(w, "not found", http.StatusNotFound)
		case "/api/v1/fiber/create":
			creates.record(t, r)
			payload := creates.last()
			fmt.Fprintf(w, `{"id":%q,"uid":%q,"path":"/remote/loom/.felt/science/team/draft/draft.md","host":"worker","status":"active"}`, payload["id"], payload["uid"])
		case "/api/v1/state/composite":
			fmt.Fprint(w, `{"remotes":{}}`)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	}))
	out, _, err := executeIn(t, env, project, "resume", "draft", "--project-dir", "/remote/project")
	if err != nil {
		t.Fatal(err)
	}
	if got := lifecycle.last(); got["fiber"] != draft.UID || got["project_dir"] != "/remote/project" {
		t.Fatalf("resume must carry identity and project directory atomically: %#v", got)
	}
	got := creates.last()
	fm := got["frontmatter"].(map[string]any)
	if got["id"] != "science/team/draft" || got["uid"] != draft.UID || fm["status"] != "active" {
		t.Fatalf("transfer lost namespace identity: %#v", got)
	}
	if !strings.Contains(out, "created science/team/draft on worker") {
		t.Fatalf("receipt = %q", out)
	}
	if _, err := os.Stat(draft.Path); !os.IsNotExist(err) {
		t.Fatalf("confirmed draft still exists: %v", err)
	}
}

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
				case "/api/v1/state/composite":
					fmt.Fprint(w, `{"remotes":{"worker":{"snapshot":{"boot_quarantine":true}}}}`)
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
					fmt.Fprintf(w, `{"id":%q,"uid":%q,"path":%q,"host":"worker","status":"active"}`, payload["id"], payload["uid"], ownerPath)
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
