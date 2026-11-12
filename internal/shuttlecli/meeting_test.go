package shuttlecli

import (
	"reflect"
	"strings"
	"testing"
)

func TestMeetingStartPinsTheNamedCard(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got map[string]any
	serveDaemon(t, env, speechDaemon(t, "/api/v1/voice", 200, `{"mode":"meeting","target":{"fiber_id":"loom/x","name":"Weekly sync"},"recorder":"mac"}`, &got))
	out, _, err := executeIn(t, env, "", "meeting", "start", "--fiber", "loom/x")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"meeting": true, "target": map[string]any{"fiber_id": "loom/x"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request %v, want %v", got, want)
	}
	if out != "Meeting on Weekly sync, recording on mac\n" {
		t.Fatalf("stdout %q", out)
	}
}

func TestMeetingEndFollowsAgain(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got map[string]any
	serveDaemon(t, env, speechDaemon(t, "/api/v1/voice", 200, `{"mode":"following","target":{"fiber_id":"loom/x"},"recorder":"mac"}`, &got))
	out, _, err := executeIn(t, env, "", "meeting", "end")
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"meeting": false}; !reflect.DeepEqual(got, want) {
		t.Fatalf("request %v, want %v", got, want)
	}
	if out != "No meeting; Listen is following\n" {
		t.Fatalf("stdout %q", out)
	}
}

func TestMeetingStartWithoutAWorkerAsksForAFiber(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_, _, err := executeIn(t, env, "", "meeting", "start")
	if err == nil || !strings.HasSuffix(err.Error(), "(or pass --fiber)") {
		t.Fatalf("err %v", err)
	}
}
