package shuttlecli

import (
	"bytes"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/shuttle"
)

// Lock-in for the exact argv the Elixir daemon shells against
// `shuttle mark-runtime`. Daemon-side Elixir tests assert flags are SENT via a
// mock Runner; they stay green even if the real CLI rejects a flag (a daemon
// shelling a CLI that does not know one of its flags). These tests run the
// actual cobra command path (executeIn → the root command's Execute), not a
// mock, so a flag the daemon relies on but the CLI doesn't accept fails HERE.

// TestShuttleMarkRuntime_DaemonDispatchArgv locks in the exact argv
// Shuttle.Continuation.write_dispatch/4 shells (daemon/lib/shuttle/continuation.ex,
// the `mark_runtime/4` private helper):
//
//	shuttle mark-runtime <fiber_id> --dispatched-at <ts> --session <uuid> --run-id <run_id>
//
// No `--host` override: `resolveOwnHost` is pure local state (no daemon
// round-trip), so ambient resolution (env → host file → hostname) drives the
// ownership guard the same way for every write verb. The daemon is DOWN here (unroutable
// SHUTTLE_DAEMON_URL) and identity is seeded only via the host file, proving
// mark-runtime never depends on a live daemon for either the flags
// themselves or the ownership check.
func TestShuttleMarkRuntime_DaemonDispatchArgv(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1") // closed port: any round-trip fails loudly
	ownHost(t, env, "candide")

	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "candide",
	}, nil)

	out, err := runIn(t, env, dir, "mark-runtime", "f",
		"--dispatched-at", "2026-07-05T12:00:00Z",
		"--session", "sess-abc-123",
		"--run-id", "20260705T120000Z",
	)
	if err != nil {
		t.Fatalf("mark-runtime with the daemon's exact dispatch argv must succeed: %v\n%s", err, out)
	}

	rt := shuttleRuntimeMap(t, mustRead(t, storage, "f"))
	for k, want := range map[string]string{
		"dispatched_at": "2026-07-05T12:00:00Z",
		"session_uuid":  "sess-abc-123",
		"run_id":        "20260705T120000Z",
	} {
		if got, _ := rt[k].(string); got != want {
			t.Fatalf("shuttle.runtime.%s = %q, want %q", k, got, want)
		}
	}
}

// TestShuttleMarkRuntime_DaemonHandoffArgv locks in the exact argv
// Shuttle.Continuation.mark_handed_off/3 shells (daemon/lib/shuttle/continuation.ex)
// — the daemon-side conclude write after an accept/resume/rearm:
//
//	shuttle mark-runtime <fiber_id> --handed-off-at <ts>
//
// Same daemon-down + host-file-only identity setup as the dispatch test; no
// `--host` override (see that test's comment for why).
func TestShuttleMarkRuntime_DaemonHandoffArgv(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	ownHost(t, env, "candide")

	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-opus", "host": "candide",
	}, nil)

	out, err := runIn(t, env, dir, "mark-runtime", "f",
		"--handed-off-at", "2026-07-05T12:05:00Z",
	)
	if err != nil {
		t.Fatalf("mark-runtime with the daemon's exact handoff argv must succeed: %v\n%s", err, out)
	}

	rt := shuttleRuntimeMap(t, mustRead(t, storage, "f"))
	if got, _ := rt["handed_off_at"].(string); got != "2026-07-05T12:05:00Z" {
		t.Fatalf("shuttle.runtime.handed_off_at = %q, want %q", got, "2026-07-05T12:05:00Z")
	}
}

// TestShuttleMarkRuntime_ClaimMeetingArgv locks in the claim-time write of a
// meeting capture, which stamps the recording's launch id beside the session:
//
//	shuttle mark-runtime <fiber_id> --dispatched-at <ts> --session <uuid> --meeting <launch>
func TestShuttleMarkRuntime_ClaimMeetingArgv(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	ownHost(t, env, "candide")

	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "candide",
	}, nil)

	out, err := runIn(t, env, dir, "mark-runtime", "f",
		"--dispatched-at", "2026-09-27T20:14:55Z",
		"--session", "sess-abc-123",
		"--meeting", "launch-xyz",
	)
	if err != nil {
		t.Fatalf("mark-runtime with a meeting claim's argv must succeed: %v\n%s", err, out)
	}

	rt := shuttleRuntimeMap(t, mustRead(t, storage, "f"))
	if got, _ := rt["meeting"].(string); got != "launch-xyz" {
		t.Fatalf("shuttle.runtime.meeting = %q, want %q", got, "launch-xyz")
	}
}

