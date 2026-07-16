package cmd

import (
	"strings"
	"testing"
)

// TestShuttleReshape_FailedReshapeLeavesBlockIntact is the load-bearing
// atomicity guarantee: a --reshape whose project_dir can't resolve must fail
// BEFORE the single write, leaving the original block untouched — never the
// old uninstall+pin hazard where a failed second write stranded a de-pinned
// fiber.
func TestShuttleReshape_FailedReshapeLeavesBlockIntact(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_HOST", "testhost")
	dir, storage := newShuttleStore(t)
	pdir := t.TempDir()
	seedPlainFiber(t, storage, "role", "open")

	if out, err := runCommand(t, dir, "shuttle", "pin", "role", "--host", "testhost", "--project-dir", pdir); err != nil {
		t.Fatalf("pin: %v\n%s", err, out)
	}

	// Reshape with a non-existent project dir → must fail.
	out, err := runCommand(t, dir, "shuttle", "pin", "role", "--reshape", "--model", "claude-opus", "--project-dir", "/no/such/dir")
	if err == nil {
		t.Fatalf("reshape with bad project dir should fail; out=%s", out)
	}

	// The original pinned block must survive intact — same project_dir, no agent.
	b, ok, err := mustRead(t, storage, "role").ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("block gone after failed reshape: ok=%v err=%v", ok, err)
	}
	if b.Kind != "pinned" || b.ProjectDir != pdir || b.Agent != "" {
		t.Fatalf("failed reshape mutated the block: %+v", b)
	}
}

// TestShuttleReshape_RefusedWithoutFlag keeps the no-clobber default: pin over
// an existing block without --reshape errors and points at the flag.
func TestShuttleReshape_RefusedWithoutFlag(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_HOST", "testhost")
	dir, storage := newShuttleStore(t)
	pdir := t.TempDir()
	seedPlainFiber(t, storage, "role", "open")
	if out, err := runCommand(t, dir, "shuttle", "pin", "role", "--host", "testhost", "--project-dir", pdir); err != nil {
		t.Fatalf("pin: %v\n%s", err, out)
	}
	out, err := runCommand(t, dir, "shuttle", "pin", "role", "--host", "testhost", "--project-dir", pdir)
	if err == nil {
		t.Fatalf("re-pin without --reshape should refuse; out=%s", out)
	}
	if !strings.Contains(err.Error(), "--reshape") {
		t.Fatalf("refusal should point at --reshape; err=%v", err)
	}
}

// TestShuttleReshape_EchoesAndPreservesRuntime: a successful reshape that omits
// model/host/project_dir echoes them from the old block, and preserves the
// daemon-owned runtime keys (session_uuid) that uninstall+pin would have lost.
func TestShuttleReshape_EchoesAndPreservesRuntime(t *testing.T) {
	defer saveShuttleGlobals()()
	t.Setenv("SHUTTLE_HOST", "testhost")
	dir, storage := newShuttleStore(t)
	pdir := t.TempDir()
	seedShuttleRole(t, storage, "role", "open", map[string]any{
		"kind":        "pinned",
		"host":        "testhost",
		"project_dir": pdir,
		"agent":       "claude-sonnet",
		"runtime":     map[string]any{"session_uuid": "deadbeef-1234"},
	}, nil)

	// Reshape to standing, omitting project_dir/host — both must echo.
	out, err := runCommand(t, dir, "shuttle", "repeat", "role", "--reshape", "--schedule", "0 9 * * 1-5", "--tz", "Europe/Paris")
	if err != nil {
		t.Fatalf("reshape repeat: %v\n%s", err, out)
	}
	f := mustRead(t, storage, "role")
	b, ok, err := f.ShuttleBlock()
	if err != nil || !ok {
		t.Fatalf("ShuttleBlock: ok=%v err=%v", ok, err)
	}
	if b.Kind != "standing" || b.ProjectDir != pdir || b.Host != "testhost" {
		t.Fatalf("reshape did not echo fields: %+v", b)
	}
	if b.Agent != "claude-sonnet" {
		t.Fatalf("reshape should inherit agent, got %q", b.Agent)
	}
	raw, err := f.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(raw), "deadbeef-1234") {
		t.Fatalf("reshape lost the runtime session_uuid:\n%s", raw)
	}
}
