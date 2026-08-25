package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
)

// TestStampHandedOff_ConcurrentWithStorageRMW is the F4 keystone at the layer
// handoff actually operates at: `felt shuttle handoff` (stampHandedOff, which
// locks+reads+writes the raw file at SHUTTLE_FIBER_PATH, bypassing Storage
// entirely) racing a daemon-shelled `felt shuttle mark-runtime`-shaped write
// (Storage.LockFiber -> Storage.Read -> SetShuttleRuntimeField -> Storage.Write)
// against the SAME fiber file. This is exactly the production race F4 exists
// to close: a worker's clean-exit handoff landing at the same instant the
// daemon shells mark-runtime to stamp a dispatch/conclude field.
//
// Both sides key their lock off the same on-disk path (Storage.Path(id) is
// what a real daemon-shelled invocation would resolve to, and what
// SHUTTLE_FIBER_PATH names for a worker), so they must serialize through the
// same lock file rather than each acquiring an independent one.
func TestStampHandedOff_ConcurrentWithStorageRMW(t *testing.T) {
	_, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)
	seeded := mustRead(t, storage, "f")
	if err := seeded.SetExtraField("counters", map[string]any{"run_id": 0}); err != nil {
		t.Fatalf("seeding counters: %v", err)
	}
	if err := storage.Write(seeded); err != nil {
		t.Fatalf("writing seeded counters: %v", err)
	}

	path := storage.Path("f")

	const iterations = 20
	var wg sync.WaitGroup
	wg.Add(2)

	// Side A: the worker's clean-exit handoff, called repeatedly (in reality
	// this fires once per worker lifetime; iterating here just gives the race
	// detector and the lock more opportunities to contend).
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			if _, _, err := stampHandedOff(path); err != nil {
				t.Errorf("stampHandedOff: %v", err)
				return
			}
		}
	}()

	// Side B: a mark-runtime-shaped RMW (lock -> read -> mutate one field ->
	// write -> unlock) bumping a counter, mirroring exactly what
	// resolveOwnedShuttleFiberAs + SetShuttleRuntimeField + Storage.Write do in
	// cmd/shuttle_mark_runtime.go's RunE.
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			unlock, err := storage.LockFiber("f")
			if err != nil {
				t.Errorf("LockFiber: %v", err)
				return
			}
			f, err := storage.Read("f")
			if err != nil {
				unlock()
				t.Errorf("Read: %v", err)
				return
			}
			var counters map[string]any
			if err := f.ExtraFields["counters"].Decode(&counters); err != nil {
				unlock()
				t.Errorf("decoding counters: %v", err)
				return
			}
			n, _ := counters["run_id"].(int)
			counters["run_id"] = n + 1
			if err := f.SetExtraField("counters", counters); err != nil {
				unlock()
				t.Errorf("SetExtraField: %v", err)
				return
			}
			if err := storage.Write(f); err != nil {
				unlock()
				t.Errorf("Write: %v", err)
				return
			}
			if err := unlock(); err != nil {
				t.Errorf("unlock: %v", err)
				return
			}
		}
	}()

	wg.Wait()

	final := mustRead(t, storage, "f")

	// Side A's field must have landed (a bare non-empty timestamp is enough
	// proof stampHandedOff's writes weren't entirely lost).
	rt := shuttleRuntimeMap(t, final)
	if got, _ := rt["handed_off_at"].(string); got == "" {
		t.Fatal("shuttle.runtime.handed_off_at is empty after the race — handoff's writes were lost")
	}

	// Side B's counter must reflect EVERY iteration — the actual lost-update
	// check. Without the lock, this reliably comes up short: whichever side
	// wrote from a stale read clobbers the other's most recent value.
	var counters map[string]any
	if err := final.ExtraFields["counters"].Decode(&counters); err != nil {
		t.Fatalf("decoding final counters: %v", err)
	}
	if n, _ := counters["run_id"].(int); n != iterations {
		t.Fatalf("counters.run_id = %d, want %d — lost update(s) under concurrent handoff/mark-runtime writes", n, iterations)
	}
}

// TestResolveHandoffPath_ExplicitArgBeatsAmbientEnv pins the fix for the
// chdir is t.Chdir for the go.mod toolchain (1.23): testing.T.Chdir arrived in
// Go 1.24, and a test that compiles only on newer local toolchains is a CI
// break waiting to happen (it did).
func chdir(t *testing.T, dir string) {
	t.Helper()
	prev, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir %s: %v", dir, err)
	}
	t.Cleanup(func() { _ = os.Chdir(prev) })
}

