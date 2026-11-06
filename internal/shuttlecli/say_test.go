package shuttlecli

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestSaySendsTheLineAndNamesTheVoice(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got map[string]any
	serveDaemon(t, env, meetingDaemon(t, "/api/v1/speak", 200, `{"voice":"borges","ahead":2,"recorder":"mac"}`, &got))

	out, _, err := executeIn(t, env, "", "say", "--fiber", "loom/x", "--voice", "borges", "Hello there.")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"fiber_id": "loom/x", "voice": "borges", "text": "Hello there."}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request %v, want %v", got, want)
	}
	if out != "Speaking on mac as borges, after 2 queued\n" {
		t.Fatalf("stdout %q", out)
	}
}

func TestSaySaysWhenTheLineIsHeld(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got map[string]any
	serveDaemon(t, env, meetingDaemon(t, "/api/v1/speak", 200, `{"voice":"jean","ahead":0,"held":true,"recorder":"mac"}`, &got))
	out, _, err := executeIn(t, env, "", "say", "--fiber", "loom/x", "Later.")
	if err != nil {
		t.Fatal(err)
	}
	if out != "Speaking on mac as jean, held until its card is in view\n" {
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

func TestVoicesMarksTheRolesHoldingThem(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/speak/voices" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"voices":[{"name":"borges","kind":"bank","role":"tutor"},{"name":"jean","kind":"builtin","role":null}]}`))
	}))

	out, _, err := executeIn(t, env, "", "voices")
	if err != nil {
		t.Fatal(err)
	}
	if want := "borges           bank     roles/tutor\njean             builtin\n"; out != want {
		t.Fatalf("stdout %q, want %q", out, want)
	}
}

const inboxState = `{"held":[{"fiber_id":"a/two","name":"Two card","n":2,"first":"one two three four five six seven eight nine"},{"fiber_id":"a/one","name":"One card","n":1,"first":"hello"}],"inbox":{"playing":false}}`

func TestInboxListsHeldLinesByCard(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/speak" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(inboxState))
	}))
	out, _, err := executeIn(t, env, "", "inbox")
	if err != nil {
		t.Fatal(err)
	}
	if want := "Two card (2): one two three four five six seven eight …\nOne card (1): hello\n"; out != want {
		t.Fatalf("stdout %q, want %q", out, want)
	}
}

func TestInboxPlayOpensTheInbox(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	var got map[string]any
	serveDaemon(t, env, meetingDaemon(t, "/api/v1/speak", 200, `{"held":[],"inbox":{"playing":true}}`, &got))
	out, _, err := executeIn(t, env, "", "inbox", "--play")
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"inbox": "play"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("request %v, want %v", got, want)
	}
	if out != "Inbox playing\n" {
		t.Fatalf("stdout %q", out)
	}
}
