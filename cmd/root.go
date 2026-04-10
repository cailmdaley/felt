package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	jsonOutput bool
	changeDir  string
)

// Version is the current version, set via ldflags.
var Version = "dev"

// SetVersionInfo sets version info from main (populated via ldflags)
func SetVersionInfo(v, commit, date string) {
	Version = v
	rootCmd.Version = v
}

var rootCmd = &cobra.Command{
	Use:   "felt",
	Short: "Markdown fiber tracker with containment and ASTRA frontmatter",
	Long: `felt stores work as a directory tree
under .felt/, with each fiber in <slug>/<slug>.md using YAML frontmatter and
plain markdown. Containment comes from directories, narrative connections come
from wikilinks in bodies, and ASTRA frontmatter accretes as computation
crystallizes.`,
	CompletionOptions: cobra.CompletionOptions{
		HiddenDefaultCmd: true,
	},
}

// Execute runs the root command.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().BoolVarP(&jsonOutput, "json", "j", false, "Output in JSON format")
	rootCmd.PersistentFlags().StringVarP(&changeDir, "directory", "C", "", "Run as if felt was started in `dir`")
}

// resolveProjectRoot returns the project root, honoring -C if set.
func resolveProjectRoot() (string, error) {
	if changeDir != "" {
		abs, err := filepath.Abs(changeDir)
		if err != nil {
			return "", fmt.Errorf("resolving -C path: %w", err)
		}
		feltDir := filepath.Join(abs, felt.DirName)
		if info, err := os.Stat(feltDir); err != nil || !info.IsDir() {
			return "", fmt.Errorf("no .felt directory in %s", abs)
		}
		return abs, nil
	}
	return felt.FindProjectRoot()
}

// outputJSON marshals data to JSON and prints it.
func outputJSON(data interface{}) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(data)
}
