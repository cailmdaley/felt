package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

// withOwnHost points the CLI's daemon-state lookup at a stub returning hostID so
// resolveOwnHost (and thus ensureOwnedHere) resolves deterministically,
// independent of any real daemon running on the test machine. Shared by the
// foundation and lifecycle/create verb tests.
func withOwnHost(t *testing.T, hostID string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/state" {
			_ = json.NewEncoder(w).Encode(map[string]any{"host": hostID})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("SHUTTLE_DAEMON_URL", srv.URL)
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
	withOwnHost(t, "daemonhost")

	// Explicit flag wins over everything.
	if got, err := resolveOwnHost("flaghost"); err != nil || got != "flaghost" {
		t.Fatalf("flag should win: got %q err %v", got, err)
	}
	// No flag → the daemon's own_host_id from the stub.
	if got, err := resolveOwnHost(""); err != nil || got != "daemonhost" {
		t.Fatalf("daemon host should resolve: got %q err %v", got, err)
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
