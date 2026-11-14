package shuttlecli

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// The incident: a fiber edited by hand into a constitution for another host,
// whose owner's copy has no shuttle: block until Git catches up. A remote
// resume or dispatch carries this host's document so the owner can adopt it.

const ownerAdoptLine = "worker took the caller's version of task (was: no shuttle: block; differs: shuttle)"

func seedHandEditedConstitution(t *testing.T, st *felt.Storage, status string) *felt.Felt {
	t.Helper()
	seedFiber(t, st, "task", "", status, nil, nil)
	f := mustRead(t, st, "task")
	f.Body = "Hand-written desired state."
	if err := f.SetExtraField("shuttle", remoteShuttleBlock(t.TempDir())); err != nil {
		t.Fatal(err)
	}
	if err := st.Write(f); err != nil {
		t.Fatal(err)
	}
	return mustRead(t, st, "task")
}

func fileText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestRemoteResumeCarriesHandEditedConstitution(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		status string
		carry  bool
	}{
		{name: "no status"},
		{name: "draft", status: felt.StatusOpen},
		{name: "carry", status: felt.StatusOpen, carry: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			f := seedHandEditedConstitution(t, st, tc.status)
			document := fileText(t, f.Path)
			var lifecycle requestBodies
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/lifecycle":
					lifecycle.record(t, r)
					fmt.Fprintf(w, "%s\nresumed task (status: active)\n", ownerAdoptLine)
				case "/api/v1/state/composite":
					fmt.Fprint(w, `{"remotes":{}}`)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
				}
			}))
			args := []string{"resume", "task"}
			if tc.carry {
				args = append(args, "--carry")
			}
			out, _, err := executeIn(t, env, dir, args...)
			if err != nil {
				t.Fatal(err)
			}
			got := lifecycle.last()
			if got["action"] != "resume" || got["fiber"] != f.UID || got["document"] != document {
				t.Fatalf("lifecycle payload = %#v; want the file's content as document", got)
			}
			if carry, set := got["carry"]; set != tc.carry || (tc.carry && carry != true) {
				t.Fatalf("carry = %#v (set %v), want %v", carry, set, tc.carry)
			}
			if !strings.HasPrefix(out, ownerAdoptLine+"\n") {
				t.Fatalf("output = %q; want the owner's adopt line first", out)
			}
			if fileText(t, f.Path) != document {
				t.Fatal("remote resume wrote the local mirror")
			}
		})
	}
}

func TestRemoteDispatchCarriesHandEditedConstitution(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"", felt.StatusOpen} {
		t.Run("status "+status, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, st := newStore(t)
			f := seedHandEditedConstitution(t, st, status)
			document := fileText(t, f.Path)
			var dispatch requestBodies
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/dispatch" {
					t.Errorf("unexpected request %s", r.URL.Path)
				}
				dispatch.record(t, r)
				fmt.Fprintf(w, `{"dispatched":true,"carried":%q}`, ownerAdoptLine)
			}))
			out, _, err := executeIn(t, env, dir, "dispatch", "task", "--carry")
			if err != nil {
				t.Fatal(err)
			}
			got := dispatch.last()
			if got["fiber_id"] != f.UID || got["origin"] != "worker" || got["document"] != document || got["carry"] != true || got["fiber_path"] != "task" {
				t.Fatalf("dispatch payload = %#v", got)
			}
			if !strings.HasPrefix(out, ownerAdoptLine+"\n{") {
				t.Fatalf("output = %q; want the owner's adopt line before the body", out)
			}
		})
	}
}

// createdOnWorker answers a fiber/create as an owner that wrote what it got.
func createdOnWorker(t *testing.T, w http.ResponseWriter, creates *requestBodies, r *http.Request) {
	creates.record(t, r)
	payload := creates.last()
	frontmatter, _ := payload["frontmatter"].(map[string]any)
	fmt.Fprintf(w, `{"id":%q,"uid":%q,"path":"/remote/loom/.felt/task/task.md","host":"worker","status":%q}`, payload["id"], payload["uid"], frontmatter["status"])
}

func TestRemoteResumeCreatesMissingConstitutionAndKeepsLocalCopy(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	f := seedHandEditedConstitution(t, st, "")
	var creates requestBodies
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/lifecycle":
			workerFiberMissing(w)
		case "/api/v1/fiber/create":
			createdOnWorker(t, w, &creates, r)
		case "/api/v1/state/composite":
			fmt.Fprint(w, `{"remotes":{}}`)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	}))
	out, _, err := executeIn(t, env, dir, "resume", "task")
	if err != nil {
		t.Fatal(err)
	}
	got := creates.last()
	frontmatter, _ := got["frontmatter"].(map[string]any)
	if got["uid"] != f.UID || got["body"] != f.Body || frontmatter["status"] != felt.StatusActive {
		t.Fatalf("create payload = %#v", got)
	}
	if !strings.Contains(out, "created task on worker from this host's copy and armed it") {
		t.Fatalf("output = %q", out)
	}
	if _, err := os.Stat(f.Path); err != nil {
		t.Fatalf("local copy removed: %v", err)
	}
}

