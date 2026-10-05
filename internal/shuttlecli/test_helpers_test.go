package shuttlecli

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/cailmdaley/felt/internal/sysenv"
)

func mustParseTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return parsed
}

func newStore(t *testing.T) (string, *felt.Storage) {
	t.Helper()
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return dir, storage
}

// seedFiber writes a fiber straight through storage, bypassing the cmd-layer
// validation — so a deliberately invalid block can be planted on disk.
func seedFiber(t *testing.T, storage *felt.Storage, id, uid, status string, block map[string]any, tempered *bool) {
	t.Helper()
	f := &felt.Felt{ID: id, UID: uid, Name: id, Status: status, CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if block != nil {
		if err := f.SetExtraField("shuttle", block); err != nil {
			t.Fatalf("SetExtraField shuttle: %v", err)
		}
	}
	if tempered != nil {
		if err := f.SetExtraField("tempered", *tempered); err != nil {
			t.Fatalf("SetExtraField tempered: %v", err)
		}
	}
	if err := storage.Write(f); err != nil {
		t.Fatalf("Write %s: %v", id, err)
	}
}

// seedShuttleRole seeds a fiber carrying a shuttle: block plus the requested
// felt-native status and optional tempered verdict.
func seedShuttleRole(t *testing.T, storage *felt.Storage, id, status string, block map[string]any, tempered *bool) {
	t.Helper()
	seedFiber(t, storage, id, "", status, block, tempered)
}

func mustRead(t *testing.T, storage *felt.Storage, id string) *felt.Felt {
	t.Helper()
	f, err := storage.Read(id)
	if err != nil {
		t.Fatalf("Read %s: %v", id, err)
	}
	return f
}

func oneshot() map[string]any {
	return map[string]any{"kind": "oneshot", "agent": "claude-opus", "project_dir": "/srv/work"}
}

// seedPlainFiber writes a pure note (no shuttle: block) with the given status, so
// the create verbs have a fiber to attach a block to.
func seedPlainFiber(t *testing.T, storage *felt.Storage, id, status string) {
	t.Helper()
	seedFiber(t, storage, id, "", status, nil, nil)
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

// shuttleRuntimeMap decodes the fiber's shuttle.runtime sub-mapping into a
// plain map for assertions, mirroring the nested-write contract
// shuttle.SetRuntimeField establishes that runtime fields live under
// shuttle.runtime, never as flat shuttle siblings.
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

// writeRemotesIn writes body as env's fleet file.
func writeRemotesIn(t testing.TB, env *sysenv.Env, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "remotes.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	env.Set("SHUTTLE_REMOTES_FILE", path)
	return path
}

func shortPrivateTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "td-private-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// ownHost seeds env's host identity through a host file, so resolveOwnHost
// (and thus ensureOwnedHere) answers hostID whatever the machine's own
// hostname or ambient SHUTTLE_HOST.
func ownHost(t testing.TB, env *sysenv.Env, hostID string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "host")
	if err := os.WriteFile(path, []byte(hostID+"\n"), 0o644); err != nil {
		t.Fatalf("writing host file: %v", err)
	}
	env.Set("SHUTTLE_HOST", "")
	env.Set("SHUTTLE_HOST_FILE", path)
}

// serveDaemon starts handler as a fake daemon and points env's
// SHUTTLE_DAEMON_URL at it; the server closes when the test ends.
func serveDaemon(t testing.TB, env *sysenv.Env, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	env.Set("SHUTTLE_DAEMON_URL", server.URL)
	return server
}

// setHostEnvIn points env at the host config file and the listener and data
// variables the host resolver reads: blank first, then base, then overrides.
func setHostEnvIn(t testing.TB, env *sysenv.Env, file string, base, overrides map[string]string) {
	t.Helper()
	for _, k := range []string{"SHUTTLE_LISTEN", "SHUTTLE_PORT", "SHUTTLE_DATA_DIR", "SHUTTLE_DAEMON_URL"} {
		env.Set(k, "")
	}
	for k, v := range base {
		env.Set(k, v)
	}
	for k, v := range overrides {
		env.Set(k, v)
	}
	env.Set("SHUTTLE_HOST_CONFIG_FILE", file)
}
