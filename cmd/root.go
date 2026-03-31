package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var jsonOutput bool

// Version is the current version, set via ldflags.
var Version = "dev"

// SetVersionInfo sets version info from main (populated via ldflags)
func SetVersionInfo(v, commit, date string) {
	Version = v
	rootCmd.Version = v
}

var rootCmd = &cobra.Command{
	Use:   "felt",
	Short: "DAG-native markdown task tracker",
	Long: `felt is a DAG-native fiber tracker that stores work as a directory tree
under .felt/, with each fiber in <slug>/<slug>.md using YAML frontmatter and
MyST-flavored markdown. Fibers can depend on each other, forming a directed
acyclic graph that can be searched, traversed, and exported.`,
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
}

// outputJSON marshals data to JSON and prints it.
func outputJSON(data interface{}) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(data)
}
