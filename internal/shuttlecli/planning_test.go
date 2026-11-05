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

	"github.com/cailmdaley/felt/internal/felt"
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
	if !strings.Contains(string(out), "--local") {
		t.Fatalf("missing explicit recovery advice: %s", out)
	}
}

func TestExitExplicitLocalChecksStandingAndDiscovery(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, state := range []string{"pending", "unavailable", "ok", "closed-fleet"} {
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
				dir, path, home, remotes := exitFixture(t, content, fleet)
				before, _ := os.ReadFile(path)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					fmt.Fprintf(w, `{"discovery":{"state":%q,"peers":[]}}`, state)
				}))
				defer server.Close()
				out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, server.URL, remotes), "rest", "task", "--local")
				after, _ := os.ReadFile(path)
				if state == "closed-fleet" {
					if err != nil || !strings.Contains(out, "Git") {
						t.Fatalf("removed owner retirement: %v %s", err, out)
					}
				} else if err == nil || string(before) != string(after) {
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
		if err == nil || string(before) != string(after) || !strings.Contains(out, "owner decides") {
			t.Fatalf("standing schedule was locally parked: %v %s", err, out)
		}
	})
}

func TestMirrorExitPreservesRunAndPublicationEvidence(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, verb := range [][]string{{"rest"}, {"pause"}, {"close", "--quiet", "--tempered=false"}} {
		t.Run(verb[0], func(t *testing.T) {
			content := "status: closed\nshuttle:\n  kind: oneshot\n  host: worker\n  runtime:\n    thread_exit_verb: rearmed\n    quiet_closed_at: '2026-11-04T11:00:00Z'"
			dir, path, home, remotes := exitFixture(t, content, configuredWorker)
			args := append([]string{verb[0], "task", "--local", "--mirror-owner", "worker"}, verb[1:]...)
			out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), args...)
			after, _ := os.ReadFile(path)
			if err != nil || !strings.Contains(string(after), "thread_exit_verb: rearmed") || !strings.Contains(string(after), "quiet_closed_at: '2026-11-04T11:00:00Z'") || strings.Contains(string(after), "handed_off_at:") {
				t.Fatalf("mirror manufactured run/publication evidence: %v %s\n%s", err, out, after)
			}
		})
	}
}

func TestRemovedOwnerDoesNotAuthorizeMalformedRuntime(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, runtime := range []string{"null", "[]", "unknown"} {
		dir, path, home, remotes := exitFixture(t, "status: active\nshuttle:\n  kind: oneshot\n  host: worker\n  runtime: "+runtime, `{"version":1,"defaults":{"discover":false},"remotes":[]}`)
		before, _ := os.ReadFile(path)
		out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), "rest", "task", "--local")
		after, _ := os.ReadFile(path)
		if err == nil || string(before) != string(after) {
			t.Fatalf("malformed runtime was replaced: %v %s", err, out)
		}
	}
}

func TestExitMirrorChecksOwnerAndDoesNotInventExecution(t *testing.T) {
	binary := planningProbeBinary(t)
	for _, ending := range []string{"Z", ""} {
		t.Run("zone="+ending, func(t *testing.T) {
			dir, path, home, remotes := exitFixture(t, "status: closed\nshuttle:\n  kind: oneshot\n  host: worker\n  runtime:\n    dispatched_at: '2026-11-04T10:00:00"+ending+"'\n    handed_off_at: '2026-11-04T11:00:00"+ending+"'", configuredWorker)
			before, _ := os.ReadFile(path)
			out, err := runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), "rest", "task", "--local", "--mirror-owner", "worker")
			after, _ := os.ReadFile(path)
			if ending == "" {
				if err == nil || string(before) != string(after) {
					t.Fatalf("zone-less evidence accepted: %v %s", err, out)
				}
				return
			}
			if err != nil || !strings.Contains(string(after), "mirrored_at:") || !strings.Contains(out, "no execution request was sent") || strings.Contains(string(after), "session_uuid:") {
				t.Fatalf("mirror write: %v %s\n%s", err, out, after)
			}
			before = after
			out, err = runPlanningProbe(binary, dir, planningProbeEnv(home, "http://127.0.0.1:1", remotes), "rest", "task", "--local", "--mirror-owner", "different")
			after, _ = os.ReadFile(path)
			if err == nil || string(before) != string(after) {
				t.Fatalf("changed owner accepted: %v %s", err, out)
			}
		})
	}
}
