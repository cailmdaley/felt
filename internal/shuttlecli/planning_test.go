package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

func TestPlanningStateTable(t *testing.T) {
	data, err := os.ReadFile("../../daemon/test/fixtures/planning/states.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name      string
		Fiber     map[string]any
		Quiescent bool
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			f, _ := felt.New("task", "Task")
			f.Status, _ = tc.Fiber["status"].(string)
			if block, ok := tc.Fiber["shuttle"]; ok {
				if err := f.SetExtraField("shuttle", block); err != nil {
					t.Fatal(err)
				}
			}
			if got := planningFiber(f); got != tc.Quiescent {
				t.Fatalf("quiescent=%v want %v", got, tc.Quiescent)
			}
		})
	}
}

func TestPlanningRealYAMLStamps(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, quote := range []string{"", `"`} {
		for _, finish := range []string{"2026-11-04T11:00:00Z", "2026-11-04T10:00:00Z", "broken"} {
			t.Run(quote+finish, func(t *testing.T) {
				dir, st := newStore(t)
				path := filepath.Join(dir, ".felt/task/task.md")
				os.MkdirAll(filepath.Dir(path), 0700)
				text := fmt.Sprintf("---\nname: Task\nstatus: closed\nshuttle:\n  host: worker\n  runtime:\n    dispatched_at: %s2026-11-04T10:00:00Z%s\n    handed_off_at: %s%s%s\n---\n", quote, quote, quote, finish, quote)
				if err := os.WriteFile(path, []byte(text), 0600); err != nil {
					t.Fatal(err)
				}
				f, err := st.Read("task")
				if err != nil {
					t.Fatal(err)
				}
				if planningFiber(f) != (finish == "2026-11-04T11:00:00Z") {
					t.Fatalf("wrong evidence from actual YAML: %s", text)
				}
				home := t.TempDir()
				remotes := filepath.Join(home, "remotes.json")
				os.WriteFile(remotes, []byte(`{"version":1,"defaults":{"discover":false},"remotes":[{"name":"worker","port":4001}]}`), 0600)
				out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), "rest", "task")
				if (err == nil) != (finish == "2026-11-04T11:00:00Z") {
					t.Fatalf("real YAML CLI: %v %s", err, out)
				}
			})
		}
	}
}

var planningVerbs = [][]string{
	{"pause"}, {"rest"}, {"close"}, {"close", "--tempered=false"}, {"close", "--tempered=true"},
	{"reopen", "--as-draft"}, {"set-agent", "claude-sonnet"}, {"set-model", "claude-sonnet"},
	{"set-outcome", "--outcome", "Planned"}, {"reshape", "oneshot"},
	{"role", "editor", "--new", "Editor"}, {"seat"},
}

// An override runs the same public probes against a saved, real pre-fix binary.
func planningProbeBinary(t *testing.T) string {
	t.Helper()
	if path := os.Getenv("SHUTTLE_PLANNING_PROBE_BINARY"); path != "" {
		return path
	}
	path := filepath.Join(t.TempDir(), "shuttle")
	cmd := exec.Command("go", "build", "-p", "2", "-o", path, "../../cmd/shuttle")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	return path
}

func planningProbeEnv(home, daemon, remotes string) []string {
	return []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "GOMAXPROCS=4", "SHUTTLE_HOST=hub", "SHUTTLE_DAEMON_URL=" + daemon, "SHUTTLE_REMOTES_FILE=" + remotes}
}

