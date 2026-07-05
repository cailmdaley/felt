package cmd

import (
	"strconv"
	"strings"
	"testing"
)

// TestShuttleContract_PrintsBareInteger locks in the output contract the
// Elixir Poller boot-check codes against verbatim: `felt shuttle contract`
// exits 0 and prints exactly one integer on stdout, nothing else.
func TestShuttleContract_PrintsBareInteger(t *testing.T) {
	dir, _ := newShuttleStore(t)

	out, err := runCommand(t, dir, "shuttle", "contract")
	if err != nil {
		t.Fatalf("shuttle contract: %v\n%s", err, out)
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
