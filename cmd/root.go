package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"runtime/debug"
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
// it, while `felt --version` prints the build too, so "which build is on this
// box" has an answer on every machine. A release names its commit and date; a
// local `go build`/`go install` names the source revision Go stamped into the
// binary ("dev (3e5bcef7a1b2)", with a -dirty suffix for an unclean tree), so
// two local installs from different checkouts are distinguishable. One line
// either way: bootstrap.sh pipes this through `head -1`.
func SetVersionInfo(v, commit, date string) {
	Version = v
	if commit == "none" {
		commit = vcsRevision()
	}
	switch {
	case commit == "":
		rootCmd.Version = v
	case date == "unknown":
		rootCmd.Version = fmt.Sprintf("%s (%s)", v, commit)
	default:
		rootCmd.Version = fmt.Sprintf("%s (%s, built %s)", v, commit, date)
	}
}

// vcsRevision is the short source revision Go embeds in a binary built from a
// checkout, or "" when the build carries none.
func vcsRevision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	revision, dirty := "", false
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			dirty = setting.Value == "true"
		}
	}
	if len(revision) > 12 {
		revision = revision[:12]
	}
	if revision != "" && dirty {
		revision += "-dirty"
	}
	return revision
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

// requireStore opens the storage for the enclosing felt project, returning the
// project root alongside it for callers that also resolve a command scope.
func requireStore() (*felt.Storage, string, error) {
	root, err := resolveProjectRoot()
	if err != nil {
		return nil, "", fmt.Errorf("not in a felt repository")
	}
	return felt.NewStorage(root), root, nil
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
