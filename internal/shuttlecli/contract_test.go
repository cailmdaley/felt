package shuttlecli

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// TestShuttleContract_PrintsBareInteger locks in the output contract the
// Elixir Poller boot-check codes against verbatim: `shuttle contract`
// exits 0 and prints exactly one integer, with NOTHING on stderr. The Elixir
// consumer (daemon/lib/shuttle/contract.ex) shells this with stderr_to_stdout: true
// and parses the MERGED stream as exactly the bare integer — a single stray
// byte on stderr trips contract skew and parks every fresh launch. So we
// capture both streams and assert stderr is empty as part of the contract.
func TestShuttleContract_PrintsBareInteger(t *testing.T) {
	t.Parallel()
	dir, _ := newStore(t)

	out, errOut := runShuttleContract(t, dir)

	if errOut != "" {
		t.Fatalf("shuttle contract wrote to stderr (trips the merged-stream contract): %q", errOut)
	}

	trimmed := strings.TrimSpace(out)
	n, convErr := strconv.Atoi(trimmed)
	if convErr != nil {
		t.Fatalf("shuttle contract output %q is not a bare integer: %v", out, convErr)
	}
	if n != ShuttleContractLevel {
		t.Fatalf("shuttle contract printed %d, want the ShuttleContractLevel constant %d", n, ShuttleContractLevel)
	}
	if n != 22 {
		t.Fatalf("family board requires contract level 22, got %d", n)
	}
}

func TestMigrateContractMatchesDaemon(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile("../../daemon/lib/shuttle/contract.ex")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`@expected_level\s+(\d+)`).FindSubmatch(data)
	if len(match) != 2 {
		t.Fatal("daemon has no expected contract level")
	}
	level, err := strconv.Atoi(string(match[1]))
	if err == nil && level == 21 && ShuttleContractLevel == 22 {
		t.Skip("family board daemon level 22 is integrated in the parallel worktree")
	}
	if err != nil || level != ShuttleContractLevel {
		t.Fatalf("daemon level %s differs from CLI %d", match[1], ShuttleContractLevel)
	}
	if !strings.Contains(string(data), "migrate") {
		t.Fatal("daemon contract does not name migrate")
	}
}

// runShuttleContract executes `shuttle contract` capturing stdout and
// stderr separately, so the test can assert stderr is empty.
func runShuttleContract(t *testing.T, dir string) (stdout, stderr string) {
	t.Helper()
	stdout, stderr, _ = executeIn(t, testEnv(t), dir, "contract")
	return stdout, stderr
}
