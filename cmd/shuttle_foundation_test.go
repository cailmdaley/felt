package cmd

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// withOwnHost seeds identity via a host file (SHUTTLE_HOST_FILE) so
// resolveOwnHost (and thus ensureOwnedHere) resolves deterministically to
// hostID, independent of any real daemon, env var, or OS hostname on the test
// machine. Shared by the foundation and lifecycle/create verb tests.
func withOwnHost(t *testing.T, hostID string) {
	t.Helper()
	t.Setenv("SHUTTLE_HOST", "") // guard against ambient env leaking into the test
	dir := t.TempDir()
	path := filepath.Join(dir, "host")
	if err := os.WriteFile(path, []byte(hostID+"\n"), 0o644); err != nil {
		t.Fatalf("writing host file: %v", err)
	}
	t.Setenv("SHUTTLE_HOST_FILE", path)
}

// shuttleFeltWithBlock builds an in-memory fiber carrying a shuttle: block, for
// unit tests that exercise a helper directly (not through a command).
func shuttleFeltWithBlock(t *testing.T, block map[string]any) *felt.Felt {
	t.Helper()
	f, err := felt.New("test-fiber", "Test Fiber")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if block != nil {
		if err := f.SetExtraField("shuttle", block); err != nil {
			t.Fatalf("SetExtraField: %v", err)
		}
	}
	return f
}

func TestResolveOwnHost_Precedence(t *testing.T) {
	withOwnHost(t, "filehost")
	t.Setenv("SHUTTLE_HOST", "envhost")

	// Explicit flag wins over everything.
	if got, err := resolveOwnHost("flaghost"); err != nil || got != "flaghost" {
		t.Fatalf("flag should win: got %q err %v", got, err)
	}
	// No flag → SHUTTLE_HOST env wins over the host file.
	if got, err := resolveOwnHost(""); err != nil || got != "envhost" {
		t.Fatalf("env should win over host file: got %q err %v", got, err)
	}
}

// TestResolveOwnHost_EnvBeatsFile locks in that SHUTTLE_HOST takes precedence
// over the ~/.shuttle/host file, mirroring the Elixir daemon's own_host_id.
func TestResolveOwnHost_EnvBeatsFile(t *testing.T) {
	withOwnHost(t, "filehost")
	t.Setenv("SHUTTLE_HOST", "envhost")

	if got, err := resolveOwnHost(""); err != nil || got != "envhost" {
		t.Fatalf("env should beat file: got %q err %v", got, err)
	}
}

// TestResolveOwnHost_FileBeatsHostname locks in that the host file wins over
// os.Hostname() when no flag or env var is set — the offline-correct path
// that keeps a machine's friendly alias (e.g. candide) stable regardless of
// its OS-reported hostname (e.g. c03).
func TestResolveOwnHost_FileBeatsHostname(t *testing.T) {
	withOwnHost(t, "candide")

	got, err := resolveOwnHost("")
	if err != nil {
		t.Fatalf("resolveOwnHost: %v", err)
	}
	if got != "candide" {
		t.Fatalf("host file should beat os.Hostname(): got %q", got)
	}
	if osHost, _ := os.Hostname(); got == osHost {
		t.Fatalf("test is not exercising the file-vs-hostname distinction (file value %q equals os.Hostname())", got)
	}
}

// TestResolveOwnHost_DaemonDown_HostFileOnly is the keystone lock-in: with no
// daemon reachable at all (SHUTTLE_DAEMON_URL pointed at a closed port) and
// identity seeded ONLY via the host file, resolveOwnHost must still resolve —
// proving the resolution path never round-trips to the daemon. It then drives
// ensureOwnedHere end-to-end: a fiber whose shuttle block names this same host
// as owner is writable with no daemon involved.
func TestResolveOwnHost_DaemonDown_HostFileOnly(t *testing.T) {
	// An unroutable/closed local port: nothing is listening, so any accidental
	// round-trip to the daemon would fail loudly (dial refused) rather than
	// silently succeeding and masking the bug this test guards against.
	t.Setenv("SHUTTLE_DAEMON_URL", "http://127.0.0.1:1")
	t.Setenv("SHUTTLE_HOST", "")

	dir := t.TempDir()
	path := filepath.Join(dir, "host")
	if err := os.WriteFile(path, []byte("candide\n"), 0o644); err != nil {
		t.Fatalf("writing host file: %v", err)
	}
	t.Setenv("SHUTTLE_HOST_FILE", path)

	got, err := resolveOwnHost("")
	if err != nil {
		t.Fatalf("resolveOwnHost with daemon down: %v", err)
	}
	if got != "candide" {
		t.Fatalf("expected host-file identity %q, got %q", "candide", got)
	}

	fiber := shuttleFeltWithBlock(t, map[string]any{"kind": "oneshot", "host": "candide"})
	if err := ensureOwnedHere(fiber, "f"); err != nil {
		t.Fatalf("ownership-guarded local write should succeed with daemon down and host-file identity: %v", err)
	}
}

