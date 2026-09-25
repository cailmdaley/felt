package cmd

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const hostFixtureDir = "../daemon/test/fixtures/host"

type hostFixtureCase struct {
	Name   string            `json:"name"`
	File   *string           `json:"file"`
	Env    map[string]string `json:"env"`
	Expect struct {
		Class        string `json:"class"`
		ClassSource  string `json:"class_source"`
		Listen       string `json:"listen"`
		ListenSource string `json:"listen_source"`
		Error        string `json:"error"`
	} `json:"expect"`
}

// setHostEnv isolates one resolution: the fixture's base env, then the case's
// overrides, with every other input unset.
func setHostEnv(t *testing.T, file string, base, env map[string]string) {
	t.Helper()
	for _, k := range []string{"SHUTTLE_LISTEN", "SHUTTLE_PORT", "SHUTTLE_DATA_DIR", "SHUTTLE_DAEMON_URL"} {
		t.Setenv(k, "")
	}
	for k, v := range base {
		t.Setenv(k, v)
	}
	for k, v := range env {
		t.Setenv(k, v)
	}
	t.Setenv("FELT_HOST_FILE", file)
}

// TestHostFixtureParity — the Go reader reproduces every case the daemon's
// reader must also reproduce.
func TestHostFixtureParity(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(hostFixtureDir, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		BaseEnv map[string]string `json:"base_env"`
		Cases   []hostFixtureCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("expected.json listed no cases")
	}
	for _, tc := range doc.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "absent.json")
			if tc.File != nil {
				file, _ = filepath.Abs(filepath.Join(hostFixtureDir, *tc.File))
			}
			setHostEnv(t, file, doc.BaseEnv, tc.Env)
			got, err := resolveHostSettings()
			if tc.Expect.Error != "" {
				if err == nil {
					t.Fatalf("want %s error, resolved %+v", tc.Expect.Error, got)
				}
				if !isHostConfigError(err, tc.Expect.Error) {
					t.Fatalf("want %s error, got %v", tc.Expect.Error, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolve: %v", err)
			}
			if got.Class != tc.Expect.Class || got.ClassSource != tc.Expect.ClassSource ||
				got.Listen != tc.Expect.Listen || got.ListenSource != tc.Expect.ListenSource {
				t.Fatalf("got {%s %s %s %s}, want %+v", got.Class, got.ClassSource, got.Listen, got.ListenSource, tc.Expect)
			}
		})
	}
}

// TestHostFixtureParity_CoversEveryInput — an input file no case reads is a
// case someone meant to write.
func TestHostFixtureParity_CoversEveryInput(t *testing.T) {
	data, _ := os.ReadFile(filepath.Join(hostFixtureDir, "expected.json"))
	var doc struct {
		Cases []hostFixtureCase `json:"cases"`
	}
	_ = json.Unmarshal(data, &doc)
	used := map[string]bool{"expected.json": true}
	for _, tc := range doc.Cases {
		if tc.File != nil {
			used[*tc.File] = true
		}
	}
	entries, _ := os.ReadDir(hostFixtureDir)
	for _, e := range entries {
		if !used[e.Name()] {
			t.Errorf("fixture %s is read by no case", e.Name())
		}
	}
}

