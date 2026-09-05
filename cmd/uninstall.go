package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

// uninstallCmd is the inverse of `felt setup`: removes the felt plugin and the
// marketplace it came from, for Claude Code and Codex both (whichever are
// installed and have felt wired up). Doesn't touch the felt binary itself —
// removal of that depends on how it was installed (brew, curl, go install), so
// we just print the relevant hint instead of guessing.
var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove the felt agent plugins (Claude Code, Codex, pi)",
	Long: `Remove the felt integration from Claude Code, Codex, and pi.

The inverse of ` + "`felt setup claude`, `felt setup codex`, and `felt setup pi`" + `: for each agent
it removes the felt plugin (or pi package) and unregisters the ` + marketplaceName + `
marketplace. For Claude Code it also unlinks any skills ` + "`felt setup skills`" + `
linked out of that marketplace's clone, since removing the marketplace
deletes what they point at; Codex skills are not linked that way and are
left alone. Idempotent: running it when no plugins are installed is a
no-op. Leaves the felt binary in place — to remove that:

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

	if _, err := exec.LookPath("claude"); err == nil {
		if _, registered := marketplaceEntry(marketplaceName); registered {
			fmt.Println("Removing Claude Code plugin and marketplace...")
			if err := uninstallPlugin(); err != nil {
				fmt.Printf("warning: %v\n", err)
			}
			removedAnything = true
			fmt.Println()
		}
	}

	if feltCodexWiringPresent() {
		fmt.Println("Removing Codex plugin and marketplace...")
		if err := uninstallCodexPlugin(); err != nil {
			fmt.Printf("warning: %v\n", err)
		}
		removedAnything = true
		fmt.Println()
	}

	if _, err := exec.LookPath("pi"); err == nil {
		if installed := piFeltPackageSource(); installed != "" {
			fmt.Println("Removing pi package...")
			if err := runHarnessCLI("pi", "remove", installed); err != nil {
				fmt.Printf("warning: %v\n", err)
			}
			removedAnything = true
			fmt.Println()
		}
	}

	if !removedAnything {
		fmt.Println("No felt agent plugins detected — nothing to remove.")
		fmt.Println()
	}

	fmt.Println("To remove the felt binary itself:")
	fmt.Println("  brew uninstall felt        # if installed via brew")
	fmt.Println("  rm $(which felt)           # if installed via curl or go install")
}

// piFeltPackageSource returns the source spec of the felt package registered
// in pi's settings (~/.pi/agent/settings.json under "packages"), or "" when
// pi has none. Matching is structural: the git: entry for marketplaceRepo at
// any tag, or any local path whose package.json names felt — so a dev
// checkout at an arbitrary path is recognized. A substring probe over
// "owner/repo" would miss local installs entirely: refresh would no-op and
// uninstall would leave the package loaded.
func piFeltPackageSource() string {
	home, err := os.UserHomeDir()
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