// live-fire near-miss: a daemon-launched worker (SHUTTLE_FIBER_PATH in env)
// running `felt shuttle handoff <other-fiber>` must stamp the fiber it NAMED,
// not its own — and must not be treated as exiting (self=false gates the tmux
// self-kill). Self-handoff and the resolution-failure fallback keep the old
// env-authoritative behavior.
func TestResolveHandoffPath_ExplicitArgBeatsAmbientEnv(t *testing.T) {
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "own", felt.StatusActive, oneshot(), nil)
	seedShuttleRole(t, storage, "sibling", felt.StatusActive, oneshot(), nil)
	chdir(t, dir)
	t.Setenv("SHUTTLE_FIBER_PATH", storage.Path("own"))

	// Explicit different fiber: the argument wins, caller is not exiting.
	path, self, _, err := resolveHandoffPath("sibling")
	if err != nil {
		t.Fatalf("resolveHandoffPath(sibling): %v", err)
	}
	if !samePath(path, storage.Path("sibling")) {
		t.Fatalf("path = %q, want sibling's %q — ambient SHUTTLE_FIBER_PATH overrode the explicit argument", path, storage.Path("sibling"))
	}
	if self {
		t.Fatal("self = true for a sibling handoff — would kill the caller's own tmux session")
	}

	// Self-handoff: env path is authoritative, self=true.
	path, self, _, err = resolveHandoffPath("own")
	if err != nil {
		t.Fatalf("resolveHandoffPath(own): %v", err)
	}
	if path != storage.Path("own") || !self {
		t.Fatalf("self-handoff: path=%q self=%v, want env path %q self=true", path, self, storage.Path("own"))
	}

	// Resolution failure: falls back to the env path (the pre-existing
	// daemon-worker behavior), still self.
	path, self, _, err = resolveHandoffPath("no-such-fiber")
	if err != nil {
		t.Fatalf("resolveHandoffPath(no-such-fiber): %v", err)
	}
	if path != storage.Path("own") || !self {
		t.Fatalf("fallback: path=%q self=%v, want env path self=true", path, self)
	}
}

// TestResolveHandoffPath_FuzzyAndNoStoreFallbacks pins the reviewer-flagged
// edges: (a) a fuzzy resolution that disagrees with SHUTTLE_FIBER_PATH is
// ambiguity — env wins, self=true (never silently stamp a suffix-matched
// stranger and suppress the self-kill); (b) a cwd with no .felt store at all —
// the daemon-worker reality when project_dir isn't a felt repo — falls back to
// the env path, self=true.
func TestResolveHandoffPath_FuzzyAndNoStoreFallbacks(t *testing.T) {
	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "own", felt.StatusActive, oneshot(), nil)
	seedShuttleRole(t, storage, "parent/nested-card", felt.StatusActive, oneshot(), nil)
	t.Setenv("SHUTTLE_FIBER_PATH", storage.Path("own"))

	chdir(t, dir)
	// "nested-card" fuzzily resolves to parent/nested-card but is not its exact
	// id — ambiguity, env wins.
	path, self, _, err := resolveHandoffPath("nested-card")
	if err != nil {
		t.Fatalf("resolveHandoffPath(nested-card): %v", err)
	}
	if path != storage.Path("own") || !self {
		t.Fatalf("fuzzy mismatch: path=%q self=%v, want env path %q self=true", path, self, storage.Path("own"))
	}
	// The exact nested id is honored as a sibling handoff.
	path, self, _, err = resolveHandoffPath("parent/nested-card")
	if err != nil {
		t.Fatalf("resolveHandoffPath(parent/nested-card): %v", err)
	}
	if !samePath(path, storage.Path("parent/nested-card")) || self {
		t.Fatalf("exact nested id: path=%q self=%v, want sibling path self=false", path, self)
	}

	// No felt store in cwd at all: resolution errors, env fallback, self=true.
	chdir(t, t.TempDir())
	path, self, _, err = resolveHandoffPath("parent/nested-card")
	if err != nil {
		t.Fatalf("resolveHandoffPath outside store: %v", err)
	}
	if path != storage.Path("own") || !self {
		t.Fatalf("no-store fallback: path=%q self=%v, want env path self=true", path, self)
	}
}

// The frontmatter stamp says only that the LATEST run ended cleanly; the ledger
// line is what lets a reader tell, session by session, which worker handed off
// and which died mid-thought. It is best-effort: no session UUID (or no
// ~/.shuttle) records nothing rather than failing the handoff.
func TestRecordHandoffPairing_WritesLedgerLine(t *testing.T) {
	_, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, oneshot(), nil)
	f := mustRead(t, storage, "f")
	if err := f.SetShuttleRuntimeField("session_uuid", "0883ade1-0000-4000-8000-000000000001"); err != nil {
		t.Fatalf("seeding session_uuid: %v", err)
	}

	ledger := filepath.Join(t.TempDir(), "sessions.jsonl")
	t.Setenv("SHUTTLE_SESSIONS_FILE", ledger)
	recordHandoffPairing(f, "work/one", "2026-08-25T01:02:03.5Z")

	data, err := os.ReadFile(ledger)
	if err != nil {
		t.Fatalf("reading ledger: %v", err)
	}
	var line map[string]any
	if err := json.Unmarshal(data, &line); err != nil {
		t.Fatalf("decoding ledger line %q: %v", data, err)
	}
	if line["kind"] != "handoff" {
		t.Errorf("expected a handoff line, got %v", line["kind"])
	}
	if line["session"] != "0883ade1-0000-4000-8000-000000000001" {
		t.Errorf("the line must name the session that exited, got %v", line["session"])
	}
	if line["fiber"] != "work/one" {
		t.Errorf("the line must carry the ledger's address shape, got %v", line["fiber"])
	}
	want := time.Date(2026, 8, 25, 1, 2, 3, 500_000_000, time.UTC).UnixMilli()
	if at, _ := line["at"].(float64); int64(at) != want {
		t.Errorf("at should be the handoff instant in unix ms: got %v, want %d", line["at"], want)
	}

	// A fiber that never got a session UUID has no pairing to record.
	bare := mustRead(t, storage, "f")
	recordHandoffPairing(bare, "work/one", "2026-08-25T01:02:04Z")
	after, err := os.ReadFile(ledger)
	if err != nil {
		t.Fatalf("re-reading ledger: %v", err)
	}
	if len(after) != len(data) {
		t.Errorf("a fiber with no session UUID must record nothing, ledger grew to %q", after)
	}
}
