package shuttlecli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func indexedTranscriptEnv(t *testing.T) *sysenv.Env {
	t.Helper()
	env := testEnv(t)
	root := t.TempDir()
	env.Set("SHUTTLE_TRANSCRIPT_INDEX", filepath.Join(root, "index.sqlite"))
	for _, h := range []struct{ name, key string }{{"claude", "SHUTTLE_CLAUDE_PROJECTS_DIR"}, {"codex", "SHUTTLE_CODEX_SESSIONS_DIR"}, {"pi", "SHUTTLE_PI_SESSIONS_DIR"}} {
		dir := filepath.Join(root, h.name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		body, err := os.ReadFile(filepath.Join("..", "transcriptindex", "testdata", h.name+".jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		name := "session.jsonl"
		if h.name == "codex" {
			name = "rollout-session.jsonl"
		}
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
		env.Set(h.key, dir)
	}
	if out, _, err := executeIn(t, env, t.TempDir(), "transcript", "index", "--json"); err != nil {
		t.Fatalf("index: %v %s", err, out)
	}
	return env
}
func exactJSONKeys(t *testing.T, obj map[string]json.RawMessage, want ...string) {
	t.Helper()
	got := make([]string, 0, len(obj))
	for key := range obj {
		got = append(got, key)
	}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("JSON keys=%v want=%v", got, want)
	}
}
func TestTranscriptSearchJSONContractAndFiberThreadAliases(t *testing.T) {
	env := indexedTranscriptEnv(t)
	daemonStub(t, env, map[string]http.HandlerFunc{sessionsCompositePath: jsonBody(`{"records":[
 {"fiber":"work/old","uid":"01UID","session":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","thread_id":"22222222-2222-4222-8222-222222222222","harness":"codex","host":"node"},
 {"fiber":"work/new","uid":"01UID","session":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","thread_id":"22222222-2222-4222-8222-222222222222","harness":"codex","host":"node"}
 ]}`)})
	out, _, err := executeIn(t, env, t.TempDir(), "transcript", "search", "VMPZ", "convention", "--fiber", "work/new", "--session", "22222222-2222-4222-8222-222222222222", "--json")
	if err != nil {
		t.Fatalf("search: %v %s", err, out)
	}
	var result map[string]json.RawMessage
	if err = json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	exactJSONKeys(t, result, "query", "index", "hits", "errors")
	if string(result["query"]) != `"VMPZ convention"` || string(result["errors"]) != "[]" {
		t.Fatal(out)
	}
	var stats map[string]json.RawMessage
	_ = json.Unmarshal(result["index"], &stats)
	exactJSONKeys(t, stats, "path", "sessions", "messages", "updated_at")
	var hits []map[string]json.RawMessage
	if err = json.Unmarshal(result["hits"], &hits); err != nil || len(hits) != 1 {
		t.Fatalf("fiber alias filter: %v %s", err, out)
	}
	exactJSONKeys(t, hits[0], "session", "harness", "project", "path", "line", "timestamp", "role", "score", "snippet", "matches", "fibers")
	if string(hits[0]["session"]) != `"22222222-2222-4222-8222-222222222222"` || !strings.Contains(string(hits[0]["snippet"]), "«VMPZ»") {
		t.Fatal(out)
	}
	var refs []map[string]json.RawMessage
	_ = json.Unmarshal(hits[0]["fibers"], &refs)
	if len(refs) != 2 {
		t.Fatalf("lost historical fibers %s", out)
	}
	for _, ref := range refs {
		exactJSONKeys(t, ref, "id", "name")
	}
	// An incompatible explicit session intersects the fiber restriction.
	out, _, err = executeIn(t, env, t.TempDir(), "transcript", "search", "VMPZ", "--fiber", "work/new", "--session", "11111111-1111-4111-8111-111111111111", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var empty transcriptSearchResult
	if err = json.Unmarshal([]byte(out), &empty); err != nil || empty.Hits == nil || len(empty.Hits) != 0 {
		t.Fatalf("restrictions not intersected: %v %s", err, out)
	}
}
func TestTranscriptSearchCLIFiltersAndOfflineFiberFailClosed(t *testing.T) {
	env := indexedTranscriptEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	for _, tc := range []struct {
		args []string
		want int
	}{
		{[]string{"--harness", "pi"}, 1},
		{[]string{"--since", "2026-10-03"}, 1},
		{[]string{"--project", "/work/sky"}, 2},
		{[]string{"--session", "11111111-1111-4111-8111-111111111111", "--session", "33333333-3333-4333-8333-333333333333"}, 2},
		{[]string{"--limit", "1"}, 1},
		{[]string{"--fiber", "work/unavailable"}, 0},
	} {
		args := append([]string{"transcript", "search", "VMPZ convention", "--no-index", "--json"}, tc.args...)
		out, _, err := executeIn(t, env, t.TempDir(), args...)
		if err != nil {
			t.Fatalf("%v: %v %s", tc.args, err, out)
		}
		var got transcriptSearchResult
		if err = json.Unmarshal([]byte(out), &got); err != nil || len(got.Hits) != tc.want || len(got.Errors) == 0 {
			t.Fatalf("%v: %v %s", tc.args, err, out)
		}
	}
}
func TestTranscriptSearchPerMessageFlag(t *testing.T) {
	env := indexedTranscriptEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	for _, perMessage := range []bool{false, true} {
		args := []string{"transcript", "search", "src/sky_map.go", "--no-index", "--json"}
		want := 3
		if perMessage {
			args = append(args, "--per-message")
			want = 5
		}
		out, _, err := executeIn(t, env, t.TempDir(), args...)
		if err != nil {
			t.Fatal(err)
		}
		var got transcriptSearchResult
		if err := json.Unmarshal([]byte(out), &got); err != nil || len(got.Hits) != want {
			t.Fatalf("per-message=%v: %v %s", perMessage, err, out)
		}
		for _, hit := range got.Hits {
			if hit.Matches < 1 || (perMessage && hit.Matches != 1) {
				t.Fatal(hit)
			}
		}
	}
}

func TestTranscriptSearchNonTTYOutputCarriesNativeLocation(t *testing.T) {
	env := indexedTranscriptEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	out, _, err := executeIn(t, env, t.TempDir(), "transcript", "search", "VMPZ convention", "--no-index", "--harness", "pi")
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{"«VMPZ»", "«convention»", "fleet", "33333333", "(1 matches)", "session.jsonl:3", "shuttle transcript 33333333-3333-4333-8333-333333333333"} {
		if !strings.Contains(out, part) {
			t.Errorf("missing %q: %s", part, out)
		}
	}
	if strings.Contains(out, "\x1b[") {
		t.Fatal("non-TTY output contains ANSI highlighting")
	}
}
func TestTranscriptSinceDaysAndInvalidFlagBeforeIndexAccess(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	got, err := parseTranscriptSince("30d", now)
	if err != nil || got != "2026-09-24T12:00:00Z" {
		t.Fatalf("30d=%q: %v", got, err)
	}
	env := testEnv(t)
	path := filepath.Join(t.TempDir(), "not-created.sqlite")
	env.Set("SHUTTLE_TRANSCRIPT_INDEX", path)
	for _, flags := range [][]string{{"--since", "garbage"}, {"--limit", "0"}, {"--harness", "unknown"}} {
		args := append([]string{"transcript", "search", "needle"}, flags...)
		_, _, err := executeIn(t, env, t.TempDir(), args...)
		if err == nil || strings.Contains(err.Error(), "index first") {
			t.Fatalf("invalid %v: %v", flags, err)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Fatalf("invalid %v created index: %v", flags, statErr)
		}
	}
}
