package shuttlecli

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestRemoteControl(t *testing.T) {
	t.Parallel()
	for _, jsonMode := range []bool{false, true} {
		t.Run(map[bool]string{false: "readable", true: "json"}[jsonMode], func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			payload := `{"state":"waiting","dir":"/path/to/projects","args":["--verbose"],"pid":null,"started_at":"2026-10-20T12:00:00Z","restarts":3,"last_exit":{"status":7,"at":"2026-10-20T12:00:01Z","screen":["already served"]},"next_attempt_at":"2026-10-20T12:00:05Z","message":"retrying"}`
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/remote_control" || r.Method != "GET" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(payload))
			}))
			args := []string{"remote-control"}
			if jsonMode {
				args = append(args, "--json")
			}
			out, _, err := executeIn(t, env, "", args...)
			if err != nil {
				t.Fatal(err)
			}
			if jsonMode {
				var got, want any
				if err := json.Unmarshal([]byte(out), &got); err != nil {
					t.Fatal(err)
				}
				_ = json.Unmarshal([]byte(payload), &want)
				g, _ := json.Marshal(got)
				w, _ := json.Marshal(want)
				if string(g) != string(w) {
					t.Fatalf("got %s, want %s", g, w)
				}
			} else {
				for _, want := range []string{"Remote Control: waiting", "Directory: /path/to/projects", "Arguments: [\"--verbose\"]", "Starts this daemon: 3", "Last exit: 7", "Next attempt: 2026-10-20T12:00:05Z", "already served", "retrying"} {
					if !strings.Contains(out, want) {
						t.Errorf("missing %q in %s", want, out)
					}
				}
				if strings.Contains(out, "Pane PID:") {
					t.Fatalf("nil PID printed: %s", out)
				}
			}
		})
	}
}

func TestRemoteControlFailure(t *testing.T) {
	t.Parallel()
	for _, body := range []string{"bad json", `{"state":"disabled"}`} {
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if body != "bad json" {
					w.WriteHeader(http.StatusServiceUnavailable)
				}
				_, _ = w.Write([]byte(body))
			}))
			_, _, err := executeIn(t, env, "", "remote-control")
			if err == nil {
				t.Fatal("expected daemon/decode error")
			}
		})
	}
}
