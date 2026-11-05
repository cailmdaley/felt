package shuttlecli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// An override runs the same public probes against a preserved pre-fix binary.
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
	cmd.Env, cmd.Dir = env, dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func exitFixture(t *testing.T, content, fleet string) (string, string, string, string) {
	t.Helper()
	dir, st := newStore(t)
	path := st.Path("task")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	text := "---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAX\nname: Task\noutcome: keep me\n" + content + "\n---\nBody\n"
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	remotes := filepath.Join(home, "remotes.json")
	if err := os.WriteFile(remotes, []byte(fleet), 0600); err != nil {
		t.Fatal(err)
	}
	return dir, path, home, remotes
}

const foreignDraft = "status: open\nshuttle:\n  kind: oneshot\n  host: worker"
const configuredWorker = `{"version":1,"defaults":{"discover":false},"remotes":[{"name":"worker","port":4001}]}`

func TestForeignLocalExitNeverMirrors(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, args := range [][]string{{"rest", "task", "--local"}, {"close", "task", "--local"}, {"close", "task", "--local", "--tempered=false"}, {"rest", "task", "--local", "--mirror-owner", "worker"}, {"close", "task", "--local", "--mirror-owner", "worker"}} {
		t.Run(strings.Join(args, "/"), func(t *testing.T) {
			dir, path, home, remotes := exitFixture(t, foreignDraft, configuredWorker)
			before, _ := os.ReadFile(path)
			out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), args...)
			after, _ := os.ReadFile(path)
			if err == nil || string(after) != string(before) {
				t.Fatalf("user-reachable mirror path: %v %s\n%s", err, out, after)
			}
		})
	}
}

func TestDaemonDownExitNeverSuggestsForeignLocalWrite(t *testing.T) {
	binary := planningProbeBinary(t)
	dir, _, home, remotes := exitFixture(t, foreignDraft, configuredWorker)
	out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), "rest", "task")
	if err == nil || strings.Contains(out, "--local") || !strings.Contains(out, "Start it") {
		t.Fatalf("daemon-down recovery bypasses owner policy: %v %s", err, out)
	}
}

func TestMirrorExitRejectsPauseAndRestUntil(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, args := range [][]string{{"pause", "task", "--local"}, {"pause", "task", "--local", "--no-kill"}, {"rest", "task", "--local", "--until", ""}, {"rest", "task", "--local", "--until", "2026-12-01"}} {
		t.Run(strings.Join(args, "/"), func(t *testing.T) {
			dir, path, home, remotes := exitFixture(t, foreignDraft, configuredWorker)
			before, _ := os.ReadFile(path)
			out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), args...)
			after, _ := os.ReadFile(path)
			if err == nil || string(after) != string(before) {
				t.Fatalf("non-exit mirrored: %v %s\n%s", err, out, after)
			}
		})
	}
}

func TestExitCLINeverReplaysDaemonRefusal(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, verb := range [][]string{{"rest"}, {"pause"}, {"close"}, {"close", "--tempered=false"}, {"close", "--tempered=true"}, {"set-agent", "claude-sonnet"}, {"set-model", "claude-sonnet"}, {"set-outcome", "--outcome", "Planned"}, {"reshape", "standing", "--schedule", "0 9 * * *"}, {"role", "editor", "--new", "Editor"}, {"seat"}} {
		t.Run(strings.Join(verb, "/"), func(t *testing.T) {
			dir, path, home, remotes := exitFixture(t, foreignDraft, configuredWorker)
			before, _ := os.ReadFile(path)
			var posts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/lifecycle" {
					posts.Add(1)
					w.WriteHeader(502)
					fmt.Fprint(w, `{"reason":"owner_unreachable_before_send","error":"no action request was sent; nothing was applied"}`)
					return
				}
				http.NotFound(w, r)
			}))
			defer server.Close()
			args := append([]string{verb[0], "task"}, verb[1:]...)
			out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, server.URL, remotes), args...)
			after, _ := os.ReadFile(path)
			if err == nil || posts.Load() != 1 || string(before) != string(after) {
				t.Fatalf("daemon refusal bypassed: posts=%d err=%v output=%s changed=%t", posts.Load(), err, out, string(before) != string(after))
			}
		})
	}
}

