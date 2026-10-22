package shuttlecli

import (
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// meetingDaemon serves one meeting route, recording the request body it got.
func meetingDaemon(t *testing.T, path string, status int, answer string, got *map[string]any) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != path {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, got); err != nil {
			t.Errorf("request body %q: %v", raw, err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
	})
}

const meetingStartAnswer = `{"recorder":"mac","origin":"cluster","transcript":"/home/u/.hark/meetings/2026-09-25_1403_standup.txt","meeting":{"state":"live","title":"Standup","launch":"L1","recorder":"mac"}}`

func TestMeetingStartPrintsTheTranscriptPath(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got map[string]any
	serveDaemon(t, env, meetingDaemon(t, "/api/v1/meeting/start", 200, meetingStartAnswer, &got))

	out, errOut, err := executeIn(t, env, "", "meeting", "start", "--recorder", "mac", "--note", "Standup\nagenda")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"recorder": "mac", "note": "Standup\nagenda", "meeting": map[string]any{"mode": "call"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request %v, want %v", got, want)
	}
	// Stdout is the path alone, so `shuttle follow "$(shuttle meeting start)"` works.
	if out != "/home/u/.hark/meetings/2026-09-25_1403_standup.txt\n" {
		t.Fatalf("stdout %q", out)
	}
	if !strings.Contains(errOut, "shuttle meeting stop --recorder mac --launch L1") {
		t.Fatalf("stderr %q does not say how to stop", errOut)
	}
}

func TestMeetingStartDefaultsAndJSON(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got map[string]any
	serveDaemon(t, env, meetingDaemon(t, "/api/v1/meeting/start", 200, meetingStartAnswer, &got))

	out, _, err := executeIn(t, env, "", "meeting", "start", "--mode", "phone", "--json")
	if err != nil {
		t.Fatal(err)
	}
	// An omitted recorder and note stay out of the request: the daemon selects.
	if want := map[string]any{"meeting": map[string]any{"mode": "phone"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("request %v, want %v", got, want)
	}
	if strings.TrimSpace(out) != meetingStartAnswer {
		t.Fatalf("--json printed %q", out)
	}
}

func TestMeetingStartFailures(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		args   []string
		status int
		answer string
		want   string
	}{
		"bad mode":          {args: []string{"--mode", "room"}, want: "--mode must be call or phone"},
		"conflict":          {status: 409, answer: `{"error":"a meeting is already active"}`, want: "a meeting is already active"},
		"recording unknown": {status: 502, answer: `{"recorder":"mac","recording_unknown":true,"error":"Inspect that recorder before retrying"}`, want: "recording_unknown"},
		"no transcript":     {status: 200, answer: `{"recorder":"mac"}`, want: "without a transcript path"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			called := false
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.answer))
			}))
			out, _, err := executeIn(t, env, "", append([]string{"meeting", "start"}, tc.args...)...)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %v, want %q", err, tc.want)
			}
			if out != "" {
				t.Fatalf("a failed start printed %q", out)
			}
			if tc.status == 0 && called {
				t.Fatal("an invalid mode reached the daemon")
			}
		})
	}
}

func TestMeetingStop(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got map[string]any
	serveDaemon(t, env, meetingDaemon(t, "/api/v1/meeting/stop", 202,
		`{"recorder":"mac","meeting":{"state":"stopping","title":"Standup","launch":"L1"}}`, &got))

	if _, _, err := executeIn(t, env, "", "meeting", "stop", "--recorder", "mac"); err == nil ||
		!strings.Contains(err.Error(), "--launch is required") {
		t.Fatalf("addressed stop without launch: %v", err)
	}
	out, _, err := executeIn(t, env, "", "meeting", "stop", "--recorder", "mac", "--launch", "L1")
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"recorder": "mac", "launch": "L1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("request %v, want %v", got, want)
	}
	if !strings.Contains(out, `Meeting "Standup" on mac: stopping`) {
		t.Fatalf("stdout %q", out)
	}
}