func TestRemoteResumeOfClosedFiberMissingOnOwnerPointsAtReopen(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	seedHandEditedConstitution(t, st, felt.StatusClosed)
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/lifecycle" {
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		workerFiberMissing(w)
	}))
	_, _, err := executeIn(t, env, dir, "resume", "task")
	if err == nil || !strings.Contains(err.Error(), "shuttle reopen task") {
		t.Fatalf("resume error = %v; want a pointer at shuttle reopen", err)
	}
}

func TestRemoteDispatchCreatesMissingConstitutionThenDispatches(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, st := newStore(t)
	f := seedHandEditedConstitution(t, st, "")
	var dispatches, creates requestBodies
	var order []string
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, r.URL.Path)
		switch r.URL.Path {
		case "/api/v1/dispatch":
			dispatches.record(t, r)
			if len(dispatches.all()) == 1 {
				workerFiberMissing(w)
				return
			}
			fmt.Fprint(w, `{"dispatched":true}`)
		case "/api/v1/fiber/create":
			createdOnWorker(t, w, &creates, r)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	}))
	out, _, err := executeIn(t, env, dir, "dispatch", "task", "--ad-hoc")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(order, " ") != "/api/v1/dispatch /api/v1/fiber/create /api/v1/dispatch" {
		t.Fatalf("requests = %v", order)
	}
	created := creates.last()
	frontmatter, _ := created["frontmatter"].(map[string]any)
	if created["uid"] != f.UID || frontmatter["status"] != felt.StatusOpen {
		t.Fatalf("create payload = %#v", created)
	}
	retry := dispatches.last()
	if retry["fiber_id"] != f.UID || retry["ad_hoc"] != true || retry["document"] != nil {
		t.Fatalf("second dispatch = %#v", retry)
	}
	if !strings.Contains(out, "created task on worker from this host's copy\n") || !strings.Contains(out, `{"dispatched":true}`) {
		t.Fatalf("output = %q", out)
	}
	if _, err := os.Stat(f.Path); err != nil {
		t.Fatalf("local copy removed: %v", err)
	}
}

// The owner's side of the incident, without a daemon in between: the owner's
// Git-stale copy has no block; adopting the caller's hand-edited document and
// resuming arms the caller's constitution there.
func TestOwnerAdoptsStaleCopyThenResumes(t *testing.T) {
	t.Parallel()
	callerEnv := testEnv(t)
	ownHost(t, callerEnv, "hub")
	_, callerStore := newStore(t)
	ownerEnv := testEnv(t)
	ownHost(t, ownerEnv, "worker")
	ownerDir, ownerStore := newStore(t)

	seedFiber(t, callerStore, "task", "", felt.StatusOpen, nil, nil)
	stale := mustRead(t, callerStore, "task")
	stale.Body = "The body both hosts had."
	if err := callerStore.Write(stale); err != nil {
		t.Fatal(err)
	}
	stale = mustRead(t, callerStore, "task")
	if err := ownerStore.Write(stale); err != nil {
		t.Fatal(err)
	}
	edited := mustRead(t, callerStore, "task")
	edited.Body = "The caller's hand-edited desired state."
	if err := edited.SetExtraField("shuttle", remoteShuttleBlock(t.TempDir())); err != nil {
		t.Fatal(err)
	}
	if err := callerStore.Write(edited); err != nil {
		t.Fatal(err)
	}
	edited = mustRead(t, callerStore, "task")

	out, _, err := executeIn(t, ownerEnv, ownerDir, "adopt", "task", "--document-file", edited.Path)
	if err != nil {
		t.Fatal(err)
	}
	if out != "worker took the caller's version of task (was: no shuttle: block; differs: body, shuttle)\n" {
		t.Fatalf("adopt output = %q", out)
	}
	if _, _, err := executeIn(t, ownerEnv, ownerDir, "resume", "task", "--local"); err != nil {
		t.Fatal(err)
	}
	got := mustRead(t, ownerStore, "task")
	block, ok, err := shuttle.BlockOf(got)
	if err != nil || !ok {
		t.Fatalf("owner's copy has no block: %v", err)
	}
	want, _, _ := shuttle.BlockOf(edited)
	if got.Status != felt.StatusActive || got.UID != edited.UID || got.Body != edited.Body || block.Host != "worker" || block.ProjectDir != want.ProjectDir {
		t.Fatalf("owner's copy = status %q uid %q body %q block %#v", got.Status, got.UID, got.Body, block)
	}
}
