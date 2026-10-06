//go:build !integration

package shuttlecli

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// testFenceDir is the throwaway root TestMain points every machine-level path
// at; TestTestMainFencesLiveMachineState asserts the fence holds.
var testFenceDir string

// fencedEnv lists the variables TestMain clears because the developer's shell
// (often a live shuttle worker) carries them and they select real machine
// state: the daemon listener, identity, ledgers, worker context and harness
// homes. A test that needs one sets it with t.Setenv.
var fencedEnv = []string{
	"SHUTTLE_HOST", "SHUTTLE_HOST_FILE", "SHUTTLE_HOST_CONFIG_FILE", "SHUTTLE_LISTEN",
	"SHUTTLE_PORT", "SHUTTLE_DATA_DIR", "SHUTTLE_RELEASE", "SHUTTLE_DAEMON_URL",
	"SHUTTLE_EVENTS", "SHUTTLE_EVENTS_FILE", "SHUTTLE_EVENTS_MAX_BYTES", "SHUTTLE_COMMITS_FILE",
	"SHUTTLE_MESSAGES", "SHUTTLE_SESSIONS_FILE", "SHUTTLE_FIBER_PATH", "SHUTTLE_TMUX_SESSION",
	"SHUTTLE_CODEX_SOCKET", "SHUTTLE_CONFER_STATE_DIR", "SHUTTLE_LIFECYCLE_OFFLINE",
	"SHUTTLE_AGENTS_FILE", "SHUTTLE_REMOTES_FILE", "SHUTTLE_STORES", "SHUTTLE_STORES_FILE",
	"SHUTTLE_PROJECTS", "SHUTTLE_PROJECTS_FILE", "SHUTTLE_TRANSCRIPT_CACHE_DIR",
	"SHUTTLE_BRIDGE_READY_FD", "SHUTTLE_BRIDGE_PARENT_PID", "SHUTTLE_BRIDGE_SOCKET",
	"SHUTTLE_BRIDGE_ENV_FILE", "SHUTTLE_BRIDGE_ARGS_FILE", "SHUTTLE_BRIDGE_ERROR_FILE",
	"TMUX", "CODEX_THREAD_ID", "CODEX_HOME", "CODEX_APP_TOOLS_PIPE_PATH",
	"CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MESSAGING_SOCKET",
	"CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "PI_SESSION_ID", "AI_AGENT",
}

// TestMain fences the Shuttle CLI unit-test binary away from the machine it runs
// on. Without it a test inherits the developer's live daemon (127.0.0.1:4000
// or its socket) and fleet file, so a lifecycle verb on a remote-owned test
// fiber is forwarded to a real host; and resolveOwnHost's last tier seeds the
// host file, which would rename the developer's machine.
//
// HOME and XDG paths move to a temp dir, the shuttle config files and the
// host identity file point inside it, and SHUTTLE_DAEMON_URL names a loopback
// port nothing listens on. A test that exercises a daemon starts an httptest
// server and sets SHUTTLE_DAEMON_URL itself.
func TestMain(m *testing.M) {
	os.Exit(runFenced(m))
}

