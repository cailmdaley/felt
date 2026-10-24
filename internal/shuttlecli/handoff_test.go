package shuttlecli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv"
)

// stubWorkerExitTmux records kills and snapshots the document at exit, so tests
// verify that the write is durable before the session ends.
func stubWorkerExitTmux(t *testing.T, env *sysenv.Env, session, fiberPath string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	kills, snapshot := filepath.Join(dir, "kills"), filepath.Join(dir, "snapshot")
	script := `#!/bin/sh
case "$1" in
  display-message) printf '%s\n' "$SHUTTLE_TEST_SESSION" ;;
  kill-session)
    cp "$SHUTTLE_TEST_FIBER" "$SHUTTLE_TEST_SNAPSHOT" || exit 1
    printf '%s\n' "$*" >> "$SHUTTLE_TEST_KILLS"
    ;;
  *) exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", dir+string(os.PathListSeparator)+env.Getenv("PATH"))
	env.Set("TMUX", "/test/tmux,1,0")
	env.Set("TMUX_PANE", "%1")
	env.Set("SHUTTLE_TEST_SESSION", session)
	env.Set("SHUTTLE_TEST_FIBER", fiberPath)
	env.Set("SHUTTLE_TEST_SNAPSHOT", snapshot)
	env.Set("SHUTTLE_TEST_KILLS", kills)
	// Warm executable inspection before tmuxCurrentSession's one-second probe.
	if out, err := env.Command("tmux", "display-message").Output(); err != nil || strings.TrimSpace(string(out)) != session {
		t.Fatalf("fake tmux: %q (%v)", out, err)
	}
	return kills, snapshot
}

func TestShuttleHandoff_WithoutDispatchPath(t *testing.T) {
	t.Parallel()
	for _, manual := range []bool{true, false} {
		t.Run(fmt.Sprintf("manual=%v", manual), func(t *testing.T) {
			t.Parallel()
			env := testEnv(t)
			dir, storage := newStore(t)
			seedShuttleRole(t, storage, "own", felt.StatusActive, oneshot(), nil)
			seedShuttleRole(t, storage, "other", felt.StatusActive, oneshot(), nil)
			own := mustRead(t, storage, "own")
			session := shuttleTmuxSessionName(own.ID, own.UID)
			if manual {
				session = "manual-session"
			}
			kills, _ := stubWorkerExitTmux(t, env, session, storage.Path("other"))
			if out, err := runIn(t, env, dir, "handoff", "other"); err != nil {
				t.Fatalf("handoff: %v\n%s", err, out)
			}
			if got := shuttleRuntimeMap(t, mustRead(t, storage, "other"))["handed_off_at"]; got == nil {
				t.Fatal("named fiber must be stamped")
			}
			_, err := os.Stat(kills)
			if manual && err != nil || !manual && !os.IsNotExist(err) {
				t.Fatalf("kill must apply only to manual handoff: %v", err)
			}
		})
	}
}

func TestShuttleHandoff_RenamedFiber(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "old", felt.StatusActive, oneshot(), nil)
	f := mustRead(t, storage, "old")
	session := shuttleTmuxSessionName(f.ID, f.UID)
	oldPath := storage.Path("old")
	newPath := storage.Path("renamed")
	if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		t.Fatal(err)
	}
	env.Set("SHUTTLE_FIBER_PATH", oldPath)
	kills, snapshot := stubWorkerExitTmux(t, env, session, newPath)
	if out, err := runIn(t, env, dir, "handoff", "renamed"); err != nil {
		t.Fatalf("handoff: %v\n%s", err, out)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old path must stay absent: %v", err)
	}
	data, err := os.ReadFile(snapshot)
	if err != nil || !strings.Contains(string(data), "handed_off_at:") {
		t.Fatalf("document at exit lacks handoff: %s (%v)", data, err)
	}
	data, err = os.ReadFile(kills)
	if err != nil || string(data) != fmt.Sprintf("kill-session -t %s\n", session) {
		t.Fatalf("kills = %q (%v)", data, err)
	}
}

// TestStampHandedOff_ConcurrentWithStorageRMW is the F4 keystone at the layer
// handoff actually operates at: `shuttle handoff` (stampHandedOff, which
// locks+reads+writes the raw file at SHUTTLE_FIBER_PATH, bypassing Storage
// entirely) racing a daemon-shelled runtime-field write
// (Storage.LockFiber -> Storage.Read -> shuttle.SetRuntimeField -> Storage.Write)
// against the SAME fiber file. This is exactly the production race F4 exists
// to close: a worker's clean-exit handoff landing at the same instant the
// daemon shells mark-runtime to stamp a dispatch/conclude field.
//
// Both sides key their lock off the same on-disk path (Storage.Path(id) is
// what a real daemon-shelled invocation would resolve to, and what
// SHUTTLE_FIBER_PATH names for a worker), so they must serialize through the
// same lock file rather than each acquiring an independent one.
func TestStampHandedOff_ConcurrentWithStorageRMW(t *testing.T) {
	t.Parallel()
	_, storage := newStore(t)
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
			if _, err := stampHandedOff(path, nil); err != nil {
				t.Errorf("stampHandedOff: %v", err)
				return
			}
		}
	}()

	// Side B: a mark-runtime-shaped RMW (lock -> read -> mutate one field ->
	// write -> unlock) bumping a counter, mirroring the lock/read/update/write
	// sequence in internal/shuttlecli/mark_runtime.go's RunE.
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
// live-fire near-miss: a daemon-launched worker (SHUTTLE_FIBER_PATH in env)
// running `shuttle handoff <other-fiber>` must stamp the fiber it NAMED,
// not its own — and must not be treated as exiting (self=false gates the tmux
// self-kill). Self-handoff and the resolution-failure fallback keep the old
// env-authoritative behavior.
func TestResolveHandoffPath_ExplicitArgBeatsAmbientEnv(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "own", felt.StatusActive, oneshot(), nil)
	seedShuttleRole(t, storage, "sibling", felt.StatusActive, oneshot(), nil)
	env.Chdir(dir)
	env.Set("SHUTTLE_FIBER_PATH", storage.Path("own"))

	// Explicit different fiber: the argument wins, caller is not exiting.
	path, self, err := newApp(env).resolveHandoffPath("sibling")
	if err != nil {
		t.Fatalf("resolveHandoffPath(sibling): %v", err)
	}
	if !newApp(env).samePath(path, storage.Path("sibling")) {
		t.Fatalf("path = %q, want sibling's %q — ambient SHUTTLE_FIBER_PATH overrode the explicit argument", path, storage.Path("sibling"))
	}
	if self {
		t.Fatal("self = true for a sibling handoff — would kill the caller's own tmux session")
	}

	// Self-handoff: env path is authoritative, self=true.
	path, self, err = newApp(env).resolveHandoffPath("own")
	if err != nil {
		t.Fatalf("resolveHandoffPath(own): %v", err)
	}
	if !newApp(env).samePath(path, storage.Path("own")) || !self {
		t.Fatalf("self-handoff: path=%q self=%v, want env path %q self=true", path, self, storage.Path("own"))
	}

	// A missing explicit target must never stamp the caller's fiber.
	if _, _, err := newApp(env).resolveHandoffPath("no-such-fiber"); err == nil {
		t.Fatal("explicit missing target accepted")
	}
}

// Explicit targets stay explicit; only an omitted target uses worker identity.
func TestResolveHandoffPath_FuzzyAndNoStoreFallbacks(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "own", felt.StatusActive, oneshot(), nil)
	seedShuttleRole(t, storage, "parent/nested-card", felt.StatusActive, oneshot(), nil)
	env.Set("SHUTTLE_FIBER_PATH", storage.Path("own"))

	env.Chdir(dir)
	// A unique slug resolves the named sibling, not the dispatch environment.
	path, self, err := newApp(env).resolveHandoffPath("nested-card")
	if err != nil {
		t.Fatalf("resolveHandoffPath(nested-card): %v", err)
	}
	if !newApp(env).samePath(path, storage.Path("parent/nested-card")) || self {
		t.Fatalf("slug target: path=%q self=%v", path, self)
	}
	// The exact nested id is honored as a sibling handoff.
	path, self, err = newApp(env).resolveHandoffPath("parent/nested-card")
	if err != nil {
		t.Fatalf("resolveHandoffPath(parent/nested-card): %v", err)
	}
	if !newApp(env).samePath(path, storage.Path("parent/nested-card")) || self {
		t.Fatalf("exact nested id: path=%q self=%v, want sibling path self=false", path, self)
	}

	// An omitted target works even outside a felt store.
	env.Chdir(t.TempDir())
	path, self, err = newApp(env).resolveHandoffPath("")
	if err != nil {
		t.Fatalf("resolveHandoffPath outside store: %v", err)
	}
	if !newApp(env).samePath(path, storage.Path("own")) || !self {
		t.Fatalf("no-store fallback: path=%q self=%v, want env path self=true", path, self)
	}
}
