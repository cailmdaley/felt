package cmd

import (
	"bytes"
	"io"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// executeCLI runs one `felt …` invocation in-process against dir and returns
// what it wrote to stdout and stderr. Every test that drives rootCmd goes
// through here.
//
// Cobra binds each flag to a package variable and only assigns it when the
// flag is parsed, so a flag passed in one Execute stays set for every later
// one — and a repeatable flag keeps appending. Tests then pass or fail by the
// order they happen to run in. resetFlags returns the whole command tree to
// its registered defaults before the run and again after it, so no invocation
// can observe another's flags, whether it runs through Execute or calls a
// command's function directly afterwards.
func executeCLI(t *testing.T, dir string, args ...string) (stdout, stderr string, err error) {
	t.Helper()

	oldArgs, oldStdout, oldStderr := os.Args, os.Stdout, os.Stderr
	defer func() {
		os.Args, os.Stdout, os.Stderr = oldArgs, oldStdout, oldStderr
		rootCmd.SetArgs(nil)
		rootCmd.SetOut(io.Discard)
		rootCmd.SetErr(io.Discard)
		resetFlags(t)
		changeDir = ""
	}()

	resetFlags(t)
	changeDir = dir
	rootCmd.SetArgs(args)

	outR, outW, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatalf("os.Pipe (stdout): %v", pipeErr)
	}
	errR, errW, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatalf("os.Pipe (stderr): %v", pipeErr)
	}
	// Drain both pipes while the command runs: an output larger than the
	// pipe buffer would otherwise block the write and hang the test.
	var outBuf, errBuf bytes.Buffer
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = io.Copy(&outBuf, outR) }()
	go func() { defer wg.Done(); _, _ = io.Copy(&errBuf, errR) }()

	os.Stdout, os.Stderr = outW, errW
	rootCmd.SetOut(outW)
	rootCmd.SetErr(errW)

	err = rootCmd.Execute()

	os.Stdout, os.Stderr = oldStdout, oldStderr
	_ = outW.Close()
	_ = errW.Close()
	wg.Wait()
	_ = outR.Close()
	_ = errR.Close()
	return outBuf.String(), errBuf.String(), err
}

// resetFlags returns every flag on every command to its registered default
// and clears its Changed mark.
func resetFlags(t *testing.T) {
	t.Helper()
	var walk func(*cobra.Command)
	walk = func(c *cobra.Command) {
		for _, set := range []*pflag.FlagSet{c.Flags(), c.PersistentFlags()} {
			set.VisitAll(func(f *pflag.Flag) {
				if err := resetFlag(f); err != nil {
					t.Fatalf("reset --%s on %q: %v", f.Name, c.CommandPath(), err)
				}
			})
		}
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(rootCmd)
}

func resetFlag(f *pflag.Flag) error {
	f.Changed = false
	// A slice flag's Set appends once the flag has been parsed, so its
	// default goes back through Replace instead. pflag renders a slice
	// default as "[a,b]".
	if slice, ok := f.Value.(pflag.SliceValue); ok {
		var values []string
		if def := strings.TrimSuffix(strings.TrimPrefix(f.DefValue, "["), "]"); def != "" {
			values = strings.Split(def, ",")
		}
		return slice.Replace(values)
	}
	return f.Value.Set(f.DefValue)
}

// TestFlagsDoNotLeakAcrossInvocations: a flag passed to one invocation is
// absent from the next — a scalar, a repeatable slice flag, and the root's
// persistent --json alike.
func TestFlagsDoNotLeakAcrossInvocations(t *testing.T) {
	dir, storage := newStore(t)

	if out, err := runCommand(t, dir, "add", "first", "First", "-t", "alpha", "-s", "active", "--json"); err != nil {
		t.Fatalf("add first: %v\n%s", err, out)
	}
	out, err := runCommand(t, dir, "add", "second", "Second")
	if err != nil {
		t.Fatalf("add second: %v\n%s", err, out)
	}
	if strings.HasPrefix(strings.TrimSpace(out), "{") {
		t.Fatalf("--json leaked into the next invocation: %s", out)
	}
	second, err := storage.Read("second")
	if err != nil {
		t.Fatalf("read second: %v", err)
	}
	if len(second.Tags) != 0 || second.Status != "" {
		t.Fatalf("flags leaked into the next invocation: tags=%v status=%q", second.Tags, second.Status)
	}

	// A repeatable flag starts empty each time, rather than appending.
	if out, err := runCommand(t, dir, "add", "third", "Third", "-t", "beta"); err != nil {
		t.Fatalf("add third: %v\n%s", err, out)
	}
	third, err := storage.Read("third")
	if err != nil {
		t.Fatalf("read third: %v", err)
	}
	if len(third.Tags) != 1 || third.Tags[0] != "beta" {
		t.Fatalf("third tags = %v, want [beta]", third.Tags)
	}
}
