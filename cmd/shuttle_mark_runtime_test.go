package cmd

import (
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// T1 — real-binary lock-in for the exact argv the Elixir daemon shells against
// `felt shuttle mark-runtime`. Daemon-side Elixir tests assert flags are SENT
// via a mock Runner; they stay green even if the real CLI rejects a flag (the
// exact skew that shipped 80ce7b3: a post-fix daemon shelling a pre-fix CLI
// that didn't know --host). These tests run the actual cobra command path
// (runCommand → rootCmd.Execute), not a mock, so a flag the daemon relies on
// but the CLI doesn't accept fails HERE.

// shuttleRuntimeMap decodes the fiber's shuttle.runtime sub-mapping into a
// plain map for assertions, mirroring the nested-write contract
// SetShuttleRuntimeField (internal/felt/shuttle.go) establishes: runtime
// fields live under shuttle.runtime, never as flat shuttle siblings.
func shuttleRuntimeMap(t *testing.T, f *felt.Felt) map[string]any {
	t.Helper()
	node, ok := f.ExtraFields["shuttle"]
	if !ok || node == nil {
		t.Fatalf("fiber %s carries no shuttle: block", f.ID)
	}
	var shuttle map[string]any
	if err := node.Decode(&shuttle); err != nil {
		t.Fatalf("decoding shuttle: block: %v", err)
	}
	rt, ok := shuttle["runtime"].(map[string]any)
	if !ok {
		t.Fatalf("shuttle.runtime missing or not a mapping: %#v", shuttle["runtime"])
	}
	return rt
}

// TestShuttleMarkRuntime_DaemonDispatchArgv locks in the exact argv
// Shuttle.Continuation.write_dispatch/4 shells (lib/shuttle/continuation.ex,
// the `mark_runtime/4` private helper, ~line 201-217):
//
//	felt shuttle mark-runtime <fiber_id> --dispatched-at <ts> --session <uuid> --run-id <run_id> --host <own_host_id>
//
// --host is always appended last, carrying the daemon's own_host_id so the
// ownership guard resolves locally instead of round-tripping to the (blocked)
// daemon. The daemon is DOWN here (unroutable SHUTTLE_DAEMON_URL) and identity
// is seeded only via the host file, proving mark-runtime never depends on a
// live daemon for either the flags themselves or the ownership check.
func TestShuttleMarkRuntime_DaemonDispatchArgv(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1") // closed port: any round-trip fails loudly
	withOwnHost(t, "candide")

	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "candide",
	}, nil)

	out, err := runCommand(t, dir, "shuttle", "mark-runtime", "f",
		"--dispatched-at", "2026-07-05T12:00:00Z",
		"--session", "sess-abc-123",
		"--run-id", "20260705T120000Z",
		"--host", "candide",
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
// Shuttle.Continuation.mark_handed_off/3 shells (lib/shuttle/continuation.ex,
// ~line 185-201) — the daemon-side conclude write after an accept/resume/rearm:
//
//	felt shuttle mark-runtime <fiber_id> --handed-off-at <ts> --host <own_host_id>
//
// Same daemon-down + host-file-only identity setup as the dispatch test.
func TestShuttleMarkRuntime_DaemonHandoffArgv(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	withOwnHost(t, "candide")

	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "f", felt.StatusActive, map[string]any{
		"kind": "standing", "agent": "claude-opus", "host": "candide",
	}, nil)

	out, err := runCommand(t, dir, "shuttle", "mark-runtime", "f",
		"--handed-off-at", "2026-07-05T12:05:00Z",
		"--host", "candide",
	)
	if err != nil {
		t.Fatalf("mark-runtime with the daemon's exact handoff argv must succeed: %v\n%s", err, out)
	}

	rt := shuttleRuntimeMap(t, mustRead(t, storage, "f"))
	if got, _ := rt["handed_off_at"].(string); got != "2026-07-05T12:05:00Z" {
		t.Fatalf("shuttle.runtime.handed_off_at = %q, want %q", got, "2026-07-05T12:05:00Z")
	}
}

// TestShuttleMarkRuntime_AliasGuardWithoutOverride proves the negative: without
// --host, ambient own-host resolution alone (via the host file, daemon still
// down) drives the ownership guard, so a fiber owned by a DIFFERENT host is
// refused rather than silently landing on the wrong daemon's mirror.
func TestShuttleMarkRuntime_AliasGuardWithoutOverride(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	withOwnHost(t, "candide")

	dir, storage := newShuttleStore(t)
	seedShuttleRole(t, storage, "remote", felt.StatusActive, map[string]any{
		"kind": "oneshot", "agent": "claude-opus", "host": "cineca",
	}, nil)

	_, err := runCommand(t, dir, "shuttle", "mark-runtime", "remote", "--dispatched-at", "2026-07-05T12:00:00Z")
	if err == nil {
		t.Fatal("mark-runtime with ambient own-host candide on a cineca-owned fiber must be refused")
	}
	if _, ok := err.(ownerMismatchError); !ok {
		t.Fatalf("expected ownerMismatchError, got %T: %v", err, err)
	}
}
