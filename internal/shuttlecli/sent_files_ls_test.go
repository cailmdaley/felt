package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
)

type sentFilesListing struct {
	Fiber, UID, Host, Source string
	Files                    []sentFile
}

func listSentFiles(t *testing.T, out string) sentFilesListing {
	t.Helper()
	var got sentFilesListing
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	return got
}

func TestSentFilesLsReadsTheOwnerThroughTheDaemon(t *testing.T) {
	t.Parallel()
	env := remoteLifecycleEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work/reports", clearTestUID, "open", remoteShuttleBlock("/remote"), nil)
	server := serveDaemon(t, env, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/sent-files" || r.URL.Query().Get("uid") != clearTestUID || r.URL.Query().Get("origin") != "worker" {
			http.Error(w, r.URL.String(), http.StatusBadRequest)
			return
		}
		fmt.Fprint(w, `{"files":[{"fullPath":"/far/a & b.html","basename":"a & b.html","timestamp":1786203000000,"sessionId":"s","caption":"The deck."}]}`)
	}))
	out, err := runIn(t, env, dir, "sent-files", "ls", "work/reports", "--json")
	if err != nil {
		t.Fatal(err)
	}
	got := listSentFiles(t, out)
	if got.UID != clearTestUID || got.Host != "worker" || got.Source != "daemon" || len(got.Files) != 1 {
		t.Fatalf("listing = %+v", got)
	}
	link, err := url.Parse(got.Files[0].URL)
	if err != nil || !strings.HasPrefix(got.Files[0].URL, server.URL+"/api/v1/file?") ||
		link.Query().Get("path") != "/far/a & b.html" || link.Query().Get("origin") != "worker" {
		t.Fatalf("url = %q (%v)", got.Files[0].URL, err)
	}
	out, err = runIn(t, env, dir, "sent-files", "ls", "work/reports")
	if err != nil || !strings.Contains(out, "/far/a & b.html\n    The deck.\n    "+server.URL) {
		t.Fatalf("text: %v\n%s", err, out)
	}
}

// With the daemon down, the stream answers for a fiber this host owns by the
// rules Shuttle.SentFiles applies; another host's fiber is an error.
func TestSentFilesLsFallsBackToTheStream(t *testing.T) {
	t.Parallel()
	env, sink, _ := sendFileTestEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work/reports", clearTestUID, "", nil, nil)
	block := oneshot()
	block["host"] = "elsewhere"
	seedFiber(t, storage, "work/remote", "", "open", block, nil)
	write := func(path string, lines ...string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	worker := `"tmuxSession":"reports-` + clearTestUID + `-shuttle"`
	write(env.Getenv("SHUTTLE_SESSIONS_FILE"), `{"session":"claimed","uid":"`+clearTestUID+`","at":1}`+"\n")
	write(sink+".1",
		`{"type":"file_sent","timestamp":100,`+worker+`,"files":["/x/rotated.html","/x/again.html","/x/cleared.html"]}`, "")
	write(sink,
		`{"type":"file_sent","timestamp":200,`+worker+`,"files":["/x/again.html"],"caption":"newer"}`,
		`{"type":"tool_use","tool":"SendUserFile","timestamp":300,"sessionId":"claimed","cwd":"/cwd","toolInput":{"files":["rel.png"],"caption":"tool"}}`,
		`{"type":"file_sent","timestamp":250,"sessionId":"`+clearTestUID+`","files":["/x/by-uid.html"]}`,
		`{"type":"file_sent","timestamp":400,"sessionId":"someone-else","files":["/x/not-ours.html"]}`,
		`{"type":"sent_files_cleared","timestamp":150,"uid":"`+clearTestUID+`","path":"/x/cleared.html"}`,
		`not json`,
		`{"type":"file_sent","timesta`)
	read := func() []string {
		t.Helper()
		out, err := runIn(t, env, dir, "sent-files", "ls", "work/reports", "--json")
		if err != nil {
			t.Fatal(err)
		}
		got := listSentFiles(t, out)
		if got.Source != "events" {
			t.Fatalf("source = %q", got.Source)
		}
		rows := []string{}
		for _, f := range got.Files {
			rows = append(rows, strings.TrimSpace(f.FullPath+" "+f.Caption))
		}
		return rows
	}
	if got, want := read(), []string{"/cwd/rel.png tool", "/x/by-uid.html", "/x/again.html newer", "/x/rotated.html"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("files = %q, want %q", got, want)
	}
	write(sink, `{"type":"sent_files_cleared","timestamp":150,"uid":"`+clearTestUID+`"}`)
	if got := read(); len(got) != 0 {
		t.Fatalf("a whole-fiber clear left %q", got)
	}
	if out, err := runIn(t, env, dir, "sent-files", "ls", "work/remote"); err == nil {
		t.Fatalf("answered for another host's fiber: %s", out)
	}
}
