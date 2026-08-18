package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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

// TestResolveOwnHost_HostnameNormalized locks in the shared normalization of
// the OS-hostname tier: lowercased and truncated at the first ".". This is the
// half of the split-identity bug that lived in Go — os.Hostname() reported
// "Studio-Air.home" where the daemon's :inet.gethostname() reported the
// short name, so the CLI stamped a host the daemon would never match.
func TestResolveOwnHost_HostnameNormalized(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "")
	t.Setenv("SHUTTLE_HOST_FILE", filepath.Join(t.TempDir(), "host"))

	prev := osHostname
	osHostname = func() (string, error) { return "  Studio-Air.home  ", nil }
	t.Cleanup(func() { osHostname = prev })

	got, err := resolveOwnHost("")
	if err != nil {
		t.Fatalf("resolveOwnHost: %v", err)
	}
	if got != "studio-air" {
		t.Fatalf("expected normalized short name, got %q", got)
	}
}

// TestResolveOwnHost_HostnameSeedsFile is the fix's core invariant: the OS
// hostname is consulted ONCE, then written to the host-config file so every
// later resolve — on either side of the CLI/daemon split — reads a value that
// cannot drift with DHCP or with which runtime asks.
func TestResolveOwnHost_HostnameSeedsFile(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "")
	path := filepath.Join(t.TempDir(), "host")
	t.Setenv("SHUTTLE_HOST_FILE", path)

	prev := osHostname
	osHostname = func() (string, error) { return "Studio-Air.home", nil }
	t.Cleanup(func() { osHostname = prev })

	if got, err := resolveOwnHost(""); err != nil || got != "studio-air" {
		t.Fatalf("first resolve: got %q err %v", got, err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("host file should have been seeded: %v", err)
	}
	if strings.TrimSpace(string(data)) != "studio-air" {
		t.Fatalf("seeded contents: %q", string(data))
	}

	// Second resolve must come from the file, not the hostname syscall.
	osHostname = func() (string, error) { return "renamed-by-dhcp.local", nil }
	if got, err := resolveOwnHost(""); err != nil || got != "studio-air" {
		t.Fatalf("second resolve should read the seeded file: got %q err %v", got, err)
	}
}

// TestResolveOwnHost_SeedNeverCreatesDirectory: the seed writes into a parent
// that already exists and never creates one. The existence of ~/.shuttle is
// the gate that decides whether this machine keeps an event stream and a commit
// ledger (shuttleSink), and resolveOwnHost runs inside `felt hook event`
// upstream of that gate — so an mkdir here would turn a felt-only machine into
// a shuttle host on its first hook.
func TestResolveOwnHost_SeedNeverCreatesDirectory(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "")
	dir := filepath.Join(t.TempDir(), "dot-shuttle")
	t.Setenv("SHUTTLE_HOST_FILE", filepath.Join(dir, "host"))

	prev := osHostname
	osHostname = func() (string, error) { return "Studio-Air.home", nil }
	t.Cleanup(func() { osHostname = prev })

	if got, err := resolveOwnHost(""); err != nil || got != "studio-air" {
		t.Fatalf("resolve must still succeed without seeding: got %q err %v", got, err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("seed must not create the state directory (stat err: %v)", err)
	}
}

// TestResolveOwnHost_EnvDoesNotSeed: SHUTTLE_HOST is the explicit override and
// the test seam, not an identity to make durable. Seeding from it would let a
// one-off `SHUTTLE_HOST=x felt ...` permanently rename the machine.
func TestResolveOwnHost_EnvDoesNotSeed(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "envhost")
	path := filepath.Join(t.TempDir(), "host")
	t.Setenv("SHUTTLE_HOST_FILE", path)

	if got, err := resolveOwnHost(""); err != nil || got != "envhost" {
		t.Fatalf("env tier: got %q err %v", got, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("SHUTTLE_HOST must not seed the host file (stat err: %v)", err)
	}
}

// TestResolveOwnHost_UnwritableSeedStillResolves: the seed is best-effort. A
// read-only home (a container, a locked-down machine) must still get a working
// identity, just an ephemeral one.
func TestResolveOwnHost_UnwritableSeedStillResolves(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "")
	// A path whose parent is a FILE: MkdirAll and WriteFile both fail.
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("writing blocker: %v", err)
	}
	t.Setenv("SHUTTLE_HOST_FILE", filepath.Join(blocker, "host"))

	prev := osHostname
	osHostname = func() (string, error) { return "Somewhere.Local", nil }
	t.Cleanup(func() { osHostname = prev })

	if got, err := resolveOwnHost(""); err != nil || got != "somewhere" {
		t.Fatalf("unwritable seed must not break resolution: got %q err %v", got, err)
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

// TestOwnerMismatchNamesItsSource: the mismatch message tells the user where
// this machine's name came from so its advice — "if both names are THIS
// machine, edit that source" — points at something editing which changes the
// answer. Naming the host file while $SHUTTLE_HOST overrides it sends them to
// change a value nothing reads.
func TestOwnerMismatchNamesItsSource(t *testing.T) {
	fiber := func() *felt.Felt {
		return shuttleFeltWithBlock(t, map[string]any{"kind": "oneshot", "host": "cineca"})
	}

	t.Run("file tier names the file", func(t *testing.T) {
		withOwnHost(t, "macbook")
		msg := ensureOwnedHere(fiber(), "f").Error()
		if !strings.Contains(msg, hostConfigFilePath()) {
			t.Fatalf("file-sourced identity should name the file: %s", msg)
		}
	})

	t.Run("env tier names the env var", func(t *testing.T) {
		withOwnHost(t, "macbook")
		t.Setenv("SHUTTLE_HOST", "laptop")
		msg := ensureOwnedHere(fiber(), "f").Error()
		if !strings.Contains(msg, "$SHUTTLE_HOST") {
			t.Fatalf("env-sourced identity should name the env var: %s", msg)
		}
		if strings.Contains(msg, hostConfigFilePath()) {
			t.Fatalf("env-sourced identity must not blame the overridden file: %s", msg)
		}
	})
}

// TestEnsureOwnedHere_UnresolvableIdentityFailsLoud is the S3 lock-in: when a
// fiber DOES carry an owner (block.host non-empty) but own-host resolution
// itself fails — every tier of resolveOwnHost's precedence empty/absent — the
// guard must refuse the write rather than silently falling through. Post-S1,
// resolution is pure local state, so a failure here means something is
// genuinely broken (not "daemon briefly unreachable", the pre-S1 excuse for
// fail-open).
func TestEnsureOwnedHere_UnresolvableIdentityFailsLoud(t *testing.T) {
	t.Setenv("SHUTTLE_HOST", "")
	t.Setenv("SHUTTLE_HOST_FILE", filepath.Join(t.TempDir(), "does-not-exist"))

	prevHostname := osHostname
	osHostname = func() (string, error) { return "", fmt.Errorf("forced failure: no OS hostname") }
	t.Cleanup(func() { osHostname = prevHostname })

	fiber := shuttleFeltWithBlock(t, map[string]any{"kind": "oneshot", "host": "candide"})
	err := ensureOwnedHere(fiber, "f")
	if err == nil {
		t.Fatal("unresolvable own-host identity against an owned fiber must refuse the write, not fall through")
	}
	if _, ok := err.(ownerMismatchError); ok {
		t.Fatalf("expected a wrapped resolution error, not ownerMismatchError: %v", err)
	}
	if !strings.Contains(err.Error(), "cannot verify fiber") {
		t.Fatalf("error should explain resolution failure, got: %v", err)
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
