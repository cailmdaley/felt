package feltcli

import (
	"fmt"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

func (a *app) initCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "init",
		Short: "Create a store here, or repair its support files",
		Long: `Creates .felt/ and its .gitignore in the current directory, or in -C dir; it
does not look for an enclosing store. In an existing store it restores a
missing .gitignore and changes nothing else.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Honor -C, resolved to an absolute path. The usual project-root
			// lookup requires an existing .felt/, which is precisely what init is
			// here to create.
			target := "."
			if a.dir != "" {
				target = a.dir
			}
			target, err := a.env.Abs(target)
			if err != nil {
				return err
			}
			storage := felt.NewStorage(target)

			// Ask what exists BEFORE Init, because Init is idempotent and answers
			// nothing afterwards. The distinction matters to the reader: a fresh
			// init is the one moment where "here is your store, at this path" is
			// the whole of what they need, and reporting it in idempotency
			// vocabulary ("ensured") reads as though nothing happened.
			existed := storage.Exists()

			if err := storage.Init(); err != nil {
				return err
			}

			// The store is reported by its absolute path. `felt init` is usually
			// run from the directory it initializes, so a relative ".felt" tells
			// someone who just cd'd around exactly nothing about where their store
			// landed.
			root := storage.Root()

			if existed {
				fmt.Fprintf(a.env.Stdout, "felt store already present at %s (support files checked).\n", root)
				return nil
			}

			fmt.Fprintf(a.env.Stdout, "Created felt store at %s\n", root)
			fmt.Fprintf(a.env.Stdout, "  %s   ignores local fiber-write locks\n", felt.GitignoreName)
			fmt.Fprintln(a.env.Stdout)
			fmt.Fprintln(a.env.Stdout, "Next:")
			fmt.Fprintln(a.env.Stdout, `  felt add <slug> "<name>"   file your first fiber`)
			fmt.Fprintln(a.env.Stdout, "  felt ls                    see what the store holds")
			return nil
		},
	}
	command.GroupID = groupStore
	return command
}
