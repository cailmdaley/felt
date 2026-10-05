package feltcli

import (
	"fmt"
	"path/filepath"
	"strings"

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
		Short: "Remove the felt agent plugins (Claude Code, Codex, pi)",
		Long: `The inverse of felt setup claude, codex, and pi: wherever felt is installed, it
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
		if installed := a.piFeltPackageSource(); installed != "" {
			fmt.Fprintln(a.env.Stdout, "Removing pi package...")
			if err := a.runHarnessCLI("pi", "remove", installed); err != nil {
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

// piFeltPackageSource returns the source spec of the felt package registered
// in pi's settings (~/.pi/agent/settings.json under "packages"), or "" when
// pi has none. Matching is structural: the git: entry for marketplaceRepo at
// any tag, or any local path whose package.json names felt — so a dev
// checkout at an arbitrary path is recognized. A substring probe over
// "owner/repo" would miss local installs entirely: refresh would no-op and
// uninstall would leave the package loaded.
func (a *app) piFeltPackageSource() string {
	home, err := a.env.UserHomeDir()
	if err != nil {
		return ""
	}
	settings, err := readJSONFile[struct {
		Packages []string `json:"packages"`
	}](filepath.Join(home, ".pi", "agent", "settings.json"))
	if err != nil {
		return ""
	}
	gitBase := "git:github.com/" + marketplaceRepo
	for _, src := range settings.Packages {
		if src == gitBase || strings.HasPrefix(src, gitBase+"@") {
			return src
		}
		if !strings.Contains(src, ":") && isFeltPackageDir(home, src) {
			return src
		}
	}
	return ""
}

// isFeltPackageDir reports whether dir holds a package.json named felt.
// Entries are tried as recorded, then home-relative; a literal ~ prefix is
// expanded against home in case pi recorded it unexpanded.
func isFeltPackageDir(home, dir string) bool {
	candidates := []string{dir}
	if strings.HasPrefix(dir, "~") {
		candidates = append(candidates, filepath.Join(home, strings.TrimPrefix(dir, "~")))
	} else if !filepath.IsAbs(dir) {
		candidates = append(candidates, filepath.Join(home, dir))
	}
	for _, candidate := range candidates {
		pkg, err := readJSONFile[struct {
			Name string `json:"name"`
		}](filepath.Join(candidate, "package.json"))
		if err == nil && pkg.Name == "felt" {
			return true
		}
	}
	return false
}
