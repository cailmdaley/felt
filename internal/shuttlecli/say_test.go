package shuttlecli

import (
	"reflect"
	"strings"
	"testing"
)

func TestSaySendsTheLineAndNamesTheVoice(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got map[string]any
	serveDaemon(t, env, meetingDaemon(t, "/api/v1/speak", 200, `{"voice":"borges","ahead":2,"recorder":"mac"}`, &got))

	out, _, err := executeIn(t, env, "", "say", "--fiber", "loom/x", "--voice", "borges", "Hello Cail.")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"fiber_id": "loom/x", "voice": "borges", "text": "Hello Cail."}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request %v, want %v", got, want)
	}
	if out != "Speaking on mac as borges, after 2 queued\n" {
		t.Fatalf("stdout %q", out)
	}
}

func TestSayWithoutAWorkerAsksForAFiber(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	_, _, err := executeIn(t, env, "", "say", "Hello.")
	if err == nil || !strings.HasSuffix(err.Error(), "(or pass --fiber)") {
		t.Fatalf("err %v", err)
	}
}
