package shuttlecli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBoardDigestFindsLateRecordsAndKeepsUnresolvedCursor(t *testing.T) {
	env := messageHookEnv(t, "host")
	now := time.UnixMilli(1793300000000)
	resolved := false
	late := false
	daemonStub(t, env, map[string]http.HandlerFunc{"/api/v1/board/family": func(w http.ResponseWriter, r *http.Request) {
		if !resolved {
			w.Write([]byte(`{"family":null,"viewer":null,"records":[]}`))
			return
		}
		var rows []map[string]any
		// A record can arrive after this session's previous successful digest,
		// while carrying a writer clock from fifteen minutes earlier.
		if late && r.URL.Query().Get("since_ms") == "0" {
			rows = append(rows, map[string]any{"id": "late", "timestamp": now.Add(-15 * time.Minute).UnixMilli(), "kind": "post", "text": "arrived late"})
		}
		json.NewEncoder(w).Encode(map[string]any{"family": map[string]any{"label": "family"}, "records": rows})
	}})
	a := newApp(env)
	a.eventNow = func() time.Time { return now }
	path := filepath.Join(env.Getenv("SHUTTLE_DATA_DIR"), "board-cursors", "codex-s.json")
	a.boardDigest("codex", "s")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("unresolved viewer advanced cursor: %v", err)
	}
	resolved = true
	a.boardDigest("codex", "s")
	late = true
	now = now.Add(time.Minute)
	if out := a.boardDigest("codex", "s"); !strings.Contains(out, "arrived late") {
		t.Fatalf("late record missing: %q", out)
	}
	now = now.Add(20 * time.Minute)
	if out := a.boardDigest("codex", "s"); out != "" {
		t.Fatalf("late record replayed: %q", out)
	}
}
