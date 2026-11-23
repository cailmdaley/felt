package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	if !got.Exists || got.Path != path || got.Host != "hub" || got.ThreadURL+"\n" != thread ||
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
		if raw, _ := os.ReadFile(opened); string(raw) != opener+" "+path+"\n" {
			t.Fatalf("%s opened %q", goos, raw)
		}
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
	}{
		{name: "remote only", reply: `{"fibers":[{"report_path":"/far/work/tapestry.html"}]}`, exists: true, file: true},
		{name: "both", reply: `{"fibers":[{"report_path":"/far/work/tapestry.html"}]}`, copyHere: true, exists: true, file: true, path: true},
		{name: "another companion", reply: `{"fibers":[{"report_path":"/far/work/report.html"}]}`},
		{name: "leftover copy", reply: `{"fibers":[{}]}`, copyHere: true},
		{name: "owner down, copy", reply: `{"error":"forward failed"}`, status: 502, copyHere: true, exists: true, path: true, warn: true},
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
	if out, err := runIn(t, env, dir, "tapestry", "work", "--url"); err == nil || !strings.Contains(err.Error(), "unix socket") {
		t.Fatalf("got %q, %v", out, err)
	}
}
