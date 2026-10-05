package feltcli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"
	"runtime/debug"

	"github.com/cailmdaley/felt/internal/sysenv"
	"github.com/spf13/cobra"
)

// app is one felt invocation: the process surface it runs against and the
// root's persistent flags. Commands read env vars, the home and working
// directories, executables and the standard streams through a.env, never
// through package os.
type app struct {
	env     *sysenv.Env
	json    bool   // --json
	dir     string // -C
	version string // the release version this binary reports and pins plugins to
}

func newApp(env *sysenv.Env) *app {
	return &app{env: env, version: Version}
}

// Version is the current release version, set through build metadata.
var Version = "dev"

// displayVersion is what --version prints; SetVersionInfo writes it once,
// before any command tree is built.
var displayVersion string

// SetVersionInfo records the release version and display identity for the binary.
func SetVersionInfo(v, commit, date string) {
	Version = v
	if commit == "none" {
		commit = vcsRevision()
	}
	switch {
	case commit == "":
		displayVersion = v
	case date == "unknown":
		displayVersion = fmt.Sprintf("%s (%s)", v, commit)
	default:
		displayVersion = fmt.Sprintf("%s (%s, built %s)", v, commit, date)
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

func init() {
	cobra.EnableTraverseRunHooks = true
}

// NewRootCmd builds a fresh felt command tree bound to env.
func NewRootCmd(env *sysenv.Env) *cobra.Command {
	return newApp(env).rootCmd()
}

// Run executes one felt invocation with args in env and returns its exit
// code, printing a failure to env.Stderr.
func Run(env *sysenv.Env, args []string) int {
	root := NewRootCmd(env)
	if args == nil {
		args = []string{}
	}
	root.SetArgs(args)
	if err := root.Execute(); err != nil {
		fmt.Fprintln(env.Stderr, err)
		return 1
	}
	return 0
}

func Execute() {
	os.Exit(Run(sysenv.OS(), os.Args[1:]))
}

func (a *app) rootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:     "felt",
		Short:   "Markdown fiber tracker with containment, wikilinks, and extra YAML",
		Long:    rootLong,
		Version: displayVersion,
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
	root.SetIn(a.env.Stdin)
	root.SetOut(a.env.Stdout)
	root.SetErr(a.env.Stderr)
	root.AddGroup(
		&cobra.Group{ID: groupFibers, Title: "Fibers:"},
		&cobra.Group{ID: groupSearch, Title: "Finding:"},
		&cobra.Group{ID: groupStore, Title: "Store:"},
		&cobra.Group{ID: groupAgents, Title: "Integration:"},
	)
	root.SetHelpCommandGroupID(groupAgents)
	root.PersistentFlags().BoolVarP(&a.json, "json", "j", false, "Output in JSON format")
	root.PersistentFlags().StringVarP(&a.dir, "directory", "C", "", "Run as if felt was started in `dir`")
	view := a.view()
	root.AddCommand(
		a.addCmd(),
		a.editCmd(),
		NewShowCmd(a.env, view),
		a.rmCmd(),
		NewLsCmd(a.env, view),
		a.treeCmd(),
		a.findCmd(),
		a.checkCmd(),
		a.initCmd(),
		a.syncCmd(),
		a.nestCmd(),
		a.unnestCmd(),
		a.migrateCmd(),
		a.backfillIDsCmd(),
		a.sessionCmd(),
		a.hookCmd(),
		a.setupCmd(),
		a.updateCmd(),
		a.uninstallCmd(),
	)
	return root
}

// view is the felt binary's own view options: -C and --json of this
// invocation.
func (a *app) view() ViewOptions {
	return ViewOptions{
		Directory: func() string { return a.dir },
		IsJSON:    func() bool { return a.json },
	}
}

// writeJSON encodes data to w, indented, with a nil slice as [].
func writeJSON(w io.Writer, data interface{}) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if v := reflect.ValueOf(data); v.Kind() == reflect.Slice && v.IsNil() {
		data = reflect.MakeSlice(v.Type(), 0, 0).Interface()
	}
	return enc.Encode(data)
}

func (a *app) outputJSON(data interface{}) error {
	return writeJSON(a.env.Stdout, data)
}
