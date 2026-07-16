package cmd

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestShuttleContract_PrintsBareInteger locks in the output contract the
// Elixir Poller boot-check codes against verbatim: `felt shuttle contract`
// exits 0 and prints exactly one integer, with NOTHING on stderr. The Elixir
// consumer (lib/shuttle/contract.ex) shells this with stderr_to_stdout: true
// and parses the MERGED stream as exactly the bare integer — a single stray
// byte on stderr trips contract skew and parks every fresh launch. So we
// capture both streams and assert stderr is empty as part of the contract.
func TestShuttleContract_PrintsBareInteger(t *testing.T) {
	dir, _ := newShuttleStore(t)

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

// runShuttleContract executes `felt shuttle contract` capturing stdout and
// stderr separately, so the test can assert stderr is empty — runCommand only
// captures stdout. Mirrors runCommand's os.Args/changeDir save-restore.
func runShuttleContract(t *testing.T, dir string) (stdout, stderr string) {
	t.Helper()

	oldArgs := os.Args
	oldChangeDir := changeDir
	oldStdout := os.Stdout
	oldStderr := os.Stderr
	defer func() {
		os.Args = oldArgs
		changeDir = oldChangeDir
		os.Stdout = oldStdout
		os.Stderr = oldStderr
	}()

	changeDir = dir
	rootCmd.SetArgs([]string{"shuttle", "contract"})

	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe (stdout): %v", err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe (stderr): %v", err)
	}
	os.Stdout = outW
	os.Stderr = errW
	// Cobra writes its own diagnostics via rootCmd's out/err writers, which
	// default to os.Stdout/os.Stderr but may have been rebound by a prior
	// runCommand; point them back at the real fds so any cobra-side stderr is
	// also captured here.
	rootCmd.SetOut(outW)
	rootCmd.SetErr(errW)

	_ = rootCmd.Execute()

	if err := outW.Close(); err != nil {
		t.Fatalf("close stdout write pipe: %v", err)
	}
	if err := errW.Close(); err != nil {
		t.Fatalf("close stderr write pipe: %v", err)
	}

	var outBuf, errBuf bytes.Buffer
	if _, err := io.Copy(&outBuf, outR); err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	if _, err := io.Copy(&errBuf, errR); err != nil {
		t.Fatalf("read stderr: %v", err)
	}
	outR.Close()
	errR.Close()

	rootCmd.SetArgs(nil)
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(io.Discard)
	os.Args = []string{filepath.Base(oldArgs[0])}

	return outBuf.String(), errBuf.String()
}
