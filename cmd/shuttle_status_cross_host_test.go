package cmd

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"
)

// Exercises composite-snapshot rendering. The integration test uses
// httptest.NewServer to stand in for the daemon's /api/v1/state/composite endpoint,
// so the same code path (fetchCompositeFrom -> compositeRows) runs end-to-end
// without a live daemon. Pure rendering logic gets covered by compositeRows unit
// tests against fixture structs. Ported from shuttle-ctl's status_cross_host_test.go.

const sampleCompositeJSON = `{
  "local": {
    "host": "dapmcw68",
    "felt_stores": ["/tmp/example-loom"],
    "eligible": [
      {
        "fiber_id": "ai-futures/shuttle/constitution-shuttle-remote-dispatch",
        "tmux_session": "constitution-shuttle-remote-dispatch-shuttle",
        "agent": "claude-opus",
        "state": "running",
        "started_at": 1778010188803,
        "runtime_seconds": 44
      }
    ],
    "retrying": [],
    "standing_roles": [
      {
        "fiber_id": "ai-futures/shuttle/standing-roles/canary-local-snapshot",
        "state": "scheduled",
        "next_due_at": 4071283200000,
        "review": {"state": "scheduled"},
        "schedule": {"expr": "0 9 * * 1-5", "tz": "Europe/Paris"}
      }
    ]
  },
  "remotes": {
    "candide": {
      "snapshot": {
        "host": "candide",
        "eligible": [
          {
            "fiber_id": "tests/smoke-remote-haiku",
            "tmux_session": "smoke-remote-haiku-shuttle",
            "agent": "claude-sonnet",
            "state": "running",
            "started_at": 1778010100000,
            "runtime_seconds": 88
          }
        ],
        "retrying": [
          {"fiber_id": "tests/flaky-job", "attempt": 2, "due_in_ms": 4000, "error": "boom"}
        ],
        "standing_roles": []
      },
      "last_polled_at": "2026-05-05T20:30:00Z",
      "stale": false,
      "last_error": null
    },
    "cineca": {
      "snapshot": null,
      "last_polled_at": null,
      "stale": true,
      "last_error": "nxdomain"
    }
  }
}`

func TestCompositeRows_All(t *testing.T) {
	c := &CompositeState{
		Local: &Snapshot{
			Eligible: []SnapshotEntry{{FiberID: "local/a", Agent: "claude-opus", State: "running", TmuxSession: "a-shuttle"}},
			StandingRoles: []StandingRoleEntry{
				{FiberID: "local/standing", State: "scheduled"},
			},
		},
		Remotes: map[string]*RemoteSnapshot{
			"candide": {
				Snapshot: &Snapshot{
					Eligible: []SnapshotEntry{{FiberID: "remote/x", Agent: "claude-sonnet", State: "running"}},
					Retrying: []RetryEntry{{FiberID: "remote/r", Attempt: 1, Error: "boom"}},
				},
				Stale: false,
			},
			"cineca": {Snapshot: nil, Stale: true, LastError: "nxdomain"},
		},
	}

	rows := compositeRows(c, "")

	gotIDs := map[string]string{} // fiber_id → origin
	for _, r := range rows {
		gotIDs[r.FiberID] = r.Origin
	}

	for fid, wantOrigin := range map[string]string{
		"local/a":        "",
		"local/standing": "",
		"remote/x":       "candide",
		"remote/r":       "candide",
	} {
		if got := gotIDs[fid]; got != wantOrigin {
			t.Errorf("fiber %q: got origin %q, want %q", fid, got, wantOrigin)
		}
	}

	// cineca is configured but never successfully polled — must surface as a
	// placeholder row so the user sees it exists.
	foundCineca := false
	for _, r := range rows {
		if r.Origin == "cineca" {
			foundCineca = true
			if !r.Stale {
				t.Errorf("cineca placeholder row: expected Stale=true, got false")
			}
			if r.State == "" {
				t.Errorf("cineca placeholder row: expected non-empty State, got empty")
			}
		}
	}
	if !foundCineca {
		t.Errorf("cineca remote missing from rows; configured-but-stale remotes must render as placeholders")
	}
}

func TestCompositeRows_FilterRemote(t *testing.T) {
	c := &CompositeState{
		Local: &Snapshot{
			Eligible: []SnapshotEntry{{FiberID: "local/a", State: "running"}},
		},
		Remotes: map[string]*RemoteSnapshot{
			"candide": {Snapshot: &Snapshot{Eligible: []SnapshotEntry{{FiberID: "remote/x", State: "running"}}}},
			"cineca":  {Snapshot: &Snapshot{Eligible: []SnapshotEntry{{FiberID: "remote/y", State: "running"}}}},
		},
	}

	rows := compositeRows(c, "candide")

	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
	}
	if rows[0].Origin != "candide" || rows[0].FiberID != "remote/x" {
		t.Errorf("unexpected row: %+v", rows[0])
	}
}

