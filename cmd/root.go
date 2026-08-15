package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/cailmdaley/felt/internal/felt"
	"github.com/spf13/cobra"
)

var (
	jsonOutput bool
	changeDir  string
)

// Version is the current version, set via ldflags. It stays a bare semver:
// setup.go pins the marketplace ref to it and update.go compares it for
// equality against the upstream tag, so any decoration belongs on the display
// string, never here.
var Version = "dev"

// SetVersionInfo takes the three values goreleaser injects (see .goreleaser.yml)
// and splits them: Version keeps the bare semver for the code that computes with
// it, while `felt --version` prints all three, so "which build is on this box"
// has an answer on a machine that self-updates. A local build carries main.go's
// commit/date defaults and prints the bare version instead — "dev (none, built
// unknown)" tells nobody anything. One line either way: bootstrap.sh pipes this
// through `head -1`.
func SetVersionInfo(v, commit, date string) {
	Version = v
	if commit == "none" || date == "unknown" {
		rootCmd.Version = v
		return
	}
	rootCmd.Version = fmt.Sprintf("%s (%s, built %s)", v, commit, date)
}

var rootCmd = &cobra.Command{
	Use:   "felt",
	Short: "Markdown fiber tracker with containment, wikilinks, and extra YAML",
	Long: `felt stores work as a directory tree
under .felt/, with each fiber in <slug>/<slug>.md using YAML frontmatter and
plain markdown. Containment comes from directories, narrative connections come
from wikilinks in bodies, and non-native frontmatter is preserved opaquely for
downstream tools.`,
	CompletionOptions: cobra.CompletionOptions{
		HiddenDefaultCmd: true,
	},
	// Execute below is the single error printer. Without this, cobra prints the
	// error too and every failure reads twice — which a multi-line error (the
	// create verbs' "already has a block, here are the verbs you meant") turns
	// into a wall.
	SilenceErrors: true,
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

// resolveCommandScope derives the nearest containing fiber ID from the current
// working directory when the command is run inside `.felt/`.
func resolveCommandScope(root string) string {
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	if changeDir != "" {
		if abs, err := filepath.Abs(changeDir); err == nil {
			cwd = abs
		}
	}

	feltRoot := filepath.Join(root, felt.DirName)
	if resolved, err := filepath.EvalSymlinks(feltRoot); err == nil {
		feltRoot = resolved
	}
	if resolved, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = resolved
	}
	rel, err := filepath.Rel(feltRoot, cwd)
	if err != nil {
		return ""
	}
	rel = filepath.ToSlash(rel)
	if rel == "." || strings.HasPrefix(rel, "../") {
		return ""
	}

	parts := strings.Split(rel, "/")
	for i := len(parts); i > 0; i-- {
		candidate := path.Join(parts[:i]...)
		if candidate == "." || candidate == "" {
			continue
		}
		fiberPath := filepath.Join(feltRoot, filepath.FromSlash(candidate), path.Base(candidate)+felt.FileExt)
		if info, err := os.Stat(fiberPath); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

// outputJSON marshals data to JSON and prints it. A nil slice is normalized
// to an empty slice so listing endpoints always emit `[]` (not `null`) when
// they have no results — consumers shouldn't have to handle both.
func outputJSON(data interface{}) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if v := reflect.ValueOf(data); v.Kind() == reflect.Slice && v.IsNil() {
		data = reflect.MakeSlice(v.Type(), 0, 0).Interface()
	}
	return enc.Encode(data)
}
