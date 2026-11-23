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

// A Claude subagent's SendUserFile is recorded as file_sent with its paths in
// the tool input, the line the hook itself renders.
func TestSentFilesLsFallbackReadsASubagentsSend(t *testing.T) {
	t.Parallel()
	env, sink, _ := sendFileTestEnv(t)
	dir, storage := newStore(t)
	seedFiber(t, storage, "work/reports", clearTestUID, "", nil, nil)
	line, ok := newApp(env).renderEvent(eventHookInput{
		Harness: "claude", HookEventName: "PreToolUse", SessionID: clearTestUID, AgentID: "child", CWD: "/cwd",
		ToolName: "SendUserFile", ToolInput: json.RawMessage(`{"files":["report.html"],"caption":"From the child."}`),
	})
	if !ok || !strings.Contains(line, `"type":"file_sent"`) {
		t.Fatalf("hook line = %s", line)
	}
	// Top-level names win on a file_sent event, and its caption outranks the tool's.
	lines := line + `{"type":"file_sent","timestamp":1,"sessionId":"` + clearTestUID + `","files":["/x/top.html"],"caption":"top","toolInput":{"files":["/x/not.html"],"caption":"tool"}}
{"type":"file_sent","timestamp":2,"sessionId":"` + clearTestUID + `","files":["/x/tool-words.html"],"toolInput":{"caption":"tool"}}
{"type":"pre_tool_use","tool":"Write","timestamp":3,"sessionId":"` + clearTestUID + `","toolInput":{"files":["/x/not-sent.html"]}}
`
	if err := os.WriteFile(sink, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := runIn(t, env, dir, "sent-files", "ls", "work/reports", "--json")
	if err != nil {
		t.Fatal(err)
	}
	rows := []string{}
	for _, f := range listSentFiles(t, out).Files {
		rows = append(rows, f.FullPath+" "+f.Caption)
	}
	if want := []string{"/cwd/report.html From the child.", "/x/tool-words.html tool", "/x/top.html top"}; !reflect.DeepEqual(rows, want) {
		t.Fatalf("files = %q, want %q", rows, want)
	}
}

func TestSentFilesLsFallbackClearCutoffs(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, clear string
		sent        int
		shown       bool
	}{
		{"no clear, time zero", "", 0, true},
		{"path null is no clear", `,"path":null`, 100, true},
		{"path not a string is no clear", `,"path":3`, 100, true},
		{"relative path is no clear", `,"path":"a.html"`, 100, true},
		{"omitted path clears the fiber", " ", 100, false},
		{"the path clears itself", `,"path":"/x/a.html"`, 100, false},
		{"another path clears only itself", `,"path":"/x/b.html"`, 100, true},
		{"a later send shows", " ", 201, true},
		{"a send at the cutoff is hidden", " ", 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			env, sink, _ := sendFileTestEnv(t)
			dir, storage := newStore(t)
			seedFiber(t, storage, "work/reports", clearTestUID, "", nil, nil)
			lines := fmt.Sprintf(`{"type":"file_sent","timestamp":%d,"sessionId":%q,"files":["/x/a.html"]}`+"\n", tc.sent, clearTestUID)
			if tc.clear != "" {
				lines += fmt.Sprintf(`{"type":"sent_files_cleared","timestamp":200,"uid":%q%s}`+"\n", clearTestUID, tc.clear)
			}
			if err := os.WriteFile(sink, []byte(lines), 0o600); err != nil {
				t.Fatal(err)
			}
			out, err := runIn(t, env, dir, "sent-files", "ls", "work/reports", "--json")
			if err != nil {
				t.Fatal(err)
			}
			if got := len(listSentFiles(t, out).Files) == 1; got != tc.shown {
				t.Fatalf("shown = %v, want %v", got, tc.shown)
			}
		})
	}
}

// With no state directory to resolve, there is no trail to call empty.
func TestSentFilesFromStreamNeedsAStateDirectory(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	for _, key := range []string{"HOME", "SHUTTLE_DATA_DIR", "SHUTTLE_EVENTS_FILE"} {
		env.Set(key, "")
	}
	if files, err := newApp(env).sentFilesFromStream(clearTestUID); err == nil {
		t.Fatalf("claimed %v", files)
	}
}