func TestExitCLIDaemonDownPreservesStdinOutcome(t *testing.T) {
	binary := planningProbeBinary(t)
	dir, path, home, remotes := exitFixture(t, foreignDraft, configuredWorker)
	before, _ := os.ReadFile(path)
	cmd := exec.Command(binary, "-C", dir, "set-outcome", "task")
	cmd.Env, cmd.Dir, cmd.Stdin = planningProbeEnv(home, "http://127.0.0.1:1", remotes), dir, strings.NewReader("x")
	out, err := cmd.CombinedOutput()
	after, _ := os.ReadFile(path)
	if err == nil || string(before) != string(after) {
		t.Fatalf("drained stdin changed the mirror: %v %s\n%s", err, out, after)
	}
	if strings.Contains(string(out), "--local") || !strings.Contains(string(out), "Start it") {
		t.Fatalf("configuration recovery advice offers a refused local write: %s", out)
	}
}

func TestExitExplicitLocalChecksStandingAndDiscovery(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, state := range []string{"pending", "unavailable", "ok", "closed-fleet", "rejected", "peer", "disabled-entry"} {
		for _, standing := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/standing=%t", state, standing), func(t *testing.T) {
				content := "status: active\nshuttle:\n  kind: oneshot\n  host: worker\n  runtime:\n    session_uuid: live"
				if standing {
					content = "status: closed\nshuttle:\n  kind: standing\n  schedule:\n    expr: '0 9 * * *'\n  host: worker"
				}
				fleet := `{"version":1,"remotes":[]}`
				if state == "closed-fleet" {
					fleet = `{"version":1,"defaults":{"discover":false},"remotes":[]}`
				}
				if state == "disabled-entry" {
					fleet = `{"version":1,"remotes":[{"name":"worker","port":4001,"enabled":false}]}`
				}
				dir, path, home, remotes := exitFixture(t, content, fleet)
				before, _ := os.ReadFile(path)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch state {
					case "rejected":
						fmt.Fprint(w, `{"discovery":{"state":"ok","peers":[],"rejected":[{"dns_name":"worker.example.ts.net.","reason":"offline"}]}}`)
					case "peer":
						fmt.Fprint(w, `{"discovery":{"state":"ok","peers":[{"name":"worker","url":"http://127.0.0.1:1"}]}}`)
					case "disabled-entry":
						fmt.Fprint(w, `{"discovery":{"state":"ok","peers":[]}}`)
					default:
						fmt.Fprintf(w, `{"discovery":{"state":%q,"peers":[]}}`, state)
					}
				}))
				defer server.Close()
				out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, server.URL, remotes), "rest", "task", "--local")
				after, _ := os.ReadFile(path)
				if err == nil || string(before) != string(after) {
					t.Fatalf("unknown discovery treated as removal: %v %s", err, out)
				}
			})
		}
	}
	t.Run("configured standing owner is not removed", func(t *testing.T) {
		dir, path, home, remotes := exitFixture(t, "status: closed\nshuttle:\n  kind: standing\n  schedule:\n    expr: '0 9 * * *'\n  host: worker", configuredWorker)
		before, _ := os.ReadFile(path)
		out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), "rest", "task", "--local")
		after, _ := os.ReadFile(path)
		if err == nil || string(before) != string(after) || !strings.Contains(out, "is owned by host") {
			t.Fatalf("standing schedule was locally parked: %v %s", err, out)
		}
	})
}

func TestExitUnownedActiveAndDispatchedParity(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, state := range []string{"status: active", "status: open"} {
		for _, verb := range []string{"rest", "close"} {
			dir, path, home, remotes := exitFixture(t, state+"\nshuttle:\n  kind: oneshot\n  runtime:\n    dispatched_at: '2026-11-04T10:00:00Z'", configuredWorker)
			out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), verb, "task")
			after, _ := os.ReadFile(path)
			if err != nil || strings.Contains(out, "Git") || strings.Contains(string(after), "mirrored_at:") {
				t.Fatalf("unowned native exit became a mirror refusal: %v %s\n%s", err, out, after)
			}
		}
	}
}

func TestExitUnscheduledStandingRequiresOwner(t *testing.T) {
	binary := planningProbeBinary(t)
	dir, path, home, remotes := exitFixture(t, "status: open\nshuttle:\n  kind: standing\n  host: worker", configuredWorker)
	before, _ := os.ReadFile(path)
	out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), "rest", "task", "--local")
	after, _ := os.ReadFile(path)
	if err == nil || string(before) != string(after) {
		t.Fatalf("unscheduled standing mirrored: %v %s", err, out)
	}
}