func runPlanningProbe(binary, dir string, env []string, args ...string) (string, error) {
	cmd := exec.Command(binary, append([]string{"-C", dir}, args...)...)
	cmd.Env = env
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestPlanningRealBinaryOwnerFirstAndNilStorage(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, location := range []struct {
		local bool
		host  string
	}{{true, "worker"}, {false, "worker"}, {false, "hub"}} {
		local, host := location.local, location.host
		for _, available := range []bool{true, false} {
			for _, verb := range planningVerbs {
				t.Run(fmt.Sprintf("owner=%s/local=%t/reachable=%t/%s", host, local, available, strings.Join(verb, "/")), func(t *testing.T) {
					dir, st := newStore(t)
					home := t.TempDir()
					f, _ := felt.New("task", "Task")
					f.Status = felt.StatusOpen
					f.SetExtraField("shuttle", map[string]any{"kind": "oneshot", "host": host, "agent": "claude-opus", "role": "editor"})
					var before []byte
					if local {
						if err := st.Write(f); err != nil {
							t.Fatal(err)
						}
						before, _ = os.ReadFile(st.Path("task"))
					}
					var posts atomic.Int32
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						switch r.URL.Path {
						case "/api/v1/lifecycle":
							posts.Add(1)
							if !available {
								w.WriteHeader(502)
								fmt.Fprint(w, `{"reason":"owner_unreachable_before_send","error":"no action request was sent; nothing was applied"}`)
								return
							}
							fmt.Fprint(w, "owner applied\n")
						case "/api/v1/fibers/composite":
							fmt.Fprintf(w, `{"fibers":[{"origin":%q,"path":"task","fiber":{"id":%q,"uid":%q,"slug":"task"}}]}`, host, f.UID, f.UID)
						case "/api/v1/fibers/task":
							fmt.Fprintf(w, `{"fibers":[{"fiber":{"id":%q,"uid":%q,"slug":"task","name":"Task","status":"open","shuttle":{"kind":"oneshot","host":%q,"role":"editor","agent":"claude-opus"}}}]}`, f.UID, f.UID, host)
						case "/api/v1/document-changed":
							fmt.Fprint(w, `{}`)
						default:
							t.Errorf("unexpected %s %s", r.Method, r.URL)
							http.NotFound(w, r)
						}
					}))
					defer server.Close()
					remotes := filepath.Join(home, "remotes.json")
					os.WriteFile(remotes, []byte(`{"version":1,"defaults":{"discover":false},"remotes":[{"name":"worker","port":4001}]}`), 0600)
					args := append([]string{verb[0], "task"}, verb[1:]...)
					out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, server.URL, remotes), args...)
					if !local && host == "hub" {
						if posts.Load() != 0 || err == nil || !strings.Contains(out, "no verified remote owner") || strings.Contains(out, "panic:") {
							t.Fatalf("unverified local-origin data must refuse before routing or writing: posts=%d err=%v %s", posts.Load(), err, out)
						}
						return
					}
					if posts.Load() != 1 {
						t.Fatalf("want exactly one owner POST, got %d; err=%v out=%s", posts.Load(), err, out)
					}
					if available || local {
						if err != nil {
							t.Fatalf("%v: %s", err, out)
						}
					} else if err == nil || strings.Contains(out, "panic:") {
						t.Fatalf("storage-less failure must route/refuse, never write or panic: %v %s", err, out)
					}
					if local {
						got, _ := st.Read("task")
						after, _ := os.ReadFile(st.Path("task"))
						if available && string(before) != string(after) {
							t.Fatal("reachable-owner request mutated its local mirror")
						}
						if !available {
							if got.UpdatedAt == nil || (f.UpdatedAt != nil && !got.UpdatedAt.After(*f.UpdatedAt)) || !strings.Contains(out, "Git") || !strings.Contains(out, "no execution request was sent") {
								t.Fatalf("mirror did not touch/explain: %s", out)
							}
							runtime := felt.MappingValueNode(got.ExtraFields[shuttle.FacetKey], shuttle.RuntimeKey)
							for _, key := range []string{"session_uuid", "tmux_session", "dispatched_at", "handed_off_at"} {
								if node := felt.MappingValueNode(runtime, key); node != nil {
									t.Fatalf("planning invented execution evidence %s=%s", key, node.Value)
								}
							}
						}
					}
				})
			}
		}
	}
}

func TestPlanningRealBinaryRemovedHostUnconcluded(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, host := range []string{"removed", ""} {
		for _, status := range []string{felt.StatusOpen, felt.StatusClosed, felt.StatusActive} {
			for _, verb := range [][]string{{"rest"}, {"close"}, {"close", "--tempered=false"}} {
				t.Run(fmt.Sprintf("owner=%q/%s/%s", host, status, strings.Join(verb, "/")), func(t *testing.T) {
					dir, st := newStore(t)
					home := t.TempDir()
					seedFiber(t, st, "task", "", status, map[string]any{"kind": "oneshot", "host": host, "runtime": map[string]any{"dispatched_at": "2026-11-04T10:00:00Z", "session_uuid": "unconcluded"}}, nil)
					remotes := filepath.Join(home, "remotes.json")
					os.WriteFile(remotes, []byte(`{"version":1,"defaults":{"discover":false},"remotes":[]}`), 0600)
					args := append([]string{verb[0], "task"}, verb[1:]...)
					out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), args...)
					if err != nil {
						t.Fatalf("%v %s", err, out)
					}
					if !strings.Contains(out, "Git") {
						t.Fatal(out)
					}
					got, _ := st.Read("task")
					runtime := felt.MappingValueNode(got.ExtraFields[shuttle.FacetKey], shuttle.RuntimeKey)
					for key, want := range map[string]string{"dispatched_at": "2026-11-04T10:00:00Z", "session_uuid": "unconcluded"} {
						if node := felt.MappingValueNode(runtime, key); node == nil || node.Value != want {
							t.Fatalf("retirement replaced %s execution evidence", key)
						}
					}
					if node := felt.MappingValueNode(runtime, "handed_off_at"); node != nil {
						t.Fatalf("retirement invented an owner handoff: %s", node.Value)
					}
				})
			}
		}
	}
}

