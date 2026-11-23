package shuttlecli

import (
	"fmt"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// recordingDaemon answers every POST with reply and records each path and body.
func recordingDaemon(t *testing.T, reply string) (http.Handler, *requestBodies, *[]string) {
	bodies, paths := &requestBodies{}, &[]string{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "unexpected "+r.URL.String(), http.StatusNotFound)
			return
		}
		bodies.record(t, r)
		*paths = append(*paths, r.URL.Path)
		fmt.Fprint(w, reply)
	}), bodies, paths
}

func TestKillStopsTheWorkerOnItsOwner(t *testing.T) {
	t.Parallel()
	for host, seededHost := range map[string]string{"hub": "", "worker": "worker"} {
		t.Run(host, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, storage := newStore(t)
			block := oneshot()
			if seededHost != "" {
				block["host"] = seededHost
			}
			seedFiber(t, storage, "work/reports", clearTestUID, "active", block, nil)
			handler, bodies, paths := recordingDaemon(t, `{"fiber_id":"x","killed":true,"session":"the-session"}`)
			serveDaemon(t, env, handler)
			out, err := runIn(t, env, dir, "kill", "work/reports")
			if err != nil || !strings.Contains(out, "killed the-session") {
				t.Fatalf("%v: %s", err, out)
			}
			want := map[string]any{"fiber_id": clearTestUID, "origin": host}
			if len(bodies.bodies) != 1 || (*paths)[0] != "/api/v1/kill" || !reflect.DeepEqual(bodies.bodies[0], want) {
				t.Fatalf("sent %v %v", *paths, bodies.bodies)
			}
		})
	}
}

func TestKillReportsNoWorkerAndRefusesAGuess(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work/reports", clearTestUID, "active", oneshot(), nil)
	handler, bodies, _ := recordingDaemon(t, `{"fiber_id":"x","killed":false}`)
	serveDaemon(t, env, handler)
	if out, err := runIn(t, env, dir, "kill", "work/reports"); err != nil || !strings.Contains(out, "no live worker") {
		t.Fatalf("%v: %s", err, out)
	}
	if out, err := runIn(t, env, dir, "kill", "work/rep"); err == nil {
		t.Fatalf("killed by prefix: %s", out)
	}
	if len(bodies.bodies) != 1 {
		t.Fatalf("a guess reached the daemon: %v", bodies.bodies)
	}
}

func TestCaptureLaunchesFromAPrompt(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	project := t.TempDir()
	const reply = `{"spawned":true,"agent":"claude-opus","surface":"cli","terminal":"tmux","tmux_session":"capture-1","session_uuid":"native"}`
	handler, bodies, paths := recordingDaemon(t, reply)
	serveDaemon(t, env, handler)

	out, err := runIn(t, env, "", "capture", "read the mocks", "--project-dir", project)
	if err != nil || !strings.Contains(out, "claude-opus on hub") || !strings.Contains(out, "capture-1") || !strings.Contains(out, "native") {
		t.Fatalf("%v: %s", err, out)
	}
	want := map[string]any{"prompt": "read the mocks", "project_dir": project, "origin": "hub"}
	if (*paths)[0] != "/api/v1/capture" || !reflect.DeepEqual(bodies.bodies[0], want) {
		t.Fatalf("sent %v %v", *paths, bodies.bodies)
	}

	out, err = runIn(t, env, "", "capture", "p", "--project-dir", project, "--agent", "a", "--effort", "high", "--chrome", "--json")
	if err != nil || strings.TrimSpace(out) != reply {
		t.Fatalf("--json: %v: %s", err, out)
	}
	want = map[string]any{"prompt": "p", "project_dir": project, "origin": "hub", "agent": "a", "effort": "high", "chrome": true}
	if !reflect.DeepEqual(bodies.bodies[1], want) {
		t.Fatalf("sent %v", bodies.bodies[1])
	}

	for _, args := range [][]string{
		{"capture", "p"},
		{"capture", "  ", "--project-dir", project},
		{"capture", "p", "--project-dir", filepath.Join(project, "absent")},
	} {
		if out, err := runIn(t, env, "", args...); err == nil {
			t.Fatalf("%v launched: %s", args, out)
		}
	}
	if len(bodies.bodies) != 2 {
		t.Fatalf("a refused capture reached the daemon: %v", bodies.bodies)
	}
}

// A remote capture's directory is the owner's, and a failure names the host
// without repeating the prompt.
func TestCaptureOnAnotherHost(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	var captured requestBodies
	fail := false
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/project-dir/resolve":
			fmt.Fprint(w, `{"path":"/far/home/project"}`)
		case fail:
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, `{"spawned":false,"reason":"forward_failed","origin":"worker","error":"timeout"}`)
		default:
			captured.record(t, r)
			fmt.Fprint(w, `{"spawned":true,"agent":"claude-opus","tmux_session":"capture-1"}`)
		}
	}))
	out, err := runIn(t, env, "", "capture", "a private prompt", "--host", "worker", "--project-dir", "~/project")
	if err != nil || !strings.Contains(out, "on worker in /far/home/project") {
		t.Fatalf("%v: %s", err, out)
	}
	if body := captured.bodies[0]; body["origin"] != "worker" || body["project_dir"] != "/far/home/project" {
		t.Fatalf("sent %v", body)
	}
	fail = true
	_, err = runIn(t, env, "", "capture", "a private prompt", "--host", "worker", "--project-dir", "~/project")
	if err == nil || !strings.Contains(err.Error(), `"worker" is unreachable`) || strings.Contains(err.Error(), "private") {
		t.Fatalf("err = %v", err)
	}
	if _, err = runIn(t, env, "", "capture", "p", "--host", "stranger", "--project-dir", "/x"); err == nil {
		t.Fatal("captured on an unknown host")
	}
}