func TestWriteHostClass_PreservesKeysAndMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg", "host.json")
	setHostEnv(t, path, map[string]string{"SHUTTLE_DATA_DIR": "/srv/shuttle-fixture"}, nil)

	if _, err := writeHostClass(hostClassShared); err != nil {
		t.Fatalf("write to absent file: %v", err)
	}
	if err := os.WriteFile(path, []byte(`{"class":"single-user","listen":"unix:///srv/x.sock","note":{"kept":true}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := writeHostClass(hostClassExposed); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
	var doc map[string]any
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["class"] != "exposed" || doc["listen"] != "unix:///srv/x.sock" {
		t.Errorf("doc = %v", doc)
	}
	if note, _ := doc["note"].(map[string]any); note["kept"] != true {
		t.Errorf("unknown key lost: %v", doc)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("temp file left behind: %v", entries)
	}
}

func TestWriteHostClass_Refusals(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.json")
	setHostEnv(t, path, nil, nil)
	if _, err := writeHostClass("shared"); !isHostConfigError(err, hostErrBadClass) {
		t.Errorf("bad class: err = %v", err)
	}
	if err := os.WriteFile(path, []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := writeHostClass(hostClassShared); !isHostConfigError(err, hostErrMalformed) {
		t.Errorf("malformed file must be refused, not overwritten: err = %v", err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != "{nope" {
		t.Errorf("malformed file was rewritten: %q", raw)
	}
}

func TestResolveHostSettings_NonStringKeyIsMalformed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.json")
	setHostEnv(t, path, nil, nil)
	_ = os.WriteFile(path, []byte(`{"class": 3}`), 0o600)
	if _, err := resolveHostSettings(); !isHostConfigError(err, hostErrMalformed) {
		t.Errorf("err = %v", err)
	}
}

func TestDaemonURL_FollowsListen(t *testing.T) {
	setHostEnv(t, filepath.Join(t.TempDir(), "absent.json"), nil, map[string]string{"SHUTTLE_PORT": "4100"})
	check := func(label, want string) {
		t.Helper()
		got, err := daemonURL()
		if err != nil || got != want {
			t.Errorf("%s: daemonURL = %q, %v; want %q", label, got, err, want)
		}
	}
	check("tcp", "http://127.0.0.1:4100")
	t.Setenv("SHUTTLE_LISTEN", "unix:///srv/shuttle-fixture/sock/daemon.sock")
	check("unix", "http://shuttle.invalid")
	t.Setenv("SHUTTLE_DAEMON_URL", "http://127.0.0.1:9")
	check("override", "http://127.0.0.1:9")
}

func mustDaemonEndpoint(t *testing.T, path string) string {
	t.Helper()
	endpoint, err := daemonEndpoint(path)
	if err != nil {
		t.Fatalf("daemonEndpoint: %v", err)
	}
	return endpoint
}

// TestGetDaemon_DialsUnixSocket — with a unix listener every daemon verb goes
// through the socket: the synthetic base URL plus a path reaches the server,
// and an $HTTP_PROXY does not capture it.
func TestGetDaemon_DialsUnixSocket(t *testing.T) {
	// /tmp, not t.TempDir(): macOS temp paths alone approach the 104-byte
	// sun_path limit.
	dir, err := os.MkdirTemp("/tmp", "felt-sock-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "d.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The daemon's CORS plug admits only loopback authorities, so the
		// wire Host must be localhost, not the synthetic socket host.
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "http://localhost:4077/api/v1/state", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("host=" + r.Host + " path=" + r.URL.Path + " q=" + r.URL.RawQuery))
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })

	setHostEnv(t, filepath.Join(dir, "absent.json"), nil, map[string]string{"SHUTTLE_LISTEN": "unix://" + sock})
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9")

	body, err := getDaemon(mustDaemonEndpoint(t, "/api/v1/state?x=1"), daemonReadTimeout)
	if err != nil {
		t.Fatalf("getDaemon: %v", err)
	}
	if got := string(body); got != "host=localhost path=/api/v1/state q=x=1" {
		t.Errorf("body = %q", got)
	}
	if _, err := postDaemon(mustDaemonEndpoint(t, "/api/v1/dispatch"), []byte("{}"), daemonPostTimeout); err != nil {
		t.Errorf("postDaemon: %v", err)
	}
	// A redirect — relative or absolute — is refused rather than followed off
	// the socket.
	if _, err := getDaemon(mustDaemonEndpoint(t, "/redirect"), daemonReadTimeout); err == nil || !strings.Contains(err.Error(), "never redirects") || !strings.Contains(err.Error(), "localhost:4077") {
		t.Errorf("redirect: err = %v; want a refusal", err)
	}
}

// TestDaemonURL_BrokenHostFileFailsLoud — a host file that does not resolve
// is an error naming the file, never a URL, and never a transport error: the
// lifecycle verbs answer "daemon unreachable" with a local write, and a
// malformed operator file must not take that path.
func TestDaemonURL_BrokenHostFileFailsLoud(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.json")
	setHostEnv(t, path, nil, nil)
	for _, body := range []string{`{"class":"shared"}`, `{nope`, `{"listen":"tcp://0.0.0.0:4000"}`} {
		_ = os.WriteFile(path, []byte(body), 0o600)
		url, err := daemonURL()
		if err == nil || url != "" {
			t.Fatalf("%s: daemonURL = %q, %v; want an error", body, url, err)
		}
		if !strings.Contains(err.Error(), path) {
			t.Errorf("%s: error %q does not name %s", body, err, path)
		}
		if isLifecycleTransportError(err) {
			t.Errorf("%s: error %q reads as a transport error", body, err)
		}
	}
	t.Setenv("SHUTTLE_LISTEN", "tcp://10.0.0.5:4000")
	if _, err := daemonURL(); err == nil || !strings.Contains(err.Error(), "SHUTTLE_LISTEN") || isLifecycleTransportError(err) {
		t.Errorf("env listener: err = %v", err)
	}
}

// TestPostLifecycle_BrokenHostFileDoesNotFallBack — the lifecycle hop, whose
// transport errors trigger a local write, surfaces the host file error.
func TestPostLifecycle_BrokenHostFileDoesNotFallBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.json")
	setHostEnv(t, path, nil, nil)
	t.Setenv("SHUTTLE_LIFECYCLE_OFFLINE", "")
	_ = os.WriteFile(path, []byte(`{"class":"shared"}`), 0o600)
	_, err := postLifecycle("resume", map[string]any{"fiber": "x"})
	if err == nil || isLifecycleTransportError(err) || !strings.Contains(err.Error(), path) {
		t.Fatalf("err = %v", err)
	}
}
