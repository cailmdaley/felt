package feltcli

import (
	"fmt"
	"path/filepath"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Create a store here, or repair its support files",
	Long: `Creates .felt/ and its .gitignore in the current directory, or in -C dir; it
does not look for an enclosing store. In an existing store it restores a
missing .gitignore and changes nothing else.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		// Honor -C. The usual project-root lookup requires an existing .felt/,
		// which is precisely what init is here to create.
		target := "."
		if changeDir != "" {
			target = changeDir
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

		// Report the absolute path. `felt init` is usually run from the
		// directory it initializes, so a relative ".felt" tells someone who
		// just cd'd around exactly nothing about where their store landed.
		root, err := filepath.Abs(storage.Root())
		if err != nil {
			// Path resolution failing is not a reason to claim the init
			// failed — it succeeded; we just can't name it as nicely.
			root = storage.Root()
		}

		if existed {
			fmt.Printf("felt store already present at %s (support files checked).\n", root)
			return nil
		}

		fmt.Printf("Created felt store at %s\n", root)
		fmt.Printf("  %s   ignores local fiber-write locks\n", felt.GitignoreName)
		fmt.Println()
		fmt.Println("Next:")
		fmt.Println(`  felt add <slug> "<name>"   file your first fiber`)
		fmt.Println("  felt ls                    see what the store holds")
		return nil
	},
}

func init() {
	initCmd.GroupID = groupStore
	rootCmd.AddCommand(initCmd)
}
