package shuttlecli

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

func executeCLI(t *testing.T, dir string, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	oldStdout, oldStderr := os.Stdout, os.Stderr
	defer func() {
		os.Stdout, os.Stderr = oldStdout, oldStderr
		rootCmd.SetArgs(nil)
		rootCmd.SetOut(io.Discard)
		rootCmd.SetErr(io.Discard)
		changeDir = ""
		resetFlags(t)
	}()

	resetFlags(t)
	changeDir = dir
	rootCmd.SetArgs(args)
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe (stdout): %v", err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe (stderr): %v", err)
	}
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

func runCommand(t *testing.T, dir string, args ...string) (string, error) {
	t.Helper()
	stdout, _, err := executeCLI(t, dir, args...)
	return stdout, err
}

func resetFlags(t *testing.T) {
	t.Helper()
	var walk func(*cobra.Command)
	walk = func(command *cobra.Command) {
		command.SilenceUsage = false
		for _, set := range []*pflag.FlagSet{command.Flags(), command.PersistentFlags()} {
			set.VisitAll(func(flag *pflag.Flag) {
				flag.Changed = false
				if slice, ok := flag.Value.(pflag.SliceValue); ok {
					values := []string{}
					if def := strings.TrimSuffix(strings.TrimPrefix(flag.DefValue, "["), "]"); def != "" {
						values = strings.Split(def, ",")
					}
					if err := slice.Replace(values); err != nil {
						t.Fatalf("reset --%s on %q: %v", flag.Name, command.CommandPath(), err)
					}
					return
				}
				if err := flag.Value.Set(flag.DefValue); err != nil {
					t.Fatalf("reset --%s on %q: %v", flag.Name, command.CommandPath(), err)
				}
			})
		}
		for _, child := range command.Commands() {
			walk(child)
		}
	}
	walk(rootCmd)
}
