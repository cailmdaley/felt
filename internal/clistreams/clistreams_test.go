package clistreams

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func toyTree(stdout, stderr *bytes.Buffer) *cobra.Command {
	root := &cobra.Command{Use: "toy", Version: "1.2.3", SilenceErrors: true}
	run := &cobra.Command{Use: "run <x>", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		return errors.New("failed at run time")
	}}
	run.Flags().Bool("real", false, "a real flag")
	root.AddCommand(run, &cobra.Command{Use: "old", Deprecated: "use run", Run: func(*cobra.Command, []string) {}})
	Bind(root, strings.NewReader(""), stdout, stderr)
	return root
}

// TestBindSplitsAsAnUnboundTree: the split cobra gives a tree with no writers
// set, now on injected streams.
func TestBindSplitsAsAnUnboundTree(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		args           []string
		stdout, stderr string // substrings; "" means empty
	}{
		{[]string{"--version"}, "toy version 1.2.3", ""},
		{[]string{"-v"}, "toy version 1.2.3", ""},
		{[]string{"--help"}, "Usage:", ""},
		{[]string{"help", "run"}, "Usage:", ""},
		{[]string{"run", "-h"}, "--real", ""},
		{[]string{"completion", "zsh"}, "compdef", ""},
		{[]string{"__complete", "r"}, "run", "Completion ended"},
		{[]string{"run", "--bogus"}, "", "Usage:"},
		{[]string{"run"}, "", "Usage:"},
		{[]string{"help", "nosuch"}, "", "Unknown help topic"},
		{[]string{"old"}, "", "deprecated"},
	} {
		t.Run(strings.Join(c.args, " "), func(t *testing.T) {
			t.Parallel()
			var stdout, stderr bytes.Buffer
			root := toyTree(&stdout, &stderr)
			root.SetArgs(c.args)
			_ = root.Execute()
			for _, s := range []struct{ name, got, want string }{
				{"stdout", stdout.String(), c.stdout},
				{"stderr", stderr.String(), c.stderr},
			} {
				if s.want == "" && s.got != "" {
					t.Errorf("%s should be empty, got:\n%s", s.name, s.got)
				}
				if s.want != "" && !strings.Contains(s.got, s.want) {
					t.Errorf("%s lacks %q, got:\n%s", s.name, s.want, s.got)
				}
			}
		})
	}
}
