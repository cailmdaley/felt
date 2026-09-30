package shuttlecli

import (
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
	if n < 1 {
		t.Fatalf("ShuttleContractLevel must start at 1, got %d", n)
	}
}

// runShuttleContract executes `shuttle contract` capturing stdout and
// stderr separately, so the test can assert stderr is empty.
func runShuttleContract(t *testing.T, dir string) (stdout, stderr string) {
	t.Helper()
	stdout, stderr, _ = executeCLI(t, dir, "contract")
	return stdout, stderr
}
