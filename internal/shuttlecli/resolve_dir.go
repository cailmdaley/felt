package shuttlecli

import (
	"fmt"

	"github.com/spf13/cobra"
)

// resolveDirCmd answers the one question an arming --project-dir asks, without
// writing anything: what absolute directory a path names on this machine.
// The daemon asks it before a forced start cuts a session or writes a
// document, so a directory the host cannot use is refused while nothing has
// happened yet.
func (a *app) resolveDirCmd() *cobra.Command {
	resolveDirCmd := &cobra.Command{
		Use:    "resolve-dir <path>",
		Short:  "Print the absolute directory a --project-dir value names here",
		Hidden: true,
		Long: `Expands $VARS and ~ in <path> exactly as --project-dir does, and prints the
absolute path when it is an existing directory on this machine. Exits non-zero
with the reason otherwise. Writes nothing.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, err := a.resolveProjectDirFlag(args[0])
			if err != nil {
				return err
			}
			fmt.Fprintln(a.env.Stdout, dir)
			return nil
		},
	}
	return resolveDirCmd
}
