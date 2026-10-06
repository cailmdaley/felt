package shuttlecli

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestDaemonLifecycleHTTPUsesTCPAndUnixListeners(t *testing.T) {
	t.Parallel()
	t.Run("tcp", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/v1/version" {
				http.NotFound(w, r)
				return
			}
			fmt.Fprint(w, `{"ready":true}`)
		}))
		defer server.Close()
		host, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
		if err != nil || host != "127.0.0.1" {
			t.Fatalf("test server address %q: %v", server.URL, err)
		}
		env := testEnv(t)
		env.Set("SHUTTLE_LISTEN", "tcp://127.0.0.1:"+port)
		a := newApp(env)
		settings, err := a.resolveHostSettings()
		if err != nil {
			t.Fatal(err)
		}
		body, err := a.daemonLifecycleGet(settings, "/api/v1/version", daemonReadTimeout)
		if err != nil || string(body) != `{"ready":true}` {
			t.Fatalf("TCP request = %q, %v", body, err)
		}
	})

	t.Run("unix socket", func(t *testing.T) {
		t.Parallel()
		socket := filepath.Join(shortPrivateTempDir(t), "daemon.sock")
		listener, err := net.Listen("unix", socket)
		if err != nil {
			t.Fatal(err)
		}
		server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/v1/version" {
				http.NotFound(w, r)
				return
			}
			fmt.Fprint(w, `{"ready":false}`)
		})}
		go func() { _ = server.Serve(listener) }()
		defer server.Close()
		env := testEnv(t)
		env.Set("SHUTTLE_LISTEN", "unix://"+socket)
		a := newApp(env)
		settings, err := a.resolveHostSettings()
		if err != nil {
			t.Fatal(err)
		}
		body, err := a.daemonLifecycleGet(settings, "/api/v1/version", daemonReadTimeout)
		if err != nil || !daemonVersionIsBooting(body) {
			t.Fatalf("unix request = %q, %v", body, err)
		}
	})
}

func TestDaemonLifecycleChecksTCPListenerOwnershipBeforeRequest(t *testing.T) {
	t.Parallel()
	var called atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called.Store(true) }))
	defer server.Close()
	a := newApp(testEnv(t))
	a.daemonLifecycleOwnerCheck = func(hostSettings) error { return errors.New("foreign listener") }
	settings := hostSettings{Listen: "tcp://127.0.0.1:4000", listen: listenAddr{Network: "tcp", Address: "127.0.0.1:4000"}}
	if _, err := a.daemonLifecycleGet(settings, "/api/v1/version", daemonReadTimeout); err == nil || !strings.Contains(err.Error(), "foreign listener") {
		t.Fatalf("owner-refused request error = %v", err)
	}
	if called.Load() {
		t.Fatal("HTTP request reached a listener before the owner check passed")
	}
}