func runFenced(m *testing.M) int {
	// Re-executed event-hook helpers must append to the parent test's stream,
	// not to a fresh fence directory of their own.
	helperEventFile := ""
	if os.Getenv("SHUTTLE_EVENT_HELPER") == "1" {
		helperEventFile = os.Getenv("SHUTTLE_EVENTS_FILE")
	}
	dir, err := os.MkdirTemp("", "shuttle-cli-test-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	testFenceDir = dir

	// Tests that build helper binaries keep the developer's Go caches: pin them
	// before HOME and XDG_CACHE_HOME move, or every such build starts cold.
	pinGoCaches()

	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		panic(err)
	}
	for _, key := range fencedEnv {
		if err := os.Unsetenv(key); err != nil {
			panic(err)
		}
	}
	for key, value := range map[string]string{
		"HOME":                         home,
		"XDG_CACHE_HOME":               filepath.Join(dir, "cache"),
		"XDG_CONFIG_HOME":              filepath.Join(dir, "config"),
		"SHUTTLE_HOST_FILE":            filepath.Join(dir, "host"),
		"SHUTTLE_HOST_CONFIG_FILE":     filepath.Join(dir, "host.json"),
		"SHUTTLE_REMOTES_FILE":         filepath.Join(dir, "remotes.json"),
		"SHUTTLE_STORES_FILE":          filepath.Join(dir, "stores.json"),
		"SHUTTLE_AGENTS_FILE":          filepath.Join(dir, "agents.json"),
		"SHUTTLE_PROJECTS_FILE":        filepath.Join(dir, "projects.json"),
		"SHUTTLE_TRANSCRIPT_CACHE_DIR": filepath.Join(dir, "transcripts"),
		"SHUTTLE_DAEMON_URL":           "http://" + closedLoopbackAddr(),
	} {
		if err := os.Setenv(key, value); err != nil {
			panic(err)
		}
	}
	if helperEventFile != "" {
		if err := os.Setenv("SHUTTLE_EVENTS_FILE", helperEventFile); err != nil {
			panic(err)
		}
	}
	return m.Run()
}

// pinGoCaches exports the Go settings resolved against the real home (the
// build and module caches, the go env file, the toolchain), so a helper
// binary built under the moved HOME reuses them. Without go on PATH nothing
// is pinned and those tests build cold.
func pinGoCaches() {
	keys := []string{"GOCACHE", "GOPATH", "GOMODCACHE", "GOENV", "GOTOOLCHAIN"}
	out, err := exec.Command("go", append([]string{"env", "-json"}, keys...)...).Output()
	if err != nil {
		return
	}
	var env map[string]string
	if json.Unmarshal(out, &env) != nil {
		return
	}
	for _, key := range keys {
		if value := env[key]; value != "" {
			_ = os.Setenv(key, value)
		}
	}
}

// closedLoopbackAddr returns a loopback address that refuses connections: the
// kernel hands out a free port, and closing the listener leaves it unbound.
func closedLoopbackAddr() string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(fmt.Sprintf("reserving a closed port: %v", err))
	}
	addr := l.Addr().String()
	_ = l.Close()
	return addr
}

func TestTestMainFencesLiveMachineState(t *testing.T) {
	endpoint, err := daemonEndpoint("/api/v1/lifecycle")
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasSuffix(strings.SplitN(strings.TrimPrefix(endpoint, "http://"), "/", 2)[0], ":4000") {
		t.Fatalf("daemon endpoint %q escapes the test fence", endpoint)
	}
	if _, err := postDaemon(endpoint, []byte(`{}`), daemonReadTimeout); err == nil || requestCouldHaveReachedDaemon(err) {
		t.Fatalf("fenced daemon endpoint accepted a connection: %v", err)
	}
	for name, resolve := range map[string]func() (string, error){
		"remotes":       shuttleRemotesPath,
		"stores":        feltStoresRegistryPath,
		"agents":        func() (string, error) { return shuttleConfigPath("SHUTTLE_AGENTS_FILE", "agents.json") },
		"projects":      func() (string, error) { return shuttleConfigPath("SHUTTLE_PROJECTS_FILE", "projects.json") },
		"home":          os.UserHomeDir,
		"host config":   hostClassFilePath,
		"host identity": func() (string, error) { return hostConfigFilePath(), nil },
	} {
		path, err := resolve()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(path, testFenceDir) {
			t.Fatalf("%s path %q is outside the test fence %q", name, path, testFenceDir)
		}
	}
	remotes, err := loadRemotesFile()
	if err != nil || len(remotes.Remotes) != 0 {
		t.Fatalf("remotes file = %v, %v; want none", remotes.Remotes, err)
	}
}
