package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
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

// Negative control: remove check_tcp_owner from api_get and the refusal case reaches curl.
func TestBinShuttleChecksTCPOwnerBeforeCurl(t *testing.T) {
	for _, tc := range []struct {
		name      string
		failOwner bool
		wantErr   bool
		wantCalls string
	}{
		{"owner accepted", false, false, "host-json\ncheck-owner\ncurl\ncheck-owner\ncurl"},
		{"owner refused", true, true, "host-json\ncheck-owner"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			binDir := t.TempDir()
			calls := filepath.Join(t.TempDir(), "calls")
			felt := "#!/bin/sh\ncase \"$*\" in\n" +
				"  'shuttle host --json') echo host-json >> \"$CALLS\"; printf '%s\\n' '{\"listen\":\"tcp://127.0.0.1:4000\"}' ;;\n" +
				"  'shuttle host check-owner') echo check-owner >> \"$CALLS\"; [ \"${FAIL_OWNER:-0}\" = 0 ] ;;\n" +
				"  *) exit 2 ;;\nesac\n"
			if err := os.WriteFile(filepath.Join(binDir, "felt"), []byte(felt), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(binDir, "curl"), []byte("#!/bin/sh\necho curl >> \"$CALLS\"\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("CALLS", calls)
			if tc.failOwner {
				t.Setenv("FAIL_OWNER", "1")
			} else {
				t.Setenv("FAIL_OWNER", "0")
			}

			cmd := exec.Command("sh", "../bin/shuttle", "status")
			out, err := cmd.CombinedOutput()
			if (err != nil) != tc.wantErr {
				t.Fatalf("bin/shuttle status error = %v, output %q", err, out)
			}
			if tc.wantErr && !strings.Contains(string(out), "owner check failed") {
				t.Fatalf("owner refusal was not surfaced: %q", out)
			}
			gotCalls, err := os.ReadFile(calls)
			if err != nil {
				t.Fatal(err)
			}
			if strings.TrimSpace(string(gotCalls)) != tc.wantCalls {
				t.Fatalf("calls = %q, want %q", gotCalls, tc.wantCalls)
			}
		})
	}
}

func TestShuttleDeployChecksOwnerBeforeDaemonCall(t *testing.T) {
	script, err := os.ReadFile("../bin/shuttle-deploy")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(script), "daemon_call() {")
	if start < 0 {
		t.Fatal("daemon_call function not found")
	}
	end := strings.Index(string(script[start:]), "\n}")
	if end < 0 {
		t.Fatal("daemon_call function is unterminated")
	}
	definition := string(script[start : start+end+2])
	generated, err := exec.Command("bash", "-c", "listen_prelude() { printf 'sock=; port=4000; base=http://127.0.0.1:4000; '; }\n"+definition+"\ndaemon_call '' /api/v1/version").Output()
	if err != nil {
		t.Fatalf("generate daemon call: %v", err)
	}

	binDir := t.TempDir()
	calls := filepath.Join(t.TempDir(), "calls")
	felt := "#!/bin/sh\n[ \"$*\" = 'shuttle host check-owner' ] || exit 2\necho check-owner >> \"$CALLS\"\n[ \"${FAIL_OWNER:-0}\" = 0 ]\n"
	curl := "#!/bin/sh\necho curl >> \"$CALLS\"\n"
	for name, body := range map[string]string{"felt": felt, "curl": curl} {
		if err := os.WriteFile(filepath.Join(binDir, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name      string
		failOwner bool
		wantCalls string
	}{
		{"owner accepted", false, "check-owner\ncurl"},
		{"owner refused", true, "check-owner"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("CALLS", calls)
			if tc.failOwner {
				t.Setenv("FAIL_OWNER", "1")
			} else {
				t.Setenv("FAIL_OWNER", "0")
			}
			_, err := exec.Command("bash", "-c", string(generated)).CombinedOutput()
			if (err != nil) != tc.failOwner {
				t.Fatalf("daemon call error = %v; want failure %v", err, tc.failOwner)
			}
			got, err := os.ReadFile(calls)
			if err != nil {
				t.Fatal(err)
			}
			if strings.TrimSpace(string(got)) != tc.wantCalls {
				t.Fatalf("calls = %q, want %q", got, tc.wantCalls)
			}
			if err := os.WriteFile(calls, nil, 0o600); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCheckResolvedDaemonPortOwnerSkipsOtherListeners(t *testing.T) {
	for _, settings := range []hostSettings{
		{Class: "single-user", listen: listenAddr{Network: "tcp", Address: "127.0.0.1:4000"}},
		{Class: "shared-multi-user", listen: listenAddr{Network: "unix", Address: "/tmp/daemon.sock"}},
	} {
		if err := checkResolvedDaemonPortOwner(settings); err != nil {
			t.Fatalf("check for %+v: %v", settings, err)
		}
	}
}

func TestIsSocketClassDaemonTCPMatchesLoopbackAddresses(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the owner check applies to Linux socket-class TCP listeners")
	}
	hostFile := filepath.Join(t.TempDir(), "host.json")
	setHostEnv(t, hostFile, nil, nil)
	if err := os.WriteFile(hostFile, []byte(`{"class":"shared-multi-user","listen":"tcp://127.0.0.1:4102"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		address string
		want    bool
	}{
		{"127.0.0.1:4102", true},
		{"127.0.0.2:4102", true},
		{"[::1]:4102", true},
		{"localhost:4102", true},
		{"10.0.0.1:4102", false},
		{"127.0.0.1:4103", false},
	} {
		t.Run(tc.address, func(t *testing.T) {
			got, err := isSocketClassDaemonTCP("tcp", tc.address)
			if err != nil || got != tc.want {
				t.Fatalf("isSocketClassDaemonTCP(%q) = %v, %v; want %v", tc.address, got, err, tc.want)
			}
		})
	}
}

func TestDaemonHTTPClientFailsClosedWhenSettingsCannotResolve(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the owner check applies to Linux socket-class TCP listeners")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan struct{}, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests <- struct{}{}
		_, _ = w.Write([]byte("connected"))
	})}
	go server.Serve(listener)
	t.Cleanup(func() { _ = server.Close() })

	hostFile := filepath.Join(t.TempDir(), "host.json")
	setHostEnv(t, hostFile, nil, nil)
	if err := os.WriteFile(hostFile, []byte("{malformed"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHUTTLE_DAEMON_URL", "http://"+listener.Addr().String())
	for _, key := range []string{"HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		t.Setenv(key, "")
	}
	if _, err := getDaemon("http://"+listener.Addr().String(), time.Second); err == nil || !strings.Contains(err.Error(), hostFile) {
		t.Fatalf("getDaemon error = %v; want host settings error naming %s", err, hostFile)
	}
	select {
	case <-requests:
		t.Fatal("request reached the listener despite unresolved owner-check settings")
	default:
	}
}

func TestDaemonHTTPClientChecksLiveSocketClassTCP(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the accepted-socket owner check reads Linux /proc")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("connected"))
	})}
	go server.Serve(listener)
	t.Cleanup(func() { _ = server.Close() })

	addr := listener.Addr().String()
	hostFile := filepath.Join(t.TempDir(), "host.json")
	setHostEnv(t, hostFile, nil, nil)
	if err := os.WriteFile(hostFile, []byte(fmt.Sprintf(`{"class":"shared-multi-user","listen":"tcp://%s"}`, addr)), 0o600); err != nil {
		t.Fatal(err)
	}

	body, err := getDaemon("http://"+addr, daemonReadTimeout)
	if err != nil {
		t.Fatalf("the daemon HTTP client rejected its own listener: %v", err)
	}
	if string(body) != "connected" {
		t.Fatalf("response = %q, want connected", body)
	}
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
func TestLifecycleOwnerCheckRefusalIsNotTransportError(t *testing.T) {
	refusal := fmt.Errorf("reaching daemon at http://127.0.0.1:4000: %w", &daemonTCPOwnerCheckError{
		address: "127.0.0.1:4000", uid: 2000, foreign: true,
	})
	var ownerErr *daemonTCPOwnerCheckError
	if !errors.As(refusal, &ownerErr) {
		t.Fatalf("error chain lost owner refusal: %v", refusal)
	}
	if isLifecycleTransportError(refusal) {
		t.Fatalf("owner refusal was classified as a transport outage: %v", refusal)
	}
}

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
	_ = os.WriteFile(path, []byte(`{"class":"shared"}`), 0o600)
	_, err := postLifecycle("resume", "x")
	if err == nil || isLifecycleTransportError(err) || !strings.Contains(err.Error(), path) {
		t.Fatalf("err = %v", err)
	}
}

// isHostConfigError reports whether err is a host-file refusal of the given
// kind, through any wrapping.
func isHostConfigError(err error, kind string) bool {
	var hc hostConfigError
	return errors.As(err, &hc) && hc.Kind == kind
}