// A dispatch guard compares wire stamps exactly, including an absent stamp.
func TestShuttleMarkRuntime_IfDispatchedAt(t *testing.T) {
	t.Parallel()
	for _, current := range []string{"", "2026-10-23T02:35:11.000Z"} {
		for _, expected := range []string{"", "2026-10-23T02:35:11.000Z", "2026-10-23T02:35:11Z"} {
			t.Run(current+"/"+expected, func(t *testing.T) {
				t.Parallel()
				env := testEnv(t)
				dir, st := newStore(t)
				seedShuttleRole(t, st, "source", felt.StatusActive, oneshot(), nil)
				f := mustRead(t, st, "source")
				if current != "" {
					if err := shuttle.SetRuntimeField(f, "dispatched_at", current); err != nil {
						t.Fatal(err)
					}
					if err := st.Write(f); err != nil {
						t.Fatal(err)
					}
				}
				before, err := os.ReadFile(f.Path)
				if err != nil {
					t.Fatal(err)
				}
				_, err = runIn(t, env, dir, "mark-runtime", f.UID, "--handed-off-at", "2026-10-23T03:00:00Z", "--if-dispatched-at", expected)
				if current == expected {
					if err != nil {
						t.Fatal(err)
					}
					if shuttleRuntimeMap(t, mustRead(t, st, "source"))["handed_off_at"] != "2026-10-23T03:00:00Z" {
						t.Fatal("guarded handoff not stamped")
					}
				} else {
					if err == nil || !strings.Contains(err.Error(), "dispatched_at mismatch") {
						t.Fatalf("mismatch error: %v", err)
					}
					after, err := os.ReadFile(f.Path)
					if err != nil || !bytes.Equal(before, after) {
						t.Fatalf("mismatch changed document: %v", err)
					}
				}
			})
		}
	}
}

func TestShuttleMarkRuntime_GuardReloadsUnderWriteLock(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "source", felt.StatusActive, oneshot(), nil)
	f := mustRead(t, st, "source")
	if err := shuttle.SetRuntimeField(f, "dispatched_at", "old"); err != nil {
		t.Fatal(err)
	}
	if err := st.Write(f); err != nil {
		t.Fatal(err)
	}
	unlock, err := st.LockFiber("source")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	done := make(chan error, 1)
	go func() {
		_, err := runIn(t, env, dir, "mark-runtime", f.UID, "--handed-off-at", "exit", "--if-dispatched-at", "old")
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("guarded write bypassed held lock: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := shuttle.SetRuntimeField(f, "dispatched_at", "new"); err != nil {
		t.Fatal(err)
	}
	if err := st.Write(f); err != nil {
		t.Fatal(err)
	}
	if err := unlock(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "dispatched_at mismatch") {
			t.Fatalf("stale guard: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("guarded write did not finish")
	}
	runtime := shuttleRuntimeMap(t, mustRead(t, st, "source"))
	if runtime["dispatched_at"] != "new" || runtime["handed_off_at"] != nil {
		t.Fatalf("guard overwrote concurrent dispatch: %+v", runtime)
	}
}

// The claimed pane binding is one more runtime field; an empty value clears it.
func TestShuttleMarkRuntime_Pane(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	dir, st := newStore(t)
	seedShuttleRole(t, st, "claimed", felt.StatusActive, oneshot(), nil)
	f := mustRead(t, st, "claimed")
	if _, err := runIn(t, env, dir, "mark-runtime", f.UID, "--pane", "4242:1700000000.12"); err != nil {
		t.Fatal(err)
	}
	if got := shuttleRuntimeMap(t, mustRead(t, st, "claimed"))["pane"]; got != "4242:1700000000.12" {
		t.Fatalf("pane = %v", got)
	}
	if _, err := runIn(t, env, dir, "mark-runtime", f.UID, "--pane", ""); err != nil {
		t.Fatal(err)
	}
	if got, ok := shuttleRuntimeMap(t, mustRead(t, st, "claimed"))["pane"]; ok {
		t.Fatalf("empty --pane must clear the binding, got %v", got)
	}
}

// TestShuttleMarkRuntime_AliasGuardWithoutOverride proves the negative: without
// --host, ambient own-host resolution alone (via the host file, daemon still
// down) drives the ownership guard, so a fiber owned by a DIFFERENT host is
// refused rather than silently landing on the wrong daemon's mirror.
func TestShuttleMarkRuntime_AliasGuardWithoutOverride(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	env.Set("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	ownHost(t, env, "candide")

	dir, storage := newStore(t)
	seedShuttleRole(t, storage, "remote", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "cineca",
	}, nil)

	_, err := runIn(t, env, dir, "mark-runtime", "remote", "--dispatched-at", "2026-07-05T12:00:00Z")
	if err == nil {
		t.Fatal("mark-runtime with ambient own-host candide on a cineca-owned fiber must be refused")
	}
	if _, ok := err.(ownerMismatchError); !ok {
		t.Fatalf("expected ownerMismatchError, got %T: %v", err, err)
	}
}