func TestDaemonStatusReportsBootingAndFallsBackToVersion(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name       string
		version    string
		stateCode  int
		wantState  bool
		wantOutput string
	}{
		{"booting", `{"ready":false}`, http.StatusOK, false, `{"ready":false}`},
		{"state unavailable", `{"ready":true}`, http.StatusServiceUnavailable, true, `{"ready":true}`},
		{"state ready", `{"ready":true}`, http.StatusOK, true, `{"state":"running"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			stateRequested := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/version":
					fmt.Fprint(w, tc.version)
				case "/api/v1/state":
					stateRequested = true
					w.WriteHeader(tc.stateCode)
					if tc.stateCode == http.StatusOK {
						fmt.Fprint(w, tc.wantOutput)
					}
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			port := strings.TrimPrefix(server.URL, "http://127.0.0.1:")
			env := testEnv(t)
			env.Set("SHUTTLE_LISTEN", "tcp://127.0.0.1:"+port)
			out, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "status")
			if err != nil {
				t.Fatalf("daemon status: %v\n%s", err, stderr)
			}
			if !strings.Contains(out, tc.wantOutput) || stateRequested != tc.wantState {
				t.Fatalf("status output=%q stateRequested=%t, want output containing %q and state=%t", out, stateRequested, tc.wantOutput, tc.wantState)
			}
		})
	}
}

func TestDaemonStatusDownUsesExitCodeTwo(t *testing.T) {
	t.Parallel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatal(err)
	}
	env := testEnv(t)
	env.Set("SHUTTLE_LISTEN", "tcp://"+net.JoinHostPort(host, port))
	_, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "status")
	var exitErr *cliExitError
	if !errors.As(err, &exitErr) || exitErr.code != 2 {
		t.Fatalf("daemon status error = %v, want exit code 2\n%s", err, stderr)
	}
	if !strings.Contains(stderr, "daemon down at") {
		t.Fatalf("status diagnostic = %q", stderr)
	}
}

func TestDaemonReleaseGatesBootingAndPostsWhenReady(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name        string
		ready       bool
		wantPost    bool
		wantSuccess bool
	}{
		{"booting", false, false, false},
		{"ready", true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			posted := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/version":
					fmt.Fprintf(w, `{"ready":%t}`, tc.ready)
				case "/api/v1/quarantine/release":
					posted = true
					fmt.Fprint(w, `{}`)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			env := testEnv(t)
			env.Set("SHUTTLE_LISTEN", "tcp://"+strings.TrimPrefix(server.URL, "http://"))
			_, stderr, err := executeIn(t, env, t.TempDir(), "daemon", "release")
			if (err == nil) != tc.wantSuccess || posted != tc.wantPost {
				t.Fatalf("release err=%v posted=%t stderr=%q", err, posted, stderr)
			}
			if !tc.ready && !strings.Contains(err.Error(), "still booting") {
				t.Fatalf("booting error = %v", err)
			}
		})
	}
}

func TestDaemonResetEscapesRemoteName(t *testing.T) {
	t.Parallel()
	posted := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.EscapedPath() == "/api/v1/remotes/one%2Ftwo/reset" {
			posted = true
			fmt.Fprint(w, `{}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	env := testEnv(t)
	env.Set("SHUTTLE_LISTEN", "tcp://"+strings.TrimPrefix(server.URL, "http://"))
	out, _, err := executeIn(t, env, t.TempDir(), "daemon", "reset", "one/two")
	if err != nil || !posted || !strings.Contains(out, "circuit breaker reset for one/two") {
		t.Fatalf("reset output=%q posted=%t err=%v", out, posted, err)
	}
}

func TestShuttleVersionPrefersLiveDaemonAndFallsBackToRelease(t *testing.T) {
	t.Parallel()
	t.Run("live", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/v1/version" {
				fmt.Fprint(w, `{"version":"live"}`)
			}
		}))
		defer server.Close()
		env := testEnv(t)
		env.Set("SHUTTLE_LISTEN", "tcp://"+strings.TrimPrefix(server.URL, "http://"))
		a := newApp(env)
		a.runDaemonReleaseVersion = func(string) error { t.Fatal("release fallback ran with a live daemon"); return nil }
		out, _, err := executeApp(t, a, t.TempDir(), "version")
		if err != nil || !strings.Contains(out, `"version":"live"`) {
			t.Fatalf("live version output=%q err=%v", out, err)
		}
	})

	t.Run("release fallback", func(t *testing.T) {
		t.Parallel()
		env := testEnv(t)
		release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
		env.Set("SHUTTLE_RELEASE", release.Dir)
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		address := listener.Addr().String()
		_ = listener.Close()
		env.Set("SHUTTLE_LISTEN", "tcp://"+address)
		a := newApp(env)
		called := ""
		a.runDaemonReleaseVersion = func(path string) error { called = path; return nil }
		if _, _, err := executeApp(t, a, t.TempDir(), "version"); err != nil || called != release.Launcher {
			t.Fatalf("version fallback path=%q err=%v, want %q", called, err, release.Launcher)
		}
	})
}

func TestDaemonStartForceExecutesReleaseLauncher(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	env.Set("SHUTTLE_RELEASE", release.Dir)
	env.Set("SHUTTLE_LISTEN", "invalid listener ignored by --force")
	a := newApp(env)
	var gotPath string
	var gotArgs []string
	a.execDaemonRelease = func(path string, args ...string) error {
		gotPath, gotArgs = path, args
		return nil
	}
	if _, _, err := executeApp(t, a, t.TempDir(), "daemon", "start", "--force"); err != nil {
		t.Fatalf("forced start: %v", err)
	}
	if gotPath != release.Launcher || strings.Join(gotArgs, " ") != "start" {
		t.Fatalf("exec = %q %v, want %q start", gotPath, gotArgs, release.Launcher)
	}
}

func TestDaemonStartGuardRefusesWhenTCPOwnerCheckFails(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	env.Set("SHUTTLE_RELEASE", release.Dir)
	env.Set("SHUTTLE_LISTEN", "tcp://127.0.0.1:4000")
	a := newApp(env)
	a.daemonLifecycleOwnerCheck = func(hostSettings) error { return errors.New("foreign listener") }
	launched := false
	a.execDaemonRelease = func(string, ...string) error { launched = true; return nil }
	_, stderr, err := executeApp(t, a, t.TempDir(), "daemon", "start")
	if err == nil || launched || !strings.Contains(err.Error(), "foreign listener") || strings.Contains(stderr, "Daemon already running") {
		t.Fatalf("start result err=%v launched=%t stderr=%q", err, launched, stderr)
	}
}