func TestEnsureOwnedHere(t *testing.T) {
	withOwnHost(t, "macbook")

	mk := func(host string) *felt.Felt {
		return shuttleFeltWithBlock(t, map[string]any{"kind": "oneshot", "host": host})
	}

	if err := ensureOwnedHere(mk("macbook"), "f"); err != nil {
		t.Fatalf("fiber owned by this host should pass: %v", err)
	}

	err := ensureOwnedHere(mk("cineca"), "f")
	if err == nil {
		t.Fatal("fiber owned by another host should be refused")
	}
	if _, ok := err.(ownerMismatchError); !ok {
		t.Fatalf("expected ownerMismatchError, got %T: %v", err, err)
	}

	if err := ensureOwnedHere(mk(""), "f"); err != nil {
		t.Fatalf("host-less block should fail open (legacy): %v", err)
	}
	if err := ensureOwnedHere(shuttleFeltWithBlock(t, nil), "f"); err != nil {
		t.Fatalf("pure note (no block) should pass: %v", err)
	}
}

func TestShuttleTmuxSessionNames(t *testing.T) {
	if got := shuttleTmuxSessionName("a/b/leaf", "01HXYZ"); got != "leaf-01HXYZ-shuttle" {
		t.Fatalf("canonical name: got %q", got)
	}
	if got := shuttleTmuxSessionName("a/b/leaf", ""); got != "leaf-shuttle" {
		t.Fatalf("legacy name (empty uid): got %q", got)
	}
	if got := shuttleTmuxSessionNames("leaf", "uid"); !reflect.DeepEqual(got, []string{"leaf-uid-shuttle", "leaf-shuttle"}) {
		t.Fatalf("dual-recognition names: got %v", got)
	}
	if got := shuttleTmuxSessionNames("leaf", ""); !reflect.DeepEqual(got, []string{"leaf-shuttle"}) {
		t.Fatalf("legacy-only names: got %v", got)
	}
}

func TestReadWriteTempered(t *testing.T) {
	f := shuttleFeltWithBlock(t, map[string]any{"kind": "oneshot"})
	if readTempered(f) != nil {
		t.Fatal("absent tempered must read as nil")
	}
	yes := true
	if err := setTempered(f, &yes); err != nil {
		t.Fatalf("setTempered true: %v", err)
	}
	if got := readTempered(f); got == nil || *got != true {
		t.Fatalf("tempered should read true, got %v", got)
	}
	if err := setTempered(f, nil); err != nil {
		t.Fatalf("setTempered nil: %v", err)
	}
	if readTempered(f) != nil {
		t.Fatal("cleared tempered must read as nil")
	}
}

func TestParseOptionalBool(t *testing.T) {
	if v, err := parseOptionalBool(""); err != nil || v != nil {
		t.Fatalf(`"" → nil/nil, got %v %v`, v, err)
	}
	if v, err := parseOptionalBool("true"); err != nil || v == nil || !*v {
		t.Fatalf(`"true" → *true, got %v %v`, v, err)
	}
	if v, err := parseOptionalBool("false"); err != nil || v == nil || *v {
		t.Fatalf(`"false" → *false, got %v %v`, v, err)
	}
	if _, err := parseOptionalBool("maybe"); err == nil {
		t.Fatal("invalid value must error")
	}
}

func TestResolveProjectDirFlag(t *testing.T) {
	dir := t.TempDir()
	if got, err := resolveProjectDirFlag(dir); err != nil || got != dir {
		t.Fatalf("existing dir should resolve: got %q err %v", got, err)
	}
	if _, err := resolveProjectDirFlag(""); err == nil {
		t.Fatal("empty project-dir must error")
	}
	if _, err := resolveProjectDirFlag(dir + "/does-not-exist"); err == nil {
		t.Fatal("nonexistent project-dir must error")
	}
	// A regular file is not a directory.
	file := dir + "/afile"
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := resolveProjectDirFlag(file); err == nil {
		t.Fatal("a file path must error (not a directory)")
	}
}