func TestPlanningUnownedExecutionEvidenceRequiresRetirement(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, verb := range planningVerbs {
		if verb[0] == "rest" || verb[0] == "close" {
			continue
		}
		t.Run(strings.Join(verb, "/"), func(t *testing.T) {
			dir, st := newStore(t)
			home := t.TempDir()
			seedFiber(t, st, "task", "", felt.StatusOpen, map[string]any{"kind": "oneshot", "agent": "claude-opus", "role": "editor", "runtime": map[string]any{"session_uuid": "unconcluded"}}, nil)
			before, _ := os.ReadFile(st.Path("task"))
			remotes := filepath.Join(home, "remotes.json")
			os.WriteFile(remotes, []byte(`{"version":1,"defaults":{"discover":false},"remotes":[]}`), 0600)
			args := append([]string{verb[0], "task"}, verb[1:]...)
			out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), args...)
			after, _ := os.ReadFile(st.Path("task"))
			if err == nil || string(before) != string(after) {
				t.Fatalf("unowned runtime evidence admitted non-retirement: %v %s", err, out)
			}
		})
	}
}

func TestPlanningRealBinaryMalformedFleetDoesNotBecomeOfflineAuthority(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, verb := range planningVerbs {
		t.Run(strings.Join(verb, "/"), func(t *testing.T) {
			dir, st := newStore(t)
			home := t.TempDir()
			seedFiber(t, st, "task", "", felt.StatusOpen, map[string]any{"kind": "oneshot", "host": "worker", "agent": "claude-opus", "role": "editor"}, nil)
			before, _ := os.ReadFile(st.Path("task"))
			remotes := filepath.Join(home, "remotes.json")
			os.WriteFile(remotes, []byte(`{"remotes":`), 0600)
			args := append([]string{verb[0], "task"}, verb[1:]...)
			out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), args...)
			after, _ := os.ReadFile(st.Path("task"))
			if err == nil || string(before) != string(after) {
				t.Fatalf("malformed fleet must remain a refusal: %v %s", err, out)
			}
		})
	}
}

func TestStandingTemperedCloseRequiresOwner(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, removed := range []bool{true, false} {
		for _, status := range []string{felt.StatusOpen, felt.StatusClosed} {
			t.Run(fmt.Sprintf("removed=%t/%s", removed, status), func(t *testing.T) {
				dir, st := newStore(t)
				home := t.TempDir()
				seedFiber(t, st, "task", "", status, map[string]any{"kind": "standing", "host": "worker", "schedule": map[string]any{"expr": "0 7 * * *", "tz": "UTC"}, "project_dir": dir}, nil)
				before, _ := os.ReadFile(st.Path("task"))
				var posts atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					posts.Add(1)
					w.WriteHeader(502)
					fmt.Fprint(w, `{"reason":"owner_unreachable_before_send","error":"no action request was sent"}`)
				}))
				defer server.Close()
				fleet := `[]`
				if !removed {
					fleet = `[{"name":"worker","port":4001}]`
				}
				remotes := filepath.Join(home, "remotes.json")
				os.WriteFile(remotes, []byte(`{"version":1,"defaults":{"discover":false},"remotes":`+fleet+`}`), 0600)
				out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, server.URL, remotes), "close", "task", "--tempered=true")
				after, _ := os.ReadFile(st.Path("task"))
				want := int32(1)
				if removed {
					want = 0
				}
				if err == nil || string(before) != string(after) || posts.Load() != want {
					t.Fatalf("standing acceptance must remain owner-only: posts=%d err=%v %s", posts.Load(), err, out)
				}
			})
		}
	}
}

