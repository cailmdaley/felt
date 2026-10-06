// Package clistreams binds a cobra command tree to an invocation's stdout and
// stderr with the split cobra gives a tree that has no writers set: help,
// version text and shell completion are output and go to stdout; usage after
// a command-line error, "Unknown help topic", deprecation notices and every
// other cobra Print go to stderr, as do errors.
//
// cobra.SetOut alone cannot express that: once Out is set, cobra's Print*
// (usage on error included) write to Out as well. Both the felt and the
// shuttle command trees bind through here, so a caller that parses a
// command's stdout never sees usage text.
package clistreams

import (
	"io"

	"github.com/spf13/cobra"
)

// Bind points root's tree at stdin, stdout and stderr. Call it once the tree
// is complete: it installs the default completion command so it can route it.
func Bind(root *cobra.Command, stdin io.Reader, stdout, stderr io.Writer) {
	out := &switchWriter{stdout: stdout, stderr: stderr}
	root.SetIn(stdin)
	root.SetOut(out)
	root.SetErr(stderr)

	help := root.HelpFunc()
	root.SetHelpFunc(func(c *cobra.Command, args []string) {
		out.toStdout = true
		defer func() { out.toStdout = false }()
		help(c, args)
	})

	// cobra's own version text, preceded by a switch to stdout. The flag
	// itself stays cobra's, added when the root runs.
	root.SetVersionTemplate("{{" + toStdoutFunc + " .}}{{.DisplayName}} version {{.Version}}\n")

	root.InitDefaultCompletionCmd()
	pre := root.PersistentPreRunE
	root.PersistentPreRunE = func(cmd *cobra.Command, args []string) error {
		if writesCompletion(cmd) {
			out.toStdout = true
		}
		if pre != nil {
			return pre(cmd, args)
		}
		return nil
	}
}

// writesCompletion reports whether cmd prints a completion script or
// completion candidates, which are its output.
func writesCompletion(cmd *cobra.Command) bool {
	for c := cmd; c != nil && c.HasParent(); c = c.Parent() {
		switch c.Name() {
		case "completion", cobra.ShellCompRequestCmd, cobra.ShellCompNoDescRequestCmd:
			return !c.Parent().HasParent()
		}
	}
	return false
}

// switchWriter is the tree's Out: stderr, where cobra's own Print* belong,
// except while help, version or completion output is being written.
type switchWriter struct {
	stdout, stderr io.Writer
	toStdout       bool
}

func (w *switchWriter) Write(p []byte) (int, error) {
	if w.toStdout {
		return w.stdout.Write(p)
	}
	return w.stderr.Write(p)
}

// toStdoutFunc names the template function the version template starts
// with: it turns the tree's Out to stdout before the version text is written.
const toStdoutFunc = "clistreamsToStdout"

func init() {
	cobra.AddTemplateFunc(toStdoutFunc, func(c *cobra.Command) string {
		if w, ok := c.Root().OutOrStderr().(*switchWriter); ok {
			w.toStdout = true
		}
		return ""
	})
}
