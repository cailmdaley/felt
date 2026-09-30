package feltcli

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"runtime/debug"

	"github.com/spf13/cobra"
)

var (
	jsonOutput bool
	changeDir  string
)

// Version is the current release version, set through build metadata.
var Version = "dev"

// SetVersionInfo records the release version and display identity for the binary.
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

const (
	groupFibers = "fibers"
	groupSearch = "search"
	groupStore  = "store"
	groupAgents = "agents"
)

const rootLong = `felt keeps fibers (tasks, decisions, findings, specs) as markdown files: the id
is the nested path, so analysis/prior lives at .felt/analysis/prior/prior.md.
Relationships come from containment, [[wikilinks]] in bodies, and project-owned
conventions such as inputs.from. Extra top-level YAML is preserved untouched.

Status is opt-in:   · none (default)   ○ open   ◐ active   ● closed
open and active mean someone should act; a note, decision, or finding stays
statusless. Close a todo with an outcome that says what was learned.

Views and stores: a project .felt that symlinks into a larger store is a view.
ls lists the view, find searches the whole store, and an id reaches anywhere:
show, edit, tree, nest, and rm act on the fiber where it lives.

Common paths:
  felt add analysis/covariance "Covariance method" -o "one-line outcome"
  felt edit analysis/covariance -o "what was learned" -s closed
  felt ls                           open and active fibers in this view
  felt ls "query"                   search; closed matches are counted, not shown
  felt ls "query" --body -r         regex, including bodies
  felt find "query"                 search the whole store
  felt show <id> -d summary         outcome, lede, back-references in this view
  felt show <id> --field key        one frontmatter key, shell-friendly
  felt show <id> --citations        fibers anywhere in the store that link here
  felt tree <id> -L 2               containment around a fiber
  felt edit <id> --set key=value    a scalar project field (--unset key)
  felt nest <child> <parent>        move a subtree, rewriting links it would break

Editing: write bodies, outcomes longer than a sentence (outcome: |-), and
structured YAML in the file directly; quotes and newlines are easier there
than through shell quoting. Never hand-edit created-at or updated-at; felt stamps them itself.

Sync: felt sync merges the store's Git upstream, following a symlinked view to
the real store. Commit intentional changes, then felt sync --push at useful
checkpoints. Resolve conflicts in context: never take ours or theirs
mechanically, never discard another worker's edits.

Hygiene: felt check reports broken links and layout problems; felt session
prints the start-of-session context, including its Attention list.`

var rootCmd = &cobra.Command{
	Use:   "felt",
	Short: "Markdown fiber tracker with containment, wikilinks, and extra YAML",
	Long:  rootLong,
	CompletionOptions: cobra.CompletionOptions{
		HiddenDefaultCmd: true,
	},
	SilenceErrors: true,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		if err := cmd.ValidateRequiredFlags(); err != nil {
			return err
		}
		if err := cmd.ValidateFlagGroups(); err != nil {
			return err
		}
		cmd.SilenceUsage = true
		return nil
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	cobra.EnableTraverseRunHooks = true
	rootCmd.AddGroup(
		&cobra.Group{ID: groupFibers, Title: "Fibers:"},
		&cobra.Group{ID: groupSearch, Title: "Finding:"},
		&cobra.Group{ID: groupStore, Title: "Store:"},
		&cobra.Group{ID: groupAgents, Title: "Integration:"},
	)
	rootCmd.SetHelpCommandGroupID(groupAgents)
	rootCmd.PersistentFlags().BoolVarP(&jsonOutput, "json", "j", false, "Output in JSON format")
	rootCmd.PersistentFlags().StringVarP(&changeDir, "directory", "C", "", "Run as if felt was started in `dir`")
}

func outputJSON(data interface{}) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if v := reflect.ValueOf(data); v.Kind() == reflect.Slice && v.IsNil() {
		data = reflect.MakeSlice(v.Type(), 0, 0).Interface()
	}
	return enc.Encode(data)
}
