package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var jsonOutput bool

// SetVersionInfo sets version info from main (populated via ldflags)
func SetVersionInfo(version, commit, date string) {
	rootCmd.Version = version
}

var rootCmd = &cobra.Command{
	Use:   "felt",
	Short: "DAG-native markdown task tracker",
	Long: `felt is a DAG-native task/spec tracker that stores tasks as markdown files
with YAML frontmatter. Tasks can depend on each other, forming a directed
acyclic graph that can be traversed and visualized.`,
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
