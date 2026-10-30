package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A tree as the daemon's GET /api/v1/threads/*id serves it.
const threadsTreeJSON = `{"fiber_id":"hub","uid":"01HUB","name":"Hub","felt_store":"/s","threads":[
 {"id":"hub/a","name":"A","column":"awaiting_review","state":"To review","outcome":"Found it. Then more.","threads":[
   {"id":"hub/a/deep","name":"Deep","column":"in_flight","state":"Working","threads":[]}]},
 {"id":"hub/b","name":"B","column":"tempered","state":"Archived","threads":[]},
 {"id":"hub/c","name":"C","column":"in_flight","state":"Waiting","outcome":"Which one?","threads":[]},
 {"id":"hub/e","name":"E","host":"nersc","column":"in_flight","state":"Armed","host_unreachable":true,"threads":[]},
 {"id":"hub/f","name":"F","host":"laptop","column":"in_flight","state":"Armed","host_unreachable":false,"threads":[]},
 {"id":"hub/d","name":"D","column":"drafts","state":"Draft","threads":[
   {"id":"hub/d/x","name":"X","column":"discarded","state":"Archived","threads":[]}]}]}`

func threadsDaemon(t *testing.T, paths *[]string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*paths = append(*paths, r.URL.Path)
		if r.URL.Path != "/api/v1/threads/01HUB" && r.URL.Path != "/api/v1/threads/hub" {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":"not_found"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(threadsTreeJSON))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestThreadsGroupsDirectThreadsByState(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, _ := newStore(t)
	var paths []string
	env.Set("SHUTTLE_DAEMON_URL", threadsDaemon(t, &paths).URL)

	out, err := runIn(t, env, dir, "threads", "hub")
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	want := `hub  Hub

Waiting
  hub/c  Waiting  C: Which one?

To review
  hub/a  To review  A: Found it. (1 thread)

Armed
  hub/e  Armed · host unreachable  E
  hub/f  Armed  F

Draft
  hub/d  Draft  D

(1 archived; --all to show)
`
	if out != want {
		t.Fatalf("got\n%s\nwant\n%s", out, want)
	}

	all, err := runIn(t, env, dir, "threads", "hub", "--all")
	if err != nil {
		t.Fatalf("%v %s", err, all)
	}
	for _, line := range []string{"\n      hub/a/deep  Working  Deep\n", "\nArchived\n  hub/b  Archived  B\n", "\n      hub/d/x  Archived  X\n"} {
		if !strings.Contains(all, line) {
			t.Fatalf("--all lacks %q:\n%s", line, all)
		}
	}
	if strings.Contains(all, "--all to show") {
		t.Fatalf("--all still folds the archived:\n%s", all)
	}
}

func TestThreadsJSONCarriesColumnsAndCounts(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, _ := newStore(t)
	var paths []string
	env.Set("SHUTTLE_DAEMON_URL", threadsDaemon(t, &paths).URL)

	out, err := runIn(t, env, dir, "threads", "hub", "--json")
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	var got struct {
		FiberID  string      `json:"fiber_id"`
		Archived int         `json:"archived"`
		Threads  []threadRow `json:"threads"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, r := range got.Threads {
		ids = append(ids, r.ID+"="+r.Column)
		if len(r.Threads) > 0 {
			t.Fatalf("deeper levels without --all: %+v", r)
		}
	}
	if got.FiberID != "hub" || got.Archived != 1 || strings.Join(ids, ",") != "hub/c=in_flight,hub/a=awaiting_review,hub/e=in_flight,hub/f=in_flight,hub/d=drafts" || got.Threads[1].Unfinished != 1 || !got.Threads[2].HostUnreachable || got.Threads[3].HostUnreachable {
		t.Fatalf("unexpected %s", out)
	}
}

func TestThreadsNamesAConstitutionTheDaemonLacks(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, _ := newStore(t)
	var paths []string
	env.Set("SHUTTLE_DAEMON_URL", threadsDaemon(t, &paths).URL)
	out, err := runIn(t, env, dir, "threads", "elsewhere")
	if err == nil || !strings.Contains(err.Error(), "no constitution elsewhere in this host's daemon cache") {
		t.Fatalf("err %v out %s", err, out)
	}
}

func TestThreadsNamesADaemonWithoutTheEndpoint(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, _ := newStore(t)
	server := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(server.Close)
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	out, err := runIn(t, env, dir, "threads", "hub")
	if err == nil || !strings.Contains(err.Error(), "serves no thread roster") {
		t.Fatalf("err %v out %s", err, out)
	}
}

func TestFirstSentence(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"Found it. Then more.":   "Found it.",
		"Is it? Yes.":            "Is it?",
		"v1.2 shipped. Next.":    "v1.2 shipped.",
		"one line\nsecond":       "one line",
		"":                       "",
		strings.Repeat("a", 130): strings.Repeat("a", 119) + "…",
	} {
		if got := firstSentence(in); got != want {
			t.Errorf("firstSentence(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestThreadsCountWhatWaitsForANextWorker(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, _ := newStore(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"fiber_id":"hub","uid":"01HUB","name":"Hub","pending_results":3,"threads":[
 {"id":"hub/m","name":"M","column":"drafts","state":"Draft","pending_results":2,"threads":[
   {"id":"hub/m/x","name":"X","column":"drafts","state":"Draft","threads":[]}]},
 {"id":"hub/n","name":"N","column":"drafts","state":"Draft","pending_results":0,"threads":[]}]}`))
	}))
	t.Cleanup(server.Close)
	env.Set("SHUTTLE_DAEMON_URL", server.URL)

	out, err := runIn(t, env, dir, "threads", "hub")
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	want := `hub  Hub  (3 waiting for its next worker)

Draft
  hub/m  Draft  M (1 thread; 2 waiting for its next worker)
  hub/n  Draft  N
`
	if out != want {
		t.Fatalf("got\n%s\nwant\n%s", out, want)
	}

	out, err = runIn(t, env, dir, "threads", "hub", "--json")
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	var got struct {
		PendingResults int         `json:"pending_results"`
		Threads        []threadRow `json:"threads"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if got.PendingResults != 3 || got.Threads[0].PendingResults != 2 || got.Threads[1].PendingResults != 0 {
		t.Fatalf("unexpected %s", out)
	}
}

func TestThreadsCarriesOwnerDispatchError(t *testing.T) {
	t.Parallel()
	var node ThreadNode
	if err := json.Unmarshal([]byte(`{"id":"hub/failure","state":"Blocked","dispatch_error":"systemError: native_thread_unverified","threads":[]}`), &node); err != nil {
		t.Fatal(err)
	}
	row := toThreadRow(node, false)
	if got := row.stateLabel(); got != "Blocked · systemError: native_thread_unverified" {
		t.Fatal(got)
	}
	encoded, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"dispatch_error":"systemError: native_thread_unverified"`) {
		t.Fatal(string(encoded))
	}
}
