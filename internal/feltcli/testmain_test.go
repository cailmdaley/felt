//go:build !integration

package feltcli

import (
	"os"
	"path/filepath"
	"testing"
)

// testScratch is a directory for fixtures built once per test binary and
// shared read-only by the tests that copy them.
var testScratch string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "felt-cli-test-*")
	if err != nil {
		panic(err)
	}
	testScratch = dir

	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		panic(err)
	}
	for _, key := range []string{
		"CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_SESSION_ID",
		"CODEX_HOME", "CODEX_THREAD_ID", "PI_SESSION_ID", "AI_AGENT",
	} {
		if err := os.Unsetenv(key); err != nil {
			panic(err)
		}
	}
	for key, value := range map[string]string{
		"HOME":            home,
		"XDG_CACHE_HOME":  filepath.Join(dir, "cache"),
		"XDG_CONFIG_HOME": filepath.Join(dir, "config"),
	} {
		if err := os.Setenv(key, value); err != nil {
			panic(err)
		}
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