func TestCompositeRows_FilterUnknownRemote(t *testing.T) {
	c := &CompositeState{
		Local:   &Snapshot{Eligible: []SnapshotEntry{{FiberID: "local/a", State: "running"}}},
		Remotes: map[string]*RemoteSnapshot{"candide": {Snapshot: &Snapshot{}}},
	}
	// Unknown name yields zero rows (not an error). Lets JSON consumers see [] and
	// avoids privileging "did you mean" suggestions.
	rows := compositeRows(c, "ghost")
	if len(rows) != 0 {
		t.Errorf("expected 0 rows for unknown remote, got %d: %+v", len(rows), rows)
	}
}

func TestCompositeRows_StalePropagatesToRows(t *testing.T) {
	c := &CompositeState{
		Remotes: map[string]*RemoteSnapshot{
			"candide": {
				Snapshot: &Snapshot{
					Eligible: []SnapshotEntry{{FiberID: "remote/x", State: "running"}},
				},
				Stale:     true,
				LastError: "timeout",
			},
		},
	}

	rows := compositeRows(c, "")
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(rows))
	}
	// A stale-but-still-cached snapshot still yields rows from the cached data; the
	// per-row Stale flag warns the renderer.
	if !rows[0].Stale {
		t.Errorf("expected Stale=true on rows from stale remote, got false")
	}
}

func TestCompositeRows_RecoveryPlaceholderUsesRecoveryState(t *testing.T) {
	c := &CompositeState{
		Remotes: map[string]*RemoteSnapshot{
			"candide": {
				Snapshot: nil,
				Stale:    true,
				Recovery: &RemoteRecovery{State: "unreachable", NextRetryAt: time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339)},
			},
		},
	}

	rows := compositeRows(c, "")
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
	}
	if rows[0].Origin != "candide" {
		t.Fatalf("unexpected origin: %+v", rows[0])
	}
	if rows[0].FiberID != "" {
		t.Fatalf("expected placeholder row, got fiber_id=%q", rows[0].FiberID)
	}
	if want := "unreachable (next:"; len(rows[0].State) < len(want) || rows[0].State[:len(want)] != want {
		t.Fatalf("expected unreachable recovery label, got %q", rows[0].State)
	}
}

func TestCompositeRows_RecoveryAddsOriginSummaryAlongsideSnapshotRows(t *testing.T) {
	c := &CompositeState{
		Remotes: map[string]*RemoteSnapshot{
			"candide": {
				Snapshot: &Snapshot{
					Eligible: []SnapshotEntry{{FiberID: "remote/x", State: "running"}},
				},
				Recovery: &RemoteRecovery{State: "reviving", Attempt: 2, LastAction: "bounced tunnel"},
			},
		},
	}

	rows := compositeRows(c, "")
	if len(rows) != 2 {
		t.Fatalf("expected summary row + worker row, got %d: %+v", len(rows), rows)
	}
	if rows[0].FiberID != "" || rows[0].Origin != "candide" {
		t.Fatalf("first row should be origin summary, got %+v", rows[0])
	}
	if rows[0].State != "reviving (attempt 2: bounced tunnel)" {
		t.Fatalf("unexpected recovery label: %q", rows[0].State)
	}
	if rows[1].FiberID != "remote/x" || rows[1].Origin != "candide" {
		t.Fatalf("second row should be worker row, got %+v", rows[1])
	}
}

func TestCompositeRows_StandingRoleNextDueRendered(t *testing.T) {
	due := int64(4071283200000)
	c := &CompositeState{
		Local: &Snapshot{
			StandingRoles: []StandingRoleEntry{{
				FiberID:   "ai-futures/shuttle/standing-roles/canary",
				State:     "scheduled",
				NextDueAt: &due,
			}},
		},
	}
	rows := compositeRows(c, "")
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(rows))
	}
	if rows[0].NextDueAt == "" {
		t.Errorf("expected NextDueAt to render from epoch ms, got empty")
	}
	if rows[0].Kind != "standing" {
		t.Errorf("expected Kind=standing, got %q", rows[0].Kind)
	}
}

func TestFetchComposite_ParsesSampleResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/state/composite" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(sampleCompositeJSON))
	}))
	defer srv.Close()

	c, err := fetchCompositeFrom(srv.URL + "/api/v1/state/composite")
	if err != nil {
		t.Fatalf("fetchCompositeFrom: %v", err)
	}

	// Sanity: local has the expected fiber, candide has its own, cineca is
	// null/stale, all without us hand-asserting field by field.
	rows := compositeRows(c, "")
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.Origin+":"+r.FiberID)
	}
	sort.Strings(ids)

	want := []string{
		":ai-futures/shuttle/constitution-shuttle-remote-dispatch",
		":ai-futures/shuttle/standing-roles/canary-local-snapshot",
		"candide:tests/flaky-job",
		"candide:tests/smoke-remote-haiku",
		"cineca:",
	}
	if !equalSorted(ids, want) {
		t.Errorf("unexpected row set:\n got: %v\nwant: %v", ids, want)
	}
}

func TestFetchComposite_ErrorOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := fetchCompositeFrom(srv.URL + "/api/v1/state/composite")
	if err == nil {
		t.Fatal("expected error on 500, got nil")
	}
}

func equalSorted(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
