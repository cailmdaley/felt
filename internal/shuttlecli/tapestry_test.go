package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func writeTapestry(t *testing.T, storage *felt.Storage, id string) string {
	t.Helper()
	path := filepath.Join(filepath.Dir(storage.Path(id)), "tapestry.html")
	if err := os.WriteFile(path, []byte("<p>hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestTapestryOfAFiberHere(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	ownHost(t, env, "hub")
	dir, storage := newStore(t)
	seedFiber(t, storage, "work", clearTestUID, "", nil, nil)

	// No daemon: no URL is printed for a page nobody would answer.
	if out, err := runIn(t, env, dir, "tapestry", "work", "--url"); err == nil {
		t.Fatalf("printed a URL with no daemon: %s", out)
	}
	server := serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{}`) }))
	thread := server.URL + "/thread?f=" + clearTestUID + "@hub\n"
	if out, err := runIn(t, env, dir, "tapestry", "work", "--url"); err != nil || out != thread {
		t.Fatalf("without a tapestry: %q %v, want the thread page", out, err)
	}
	for _, flag := range []string{"--path", "--open"} {
		if out, err := runIn(t, env, dir, "tapestry", "work", flag); err == nil || !strings.Contains(err.Error(), "no tapestry.html") {
			t.Fatalf("%s without a tapestry: %q %v", flag, out, err)
		}
	}

	path := writeTapestry(t, storage, "work")
	if out, err := runIn(t, env, dir, "tapestry", "work", "--path"); err != nil || out != path+"\n" {
		t.Fatalf("--path = %q %v", out, err)
	}
	out, err := runIn(t, env, dir, "tapestry", "work", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var got tapestry
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	link, _ := url.Parse(got.FileURL)
	if !got.Exists || got.Path != path || got.Host != "hub" || got.Source != "local" || got.ThreadURL+"\n" != thread ||
		link.Query().Get("path") != path || link.Query().Get("origin") != "hub" {
		t.Fatalf("tapestry = %+v", got)
	}

	opened := filepath.Join(t.TempDir(), "opened")
	env.Set("OPENED", opened)
	for goos, opener := range map[string]string{"darwin": "open", "linux": "xdg-open"} {
		sysenvtest.FakeCommand(t, env, opener, `echo "${0##*/} $1" > "$OPENED"`)
		a := newApp(env)
		a.hostGOOS = goos
		if _, _, err := executeApp(t, a, dir, "tapestry", "work", "--open"); err != nil {
			t.Fatal(err)
		}
		awaitFile(t, opened, opener+" "+path+"\n")
	}
}

func awaitFile(t *testing.T, path, want string) {
	t.Helper()
	var raw []byte
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if raw, _ = os.ReadFile(path); string(raw) == want {
			return
		}
	}
	t.Fatalf("%s holds %q, want %q", path, raw, want)
}

// xdg-open stays in the foreground while the browser it started runs.
func TestTapestryOpenDoesNotWaitForTheBrowser(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work", clearTestUID, "", nil, nil)
	writeTapestry(t, storage, "work")
	state := t.TempDir()
	hold, closed := filepath.Join(state, "hold"), filepath.Join(state, "closed")
	if err := os.WriteFile(hold, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	env.Set("HOLD", hold)
	env.Set("CLOSED", closed)
	sysenvtest.FakeCommand(t, env, "xdg-open", `i=0; while [ -e "$HOLD" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; echo done > "$CLOSED"`)
	a := newApp(env)
	a.hostGOOS = "linux"
	if _, _, err := executeApp(t, a, dir, "tapestry", "work", "--open"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(closed); err == nil {
		t.Error("--open waited for the browser to close")
	}
	os.Remove(hold)
	awaitFile(t, closed, "done\n")
}

func TestTapestryOpenReportsAFailedOpener(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work", clearTestUID, "", nil, nil)
	path := writeTapestry(t, storage, "work")
	for script, want := range map[string]string{
		"exit 3":              "open " + path + ": exit status 3",
		"echo no app; exit 3": "open " + path + ": exit status 3: no app",
	} {
		sysenvtest.FakeCommand(t, env, "open", script)
		a := newApp(env)
		a.hostGOOS = "darwin"
		if _, _, err := executeApp(t, a, dir, "tapestry", "work", "--open"); err == nil || err.Error() != want {
			t.Fatalf("err = %q, want %q", err, want)
		}
	}
}

// A file on this host's disk needs no daemon, and a daemon that answers its
// version with an error serves no pages.
func TestTapestryAsksTheDaemonOnlyForURLs(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work", clearTestUID, "", nil, nil)
	writeTapestry(t, storage, "work")
	var asked atomic.Int32
	serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		http.Error(w, "broken", http.StatusInternalServerError)
	}))
	sysenvtest.FakeCommand(t, env, "xdg-open", "exit 0")
	for _, flag := range []string{"--path", "--open"} {
		a := newApp(env)
		a.hostGOOS = "linux"
		if _, _, err := executeApp(t, a, dir, "tapestry", "work", flag); err != nil {
			t.Fatal(err)
		}
	}
	if n := asked.Load(); n != 0 {
		t.Fatalf("a local file cost %d daemon requests", n)
	}
	if out, err := runIn(t, env, dir, "tapestry", "work", "--url"); err == nil {
		t.Fatalf("a failing daemon got a URL: %s", out)
	}
	if asked.Load() != 1 {
		t.Fatal("--url did not ask the daemon")
	}
}

// A fiber known only through its owner has a path on the owner's disk; a file
// at that path here belongs to something else.
func TestTapestryNeverReadsAnOwnersPathHere(t *testing.T) {
	t.Parallel()
	for _, flag := range []string{"--json", "--path"} {
		t.Run(flag, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, _ := newStore(t)
			_, storage := newStore(t)
			seedFiber(t, storage, "work", clearTestUID, "open", remoteShuttleBlock("/remote"), nil)
			here := writeTapestry(t, storage, "work")
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				row := fmt.Sprintf(`{"fibers":[{"path":"work/work.md","origin":"worker","report_path":%q,"fiber":{"id":%q,"uid":%q,"slug":"work","name":"Work","status":"open","path":%q,"shuttle":{"kind":"oneshot","host":"worker","project_dir":"/remote"}}}]}`,
					here, clearTestUID, clearTestUID, storage.Path("work"))
				fmt.Fprint(w, row)
			}))
			out, err := runIn(t, env, dir, "tapestry", clearTestUID, flag)
			if flag == "--path" {
				if err == nil || !strings.Contains(err.Error(), "no copy here") {
					t.Fatalf("--path = %q, %v", out, err)
				}
				return
			}
			var got tapestry
			if err != nil || json.Unmarshal([]byte(out), &got) != nil {
				t.Fatalf("%v: %s", err, out)
			}
			if got.Path != "" || !got.Exists || got.FileURL == "" || got.Source != "owner" {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

// The owner's answer decides, whatever Git copy is here; the copy speaks, with
// a warning, only when the owner does not.
func TestTapestryOfAnotherHostsFiber(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, reply      string
		status           int
		copyHere         bool
		exists, fails    bool
		path, file, warn bool
		source           string
	}{
		{name: "remote only", reply: `{"fibers":[{"report_path":"/far/work/tapestry.html"}]}`, exists: true, file: true},
		{name: "both", reply: `{"fibers":[{"report_path":"/far/work/tapestry.html"}]}`, copyHere: true, exists: true, file: true, path: true},
		{name: "another companion", reply: `{"fibers":[{"report_path":"/far/work/report.html"}]}`},
		{name: "leftover copy", reply: `{"fibers":[{}]}`, copyHere: true},
		{name: "owner down, copy", reply: `{"error":"forward failed"}`, status: 502, copyHere: true, exists: true, path: true, warn: true, source: "local_fallback"},
		{name: "owner refuses, copy", reply: `{"error":"not found"}`, status: 404, copyHere: true, fails: true},
		{name: "owner down, no copy", reply: `{"error":"forward failed"}`, status: 502, fails: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env := remoteLifecycleEnv(t)
			dir, storage := newStore(t)
			seedFiber(t, storage, "work", clearTestUID, "open", remoteShuttleBlock("/remote"), nil)
			if tc.copyHere {
				writeTapestry(t, storage, "work")
			}
			serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/fibers/"+clearTestUID || r.URL.Query().Get("origin") != "worker" {
					t.Errorf("unexpected request %s", r.URL)
				}
				if tc.status != 0 {
					w.WriteHeader(tc.status)
				}
				fmt.Fprint(w, tc.reply)
			}))
			out, stderr, err := executeIn(t, env, dir, "tapestry", "work", "--json")
			if tc.fails {
				if err == nil {
					t.Fatalf("claimed %s", out)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var got tapestry
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if got.Exists != tc.exists || (got.Path != "") != tc.path || (got.FileURL != "") != tc.file ||
				got.ThreadURL == "" || strings.Contains(stderr, "may be stale") != tc.warn {
				t.Fatalf("got %+v, stderr %q", got, stderr)
			}
			if tc.source == "" {
				tc.source = "owner"
			}
			if got.Source != tc.source {
				t.Fatalf("source = %q, want %q", got.Source, tc.source)
			}
			if tc.file {
				if link, _ := url.Parse(got.FileURL); link.Query().Get("path") != "/far/work/tapestry.html" || link.Query().Get("origin") != "worker" {
					t.Fatalf("file_url = %s", got.FileURL)
				}
			}
		})
	}
}

func TestTapestryGivesNoURLForASocketDaemon(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work", clearTestUID, "", nil, nil)
	env.Set("SHUTTLE_DAEMON_URL", "")
	env.Set("SHUTTLE_LISTEN", "unix:///nonexistent/daemon.sock")
	for _, base := range []string{"", "http://shuttle.invalid/"} {
		env.Set("SHUTTLE_DAEMON_URL", base)
		if out, err := runIn(t, env, dir, "tapestry", "work", "--url"); err == nil || !strings.Contains(err.Error(), "unix socket") {
			t.Fatalf("%q: got %q, %v", base, out, err)
		}
	}
}
