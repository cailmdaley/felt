package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

const spokenAnswer = `{"date":"2026-11-07","rows":[{"t":"2026-11-07T10:23:41.123+01:00","speaker":"me","text":"Hello","fiber_id":"project/card","origin":"cluster","name":"Card title","launch":"voice-1"},{"t":"2026-11-07T10:24:02+01:00","speaker":"S2","text":"Yes\nindeed","fiber_id":"01ABC","slug":"project/second-card","name":"Card title"},{"t":"2026-11-07T10:24:03+01:00","speaker":"S3","text":"Unrouted","fiber_id":null,"name":null}],"recorder":"recorder-host"}`

func TestSpokenTranscriptFiltersAndRendering(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var query url.Values
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/voice/transcript" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		query = r.URL.Query()
		_, _ = w.Write([]byte(spokenAnswer))
	}))
	out, _, err := executeIn(t, env, "", "transcript", "--date", "2026-11-07", "--fiber", "project/a & b", "--since", "10:23:41", "--recorder", "recorder-host")
	if err != nil {
		t.Fatal(err)
	}
	wantQuery := url.Values{"date": {"2026-11-07"}, "fiber": {"project/a & b"}, "since": {"10:23:41"}, "recorder": {"recorder-host"}}
	if !reflect.DeepEqual(query, wantQuery) {
		t.Fatalf("query %v, want %v", query, wantQuery)
	}
	want := "10:23:41 me → card: Hello\n10:24:02 S2 → second-card: Yes indeed\n10:24:03 S3 → —: Unrouted\n"
	if out != want {
		t.Fatalf("output %q, want %q", out, want)
	}
}

func TestSpokenTranscriptJSONAndEmpty(t *testing.T) {
	t.Parallel()
	for _, answer := range []string{spokenAnswer, `{"date":"2026-11-07","rows":[],"recorder":"host"}`} {
		t.Run(answer[:20], func(t *testing.T) {
			env := testEnv(t)
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if len(r.URL.Query()) != 0 {
					t.Errorf("unexpected defaults: %v", r.URL.Query())
				}
				_, _ = w.Write([]byte(answer))
			}))
			out, _, err := executeIn(t, env, "", "transcript", "--json")
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			if json.Unmarshal([]byte(out), &got) != nil || json.Unmarshal([]byte(answer), &want) != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("JSON %q, want %q", out, answer)
			}
			if strings.Contains(answer, `"rows":[]`) {
				out, _, err = executeIn(t, env, "", "transcript")
				if err != nil || out != "" {
					t.Fatalf("empty transcript: %q, %v", out, err)
				}
			}
		})
	}
}

func TestSpokenTranscriptDaemonErrorsAndSessionFlags(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"error":"invalid since"}`))
	}))
	out, _, err := executeIn(t, env, "", "transcript", "--since", "nope")
	if err == nil || !strings.Contains(err.Error(), "invalid since") || out != "" {
		t.Fatalf("daemon error: out=%q err=%v", out, err)
	}
	_, _, err = executeIn(t, env, "", "transcript", "11111111-1111-4111-8111-111111111111", "--date", "2026-11-07")
	if err == nil || !strings.Contains(err.Error(), "not a session ID") {
		t.Fatalf("session flags: %v", err)
	}
}
