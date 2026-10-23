package transcriptindex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

var ctx = context.Background()

func testIndex(t *testing.T) *Index {
	t.Helper()
	i, e := Open(filepath.Join(t.TempDir(), "index.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { i.Close() })
	return i
}
func fixture(t *testing.T, h string) string {
	t.Helper()
	b, e := os.ReadFile(filepath.Join("testdata", h+".jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(t.TempDir(), h+".jsonl")
	if e = os.WriteFile(p, b, 0o600); e != nil {
		t.Fatal(e)
	}
	return p
}
func search(t *testing.T, i *Index, q string, o Options) []Hit {
	t.Helper()
	h, e := i.Search(ctx, q, o)
	if e != nil {
		t.Fatal(e)
	}
	return h
}
func appendFile(t *testing.T, p, s string) {
	t.Helper()
	f, e := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if _, e = f.WriteString(s); e != nil {
		t.Fatal(e)
	}
}
func userLine(text string) string {
	b, _ := json.Marshal(map[string]any{"type": "user", "sessionId": "11111111-1111-4111-8111-111111111111", "cwd": "/work/sky", "timestamp": "2026-10-04T12:00:00Z", "message": map[string]any{"role": "user", "content": text}})
	return string(b) + "\n"
}

func TestNativeFixturesRolesAndSkippedPayloads(t *testing.T) {
	for _, h := range []string{"claude", "codex", "pi"} {
		t.Run(h, func(t *testing.T) {
			i := testIndex(t)
			p := fixture(t, h)
			if e := i.IndexFile(ctx, p, h); e != nil {
				t.Fatal(e)
			}
			roles := map[string]bool{}
			rows, e := i.db.Query("SELECT role FROM messages")
			if e != nil {
				t.Fatal(e)
			}
			for rows.Next() {
				var role string
				_ = rows.Scan(&role)
				roles[role] = true
			}
			rows.Close()
			for _, role := range []string{"user", "assistant", "tool_call", "tool_result"} {
				if !roles[role] {
					t.Errorf("missing %s", role)
				}
			}
			for _, q := range []string{"notsearchable", "hiddenreasoning", "hiddensignature", "hiddenbinary"} {
				if hits := search(t, i, q, Options{}); len(hits) != 0 {
					t.Errorf("indexed skipped %s: %+v", q, hits)
				}
			}
			hits := search(t, i, "VMPZ convention", Options{})
			if len(hits) != 1 || hits[0].Project == "" || !strings.Contains(hits[0].Snippet, "«VMPZ»") {
				t.Fatalf("hit metadata/snippet: %+v", hits)
			}
			if hits[0].Line < 2 || hits[0].Timestamp == "" || hits[0].Session == "" {
				t.Fatalf("missing native provenance: %+v", hits)
			}
		})
	}
}

func TestAppendCheckpointAndPartialLine(t *testing.T) {
	i := testIndex(t)
	p := fixture(t, "claude")
	if e := i.IndexFile(ctx, p, "claude"); e != nil {
		t.Fatal(e)
	}
	before, _ := i.Stats(ctx)
	appendFile(t, p, userLine("appendneedle"))
	if e := i.IndexFile(ctx, p, "claude"); e != nil {
		t.Fatal(e)
	}
	after, _ := i.Stats(ctx)
	if after.Messages != before.Messages+1 {
		t.Fatalf("append duplicated old rows: %+v %+v", before, after)
	}
	hits := search(t, i, "appendneedle", Options{})
	if len(hits) != 1 || hits[0].Line != 7 {
		t.Fatalf("append line = %+v", hits)
	}
	// A complete JSON object without its JSONL newline remains uncommitted.
	partial := strings.TrimSuffix(userLine("partialneedle"), "\n")
	appendFile(t, p, partial)
	if e := i.IndexFile(ctx, p, "claude"); e != nil {
		t.Fatal(e)
	}
	if len(search(t, i, "partialneedle", Options{})) != 0 {
		t.Fatal("indexed partial trailing line")
	}
	if e := i.IndexFile(ctx, p, "claude"); e != nil {
		t.Fatal(e)
	}
	appendFile(t, p, "\n")
	if e := i.IndexFile(ctx, p, "claude"); e != nil {
		t.Fatal(e)
	}
	if len(search(t, i, "partialneedle", Options{})) != 1 {
		t.Fatal("didn't finish partial line")
	}
	var offset int64
	_ = i.db.QueryRow("SELECT offset FROM files").Scan(&offset)
	stat, _ := os.Stat(p)
	if offset != stat.Size() {
		t.Fatalf("offset %d size %d", offset, stat.Size())
	}
	// Preserve the checkpoint timestamp: an unchanged scan must not write.
	if _, e := i.db.Exec("UPDATE state SET value='sentinel' WHERE key='updated_at'"); e != nil {
		t.Fatal(e)
	}
	if e := i.IndexFile(ctx, p, "claude"); e != nil {
		t.Fatal(e)
	}
	stats, _ := i.Stats(ctx)
	if stats.UpdatedAt != "sentinel" {
		t.Fatal("no-op scan wrote index")
	}
}
func TestReplacementTruncationAndRewrite(t *testing.T) {
	for _, mode := range []string{"truncate", "replace", "same-size", "regrown"} {
		t.Run(mode, func(t *testing.T) {
			i := testIndex(t)
			p := filepath.Join(t.TempDir(), "session.jsonl")
			old := userLine("oldneedle " + strings.Repeat("x", 500))
			_ = os.WriteFile(p, []byte(old), 0o600)
			if e := i.IndexFile(ctx, p, "claude"); e != nil {
				t.Fatal(e)
			}
			next := userLine("newneedle")
			switch mode {
			case "same-size":
				next = userLine("newneedle " + strings.Repeat("x", 500))
			case "regrown":
				next = userLine("newneedle " + strings.Repeat("y", 1000))
			case "replace":
				tmp := p + ".new"
				_ = os.WriteFile(tmp, []byte(next), 0o600)
				if e := os.Rename(tmp, p); e != nil {
					t.Fatal(e)
				}
			}
			if mode != "replace" {
				if e := os.WriteFile(p, []byte(next), 0o600); e != nil {
					t.Fatal(e)
				}
				future := time.Now().Add(time.Second)
				_ = os.Chtimes(p, future, future)
			}
			if e := i.IndexFile(ctx, p, "claude"); e != nil {
				t.Fatal(e)
			}
			if len(search(t, i, "oldneedle", Options{})) != 0 || len(search(t, i, "newneedle", Options{})) != 1 {
				t.Fatal("stale or duplicated rows after rewrite")
			}
		})
	}
}
func TestRankingFiltersAndLiteralQueries(t *testing.T) {
	i := testIndex(t)
	for _, h := range []string{"claude", "codex", "pi"} {
		if e := i.IndexFile(ctx, fixture(t, h), h); e != nil {
			t.Fatal(e)
		}
	}
	hits := search(t, i, "VMPZ convention", Options{})
	if len(hits) != 3 || hits[0].Harness != "codex" || hits[0].Score <= hits[1].Score {
		t.Fatalf("ranking: %+v", hits)
	}
	cases := []struct {
		q string
		o Options
		n int
	}{
		{"VMPZ", Options{Harness: "pi"}, 1}, {"VMPZ", Options{Project: "/work/sky"}, 3},
		{"VMPZ", Options{Since: "2026-10-02T00:00:00Z"}, 2}, {"VMPZ", Options{Sessions: []string{"33333333-3333-4333-8333-333333333333"}}, 1},
		{"VMPZ", Options{Sessions: []string{}}, 0}, {"VMPZ", Options{Limit: 1}, 1},
		{"src/sky_map.go", Options{}, 5}, {"snake_case", Options{}, 3}, {"cafe", Options{}, 1}, {"SQLITE_BUSY: database is locked", Options{}, 2},
		{"\" OR * NOT :", Options{}, 0}, {"---", Options{}, 0},
	}
	for _, c := range cases {
		if got := search(t, i, c.q, c.o); len(got) != c.n {
			t.Errorf("%q %+v got %d want %d: %+v", c.q, c.o, len(got), c.n, got)
		}
	}
}
func TestToolCapsAndUnicode(t *testing.T) {
	text := strings.Repeat("é", 5000)
	line := `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"` + text + `"},{"type":"toolCall","name":"bash","arguments":{"command":"` + text + `"}}]}}`
	m, e := parseLine("pi", []byte(line), &metadata{})
	if e != nil {
		t.Fatal(e)
	}
	if len(m) != 2 || len(m[0].Text) > 2048 || len(m[1].Text) != len(text) {
		t.Fatalf("tool cap or full assistant text violated (%d units)", len(m))
	}
	line = `{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"` + text + `"}]}}`
	m, e = parseLine("pi", []byte(line), &metadata{})
	if e != nil {
		t.Fatal(e)
	}
	if len(m) != 1 || len(m[0].Text) != 4096 {
		t.Fatal("tool result cap")
	}
}
func TestCatchUpAndRebuild(t *testing.T) {
	i := testIndex(t)
	p := fixture(t, "claude")
	roots := []Root{{"claude", filepath.Dir(p)}, {"pi", filepath.Join(t.TempDir(), "missing")}}
	problems, e := i.CatchUp(ctx, roots, false)
	if e != nil || len(problems) != 0 {
		t.Fatalf("catchup %v %v", problems, e)
	}
	first, _ := i.Stats(ctx)
	if first.Sessions != 1 || first.Messages != 4 {
		t.Fatalf("stats %+v", first)
	}
	problems, e = i.CatchUp(ctx, roots, true)
	if e != nil || len(problems) != 0 {
		t.Fatalf("rebuild %v %v", problems, e)
	}
	next, _ := i.Stats(ctx)
	if next.Messages != first.Messages {
		t.Fatal("rebuild duplicated")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, e = i.CatchUp(cancelled, roots, false); e == nil {
		t.Fatal("ignored cancellation")
	}
}
func TestPathsRespectScopedEnvironment(t *testing.T) {
	env := sysenv.New("/work", []string{"HOME=/home/test", "XDG_CACHE_HOME=/cache", "SHUTTLE_PI_SESSIONS_DIR=/pi"})
	p, e := DefaultPath(env)
	if e != nil || p != "/cache/felt/transcript-index.sqlite" {
		t.Fatalf("%s %v", p, e)
	}
	roots, e := Roots(env)
	if e != nil || roots[0].Path != "/home/test/.claude/projects" || roots[1].Path != "/home/test/.codex/sessions" || roots[2].Path != "/pi" {
		t.Fatalf("%+v %v", roots, e)
	}
	env.Set("SHUTTLE_TRANSCRIPT_INDEX", "index.sqlite")
	p, _ = DefaultPath(env)
	if p != "/work/index.sqlite" {
		t.Fatal(p)
	}
}
