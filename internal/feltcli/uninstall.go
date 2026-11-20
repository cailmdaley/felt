package feltcli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

// uninstallCmd is the inverse of `felt setup`: removes the felt plugin and the
// marketplace it came from, for Claude Code and Codex both (whichever are
// installed and have felt wired up). Doesn't touch the felt binary itself —
// removal of that depends on how it was installed (brew, curl, go install), so
// we just print the relevant hint instead of guessing.
func (a *app) uninstallCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "uninstall",
		Short: "Remove the felt agent plugins (Claude Code, Codex, pi, Antigravity)",
		Long: `The inverse of felt setup claude, codex, pi and antigravity: wherever felt is installed, it
removes the plugin (or pi package) and the ` + marketplaceName + ` marketplace.
For Claude Code it also unlinks skills that felt setup skills linked into
~/.claude/skills from that marketplace, since removing it deletes their
targets. Running it with nothing installed is a no-op.

The felt binary stays; remove it with brew uninstall felt, or by deleting
$(which felt) for a curl or go install.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			a.runFeltUninstall()
			return nil
		},
	}
	command.GroupID = groupAgents
	return command
}

func (a *app) runFeltUninstall() {
	removedAnything := false

	if _, err := a.env.LookPath("claude"); err == nil {
		if _, registered := a.marketplaceEntry(marketplaceName); registered {
			fmt.Fprintln(a.env.Stdout, "Removing Claude Code plugin and marketplace...")
			if err := a.uninstallPlugin(); err != nil {
				fmt.Fprintf(a.env.Stdout, "warning: %v\n", err)
			}
			removedAnything = true
			fmt.Fprintln(a.env.Stdout)
		}
	}

	if a.feltCodexWiringPresent() {
		fmt.Fprintln(a.env.Stdout, "Removing Codex plugin and marketplace...")
		if err := a.uninstallCodexPlugin(); err != nil {
			fmt.Fprintf(a.env.Stdout, "warning: %v\n", err)
		}
		removedAnything = true
		fmt.Fprintln(a.env.Stdout)
	}

	if _, err := a.env.LookPath("pi"); err == nil {
		if installed, err := a.piFeltPackage(); err != nil {
			fmt.Fprintf(a.env.Stdout, "warning: %v\n", err)
		} else if installed.Source != "" {
			fmt.Fprintln(a.env.Stdout, "Removing pi package...")
			if err := a.runHarnessCLI("pi", "remove", installed.spec()); err != nil {
				fmt.Fprintf(a.env.Stdout, "warning: %v\n", err)
			}
			removedAnything = true
			fmt.Fprintln(a.env.Stdout)
		}
	}

	if dir, err := a.antigravityPluginDir(); err == nil {
		if _, err := os.Stat(filepath.Join(dir, "plugin.json")); err == nil {
			fmt.Fprintln(a.env.Stdout, "Removing the agy plugin...")
			if err := os.RemoveAll(dir); err != nil {
				fmt.Fprintf(a.env.Stdout, "warning: %v\n", err)
			}
			removedAnything = true
			fmt.Fprintln(a.env.Stdout)
		}
	}

	if !removedAnything {
		fmt.Fprintln(a.env.Stdout, "No felt agent plugins detected — nothing to remove.")
		fmt.Fprintln(a.env.Stdout)
	}

	fmt.Fprintln(a.env.Stdout, "To remove the felt binary itself:")
	fmt.Fprintln(a.env.Stdout, "  brew uninstall felt        # if installed via brew")
	fmt.Fprintln(a.env.Stdout, "  rm $(which felt)           # if installed via curl or go install")
}
