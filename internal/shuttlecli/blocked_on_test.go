package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

const blockerUID = "01JB0CKER00000000000000000"

// A rest --until naming a fiber stores its uid; a text naming nothing is kept
// as text; a date is a return day and clears the wait; '' clears both.
func TestRestUntilNamesWhatItWaitsFor(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "hub/a", "01JTHREAD00000000000000000", felt.StatusActive, oneshot(), nil)
	seedFiber(t, storage, "hub/blocker", blockerUID, felt.StatusActive, nil, nil)

	out, err := runIn(t, env, dir, "rest", "hub/a", "--until", "blocker", "--local")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if got := blockedOn(mustRead(t, storage, "hub/a")); got != blockerUID {
		t.Fatalf("blocked_on = %q, want the sibling's uid", got)
	}
	if !strings.Contains(out, "until: hub/blocker (hub/blocker)") {
		t.Fatalf("rest does not say what it waits for:\n%s", out)
	}
	handed := runtimeField(t, storage, "hub/a", "handed_off_at")

	// Already at rest: only the wait changes, and the rest is not stamped again.
	out, err = runIn(t, env, dir, "rest", "hub/a", "--until", "Cail's review of the draft", "--local")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if got := blockedOn(mustRead(t, storage, "hub/a")); got != "Cail's review of the draft" {
		t.Fatalf("blocked_on = %q, want the free text", got)
	}
	if again := runtimeField(t, storage, "hub/a", "handed_off_at"); again != handed {
		t.Fatalf("a re-rest stamped the rest again: %s → %s", handed, again)
	}

	if out, err := runIn(t, env, dir, "rest", "hub/a", "--until", "2099-06-12", "--local"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	got := mustRead(t, storage, "hub/a")
	if blockedOn(got) != "" || got.Due == nil {
		t.Fatalf("a return day must replace the wait: blocked_on=%q due=%v", blockedOn(got), got.Due)
	}
	if out, err := runIn(t, env, dir, "rest", "hub/a", "--until", "blocker", "--local"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if got := mustRead(t, storage, "hub/a"); got.Due != nil {
		t.Fatal("a wait must replace the return day")
	}
	if out, err := runIn(t, env, dir, "rest", "hub/a", "--until", "", "--local"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if got := mustRead(t, storage, "hub/a"); blockedOn(got) != "" || got.Due != nil {
		t.Fatal("--until '' must clear the wait and the day")
	}
	if _, err := runIn(t, env, dir, "rest", "hub/a", "--until", "hub/a", "--local"); err == nil {
		t.Fatal("a constitution rested until itself")
	}
}

// resume and close end the wait.
func TestResumeAndCloseClearTheWait(t *testing.T) {
	t.Parallel()
	for _, verb := range []string{"resume", "close"} {
		t.Run(verb, func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, storage := newStore(t)
			seedFiber(t, storage, "f", "01JTHREAD00000000000000000", felt.StatusActive, oneshot(), nil)
			if out, err := runIn(t, env, dir, "rest", "f", "--until", "the mocks", "--local"); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			if out, err := runIn(t, env, dir, verb, "f", "--local"); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			raw, _ := os.ReadFile(storage.Path("f"))
			if strings.Contains(string(raw), "blocked_on") {
				t.Fatalf("%s kept the wait:\n%s", verb, raw)
			}
		})
	}
}

// status names the wait in prose and --json, by the blocker's current name.
func TestStatusShowsTheWait(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "hub/a", "01JTHREAD00000000000000000", felt.StatusActive, oneshot(), nil)
	seedFiber(t, storage, "hub/blocker", blockerUID, felt.StatusActive, nil, nil)
	if out, err := runIn(t, env, dir, "rest", "hub/a", "--until", "hub/blocker", "--local"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	blocker := mustRead(t, storage, "hub/blocker")
	blocker.Name = "The mocks land"
	if err := storage.Write(blocker); err != nil {
		t.Fatal(err)
	}

	out, err := runIn(t, env, dir, "status", "hub/a")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	for _, want := range []string{"until:       The mocks land", "→ Resting until The mocks land"} {
		if !strings.Contains(out, want) {
			t.Fatalf("status lacks %q:\n%s", want, out)
		}
	}
	out, err = runIn(t, env, dir, "status", "hub/a", "--json")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if got["blocked_on"] != blockerUID || got["until"] != "The mocks land" {
		t.Fatalf("status --json blocked_on=%v until=%v", got["blocked_on"], got["until"])
	}
}

// threads rows read "⏸ until <name>", naming a uid from this host's store when
// the daemon sent no name.
func TestThreadsShowTheWait(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "hub/blocker", blockerUID, felt.StatusActive, nil, nil)
	tree := `{"fiber_id":"hub","name":"Hub","threads":[
 {"id":"hub/a","name":"A","column":"resting","state":"Resting","blocked_on":"` + blockerUID + `","threads":[]},
 {"id":"hub/b","name":"B","column":"resting","state":"Resting","blocked_on":"the mocks","until":"the mocks","threads":[]}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(tree))
	}))
	t.Cleanup(server.Close)
	env.Set("SHUTTLE_DAEMON_URL", server.URL)

	out, err := runIn(t, env, dir, "threads", "hub")
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	for _, want := range []string{"hub/a  Resting · ⏸ until hub/blocker  A\n", "hub/b  Resting · ⏸ until the mocks  B\n"} {
		if !strings.Contains(out, want) {
			t.Fatalf("threads lacks %q:\n%s", want, out)
		}
	}
}

func runtimeField(t *testing.T, storage *felt.Storage, id, key string) string {
	t.Helper()
	raw, err := os.ReadFile(storage.Path(id))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, key+":") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, key+":"))
		}
	}
	t.Fatalf("%s has no %s", id, key)
	return ""
}