func TestDaemonStartGuardRefusesAnAnsweringListener(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release"))
	env.Set("SHUTTLE_RELEASE", release.Dir)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"ready":false}`)
	}))
	defer server.Close()
	port := strings.TrimPrefix(server.URL, "http://127.0.0.1:")
	env.Set("SHUTTLE_LISTEN", "tcp://127.0.0.1:"+port)
	a := newApp(env)
	launched := false
	a.execDaemonRelease = func(string, ...string) error { launched = true; return nil }
	_, stderr, err := executeApp(t, a, t.TempDir(), "daemon", "start")
	if err == nil || launched || !strings.Contains(stderr, "Daemon already running") {
		t.Fatalf("start result err=%v launched=%t stderr=%q", err, launched, stderr)
	}
}

func TestAbsoluteExecutablePathPreservesHomebrewLauncherSymlink(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	target := filepath.Join(dir, "Cellar", "shuttle", "1.0", "bin", "shuttle")
	link := filepath.Join(dir, "bin", "shuttle")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("shuttle"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	got, err := newApp(testEnv(t)).absoluteExecutablePath(link)
	if err != nil {
		t.Fatal(err)
	}
	if got != link {
		t.Fatalf("executable path = %q; want the stable launcher path %q", got, link)
	}
}

func TestFindDaemonReleasePrecedence(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	configured := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "configured"))
	sibling := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "sibling"))
	repo := t.TempDir()
	repository := writeTestDaemonRelease(t, filepath.Join(repo, "bin", "rel"))
	if err := os.MkdirAll(filepath.Join(home, ".shuttle"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".shuttle", "repo"), []byte(repo+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := testEnv(t)
	env.Set("HOME", home)
	a := newApp(env)

	got, err := a.findDaemonReleaseAt(configured.Dir, filepath.Join(sibling.Dir, "bin", "shuttle"), home)
	if err != nil || got.Dir != configured.Dir {
		t.Fatalf("environment release = %+v, %v", got, err)
	}
	got, err = a.findDaemonReleaseAt("", filepath.Join(sibling.Dir, "bin", "shuttle"), home)
	if err != nil || got.Dir != sibling.Dir {
		t.Fatalf("sibling release = %+v, %v", got, err)
	}
	if _, err := a.findDaemonReleaseAt("", filepath.Join(repo, "shuttle"), t.TempDir()); err == nil {
		t.Fatal("release lookup should require SHUTTLE_RELEASE, a sibling launcher, or ~/.shuttle/repo")
	}
	got, err = a.findDaemonReleaseAt("", filepath.Join(t.TempDir(), "shuttle"), home)
	if err != nil || got.Dir != repository.Dir {
		t.Fatalf("repository release = %+v, %v", got, err)
	}
}

func TestFindDaemonReleaseSupportsFetchedReleaseInShuttleState(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	fetched := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "fetched"))
	if err := os.MkdirAll(filepath.Join(home, ".shuttle"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".shuttle", "repo"), []byte(fetched.Dir+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := newApp(testEnv(t)).findDaemonReleaseAt("", filepath.Join(t.TempDir(), "shuttle"), home)
	if err != nil || got.Dir != fetched.Dir {
		t.Fatalf("fetched release = %+v, %v; want %q", got, err, fetched.Dir)
	}
}

func TestStopDaemonMarksAndSignalsOnlyThisRelease(t *testing.T) {
	t.Parallel()
	release := writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release.with.dots"))
	dataDir := filepath.Join(t.TempDir(), "daemon-data")
	env := testEnv(t)
	env.Set("SHUTTLE_DATA_DIR", dataDir)
	a := newApp(env)
	finds := 0
	a.daemonFindPIDs = func(pattern string) ([]int, error) {
		if !strings.Contains(pattern, regexp.QuoteMeta(release.Dir)) {
			t.Fatalf("process pattern %q does not identify release %q", pattern, release.Dir)
		}
		finds++
		if finds == 1 {
			return []int{1234}, nil
		}
		return nil, nil
	}
	var signals []syscall.Signal
	a.daemonSignalPID = func(pid int, signal syscall.Signal) error {
		if pid != 1234 {
			t.Fatalf("signal pid %d, want 1234", pid)
		}
		if _, err := os.Stat(filepath.Join(dataDir, "heartbeat.stopped")); err != nil {
			t.Fatalf("stop marker must exist before signal %v: %v", signal, err)
		}
		signals = append(signals, signal)
		return nil
	}
	a.daemonPause = func(time.Duration) {}
	if err := a.stopDaemonRelease(release); err != nil {
		t.Fatal(err)
	}
	if len(signals) != 1 || signals[0] != syscall.SIGTERM {
		t.Fatalf("signals = %v, want SIGTERM only", signals)
	}
}

func TestDaemonProcessPatternMatchesOnlyReleasePath(t *testing.T) {
	t.Parallel()
	release := filepath.Join(t.TempDir(), "release.v1")
	pattern := daemonProcessPattern(release)
	for _, tc := range []struct {
		command string
		want    bool
	}{
		{filepath.Join(release, "releases", "1.2.3", "start") + " --", true},
		{filepath.Join(filepath.Dir(release), "releaseXv1", "releases", "1.2.3", "start") + " --", false},
	} {
		matched, err := regexp.MatchString(pattern, tc.command)
		if err != nil || matched != tc.want {
			t.Errorf("pattern match %q = %t, %v, want %t", tc.command, matched, err, tc.want)
		}
	}
}

func writeTestDaemonRelease(t *testing.T, dir string) daemonRelease {
	t.Helper()
	launcher := filepath.Join(dir, "bin", "shuttled")
	if err := os.MkdirAll(filepath.Dir(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	release, err := newApp(testEnv(t)).validateDaemonRelease(dir)
	if err != nil {
		t.Fatal(err)
	}
	return release
}
