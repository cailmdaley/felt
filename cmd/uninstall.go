package cmd

import (
	"fmt"
	"os/exec"

	"github.com/spf13/cobra"
)

// uninstallCmd is the inverse of `felt setup`: removes the felt plugin from
// Claude Code and Codex (whichever are installed and have felt wired up).
// Doesn't touch the felt binary itself — removal of that depends on how it
// was installed (brew, curl, go install), so we just print the relevant
// hint instead of guessing.
var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove the felt agent plugins (Claude Code, Codex)",
	Long: `Remove the felt plugin from Claude Code and Codex.

The inverse of ` + "`felt setup claude`" + ` and ` + "`felt setup codex`" + `. Idempotent:
running it when no plugins are installed is a no-op. Leaves the felt
binary in place — to remove that:

  brew uninstall felt        # if installed via brew
  rm $(which felt)           # if installed via curl or go install`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		runFeltUninstall()
		return nil
	},
}

func init() {
	rootCmd.AddCommand(uninstallCmd)
}

func runFeltUninstall() {
	removedAnything := false

	if _, err := exec.LookPath("claude"); err == nil && isMarketplaceRegistered(marketplaceName) {
		fmt.Println("Removing Claude Code plugin...")
		if err := uninstallPlugin(); err != nil {
			fmt.Printf("warning: %v\n", err)
		}
		removedAnything = true
		fmt.Println()
	}

	if feltCodexInstalled() {
		fmt.Println("Removing Codex plugin...")
		if err := uninstallCodexPlugin(); err != nil {
			fmt.Printf("warning: %v\n", err)
		}
		removedAnything = true
		fmt.Println()
	}

	if !removedAnything {
		fmt.Println("No felt agent plugins detected — nothing to remove.")
		fmt.Println()
	}

	fmt.Println("To remove the felt binary itself:")
	fmt.Println("  brew uninstall felt        # if installed via brew")
	fmt.Println("  rm $(which felt)           # if installed via curl or go install")
}
