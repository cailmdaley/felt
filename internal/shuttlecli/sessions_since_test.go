package shuttlecli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// recentFixture indexes two ended Claude sessions on host "mac": one last
// active on 14 Nov, one on 1 Nov.
func recentFixture(t *testing.T) func(args ...string) (string, error) {
	t.Helper()
	e := testEnv(t)
	dir := t.TempDir()
	projects := filepath.Join(dir, "claude-projects", "-work")
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(session, text string, stamps ...string) {
		var b strings.Builder
		for _, at := range stamps {
			b.WriteString(`{"type":"user","sessionId":"` + session + `","cwd":"/work","timestamp":"` + at + `","message":{"role":"user","content":"` + text + `"}}` + "\n")
		}
		if err := os.WriteFile(filepath.Join(projects, session+".jsonl"), []byte(b.String()), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("aaaaaaaa-1111-4111-8111-111111111111", "the night review", "2026-11-13T22:00:00Z", "2026-11-14T03:30:00+01:00")
	write("bbbbbbbb-2222-4222-8222-222222222222", "an old thread", "2026-11-01T09:00:00Z")
	e.Set("SHUTTLE_HOST", "mac")
	e.Set("SHUTTLE_CLAUDE_PROJECTS_DIR", filepath.Join(dir, "claude-projects"))
	e.Set("SHUTTLE_CODEX_SESSIONS_DIR", filepath.Join(dir, "codex"))
	e.Set("SHUTTLE_PI_SESSIONS_DIR", filepath.Join(dir, "pi"))
	e.Set("SHUTTLE_TRANSCRIPT_INDEX", filepath.Join(dir, "index.sqlite"))
	run := func(args ...string) (string, error) {
		out, _, err := executeIn(t, e, dir, args...)
		return out, err
	}
	if out, err := run("transcript", "index"); err != nil {
		t.Fatalf("index: %v\n%s", err, out)
	}
	return run
}

func TestSessionsSinceListsEndedSessionsInsideTheWindow(t *testing.T) {
	run := recentFixture(t)

	out, err := run("sessions", "--since", "2026-11-13T12:00:00Z", "--json")
	if err != nil {
		t.Fatalf("sessions --since: %v\n%s", err, out)
	}
	var got recentSessions
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if got.Host != "mac" || got.Since != "2026-11-13T12:00:00Z" || len(got.Sessions) != 1 {
		t.Fatalf("want one session on mac since 13 Nov noon: %s", out)
	}
	s := got.Sessions[0]
	if s.Session != "aaaaaaaa-1111-4111-8111-111111111111" || s.Live || s.Harness != "claude" || s.Address != "aaaaaaaa" || s.Host != "mac" {
		t.Fatalf("unexpected row: %+v", s)
	}
	// 03:30+01:00 is the later message, reported in UTC.
	if s.Last != "2026-11-14T02:30:00Z" || s.Messages != 2 {
		t.Fatalf("last activity %q over %d messages, want 2026-11-14T02:30:00Z over 2", s.Last, s.Messages)
	}

	out, err = run("sessions", "--since", "2026-10-30")
	if err != nil {
		t.Fatalf("sessions --since date: %v\n%s", err, out)
	}
	if !strings.Contains(out, "aaaaaaaa") || !strings.Contains(out, "bbbbbbbb") || strings.Index(out, "aaaaaaaa") > strings.Index(out, "bbbbbbbb") || !strings.Contains(out, "ended") {
		t.Fatalf("want both sessions, newest first, marked ended:\n%s", out)
	}

	out, err = run("sessions", "--since", "2026-11-15")
	if err != nil || !strings.Contains(out, "no sessions on mac since 2026-11-15T00:00:00Z") {
		t.Fatalf("empty window: %v\n%s", err, out)
	}

	if _, err := run("sessions", "--since", "yesterday"); err == nil {
		t.Fatal("an invalid --since was accepted")
	}
	if _, err := run("sessions", "some/fiber", "--since", "1d"); err == nil {
		t.Fatal("--since with a fiber argument was accepted")
	}
}

func TestSessionsSinceRoutesAnotherHostThroughTheDaemon(t *testing.T) {
	var asked string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/sessions/recent" {
			http.NotFound(w, r)
			return
		}
		asked = r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(recentSessions{
			Host:  "cluster",
			Since: r.URL.Query().Get("since"),
			Sessions: []recentSession{{
				Host: "cluster", Address: "cccccccc", Live: true,
				Fibers: []transcriptFiber{{ID: "science/bmodes", Name: "B-modes"}},
			}},
			Errors: []string{},
		})
	}))
	defer server.Close()
	e := testEnv(t)
	e.Set("SHUTTLE_HOST", "mac")
	e.Set("SHUTTLE_DAEMON_URL", server.URL)
	e.Set("SHUTTLE_TRANSCRIPT_INDEX", filepath.Join(t.TempDir(), "never-opened.sqlite"))

	out, _, err := executeIn(t, e, t.TempDir(), "sessions", "--host", "cluster", "--since", "2026-11-14T00:00:00+01:00", "--harness", "codex")
	if err != nil {
		t.Fatalf("remote sessions --since: %v\n%s", err, out)
	}
	for _, want := range []string{"host=cluster", "since=2026-11-13T23%3A00%3A00Z", "harness=codex"} {
		if !strings.Contains(asked, want) {
			t.Errorf("daemon asked %q, missing %q", asked, want)
		}
	}
	if !strings.Contains(out, "live") || !strings.Contains(out, "cccccccc") || !strings.Contains(out, "bmodes") {
		t.Fatalf("remote row not printed:\n%s", out)
	}
}