func TestPlanningRealBinaryUncertainReplyAndChangedDocument(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, change := range []string{"lost-reply", "new-arm", "new-owner", "new-identity", "new-leaf"} {
		t.Run(change, func(t *testing.T) {
			dir, st := newStore(t)
			home := t.TempDir()
			seedFiber(t, st, "task", "", felt.StatusOpen, map[string]any{"kind": "oneshot", "host": "worker", "agent": "claude-opus"}, nil)
			f, _ := st.Read("task")
			if change == "new-leaf" {
				raw, _ := os.ReadFile(st.Path("task"))
				var lines []string
				for _, line := range strings.Split(string(raw), "\n") {
					if !strings.HasPrefix(line, "id:") {
						lines = append(lines, line)
					}
				}
				os.WriteFile(st.Path("task"), []byte(strings.Join(lines, "\n")), 0600)
				f, _ = st.Read("task")
			}
			before, _ := os.ReadFile(st.Path(f.ID))
			var posts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/document-changed" {
					fmt.Fprint(w, `{}`)
					return
				}
				if r.URL.Path != "/api/v1/lifecycle" {
					http.NotFound(w, r)
					return
				}
				posts.Add(1)
				if change == "lost-reply" {
					connection, _, _ := w.(http.Hijacker).Hijack()
					connection.Close()
					return
				}
				fresh, _ := st.Read("task")
				switch change {
				case "new-arm":
					fresh.Status = felt.StatusActive
				case "new-owner":
					fresh.SetExtraField("shuttle", map[string]any{"kind": "oneshot", "host": "new-owner", "agent": "claude-opus"})
				case "new-identity":
					replacement, _ := felt.New("task", "Replacement")
					fresh.UID = replacement.UID
				}
				if change == "new-leaf" {
					path := st.Path("elsewhere/task")
					os.MkdirAll(filepath.Dir(path), 0755)
					if err := os.Rename(st.Path("task"), path); err != nil {
						t.Error(err)
					}
				} else if err := st.Write(fresh); err != nil {
					t.Error(err)
				}
				w.WriteHeader(502)
				fmt.Fprint(w, `{"reason":"owner_unreachable_before_send","error":"no action request was sent"}`)
			}))
			defer server.Close()
			remotes := filepath.Join(home, "remotes.json")
			os.WriteFile(remotes, []byte(`{"version":1,"defaults":{"discover":false},"remotes":[{"name":"worker","port":4001}]}`), 0600)
			out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, server.URL, remotes), "set-agent", "task", "claude-sonnet")
			if err == nil || posts.Load() != 1 {
				t.Fatalf("must refuse without replay/mirror: posts=%d err=%v %s", posts.Load(), err, out)
			}
			id := "task"
			if change == "new-leaf" {
				id = "elsewhere/task"
				if _, err := os.Stat(st.Path("task")); !os.IsNotExist(err) {
					t.Fatal("planning recreated the vanished original")
				}
			}
			after, _ := os.ReadFile(st.Path(id))
			if change == "lost-reply" && string(before) != string(after) {
				t.Fatal("uncertain reply changed local copy")
			}
			fresh, _ := st.Read(id)
			block, _, _ := shuttle.BlockOf(fresh)
			if block.Agent != "claude-opus" {
				t.Fatalf("stale planning overwrote concurrent state: %s", after)
			}
		})
	}
}

func TestPlanningRealGitMergeOwnerArm(t *testing.T) {
	binary := planningProbeBinary(t)
	dir, st := newStore(t)
	home := t.TempDir()
	seedFiber(t, st, "task", "", felt.StatusOpen, map[string]any{"kind": "oneshot", "host": "worker", "agent": "claude-opus", "project_dir": dir}, nil)
	f, _ := st.Read("task")
	f.Touch(time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC))
	st.Write(f)
	git := func(args ...string) (string, error) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid")
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	mustGit := func(args ...string) {
		t.Helper()
		if out, err := git(args...); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	mustGit("init", "-b", "owner")
	mustGit("add", ".")
	mustGit("commit", "-m", "base")
	mustGit("checkout", "-b", "offline")
	remotes := filepath.Join(home, "remotes.json")
	os.WriteFile(remotes, []byte(`{"version":1,"defaults":{"discover":false},"remotes":[]}`), 0600)
	env := planningProbeEnv(home, "http://127.0.0.1:1", remotes)
	if out, err := runPlanningProbe(binary, dir, env, "rest", "task"); err != nil {
		t.Fatalf("rest %v %s", err, out)
	}
	planned, _ := st.Read("task")
	mustGit("add", ".")
	mustGit("commit", "-m", "offline rest")
	mustGit("checkout", "owner")
	ownerEnv := append(env, "SHUTTLE_HOST=worker")
	if out, err := runPlanningProbe(binary, dir, ownerEnv, "resume", "task", "--local"); err != nil {
		t.Fatalf("arm %v %s", err, out)
	}
	mustGit("add", ".")
	mustGit("commit", "-m", "explicit owner arm")
	if out, err := git("merge", "--no-edit", "offline"); err != nil {
		raw, _ := os.ReadFile(filepath.Join(dir, ".felt/task/task.md"))
		if !strings.Contains(string(raw), "<<<<<<<") {
			t.Fatalf("not a textual conflict: %s", out)
		}
		// The syncing agent resolves a textual conflict from the explicit owner arm.
		planned.Status = felt.StatusActive
		st.Write(planned)
		mustGit("add", ".")
		mustGit("commit", "-m", "resolve with owner arm")
	}
	merged, err := st.Read("task")
	if err != nil {
		t.Fatal(err)
	}
	if merged.Status != felt.StatusActive || !horizonStashed(merged) {
		t.Fatalf("lost owner arm or plan: %#v", merged)
	}
	var config map[string]any
	merged.ExtraFields["shuttle"].Decode(&config)
	for key := range config {
		switch key {
		case "kind", "host", "agent", "project_dir", "runtime":
		default:
			t.Fatalf("merge introduced an execution gate: %s", key)
		}
	}
}
